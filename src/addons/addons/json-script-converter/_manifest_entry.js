const manifest = {
    "editorOnly": true, // 仅在编辑器中显示
    "name": "JSON 脚本转换器", // Addon 的名称
    "description": "在浮动窗口中编辑和转换 Scratch 项目的 JSON 代码。(测试版，可能造成项目损坏或丢失，请谨慎使用，并做好备份)", // Addon 的描述
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