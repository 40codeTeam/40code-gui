const manifest = {
    "editorOnly": true, // 仅在编辑器中显示
    "name": "积木脚本助手", // Addon 的名称
    "description": "在浮动窗口中用伪代码编辑 Scratch 积木，并可通过 AI 生成或修改脚本。(测试版，可能造成项目损坏或丢失，请谨慎使用，并做好备份)", // Addon 的描述
    "credits": [ // 贡献者信息
      {
        "name": "40code" // 你的名字
      }
    ],
    "userscripts": [ // 用户脚本
      {
        "url": "userscript.js" // 运行时入口点
      }
    ],
    "userstyles": [ // 用户样式
      {
        "url": "style.css" // 样式文件
      }
    ],
    "tags": [
        "new"
    ] // 标签
  };
  
  export default manifest;
