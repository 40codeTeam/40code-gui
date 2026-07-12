import React from 'react';
import ReactDOM from 'react-dom';
import sb3 from 'scratch-vm/src/serialization/sb3';
import newBlockIds from 'scratch-vm/src/util/new-block-ids';
import {sanitizeSvg, fixForVanilla} from '@turbowarp/scratch-svg-renderer';
import {emptyCostume, emptySprite} from '../../../lib/empty-assets';
import {isPaused, setPaused, setup as setupPauseControls} from '../debugger/module.js';
import pseudoConverter from './pseudocode';

// 保险丝：给 Blockly workspace 装一个变量事件监听器，任何 var_create / var_delete /
// var_rename 发生后都强制把 flyout 重绘一次。
// 背景：apply 路径走过 clearWorkspaceAndLoadFromXml + React updateToolbox + setTimeout refreshSelection
// 之后，flyout 的 recycle 缓存 / toolbox 重建组合会让 Blockly 自身在原生"Make a Variable"之后调的
// refreshToolboxSelection_ 命中 recycle 快门、视觉上不更新——这里兜底。
// 幂等：靠 ws 自身的 flag。多次打开/关闭转换器不会累加。
const installVariableFlyoutRefreshListener = ws => {
    if (!ws || ws.__jscVariableFlyoutRefreshInstalled) return;
    ws.__jscVariableFlyoutRefreshInstalled = true;
    ws.addChangeListener(event => {
        if (!event) return;
        const t = event.type;
        if (t !== 'var_create' && t !== 'var_delete' && t !== 'var_rename') return;
        // 延后一个 tick，让 Blockly / React 自己的 toolbox 重建先跑完。
        setTimeout(() => {
            try {
                const tb = ws.toolbox_;
                if (!tb || !tb.flyout_ || typeof tb.refreshSelection !== 'function') return;
                // 清 flyout 的 recycle 缓存，避免 show 误判"内容没变"。
                const fl = tb.flyout_;
                if (typeof fl.emptyRecycleBlocks === 'function') fl.emptyRecycleBlocks();
                tb.refreshSelection();
            } catch (_) { /* 视觉补丁，出错就算了 */ }
        }, 0);
    });
};

const makeDraggable = (element, handle) => {
    let pos1 = 0;
    let pos2 = 0;
    let pos3 = 0;
    let pos4 = 0;
    const dragHandle = handle || element;
    const dragMouseDown = e => {
        e.preventDefault();
        e.stopPropagation();
        pos3 = e.clientX;
        pos4 = e.clientY;
        document.addEventListener('mouseup', closeDragElement, {capture: true});
        document.addEventListener('mousemove', elementDrag, {capture: true});
    };
    const elementDrag = e => {
        e.preventDefault();
        e.stopPropagation();
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;
        const newTop = element.offsetTop - pos2;
        const newLeft = element.offsetLeft - pos1;
        const maxLeft = window.innerWidth - element.offsetWidth;
        const maxTop = window.innerHeight - element.offsetHeight;
        element.style.top = `${Math.max(0, Math.min(newTop, maxTop))}px`;
        element.style.left = `${Math.max(0, Math.min(newLeft, maxLeft))}px`;
    };
    const closeDragElement = e => {
        e.stopPropagation();
        document.removeEventListener('mouseup', closeDragElement, {capture: true});
        document.removeEventListener('mousemove', elementDrag, {capture: true});
    };
    dragHandle.addEventListener('mousedown', dragMouseDown);
};

// 0 → "a", 25 → "z", 26 → "aa", 27 → "ab", ... 类似 Excel 列但全小写
const shortIdAt = index => {
    let n = index;
    let s = '';
    while (true) {
        s = String.fromCharCode(97 + (n % 26)) + s;
        n = Math.floor(n / 26);
        if (n === 0) break;
        n -= 1;
    }
    return s;
};

// 把 sb3.serialize(...).blocks 里的长随机 UID 全部换成 a/b/c/... 方便人编辑。
// 输入是 SB3 压缩形态：值可能是块对象，也可能是 [type, ...] 压缩 primitive 数组。
// 需要改写三处引用：next / parent / inputs[X] 里位置 1 和 2（当它们是字符串块 ID 时）。
// 应用回去时 deserializeBlocks + newBlockIds 会重新生成真正的 UID，短 ID 只在编辑期间存在。
const remapBlockIdsForEditor = blocksObj => {
    const keys = Object.keys(blocksObj);
    const idMap = new Map();
    keys.forEach((oldId, i) => idMap.set(oldId, shortIdAt(i)));
    const mapId = id => (typeof id === 'string' && idMap.has(id) ? idMap.get(id) : id);

    const result = {};
    for (const oldId of keys) {
        const entry = blocksObj[oldId];
        const newId = idMap.get(oldId);
        if (Array.isArray(entry)) {
            // 压缩 primitive 数组：内部不含块引用
            result[newId] = entry.slice();
            continue;
        }
        const cloned = JSON.parse(JSON.stringify(entry));
        if (cloned.next) cloned.next = mapId(cloned.next);
        if (cloned.parent) cloned.parent = mapId(cloned.parent);
        if (cloned.inputs) {
            for (const inputName of Object.keys(cloned.inputs)) {
                const input = cloned.inputs[inputName];
                if (!Array.isArray(input)) continue;
                for (let i = 1; i < input.length; i++) {
                    if (typeof input[i] === 'string') {
                        input[i] = mapId(input[i]);
                    }
                }
            }
        }
        result[newId] = cloned;
    }
    return result;
};

// 在 editor 文本里按子串查找（大小写不敏感），返回 {start, end} 数组
const computeMatches = (text, query) => {
    if (!query) return [];
    const matches = [];
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    let i = 0;
    while (i <= lowerText.length) {
        const idx = lowerText.indexOf(lowerQuery, i);
        if (idx === -1) break;
        matches.push({start: idx, end: idx + query.length});
        i = idx + Math.max(1, query.length);
    }
    return matches;
};

const looksLikeBlocksObject = obj => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    let hasAny = false;
    for (const key in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
        hasAny = true;
        const entry = obj[key];
        if (Array.isArray(entry)) continue; // compressed primitive
        if (entry && typeof entry === 'object' && typeof entry.opcode === 'string') continue;
        return false;
    }
    return hasAny;
};

// 伪代码里顶层脚本被空行分隔（renderPseudocode 每个脚本末尾 push ''）。
// 文本开头还有 #vars / #lists 这几个头部声明块，它们也被空行分隔，但并**不**对应
// 任何顶层积木 —— 如果也当作脚本算进去，ranges 和 topBlocks 的索引就错位了。过滤掉以 # 开头的段。
// 返回每个脚本的行区间 [{startLine, endLine}, ...]，endLine 不含。
const scriptLineRanges = text => {
    const lines = text.split('\n');
    const ranges = [];
    let curStart = -1;
    const flush = endLine => {
        const first = (lines[curStart] || '').trimStart();
        if (!first.startsWith('#')) ranges.push({startLine: curStart, endLine});
        curStart = -1;
    };
    for (let i = 0; i < lines.length; i++) {
        const blank = lines[i].trim() === '';
        if (!blank) {
            if (curStart === -1) curStart = i;
        } else if (curStart !== -1) {
            flush(i);
        }
    }
    if (curStart !== -1) flush(lines.length);
    return ranges;
};

// 找到伪代码文本顶部连续头部块（#vars/#lists/#localvars/#locallists 及中文形态）占据的字节范围。
// 返回 {end, indexAfterHeaderBlank}，end 是最后一个头部块右大括号后的位置（不含尾部换行）；
// indexAfterHeaderBlank 是跳过紧随其后的一次空白/换行后的位置（即"正文开始处"）。
// 没有头部时两者都返回 0。
const HEADER_KW_RE = /^#(?:vars|变量|lists|列表|localvars|局部变量|locallists|局部列表)(?![a-zA-Z_0-9\u4e00-\u9fa5])/;
const findHeaderRegion = text => {
    let scan = 0;
    let end = 0;
    while (scan < text.length) {
        while (scan < text.length && /\s/.test(text[scan])) scan++;
        if (scan >= text.length) break;
        if (!HEADER_KW_RE.test(text.slice(scan))) break;
        // 找到 '{'
        let i = scan;
        while (i < text.length && text[i] !== '{') i++;
        if (i >= text.length) break;
        // 扫到配对 '}'；跳过字符串字面量内容
        let depth = 0;
        let inStr = false;
        let strCh = '';
        let closed = false;
        while (i < text.length) {
            const c = text[i];
            if (inStr) {
                if (c === '\\' && i + 1 < text.length) { i += 2; continue; }
                if (c === strCh) inStr = false;
                i++;
                continue;
            }
            if (c === '"' || c === "'") { inStr = true; strCh = c; i++; continue; }
            if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) { i++; closed = true; break; } }
            i++;
        }
        if (!closed) break;
        scan = i;
        end = i;
    }
    // 跳过尾部所有连续空白/换行（让 rest 直接从正文开始）。
    // 这样 syncEditorHeader 的 newHeader 末尾固定补 '\n\n'，不会因为残留的换行越堆越多。
    let tail = end;
    while (tail < text.length && /\s/.test(text[tail])) tail++;
    return {end, indexAfterHeader: end > 0 ? tail : 0};
};

// 从解析后的 SB3 blocks 对象里提取被 variable/list/broadcast 引用的名字集合
const collectReferencedNames = blocks => {
    const vars = new Set();
    const lists = new Set();
    const broadcasts = new Set();
    const addPrim = arr => {
        if (!Array.isArray(arr) || arr.length < 2) return;
        const t = arr[0];
        const name = arr[1];
        if (name == null) return;
        if (t === 11) broadcasts.add(String(name));
        else if (t === 12) vars.add(String(name));
        else if (t === 13) lists.add(String(name));
    };
    for (const id of Object.keys(blocks)) {
        const b = blocks[id];
        if (Array.isArray(b)) { addPrim(b); continue; }
        if (b && b.fields) {
            const vf = b.fields.VARIABLE; if (vf && vf[0] != null) vars.add(String(vf[0]));
            const lf = b.fields.LIST;     if (lf && lf[0] != null) lists.add(String(lf[0]));
            const bf = b.fields.BROADCAST_OPTION; if (bf && bf[0] != null) broadcasts.add(String(bf[0]));
        }
        if (b && b.inputs) {
            for (const k of Object.keys(b.inputs)) {
                const input = b.inputs[k];
                if (!Array.isArray(input)) continue;
                for (let i = 1; i < input.length; i++) {
                    const v = input[i];
                    if (Array.isArray(v)) addPrim(v);
                }
            }
        }
    }
    return {vars, lists, broadcasts};
};

const escapePseudoString = s => '"' + String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t') + '"';

const normalizeControlStopMutations = blocks => {
    const getFieldValue = field => {
        if (Array.isArray(field)) return field[0];
        if (field && typeof field === 'object') return field.value;
        return field;
    };
    for (const blockId in blocks) {
        const block = blocks[blockId];
        if (!block || Array.isArray(block) || block.opcode !== 'control_stop') continue;
        const option = String(getFieldValue(block.fields && block.fields.STOP_OPTION) || '');
        const oldMutation = block.mutation && typeof block.mutation === 'object' ? block.mutation : {};
        let hasNext;
        if (option) {
            hasNext = option === 'other scripts in sprite';
        } else {
            hasNext = oldMutation.hasnext === true || oldMutation.hasnext === 'true' || !!block.next;
        }
        block.mutation = {
            ...oldMutation,
            tagName: oldMutation.tagName || 'mutation',
            children: Array.isArray(oldMutation.children) ? oldMutation.children : [],
            hasnext: hasNext ? 'true' : 'false'
        };
    }
};

const findMissingReferences = (blocks, target) => {
    const missing = {variable: new Set(), list: new Set(), broadcast: new Set()};
    const stage = target && target.runtime && typeof target.runtime.getTargetForStage === 'function'
        ? target.runtime.getTargetForStage()
        : null;
    const broadcastTarget = stage || target;
    for (const blockId in blocks) {
        const block = blocks[blockId];
        if (!block || !block.fields) continue;
        const checks = [
            ['VARIABLE', 'variable'],
            ['LIST', 'list'],
            ['BROADCAST_OPTION', 'broadcast']
        ];
        for (const [fieldName, kind] of checks) {
            const field = block.fields[fieldName];
            if (!field || !field.id) continue;
            if (kind === 'broadcast') {
                if (!broadcastTarget || !broadcastTarget.lookupBroadcastMsg(field.id, field.value)) {
                    missing.broadcast.add(`${field.id} (${field.value || ''})`);
                }
            } else if (!target.lookupVariableById(field.id)) {
                missing[kind].add(`${field.id} (${field.value || ''})`);
            }
        }
    }
    return {
        variable: [...missing.variable],
        list: [...missing.list],
        broadcast: [...missing.broadcast]
    };
};

const remapBlockReferenceIds = (blocks, remaps) => {
    const getReplacement = (kind, oldId) => {
        const map = remaps && remaps[kind];
        if (!map || oldId == null) return null;
        return map.get(String(oldId)) || null;
    };
    const applyReplacement = (field, replacement) => {
        if (!field || !replacement) return;
        if (Array.isArray(field)) {
            if (replacement.name != null) field[0] = replacement.name;
            if (replacement.id != null) field[1] = replacement.id;
            return;
        }
        if (typeof field !== 'object') return;
        if (replacement.name != null) field.value = replacement.name;
        if (replacement.id != null) field.id = replacement.id;
    };
    for (const blockId in blocks) {
        const block = blocks[blockId];
        if (!block || !block.fields) continue;
        const refs = [
            ['VARIABLE', 'variable'],
            ['LIST', 'list'],
            ['BROADCAST_OPTION', 'broadcast']
        ];
        for (const [fieldName, kind] of refs) {
            const field = block.fields[fieldName];
            const oldId = Array.isArray(field) ? field[1] : field && field.id;
            applyReplacement(field, getReplacement(kind, oldId));
        }
    }
};

export default async ({addon, console, msg}) => {
    const vm = addon.tab.traps.vm;
    if (!vm) {
        console.error('无法获取 Scratch VM 实例');
        return;
    }
    setupPauseControls(addon);

    const container = document.createElement('div');
    container.className = 'jsonConverterContainer';
    container.style.cssText = `
        position: absolute;
        top: 80px;
        left: 80px;
        z-index: 10000;
        background-color: #f8fafc;
        color: #172033;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        box-shadow: 0 18px 48px rgba(15,23,42,0.2), 0 2px 8px rgba(15,23,42,0.12);
        width: 760px;
        height: 560px;
        min-width: 420px;
        max-width: 90vw;
        min-height: 320px;
        max-height: 90vh;
        display: none;
        flex-direction: column;
        resize: both;
        overflow: hidden;
    `;

    const titleBar = document.createElement('div');
    titleBar.className = 'jsonConverterTitleBar';
    titleBar.style.cssText = `
        padding: 10px 12px;
        background-color: #ffffff;
        border-bottom: 1px solid #dbe3ee;
        cursor: move;
        display: flex;
        justify-content: flex-start;
        align-items: center;
        flex-shrink: 0;
        min-height: 44px;
        box-sizing: border-box;
    `;
    titleBar.innerHTML = '<span style="font-weight:bold;">积木脚本助手</span>';
    container.appendChild(titleBar);

    const titleSpacer = document.createElement('div');
    titleSpacer.style.cssText = 'flex:1 1 auto;';
    titleBar.appendChild(titleSpacer);

    const titleAiActions = document.createElement('div');
    titleAiActions.className = 'jsonConverterTitleAiActions';
    titleAiActions.style.cssText = 'display:none;align-items:center;gap:8px;';
    titleBar.appendChild(titleAiActions);

    const titleAiConfigButton = document.createElement('button');
    titleAiConfigButton.type = 'button';
    titleAiConfigButton.className = 'jsonConverterTitleAiConfigButton';
    titleAiConfigButton.style.cssText = 'height:28px;min-width:28px;border:1px solid #cbd5e1;border-radius:6px;background:#ffffff;color:#172033;cursor:pointer;font-size:13px;font-weight:700;padding:0 9px;display:flex;align-items:center;justify-content:center;';
    titleAiConfigButton.onmousedown = e => e.stopPropagation();
    titleAiConfigButton.onclick = e => {
        e.stopPropagation();
        if (reactModalInstance && typeof reactModalInstance.handleAiTitleConfigAction === 'function') {
            reactModalInstance.handleAiTitleConfigAction();
        }
    };
    titleAiActions.appendChild(titleAiConfigButton);

    const titleAiCloseButton = document.createElement('button');
    titleAiCloseButton.type = 'button';
    titleAiCloseButton.className = 'jsonConverterTitleAiCloseButton';
    titleAiCloseButton.textContent = '关闭 AI';
    titleAiCloseButton.title = '关闭 AI';
    titleAiCloseButton.style.cssText = 'height:28px;border:1px solid #cbd5e1;border-radius:6px;background:#ffffff;color:#172033;cursor:pointer;font-size:13px;font-weight:700;padding:0 10px;display:flex;align-items:center;justify-content:center;';
    titleAiCloseButton.onmousedown = e => e.stopPropagation();
    titleAiCloseButton.onclick = e => {
        e.stopPropagation();
        if (reactModalInstance && typeof reactModalInstance.closeAiChat === 'function') {
            reactModalInstance.closeAiChat();
        }
    };
    titleAiActions.appendChild(titleAiCloseButton);

    const closeButton = document.createElement('button');
    closeButton.className = 'jsonConverterCloseButton';
    closeButton.textContent = '\u00d7';
    closeButton.title = msg ? (msg('close') || 'Close') : 'Close';
    closeButton.style.cssText = 'width:28px;height:28px;border:1px solid transparent;border-radius:6px;background:transparent;color:#64748b;cursor:pointer;font-size:16px;font-weight:bold;padding:0;line-height:1;display:flex;align-items:center;justify-content:center;margin-left:8px;';
    closeButton.onclick = e => {
        e.stopPropagation();
        if (reactModalInstance && typeof reactModalInstance.closeAiChat === 'function') {
            reactModalInstance.closeAiChat();
        }
        container.style.display = 'none';
    };
    titleBar.appendChild(closeButton);

    const jsonEditorContainer = document.createElement('div');
    jsonEditorContainer.className = 'jsonConverterEditor';
    jsonEditorContainer.style.cssText = 'flex-grow:1;overflow:auto;padding:12px;border-bottom:1px solid #dbe3ee;position:relative;background:#f8fafc;';
    container.appendChild(jsonEditorContainer);

    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'jsonConverterToolbar';
    buttonContainer.style.cssText = 'padding:10px 12px;display:flex;justify-content:flex-start;align-items:center;gap:8px;flex-wrap:wrap;flex-shrink:0;background:#ffffff;';
    container.appendChild(buttonContainer);

    const statusContainer = document.createElement('div');
    statusContainer.className = 'jsonConverterStatus';
    statusContainer.style.cssText = 'padding:8px 12px;font-size:12px;border-top:1px solid #dbe3ee;max-height:120px;overflow-y:auto;flex-shrink:0;display:none;white-space:pre-wrap;line-height:1.45;';
    container.appendChild(statusContainer);

    const setStatus = (message, kind) => {
        if (!message) {
            statusContainer.style.display = 'none';
            statusContainer.textContent = '';
            return;
        }
        statusContainer.textContent = message;
        statusContainer.style.color = kind === 'success' ? '#047857' : (kind === 'info' ? '#334155' : '#b42318');
        statusContainer.style.background = kind === 'success' ? '#ecfdf5' : (kind === 'info' ? '#f8fafc' : '#fff1f2');
        statusContainer.style.display = 'block';
    };

    // 阻止键盘事件冒泡到 Blockly / Scratch GUI 的全局监听（否则 backspace/delete 等会被工作区吃掉，
    // 甚至被当作"删除选中积木"）。必须在冒泡阶段 —— 捕获阶段会先于内部 contentEditable 处理，
    // 提前切断 JSON 编辑器自己的输入链路（按键看起来像被吞了）。
    const stopKey = e => e.stopPropagation();
    for (const evt of ['keydown', 'keypress', 'keyup', 'beforeinput']) {
        container.addEventListener(evt, stopKey, false);
    }

    // 容器内 Ctrl+F 走本地查找栏（不调浏览器原生查找）。find-bar 插件在 document 捕获阶段
    // preventDefault 吞掉 Ctrl+F；window 捕获阶段比 document 更早，这里抢先
    // stopImmediatePropagation 掐断分发，然后调本组件的 openFind / gotoNext / gotoPrev。
    const findShortcutHandler = e => {
        if (!container.contains(e.target)) return;
        const ctrl = e.ctrlKey || e.metaKey;
        if (!ctrl || e.altKey) return;
        const k = (e.key || '').toLowerCase();
        if (k !== 'f' && k !== 'g') return;
        const editor = reactModalInstance && reactModalInstance.jsonEditorComponent.current;
        if (!editor) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        if (k === 'f') {
            // 选中文本 → 作为查找框的初始值
            const ta = editor.textareaRef && editor.textareaRef.current;
            const hasSelection = ta && ta.selectionStart !== ta.selectionEnd;
            const seed = hasSelection ? editor.state.text.slice(ta.selectionStart, ta.selectionEnd) : null;
            editor.openFind(seed && !seed.includes('\n') ? seed : null);
        } else if (k === 'g') {
            if (e.shiftKey) editor.gotoPrev(); else editor.gotoNext();
        }
    };
    // 常驻监听：容器隐藏时 contains 自然为 false，是无副作用的 no-op，不必随 disabled 拆装
    window.addEventListener('keydown', findShortcutHandler, true);

    makeDraggable(container, titleBar);

    // 用"透明 textarea + 上层彩色 <pre>"组合替换 react-json-editor-ajrm。
    // 后者有多个难绕开的 bug（粘贴复制、tokenizer 对部分字符报错等）。
    // textarea 负责输入，<pre> 负责显示高亮，两者同字体同大小同 padding 精确对齐。
    const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const highlightJson = text => {
        let out = '';
        let i = 0;
        const n = text.length;
        while (i < n) {
            const c = text[i];
            // 字符串（单/双引号；兼容 JS 字面量）
            if (c === '"' || c === "'") {
                const quote = c;
                let j = i + 1;
                while (j < n) {
                    if (text[j] === '\\') { j += 2; continue; }
                    if (text[j] === quote) { j++; break; }
                    j++;
                }
                // 是 key 吗：向后看过空白是否遇到冒号
                let k = j;
                while (k < n && /\s/.test(text[k])) k++;
                const isKey = text[k] === ':';
                out += `<span style="color:${isKey ? '#a71d5d' : '#032f62'}">${escapeHtml(text.slice(i, j))}</span>`;
                i = j;
                continue;
            }
            // 数字
            if ((c === '-' || (c >= '0' && c <= '9'))) {
                const prev = i === 0 ? '' : text[i - 1];
                if (i === 0 || /[\s,:{\[]/.test(prev)) {
                    let j = i;
                    if (c === '-') j++;
                    while (j < n && /[\d.eE+-]/.test(text[j])) j++;
                    out += `<span style="color:#008000">${escapeHtml(text.slice(i, j))}</span>`;
                    i = j;
                    continue;
                }
            }
            // 标识符：true/false/null 或 JS 字面量里的裸键
            if (/[a-zA-Z_$]/.test(c)) {
                let j = i;
                while (j < n && /[\w$]/.test(text[j])) j++;
                const word = text.slice(i, j);
                if (word === 'true' || word === 'false' || word === 'null') {
                    out += `<span style="color:#008000">${escapeHtml(word)}</span>`;
                } else {
                    let k = j;
                    while (k < n && /\s/.test(text[k])) k++;
                    const isKey = text[k] === ':';
                    out += isKey ? `<span style="color:#a71d5d">${escapeHtml(word)}</span>` : escapeHtml(word);
                }
                i = j;
                continue;
            }
            out += escapeHtml(c);
            i++;
        }
        // 保证末尾换行被保留为一个可视空行（否则 pre 会吃掉最后一个 \n）
        if (text.endsWith('\n')) out += ' ';
        return out;
    };

    // 伪代码语法高亮：
    //   - 双引号字符串 → 绿色
    //   - 数字 → 蓝色
    //   - #vars / #lists / #localvars / #locallists 头部关键字 → 橙色
    //   - @op / @ident → 红色
    //   - 语法控制关键字（if/else/define/warp/return/true/false/null/at 等） → 紫红色
    //   - 内置引用 helper（var/list/broadcast/broadcast_ref/arg/arg_bool） → 紫色
    //   - 传入的 extraKeywords（OPCODE_DEFS 里的已登记名） → 深蓝色
    //   - 其他 → 默认色
    const PSEUDO_SYNTAX_KEYWORDS = new Set([
        'if', 'else', 'while', 'repeat', 'forever', 'until',
        'define', 'warp', 'return', 'call', 'callret',
        'as', 'bool', 'str',
        'true', 'false', 'null', 'at'
    ]);
    const PSEUDO_BUILTIN_HELPERS = new Set([
        'var', 'list', 'broadcast', 'broadcast_ref',
        'arg', 'arg_bool'
    ]);
    const highlightPseudocode = (text, extraKeywords) => {
        let out = '';
        let i = 0;
        const n = text.length;
        while (i < n) {
            const c = text[i];
            // 双引号字符串（支持反斜线转义）
            if (c === '"') {
                let j = i + 1;
                while (j < n) {
                    if (text[j] === '\\') { j += 2; continue; }
                    if (text[j] === '"') { j++; break; }
                    j++;
                }
                out += `<span style="color:#032f62">${escapeHtml(text.slice(i, j))}</span>`;
                i = j;
                continue;
            }
            // #header 关键字
            if (c === '#') {
                let j = i + 1;
                while (j < n && /[a-zA-Z_\u4e00-\u9fa5]/.test(text[j])) j++;
                if (j > i + 1) {
                    out += `<span style="color:#e36209;font-weight:bold">${escapeHtml(text.slice(i, j))}</span>`;
                    i = j;
                    continue;
                }
            }
            // @op / @ident
            if (c === '@') {
                let j = i + 1;
                while (j < n && /[a-zA-Z_\u4e00-\u9fa5]/.test(text[j])) j++;
                if (j > i + 1) {
                    out += `<span style="color:#d73a49;font-weight:bold">${escapeHtml(text.slice(i, j))}</span>`;
                    i = j;
                    continue;
                }
            }
            // 数字
            if ((c === '-' || (c >= '0' && c <= '9'))) {
                const prev = i === 0 ? '' : text[i - 1];
                if (i === 0 || /[\s,:;{[(=+\-*/<>!&|]/.test(prev)) {
                    let j = i;
                    if (c === '-') j++;
                    let hasDigit = false;
                    while (j < n && /[\d.eE+\-]/.test(text[j])) {
                        if (/\d/.test(text[j])) hasDigit = true;
                        j++;
                    }
                    if (hasDigit && j > i) {
                        out += `<span style="color:#005cc5">${escapeHtml(text.slice(i, j))}</span>`;
                        i = j;
                        continue;
                    }
                }
            }
            // 标识符（含 CJK）
            if (/[a-zA-Z_\u4e00-\u9fa5]/.test(c)) {
                let j = i;
                while (j < n && /[a-zA-Z0-9_\u4e00-\u9fa5]/.test(text[j])) j++;
                const word = text.slice(i, j);
                let color = '';
                let bold = false;
                if (PSEUDO_SYNTAX_KEYWORDS.has(word)) { color = '#a71d5d'; bold = true; }
                else if (PSEUDO_BUILTIN_HELPERS.has(word)) { color = '#6f42c1'; }
                else if (extraKeywords && extraKeywords.has(word)) { color = '#0366d6'; }
                if (color) {
                    const style = `color:${color}${bold ? ';font-weight:bold' : ''}`;
                    out += `<span style="${style}">${escapeHtml(word)}</span>`;
                } else {
                    out += escapeHtml(word);
                }
                i = j;
                continue;
            }
            out += escapeHtml(c);
            i++;
        }
        if (text.endsWith('\n')) out += ' ';
        return out;
    };

    // 匹配高亮层：全文 text 按 match 范围切段，命中段包 <span> 带底色。
    // 整层 color:transparent，只暴露背景矩形；字体/行高/padding 与 highlight 层一致，
    // 保证位置精确对齐（与上方 textarea 的光标和选区也对齐）。
    const renderMatchesHtml = (text, matches, currentIndex) => {
        let out = '';
        let cursor = 0;
        matches.forEach((m, i) => {
            if (cursor < m.start) out += escapeHtml(text.slice(cursor, m.start));
            const bg = i === currentIndex ? '#ff9632' : '#ffe56b';
            out += `<span style="background:${bg};border-radius:2px;">${escapeHtml(text.slice(m.start, m.end))}</span>`;
            cursor = m.end;
        });
        if (cursor < text.length) out += escapeHtml(text.slice(cursor));
        if (text.endsWith('\n')) out += ' ';
        return out;
    };

    const sharedTextStyle = {
        fontFamily: 'Consolas, "Cascadia Code", "Courier New", monospace',
        fontSize: '13px',
        lineHeight: '1.45',
        padding: '10px',
        margin: 0,
        border: '1px solid #cbd5e1',
        borderRadius: '6px',
        boxSizing: 'border-box',
        whiteSpace: 'pre',
        wordWrap: 'normal',
        overflowWrap: 'normal',
        tabSize: 2
    };

    class JsonEditorComponent extends React.Component {
        constructor (props) {
            super(props);
            this.textareaRef = React.createRef();
            this.preRef = React.createRef();
            this.matchesRef = React.createRef();
            this.gutterRef = React.createRef();
            this.findInputRef = React.createRef();
            this.state = {
                text: props.initialText || '',
                findOpen: false,
                findQuery: '',
                findMatches: [],
                findIndex: 0,
                // 补全弹层：null 或 {items: string[], selectedIndex, wordStart, left, top}
                autoComplete: null
            };
        }
        componentDidMount () {
            // 容器级 stopKey 在 bubble 阶段掐断传播（防止按键漏给 Blockly），
            // React 16 的事件代理在 document 上，onKeyDown 会收不到 —— 所以直接绑 textarea。
            const ta = this.textareaRef.current;
            if (ta) ta.addEventListener('keydown', this.handleTextareaKeyDown, false);
        }
        componentWillUnmount () {
            const ta = this.textareaRef.current;
            if (ta) ta.removeEventListener('keydown', this.handleTextareaKeyDown, false);
        }
        // Modal 通过 ref 调用：直接替换编辑器文本（模式切换、加载时用）
        setText = (text) => {
            this.setState({
                text,
                autoComplete: null,
                findMatches: this.state.findQuery ? computeMatches(text, this.state.findQuery) : [],
                findIndex: 0
            });
        };
        getText = () => this.state.text;
        // textarea 的可视高度（CSS 像素）。给 Modal 的"视口中心对齐"算法用。
        getViewHeight = () => (this.textareaRef.current ? this.textareaRef.current.clientHeight : 0);
        handleChange = e => {
            const text = e.target.value;
            this.setState({
                text,
                findMatches: this.state.findQuery ? computeMatches(text, this.state.findQuery) : [],
                findIndex: 0
            }, () => this.maybeOpenAutocomplete());
            if (this.props.onChange) this.props.onChange();
        };
        handleScroll = () => {
            if (!this.textareaRef.current) return;
            const {scrollTop, scrollLeft} = this.textareaRef.current;
            if (this.preRef.current) {
                this.preRef.current.scrollTop = scrollTop;
                this.preRef.current.scrollLeft = scrollLeft;
            }
            if (this.matchesRef.current) {
                this.matchesRef.current.scrollTop = scrollTop;
                this.matchesRef.current.scrollLeft = scrollLeft;
            }
            if (this.gutterRef.current) {
                this.gutterRef.current.scrollTop = scrollTop;
            }
            // 弹层位置在打开那一刻固定（减去当时的 scrollLeft/Top）；滚动后会漂，直接关掉省事
            if (this.state.autoComplete) this.closeAutocomplete();
            if (this.props.onScroll) this.props.onScroll(scrollTop);
        };
        // 程序化设置 scrollTop（用于"工作区滚动 → 编辑器跟随"）。直接改 textarea.scrollTop
        // 会同步触发 scroll 事件 → handleScroll → onScroll，需要调用方用 suppression 抑制回环。
        setScrollTop = top => {
            const ta = this.textareaRef.current;
            if (!ta) return;
            ta.scrollTop = top;
            if (this.preRef.current) this.preRef.current.scrollTop = top;
            if (this.matchesRef.current) this.matchesRef.current.scrollTop = top;
            if (this.gutterRef.current) this.gutterRef.current.scrollTop = top;
        };
        openFind = (seedQuery) => {
            const useSeed = typeof seedQuery === 'string' && seedQuery.length > 0;
            const stateUpdate = {findOpen: true};
            if (useSeed) {
                const matches = computeMatches(this.state.text, seedQuery);
                stateUpdate.findQuery = seedQuery;
                stateUpdate.findMatches = matches;
                stateUpdate.findIndex = 0;
            }
            this.setState(stateUpdate, () => {
                if (this.findInputRef.current) {
                    this.findInputRef.current.focus();
                    this.findInputRef.current.select();
                }
                if (useSeed && stateUpdate.findMatches.length) this.selectMatch(0);
            });
        };
        closeFind = () => {
            this.setState({findOpen: false}, () => {
                if (this.textareaRef.current) this.textareaRef.current.focus();
            });
        };
        updateFindQuery = query => {
            const matches = query ? computeMatches(this.state.text, query) : [];
            this.setState({findQuery: query, findMatches: matches, findIndex: 0}, () => {
                if (matches.length) this.selectMatch(0);
            });
        };
        selectMatch = i => {
            const m = this.state.findMatches[i];
            if (!m || !this.textareaRef.current) return;
            const ta = this.textareaRef.current;
            // 手动算 match 所在行，强制把它滚到可视区（比依赖 setSelectionRange 的自动滚动更可靠）
            const before = this.state.text.slice(0, m.start);
            const lineNum = (before.match(/\n/g) || []).length;
            const lineHeight = 13 * 1.4; // 与 sharedTextStyle 保持一致
            const paddingY = 8;
            const targetTop = lineNum * lineHeight;
            const viewportH = ta.clientHeight - paddingY * 2;
            if (targetTop < ta.scrollTop) {
                ta.scrollTop = Math.max(0, targetTop - lineHeight);
            } else if (targetTop > ta.scrollTop + viewportH - lineHeight) {
                ta.scrollTop = Math.max(0, targetTop - viewportH / 2);
            }
            ta.focus();
            ta.setSelectionRange(m.start, m.end);
            this.handleScroll(); // 同步到两层 pre
            // focus 会把焦点从查找输入框抢走；立刻把焦点还回去，否则 Enter 就没法继续查找了
            if (this.findInputRef.current) this.findInputRef.current.focus();
        };
        gotoNext = () => {
            const {findMatches, findIndex} = this.state;
            if (!findMatches.length) return;
            const next = (findIndex + 1) % findMatches.length;
            this.setState({findIndex: next}, () => this.selectMatch(next));
        };
        gotoPrev = () => {
            const {findMatches, findIndex} = this.state;
            if (!findMatches.length) return;
            const prev = (findIndex - 1 + findMatches.length) % findMatches.length;
            this.setState({findIndex: prev}, () => this.selectMatch(prev));
        };
        handleFindInputKeyDown = e => {
            if (e.key === 'Escape') { e.preventDefault(); this.closeFind(); return; }
            if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) this.gotoPrev(); else this.gotoNext();
                return;
            }
            if (e.key === 'ArrowDown') { e.preventDefault(); this.gotoNext(); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); this.gotoPrev(); return; }
        };
        // ==================== 代码补全 ====================
        // 单色等宽字体下按列×字宽粗定位；实际像素可能偏几 px，对 UX 无感。
        getCursorPixel = () => {
            const ta = this.textareaRef.current;
            if (!ta) return {left: 0, top: 0};
            const pos = ta.selectionStart;
            const before = this.state.text.slice(0, pos);
            const lineNum = (before.match(/\n/g) || []).length;
            const lastNl = before.lastIndexOf('\n');
            const col = pos - (lastNl + 1);
            const lineHeight = 13 * 1.4;
            const charWidth = 13 * 0.6;
            const padding = 8;
            // textarea 因 gutter 整体右移：offsetLeft 反映相对父容器的 x 起点（= gutterWidth）
            const xOffset = ta.offsetLeft || 0;
            return {
                left: xOffset + padding + col * charWidth - ta.scrollLeft,
                top: padding + (lineNum + 1) * lineHeight - ta.scrollTop
            };
        };
        getAutocompleteCallContext = (text, pos) => {
            const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
            const source = text.slice(lineStart, pos);
            const stack = [];
            let inString = false;
            let stringStart = -1;
            let escape = false;
            const isIdentChar = ch => /[a-zA-Z0-9_\u4e00-\u9fa5]/.test(ch);
            for (let i = 0; i < source.length; i++) {
                const ch = source[i];
                if (inString) {
                    if (escape) { escape = false; continue; }
                    if (ch === '\\') { escape = true; continue; }
                    if (ch === '"') {
                        inString = false;
                        stringStart = -1;
                    }
                    continue;
                }
                if (ch === '/' && source[i + 1] === '/') break;
                if (ch === '"') {
                    inString = true;
                    stringStart = i;
                    continue;
                }
                if (ch === '(') {
                    let j = i - 1;
                    while (j >= 0 && /\s/.test(source[j])) j--;
                    const end = j + 1;
                    while (j >= 0 && isIdentChar(source[j])) j--;
                    const callName = source.slice(j + 1, end);
                    stack.push({callName, argIndex: 0, openIndex: i});
                    continue;
                }
                if (ch === ')') {
                    stack.pop();
                    continue;
                }
                if (ch === ',' && stack.length) {
                    stack[stack.length - 1].argIndex++;
                }
            }
            if (!stack.length) return null;
            const top = stack[stack.length - 1];
            const beforeOpen = source.slice(0, top.openIndex);
            const isDefineParams = /(^|\s)define\s+(?:"[^"]+"|[a-zA-Z0-9_\u4e00-\u9fa5]+)\s*$/.test(beforeOpen);
            if (!top.callName && !isDefineParams) return null;
            return {
                callName: top.callName,
                argIndex: top.argIndex,
                inString,
                stringStart: inString ? lineStart + stringStart : -1,
                isDefineParams
            };
        };
        maybeOpenAutocomplete = () => {
            const baseKeywords = this.props.completionKeywords || [];
            const dynamic = typeof this.props.getDynamicKeywords === 'function'
                ? (this.props.getDynamicKeywords() || []) : [];
            const ta = this.textareaRef.current;
            if (!ta) return;
            const pos = ta.selectionStart;
            if (pos !== ta.selectionEnd) { this.closeAutocomplete(); return; }
            const text = this.state.text;
            const context = this.getAutocompleteCallContext(text, pos);
            const hasContextualProvider = !!(context && typeof this.props.getContextualCompletions === 'function');
            const contextual = hasContextualProvider
                ? (this.props.getContextualCompletions(context) || [])
                : [];
            // 向前扫描获取光标处"单词前缀"；标识符范围和 pseudocode tokenizer 对齐（含 CJK）
            let start = pos;
            if (context && context.inString && context.stringStart >= 0) {
                start = context.stringStart + 1;
            } else {
                while (start > 0 && /[a-zA-Z0-9_\u4e00-\u9fa5]/.test(text[start - 1])) start--;
            }
            const word = text.slice(start, pos);
            const keywords = hasContextualProvider
                ? contextual
                : (dynamic.length ? Array.from(new Set([...baseKeywords, ...dynamic])) : baseKeywords);
            if (!keywords.length) { this.closeAutocomplete(); return; }
            if (word.length < 1 && !hasContextualProvider) { this.closeAutocomplete(); return; }
            const lower = word.toLowerCase();
            // 子串匹配（不只匹前缀），前缀命中排在前、其次按首次匹配位置、最后按长度升序。
            // k !== word 跳过完全等于当前词的项（弹层就是帮输入补全用的，没必要再显示自己）。
            const normalizedKeywords = [];
            const seenKeyword = new Set();
            keywords.forEach((item, order) => {
                const isObject = item && typeof item === 'object';
                const label = String(isObject ? item.value : item);
                if (!label || seenKeyword.has(label)) return;
                seenKeyword.add(label);
                normalizedKeywords.push({
                    label,
                    priority: isObject && Number.isFinite(Number(item.priority)) ? Number(item.priority) : 10,
                    order
                });
            });
            const candidates = [];
            for (const item of normalizedKeywords) {
                if (item.label === word) continue;
                const label = item.label;
                const searchable = label.replace(/^"([\s\S]*)"$/, '$1').toLowerCase();
                const idx = lower ? searchable.indexOf(lower) : 0;
                if (idx < 0) continue;
                candidates.push({k: label, idx, len: searchable.length, priority: item.priority, order: item.order});
            }
            candidates.sort((a, b) => {
                if (contextual.length && a.priority !== b.priority) return a.priority - b.priority;
                if ((a.idx === 0) !== (b.idx === 0)) return a.idx === 0 ? -1 : 1;
                if (a.idx !== b.idx) return a.idx - b.idx;
                if (a.len !== b.len) return a.len - b.len;
                if (contextual.length && a.order !== b.order) return a.order - b.order;
                return a.k < b.k ? -1 : (a.k > b.k ? 1 : 0);
            });
            const items = candidates.slice(0, 16).map(c => c.k);
            if (!items.length) { this.closeAutocomplete(); return; }
            const {left, top} = this.getCursorPixel();
            this.setState({autoComplete: {items, selectedIndex: 0, wordStart: start, left, top}});
        };
        closeAutocomplete = () => {
            if (this.state.autoComplete) this.setState({autoComplete: null});
        };
        acceptAutocomplete = () => {
            const ac = this.state.autoComplete;
            if (!ac) return false;
            const ta = this.textareaRef.current;
            if (!ta) return false;
            const pos = ta.selectionStart;
            const text = this.state.text;
            const chosen = ac.items[ac.selectedIndex];
            if (!chosen) return false;
            const newText = text.slice(0, ac.wordStart) + chosen + text.slice(pos);
            const newPos = ac.wordStart + chosen.length;
            this.setState({
                text: newText,
                autoComplete: null,
                findMatches: this.state.findQuery ? computeMatches(newText, this.state.findQuery) : [],
                findIndex: 0
            }, () => {
                if (this.textareaRef.current) this.textareaRef.current.setSelectionRange(newPos, newPos);
            });
            if (this.props.onChange) this.props.onChange();
            return true;
        };
        moveAutocompleteSelection = delta => {
            const ac = this.state.autoComplete;
            if (!ac) return;
            const n = ac.items.length;
            const idx = ((ac.selectedIndex + delta) % n + n) % n;
            this.setState({autoComplete: {...ac, selectedIndex: idx}});
        };

        // 默认 Tab 会让焦点跳出 textarea。这里拦下来，单光标 → 插 2 空格；
        // 选中跨行 → 整体缩进/反缩进；保留 dedent 里的"最多去 2 个空格"语义，避免吃掉不小心的非空白。
        // Enter：保留当前行缩进；若光标夹在 {}、[] 中间，插"空行+多一级缩进+原缩进闭合"。
        // 补全弹层打开时：Arrow Up/Down 移动选中、Tab 接受、Esc 关闭；Enter 关闭弹层走换行。
        handleTextareaKeyDown = e => {
            // 先处理补全弹层的导航键（优先级最高）
            if (this.state.autoComplete) {
                if (e.key === 'ArrowDown') { e.preventDefault(); this.moveAutocompleteSelection(1); return; }
                if (e.key === 'ArrowUp')   { e.preventDefault(); this.moveAutocompleteSelection(-1); return; }
                if (e.key === 'Escape')    { e.preventDefault(); this.closeAutocomplete(); return; }
                if (e.key === 'Tab') {
                    if (this.acceptAutocomplete()) { e.preventDefault(); return; }
                }
                // Enter 不再接受补全，仅关闭弹层然后走下面的普通换行/缩进逻辑
                if (e.key === 'Enter') this.closeAutocomplete();
                // 其他键（包括 ArrowLeft/Right 字符键）照常落下，随后 handleChange / 鼠标点击可能关闭弹层
            }

            // IME 组合输入阶段（中文选字等）不干预：否则会把中间态字符吞掉或破坏选中候选流程
            if (e.isComposing || e.keyCode === 229) return;

            // 自动补齐括号/引号：( [ { " 插一对；若有选区则把选区包起来
            const pairOpen = {'(': ')', '[': ']', '{': '}', '"': '"'};
            if (pairOpen[e.key] && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const ta = this.textareaRef.current;
                if (ta) {
                    const text = this.state.text;
                    const start = ta.selectionStart;
                    const end = ta.selectionEnd;
                    // 估算"当前是否在字符串内"：当前行光标左侧未配对的 " 个数是奇数 → 在串内
                    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
                    const leftOfCursor = text.slice(lineStart, start);
                    let inString = false;
                    let escape = false;
                    for (let k = 0; k < leftOfCursor.length; k++) {
                        const ch = leftOfCursor[k];
                        if (escape) { escape = false; continue; }
                        if (ch === '\\') { escape = true; continue; }
                        if (ch === '"') inString = !inString;
                    }
                    // 仅当"非字符串内"才自动成对；输入 " 且当前已在串内 → 走默认输入（相当于关闭串）
                    const shouldPair = !inString;
                    if (shouldPair) {
                        const close = pairOpen[e.key];
                        e.preventDefault();
                        let newText, newSelStart, newSelEnd;
                        if (start !== end) {
                            const sel = text.slice(start, end);
                            newText = text.slice(0, start) + e.key + sel + close + text.slice(end);
                            newSelStart = start + 1;
                            newSelEnd = end + 1; // 保留选区在内部
                        } else {
                            newText = text.slice(0, start) + e.key + close + text.slice(end);
                            newSelStart = start + 1;
                            newSelEnd = start + 1;
                        }
                        this.setState({
                            text: newText,
                            autoComplete: null,
                            findMatches: this.state.findQuery ? computeMatches(newText, this.state.findQuery) : [],
                            findIndex: 0
                        }, () => {
                            if (this.textareaRef.current) {
                                this.textareaRef.current.setSelectionRange(newSelStart, newSelEnd);
                                this.maybeOpenAutocomplete();
                            }
                        });
                        if (this.props.onChange) this.props.onChange();
                        return;
                    }
                }
            }
            // 输入闭括号 / 关闭引号时：若光标紧邻同一个字符，直接跳过不重复插入
            if ((e.key === ')' || e.key === ']' || e.key === '}' || e.key === '"') && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const ta = this.textareaRef.current;
                if (ta) {
                    const start = ta.selectionStart;
                    const end = ta.selectionEnd;
                    if (start === end && this.state.text[start] === e.key) {
                        e.preventDefault();
                        ta.setSelectionRange(start + 1, start + 1);
                        this.maybeOpenAutocomplete();
                        return;
                    }
                }
            }
            // Backspace 删空对（光标夹在 ()/[]/{}/"" 正中间）→ 两侧一起删
            if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
                const ta = this.textareaRef.current;
                if (ta) {
                    const start = ta.selectionStart;
                    const end = ta.selectionEnd;
                    if (start === end && start > 0) {
                        const prev = this.state.text[start - 1];
                        const next = this.state.text[start];
                        const pairs = {'(': ')', '[': ']', '{': '}', '"': '"'};
                        if (pairs[prev] && pairs[prev] === next) {
                            e.preventDefault();
                            const text = this.state.text;
                            const newText = text.slice(0, start - 1) + text.slice(start + 1);
                            this.setState({
                                text: newText,
                                autoComplete: null,
                                findMatches: this.state.findQuery ? computeMatches(newText, this.state.findQuery) : [],
                                findIndex: 0
                            }, () => {
                                if (this.textareaRef.current) this.textareaRef.current.setSelectionRange(start - 1, start - 1);
                            });
                            if (this.props.onChange) this.props.onChange();
                            return;
                        }
                    }
                }
            }

            // Enter：保留缩进；{}/[] 夹光标时分行
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const ta = this.textareaRef.current;
                if (!ta) return;
                const text = this.state.text;
                const start = ta.selectionStart;
                const end = ta.selectionEnd;
                if (start !== end) return; // 选区让默认行为处理（替换选区+换行）
                const lineStart = text.lastIndexOf('\n', start - 1) + 1;
                const linePrefix = text.slice(lineStart, start);
                const indent = (linePrefix.match(/^[ \t]*/) || [''])[0];
                const prevChar = text[start - 1] || '';
                const nextChar = text[start] || '';
                const pairOpen = (prevChar === '{' && nextChar === '}')
                              || (prevChar === '[' && nextChar === ']');
                if (pairOpen) {
                    e.preventDefault();
                    const inner = indent + '  ';
                    const ins = `\n${inner}\n${indent}`;
                    const newText = text.slice(0, start) + ins + text.slice(start);
                    const newPos = start + 1 + inner.length;
                    this.setState({
                        text: newText,
                        autoComplete: null,
                        findMatches: this.state.findQuery ? computeMatches(newText, this.state.findQuery) : [],
                        findIndex: 0
                    }, () => ta.setSelectionRange(newPos, newPos));
                    if (this.props.onChange) this.props.onChange();
                    return;
                }
                // 行尾是开括号 → 下一行多缩进 2 空格
                const trimmed = linePrefix.replace(/\s+$/, '');
                const extra = (trimmed.endsWith('{') || trimmed.endsWith('[') || trimmed.endsWith('(')) ? '  ' : '';
                if (!indent && !extra) return; // 没缩进也没开括号，走默认
                e.preventDefault();
                const ins = `\n${indent}${extra}`;
                const newText = text.slice(0, start) + ins + text.slice(start);
                const newPos = start + ins.length;
                this.setState({
                    text: newText,
                    autoComplete: null,
                    findMatches: this.state.findQuery ? computeMatches(newText, this.state.findQuery) : [],
                    findIndex: 0
                }, () => ta.setSelectionRange(newPos, newPos));
                if (this.props.onChange) this.props.onChange();
                return;
            }

            if (e.key !== 'Tab') return;
            e.preventDefault();
            const ta = this.textareaRef.current;
            if (!ta) return;
            const INDENT = '  '; // 2 空格，对齐 sharedTextStyle 的 tabSize
            const text = this.state.text;
            const start = ta.selectionStart;
            const end = ta.selectionEnd;
            // 找到选区所在行的开头/结尾
            const lineStart = text.lastIndexOf('\n', start - 1) + 1;
            const selTextHasNewline = text.slice(start, end).includes('\n');

            if (selTextHasNewline) {
                // 跨行 → 对每一行做 indent/dedent
                const before = text.slice(0, lineStart);
                // end 可能正好在 \n 上；若结尾不是行首，把它扩到行尾
                let blockEnd = end;
                if (blockEnd > 0 && text[blockEnd - 1] !== '\n') {
                    const nextNl = text.indexOf('\n', blockEnd);
                    blockEnd = nextNl === -1 ? text.length : nextNl;
                }
                const block = text.slice(lineStart, blockEnd);
                const after = text.slice(blockEnd);
                const lines = block.split('\n');
                let newBlock;
                if (e.shiftKey) {
                    newBlock = lines.map(l => {
                        if (l.startsWith(INDENT)) return l.slice(INDENT.length);
                        if (l.startsWith(' ')) return l.slice(1);
                        if (l.startsWith('\t')) return l.slice(1);
                        return l;
                    }).join('\n');
                } else {
                    newBlock = lines.map(l => INDENT + l).join('\n');
                }
                const newText = before + newBlock + after;
                const newStart = lineStart;
                const newEnd = lineStart + newBlock.length;
                this.setState({
                    text: newText,
                    findMatches: this.state.findQuery ? computeMatches(newText, this.state.findQuery) : [],
                    findIndex: 0
                }, () => {
                    ta.setSelectionRange(newStart, newEnd);
                });
                if (this.props.onChange) this.props.onChange();
                return;
            }

            // 单行/光标：Shift+Tab 去掉行首 2 空格；Tab 在光标处插 2 空格
            if (e.shiftKey) {
                const currentLineEnd = text.indexOf('\n', lineStart);
                const lineEnd = currentLineEnd === -1 ? text.length : currentLineEnd;
                const line = text.slice(lineStart, lineEnd);
                let strip = 0;
                if (line.startsWith(INDENT)) strip = INDENT.length;
                else if (line.startsWith(' ')) strip = 1;
                else if (line.startsWith('\t')) strip = 1;
                if (!strip) return;
                const newText = text.slice(0, lineStart) + line.slice(strip) + text.slice(lineEnd);
                const newCursor = Math.max(lineStart, start - strip);
                this.setState({
                    text: newText,
                    findMatches: this.state.findQuery ? computeMatches(newText, this.state.findQuery) : [],
                    findIndex: 0
                }, () => ta.setSelectionRange(newCursor, newCursor));
            } else {
                const newText = text.slice(0, start) + INDENT + text.slice(end);
                const newCursor = start + INDENT.length;
                this.setState({
                    text: newText,
                    findMatches: this.state.findQuery ? computeMatches(newText, this.state.findQuery) : [],
                    findIndex: 0
                }, () => ta.setSelectionRange(newCursor, newCursor));
            }
            if (this.props.onChange) this.props.onChange();
        };
        // 只返回原始文本；具体解析由 Modal 按当前模式决定
        readFromDOM = () => {
            const text = (this.state.text || '').trim();
            if (!text) return {ok: false, error: '编辑器为空'};
            return {ok: true, text};
        };
        render () {
            const {findOpen, findQuery, findMatches, findIndex} = this.state;
            const matchLabel = findQuery
                ? (findMatches.length ? `${findIndex + 1}/${findMatches.length}` : '0/0')
                : '';
            const pseudoMode = this.props.mode === 'pseudo';
            // 每次 render 从 completionKeywords 重建 Set；数组一般几百项，构造成本可忽略。
            this._pseudoKeywordSet = pseudoMode ? new Set(this.props.completionKeywords || []) : null;
            // 行号（装订线）：按行数生成 "1\n2\n3\n..."
            const lineCount = Math.max(1, (this.state.text.match(/\n/g) || []).length + 1);
            const gutterWidth = Math.max(24, String(lineCount).length * 9 + 10);
            let gutterText = '';
            for (let ln = 1; ln <= lineCount; ln++) gutterText += (ln > 1 ? '\n' : '') + ln;
            const findBtnStyle = {
                border: '1px solid #cbd5e1',
                background: '#f8fafc',
                color: '#334155',
                cursor: 'pointer',
                padding: '0',
                width: '24px',
                height: '24px',
                fontSize: '12px',
                borderRadius: '5px',
                lineHeight: 1,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center'
            };
            return (
                <div style={{position: 'absolute', inset: 0}}>
                    <pre
                        ref={this.gutterRef}
                        aria-hidden="true"
                        style={{
                            ...sharedTextStyle,
                            position: 'absolute',
                            top: 0, bottom: 0, left: 0,
                            width: gutterWidth,
                            overflow: 'hidden',
                            pointerEvents: 'none',
                            color: '#64748b',
                            background: '#f1f5f9',
                            borderRight: '1px solid #d8e0ea',
                            borderRadius: '6px 0 0 6px',
                            borderTopRightRadius: 0,
                            borderBottomRightRadius: 0,
                            textAlign: 'right',
                            userSelect: 'none'
                        }}
                    >{gutterText}</pre>
                    <pre
                        ref={this.matchesRef}
                        aria-hidden="true"
                        style={{
                            ...sharedTextStyle,
                            position: 'absolute',
                            top: 0, bottom: 0, right: 0,
                            left: gutterWidth,
                            overflow: 'hidden',
                            pointerEvents: 'none',
                            color: 'transparent',
                            background: '#ffffff',
                            borderLeft: 'none',
                            borderRadius: '0 6px 6px 0'
                        }}
                        dangerouslySetInnerHTML={{__html: renderMatchesHtml(this.state.text, findMatches, findIndex)}}
                    />
                    <pre
                        ref={this.preRef}
                        aria-hidden="true"
                        style={{
                            ...sharedTextStyle,
                            position: 'absolute',
                            top: 0, bottom: 0, right: 0,
                            left: gutterWidth,
                            overflow: 'hidden',
                            pointerEvents: 'none',
                            color: '#1f2937',
                            background: 'transparent',
                            borderColor: 'transparent'
                        }}
                        dangerouslySetInnerHTML={{__html: pseudoMode
                            ? highlightPseudocode(this.state.text, this._pseudoKeywordSet)
                            : highlightJson(this.state.text)}}
                    />
                    <textarea
                        ref={this.textareaRef}
                        value={this.state.text}
                        onChange={this.handleChange}
                        onScroll={this.handleScroll}
                        onMouseDown={this.closeAutocomplete}
                        onBlur={this.closeAutocomplete}
                        spellCheck={false}
                        wrap="off"
                        style={{
                            ...sharedTextStyle,
                            position: 'absolute',
                            top: 0, bottom: 0, right: 0,
                            left: gutterWidth,
                            overflow: 'auto',
                            resize: 'none',
                            outline: 'none',
                            color: 'transparent',
                            caretColor: '#111827',
                            background: 'transparent',
                            borderColor: 'transparent'
                        }}
                    />
                    {this.state.autoComplete ? (
                        <div style={{
                            position: 'absolute',
                            left: Math.max(0, this.state.autoComplete.left),
                            top: this.state.autoComplete.top,
                            zIndex: 6,
                            background: '#ffffff',
                            border: '1px solid #cbd5e1',
                            borderRadius: '6px',
                            boxShadow: '0 12px 30px rgba(15,23,42,0.16), 0 2px 8px rgba(15,23,42,0.1)',
                            fontFamily: sharedTextStyle.fontFamily,
                            fontSize: '12px',
                            lineHeight: 1.3,
                            maxHeight: '180px',
                            overflow: 'auto',
                            minWidth: '144px',
                            padding: '4px'
                        }}>
                            {this.state.autoComplete.items.map((item, i) => (
                                <div
                                    key={item}
                                    // 用 mousedown 而不是 click：click 会让 textarea 先 blur，弹层就被 onBlur 关了
                                    onMouseDown={ev => {
                                        ev.preventDefault();
                                        this.setState({autoComplete: {...this.state.autoComplete, selectedIndex: i}}, () => {
                                            this.acceptAutocomplete();
                                            if (this.textareaRef.current) this.textareaRef.current.focus();
                                        });
                                    }}
                                    style={{
                                        padding: '5px 8px',
                                        cursor: 'pointer',
                                        borderRadius: '4px',
                                        background: i === this.state.autoComplete.selectedIndex ? '#2563eb' : 'transparent',
                                        color: i === this.state.autoComplete.selectedIndex ? '#fff' : '#1f2937'
                                    }}
                                >{item}</div>
                            ))}
                        </div>
                    ) : null}
                    {findOpen ? (
                        <div style={{
                            position: 'absolute',
                            top: 6,
                            right: 18,
                            zIndex: 5,
                            background: '#ffffff',
                            border: '1px solid #cbd5e1',
                            borderRadius: '8px',
                            padding: '6px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            boxShadow: '0 10px 24px rgba(15,23,42,0.14), 0 1px 4px rgba(15,23,42,0.1)',
                            fontSize: '12px'
                        }}>
                            <input
                                ref={this.findInputRef}
                                value={findQuery}
                                onChange={e => this.updateFindQuery(e.target.value)}
                                onKeyDown={this.handleFindInputKeyDown}
                                placeholder="查找"
                                style={{
                                    width: '140px',
                                    border: '1px solid #cbd5e1',
                                    padding: '4px 7px',
                                    fontSize: '12px',
                                    outline: 'none',
                                    borderRadius: '5px',
                                    color: '#172033',
                                    background: '#f8fafc'
                                }}
                            />
                            <span style={{color: '#64748b', minWidth: '38px', textAlign: 'center'}}>{matchLabel}</span>
                            <button onClick={this.gotoPrev} title="上一个 (Shift+Enter)" style={findBtnStyle}>↑</button>
                            <button onClick={this.gotoNext} title="下一个 (Enter)" style={findBtnStyle}>↓</button>
                            <button onClick={this.closeFind} title="关闭 (Esc)" style={findBtnStyle}>✕</button>
                        </div>
                    ) : null}
                </div>
            );
        }
    }

    const stringifyForEditor = value => {
        try {
            return JSON.stringify(value || {}, null, 2);
        } catch (_) {
            return '{}';
        }
    };

    // ------------ 模式无关工具 ------------
    // 把编辑器里的原始文本解析为 blocks 对象（短 ID 键、SB3 压缩形态）
    const parseJsonLikeText = text => {
        try {
            return {ok: true, value: JSON.parse(text)};
        } catch (_) { /* fall through */ }
        try {
            // eslint-disable-next-line no-new-func
            const value = new Function(`return (${text});`)();
            if (value === null || typeof value !== 'object') {
                return {ok: false, error: '解析结果不是对象'};
            }
            return {ok: true, value};
        } catch (err) {
            return {ok: false, error: `JSON/JS 语法错误: ${err.message}`};
        }
    };

    const PSEUDO_KEYWORDS = pseudoConverter.keywordNames || [];
    const AI_CONFIG_STORAGE_KEY = 'jsonScriptConverter.aiConfig.v1';
    const AI_CHAT_STORAGE_KEY = 'jsonScriptConverter.aiChats.v1';
    const UI_STATE_STORAGE_KEY = 'jsonScriptConverter.uiState.v1';
    const AI_CHAT_MAX_CONVERSATIONS = 40;
    const AI_CHAT_MAX_MESSAGES = 160;
    const AI_CHAT_RENDER_INITIAL_MESSAGES = 36;
    const AI_CHAT_RENDER_BATCH_MESSAGES = 24;
    const AI_MAX_TOOL_ROUNDS = 20;
    const AI_MAX_TOTAL_ROUNDS = 50;
    const AI_MAX_TOOL_CALLS_PER_BATCH = 16;
    const AI_DEFAULT_EMPTY_ASSET_MD5 = 'cd21514d0531fdffb22204e0ec5ed84a.svg';
    const AI_VISION_UNKNOWN = 'unknown';
    const AI_VISION_SUPPORTED = 'supported';
    const AI_VISION_UNSUPPORTED = 'unsupported';
    const AI_VISION_FAILED = 'failed';
    const AI_VISION_SOURCE_METADATA = 'metadata';
    const AI_VISION_SOURCE_NAME = 'name';
    const AI_VISION_SOURCE_SAVED = 'saved';
    const AI_SVG_SOURCE_LIMIT = 24000;
    const AI_SVG_WRITE_LIMIT = 200000;
    const AI_IMAGE_DATA_URL_LIMIT = 3500000;
    const AI_BITMAP_WRITE_DATA_URL_LIMIT = 6 * 1024 * 1024;
    const AI_BITMAP_WRITE_BYTE_LIMIT = 16 * 1024 * 1024;
    const AI_BITMAP_MAX_DIMENSION = 4096;
    const AI_BITMAP_MAX_PIXELS = 4096 * 4096;
    const AI_REQUEST_RETRY_DEFAULT_COUNT = 2;
    const AI_REQUEST_RETRY_MAX_COUNT = 5;
    const AI_REQUEST_RETRY_BASE_DELAY = 800;
    const AI_REQUEST_RETRY_MAX_DELAY = 6000;
    const AI_MCP_BRIDGE_DEFAULT_URL = 'http://127.0.0.1:47740';
    const AI_MCP_BRIDGE_EXE_NAME = '40code-MCP本地桥接器.exe';
    const AI_MCP_BRIDGE_EXE_DOWNLOAD_URL = '40code-mcp-bridge/40code-MCP本地桥接器.exe';
    const AI_MCP_BRIDGE_LEGACY_PATH_RE = /\/json-script-converter\/mcp\/?$/;
    const AI_MCP_BRIDGE_STORAGE_KEY = 'jsonScriptConverter.mcpBridgeUrl.v1';
    const AI_MCP_BRIDGE_ENABLED_STORAGE_KEY = 'jsonScriptConverter.mcpBridgeEnabled.v1';
    const AI_MCP_BRIDGE_IDLE_DELAY = 1500;
    const AI_MCP_BRIDGE_ACTIVE_DELAY = 80;
    const AI_MCP_BRIDGE_ERROR_DELAY = 2500;

    const loadAiConfig = () => {
        try {
            return JSON.parse(localStorage.getItem(AI_CONFIG_STORAGE_KEY) || '{}') || {};
        } catch (_) {
            return {};
        }
    };
    const saveAiConfig = config => {
        try {
            localStorage.setItem(AI_CONFIG_STORAGE_KEY, JSON.stringify(config || {}));
        } catch (_) { /* ignore */ }
    };
    const loadMcpBridgeEnabled = () => {
        try {
            return localStorage.getItem(AI_MCP_BRIDGE_ENABLED_STORAGE_KEY) === '1';
        } catch (_) {
            return false;
        }
    };
    const saveMcpBridgeEnabled = enabled => {
        try {
            localStorage.setItem(AI_MCP_BRIDGE_ENABLED_STORAGE_KEY, enabled ? '1' : '0');
        } catch (_) { /* ignore */ }
    };
    const normalizeMcpBridgeUrl = url => {
        const value = String(url || AI_MCP_BRIDGE_DEFAULT_URL).trim().replace(/\/+$/, '');
        return (value.replace(AI_MCP_BRIDGE_LEGACY_PATH_RE, '') || AI_MCP_BRIDGE_DEFAULT_URL);
    };
    const formatMcpBridgeStatus = status => {
        const value = String(status || 'disabled');
        if (value.startsWith('desktop-start-failed:')) {
            return `桌面端 MCP 启动失败：${value.slice('desktop-start-failed:'.length).trim() || '未知错误'}`;
        }
        return ({
            disabled: '未启用',
            starting: '启动中',
            connecting: '连接中',
            connected: '已连接',
            offline: '未连接'
        })[value] || value;
    };
    const loadMcpBridgeUrl = () => {
        try {
            return normalizeMcpBridgeUrl(localStorage.getItem(AI_MCP_BRIDGE_STORAGE_KEY));
        } catch (_) {
            return AI_MCP_BRIDGE_DEFAULT_URL;
        }
    };
    const saveMcpBridgeUrl = url => {
        try {
            localStorage.setItem(AI_MCP_BRIDGE_STORAGE_KEY, normalizeMcpBridgeUrl(url));
        } catch (_) { /* ignore */ }
    };
    const loadUiState = () => {
        try {
            const raw = JSON.parse(localStorage.getItem(UI_STATE_STORAGE_KEY) || '{}') || {};
            const mode = raw.mode === 'json' ? 'json' : 'pseudo';
            const aiChatOpen = !!raw.aiChatOpen;
            return {
                mode: aiChatOpen ? 'pseudo' : mode,
                aiChatOpen
            };
        } catch (_) {
            return {mode: 'pseudo', aiChatOpen: false};
        }
    };
    const saveUiState = uiState => {
        try {
            localStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify({
                mode: uiState && uiState.mode === 'json' ? 'json' : 'pseudo',
                aiChatOpen: !!(uiState && uiState.aiChatOpen)
            }));
        } catch (_) { /* ignore */ }
    };
    const hasAiConfig = config => !!(config && config.endpoint && config.model);
    const normalizeAiRequestRetryCount = value => {
        const count = Number(value);
        if (!Number.isFinite(count)) return AI_REQUEST_RETRY_DEFAULT_COUNT;
        return Math.max(0, Math.min(AI_REQUEST_RETRY_MAX_COUNT, Math.floor(count)));
    };
    const isAiRequestRetryEnabled = config => !!config && config.requestRetryEnabled !== false &&
        normalizeAiRequestRetryCount(config.requestRetryCount) > 0;
    const getAiVisionSupport = config => {
        const value = config && config.visionSupport;
        return value === AI_VISION_SUPPORTED || value === AI_VISION_UNSUPPORTED || value === AI_VISION_FAILED
            ? value
            : AI_VISION_UNKNOWN;
    };
    const hasAiVisionSupport = config => !!(config && config.visionEnabled);
    const normalizeAiModelCapabilityName = value => String(value || '')
        .trim()
        .toLowerCase()
        .replace(/^models\//, '')
        .replace(/[:/.\\_\s]+/g, '-')
        .replace(/-+/g, '-');
    const inferAiModelVisionSupportFromName = value => {
        const name = normalizeAiModelCapabilityName(value);
        if (!name) return AI_VISION_UNKNOWN;
        const nonChatPatterns = [
            /(^|-)embed(ding)?s?($|-)/,
            /(^|-)text-embedding($|-)/,
            /(^|-)rerank(er|ing)?($|-)/,
            /(^|-)whisper($|-)/,
            /(^|-)tts($|-)/,
            /(^|-)speech($|-)/,
            /(^|-)moderation($|-)/,
            /(^|-)dall-e($|-)/,
            /(^|-)gpt-image($|-)/,
            /(^|-)flux($|-)/,
            /(^|-)stable-diffusion($|-)/,
            /(^|-)sd(?:xl|3)?($|-)/,
            /(^|-)sora($|-)/,
            /(^|-)veo($|-)/
        ];
        if (nonChatPatterns.some(pattern => pattern.test(name))) return AI_VISION_UNSUPPORTED;
        const knownTextPatterns = [
            /(^|-)glm-5($|-)/,
            /(^|-)gpt-3-5($|-)/,
            /(^|-)o1-mini($|-)/,
            /(^|-)gemini-pro($|-)/,
            /(^|-)deepseek-(?:chat|reasoner|r1|v3)($|-)/,
            /(^|-)deepseek-r1($|-)/
        ];
        if (knownTextPatterns.some(pattern => pattern.test(name))) return AI_VISION_UNSUPPORTED;
        const compact = name.replace(/-/g, '');
        const visionPatterns = [
            /(^|-)vision($|-)/,
            /(^|-)visual($|-)/,
            /(^|-)vl($|-)/,
            /(^|-)multimodal($|-)/,
            /(^|-)multi-modal($|-)/,
            /(^|-)omni($|-)/,
            /(^|-)llava($|-)/,
            /(^|-)internvl($|-)/,
            /(^|-)pixtral($|-)/,
            /(^|-)qvq($|-)/,
            /(^|-)qwen.*-vl($|-)/,
            /(^|-)qwen.*vl($|-)/,
            /(^|-)chatgpt-4o($|-)/,
            /(^|-)gpt-4o($|-)/,
            /(^|-)gpt-4-1($|-)/,
            /(^|-)gpt-4-5($|-)/,
            /(^|-)gpt-4-turbo($|-)/,
            /(^|-)gpt-4-vision($|-)/,
            /(^|-)o[34]($|-)/,
            /(^|-)claude-(?:3|3-5|3-7|4|sonnet-4|opus-4|haiku-4)($|-)/,
            /(^|-)gemini-(?:1-5|2|2-5|pro-vision|.*vision|.*flash|.*exp)($|-)/,
            /(^|-)grok.*vision($|-)/,
            /(^|-)doubao.*vision($|-)/,
            /(^|-)hunyuan.*vision($|-)/,
            /(^|-)step.*1v($|-)/,
            /(^|-)ernie.*(?:vision|vl)($|-)/,
            /(^|-)kimi.*vision($|-)/,
            /(^|-)moonshot.*vision($|-)/,
            /(^|-)yi.*vision($|-)/,
            /(^|-)llama-3-2.*vision($|-)/,
            /(^|-)llama-4($|-)/
        ];
        if (visionPatterns.some(pattern => pattern.test(name))) return AI_VISION_SUPPORTED;
        if (/glm\d+v/.test(compact) || /glm.*vision/.test(name)) return AI_VISION_SUPPORTED;
        return AI_VISION_UNKNOWN;
    };
    const getAiModelIdentityText = model => {
        if (typeof model === 'string') return model;
        if (!model || typeof model !== 'object') return '';
        return [
            model.id,
            model.name,
            model.model,
            model.display_name,
            model.displayName
        ].filter(Boolean).join(' ');
    };
    const inferAiModelVisionSupportWithSource = model => {
        const metadataResult = (support, source) => ({support, source});
        if (!model) return metadataResult(AI_VISION_UNKNOWN, '');
        const objectModel = typeof model === 'object' ? model : null;
        const truthyVisionKeys = [
            'vision',
            'image',
            'image_input',
            'imageInput',
            'supports_vision',
            'support_vision',
            'supportsVision',
            'supports_images',
            'supportsImages',
            'supports_image_input',
            'supportsImageInput',
            'multimodal',
            'multi_modal'
        ];
        const checkObject = object => {
            if (!object || typeof object !== 'object') return AI_VISION_UNKNOWN;
            for (const key of truthyVisionKeys) {
                if (object[key] === true) return AI_VISION_SUPPORTED;
                if (object[key] === false) return AI_VISION_UNSUPPORTED;
            }
            return AI_VISION_UNKNOWN;
        };
        if (objectModel) {
            const direct = checkObject(objectModel);
            if (direct !== AI_VISION_UNKNOWN) return metadataResult(direct, AI_VISION_SOURCE_METADATA);
            const nestedObjects = [
                objectModel.capabilities,
                objectModel.features,
                objectModel.supported_features,
                objectModel.supportedFeatures,
                objectModel.metadata,
                objectModel.architecture
            ];
            for (const object of nestedObjects) {
                const result = checkObject(object);
                if (result !== AI_VISION_UNKNOWN) return metadataResult(result, AI_VISION_SOURCE_METADATA);
            }
            const arrays = [
                objectModel.modalities,
                objectModel.input_modalities,
                objectModel.inputModalities,
                objectModel.supported_modalities,
                objectModel.supportedModalities,
                objectModel.capabilities,
                objectModel.features,
                objectModel.supported_features,
                objectModel.supportedFeatures,
                objectModel.capabilities && objectModel.capabilities.modalities,
                objectModel.capabilities && objectModel.capabilities.input_modalities,
                objectModel.features && objectModel.features.modalities,
                objectModel.architecture && objectModel.architecture.input_modalities,
                objectModel.architecture && objectModel.architecture.output_modalities
            ].filter(Array.isArray);
            for (const items of arrays) {
                const text = items.map(item => String(item || '').toLowerCase()).join(' ');
                if (/\b(image|vision|visual|multimodal|multi-modal)\b/.test(text)) {
                    return metadataResult(AI_VISION_SUPPORTED, AI_VISION_SOURCE_METADATA);
                }
                if (/\b(text)\b/.test(text) && !/\b(image|vision|visual)\b/.test(text)) {
                    // Keep looking; a text modality alone is not enough to prove "no vision".
                    continue;
                }
            }
            const stringFields = [
                objectModel.type,
                objectModel.mode,
                objectModel.category,
                objectModel.description,
                objectModel.architecture && objectModel.architecture.modality,
                objectModel.capabilities && objectModel.capabilities.type,
                objectModel.features && objectModel.features.type
            ].map(value => String(value || '').toLowerCase()).join(' ');
            if (/\b(image|vision|visual|multimodal|multi-modal)\b/.test(stringFields)) {
                return metadataResult(AI_VISION_SUPPORTED, AI_VISION_SOURCE_METADATA);
            }
        }
        const nameSupport = inferAiModelVisionSupportFromName(getAiModelIdentityText(model));
        if (nameSupport !== AI_VISION_UNKNOWN) {
            return metadataResult(nameSupport, AI_VISION_SOURCE_NAME);
        }
        return metadataResult(AI_VISION_UNKNOWN, '');
    };
    const inferAiModelVisionSupport = model => inferAiModelVisionSupportWithSource(model).support;
    const getAiModelVisionSupportMessage = model => {
        const support = model && model.visionSupport;
        const source = model && model.visionSupportSource;
        if (support === AI_VISION_SUPPORTED) {
            if (source === AI_VISION_SOURCE_NAME) return '按模型名推断支持图片输入';
            if (source === AI_VISION_SOURCE_SAVED) return '来自已保存配置';
            return '来自模型列表字段';
        }
        if (support === AI_VISION_UNSUPPORTED) {
            if (source === AI_VISION_SOURCE_NAME) return '按模型名推断为非视觉模型';
            if (source === AI_VISION_SOURCE_SAVED) return '来自已保存配置';
            return '来自模型列表字段';
        }
        return '模型列表和模型名都未提供图片能力信息';
    };
    const normalizeAiModelRecord = item => {
        const id = typeof item === 'string' ? item : (item && item.id);
        if (!id) return null;
        const vision = inferAiModelVisionSupportWithSource(item);
        return {
            id: String(id),
            visionSupport: vision.support,
            visionSupportSource: vision.source,
            raw: item && typeof item === 'object' ? item : {id}
        };
    };
    const findAiModelRecord = (models, id) => {
        const value = String(id || '').trim();
        if (!value) return null;
        return (Array.isArray(models) ? models : []).find(model => model && model.id === value) || null;
    };
    const summarizeAiConversationTitle = text => {
        const s = String(text || '').replace(/\s+/g, ' ').trim();
        if (!s) return '新的聊天';
        return s.length > 28 ? `${s.slice(0, 28)}...` : s;
    };
    const getAiConversationTitleFromMessages = messages => {
        const userMessage = (messages || []).find(message => message && message.role === 'user' && message.text);
        return summarizeAiConversationTitle(userMessage ? userMessage.text : '');
    };
    const createAiConversation = (title, messages) => {
        const now = Date.now();
        return {
            id: `ai-chat-${now}-${Math.random().toString(36).slice(2, 8)}`,
            title: title || '新的聊天',
            createdAt: now,
            updatedAt: now,
            messages: Array.isArray(messages) ? messages : []
        };
    };
    const normalizeAiChatDetail = detail => {
        if (!detail) return null;
        const diff = Array.isArray(detail.diff)
            ? detail.diff.map(row => ({
                type: row && row.type ? String(row.type) : 'context',
                oldLine: row && row.oldLine != null ? Number(row.oldLine) : null,
                newLine: row && row.newLine != null ? Number(row.newLine) : null,
                text: String((row && row.text) || '')
            })).filter(row => row.type && row.text !== null)
            : null;
        return {
            key: detail.key || '',
            kind: detail.kind || '',
            title: String(detail.title || ''),
            content: String(detail.content || ''),
            time: Number(detail.time) || Date.now(),
            diff
        };
    };
    const normalizeAiChatMessage = message => {
        if (!message) return null;
        const confirmationResolved = !!message.confirmationResolved;
        const staleConfirmation = message.kind === 'confirm' && !confirmationResolved;
        const text = String(message.text || '');
        return {
            id: message.id || `ai-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: message.role === 'user' ? 'user' : 'assistant',
            kind: staleConfirmation ? 'status' : (message.kind || ''),
            text: staleConfirmation
                ? `${text.trim() || '确认请求'}\n\n（这条确认请求已失效，请重新发起。）`
                : text,
            time: Number(message.time) || Date.now(),
            pending: false,
            confirmationId: confirmationResolved ? String(message.confirmationId || '') : '',
            confirmationResolved,
            confirmationResult: message.confirmationResult === 'confirmed' ? 'confirmed' :
                (message.confirmationResult === 'cancelled' ? 'cancelled' : ''),
            details: (Array.isArray(message.details) ? message.details : [])
                .map(normalizeAiChatDetail)
                .filter(Boolean)
        };
    };
    const getAiVisibleDetailsForRender = (message, showProcessLog) => {
        const rawDetails = Array.isArray(message && message.details) ? message.details : [];
        return showProcessLog
            ? rawDetails
            : rawDetails.filter(detail => !detail || detail.key !== 'process');
    };
    const shouldRenderAiChatMessage = (message, showProcessLog) => {
        if (!message) return false;
        if (message.pending) return true;
        if (String(message.text || '').trim()) return true;
        return getAiVisibleDetailsForRender(message, showProcessLog).length > 0;
    };
    const getRenderableAiChatMessages = (messages, showProcessLog) => (Array.isArray(messages) ? messages : [])
        .filter(message => shouldRenderAiChatMessage(message, showProcessLog));
    const formatAiExportTime = time => {
        const d = new Date(Number(time) || Date.now());
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    const sanitizeAiExportFileName = value => {
        const name = String(value || '聊天记录')
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
            .replace(/\s+/g, ' ')
            .trim();
        return (name || '聊天记录').slice(0, 80);
    };
    const formatAiConversationAsTxt = conversation => {
        const item = conversation || {};
        const lines = [
            '积木脚本助手聊天记录',
            `标题：${item.title || '新的聊天'}`,
            `创建时间：${formatAiExportTime(item.createdAt)}`,
            `更新时间：${formatAiExportTime(item.updatedAt)}`,
            `导出时间：${formatAiExportTime(Date.now())}`,
            '',
            '========================================',
            ''
        ];
        for (const message of item.messages || []) {
            const role = message.role === 'user' ? '用户' : (message.kind === 'status' ? '系统' : 'AI');
            lines.push(`[${formatAiExportTime(message.time)}] ${role}`);
            const text = String(message.text || '').trim();
            lines.push(text || '(无可见文本)');
            for (const detail of message.details || []) {
                const title = detail && detail.title ? detail.title : '详情';
                const content = detail && detail.content ? String(detail.content) : '';
                lines.push('');
                lines.push(`--- ${title} ---`);
                lines.push(content || '(空)');
            }
            lines.push('');
            lines.push('----------------------------------------');
            lines.push('');
        }
        return lines.join('\n');
    };
    const downloadTextFile = (filename, text) => {
        const blob = new Blob([String(text || '')], {type: 'text/plain;charset=utf-8'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const normalizeAiConversations = conversations => (Array.isArray(conversations) ? conversations : [])
        .map(conversation => {
            if (!conversation) return null;
            const messages = (Array.isArray(conversation.messages) ? conversation.messages : [])
                .slice(-AI_CHAT_MAX_MESSAGES)
                .map(normalizeAiChatMessage)
                .filter(Boolean);
            const createdAt = Number(conversation.createdAt) || (messages[0] && messages[0].time) || Date.now();
            const updatedAt = Number(conversation.updatedAt) ||
                (messages.length ? messages[messages.length - 1].time : createdAt);
            return {
                id: conversation.id || `ai-chat-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
                title: summarizeAiConversationTitle(conversation.title || getAiConversationTitleFromMessages(messages)),
                createdAt,
                updatedAt,
                messages
            };
        })
        .filter(Boolean)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, AI_CHAT_MAX_CONVERSATIONS);
    const loadAiChatState = () => {
        try {
            const raw = JSON.parse(localStorage.getItem(AI_CHAT_STORAGE_KEY) || '{}') || {};
            const conversations = normalizeAiConversations(Array.isArray(raw) ? raw : raw.conversations);
            const activeConversationId = conversations.some(item => item.id === raw.activeConversationId)
                ? raw.activeConversationId
                : (conversations[0] && conversations[0].id) || null;
            return {
                conversations,
                activeConversationId,
                sidebarCollapsed: !!raw.sidebarCollapsed
            };
        } catch (_) {
            return {conversations: [], activeConversationId: null, sidebarCollapsed: false};
        }
    };
    const saveAiChatState = chatState => {
        try {
            const conversations = normalizeAiConversations(chatState && (
                chatState.conversations || chatState.aiConversations
            ));
            localStorage.setItem(AI_CHAT_STORAGE_KEY, JSON.stringify({
                conversations,
                activeConversationId: chatState && (
                    chatState.activeConversationId || chatState.aiActiveConversationId
                ),
                sidebarCollapsed: !!(chatState && (
                    chatState.sidebarCollapsed || chatState.aiSidebarCollapsed
                ))
            }));
        } catch (err) {
            console.warn('[json-script-converter] save AI chat history failed', err);
        }
    };
    const formatAiConversationTime = time => {
        const d = new Date(Number(time) || Date.now());
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
    };
    const normalizeAiEndpoint = value => {
        const raw = String(value || '').trim().replace(/\/+$/, '');
        if (!raw) return '';
        let url;
        try {
            url = new URL(raw);
        } catch (_) {
            try {
                url = new URL(`https://${raw}`);
            } catch (err) {
                throw new Error(`接口地址格式不正确: ${err.message}`);
            }
        }
        let path = url.pathname.replace(/\/+$/, '');
        if (!path || path === '/') path = '/v1/chat/completions';
        else if (path.endsWith('/v1')) path = `${path}/chat/completions`;
        else if (path === '/v1/chat') path = '/v1/chat/completions';
        else if (path.endsWith('/chat')) path = `${path}/completions`;
        else if (!path.endsWith('/chat/completions')) {
            path = `${path}/v1/chat/completions`;
        }
        // Preserve repeated slashes inside the user-provided path. Some proxy endpoints
        // embed another URL in the path, for example /https://example.com/.
        url.pathname = path;
        url.search = '';
        url.hash = '';
        return url.toString();
    };
    const getAiEndpointPreview = value => {
        const raw = String(value || '').trim();
        if (!raw) return {endpoint: '', error: ''};
        try {
            return {endpoint: normalizeAiEndpoint(raw), error: ''};
        } catch (err) {
            return {endpoint: '', error: err && err.message ? err.message : String(err)};
        }
    };
    const getModelsEndpoint = endpoint => {
        const url = new URL(normalizeAiEndpoint(endpoint));
        url.pathname = url.pathname.replace(/\/chat\/completions$/, '/models');
        url.search = '';
        url.hash = '';
        return url.toString();
    };
    const getTargetNamesByType = (target, type) => {
        if (!target || !target.variables) return [];
        const out = [];
        for (const id of Object.keys(target.variables)) {
            const v = target.variables[id];
            if (v && (v.type || '') === type) out.push(v.name);
        }
        return out.sort();
    };
    const getAiTargetName = target => (
        target && target.sprite && target.sprite.name
            ? target.sprite.name
            : (target && target.isStage ? 'Stage' : (target && target.id) || '')
    );
    const getAiUnusedName = (baseName, usedNames) => {
        const base = String(baseName || '').trim() || 'Untitled';
        const used = new Set((usedNames || []).map(name => String(name)));
        if (!used.has(base)) return base;
        let i = 2;
        while (used.has(`${base}${i}`)) i++;
        return `${base}${i}`;
    };
    const formatAiTargetRef = index => {
        let n = Number.isInteger(index) && index >= 0 ? index : 0;
        let out = '';
        do {
            out = String.fromCharCode(97 + (n % 26)) + out;
            n = Math.floor(n / 26) - 1;
        } while (n >= 0);
        return out;
    };
    const getAiTargets = vm => {
        const runtimeTargets = vm && vm.runtime ? vm.runtime.targets : [];
        const rawTargets = Array.isArray(runtimeTargets)
            ? runtimeTargets
            : Object.keys(runtimeTargets || {}).map(id => runtimeTargets[id]);
        return rawTargets
            .filter(target => target && target.isOriginal)
            .sort((a, b) => {
                if (!!a.isStage !== !!b.isStage) return a.isStage ? -1 : 1;
                const ai = rawTargets.indexOf(a);
                const bi = rawTargets.indexOf(b);
                return ai - bi;
            });
    };
    const getAiTargetSummary = (target, vm, targetRef, options) => {
        const isStage = !!(target && target.isStage);
        const targetName = getAiTargetName(target);
        const includeCostumes = !(options && options.includeCostumes === false);
        const costumes = target && target.sprite && Array.isArray(target.sprite.costumes)
            ? target.sprite.costumes.map((costume, index) => ({
                index,
                name: costume && costume.name ? costume.name : `costume${index + 1}`
            }))
            : [];
        const currentCostumeIndex = target && typeof target.currentCostume === 'number'
            ? target.currentCostume
            : null;
        return {
            targetRef: targetRef || '',
            targetId: target && target.id,
            targetName,
            targetType: isStage ? 'stage' : 'sprite',
            aliases: isStage ? ['Stage', '舞台', '背景', 'backdrop'] : [targetName],
            isStage,
            costumeCount: costumes.length,
            costumes: includeCostumes ? costumes : undefined,
            currentCostumeIndex,
            currentCostumeName: currentCostumeIndex != null && costumes[currentCostumeIndex]
                ? costumes[currentCostumeIndex].name
                : '',
            isCurrent: !!(target && vm && vm.editingTarget && target.id === vm.editingTarget.id)
        };
    };
    const findAiTarget = (vm, targetIdOrName) => {
        const value = String(targetIdOrName || '').trim();
        if (!value) return {target: null, error: '缺少 targetId 或角色名'};
        const lowerValue = value.toLowerCase();
        const targets = getAiTargets(vm);
        const byId = targets.find(target => target.id === value);
        if (byId) return {target: byId, error: null};
        const byName = targets.filter(target => getAiTargetName(target) === value);
        if (byName.length === 1) return {target: byName[0], error: null};
        if (byName.length > 1) return {target: null, error: `角色名不唯一: ${value}`};
        const byAlias = targets.filter(target => {
            const summary = getAiTargetSummary(target, vm);
            return (summary.aliases || []).some(alias => String(alias).toLowerCase() === lowerValue);
        });
        if (byAlias.length === 1) return {target: byAlias[0], error: null};
        if (byAlias.length > 1) return {target: null, error: `目标别名不唯一: ${value}`};
        return {target: null, error: `找不到角色: ${value}`};
    };
    const findAiCostumeIndex = (target, payload) => {
        const costumes = target && target.sprite && Array.isArray(target.sprite.costumes)
            ? target.sprite.costumes
            : [];
        if (!costumes.length) return {index: -1, error: '目标没有造型/背景'};
        const rawIndex = payload && (
            payload.costumeIndex != null ? payload.costumeIndex :
                (payload.index != null ? payload.index : null)
        );
        if (rawIndex != null) {
            const index = Number(rawIndex);
            if (!Number.isInteger(index) || index < 0 || index >= costumes.length) {
                return {index: -1, error: `造型索引无效: ${rawIndex}`};
            }
            return {index, error: null};
        }
        const name = String((payload && (payload.costumeName || payload.backdropName || payload.name)) || '').trim();
        if (!name) return {index: -1, error: '缺少 costumeIndex 或 costumeName'};
        const matches = costumes
            .map((costume, index) => ({costume, index}))
            .filter(item => item.costume && item.costume.name === name);
        if (matches.length === 1) return {index: matches[0].index, error: null};
        if (matches.length > 1) return {index: -1, error: `造型/背景名不唯一: ${name}`};
        return {index: -1, error: `找不到造型/背景: ${name}`};
    };
    const getAiCostumeDataFormat = costume => {
        const direct = costume && costume.dataFormat ? String(costume.dataFormat).toLowerCase() : '';
        if (direct) return direct;
        const md5 = String((costume && (costume.md5 || costume.baseLayerMD5)) || '');
        const match = md5.match(/\.([a-z0-9]+)$/i);
        return match ? match[1].toLowerCase() : '';
    };
    const getAiCostumeAssetId = costume => {
        if (!costume) return '';
        if (costume.assetId) return String(costume.assetId);
        const md5 = String(costume.md5 || costume.baseLayerMD5 || '');
        return md5.indexOf('.') >= 0 ? md5.slice(0, md5.lastIndexOf('.')) : md5;
    };
    const getAiCostumeMd5 = costume => {
        const md5 = String((costume && (costume.md5 || costume.baseLayerMD5)) || '');
        if (md5) return md5;
        const assetId = getAiCostumeAssetId(costume);
        const dataFormat = getAiCostumeDataFormat(costume);
        return assetId && dataFormat ? `${assetId}.${dataFormat}` : '';
    };
    const getAiCostumeAssetType = (storage, dataFormat) => {
        if (!storage || !storage.AssetType) return null;
        return String(dataFormat).toLowerCase() === 'svg'
            ? storage.AssetType.ImageVector
            : storage.AssetType.ImageBitmap;
    };
    const decodeAiAssetText = asset => {
        if (!asset) return '';
        if (typeof asset.decodeText === 'function') return asset.decodeText();
        if (asset.data) return new TextDecoder().decode(asset.data);
        return '';
    };
    const formatAiCostumeMeta = (target, costume, index) => ({
        index,
        name: costume && costume.name ? costume.name : `${target && target.isStage ? 'backdrop' : 'costume'}${index + 1}`,
        dataFormat: getAiCostumeDataFormat(costume),
        md5: getAiCostumeMd5(costume),
        assetId: getAiCostumeAssetId(costume),
        rotationCenterX: costume && typeof costume.rotationCenterX === 'number' ? costume.rotationCenterX : null,
        rotationCenterY: costume && typeof costume.rotationCenterY === 'number' ? costume.rotationCenterY : null,
        bitmapResolution: costume && costume.bitmapResolution != null ? costume.bitmapResolution : null
    });
    const parseAiSvgNumber = value => {
        const match = String(value || '').trim().match(/^-?\d+(?:\.\d+)?/);
        return match ? Number(match[0]) : null;
    };
    const getAiSvgBounds = svgText => {
        let width = null;
        let height = null;
        try {
            const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
            const root = doc && doc.documentElement;
            if (root) {
                width = parseAiSvgNumber(root.getAttribute('width'));
                height = parseAiSvgNumber(root.getAttribute('height'));
                const viewBox = String(root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
                if ((!width || !height) && viewBox.length === 4 && viewBox.every(Number.isFinite)) {
                    width = width || Math.abs(viewBox[2]);
                    height = height || Math.abs(viewBox[3]);
                }
            }
        } catch (_) { /* fall back below */ }
        return {
            width: width && width > 0 ? width : 480,
            height: height && height > 0 ? height : 360
        };
    };
    const decodeAiSvgData = data => {
        if (typeof data === 'string') return data;
        if (!data) return '';
        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
            return new TextDecoder().decode(data);
        }
        return String(data);
    };
    const fixAiSvgTextForVanilla = svgText => {
        if (typeof fixForVanilla !== 'function') return svgText;
        const bytes = new TextEncoder().encode(svgText);
        try {
            return decodeAiSvgData(fixForVanilla(bytes));
        } catch (byteErr) {
            try {
                return decodeAiSvgData(fixForVanilla(svgText));
            } catch (_) {
                throw byteErr;
            }
        }
    };
    const sanitizeAiSvgText = svgText => {
        const fixed = fixAiSvgTextForVanilla(svgText);
        if (!sanitizeSvg || typeof sanitizeSvg.sanitizeSvgText !== 'function') return fixed.trim();
        return decodeAiSvgData(sanitizeSvg.sanitizeSvgText(fixed)).trim();
    };
    const validateAiSvgText = rawSvg => {
        let svg = String(rawSvg || '').trim();
        svg = stripCodeFence(svg).trim();
        if (!svg) return {ok: false, error: 'SVG 内容为空'};
        if (svg.length > AI_SVG_WRITE_LIMIT) {
            return {ok: false, error: `SVG 过大，最多 ${AI_SVG_WRITE_LIMIT} 个字符`};
        }
        if (!/<svg[\s>]/i.test(svg)) return {ok: false, error: 'SVG 必须包含 <svg> 根元素'};
        if (/<script[\s>]/i.test(svg)) return {ok: false, error: 'SVG 不能包含 script'};
        if (/\son[a-z]+\s*=/i.test(svg)) return {ok: false, error: 'SVG 不能包含 onload/onclick 等事件属性'};
        if (/\b(?:href|xlink:href|src)\s*=\s*["']?\s*(?:https?:|file:|javascript:|data:)/i.test(svg)) {
            return {ok: false, error: 'SVG 不能引用外部资源、data URI 或 javascript 链接'};
        }
        if (/url\(\s*['"]?(?!#)/i.test(svg)) return {ok: false, error: 'SVG 不能使用外部 url() 资源'};
        try {
            svg = sanitizeAiSvgText(svg);
        } catch (err) {
            return {ok: false, error: `SVG 清理失败: ${err.message}`};
        }
        if (!/<svg[\s>]/i.test(svg)) return {ok: false, error: 'SVG 清理后不包含 <svg> 根元素'};
        if (/<script[\s>]/i.test(svg) || /\son[a-z]+\s*=/i.test(svg)) {
            return {ok: false, error: 'SVG 清理后仍包含不安全内容'};
        }
        try {
            const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
            if (doc.querySelector('parsererror')) return {ok: false, error: 'SVG 不是合法 XML'};
            if (!doc.documentElement || doc.documentElement.tagName.toLowerCase() !== 'svg') {
                return {ok: false, error: 'SVG 根元素必须是 svg'};
            }
        } catch (err) {
            return {ok: false, error: `SVG 解析失败: ${err.message}`};
        }
        return {ok: true, svg, bounds: getAiSvgBounds(svg)};
    };
    const getAiSvgDataUrl = svgText => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
    const loadAiImageFromDataUrl = dataUrl => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({
            image,
            width: image.naturalWidth || image.width || 1,
            height: image.naturalHeight || image.height || 1
        });
        image.onerror = () => reject(new Error('图片无法加载'));
        image.src = dataUrl;
    });
    const decodeAiBase64Bytes = base64 => {
        const normalized = String(base64 || '').replace(/\s+/g, '');
        if (!normalized || !/^[a-z0-9+/]+={0,2}$/i.test(normalized)) {
            throw new Error('图片不是有效的 Base64 数据');
        }
        const binary = atob(normalized);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    };
    const normalizeAiBitmapInput = (rawImageData, rawMimeType) => {
        let imageData = stripCodeFence(String(rawImageData || '')).trim();
        if (!imageData) return {ok: false, error: '位图数据为空'};
        if (imageData.length > AI_BITMAP_WRITE_DATA_URL_LIMIT) {
            return {ok: false, error: `位图数据过大，最多 ${AI_BITMAP_WRITE_DATA_URL_LIMIT} 个字符`};
        }
        let mimeType = String(rawMimeType || '').trim().toLowerCase();
        if (!/^data:/i.test(imageData)) {
            mimeType = mimeType || 'image/png';
            imageData = `data:${mimeType};base64,${imageData}`;
        }
        const match = imageData.match(/^data:([^;,]+)((?:;[^,]*)*),([\s\S]*)$/i);
        if (!match || !/(?:^|;)base64(?:;|$)/i.test(match[2])) {
            return {ok: false, error: '位图必须是 Base64 data URL，或者是单独的 Base64 数据'};
        }
        mimeType = String(match[1] || '').trim().toLowerCase();
        if (mimeType === 'image/jpg') mimeType = 'image/jpeg';
        if (!/^image\/(?:png|jpeg|webp|bmp|x-ms-bmp|gif)$/.test(mimeType)) {
            return {ok: false, error: `不支持的位图格式: ${mimeType || '未知'}`};
        }
        try {
            const bytes = decodeAiBase64Bytes(match[3]);
            if (!bytes.length) return {ok: false, error: '位图数据为空'};
        } catch (err) {
            return {ok: false, error: err.message};
        }
        return {
            ok: true,
            mimeType,
            dataUrl: `data:${mimeType};base64,${String(match[3] || '').replace(/\s+/g, '')}`
        };
    };
    const renderAiBitmapToPng = async (rawImageData, rawMimeType) => {
        const checked = normalizeAiBitmapInput(rawImageData, rawMimeType);
        if (!checked.ok) return checked;
        let loaded;
        try {
            loaded = await loadAiImageFromDataUrl(checked.dataUrl);
        } catch (err) {
            return {ok: false, error: `位图无法解码: ${err.message}`};
        }
        const sourceWidth = Math.max(1, loaded.width);
        const sourceHeight = Math.max(1, loaded.height);
        const scale = Math.min(
            1,
            AI_BITMAP_MAX_DIMENSION / sourceWidth,
            AI_BITMAP_MAX_DIMENSION / sourceHeight,
            Math.sqrt(AI_BITMAP_MAX_PIXELS / (sourceWidth * sourceHeight))
        );
        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return {ok: false, error: '当前浏览器无法处理位图'};
        ctx.drawImage(loaded.image, 0, 0, width, height);
        let bytes;
        try {
            const pngDataUrl = canvas.toDataURL('image/png');
            bytes = decodeAiBase64Bytes(pngDataUrl.slice(pngDataUrl.indexOf(',') + 1));
        } catch (err) {
            return {ok: false, error: `位图转换为 PNG 失败: ${err.message}`};
        }
        if (bytes.length > AI_BITMAP_WRITE_BYTE_LIMIT) {
            return {ok: false, error: `转换后的 PNG 过大，最多 ${AI_BITMAP_WRITE_BYTE_LIMIT} 字节`};
        }
        return {
            ok: true,
            bytes,
            width,
            height,
            sourceWidth,
            sourceHeight,
            sourceMimeType: checked.mimeType,
            resized: width !== sourceWidth || height !== sourceHeight
        };
    };
    const assertAiSvgRenderable = async svgText => {
        const loaded = await loadAiImageFromDataUrl(getAiSvgDataUrl(svgText));
        return {ok: true, width: loaded.width, height: loaded.height};
    };
    const rasterizeAiSvgToPngDataUrl = async (svgText, maxSize) => {
        const loaded = await loadAiImageFromDataUrl(getAiSvgDataUrl(svgText));
        const limit = Number(maxSize) || 768;
        const scale = Math.min(1, limit / Math.max(loaded.width, loaded.height));
        const width = Math.max(1, Math.round(loaded.width * scale));
        const height = Math.max(1, Math.round(loaded.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(loaded.image, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/png');
        if (dataUrl.length > AI_IMAGE_DATA_URL_LIMIT) return {ok: false, error: '转换后的图片过大，无法发送给 AI'};
        return {ok: true, dataUrl, width, height};
    };
    const downscaleAiImageDataUrl = async (dataUrl, maxSize) => {
        const loaded = await loadAiImageFromDataUrl(dataUrl);
        const limit = Number(maxSize) || 768;
        const scale = Math.min(1, limit / Math.max(loaded.width, loaded.height));
        const width = Math.max(1, Math.round(loaded.width * scale));
        const height = Math.max(1, Math.round(loaded.height * scale));
        if (scale >= 1 && dataUrl.length <= AI_IMAGE_DATA_URL_LIMIT) {
            return {ok: true, dataUrl, width, height};
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(loaded.image, 0, 0, width, height);
        const nextDataUrl = canvas.toDataURL('image/png');
        if (nextDataUrl.length > AI_IMAGE_DATA_URL_LIMIT) return {ok: false, error: '图片过大，无法发送给 AI'};
        return {ok: true, dataUrl: nextDataUrl, width, height};
    };
    const createAiSolidPngDataUrl = (r, g, b) => {
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/png');
    };
    const collectAiImageAttachments = (value, out) => {
        const result = out || [];
        if (!value) return result;
        if (Array.isArray(value)) {
            value.forEach(item => collectAiImageAttachments(item, result));
            return result;
        }
        if (typeof value !== 'object') return result;
        if (value.imageAttachment && value.imageAttachment.dataUrl) result.push(value.imageAttachment);
        Object.keys(value).forEach(key => {
            if (key !== 'imageAttachment') collectAiImageAttachments(value[key], result);
        });
        return result;
    };
    const stripAiImageAttachments = value => {
        if (!value || typeof value !== 'object') return value;
        if (Array.isArray(value)) return value.map(stripAiImageAttachments);
        const next = {};
        Object.keys(value).forEach(key => {
            if (key === 'imageAttachment') {
                next.imageAttachment = {
                    label: value[key] && value[key].label,
                    mimeType: value[key] && value[key].mimeType,
                    width: value[key] && value[key].width,
                    height: value[key] && value[key].height
                };
            } else {
                next[key] = stripAiImageAttachments(value[key]);
            }
        });
        return next;
    };
    const renderTargetPseudocode = (target, vm, options) => {
        if (!target) throw new Error('没有目标角色');
        const includeCoords = !!(options && options.includeCoords);
        const serialized = sb3.serialize(vm.runtime, target.id);
        const blocksObj = (serialized && serialized.blocks) || {};
        const remapped = remapBlockIdsForEditor(blocksObj);
        return pseudoConverter.renderPseudocode(remapped, {target, vm}, {includeCoords});
    };
    const getAiRuntimeContext = vm => {
        const runtime = vm && vm.runtime;
        const frameLoop = runtime && runtime.frameLoop;
        const rawFramerate = frameLoop && typeof frameLoop.framerate === 'number'
            ? frameLoop.framerate
            : null;
        const effectiveFramerate = rawFramerate === 0 ? 60 : rawFramerate;
        const stepTimeMs = runtime && typeof runtime.currentStepTime === 'number'
            ? runtime.currentStepTime
            : (effectiveFramerate ? 1000 / effectiveFramerate : null);
        return {
            framerate: rawFramerate,
            effectiveFramerate,
            stepTimeMs,
            turboMode: !!(runtime && runtime.turboMode),
            warpSemantics: [
                'Custom block definitions may include warp, for example define name() warp { ... }.',
                'warp means Scratch/TurboWarp "run without screen refresh" for that custom block.',
                'Without warp, model each block/step inside the custom block as taking about one frame.',
                'With warp, the custom block body runs as fast as possible until it yields or finishes.',
                'Use warp for pure calculations, tight loops, list processing, recursion, and helpers that should finish in the same frame.',
                'Avoid warp for animation, visible step-by-step motion, waits, or code that intentionally updates the screen between steps.'
            ]
        };
    };
    const ensureHeadlessTopLevelCoords = blocks => {
        const topIds = Object.keys(blocks || {}).filter(id => {
            const block = blocks[id];
            return block && !Array.isArray(block) && block.topLevel && !block.parent;
        });
        if (!topIds.length) return;
        const allAtOrigin = topIds.every(id => {
            const block = blocks[id];
            return (!block.x && !block.y);
        });
        topIds.sort((idA, idB) => {
            const a = blocks[idA];
            const b = blocks[idB];
            const ay = typeof a.y === 'number' ? a.y : 0;
            const by = typeof b.y === 'number' ? b.y : 0;
            if (ay !== by) return ay - by;
            const ax = typeof a.x === 'number' ? a.x : 0;
            const bx = typeof b.x === 'number' ? b.x : 0;
            if (ax !== bx) return ax - bx;
            return idA < idB ? -1 : (idA > idB ? 1 : 0);
        });
        let cursorY = 0;
        for (const id of topIds) {
            const block = blocks[id];
            if (allAtOrigin || typeof block.x !== 'number' || typeof block.y !== 'number') {
                block.x = 0;
                block.y = cursorY;
            }
            cursorY = (typeof block.y === 'number' ? block.y : cursorY) + 120;
        }
    };
    const AI_EXTENSION_CATALOG = [
        {id: 'pen', name: 'Pen / 画笔', builtin: true, aliases: ['pen', '画笔'], opcodePrefixes: ['pen']},
        {id: 'music', name: 'Music / 音乐', builtin: true, aliases: ['music', '音乐'], opcodePrefixes: ['music']},
        {id: 'videoSensing', name: 'Video Sensing / 视频侦测', builtin: true, aliases: ['video', 'videoSensing', '视频侦测'], opcodePrefixes: ['videoSensing']},
        {id: 'text2speech', name: 'Text to Speech / 文字朗读', builtin: true, aliases: ['tts', 'text2speech', '文字朗读', '朗读'], opcodePrefixes: ['text2speech']},
        {id: 'translate', name: 'Translate / 翻译', builtin: true, aliases: ['translate', '翻译'], opcodePrefixes: ['translate']},
        {id: 'makeymakey', name: 'Makey Makey', builtin: true, hardware: true, aliases: ['makeymakey', 'makey makey'], opcodePrefixes: ['makeymakey']},
        {id: 'microbit', name: 'micro:bit', builtin: true, hardware: true, aliases: ['microbit', 'micro:bit'], opcodePrefixes: ['microbit']},
        {id: 'ev3', name: 'LEGO EV3', builtin: true, hardware: true, aliases: ['ev3', 'lego ev3'], opcodePrefixes: ['ev3']},
        {id: 'boost', name: 'LEGO BOOST', builtin: true, hardware: true, aliases: ['boost', 'lego boost'], opcodePrefixes: ['boost']},
        {id: 'wedo2', name: 'LEGO WeDo 2.0', builtin: true, hardware: true, aliases: ['wedo2', 'wedo', 'lego wedo'], opcodePrefixes: ['wedo2']},
        {id: 'gdxfor', name: 'Go Direct Force & Acceleration', builtin: true, hardware: true, aliases: ['gdxfor', 'vernier'], opcodePrefixes: ['gdxfor']},
        {id: 'tw', name: 'TurboWarp Blocks', builtin: true, aliases: ['tw', 'turbowarp'], opcodePrefixes: ['tw']},
        {id: 'lazyAudio', name: 'Lazy Audio', builtin: true, aliases: ['lazyAudio', 'lazyaudio'], opcodePrefixes: ['lazyAudio']},
        {id: 'canvas', name: 'Canvas', builtin: true, aliases: ['canvas'], opcodePrefixes: ['canvas']},
        {id: 'yun', name: 'Cloud Data', builtin: true, aliases: ['yun'], opcodePrefixes: ['yun']},
        {id: 'js', name: 'JS', builtin: true, aliases: ['js'], opcodePrefixes: ['js']},
        {id: 'jsonfetch', name: 'JSON Fetch', builtin: true, aliases: ['jsonfetch'], opcodePrefixes: ['jsonfetch']},
        {id: 'three', name: '3D Engine', builtin: true, aliases: ['three'], opcodePrefixes: ['three']},
        {id: 'p3d', name: '3D Physics', builtin: true, aliases: ['p3d'], opcodePrefixes: ['p3d']},
        {id: 'box2d', name: '2D Physics', builtin: true, aliases: ['box2d'], opcodePrefixes: ['box2d']},
        {id: 'ws', name: 'WebSocket', builtin: true, aliases: ['ws'], opcodePrefixes: ['ws']},
        {id: 'community', name: 'Community', builtin: true, aliases: ['community'], opcodePrefixes: ['community']},
        {id: 'community2', name: 'Community 2', builtin: true, aliases: ['community2'], opcodePrefixes: ['community2']},
        {id: 'yx', name: 'Math / 运算', builtin: true, aliases: ['yx'], opcodePrefixes: ['yx']},
        {id: 'set', name: 'Advanced Settings', builtin: true, aliases: ['set'], opcodePrefixes: ['set']},
        {id: 'tc', name: 'Layers', builtin: true, aliases: ['tc'], opcodePrefixes: ['tc']},
        {id: 'touch', name: 'Touch', builtin: true, aliases: ['touch'], opcodePrefixes: ['touch']},
        {id: 'faceSensing', name: 'Face Sensing', builtin: false, url: 'https://extensions.turbowarp.org/lab/face-sensing.js', aliases: ['faceSensing', 'face sensing'], opcodePrefixes: ['faceSensing']}
    ];
    const AI_CORE_OPCODE_PREFIXES = new Set([
        'argument', 'control', 'data', 'event', 'looks', 'motion', 'operator',
        'procedures', 'sensing', 'sound',
        // Scratch shadow/input helper blocks, not extensions.
        'colour', 'math', 'text', 'note'
    ]);
    const AI_CORE_EXTENSION_CONTEXT = [
        'motion', 'looks', 'sound', 'events', 'control',
        'sensing', 'operators', 'variables', 'lists', 'myBlocks'
    ];
    const AI_EXTENSION_ID_MAP = new Map(AI_EXTENSION_CATALOG.map(item => [item.id, item]));
    const AI_EXTENSION_ALIAS_MAP = (() => {
        const map = new Map();
        for (const item of AI_EXTENSION_CATALOG) {
            const aliases = [item.id, item.name].concat(item.aliases || []);
            for (const alias of aliases) {
                const key = String(alias || '').trim().toLowerCase();
                if (key) map.set(key, item.id);
            }
        }
        return map;
    })();
    const AI_EXTENSION_OPCODE_PREFIX_MAP = (() => {
        const map = new Map();
        for (const item of AI_EXTENSION_CATALOG) {
            for (const prefix of item.opcodePrefixes || []) {
                map.set(String(prefix).toLowerCase(), item.id);
            }
        }
        return map;
    })();
    const AI_REMOTE_EXTENSION_SOURCES = [
        {
            id: 'tw-official',
            name: 'TurboWarp official',
            url: 'https://extensions.turbowarp.org/generated-metadata/extensions-v0.json'
        }
    ];
    let aiRemoteExtensionCatalog = null;
    let aiRemoteExtensionCatalogPromise = null;
    let aiRemoteExtensionCatalogError = null;
    const isAiExtensionUrl = value => /^(?:https?:|data:|file:)/i.test(String(value || '').trim());
    const normalizeAiExtensionSlug = value => String(value || '')
        .trim()
        .replace(/^https:\/\/extensions\.turbowarp\.org\//i, '')
        .replace(/\.js(?:[?#].*)?$/i, '')
        .replace(/^\/+/, '');
    const normalizeAiExtensionId = value => {
        const text = String(value || '').trim();
        if (!text) return '';
        if (AI_EXTENSION_ID_MAP.has(text)) return text;
        const lower = text.toLowerCase();
        if (AI_EXTENSION_ALIAS_MAP.has(lower)) return AI_EXTENSION_ALIAS_MAP.get(lower);
        return text;
    };
    const getAiExtensionRecord = value => {
        const id = normalizeAiExtensionId(value);
        return AI_EXTENSION_ID_MAP.get(id) || null;
    };
    const normalizeAiRemoteExtensionRecord = (source, extension) => {
        if (!extension || typeof extension !== 'object') return null;
        const sourceId = source && source.id;
        const isTw = sourceId === 'tw-official';
        const id = String(isTw ? extension.id : (extension.extId || extension.extensionId || extension.id) || '').trim();
        const slug = normalizeAiExtensionSlug(extension.slug || extension.path || '');
        const name = String(extension.name || id || slug || '').trim();
        if (!id && !slug && !name) return null;
        let url = String(extension.extensionURL || extension.url || '').trim();
        if (!url && isTw && slug) url = `https://extensions.turbowarp.org/${slug}.js`;
        if (!url) return null;
        return {
            id: id || slug || url,
            name: name || id || slug || url,
            slug,
            url,
            source: 'tw-official',
            remote: true,
            builtin: false,
            hardware: false,
            scratchCompatible: extension.scratchCompatible !== false,
            description: String(extension.description || '').trim(),
            aliases: [
                id,
                slug,
                name,
                String(extension.author || '').trim()
            ].filter(Boolean)
        };
    };
    const fetchAiRemoteExtensionSource = async source => {
        const url = source.getUrl ? source.getUrl() : source.url;
        if (!url) return [];
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${source.name}: HTTP ${response.status}`);
        const data = await response.json();
        const rawList = Array.isArray(data)
            ? data
            : (Array.isArray(data && data.extensions) ? data.extensions : []);
        return rawList
            .map(item => normalizeAiRemoteExtensionRecord(source, item))
            .filter(Boolean);
    };
    const getAiRemoteExtensionCatalog = async () => {
        if (aiRemoteExtensionCatalog) return aiRemoteExtensionCatalog;
        if (aiRemoteExtensionCatalogPromise) return aiRemoteExtensionCatalogPromise;
        aiRemoteExtensionCatalogPromise = Promise.allSettled(
            AI_REMOTE_EXTENSION_SOURCES.map(source => fetchAiRemoteExtensionSource(source))
        ).then(results => {
            const items = [];
            const errors = [];
            const seen = new Set();
            for (const result of results) {
                if (result.status !== 'fulfilled') {
                    errors.push(result.reason && result.reason.message ? result.reason.message : String(result.reason));
                    continue;
                }
                for (const item of result.value || []) {
                    const key = `${item.id || ''}|${item.url || ''}`.toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);
                    items.push(item);
                }
            }
            aiRemoteExtensionCatalogError = errors.join('；');
            aiRemoteExtensionCatalog = items.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
            return aiRemoteExtensionCatalog;
        }).finally(() => {
            aiRemoteExtensionCatalogPromise = null;
        });
        return aiRemoteExtensionCatalogPromise;
    };
    const findAiRemoteExtensionRecord = async value => {
        const query = String(value || '').trim();
        if (!query) return null;
        const normalizedQuery = normalizeAiExtensionSlug(query).toLowerCase();
        const catalog = await getAiRemoteExtensionCatalog();
        const exact = catalog.find(item => {
            const aliases = [item.id, item.slug, item.name, ...(item.aliases || [])]
                .map(alias => normalizeAiExtensionSlug(alias).toLowerCase())
                .filter(Boolean);
            return aliases.includes(normalizedQuery);
        });
        if (exact) return exact;
        return catalog.find(item => {
            const text = [item.id, item.slug, item.name, item.description, item.source]
                .concat(item.aliases || [])
                .join(' ')
                .toLowerCase();
            return text.includes(normalizedQuery);
        }) || null;
    };
    const makeAiTurboWarpExtensionUrl = slug => {
        const clean = normalizeAiExtensionSlug(slug);
        if (!clean || clean.includes('..') || /^[a-z]+:/i.test(clean)) return '';
        return `https://extensions.turbowarp.org/${clean}.js`;
    };
    const getAiLoadedExtensionIds = vm => {
        const manager = vm && vm.extensionManager;
        const loaded = manager && manager._loadedExtensions;
        if (loaded && typeof loaded.keys === 'function') return Array.from(loaded.keys()).sort();
        return [];
    };
    const isAiExtensionLoaded = (vm, extensionId) => {
        const manager = vm && vm.extensionManager;
        return !!(manager && typeof manager.isExtensionLoaded === 'function' && manager.isExtensionLoaded(extensionId));
    };
    const summarizeAiExtension = (vm, recordOrId) => {
        const record = typeof recordOrId === 'string'
            ? (AI_EXTENSION_ID_MAP.get(recordOrId) || {id: recordOrId, name: recordOrId})
            : recordOrId;
        const id = record && record.id ? record.id : '';
        return {
            id,
            name: record && record.name ? record.name : id,
            loaded: !!(id && isAiExtensionLoaded(vm, id)),
            builtin: !!(record && record.builtin),
            hardware: !!(record && record.hardware),
            remote: !!(record && record.remote),
            source: record && record.source ? record.source : undefined,
            slug: record && record.slug ? record.slug : undefined,
            url: record && record.url ? record.url : undefined,
            description: record && record.description ? record.description : undefined
        };
    };
    const getAiExtensionSummaries = (vm, remoteItems) => {
        const summaries = AI_EXTENSION_CATALOG.map(item => summarizeAiExtension(vm, item));
        const seen = new Set(summaries.map(item => item.id));
        for (const item of remoteItems || []) {
            const summary = summarizeAiExtension(vm, item);
            const key = `${summary.id || ''}|${summary.url || ''}`.toLowerCase();
            if (seen.has(summary.id) || seen.has(key)) continue;
            seen.add(summary.id);
            seen.add(key);
            summaries.push(summary);
        }
        for (const id of getAiLoadedExtensionIds(vm)) {
            if (seen.has(id)) continue;
            summaries.push(summarizeAiExtension(vm, id));
        }
        return summaries;
    };
    const getAiLoadedExtensionSummaries = vm => {
        const loadedIds = getAiLoadedExtensionIds(vm);
        return loadedIds.map(id => summarizeAiExtension(vm, AI_EXTENSION_ID_MAP.get(id) || id));
    };
    const getAiLocalExtensionSummaries = vm => AI_EXTENSION_CATALOG.map(item => {
        const summary = summarizeAiExtension(vm, item);
        return {
            id: summary.id,
            name: summary.name,
            loaded: summary.loaded,
            builtin: summary.builtin,
            hardware: summary.hardware
        };
    });
    const getAiExtensionContext = vm => ({
        core: AI_CORE_EXTENSION_CONTEXT,
        loadedIds: getAiLoadedExtensionIds(vm),
        loaded: getAiLoadedExtensionSummaries(vm),
        localAvailable: getAiLocalExtensionSummaries(vm)
    });
    const getAiExtensionIdForOpcode = opcode => {
        const text = String(opcode || '').trim();
        const match = text.match(/^([A-Za-z0-9]+)_/);
        if (!match) return '';
        const prefix = match[1];
        if (AI_CORE_OPCODE_PREFIXES.has(prefix)) return '';
        return AI_EXTENSION_OPCODE_PREFIX_MAP.get(prefix.toLowerCase()) || prefix;
    };
    const getAiRequiredExtensionsFromBlocks = blocks => {
        const ids = new Set();
        for (const block of Object.values(blocks || {})) {
            if (!block || Array.isArray(block) || typeof block.opcode !== 'string') continue;
            const id = getAiExtensionIdForOpcode(block.opcode);
            if (id) ids.add(id);
        }
        return Array.from(ids);
    };
    const getAiContextKeywords = vm => {
        const defs = Array.isArray(pseudoConverter.opcodeDefs) ? pseudoConverter.opcodeDefs : [];
        const loaded = new Set(getAiLoadedExtensionIds(vm));
        const names = [];
        for (const def of defs) {
            if (!def || !def.opcode) continue;
            const extensionId = getAiExtensionIdForOpcode(def.opcode);
            if (extensionId && !loaded.has(extensionId)) continue;
            names.push(def.name, def.cname, def.opcode);
        }
        const runtime = vm && vm.runtime;
        const blockInfo = Array.isArray(runtime && runtime._blockInfo) ? runtime._blockInfo : [];
        for (const category of blockInfo) {
            if (!category || !category.id || !loaded.has(category.id) || !Array.isArray(category.blocks)) continue;
            for (const convertedBlock of category.blocks) {
                const info = convertedBlock && convertedBlock.info;
                if (!info || !info.opcode) continue;
                const json = convertedBlock && convertedBlock.json;
                names.push(json && json.type ? String(json.type) : `${category.id}_${info.opcode}`);
            }
        }
        return names.filter(Boolean).slice(0, 260);
    };
    const formatAiExtensionsDetail = result => {
        const extensions = (result && result.extensions) || [];
        const header = result && result.remoteError ? `远程扩展列表部分读取失败：${result.remoteError}\n\n` : '';
        if (!extensions.length) return `${header}没有可显示的扩展。`;
        const body = extensions.map(item => [
            `${item.loaded ? '已加载' : '未加载'} ${item.id} - ${item.name}`,
            item.remote ? `远程来源: ${item.source || 'remote'}${item.slug ? ` / ${item.slug}` : ''}` : '',
            item.hardware ? '硬件扩展' : '',
            item.url ? `url: ${item.url}` : ''
        ].filter(Boolean).join('\n')).join('\n\n');
        const footer = result && result.truncated ? `\n\n只显示前 ${extensions.length} 个，共 ${result.total} 个。` : '';
        return `${header}${body}${footer}`;
    };
    const formatAiLoadedExtensions = extensions => (extensions || [])
        .map(item => `${item.id || ''}${item.name ? ` (${item.name})` : ''}`.trim())
        .filter(Boolean)
        .join('、');
    const getAiMaybeMessageText = value => {
        if (value == null) return '';
        if (typeof value === 'string') return value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        if (typeof value === 'object') {
            return String(value.default || value.defaultMessage || value.message || value.id || '').trim();
        }
        return '';
    };
    const getAiExtensionBlockCategories = (vm, extensionId) => {
        const runtime = vm && vm.runtime;
        const blockInfo = Array.isArray(runtime && runtime._blockInfo) ? runtime._blockInfo : [];
        const loaded = new Set(getAiLoadedExtensionIds(vm));
        const requested = String(extensionId || '').trim();
        if (requested) {
            return blockInfo.filter(category => category && category.id === requested);
        }
        return blockInfo.filter(category => category && category.id && loaded.has(category.id));
    };
    const normalizeAiExtensionMenuItems = menuInfo => {
        if (!menuInfo) return null;
        const items = menuInfo.items;
        if (typeof items === 'function') return {dynamic: true, items: []};
        if (!Array.isArray(items)) return null;
        const normalized = items.slice(0, 30).map(item => {
            if (typeof item === 'string' || typeof item === 'number') {
                return {text: String(item), value: String(item)};
            }
            if (!item || typeof item !== 'object') return null;
            const text = getAiMaybeMessageText(item.text || item.name || item.label || item.value);
            const value = item.value != null ? String(item.value) : text;
            return text || value ? {text: text || value, value} : null;
        }).filter(Boolean);
        return {
            dynamic: false,
            items: normalized,
            truncated: items.length > normalized.length
        };
    };
    const normalizeAiExtensionArgument = (category, name, argInfo) => {
        const arg = argInfo && typeof argInfo === 'object' ? argInfo : {};
        const menuInfo = arg.menu && category && category.menuInfo ? category.menuInfo[arg.menu] : null;
        const menuAcceptsReporters = !!(arg.menu && menuInfo && menuInfo.acceptReporters);
        const isDropdownField = !!(arg.menu && !menuAcceptsReporters);
        const defaultValue = getAiMaybeMessageText(
            arg.defaultValue !== undefined ? arg.defaultValue : (arg.default !== undefined ? arg.default : '')
        );
        return {
            name,
            kind: isDropdownField ? 'field' : 'input',
            type: arg.type || '',
            menu: arg.menu || undefined,
            acceptReporters: menuAcceptsReporters,
            defaultValue,
            menuItems: normalizeAiExtensionMenuItems(menuInfo)
        };
    };
    const makeAiExtensionOpExample = block => {
        const fields = [];
        const inputs = [];
        for (const slot of block.slots || []) {
            const value = slot.defaultValue || (slot.type === 'number' ? '10' : 'value');
            if (slot.kind === 'field') {
                fields.push(`${JSON.stringify(slot.name)}:${JSON.stringify(value)}`);
            } else {
                const inputValue = /^-?\d+(?:\.\d+)?$/.test(value) ? value : JSON.stringify(value);
                inputs.push(`${JSON.stringify(slot.name)}:${inputValue}`);
            }
        }
        const pieces = [JSON.stringify(block.opcode)];
        const blockKind = String(block.blockType || '').toLowerCase();
        if (blockKind === 'boolean' || blockKind === 'reporter') pieces.push(`kind=${JSON.stringify(blockKind)}`);
        if (fields.length) pieces.push(`fields={${fields.join(', ')}}`);
        if (inputs.length) pieces.push(`inputs={${inputs.join(', ')}}`);
        return `@op(${pieces.join(', ')})`;
    };
    const summarizeAiExtensionBlock = (category, convertedBlock) => {
        const info = convertedBlock && convertedBlock.info;
        const json = convertedBlock && convertedBlock.json;
        if (!info || typeof info !== 'object' || !info.opcode) return null;
        const opcode = json && json.type ? String(json.type) : `${category.id}_${info.opcode}`;
        const args = info.arguments && typeof info.arguments === 'object' ? info.arguments : {};
        const slots = Object.keys(args).map(name => normalizeAiExtensionArgument(category, name, args[name]));
        const text = Array.isArray(info.text)
            ? info.text.map(getAiMaybeMessageText).filter(Boolean).join(' | ')
            : getAiMaybeMessageText(info.text);
        const result = {
            opcode,
            rawOpcode: String(info.opcode),
            blockType: String(info.blockType || ''),
            text,
            slots,
            terminal: !!info.isTerminal,
            hidden: !!(info.hide || info.hideFromPalette),
            filter: Array.isArray(info.filter) ? info.filter.slice() : undefined
        };
        result.opExample = makeAiExtensionOpExample(result);
        return result;
    };
    const getAiExtensionBlocks = (vm, tool) => {
        const extensionId = normalizeAiExtensionId(
            (tool && (tool.extensionId || tool.id || tool.name || tool.extension)) || ''
        );
        const categories = getAiExtensionBlockCategories(vm, extensionId);
        if (extensionId && !categories.length) {
            const loaded = getAiLoadedExtensionIds(vm);
            return {
                ok: false,
                type: 'get_extension_blocks',
                error: `扩展 ${extensionId} 尚未加载或没有 block metadata。请先 load_extension。`,
                loaded
            };
        }
        if (!categories.length) {
            return {
                ok: false,
                type: 'get_extension_blocks',
                error: '当前没有已加载扩展的 block metadata。请先 load_extension。',
                loaded: getAiLoadedExtensionIds(vm)
            };
        }
        const limit = Math.min(300, Math.max(1, Number(tool && (tool.limit || tool.maxResults)) || AI_EXTENSION_BLOCK_LIMIT));
        const query = String(tool && (tool.query || tool.keyword || '') || '').trim().toLowerCase();
        const extensions = [];
        let totalBlocks = 0;
        let matchedBlocks = 0;
        let returnedBlocks = 0;
        for (const category of categories) {
            const blocks = [];
            for (const convertedBlock of category.blocks || []) {
                const block = summarizeAiExtensionBlock(category, convertedBlock);
                if (!block) continue;
                totalBlocks++;
                if (query) {
                    const text = [block.opcode, block.rawOpcode, block.text, block.blockType]
                        .join(' ')
                        .toLowerCase();
                    if (!text.includes(query)) continue;
                }
                matchedBlocks++;
                if (returnedBlocks >= limit) continue;
                blocks.push(block);
                returnedBlocks++;
            }
            extensions.push({
                id: category.id,
                name: category.name || category.id,
                color1: category.color1,
                color2: category.color2,
                blockCount: blocks.length,
                blocks
            });
        }
        return {
            ok: true,
            type: 'get_extension_blocks',
            extensionId: extensionId || null,
            extensions,
            totalBlocks,
            matchedBlocks,
            returnedBlocks,
            truncated: returnedBlocks < matchedBlocks
        };
    };
    const formatAiExtensionBlocksDetail = result => {
        if (!result || !Array.isArray(result.extensions) || !result.extensions.length) return '没有扩展积木信息。';
        const lines = [];
        for (const extension of result.extensions) {
            lines.push(`${extension.id} - ${extension.name}`);
            for (const block of extension.blocks || []) {
                const slots = (block.slots || []).map(slot => {
                    const menu = slot.menu ? ` menu=${slot.menu}${slot.acceptReporters ? '+reporter' : ''}` : '';
                    return `${slot.kind}:${slot.name}${slot.type ? `/${slot.type}` : ''}${menu}`;
                }).join(', ');
                lines.push(`- ${block.opcode} [${block.blockType}] ${block.text || ''}`);
                if (slots) lines.push(`  slots: ${slots}`);
                lines.push(`  @op: ${block.opExample}`);
            }
        }
        if (result.truncated) lines.push(`只显示 ${result.returnedBlocks}/${result.matchedBlocks || result.totalBlocks} 个匹配积木。`);
        return lines.join('\n');
    };
    const getAiProjectContext = (target, vm, currentText, summarizeTarget) => {
        const stage = vm && vm.runtime && vm.runtime.getTargetForStage ? vm.runtime.getTargetForStage() : null;
        const summarize = typeof summarizeTarget === 'function'
            ? summarizeTarget
            : item => getAiTargetSummary(item, vm);
        const stageSummary = stage ? summarize(stage) : null;
        const currentSummary = target ? summarize(target) : null;
        const defineLines = String(currentText || '').split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('define '))
            .slice(0, 80);
        return {
            targets: getAiTargets(vm).map(item => summarize(item)),
            runtime: getAiRuntimeContext(vm),
            stageTargetRef: stageSummary && stageSummary.targetRef,
            stageTargetId: stage && stage.id,
            stageAliases: ['Stage', '舞台', '背景', 'backdrop'],
            currentTargetRef: currentSummary && currentSummary.targetRef,
            currentTargetId: target && target.id,
            targetName: target && target.sprite ? target.sprite.name : (target && target.id) || '',
            isStage: !!(target && target.isStage),
            variables: {
                local: getTargetNamesByType(target, ''),
                global: getTargetNamesByType(stage, '')
            },
            lists: {
                local: getTargetNamesByType(target, 'list'),
                global: getTargetNamesByType(stage, 'list')
            },
            broadcasts: getTargetNamesByType(stage, 'broadcast_msg'),
            extensions: getAiExtensionContext(vm),
            procedures: defineLines,
            keywords: getAiContextKeywords(vm)
        };
    };
    const formatPseudoErrors = errors => (errors || [])
        .slice(0, 8)
        .map(e => `line ${Number(e && e.line) > 0 ? e.line : 1}, col ${Number(e && e.col) > 0 ? e.col : 1}: ${e && e.message}`)
        .join('\n');
    const stripCodeFence = text => {
        const s = String(text || '').trim();
        const m = s.match(/^```(?:json|javascript|js|text|pseudo|pseudocode)?\s*([\s\S]*?)\s*```$/i);
        return m ? m[1].trim() : s;
    };
    const AI_TOOL_OPEN = '<AI_TOOL>';
    const AI_TOOL_CLOSE = '</AI_TOOL>';
    const AI_EDIT_OPEN = '<AI_EDIT>';
    const AI_EDIT_CLOSE = '</AI_EDIT>';
    const AI_ACTION_OPEN = '<ACTION>';
    const AI_ACTION_CLOSE = '</ACTION>';
    const AI_PROVIDER_TOOL_OPEN = '<|tool_calls_section_begin|>';
    const AI_PROVIDER_TOOL_CLOSE = '<|tool_calls_section_end|>';
    const AI_THINK_OPEN = '<think>';
    const AI_THINK_CLOSE = '</think>';
    const AI_HIDDEN_TOKENS = [
        {type: 'action', open: AI_ACTION_OPEN, close: AI_ACTION_CLOSE},
        {type: 'tool', open: AI_TOOL_OPEN, close: AI_TOOL_CLOSE},
        {type: 'edit', open: AI_EDIT_OPEN, close: AI_EDIT_CLOSE},
        {type: 'provider_tool', open: AI_PROVIDER_TOOL_OPEN, close: AI_PROVIDER_TOOL_CLOSE}
    ];
    const AI_PSEUDOCODE_PREVIEW_LIMIT = 12000;
    const AI_TOOL_TRACE_STRING_LIMIT = 2400;
    const AI_TOOL_TRACE_ARRAY_LIMIT = 30;
    const AI_TOOL_TRACE_DEPTH_LIMIT = 5;
    const AI_SEARCH_RESULT_LIMIT = 80;
    const AI_EXTENSION_BLOCK_LIMIT = 120;
    const AI_PSEUDOCODE_SYNTAX_GUIDE = [
        '伪代码文件结构：',
        '1. 可选头部声明。',
        '2. 一个或多个顶层脚本。',
        '3. 一个或多个自定义块 define。',
        '',
        '头部声明规则：',
        '- 变量、列表、广播声明应放在伪代码最前面，先写声明，再写脚本。',
        '- 全局变量使用 #vars { 名字1, 名字2 }。',
        '- 角色局部变量使用 #localvars { 名字1, 名字2 }。',
        '- 全局列表使用 #lists { 名字1, 名字2 }。',
        '- 角色局部列表使用 #locallists { 名字1, 名字2 }。',
                        '- 广播消息不需要头部声明；使用 broadcast("消息名")、broadcast_and_wait("消息名") 或 on_broadcast("消息名") 时会自动创建。',
                        '- 中文别名也可用：#变量、#局部变量、#列表、#局部列表。',
        '- 不要在 on_flag_clicked、define、forever、if 等脚本体内部写头部声明。',
                        '- 标准写法使用复数：#vars、#localvars、#lists、#locallists。',
        '',
        '伪代码规则：',
        '- 使用 context.keywords 中的英文友好积木名，除非现有伪代码已经使用中文名或原始 opcode。',
        '- 顶层脚本之间用空行分隔。事件脚本示例：on_flag_clicked() { ... }。',
        '- 没有帽子积木的顶层堆栈可以写成 { ... }。可用 at(120, 80) on_flag_clicked() { ... } 指定坐标。',
        '- 普通语句写成 name(arg1, arg2)。C 型积木用 braces，例如 forever() { ... }、repeat(10) { ... }、repeat_until(condition) { ... }。',
        '- if 必须写成 if (条件) { ... }，else 写成 if (...) { ... } else { ... }。',
        '- 表达式支持数字、字符串、变量/reporter、true/false/null、括号、!、+、-、*、/、%、<、>、<=、>=、==、!=、&&、||。',
        '- +、-、*、/、% 是数学运算，不是 JavaScript 字符串拼接。字符串拼接必须使用 join(a, b)；多个片段使用嵌套 join，例如 join(join("第", 关卡编号), "关")。',
        '- 数学单参函数使用简洁写法：abs(x)、floor(x)、ceiling(x)、sqrt(x)、sin(x)、cos(x)、tan(x)、asin(x)、acos(x)、atan(x)、ln(x)、log(x)、exp(x)、pow10(x)。旧写法 math_op("abs", x) 兼容但不推荐。',
        '- 赋值支持 a = 1、a += 1、a -= 1、a *= 2、a /= 2、a %= 2。',
        '- 注释支持 // 行注释 和 /* 块注释 */，会同步为 Scratch 可视化注释气泡。注释只作为说明，不要把必须执行的逻辑写进注释里。',
        '- 不要写 JavaScript 风格临时变量声明，例如 var x = 1 或 let x = 1。需要变量时，在头部用 #vars 或 #localvars 声明，然后直接赋值。',
        '- 字符串包含空格、标点或菜单值时必须用双引号。双引号内部用 \\\" 转义。',
        '- Scratch 下拉输入槽分两类：帽子积木/字段型下拉必须写菜单字符串；普通输入型下拉既可以写菜单字符串，也可以写变量/reporter 表达式。',
        '- 菜单字符串示例：on_key_pressed("space")、key_pressed("left arrow")、goto("_mouse_")、create_clone_of("_myself_")、switch_costume("造型1")。',
        '- 可拖入 reporter 的菜单槽示例：switch_costume(当前造型编号)、switch_backdrop(背景编号)、goto(目标角色名)、key_pressed(按键名)。造型/背景切换中，数字表示第几个，字符串表示名称。',
                        '- 需要广播时直接使用 broadcast("消息名") 或 on_broadcast("消息名")，不要写 #broadcasts 头部。',
        '- 自定义块写成 define my_block(arg, bool flag) { ... } 或 define my_block(arg, bool flag) warp { ... }，调用写成 my_block(1, true) 或 call my_block(1)。',
        '- define 中的 warp 表示 Scratch/TurboWarp “不刷新屏幕运行”。没有 warp 时，自定义块内部每个积木/步骤大约按一帧执行；有 warp 时，函数体尽可能快地执行，直到让步或结束。',
        '- 纯计算、紧密循环、列表处理、递归、批量初始化适合 warp。动画、等待、需要看到过程的代码不要使用 warp。',
        '- return expr 只在自定义块里使用。只有已有 reporter 自定义块时才使用 callret/procedure reporter。',
        '- 未知 Scratch opcode 可以使用 @op(opcode="...", inputs={...}, fields={...}, mutation="...")，但优先使用普通友好名称。',
        '',
        '变量作用域规则：',
        '- #vars 是全局变量，适合“当前关卡”“总分”“游戏状态”。',
        '- #localvars 是角色局部变量，适合“本克隆编号”“本按钮关卡”“本敌人血量”。',
        '- #lists 是全局列表，适合全项目共享的数据。',
        '- #locallists 是角色局部列表，适合角色或克隆相关的临时数据。',
        '- 克隆体各自不同的数据必须使用 #localvars 或 #locallists。',
        '- 不要用全局变量保存每个克隆自己的身份，否则多个克隆会互相覆盖。',
        '- 批量创建带编号克隆（选关按钮、敌人、菜单项、列表项）时，使用一个 #vars 全局创建标记递增，再在 on_clone_start 的第一句复制到 #localvars 克隆身份变量。',
        '- 创建循环中写：创建标记 += 1；create_clone_of("_myself_")；wait(0)。wait(0) 会等待一帧，让刚创建的克隆先执行 on_clone_start 并读到当前标记，再进入下一次循环。',
        '- 克隆的位置、造型、血量、点击响应、广播参数等，都应读取克隆身份变量，不要读取还会继续变化的创建标记。',
        '',
        '头部声明示例：',
        '#vars { 当前关卡, 总分 }',
        '#localvars { 本关卡编号 }',
        '#lists { 已解锁关卡 }',
        '#locallists { 临时路径 }',
                        '脚本示例：',
        'on_flag_clicked() {',
        '    当前关卡 = 0',
        '    forever() {',
        '        move(10)',
        '        if_on_edge_bounce()',
        '        if (当前关卡 > 8) {',
        '            broadcast("游戏结束")',
        '        }',
        '    }',
        '}',
        '',
        '带编号克隆示例：',
        '#vars { 创建标记, 选中编号 }',
        '#localvars { 本克隆编号 }',
        'on_flag_clicked() {',
        '    hide()',
        '    创建标记 = 0',
        '    repeat(8) {',
        '        创建标记 += 1',
        '        create_clone_of("_myself_")',
        '        wait(0)',
        '    }',
        '}',
        'on_clone_start() {',
        '    本克隆编号 = 创建标记',
        '    show()',
        '    switch_costume(本克隆编号 + 1)',
        '}',
        'on_sprite_clicked() {',
        '    选中编号 = 本克隆编号',
        '}'
    ].join('\n');
    const formatAiPseudocodePreview = pseudocode => {
        const text = String(pseudocode || '').trim();
        if (!text) return '';
        if (text.length <= AI_PSEUDOCODE_PREVIEW_LIMIT) return text;
        return `${text.slice(0, AI_PSEUDOCODE_PREVIEW_LIMIT)}\n\n...（伪代码较长，后续内容已写入编辑器）`;
    };
    const formatAiToolTraceName = tool => {
        const type = String(tool && (tool.type || tool.toolType || tool.action) || '').trim();
        return type || 'unknown';
    };
    const sanitizeAiToolTraceValue = (value, depth = 0, seen = new Set()) => {
        if (value == null) return value;
        const valueType = typeof value;
        if (valueType === 'string') {
            if (/^data:image\//i.test(value)) return `[image data url, ${value.length} chars]`;
            if (value.length > AI_TOOL_TRACE_STRING_LIMIT) {
                return `${value.slice(0, AI_TOOL_TRACE_STRING_LIMIT)}\n...（已截断，原长度 ${value.length} 字符）`;
            }
            return value;
        }
        if (valueType === 'number' || valueType === 'boolean') return value;
        if (valueType === 'function' || valueType === 'symbol') return `[${valueType}]`;
        if (seen.has(value)) return '[Circular]';
        if (depth >= AI_TOOL_TRACE_DEPTH_LIMIT) return '[Object]';
        seen.add(value);
        if (Array.isArray(value)) {
            const items = value.slice(0, AI_TOOL_TRACE_ARRAY_LIMIT)
                .map(item => sanitizeAiToolTraceValue(item, depth + 1, seen));
            if (value.length > AI_TOOL_TRACE_ARRAY_LIMIT) {
                items.push(`...（已截断，剩余 ${value.length - AI_TOOL_TRACE_ARRAY_LIMIT} 项）`);
            }
            seen.delete(value);
            return items;
        }
        const result = {};
        for (const key of Object.keys(value)) {
            const lowerKey = key.toLowerCase();
            if (
                lowerKey === 'data' ||
                lowerKey === 'bytes' ||
                lowerKey === 'arraybuffer' ||
                lowerKey === 'imagedata' ||
                lowerKey === 'dataurl'
            ) {
                const raw = value[key];
                result[key] = typeof raw === 'string'
                    ? `[omitted ${raw.length} chars]`
                    : '[omitted binary data]';
                continue;
            }
            result[key] = sanitizeAiToolTraceValue(value[key], depth + 1, seen);
        }
        seen.delete(value);
        return result;
    };
    const formatAiToolTraceJson = value => JSON.stringify(sanitizeAiToolTraceValue(value), null, 2);
    const formatAiAppliedMultiResult = (summary, applications) => {
        const names = (applications || [])
            .map(item => item && item.targetName)
            .filter(Boolean);
        const lines = [];
        lines.push(summary ? `已应用修改：${summary}` : '已应用伪代码修改。');
        if (names.length) lines.push(`修改角色：${names.join('、')}`);
        lines.push('生成的伪代码已折叠，可展开查看。');
        return lines.join('\n');
    };
    const formatAiPatchDraftPreview = patches => {
        const items = Array.isArray(patches) ? patches : [];
        if (!items.length) return '';
        return items.map((patch, index) => {
            const lines = [];
            const op = String((patch && patch.op) || 'replace');
            const startLine = patch && patch.startLine != null ? patch.startLine : '';
            const endLine = patch && patch.endLine != null ? patch.endLine : startLine;
            lines.push(`Patch ${index + 1}: ${op}${startLine ? ` 第 ${startLine}${endLine && endLine !== startLine ? `-${endLine}` : ''} 行` : ''}`);
            if (patch && patch.summary) lines.push(`说明：${patch.summary}`);
            if (patch && typeof patch.oldText === 'string') {
                lines.push('oldText:');
                lines.push(patch.oldText);
            }
            if (patch && typeof patch.newText === 'string') {
                lines.push('newText:');
                lines.push(patch.newText);
            }
            if (lines.length <= 1) lines.push(JSON.stringify(patch || {}, null, 2));
            return lines.join('\n');
        }).join('\n\n');
    };
    const formatAiElapsed = startTime => {
        const seconds = Math.max(0, Date.now() - startTime) / 1000;
        if (seconds < 10) return `${seconds.toFixed(1)}s`;
        return `${Math.round(seconds)}s`;
    };
    const formatAiSearchResultDetail = result => {
        const lines = [];
        const matches = (result && result.matches) || [];
        const searched = ((result && result.targetsSearched) || [])
            .map(item => item && item.targetName)
            .filter(Boolean);
        lines.push(`查找：${JSON.stringify((result && result.query) || '')}`);
        lines.push(`范围：${searched.length ? searched.join('、') : '全部角色'}`);
        lines.push(`命中：${(result && result.totalMatches) || 0} 条${result && result.truncated ? `（仅显示前 ${matches.length} 条）` : ''}`);
        if (!matches.length) {
            lines.push('没有找到匹配行。');
            return lines.join('\n');
        }
        for (const match of matches) {
            const label = match.targetRef ? `${match.targetRef} ${match.targetName}` : match.targetName;
            lines.push(`${label} 第 ${match.lineNumber} 行，第 ${match.column} 列: ${match.lineText}`);
        }
        return lines.join('\n');
    };
    const normalizeAiLineEndings = text => String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    const splitAiLines = text => {
        const normalized = normalizeAiLineEndings(text);
        return normalized ? normalized.split('\n') : [];
    };
    const buildAiSimpleLineDiffRows = (beforeLines, afterLines) => {
        let prefix = 0;
        while (
            prefix < beforeLines.length &&
            prefix < afterLines.length &&
            beforeLines[prefix] === afterLines[prefix]
        ) {
            prefix++;
        }
        let suffix = 0;
        while (
            suffix < beforeLines.length - prefix &&
            suffix < afterLines.length - prefix &&
            beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
        ) {
            suffix++;
        }
        const rows = [];
        for (let i = 0; i < prefix; i++) {
            rows.push({type: 'context', oldLine: i + 1, newLine: i + 1, text: afterLines[i]});
        }
        for (let i = prefix; i < beforeLines.length - suffix; i++) {
            rows.push({type: 'remove', oldLine: i + 1, newLine: null, text: beforeLines[i]});
        }
        for (let i = prefix; i < afterLines.length - suffix; i++) {
            rows.push({type: 'add', oldLine: null, newLine: i + 1, text: afterLines[i]});
        }
        for (let i = afterLines.length - suffix; i < afterLines.length; i++) {
            const oldLine = beforeLines.length - afterLines.length + i + 1;
            rows.push({type: 'context', oldLine, newLine: i + 1, text: afterLines[i]});
        }
        return rows;
    };
    const buildAiLineDiffRows = (beforeText, afterText) => {
        const beforeLines = splitAiLines(formatAiPseudocodePreview(beforeText));
        const afterLines = splitAiLines(formatAiPseudocodePreview(afterText));
        if (!beforeLines.length && !afterLines.length) return [];
        if (beforeLines.join('\n') === afterLines.join('\n')) {
            return afterLines.map((line, index) => ({
                type: 'context',
                oldLine: index + 1,
                newLine: index + 1,
                text: line
            }));
        }
        if (beforeLines.length * afterLines.length > 600000) {
            return buildAiSimpleLineDiffRows(beforeLines, afterLines);
        }
        const dp = Array.from({length: beforeLines.length + 1}, () => new Uint32Array(afterLines.length + 1));
        for (let i = beforeLines.length - 1; i >= 0; i--) {
            for (let j = afterLines.length - 1; j >= 0; j--) {
                dp[i][j] = beforeLines[i] === afterLines[j]
                    ? dp[i + 1][j + 1] + 1
                    : Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
        }
        const rows = [];
        let i = 0;
        let j = 0;
        while (i < beforeLines.length || j < afterLines.length) {
            if (i < beforeLines.length && j < afterLines.length && beforeLines[i] === afterLines[j]) {
                rows.push({type: 'context', oldLine: i + 1, newLine: j + 1, text: afterLines[j]});
                i++;
                j++;
            } else if (j < afterLines.length && (i >= beforeLines.length || dp[i][j + 1] >= dp[i + 1][j])) {
                rows.push({type: 'add', oldLine: null, newLine: j + 1, text: afterLines[j]});
                j++;
            } else if (i < beforeLines.length) {
                rows.push({type: 'remove', oldLine: i + 1, newLine: null, text: beforeLines[i]});
                i++;
            }
        }
        return rows;
    };
    const compactAiDiffRows = (rows, contextRadius) => {
        const source = Array.isArray(rows) ? rows : [];
        const radius = Number.isInteger(contextRadius) ? contextRadius : 3;
        const changed = [];
        source.forEach((row, index) => {
            if (row && (row.type === 'add' || row.type === 'remove')) changed.push(index);
        });
        if (!changed.length) return {rows: source, hiddenCount: 0};
        const keep = new Set();
        changed.forEach(index => {
            for (let i = Math.max(0, index - radius); i <= Math.min(source.length - 1, index + radius); i++) {
                keep.add(i);
            }
        });
        const compactRows = [];
        let hiddenCount = 0;
        const flushHidden = () => {
            if (!hiddenCount) return;
            compactRows.push({
                type: 'omit',
                oldLine: null,
                newLine: null,
                text: `... 跳过 ${hiddenCount} 行未改动`
            });
            hiddenCount = 0;
        };
        source.forEach((row, index) => {
            if (keep.has(index)) {
                flushHidden();
                compactRows.push(row);
            } else {
                hiddenCount++;
            }
        });
        flushHidden();
        return {
            rows: compactRows,
            hiddenCount: source.length - compactRows.filter(row => row && row.type !== 'omit').length
        };
    };
    const normalizeAiToolTargetIds = payload => {
        const raw = payload && (
            payload.targetRefs ||
            payload.targetIds ||
            payload.targets ||
            payload.refs ||
            payload.ids ||
            payload.targetNames ||
            payload.names
        );
        const values = Array.isArray(raw)
            ? raw
            : (typeof raw === 'string' ? raw.split(',') : []);
        const single = payload && (
            payload.targetRef ||
            payload.targetId ||
            payload.target ||
            payload.targetName
        );
        if (single && !values.length) values.push(single);
        return values
            .map(item => String(item).trim())
            .filter(Boolean);
    };
    const normalizeAiToolLineRanges = payload => {
        const ranges = [];
        const pushRange = item => {
            if (item == null) return;
            if (typeof item === 'number' || typeof item === 'string') {
                const line = Number(item);
                ranges.push({startLine: line, endLine: line});
                return;
            }
            if (Array.isArray(item)) {
                const startLine = Number(item[0]);
                const endLine = item.length > 1 ? Number(item[1]) : startLine;
                ranges.push({startLine, endLine});
                return;
            }
            if (typeof item === 'object') {
                const startLine = Number(item.startLine || item.start || item.from || item.line);
                const endLine = Number(item.endLine || item.end || item.to || item.startLine || item.start || item.from || item.line);
                const targetId = item.targetRef || item.targetId || item.target || item.targetName || item.name || '';
                ranges.push({
                    targetId: targetId ? String(targetId).trim() : '',
                    startLine,
                    endLine
                });
            }
        };
        const rawRanges = payload && (payload.lineRanges || payload.ranges || payload.range);
        if (Array.isArray(rawRanges)) rawRanges.forEach(pushRange);
        else if (rawRanges) pushRange(rawRanges);
        const rawLines = payload && (payload.lines || payload.lineNumbers);
        if (Array.isArray(rawLines)) rawLines.forEach(pushRange);
        else if (rawLines != null) pushRange(rawLines);
        if (payload && (payload.startLine != null || payload.start != null || payload.from != null || payload.line != null)) {
            pushRange(payload);
        }
        return ranges;
    };
    const getAiPseudocodeLineSlice = (text, range) => {
        const lines = splitAiLines(text);
        const startLine = Number(range && range.startLine);
        const endLine = Number(range && range.endLine);
        if (!Number.isInteger(startLine) || !Number.isInteger(endLine) ||
                startLine < 1 || endLine < startLine || endLine > lines.length) {
            return {
                ok: false,
                error: `行号范围无效: ${startLine}-${endLine}，当前共有 ${lines.length} 行`
            };
        }
        const selected = lines.slice(startLine - 1, endLine);
        return {
            ok: true,
            startLine,
            endLine,
            totalLines: lines.length,
            pseudocode: selected.join('\n'),
            lines: selected.map((line, index) => ({
                lineNumber: startLine + index,
                text: line
            }))
        };
    };
    const formatAiPseudocodeSnippetDetail = item => {
        const lines = [];
        lines.push(`${item.targetRef ? `${item.targetRef} ` : ''}${item.targetName} 第 ${item.startLine}-${item.endLine} 行 / 共 ${item.totalLines} 行`);
        lines.push('');
        for (const line of item.lines || []) {
            lines.push(`${String(line.lineNumber).padStart(4, ' ')}  ${line.text}`);
        }
        return lines.join('\n');
    };
    const searchAiPseudocodeLines = (text, query, options) => {
        const needle = String(query || '').trim();
        if (!needle) return {ok: false, error: '查找文本不能为空'};
        const caseSensitive = !!(options && options.caseSensitive);
        const useRegex = !!(options && options.regex);
        let findColumn;
        if (useRegex) {
            let re;
            try {
                re = new RegExp(needle, caseSensitive ? '' : 'i');
            } catch (err) {
                return {ok: false, error: `正则表达式无效: ${err.message}`};
            }
            findColumn = line => {
                const match = re.exec(line);
                return match ? match.index + 1 : 0;
            };
        } else {
            const normalizedNeedle = caseSensitive ? needle : needle.toLowerCase();
            findColumn = line => {
                const haystack = caseSensitive ? line : line.toLowerCase();
                const index = haystack.indexOf(normalizedNeedle);
                return index >= 0 ? index + 1 : 0;
            };
        }
        const maxResults = Math.max(0, Number(options && options.maxResults) || AI_SEARCH_RESULT_LIMIT);
        const matches = [];
        let totalMatches = 0;
        splitAiLines(text).forEach((line, index) => {
            const column = findColumn(line);
            if (!column) return;
            totalMatches++;
            if (matches.length < maxResults) {
                matches.push({
                    lineNumber: index + 1,
                    column,
                    lineText: line
                });
            }
        });
        return {ok: true, matches, totalMatches, truncated: totalMatches > matches.length};
    };
    const applyAiLinePatches = (baseText, patches) => {
        const lines = splitAiLines(baseText);
        const normalizedPatches = (Array.isArray(patches) ? patches : []).map((patch, index) => ({
            ...patch,
            index,
            op: String((patch && patch.op) || 'replace')
        }));
        const anchorOf = patch => {
            if (patch.op === 'insertAfter') {
                const value = patch.afterLine != null ? patch.afterLine : patch.startLine;
                return Number.isFinite(Number(value)) ? Number(value) : -1;
            }
            return Number.isFinite(Number(patch.startLine)) ? Number(patch.startLine) : -1;
        };
        normalizedPatches.sort((a, b) => {
            const delta = anchorOf(b) - anchorOf(a);
            return delta || (b.index - a.index);
        });
        for (const patch of normalizedPatches) {
            if (patch.op === 'insertAfter') {
                const afterLine = anchorOf(patch);
                if (!Number.isInteger(afterLine) || afterLine < 0 || afterLine > lines.length) {
                    return {ok: false, error: `insertAfter 行号无效: ${afterLine}`};
                }
                const inserted = splitAiLines(patch.newText || '');
                lines.splice(afterLine, 0, ...inserted);
                continue;
            }
            if (patch.op !== 'replace' && patch.op !== 'delete') {
                return {ok: false, error: `不支持的补丁操作: ${patch.op}`};
            }
            const startLine = Number(patch.startLine);
            const endLine = Number(patch.endLine);
            if (!Number.isInteger(startLine) || !Number.isInteger(endLine) ||
                    startLine < 1 || endLine < startLine || endLine > lines.length) {
                return {ok: false, error: `补丁行号无效: ${startLine}-${endLine}`};
            }
            const actual = lines.slice(startLine - 1, endLine).join('\n');
            const expected = normalizeAiLineEndings(patch.oldText || '');
            if (actual !== expected) {
                return {
                    ok: false,
                    error: `补丁 oldText 与第 ${startLine}-${endLine} 行不匹配`,
                    expected,
                    actual
                };
            }
            const replacement = patch.op === 'delete' ? [] : splitAiLines(patch.newText || '');
            lines.splice(startLine - 1, endLine - startLine + 1, ...replacement);
        }
        return {ok: true, text: lines.join('\n')};
    };
    const getAiHiddenTokenLabel = token => {
        if (!token) return 'AI 隐藏块';
        if (token.type === 'action') return 'AI 动作块';
        if (token.type === 'tool' || token.type === 'provider_tool') return 'AI 工具块';
        if (token.type === 'edit') return 'AI 修改块';
        return 'AI 隐藏块';
    };
    const parseAiJsonFromText = text => {
        const clean = stripCodeFence(text);
        return JSON.parse(clean);
    };
    const parseAiProviderToolPayload = text => {
        const raw = String(text || '');
        const marker = '<|tool_call_argument_begin|>';
        const endMarkers = [
            '<|tool_call_end|>',
            '<|tool_call_argument_end|>',
            '<|tool_calls_section_end|>'
        ];
        const payloads = [];
        let index = raw.indexOf(marker);
        while (index >= 0) {
            const start = index + marker.length;
            let end = raw.length;
            for (const endMarker of endMarkers) {
                const candidate = raw.indexOf(endMarker, start);
                if (candidate >= 0 && candidate < end) end = candidate;
            }
            const chunk = raw.slice(start, end).trim();
            if (chunk) payloads.push(parseAiJsonFromText(chunk));
            index = raw.indexOf(marker, end);
        }
        if (payloads.length === 1) return payloads[0];
        if (payloads.length > 1) return {type: 'batch', calls: payloads};
        const firstBrace = raw.indexOf('{');
        const lastBrace = raw.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
            return parseAiJsonFromText(raw.slice(firstBrace, lastBrace + 1));
        }
        throw new Error('没有找到工具参数 JSON');
    };
    const normalizeAiCallableTypeName = value => String(value || '')
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[\s-]+/g, '_')
        .toLowerCase();
    const normalizeAiCallablePayload = parsed => {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
        const type = normalizeAiCallableTypeName(parsed.type || parsed.name || parsed.action || parsed.toolType);
        let args = parsed.arguments;
        if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch (_) { args = null; }
        }
        if (args && typeof args === 'object' && !Array.isArray(args)) {
            return {
                ...args,
                type: args.type || type
            };
        }
        return parsed;
    };
    const normalizeAiSingleToolPayload = parsed => {
        parsed = normalizeAiCallablePayload(parsed);
        const type = normalizeAiCallableTypeName(parsed && (parsed.type || parsed.action || parsed.toolType));
        const targetIds = normalizeAiToolTargetIds(parsed);
        const lineRanges = normalizeAiToolLineRanges(parsed);
        if (
            type === 'click_green_flag' ||
            type === 'green_flag' ||
            type === 'start_project' ||
            type === 'run_project' ||
            type === 'start' ||
            type === 'go'
        ) {
            return {ok: true, tool: {type: 'click_green_flag', raw: parsed}};
        }
        if (
            type === 'click_pause' ||
            type === 'pause_project' ||
            type === 'pause'
        ) {
            return {ok: true, tool: {type: 'click_pause', raw: parsed}};
        }
        if (
            type === 'click_stop' ||
            type === 'stop_project' ||
            type === 'stop_all' ||
            type === 'stop'
        ) {
            return {ok: true, tool: {type: 'click_stop', raw: parsed}};
        }
        if (type === 'get_target_info' || type === 'get_targets' || type === 'list_targets') {
            return {ok: true, tool: {type: 'get_target_info', targetIds}};
        }
        if (type === 'get_costume_info' || type === 'get_costumes' || type === 'list_costumes') {
            return {
                ok: true,
                tool: {
                    type: 'get_costume_info',
                    targetIds,
                    targetId: String(parsed.targetRef || parsed.targetId || parsed.target || parsed.targetName || '').trim(),
                    costumeName: String(parsed.costumeName || parsed.backdropName || parsed.name || '').trim(),
                    costumeIndex: parsed.costumeIndex != null ? parsed.costumeIndex : parsed.index,
                    includeSvg: parsed.includeSvg !== false,
                    raw: parsed
                }
            };
        }
        if (type === 'inspect_costume' || type === 'view_costume' || type === 'read_costume_image') {
            return {
                ok: true,
                tool: {
                    type: 'inspect_costume',
                    targetId: String(parsed.targetRef || parsed.targetId || parsed.target || parsed.targetName || '').trim(),
                    costumeName: String(parsed.costumeName || parsed.backdropName || parsed.name || '').trim(),
                    costumeIndex: parsed.costumeIndex != null ? parsed.costumeIndex : parsed.index,
                    raw: parsed
                }
            };
        }
        if (
            type === 'get_stage_snapshot' ||
            type === 'get_stage_screenshot' ||
            type === 'get_player_screenshot' ||
            type === 'inspect_stage'
        ) {
            return {ok: true, tool: {type: 'get_stage_snapshot', raw: parsed}};
        }
        if (type === 'list_extensions' || type === 'get_extensions' || type === 'get_extension_list') {
            return {
                ok: true,
                tool: {
                    type: 'list_extensions',
                    query: String(parsed.query || parsed.keyword || parsed.search || '').trim(),
                    source: String(parsed.source || parsed.provider || '').trim(),
                    includeRemote: parsed.includeRemote !== false,
                    limit: parsed.limit || parsed.maxResults,
                    raw: parsed
                }
            };
        }
        if (type === 'load_extension' || type === 'enable_extension' || type === 'add_extension') {
            const extensionId = String(parsed.extensionId || parsed.id || parsed.name || parsed.extension || '').trim();
            const extensionUrl = String(parsed.extensionUrl || parsed.url || parsed.extensionURL || '').trim();
            const slug = String(parsed.slug || parsed.turbowarpSlug || parsed.twSlug || '').trim();
            if (!extensionId && !extensionUrl && !slug) return {ok: false, error: 'load_extension 动作缺少 extensionId、slug 或 url。'};
            return {
                ok: true,
                tool: {
                    type: 'load_extension',
                    extensionId,
                    url: extensionUrl,
                    slug,
                    raw: parsed
                }
            };
        }
        if (
            type === 'get_extension_blocks' ||
            type === 'get_extension_opcodes' ||
            type === 'get_extension_block_info'
        ) {
            return {
                ok: true,
                tool: {
                    type: 'get_extension_blocks',
                    extensionId: String(parsed.extensionId || parsed.id || parsed.name || parsed.extension || '').trim(),
                    query: String(parsed.query || parsed.keyword || parsed.search || '').trim(),
                    limit: parsed.limit || parsed.maxResults,
                    raw: parsed
                }
            };
        }
        if (type === 'get_pseudocode' && (targetIds.length || lineRanges.some(range => range.targetId))) {
            return {ok: true, tool: {type: 'get_pseudocode', targetIds, lineRanges}};
        }
        if (type === 'search_text' || type === 'find_text' || type === 'search_pseudocode') {
            const query = String(parsed.query || parsed.text || parsed.pattern || parsed.keyword || '').trim();
            if (!query) return {ok: false, error: 'AI 查找工具缺少 query。'};
            return {
                ok: true,
                tool: {
                    type: 'search_text',
                    query,
                    targetIds,
                    caseSensitive: !!parsed.caseSensitive,
                    regex: !!parsed.regex,
                    maxResults: parsed.maxResults || parsed.limit
                }
            };
        }
        if (
            type === 'create_sprite' ||
            type === 'delete_sprite' ||
            type === 'create_costume' ||
            type === 'delete_costume' ||
            type === 'create_svg_costume' ||
            type === 'replace_svg_costume' ||
            type === 'create_bitmap_costume' ||
            type === 'replace_bitmap_costume'
        ) {
            return {
                ok: true,
                tool: {
                    type,
                    targetId: String(parsed.targetRef || parsed.targetId || parsed.target || parsed.targetName || '').trim(),
                    name: String(parsed.name || parsed.spriteName || parsed.costumeName || parsed.backdropName || '').trim(),
                    costumeName: String(parsed.costumeName || parsed.backdropName || parsed.name || '').trim(),
                    costumeIndex: parsed.costumeIndex != null ? parsed.costumeIndex : parsed.index,
                    newName: String(parsed.newName || parsed.newCostumeName || parsed.newBackdropName || '').trim(),
                    svg: String(parsed.svg || parsed.svgText || parsed.content || '').trim(),
                    imageData: String(
                        parsed.imageData || parsed.dataUrl || parsed.bitmapData || parsed.base64 || parsed.content || ''
                    ).trim(),
                    mimeType: String(parsed.mimeType || parsed.mediaType || parsed.contentType || '').trim().toLowerCase(),
                    rotationCenterX: parsed.rotationCenterX,
                    rotationCenterY: parsed.rotationCenterY,
                    confirm: parsed.confirm === true,
                    raw: parsed
                }
            };
        }
        return {ok: false, error: 'AI 工具块必须是 click_green_flag、click_pause、click_stop、get_pseudocode、get_target_info、get_costume_info、search_text、list_extensions、load_extension、get_extension_blocks、造型工具或项目结构工具。'};
    };
    const isAiEditActionType = type => [
        'edit_pseudocode',
        'edit',
        'apply_edit',
        'apply_pseudocode',
        'modify_pseudocode',
        'replace_pseudocode'
    ].indexOf(type) >= 0;
    const normalizeAiSingleActionPayload = parsed => {
        const payload = normalizeAiCallablePayload(parsed);
        const type = normalizeAiCallableTypeName(payload && (payload.type || payload.action || payload.toolType));
        if (isAiEditActionType(type) || (payload && (typeof payload.pseudocode === 'string' || Array.isArray(payload.edits)))) {
            if (!payload || (typeof payload.pseudocode !== 'string' && !Array.isArray(payload.edits))) {
                return {ok: false, error: 'edit_pseudocode 动作缺少 pseudocode 或 edits 字段。'};
            }
            return {ok: true, action: {kind: 'edit', type: 'edit_pseudocode', edit: payload}};
        }
        const normalized = normalizeAiSingleToolPayload(payload);
        if (!normalized.ok) return normalized;
        return {ok: true, action: {kind: 'tool', type: normalized.tool.type, tool: normalized.tool}};
    };
    const normalizeAiActionPayload = parsed => {
        const payload = normalizeAiCallablePayload(parsed);
        const rawActions = Array.isArray(payload)
            ? payload
            : (Array.isArray(payload && payload.calls)
                ? payload.calls
                : (Array.isArray(payload && payload.tools)
                    ? payload.tools
                    : (Array.isArray(payload && payload.toolCalls)
                        ? payload.toolCalls
                        : (Array.isArray(payload && payload.actions) ? payload.actions : null))));
        const actionItems = rawActions || [payload];
        if (!actionItems.length) return {ok: false, error: 'AI 动作列表为空。'};
        if (actionItems.length > AI_MAX_TOOL_CALLS_PER_BATCH) {
            return {
                ok: false,
                error: `AI 单次最多可以批量执行 ${AI_MAX_TOOL_CALLS_PER_BATCH} 个动作。`
            };
        }
        const actions = [];
        for (let i = 0; i < actionItems.length; i++) {
            const normalized = normalizeAiSingleActionPayload(actionItems[i]);
            if (!normalized.ok) {
                return {ok: false, error: `第 ${i + 1} 个动作无效：${normalized.error}`};
            }
            actions.push(normalized.action);
        }
        return {ok: true, actions};
    };
    const buildAiHiddenActionResult = (visibleText, actions) => {
        const actionList = Array.isArray(actions) ? actions : [];
        const tools = actionList
            .filter(item => item && item.kind === 'tool' && item.tool)
            .map(item => item.tool);
        const editAction = actionList.find(item => item && item.kind === 'edit' && item.edit);
        const legacyAction = actionList.length === 1 && editAction
            ? {type: 'edit', edit: editAction.edit, actions: actionList}
            : (actionList.length && tools.length === actionList.length
                ? {type: 'tool', tool: tools[0] || null, tools, actions: actionList}
                : {type: 'actions', actions: actionList});
        return {
            visibleText,
            action: legacyAction,
            actions: actionList,
            tool: tools[0] || null,
            tools,
            edit: editAction ? editAction.edit : null,
            error: null
        };
    };
    const normalizeAiToolPayload = parsed => {
        const rawTools = Array.isArray(parsed)
            ? parsed
            : (Array.isArray(parsed && parsed.tools)
                ? parsed.tools
                : (Array.isArray(parsed && parsed.toolCalls)
                    ? parsed.toolCalls
                    : (Array.isArray(parsed && parsed.calls)
                        ? parsed.calls
                        : (Array.isArray(parsed && parsed.actions) ? parsed.actions : null))));
        if (rawTools) {
            if (!rawTools.length) return {ok: false, error: 'AI 批量工具列表为空。'};
            if (rawTools.length > AI_MAX_TOOL_CALLS_PER_BATCH) {
                return {
                    ok: false,
                    error: `AI 单次最多可以批量调用 ${AI_MAX_TOOL_CALLS_PER_BATCH} 个工具。`
                };
            }
            const tools = [];
            for (let i = 0; i < rawTools.length; i++) {
                const normalized = normalizeAiSingleToolPayload(rawTools[i]);
                if (!normalized.ok) {
                    return {ok: false, error: `第 ${i + 1} 个工具无效：${normalized.error}`};
                }
                tools.push(normalized.tool);
            }
            return {ok: true, tools};
        }
        if (parsed && parsed.tool && typeof parsed.tool === 'object') {
            const normalized = normalizeAiSingleToolPayload(parsed.tool);
            return normalized.ok ? {ok: true, tools: [normalized.tool]} : normalized;
        }
        const normalized = normalizeAiSingleToolPayload(parsed);
        return normalized.ok ? {ok: true, tools: [normalized.tool]} : normalized;
    };
    const parseHiddenAction = text => {
        const raw = String(text || '');
        let token = null;
        let openIndex = -1;
        for (const candidate of AI_HIDDEN_TOKENS) {
            const idx = raw.indexOf(candidate.open);
            if (idx < 0) continue;
            if (openIndex < 0 || idx < openIndex) {
                openIndex = idx;
                token = candidate;
            }
        }
        if (!token) {
            return {visibleText: raw.trim(), action: null, tool: null, tools: null, edit: null, error: null};
        }
        const closeIndex = raw.indexOf(token.close, openIndex + token.open.length);
        const visibleText = raw.slice(0, openIndex).trim();
        const parseHiddenPayload = clean => {
            const parsed = token.type === 'provider_tool'
                ? parseAiProviderToolPayload(clean)
                : JSON.parse(clean);
            if (token.type === 'action' || token.type === 'provider_tool') {
                const normalized = normalizeAiActionPayload(parsed);
                if (!normalized.ok) {
                    return {visibleText, action: null, tool: null, tools: null, edit: null, error: normalized.error};
                }
                return buildAiHiddenActionResult(visibleText, normalized.actions);
            }
            if (token.type === 'tool') {
                const normalized = normalizeAiToolPayload(parsed);
                if (!normalized.ok) {
                    return {visibleText, action: null, tool: null, tools: null, edit: null, error: normalized.error};
                }
                return buildAiHiddenActionResult(
                    visibleText,
                    normalized.tools.map(tool => ({kind: 'tool', type: tool.type, tool}))
                );
            }
            if (parsed && (typeof parsed.pseudocode === 'string' || Array.isArray(parsed.edits))) {
                return buildAiHiddenActionResult(
                    visibleText,
                    [{kind: 'edit', type: 'edit_pseudocode', edit: parsed}]
                );
            }
            return {visibleText, action: null, tool: null, tools: null, edit: null, error: 'AI 修改块缺少 pseudocode 或 edits 字段。'};
        };
        if (closeIndex < 0) {
            const cleanTail = stripCodeFence(raw.slice(openIndex + token.open.length).trim());
            if (cleanTail) {
                try {
                    const parsedTail = parseHiddenPayload(cleanTail);
                    if (!parsedTail.error) return {...parsedTail, missingCloseAccepted: true};
                    return parsedTail;
                } catch (_) {
                    // fall through to the clearer "missing close" error below
                }
            }
            return {
                visibleText,
                action: null,
                tool: null,
                tools: null,
                edit: null,
                error: `${getAiHiddenTokenLabel(token)}没有结束。`
            };
        }
        const clean = stripCodeFence(raw.slice(openIndex + token.open.length, closeIndex).trim());
        try {
            return parseHiddenPayload(clean);
        } catch (err) {
            const label = getAiHiddenTokenLabel(token);
            return {visibleText, action: null, tool: null, tools: null, edit: null, error: `${label}不是合法 JSON: ${err.message}`};
        }
    };
    const extractAiContent = data => {
        if (!data) return '';
        if (typeof data.pseudocode === 'string') return JSON.stringify(data);
        if (typeof data.output_text === 'string') return data.output_text;
        const choice = data.choices && data.choices[0];
        if (choice && choice.message) {
            const content = choice.message.content;
            if (typeof content === 'string') return content;
            if (Array.isArray(content)) {
                return content.map(part => part && (part.text || part.content || '')).join('\n');
            }
        }
        if (Array.isArray(data.output)) {
            return data.output.map(item => {
                if (!item || !Array.isArray(item.content)) return '';
                return item.content.map(part => part && (part.text || part.output_text || '')).join('\n');
            }).join('\n');
        }
        return '';
    };
    const normalizeAiReasoningValue = value => {
        if (!value) return '';
        if (typeof value === 'string') return value;
        if (Array.isArray(value)) {
            return value.map(part => {
                if (!part) return '';
                if (typeof part === 'string') return part;
                return part.text || part.content || part.reasoning_content || part.reasoning || '';
            }).join('\n');
        }
        if (typeof value === 'object') {
            return value.text || value.content || value.reasoning_content || value.reasoning || '';
        }
        return '';
    };
    const extractAiReasoningContent = data => {
        if (!data) return '';
        const direct = normalizeAiReasoningValue(data.reasoning_content || data.reasoning || data.reasoning_text);
        if (direct) return direct;
        const choice = data.choices && data.choices[0];
        if (choice && choice.message) {
            const message = choice.message;
            const reasoning = normalizeAiReasoningValue(
                message.reasoning_content || message.reasoning || message.reasoning_text
            );
            if (reasoning) return reasoning;
        }
        if (Array.isArray(data.output)) {
            return data.output.map(item => {
                if (!item) return '';
                if (/reason/i.test(String(item.type || ''))) {
                    return normalizeAiReasoningValue(item.content || item.text || item.summary);
                }
                if (!Array.isArray(item.content)) return '';
                return item.content.map(part => {
                    if (!part || !/reason/i.test(String(part.type || ''))) return '';
                    return normalizeAiReasoningValue(part.text || part.content || part.summary);
                }).join('\n');
            }).filter(Boolean).join('\n');
        }
        return '';
    };
    const extractAiDeltaContent = data => {
        if (!data) return '';
        const choice = data.choices && data.choices[0];
        if (choice) {
            if (choice.delta) {
                const content = choice.delta.content;
                if (typeof content === 'string') return content;
                if (Array.isArray(content)) {
                    return content.map(part => part && (part.text || part.content || '')).join('');
                }
            }
            if (typeof choice.text === 'string') return choice.text;
            if (choice.message) return extractAiContent({choices: [choice]});
        }
        if (typeof data.delta === 'string') return data.delta;
        if (typeof data.content === 'string') return data.content;
        return '';
    };
    const extractAiDeltaReasoning = data => {
        if (!data) return '';
        const direct = normalizeAiReasoningValue(data.reasoning_content || data.reasoning || data.reasoning_text);
        if (direct) return direct;
        if (/reason/i.test(String(data.type || ''))) {
            const eventReasoning = normalizeAiReasoningValue(data.delta || data.text || data.content || data.summary);
            if (eventReasoning) return eventReasoning;
        }
        const choice = data.choices && data.choices[0];
        if (choice && choice.delta) {
            return normalizeAiReasoningValue(
                choice.delta.reasoning_content || choice.delta.reasoning || choice.delta.reasoning_text
            );
        }
        return '';
    };
    const getSuffixMatchLength = (text, token) => {
        const s = String(text || '');
        const max = Math.min(token.length - 1, s.length);
        for (let len = max; len > 0; len--) {
            if (token.startsWith(s.slice(-len))) return len;
        }
        return 0;
    };
    const getHiddenActionOpen = text => {
        let found = null;
        for (const token of AI_HIDDEN_TOKENS) {
            const index = text.indexOf(token.open);
            if (index < 0) continue;
            if (!found || index < found.index) found = {...token, index};
        }
        return found;
    };
    const getHiddenOpenSuffixLength = text => {
        let best = 0;
        for (const token of AI_HIDDEN_TOKENS) {
            best = Math.max(best, getSuffixMatchLength(text, token.open));
        }
        return best;
    };
    class AiResponseProcessor {
        constructor (onVisibleDelta, onHiddenStart, onReasoningDelta, onHiddenEnd) {
            this.onVisibleDelta = onVisibleDelta;
            this.onHiddenStart = onHiddenStart;
            this.onReasoningDelta = onReasoningDelta;
            this.onHiddenEnd = onHiddenEnd;
            this.raw = '';
            this.visibleSent = 0;
            this.hiddenStarted = false;
            this.hiddenClosed = false;
            this.hiddenType = null;
            this.buffer = '';
            this.inThink = false;
        }
        emitVisible (delta) {
            if (delta && this.onVisibleDelta) this.onVisibleDelta(delta);
        }
        appendVisible (chunk) {
            if (!chunk) return;
            this.raw += chunk;
            const hidden = getHiddenActionOpen(this.raw);
            if (hidden && !this.hiddenStarted) {
                this.hiddenStarted = true;
                this.hiddenType = hidden.type;
                if (this.onHiddenStart) this.onHiddenStart(hidden.type);
            }
            if (hidden && this.hiddenStarted && !this.hiddenClosed) {
                const closeIndex = this.raw.indexOf(hidden.close, hidden.index + hidden.open.length);
                if (closeIndex >= 0) {
                    this.hiddenClosed = true;
                    if (this.onHiddenEnd) this.onHiddenEnd(hidden.type, true);
                }
            }
            const visibleEnd = hidden
                ? hidden.index
                : this.raw.length - getHiddenOpenSuffixLength(this.raw);
            if (visibleEnd > this.visibleSent) {
                this.emitVisible(this.raw.slice(this.visibleSent, visibleEnd));
                this.visibleSent = visibleEnd;
            }
        }
        appendReasoning (text) {
            if (text && this.onReasoningDelta) this.onReasoningDelta(text);
        }
        append (chunk) {
            if (!chunk) return;
            this.buffer += chunk;
            while (this.buffer) {
                if (this.inThink) {
                    const closeIndex = this.buffer.indexOf(AI_THINK_CLOSE);
                    if (closeIndex >= 0) {
                        this.appendReasoning(this.buffer.slice(0, closeIndex));
                        this.buffer = this.buffer.slice(closeIndex + AI_THINK_CLOSE.length);
                        this.inThink = false;
                        continue;
                    }
                    const safeEnd = this.buffer.length - getSuffixMatchLength(this.buffer, AI_THINK_CLOSE);
                    if (safeEnd > 0) {
                        this.appendReasoning(this.buffer.slice(0, safeEnd));
                        this.buffer = this.buffer.slice(safeEnd);
                    }
                    break;
                }
                const openIndex = this.buffer.indexOf(AI_THINK_OPEN);
                if (openIndex >= 0) {
                    this.appendVisible(this.buffer.slice(0, openIndex));
                    this.buffer = this.buffer.slice(openIndex + AI_THINK_OPEN.length);
                    this.inThink = true;
                    continue;
                }
                const safeEnd = this.buffer.length - getSuffixMatchLength(this.buffer, AI_THINK_OPEN);
                if (safeEnd > 0) {
                    this.appendVisible(this.buffer.slice(0, safeEnd));
                    this.buffer = this.buffer.slice(safeEnd);
                }
                break;
            }
        }
        finish () {
            if (this.buffer) {
                if (this.inThink) this.appendReasoning(this.buffer);
                else this.appendVisible(this.buffer);
                this.buffer = '';
            }
            if (!this.hiddenStarted && this.visibleSent < this.raw.length) {
                this.emitVisible(this.raw.slice(this.visibleSent));
                this.visibleSent = this.raw.length;
            }
            if (this.hiddenStarted && !this.hiddenClosed && this.onHiddenEnd) {
                this.onHiddenEnd(this.hiddenType, false);
            }
            const action = parseHiddenAction(this.raw);
            return {
                raw: this.raw,
                visibleText: action.visibleText,
                hiddenType: this.hiddenType,
                hiddenClosed: this.hiddenClosed,
                action
            };
        }
        getRaw () {
            return this.raw;
        }
    }
    const isAiRetryableHttpStatus = status => (
        status === 408 ||
        status === 409 ||
        status === 425 ||
        status === 429 ||
        status >= 500
    );
    const createAiHttpError = (response, message) => {
        const err = new Error(message || `HTTP ${response.status}`);
        err.status = response.status;
        err.statusText = response.statusText || '';
        err.retryable = isAiRetryableHttpStatus(response.status);
        return err;
    };
    const getAiHttpError = async response => {
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { /* use text */ }
        const message = data && data.error && data.error.message ? data.error.message : text;
        return createAiHttpError(response, message);
    };
    const isAiRetryableRequestError = err => {
        if (!err || err.name === 'AbortError') return false;
        if (err.partialContent && String(err.partialContent).length) return false;
        if (typeof err.status === 'number') return err.retryable === true;
        return true;
    };
    const getAiRetryDelay = retryIndex => {
        const delay = AI_REQUEST_RETRY_BASE_DELAY * Math.pow(2, Math.max(0, retryIndex));
        return Math.min(AI_REQUEST_RETRY_MAX_DELAY, delay) + Math.floor(Math.random() * 250);
    };
    const waitAiRetryDelay = (delay, signal) => new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
            return;
        }
        let timer = null;
        const onAbort = () => {
            if (timer) clearTimeout(timer);
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
        };
        timer = setTimeout(() => {
            if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort);
            resolve();
        }, delay);
        if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort, {once: true});
    });
    const withAiRequestRetry = async (config, signal, request, onRetry) => {
        const maxRetries = isAiRequestRetryEnabled(config)
            ? normalizeAiRequestRetryCount(config.requestRetryCount)
            : 0;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await request(attempt);
            } catch (err) {
                if (err && err.name === 'AbortError') throw err;
                if (attempt >= maxRetries || !isAiRetryableRequestError(err)) throw err;
                const delay = getAiRetryDelay(attempt);
                if (typeof onRetry === 'function') {
                    onRetry({
                        attempt: attempt + 1,
                        maxRetries,
                        delay,
                        error: err
                    });
                }
                await waitAiRetryDelay(delay, signal);
            }
        }
        throw new Error('AI request failed');
    };
    const requestAiTextNonStreaming = async (config, messages, signal, onVisibleDelta, onHiddenStart, onReasoningDelta, onHiddenEnd) => {
        const headers = {'Content-Type': 'application/json'};
        if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
        const processor = new AiResponseProcessor(onVisibleDelta, onHiddenStart, onReasoningDelta, onHiddenEnd);
        const response = await fetch(normalizeAiEndpoint(config.endpoint), {
            method: 'POST',
            headers,
            signal,
            body: JSON.stringify({
                model: config.model,
                messages,
                temperature: 1
            })
        });
        if (!response.ok) throw await getAiHttpError(response);
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { /* use text */ }
        const reasoning = extractAiReasoningContent(data);
        if (reasoning) processor.appendReasoning(reasoning);
        const content = extractAiContent(data) || text;
        if (!content) throw new Error('AI response is empty');
        processor.append(content);
        return processor.finish();
    };
    const requestAiTextStreaming = async (config, messages, signal, onVisibleDelta, onHiddenStart, onReasoningDelta, onHiddenEnd) => {
        const headers = {'Content-Type': 'application/json'};
        if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
        const response = await fetch(normalizeAiEndpoint(config.endpoint), {
            method: 'POST',
            headers,
            signal,
            body: JSON.stringify({
                model: config.model,
                messages,
                temperature: 1,
                stream: true
            })
        });
        if (!response.ok) throw await getAiHttpError(response);
        if (!response.body || typeof response.body.getReader !== 'function') {
            return requestAiTextNonStreaming(config, messages, signal, onVisibleDelta, onHiddenStart, onReasoningDelta, onHiddenEnd);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const processor = new AiResponseProcessor(onVisibleDelta, onHiddenStart, onReasoningDelta, onHiddenEnd);
        let eventBuffer = '';
        let wireText = '';
        let sawSseData = false;
        const findEventBoundary = text => {
            const lf = text.indexOf('\n\n');
            const crlf = text.indexOf('\r\n\r\n');
            if (lf < 0) return crlf < 0 ? null : {index: crlf, length: 4};
            if (crlf < 0) return {index: lf, length: 2};
            return lf < crlf ? {index: lf, length: 2} : {index: crlf, length: 4};
        };
        const processEvent = eventText => {
            const lines = eventText.split(/\r?\n/);
            const dataLines = lines
                .filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trimStart());
            if (!dataLines.length) return;
            const payload = dataLines.join('\n').trim();
            if (!payload) return;
            sawSseData = true;
            if (payload === '[DONE]') return;
            let parsed;
            try {
                parsed = JSON.parse(payload);
            } catch (err) {
                const e = new Error(`无法解析流式响应: ${err.message}`);
                e.partialContent = processor.getRaw();
                throw e;
            }
            const reasoningDelta = extractAiDeltaReasoning(parsed);
            if (reasoningDelta) processor.appendReasoning(reasoningDelta);
            processor.append(extractAiDeltaContent(parsed));
        };

        try {
            while (true) {
                const {done, value} = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, {stream: true});
                wireText += chunk;
                eventBuffer += chunk;
                let boundary = findEventBoundary(eventBuffer);
                while (boundary) {
                    const eventText = eventBuffer.slice(0, boundary.index);
                    eventBuffer = eventBuffer.slice(boundary.index + boundary.length);
                    processEvent(eventText);
                    boundary = findEventBoundary(eventBuffer);
                }
            }
            const tail = decoder.decode();
            if (tail) {
                wireText += tail;
                eventBuffer += tail;
            }
            if (eventBuffer.trim()) processEvent(eventBuffer);
        } catch (err) {
            if (err && err.name === 'AbortError') throw err;
            if (!err.partialContent) err.partialContent = processor.getRaw();
            throw err;
        } finally {
            try {
                if (reader.releaseLock) reader.releaseLock();
            } catch (_) { /* ignore */ }
        }

        if (!sawSseData) {
            let data = null;
            try { data = wireText ? JSON.parse(wireText) : null; } catch (_) { /* use text */ }
            const reasoning = extractAiReasoningContent(data);
            if (reasoning) processor.appendReasoning(reasoning);
            const content = extractAiContent(data) || wireText;
            if (!content) throw new Error('AI response is empty');
            processor.append(content);
            return processor.finish();
        }
        const result = processor.finish();
        if (!result.raw) throw new Error('AI response is empty');
        return result;
    };
    const requestAiTextOnce = async (config, messages, signal, onVisibleDelta, onHiddenStart, onReasoningDelta, onHiddenEnd) => {
        try {
            return await requestAiTextStreaming(config, messages, signal, onVisibleDelta, onHiddenStart, onReasoningDelta, onHiddenEnd);
        } catch (err) {
            if (err && err.name === 'AbortError') throw err;
            if (err && err.retryable === true) throw err;
            if (err && err.partialContent) throw err;
            console.warn('[json-script-converter] AI stream failed; falling back to non-streaming', err);
            return requestAiTextNonStreaming(config, messages, signal, onVisibleDelta, onHiddenStart, onReasoningDelta, onHiddenEnd);
        }
    };
    const requestAiText = async (config, messages, signal, onVisibleDelta, onHiddenStart, onReasoningDelta, onHiddenEnd, onRetry) => (
        withAiRequestRetry(
            config,
            signal,
            () => requestAiTextOnce(config, messages, signal, onVisibleDelta, onHiddenStart, onReasoningDelta, onHiddenEnd),
            onRetry
        )
    );
    const testAiConfig = async (config, signal) => withAiRequestRetry(config, signal, async () => {
        const headers = {'Content-Type': 'application/json'};
        if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
        const response = await fetch(normalizeAiEndpoint(config.endpoint), {
            method: 'POST',
            headers,
            signal,
            body: JSON.stringify({
                model: config.model,
                messages: [{role: 'user', content: 'Reply with ok.'}],
                temperature: 1,
                max_tokens: 8
            })
        });
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { /* use text */ }
        if (!response.ok) {
            const message = data && data.error && data.error.message ? data.error.message : text;
            throw createAiHttpError(response, message);
        }
        const content = extractAiContent(data) || text;
        if (!content) throw new Error('AI response is empty');
        return true;
    });
    const testAiVisionSupport = async (config, signal) => withAiRequestRetry(config, signal, async () => {
        const headers = {'Content-Type': 'application/json'};
        if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
        const r = 40 + Math.floor(Math.random() * 160);
        const g = 40 + Math.floor(Math.random() * 160);
        const b = 40 + Math.floor(Math.random() * 160);
        const dataUrl = createAiSolidPngDataUrl(r, g, b);
        const response = await fetch(normalizeAiEndpoint(config.endpoint), {
            method: 'POST',
            headers,
            signal,
            body: JSON.stringify({
                model: config.model,
                messages: [{
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'The attached image is a solid color. Reply only as JSON: {"r":number,"g":number,"b":number}.'
                        },
                        {
                            type: 'image_url',
                            image_url: {url: dataUrl}
                        }
                    ]
                }],
                temperature: 1,
                max_tokens: 40
            })
        });
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { /* use text */ }
        if (!response.ok) {
            const message = data && data.error && data.error.message ? data.error.message : text;
            throw createAiHttpError(response, message);
        }
        const content = extractAiContent(data) || text;
        const match = content.match(/\{[\s\S]*\}/);
        if (!match) throw new Error(`模型没有返回可验证的颜色 JSON：${content.slice(0, 80)}`);
        let color;
        try {
            color = JSON.parse(match[0]);
        } catch (err) {
            throw new Error(`模型返回的颜色 JSON 无法解析：${err.message}`);
        }
        const distance = Math.max(
            Math.abs(Number(color.r) - r),
            Math.abs(Number(color.g) - g),
            Math.abs(Number(color.b) - b)
        );
        if (!Number.isFinite(distance) || distance > 20) {
            throw new Error('模型没有正确读取测试图片颜色');
        }
        return true;
    });
    const fetchAiModels = async (config, signal) => withAiRequestRetry(config, signal, async () => {
        const headers = {};
        if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
        const response = await fetch(getModelsEndpoint(config.endpoint), {headers, signal});
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { /* use text */ }
        if (!response.ok) {
            const message = data && data.error && data.error.message ? data.error.message : text;
            throw createAiHttpError(response, message);
        }
        const list = Array.isArray(data && data.data) ? data.data : [];
        const models = list
            .map(normalizeAiModelRecord)
            .filter(Boolean)
            .sort((a, b) => a.id.localeCompare(b.id));
        if (!models.length) throw new Error('模型列表为空');
        return models;
    });

    class JsonScriptConverterModal extends React.Component {
        constructor (props) {
            super(props);
            const storedAiConfig = loadAiConfig();
            const storedAiChats = loadAiChatState();
            const storedUiState = loadUiState();
            const storedMcpBridgeEnabled = loadMcpBridgeEnabled();
            const storedMcpBridgeUrl = loadMcpBridgeUrl();
            const storedEndpointPreview = getAiEndpointPreview(storedAiConfig.endpointInput || storedAiConfig.endpoint || '');
            const activeAiConversation = storedAiChats.conversations.find(
                conversation => conversation.id === storedAiChats.activeConversationId
            );
            // 伪代码比 JSON 友好，默认就用它
            this.state = {
                mode: storedUiState.mode,
                aiChatOpen: storedUiState.aiChatOpen,
                aiBusy: false,
                aiConfigTesting: false,
                aiModelsLoading: false,
                aiConfigReady: hasAiConfig(storedAiConfig),
                aiConfigPanelOpen: !hasAiConfig(storedAiConfig),
                aiModels: [],
                aiModelMenuOpen: false,
                aiModelInputValue: storedAiConfig.model || '',
                aiEndpointPreview: storedEndpointPreview.endpoint,
                aiEndpointPreviewError: storedEndpointPreview.error,
                aiConversations: storedAiChats.conversations,
                aiActiveConversationId: storedAiChats.activeConversationId,
                aiSidebarCollapsed: storedAiChats.sidebarCollapsed,
                aiMessages: activeAiConversation ? activeAiConversation.messages : [],
                aiVisibleMessageLimit: AI_CHAT_RENDER_INITIAL_MESSAGES,
                aiShowProcessLog: false,
                mcpBridgeEnabled: storedMcpBridgeEnabled,
                mcpBridgeUrl: storedMcpBridgeUrl,
                mcpBridgeStatus: storedMcpBridgeEnabled ? 'starting' : 'disabled',
                aiConfig: storedAiConfig
            };
            this.dirty = false;
            // 固定不带坐标；apply 后总是走 cleanUp 自动整理
            this.includeCoords = false;
            this.jsonEditorComponent = React.createRef();
            this.aiEndpointRef = React.createRef();
            this.aiModelRef = React.createRef();
            this.aiApiKeyRef = React.createRef();
            this.aiVisionEnabledRef = React.createRef();
            this.aiToolNoConfirmRef = React.createRef();
            this.aiRequestRetryEnabledRef = React.createRef();
            this.aiRequestRetryCountRef = React.createRef();
            this.mcpBridgeUrlRef = React.createRef();
            this.aiInputRef = React.createRef();
            this.aiMessagesRef = React.createRef();
            this.aiShouldAutoScrollMessages = true;
            this.aiChatPersistTimer = null;
            this.aiPendingConfirmations = new Map();
            this.aiTargetRefs = new Map();
            this.aiTargetRefIds = new Map();
            this.aiNextTargetRefIndex = 0;
            this.aiInputElement = null;
            this.aiAbortController = null;
            this.aiModelsAutoFetchTimer = null;
            this.aiModelsAbortController = null;
            this.aiLastModelsFetchKey = '';
            this.aiLastEndpointInputKey = '';
            this.aiMessagesScrollRAF = null;
            this.aiMessagesScrollTimer = null;
            this.aiLoadingOlderMessages = false;
            this.aiProgrammaticScrollUntil = 0;
            this.aiUserMessageScrollUntil = 0;
            this.aiActiveMessageId = null;
            this.aiUserAborted = false;
            this.aiProcessStartedAt = 0;
            this.aiProcessLines = [];
            this.mcpBridgeClientId = `jsc-page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            this.mcpBridgeTimer = null;
            this.mcpBridgeAbortController = null;
            this.mcpBridgeStopped = true;
            this.mcpBridgeBusy = false;
            this.mcpBridgeLastStatus = storedMcpBridgeEnabled ? 'starting' : 'disabled';
            this.isMountedForMcp = false;
            // 实时同步用的计时器 + 防回环抑制窗口
            this.applyDebounceTimer = null;
            this.regenDebounceTimer = null;
            // 自己 apply 回写 workspace 后，VM 会 emit workspaceUpdate/PROJECT_CHANGED 回声；
            // 在这段时间内忽略从 workspace 往编辑器的回写，否则会把用户刚输入的内容覆盖掉。
            this.suppressRegenUntil = 0;
            // 上一次成功 apply 的 blocks（规范化 JSON 字符串）；用于识别"纯空白/格式变化"——
            // parse 后和这个比，相等就不再做 delete+create+重排，否则每多打一个空格 workspace 都会闪一下。
            this.lastAppliedBlocksJson = '';
            // 伪代码 ↔ 积木区 滚动互跟随：默认开启；只在伪代码模式下实际生效
            this.syncScroll = true;
            // 抑制窗：一侧程序化地滚动另一侧时，另一侧会触发 scroll 事件回传 —— 否则形成死循环。
            // 两个方向各一个时间戳。
            this.suppressEditorScrollUntil = 0;
            this.suppressWsScrollUntil = 0;
            // rAF 句柄 + 上次轮询到的 workspace 滚动状态（工作区没有 scroll 事件，只能 rAF 轮询）
            this.wsPollRAF = null;
            this.lastWsScrollY = 0;
            this.lastWsScrollX = 0;
            this.lastWsScale = 1;
            this.editorTargetId = null;
            this.projectLoading = false;
        }
        componentDidMount () {
            this.isMountedForMcp = true;
            this.syncAiInputKeyListener();
            this.installAiDebugApi();
            if (this.state.mcpBridgeEnabled) {
                this.enableMcpBridgeFromState();
            }
            this.syncUiChrome();
            this.syncAiTitleActions();
            window.addEventListener('beforeunload', this.persistAiChatState);
            window.addEventListener('beforeunload', this.persistUiState);
            if (this.state.aiChatOpen) {
                this.scrollAiMessagesToBottomSoon(true);
                setTimeout(() => {
                    const needsConfig = !this.state.aiConfigReady;
                    if (needsConfig && this.aiEndpointRef.current) {
                        this.aiEndpointRef.current.focus();
                        this.handleAiEndpointInputChange();
                    } else if (this.aiInputRef.current) this.aiInputRef.current.focus();
                }, 0);
            }
        }
        componentDidUpdate () {
            this.syncAiInputKeyListener();
            this.installAiDebugApi();
            this.syncUiChrome();
            this.syncAiTitleActions();
        }
        componentWillUnmount () {
            this.isMountedForMcp = false;
            this.cancelAiPendingConfirmations('组件已关闭，删除操作已取消。', false);
            this.stopMcpBridge();
            this.abortAiRequest(false);
            syncLauncherAiState(false);
            if (this.aiModelsAutoFetchTimer) {
                clearTimeout(this.aiModelsAutoFetchTimer);
                this.aiModelsAutoFetchTimer = null;
            }
            if (this.aiModelsAbortController) {
                this.aiModelsAbortController.abort();
                this.aiModelsAbortController = null;
            }
            if (this.aiMessagesScrollRAF) {
                cancelAnimationFrame(this.aiMessagesScrollRAF);
                this.aiMessagesScrollRAF = null;
            }
            if (this.aiMessagesScrollTimer) {
                clearTimeout(this.aiMessagesScrollTimer);
                this.aiMessagesScrollTimer = null;
            }
            if (this.aiInputElement) {
                this.aiInputElement.removeEventListener('keydown', this.handleAiInputKeyDown, false);
                this.aiInputElement = null;
            }
            if (this.aiChatPersistTimer) {
                clearTimeout(this.aiChatPersistTimer);
                this.aiChatPersistTimer = null;
                this.persistAiChatState();
            }
            this.persistUiState();
            if (window.__jsonScriptConverterAiDebug === this.aiDebugApi) {
                delete window.__jsonScriptConverterAiDebug;
            }
            window.removeEventListener('beforeunload', this.persistAiChatState);
            window.removeEventListener('beforeunload', this.persistUiState);
        }
        persistUiState = () => {
            saveUiState({
                mode: this.state.mode,
                aiChatOpen: this.state.aiChatOpen
            });
        };
        syncUiChrome = () => {
            if (buttonContainer) buttonContainer.style.display = this.state.aiChatOpen ? 'none' : 'flex';
            if (modeToggleButton) {
                modeToggleButton.textContent = this.state.mode === 'json' ? '当前: JSON' : '当前: 伪代码';
            }
            if (aiModifyButton) {
                aiModifyButton.textContent = this.state.aiBusy ? 'AI运行中...' : 'AI修改';
                aiModifyButton.title = this.state.aiBusy ? 'AI 正在后台继续运行，点击查看进度' : '打开 AI 聊天面板';
                aiModifyButton.classList.toggle('is-running', !!this.state.aiBusy);
            }
            syncLauncherAiState(this.state.aiBusy);
            if (typeof updateSyncCheckboxVisibility === 'function') {
                updateSyncCheckboxVisibility(this.state.mode);
            }
        };
        syncAiTitleActions = () => {
            if (!titleAiActions || !titleAiConfigButton || !titleAiCloseButton) return;
            if (!this.state.aiChatOpen) {
                titleAiActions.style.display = 'none';
                return;
            }
            titleAiActions.style.display = 'flex';
            const showConfig = this.state.aiConfigPanelOpen || !this.state.aiConfigReady;
            if (showConfig && !this.state.aiConfigReady) {
                titleAiConfigButton.style.display = 'none';
            } else {
                titleAiConfigButton.style.display = 'flex';
                if (showConfig) {
                    titleAiConfigButton.textContent = '返回聊天';
                    titleAiConfigButton.title = '返回聊天';
                } else {
                    titleAiConfigButton.textContent = '⚙';
                    titleAiConfigButton.title = '设置 AI 接口';
                }
            }
            titleAiCloseButton.style.display = 'flex';
            titleAiCloseButton.textContent = this.state.aiBusy ? '收起 AI' : '关闭 AI';
            titleAiCloseButton.title = this.state.aiBusy ? '收起 AI 面板，AI 会继续运行' : '关闭 AI';
        };
        handleAiTitleConfigAction = () => {
            const showConfig = this.state.aiConfigPanelOpen || !this.state.aiConfigReady;
            if (showConfig && this.state.aiConfigReady) {
                this.setState({aiConfigPanelOpen: false}, () => {
                    if (this.aiInputRef.current) this.aiInputRef.current.focus();
                });
                return;
            }
            this.openAiConfigPanel();
        };
        installAiDebugApi = () => {
            if (this.aiDebugApi) {
                window.__jsonScriptConverterAiDebug = this.aiDebugApi;
                return;
            }
            this.aiDebugApi = {
                listTargets: () => this.getAiTargetSummaries(),
                getTargetPseudocode: (targetIdOrName, options) => {
                    const resolved = this.resolveAiTarget(targetIdOrName);
                    if (!resolved.target) return {ok: false, error: resolved.error};
                    try {
                        const editor = this.jsonEditorComponent.current;
                        const currentText = editor ? editor.getText() || '' : '';
                        const pseudocode = this.getTargetPseudocode(resolved.target, currentText);
                        const lineRanges = normalizeAiToolLineRanges(options || {});
                        if (lineRanges.length) {
                            const snippets = [];
                            for (const range of lineRanges) {
                                const snippet = getAiPseudocodeLineSlice(pseudocode, range);
                                if (!snippet.ok) return {ok: false, error: snippet.error};
                                snippets.push({
                                    ...this.getAiTargetSummary(resolved.target),
                                    startLine: snippet.startLine,
                                    endLine: snippet.endLine,
                                    totalLines: snippet.totalLines,
                                    pseudocode: snippet.pseudocode,
                                    lines: snippet.lines
                                });
                            }
                            return {ok: true, target: this.getAiTargetSummary(resolved.target), snippets};
                        }
                        return {
                            ok: true,
                            target: this.getAiTargetSummary(resolved.target),
                            pseudocode
                        };
                    } catch (err) {
                        return {ok: false, error: err.message};
                    }
                },
                getProjectAiContext: () => {
                    const target = vm.editingTarget;
                    const editor = this.jsonEditorComponent.current;
                    const currentText = editor ? editor.getText() || '' : '';
                    return getAiProjectContext(
                        target,
                        vm,
                        currentText,
                        item => this.getAiTargetSummary(item, {includeCostumes: false})
                    );
                },
                searchText: (query, targetIdsOrNames, options) => {
                    let opts = options || {};
                    let targetIds = [];
                    if (Array.isArray(targetIdsOrNames)) {
                        targetIds = targetIdsOrNames;
                    } else if (targetIdsOrNames && typeof targetIdsOrNames === 'object') {
                        opts = targetIdsOrNames;
                    } else if (targetIdsOrNames) {
                        targetIds = [targetIdsOrNames];
                    }
                    if (!targetIds.length) targetIds = normalizeAiToolTargetIds(opts);
                    const target = vm.editingTarget;
                    const editor = this.jsonEditorComponent.current;
                    const currentText = editor ? editor.getText() || '' : '';
                    const known = new Map();
                    if (target) known.set(target.id, currentText || this.getTargetPseudocode(target));
                    return this.executeAiTool({
                        type: 'search_text',
                        query,
                        targetIds: targetIds.length ? targetIds : opts.targetIds,
                        caseSensitive: !!opts.caseSensitive,
                        regex: !!opts.regex,
                        maxResults: opts.maxResults || opts.limit
                    }, known, currentText, null);
                },
                testVisionSupport: async () => {
                    const config = this.state.aiConfig || {};
                    if (!hasAiConfig(config)) return {ok: false, error: '请先配置 AI endpoint 和 model'};
                    try {
                        await testAiVisionSupport(config);
                        return {ok: true};
                    } catch (err) {
                        return {ok: false, error: err.message};
                    }
                },
                getCostumeInfo: async (targetIdOrName, costumeNameOrIndex, options) => {
                    const resolved = this.resolveAiTarget(targetIdOrName || (vm.editingTarget && vm.editingTarget.id));
                    if (!resolved.target) return {ok: false, error: resolved.error};
                    const opts = options || {};
                    const tool = {
                        type: 'get_costume_info',
                        costumeName: typeof costumeNameOrIndex === 'string' ? costumeNameOrIndex : '',
                        costumeIndex: typeof costumeNameOrIndex === 'number' ? costumeNameOrIndex : opts.costumeIndex,
                        includeSvg: opts.includeSvg !== false,
                        raw: {
                            costumeName: typeof costumeNameOrIndex === 'string' ? costumeNameOrIndex : '',
                            costumeIndex: typeof costumeNameOrIndex === 'number' ? costumeNameOrIndex : opts.costumeIndex
                        }
                    };
                    return this.getAiCostumeInfo(resolved.target, tool);
                },
                inspectCostume: async (targetIdOrName, costumeNameOrIndex) => {
                    const resolved = this.resolveAiTarget(targetIdOrName || (vm.editingTarget && vm.editingTarget.id));
                    if (!resolved.target) return {ok: false, error: resolved.error};
                    return this.inspectAiCostumeImage(resolved.target, {
                        type: 'inspect_costume',
                        costumeName: typeof costumeNameOrIndex === 'string' ? costumeNameOrIndex : '',
                        costumeIndex: typeof costumeNameOrIndex === 'number' ? costumeNameOrIndex : null,
                        raw: {
                            costumeName: typeof costumeNameOrIndex === 'string' ? costumeNameOrIndex : '',
                            costumeIndex: typeof costumeNameOrIndex === 'number' ? costumeNameOrIndex : null
                        }
                    });
                },
                getStageSnapshot: async () => this.getAiStageSnapshot(),
                listExtensions: options => this.listAiExtensions(options || {}),
                loadExtension: async (extensionIdOrUrl, options) => this.loadAiExtension({
                    type: 'load_extension',
                    extensionId: isAiExtensionUrl(extensionIdOrUrl) ? '' : extensionIdOrUrl,
                    url: isAiExtensionUrl(extensionIdOrUrl) ? extensionIdOrUrl : '',
                    slug: options && options.slug
                }),
                getExtensionBlocks: (extensionId, options) => getAiExtensionBlocks(vm, {
                    type: 'get_extension_blocks',
                    extensionId,
                    query: options && options.query,
                    limit: options && options.limit
                }),
                createSvgCostume: async (targetIdOrName, name, svg, options) => {
                    const resolved = this.resolveAiTarget(targetIdOrName || (vm.editingTarget && vm.editingTarget.id));
                    if (!resolved.target) return {ok: false, error: resolved.error};
                    return this.executeAiProjectTool({
                        type: 'create_svg_costume',
                        targetId: this.getAiTargetRef(resolved.target),
                        name,
                        costumeName: name,
                        svg,
                        rotationCenterX: options && options.rotationCenterX,
                        rotationCenterY: options && options.rotationCenterY
                    });
                },
                replaceSvgCostume: async (targetIdOrName, costumeNameOrIndex, svg, options) => {
                    const resolved = this.resolveAiTarget(targetIdOrName || (vm.editingTarget && vm.editingTarget.id));
                    if (!resolved.target) return {ok: false, error: resolved.error};
                    return this.executeAiProjectTool({
                        type: 'replace_svg_costume',
                        targetId: this.getAiTargetRef(resolved.target),
                        costumeName: typeof costumeNameOrIndex === 'string' ? costumeNameOrIndex : '',
                        costumeIndex: typeof costumeNameOrIndex === 'number' ? costumeNameOrIndex : null,
                        newName: options && options.newName,
                        svg,
                        rotationCenterX: options && options.rotationCenterX,
                        rotationCenterY: options && options.rotationCenterY,
                        raw: {
                            costumeName: typeof costumeNameOrIndex === 'string' ? costumeNameOrIndex : '',
                            costumeIndex: typeof costumeNameOrIndex === 'number' ? costumeNameOrIndex : null
                        }
                    });
                },
                createBitmapCostume: async (targetIdOrName, name, imageData, options) => {
                    const resolved = this.resolveAiTarget(targetIdOrName || (vm.editingTarget && vm.editingTarget.id));
                    if (!resolved.target) return {ok: false, error: resolved.error};
                    return this.executeAiProjectTool({
                        type: 'create_bitmap_costume',
                        targetId: this.getAiTargetRef(resolved.target),
                        name,
                        costumeName: name,
                        imageData,
                        mimeType: options && options.mimeType,
                        rotationCenterX: options && options.rotationCenterX,
                        rotationCenterY: options && options.rotationCenterY
                    });
                },
                replaceBitmapCostume: async (targetIdOrName, costumeNameOrIndex, imageData, options) => {
                    const resolved = this.resolveAiTarget(targetIdOrName || (vm.editingTarget && vm.editingTarget.id));
                    if (!resolved.target) return {ok: false, error: resolved.error};
                    return this.executeAiProjectTool({
                        type: 'replace_bitmap_costume',
                        targetId: this.getAiTargetRef(resolved.target),
                        costumeName: typeof costumeNameOrIndex === 'string' ? costumeNameOrIndex : '',
                        costumeIndex: typeof costumeNameOrIndex === 'number' ? costumeNameOrIndex : null,
                        newName: options && options.newName,
                        imageData,
                        mimeType: options && options.mimeType,
                        rotationCenterX: options && options.rotationCenterX,
                        rotationCenterY: options && options.rotationCenterY,
                        raw: {
                            costumeName: typeof costumeNameOrIndex === 'string' ? costumeNameOrIndex : '',
                            costumeIndex: typeof costumeNameOrIndex === 'number' ? costumeNameOrIndex : null
                        }
                    });
                },
                validateTargetPseudocode: (targetIdOrName, text) => {
                    const resolved = this.resolveAiTarget(targetIdOrName);
                    if (!resolved.target) return {ok: false, error: resolved.error};
                    const checked = this.validatePseudoText(text, resolved.target);
                    return checked.ok ? {ok: true} : {ok: false, errors: checked.errors};
                },
                applyTargetPseudocode: (targetIdOrName, text) => {
                    const resolved = this.resolveAiTarget(targetIdOrName);
                    if (!resolved.target) return {ok: false, error: resolved.error};
                    const checked = this.validatePseudoText(text, resolved.target);
                    if (!checked.ok) return {ok: false, errors: checked.errors};
                    const meta = this.createPseudoMeta(checked.result);
                    const result = this.applyAiApplications([{
                        target: resolved.target,
                        targetId: resolved.target.id,
                        targetRef: this.getAiTargetRef(resolved.target),
                        targetName: getAiTargetName(resolved.target),
                        mode: 'replace',
                        patches: [],
                        pseudocode: text,
                        parsed: checked.result,
                        meta
                    }]);
                    return result.ok ? {ok: true, result} : {ok: false, error: result.error};
                },
                applyAiEditPayload: payload => {
                    let parsed = payload;
                    if (typeof payload === 'string') {
                        if (
                            payload.indexOf(AI_ACTION_OPEN) >= 0 ||
                            payload.indexOf(AI_EDIT_OPEN) >= 0 ||
                            payload.indexOf(AI_TOOL_OPEN) >= 0 ||
                            payload.indexOf(AI_PROVIDER_TOOL_OPEN) >= 0
                        ) {
                            const action = parseHiddenAction(payload);
                            if (action.error) return {ok: false, error: action.error};
                            if (!action.edit) return {ok: false, error: '隐藏块不是伪代码修改动作。'};
                            parsed = action.edit;
                        } else {
                            try { parsed = JSON.parse(stripCodeFence(payload)); } catch (err) { return {ok: false, error: err.message}; }
                        }
                    }
                    const target = vm.editingTarget;
                    const editor = this.jsonEditorComponent.current;
                    const known = new Map();
                    if (target) known.set(target.id, editor ? editor.getText() || '' : this.getTargetPseudocode(target));
                    const prepared = this.prepareAiEditPayload(parsed, known);
                    if (!prepared.ok) return {ok: false, error: prepared.error, errors: prepared.errors || null};
                    const result = this.applyAiApplications(prepared.applications);
                    return result.ok ? {ok: true, applications: prepared.applications.map(app => ({
                        targetRef: app.targetRef,
                        targetId: app.targetId,
                        targetName: app.targetName,
                        mode: app.mode
                    }))} : {ok: false, error: result.error};
                },
                applyProjectTool: async payload => {
                    let parsed = payload;
                    let tools = null;
                    if (typeof payload === 'string') {
                        if (
                            payload.indexOf(AI_ACTION_OPEN) >= 0 ||
                            payload.indexOf(AI_TOOL_OPEN) >= 0 ||
                            payload.indexOf(AI_PROVIDER_TOOL_OPEN) >= 0
                        ) {
                            const action = parseHiddenAction(payload);
                            if (action.error) return {ok: false, error: action.error};
                            if (!action.tools || !action.tools.length) return {ok: false, error: '隐藏块不是项目结构工具动作。'};
                            if (action.actions && action.actions.some(item => item && item.kind !== 'tool')) {
                                return {ok: false, error: '项目结构调试接口只能执行工具动作。'};
                            }
                            tools = action.tools;
                        } else {
                            try { parsed = JSON.parse(stripCodeFence(payload)); } catch (err) { return {ok: false, error: err.message}; }
                        }
                    }
                    if (!tools) {
                        const normalized = normalizeAiActionPayload(parsed);
                        if (!normalized.ok) return {ok: false, error: normalized.error};
                        if (normalized.actions.some(action => action.kind !== 'tool')) {
                            return {ok: false, error: '项目结构调试接口只能执行工具动作。'};
                        }
                        tools = normalized.actions.map(action => action.tool);
                    }
                    const results = [];
                    for (const tool of tools) {
                        if (!tool || (
                            tool.type !== 'create_sprite' &&
                            tool.type !== 'delete_sprite' &&
                            tool.type !== 'create_costume' &&
                            tool.type !== 'delete_costume' &&
                            tool.type !== 'create_svg_costume' &&
                            tool.type !== 'replace_svg_costume' &&
                            tool.type !== 'create_bitmap_costume' &&
                            tool.type !== 'replace_bitmap_costume'
                        )) {
                            return {ok: false, error: `不是项目结构工具：${tool && tool.type}`};
                        }
                        const result = await this.executeAiProjectTool(tool);
                        results.push(result);
                        if (!result.ok) return tools.length === 1 ? result : {ok: false, results, error: result.error};
                    }
                    return results.length === 1 ? results[0] : {ok: true, results};
                },
                executeMcpAction: async (name, args) => this.executeExternalMcpAction(name, args || {}),
                getMcpBridgeStatus: () => this.getMcpBridgeStatus(),
                parseHiddenAction: text => parseHiddenAction(text)
            };
            window.__jsonScriptConverterAiDebug = this.aiDebugApi;
        };
        setMcpBridgeStatus = status => {
            this.mcpBridgeLastStatus = status;
            if (this.isMountedForMcp && this.state && this.state.mcpBridgeStatus !== status) {
                this.setState({mcpBridgeStatus: status});
            }
        };

        getMcpBridgeInputUrl = () => {
            const value = this.mcpBridgeUrlRef.current
                ? this.mcpBridgeUrlRef.current.value
                : this.state.mcpBridgeUrl;
            return normalizeMcpBridgeUrl(value);
        };

        startDesktopMcpServer = async () => {
            const desktopMcp = window.fortycodeDesktopMcp;
            if (!desktopMcp || typeof desktopMcp.start !== 'function') return null;
            return desktopMcp.start();
        };

        stopDesktopMcpServer = async () => {
            const desktopMcp = window.fortycodeDesktopMcp;
            if (!desktopMcp || typeof desktopMcp.stop !== 'function') return null;
            return desktopMcp.stop();
        };

        enableMcpBridgeFromState = async () => {
            const bridgeUrl = this.getMcpBridgeInputUrl();
            saveMcpBridgeUrl(bridgeUrl);
            this.setMcpBridgeStatus('starting');
            try {
                const desktopStatus = await this.startDesktopMcpServer();
                if (desktopStatus && desktopStatus.bridgeUrl) {
                    saveMcpBridgeUrl(desktopStatus.bridgeUrl);
                    this.setState({mcpBridgeUrl: desktopStatus.bridgeUrl});
                }
            } catch (err) {
                this.setMcpBridgeStatus(`desktop-start-failed: ${err && err.message ? err.message : String(err)}`);
            }
            this.startMcpBridge();
        };

        handleMcpBridgeEnabledChange = event => {
            const enabled = !!(event && event.target && event.target.checked);
            saveMcpBridgeEnabled(enabled);
            const bridgeUrl = this.getMcpBridgeInputUrl();
            saveMcpBridgeUrl(bridgeUrl);
            this.setState({
                mcpBridgeEnabled: enabled,
                mcpBridgeUrl: bridgeUrl
            }, () => {
                if (enabled) {
                    this.enableMcpBridgeFromState();
                } else {
                    this.stopMcpBridge();
                    this.stopDesktopMcpServer().catch(() => {});
                }
            });
        };

        handleMcpBridgeUrlChange = event => {
            const bridgeUrl = String(event && event.target ? event.target.value : '').trim();
            this.setState({mcpBridgeUrl: bridgeUrl});
        };

        handleMcpBridgeUrlBlur = () => {
            const bridgeUrl = this.getMcpBridgeInputUrl();
            saveMcpBridgeUrl(bridgeUrl);
            this.setState({mcpBridgeUrl: bridgeUrl}, () => {
                if (this.state.mcpBridgeEnabled) {
                    this.stopMcpBridge();
                    this.enableMcpBridgeFromState();
                }
            });
        };

        getMcpBridgeBaseUrl = () => {
            const configured = String(
                window.__JSON_SCRIPT_CONVERTER_MCP_BRIDGE_URL ||
                this.state.mcpBridgeUrl ||
                loadMcpBridgeUrl() ||
                AI_MCP_BRIDGE_DEFAULT_URL
            ).trim();
            return normalizeMcpBridgeUrl(configured);
        };

        getMcpKnownContext = () => {
            const target = vm.editingTarget;
            const editor = this.jsonEditorComponent.current;
            const editorText = editor ? editor.getText() || '' : '';
            const shouldUseEditorText = !!(this.dirty || (container && container.style.display !== 'none'));
            const currentText = target
                ? (shouldUseEditorText ? editorText : this.getTargetPseudocode(target))
                : '';
            const knownTargetTexts = new Map();
            if (target) knownTargetTexts.set(target.id, currentText);
            return {target, currentText, knownTargetTexts};
        };

        getMcpBridgeStatus = () => {
            const editingTarget = vm.editingTarget;
            return {
                ok: true,
                enabled: !!this.state.mcpBridgeEnabled,
                bridgeUrl: this.getMcpBridgeBaseUrl(),
                clientId: this.mcpBridgeClientId,
                status: this.state.mcpBridgeStatus || this.mcpBridgeLastStatus,
                pageTitle: document.title,
                addonVisible: !!(container && container.style.display !== 'none'),
                editingTarget: editingTarget ? this.getAiTargetSummary(editingTarget, {includeCostumes: false}) : null,
                targets: this.getAiTargetSummaries().map(target => ({
                    targetRef: target.targetRef,
                    targetId: target.targetId,
                    targetName: target.targetName,
                    targetType: target.targetType,
                    isStage: !!target.isStage
                }))
            };
        };

        executeExternalMcpEdit = editPayload => {
            const {knownTargetTexts} = this.getMcpKnownContext();
            const prepared = this.prepareAiEditPayload(editPayload, knownTargetTexts);
            if (!prepared.ok) {
                return {
                    ok: false,
                    type: 'edit_pseudocode',
                    error: prepared.error,
                    errors: prepared.errors || null
                };
            }
            const result = this.applyAiApplications(prepared.applications);
            if (!result.ok) return {ok: false, type: 'edit_pseudocode', error: result.error};
            return {
                ok: true,
                type: 'edit_pseudocode',
                loadedExtensions: result.loadedExtensions || [],
                applications: prepared.applications.map(app => ({
                    targetRef: app.targetRef,
                    targetId: app.targetId,
                    targetName: app.targetName,
                    mode: app.mode,
                    patchCount: Array.isArray(app.patches) ? app.patches.length : 0,
                    lineCount: splitAiLines(app.pseudocode).length
                }))
            };
        };

        executeExternalMcpAction = async (name, args) => {
            const toolName = normalizeAiCallableTypeName(name);
            if (toolName === 'jsc_get_status' || toolName === 'get_status' || toolName === 'status') {
                return this.getMcpBridgeStatus();
            }
            let payload;
            const rawArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
            if (toolName === 'jsc_call_action' || toolName === 'call_action') {
                payload = rawArgs.action || rawArgs.payload || rawArgs;
                if (typeof payload === 'string') {
                    const parsed = parseHiddenAction(payload);
                    if (parsed.error) return {ok: false, error: parsed.error};
                    if (parsed.actions && parsed.actions.length) {
                        payload = {type: 'batch', calls: parsed.actions.map(action => action.edit || action.tool)};
                    } else {
                        try { payload = JSON.parse(stripCodeFence(payload)); } catch (err) { return {ok: false, error: err.message}; }
                    }
                }
            } else {
                payload = {
                    ...rawArgs,
                    type: rawArgs.type || toolName
                };
            }

            const normalized = normalizeAiActionPayload(payload);
            if (!normalized.ok) return {ok: false, error: normalized.error};
            const {currentText, knownTargetTexts} = this.getMcpKnownContext();
            const results = [];
            for (const action of normalized.actions) {
                if (action.kind === 'edit') {
                    const result = this.executeExternalMcpEdit(action.edit);
                    results.push(result);
                    if (!result.ok) return normalized.actions.length === 1 ? result : {ok: false, results, error: result.error};
                    continue;
                }
                if (action.kind === 'tool') {
                    const result = await this.executeAiTool(action.tool, knownTargetTexts, currentText, null);
                    results.push(result);
                    if (!result.ok) return normalized.actions.length === 1 ? result : {ok: false, results, error: result.error};
                    continue;
                }
                const error = `不支持的 MCP 动作类型: ${action.kind || action.type || ''}`;
                const result = {ok: false, error};
                results.push(result);
                return normalized.actions.length === 1 ? result : {ok: false, results, error};
            }
            return results.length === 1 ? results[0] : {ok: true, type: 'batch', results};
        };

        postMcpBridgeResult = async (callId, payload) => {
            if (!callId) return;
            const baseUrl = this.getMcpBridgeBaseUrl();
            await fetch(`${baseUrl}/result`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    clientId: this.mcpBridgeClientId,
                    id: callId,
                    ...payload
                })
            });
        };

        handleMcpBridgeCall = async call => {
            if (!call || !call.id) return;
            try {
                const result = await this.executeExternalMcpAction(call.name, call.arguments || {});
                await this.postMcpBridgeResult(call.id, {result});
            } catch (err) {
                await this.postMcpBridgeResult(call.id, {
                    error: err && err.message ? err.message : String(err)
                });
            }
        };

        pollMcpBridge = async () => {
            if (this.mcpBridgeStopped || this.mcpBridgeBusy) return;
            this.mcpBridgeBusy = true;
            let nextDelay = AI_MCP_BRIDGE_IDLE_DELAY;
            const baseUrl = this.getMcpBridgeBaseUrl();
            const controller = new AbortController();
            this.mcpBridgeAbortController = controller;
            try {
                const url = new URL(`${baseUrl}/poll`);
                url.searchParams.set('clientId', this.mcpBridgeClientId);
                url.searchParams.set('title', document.title || '');
                const response = await fetch(url.toString(), {
                    method: 'GET',
                    cache: 'no-store',
                    signal: controller.signal
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                const calls = Array.isArray(data && data.calls) ? data.calls : [];
                this.setMcpBridgeStatus('connected');
                if (calls.length) {
                    nextDelay = AI_MCP_BRIDGE_ACTIVE_DELAY;
                    for (const call of calls) {
                        await this.handleMcpBridgeCall(call);
                    }
                }
            } catch (err) {
                if (!this.mcpBridgeStopped && (!err || err.name !== 'AbortError')) {
                    this.setMcpBridgeStatus('offline');
                    nextDelay = AI_MCP_BRIDGE_ERROR_DELAY;
                }
            } finally {
                if (this.mcpBridgeAbortController === controller) this.mcpBridgeAbortController = null;
                this.mcpBridgeBusy = false;
                if (!this.mcpBridgeStopped) {
                    this.mcpBridgeTimer = setTimeout(this.pollMcpBridge, nextDelay);
                }
            }
        };

        startMcpBridge = () => {
            this.mcpBridgeStopped = false;
            if (this.mcpBridgeTimer) clearTimeout(this.mcpBridgeTimer);
            this.setMcpBridgeStatus('connecting');
            this.mcpBridgeTimer = setTimeout(this.pollMcpBridge, 250);
        };

        stopMcpBridge = () => {
            this.mcpBridgeStopped = true;
            if (this.mcpBridgeTimer) {
                clearTimeout(this.mcpBridgeTimer);
                this.mcpBridgeTimer = null;
            }
            if (this.mcpBridgeAbortController) {
                this.mcpBridgeAbortController.abort();
                this.mcpBridgeAbortController = null;
            }
            this.setMcpBridgeStatus('disabled');
        };

        syncAiInputKeyListener = () => {
            const nextInput = this.aiInputRef.current;
            if (this.aiInputElement === nextInput) return;
            if (this.aiInputElement) {
                this.aiInputElement.removeEventListener('keydown', this.handleAiInputKeyDown, false);
            }
            this.aiInputElement = nextInput || null;
            if (this.aiInputElement) {
                this.aiInputElement.addEventListener('keydown', this.handleAiInputKeyDown, false);
            }
        };
        insertAiInputNewline = () => {
            const input = this.aiInputRef.current;
            if (!input || input.disabled) return;
            const start = input.selectionStart || 0;
            const end = input.selectionEnd || 0;
            const value = input.value || '';
            input.value = `${value.slice(0, start)}\n${value.slice(end)}`;
            const nextPos = start + 1;
            input.setSelectionRange(nextPos, nextPos);
        };
        handleAiInputKeyDown = e => {
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key !== 'Enter') return;
            e.preventDefault();
            e.stopPropagation();
            if (e.ctrlKey || e.metaKey) {
                this.insertAiInputNewline();
                return;
            }
            this.submitAiChat();
        };
        getMode = () => this.state.mode;
        setEditorText = text => {
            this.dirty = false;
            const editor = this.jsonEditorComponent.current;
            if (editor) editor.setText(text);
        };
        setEditorValueFromBlocks = blocksObj => {
            this.editorTargetId = vm.editingTarget ? vm.editingTarget.id : null;
            const remapped = remapBlockIdsForEditor(blocksObj);
            if (this.state.mode === 'json') {
                this.setEditorText(stringifyForEditor(remapped));
            } else {
                try {
                    const target = vm.editingTarget;
                    const text = pseudoConverter.renderPseudocode(remapped, {target, vm}, {includeCoords: this.includeCoords});
                    this.setEditorText(text);
                } catch (err) {
                    console.error('[json-script-converter] render pseudocode failed', err);
                    this.setError(`渲染伪代码失败: ${err.message}`);
                }
            }
        };
        // 用户在编辑器里按键：标记 dirty，debounce 500ms 后尝试静默 apply
        handleJsonChange = () => {
            this.dirty = true;
            if (this.applyDebounceTimer) clearTimeout(this.applyDebounceTimer);
            this.applyDebounceTimer = setTimeout(() => {
                this.applyDebounceTimer = null;
                this.autoApplyFromEditor();
            }, 500);
        };
        cancelPendingApply = () => {
            if (this.applyDebounceTimer) {
                clearTimeout(this.applyDebounceTimer);
                this.applyDebounceTimer = null;
            }
        };
        prepareForExternalWorkspaceReset = () => {
            this.cancelPendingApply();
            if (this.regenDebounceTimer) {
                clearTimeout(this.regenDebounceTimer);
                this.regenDebounceTimer = null;
            }
            this.suppressRegenUntil = 0;
            this.dirty = false;
        };
        prepareForProjectLoad = () => {
            this.prepareForExternalWorkspaceReset();
            this.resetAiTargetRefs();
            this.editorTargetId = null;
            this.lastAppliedBlocksJson = '';
            this.projectLoading = true;
        };
        finishProjectLoad = () => {
            this.prepareForExternalWorkspaceReset();
            this.projectLoading = false;
        };
        setError = errorMessage => {
            setStatus(errorMessage ? `✗ ${errorMessage}` : null, 'error');
        };
        setSuccess = msg => {
            setStatus(msg, 'success');
        };
        setInfo = msg => {
            setStatus(msg, 'info');
        };
        clearError = () => setStatus(null);

        openAiChat = () => {
            if (this.state.mode !== 'pseudo' && !this.state.aiBusy) {
                this.setError('AI 聊天只在伪代码模式下工作。');
                return;
            }
            const needsConfig = !this.state.aiConfigReady;
            buttonContainer.style.display = 'none';
            this.setState({
                aiChatOpen: true,
                aiConfigPanelOpen: needsConfig
            }, () => {
                this.persistUiState();
                this.aiShouldAutoScrollMessages = true;
                this.scrollAiMessagesToBottomSoon(true);
                if (needsConfig && this.aiEndpointRef.current) {
                    this.aiEndpointRef.current.focus();
                    this.handleAiEndpointInputChange();
                } else if (this.aiInputRef.current) this.aiInputRef.current.focus();
            });
        };

        closeAiChat = () => {
            this.setState({aiChatOpen: false}, this.persistUiState);
        };

        openAiConfigPanel = () => {
            this.setState({aiConfigPanelOpen: true}, () => {
                if (this.aiEndpointRef.current) this.aiEndpointRef.current.focus();
                this.handleAiEndpointInputChange();
            });
        };

        readAiConfigFromInputs = () => {
            const endpointInput = this.aiEndpointRef.current ? this.aiEndpointRef.current.value.trim() : '';
            const normalized = endpointInput ? normalizeAiEndpoint(endpointInput) : '';
            const previous = this.state.aiConfig || {};
            const model = this.aiModelRef.current ? this.aiModelRef.current.value.trim() : '';
            const apiKey = this.aiApiKeyRef.current ? this.aiApiKeyRef.current.value.trim() : '';
            const visionEnabled = this.aiVisionEnabledRef.current
                ? !!this.aiVisionEnabledRef.current.checked
                : !!previous.visionEnabled;
            const toolNoConfirm = this.aiToolNoConfirmRef.current
                ? !!this.aiToolNoConfirmRef.current.checked
                : !!previous.toolNoConfirm;
            const requestRetryEnabled = this.aiRequestRetryEnabledRef.current
                ? !!this.aiRequestRetryEnabledRef.current.checked
                : previous.requestRetryEnabled !== false;
            const requestRetryCount = this.aiRequestRetryCountRef.current
                ? normalizeAiRequestRetryCount(this.aiRequestRetryCountRef.current.value)
                : normalizeAiRequestRetryCount(previous.requestRetryCount);
            const matchedModel = findAiModelRecord(this.state.aiModels, model);
            const inferredModel = inferAiModelVisionSupportWithSource(model);
            const inferredModelRecord = {
                visionSupport: inferredModel.support,
                visionSupportSource: inferredModel.source
            };
            const sameVisionTarget = normalized === previous.endpoint &&
                model === previous.model &&
                apiKey === (previous.apiKey || '');
            const modelVisionSupport = matchedModel && matchedModel.visionSupport !== AI_VISION_UNKNOWN
                ? matchedModel.visionSupport
                : (inferredModel.support !== AI_VISION_UNKNOWN
                    ? inferredModel.support
                    : (sameVisionTarget ? getAiVisionSupport(previous) : AI_VISION_UNKNOWN));
            const modelVisionSource = matchedModel && matchedModel.visionSupport !== AI_VISION_UNKNOWN
                ? matchedModel.visionSupportSource
                : (inferredModel.support !== AI_VISION_UNKNOWN
                    ? inferredModel.source
                    : (sameVisionTarget ? String(previous.visionSupportSource || AI_VISION_SOURCE_SAVED) : ''));
            return {
                endpoint: normalized,
                endpointInput,
                model,
                apiKey,
                showProcessLog: false,
                visionEnabled,
                toolNoConfirm,
                requestRetryEnabled,
                requestRetryCount,
                visionSupport: modelVisionSupport,
                visionSupportSource: modelVisionSource,
                visionSupportMessage: matchedModel
                    ? getAiModelVisionSupportMessage(matchedModel)
                    : (inferredModel.support !== AI_VISION_UNKNOWN
                        ? getAiModelVisionSupportMessage(inferredModelRecord)
                        : (sameVisionTarget ? String(previous.visionSupportMessage || '') : ''))
            };
        };

        saveAiConfigFromInputs = () => {
            let config;
            try {
                config = this.readAiConfigFromInputs();
            } catch (err) {
                this.setError(err.message);
                return null;
            }
            if (!config.endpoint || !config.model) {
                this.setError('请先填写 AI endpoint 和 model。');
                return null;
            }
            saveAiConfig(config);
            this.setState({
                aiConfig: config,
                aiConfigReady: true,
                aiConfigPanelOpen: false,
                aiShowProcessLog: false
            }, () => {
                if (this.aiInputRef.current) this.aiInputRef.current.focus();
            });
            this.setSuccess('已保存 AI 配置。');
            return config;
        };

        testAiConfigFromInputs = async () => {
            let config;
            try {
                config = this.readAiConfigFromInputs();
            } catch (err) {
                this.setError(err.message);
                return null;
            }
            if (!config.endpoint || !config.model) {
                this.setError('请先填写 AI endpoint 和 model。');
                return null;
            }
            this.setState({aiConfigTesting: true});
            this.setInfo('正在检测 AI 接口...');
            try {
                await testAiConfig(config);
                this.setState({
                    aiConfig: config,
                    aiConfigReady: true,
                    aiConfigPanelOpen: true,
                    aiShowProcessLog: false
                });
                this.setSuccess('AI 接口可用。');
                return config;
            } catch (err) {
                console.error('[json-script-converter] AI config test failed', err);
                this.setError(`AI 接口检测失败: ${err.message}`);
                return null;
            } finally {
                this.setState({aiConfigTesting: false});
            }
        };

        updateConfigVisionFromModel = (modelId, models) => {
            const previous = this.state.aiConfig || {};
            const matched = findAiModelRecord(models || this.state.aiModels, modelId);
            const inferred = inferAiModelVisionSupportWithSource(modelId);
            const inferredRecord = {
                visionSupport: inferred.support,
                visionSupportSource: inferred.source
            };
            const sameModel = modelId === previous.model;
            const nextConfig = {
                ...previous,
                model: modelId,
                visionSupport: matched
                    ? matched.visionSupport
                    : (inferred.support !== AI_VISION_UNKNOWN
                        ? inferred.support
                        : (sameModel ? getAiVisionSupport(previous) : AI_VISION_UNKNOWN)),
                visionSupportSource: matched
                    ? matched.visionSupportSource
                    : (inferred.support !== AI_VISION_UNKNOWN
                        ? inferred.source
                        : (sameModel ? String(previous.visionSupportSource || AI_VISION_SOURCE_SAVED) : '')),
                visionSupportMessage: matched
                    ? getAiModelVisionSupportMessage(matched)
                    : (inferred.support !== AI_VISION_UNKNOWN
                        ? getAiModelVisionSupportMessage(inferredRecord)
                        : (sameModel ? String(previous.visionSupportMessage || '') : ''))
            };
            this.setState({aiConfig: nextConfig});
        };

        fetchAiModelsFromInputs = async (options) => {
            const silent = !!(options && options.silent);
            let config;
            try {
                config = this.readAiConfigFromInputs();
            } catch (err) {
                if (!silent) this.setError(err.message);
                return;
            }
            if (!config.endpoint) {
                if (!silent) this.setError('请先填写 AI endpoint。');
                return;
            }
            const fetchKey = `${config.endpoint}|${config.apiKey || ''}`;
            if (silent && fetchKey === this.aiLastModelsFetchKey && this.state.aiModels.length) return;
            this.aiLastModelsFetchKey = fetchKey;
            if (this.aiModelsAbortController) {
                this.aiModelsAbortController.abort();
                this.aiModelsAbortController = null;
            }
            const controller = new AbortController();
            this.aiModelsAbortController = controller;
            this.setState({aiModelsLoading: true});
            if (!silent) this.setInfo('正在获取模型列表...');
            try {
                const models = await fetchAiModels(config, controller.signal);
                if (controller.signal.aborted) return;
                const modelValue = this.aiModelRef.current ? this.aiModelRef.current.value.trim() : this.state.aiModelInputValue;
                const matched = findAiModelRecord(models, modelValue);
                const inferred = inferAiModelVisionSupportWithSource(modelValue);
                const inferredRecord = {
                    visionSupport: inferred.support,
                    visionSupportSource: inferred.source
                };
                const nextConfig = matched ? {
                    ...config,
                    model: modelValue,
                    visionSupport: matched.visionSupport,
                    visionSupportSource: matched.visionSupportSource,
                    visionSupportMessage: getAiModelVisionSupportMessage(matched)
                } : {
                    ...config,
                    model: modelValue,
                    visionSupport: inferred.support,
                    visionSupportSource: inferred.source,
                    visionSupportMessage: modelValue
                        ? getAiModelVisionSupportMessage(inferredRecord)
                        : ''
                };
                this.setState({
                    aiModels: models,
                    aiConfig: nextConfig,
                    aiModelMenuOpen: true,
                    aiShowProcessLog: false
                });
                if (!silent) this.setSuccess(`已获取 ${models.length} 个模型。`);
            } catch (err) {
                if (err && err.name === 'AbortError') return;
                console.error('[json-script-converter] fetch AI models failed', err);
                if (!silent) this.setError(`获取模型列表失败: ${err.message}`);
            } finally {
                if (this.aiModelsAbortController === controller) {
                    this.aiModelsAbortController = null;
                    this.setState({aiModelsLoading: false});
                }
            }
        };

        scheduleAiModelsAutoFetch = () => {
            if (this.aiModelsAutoFetchTimer) clearTimeout(this.aiModelsAutoFetchTimer);
            this.aiModelsAutoFetchTimer = setTimeout(() => {
                this.aiModelsAutoFetchTimer = null;
                this.fetchAiModelsFromInputs({silent: true});
            }, 650);
        };

        handleAiEndpointInputChange = () => {
            const input = this.aiEndpointRef.current;
            const value = input ? input.value.trim() : '';
            const preview = getAiEndpointPreview(value);
            if (!value || preview.error) {
                this.aiLastEndpointInputKey = '';
                this.aiLastModelsFetchKey = '';
                this.setState({
                    aiEndpointPreview: preview.endpoint,
                    aiEndpointPreviewError: preview.error,
                    aiModels: value ? this.state.aiModels : [],
                    aiModelMenuOpen: value ? this.state.aiModelMenuOpen : false
                });
                return;
            }
            const apiKey = this.aiApiKeyRef.current ? this.aiApiKeyRef.current.value.trim() : '';
            const endpointKey = `${preview.endpoint}|${apiKey}`;
            if (endpointKey === this.aiLastEndpointInputKey) {
                if (
                    this.state.aiEndpointPreview !== preview.endpoint ||
                    this.state.aiEndpointPreviewError
                ) {
                    this.setState({
                        aiEndpointPreview: preview.endpoint,
                        aiEndpointPreviewError: ''
                    });
                }
                return;
            }
            this.aiLastEndpointInputKey = endpointKey;
            this.aiLastModelsFetchKey = '';
            this.setState({
                aiEndpointPreview: preview.endpoint,
                aiEndpointPreviewError: '',
                aiModels: [],
                aiModelMenuOpen: true
            });
            this.scheduleAiModelsAutoFetch();
        };

        handleAiModelInputChange = e => {
            const value = e && e.target ? e.target.value : '';
            this.setState({aiModelInputValue: value, aiModelMenuOpen: true}, () => {
                this.updateConfigVisionFromModel(value);
            });
        };

        chooseAiModelOption = model => {
            if (!model || !model.id) return;
            if (this.aiModelRef.current) this.aiModelRef.current.value = model.id;
            this.setState({
                aiModelInputValue: model.id,
                aiModelMenuOpen: false
            }, () => this.updateConfigVisionFromModel(model.id));
        };

        handleAiVisionEnabledChange = e => {
            const checked = !!(e && e.target && e.target.checked);
            this.setState(prev => ({
                aiConfig: {
                    ...(prev.aiConfig || {}),
                    visionEnabled: checked
                }
            }));
        };

        handleAiToolNoConfirmChange = e => {
            const checked = !!(e && e.target && e.target.checked);
            this.setState(prev => ({
                aiConfig: {
                    ...(prev.aiConfig || {}),
                    toolNoConfirm: checked
                }
            }));
        };

        handleAiRequestRetryEnabledChange = e => {
            const checked = !!(e && e.target && e.target.checked);
            this.setState(prev => ({
                aiConfig: {
                    ...(prev.aiConfig || {}),
                    requestRetryEnabled: checked
                }
            }));
        };

        handleAiRequestRetryCountChange = e => {
            const value = e && e.target ? e.target.value : '';
            this.setState(prev => ({
                aiConfig: {
                    ...(prev.aiConfig || {}),
                    requestRetryCount: normalizeAiRequestRetryCount(value)
                }
            }));
        };

        abortAiRequest = (cancelConfirmations = true) => {
            if (this.aiAbortController) {
                this.aiAbortController.abort();
                this.aiAbortController = null;
            }
            if (cancelConfirmations) {
                this.cancelAiPendingConfirmations('已中断，未执行删除操作。');
            }
        };

        persistAiChatState = () => {
            saveAiChatState({
                conversations: this.state.aiConversations,
                activeConversationId: this.state.aiActiveConversationId,
                sidebarCollapsed: this.state.aiSidebarCollapsed
            });
        };

        schedulePersistAiChatState = () => {
            if (this.aiChatPersistTimer) clearTimeout(this.aiChatPersistTimer);
            this.aiChatPersistTimer = setTimeout(() => {
                this.aiChatPersistTimer = null;
                this.persistAiChatState();
            }, 250);
        };

        getNextAiConversationState = (prev, messages, preferredTitle) => {
            const nextMessages = Array.isArray(messages) ? messages.slice(-AI_CHAT_MAX_MESSAGES) : [];
            const now = Date.now();
            let conversations = Array.isArray(prev.aiConversations) ? prev.aiConversations.slice() : [];
            let activeConversationId = prev.aiActiveConversationId;
            let activeIndex = conversations.findIndex(item => item && item.id === activeConversationId);
            if (activeIndex < 0) {
                const conversation = createAiConversation(
                    preferredTitle || getAiConversationTitleFromMessages(nextMessages),
                    []
                );
                activeConversationId = conversation.id;
                conversations.unshift(conversation);
                activeIndex = 0;
            }
            const current = conversations[activeIndex];
            const titleFromMessages = preferredTitle || getAiConversationTitleFromMessages(nextMessages);
            const shouldUpdateTitle = !current.title || current.title === '新的聊天';
            const updatedConversation = {
                ...current,
                title: shouldUpdateTitle ? summarizeAiConversationTitle(titleFromMessages) : current.title,
                updatedAt: now,
                messages: nextMessages
            };
            conversations.splice(activeIndex, 1);
            conversations.unshift(updatedConversation);
            conversations = conversations
                .filter(Boolean)
                .slice(0, AI_CHAT_MAX_CONVERSATIONS);
            return {
                aiMessages: nextMessages,
                aiConversations: conversations,
                aiActiveConversationId: activeConversationId
            };
        };

        createNewAiChat = () => {
            if (this.state.aiBusy) {
                this.setInfo('AI 回复中，先中断或等待完成后再新建聊天。');
                return;
            }
            if (!this.state.aiMessages.length && this.state.aiActiveConversationId) {
                if (this.aiInputRef.current) this.aiInputRef.current.focus();
                return;
            }
            const conversation = createAiConversation('新的聊天', []);
            this.aiShouldAutoScrollMessages = true;
            this.setState(prev => ({
                aiConversations: [conversation]
                    .concat(Array.isArray(prev.aiConversations) ? prev.aiConversations : [])
                    .slice(0, AI_CHAT_MAX_CONVERSATIONS),
                aiActiveConversationId: conversation.id,
                aiMessages: [],
                aiVisibleMessageLimit: AI_CHAT_RENDER_INITIAL_MESSAGES
            }), () => {
                this.persistAiChatState();
                this.scrollAiMessagesToBottomSoon(true);
                if (this.aiInputRef.current) this.aiInputRef.current.focus();
            });
        };

        selectAiConversation = id => {
            if (this.state.aiBusy) {
                this.setInfo('AI 回复中，先中断或等待完成后再切换聊天。');
                return;
            }
            const conversation = (this.state.aiConversations || []).find(item => item && item.id === id);
            if (!conversation) return;
            this.aiShouldAutoScrollMessages = true;
            this.setState({
                aiActiveConversationId: conversation.id,
                aiMessages: Array.isArray(conversation.messages) ? conversation.messages : [],
                aiVisibleMessageLimit: AI_CHAT_RENDER_INITIAL_MESSAGES
            }, () => {
                this.persistAiChatState();
                this.scrollAiMessagesToBottomSoon(true);
                if (this.aiInputRef.current) this.aiInputRef.current.focus();
            });
        };

        toggleAiSidebar = () => {
            this.setState(prev => ({
                aiSidebarCollapsed: !prev.aiSidebarCollapsed
            }), this.persistAiChatState);
        };

        deleteAiConversation = id => {
            if (this.state.aiBusy) {
                this.setInfo('AI 回复中，先中断或等待完成后再删除聊天。');
                return;
            }
            const conversation = (this.state.aiConversations || []).find(item => item && item.id === id);
            if (!conversation) return;
            const title = conversation.title || '新的聊天';
            if (!window.confirm(`确定要删除聊天记录“${title}”吗？此操作不能撤销。`)) return;
            const conversations = (this.state.aiConversations || []).filter(item => item && item.id !== id);
            const deletingActive = id === this.state.aiActiveConversationId;
            const activeConversation = deletingActive
                ? (conversations[0] || null)
                : (conversations.find(item => item && item.id === this.state.aiActiveConversationId) || conversations[0] || null);
            this.aiShouldAutoScrollMessages = true;
            this.setState({
                aiConversations: conversations,
                aiActiveConversationId: activeConversation ? activeConversation.id : null,
                aiMessages: activeConversation ? (activeConversation.messages || []) : [],
                aiVisibleMessageLimit: AI_CHAT_RENDER_INITIAL_MESSAGES
            }, () => {
                this.persistAiChatState();
                this.scrollAiMessagesToBottomSoon(true);
                this.setInfo('聊天记录已删除。');
            });
        };

        exportAiConversation = id => {
            const conversation = (this.state.aiConversations || []).find(item => item && item.id === id);
            if (!conversation) {
                this.setError('没有找到要导出的聊天记录。');
                return;
            }
            const filename = `${sanitizeAiExportFileName(conversation.title)}-${formatAiExportTime(Date.now()).replace(/[: ]/g, '-')}.txt`;
            downloadTextFile(filename, formatAiConversationAsTxt(conversation));
            this.setInfo('聊天记录已导出为 TXT。');
        };

        loadOlderAiMessages = () => {
            if (this.aiLoadingOlderMessages) return;
            const el = this.aiMessagesRef.current;
            if (!el) return;
            const total = getRenderableAiChatMessages(this.state.aiMessages, this.state.aiShowProcessLog).length;
            const currentLimit = Number(this.state.aiVisibleMessageLimit) || AI_CHAT_RENDER_INITIAL_MESSAGES;
            if (currentLimit >= total) return;
            const previousScrollHeight = el.scrollHeight;
            const previousScrollTop = el.scrollTop;
            this.aiLoadingOlderMessages = true;
            this.setState({
                aiVisibleMessageLimit: Math.min(total, currentLimit + AI_CHAT_RENDER_BATCH_MESSAGES)
            }, () => {
                this.aiLoadingOlderMessages = false;
                const nextEl = this.aiMessagesRef.current;
                if (!nextEl) return;
                this.aiProgrammaticScrollUntil = Date.now() + 180;
                nextEl.scrollTop = Math.max(0, nextEl.scrollHeight - previousScrollHeight + previousScrollTop);
            });
        };

        getAiMessagesDistanceToBottom = () => {
            const el = this.aiMessagesRef.current;
            if (!el) return 0;
            return el.scrollHeight - el.scrollTop - el.clientHeight;
        };

        isAiMessagesNearBottom = () => this.getAiMessagesDistanceToBottom() <= 48;

        shouldScrollAiMessagesToBottom = force => {
            if (force) {
                this.aiShouldAutoScrollMessages = true;
                return true;
            }
            if (!this.aiMessagesRef.current) return true;
            const nearBottom = this.isAiMessagesNearBottom();
            if (nearBottom) this.aiShouldAutoScrollMessages = true;
            return nearBottom && this.aiShouldAutoScrollMessages !== false;
        };

        scrollAiMessagesToBottom = shouldScroll => {
            if (!shouldScroll || this.aiShouldAutoScrollMessages === false) return;
            const scrollOnce = () => {
                if (this.aiShouldAutoScrollMessages === false) return;
                const el = this.aiMessagesRef.current;
                if (!el) return;
                this.aiProgrammaticScrollUntil = Date.now() + 180;
                el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
                this.aiShouldAutoScrollMessages = true;
            };
            scrollOnce();
            if (this.aiMessagesScrollRAF) cancelAnimationFrame(this.aiMessagesScrollRAF);
            this.aiMessagesScrollRAF = requestAnimationFrame(() => {
                scrollOnce();
                this.aiMessagesScrollRAF = requestAnimationFrame(() => {
                    this.aiMessagesScrollRAF = null;
                    scrollOnce();
                });
            });
            if (this.aiMessagesScrollTimer) clearTimeout(this.aiMessagesScrollTimer);
            this.aiMessagesScrollTimer = setTimeout(() => {
                this.aiMessagesScrollTimer = null;
                scrollOnce();
            }, 120);
        };

        scrollAiMessagesToBottomSoon = shouldScroll => {
            if (!shouldScroll || this.aiShouldAutoScrollMessages === false) return;
            this.scrollAiMessagesToBottom(shouldScroll);
            setTimeout(() => this.scrollAiMessagesToBottom(shouldScroll), 260);
        };

        handleAiMessagesScroll = () => {
            const el = this.aiMessagesRef.current;
            if (!el) return;
            const userScrolling = Date.now() < this.aiUserMessageScrollUntil;
            if (userScrolling && el.scrollTop <= 80) {
                this.loadOlderAiMessages();
                return;
            }
            if (!userScrolling && Date.now() < this.aiProgrammaticScrollUntil) {
                this.aiShouldAutoScrollMessages = true;
                return;
            }
            this.aiShouldAutoScrollMessages = this.isAiMessagesNearBottom();
        };

        handleAiMessagesUserScrollIntent = event => {
            this.aiUserMessageScrollUntil = Date.now() + 1000;
            if (this.aiMessagesScrollRAF) {
                cancelAnimationFrame(this.aiMessagesScrollRAF);
                this.aiMessagesScrollRAF = null;
            }
            if (this.aiMessagesScrollTimer) {
                clearTimeout(this.aiMessagesScrollTimer);
                this.aiMessagesScrollTimer = null;
            }
            if (event && typeof event.deltaY === 'number' && event.deltaY < 0) {
                this.aiShouldAutoScrollMessages = false;
            }
        };

        addAiChatMessage = (role, text, extra) => {
            const forceScroll = extra && Object.prototype.hasOwnProperty.call(extra, 'forceScroll')
                ? !!extra.forceScroll
                : role === 'user';
            const shouldScroll = this.shouldScrollAiMessagesToBottom(forceScroll);
            const preferredTitle = role === 'user' ? summarizeAiConversationTitle(text) : '';
            const id = `ai-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const message = {
                id,
                role,
                kind: extra && extra.kind ? extra.kind : '',
                text: String(text || ''),
                time: Date.now(),
                pending: !!(extra && extra.pending),
                confirmationId: extra && extra.confirmationId ? String(extra.confirmationId) : '',
                confirmationResolved: !!(extra && extra.confirmationResolved),
                confirmationResult: extra && extra.confirmationResult ? String(extra.confirmationResult) : '',
                details: extra && Array.isArray(extra.details) ? extra.details : []
            };
            this.setState(prev => this.getNextAiConversationState(
                prev,
                prev.aiMessages.concat(message),
                preferredTitle
            ), () => {
                this.schedulePersistAiChatState();
                this.scrollAiMessagesToBottomSoon(shouldScroll);
            });
            return id;
        };

        addAiStatusMessage = text => this.addAiChatMessage('assistant', text, {kind: 'status'});

        appendAiConfirmationResultText = (text, resultText) => {
            const base = String(text || '').trim();
            return base ? `${base}\n\n${resultText}` : resultText;
        };

        shouldSkipAiToolConfirmation = () => !!(this.state.aiConfig && this.state.aiConfig.toolNoConfirm);

        requestAiUserConfirmation = text => new Promise(resolve => {
            if (this.shouldSkipAiToolConfirmation()) {
                this.addAiStatusMessage('已按设置跳过工具确认，继续执行。');
                resolve(true);
                return;
            }
            const confirmationId = `ai-confirm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const pending = {resolve, messageId: ''};
            this.aiPendingConfirmations.set(confirmationId, pending);
            const messageId = this.addAiChatMessage('assistant', text, {
                kind: 'confirm',
                confirmationId,
                forceScroll: true
            });
            pending.messageId = messageId;
        });

        resolveAiUserConfirmation = (confirmationId, confirmed) => {
            if (!confirmationId || !this.aiPendingConfirmations) return;
            const pending = this.aiPendingConfirmations.get(confirmationId);
            if (!pending) return;
            this.aiPendingConfirmations.delete(confirmationId);
            pending.resolve(!!confirmed);
            const messageId = pending.messageId || (
                (this.state.aiMessages || []).find(message => message && message.confirmationId === confirmationId) || {}
            ).id;
            this.updateAiChatMessage(messageId, message => ({
                kind: 'status',
                pending: false,
                confirmationResolved: true,
                confirmationResult: confirmed ? 'confirmed' : 'cancelled',
                text: this.appendAiConfirmationResultText(
                    message.text,
                    confirmed ? '已确认，继续执行。' : '已取消，未执行删除。'
                )
            }));
        };

        cancelAiPendingConfirmations = (reason, updateMessages = true) => {
            if (!this.aiPendingConfirmations || !this.aiPendingConfirmations.size) return;
            const pendingItems = Array.from(this.aiPendingConfirmations.entries());
            this.aiPendingConfirmations.clear();
            for (const [, pending] of pendingItems) {
                if (pending && typeof pending.resolve === 'function') {
                    pending.resolve(false);
                }
                if (updateMessages && pending && pending.messageId) {
                    this.updateAiChatMessage(pending.messageId, message => ({
                        kind: 'status',
                        pending: false,
                        confirmationResolved: true,
                        confirmationResult: 'cancelled',
                        text: this.appendAiConfirmationResultText(
                            message.text,
                            reason || '已取消，未执行删除。'
                        )
                    }));
                }
            }
        };

        updateAiChatMessage = (id, updater) => {
            if (!id) return;
            const shouldScroll = this.shouldScrollAiMessagesToBottom(false);
            this.setState(prev => {
                const nextMessages = prev.aiMessages.map(message => {
                    if (message.id !== id) return message;
                    const patch = typeof updater === 'function' ? updater(message) : updater;
                    return {...message, ...patch};
                });
                return this.getNextAiConversationState(prev, nextMessages);
            }, () => {
                this.schedulePersistAiChatState();
                this.scrollAiMessagesToBottomSoon(shouldScroll);
            });
        };

        appendAiVisibleDelta = (id, delta) => {
            if (!delta) return;
            this.updateAiChatMessage(id, message => ({
                text: `${message.text || ''}${delta}`,
                pending: false
            }));
        };

        appendAiChatText = (id, text) => {
            if (!text) return;
            this.updateAiChatMessage(id, message => ({
                text: message.text ? `${message.text}\n\n${text}` : text,
                pending: false
            }));
        };

        addAiMessageDetail = (id, title, content, extra) => {
            const preview = formatAiPseudocodePreview(content);
            if (!preview) return;
            this.updateAiChatMessage(id, message => ({
                details: (message.details || []).concat({
                    key: extra && extra.key ? extra.key : '',
                    kind: extra && extra.kind ? extra.kind : '',
                    title,
                    content: preview,
                    time: Date.now(),
                    diff: extra && Array.isArray(extra.diff) ? extra.diff : null
                })
            }));
        };

        addAiToolTraceDetail = (id, title, payload, extra) => {
            this.addAiMessageDetail(id, title, formatAiToolTraceJson(payload), {
                key: extra && extra.key ? extra.key : '',
                kind: extra && extra.kind ? extra.kind : 'tool-trace'
            });
        };

        addAiToolCallDetail = (id, tool, index, total) => {
            const name = formatAiToolTraceName(tool);
            const suffix = total > 1 ? ` ${index + 1}/${total}` : '';
            this.addAiToolTraceDetail(id, `调用工具${suffix}：${name}`, tool || {}, {
                key: `tool-call-${Date.now()}-${index}`,
                kind: 'tool-call'
            });
        };

        addAiToolResultDetail = (id, tool, result, index, total) => {
            const name = formatAiToolTraceName(tool || result);
            const suffix = total > 1 ? ` ${index + 1}/${total}` : '';
            const status = result && result.ok ? '成功' : '失败';
            this.addAiToolTraceDetail(id, `调用结果${suffix}：${name} ${status}`, result || {}, {
                key: `tool-result-${Date.now()}-${index}`,
                kind: result && result.ok ? 'tool-result' : 'tool-error'
            });
        };

        appendAiReasoningDelta = (id, delta) => {
            if (!id || !delta) return;
            this.updateAiChatMessage(id, message => {
                const details = (message.details || []).slice();
                const index = details.findIndex(detail => detail && detail.key === 'reasoning');
                if (index >= 0) {
                    const prev = details[index];
                    details[index] = {
                        ...prev,
                        content: `${prev.content || ''}${delta}`
                    };
                } else {
                    details.unshift({
                        key: 'reasoning',
                        title: 'AI 推理',
                        content: String(delta),
                        time: Date.now()
                    });
                }
                return {details};
            });
        };

        upsertAiMessageDetail = (id, key, title, content) => {
            if (!content) return;
            this.updateAiChatMessage(id, message => {
                const details = (message.details || []).slice();
                const index = details.findIndex(detail => detail && detail.key === key);
                const next = {key, title, content: String(content), time: Date.now()};
                if (index >= 0) details[index] = {...details[index], ...next};
                else details.unshift(next);
                return {details};
            });
        };

        startAiProcessLog = id => {
            this.aiProcessStartedAt = Date.now();
            this.aiProcessLines = [];
            this.addAiProcessStep(id, '收到请求，准备发送给 AI。');
        };

        addAiProcessStep = (id, text) => {
            if (!id || !text) return;
            if (!this.aiProcessStartedAt) this.aiProcessStartedAt = Date.now();
            if (!Array.isArray(this.aiProcessLines)) this.aiProcessLines = [];
            this.aiProcessLines.push(`[${formatAiElapsed(this.aiProcessStartedAt)}] ${text}`);
            if (!this.state.aiShowProcessLog) return;
            this.upsertAiMessageDetail(id, 'process', '处理过程', this.aiProcessLines.join('\n'));
        };

        resetAiTargetRefs = () => {
            this.aiTargetRefs = new Map();
            this.aiTargetRefIds = new Map();
            this.aiNextTargetRefIndex = 0;
        };

        ensureAiTargetRefs = () => {
            if (!this.aiTargetRefs) this.aiTargetRefs = new Map();
            if (!this.aiTargetRefIds) this.aiTargetRefIds = new Map();
            for (const target of getAiTargets(vm)) {
                if (!target || !target.id || this.aiTargetRefs.has(target.id)) continue;
                let ref;
                do {
                    ref = formatAiTargetRef(this.aiNextTargetRefIndex++);
                } while (this.aiTargetRefIds.has(ref));
                this.aiTargetRefs.set(target.id, ref);
                this.aiTargetRefIds.set(ref, target.id);
            }
        };

        getAiTargetRef = target => {
            if (!target || !target.id) return '';
            this.ensureAiTargetRefs();
            return this.aiTargetRefs.get(target.id) || '';
        };

        getAiTargetSummary = (target, options) => getAiTargetSummary(target, vm, this.getAiTargetRef(target), options);

        getAiTargetSummaries = () => getAiTargets(vm).map(target => this.getAiTargetSummary(target));

        resolveAiTarget = targetIdOrName => {
            const value = String(targetIdOrName || '').trim();
            if (!value) return findAiTarget(vm, value);
            this.ensureAiTargetRefs();
            const targetId = this.aiTargetRefIds.get(value.toLowerCase());
            if (targetId) {
                const target = getAiTargets(vm).find(item => item && item.id === targetId);
                if (target) return {target, error: null};
            }
            const resolved = findAiTarget(vm, value);
            if (resolved.target) return resolved;
            return resolved;
        };

        getTargetPseudocode = (target, fallbackCurrentText) => {
            if (!target) throw new Error('没有目标角色');
            if (vm.editingTarget && target.id === vm.editingTarget.id && typeof fallbackCurrentText === 'string') {
                return fallbackCurrentText;
            }
            return renderTargetPseudocode(target, vm, {includeCoords: this.includeCoords});
        };

        createPseudoMeta = parsed => ({
            pendingVars: parsed.pendingVars,
            pendingLists: parsed.pendingLists,
            pendingBroadcasts: parsed.pendingBroadcasts,
            declaredVars: parsed.declaredVars,
            declaredLists: parsed.declaredLists,
            declaredBroadcasts: parsed.declaredBroadcasts,
            declaredLocalVars: parsed.declaredLocalVars || new Set(),
            declaredLocalLists: parsed.declaredLocalLists || new Set(),
            comments: parsed.comments || {}
        });

        getPseudoMetaSummary = meta => meta ? JSON.stringify({
            pV: [...meta.pendingVars.keys()],
            pL: [...meta.pendingLists.keys()],
            pB: [...meta.pendingBroadcasts.keys()],
            dV: [...meta.declaredVars],
            dL: [...meta.declaredLists],
            dB: [...meta.declaredBroadcasts],
            dLV: [...meta.declaredLocalVars],
            dLL: [...meta.declaredLocalLists],
            c: meta.comments || {}
        }) : '';

        getKnownPseudocodeEntries = knownTargetTexts => {
            const entries = [];
            for (const [targetId, pseudocode] of knownTargetTexts.entries()) {
                const resolved = this.resolveAiTarget(targetId);
                if (!resolved.target) continue;
                const text = String(pseudocode || '');
                const lines = splitAiLines(text);
                entries.push({
                    ...this.getAiTargetSummary(resolved.target, {includeCostumes: false}),
                    pseudocode: text,
                    totalLines: lines.length,
                    numberedLines: lines.map((line, index) => ({
                        lineNumber: index + 1,
                        text: line
                    }))
                });
            }
            return entries;
        };

        getAiToolPseudocodeText = (target, knownTargetTexts, currentText) => {
            if (knownTargetTexts && knownTargetTexts.has(target.id)) {
                return knownTargetTexts.get(target.id);
            }
            return this.getTargetPseudocode(target, currentText);
        };

        addAiPseudocodeSnippetDetail = (messageId, snippet) => {
            this.addAiMessageDetail(
                messageId,
                `已读取的伪代码片段 - ${snippet.targetName}`,
                formatAiPseudocodeSnippetDetail(snippet)
            );
        };

        resolveAiCostume = (target, tool, defaultToCurrent) => {
            if (!target) return {costume: null, index: -1, error: '没有目标角色'};
            const costumes = target.sprite && Array.isArray(target.sprite.costumes) ? target.sprite.costumes : [];
            if (!costumes.length) return {costume: null, index: -1, error: '目标没有造型/背景'};
            const raw = (tool && tool.raw) || tool || {};
            const hasExplicit = raw.costumeIndex != null || raw.index != null ||
                raw.costumeName || raw.backdropName || raw.name || tool.costumeName || tool.costumeIndex != null;
            if (!hasExplicit && defaultToCurrent) {
                const index = typeof target.currentCostume === 'number' ? target.currentCostume : 0;
                return {costume: costumes[index] || costumes[0], index: costumes[index] ? index : 0, error: null};
            }
            const found = findAiCostumeIndex(target, raw);
            if (found.error) return {costume: null, index: -1, error: found.error};
            return {costume: costumes[found.index], index: found.index, error: null};
        };

        loadAiCostumeAsset = async costume => {
            if (!costume) throw new Error('缺少造型/背景');
            if (costume.asset && costume.asset.data) return costume.asset;
            const storage = vm.runtime && vm.runtime.storage;
            if (!storage || typeof storage.load !== 'function') throw new Error('当前项目存储不可用');
            const dataFormat = getAiCostumeDataFormat(costume);
            const assetId = getAiCostumeAssetId(costume);
            const assetType = getAiCostumeAssetType(storage, dataFormat);
            if (!assetId || !dataFormat || !assetType) throw new Error('造型资源信息不完整');
            const asset = await storage.load(assetType, assetId, dataFormat);
            if (!asset || !asset.data) throw new Error(`无法读取造型资源: ${assetId}.${dataFormat}`);
            costume.asset = asset;
            costume.assetId = asset.assetId || assetId;
            costume.dataFormat = asset.dataFormat || dataFormat;
            costume.md5 = `${costume.assetId}.${costume.dataFormat}`;
            return asset;
        };

        getAiCostumeInfo = async (target, tool) => {
            const targetSummary = this.getAiTargetSummary(target, {includeCostumes: false});
            const costumes = target.sprite && Array.isArray(target.sprite.costumes) ? target.sprite.costumes : [];
            const raw = (tool && tool.raw) || tool || {};
            const hasSpecificCostume = raw.costumeIndex != null || raw.index != null ||
                raw.costumeName || raw.backdropName || raw.name || tool.costumeName || tool.costumeIndex != null;
            const selected = [];
            if (hasSpecificCostume) {
                const resolved = this.resolveAiCostume(target, tool, true);
                if (resolved.error) return {ok: false, type: 'get_costume_info', error: resolved.error, target: targetSummary};
                selected.push({costume: resolved.costume, index: resolved.index, includeSource: true});
            } else {
                costumes.forEach((costume, index) => selected.push({costume, index, includeSource: false}));
            }
            const items = [];
            for (const item of selected) {
                const meta = formatAiCostumeMeta(target, item.costume, item.index);
                if (meta.dataFormat === 'svg') {
                    meta.svgSourceAvailable = true;
                    if (item.includeSource && tool.includeSvg !== false) {
                        try {
                            const asset = await this.loadAiCostumeAsset(item.costume);
                            const source = decodeAiAssetText(asset);
                            meta.svgLength = source.length;
                            meta.svgTruncated = source.length > AI_SVG_SOURCE_LIMIT;
                            meta.svg = source.slice(0, AI_SVG_SOURCE_LIMIT);
                        } catch (err) {
                            meta.svgReadError = err.message;
                        }
                    }
                } else {
                    meta.svgSourceAvailable = false;
                    meta.imageInspectionRequiresVision = true;
                }
                items.push(meta);
            }
            return {ok: true, type: 'get_costume_info', target: targetSummary, costumes: items};
        };

        prepareAiSvgCostume = async (name, svg, options) => {
            const checked = validateAiSvgText(svg);
            if (!checked.ok) return checked;
            try {
                await assertAiSvgRenderable(checked.svg);
            } catch (err) {
                return {ok: false, error: `SVG 无法渲染: ${err.message}`};
            }
            const storage = vm.runtime && vm.runtime.storage;
            if (!storage || !storage.AssetType || !storage.DataFormat || typeof storage.createAsset !== 'function') {
                return {ok: false, error: '当前项目存储不可用'};
            }
            const bytes = new TextEncoder().encode(checked.svg);
            const asset = storage.createAsset(storage.AssetType.ImageVector, storage.DataFormat.SVG, bytes, null, true);
            const bounds = checked.bounds || getAiSvgBounds(checked.svg);
            const rx = Number(options && options.rotationCenterX);
            const ry = Number(options && options.rotationCenterY);
            const scaleX = rendered.width / rendered.sourceWidth;
            const scaleY = rendered.height / rendered.sourceHeight;
            const costume = {
                name,
                dataFormat: storage.DataFormat.SVG,
                asset,
                assetId: asset.assetId,
                md5: `${asset.assetId}.${storage.DataFormat.SVG}`,
                bitmapResolution: 1,
                rotationCenterX: Number.isFinite(rx) ? rx : bounds.width / 2,
                rotationCenterY: Number.isFinite(ry) ? ry : bounds.height / 2
            };
            return {ok: true, svg: checked.svg, bounds, costume};
        };

        prepareAiBitmapCostume = async (name, imageData, options) => {
            const rendered = await renderAiBitmapToPng(imageData, options && options.mimeType);
            if (!rendered.ok) return rendered;
            const storage = vm.runtime && vm.runtime.storage;
            if (!storage || !storage.AssetType || !storage.DataFormat || typeof storage.createAsset !== 'function') {
                return {ok: false, error: '当前项目存储不可用'};
            }
            const asset = storage.createAsset(
                storage.AssetType.ImageBitmap,
                storage.DataFormat.PNG,
                rendered.bytes,
                null,
                true
            );
            const rx = Number(options && options.rotationCenterX);
            const ry = Number(options && options.rotationCenterY);
            const costume = {
                name,
                dataFormat: storage.DataFormat.PNG,
                asset,
                assetId: asset.assetId,
                md5: `${asset.assetId}.${storage.DataFormat.PNG}`,
                bitmapResolution: 1,
                rotationCenterX: Number.isFinite(rx) ? rx * scaleX : rendered.width / 2,
                rotationCenterY: Number.isFinite(ry) ? ry * scaleY : rendered.height / 2
            };
            return {
                ok: true,
                costume,
                image: {
                    mimeType: 'image/png',
                    width: rendered.width,
                    height: rendered.height,
                    sourceWidth: rendered.sourceWidth,
                    sourceHeight: rendered.sourceHeight,
                    sourceMimeType: rendered.sourceMimeType,
                    byteLength: rendered.bytes.length,
                    resized: rendered.resized
                }
            };
        };

        inspectAiCostumeImage = async (target, tool) => {
            if (!hasAiVisionSupport(this.state.aiConfig)) {
                return {ok: false, type: 'inspect_costume', error: '图像理解未启用，请在 AI 设置中打开“启用图像理解”。'};
            }
            const resolved = this.resolveAiCostume(target, tool, true);
            if (resolved.error) return {ok: false, type: 'inspect_costume', error: resolved.error};
            const meta = formatAiCostumeMeta(target, resolved.costume, resolved.index);
            let image;
            if (meta.dataFormat === 'svg') {
                const asset = await this.loadAiCostumeAsset(resolved.costume);
                image = await rasterizeAiSvgToPngDataUrl(decodeAiAssetText(asset), 768);
                if (!image.ok) return {ok: false, type: 'inspect_costume', error: image.error};
            } else {
                const asset = await this.loadAiCostumeAsset(resolved.costume);
                if (!asset || typeof asset.encodeDataURI !== 'function') {
                    return {ok: false, type: 'inspect_costume', error: '造型资源无法转换为图片'};
                }
                image = await downscaleAiImageDataUrl(asset.encodeDataURI(), 768);
                if (!image.ok) return {ok: false, type: 'inspect_costume', error: image.error};
            }
            const targetSummary = this.getAiTargetSummary(target, {includeCostumes: false});
            return {
                ok: true,
                type: 'inspect_costume',
                target: targetSummary,
                costume: meta,
                imageAttachment: {
                    label: `${targetSummary.targetName} - ${meta.name}`,
                    mimeType: 'image/png',
                    dataUrl: image.dataUrl,
                    width: image.width,
                    height: image.height
                }
            };
        };

        getAiStageSnapshot = async () => {
            if (!hasAiVisionSupport(this.state.aiConfig)) {
                return {ok: false, type: 'get_stage_snapshot', error: '图像理解未启用，请在 AI 设置中打开“启用图像理解”。'};
            }
            const renderer = vm && vm.renderer;
            if (!renderer || typeof renderer.requestSnapshot !== 'function') {
                return {ok: false, type: 'get_stage_snapshot', error: '当前渲染器不支持舞台截图'};
            }
            const dataUrl = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('舞台截图超时')), 5000);
                try {
                    if (vm.runtime && typeof vm.runtime.requestRedraw === 'function') vm.runtime.requestRedraw();
                    renderer.requestSnapshot(url => {
                        clearTimeout(timer);
                        if (url) resolve(url);
                        else reject(new Error('舞台截图为空'));
                    });
                } catch (err) {
                    clearTimeout(timer);
                    reject(err);
                }
            });
            const image = await downscaleAiImageDataUrl(dataUrl, 768);
            if (!image.ok) return {ok: false, type: 'get_stage_snapshot', error: image.error};
            return {
                ok: true,
                type: 'get_stage_snapshot',
                stage: {
                    width: vm.runtime && vm.runtime.stageWidth,
                    height: vm.runtime && vm.runtime.stageHeight
                },
                imageAttachment: {
                    label: '舞台截图',
                    mimeType: 'image/png',
                    dataUrl: image.dataUrl,
                    width: image.width,
                    height: image.height
                }
            };
        };

        listAiExtensions = async options => {
            const opts = options || {};
            let remoteItems = [];
            let remoteError = null;
            if (opts.includeRemote !== false) {
                try {
                    remoteItems = await getAiRemoteExtensionCatalog();
                    remoteError = aiRemoteExtensionCatalogError || null;
                } catch (err) {
                    remoteError = err && err.message ? err.message : String(err);
                }
            }
            let extensions = getAiExtensionSummaries(vm, remoteItems);
            const query = String(opts.query || '').trim().toLowerCase();
            const source = String(opts.source || '').trim().toLowerCase();
            if (query) {
                extensions = extensions.filter(item => [item.id, item.name, item.slug, item.description, item.url]
                    .join(' ')
                    .toLowerCase()
                    .includes(query));
            }
            if (source) {
                extensions = extensions.filter(item => String(item.source || (item.remote ? 'remote' : 'builtin'))
                    .toLowerCase()
                    .includes(source));
            }
            const total = extensions.length;
            const limit = Math.min(200, Math.max(1, Number(opts.limit) || 80));
            extensions = extensions.slice(0, limit);
            return {
                ok: true,
                type: 'list_extensions',
                loaded: getAiLoadedExtensionIds(vm),
                extensions,
                total,
                truncated: total > extensions.length,
                remoteError
            };
        };

        refreshAiExtensionUi = () => {
            try {
                if (typeof vm.emitTargetsUpdate === 'function') vm.emitTargetsUpdate(false);
            } catch (_) { /* ignore */ }
        };

        loadAiExtension = async tool => {
            const manager = vm && vm.extensionManager;
            if (!manager) return {ok: false, type: 'load_extension', error: '当前 VM 没有 extensionManager'};
            const rawUrl = String(tool && (tool.url || tool.extensionUrl || tool.extensionURL) || '').trim();
            const rawSlug = String(tool && (tool.slug || tool.turbowarpSlug || tool.twSlug) || '').trim();
            const rawId = String(tool && (tool.extensionId || tool.id || tool.name || tool.extension) || '').trim();
            const rawValue = rawUrl || rawId || rawSlug;
            if (!rawValue) return {ok: false, type: 'load_extension', error: '缺少 extensionId 或 url'};
            const isUrl = isAiExtensionUrl(rawValue);
            const normalizedId = isUrl ? '' : normalizeAiExtensionId(rawValue);
            let record = normalizedId ? getAiExtensionRecord(normalizedId) : null;
            if (!record && !isUrl) {
                try {
                    record = await findAiRemoteExtensionRecord(rawSlug || rawId || rawValue);
                } catch (_) { /* fall back below */ }
            }
            const directTurboWarpUrl = !record && rawSlug ? makeAiTurboWarpExtensionUrl(rawSlug) : '';
            const extensionId = record ? record.id : normalizedId;
            const displayId = extensionId || rawValue;
            const beforeLoadedIds = new Set(getAiLoadedExtensionIds(vm));
            if (extensionId && isAiExtensionLoaded(vm, extensionId)) {
                return {
                    ok: true,
                    type: 'load_extension',
                    extension: summarizeAiExtension(vm, record || extensionId),
                    loaded: getAiLoadedExtensionIds(vm),
                    newLoadedIds: [],
                    alreadyLoaded: true,
                    summary: `扩展已加载：${displayId}`,
                    nextSuggestedAction: {type: 'get_extension_blocks', extensionId}
                };
            }
            try {
                if (record && (typeof manager.isBuiltinExtension !== 'function' || manager.isBuiltinExtension(record.id)) &&
                    typeof manager.loadExtensionIdSync === 'function') {
                    manager.loadExtensionIdSync(record.id);
                } else if (record && record.url && typeof manager.loadExtensionURL === 'function') {
                    await manager.loadExtensionURL(record.url);
                } else if (extensionId && typeof manager.isBuiltinExtension === 'function' &&
                    manager.isBuiltinExtension(extensionId) && typeof manager.loadExtensionIdSync === 'function') {
                    manager.loadExtensionIdSync(extensionId);
                } else if (directTurboWarpUrl && typeof manager.loadExtensionURL === 'function') {
                    await manager.loadExtensionURL(directTurboWarpUrl);
                } else if (!isUrl && typeof vm._loadExtensions === 'function') {
                    await vm._loadExtensions([extensionId]);
                } else if (typeof manager.loadExtensionURL === 'function') {
                    await manager.loadExtensionURL(rawValue);
                } else {
                    return {ok: false, type: 'load_extension', error: '当前 VM 不支持加载扩展'};
                }
                this.refreshAiExtensionUi();
                const afterLoadedIds = getAiLoadedExtensionIds(vm);
                const newLoadedIds = afterLoadedIds.filter(id => !beforeLoadedIds.has(id));
                const loadedId = record && record.id ? record.id : (extensionId || newLoadedIds[0] || '');
                return {
                    ok: true,
                    type: 'load_extension',
                    extension: loadedId ? summarizeAiExtension(vm, record || {
                        id: loadedId,
                        name: loadedId,
                        url: directTurboWarpUrl || rawUrl,
                        remote: !!(directTurboWarpUrl || rawUrl),
                        source: directTurboWarpUrl ? 'tw' : undefined,
                        slug: rawSlug
                    }) : {id: rawValue, name: rawValue, loaded: true, url: directTurboWarpUrl || rawUrl},
                    loaded: afterLoadedIds,
                    newLoadedIds,
                    summary: `已加载扩展：${loadedId || rawSlug || rawValue}`,
                    nextSuggestedAction: loadedId ? {type: 'get_extension_blocks', extensionId: loadedId} : null
                };
            } catch (err) {
                return {
                    ok: false,
                    type: 'load_extension',
                    extensionId: displayId,
                    error: err && err.message ? err.message : String(err)
                };
            }
        };

        ensureAiExtensionsForBlocks = blocks => {
            const manager = vm && vm.extensionManager;
            const requiredIds = getAiRequiredExtensionsFromBlocks(blocks);
            if (!requiredIds.length) return {ok: true, requiredExtensions: [], loadedExtensions: []};
            if (!manager) return {ok: false, error: '当前 VM 没有 extensionManager', requiredExtensions: requiredIds};
            const loadedExtensions = [];
            const errors = [];
            for (const extensionId of requiredIds) {
                if (isAiExtensionLoaded(vm, extensionId)) continue;
                const record = AI_EXTENSION_ID_MAP.get(extensionId) || {id: extensionId, name: extensionId};
                try {
                    if (typeof manager.isBuiltinExtension === 'function' &&
                        manager.isBuiltinExtension(extensionId) &&
                        typeof manager.loadExtensionIdSync === 'function') {
                        manager.loadExtensionIdSync(extensionId);
                        loadedExtensions.push(summarizeAiExtension(vm, record));
                    } else {
                        errors.push(`${extensionId} 需要先调用 load_extension 加载`);
                    }
                } catch (err) {
                    errors.push(`${extensionId}: ${err && err.message ? err.message : String(err)}`);
                }
            }
            if (loadedExtensions.length) this.refreshAiExtensionUi();
            if (errors.length) {
                return {
                    ok: false,
                    error: `缺少扩展：${errors.join('；')}`,
                    requiredExtensions: requiredIds,
                    loadedExtensions
                };
            }
            return {ok: true, requiredExtensions: requiredIds, loadedExtensions};
        };

        executeAiProjectTool = async tool => {
            const type = tool && tool.type;
            if (type === 'create_sprite') {
                const usedNames = getAiTargets(vm).filter(target => !target.isStage).map(target => getAiTargetName(target));
                const name = getAiUnusedName(tool.name || 'Sprite', usedNames);
                await vm.addSprite(JSON.stringify(emptySprite(name, 'pop', 'costume1')));
                const created = getAiTargets(vm).find(target => !target.isStage && getAiTargetName(target) === name);
                if (!created) return {ok: false, type, error: `角色创建后未找到: ${name}`};
                this.prepareForExternalWorkspaceReset();
                return {ok: true, type, target: this.getAiTargetSummary(created, {includeCostumes: false}), summary: `已创建角色：${name}`};
            }
            if (type === 'delete_sprite') {
                const resolved = this.resolveAiTarget(tool.targetId || tool.name);
                if (!resolved.target) return {ok: false, type, error: resolved.error};
                if (resolved.target.isStage) return {ok: false, type, error: '不能删除舞台/背景目标'};
                const summary = this.getAiTargetSummary(resolved.target, {includeCostumes: false});
                const confirmed = tool.confirm === true || this.shouldSkipAiToolConfirmation() ||
                    await this.requestAiUserConfirmation(
                        `AI 请求删除角色：${summary.targetName}\n` +
                        '删除会移除这个角色及其脚本、造型和声音。\n' +
                        '请在这里确认是否继续。'
                    );
                if (!confirmed) {
                    return {ok: false, type, cancelled: true, error: `用户取消删除角色：${summary.targetName}`};
                }
                vm.deleteSprite(resolved.target.id);
                this.prepareForExternalWorkspaceReset();
                return {ok: true, type, target: summary, summary: `已删除角色：${summary.targetName}`};
            }
            if (type === 'create_costume') {
                const resolved = this.resolveAiTarget(tool.targetId || (vm.editingTarget && vm.editingTarget.id));
                if (!resolved.target) return {ok: false, type, error: resolved.error};
                const existing = resolved.target.sprite && Array.isArray(resolved.target.sprite.costumes)
                    ? resolved.target.sprite.costumes.map(costume => costume && costume.name)
                    : [];
                const fallback = resolved.target.isStage ? 'backdrop1' : 'costume1';
                const name = getAiUnusedName(tool.costumeName || tool.name || fallback, existing);
                const costume = emptyCostume(name);
                await vm.addCostume(costume.md5 || AI_DEFAULT_EMPTY_ASSET_MD5, costume, resolved.target.id);
                const fullTargetSummary = this.getAiTargetSummary(resolved.target);
                const targetSummary = this.getAiTargetSummary(resolved.target, {includeCostumes: false});
                const createdCostume = (fullTargetSummary.costumes || []).find(item => item.name === name) || {};
                const costumeNumber = createdCostume.index != null ? createdCostume.index + 1 : existing.length + 1;
                const costumeSummary = {
                    ...createdCostume,
                    name,
                    number: costumeNumber,
                    costumeNumber
                };
                this.prepareForExternalWorkspaceReset();
                return {
                    ok: true,
                    type,
                    target: targetSummary,
                    costume: costumeSummary,
                    summary: resolved.target.isStage ?
                        `已创建背景：${name}（第 ${costumeNumber} 个背景）` :
                        `已创建造型：${name}（第 ${costumeNumber} 个造型）`
                };
            }
            if (type === 'create_svg_costume') {
                const resolved = this.resolveAiTarget(tool.targetId || (vm.editingTarget && vm.editingTarget.id));
                if (!resolved.target) return {ok: false, type, error: resolved.error};
                if (!tool.svg) return {ok: false, type, error: '缺少 svg 内容'};
                const existing = resolved.target.sprite && Array.isArray(resolved.target.sprite.costumes)
                    ? resolved.target.sprite.costumes.map(costume => costume && costume.name)
                    : [];
                const fallback = resolved.target.isStage ? 'backdrop1' : 'costume1';
                const name = getAiUnusedName(tool.costumeName || tool.name || fallback, existing);
                const prepared = await this.prepareAiSvgCostume(name, tool.svg, tool);
                if (!prepared.ok) return {ok: false, type, error: prepared.error};
                await vm.addCostume(prepared.costume.md5, prepared.costume, resolved.target.id);
                const fullTargetSummary = this.getAiTargetSummary(resolved.target);
                const targetSummary = this.getAiTargetSummary(resolved.target, {includeCostumes: false});
                const createdCostume = (fullTargetSummary.costumes || []).find(item => item.name === name) || {};
                const costumeNumber = createdCostume.index != null ? createdCostume.index + 1 : existing.length + 1;
                const costumeSummary = {
                    ...createdCostume,
                    name,
                    number: costumeNumber,
                    costumeNumber
                };
                this.prepareForExternalWorkspaceReset();
                return {
                    ok: true,
                    type,
                    target: targetSummary,
                    costume: costumeSummary,
                    svg: prepared.svg,
                    summary: resolved.target.isStage ?
                        `已创建 SVG 背景：${name}（第 ${costumeNumber} 个背景）` :
                        `已创建 SVG 造型：${name}（第 ${costumeNumber} 个造型）`
                };
            }
            if (type === 'replace_svg_costume') {
                const resolved = this.resolveAiTarget(tool.targetId || (vm.editingTarget && vm.editingTarget.id));
                if (!resolved.target) return {ok: false, type, error: resolved.error};
                if (!tool.svg) return {ok: false, type, error: '缺少 svg 内容'};
                const target = resolved.target;
                const costumes = target.sprite && Array.isArray(target.sprite.costumes) ? target.sprite.costumes : [];
                const found = this.resolveAiCostume(target, tool, true);
                if (found.error) return {ok: false, type, error: found.error};
                const oldCostume = found.costume;
                const oldName = oldCostume && oldCostume.name ? oldCostume.name : `costume${found.index + 1}`;
                const usedNames = costumes
                    .filter((costume, index) => index !== found.index && costume)
                    .map(costume => costume.name);
                const finalName = tool.newName ? getAiUnusedName(tool.newName, usedNames) : oldName;
                const tempName = getAiUnusedName(`__ai_svg_${Date.now()}`, costumes.map(costume => costume && costume.name));
                const prepared = await this.prepareAiSvgCostume(tempName, tool.svg, tool);
                if (!prepared.ok) return {ok: false, type, error: prepared.error};
                const originalCurrent = typeof target.currentCostume === 'number' ? target.currentCostume : 0;
                await vm.addCostume(prepared.costume.md5, prepared.costume, target.id);
                const added = costumes[costumes.length - 1];
                if (!added) return {ok: false, type, error: 'SVG 造型加载后未找到'};
                target.sprite.deleteCostumeAt(found.index);
                let addedIndex = costumes.indexOf(added);
                if (addedIndex < 0) addedIndex = costumes.length - 1;
                target.sprite.deleteCostumeAt(addedIndex);
                added.name = finalName;
                target.sprite.addCostumeAt(added, Math.min(found.index, costumes.length));
                target.setCostume(Math.min(originalCurrent, costumes.length - 1));
                if (vm.runtime && typeof vm.runtime.emitProjectChanged === 'function') vm.runtime.emitProjectChanged();
                if (typeof vm.emitTargetsUpdate === 'function') vm.emitTargetsUpdate();
                this.prepareForExternalWorkspaceReset();
                return {
                    ok: true,
                    type,
                    target: this.getAiTargetSummary(target, {includeCostumes: false}),
                    costume: {index: found.index, name: finalName, oldName, oldMd5: getAiCostumeMd5(oldCostume), md5: added.md5},
                    svg: prepared.svg,
                    summary: target.isStage ? `已替换 SVG 背景：${finalName}` : `已替换 SVG 造型：${finalName}`
                };
            }
            if (type === 'create_bitmap_costume') {
                const resolved = this.resolveAiTarget(tool.targetId || (vm.editingTarget && vm.editingTarget.id));
                if (!resolved.target) return {ok: false, type, error: resolved.error};
                if (!tool.imageData) return {ok: false, type, error: '缺少 imageData 位图数据'};
                const existing = resolved.target.sprite && Array.isArray(resolved.target.sprite.costumes)
                    ? resolved.target.sprite.costumes.map(costume => costume && costume.name)
                    : [];
                const fallback = resolved.target.isStage ? 'backdrop1' : 'costume1';
                const name = getAiUnusedName(tool.costumeName || tool.name || fallback, existing);
                const prepared = await this.prepareAiBitmapCostume(name, tool.imageData, tool);
                if (!prepared.ok) return {ok: false, type, error: prepared.error};
                await vm.addCostume(prepared.costume.md5, prepared.costume, resolved.target.id);
                const fullTargetSummary = this.getAiTargetSummary(resolved.target);
                const targetSummary = this.getAiTargetSummary(resolved.target, {includeCostumes: false});
                const createdCostume = (fullTargetSummary.costumes || []).find(item => item.name === name) || {};
                const costumeNumber = createdCostume.index != null ? createdCostume.index + 1 : existing.length + 1;
                const costumeSummary = {
                    ...createdCostume,
                    name,
                    number: costumeNumber,
                    costumeNumber
                };
                this.prepareForExternalWorkspaceReset();
                return {
                    ok: true,
                    type,
                    target: targetSummary,
                    costume: costumeSummary,
                    image: prepared.image,
                    summary: resolved.target.isStage ?
                        `已创建位图背景：${name}（第 ${costumeNumber} 个背景）` :
                        `已创建位图造型：${name}（第 ${costumeNumber} 个造型）`
                };
            }
            if (type === 'replace_bitmap_costume') {
                const resolved = this.resolveAiTarget(tool.targetId || (vm.editingTarget && vm.editingTarget.id));
                if (!resolved.target) return {ok: false, type, error: resolved.error};
                if (!tool.imageData) return {ok: false, type, error: '缺少 imageData 位图数据'};
                const target = resolved.target;
                const costumes = target.sprite && Array.isArray(target.sprite.costumes) ? target.sprite.costumes : [];
                const found = this.resolveAiCostume(target, tool, true);
                if (found.error) return {ok: false, type, error: found.error};
                const oldCostume = found.costume;
                const oldName = oldCostume && oldCostume.name ? oldCostume.name : `costume${found.index + 1}`;
                const usedNames = costumes
                    .filter((costume, index) => index !== found.index && costume)
                    .map(costume => costume.name);
                const finalName = tool.newName ? getAiUnusedName(tool.newName, usedNames) : oldName;
                const tempName = getAiUnusedName(
                    `__ai_bitmap_${Date.now()}`,
                    costumes.map(costume => costume && costume.name)
                );
                const prepared = await this.prepareAiBitmapCostume(tempName, tool.imageData, tool);
                if (!prepared.ok) return {ok: false, type, error: prepared.error};
                const originalCurrent = typeof target.currentCostume === 'number' ? target.currentCostume : 0;
                await vm.addCostume(prepared.costume.md5, prepared.costume, target.id);
                const added = costumes[costumes.length - 1];
                if (!added) return {ok: false, type, error: '位图造型加载后未找到'};
                target.sprite.deleteCostumeAt(found.index);
                let addedIndex = costumes.indexOf(added);
                if (addedIndex < 0) addedIndex = costumes.length - 1;
                target.sprite.deleteCostumeAt(addedIndex);
                added.name = finalName;
                target.sprite.addCostumeAt(added, Math.min(found.index, costumes.length));
                target.setCostume(Math.min(originalCurrent, costumes.length - 1));
                if (vm.runtime && typeof vm.runtime.emitProjectChanged === 'function') vm.runtime.emitProjectChanged();
                if (typeof vm.emitTargetsUpdate === 'function') vm.emitTargetsUpdate();
                this.prepareForExternalWorkspaceReset();
                return {
                    ok: true,
                    type,
                    target: this.getAiTargetSummary(target, {includeCostumes: false}),
                    costume: {
                        index: found.index,
                        name: finalName,
                        oldName,
                        oldMd5: getAiCostumeMd5(oldCostume),
                        md5: added.md5
                    },
                    image: prepared.image,
                    summary: target.isStage ? `已替换位图背景：${finalName}` : `已替换位图造型：${finalName}`
                };
            }
            if (type === 'delete_costume') {
                const resolved = this.resolveAiTarget(tool.targetId || (vm.editingTarget && vm.editingTarget.id));
                if (!resolved.target) return {ok: false, type, error: resolved.error};
                const target = resolved.target;
                const costumes = target.sprite && Array.isArray(target.sprite.costumes) ? target.sprite.costumes : [];
                if (costumes.length <= 1) return {ok: false, type, error: '不能删除最后一个造型/背景'};
                const found = findAiCostumeIndex(target, tool.raw || tool);
                if (found.error) return {ok: false, type, error: found.error};
                const deletedName = costumes[found.index] && costumes[found.index].name;
                const label = target.isStage ? '背景' : '造型';
                const confirmed = tool.confirm === true || this.shouldSkipAiToolConfirmation() ||
                    await this.requestAiUserConfirmation(
                        `AI 请求删除${label}：${deletedName}\n` +
                        `所属目标：${getAiTargetName(target)}\n` +
                        '请在这里确认是否继续。'
                    );
                if (!confirmed) {
                    return {ok: false, type, cancelled: true, error: `用户取消删除${label}：${deletedName}`};
                }
                const deleted = target.deleteCostume(found.index);
                if (!deleted) return {ok: false, type, error: '删除造型/背景失败'};
                if (vm.runtime && typeof vm.runtime.emitProjectChanged === 'function') vm.runtime.emitProjectChanged();
                if (typeof vm.emitTargetsUpdate === 'function') vm.emitTargetsUpdate();
                this.prepareForExternalWorkspaceReset();
                return {
                    ok: true,
                    type,
                    target: this.getAiTargetSummary(target, {includeCostumes: false}),
                    costume: {index: found.index, name: deletedName},
                    summary: target.isStage ? `已删除背景：${deletedName}` : `已删除造型：${deletedName}`
                };
            }
            return {ok: false, type, error: '不支持的项目结构工具请求'};
        };

        getAiGreenFlagHatCount = () => {
            const targets = vm.runtime && Array.isArray(vm.runtime.targets)
                ? vm.runtime.targets
                : [];
            let count = 0;
            for (const target of targets) {
                const blocks = target && target.blocks && target.blocks._blocks;
                if (!blocks) continue;
                for (const blockId of Object.keys(blocks)) {
                    const block = blocks[blockId];
                    if (block && block.opcode === 'event_whenflagclicked') count++;
                }
            }
            return count;
        };

        findAiGreenFlagControl = () => {
            if (typeof document === 'undefined') return null;
            const selectors = [
                '[class*="controls_controls-container"] img[class*="green-flag_green-flag"]',
                'img[class*="green-flag_green-flag"]',
                '[class*="green-flag-overlay-wrapper"]',
                'img[title="Go"]',
                'img[title="运行"]',
                'img[title="开始"]',
                'img[title="绿旗"]',
                'img[aria-label="Go"]'
            ];
            const candidates = [];
            const seen = new Set();
            const push = element => {
                if (!element || seen.has(element)) return;
                seen.add(element);
                candidates.push(element);
            };
            for (const selector of selectors) {
                for (const element of Array.from(document.querySelectorAll(selector))) {
                    push(element);
                }
            }
            for (const element of Array.from(document.querySelectorAll('img'))) {
                const className = String(element.className || '');
                const src = String(element.getAttribute('src') || '');
                const title = String(element.getAttribute('title') || '');
                if (
                    className.indexOf('green-flag') >= 0 ||
                    src.indexOf('green-flag') >= 0 ||
                    title === 'Go' ||
                    title.indexOf('绿旗') >= 0
                ) {
                    push(element);
                }
            }
            return candidates.find(element => {
                if (!element || typeof element.getBoundingClientRect !== 'function') return false;
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            }) || null;
        };

        clickAiGreenFlagControl = () => {
            const element = this.findAiGreenFlagControl();
            if (!element) return {ok: false, error: '找不到界面上的绿旗按钮'};
            const label = String(element.getAttribute('title') || element.getAttribute('aria-label') || element.className || 'green flag');
            element.dispatchEvent(new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                view: window
            }));
            return {ok: true, label};
        };

        captureAiStartHats = callback => {
            const runtime = vm.runtime;
            const originalStartHats = runtime && runtime.startHats;
            const capture = {
                called: false,
                eventThreadCount: 0,
                totalThreadCount: 0,
                calls: []
            };
            if (typeof originalStartHats !== 'function') {
                callback();
                return capture;
            }
            const wrappedStartHats = function (...args) {
                const result = originalStartHats.apply(this, args);
                const opcode = String(args[0] || '');
                const threadCount = Array.isArray(result) ? result.length : 0;
                capture.calls.push({opcode, threadCount});
                capture.totalThreadCount += threadCount;
                if (opcode === 'event_whenflagclicked') {
                    capture.called = true;
                    capture.eventThreadCount += threadCount;
                }
                return result;
            };
            runtime.startHats = wrappedStartHats;
            try {
                callback();
            } finally {
                if (runtime.startHats === wrappedStartHats) {
                    runtime.startHats = originalStartHats;
                }
            }
            return capture;
        };

        waitAiRuntimeControlTick = () => new Promise(resolve => setTimeout(resolve, 60));

        getAiRuntimeStatus = () => {
            const state = addon.tab.redux && addon.tab.redux.state;
            const vmStatus = state && state.scratchGui && state.scratchGui.vmStatus;
            const threads = vm.runtime && Array.isArray(vm.runtime.threads)
                ? vm.runtime.threads
                : [];
            const nonMonitorThreadCount = threads.filter(thread => !(thread && thread.updateMonitor)).length;
            const frameLoopRunning = !!(vm.runtime && vm.runtime.frameLoop && vm.runtime.frameLoop.running);
            return {
                started: !!(vmStatus && vmStatus.started) || frameLoopRunning,
                running: vmStatus && typeof vmStatus.running === 'boolean'
                    ? vmStatus.running || nonMonitorThreadCount > 0
                    : nonMonitorThreadCount > 0,
                threadCount: threads.length,
                nonMonitorThreadCount,
                frameLoopRunning,
                greenFlagHatCount: this.getAiGreenFlagHatCount(),
                paused: isPaused()
            };
        };

        executeAiRuntimeControlTool = async tool => {
            const type = tool && tool.type;
            if (type === 'click_green_flag') {
                if (
                    typeof vm.greenFlag !== 'function' &&
                    (!vm.runtime || (
                        typeof vm.runtime.greenFlag !== 'function' &&
                        typeof vm.runtime.startHats !== 'function'
                    )) &&
                    !this.findAiGreenFlagControl()
                ) {
                    return {ok: false, type, error: '当前 VM 不支持点击绿旗'};
                }
                const before = this.getAiRuntimeStatus();
                const callPath = [];
                if (before.paused) setPaused(false);
                const invokeDirectGreenFlag = () => {
                    const current = this.getAiRuntimeStatus();
                    const didStartVm = !current.started && typeof vm.start === 'function';
                    if (didStartVm) {
                        vm.start();
                        callPath.push('vm.start');
                    }
                    if (typeof vm.greenFlag === 'function') {
                        vm.greenFlag();
                        callPath.push('vm.greenFlag');
                        return;
                    }
                    if (vm.runtime && typeof vm.runtime.greenFlag === 'function') {
                        vm.runtime.greenFlag();
                        callPath.push('runtime.greenFlag');
                    }
                };
                const mergeCapture = (target, source) => {
                    if (!source) return target;
                    target.called = target.called || source.called;
                    target.eventThreadCount += source.eventThreadCount || 0;
                    target.totalThreadCount += source.totalThreadCount || 0;
                    target.calls = target.calls.concat(source.calls || []);
                    return target;
                };
                let capture = {
                    called: false,
                    eventThreadCount: 0,
                    totalThreadCount: 0,
                    calls: []
                };
                let usedDomClick = false;
                try {
                    capture = mergeCapture(capture, this.captureAiStartHats(() => {
                        const clicked = this.clickAiGreenFlagControl();
                        if (clicked.ok) {
                            usedDomClick = true;
                            callPath.push(`dom.click:${clicked.label}`);
                        } else {
                            invokeDirectGreenFlag();
                        }
                    }));
                    if (
                        usedDomClick &&
                        !capture.called &&
                        (typeof vm.greenFlag === 'function' || (vm.runtime && typeof vm.runtime.greenFlag === 'function'))
                    ) {
                        capture = mergeCapture(capture, this.captureAiStartHats(invokeDirectGreenFlag));
                    }
                } catch (err) {
                    return {
                        ok: false,
                        type,
                        error: `点击绿旗失败：${err && err.message ? err.message : String(err)}`
                    };
                }
                let fallbackThreadCount = 0;
                if (
                    !capture.called &&
                    vm.runtime &&
                    typeof vm.runtime.startHats === 'function' &&
                    (before.greenFlagHatCount > 0 || this.getAiGreenFlagHatCount() > 0)
                ) {
                    const threads = vm.runtime.startHats('event_whenflagclicked') || [];
                    fallbackThreadCount = Array.isArray(threads) ? threads.length : 0;
                    callPath.push('runtime.startHats:fallback');
                }
                await this.waitAiRuntimeControlTick();
                const status = this.getAiRuntimeStatus();
                return {
                    ok: true,
                    type,
                    summary: '已点击绿旗。',
                    started: status.started || before.started || callPath.indexOf('vm.start') >= 0,
                    running: status.running,
                    paused: status.paused,
                    threadCount: status.threadCount,
                    nonMonitorThreadCount: status.nonMonitorThreadCount,
                    frameLoopRunning: status.frameLoopRunning,
                    greenFlagHatCount: status.greenFlagHatCount,
                    greenFlagStartedThreads: capture.eventThreadCount + fallbackThreadCount,
                    callPath
                };
            }
            if (type === 'click_pause') {
                const before = this.getAiRuntimeStatus();
                setPaused(true);
                const status = this.getAiRuntimeStatus();
                return {
                    ok: true,
                    type,
                    summary: before.paused ? '项目已经处于暂停状态。' : '已点击暂停。',
                    started: status.started,
                    running: status.running,
                    paused: status.paused,
                    threadCount: status.threadCount,
                    alreadyPaused: before.paused
                };
            }
            if (type === 'click_stop') {
                if (typeof vm.stopAll !== 'function' && (!vm.runtime || typeof vm.runtime.stopAll !== 'function')) {
                    return {ok: false, type, error: '当前 VM 不支持点击停止'};
                }
                if (isPaused()) setPaused(false);
                if (typeof vm.stopAll === 'function') vm.stopAll();
                else vm.runtime.stopAll();
                const status = this.getAiRuntimeStatus();
                return {
                    ok: true,
                    type,
                    summary: '已点击停止。',
                    started: status.started,
                    running: false,
                    paused: status.paused,
                    threadCount: status.threadCount
                };
            }
            return {ok: false, type, error: '不支持的运行控制工具请求'};
        };

        executeAiTool = async (tool, knownTargetTexts, currentText, messageId) => {
            if (!tool || (
                tool.type !== 'click_green_flag' &&
                tool.type !== 'click_pause' &&
                tool.type !== 'click_stop' &&
                tool.type !== 'get_pseudocode' &&
                tool.type !== 'get_target_info' &&
                tool.type !== 'get_costume_info' &&
                tool.type !== 'inspect_costume' &&
                tool.type !== 'get_stage_snapshot' &&
                tool.type !== 'list_extensions' &&
                tool.type !== 'load_extension' &&
                tool.type !== 'get_extension_blocks' &&
                tool.type !== 'search_text' &&
                tool.type !== 'create_sprite' &&
                tool.type !== 'delete_sprite' &&
                tool.type !== 'create_costume' &&
                tool.type !== 'delete_costume' &&
                tool.type !== 'create_svg_costume' &&
                tool.type !== 'replace_svg_costume' &&
                tool.type !== 'create_bitmap_costume' &&
                tool.type !== 'replace_bitmap_costume'
            )) {
                return {ok: false, error: '不支持的 AI 工具请求'};
            }
            if (
                tool.type === 'click_green_flag' ||
                tool.type === 'click_pause' ||
                tool.type === 'click_stop'
            ) {
                return this.executeAiRuntimeControlTool(tool);
            }
            if (
                tool.type === 'create_sprite' ||
                tool.type === 'delete_sprite' ||
                tool.type === 'create_costume' ||
                tool.type === 'delete_costume' ||
                tool.type === 'create_svg_costume' ||
                tool.type === 'replace_svg_costume' ||
                tool.type === 'create_bitmap_costume' ||
                tool.type === 'replace_bitmap_costume'
            ) {
                return this.executeAiProjectTool(tool);
            }
            const resolveRequestedTargets = targetIds => {
                const requested = (Array.isArray(targetIds) ? targetIds : [])
                    .map(item => String(item).trim())
                    .filter(Boolean);
                const allTargets = getAiTargets(vm);
                const wantsAll = !requested.length ||
                    requested.some(item => item === '*' || item.toLowerCase() === 'all');
                const keys = wantsAll ? allTargets.map(target => target.id) : requested;
                const targets = [];
                const errors = [];
                const seen = new Set();
                for (const requestedKey of keys) {
                    const resolved = this.resolveAiTarget(requestedKey);
                    if (!resolved.target) {
                        errors.push(resolved.error || `找不到角色: ${requestedKey}`);
                        continue;
                    }
                    if (seen.has(resolved.target.id)) continue;
                    seen.add(resolved.target.id);
                    targets.push(resolved.target);
                }
                return {targets, errors};
            };
            if (tool.type === 'list_extensions') {
                const result = await this.listAiExtensions(tool);
                if (messageId) this.addAiMessageDetail(messageId, '扩展列表', formatAiExtensionsDetail(result));
                return result;
            }
            if (tool.type === 'load_extension') {
                const result = await this.loadAiExtension(tool);
                if (messageId) this.addAiMessageDetail(messageId, '加载扩展结果', JSON.stringify(result, null, 2));
                return result;
            }
            if (tool.type === 'get_extension_blocks') {
                const result = getAiExtensionBlocks(vm, tool);
                if (messageId) this.addAiMessageDetail(messageId, '扩展 opcode 表', formatAiExtensionBlocksDetail(result));
                return result;
            }
            if (tool.type === 'get_stage_snapshot') {
                return this.getAiStageSnapshot();
            }
            if (tool.type === 'inspect_costume') {
                const targetKey = tool.targetId || (vm.editingTarget && vm.editingTarget.id);
                const resolved = this.resolveAiTarget(targetKey);
                if (!resolved.target) return {ok: false, type: 'inspect_costume', error: resolved.error};
                return this.inspectAiCostumeImage(resolved.target, tool);
            }
            if (tool.type === 'get_costume_info') {
                const requested = tool.targetIds && tool.targetIds.length
                    ? tool.targetIds
                    : [tool.targetId || (vm.editingTarget && vm.editingTarget.id)];
                const resolvedTargets = resolveRequestedTargets(requested);
                const targets = [];
                const errors = resolvedTargets.errors.slice();
                for (const target of resolvedTargets.targets) {
                    const result = await this.getAiCostumeInfo(target, tool);
                    if (result.ok) targets.push({target: result.target, costumes: result.costumes});
                    else errors.push(`${getAiTargetName(target)}: ${result.error}`);
                }
                if (messageId && targets.length) {
                    this.addAiMessageDetail(
                        messageId,
                        '已读取的造型/背景信息',
                        targets.map(item => {
                            const lines = (item.costumes || []).map(costume =>
                                `${costume.index}:${costume.name} (${costume.dataFormat || 'unknown'})${costume.svg ? `\n${costume.svg}` : ''}`
                            ).join('\n');
                            return `${item.target.targetRef} ${item.target.targetName}\n${lines}`;
                        }).join('\n\n')
                    );
                }
                if (errors.length) return {ok: false, type: 'get_costume_info', error: errors.join(' | '), targets};
                return {ok: true, type: 'get_costume_info', targets};
            }
            if (tool.type === 'get_target_info') {
                const resolvedTargets = resolveRequestedTargets(tool.targetIds);
                const targets = resolvedTargets.targets.map(target => this.getAiTargetSummary(target));
                if (messageId) {
                    this.addAiMessageDetail(
                        messageId,
                        '已读取的目标信息',
                        targets.map(item => {
                            const label = `${item.targetRef} ${item.targetName}`;
                            const costumes = (item.costumes || [])
                                .map(costume => `${costume.index}:${costume.name}`)
                                .join('、');
                            return `${label}\n类型：${item.targetType}\n造型/背景：${costumes || '无'}`;
                        }).join('\n\n')
                    );
                }
                if (resolvedTargets.errors.length) {
                    return {
                        ok: false,
                        type: 'get_target_info',
                        error: resolvedTargets.errors.join(' | '),
                        targets
                    };
                }
                return {ok: true, type: 'get_target_info', targets};
            }
            if (tool.type === 'search_text') {
                const resolvedTargets = resolveRequestedTargets(tool.targetIds);
                const matches = [];
                const errors = resolvedTargets.errors.slice();
                const targetsSearched = [];
                let totalMatches = 0;
                const maxResults = Math.min(200, Math.max(1, Number(tool.maxResults) || AI_SEARCH_RESULT_LIMIT));
                const searchOptions = {
                    caseSensitive: tool.caseSensitive,
                    regex: tool.regex,
                    maxResults
                };
                const searchCheck = searchAiPseudocodeLines('', tool.query, searchOptions);
                if (!searchCheck.ok) return {ok: false, type: 'search_text', error: searchCheck.error, matches};
                for (const target of resolvedTargets.targets) {
                    try {
                        const pseudocode = knownTargetTexts && knownTargetTexts.has(target.id)
                            ? knownTargetTexts.get(target.id)
                            : this.getTargetPseudocode(target, currentText);
                        const result = searchAiPseudocodeLines(pseudocode, tool.query, searchOptions);
                        if (!result.ok) {
                            errors.push(`${getAiTargetName(target)}: ${result.error}`);
                            continue;
                        }
                        const summary = this.getAiTargetSummary(target, {includeCostumes: false});
                        targetsSearched.push(summary);
                        totalMatches += result.totalMatches;
                        for (const match of result.matches) {
                            matches.push({
                                ...summary,
                                lineNumber: match.lineNumber,
                                column: match.column,
                                lineText: match.lineText
                            });
                        }
                    } catch (err) {
                        errors.push(`${getAiTargetName(target)}: ${err.message}`);
                    }
                }
                if (errors.length) return {ok: false, type: 'search_text', error: errors.join(' | '), matches};
                const limitedMatches = matches.slice(0, maxResults);
                const result = {
                    ok: true,
                    type: 'search_text',
                    query: tool.query,
                    caseSensitive: !!tool.caseSensitive,
                    regex: !!tool.regex,
                    totalMatches,
                    matches: limitedMatches,
                    truncated: totalMatches > limitedMatches.length,
                    targetsSearched
                };
                this.addAiMessageDetail(messageId, `查找结果 - ${tool.query}`, formatAiSearchResultDetail(result));
                return result;
            }
            const fetched = [];
            const snippets = [];
            const errors = [];
            const lineRanges = Array.isArray(tool.lineRanges) ? tool.lineRanges : [];
            if (lineRanges.length) {
                const genericRanges = lineRanges.filter(range => !(range && range.targetId));
                const targetSpecificRanges = lineRanges.filter(range => range && range.targetId);
                const targetRangeMap = new Map();
                const addRangeForTarget = (target, range) => {
                    if (!targetRangeMap.has(target.id)) {
                        targetRangeMap.set(target.id, {
                            target,
                            ranges: []
                        });
                    }
                    targetRangeMap.get(target.id).ranges.push(range);
                };
                for (const requested of tool.targetIds || []) {
                    const resolved = this.resolveAiTarget(requested);
                    if (!resolved.target) {
                        errors.push(resolved.error || `找不到角色: ${requested}`);
                        continue;
                    }
                    genericRanges.forEach(range => addRangeForTarget(resolved.target, range));
                }
                for (const range of targetSpecificRanges) {
                    const resolved = this.resolveAiTarget(range.targetId);
                    if (!resolved.target) {
                        errors.push(resolved.error || `找不到角色: ${range.targetId}`);
                        continue;
                    }
                    addRangeForTarget(resolved.target, range);
                }
                for (const {target, ranges} of targetRangeMap.values()) {
                    try {
                        const pseudocode = this.getAiToolPseudocodeText(target, knownTargetTexts, currentText);
                        const summary = this.getAiTargetSummary(target, {includeCostumes: false});
                        for (const range of ranges) {
                            const snippet = getAiPseudocodeLineSlice(pseudocode, range);
                            if (!snippet.ok) {
                                errors.push(`${getAiTargetName(target)}: ${snippet.error}`);
                                continue;
                            }
                            const item = {
                                ...summary,
                                startLine: snippet.startLine,
                                endLine: snippet.endLine,
                                totalLines: snippet.totalLines,
                                pseudocode: snippet.pseudocode,
                                lines: snippet.lines
                            };
                            snippets.push(item);
                            this.addAiPseudocodeSnippetDetail(messageId, item);
                        }
                    } catch (err) {
                        errors.push(`${getAiTargetName(target)}: ${err.message}`);
                    }
                }
                if (errors.length) {
                    return {ok: false, type: 'get_pseudocode', mode: 'snippet', error: errors.join(' | '), fetched, snippets};
                }
                return {ok: true, type: 'get_pseudocode', mode: 'snippet', fetched, snippets};
            }
            for (const requested of tool.targetIds || []) {
                const resolved = this.resolveAiTarget(requested);
                if (!resolved.target) {
                    errors.push(resolved.error || `找不到角色: ${requested}`);
                    continue;
                }
                const target = resolved.target;
                if (knownTargetTexts.has(target.id)) {
                    fetched.push({...this.getAiTargetSummary(target, {includeCostumes: false}), cached: true});
                    continue;
                }
                try {
                    const pseudocode = this.getTargetPseudocode(target, currentText);
                    knownTargetTexts.set(target.id, pseudocode);
                    const summary = this.getAiTargetSummary(target, {includeCostumes: false});
                    fetched.push(summary);
                    this.addAiMessageDetail(messageId, `已读取的伪代码 - ${summary.targetName}`, pseudocode);
                } catch (err) {
                    errors.push(`${getAiTargetName(target)}: ${err.message}`);
                }
            }
            if (errors.length) return {ok: false, type: 'get_pseudocode', error: errors.join(' | '), fetched};
            return {ok: true, type: 'get_pseudocode', fetched};
        };

        normalizeAiEditPayload = (payload, knownTargetTexts) => {
            const currentTarget = vm.editingTarget;
            if (!currentTarget) return {ok: false, error: '没有选中的角色或舞台', applications: []};
            const rawEdits = Array.isArray(payload && payload.edits)
                ? payload.edits
                : [{
                    ...(payload || {}),
                    targetId: (payload && (payload.targetRef || payload.targetId || payload.targetName)) || currentTarget.id,
                    mode: (payload && payload.mode) || (payload && payload.patches ? 'patch' : 'replace')
                }];
            const applications = [];
            const seen = new Set();
            for (const rawEdit of rawEdits) {
                const targetKey = rawEdit && (
                    rawEdit.targetRef ||
                    rawEdit.targetId ||
                    rawEdit.targetName ||
                    rawEdit.name ||
                    currentTarget.id
                );
                const resolved = this.resolveAiTarget(targetKey);
                if (!resolved.target) return {ok: false, error: resolved.error, applications};
                const target = resolved.target;
                if (seen.has(target.id)) return {ok: false, error: `同一角色被重复修改: ${getAiTargetName(target)}`, applications};
                seen.add(target.id);
                const targetName = getAiTargetName(target);
                const baseText = knownTargetTexts.has(target.id)
                    ? knownTargetTexts.get(target.id)
                    : this.getTargetPseudocode(target);
                const mode = String((rawEdit && rawEdit.mode) || (rawEdit && rawEdit.pseudocode ? 'replace' : 'patch'));
                let pseudocode;
                if (mode === 'patch') {
                    const patchResult = applyAiLinePatches(baseText, rawEdit && rawEdit.patches);
                    if (!patchResult.ok) {
                        return {
                            ok: false,
                            error: `${targetName}: ${patchResult.error}`,
                            applications
                        };
                    }
                    pseudocode = patchResult.text;
                } else if (mode === 'replace') {
                    if (!rawEdit || typeof rawEdit.pseudocode !== 'string') {
                        return {ok: false, error: `${targetName}: replace 修改缺少 pseudocode`, applications};
                    }
                    pseudocode = rawEdit.pseudocode;
                } else {
                    return {ok: false, error: `${targetName}: 不支持的修改模式 ${mode}`, applications};
                }
                applications.push({
                    target,
                    targetRef: this.getAiTargetRef(target),
                    targetId: target.id,
                    targetName,
                    mode,
                    patches: (rawEdit && rawEdit.patches) || [],
                    summary: (rawEdit && rawEdit.summary) || '',
                    baseText,
                    pseudocode
                });
            }
            return {ok: true, applications};
        };

        extractAiRawDraftApplications = (payload, knownTargetTexts) => {
            const currentTarget = vm.editingTarget;
            const rawEdits = Array.isArray(payload && payload.edits)
                ? payload.edits
                : [payload || {}];
            const applications = [];
            for (const rawEdit of rawEdits) {
                if (!rawEdit || typeof rawEdit !== 'object') continue;
                const targetKey = rawEdit.targetRef ||
                    rawEdit.targetId ||
                    rawEdit.targetName ||
                    rawEdit.name ||
                    (currentTarget && currentTarget.id) ||
                    '';
                const resolved = targetKey ? this.resolveAiTarget(targetKey) : {target: null};
                const target = resolved.target || null;
                const targetName = target
                    ? getAiTargetName(target)
                    : String(rawEdit.targetName || rawEdit.targetRef || rawEdit.targetId || rawEdit.name || '未知目标');
                let baseText = '';
                if (target) {
                    try {
                        baseText = knownTargetTexts && knownTargetTexts.has(target.id)
                            ? knownTargetTexts.get(target.id)
                            : this.getTargetPseudocode(target);
                    } catch (_) {
                        baseText = '';
                    }
                }
                let pseudocode = '';
                if (typeof rawEdit.pseudocode === 'string') {
                    pseudocode = rawEdit.pseudocode;
                } else if (Array.isArray(rawEdit.patches)) {
                    pseudocode = formatAiPatchDraftPreview(rawEdit.patches);
                } else {
                    try {
                        pseudocode = JSON.stringify(rawEdit, null, 2);
                    } catch (_) {
                        pseudocode = String(rawEdit);
                    }
                }
                if (!String(pseudocode || '').trim()) continue;
                applications.push({
                    target,
                    targetRef: target ? this.getAiTargetRef(target) : String(rawEdit.targetRef || ''),
                    targetId: target ? target.id : String(rawEdit.targetId || ''),
                    targetName,
                    mode: rawEdit.mode || (rawEdit.pseudocode ? 'replace' : (rawEdit.patches ? 'patch' : 'unknown')),
                    patches: rawEdit.patches || [],
                    summary: rawEdit.summary || '',
                    baseText,
                    pseudocode
                });
            }
            return applications;
        };

        prepareAiEditPayload = (payload, knownTargetTexts) => {
            const normalized = this.normalizeAiEditPayload(payload, knownTargetTexts);
            if (!normalized.ok) return normalized;
            const errors = [];
            for (const app of normalized.applications) {
                const checked = this.validatePseudoText(app.pseudocode, app.target);
                if (!checked.ok) {
                    errors.push({
                        targetRef: app.targetRef,
                        targetId: app.targetId,
                        targetName: app.targetName,
                        errors: checked.errors,
                        pseudocode: app.pseudocode
                    });
                    continue;
                }
                app.parsed = checked.result;
                app.meta = this.createPseudoMeta(checked.result);
            }
            if (errors.length) {
                return {ok: false, error: this.formatAiApplicationErrors(errors), applications: normalized.applications, errors};
            }
            return normalized;
        };

        formatAiApplicationErrors = errors => (errors || [])
            .map(item => `${item.targetName}:\n${formatPseudoErrors(item.errors)}`)
            .join('\n\n');

        addAiApplicationDetails = (messageId, titlePrefix, applications) => {
            let shown = 0;
            for (const app of applications || []) {
                if (!app || !app.pseudocode) continue;
                const isFinal = titlePrefix === '最终生成的伪代码' || titlePrefix === '已应用的伪代码';
                this.addAiMessageDetail(messageId, `${titlePrefix} - ${app.targetName}`, app.pseudocode, isFinal ? {
                    key: 'pseudocode-diff',
                    kind: 'pseudocode-diff',
                    diff: buildAiLineDiffRows(app.baseText || '', app.pseudocode)
                } : null);
                shown++;
            }
            return shown;
        };

        applyAiApplications = applications => {
            const currentTargetId = vm.editingTarget && vm.editingTarget.id;
            let currentApplication = null;
            const loadedExtensions = [];
            for (const app of applications) {
                const result = this.applyBlocksToWorkspace(app.parsed.blocks, app.meta, app.target, {forcePseudo: true});
                if (!result.ok) return {ok: false, error: `${app.targetName}: ${result.error}`};
                for (const extension of result.loadedExtensions || []) {
                    if (!loadedExtensions.some(item => item && item.id === extension.id)) loadedExtensions.push(extension);
                }
                if (app.targetId === currentTargetId) currentApplication = app;
            }
            if (currentApplication) {
                const editor = this.jsonEditorComponent.current;
                if (editor) {
                    editor.setText(currentApplication.pseudocode);
                    if (typeof editor.closeAutocomplete === 'function') editor.closeAutocomplete();
                    this.editorTargetId = currentApplication.targetId;
                    this.dirty = false;
                    this.lastAppliedBlocksJson = JSON.stringify(currentApplication.parsed.blocks) +
                        '|' + this.getPseudoMetaSummary(currentApplication.meta);
                }
            }
            return {ok: true, loadedExtensions};
        };

        submitAiChat = async () => {
            if (this.state.aiBusy) {
                this.aiUserAborted = true;
                this.addAiProcessStep(this.aiActiveMessageId, '用户点击中断，请求已停止。');
                this.abortAiRequest();
                if (this.aiActiveMessageId) {
                    this.updateAiChatMessage(this.aiActiveMessageId, {pending: false});
                }
                this.addAiStatusMessage('已中断。');
                this.setInfo('已中断 AI 请求。');
                this.setState({aiBusy: false});
                return;
            }
            if (this.state.mode !== 'pseudo') {
                this.setError('AI 聊天只在伪代码模式下工作。');
                return;
            }
            const input = this.aiInputRef.current;
            const instruction = input ? input.value.trim() : '';
            if (!instruction) return;
            const config = this.state.aiConfig;
            if (!this.state.aiConfigReady || !hasAiConfig(config)) {
                this.setError('请先配置并检测 AI 接口。');
                this.setState({aiConfigPanelOpen: true});
                return;
            }
            const editor = this.jsonEditorComponent.current;
            if (!editor) return;
            const target = vm.editingTarget;
            if (!target) {
                this.setError('没有选中的角色或舞台。');
                return;
            }
            if (input) input.value = '';
            this.cancelPendingApply();
            this.addAiChatMessage('user', instruction);
            let currentAssistantMessageId = null;
            this.aiActiveMessageId = null;
            this.aiUserAborted = false;
            this.aiProcessStartedAt = Date.now();
            this.aiProcessLines = [];
            this.setState({aiBusy: true});
            this.setInfo('AI 正在思考...');
            this.aiAbortController = new AbortController();
            const throwIfAborted = () => {
                if (this.aiUserAborted || !this.aiAbortController || this.aiAbortController.signal.aborted) {
                    const err = new Error('Aborted');
                    err.name = 'AbortError';
                    throw err;
                }
            };
            try {
                const currentText = editor.getText() || '';
                const knownTargetTexts = new Map([[target.id, currentText]]);
                let feedback = null;
                let repairAttempts = 0;
                let hiddenParseAttempts = 0;
                let toolRounds = 0;
                const projectOperationHistory = [];
                const editOperationHistory = [];
                const requestOnce = async () => {
                    const messageId = this.addAiChatMessage('assistant', '', {pending: true});
                    currentAssistantMessageId = messageId;
                    this.aiActiveMessageId = messageId;
                    let visibleStarted = false;
                    let hiddenStatusId = null;
                    const getHiddenStatusText = type => {
                        if (type === 'edit') return 'AI 正在生成修改动作...';
                        if (type === 'tool' || type === 'provider_tool') return 'AI 正在生成工具请求...';
                        return 'AI 正在生成动作...';
                    };
                    const getHiddenDoneText = (type, completed) => {
                        if (!completed) {
                            if (type === 'edit') return 'AI 修改动作没有完整生成，准备重试。';
                            if (type === 'tool' || type === 'provider_tool') return 'AI 工具请求没有完整生成，准备重试。';
                            return 'AI 动作没有完整生成，准备重试。';
                        }
                        if (type === 'edit') return 'AI 已生成修改动作，准备校验。';
                        if (type === 'tool' || type === 'provider_tool') return 'AI 已生成工具请求，准备执行。';
                        return 'AI 已生成动作，准备执行。';
                    };
                    this.addAiProcessStep(messageId, this.aiProcessLines.length
                        ? '继续发送请求，等待 AI 回复。'
                        : '收到请求，准备发送给 AI。');
                    this.addAiProcessStep(messageId, '已发送请求，等待 AI 回复。');
                    const response = await requestAiText(
                        config,
                        this.buildAiMessages(instruction, knownTargetTexts, feedback, {
                            completedProjectOperations: projectOperationHistory.slice(),
                            completedEditOperations: editOperationHistory.slice()
                        }),
                        this.aiAbortController.signal,
                        delta => {
                            if (!visibleStarted) {
                                visibleStarted = true;
                                this.addAiProcessStep(messageId, '开始收到 AI 可见回复。');
                            }
                            this.appendAiVisibleDelta(messageId, delta);
                        },
                        type => {
                            this.addAiProcessStep(
                                messageId,
                                type === 'edit'
                                    ? '开始接收隐藏修改块。'
                                    : (type === 'tool' || type === 'provider_tool'
                                        ? '开始接收隐藏工具请求。'
                                        : '开始接收隐藏动作块。')
                            );
                            hiddenStatusId = this.addAiStatusMessage(getHiddenStatusText(type));
                        },
                        delta => this.appendAiReasoningDelta(messageId, delta),
                        (type, completed) => {
                            this.addAiProcessStep(
                                messageId,
                                completed
                                    ? '隐藏动作块接收完成。'
                                    : '隐藏动作块未完整接收。'
                            );
                            if (hiddenStatusId) {
                                this.updateAiChatMessage(hiddenStatusId, {
                                    text: getHiddenDoneText(type, completed)
                                });
                            }
                        },
                        retry => {
                            const delaySeconds = Math.max(1, Math.ceil((retry.delay || 0) / 1000));
                            const errorMessage = retry.error && retry.error.message ? retry.error.message : 'unknown error';
                            const retryText = `AI 请求失败，${delaySeconds} 秒后自动重试（${retry.attempt}/${retry.maxRetries}）：${errorMessage}`;
                            this.addAiProcessStep(messageId, retryText);
                            this.addAiStatusMessage(retryText);
                            this.setInfo(`AI 请求失败，正在自动重试 ${retry.attempt}/${retry.maxRetries}...`);
                        }
                    );
                    if (hiddenStatusId && response.action && response.action.missingCloseAccepted) {
                        this.updateAiChatMessage(hiddenStatusId, {
                            text: 'AI 动作 JSON 已完整，缺少结束标签，已按完整动作处理。'
                        });
                    }
                    this.updateAiChatMessage(messageId, {pending: false});
                    return {response, messageId};
                };
                const isAiProjectTool = tool => tool && (
                    tool.type === 'create_sprite' ||
                    tool.type === 'delete_sprite' ||
                    tool.type === 'create_costume' ||
                    tool.type === 'delete_costume' ||
                    tool.type === 'create_svg_costume' ||
                    tool.type === 'replace_svg_costume' ||
                    tool.type === 'create_bitmap_costume' ||
                    tool.type === 'replace_bitmap_costume'
                );
                const getAiToolStatusText = (tool, index, total) => {
                    const prefix = total > 1 ? `AI 正在执行工具 ${index + 1}/${total}：` : '';
                    if (tool && tool.type === 'search_text') return `${prefix}查找：${tool.query || ''}`;
                    if (tool && tool.type === 'get_target_info') return `${prefix}查看目标信息`;
                    if (tool && tool.type === 'get_costume_info') return `${prefix}查看造型/背景信息`;
                    if (tool && tool.type === 'inspect_costume') return `${prefix}查看造型/背景图片`;
                    if (tool && tool.type === 'get_stage_snapshot') return `${prefix}获取舞台截图`;
                    if (tool && tool.type === 'list_extensions') return `${prefix}查看扩展列表`;
                    if (tool && tool.type === 'load_extension') return `${prefix}加载扩展${tool.extensionId ? `：${tool.extensionId}` : ''}`;
                    if (tool && tool.type === 'get_extension_blocks') return `${prefix}查看扩展 opcode 表${tool.extensionId ? `：${tool.extensionId}` : ''}`;
                    if (tool && tool.type === 'click_green_flag') return `${prefix}点击绿旗`;
                    if (tool && tool.type === 'click_pause') return `${prefix}点击暂停`;
                    if (tool && tool.type === 'click_stop') return `${prefix}点击停止`;
                    if (tool && tool.type === 'get_pseudocode') return `${prefix}查看伪代码`;
                    if (tool && tool.type === 'create_sprite') return `${prefix}创建角色${tool.name ? `：${tool.name}` : ''}`;
                    if (tool && tool.type === 'delete_sprite') return `${prefix}删除角色`;
                    if (tool && tool.type === 'create_costume') return `${prefix}创建造型/背景${tool.name ? `：${tool.name}` : ''}`;
                    if (tool && tool.type === 'create_svg_costume') return `${prefix}创建 SVG 造型/背景${tool.name ? `：${tool.name}` : ''}`;
                    if (tool && tool.type === 'replace_svg_costume') return `${prefix}替换 SVG 造型/背景`;
                    if (tool && tool.type === 'create_bitmap_costume') return `${prefix}创建位图造型/背景${tool.name ? `：${tool.name}` : ''}`;
                    if (tool && tool.type === 'replace_bitmap_costume') return `${prefix}替换位图造型/背景`;
                    if (tool && tool.type === 'delete_costume') return `${prefix}删除造型/背景`;
                    return `${prefix}处理工具请求`;
                };
                const executeOneAiToolAction = async (tool, index, total, messageId) => {
                    const isSearchTool = tool && tool.type === 'search_text';
                    const isProjectTool = isAiProjectTool(tool);
                    const isTargetInfoTool = tool && tool.type === 'get_target_info';
                    const isCostumeInfoTool = tool && tool.type === 'get_costume_info';
                    const isVisionTool = tool && (tool.type === 'inspect_costume' || tool.type === 'get_stage_snapshot');
                    const isRuntimeControlTool = tool && (
                        tool.type === 'click_green_flag' ||
                        tool.type === 'click_pause' ||
                        tool.type === 'click_stop'
                    );
                    const isExtensionTool = tool && (
                        tool.type === 'list_extensions' ||
                        tool.type === 'load_extension' ||
                        tool.type === 'get_extension_blocks'
                    );
                    const statusId = this.addAiStatusMessage(getAiToolStatusText(tool, index, total));
                    this.addAiToolCallDetail(statusId, tool, index, total);
                    const toolResult = await this.executeAiTool(tool, knownTargetTexts, currentText, statusId);
                    throwIfAborted();
                    this.addAiToolResultDetail(statusId, tool, toolResult, index, total);
                    if (toolResult.ok) {
                        if (toolResult.type === 'search_text') {
                            const hitText = toolResult.totalMatches
                                ? `${toolResult.totalMatches} 条命中`
                                : '未找到';
                            this.addAiProcessStep(messageId, `已查找文本：${toolResult.query}，${hitText}`);
                            this.updateAiChatMessage(statusId, {
                                text: `AI 查找：${toolResult.query}（${hitText}）`
                            });
                            return {
                                ok: true,
                                feedbackItem: {
                                    kind: 'tool_result',
                                    toolType: 'search_text',
                                    ok: true,
                                    query: toolResult.query,
                                    caseSensitive: toolResult.caseSensitive,
                                    regex: toolResult.regex,
                                    totalMatches: toolResult.totalMatches,
                                    truncated: toolResult.truncated,
                                    targetsSearched: toolResult.targetsSearched,
                                    matches: toolResult.matches
                                }
                            };
                        }
                        if (isCostumeInfoTool) {
                            const labels = (toolResult.targets || [])
                                .map(item => item && item.target ? `${item.target.targetRef || ''} ${item.target.targetName || ''}`.trim() : '')
                                .filter(Boolean);
                            this.addAiProcessStep(messageId, `已读取造型/背景信息：${labels.join('、') || '无'}`);
                            this.updateAiChatMessage(statusId, {
                                text: labels.length
                                    ? `AI 已查看造型/背景信息：${labels.join('、')}`
                                    : 'AI 请求的造型/背景信息为空。'
                            });
                            return {
                                ok: true,
                                feedbackItem: {
                                    kind: 'tool_result',
                                    toolType: 'get_costume_info',
                                    ok: true,
                                    targets: toolResult.targets || []
                                }
                            };
                        }
                        if (isVisionTool) {
                            const label = toolResult.type === 'get_stage_snapshot'
                                ? '舞台截图'
                                : (toolResult.imageAttachment && toolResult.imageAttachment.label) || '造型图片';
                            this.addAiProcessStep(messageId, `已获取图片：${label}`);
                            this.updateAiChatMessage(statusId, {
                                text: `AI 已获取图片：${label}`
                            });
                            return {
                                ok: true,
                                feedbackItem: {
                                    kind: 'tool_result',
                                    toolType: toolResult.type,
                                    ok: true,
                                    target: toolResult.target || null,
                                    costume: toolResult.costume || null,
                                    stage: toolResult.stage || null,
                                    imageAttachment: toolResult.imageAttachment || null
                                }
                            };
                        }
                        if (isExtensionTool) {
                            const summary = toolResult.type === 'list_extensions'
                                ? `AI 已查看扩展列表：${(toolResult.loaded || []).length} 个已加载`
                                : (toolResult.type === 'get_extension_blocks'
                                    ? `AI 已查看扩展 opcode 表：${toolResult.returnedBlocks || 0} 个积木`
                                    : (toolResult.summary || `已加载扩展：${toolResult.extension && toolResult.extension.id || tool.extensionId || ''}`));
                            this.addAiProcessStep(messageId, summary);
                            this.updateAiChatMessage(statusId, {text: summary});
                            return {
                                ok: true,
                                feedbackItem: {
                                    kind: 'tool_result',
                                    toolType: toolResult.type || tool.type,
                                    ok: true,
                                    loaded: toolResult.loaded || null,
                                    extensions: toolResult.extensions || null,
                                    total: toolResult.total || null,
                                    totalBlocks: toolResult.totalBlocks || null,
                                    matchedBlocks: toolResult.matchedBlocks || null,
                                    returnedBlocks: toolResult.returnedBlocks || null,
                                    truncated: !!toolResult.truncated,
                                    remoteError: toolResult.remoteError || null,
                                    extension: toolResult.extension || null,
                                    newLoadedIds: toolResult.newLoadedIds || null,
                                    nextSuggestedAction: toolResult.nextSuggestedAction || null,
                                    alreadyLoaded: !!toolResult.alreadyLoaded,
                                    summary
                                }
                            };
                        }
                        if (isProjectTool) {
                            const operationRecord = {
                                type: toolResult.type || tool.type,
                                summary: toolResult.summary || '',
                                target: toolResult.target || null,
                                costume: toolResult.costume || null,
                                image: toolResult.image || null
                            };
                            projectOperationHistory.push(operationRecord);
                            this.addAiProcessStep(messageId, toolResult.summary || '已完成项目结构操作。');
                            this.updateAiChatMessage(statusId, {
                                text: toolResult.summary || '已完成项目结构操作。'
                            });
                            if (toolResult.svg) {
                                this.addAiMessageDetail(statusId, '生成的 SVG', toolResult.svg);
                            }
                            return {
                                ok: true,
                                feedbackItem: {
                                    kind: 'tool_result',
                                    toolType: operationRecord.type,
                                    ok: true,
                                    summary: operationRecord.summary,
                                    target: operationRecord.target,
                                    costume: operationRecord.costume,
                                    image: operationRecord.image,
                                    svgLength: toolResult.svg ? toolResult.svg.length : 0,
                                    projectOperationProgress: {
                                        completed: projectOperationHistory.slice()
                                    },
                                    completed: true,
                                    guidance: 'This project structure operation has already been executed in the live project. Use projectOperationProgress.completed and current context.targets to decide whether the user requested more separate items. If more items remain, output one next ACTION and batch independent remaining actions when practical. If nothing remains, answer normally with no hidden action.'
                                }
                            };
                        }
                        if (isRuntimeControlTool) {
                            const summary = toolResult.summary || '已完成运行控制操作。';
                            this.addAiProcessStep(messageId, summary);
                            this.updateAiChatMessage(statusId, {text: summary});
                            return {
                                ok: true,
                                feedbackItem: {
                                    kind: 'tool_result',
                                    toolType: toolResult.type || tool.type,
                                    ok: true,
                                    summary,
                                    started: !!toolResult.started,
                                    running: !!toolResult.running,
                                    paused: !!toolResult.paused,
                                    threadCount: toolResult.threadCount || 0,
                                    nonMonitorThreadCount: toolResult.nonMonitorThreadCount || 0,
                                    frameLoopRunning: !!toolResult.frameLoopRunning,
                                    greenFlagHatCount: toolResult.greenFlagHatCount || 0,
                                    greenFlagStartedThreads: toolResult.greenFlagStartedThreads || 0,
                                    callPath: toolResult.callPath || null,
                                    alreadyPaused: !!toolResult.alreadyPaused
                                }
                            };
                        }
                        if (isTargetInfoTool) {
                            const names = (toolResult.targets || [])
                                .map(item => `${item.targetRef || ''} ${item.targetName || ''}`.trim())
                                .filter(Boolean);
                            this.addAiProcessStep(messageId, `已读取目标信息：${names.join('、') || '无'}`);
                            this.updateAiChatMessage(statusId, {
                                text: names.length
                                    ? `AI 已查看目标信息：${names.join('、')}`
                                    : 'AI 请求的目标信息为空。'
                            });
                            return {
                                ok: true,
                                feedbackItem: {
                                    kind: 'tool_result',
                                    toolType: 'get_target_info',
                                    ok: true,
                                    targets: toolResult.targets || []
                                }
                            };
                        }
                        const snippets = Array.isArray(toolResult.snippets) ? toolResult.snippets : [];
                        if (toolResult.mode === 'snippet') {
                            const labels = snippets.map(item =>
                                `${item.targetRef ? `${item.targetRef} ` : ''}${item.targetName} 第 ${item.startLine}-${item.endLine} 行`
                            );
                            this.addAiProcessStep(messageId, `已读取伪代码片段：${labels.join('、') || '无新增'}`);
                            this.updateAiChatMessage(statusId, {
                                text: labels.length
                                    ? `AI 已查看：${labels.join('、')}`
                                    : 'AI 请求的伪代码片段为空。'
                            });
                            return {
                                ok: true,
                                feedbackItem: {
                                    kind: 'tool_result',
                                    toolType: 'get_pseudocode',
                                    mode: 'snippet',
                                    ok: true,
                                    snippets
                                }
                            };
                        }
                        const names = toolResult.fetched
                            .map(item => `${item.targetRef || ''} ${item.targetName || ''}`.trim())
                            .filter(Boolean);
                        this.addAiProcessStep(messageId, `已读取角色伪代码：${names.join('、') || '无新增'}`);
                        this.updateAiChatMessage(statusId, {
                            text: names.length
                                ? `AI 已查看：${names.join('、')}`
                                : 'AI 请求的角色伪代码已经在上下文里。'
                        });
                        return {
                            ok: true,
                            feedbackItem: {
                                kind: 'tool_result',
                                toolType: 'get_pseudocode',
                                mode: 'full',
                                ok: true,
                                fetched: toolResult.fetched
                            }
                        };
                    }
                    this.addAiProcessStep(messageId, `工具请求失败：${toolResult.error}`);
                    this.updateAiChatMessage(statusId, {
                        text: toolResult.cancelled
                            ? toolResult.error
                            : (isSearchTool
                                ? `查找失败：${toolResult.error}`
                                : (isProjectTool ? `项目结构操作未完成：${toolResult.error}` :
                                        (isTargetInfoTool ? `读取目标信息失败：${toolResult.error}` :
                                            (isCostumeInfoTool ? `读取造型/背景信息失败：${toolResult.error}` :
                                                (isVisionTool ? `读取图片失败：${toolResult.error}` :
                                                    (isRuntimeControlTool ? `运行控制失败：${toolResult.error}` :
                                                        (isExtensionTool ? `扩展工具失败：${toolResult.error}` : `读取角色失败：${toolResult.error}`)))))))
                    });
                    return {
                        ok: false,
                        cancelled: !!toolResult.cancelled,
                        feedbackItem: {
                            kind: 'tool_result',
                            toolType: isSearchTool ? 'search_text' :
                                (isProjectTool ? tool.type :
                                    (isTargetInfoTool ? 'get_target_info' :
                                        (isCostumeInfoTool ? 'get_costume_info' :
                                            (isVisionTool ? tool.type :
                                                (isRuntimeControlTool ? tool.type :
                                                    (isExtensionTool ? tool.type : 'get_pseudocode')))))),
                            ok: false,
                            error: toolResult.error,
                            targets: toolResult.targets || [],
                            fetched: toolResult.fetched || [],
                            snippets: toolResult.snippets || [],
                            matches: toolResult.matches || [],
                            stage: toolResult.stage || null
                        }
                    };
                };
                const executeOneAiEditAction = async (editPayload, messageId) => {
                    const editTraceTool = {
                        type: 'edit_pseudocode',
                        payload: editPayload || {}
                    };
                    const statusId = this.addAiStatusMessage(
                        repairAttempts
                            ? 'AI 正在校验修复后的伪代码...'
                            : 'AI 正在校验伪代码修改...'
                    );
                    this.addAiToolCallDetail(statusId, editTraceTool, 0, 1);
                    this.addAiProcessStep(messageId, '检测到伪代码修改动作，开始合成和校验伪代码。');
                    const prepared = this.prepareAiEditPayload(editPayload, knownTargetTexts);
                    if (!prepared.ok) {
                        this.addAiProcessStep(messageId, `草稿未通过校验：${prepared.error}`);
                        const draftTitle = repairAttempts
                            ? `第 ${repairAttempts + 1} 次修复草稿（仍未通过解析）`
                            : '未通过解析的草稿伪代码';
                        const shownDrafts = this.addAiApplicationDetails(statusId, draftTitle, prepared.applications);
                        if (!shownDrafts) {
                            this.addAiApplicationDetails(
                                statusId,
                                `${draftTitle}（原始修改内容）`,
                                this.extractAiRawDraftApplications(editPayload, knownTargetTexts)
                            );
                        }
                        repairAttempts++;
                        this.addAiToolResultDetail(statusId, editTraceTool, {
                            ok: false,
                            error: prepared.error,
                            parseErrors: prepared.errors || null,
                            repairAttempt: repairAttempts
                        }, 0, 1);
                        this.updateAiChatMessage(statusId, {
                            text: repairAttempts === 1
                                ? '草稿没有通过解析，我正在把错误信息发回 AI 修复。'
                                : `第 ${repairAttempts} 次草稿仍未通过解析，我会继续把错误信息发回 AI 修复。`
                        });
                        return {
                            ok: false,
                            repair: true,
                            feedbackItem: {
                                kind: 'repair',
                                previousPayload: editPayload,
                                error: prepared.error,
                                parseErrors: prepared.errors || null,
                                repairAttempt: repairAttempts
                            }
                        };
                    }
                    throwIfAborted();
                    this.addAiProcessStep(messageId, '所有角色伪代码校验通过，准备应用。');
                    const applyResult = this.applyAiApplications(prepared.applications);
                    if (!applyResult.ok) {
                        repairAttempts++;
                        this.addAiApplicationDetails(
                            statusId,
                            repairAttempts === 1
                                ? '应用前校验失败的草稿伪代码'
                                : `第 ${repairAttempts} 次应用前校验失败草稿`,
                            prepared.applications
                        );
                        this.addAiToolResultDetail(statusId, editTraceTool, {
                            ok: false,
                            error: applyResult.error,
                            repairAttempt: repairAttempts
                        }, 0, 1);
                        this.updateAiChatMessage(statusId, {
                            text: repairAttempts === 1
                                ? '应用前校验失败，我正在把错误信息发回 AI 修复。'
                                : `第 ${repairAttempts} 次应用前校验失败，我会继续把错误信息发回 AI 修复。`
                        });
                        return {
                            ok: false,
                            repair: true,
                            feedbackItem: {
                                kind: 'repair',
                                previousPayload: editPayload,
                                error: applyResult.error,
                                repairAttempt: repairAttempts
                            }
                        };
                    }
                    if (applyResult.loadedExtensions && applyResult.loadedExtensions.length) {
                        const loadedText = formatAiLoadedExtensions(applyResult.loadedExtensions);
                        this.addAiProcessStep(messageId, `已自动加载扩展：${loadedText}`);
                        this.addAiMessageDetail(statusId, '自动加载的扩展', loadedText);
                    }
                    const summary = (editPayload && editPayload.summary) || '';
                    const appliedText = formatAiAppliedMultiResult(summary, prepared.applications);
                    this.addAiApplicationDetails(statusId, '已应用的伪代码', prepared.applications);
                    this.updateAiChatMessage(statusId, {text: appliedText});
                    this.addAiProcessStep(messageId, '已应用跨角色修改。');
                    const editRecord = {
                        summary,
                        applications: prepared.applications.map(app => ({
                            targetRef: app.targetRef,
                            targetId: app.targetId,
                            targetName: app.targetName,
                            mode: app.mode,
                            summary: app.summary || '',
                            patchSummaries: (app.patches || [])
                                .map(patch => patch && patch.summary)
                                .filter(Boolean)
                        }))
                    };
                    this.addAiToolResultDetail(statusId, editTraceTool, {
                        ok: true,
                        summary,
                        applications: editRecord.applications
                    }, 0, 1);
                    editOperationHistory.push(editRecord);
                    for (const app of prepared.applications) {
                        knownTargetTexts.set(app.targetId, app.pseudocode);
                    }
                    repairAttempts = 0;
                    this.setSuccess('AI 已应用伪代码修改。');
                    return {
                        ok: true,
                        feedbackItem: {
                            kind: 'edit_result',
                            ok: true,
                            summary,
                            applications: editRecord.applications,
                            completed: true,
                            editOperationProgress: {
                                completed: editOperationHistory.slice()
                            },
                            guidance: 'This edit_pseudocode action has already been applied in the live project. Use editOperationProgress.completed and current availablePseudocode/context to decide whether more requested edits remain. If more work remains, output one next ACTION. If everything requested is complete, answer normally with no hidden action.'
                        }
                    };
                };
                for (let turn = 0; turn < AI_MAX_TOTAL_ROUNDS; turn++) {
                    const {response, messageId} = await requestOnce();
                    this.addAiProcessStep(messageId, 'AI 回复完成，开始检查隐藏 action。');
                    throwIfAborted();
                    const hidden = response.action || parseHiddenAction(response.raw);
                    if (hidden.error) {
                        hiddenParseAttempts++;
                        this.addAiProcessStep(messageId, `隐藏块解析失败：${hidden.error}`);
                        const canRetry = turn < AI_MAX_TOTAL_ROUNDS - 1;
                        if (canRetry) {
                            this.addAiStatusMessage('AI 动作块没有完整生成，我正在让 AI 重新生成完整动作。');
                            feedback = {
                                kind: 'action_parse_error',
                                ok: false,
                                error: hidden.error,
                                attempt: hiddenParseAttempts,
                                guidance: 'Your previous hidden ACTION was invalid or incomplete. Do not continue the partial JSON. Regenerate the whole action as exactly one complete <ACTION>...</ACTION> block at the end, or answer normally with no hidden action if no action is needed.'
                            };
                            this.setInfo('AI 动作块不完整，正在重试。');
                            continue;
                        }
                        this.addAiStatusMessage(`AI 动作块一直没有完整生成，我先停止了：${hidden.error}`);
                        this.setError(`AI 隐藏块解析失败: ${hidden.error}`);
                        return;
                    }
                    hiddenParseAttempts = 0;
                    if (!hidden.action) {
                        const hasCompletedActions = projectOperationHistory.length || editOperationHistory.length;
                        this.updateAiChatMessage(messageId, message => ({
                            text: message.text && message.text.trim()
                                ? message.text.trim()
                                : (hidden.visibleText || (hasCompletedActions
                                    ? '已完成。'
                                    : 'AI 已回复，未检测到需要应用的伪代码修改。')),
                            pending: false
                        }));
                        this.addAiProcessStep(messageId, hasCompletedActions
                            ? '没有检测到隐藏 action，任务已结束。'
                            : '没有检测到隐藏 action，本次只作为普通回复处理。');
                        this.setInfo(hasCompletedActions ? 'AI 已完成。' : 'AI 已回复，未修改伪代码。');
                        return;
                    }
                    const hiddenActions = (hidden.action && hidden.action.actions) || hidden.actions || (
                        hidden.action.type === 'tool'
                            ? (hidden.action.tools || hidden.tools || (hidden.tool ? [hidden.tool] : []))
                                .filter(Boolean)
                                .map(tool => ({kind: 'tool', type: tool.type, tool}))
                            : (hidden.action.type === 'edit' && hidden.edit
                                ? [{kind: 'edit', type: 'edit_pseudocode', edit: hidden.edit}]
                                : [])
                    );
                    if (!hiddenActions.length) {
                        this.addAiStatusMessage('AI 动作块里没有可执行的动作。');
                        this.setError('AI 动作块里没有可执行的动作。');
                        return;
                    }
                    if (hiddenActions.length > AI_MAX_TOOL_CALLS_PER_BATCH) {
                        this.addAiStatusMessage(`AI 一次请求了 ${hiddenActions.length} 个动作，超过上限 ${AI_MAX_TOOL_CALLS_PER_BATCH} 个。`);
                        this.setError(`AI 批量动作数超过上限（${AI_MAX_TOOL_CALLS_PER_BATCH} 个）。`);
                        return;
                    }
                    const hasToolActions = hiddenActions.some(action => action && action.kind === 'tool');
                    if (hasToolActions) {
                        toolRounds++;
                        if (toolRounds > AI_MAX_TOOL_ROUNDS) {
                            this.addAiProcessStep(messageId, `工具请求超过上限：${AI_MAX_TOOL_ROUNDS} 轮。`);
                            this.addAiStatusMessage(
                                `AI 已连续请求工具超过 ${AI_MAX_TOOL_ROUNDS} 轮，我先停止了。\n` +
                                '可以把需求说得更具体一点，或让 AI 先只修改一个角色。'
                            );
                            this.setError(`AI 工具请求次数超过上限（${AI_MAX_TOOL_ROUNDS} 轮）。`);
                            return;
                        }
                    }
                    this.addAiProcessStep(messageId, hiddenActions.length > 1
                        ? `检测到批量动作请求：${hiddenActions.length} 个动作。`
                        : (hiddenActions[0].kind === 'edit' ? '检测到伪代码修改动作。' : '检测到工具动作。'));
                    const resultItems = [];
                    let failedItem = null;
                    for (let i = 0; i < hiddenActions.length; i++) {
                        const action = hiddenActions[i];
                        let item;
                        if (action.kind === 'tool') {
                            item = await executeOneAiToolAction(action.tool, i, hiddenActions.length, messageId);
                        } else if (action.kind === 'edit') {
                            item = await executeOneAiEditAction(action.edit, messageId);
                        } else {
                            item = {
                                ok: false,
                                feedbackItem: {
                                    kind: 'action_result',
                                    ok: false,
                                    error: `不支持的动作类型: ${action.kind || action.type || ''}`
                                }
                            };
                        }
                        resultItems.push(item.feedbackItem);
                        if (!item.ok) {
                            failedItem = item;
                            break;
                        }
                    }
                    if (failedItem && failedItem.cancelled) {
                        this.setInfo('用户已取消 AI 删除操作。');
                        return;
                    }
                    if (failedItem && failedItem.repair) {
                        feedback = failedItem.feedbackItem;
                        continue;
                    }
                    feedback = resultItems.length === 1
                        ? resultItems[0]
                        : {
                            kind: 'action_result',
                            batch: true,
                            ok: !failedItem,
                            actionCount: hiddenActions.length,
                            completedActionCount: resultItems.length,
                            results: resultItems,
                            projectOperationProgress: {
                                completed: projectOperationHistory.slice()
                            },
                            editOperationProgress: {
                                completed: editOperationHistory.slice()
                            },
                            guidance: failedItem
                                ? 'One action in the batch failed, and later actions were not executed. Use the results array to recover or ask for the missing information before continuing.'
                                : 'All ACTION calls in this batch have been executed in order. Use the results array, projectOperationProgress.completed, editOperationProgress.completed, and current context to decide the next action. If more work remains, output one next ACTION; otherwise answer normally with no hidden action.'
                        };
                    continue;
                }
                this.addAiStatusMessage(
                    `AI 处理轮次达到上限（${AI_MAX_TOTAL_ROUNDS} 轮），我先停止了。\n` +
                    '这通常表示 AI 一直在请求工具、修复草稿或没有给出最终修改块。可以把任务拆小后再试。'
                );
                this.setError(`AI 处理轮次达到上限（${AI_MAX_TOTAL_ROUNDS} 轮）。`);
            } catch (err) {
                if (err && err.name === 'AbortError') {
                    if (!this.aiUserAborted) {
                        this.addAiProcessStep(currentAssistantMessageId, '请求被中断。');
                        this.addAiStatusMessage('已中断。');
                    }
                    this.updateAiChatMessage(currentAssistantMessageId, {pending: false});
                    this.setInfo('已中断 AI 请求。');
                    return;
                }
                console.error('[json-script-converter] AI chat failed', err);
                this.addAiProcessStep(currentAssistantMessageId, `请求失败：${err.message}`);
                if (currentAssistantMessageId) {
                    this.updateAiChatMessage(currentAssistantMessageId, {pending: false});
                }
                this.addAiStatusMessage(`请求失败：${err.message}`);
                this.setError(`AI 请求失败: ${err.message}`);
            } finally {
                this.aiAbortController = null;
                this.aiActiveMessageId = null;
                this.aiUserAborted = false;
                const shouldScroll = this.shouldScrollAiMessagesToBottom(false);
                this.setState({aiBusy: false}, () => this.scrollAiMessagesToBottomSoon(shouldScroll));
            }
        };

        validatePseudoText = (text, targetOverride) => {
            const target = targetOverride || vm.editingTarget;
            if (!target) {
                return {ok: false, errors: [{line: 1, col: 1, message: 'No target selected'}]};
            }
            const r = pseudoConverter.parsePseudocode(text, {target, vm});
            if (r.errors && r.errors.length) {
                return {ok: false, errors: r.errors};
            }
            if ((!r.blocks || !Object.keys(r.blocks).length) && (!r.comments || !Object.keys(r.comments).length)) {
                return {ok: false, errors: [{line: 1, col: 1, message: 'No blocks parsed from pseudocode'}]};
            }
            return {ok: true, result: r};
        };

        buildAiMessages = (instruction, knownTargetTexts, extra, progress) => {
            const target = vm.editingTarget;
            const currentText = target && knownTargetTexts && knownTargetTexts.has(target.id)
                ? knownTargetTexts.get(target.id)
                : '';
            const visionSupported = hasAiVisionSupport(this.state.aiConfig);
            const toolNoConfirm = !!(this.state.aiConfig && this.state.aiConfig.toolNoConfirm);
            const imageAttachments = visionSupported ? collectAiImageAttachments(extra || null) : [];
            const cleanExtra = stripAiImageAttachments(extra || null);
            const context = getAiProjectContext(
                target,
                vm,
                currentText,
                item => this.getAiTargetSummary(item, {includeCostumes: false})
            );
            const userPayload = {
                instruction,
                context,
                availablePseudocode: this.getKnownPseudocodeEntries(knownTargetTexts || new Map()),
                conversation: this.state.aiMessages
                    .filter(m => m && m.kind !== 'status' && String(m.text || '').trim())
                    .slice(-10)
                    .map(m => ({role: m.role, text: m.text})),
                projectOperationProgress: progress
                    ? {completed: progress.completedProjectOperations || []}
                    : null,
                editOperationProgress: progress
                    ? {completed: progress.completedEditOperations || []}
                    : null,
                feedback: cleanExtra || null,
                currentPseudocode: currentText
            };
            const userContentText = JSON.stringify(userPayload, null, 2);
            const userContent = imageAttachments.length ? [
                {type: 'text', text: userContentText},
                ...imageAttachments.map(attachment => ({
                    type: 'image_url',
                    image_url: {
                        url: attachment.dataUrl,
                        detail: 'low'
                    }
                }))
            ] : userContentText;
            return [
                {
                    role: 'system',
                    content: [
                        '你是一个 Scratch / TurboWarp 伪代码助手。你的任务是根据用户要求，解释、读取、创建或修改项目中的角色、舞台、造型和伪代码。',
                        '你的可见回复要简洁、自然、按实际进度说话。不要提前宣布已经完成。需要执行动作时，可见回复最多先说一句正在做什么，然后在末尾追加一个隐藏动作块。',
                        '每轮 assistant 回复只能选择一种结果：普通回答、执行一个隐藏动作块、或总结完成。确认所有用户要求都已完成后，才用普通回答总结，不输出隐藏动作块。',
                        `隐藏动作块必须放在整段回复的最后。隐藏动作块外不要输出 JSON、伪代码或工具参数。通用格式：${AI_ACTION_OPEN}{"type":"工具名","参数名":"参数值"}${AI_ACTION_CLOSE}`,
                        `批量动作格式：${AI_ACTION_OPEN}{"type":"batch","calls":[{"type":"工具名","参数名":"参数值"},{"type":"工具名","参数名":"参数值"}]}${AI_ACTION_CLOSE}`,
                        `不要使用模型供应商自己的工具调用格式。不要输出类似 <|tool_calls_section_begin|>、functions.AI_TOOL、tool_call_argument、${AI_TOOL_OPEN}、${AI_EDIT_OPEN} 这样的内容。只使用 ${AI_ACTION_OPEN}。`,
                        '每次最多输出一个 <ACTION> 块。所有读取、创建、删除、修改伪代码、运行控制都属于动作。修改伪代码使用 edit_pseudocode 动作。',
                        '执行决策顺序：先理解用户原始目标；再查看 projectOperationProgress.completed 和 editOperationProgress.completed；还有未完成的结构操作就继续执行；需要更多上下文就先读取或查找；已有足够上下文且需要改代码就调用 edit_pseudocode；所有要求完成后才普通总结。',
                        '一次动作成功不代表任务结束；必须检查是否还有剩余角色、造型或脚本要处理。edit_pseudocode 成功也不是最终回答，成功后仍要根据 edit_result 检查是否还有剩余要求。',
                        `批量规则：多个互不依赖的动作应放在同一个 batch.calls 中，最多 ${AI_MAX_TOOL_CALLS_PER_BATCH} 个。后一个动作依赖前一个动作返回结果时，必须分轮执行。`,
                        '例如“创建三个角色”应使用一个 batch，包含三个 create_sprite。例如“读取 a 中名称最长的造型，再用这个名称创建角色”必须先 get_target_info，等 tool_result 返回后再 create_sprite。例如“创建两个角色，一个写加法，一个写乘法”：先 batch 创建两个角色，拿到新 targetRef 后再 edit_pseudocode。',
                        '工具执行后，插件会返回 tool_result 或 edit_result。你必须根据 result 判断下一步，不要猜测执行结果。',
                        '可用动作：click_green_flag、click_pause、click_stop、get_target_info、get_pseudocode、search_text、list_extensions、load_extension、get_extension_blocks、get_costume_info、create_sprite、delete_sprite、create_costume、delete_costume、create_svg_costume、replace_svg_costume、create_bitmap_costume、replace_bitmap_costume、edit_pseudocode。',
                        '运行控制动作只在用户明确要求运行、暂停、停止或需要试运行项目时使用。click_green_flag 点击绿旗并启动项目；click_pause 暂停当前项目（若已暂停则保持暂停）；click_stop 点击停止并清除暂停状态。',
                        ...(visionSupported ? [
                            '用户已为此 AI 配置启用图像理解。额外可用动作：inspect_costume、get_stage_snapshot。',
                            `查看造型图片：${AI_ACTION_OPEN}{"type":"inspect_costume","targetRef":"a","costumeName":"costume1"}${AI_ACTION_CLOSE}`,
                            `查看舞台截图：${AI_ACTION_OPEN}{"type":"get_stage_snapshot"}${AI_ACTION_CLOSE}`,
                            'inspect_costume 和 get_stage_snapshot 会在下一轮 tool_result 中返回图片。只有视觉外观确实重要，或 SVG 源码不足以判断时才使用。'
                        ] : [
                            '用户未启用图像理解。不要调用 inspect_costume 或 get_stage_snapshot。位图造型只能读取元信息；SVG 造型可通过 get_costume_info 读取源码。'
                        ]),
                        toolNoConfirm
                            ? '删除角色或造型时，直接调用对应删除动作。当前配置已允许工具调用跳过确认，插件会直接执行。'
                            : '删除角色或造型时，直接调用对应删除动作。插件会在对话中请求用户确认，只有用户确认后才会执行删除。你不要替用户确认。',
                        '优先使用 targetRef，例如 "a"、"b"、"c"。targetName 只用于展示，targetId 只用于兼容旧格式。舞台/背景也是一个目标，isStage 为 true，可以读取和编辑脚本。',
                        'context.targets 是轻量列表，可能不包含完整造型信息。需要准确造型名、背景名、尺寸、格式、SVG 源码时，先调用 get_target_info 或 get_costume_info。',
                        'context.extensions.core 是 Scratch 打开就自带的核心分类；context.extensions.loaded 是当前已加载扩展；context.extensions.localAvailable 是本地已存在、可加载的扩展薄列表，只包含 id/name/loaded/hardware，不包含未加载扩展的 opcode 表。伪代码里使用扩展 opcode 时，插件会在应用前自动加载可识别的本地扩展，例如 pen/music/microbit。远程扩展不会靠 opcode 自动猜测 URL；使用远程扩展前必须先调用 list_extensions 搜索或 load_extension 传入 url/slug。找不到或不能自动加载的扩展会让伪代码应用失败。',
                        '加载扩展只表示项目可以使用该扩展，不表示你已经知道它的 opcode 和参数。需要编写某个已加载扩展的积木时，先调用 get_extension_blocks 获取 opcode 表、参数槽和 @op 示例；未列入 context.keywords 的扩展积木必须使用 @op("完整opcode", inputs={...}, fields={...})。',
                        '如果 load_extension 的 tool_result 带有 nextSuggestedAction，请优先按这个 extensionId 调用 get_extension_blocks；URL 加载的远程扩展尤其需要这样获取真实 id。',
                        'availablePseudocode 中已有的伪代码可以直接使用，且带有 totalLines/numberedLines 行号；没有的目标需要用 get_pseudocode 读取。currentPseudocode 是当前选中目标的原始伪代码，行号以 availablePseudocode 为准。',
                        `查看扩展列表或搜索远程扩展：${AI_ACTION_OPEN}{"type":"list_extensions","query":"clones","includeRemote":true}${AI_ACTION_CLOSE}`,
                        `加载扩展：${AI_ACTION_OPEN}{"type":"load_extension","extensionId":"pen"}${AI_ACTION_CLOSE}`,
                        `查看已加载扩展 opcode 表：${AI_ACTION_OPEN}{"type":"get_extension_blocks","extensionId":"pen"}${AI_ACTION_CLOSE}`,
                        `加载 TurboWarp 远程扩展：${AI_ACTION_OPEN}{"type":"load_extension","slug":"clones"}${AI_ACTION_CLOSE} 或 ${AI_ACTION_OPEN}{"type":"load_extension","url":"https://extensions.turbowarp.org/xxx.js"}${AI_ACTION_CLOSE}`,
                        `读取伪代码：${AI_ACTION_OPEN}{"type":"get_pseudocode","targetRefs":["a"]}${AI_ACTION_CLOSE}`,
                        `读取指定行：${AI_ACTION_OPEN}{"type":"get_pseudocode","targetRefs":["a"],"startLine":3,"endLine":8}${AI_ACTION_CLOSE}`,
                        `查找文本：${AI_ACTION_OPEN}{"type":"search_text","query":"当前关卡","targetRefs":["a"],"caseSensitive":false,"regex":false}${AI_ACTION_CLOSE}`,
                        `点击绿旗：${AI_ACTION_OPEN}{"type":"click_green_flag"}${AI_ACTION_CLOSE}`,
                        `点击暂停：${AI_ACTION_OPEN}{"type":"click_pause"}${AI_ACTION_CLOSE}`,
                        `点击停止：${AI_ACTION_OPEN}{"type":"click_stop"}${AI_ACTION_CLOSE}`,
                        `创建角色：${AI_ACTION_OPEN}{"type":"create_sprite","name":"角色名"}${AI_ACTION_CLOSE}`,
                        `批量创建角色：${AI_ACTION_OPEN}{"type":"batch","calls":[{"type":"create_sprite","name":"加法"},{"type":"create_sprite","name":"乘法"}]}${AI_ACTION_CLOSE}`,
                        `创建 SVG 造型：${AI_ACTION_OPEN}{"type":"create_svg_costume","targetRef":"a","name":"按钮1","svg":"<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 100 60\\">...</svg>"}${AI_ACTION_CLOSE}`,
                        `创建位图造型：${AI_ACTION_OPEN}{"type":"create_bitmap_costume","targetRef":"a","name":"照片","imageData":"data:image/png;base64,..."}${AI_ACTION_CLOSE}`,
                        'create_bitmap_costume/replace_bitmap_costume 的 imageData 可以是 PNG、JPEG、WebP、BMP 或 GIF 的 Base64 data URL；传纯 Base64 时可用 mimeType 声明格式。位图会安全解码并统一存为 PNG。',
                        '位图工具不接受 HTTP 图片链接。只有拿到完整图片数据时才能调用，不要编造、省略或截断 Base64。',
                        'get_costume_info 返回造型/背景元信息；请求具体 SVG 造型/背景时，也会返回 SVG 源码。创建或替换 SVG 必须提供安全、独立的 SVG：不包含 script、事件属性、外链资源或 data URI 图片。',
                        '创建或替换 SVG 时，只生成 Scratch/Paper.js 易识别的简单 SVG 子集。允许的元素只有：svg、g、path、rect、circle、ellipse、line、polyline、polygon、text、tspan。需要复杂图形时，用这些基础元素直接组合。',
                        'SVG 根元素必须包含 xmlns="http://www.w3.org/2000/svg" 和简单 viewBox，例如 viewBox="0 0 100 60"。优先用 viewBox 坐标定位，不依赖百分比 width/height。',
                        '允许的 SVG 属性只使用：viewBox、xmlns、x、y、x1、y1、x2、y2、cx、cy、r、rx、ry、width、height、points、d、fill、stroke、stroke-width、stroke-linecap、stroke-linejoin、opacity、transform、font-size、font-family、font-weight、text-anchor、dominant-baseline、xml:space。',
                        '文字必须保留为真实 <text> 或 <text><tspan>，不要把按钮文字、标签、数字转成 path。文本要写明确 x/y、font-size、text-anchor 和 dominant-baseline；多行文字用多个 text 或 tspan。',
                        '不要使用未列入允许清单的 SVG 元素或属性；尤其不要使用 style、class、defs、use、symbol、filter、mask、clipPath、marker、pattern、linearGradient、radialGradient、textPath、image、foreignObject、animate、外部字体、外链资源或 data URI。',
                        'create_costume/create_svg_costume/create_bitmap_costume 成功后，tool_result.costume.number / costumeNumber 是 Scratch 菜单里可用的 1-based 序号，可直接用于 switch_costume(number) 或 switch_backdrop(number)。',
                        `修改伪代码 patch：${AI_ACTION_OPEN}{"type":"edit_pseudocode","edits":[{"targetRef":"a","mode":"patch","patches":[{"op":"replace","startLine":1,"endLine":1,"oldText":"原来的连续行","newText":"新的连续行"}]}]}${AI_ACTION_CLOSE}`,
                        `修改伪代码 replace：${AI_ACTION_OPEN}{"type":"edit_pseudocode","edits":[{"targetRef":"a","mode":"replace","pseudocode":"完整伪代码"}]}${AI_ACTION_CLOSE}`,
                        '有明确行号且只改少量连续行时优先使用 mode:"patch"。新脚本、空伪代码、新增大段脚本、大范围重写、或修复解析错误时可以使用 mode:"replace" 和 pseudocode。不要为了使用 patch 而拆得很碎。',
                        'patch 规则：行号从 1 开始；replace/delete 必须提供完全匹配的 oldText；insertAfter 在指定行后插入 newText；所有 patch 都基于修改前的原文；不要修改无关脚本、变量、列表、广播、注释或自定义块。',
                        'edit_pseudocode 的 summary 和 patch summary 默认省略。只有复杂修改确实需要说明时才写短 summary。最终总结应在 edit_result 成功后用普通回答完成。',
                        '不要输出 Scratch JSON。不要在可见回复里展示伪代码；伪代码只能放在 edit_pseudocode 动作中。隐藏伪代码必须能被项目 parser 解析。',
                        '保留无关脚本、头部声明、变量、列表、广播、自定义块和注释，除非用户要求修改。',
                        '如果 currentPseudocode 为空，根据用户要求创建完整第一版。优先使用上下文中的已有名称，只使用 context.keywords 中支持的积木名/opcode。',
                        '选关界面、按钮、菜单等视觉 UI，优先使用 Scratch/Paper.js 兼容的简单 SVG 造型表达按钮外观和真实文字。不要用 say/think 气泡当按钮文字。多个编号按钮可以创建多个 SVG 造型，克隆根据局部变量切换造型。',
                        '生成选关按钮、敌人、菜单项等带编号克隆时，必须使用“全局创建标记 + 克隆局部身份变量 + create_clone 后 wait(0)”模式：循环里递增全局标记并创建克隆，wait(0) 让克隆启动脚本先复制标记；on_clone_start 第一句把标记存入 #localvars；点击、位置和造型都使用这个 #localvars。',
                        '如果 feedback 中包含 repair/parser 错误，说明上一次草稿没有通过解析。先简短说明正在修复，然后调用 edit_pseudocode 给出修正版。修复时可以使用全文 replace。不要重复同一个错误动作。',
                        '如果 feedback.kind 是 action_parse_error，说明上一轮隐藏动作块没有闭合或 JSON 无效。不要接着半截 JSON 续写；必须重新生成完整的一个 <ACTION>...</ACTION>，或在确实不需要动作时普通回答。',
                        '每次 tool_result 或 edit_result 返回后，都要重新检查用户原始目标。如果用户要求多个角色、多个造型、多个脚本或多个功能，必须确认全部完成后才能最终总结。',
                        '回复风格：简洁；不展示长篇计划；不反复讨论工具规则；不要说“我可能需要尝试”这类犹豫内容；按规则直接行动。',
                        'Use context.runtime.framerate/effectiveFramerate/stepTimeMs when reasoning about timing. framerate 0 means matching the device screen refresh rate; effectiveFramerate is the fallback estimate.',
                        AI_PSEUDOCODE_SYNTAX_GUIDE
                    ].join('\n')
                },
                {
                    role: 'user',
                    content: userContent
                }
            ];
        };

        runAiModifyPseudocode = () => {
            this.openAiChat();
        };

        // 切换模式：按当前模式解析 → 按目标模式渲染 → 替换编辑器文本
        switchMode = newMode => {
            if (newMode === this.state.mode) return;
            // 如果有还没执行的 apply 任务，先 flush 掉 —— 避免 "切完模式后延迟 apply 旧模式的文本" 这种时序错乱
            if (this.applyDebounceTimer) {
                clearTimeout(this.applyDebounceTimer);
                this.applyDebounceTimer = null;
            }
            const editor = this.jsonEditorComponent.current;
            if (!editor) {
                this.setState({mode: newMode}, this.persistUiState);
                return;
            }
            const cur = editor.getText();
            if (!cur || !cur.trim()) {
                // 编辑器空 → 直接切模式
                this.setState({mode: newMode}, this.persistUiState);
                this.clearError();
                return;
            }
            // 1) 按当前模式解析出 blocks
            let blocks;
            if (this.state.mode === 'json') {
                const r = parseJsonLikeText(cur);
                if (!r.ok) { this.setError(`切换失败：${r.error}`); return; }
                if (!looksLikeBlocksObject(r.value)) {
                    this.setError('切换失败：JSON 不是 blocks 结构');
                    return;
                }
                blocks = r.value;
            } else {
                const target = vm.editingTarget;
                const r = pseudoConverter.parsePseudocode(cur, {target, vm});
                if (r.errors && r.errors.length) {
                    const msgs = r.errors.slice(0, 5)
                        .map(e => `第${Number(e && e.line) > 0 ? e.line : 1}行: ${e && e.message}`)
                        .join('\n');
                    this.setError(`切换失败：伪代码有错\n${msgs}`);
                    return;
                }
                blocks = r.blocks;
            }
            // 2) 按新模式渲染
            try {
                let text;
                if (newMode === 'json') {
                    text = stringifyForEditor(blocks);
                } else {
                    const target = vm.editingTarget;
                    text = pseudoConverter.renderPseudocode(blocks, {target, vm}, {includeCoords: this.includeCoords});
                }
                editor.setText(text);
                if (typeof editor.closeAutocomplete === 'function') editor.closeAutocomplete();
                this.setState({mode: newMode}, this.persistUiState);
                this.dirty = false;
                // 滚动跟随只在伪代码模式下有意义：切到 JSON 时停 rAF，切回伪代码（若开启）再启
                if (newMode === 'pseudo' && this.syncScroll) this.startWsScrollPoll();
                else this.stopWsScrollPoll();
                this.setSuccess(newMode === 'json' ? '已切换到 JSON 模式' : '已切换到伪代码模式');
            } catch (err) {
                console.error('[json-script-converter] switchMode failed', err);
                this.setError(`切换失败：${err.message}`);
            }
        };

        // 当前 target + stage 上的变量 / 列表名，作为补全候选。
        // 名字含非标识符字符时，额外把下划线化过的形式也塞一份。
        getDynamicKeywords = () => {
            if (this.state.mode !== 'pseudo') return [];
            const target = vm && vm.editingTarget;
            if (!target) return [];
            const stage = (vm.runtime && vm.runtime.getTargetForStage) ? vm.runtime.getTargetForStage() : null;
            const names = new Set();
            const sanitize = pseudoConverter.sanitizeIdent || (s => s);
            const collect = (scope) => {
                if (!scope || !scope.variables) return;
                for (const id of Object.keys(scope.variables)) {
                    const v = scope.variables[id];
                    if (!v || !v.name) continue;
                    if (v.type === 'broadcast_msg') continue;
                    names.add(v.name);
                    const s = sanitize(v.name);
                    if (s && s !== v.name) names.add(s);
                }
            };
            collect(target);
            if (stage && stage !== target) collect(stage);
            return [...names];
        };

        getContextualCompletions = context => {
            if (this.state.mode !== 'pseudo' || !context) return [];
            const defs = Array.isArray(pseudoConverter.opcodeDefs) ? pseudoConverter.opcodeDefs : [];
            if (context.isDefineParams) return [{value: 'bool', priority: 0}];
            const callName = String(context.callName || '').toLowerCase();
            const def = defs.find(item => [item.name, item.cname, item.opcode]
                .filter(Boolean)
                .some(name => String(name).toLowerCase() === callName));
            const arg = def && Array.isArray(def.args) ? def.args[context.argIndex] : null;

            const target = vm && vm.editingTarget;
            const stage = (vm.runtime && vm.runtime.getTargetForStage) ? vm.runtime.getTargetForStage() : null;
            const targets = getAiTargets(vm);
            const spriteNames = targets.filter(item => !item.isStage).map(item => getAiTargetName(item)).filter(Boolean);
            const costumesOf = item => item && item.sprite && Array.isArray(item.sprite.costumes)
                ? item.sprite.costumes.map(costume => costume && costume.name).filter(Boolean)
                : [];
            const soundsOf = item => item && item.sprite && Array.isArray(item.sprite.sounds)
                ? item.sprite.sounds.map(sound => sound && sound.name).filter(Boolean)
                : [];
            const targetCostumes = costumesOf(target);
            const stageCostumes = costumesOf(stage);
            const targetSounds = soundsOf(target);
            const broadcasts = getTargetNamesByType(stage, 'broadcast_msg');
            const keys = [
                'space', 'up arrow', 'down arrow', 'left arrow', 'right arrow', 'any',
                ...'abcdefghijklmnopqrstuvwxyz'.split(''),
                ...'0123456789'.split('')
            ];
            const items = [];
            const push = (value, priority) => {
                if (value == null || value === '') return;
                items.push({value: String(value), priority});
            };
            const quote = value => {
                const text = escapePseudoString(value);
                return context.inString ? text.slice(1, -1) : text;
            };
            const addQuoted = (values, priority = 0) => {
                for (const value of values || []) {
                    if (value == null || value === '') continue;
                    push(quote(value), priority);
                }
            };
            const addRaw = (values, priority = 0) => {
                for (const value of values || []) {
                    if (value == null || value === '') continue;
                    push(value, priority);
                }
            };
            const addReporterNames = () => {
                if (context.inString) return;
                const reporterNames = new Set();
                for (const item of defs) {
                    if (!item || (item.kind !== 'reporter' && item.kind !== 'boolean')) continue;
                    for (const name of [item.name, item.cname, item.opcode]) {
                        if (name) reporterNames.add(name);
                    }
                }
                [
                    'abs', 'floor', 'ceiling', 'ceil', 'sqrt', 'sin', 'cos', 'tan',
                    'asin', 'acos', 'atan', 'ln', 'log', 'exp', 'e_pow', 'pow_e',
                    'pow10', 'ten_pow', 'true', 'false', 'null', 'arg', 'arg_bool',
                    'callret', 'broadcast_ref'
                ].forEach(name => reporterNames.add(name));
                for (const name of this.getDynamicKeywords()) reporterNames.add(name);
                for (const name of reporterNames) push(name, 10);
            };
            const costumeIndexes = names => names.map((_, index) => String(index + 1));
            if (!arg) {
                addReporterNames();
                return items;
            }
            const fieldName = arg.name || '';
            const menuOpcode = arg.menu && arg.menu.opcode;

            if (arg.type === 'field') {
                if (arg.kind === 'broadcast' || fieldName === 'BROADCAST_OPTION') addQuoted(broadcasts);
                else if (fieldName === 'KEY_OPTION') addQuoted(keys);
                else if (fieldName === 'BACKDROP') addQuoted(stageCostumes);
                else if (fieldName === 'WHENGREATERTHANMENU') addQuoted(['LOUDNESS', 'TIMER']);
                else if (fieldName === 'STOP_OPTION') addQuoted(['all', 'this script', 'other scripts in sprite']);
                else if (fieldName === 'STYLE') addQuoted(['left-right', "don't rotate", 'all around']);
                else if (fieldName === 'EFFECT') addQuoted(['color', 'fisheye', 'whirl', 'pixelate', 'mosaic', 'brightness', 'ghost']);
                else if (fieldName === 'FRONT_BACK') addQuoted(['front', 'back']);
                else if (fieldName === 'FORWARD_BACKWARD') addQuoted(['forward', 'backward']);
                else if (fieldName === 'NUMBER_NAME') addQuoted(['number', 'name']);
                else if (fieldName === 'CURRENTMENU') addQuoted(['YEAR', 'MONTH', 'DATE', 'DAYOFWEEK', 'HOUR', 'MINUTE', 'SECOND']);
                else if (fieldName === 'PROPERTY') {
                    addQuoted([
                        'x position', 'y position', 'direction', 'costume #', 'costume name',
                        'size', 'volume', 'backdrop #', 'backdrop name'
                    ]);
                }
                return Array.from(new Set(items));
            }

            if (arg.primType === 11) {
                addQuoted(broadcasts);
                addReporterNames();
                return items;
            }
            if (!menuOpcode) {
                addReporterNames();
                return items;
            }

            if (menuOpcode === 'control_create_clone_of_menu') addQuoted(['_myself_', ...spriteNames]);
            else if (menuOpcode === 'motion_goto_menu' || menuOpcode === 'motion_glideto_menu') {
                addQuoted(['_random_', '_mouse_', ...spriteNames]);
            } else if (menuOpcode === 'motion_pointtowards_menu' || menuOpcode === 'sensing_distancetomenu') {
                addQuoted(['_mouse_', ...spriteNames]);
            } else if (menuOpcode === 'sensing_touchingobjectmenu') {
                addQuoted(['_mouse_', '_edge_', ...spriteNames]);
            } else if (menuOpcode === 'sensing_of_object_menu') {
                addQuoted(['_stage_', ...spriteNames]);
            } else if (menuOpcode === 'looks_costume') {
                addQuoted(targetCostumes);
                if (!context.inString) addRaw(costumeIndexes(targetCostumes));
            } else if (menuOpcode === 'looks_backdrops') {
                addQuoted(stageCostumes);
                if (!context.inString) addRaw(costumeIndexes(stageCostumes));
            } else if (menuOpcode === 'sound_sounds_menu') {
                addQuoted(targetSounds);
            } else if (menuOpcode === 'sensing_keyoptions') {
                addQuoted(keys);
            }
            addReporterNames();
            return items;
        };

        // 把当前伪代码文本里的标识符整体换成中文 cname 或原版 opcode。
        // 字符串字面量 / 注释不受影响。只在伪代码模式下有意义。
        translateLanguage = target => {
            if (this.state.mode !== 'pseudo') {
                this.setError('只能在伪代码模式下切换语言');
                return;
            }
            const editor = this.jsonEditorComponent.current;
            if (!editor) return;
            const cur = editor.getText();
            if (!cur || !cur.trim()) return;
            try {
                const converted = pseudoConverter.translatePseudocode(cur, target);
                if (converted === cur) {
                    this.setSuccess(target === 'zh' ? '已是中文（没有可替换项）' : '已是 opcode（没有可替换项）');
                    return;
                }
                editor.setText(converted);
                if (typeof editor.closeAutocomplete === 'function') editor.closeAutocomplete();
                this.dirty = true;
                this.setSuccess(target === 'zh' ? '已转换为中文关键字' : '已转换为原版 opcode');
            } catch (err) {
                console.error('[json-script-converter] translateLanguage failed', err);
                this.setError(`转换失败：${err.message}`);
            }
        };

        // 把 blocks 对象（SB3 压缩形态，含短 ID）应用到当前角色的积木区。
        // 返回 {ok, error?, count?, loadedExtensions?}。不抛错，错误走返回值。
        applyBlocksToWorkspace = (raw, meta, targetOverride, options) => {
            const target = targetOverride || vm.editingTarget;
            if (!target) return {ok: false, error: '没有选中的角色或舞台'};
            const isVisibleTarget = !!(vm.editingTarget && target.id === vm.editingTarget.id);
            const cloned = JSON.parse(JSON.stringify(raw));
            normalizeControlStopMutations(cloned);
            try {
                sb3.deserializeBlocks(cloned);
            } catch (err) {
                return {ok: false, error: `反序列化失败: ${err.message}`};
            }
            const extensionCheck = this.ensureAiExtensionsForBlocks(cloned);
            if (!extensionCheck.ok) return {ok: false, error: extensionCheck.error};

            // —— 自动对齐：按 parser 的 pending + declared 在目标上建新变量/列表/广播 —— //
            // meta 由 parsePseudocode 的返回值传入；JSON 模式下 meta 为空对象，所有集合都当空。
            // 伪代码模式下始终开启自动对齐：apply 时自动建新变量/列表/广播，并删掉本角色里没用到的 local 变量/列表
            // （stage target 和广播永不自动删；stage 上的 global 永不自动删——可能被其它 sprite 引用）
            const autoAlign = !!(options && options.forcePseudo) || this.state.mode === 'pseudo';
            const pendingVars = (meta && meta.pendingVars) || new Map();
            const pendingLists = (meta && meta.pendingLists) || new Map();
            const pendingBroadcasts = (meta && meta.pendingBroadcasts) || new Map();
            const declaredVars = (meta && meta.declaredVars) || new Set();
            const declaredLists = (meta && meta.declaredLists) || new Set();
            const declaredBroadcasts = (meta && meta.declaredBroadcasts) || new Set();
            const declaredLocalVars = (meta && meta.declaredLocalVars) || new Set();
            const declaredLocalLists = (meta && meta.declaredLocalLists) || new Set();
            const referenceIdRemaps = {variable: new Map(), list: new Map(), broadcast: new Map()};

            if (autoAlign) {
                const stage = vm.runtime.getTargetForStage && vm.runtime.getTargetForStage();
                // 选择变量/列表 应该创建在哪个 target 上：
                //   - 当前 target 是 stage → 只能全局（就是 stage 自己）
                //   - 声明在 #localvars/#locallists → 当前 sprite（局部）
                //   - 否则 → stage（全局），匹配 Scratch "Make a Variable" 默认行为
                const chooseScope = (name, isLocalDeclared) => {
                    if (target.isStage) return stage;
                    if (isLocalDeclared) return target;
                    return stage || target;
                };
                const lookupInOwnScope = (scope, name, type) => {
                    if (!scope || !scope.variables) return null;
                    for (const id of Object.keys(scope.variables)) {
                        const v = scope.variables[id];
                        if (v && v.name === name && (v.type || '') === type) return v;
                    }
                    return null;
                };
                const rememberReferenceId = (kind, requestedId, resolved) => {
                    if (!resolved || requestedId == null || resolved.id == null) return;
                    referenceIdRemaps[kind].set(String(requestedId), {
                        id: resolved.id,
                        name: resolved.name
                    });
                };

                // declared 里目标上没有的名字，也补进 pending 去建（独立的本地随机 id 前缀，避免撞已有 id）
                const declSeed = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
                let declCounter = 0;
                const freshDeclId = kind => `${kind}-decl-${declSeed}-${declCounter++}`;

                // 变量：声明里有、还没实际存在的补进 pending
                for (const name of declaredVars) {
                    if (!lookupInOwnScope(chooseScope(name, false), name, '') && !pendingVars.has(name)) {
                        pendingVars.set(name, freshDeclId('newvar'));
                    }
                }
                for (const name of declaredLocalVars) {
                    if (!lookupInOwnScope(chooseScope(name, true), name, '') && !pendingVars.has(name)) {
                        pendingVars.set(name, freshDeclId('newvar'));
                    }
                }
                for (const name of declaredLists) {
                    if (!lookupInOwnScope(chooseScope(name, false), name, 'list') && !pendingLists.has(name)) {
                        pendingLists.set(name, freshDeclId('newlist'));
                    }
                }
                for (const name of declaredLocalLists) {
                    if (!lookupInOwnScope(chooseScope(name, true), name, 'list') && !pendingLists.has(name)) {
                        pendingLists.set(name, freshDeclId('newlist'));
                    }
                }
                for (const name of declaredBroadcasts) {
                    if (stage && !stage.lookupBroadcastByInputValue(name) && !pendingBroadcasts.has(name)) {
                        pendingBroadcasts.set(name, freshDeclId('newbroadcast'));
                    }
                }

                // 实际创建
                for (const [name, id] of pendingVars) {
                    const scope = chooseScope(name, declaredLocalVars.has(name));
                    let variable = lookupInOwnScope(scope, name, '');
                    if (!variable && scope) {
                        scope.createVariable(id, name, '', false);
                        variable = lookupInOwnScope(scope, name, '');
                    }
                    rememberReferenceId('variable', id, variable);
                }
                for (const [name, id] of pendingLists) {
                    const scope = chooseScope(name, declaredLocalLists.has(name));
                    let list = lookupInOwnScope(scope, name, 'list');
                    if (!list && scope) {
                        scope.createVariable(id, name, 'list', false);
                        list = lookupInOwnScope(scope, name, 'list');
                    }
                    rememberReferenceId('list', id, list);
                }
                if (stage) {
                    for (const [name, id] of pendingBroadcasts) {
                        let broadcast = stage.lookupBroadcastByInputValue(name);
                        if (!broadcast) {
                            stage.createVariable(id, name, 'broadcast_msg', false);
                            broadcast = stage.lookupBroadcastByInputValue(name);
                        }
                        rememberReferenceId('broadcast', id, broadcast);
                    }
                }

                // 创建的变量要让 Blockly 的工具箱立刻刷新（否则变量分类里看不到新变量，也会让后续
                // UI "Make a Variable" 因为内部状态没同步而出怪现象）。vm.emitTargetsUpdate() 会触发
                // blocks.jsx 重新 getToolboxXML 并 requestToolboxUpdate。
                if (typeof vm.emitTargetsUpdate === 'function') vm.emitTargetsUpdate(false);
            }
            remapBlockReferenceIds(cloned, referenceIdRemaps);

            const missing = findMissingReferences(cloned, target);
            const parts = [];
            if (missing.variable.length) parts.push(`缺少变量: ${missing.variable.join(', ')}`);
            if (missing.list.length) parts.push(`缺少列表: ${missing.list.join(', ')}`);
            if (missing.broadcast.length) parts.push(`缺少广播: ${missing.broadcast.join(', ')}`);
            if (parts.length) return {ok: false, error: parts.join(' | ')};

            const blockArray = Object.values(cloned);
            if (!isVisibleTarget && autoAlign) ensureHeadlessTopLevelCoords(cloned);
            newBlockIds(blockArray);
            const parsedComments = meta && meta.comments && typeof meta.comments === 'object'
                ? meta.comments
                : null;
            const commentsToCreate = [];
            const attachedCommentIds = new Set();
            const queueCommentForCreate = (commentId, comment, blockId) => {
                if (!comment || typeof comment.text !== 'string') return;
                commentsToCreate.push({
                    id: commentId,
                    blockId: blockId || null,
                    text: comment.text,
                    x: Number.isFinite(Number(comment.x)) ? Number(comment.x) : 0,
                    y: Number.isFinite(Number(comment.y)) ? Number(comment.y) : 0,
                    width: Number(comment.width) || 200,
                    height: Number(comment.height) || 120,
                    minimized: !!comment.minimized
                });
            };
            for (const b of blockArray) {
                if (!b || typeof b !== 'object') continue;
                const commentId = b.comment;
                const comment = parsedComments && commentId ? parsedComments[commentId] : null;
                if (comment && typeof comment.text === 'string') {
                    attachedCommentIds.add(commentId);
                    queueCommentForCreate(commentId, comment, b.id);
                } else {
                    b.comment = null;
                }
            }
            if (parsedComments) {
                for (const commentId of Object.keys(parsedComments)) {
                    if (attachedCommentIds.has(commentId)) continue;
                    queueCommentForCreate(commentId, parsedComments[commentId], null);
                }
            }

            // 自己 apply 回写 workspace 会立刻引起 VM emit workspaceUpdate/PROJECT_CHANGED；
            // 把抑制窗口拉到 apply 之后一段时间，避免回声把编辑器里刚输入的内容覆盖掉
            this.suppressRegenUntil = Date.now() + 1200;

            // 预先拿到 workspace 实例，顺便保存当前视口（scrollX/scrollY/scale）。
            // emitWorkspaceUpdate 触发 blocks.jsx.onWorkspaceUpdate → clearWorkspaceAndLoadFromXml 会把视口重置到原点；
            // blocks.jsx 本来有 workspaceMetrics 恢复逻辑，但那只在 target 已经有 metrics 时才生效，
            // 用户在当前角色首次打开编辑器或刚切角色时常常没 metrics → 每次 apply 就像跳回顶。
            // 这里自己存/恢一次，保证实时同步时视口不漂。
            const ws = isVisibleTarget && addon.tab.traps && typeof addon.tab.traps.getWorkspace === 'function'
                ? addon.tab.traps.getWorkspace() : null;
            // 装保险丝：让之后原生"Make a Variable"也会触发一次 flyout 重绘。幂等。
            installVariableFlyoutRefreshListener(ws);
            const savedView = ws ? {
                scrollX: ws.scrollX,
                scrollY: ws.scrollY,
                scale: ws.scale
            } : null;

            target.blocks.deleteAllBlocks();
            if (parsedComments) target.comments = {};
            for (const b of blockArray) target.blocks.createBlock(b);
            if (parsedComments && typeof target.createComment === 'function') {
                for (const comment of commentsToCreate) {
                    target.createComment(
                        comment.id,
                        comment.blockId,
                        comment.text,
                        comment.x,
                        comment.y,
                        comment.width,
                        comment.height,
                        comment.minimized
                    );
                }
            }
            target.blocks.updateTargetSpecificBlocks(target.isStage);
            target.blocks.resetCache();

            // —— Prune：删掉本地目标上没被引用、且也不在头部声明保留集里的 local 变量/列表 —— //
            // 只对非 stage target 生效；stage 上的条目都是 global，可能被其它 sprite 引用，不碰。
            // 广播也永远不删（global）。
            if (autoAlign && !target.isStage) {
                const referenced = new Set();
                for (const b of blockArray) {
                    if (b.fields) {
                        const v = b.fields.VARIABLE; if (v && v[1]) referenced.add(v[1]);
                        const l = b.fields.LIST;     if (l && l[1]) referenced.add(l[1]);
                    }
                    if (b.inputs) {
                        for (const k of Object.keys(b.inputs)) {
                            const input = b.inputs[k];
                            if (!Array.isArray(input)) continue;
                            for (let i = 1; i < input.length; i++) {
                                const v = input[i];
                                if (Array.isArray(v) && (v[0] === 12 || v[0] === 13) && v[2]) referenced.add(v[2]);
                            }
                        }
                    }
                }
                // 头部 declared 也算保留
                const reserveByName = (name, type) => {
                    const v = target.lookupVariableByNameAndType(name, type);
                    if (v) referenced.add(v.id);
                };
                for (const n of declaredVars) reserveByName(n, '');
                for (const n of declaredLists) reserveByName(n, 'list');
                for (const n of declaredLocalVars) reserveByName(n, '');
                for (const n of declaredLocalLists) reserveByName(n, 'list');
                for (const id of Object.keys(target.variables)) {
                    if (!referenced.has(id)) target.deleteVariable(id);
                }
            }

            // emitWorkspaceUpdate 是同步的：listener（blocks.jsx.onWorkspaceUpdate）里
            // clearWorkspaceAndLoadFromXml 也同步跑完，所以这一行返回时 Blockly 端的 SVG 已经渲染好、可测量高度。
            if (isVisibleTarget && typeof vm.emitWorkspaceUpdate === 'function') vm.emitWorkspaceUpdate();
            else if (typeof vm.emitTargetsUpdate === 'function') vm.emitTargetsUpdate(false);
            vm.runtime.emitProjectChanged();

            // 左侧 flyout（可拖动积木区）需要强制一次刷新，否则代码里新建的变量只出现在 dropdown 里，
            // 不会出现在"变量"类别的可拖动积木中。
            // 背景：变量分类在 toolbox XML 里只是 `<category custom="VARIABLE">`，实际变量清单是 flyout.show
            // 时 DataCategory 回调动态生成的。所以增减变量不会让 toolbox XML 变化，blocks.jsx 的
            // `toolboxXML !== _renderedToolboxXML` 判断为假 → React 那条 requestToolboxUpdate 通路不会触发。
            // clearWorkspaceAndLoadFromXml 结尾的 setToolboxRefreshEnabled(false→true) 理论上也会触发一次
            // refreshToolboxSelection_，但它有 `!currentGesture_ && toolboxRefreshEnabled_` 门槛，偶尔会静默跳过。
            // 解决：用 setTimeout(0) 排一次 refreshSelection，让它在 React 的 componentDidUpdate 链结束之后跑，
            // 走 toolbox_.refreshSelection()（无门槛）直接调 showAll_ 重建 flyout。
            // 不动 flyout.setRecyclingEnabled：之前在这里改过 false→true，会和 React 随后的
            // updateToolbox→populate_ 重建产生奇怪的交互，导致之后点原生"Make a Variable"按钮新建的变量
            // 在 flyout 里看不到。
            if (ws) {
                setTimeout(() => {
                    try {
                        if (ws.toolbox_ && ws.toolbox_.flyout_ && typeof ws.toolbox_.refreshSelection === 'function') {
                            ws.toolbox_.refreshSelection();
                        } else if (typeof ws.refreshToolboxSelection_ === 'function') {
                            ws.refreshToolboxSelection_();
                        }
                    } catch (_) { /* ignore */ }
                }, 0);
            }

            // 伪代码不带坐标时，紧接着同步重排顶块（用真实高度而不是估算）。
            // 关键是"同步"：浏览器在整个 tick 结束时才 paint 一次，用户看到的是最终版面，不会经过
            // "全叠在 (0,0)" → "粗略位置" → "精确位置" 这种多帧闪烁。
            // 不走 ws.cleanUp()：editor-devtools 重写了它，会弹 confirm 问孤儿/未使用变量。
            if (isVisibleTarget && this.state.mode === 'pseudo' && !this.includeCoords && ws && typeof ws.getTopBlocks === 'function') {
                const MIN_BLOCK_Y = 48; // 与 Blockly.BlockSvg.MIN_BLOCK_Y (竖排) 一致
                if (typeof ws.setResizesEnabled === 'function') ws.setResizesEnabled(false);
                try {
                    const top = ws.getTopBlocks(true);
                    let cursorY = 0;
                    for (const block of top) {
                        const xy = block.getRelativeToSurfaceXY();
                        block.moveBy(-xy.x, cursorY - xy.y);
                        if (typeof block.snapToGrid === 'function') block.snapToGrid();
                        const newXY = block.getRelativeToSurfaceXY();
                        cursorY = newXY.y + block.getHeightWidth().height + MIN_BLOCK_Y;
                    }
                } catch (_) { /* ignore */ }
                if (typeof ws.setResizesEnabled === 'function') ws.setResizesEnabled(true);
                this.suppressRegenUntil = Date.now() + 1200;
            }

            // 恢复视口。按 blocks.jsx:500-503 的做法直接赋值 scrollX/scrollY/scale 再 resize()。
            if (ws && savedView) {
                try {
                    ws.scrollX = savedView.scrollX;
                    ws.scrollY = savedView.scrollY;
                    if (typeof ws.scale === 'number' && typeof savedView.scale === 'number') {
                        ws.scale = savedView.scale;
                    }
                    if (typeof ws.resize === 'function') ws.resize();
                } catch (_) { /* ignore */ }
            }

            return {ok: true, count: blockArray.length, loadedExtensions: extensionCheck.loadedExtensions || []};
        };

        // 实时 apply：解析当前编辑器文本，若有效则静默写回积木区；无效则在状态栏显示错误
        autoApplyFromEditor = () => {
            const editor = this.jsonEditorComponent.current;
            if (!editor) return;
            const text = (editor.getText() || '').trim();
            if (!text) { this.clearError(); return; }
            if (this.projectLoading || !this.editorTargetId) return;
            const target = vm.editingTarget;
            if (!target) { this.setError('没有选中的角色或舞台'); return; }
            if (this.editorTargetId && target.id !== this.editorTargetId) {
                this.prepareForExternalWorkspaceReset();
                this.regenerateFromWorkspace();
                return;
            }

            let raw;
            let meta = null;
            if (this.state.mode === 'json') {
                const r = parseJsonLikeText(text);
                if (!r.ok) { this.setError(r.error); return; }
                if (!looksLikeBlocksObject(r.value)) { this.setError('JSON 结构不合法'); return; }
                raw = r.value;
            } else {
                const r = pseudoConverter.parsePseudocode(text, {target, vm});
                if (r.errors && r.errors.length) {
                    const msgs = r.errors.slice(0, 5)
                        .map(e => `第${Number(e && e.line) > 0 ? e.line : 1}行: ${e && e.message}`)
                        .join(' | ');
                    this.setError(`伪代码语法错误: ${msgs}`);
                    return;
                }
                raw = r.blocks;
                if (!Object.keys(raw).length && (!r.comments || !Object.keys(r.comments).length)) {
                    this.setError('伪代码里没有积木或注释');
                    return;
                }
                meta = this.createPseudoMeta(r);
            }
            // 解析结果和上次 apply 完全一致 → 纯空白/换行变化，没必要再动 workspace
            // meta 里的 pending/declared 可能随变量名字增减而变，哪怕 blocks JSON 没变也要进 apply 一次
            //   （比如用户在 #vars 里加了一个新声明），所以把 meta 摘要也纳入对比。
            const metaSummary = this.getPseudoMetaSummary(meta);
            const currentJson = JSON.stringify(raw) + '|' + metaSummary;
            if (currentJson === this.lastAppliedBlocksJson) {
                this.dirty = false;
                this.clearError();
                return;
            }
            const result = this.applyBlocksToWorkspace(raw, meta);
            if (!result.ok) { this.setError(result.error); return; }
            this.dirty = false;
            // 伪代码模式下把头部同步到 "声明 ∪ 引用"，并按当前 target 的作用域把变量/列表分到全局/局部。
            // 广播会根据 broadcast/on_broadcast 引用自动创建，不再回写 #broadcasts 头部。
            if (this.state.mode === 'pseudo' && meta) {
                const refs = collectReferencedNames(raw);
                const unionSet = (a, b) => { const s = new Set(a); for (const x of b) s.add(x); return s; };
                // 所有要在头部出现的名字 = 声明 ∪ 引用
                const allVarNames = unionSet(unionSet(meta.declaredVars, meta.declaredLocalVars), refs.vars);
                const allListNames = unionSet(unionSet(meta.declaredLists, meta.declaredLocalLists), refs.lists);

                // 按当前 target 实际作用域分类：局部 = 挂在当前非-stage target 的 variables 里
                const targetNow = vm.editingTarget;
                const isSpriteLocal = (name, wantType) => {
                    if (!targetNow || targetNow.isStage || !targetNow.variables) return false;
                    for (const id of Object.keys(targetNow.variables)) {
                        const v = targetNow.variables[id];
                        if (v && v.name === name && (v.type || '') === wantType) return true;
                    }
                    return false;
                };
                const splitByScope = (names, wantType) => {
                    const g = new Set(); const l = new Set();
                    for (const n of names) (isSpriteLocal(n, wantType) ? l : g).add(n);
                    return {g, l};
                };
                const varSplit = splitByScope(allVarNames, '');
                const listSplit = splitByScope(allListNames, 'list');
                const updatedText = this.syncEditorHeader({
                    vars: varSplit.g, localVars: varSplit.l,
                    lists: listSplit.g, localLists: listSplit.l,
                    broadcasts: new Set()
                });
                if (updatedText != null) {
                    const newMeta = JSON.stringify({
                        pV: [...meta.pendingVars.keys()],
                        pL: [...meta.pendingLists.keys()],
                        pB: [...meta.pendingBroadcasts.keys()],
                        dV: [...varSplit.g],
                        dL: [...listSplit.g],
                        dB: [],
                        dLV: [...varSplit.l],
                        dLL: [...listSplit.l],
                        c: meta.comments || {}
                    });
                    this.lastAppliedBlocksJson = JSON.stringify(raw) + '|' + newMeta;
                } else {
                    this.lastAppliedBlocksJson = currentJson;
                }
            } else {
                this.lastAppliedBlocksJson = currentJson;
            }
            const loadedExtensionText = result.loadedExtensions && result.loadedExtensions.length
                ? `，已自动加载扩展：${formatAiLoadedExtensions(result.loadedExtensions)}`
                : '';
            this.setSuccess(`✓ 已同步 ${result.count} 个积木${loadedExtensionText}`);
        };

        // 把编辑器顶部的 #vars/#localvars/#lists/#locallists 替换成 desired 集合（按名字排序）。
        // 旧的 #broadcasts/#广播 会在这里被移除；广播由引用自动创建，不再写头部。
        // 原文无头部时从头插入；有头部时整段覆盖。如果结果没变化返回 null，否则返回新文本。
        // 保留光标位置：光标在原头部内 → 挪到新头部末尾；在头部后 → 按 delta 平移。
        syncEditorHeader = desired => {
            const editor = this.jsonEditorComponent.current;
            if (!editor) return null;
            const oldText = editor.state.text;
            const region = findHeaderRegion(oldText);
            const existingHeader = oldText.slice(0, region.end);
            // 既有头部有任一 English 关键字 → English；否则看既有是否用了中文关键字；都没有就看正文。
            const hasEn = /#(?:vars|broadcasts|lists|localvars|locallists)\b/.test(existingHeader);
            const hasZhHeader = /#(?:变量|广播|列表|局部变量|局部列表)/.test(existingHeader);
            const useZh = hasEn ? false
                : (hasZhHeader || (!existingHeader && /#(?:变量|广播|列表|局部变量|局部列表)/.test(oldText)));
            const kw = useZh
                ? {vars: '变量', localVars: '局部变量', lists: '列表', localLists: '局部列表'}
                : {vars: 'vars', localVars: 'localvars', lists: 'lists', localLists: 'locallists'};
            const lines = [];
            const fmt = (key, set) => {
                if (!set || !set.size) return;
                const names = [...set].sort();
                lines.push(`#${kw[key]} { ${names.map(escapePseudoString).join(' ')} }`);
            };
            fmt('vars', desired.vars);
            fmt('localVars', desired.localVars);
            fmt('lists', desired.lists);
            fmt('localLists', desired.localLists);
            const newHeader = lines.length ? lines.join('\n\n') + '\n\n' : '';
            const rest = oldText.slice(region.indexAfterHeader);
            const newText = newHeader + rest;
            if (newText === oldText) return null;
            const ta = editor.textareaRef.current;
            const oldStart = ta ? ta.selectionStart : 0;
            const oldEnd = ta ? ta.selectionEnd : 0;
            const oldBoundary = region.indexAfterHeader;
            const delta = newText.length - oldText.length;
            const adjust = pos => {
                if (pos <= oldBoundary) return Math.min(pos, newHeader.length);
                return pos + delta;
            };
            editor.setState({
                text: newText,
                findMatches: editor.state.findQuery ? computeMatches(newText, editor.state.findQuery) : [],
                findIndex: 0
            }, () => {
                if (ta) ta.setSelectionRange(adjust(oldStart), adjust(oldEnd));
            });
            return newText;
        };

        // ---------------- 滚动跟随 ----------------
        getWorkspace = () => {
            if (addon.tab.traps && typeof addon.tab.traps.getWorkspace === 'function') {
                return addon.tab.traps.getWorkspace();
            }
            return null;
        };
        // 外部开关（复选框）：启用 → 开始轮询 workspace 滚动；禁用 → 停轮询
        setSyncScrollEnabled = enabled => {
            this.syncScroll = !!enabled;
            if (this.syncScroll && this.state.mode === 'pseudo') {
                this.startWsScrollPoll();
            } else {
                this.stopWsScrollPoll();
            }
        };
        startWsScrollPoll = () => {
            if (this.wsPollRAF !== null) return;
            const ws = this.getWorkspace();
            if (ws) {
                this.lastWsScrollY = ws.scrollY || 0;
                this.lastWsScrollX = ws.scrollX || 0;
                this.lastWsScale = ws.scale || 1;
            }
            const tick = () => {
                this.wsPollRAF = null;
                if (!this.syncScroll || this.state.mode !== 'pseudo') return;
                // 窗口隐藏时没必要轮询（节能）
                if (container.style.display === 'none') return;
                const w = this.getWorkspace();
                if (w) {
                    const sy = w.scrollY || 0;
                    const sx = w.scrollX || 0;
                    const sc = w.scale || 1;
                    if (sy !== this.lastWsScrollY || sx !== this.lastWsScrollX || sc !== this.lastWsScale) {
                        this.lastWsScrollY = sy;
                        this.lastWsScrollX = sx;
                        this.lastWsScale = sc;
                        if (Date.now() >= this.suppressWsScrollUntil) {
                            this.syncEditorToWorkspaceScroll();
                        }
                    }
                }
                this.wsPollRAF = requestAnimationFrame(tick);
            };
            this.wsPollRAF = requestAnimationFrame(tick);
        };
        stopWsScrollPoll = () => {
            if (this.wsPollRAF !== null) {
                cancelAnimationFrame(this.wsPollRAF);
                this.wsPollRAF = null;
            }
        };
        // 编辑器滚动 → 让工作区视口对齐到相应的积木位置。
        // 对齐基准：两边的"视口**上边界**"对齐。编辑器视口顶部那一行所属脚本的 fraction 位置，
        // 就是积木区视口顶部应该停的 block 内 fraction 位置。两侧能看到的内容起点一致。
        handleEditorScroll = scrollTop => {
            if (!this.syncScroll) return;
            if (this.state.mode !== 'pseudo') return;
            if (Date.now() < this.suppressEditorScrollUntil) return;
            const editor = this.jsonEditorComponent.current;
            if (!editor) return;
            const text = editor.getText();
            if (!text) return;
            const ws = this.getWorkspace();
            if (!ws || typeof ws.getTopBlocks !== 'function') return;
            const topBlocks = ws.getTopBlocks(true);
            if (!topBlocks.length) return;
            const ranges = scriptLineRanges(text);
            if (!ranges.length) return;

            const lineHeight = 13 * 1.4; // 与 sharedTextStyle 一致
            const viewportTopLine = scrollTop / lineHeight;
            // 视口顶部落在哪个脚本：第一个 endLine > viewportTopLine 的 range
            let scriptIdx = ranges.length - 1;
            for (let i = 0; i < ranges.length; i++) {
                if (ranges[i].endLine > viewportTopLine) { scriptIdx = i; break; }
            }
            if (scriptIdx >= topBlocks.length) scriptIdx = topBlocks.length - 1;
            const r = ranges[scriptIdx];
            const scriptLines = Math.max(1, r.endLine - r.startLine);
            const fraction = Math.max(0, Math.min(1, (viewportTopLine - r.startLine) / scriptLines));

            const block = topBlocks[scriptIdx];
            const xy = block.getRelativeToSurfaceXY();
            const hw = block.getHeightWidth();
            const scale = ws.scale || 1;
            // 让 workspace 中的这个像素位置出现在积木区视口**上边界**
            const pixelTopY = (xy.y + fraction * hw.height) * scale;

            try {
                const metrics = ws.getMetrics();
                // vScroll.set(value) 的 value = "内容顶部到视口上边界的像素距离"
                const sbY = pixelTopY - metrics.contentTop;
                if (ws.scrollbar && ws.scrollbar.vScroll && typeof ws.scrollbar.vScroll.set === 'function') {
                    this.suppressWsScrollUntil = Date.now() + 400;
                    ws.scrollbar.vScroll.set(sbY);
                }
            } catch (err) {
                console.warn('[json-script-converter] sync editor→ws scroll failed', err);
            }
        };
        // 工作区滚动 → 让编辑器滚动到相应的文本位置（同样以视口上边界为锚点，和 handleEditorScroll 互为逆）
        syncEditorToWorkspaceScroll = () => {
            const editor = this.jsonEditorComponent.current;
            if (!editor) return;
            const text = editor.getText();
            if (!text) return;
            const ws = this.getWorkspace();
            if (!ws || typeof ws.getTopBlocks !== 'function') return;
            const topBlocks = ws.getTopBlocks(true);
            if (!topBlocks.length) return;
            const ranges = scriptLineRanges(text);
            if (!ranges.length) return;

            const scale = ws.scale || 1;
            // 积木区视口**上边界**在 workspace 坐标下的 y
            const viewportTopWs = -(ws.scrollY || 0) / scale;
            // 上边界落在哪个顶块内：最后一个 y ≤ viewportTopWs 的块
            let idx = 0;
            for (let i = 0; i < topBlocks.length; i++) {
                const by = topBlocks[i].getRelativeToSurfaceXY().y;
                if (by <= viewportTopWs) idx = i;
                else break;
            }
            if (idx >= ranges.length) idx = ranges.length - 1;

            const block = topBlocks[idx];
            const xy = block.getRelativeToSurfaceXY();
            const hw = block.getHeightWidth();
            const blockH = Math.max(1, hw.height);
            const fraction = Math.max(0, Math.min(1, (viewportTopWs - xy.y) / blockH));

            const r = ranges[idx];
            const scriptLines = Math.max(1, r.endLine - r.startLine);
            const targetTopLine = r.startLine + fraction * scriptLines;
            const lineHeight = 13 * 1.4;
            // 让 targetTopLine 出现在编辑器视口**上边界**
            const targetScrollTop = Math.max(0, targetTopLine * lineHeight);
            this.suppressEditorScrollUntil = Date.now() + 400;
            editor.setScrollTop(targetScrollTop);
        };

        // 从当前角色积木区重新生成编辑器文本（由 workspace 变化触发）
        regenerateFromWorkspace = () => {
            const target = vm.editingTarget;
            if (!target) return;
            try {
                const serialized = sb3.serialize(vm.runtime, target.id);
                const blocksObj = (serialized && serialized.blocks) || {};
                const remapped = remapBlockIdsForEditor(blocksObj);
                let text;
                if (this.state.mode === 'json') {
                    text = stringifyForEditor(remapped);
                } else {
                    text = pseudoConverter.renderPseudocode(remapped, {target, vm}, {includeCoords: this.includeCoords});
                }
                const editor = this.jsonEditorComponent.current;
                if (!editor) return;
                this.editorTargetId = target.id;
                if (editor.getText() !== text) {
                    editor.setText(text);
                }
                this.dirty = false;
                this.clearError();
                // 把 lastAppliedBlocksJson 同步成"刚生成的文本再次 parse 后的结果"。
                // 这样用户在刚打开的窗口里纯打空格/换行，debounce 到 apply 时 parse 结果和这个相等 → 跳过，
                // 否则会把原本和 workspace 一致的文本再 apply 一遍，导致无谓的 delete+create+cleanUp 刷新。
                try {
                    if (this.state.mode === 'json') {
                        const r = parseJsonLikeText(text);
                        if (r.ok) this.lastAppliedBlocksJson = JSON.stringify(r.value) + '|';
                    } else {
                        const r = pseudoConverter.parsePseudocode(text, {target, vm});
                        if (!r.errors || !r.errors.length) {
                            const metaSummary = this.getPseudoMetaSummary(this.createPseudoMeta(r));
                            this.lastAppliedBlocksJson = JSON.stringify(r.blocks) + '|' + metaSummary;
                        }
                    }
                } catch (_) { /* 留前一次值即可 */ }
            } catch (err) {
                console.warn('[json-script-converter] regenerate from workspace failed', err);
            }
        };

        renderAiChat = () => {
            const config = this.state.aiConfig || {};
            const showConfig = this.state.aiConfigPanelOpen || !this.state.aiConfigReady;
            const fieldStyle = {
                height: 34,
                border: '1px solid #cbd5e1',
                borderRadius: 6,
                padding: '0 10px',
                fontSize: 13,
                color: '#172033',
                background: '#ffffff',
                minWidth: 0
            };
            const buttonStyle = {
                height: 34,
                border: '1px solid #cbd5e1',
                borderRadius: 6,
                background: '#ffffff',
                color: '#172033',
                fontSize: 13,
                fontWeight: 700,
                cursor: 'pointer',
                padding: '0 12px'
            };
            const primaryButtonStyle = {
                ...buttonStyle,
                background: (this.state.aiBusy || this.state.aiConfigTesting) ? '#94a3b8' : '#2563eb',
                borderColor: (this.state.aiBusy || this.state.aiConfigTesting) ? '#94a3b8' : '#2563eb',
                color: '#ffffff'
            };
            const messages = this.state.aiMessages;
            const conversations = Array.isArray(this.state.aiConversations) ? this.state.aiConversations : [];
            const sidebarCollapsed = !!this.state.aiSidebarCollapsed;
            const modelInputValue = this.state.aiModelInputValue || (this.aiModelRef.current && this.aiModelRef.current.value) || config.model || '';
            const visionEnabled = !!config.visionEnabled;
            const toolNoConfirm = !!config.toolNoConfirm;
            const requestRetryEnabled = config.requestRetryEnabled !== false;
            const requestRetryCount = normalizeAiRequestRetryCount(config.requestRetryCount);
            const mcpBridgeEnabled = !!this.state.mcpBridgeEnabled;
            const mcpBridgeStatus = this.state.mcpBridgeStatus || this.mcpBridgeLastStatus || 'disabled';
            const mcpBridgeUrl = this.state.mcpBridgeUrl || AI_MCP_BRIDGE_DEFAULT_URL;
            const hasDesktopMcpApi = !!(window.fortycodeDesktopMcp && typeof window.fortycodeDesktopMcp.start === 'function');
            const endpointInputValue = this.aiEndpointRef.current
                ? this.aiEndpointRef.current.value
                : (config.endpointInput || config.endpoint || '');
            const endpointPreviewState = getAiEndpointPreview(endpointInputValue);
            const endpointPreview = this.state.aiEndpointPreview || endpointPreviewState.endpoint;
            const endpointPreviewError = this.state.aiEndpointPreviewError || endpointPreviewState.error;
            const modelOptions = this.state.aiModels.slice();
            const getVisibleAiDetails = message => getAiVisibleDetailsForRender(message, this.state.aiShowProcessLog);
            const visibleMessages = getRenderableAiChatMessages(messages, this.state.aiShowProcessLog);
            const messageLimit = Number(this.state.aiVisibleMessageLimit) || AI_CHAT_RENDER_INITIAL_MESSAGES;
            const renderedMessages = visibleMessages.slice(-messageLimit);
            const hiddenOlderMessageCount = Math.max(0, visibleMessages.length - renderedMessages.length);
            if (config.model && !findAiModelRecord(modelOptions, config.model)) {
                modelOptions.unshift({
                    id: config.model,
                    visionSupport: getAiVisionSupport(config),
                    visionSupportSource: config.visionSupportSource || AI_VISION_SOURCE_SAVED,
                    raw: {id: config.model}
                });
            }
            const filteredModelOptions = modelOptions
                .filter(model => !modelInputValue ||
                    String(model.id).toLowerCase().indexOf(modelInputValue.toLowerCase()) >= 0)
                .slice(0, 80);
            const getModelBadge = model => {
                const support = model && model.visionSupport;
                const title = getAiModelVisionSupportMessage(model);
                if (support === AI_VISION_SUPPORTED) return {text: '视觉', color: '#047857', background: '#dcfce7', title};
                if (support === AI_VISION_UNSUPPORTED) return {text: '文本', color: '#64748b', background: '#f1f5f9', title};
                return {text: '未知', color: '#64748b', background: '#f8fafc', title};
            };
            const renderAiMessageContent = message => {
                const details = getVisibleAiDetails(message);
                const isPendingConfirmation = message.kind === 'confirm' &&
                    !message.confirmationResolved &&
                    message.confirmationId;
                const isLiveConfirmation = isPendingConfirmation &&
                    this.aiPendingConfirmations &&
                    this.aiPendingConfirmations.has(message.confirmationId);
                const isStaleConfirmation = isPendingConfirmation && !isLiveConfirmation;
                if (message.pending && !message.text && !details.length) {
                    return (
                        <span style={{display: 'inline-flex', alignItems: 'center', gap: 8}}>
                            <span className="jsonConverterAiSpinner" aria-hidden="true" />
                            <span>AI 正在思考...</span>
                        </span>
                    );
                }
                const renderDetail = (detail, detailIndex, keyPrefix) => {
                    const isReasoning = detail.key === 'reasoning';
                    const reasoningPreview = isReasoning
                        ? String(detail.content || '').replace(/\s+/g, ' ').trim()
                        : '';
                    const detailKey = [
                        keyPrefix,
                        detail.key || detail.title || 'detail',
                        detailIndex
                    ].join('-');
                    const diffRows = Array.isArray(detail.diff) ? detail.diff : null;
                    const compactDiff = diffRows && diffRows.length ? compactAiDiffRows(diffRows, 3) : null;
                    const renderDiffTable = (rows, maxHeight) => (
                        <div
                            style={{
                                maxHeight,
                                overflow: 'auto',
                                color: '#172033',
                                fontSize: 12,
                                lineHeight: 1.45,
                                fontFamily: 'Consolas, "SFMono-Regular", Menlo, Monaco, monospace',
                                tabSize: 4
                            }}
                        >
                            <div style={{minWidth: 'max-content'}}>
                                {rows.map((row, rowIndex) => {
                                    const type = row && row.type;
                                    const isAdd = type === 'add';
                                    const isRemove = type === 'remove';
                                    const isOmit = type === 'omit';
                                    return (
                                        <div
                                            key={`diff-${rowIndex}`}
                                            style={{
                                                display: 'grid',
                                                gridTemplateColumns: '42px 42px 18px minmax(0, 1fr)',
                                                gap: 0,
                                                background: isAdd ? '#dcfce7' : (isRemove ? '#fee2e2' : (isOmit ? '#f8fafc' : '#ffffff')),
                                                color: isAdd ? '#166534' : (isRemove ? '#991b1b' : (isOmit ? '#64748b' : '#172033')),
                                                whiteSpace: 'pre'
                                            }}
                                        >
                                            <span style={{padding: '0 6px', textAlign: 'right', color: '#94a3b8', userSelect: 'none'}}>
                                                {row.oldLine || ''}
                                            </span>
                                            <span style={{padding: '0 6px', textAlign: 'right', color: '#94a3b8', userSelect: 'none'}}>
                                                {row.newLine || ''}
                                            </span>
                                            <span style={{fontWeight: 700, userSelect: 'none'}}>
                                                {isAdd ? '+' : (isRemove ? '-' : ' ')}
                                            </span>
                                            <span style={{paddingRight: 10}}>
                                                {row.text || ' '}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                    return (
                        <details
                            key={detailKey}
                            style={{
                                marginTop: detailIndex || keyPrefix !== 'reasoning' ? 8 : 0,
                                border: '1px solid #dbe3ee',
                                borderRadius: 6,
                                background: '#f8fafc',
                                overflow: 'hidden'
                            }}
                        >
                            <summary
                                style={{
                                    cursor: 'pointer',
                                    padding: '7px 10px',
                                    color: '#334155',
                                    fontSize: 12,
                                    fontWeight: 700,
                                    userSelect: 'none',
                                    background: '#eef2f7'
                                }}
                            >
                                {isReasoning ? (
                                    <span style={{
                                        display: 'inline-flex',
                                        alignItems: 'baseline',
                                        gap: 8,
                                        maxWidth: 'calc(100% - 18px)',
                                        minWidth: 0,
                                        verticalAlign: 'top'
                                    }}>
                                        <span style={{flex: '0 0 auto'}}>AI 推理</span>
                                        {reasoningPreview ? (
                                            <span style={{
                                                flex: '1 1 auto',
                                                minWidth: 0,
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                                color: '#94a3b8',
                                                fontWeight: 400
                                            }}>
                                                {reasoningPreview}
                                            </span>
                                        ) : null}
                                    </span>
                                ) : (detail.title || '伪代码')}
                            </summary>
                            {compactDiff && compactDiff.rows.length ? (
                                <div
                                    style={{
                                        margin: 0,
                                        background: '#ffffff',
                                        color: '#172033'
                                    }}
                                >
                                    <div style={{
                                        display: 'flex',
                                        gap: 12,
                                        padding: '6px 10px',
                                        borderBottom: '1px solid #e2e8f0',
                                        color: '#64748b',
                                        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                                        fontSize: 11
                                    }}>
                                        <span><span style={{color: '#15803d', fontWeight: 700}}>绿色</span> 为新增</span>
                                        <span><span style={{color: '#b91c1c', fontWeight: 700}}>红色</span> 为删除</span>
                                        {compactDiff.hiddenCount ? (
                                            <span>默认只显示改动附近 {3} 行</span>
                                        ) : null}
                                    </div>
                                    {renderDiffTable(compactDiff.rows, 260)}
                                    {compactDiff.hiddenCount ? (
                                        <details style={{borderTop: '1px solid #e2e8f0'}}>
                                            <summary style={{
                                                cursor: 'pointer',
                                                padding: '7px 10px',
                                                color: '#475569',
                                                fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                                                fontSize: 12,
                                                fontWeight: 700,
                                                userSelect: 'none',
                                                background: '#f8fafc'
                                            }}>
                                                显示完整差异（含 {diffRows.length} 行）
                                            </summary>
                                            {renderDiffTable(diffRows, 360)}
                                        </details>
                                    ) : null}
                                </div>
                            ) : (
                                <pre
                                    style={{
                                        margin: 0,
                                        padding: '8px 10px',
                                        maxHeight: 260,
                                        overflow: 'auto',
                                        color: '#172033',
                                        fontSize: 12,
                                        lineHeight: 1.45,
                                        fontFamily: 'Consolas, "SFMono-Regular", Menlo, Monaco, monospace',
                                        whiteSpace: 'pre',
                                        tabSize: 4
                                    }}
                                >{detail.content || ''}</pre>
                            )}
                        </details>
                    );
                };
                const renderDetailGroup = groupDetails => (
                    <details
                        key="detail-group"
                        style={{
                            marginTop: parts.length ? 8 : 0,
                            border: '1px solid #dbe3ee',
                            borderRadius: 6,
                            background: '#f8fafc',
                            overflow: 'hidden'
                        }}
                    >
                        <summary
                            style={{
                                cursor: 'pointer',
                                padding: '7px 10px',
                                color: '#334155',
                                fontSize: 12,
                                fontWeight: 700,
                                userSelect: 'none',
                                background: '#eef2f7'
                            }}
                        >
                            处理详情（{groupDetails.length}）
                        </summary>
                        <div style={{padding: '0 8px 8px'}}>
                            {groupDetails.map((detail, detailIndex) =>
                                renderDetail(detail, detailIndex, 'group-detail')
                            )}
                        </div>
                    </details>
                );
                const text = String(message.text || '');
                const parts = [];
                const reasoningDetails = details.filter(detail => detail && detail.key === 'reasoning');
                const nonReasoningDetails = details.filter(detail => !detail || detail.key !== 'reasoning');
                const otherDetails = nonReasoningDetails
                    .filter(detail => !detail || detail.key !== 'process')
                    .concat(nonReasoningDetails.filter(detail => detail && detail.key === 'process'));
                reasoningDetails.forEach((detail, detailIndex) => {
                    parts.push(renderDetail(detail, detailIndex, 'reasoning'));
                });
                if (message.pending && !text && details.length) {
                    parts.push(
                        <span key="pending-with-details" style={{display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'pre-wrap'}}>
                            <span className="jsonConverterAiSpinner" aria-hidden="true" />
                            <span>AI 正在生成回复...</span>
                        </span>
                    );
                }
                const fenceRe = /```(?:pseudocode|text)?\n([\s\S]*?)```/g;
                let lastIndex = 0;
                let match;
                while ((match = fenceRe.exec(text))) {
                    const before = text.slice(lastIndex, match.index);
                    if (before) {
                        parts.push(
                            <span key={`text-${parts.length}`} style={{whiteSpace: 'pre-wrap'}}>
                                {before}
                            </span>
                        );
                    }
                    parts.push(
                        <pre
                            key={`code-${parts.length}`}
                            style={{
                                margin: before ? '8px 0 0' : 0,
                                padding: '8px 10px',
                                maxHeight: 260,
                                overflow: 'auto',
                                border: '1px solid #dbe3ee',
                                borderRadius: 6,
                                background: '#f8fafc',
                                color: '#172033',
                                fontSize: 12,
                                lineHeight: 1.45,
                                fontFamily: 'Consolas, "SFMono-Regular", Menlo, Monaco, monospace',
                                whiteSpace: 'pre',
                                tabSize: 4
                            }}
                        >{match[1].trim()}</pre>
                    );
                    lastIndex = fenceRe.lastIndex;
                }
                const tail = text.slice(lastIndex);
                if (tail) {
                    parts.push(
                        <span key={`text-${parts.length}`} style={{whiteSpace: 'pre-wrap'}}>
                            {tail}
                        </span>
                    );
                }
                if (isLiveConfirmation) {
                    parts.push(
                        <div
                            key="confirm-actions"
                            style={{
                                display: 'flex',
                                gap: 8,
                                flexWrap: 'wrap',
                                marginTop: 10,
                                padding: 10,
                                border: '1px solid #fdba74',
                                borderRadius: 8,
                                background: '#fff7ed'
                            }}
                        >
                            <button
                                type="button"
                                onClick={() => this.resolveAiUserConfirmation(message.confirmationId, true)}
                                style={{
                                    height: 34,
                                    border: '1px solid #dc2626',
                                    borderRadius: 6,
                                    background: '#dc2626',
                                    color: '#ffffff',
                                    fontSize: 13,
                                    fontWeight: 700,
                                    cursor: 'pointer',
                                    padding: '0 14px'
                                }}
                            >
                                确认删除
                            </button>
                            <button
                                type="button"
                                onClick={() => this.resolveAiUserConfirmation(message.confirmationId, false)}
                                style={{
                                    height: 34,
                                    border: '1px solid #cbd5e1',
                                    borderRadius: 6,
                                    background: '#ffffff',
                                    color: '#334155',
                                    fontSize: 13,
                                    fontWeight: 700,
                                    cursor: 'pointer',
                                    padding: '0 14px'
                                }}
                            >
                                取消
                            </button>
                        </div>
                    );
                } else if (isStaleConfirmation) {
                    parts.push(
                        <div
                            key="confirm-expired"
                            style={{
                                marginTop: 10,
                                padding: '8px 10px',
                                border: '1px solid #e2e8f0',
                                borderRadius: 8,
                                background: '#f8fafc',
                                color: '#64748b',
                                fontSize: 12,
                                lineHeight: 1.45
                            }}
                        >
                            这条确认已失效，请重新发起删除操作。
                        </div>
                    );
                }
                if ((message.kind === 'status' || message.kind === 'confirm') && otherDetails.length) {
                    parts.push(renderDetailGroup(otherDetails));
                } else {
                    otherDetails.forEach((detail, detailIndex) => {
                        parts.push(renderDetail(detail, detailIndex, 'detail'));
                    });
                }
                return parts.length ? parts : text;
            };
            const renderAiSidebar = () => {
                if (sidebarCollapsed) {
                    return (
                        <div style={{
                            width: 42,
                            flex: '0 0 42px',
                            borderRight: '1px solid #dbe3ee',
                            background: '#ffffff',
                            display: 'flex',
                            justifyContent: 'center',
                            paddingTop: 10
                        }}>
                            <button
                                type="button"
                                onClick={this.toggleAiSidebar}
                                style={{...buttonStyle, width: 28, height: 28, padding: 0}}
                                title="显示对话列表"
                            >
                                ›
                            </button>
                        </div>
                    );
                }
                return (
                    <aside style={{
                        width: 224,
                        flex: '0 0 224px',
                        borderRight: '1px solid #dbe3ee',
                        background: '#ffffff',
                        display: 'flex',
                        flexDirection: 'column',
                        minHeight: 0
                    }}>
                        <div style={{
                            padding: 10,
                            borderBottom: '1px solid #e2e8f0',
                            display: 'grid',
                            gridTemplateColumns: '1fr 32px',
                            gap: 8,
                            flexShrink: 0
                        }}>
                            <button
                                type="button"
                                disabled={this.state.aiBusy}
                                onClick={this.createNewAiChat}
                                style={{
                                    ...primaryButtonStyle,
                                    height: 32,
                                    opacity: this.state.aiBusy ? 0.7 : 1
                                }}
                            >
                                新的聊天
                            </button>
                            <button
                                type="button"
                                onClick={this.toggleAiSidebar}
                                style={{...buttonStyle, width: 32, height: 32, padding: 0}}
                                title="隐藏左侧"
                            >
                                ‹
                            </button>
                        </div>
                        <div style={{
                            flex: '1 1 auto',
                            minHeight: 0,
                            overflow: 'auto',
                            padding: 8,
                            display: 'grid',
                            alignContent: 'start',
                            gap: 6
                        }}>
                            {conversations.length ? conversations.map(conversation => {
                                const active = conversation.id === this.state.aiActiveConversationId;
                                return (
                                    <div
                                        key={conversation.id}
                                        style={{
                                            width: '100%',
                                            minHeight: 48,
                                            display: 'grid',
                                            gridTemplateColumns: 'minmax(0, 1fr) auto',
                                            alignItems: 'center',
                                            gap: 6,
                                            border: `1px solid ${active ? '#93c5fd' : 'transparent'}`,
                                            borderRadius: 7,
                                            background: active ? '#eff6ff' : '#ffffff',
                                            padding: '6px 6px 6px 8px',
                                            opacity: this.state.aiBusy && !active ? 0.65 : 1
                                        }}
                                    >
                                        <button
                                            type="button"
                                            disabled={this.state.aiBusy}
                                            onClick={() => this.selectAiConversation(conversation.id)}
                                            style={{
                                                minWidth: 0,
                                                border: 0,
                                                background: 'transparent',
                                                color: '#172033',
                                                padding: 0,
                                                textAlign: 'left',
                                                cursor: this.state.aiBusy ? 'default' : 'pointer'
                                            }}
                                        >
                                            <span style={{
                                                display: 'block',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                                fontSize: 13,
                                                fontWeight: active ? 700 : 600,
                                                lineHeight: 1.35
                                            }}>
                                                {conversation.title || '新的聊天'}
                                            </span>
                                            <span style={{
                                                display: 'block',
                                                marginTop: 3,
                                                color: '#94a3b8',
                                                fontSize: 11,
                                                lineHeight: 1.25
                                            }}>
                                                {formatAiConversationTime(conversation.updatedAt)}
                                            </span>
                                        </button>
                                        <div style={{display: 'flex', gap: 4}}>
                                            <button
                                                type="button"
                                                onClick={() => this.exportAiConversation(conversation.id)}
                                                style={{
                                                    width: 30,
                                                    height: 28,
                                                    border: '1px solid #cbd5e1',
                                                    borderRadius: 6,
                                                    background: '#ffffff',
                                                    color: '#475569',
                                                    fontSize: 11,
                                                    fontWeight: 700,
                                                    cursor: 'pointer',
                                                    padding: 0
                                                }}
                                                title="导出此聊天为 TXT"
                                            >
                                                TXT
                                            </button>
                                            <button
                                                type="button"
                                                disabled={this.state.aiBusy}
                                                onClick={() => this.deleteAiConversation(conversation.id)}
                                                style={{
                                                    width: 28,
                                                    height: 28,
                                                    border: '1px solid #fecaca',
                                                    borderRadius: 6,
                                                    background: '#fff1f2',
                                                    color: '#be123c',
                                                    fontSize: 16,
                                                    fontWeight: 700,
                                                    lineHeight: 1,
                                                    cursor: this.state.aiBusy ? 'default' : 'pointer',
                                                    opacity: this.state.aiBusy ? 0.55 : 1,
                                                    padding: 0
                                                }}
                                                title="删除此聊天记录"
                                            >
                                                ×
                                            </button>
                                        </div>
                                    </div>
                                );
                            }) : (
                                <div style={{
                                    color: '#94a3b8',
                                    fontSize: 12,
                                    lineHeight: 1.45,
                                    padding: 8
                                }}>
                                    暂无聊天记录
                                </div>
                            )}
                        </div>
                    </aside>
                );
            };
            return (
                <section
                    className="jsonConverterAiPanel"
                    style={{
                        width: '100%',
                        height: '100%',
                        minWidth: 0,
                        background: '#f8fafc',
                        display: 'flex',
                        flexDirection: 'column'
                    }}
                >
                    {showConfig ? (
                        <div style={{
                            flex: '1 1 auto',
                            minHeight: 0,
                            display: 'flex',
                            alignItems: 'flex-start',
                            justifyContent: 'center',
                            padding: 24,
                            overflow: 'auto'
                        }}>
                            <div style={{
                                width: 'min(560px, 100%)',
                                display: 'grid',
                                gap: 12,
                                paddingBottom: 24
                            }}>
                                <input
                                    ref={this.aiEndpointRef}
                                    defaultValue={config.endpointInput || config.endpoint || ''}
                                    placeholder="https://api.example.com 或 https://api.example.com/v1"
                                    onChange={this.handleAiEndpointInputChange}
                                    onBlur={this.handleAiEndpointInputChange}
                                    style={fieldStyle}
                                />
                                {(endpointPreview || endpointPreviewError) ? (
                                    <div style={{
                                        marginTop: -7,
                                        color: endpointPreviewError ? '#b91c1c' : '#475569',
                                        fontSize: 12,
                                        lineHeight: 1.45,
                                        wordBreak: 'break-all'
                                    }}>
                                        {endpointPreviewError ? `实际地址无法解析：${endpointPreviewError}` : `实际地址：${endpointPreview}`}
                                    </div>
                                ) : null}
                                <div style={{position: 'relative', display: 'grid', gap: 6}}>
                                    <input
                                        ref={this.aiModelRef}
                                        value={modelInputValue}
                                        placeholder={this.state.aiModelsLoading ? '正在获取模型列表...' : 'Model（可手动输入，也可从候选列表选择）'}
                                        onFocus={() => this.setState({aiModelMenuOpen: true})}
                                        onBlur={() => setTimeout(() => this.setState({aiModelMenuOpen: false}), 120)}
                                        onChange={this.handleAiModelInputChange}
                                        style={{
                                            ...fieldStyle,
                                            width: '100%',
                                            paddingRight: 88,
                                            boxSizing: 'border-box'
                                        }}
                                    />
                                    <span style={{
                                        position: 'absolute',
                                        right: 10,
                                        top: 8,
                                        color: '#94a3b8',
                                        fontSize: 12,
                                        pointerEvents: 'none'
                                    }}>
                                        {this.state.aiModelsLoading ? '获取中' : `${modelOptions.length || 0} 个`}
                                    </span>
                                    {this.state.aiModelMenuOpen && (filteredModelOptions.length || this.state.aiModelsLoading) ? (
                                        <div className="jsonConverterAiModelMenu" style={{
                                            maxHeight: 176,
                                            overflowY: 'scroll',
                                            overflowX: 'hidden',
                                            scrollbarGutter: 'stable',
                                            border: '1px solid #cbd5e1',
                                            borderRadius: 8,
                                            background: '#ffffff',
                                            boxShadow: '0 4px 12px rgba(15, 23, 42, 0.08)',
                                            padding: 6
                                        }}>
                                            {this.state.aiModelsLoading ? (
                                                <div style={{
                                                    padding: '9px 10px',
                                                    color: '#64748b',
                                                    fontSize: 12
                                                }}>
                                                    正在获取模型列表...
                                                </div>
                                            ) : filteredModelOptions.map(model => {
                                                const badge = getModelBadge(model);
                                                return (
                                                    <button
                                                        key={model.id}
                                                        type="button"
                                                        title={`${model.id}\n${badge.title}`}
                                                        onMouseDown={e => e.preventDefault()}
                                                        onClick={() => this.chooseAiModelOption(model)}
                                                        style={{
                                                            width: '100%',
                                                            minHeight: 36,
                                                            display: 'grid',
                                                            gridTemplateColumns: 'minmax(0, 1fr) auto',
                                                            alignItems: 'center',
                                                            gap: 10,
                                                            border: 0,
                                                            borderRadius: 6,
                                                            background: model.id === modelInputValue ? '#eff6ff' : '#ffffff',
                                                            color: '#172033',
                                                            cursor: 'pointer',
                                                            padding: '7px 8px',
                                                            textAlign: 'left'
                                                        }}
                                                    >
                                                        <span style={{
                                                            overflow: 'hidden',
                                                            textOverflow: 'ellipsis',
                                                            whiteSpace: 'nowrap',
                                                            fontSize: 13,
                                                            fontWeight: 600
                                                        }}>
                                                            {model.id}
                                                        </span>
                                                        <span style={{
                                                            borderRadius: 999,
                                                            background: badge.background,
                                                            color: badge.color,
                                                            fontSize: 11,
                                                            fontWeight: 700,
                                                            lineHeight: 1,
                                                            padding: '4px 7px'
                                                        }} title={badge.title}>
                                                            {badge.text}
                                                        </span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    ) : null}
                                </div>
                                <input
                                    ref={this.aiApiKeyRef}
                                    defaultValue={config.apiKey || ''}
                                    placeholder="Token"
                                    type="password"
                                    onChange={this.handleAiEndpointInputChange}
                                    onBlur={this.handleAiEndpointInputChange}
                                    style={fieldStyle}
                                />
                                <label style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'auto minmax(0, 1fr)',
                                    gap: 10,
                                    alignItems: 'start',
                                    padding: '10px 11px',
                                    border: '1px solid #dbe3ee',
                                    borderRadius: 8,
                                    background: visionEnabled ? '#f0fdf4' : '#ffffff',
                                    cursor: 'pointer'
                                }}>
                                    <input
                                        ref={this.aiVisionEnabledRef}
                                        className="jsonConverterCheckbox"
                                        type="checkbox"
                                        checked={visionEnabled}
                                        onChange={this.handleAiVisionEnabledChange}
                                        style={{
                                            width: 16,
                                            height: 16,
                                            margin: '2px 0 0',
                                            accentColor: '#16a34a',
                                            cursor: 'pointer'
                                        }}
                                    />
                                    <span style={{minWidth: 0}}>
                                        <span style={{
                                            display: 'block',
                                            color: '#172033',
                                            fontSize: 13,
                                            fontWeight: 700,
                                            lineHeight: 1.35
                                        }}>
                                            启用图像理解
                                        </span>
                                        <span style={{
                                            display: 'block',
                                            marginTop: 3,
                                            color: '#64748b',
                                            fontSize: 12,
                                            lineHeight: 1.45
                                        }}>
                                            开启后，AI 可请求读取造型图片和舞台截图；请确认当前模型/API 支持图片输入。模型候选里的“视觉/文本/未知”仅供参考。
                                        </span>
                                    </span>
                                </label>
                                <label style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'auto minmax(0, 1fr)',
                                    gap: 10,
                                    alignItems: 'start',
                                    padding: '10px 11px',
                                    border: '1px solid #dbe3ee',
                                    borderRadius: 8,
                                    background: toolNoConfirm ? '#fff7ed' : '#ffffff',
                                    cursor: 'pointer'
                                }}>
                                    <input
                                        ref={this.aiToolNoConfirmRef}
                                        className="jsonConverterCheckbox"
                                        type="checkbox"
                                        checked={toolNoConfirm}
                                        onChange={this.handleAiToolNoConfirmChange}
                                        style={{
                                            width: 16,
                                            height: 16,
                                            margin: '2px 0 0',
                                            accentColor: '#f97316',
                                            cursor: 'pointer'
                                        }}
                                    />
                                    <span style={{minWidth: 0}}>
                                        <span style={{
                                            display: 'block',
                                            color: '#172033',
                                            fontSize: 13,
                                            fontWeight: 700,
                                            lineHeight: 1.35
                                        }}>
                                            调用工具无需确认
                                        </span>
                                        <span style={{
                                            display: 'block',
                                            marginTop: 3,
                                            color: '#64748b',
                                            fontSize: 12,
                                            lineHeight: 1.45
                                        }}>
                                            开启后，AI 执行删除角色、删除造型等需要确认的工具时会直接继续。
                                        </span>
                                    </span>
                                </label>
                                <div style={{
                                    display: 'grid',
                                    gap: 8,
                                    padding: '10px 11px',
                                    border: '1px solid #dbe3ee',
                                    borderRadius: 8,
                                    background: mcpBridgeEnabled ? '#eff6ff' : '#ffffff'
                                }}>
                                    <label style={{
                                        display: 'grid',
                                        gridTemplateColumns: 'auto minmax(0, 1fr)',
                                        gap: 10,
                                        alignItems: 'start',
                                        cursor: 'pointer'
                                    }}>
                                        <input
                                            className="jsonConverterCheckbox"
                                            type="checkbox"
                                            checked={mcpBridgeEnabled}
                                            onChange={this.handleMcpBridgeEnabledChange}
                                            style={{
                                                width: 16,
                                                height: 16,
                                                margin: '2px 0 0',
                                                accentColor: '#2563eb',
                                                cursor: 'pointer'
                                            }}
                                        />
                                        <span style={{minWidth: 0}}>
                                            <span style={{
                                                display: 'block',
                                                color: '#172033',
                                                fontSize: 13,
                                                fontWeight: 700,
                                                lineHeight: 1.35
                                            }}>
                                                启用 MCP 桥接
                                            </span>
                                            {mcpBridgeEnabled ? (
                                                <span style={{
                                                    display: 'block',
                                                    marginTop: 3,
                                                    color: '#64748b',
                                                    fontSize: 12,
                                                    lineHeight: 1.45
                                                }}>
                                                    {hasDesktopMcpApi
                                                        ? '开启后桌面端会启动本地 MCP 服务，并允许外部客户端调用当前页面工具。'
                                                        : (
                                                            <React.Fragment>
                                                                需要先
                                                                <a
                                                                    href={AI_MCP_BRIDGE_EXE_DOWNLOAD_URL}
                                                                    download={AI_MCP_BRIDGE_EXE_NAME}
                                                                    onClick={event => event.stopPropagation()}
                                                                    onMouseDown={event => event.stopPropagation()}
                                                                    style={{
                                                                        color: '#2563eb',
                                                                        fontWeight: 700,
                                                                        textDecoration: 'none'
                                                                    }}
                                                                >
                                                                    下载并运行 {AI_MCP_BRIDGE_EXE_NAME}
                                                                </a>
                                                                ，再开启桥接。
                                                            </React.Fragment>
                                                        )}
                                                </span>
                                            ) : null}
                                        </span>
                                    </label>
                                    {mcpBridgeEnabled ? (
                                        <React.Fragment>
                                            <input
                                                ref={this.mcpBridgeUrlRef}
                                                value={mcpBridgeUrl}
                                                placeholder={AI_MCP_BRIDGE_DEFAULT_URL}
                                                onChange={this.handleMcpBridgeUrlChange}
                                                onBlur={this.handleMcpBridgeUrlBlur}
                                                style={{
                                                    ...fieldStyle,
                                                    height: 30,
                                                    fontSize: 12
                                                }}
                                            />
                                            <div style={{
                                                color: mcpBridgeStatus === 'connected' ? '#047857' : '#64748b',
                                                fontSize: 12,
                                                lineHeight: 1.35
                                            }}>
                                                MCP 状态：{formatMcpBridgeStatus(mcpBridgeStatus)}
                                            </div>
                                        </React.Fragment>
                                    ) : null}
                                </div>
                                <div style={{
                                    display: 'grid',
                                    gap: 8,
                                    padding: '10px 11px',
                                    border: '1px solid #dbe3ee',
                                    borderRadius: 8,
                                    background: requestRetryEnabled ? '#eff6ff' : '#ffffff'
                                }}>
                                    <label style={{
                                        display: 'grid',
                                        gridTemplateColumns: 'auto minmax(0, 1fr)',
                                        gap: 10,
                                        alignItems: 'start',
                                        cursor: 'pointer'
                                    }}>
                                        <input
                                            ref={this.aiRequestRetryEnabledRef}
                                            className="jsonConverterCheckbox"
                                            type="checkbox"
                                            checked={requestRetryEnabled}
                                            onChange={this.handleAiRequestRetryEnabledChange}
                                            style={{
                                                width: 16,
                                                height: 16,
                                                margin: '2px 0 0',
                                                accentColor: '#2563eb',
                                                cursor: 'pointer'
                                            }}
                                        />
                                        <span style={{minWidth: 0}}>
                                            <span style={{
                                                display: 'block',
                                                color: '#172033',
                                                fontSize: 13,
                                                fontWeight: 700,
                                                lineHeight: 1.35
                                            }}>
                                                请求失败自动重试
                                            </span>
                                            <span style={{
                                                display: 'block',
                                                marginTop: 3,
                                                color: '#64748b',
                                                fontSize: 12,
                                                lineHeight: 1.45
                                            }}>
                                                网络错误、限流或服务器临时错误会自动再次请求。
                                            </span>
                                        </span>
                                    </label>
                                    <div style={{
                                        display: 'grid',
                                        gridTemplateColumns: 'minmax(0, 1fr) 88px',
                                        gap: 8,
                                        alignItems: 'center',
                                        paddingLeft: 26
                                    }}>
                                        <span style={{
                                            color: '#64748b',
                                            fontSize: 12,
                                            lineHeight: 1.35
                                        }}>
                                            最多重试次数
                                        </span>
                                        <input
                                            ref={this.aiRequestRetryCountRef}
                                            type="number"
                                            min="0"
                                            max={AI_REQUEST_RETRY_MAX_COUNT}
                                            step="1"
                                            value={requestRetryCount}
                                            disabled={!requestRetryEnabled}
                                            onChange={this.handleAiRequestRetryCountChange}
                                            aria-label="最多重试次数"
                                            style={{
                                                ...fieldStyle,
                                                height: 30,
                                                opacity: requestRetryEnabled ? 1 : 0.6
                                            }}
                                        />
                                    </div>
                                </div>
                                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8}}>
                                    <button
                                        type="button"
                                        disabled={this.state.aiConfigTesting}
                                        onClick={this.testAiConfigFromInputs}
                                        style={primaryButtonStyle}
                                    >
                                        {this.state.aiConfigTesting ? '检测中' : '检测接口'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={this.saveAiConfigFromInputs}
                                        style={buttonStyle}
                                    >
                                        保存配置
                                    </button>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div style={{
                            flex: '1 1 auto',
                            minHeight: 0,
                            display: 'flex',
                            overflow: 'hidden'
                        }}>
                            {renderAiSidebar()}
                            <div style={{
                                flex: '1 1 auto',
                                minWidth: 0,
                                minHeight: 0,
                                display: 'flex',
                                flexDirection: 'column'
                            }}>
                                <div
                                    ref={this.aiMessagesRef}
                                    onScroll={this.handleAiMessagesScroll}
                                    onWheel={this.handleAiMessagesUserScrollIntent}
                                    onPointerDown={this.handleAiMessagesUserScrollIntent}
                                    onTouchStart={this.handleAiMessagesUserScrollIntent}
                                    style={{
                                        flex: '1 1 auto',
                                        minHeight: 0,
                                        overflow: 'auto',
                                        overscrollBehavior: 'contain',
                                        padding: 14,
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: 10
                                    }}
                                >
                                    {hiddenOlderMessageCount ? (
                                        <button
                                            type="button"
                                            onClick={this.loadOlderAiMessages}
                                            style={{
                                                alignSelf: 'center',
                                                border: '1px solid #cbd5e1',
                                                borderRadius: 999,
                                                background: '#ffffff',
                                                color: '#64748b',
                                                fontSize: 12,
                                                fontWeight: 700,
                                                cursor: 'pointer',
                                                padding: '6px 12px'
                                            }}
                                        >
                                            加载更早的聊天（还有 {hiddenOlderMessageCount} 条）
                                        </button>
                                    ) : null}
                                    {visibleMessages.length ? renderedMessages.map((message, index) => {
                                        const isStatus = message.kind === 'status' || message.kind === 'confirm';
                                        const isConfirm = message.kind === 'confirm' && !message.confirmationResolved;
                                        return (
                                            <div
                                                key={message.id || `${message.time}-${index}`}
                                                style={{
                                                    alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
                                                    maxWidth: isConfirm ? '88%' : '78%',
                                                    border: `1px solid ${message.role === 'user' ? '#bfdbfe' : (isConfirm ? '#fdba74' : '#e2e8f0')}`,
                                                    borderRadius: 8,
                                                    padding: '9px 11px',
                                                    background: message.role === 'user'
                                                        ? '#eff6ff'
                                                        : (isConfirm ? '#fffaf0' : (isStatus ? '#f1f5f9' : '#ffffff')),
                                                    color: isConfirm ? '#172033' : (isStatus ? '#64748b' : '#172033'),
                                                    fontSize: isConfirm ? 13 : (isStatus ? 12 : 13),
                                                    lineHeight: 1.45,
                                                    whiteSpace: 'pre-wrap'
                                                }}
                                            >
                                                {renderAiMessageContent(message)}
                                            </div>
                                        );
                                    }) : (
                                        <div style={{
                                            color: '#64748b',
                                            fontSize: 13,
                                            lineHeight: 1.45,
                                            padding: '8px 2px'
                                        }}>
                                            直接输入需求。当前伪代码为空时，AI 会生成第一版。
                                        </div>
                                    )}
                                </div>
                                <div style={{
                                    padding: 12,
                                    borderTop: '1px solid #dbe3ee',
                                    background: '#ffffff',
                                    display: 'grid',
                                    gap: 8,
                                    flexShrink: 0
                                }}>
                                    <textarea
                                        ref={this.aiInputRef}
                                        placeholder="输入要生成或修改的内容...（Enter 发送，Ctrl+Enter 换行）"
                                        rows={3}
                                        disabled={this.state.aiBusy}
                                        style={{
                                            resize: 'vertical',
                                            minHeight: 72,
                                            maxHeight: 160,
                                            border: '1px solid #cbd5e1',
                                            borderRadius: 8,
                                            padding: 9,
                                            fontSize: 13,
                                            lineHeight: 1.4,
                                            color: '#172033',
                                            background: this.state.aiBusy ? '#f1f5f9' : '#ffffff'
                                        }}
                                    />
                                    <button
                                        type="button"
                                        onClick={this.submitAiChat}
                                        style={primaryButtonStyle}
                                    >
                                        {this.state.aiBusy ? '中断' : '发送'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </section>
            );
        };

        render () {
            return (
                <div style={{display: 'flex', height: '100%', width: '100%', minWidth: 0}}>
                    <div style={{
                        flexGrow: 1,
                        overflow: 'hidden',
                        position: 'relative',
                        minWidth: 0,
                        display: this.state.aiChatOpen ? 'none' : 'block'
                    }}>
                        <JsonEditorComponent
                            ref={this.jsonEditorComponent}
                            initialText=""
                            mode={this.state.mode}
                            onChange={this.handleJsonChange}
                            onScroll={this.handleEditorScroll}
                            completionKeywords={this.state.mode === 'pseudo' ? PSEUDO_KEYWORDS : []}
                            getDynamicKeywords={this.state.mode === 'pseudo' ? this.getDynamicKeywords : null}
                            getContextualCompletions={this.state.mode === 'pseudo' ? this.getContextualCompletions : null}
                        />
                    </div>
                    {this.state.aiChatOpen ? this.renderAiChat() : null}
                </div>
            );
        }
    }

    let reactModalInstance = null;
    let initButton = null;

    const syncLauncherAiState = aiBusy => {
        if (initButton) {
            initButton.textContent = aiBusy ? 'AI运行中...' : '脚本助手';
            initButton.title = aiBusy
                ? 'AI 正在后台继续运行，点击查看进度（可拖动）'
                : '打开伪代码与 AI 积木编辑助手（可拖动）';
            initButton.classList.toggle('is-running', !!aiBusy);
            initButton.setAttribute('aria-busy', aiBusy ? 'true' : 'false');
        }
        if (closeButton) {
            closeButton.title = aiBusy
                ? '关闭窗口，AI 会继续运行'
                : (msg ? (msg('close') || 'Close') : 'Close');
        }
    };

    const renderModal = () => {
        if (!document.body.contains(container)) document.body.appendChild(container);
        ReactDOM.render(
            <JsonScriptConverterModal ref={instance => { reactModalInstance = instance; }} />,
            jsonEditorContainer
        );
    };

    // 模式切换按钮：JSON ↔ 伪代码
    const toolbarButtonStyle = `
        height: 32px;
        padding: 0 12px;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        background: #f8fafc;
        color: #172033;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 1px 2px rgba(15,23,42,0.06);
    `;
    const modeToggleButton = document.createElement('button');
    modeToggleButton.className = 'jsonConverterActionButton jsonConverterModeButton';
    modeToggleButton.style.cssText = `${toolbarButtonStyle}background:#2563eb;color:#ffffff;border-color:#2563eb;`;
    modeToggleButton.textContent = '当前: 伪代码';
    modeToggleButton.title = '切换编辑模式。切换时会按当前模式解析编辑器内容，再按目标模式渲染。';
    buttonContainer.appendChild(modeToggleButton);

    // 滚动跟随复选框：只在伪代码模式下显示（JSON 无"脚本 ↔ 行"对应关系）
    const syncScrollLabel = document.createElement('label');
    syncScrollLabel.className = 'jsonConverterSyncLabel';
    syncScrollLabel.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:13px;color:#334155;cursor:pointer;user-select:none;height:32px;padding:0 6px;';
    syncScrollLabel.title = '编辑器 ↔ 积木区 滚动互相跟随（仅伪代码模式）';
    const syncScrollCheckbox = document.createElement('input');
    syncScrollCheckbox.type = 'checkbox';
    syncScrollCheckbox.checked = true;
    syncScrollCheckbox.className = 'jsonConverterCheckbox';
    syncScrollCheckbox.style.cssText = 'margin:0;cursor:pointer;width:14px;height:14px;accent-color:#2563eb;';
    syncScrollCheckbox.onchange = () => {
        if (!reactModalInstance) return;
        reactModalInstance.setSyncScrollEnabled(syncScrollCheckbox.checked);
    };
    syncScrollLabel.appendChild(syncScrollCheckbox);
    syncScrollLabel.appendChild(document.createTextNode('滚动跟随'));
    buttonContainer.appendChild(syncScrollLabel);

    // 伪代码 → 中文 / opcode 一键转换；仅伪代码模式下显示
    const translateZhButton = document.createElement('button');
    translateZhButton.className = 'jsonConverterActionButton';
    translateZhButton.style.cssText = toolbarButtonStyle;
    translateZhButton.textContent = '转中文';
    translateZhButton.title = '把编辑器里的 friendly name / opcode 替换成中文关键字（不影响字符串和注释）';
    translateZhButton.onclick = () => {
        if (!reactModalInstance) return;
        reactModalInstance.translateLanguage('zh');
    };
    buttonContainer.appendChild(translateZhButton);

    const translateOpButton = document.createElement('button');
    translateOpButton.className = 'jsonConverterActionButton';
    translateOpButton.style.cssText = toolbarButtonStyle;
    translateOpButton.textContent = '转opcode';
    translateOpButton.title = '把编辑器里的 friendly name / 中文关键字替换成原版 opcode（不影响字符串和注释）';
    translateOpButton.onclick = () => {
        if (!reactModalInstance) return;
        reactModalInstance.translateLanguage('op');
    };
    buttonContainer.appendChild(translateOpButton);

    const aiModifyButton = document.createElement('button');
    aiModifyButton.className = 'jsonConverterActionButton jsonConverterAiButton';
    aiModifyButton.style.cssText = `${toolbarButtonStyle}background:#fff7ed;border-color:#fed7aa;color:#9a3412;`;
    aiModifyButton.textContent = 'AI修改';
    aiModifyButton.title = '打开 AI 聊天面板';
    aiModifyButton.onclick = () => {
        if (!reactModalInstance) return;
        reactModalInstance.openAiChat();
    };
    buttonContainer.appendChild(aiModifyButton);

    const updateSyncCheckboxVisibility = mode => {
        const show = mode === 'pseudo';
        syncScrollLabel.style.display = show ? 'flex' : 'none';
        translateZhButton.style.display = show ? '' : 'none';
        translateOpButton.style.display = show ? '' : 'none';
        aiModifyButton.style.display = show ? '' : 'none';
    };

    modeToggleButton.onclick = () => {
        if (!reactModalInstance) {
            setStatus('内部错误：React 组件实例丢失。请关闭浮窗重开。', 'error');
            return;
        }
        const cur = reactModalInstance.getMode();
        const next = cur === 'json' ? 'pseudo' : 'json';
        reactModalInstance.switchMode(next);
    };

    // 实时双向同步的核心：监听 VM 事件 → 在安全时机从工作区重新生成编辑器文本。
    // 普通积木变化走温和 debounce；切换角色/打开新作品是外部上下文切换，必须清掉旧 target
    // 的待 apply 任务并强制重渲染，否则旧伪代码会留在浮窗里，甚至可能延迟写到新角色上。
    let lastObservedEditingTargetId = vm.editingTarget ? vm.editingTarget.id : null;
    let projectLoadRefreshTimers = [];
    const getEditingTargetId = () => (vm.editingTarget ? vm.editingTarget.id : null);
    const clearProjectLoadRefreshTimers = () => {
        for (const timer of projectLoadRefreshTimers) clearTimeout(timer);
        projectLoadRefreshTimers = [];
    };
    const scheduleRegenerateFromWorkspace = ({force = false, delay = 300} = {}) => {
        if (container.style.display === 'none') return;
        if (!reactModalInstance) return;
        if (force) {
            reactModalInstance.prepareForExternalWorkspaceReset();
        } else {
            if (Date.now() < reactModalInstance.suppressRegenUntil) return;
            if (reactModalInstance.applyDebounceTimer !== null) return;
        }
        if (reactModalInstance.regenDebounceTimer) clearTimeout(reactModalInstance.regenDebounceTimer);
        reactModalInstance.regenDebounceTimer = setTimeout(() => {
            reactModalInstance.regenDebounceTimer = null;
            if (container.style.display === 'none') return;
            if (!reactModalInstance) return;
            // 再 check 一遍，debounce 期间可能进入抑制窗口
            if (!force) {
                if (Date.now() < reactModalInstance.suppressRegenUntil) return;
                if (reactModalInstance.applyDebounceTimer !== null) return;
            }
            reactModalInstance.regenerateFromWorkspace();
            if (reactModalInstance.syncScroll && reactModalInstance.getMode() === 'pseudo') {
                reactModalInstance.stopWsScrollPoll();
                reactModalInstance.startWsScrollPoll();
            }
        }, delay);
    };
    const beginProjectLoad = () => {
        clearProjectLoadRefreshTimers();
        lastObservedEditingTargetId = null;
        if (reactModalInstance) {
            reactModalInstance.prepareForProjectLoad();
        }
    };
    const queueProjectLoadedRefresh = () => {
        clearProjectLoadRefreshTimers();
        const delays = [0, 100, 500, 1500, 3000, 7000, 15000, 30000];
        for (const delay of delays) {
            projectLoadRefreshTimers.push(setTimeout(() => {
                lastObservedEditingTargetId = getEditingTargetId();
                const hasUserEdit = reactModalInstance &&
                    (reactModalInstance.dirty || reactModalInstance.applyDebounceTimer !== null);
                if (reactModalInstance) {
                    reactModalInstance.projectLoading = false;
                }
                if (hasUserEdit) {
                    return;
                }
                if (reactModalInstance) {
                    reactModalInstance.finishProjectLoad();
                }
                scheduleRegenerateFromWorkspace({force: true, delay: 0});
            }, delay));
        }
    };
    const onWorkspaceChanged = () => {
        scheduleRegenerateFromWorkspace();
    };
    const onTargetsUpdate = data => {
        const nextTargetId = data && Object.prototype.hasOwnProperty.call(data, 'editingTarget')
            ? data.editingTarget
            : getEditingTargetId();
        const targetChanged = nextTargetId !== lastObservedEditingTargetId;
        lastObservedEditingTargetId = nextTargetId;
        scheduleRegenerateFromWorkspace({force: targetChanged, delay: targetChanged ? 0 : 300});
    };
    const onProjectLoaded = () => {
        lastObservedEditingTargetId = getEditingTargetId();
        queueProjectLoadedRefresh();
    };
    const projectLoadingStates = new Set([
        'FETCHING_NEW_DEFAULT',
        'FETCHING_WITH_ID',
        'LOADING_VM_FILE_UPLOAD',
        'LOADING_VM_NEW_DEFAULT',
        'LOADING_VM_WITH_ID'
    ]);
    const projectLoadedActions = new Set([
        'scratch-gui/project-state/DONE_LOADING_VM_TO_SAVE',
        'scratch-gui/project-state/DONE_LOADING_VM_WITH_ID',
        'scratch-gui/project-state/DONE_LOADING_VM_WITHOUT_ID'
    ]);
    const getProjectLoadingState = state => (
        state && state.scratchGui && state.scratchGui.projectState
            ? state.scratchGui.projectState.loadingState
            : null
    );
    const isReduxProjectLoading = () => projectLoadingStates.has(getProjectLoadingState(addon.tab.redux.state));
    const onReduxStateChanged = ({detail}) => {
        const actionType = detail && detail.action && detail.action.type;
        const prevLoading = getProjectLoadingState(detail && detail.prev);
        const nextLoading = getProjectLoadingState(detail && detail.next);
        const wasLoading = projectLoadingStates.has(prevLoading);
        const isLoading = projectLoadingStates.has(nextLoading);
        if (!wasLoading && isLoading) {
            beginProjectLoad();
        }
        if ((wasLoading && !isLoading) || projectLoadedActions.has(actionType)) {
            queueProjectLoadedRefresh();
        }
    };
    // workspaceUpdate 在 XML 推给 Blockly 时 fire（结构变化）；PROJECT_CHANGED 在变量/广播/舞台等更广范围变化时 fire。
    // targetsUpdate 覆盖角色切换；runtime.PROJECT_LOADED 覆盖打开/上传新作品。
    vm.on('workspaceUpdate', onWorkspaceChanged);
    vm.on('PROJECT_CHANGED', onWorkspaceChanged);
    vm.on('targetsUpdate', onTargetsUpdate);
    vm.runtime.on('PROJECT_LOADED', onProjectLoaded);
    addon.tab.redux.initialize();
    addon.tab.redux.addEventListener('statechanged', onReduxStateChanged);

    const openConverterWindow = () => {
        if (!document.body.contains(container)) document.body.appendChild(container);
        if (!reactModalInstance) renderModal();
        addon.tab.displayNoneWhileDisabled(container);
        container.style.display = 'flex';
        setStatus(null);
        if (reactModalInstance && reactModalInstance.state && reactModalInstance.state.aiBusy &&
                !reactModalInstance.state.aiChatOpen) {
            reactModalInstance.openAiChat();
        } else if (!reactModalInstance || !reactModalInstance.state || !reactModalInstance.state.aiChatOpen) {
            buttonContainer.style.display = 'flex';
        }
        if (isReduxProjectLoading()) {
            beginProjectLoad();
        } else if (reactModalInstance) {
            reactModalInstance.finishProjectLoad();
        }
        // 打开即从当前角色加载一次，免得窗口是空的
        setTimeout(() => {
            if (isReduxProjectLoading()) return;
            if (reactModalInstance) reactModalInstance.regenerateFromWorkspace();
            // 如果之前勾了滚动跟随、当时窗口被隐藏 rAF 已自停，这里重新启动
            if (reactModalInstance && reactModalInstance.syncScroll && reactModalInstance.getMode() === 'pseudo') {
                reactModalInstance.startWsScrollPoll();
            }
        }, 50);
    };

    addon.tab.createEditorContextMenu((items) => {
        items.push({
            enabled: true,
            text: '积木脚本助手',
            callback: openConverterWindow,
            separator: true
        });
        return items;
    }, {workspace: true});

    initButton = document.createElement('button');
    initButton.className = 'jsonConverterLauncher';
    initButton.textContent = '脚本助手';
    initButton.title = '打开伪代码与 AI 积木编辑助手（可拖动）';
    initButton.style.cssText = `
        position: fixed;
        top: 80px;
        right: 16px;
        z-index: 9999;
        height: 34px;
        padding: 0 12px;
        border: 1px solid #2563eb;
        border-radius: 8px;
        background-color: #2563eb;
        color: #ffffff;
        font-size: 13px;
        font-weight: 700;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        white-space: nowrap;
        box-shadow: 0 8px 18px rgba(37,99,235,0.24), 0 2px 4px rgba(15,23,42,0.12);
        cursor: grab;
        user-select: none;
        touch-action: none;
    `;
    addon.tab.displayNoneWhileDisabled(initButton);

    // 鼠标事件 + 移动阈值区分拖动/点击，避免 HTML5 drag API 的古怪行为
    {
        const DRAG_THRESHOLD = 4;
        let startX = 0;
        let startY = 0;
        let offsetX = 0;
        let offsetY = 0;
        let pointerActive = false;
        let dragging = false;
        const onMouseMove = e => {
            if (!pointerActive) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (!dragging && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
                dragging = true;
                initButton.style.cursor = 'grabbing';
            }
            if (!dragging) return;
            e.preventDefault();
            let newLeft = e.clientX - offsetX;
            let newTop = e.clientY - offsetY;
            const maxLeft = window.innerWidth - initButton.offsetWidth;
            const maxTop = window.innerHeight - initButton.offsetHeight;
            newLeft = Math.max(0, Math.min(newLeft, maxLeft));
            newTop = Math.max(0, Math.min(newTop, maxTop));
            initButton.style.left = `${newLeft}px`;
            initButton.style.top = `${newTop}px`;
            initButton.style.right = 'auto';
            initButton.style.bottom = 'auto';
        };
        const onMouseUp = () => {
            if (!pointerActive) return;
            pointerActive = false;
            initButton.style.cursor = 'grab';
            document.removeEventListener('mousemove', onMouseMove, true);
            document.removeEventListener('mouseup', onMouseUp, true);
            if (!dragging) {
                // 真·点击：开窗（或若已开则关闭）
                if (container.style.display === 'none' || !document.body.contains(container)) {
                    openConverterWindow();
                } else {
                    container.style.display = 'none';
                }
            }
            dragging = false;
        };
        initButton.addEventListener('mousedown', e => {
            if (e.button !== 0) return;
            pointerActive = true;
            dragging = false;
            startX = e.clientX;
            startY = e.clientY;
            const rect = initButton.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            document.addEventListener('mousemove', onMouseMove, true);
            document.addEventListener('mouseup', onMouseUp, true);
        });
    }

    document.body.appendChild(initButton);
    renderModal();
    addon.tab.displayNoneWhileDisabled(container);

    addon.self.addEventListener('disabled', () => {
        container.style.display = 'none';
        buttonContainer.style.display = 'flex';
        clearProjectLoadRefreshTimers();
        try {
            if (reactModalInstance) reactModalInstance.stopWsScrollPoll();
            ReactDOM.unmountComponentAtNode(jsonEditorContainer);
        } catch (e) { /* no-op */ }
        reactModalInstance = null;
    });

    addon.self.addEventListener('reenabled', () => {
        container.style.display = 'none';
    });
};
