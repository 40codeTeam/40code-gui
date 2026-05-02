import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webpackCli = require.resolve('webpack-cli/bin/cli.js');

const child = spawn(process.execPath, [webpackCli, '--colors', '--bail'], {
    cwd: projectRoot,
    env: {
        ...process.env,
        NODE_ENV: 'production'
    },
    stdio: 'inherit'
});

child.on('close', code => {
    process.exit(code || 0);
});

child.on('error', error => {
    console.error(error);
    process.exit(1);
});
