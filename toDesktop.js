const fs = require('fs-extra');
for (const p of ["./build/addons.html", "./build/editor.html"]) {
    for (const l of [
        "https://lf6-cdn-tos.bytecdntp.com/cdn/expire-1-y/crypto-js/4.1.1/",
        "https://lf9-cdn-tos.bytecdntp.com/cdn/expire-1-y/dompurify/2.3.6/",
        "https://cdn.bootcdn.net/ajax/libs/mdui/2.1.2/",
        "https://cdn.bootcdn.net/ajax/libs/jquery/3.6.0/",
        "https://lf9-cdn-tos.bytecdntp.com/cdn/expire-1-y/marked/4.0.2/",
        'https://lib.baomitu.com/mdui/2.1.2/'
    ])
        fs.writeFileSync(
            p,
            (fs.readFileSync(p) + "").replaceAll(l, "../other/")
        );
}

const path = require("path");

const sourceDir = path.resolve(__dirname, "build");
const targetDir = path.resolve(__dirname, "../40code-desktop/static");

async function updateStatic() {
    try {
        // 删除目标目录中的所有文件
        await fs.emptyDir(targetDir);
        console.log(`已清空目录: ${targetDir}`);

        // 复制源目录中的所有文件到目标目录
        await fs.copy(sourceDir, targetDir);
        console.log(`已复制目录: ${sourceDir} 到 ${targetDir}`);
    } catch (err) {
        console.error("操作失败:", err);
    }
}

updateStatic();