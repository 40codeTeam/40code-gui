// src/addons/json-script-converter/_runtime_entry.js
import _js from "./userscript.js";
import _css from "!css-loader!./style.css"; // 导入 CSS 样式

export const resources = {
  "userscript.js": _js,
  "style.css": _css,
};