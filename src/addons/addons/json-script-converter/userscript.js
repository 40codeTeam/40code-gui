// src/addons/json-script-converter/userscript.js
import React from 'react';
import ReactDOM from 'react-dom';
import JSONEditor from 'react-json-editor-ajrm';
// 假设你的样式文件存在，如果不存在或不需要，可以移除这行
// import styles from './style.css';

// --- 辅助函数 ---

/**
 * 生成一个简单的唯一ID (仅用于演示，生产环境应使用更健壮的UID生成器)
 * 比如 Scratch VM 内部的 uid() 或 crypto.randomUUID() (如果环境支持)
 * @returns {string} 一个伪唯一ID
 */
function generateUid() {
    // 一个更符合 Scratch ID 格式的简单生成器
    const soup = '!#%()*+,-./:;=?@[]^_`{|}~ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 20; i++) {
        id += soup.charAt(Math.random() * soup.length);
    }
    return id;
}

/**
 * **[核心且复杂]** 处理输入的 JSON 块数据，为其生成新 ID 并更新引用。
 * 这是一个改进的示例，尝试处理更复杂的情况，但仍可能不完美。
 * @param {object} originalBlocksData - 类似 project.json 中 target.blocks 的对象
 * @returns {{ newBlocks: object, topLevelIds: string[] }|null} 处理后的积木对象字典和顶层积木ID数组，如果输入无效则返回 null
 */
function processAndRemapBlockIds(originalBlocksData) {
  if (!originalBlocksData || typeof originalBlocksData !== 'object') {
    console.error("输入的不是有效的积木对象数据");
    return null;
  }

  const oldToNewIdMap = new Map();
  const newBlocks = {}; // 使用对象/字典存储新积木
  const originalBlockIds = Object.keys(originalBlocksData);
  const topLevelIds = []; // 存储新的顶层积木 ID

  // 1. 第一遍：为所有积木生成新 ID 并创建基础对象
  for (const oldId of originalBlockIds) {
    const originalBlock = originalBlocksData[oldId];
    // 跳过无效条目或非对象条目 (原始值数组会被后面处理)
    if (!originalBlock || typeof originalBlock !== 'object' || Array.isArray(originalBlock)) {
        // 如果是数组，暂时跳过，后面作为 primitive 处理
        if (!Array.isArray(originalBlock)) {
             console.warn("跳过无效的积木条目:", oldId, originalBlock);
        }
        continue;
    }

    const newId = generateUid();
    oldToNewIdMap.set(oldId, newId);

    // 深拷贝基础结构
    const newBlock = {
        id: newId, // 设置新 ID
        opcode: originalBlock.opcode,
        inputs: {}, // 稍后填充
        fields: JSON.parse(JSON.stringify(originalBlock.fields || {})), // 深拷贝字段
        next: null,
        parent: null,
        shadow: originalBlock.shadow || false,
        topLevel: originalBlock.topLevel || false, // 初始假设
        x: originalBlock.x, // 保留位置信息
        y: originalBlock.y
    };

    // 处理 mutation (深拷贝)
    if (originalBlock.mutation) {
      newBlock.mutation = JSON.parse(JSON.stringify(originalBlock.mutation));
    }
    // 处理 comment (只映射ID，comment 对象本身在 target 上)
    if (originalBlock.comment) {
      // 假设 comment ID 也需要重新生成或已经存在于目标 target 上
      // 这里简单地复制旧 ID，实际应用可能需要更复杂的处理
      newBlock.comment = originalBlock.comment;
    }


    newBlocks[newId] = newBlock;
  }

  // 2. 第二遍：处理连接和 Input 内部的 ID 引用
  for (const newId in newBlocks) {
    const newBlock = newBlocks[newId];
    // 找到对应的旧 ID (需要一种可靠的方式，这里用 newBlocks 的 ID 去反查 Map)
    let oldId = null;
    for (const [key, value] of oldToNewIdMap.entries()) {
        if (value === newId) {
            oldId = key;
            break;
        }
    }

    if (!oldId || !originalBlocksData[oldId] || Array.isArray(originalBlocksData[oldId])) continue; // 如果找不到旧ID或旧数据无效

    const originalBlock = originalBlocksData[oldId];

    // 更新 next 和 parent
    if (originalBlock.next && oldToNewIdMap.has(originalBlock.next)) {
      newBlock.next = oldToNewIdMap.get(originalBlock.next);
    }
    if (originalBlock.parent && oldToNewIdMap.has(originalBlock.parent)) {
      newBlock.parent = oldToNewIdMap.get(originalBlock.parent);
    } else {
      // 如果原始 parent 不存在或映射不到，则认为是顶层
      newBlock.topLevel = true;
      topLevelIds.push(newBlock.id);
    }

    // 更新 inputs (处理数组形式和对象形式)
    if (originalBlock.inputs) {
        for (const inputName in originalBlock.inputs) {
            const originalInput = originalBlock.inputs[inputName];
            const newInput = {}; // 使用对象格式存储输入

            // 1: Block ID (或 shadow ID if type 1)
            // 2: Shadow ID (if type 3) or Primitive Value Array (if type 1 and block is primitive)
            // 3: Primitive Value Array (if type 3 and shadow is primitive)

            // 检查原始输入是否是数组（SB3 格式）
            if (Array.isArray(originalInput)) {
                newInput.name = inputName;
                const type = originalInput[0];
                let blockValue = originalInput[1];
                let shadowValue = originalInput[2]; // 可能不存在

                // --- 处理 blockValue (可能是 ID 或 Primitive 数组) ---
                if (typeof blockValue === 'string') {
                    // 是 ID，需要映射
                    newInput.block = oldToNewIdMap.has(blockValue) ? oldToNewIdMap.get(blockValue) : null; // 如果映射不到，设为 null
                } else if (Array.isArray(blockValue)) {
                    // 是 Primitive 数组，需要创建新 Primitive Block
                    const newPrimitiveId = generateUid();
                    const primitiveBlock = createPrimitiveBlock(newPrimitiveId, blockValue, newBlock.id, true); // true 表示是 shadow
                    if(primitiveBlock) {
                        newBlocks[newPrimitiveId] = primitiveBlock;
                        newInput.block = newPrimitiveId;
                    } else {
                         newInput.block = null;
                    }
                    // 如果 type 是 1，block 就是 shadow
                    if (type === 1) {
                        newInput.shadow = newInput.block;
                    }
                } else {
                    newInput.block = null;
                    console.warn(`Input ${inputName} in block ${oldId} has unexpected block value:`, blockValue);
                }

                // --- 处理 shadowValue (只在 type 3 时有效，且可能是 ID 或 Primitive 数组) ---
                if (type === 3) {
                    if (typeof shadowValue === 'string') {
                        // 是 ID，需要映射
                        newInput.shadow = oldToNewIdMap.has(shadowValue) ? oldToNewIdMap.get(shadowValue) : null;
                    } else if (Array.isArray(shadowValue)) {
                         // 是 Primitive 数组，需要创建新 Primitive Block
                         const newPrimitiveId = generateUid();
                         const primitiveBlock = createPrimitiveBlock(newPrimitiveId, shadowValue, newBlock.id, true); // true 表示是 shadow
                         if (primitiveBlock) {
                            newBlocks[newPrimitiveId] = primitiveBlock;
                            newInput.shadow = newPrimitiveId;
                         } else {
                             newInput.shadow = null;
                         }
                    } else {
                         newInput.shadow = null; // 默认无 shadow 或 shadow 无效
                         if (shadowValue !== undefined) { // 只有在 shadowValue 存在但无效时警告
                             console.warn(`Input ${inputName} in block ${oldId} has unexpected shadow value:`, shadowValue);
                         }
                    }
                } else if (type === 1) {
                    // type 1 时，shadow ID 和 block ID 相同
                    newInput.shadow = newInput.block;
                } else {
                    // type 2 时，没有显式的 shadow ID
                    newInput.shadow = null;
                }

            } else if (typeof originalInput === 'object' && originalInput !== null) {
                // 可能是已经反序列化后的对象格式 (不太可能直接从 JSON 输入得到)
                console.warn("处理对象格式的输入，这通常不来自原始 JSON:", originalInput);
                newInput.name = inputName;
                newInput.block = (originalInput.block && oldToNewIdMap.has(originalInput.block)) ? oldToNewIdMap.get(originalInput.block) : null;
                newInput.shadow = (originalInput.shadow && oldToNewIdMap.has(originalInput.shadow)) ? oldToNewIdMap.get(originalInput.shadow) : null;
            }

            // 只添加有效的输入
            if (newInput.block !== null || newInput.shadow !== null) {
                 newBlock.inputs[inputName] = newInput;
            }
        }
    }

    // **极其重要**: 处理 mutation 中的 ID 引用 (例如 procCode 可能不需要映射，但 argumentids 可能需要)
    // 这部分依赖于具体 mutation 的结构，这里暂不处理
    if (newBlock.mutation && newBlock.mutation.argumentids) {
         // console.log("注意: Mutation中的 'argumentids' 可能需要ID映射，此处未实现");
    }

  }

  // 辅助函数：根据 SB3 原始值数组创建 VM 内部的积木对象
  function createPrimitiveBlock(newId, primitiveData, parentId, isShadow) {
        const primitiveObj = {
            id: newId,
            opcode: '',
            inputs: {},
            fields: {},
            next: null,
            parent: parentId,
            shadow: isShadow,
            topLevel: false // Primitive 永远不是顶层
        };
        const type = primitiveData[0];
        const value = primitiveData[1];
        const fieldId = primitiveData[2]; // 可能不存在

        switch(type) {
            case 4: // MATH_NUM_PRIMITIVE
            case 5: // POSITIVE_NUM_PRIMITIVE
            case 6: // WHOLE_NUM_PRIMITIVE
            case 7: // INTEGER_NUM_PRIMITIVE
                primitiveObj.opcode = 'math_number'; // 统一用 math_number
                primitiveObj.fields.NUM = { name: 'NUM', value: value };
                break;
            case 8: // ANGLE_NUM_PRIMITIVE
                primitiveObj.opcode = 'math_angle';
                primitiveObj.fields.NUM = { name: 'NUM', value: value };
                break;
            case 9: // COLOR_PICKER_PRIMITIVE
                primitiveObj.opcode = 'colour_picker';
                primitiveObj.fields.COLOUR = { name: 'COLOUR', value: value };
                break;
            case 10: // TEXT_PRIMITIVE
                primitiveObj.opcode = 'text';
                primitiveObj.fields.TEXT = { name: 'TEXT', value: value };
                break;
            case 11: // BROADCAST_PRIMITIVE
                primitiveObj.opcode = 'event_broadcast_menu';
                primitiveObj.fields.BROADCAST_OPTION = { name: 'BROADCAST_OPTION', value: value, id: fieldId, variableType: 'broadcast_msg' };
                break;
            case 12: // VAR_PRIMITIVE
                primitiveObj.opcode = 'data_variable';
                primitiveObj.fields.VARIABLE = { name: 'VARIABLE', value: value, id: fieldId, variableType: '' };
                break;
            case 13: // LIST_PRIMITIVE
                primitiveObj.opcode = 'data_listcontents';
                primitiveObj.fields.LIST = { name: 'LIST', value: value, id: fieldId, variableType: 'list' };
                break;
            default:
                console.warn(`未知的 Primitive 类型: ${type}`);
                return null; // 返回 null 表示创建失败
        }
        return primitiveObj;
    }


  console.log("ID 映射:", oldToNewIdMap);
  console.log("处理后的新积木字典:", newBlocks);
  console.log("顶层积木 ID:", topLevelIds);
  return { newBlocks, topLevelIds };
}


// 添加可拖动功能的辅助函数 (保持不变)
const makeDraggable = (element, handle = null) => {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  const dragHandle = handle || element;

  const dragMouseDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.addEventListener('mouseup', closeDragElement, { capture: true }); // 显式使用捕获
    document.addEventListener('mousemove', elementDrag, { capture: true }); // 显式使用捕获
  };

  const elementDrag = (e) => {
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
    element.style.top = Math.max(0, Math.min(newTop, maxTop)) + "px";
    element.style.left = Math.max(0, Math.min(newLeft, maxLeft)) + "px";
  };

  const closeDragElement = (e) => {
    e.stopPropagation();
    document.removeEventListener('mouseup', closeDragElement, { capture: true });
    document.removeEventListener('mousemove', elementDrag, { capture: true });
  };

  // 绑定 mousedown 到句柄
  dragHandle.addEventListener('mousedown', dragMouseDown, { capture: false }); // mousedown 不需要捕获也可
};

export default async ({ addon, console, msg }) => {
  console.log('JSON Script Converter Addon Loaded');

  const vm = addon.tab.traps.vm;
  const Blockly = await addon.tab.traps.getBlockly();

  if (!vm) {
    console.error("错误：无法获取 Scratch VM 实例！插件可能无法正常工作。");
    return;
  }

  // --- 创建 UI 元素 ---
  const container = document.createElement('div');
  container.className = 'jsonConverterContainer'; // 使用 class 方便 CSS 控制
  container.style.cssText = `
    position: absolute;
    top: 50px;
    left: 50px;
    z-index: 10000;
    background-color: white;
    border: 1px solid #ccc;
    border-radius: 5px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.2);
    min-width: 400px;
    max-width: 80vw;
    min-height: 300px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    resize: both;
    overflow: hidden;
  `;

  const titleBar = document.createElement('div');
  titleBar.style.cssText = `
    padding: 8px 10px;
    background-color: #f1f1f1;
    border-bottom: 1px solid #ccc;
    cursor: move;
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0;
    flex-shrink: 0;
  `;
  titleBar.innerHTML = '<span style="font-weight: bold;">JSON <> 积木 转换器</span>';
  container.appendChild(titleBar);

  const closeButton = document.createElement('button');
  closeButton.textContent = '✕';
  closeButton.title = msg('close') || 'Close'; // 使用 msg 或提供默认值
  closeButton.style.cssText = `
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 18px;
    font-weight: bold;
    padding: 0 5px;
    line-height: 1;
  `;
  closeButton.onclick = (e) => {
    e.stopPropagation();
    container.style.display = 'none';
    // 卸载 React 组件以释放资源
    try {
        ReactDOM.unmountComponentAtNode(jsonEditorContainer);
    } catch (error) {
        console.warn("卸载 React 组件时出错:", error);
    }
  };
  titleBar.appendChild(closeButton);

  const jsonEditorContainer = document.createElement('div');
  jsonEditorContainer.style.cssText = `
    flex-grow: 1;
    overflow: auto; /* 修改为 auto 以允许滚动 */
    padding: 10px;
    border-bottom: 1px solid #ccc;
    position: relative; /* 为了 loading 覆盖 */
  `;
  container.appendChild(jsonEditorContainer);

  const buttonContainer = document.createElement('div');
  buttonContainer.style.cssText = `
    padding: 10px;
    display: flex;
    justify-content: space-around;
    flex-shrink: 0;
  `;
  container.appendChild(buttonContainer);

  const errorContainer = document.createElement('div');
  errorContainer.style.cssText = `
    color: red;
    padding: 0 10px 5px 10px; /* 微调 */
    font-size: 12px;
    border-top: 1px solid #eee;
    max-height: 50px; /* 限制错误区域高度 */
    overflow-y: auto; /* 如果错误太长，允许滚动 */
    flex-shrink: 0;
    display: none; /* 默认隐藏 */
  `;
  container.appendChild(errorContainer);


  makeDraggable(container, titleBar);

  // --- React 组件 ---
  class JsonEditorComponent extends React.Component {
    constructor(props) {
      super(props);
      this.state = {
        editorKey: Date.now()
      };
      this.currentValue = props.value || {};
    }

    componentDidUpdate(prevProps) {
      // 只有当外部传入的值确实与当前内部值不同时才更新
      if (JSON.stringify(prevProps.value) !== JSON.stringify(this.props.value) &&
          JSON.stringify(this.currentValue) !== JSON.stringify(this.props.value)) {
        this.currentValue = this.props.value || {};
        this.setState({ editorKey: Date.now() });
      }
    }

    handleJsonChange = (value) => {
      this.currentValue = value && value.jsObject ? value.jsObject : (value && typeof value === 'object' ? value : {});
      if (this.props.onChange) {
        this.props.onChange(this.currentValue); // 回传最新的值给父组件
      }
    };

    getEditorValue = () => {
      return this.currentValue;
    };

    render() {
      return (
        // 使用 div 包裹并设置 overflow: auto，允许编辑器内容滚动
        <div style={{ height: '100%', width: '100%', overflow: 'auto', border: '1px solid #ddd', borderRadius: '4px' }}>
          <JSONEditor
            key={this.state.editorKey}
            id={`jsonEditor_${this.state.editorKey}`}
            placeholder={this.currentValue}
            colors={{
              background: '#ffffff',
              default: '#333333',
              string: '#032f62',
              number: '#008000',
              colon: '#333333',
              keys: '#a71d5d',
              keys_whiteSpace: '#a71d5d',
              primitive: '#008000',
            }}
            // 安全地获取 locale
            locale={addon.tab.scratchAddons?.l10n?.locale || document.documentElement.lang || 'en'}
            height="100%" // JSONEditor 自身不应该限制高度，让父 div 控制
            width="100%"
            onChange={this.handleJsonChange}
            waitAfterKeyPress={700} // 稍微减少延迟
            style={{
                outerBox: { border: 'none' }, // 移除编辑器的外边框，因为父 div 已经有了
                contentBox: { fontSize: '13px', fontFamily: 'monospace' }
            }}
          />
        </div>
      );
    }
  }

  class JsonScriptConverterModal extends React.Component {
    constructor(props) {
      super(props);
      this.state = {
        jsonValue: {},
        isLoading: false,
        error: null
      };
      this.jsonEditorComponent = React.createRef();
    }

    setEditorValue = (value) => {
        // 尝试美化 JSON 输出
        let displayValue = {};
        try {
            displayValue = value ? JSON.parse(JSON.stringify(value)) : {}; // 深拷贝
        } catch (e) {
             console.error("设置编辑器值时出错:", e);
             displayValue = { error: "无法加载或格式化积木数据" };
        }
        this.setState({ jsonValue: displayValue, error: null });
    }

    handleJsonChange = (currentJsonInEditor) => {
        // 仅当父组件需要知道编辑器内部实时更改时使用
        // console.log("Editor content changed (internal)");
    };

    setError = (errorMessage) => {
        this.setState({ error: errorMessage, isLoading: false });
        errorContainer.textContent = errorMessage ? `错误: ${errorMessage}` : '';
        errorContainer.style.display = errorMessage ? 'block' : 'none';
    }

    clearError = () => {
        this.setError(null);
    }

    setLoading = (loading) => {
        this.setState({ isLoading: loading });
    }

    handleJsonToScript = async () => {
      this.setLoading(true);
      this.clearError();
      const { vm } = this.props;

      if (!vm) {
        this.setError("无法访问 Scratch VM！");
        return;
      }
      const target = vm.editingTarget;
      if (!target) {
        this.setError("没有选中的角色或舞台！");
        return;
      }

      const jsonCode = this.jsonEditorComponent.current?.getEditorValue();

      if (!jsonCode || typeof jsonCode !== 'object' || Object.keys(jsonCode).length === 0) {
          this.setError("JSON 编辑器内容为空或无效。");
          return;
      }

      console.log("开始转换 JSON -> 积木");
      console.log("原始 JSON 输入:", jsonCode);

      try {
        // **关键步骤**: 处理 JSON 并重新映射 ID
        const processResult = processAndRemapBlockIds(jsonCode);

        if (!processResult) {
            throw new Error("处理或映射积木 ID 失败。请检查 JSON 格式和控制台日志。");
        }
        const { newBlocks, topLevelIds } = processResult;

        console.log("准备应用到 VM 的积木数据:", newBlocks);
        console.log("新的顶层积木 ID:", topLevelIds);

        // 1. 清空现有积木
        console.log("正在清除目标上的旧积木...");
        const existingBlockIds = target.blocks.getScripts();
        existingBlockIds.slice().forEach(blockId => {
          if (target.blocks.getBlock(blockId)) {
            try {
                target.blocks.deleteBlock(blockId);
            } catch (deleteError) {
                 console.warn(`删除积木 ${blockId} 时出错 (可能已被其他删除操作移除):`, deleteError);
            }
          }
        });
        target.blocks.resetCache(); // 清理缓存
        console.log("旧积木已清除。");

        // 2. 添加新积木 (使用处理后的字典)
        console.log("正在使用 createBlock 添加新积木...");
        let blockCreationErrors = 0;
        Object.values(newBlocks).forEach(blockData => {
             // Primitive blocks are now also objects created by processAndRemapBlockIds
            if (!blockData || !blockData.id || !blockData.opcode) {
                console.warn("跳过无效的积木数据:", blockData);
                blockCreationErrors++;
                return;
            }
            try {
               target.blocks.createBlock(blockData);
            } catch(createError) {
               console.error(`创建积木失败 (ID: ${blockData.id}, Opcode: ${blockData.opcode}):`, createError, blockData);
               blockCreationErrors++;
            }
        });

        if (blockCreationErrors > 0) {
             console.warn(`有 ${blockCreationErrors} 个积木创建失败，请检查日志。`);
             this.setError(`有 ${blockCreationErrors} 个积木创建失败，请检查控制台日志。`);
             // 即使部分失败，也继续尝试更新工作区
        } else {
            console.log("新积木添加完成。");
        }


        // 3. 更新顶层脚本数组
        target.blocks._scripts = topLevelIds; // 直接使用 processAndRemapBlockIds 返回的顶层 ID
        console.log("更新了顶层脚本数组:", target.blocks._scripts);

        // 4. 重置缓存并触发更新
        target.blocks.resetCache(); // 再次重置
        console.log("正在触发工作区更新 (emitWorkspaceUpdate)...");
        vm.emitWorkspaceUpdate(); // **通知 GUI 更新**
        console.log('JSON 转换为 Scratch 积木成功!');
        this.setLoading(false);

      } catch (error) {
        console.error('JSON 转换为 Scratch 积木失败:', error);
        this.setError('转换失败: ' + error.message);
      }
    };

    handleScriptToJson = () => {
      this.setLoading(true);
      this.clearError();
      const { vm } = this.props;

      if (!vm) {
        this.setError("无法访问 Scratch VM！");
        return;
      }
      const target = vm.editingTarget;
      if (!target) {
        this.setError("没有选中的角色或舞台！");
        return;
      }

      try {
        // 直接获取内部的 _blocks 数据，这是最接近 JSON 的结构
        // **重要**: 必须进行深拷贝！
        const blocksData = target.blocks._blocks ? JSON.parse(JSON.stringify(target.blocks._blocks)) : {};

        if (!blocksData || Object.keys(blocksData).length === 0) {
             console.warn("当前目标没有积木可导出。");
             // 设置为空对象而不是错误
             this.setEditorValue({});
        } else {
            console.log("从 VM 获取的积木数据:", blocksData);
            this.setEditorValue(blocksData); // 更新 JSON 编辑器
        }

        console.log('Scratch 积木加载到 JSON 成功!');
        this.setLoading(false);

      } catch (error) {
        console.error('Scratch 积木加载到 JSON 失败:', error);
        this.setError('加载失败: ' + error.message);
      }
    };

    // --- 提供给外部按钮调用的方法 ---
    // 这些方法将由 renderModal 中的回调调用
    triggerJsonToScript = () => {
        this.handleJsonToScript();
    }
    triggerScriptToJson = () => {
        this.handleScriptToJson();
    }


    render() {
      const { isLoading } = this.state;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
          {/* 让编辑器容器占据所有可用空间 */}
          <div style={{ flexGrow: 1, overflow: 'hidden', position: 'relative' }}>
            <JsonEditorComponent
              ref={this.jsonEditorComponent}
              value={this.state.jsonValue}
              onChange={this.handleJsonChange}
            />
            {isLoading && (
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(255,255,255,0.7)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 10 }}>
                <span>处理中...</span>
              </div>
            )}
          </div>
          {/* 错误容器现在由父级管理 */}
        </div>
      );
    }
  }

  // --- 渲染和事件处理 ---
  let reactModalInstance = null; // 存储 React 组件实例的引用

  const renderModal = () => {
    try {
        // 确保容器在 DOM 中
        if (!document.body.contains(container)) {
             document.body.appendChild(container);
        }
        // 渲染 React 组件，并通过 ref 获取实例
        ReactDOM.render(<JsonScriptConverterModal vm={vm} ref={(instance) => { reactModalInstance = instance; }} />, jsonEditorContainer, () => {
            // 渲染完成后，检查实例是否存在并立即加载当前脚本
            if (reactModalInstance) {
                reactModalInstance.triggerScriptToJson();
            } else {
                 console.error("无法获取 React 组件实例。");
            }
        });
    } catch (renderError) {
        console.error("渲染 React 组件失败:", renderError);
        errorContainer.textContent = "错误: 无法加载编辑器组件。";
        errorContainer.style.display = 'block';
    }
  };

  // 创建按钮并添加到按钮容器
  const jsonToScriptButton = document.createElement('button');
  jsonToScriptButton.textContent = 'JSON → 应用到积木区';
  jsonToScriptButton.title = '将编辑器中的 JSON 数据转换为积木，并替换当前角色的积木区';
  jsonToScriptButton.onclick = () => {
    if (reactModalInstance) {
      reactModalInstance.triggerJsonToScript();
    } else {
      console.error("无法触发 JSON -> 积木：React 组件实例不可用。");
      errorContainer.textContent = "错误: 组件实例丢失，无法执行操作。";
      errorContainer.style.display = 'block';
    }
  };
  buttonContainer.appendChild(jsonToScriptButton);

  const scriptToJsonButton = document.createElement('button');
  scriptToJsonButton.textContent = '积木区 → 加载到 JSON';
  scriptToJsonButton.title = '将当前角色积木区的内容加载到上面的 JSON 编辑器';
  scriptToJsonButton.onclick = () => {
    if (reactModalInstance) {
      reactModalInstance.triggerScriptToJson();
    } else {
      console.error("无法触发 积木 -> JSON：React 组件实例不可用。");
       errorContainer.textContent = "错误: 组件实例丢失，无法执行操作。";
       errorContainer.style.display = 'block';
    }
  };
  buttonContainer.appendChild(scriptToJsonButton);

  // --- 初始化按钮和窗口逻辑 ---
  const openConverterWindow = () => {
    if (!document.body.contains(container)) {
      document.body.appendChild(container);
    }
    renderModal(); // 每次打开都重新渲染，并自动加载
    addon.tab.displayNoneWhileDisabled(container);
    container.style.display = 'flex';
    errorContainer.style.display = 'none'; // 打开时隐藏错误
  };

  // 添加编辑器上下文菜单项
  addon.tab.createEditorContextMenu((items, block) => {
    items.push({
      enabled: true,
      text: 'JSON <> 积木 转换器',
      callback: openConverterWindow,
      separator: true,
    });
    return items;
  }, { workspace: true });

  // 添加一个初始化按钮到界面
  const initButton = document.createElement('button');
  initButton.textContent = 'JSON<>积木';
  initButton.title = '打开 JSON 与 Scratch 积木互相转换的工具';
  initButton.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    z-index: 9999;
    cursor: move;
    padding: 5px 10px;
    border: 1px solid #ccc;
    border-radius: 4px;
    background-color: #f0f0f0;
    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
    user-select: none;
  `;
  initButton.setAttribute('draggable', 'true');
  let isDraggingButton = false;

  // 简化后的按钮拖动逻辑
  const buttonDrag = (element) => {
    let offsetX, offsetY;
    const dragStart = (e) => {
        isDraggingButton = true;
        offsetX = e.clientX - element.getBoundingClientRect().left;
        offsetY = e.clientY - element.getBoundingClientRect().top;
        element.style.cursor = 'grabbing';
        // 阻止默认拖放行为
        e.dataTransfer.effectAllowed = 'move';
        try {
            // 尝试设置透明拖动图像
            const empty = new Image();
            e.dataTransfer.setDragImage(empty, 0, 0);
        } catch (err) {} // 忽略 setDragImage 的错误

        document.addEventListener('dragover', dragOver);
        document.addEventListener('dragend', dragEnd);
    };
    const dragOver = (e) => {
        if (!isDraggingButton) return;
        e.preventDefault();
        let newLeft = e.clientX - offsetX;
        let newTop = e.clientY - offsetY;
        const maxLeft = window.innerWidth - element.offsetWidth;
        const maxTop = window.innerHeight - element.offsetHeight;
        newLeft = Math.max(0, Math.min(newLeft, maxLeft));
        newTop = Math.max(0, Math.min(newTop, maxTop));
        element.style.left = `${newLeft}px`;
        element.style.top = `${newTop}px`;
        element.style.right = 'auto';
        element.style.bottom = 'auto'; // 添加 bottom auto
    };
    const dragEnd = () => {
        if (!isDraggingButton) return; // 避免重复触发
        isDraggingButton = false;
        element.style.cursor = 'move';
        document.removeEventListener('dragover', dragOver);
        document.removeEventListener('dragend', dragEnd);
        // 延迟重置标志，确保 click 事件在 dragend 后处理
        setTimeout(() => { isDraggingButton = false; }, 0);
    };
    element.addEventListener('dragstart', dragStart);
  };

  initButton.addEventListener('click', (e) => {
        // 检查是否是拖动结束后的点击
        if (isDraggingButton) {
            // 如果是拖动结束，阻止点击事件的默认行为（如果有的话），并重置标志
            e.preventDefault();
            e.stopPropagation();
            isDraggingButton = false; // 确保重置
            console.log("Drag ended, preventing click.");
            return;
        }
        // 正常的点击行为
        console.log("Button clicked.");
        if (container.style.display === 'none' || !document.body.contains(container)) {
            openConverterWindow();
        } else {
            container.style.display = 'none';
             try {
                 ReactDOM.unmountComponentAtNode(jsonEditorContainer);
             } catch (error) {
                 console.warn("卸载 React 组件时出错:", error);
             }
        }
    });

  // 将按钮添加到页面，并应用拖动
  document.body.appendChild(initButton);
  buttonDrag(initButton);

  // 处理 addon 禁用/启用
  addon.self.addEventListener('disabled', () => {
    container.style.display = 'none';
    initButton.style.display = 'none';
    try {
        ReactDOM.unmountComponentAtNode(jsonEditorContainer);
    } catch (error) {
        console.warn("禁用时卸载 React 组件出错:", error);
    }
    reactModalInstance = null; // 清除实例引用
  });

  addon.self.addEventListener('reenabled', () => {
    initButton.style.display = 'block';
    container.style.display = 'none'; // 启用时不自动打开窗口
  });

};