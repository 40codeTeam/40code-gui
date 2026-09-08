'use strict';

const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(ROOT, 'src/addons/addons/json-script-converter/mcp-server.cjs');
const CATALOG = require('../src/addons/addons/json-script-converter/mcp-tools.json');

const nativeExecutableName = process.platform === 'win32' ? 'fortycode-mcp-bridge.exe' : 'fortycode-mcp-bridge';
const nativeCandidates = [
    process.env.JSC_MCP_NATIVE_BIN,
    path.join(ROOT, 'tools/40code-mcp-bridge-rs/target/release', nativeExecutableName),
    path.join(ROOT, 'static/40code-mcp-bridge', process.platform === 'win32' ?
        '40code-MCP本地桥接器.exe' : nativeExecutableName),
    path.join(ROOT, 'build/40code-mcp-bridge', process.platform === 'win32' ?
        '40code-MCP本地桥接器.exe' : nativeExecutableName),
    path.join(ROOT, 'tools/40code-mcp-bridge-rs/target/debug', nativeExecutableName)
].filter(Boolean);
const nativeBinary = nativeCandidates.find(candidate => fs.existsSync(candidate));

const getFreePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const {port} = server.address();
        server.close(error => error ? reject(error) : resolve(port));
    });
});

const request = (port, method, pathname, options = {}) => new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const req = http.request({
        host: '127.0.0.1',
        port,
        method,
        path: pathname,
        headers: {
            Accept: 'application/json, text/event-stream',
            ...(body === null ? {} : {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)}),
            ...(options.headers || {})
        }
    }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            if (text) {
                try { json = JSON.parse(text); } catch { /* asserted by the caller */ }
            }
            resolve({status: res.statusCode, headers: res.headers, text, json});
        });
    });
    req.once('error', reject);
    if (body !== null) req.write(body);
    req.end();
});

const waitForServer = async (port, child, output) => {
    let lastError;
    for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) {
            throw new Error(`bridge exited with ${child.exitCode}\n${output()}`);
        }
        try {
            const response = await request(port, 'GET', '/status');
            if (response.status === 200) return;
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`bridge did not start: ${lastError ? lastError.message : 'timeout'}\n${output()}`);
};

const stopProcess = child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    const forceTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
    }, 1000);
    forceTimer.unref();
    child.once('exit', () => {
        clearTimeout(forceTimer);
        resolve();
    });
    child.kill();
});

const startBridge = async (name, command, args) => {
    const port = await getFreePort();
    const child = spawn(command, args, {
        cwd: ROOT,
        env: {
            ...process.env,
            JSC_MCP_HOST: '127.0.0.1',
            JSC_MCP_PORT: String(port),
            JSC_MCP_CALL_TIMEOUT_MS: '1000',
            JSC_MCP_POLL_TIMEOUT_MS: '100',
            JSC_MCP_CLIENT_TTL_MS: '3000'
        },
        windowsHide: true,
        // Both implementations also expose a stdio transport and intentionally
        // exit when stdin closes. Keep the pipe open while exercising HTTP.
        stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const output = () => `${name} stdout:\n${stdout}\n${name} stderr:\n${stderr}`;
    await waitForServer(port, child, output);
    return {name, port, child, output};
};

const rpc = (bridge, message, session) => request(bridge.port, 'POST', '/mcp', {
    headers: session ? {
        'Mcp-Session-Id': session.id,
        'MCP-Protocol-Version': session.version
    } : {},
    body: message
});

const initialize = async (bridge, protocolVersion = 'not-a-real-mcp-version', id = 1) => {
    const response = await rpc(bridge, {
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
            protocolVersion,
            capabilities: {},
            clientInfo: {name: '40code-process-conformance', version: '1.0.0'}
        }
    });
    assert.equal(response.status, 200, `${bridge.name}: ${response.text}\n${bridge.output()}`);
    assert.ok(response.headers['mcp-session-id'], `${bridge.name} did not issue an MCP session`);
    return {
        response,
        session: {
            id: response.headers['mcp-session-id'],
            version: response.json.result.protocolVersion
        }
    };
};

const callTool = (bridge, session, id, name, args) => rpc(bridge, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {name, arguments: args}
}, session);

const comparableError = response => ({
    status: response.status,
    jsonrpc: response.json && response.json.jsonrpc,
    id: response.json && response.json.id,
    error: response.json && response.json.error
});

test('Node and Rust bridge processes expose the same MCP contract', async t => {
    assert.ok(nativeBinary,
        'native bridge not found; run cargo build --release in tools/40code-mcp-bridge-rs or set JSC_MCP_NATIVE_BIN');
    const node = await startBridge('Node bridge', process.execPath, [SERVER_PATH]);
    t.after(() => stopProcess(node.child));
    const rust = await startBridge('Rust bridge', nativeBinary, []);
    t.after(() => stopProcess(rust.child));

    const nodeInitialized = await initialize(node);
    const rustInitialized = await initialize(rust);
    assert.deepEqual(rustInitialized.response.json, nodeInitialized.response.json);
    assert.equal(nodeInitialized.response.json.result.protocolVersion, CATALOG.protocolVersions[0]);

    const compatibleVersion = '2025-06-18';
    assert.ok(CATALOG.protocolVersions.includes(compatibleVersion));
    const nodeCompatible = await initialize(node, compatibleVersion, 40);
    const rustCompatible = await initialize(rust, compatibleVersion, 40);
    assert.deepEqual(rustCompatible.response.json, nodeCompatible.response.json);
    assert.equal(nodeCompatible.response.json.result.protocolVersion, compatibleVersion);

    const nodeTools = await rpc(node, {jsonrpc: '2.0', id: 2, method: 'tools/list'}, nodeInitialized.session);
    const rustTools = await rpc(rust, {jsonrpc: '2.0', id: 2, method: 'tools/list'}, rustInitialized.session);
    assert.equal(nodeTools.status, 200);
    assert.equal(rustTools.status, 200);
    assert.deepEqual(nodeTools.json.result.tools, CATALOG.tools);
    assert.deepEqual(rustTools.json, nodeTools.json);
    for (const tool of nodeTools.json.result.tools) {
        assert.deepEqual(Object.keys(tool.annotations).sort(), [
            'destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint'
        ]);
        assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    }

    const nodePages = await callTool(node, nodeInitialized.session, 3, 'jsc_list_pages', {});
    const rustPages = await callTool(rust, rustInitialized.session, 3, 'jsc_list_pages', {});
    assert.deepEqual(nodePages.json.result.structuredContent, {
        ok: true,
        selectedClientId: null,
        pageCount: 0,
        pages: []
    });
    assert.deepEqual(rustPages.json, nodePages.json);

    const invalidCalls = [
        {
            name: 'get_pseudocode',
            arguments: {startLine: 1, endLine: 2, lineRanges: [{startLine: 3, endLine: 4}]}
        },
        {
            name: 'get_costume_info',
            arguments: {targetRef: 'a', costumeName: 'one', costumeIndex: 0}
        },
        {
            name: 'get_pseudocode',
            arguments: {startLine: 2}
        }
    ];
    for (const [index, vector] of invalidCalls.entries()) {
        const id = 10 + index;
        const nodeInvalid = await callTool(node, nodeInitialized.session, id, vector.name, vector.arguments);
        const rustInvalid = await callTool(rust, rustInitialized.session, id, vector.name, vector.arguments);
        assert.equal(nodeInvalid.json.error.code, -32602, `${vector.name}: ${nodeInvalid.text}`);
        assert.ok(Array.isArray(nodeInvalid.json.error.data.errors));
        assert.ok(nodeInvalid.json.error.data.errors.length > 0);
        assert.deepEqual(comparableError(rustInvalid), comparableError(nodeInvalid), vector.name);
    }
});
