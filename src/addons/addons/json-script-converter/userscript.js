import React from 'react';
import ReactDOM from 'react-dom';
import sb3 from 'scratch-vm/src/serialization/sb3';
import newBlockIds from 'scratch-vm/src/util/new-block-ids';
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
// 文本开头还有 #vars / #broadcasts / #lists 这几个头部声明块，它们也被空行分隔，但并**不**对应
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

// 找到伪代码文本顶部连续头部块（#vars/#broadcasts/#lists 及中文形态）占据的字节范围。
// 返回 {end, indexAfterHeaderBlank}，end 是最后一个头部块右大括号后的位置（不含尾部换行）；
// indexAfterHeaderBlank 是跳过紧随其后的一次空白/换行后的位置（即"正文开始处"）。
// 没有头部时两者都返回 0。
const HEADER_KW_RE = /^#(?:vars|变量|broadcasts|广播|lists|列表|localvars|局部变量|locallists|局部列表)(?![a-zA-Z_0-9\u4e00-\u9fa5])/;
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
                if (!target.lookupBroadcastMsg(field.id, field.value)) {
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

export default async ({addon, console, msg}) => {
    const vm = addon.tab.traps.vm;
    if (!vm) {
        console.error('无法获取 Scratch VM 实例');
        return;
    }

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
    titleBar.innerHTML = '<span style="font-weight:bold;">JSON &lt;&gt; 积木 转换器</span>';
    container.appendChild(titleBar);

    const closeButton = document.createElement('button');
    closeButton.className = 'jsonConverterCloseButton';
    closeButton.textContent = '\u00d7';
    closeButton.title = msg ? (msg('close') || 'Close') : 'Close';
    closeButton.style.cssText = 'width:28px;height:28px;border:1px solid transparent;border-radius:6px;background:transparent;color:#64748b;cursor:pointer;font-size:16px;font-weight:bold;padding:0;line-height:1;display:flex;align-items:center;justify-content:center;margin-left:auto;';
    closeButton.onclick = e => {
        e.stopPropagation();
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
    //   - #vars / #lists / #broadcasts / #localvars / #locallists 头部关键字 → 橙色
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
        maybeOpenAutocomplete = () => {
            const baseKeywords = this.props.completionKeywords || [];
            const dynamic = typeof this.props.getDynamicKeywords === 'function'
                ? (this.props.getDynamicKeywords() || []) : [];
            const keywords = dynamic.length
                ? Array.from(new Set([...baseKeywords, ...dynamic]))
                : baseKeywords;
            if (!keywords.length) { this.closeAutocomplete(); return; }
            const ta = this.textareaRef.current;
            if (!ta) return;
            const pos = ta.selectionStart;
            if (pos !== ta.selectionEnd) { this.closeAutocomplete(); return; }
            const text = this.state.text;
            // 向前扫描获取光标处"单词前缀"；标识符范围和 pseudocode tokenizer 对齐（含 CJK）
            let start = pos;
            while (start > 0 && /[a-zA-Z0-9_\u4e00-\u9fa5]/.test(text[start - 1])) start--;
            const word = text.slice(start, pos);
            if (word.length < 1) { this.closeAutocomplete(); return; }
            const lower = word.toLowerCase();
            // 子串匹配（不只匹前缀），前缀命中排在前、其次按首次匹配位置、最后按长度升序。
            // k !== word 跳过完全等于当前词的项（弹层就是帮输入补全用的，没必要再显示自己）。
            const candidates = [];
            for (const k of keywords) {
                if (k === word) continue;
                const idx = k.toLowerCase().indexOf(lower);
                if (idx < 0) continue;
                candidates.push({k, idx, len: k.length});
            }
            candidates.sort((a, b) => {
                if ((a.idx === 0) !== (b.idx === 0)) return a.idx === 0 ? -1 : 1;
                if (a.idx !== b.idx) return a.idx - b.idx;
                if (a.len !== b.len) return a.len - b.len;
                return a.k < b.k ? -1 : (a.k > b.k ? 1 : 0);
            });
            const items = candidates.slice(0, 10).map(c => c.k);
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
                            if (this.textareaRef.current) this.textareaRef.current.setSelectionRange(newSelStart, newSelEnd);
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

    class JsonScriptConverterModal extends React.Component {
        constructor (props) {
            super(props);
            // 伪代码比 JSON 友好，默认就用它
            this.state = {mode: 'pseudo'};
            this.dirty = false;
            // 固定不带坐标；apply 后总是走 cleanUp 自动整理
            this.includeCoords = false;
            this.jsonEditorComponent = React.createRef();
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
        clearError = () => setStatus(null);

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
                this.setState({mode: newMode});
                return;
            }
            const cur = editor.getText();
            if (!cur || !cur.trim()) {
                // 编辑器空 → 直接切模式
                this.setState({mode: newMode});
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
                    const msgs = r.errors.slice(0, 5).map(e => `第${e.line}行: ${e.message}`).join('\n');
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
                this.setState({mode: newMode});
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
        // 返回 {ok, error?, count?}。不抛错，错误走返回值。
        applyBlocksToWorkspace = (raw, meta) => {
            const target = vm.editingTarget;
            if (!target) return {ok: false, error: '没有选中的角色或舞台'};
            const cloned = JSON.parse(JSON.stringify(raw));
            normalizeControlStopMutations(cloned);
            try {
                sb3.deserializeBlocks(cloned);
            } catch (err) {
                return {ok: false, error: `反序列化失败: ${err.message}`};
            }

            // —— 自动对齐：按 parser 的 pending + declared 在目标上建新变量/列表/广播 —— //
            // meta 由 parsePseudocode 的返回值传入；JSON 模式下 meta 为空对象，所有集合都当空。
            // 伪代码模式下始终开启自动对齐：apply 时自动建新变量/列表/广播，并删掉本角色里没用到的 local 变量/列表
            // （stage target 和广播永不自动删；stage 上的 global 永不自动删——可能被其它 sprite 引用）
            const autoAlign = this.state.mode === 'pseudo';
            const pendingVars = (meta && meta.pendingVars) || new Map();
            const pendingLists = (meta && meta.pendingLists) || new Map();
            const pendingBroadcasts = (meta && meta.pendingBroadcasts) || new Map();
            const declaredVars = (meta && meta.declaredVars) || new Set();
            const declaredLists = (meta && meta.declaredLists) || new Set();
            const declaredBroadcasts = (meta && meta.declaredBroadcasts) || new Set();
            const declaredLocalVars = (meta && meta.declaredLocalVars) || new Set();
            const declaredLocalLists = (meta && meta.declaredLocalLists) || new Set();

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
                    if (lookupInOwnScope(scope, name, '')) continue;
                    if (scope) scope.createVariable(id, name, '', false);
                }
                for (const [name, id] of pendingLists) {
                    const scope = chooseScope(name, declaredLocalLists.has(name));
                    if (lookupInOwnScope(scope, name, 'list')) continue;
                    if (scope) scope.createVariable(id, name, 'list', false);
                }
                if (stage) {
                    for (const [name, id] of pendingBroadcasts) {
                        if (!stage.lookupBroadcastByInputValue(name)) {
                            stage.createVariable(id, name, 'broadcast_msg', false);
                        }
                    }
                }

                // 创建的变量要让 Blockly 的工具箱立刻刷新（否则变量分类里看不到新变量，也会让后续
                // UI "Make a Variable" 因为内部状态没同步而出怪现象）。vm.emitTargetsUpdate() 会触发
                // blocks.jsx 重新 getToolboxXML 并 requestToolboxUpdate。
                if (typeof vm.emitTargetsUpdate === 'function') vm.emitTargetsUpdate(false);
            }

            const missing = findMissingReferences(cloned, target);
            const parts = [];
            if (missing.variable.length) parts.push(`缺少变量: ${missing.variable.join(', ')}`);
            if (missing.list.length) parts.push(`缺少列表: ${missing.list.join(', ')}`);
            if (missing.broadcast.length) parts.push(`缺少广播: ${missing.broadcast.join(', ')}`);
            if (parts.length) return {ok: false, error: parts.join(' | ')};

            const blockArray = Object.values(cloned);
            newBlockIds(blockArray);
            for (const b of blockArray) b.comment = null;

            // 自己 apply 回写 workspace 会立刻引起 VM emit workspaceUpdate/PROJECT_CHANGED；
            // 把抑制窗口拉到 apply 之后一段时间，避免回声把编辑器里刚输入的内容覆盖掉
            this.suppressRegenUntil = Date.now() + 1200;

            // 预先拿到 workspace 实例，顺便保存当前视口（scrollX/scrollY/scale）。
            // emitWorkspaceUpdate 触发 blocks.jsx.onWorkspaceUpdate → clearWorkspaceAndLoadFromXml 会把视口重置到原点；
            // blocks.jsx 本来有 workspaceMetrics 恢复逻辑，但那只在 target 已经有 metrics 时才生效，
            // 用户在当前角色首次打开编辑器或刚切角色时常常没 metrics → 每次 apply 就像跳回顶。
            // 这里自己存/恢一次，保证实时同步时视口不漂。
            const ws = (addon.tab.traps && typeof addon.tab.traps.getWorkspace === 'function')
                ? addon.tab.traps.getWorkspace() : null;
            // 装保险丝：让之后原生"Make a Variable"也会触发一次 flyout 重绘。幂等。
            installVariableFlyoutRefreshListener(ws);
            const savedView = ws ? {
                scrollX: ws.scrollX,
                scrollY: ws.scrollY,
                scale: ws.scale
            } : null;

            target.blocks.deleteAllBlocks();
            for (const b of blockArray) target.blocks.createBlock(b);
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
            vm.emitWorkspaceUpdate();
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
            if (this.state.mode === 'pseudo' && !this.includeCoords && ws && typeof ws.getTopBlocks === 'function') {
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

            return {ok: true, count: blockArray.length};
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
                    const msgs = r.errors.slice(0, 5).map(e => `第${e.line}行: ${e.message}`).join(' | ');
                    this.setError(`伪代码语法错误: ${msgs}`);
                    return;
                }
                raw = r.blocks;
                if (!Object.keys(raw).length) { this.setError('伪代码里没有积木'); return; }
                meta = {
                    pendingVars: r.pendingVars, pendingLists: r.pendingLists, pendingBroadcasts: r.pendingBroadcasts,
                    declaredVars: r.declaredVars, declaredLists: r.declaredLists, declaredBroadcasts: r.declaredBroadcasts,
                    declaredLocalVars: r.declaredLocalVars || new Set(),
                    declaredLocalLists: r.declaredLocalLists || new Set()
                };
            }
            // 解析结果和上次 apply 完全一致 → 纯空白/换行变化，没必要再动 workspace
            // meta 里的 pending/declared 可能随变量名字增减而变，哪怕 blocks JSON 没变也要进 apply 一次
            //   （比如用户在 #vars 里加了一个新声明），所以把 meta 摘要也纳入对比。
            const metaSummary = meta
                ? JSON.stringify({
                    pV: [...meta.pendingVars.keys()],
                    pL: [...meta.pendingLists.keys()],
                    pB: [...meta.pendingBroadcasts.keys()],
                    dV: [...meta.declaredVars],
                    dL: [...meta.declaredLists],
                    dB: [...meta.declaredBroadcasts],
                    dLV: [...meta.declaredLocalVars],
                    dLL: [...meta.declaredLocalLists]
                })
                : '';
            const currentJson = JSON.stringify(raw) + '|' + metaSummary;
            if (currentJson === this.lastAppliedBlocksJson) {
                this.dirty = false;
                this.clearError();
                return;
            }
            const result = this.applyBlocksToWorkspace(raw, meta);
            if (!result.ok) { this.setError(result.error); return; }
            this.dirty = false;
            // 伪代码模式下把头部同步到 "声明 ∪ 引用"，并按当前 target 的作用域把变量分到 #vars / #localvars。
            if (this.state.mode === 'pseudo' && meta) {
                const refs = collectReferencedNames(raw);
                const unionSet = (a, b) => { const s = new Set(a); for (const x of b) s.add(x); return s; };
                // 所有要在头部出现的名字 = 声明 ∪ 引用
                const allVarNames = unionSet(unionSet(meta.declaredVars, meta.declaredLocalVars), refs.vars);
                const allListNames = unionSet(unionSet(meta.declaredLists, meta.declaredLocalLists), refs.lists);
                const allBroadcastNames = unionSet(meta.declaredBroadcasts, refs.broadcasts);

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
                    broadcasts: allBroadcastNames
                });
                if (updatedText != null) {
                    const newMeta = JSON.stringify({
                        pV: [...meta.pendingVars.keys()],
                        pL: [...meta.pendingLists.keys()],
                        pB: [...meta.pendingBroadcasts.keys()],
                        dV: [...varSplit.g],
                        dL: [...listSplit.g],
                        dB: [...allBroadcastNames],
                        dLV: [...varSplit.l],
                        dLL: [...listSplit.l]
                    });
                    this.lastAppliedBlocksJson = JSON.stringify(raw) + '|' + newMeta;
                } else {
                    this.lastAppliedBlocksJson = currentJson;
                }
            } else {
                this.lastAppliedBlocksJson = currentJson;
            }
            this.setSuccess(`✓ 已同步 ${result.count} 个积木`);
        };

        // 把编辑器顶部的 #vars/#localvars/#broadcasts/#lists/#locallists 替换成 desired 集合（按名字排序）。
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
                ? {vars: '变量', localVars: '局部变量', broadcasts: '广播', lists: '列表', localLists: '局部列表'}
                : {vars: 'vars', localVars: 'localvars', broadcasts: 'broadcasts', lists: 'lists', localLists: 'locallists'};
            const lines = [];
            const fmt = (key, set) => {
                if (!set || !set.size) return;
                const names = [...set].sort();
                lines.push(`#${kw[key]} { ${names.map(escapePseudoString).join(' ')} }`);
            };
            fmt('vars', desired.vars);
            fmt('localVars', desired.localVars);
            fmt('broadcasts', desired.broadcasts);
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
                            const metaSummary = JSON.stringify({
                                pV: [...r.pendingVars.keys()],
                                pL: [...r.pendingLists.keys()],
                                pB: [...r.pendingBroadcasts.keys()],
                                dV: [...r.declaredVars],
                                dL: [...r.declaredLists],
                                dB: [...r.declaredBroadcasts],
                                dLV: [...(r.declaredLocalVars || new Set())],
                                dLL: [...(r.declaredLocalLists || new Set())]
                            });
                            this.lastAppliedBlocksJson = JSON.stringify(r.blocks) + '|' + metaSummary;
                        }
                    }
                } catch (_) { /* 留前一次值即可 */ }
            } catch (err) {
                console.warn('[json-script-converter] regenerate from workspace failed', err);
            }
        };

        render () {
            return (
                <div style={{display: 'flex', flexDirection: 'column', height: '100%', width: '100%'}}>
                    <div style={{flexGrow: 1, overflow: 'hidden', position: 'relative'}}>
                        <JsonEditorComponent
                            ref={this.jsonEditorComponent}
                            initialText=""
                            mode={this.state.mode}
                            onChange={this.handleJsonChange}
                            onScroll={this.handleEditorScroll}
                            completionKeywords={this.state.mode === 'pseudo' ? PSEUDO_KEYWORDS : []}
                            getDynamicKeywords={this.state.mode === 'pseudo' ? this.getDynamicKeywords : null}
                        />
                    </div>
                </div>
            );
        }
    }

    let reactModalInstance = null;

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

    const updateSyncCheckboxVisibility = mode => {
        const show = mode === 'pseudo';
        syncScrollLabel.style.display = show ? 'flex' : 'none';
        translateZhButton.style.display = show ? '' : 'none';
        translateOpButton.style.display = show ? '' : 'none';
    };

    modeToggleButton.onclick = () => {
        if (!reactModalInstance) {
            setStatus('内部错误：React 组件实例丢失。请关闭浮窗重开。', 'error');
            return;
        }
        const cur = reactModalInstance.getMode();
        const next = cur === 'json' ? 'pseudo' : 'json';
        reactModalInstance.switchMode(next);
        modeToggleButton.textContent = next === 'json' ? '当前: JSON' : '当前: 伪代码';
        updateSyncCheckboxVisibility(next);
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
            text: 'JSON <> 积木 转换器',
            callback: openConverterWindow,
            separator: true
        });
        return items;
    }, {workspace: true});

    const initButton = document.createElement('button');
    initButton.className = 'jsonConverterLauncher';
    initButton.textContent = 'JSON<>积木';
    initButton.title = '打开 JSON 与积木互转工具（可拖动）';
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

    addon.self.addEventListener('disabled', () => {
        container.style.display = 'none';
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
