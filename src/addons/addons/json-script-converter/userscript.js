// src/addons/json-script-converter/userscript.js
import React from 'react';
import ReactDOM from 'react-dom';
import JSONEditor from 'react-json-editor-ajrm'; // 导入 JSON 编辑器组件
import styles from './style.css'; // 导入 CSS 模块

// 添加 JSON 和 Blockly XML 转换函数
const jsonToBlocklyXml = (jsonCode) => {
  // 这里实现 JSON 到 Blockly XML 的转换逻辑
  // 简单示例，实际应根据您的需求实现
  try {
    const parsedJson = typeof jsonCode === 'string' ? JSON.parse(jsonCode) : jsonCode;
    // 这里应该有更复杂的转换逻辑
    const xml = Blockly.Xml.textToDom('<xml></xml>'); // 创建一个空的 XML
    return xml;
  } catch (error) {
    throw new Error('JSON 格式错误或转换失败: ' + error.message);
  }
};

const blocklyXmlToJson = (xml) => {
  // 这里实现 Blockly XML 到 JSON 的转换逻辑
  // 简单示例，实际应根据您的需求实现
  try {
    const xmlText = Blockly.Xml.domToText(xml);
    // 这里应该有更复杂的转换逻辑
    return { xml: xmlText };
  } catch (error) {
    throw new Error('XML 转换失败: ' + error.message);
  }
};

// 添加可拖动功能的辅助函数
const makeDraggable = (element, handle = null) => {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  const dragHandle = handle || element;
  
  const dragMouseDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // 获取鼠标位置
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.addEventListener('mouseup', closeDragElement);
    document.addEventListener('mousemove', elementDrag);
  };

  const elementDrag = (e) => {
    e.preventDefault();
    // 计算新位置
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    
    // 设置元素的新位置
    const newTop = element.offsetTop - pos2;
    const newLeft = element.offsetLeft - pos1;
    
    // 确保元素不会超出视口
    const maxLeft = window.innerWidth - element.offsetWidth;
    const maxTop = window.innerHeight - element.offsetHeight;
    
    element.style.top = Math.max(0, Math.min(newTop, maxTop)) + "px";
    element.style.left = Math.max(0, Math.min(newLeft, maxLeft)) + "px";
  };

  const closeDragElement = () => {
    // 停止移动
    document.removeEventListener('mouseup', closeDragElement);
    document.removeEventListener('mousemove', elementDrag);
  };

  // 为元素添加拖动事件
  dragHandle.addEventListener('mousedown', dragMouseDown);
};

export default async ({ addon, console, msg }) => {
  console.log('userscript.js loaded');
  // 获取 Blockly 实例和工作区
  const Blockly = await addon.tab.traps.getBlockly();
  const workspace = addon.tab.traps.getWorkspace();

  // 创建悬浮元素容器
  const container = document.createElement('div');
  container.className = styles.jsonConverterContainer; // 应用样式
  container.style.position = 'absolute';
  container.style.top = '50px';
  container.style.left = '50px';
  container.style.zIndex = '10000';
  container.style.backgroundColor = 'white';
  container.style.border = '1px solid #ccc';
  container.style.borderRadius = '5px';
  container.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
  container.style.padding = '10px';
  container.style.minWidth = '400px';
  container.style.maxWidth = '800px';

  // 创建标题栏（用于拖动）
  const titleBar = document.createElement('div');
  titleBar.style.padding = '5px';
  titleBar.style.backgroundColor = '#f0f0f0';
  titleBar.style.borderBottom = '1px solid #ccc';
  titleBar.style.cursor = 'move';
  titleBar.style.display = 'flex';
  titleBar.style.justifyContent = 'space-between';
  titleBar.style.alignItems = 'center';
  titleBar.style.marginBottom = '10px';
  titleBar.innerHTML = '<span>JSON 脚本转换器</span>';
  container.appendChild(titleBar);

  // 添加关闭按钮
  const closeButton = document.createElement('button');
  closeButton.textContent = 'X';
  closeButton.style.border = 'none';
  closeButton.style.background = 'none';
  closeButton.style.cursor = 'pointer';
  closeButton.style.fontSize = '16px';
  closeButton.style.fontWeight = 'bold';
  closeButton.onclick = () => {
    container.style.display = 'none';
  };
  titleBar.appendChild(closeButton);

  // 创建 JSON 编辑器容器
  const jsonEditorContainer = document.createElement('div');
  container.appendChild(jsonEditorContainer);

  // 使容器可拖动
  makeDraggable(container, titleBar);

  // 定义 JSON 编辑器组件 (React 组件)
  class JsonEditorComponent extends React.Component {
    constructor(props) {
      super(props);
      this.state = { 
        jsonValue: props.value || {} 
      }; // 初始化 JSON 数据
    }

    handleJsonChange = (value) => {
      this.setState({ jsonValue: value.jsObject || {} });
      if (this.props.onChange) {
        this.props.onChange(value.jsObject || {});
      }
    };

    // 添加获取编辑器值的方法
    getEditorValue = () => {
      return this.state.jsonValue;
    };

    // 添加设置编辑器值的方法
    setValue = (value) => {
      this.setState({ jsonValue: value });
    };

    render() {
      return (
        <div>
          <JSONEditor
            id="jsonEditor"
            placeholder={this.state.jsonValue}
            colors={{
              background: '#f5f5f5',
              default: '#000000',
            }}
            locale="zh-cn"
            height="300px"
            width="100%"
            onChange={this.handleJsonChange}
          />
        </div>
      );
    }
  }

  // 定义悬浮元素组件 (React 组件)
  class JsonScriptConverterModal extends React.Component {
    constructor(props) {
      super(props);
      this.state = {
        jsonValue: {}
      };
      this.jsonEditorComponent = React.createRef();
    }

    handleJsonChange = (jsonValue) => {
      this.setState({ jsonValue });
    };

    handleJsonToScript = () => {
      // JSON to Scratch 脚本转换逻辑
      const jsonCode = this.jsonEditorComponent.current.getEditorValue(); // 获取 JSON 编辑器的值
      try {
        const xml = jsonToBlocklyXml(jsonCode); // JSON 转换为 Blockly XML
        Blockly.Xml.clearWorkspaceAndLoadFromXml(xml, workspace); // 加载 XML 到工作区
        console.log('JSON 转换为 Scratch 脚本成功!');
      } catch (error) {
        console.error('JSON 转换为 Scratch 脚本失败:', error);
        alert('JSON 转换为 Scratch 脚本失败: ' + error.message);
      }
    };

    handleScriptToJson = () => {
      // Scratch 脚本 to JSON 转换逻辑
      try {
        const xml = Blockly.Xml.workspaceToDom(workspace); // 获取工作区 XML
        const jsonCode = blocklyXmlToJson(xml); // Blockly XML 转换为 JSON
        this.jsonEditorComponent.current.setValue(jsonCode); // 设置 JSON 编辑器的值
        console.log('Scratch 脚本转换为 JSON 成功!');
      } catch (error) {
        console.error('Scratch 脚本转换为 JSON 失败:', error);
        alert('Scratch 脚本转换为 JSON 失败: ' + error.message);
      }
    };

    render() {
      return (
        <div className={styles.modalContent}>
          <h3>JSON 脚本转换器</h3>
          <JsonEditorComponent
            ref={this.jsonEditorComponent}
            value={this.state.jsonValue}
            onChange={this.handleJsonChange}
          />
          <div className={styles.buttonContainer}>
            <button onClick={this.handleJsonToScript}>转换到 Scratch 脚本</button>
            <button onClick={this.handleScriptToJson}>转换到 JSON</button>
          </div>
        </div>
      );
    }
  }

  // 添加编辑器上下文菜单项
  addon.tab.createEditorContextMenu((items, block) => {
    items.push({
      enabled: true,
      text: 'JSON 脚本转换器', // 菜单项文本
      callback: () => {
        // 显示悬浮元素
        ReactDOM.render(<JsonScriptConverterModal />, jsonEditorContainer);
        addon.tab.displayNoneWhileDisabled(container); // 确保 addon 启用时显示
        container.style.display = 'block'; // 确保显示
        document.body.appendChild(container); // 将悬浮元素添加到 body
      },
      separator: true,
    });
    return items;
  }, { workspace: true });

  // 添加一个初始化按钮到界面，方便测试
  const initButton = document.createElement('button');
  initButton.textContent = '打开 JSON 转换器';
  initButton.style.position = 'fixed'; // 改为 fixed 定位
  initButton.style.top = '10px';
  initButton.style.right = '10px';
  initButton.style.zIndex = '9999';
  initButton.style.cursor = 'move';
  initButton.style.padding = '5px 10px';
  initButton.style.width = 'auto';
  initButton.style.height = 'auto';
  initButton.style.whiteSpace = 'nowrap';
  initButton.style.boxSizing = 'content-box';
  initButton.style.userSelect = 'none'; // 防止文本选择
  initButton.style.border = '1px solid #ccc';
  initButton.style.borderRadius = '4px';
  initButton.style.backgroundColor = '#f0f0f0';

  // 为按钮创建特殊的拖动处理
  const buttonDrag = (element) => {
    let isDragging = false;
    let startX, startY, startLeft, startTop;
    
    element.addEventListener('mousedown', (e) => {
      // 只有当点击的是按钮本身时才开始拖动
      if (e.target === element) {
        e.preventDefault();
        isDragging = true;
        
        // 获取初始位置
        startX = e.clientX;
        startY = e.clientY;
        
        // 计算按钮当前位置
        const rect = element.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        
        document.addEventListener('mousemove', mousemove);
        document.addEventListener('mouseup', mouseup);
      }
    });
    
    const mousemove = (e) => {
      if (!isDragging) return;
      
      // 计算新位置
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      
      const newLeft = startLeft + dx;
      const newTop = startTop + dy;
      
      // 确保按钮不会超出视口
      const maxLeft = window.innerWidth - element.offsetWidth;
      const maxTop = window.innerHeight - element.offsetHeight;
      
      element.style.left = Math.max(0, Math.min(newLeft, maxLeft)) + 'px';
      element.style.top = Math.max(0, Math.min(newTop, maxTop)) + 'px';
      element.style.right = 'auto'; // 清除 right 属性，使用 left 定位
    };
    
    const mouseup = () => {
      isDragging = false;
      document.removeEventListener('mousemove', mousemove);
      document.removeEventListener('mouseup', mouseup);
    };
  };

  initButton.onclick = (e) => {
    // 只有当不是拖动时才执行点击操作
    if (!e.isDragging) {
      ReactDOM.render(<JsonScriptConverterModal />, jsonEditorContainer);
      addon.tab.displayNoneWhileDisabled(container);
      container.style.display = 'block';
      document.body.appendChild(container);
    }
  };

  document.body.appendChild(initButton);
  
  // 使用新的拖动处理函数
  buttonDrag(initButton);
};