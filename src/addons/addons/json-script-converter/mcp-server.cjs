#!/usr/bin/env node
'use strict';

const http = require('node:http');
const {randomUUID} = require('node:crypto');

const normalizeHttpPath = value => {
    let path = String(value || '/').trim();
    if (!path.startsWith('/')) path = `/${path}`;
    return path.replace(/\/+$/, '') || '/';
};

const SERVER_NAME = '40code-json-script-converter';
const SERVER_VERSION = '0.3.0';
const PROTOCOL_VERSION = '2025-06-18';
const HOST = process.env.JSC_MCP_HOST || '127.0.0.1';
const PORT = Number(process.env.JSC_MCP_PORT || 47740);
const CALL_TIMEOUT_MS = Number(process.env.JSC_MCP_CALL_TIMEOUT_MS || 120000);
const POLL_TIMEOUT_MS = Number(process.env.JSC_MCP_POLL_TIMEOUT_MS || 25000);
const BRIDGE_CLIENT_TTL_MS = Number(process.env.JSC_MCP_CLIENT_TTL_MS || 60000);
const BODY_LIMIT = 1024 * 1024 * 8;
const BRIDGE_PATH = normalizeHttpPath(process.env.JSC_MCP_BRIDGE_PATH || '/');
const LEGACY_BRIDGE_PATH = '/json-script-converter/mcp';
const MCP_HTTP_PATH = normalizeHttpPath(process.env.JSC_MCP_HTTP_PATH || '/mcp');
const PSEUDOCODE_SYNTAX_URI = 'jsc://pseudocode/syntax';
const SERVER_INSTRUCTIONS = [
    'This server edits 40code/Scratch projects through the json-script-converter addon.',
    `Before calling edit_pseudocode for the first time, read ${PSEUDOCODE_SYNTAX_URI} with resources/read or call jsc_get_pseudocode_syntax.`,
    'Use get_target_info and get_pseudocode to inspect the current project before editing.',
    'Use create_svg_costume and replace_svg_costume for vector UI elements.',
    'Use create_bitmap_costume and replace_bitmap_costume when complete bitmap image data is available.'
].join(' ');

const PSEUDOCODE_SYNTAX_GUIDE = String.raw`
# 40code json-script-converter pseudocode syntax

Use this syntax when calling edit_pseudocode. The pseudocode is converted to Scratch blocks inside the connected 40code editor.

## Workflow

1. Call get_target_info to learn targetRef values for the stage and sprites.
2. Call get_pseudocode for targets you will modify.
3. Create or replace vector costumes/backdrops with create_svg_costume or replace_svg_costume when the project needs visible UI. Use create_bitmap_costume or replace_bitmap_costume for bitmap image data.
4. Apply code with edit_pseudocode. For simple changes use mode: "replace" and pass targetRef plus full pseudocode.

## Basic shape

Scripts are separated by a blank line. Use braces for script bodies and control blocks.

Global variables:

    #vars { screen, selectedLevel, createIndex }

Sprite-local variables:

    #localvars { buttonId }

Lists:

    #lists { unlockedLevels }
    #locallists { path }

Broadcast messages do not need a header. broadcast("message") and on_broadcast("message") create them automatically.

## Common event hats

    on_flag_clicked() {
        screen = "start"
        broadcast("show-start")
    }

    on_broadcast("show-start") {
        show()
    }

    on_sprite_clicked() {
        broadcast("open-level-select")
    }

    on_stage_clicked() {
        broadcast("stage-clicked")
    }

    on_key_pressed("space") {
        broadcast("confirm")
    }

    on_clone_start() {
        buttonId = createIndex
        show()
    }

## Common statements

    screen = "level-select"
    selectedLevel = 1
    selectedLevel += 1
    broadcast("show-help")
    broadcast_and_wait("refresh-ui")
    wait(0.2)
    repeat(3) {
        change_y(10)
    }
    forever() {
        if (screen == "start") {
            show()
        }
    }
    if_else(selectedLevel == 1) {
        switch_costume("level-1")
    } else {
        switch_costume("locked")
    }

## Useful motion and looks

    goto_xy(0, 0)
    set_x(120)
    set_y(-80)
    set_size(100)
    show()
    hide()
    switch_costume("Start Button")
    switch_backdrop("Start Screen")
    next_costume()
    clear_effects()
    goto_layer("front")

## Operators

Use normal infix operators where possible:

    if (selectedLevel > 0 && selectedLevel < 4) {
        broadcast("start-level")
    }

Useful reporters:

    random(1, 3)
    round(score)
    join("Level ", selectedLevel)
    mouse_x()
    mouse_y()
    mouse_down()
    key_pressed("space")

## Numbered clone menu pattern

For level buttons or repeated menu items, use a global creation marker and a local clone identity. Always wait(0) after create_clone_of("_myself_") so the clone can copy the marker.

    #vars { createIndex, selectedLevel }
    #localvars { buttonId }

    on_broadcast("show-level-select") {
        hide()
        createIndex = 0
        repeat(3) {
            createIndex += 1
            create_clone_of("_myself_")
            wait(0)
        }
    }

    on_clone_start() {
        buttonId = createIndex
        switch_costume(join("Level ", buttonId))
        goto_xy((buttonId - 2) * 120, -20)
        show()
    }

    on_sprite_clicked() {
        selectedLevel = buttonId
        broadcast("start-level")
    }

## UI guidance for generated projects

Use SVG costumes/backdrops for real interface text and buttons. Do not use say/think bubbles as button labels. For a project with start/help/level-select screens, put the screen state in a global variable such as screen, switch backdrops for large screen changes, and show or hide button sprites in response to broadcast messages.
`.trim();

const bridgeCalls = [];
const bridgeResults = new Map();
const pollWaiters = [];
const bridgeClients = new Map();

const log = (...args) => {
    console.error(`[${SERVER_NAME}]`, ...args);
};

const jsonSchema = (properties, required = []) => ({
    type: 'object',
    properties,
    required,
    additionalProperties: true
});

const stringProp = description => ({type: 'string', description});
const numberProp = description => ({type: 'number', description});
const booleanProp = description => ({type: 'boolean', description});
const arrayProp = (items, description) => ({type: 'array', items, description});
const objectProp = description => ({type: 'object', description, additionalProperties: true});

const tool = (name, description, properties = {}, required = []) => ({
    name,
    description,
    inputSchema: jsonSchema(properties, required)
});

const TOOL_DEFINITIONS = [
    tool('jsc_bridge_status', 'Return MCP bridge status and the connected 40code page URL without calling page tools.'),
    tool('jsc_get_pseudocode_syntax', 'Return the pseudocode syntax guide for edit_pseudocode. Call this before generating pseudocode.'),
    tool('jsc_get_status', 'Return the connected 40code page URL, status, current target, and target refs.'),
    tool('jsc_call_action', 'Call any json-script-converter action payload directly. Use this for batch calls or advanced payloads.', {
        action: objectProp('Action payload, hidden ACTION JSON, or batch payload.')
    }, ['action']),
    tool('get_target_info', 'List target/sprite/stage metadata. Use targetRefs/targetIds to limit targets.', {
        targetRefs: arrayProp({type: 'string'}, 'Target refs such as ["a", "b"]. Empty means all targets.')
    }),
    tool('get_pseudocode', 'Read pseudocode for one or more targets, optionally limited to line ranges.', {
        targetRefs: arrayProp({type: 'string'}, 'Target refs such as ["a", "b"].'),
        startLine: numberProp('Optional 1-based start line for a single range.'),
        endLine: numberProp('Optional 1-based end line for a single range.'),
        lineRanges: arrayProp(objectProp('Line range with targetRef/startLine/endLine.'), 'Optional per-target ranges.')
    }),
    tool('search_text', 'Search pseudocode text across targets.', {
        query: stringProp('Text or regex pattern to search.'),
        targetRefs: arrayProp({type: 'string'}, 'Target refs. Empty means all targets.'),
        caseSensitive: booleanProp('Whether search is case-sensitive.'),
        regex: booleanProp('Whether query is a regular expression.'),
        maxResults: numberProp('Maximum returned matches.')
    }, ['query']),
    tool('list_extensions', 'List loaded, local, and optionally remote extensions.', {
        query: stringProp('Optional search text.'),
        source: stringProp('Optional source filter.'),
        includeRemote: booleanProp('Whether to query remote extension catalog.'),
        limit: numberProp('Maximum returned extensions.')
    }),
    tool('load_extension', 'Load an extension by extensionId, slug, or URL.', {
        extensionId: stringProp('Builtin/local extension id, such as pen.'),
        slug: stringProp('TurboWarp extension slug.'),
        url: stringProp('Extension JavaScript URL.')
    }),
    tool('get_extension_blocks', 'Return block/opcode metadata for a loaded extension.', {
        extensionId: stringProp('Loaded extension id.'),
        query: stringProp('Optional opcode/name search text.'),
        limit: numberProp('Maximum returned blocks.')
    }, ['extensionId']),
    tool('get_costume_info', 'Return costume/backdrop metadata and SVG source when requested.', {
        targetRef: stringProp('Target ref/name/id. Defaults to current target.'),
        targetRefs: arrayProp({type: 'string'}, 'Optional multiple target refs.'),
        costumeName: stringProp('Optional costume/backdrop name.'),
        costumeIndex: numberProp('Optional zero-based costume/backdrop index.'),
        includeSvg: booleanProp('Whether to include SVG source when available.')
    }),
    tool('inspect_costume', 'Return a PNG data URL for a costume/backdrop image. Requires image understanding enabled in the addon AI settings.', {
        targetRef: stringProp('Target ref/name/id. Defaults to current target.'),
        costumeName: stringProp('Optional costume/backdrop name.'),
        costumeIndex: numberProp('Optional zero-based costume/backdrop index.')
    }),
    tool('get_stage_snapshot', 'Return a PNG data URL screenshot of the stage. Requires image understanding enabled in the addon AI settings.'),
    tool('click_green_flag', 'Click the green flag / start the project.'),
    tool('click_pause', 'Pause the project.'),
    tool('click_stop', 'Stop the project.'),
    tool('create_sprite', 'Create a new sprite.', {
        name: stringProp('Requested sprite name.')
    }),
    tool('delete_sprite', 'Delete a sprite. Pass confirm:true to skip the in-page confirmation dialog.', {
        targetRef: stringProp('Target ref/name/id.'),
        name: stringProp('Sprite name, used when targetRef is not provided.'),
        confirm: booleanProp('Set true to confirm deletion from the external caller.')
    }),
    tool('create_costume', 'Create a blank costume/backdrop on a target.', {
        targetRef: stringProp('Target ref/name/id. Defaults to current target.'),
        name: stringProp('Costume/backdrop name.')
    }),
    tool('delete_costume', 'Delete a costume/backdrop. Pass confirm:true to skip the in-page confirmation dialog.', {
        targetRef: stringProp('Target ref/name/id. Defaults to current target.'),
        costumeName: stringProp('Costume/backdrop name.'),
        costumeIndex: numberProp('Zero-based costume/backdrop index.'),
        confirm: booleanProp('Set true to confirm deletion from the external caller.')
    }),
    tool('create_svg_costume', 'Create a new SVG costume/backdrop on a target.', {
        targetRef: stringProp('Target ref/name/id. Defaults to current target.'),
        name: stringProp('Costume/backdrop name.'),
        svg: stringProp('Safe standalone SVG text.'),
        rotationCenterX: numberProp('Optional rotation center x.'),
        rotationCenterY: numberProp('Optional rotation center y.')
    }, ['svg']),
    tool('replace_svg_costume', 'Replace an existing costume/backdrop with SVG.', {
        targetRef: stringProp('Target ref/name/id. Defaults to current target.'),
        costumeName: stringProp('Costume/backdrop name.'),
        costumeIndex: numberProp('Zero-based costume/backdrop index.'),
        newName: stringProp('Optional new costume/backdrop name.'),
        svg: stringProp('Safe standalone SVG text.'),
        rotationCenterX: numberProp('Optional rotation center x.'),
        rotationCenterY: numberProp('Optional rotation center y.')
    }, ['svg']),
    tool('create_bitmap_costume', 'Create a new bitmap costume/backdrop from image data. The image is normalized to PNG.', {
        targetRef: stringProp('Target ref/name/id. Defaults to current target.'),
        name: stringProp('Costume/backdrop name.'),
        imageData: stringProp('PNG, JPEG, WebP, BMP, or GIF as a base64 data URL or raw base64 data.'),
        mimeType: stringProp('Image MIME type when imageData is raw base64. Defaults to image/png.'),
        rotationCenterX: numberProp('Optional rotation center x in source-image pixels.'),
        rotationCenterY: numberProp('Optional rotation center y in source-image pixels.')
    }, ['imageData']),
    tool('replace_bitmap_costume', 'Replace an existing costume/backdrop with bitmap image data. The image is normalized to PNG.', {
        targetRef: stringProp('Target ref/name/id. Defaults to current target.'),
        costumeName: stringProp('Costume/backdrop name.'),
        costumeIndex: numberProp('Zero-based costume/backdrop index.'),
        newName: stringProp('Optional new costume/backdrop name.'),
        imageData: stringProp('PNG, JPEG, WebP, BMP, or GIF as a base64 data URL or raw base64 data.'),
        mimeType: stringProp('Image MIME type when imageData is raw base64. Defaults to image/png.'),
        rotationCenterX: numberProp('Optional rotation center x in source-image pixels.'),
        rotationCenterY: numberProp('Optional rotation center y in source-image pixels.')
    }, ['imageData']),
    tool('edit_pseudocode', `Apply pseudocode edits. Supports mode:"replace" with pseudocode or mode:"patch" with patches. Read ${PSEUDOCODE_SYNTAX_URI} or call jsc_get_pseudocode_syntax before using this tool.`, {
        targetRef: stringProp('Target ref/name/id for a simple single-target edit.'),
        mode: stringProp('replace or patch.'),
        pseudocode: stringProp('Full pseudocode when mode is replace.'),
        patches: arrayProp(objectProp('Patch object.'), 'Line patches when mode is patch.'),
        edits: arrayProp(objectProp('Multi-target edit object.'), 'Advanced multi-target edits.')
    })
];

const RESOURCE_DEFINITIONS = [{
    uri: PSEUDOCODE_SYNTAX_URI,
    name: '40code pseudocode syntax',
    description: 'Syntax guide and examples for edit_pseudocode.',
    mimeType: 'text/markdown'
}];

const corsHeaders = () => ({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    'Cache-Control': 'no-store'
});

const sendJson = (res, status, payload, extraHeaders = {}) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        ...corsHeaders(),
        ...extraHeaders
    });
    res.end(body);
};

const sendNoBody = (res, status, extraHeaders = {}) => {
    res.writeHead(status, {
        ...corsHeaders(),
        ...extraHeaders
    });
    res.end();
};

const readBody = req => new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
        body += chunk;
        if (body.length > BODY_LIMIT) {
            reject(new Error('Request body too large'));
            req.destroy();
        }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
});

const hasActiveBridgeClient = () => {
    const now = Date.now();
    for (const client of bridgeClients.values()) {
        if (now - client.lastSeen <= BRIDGE_CLIENT_TTL_MS) return true;
    }
    return false;
};

const getBridgeStatus = () => {
    const now = Date.now();
    const clients = Array.from(bridgeClients.values())
        .map(client => ({
            clientId: client.clientId,
            title: client.title,
            pageUrl: client.pageUrl || '',
            lastSeenAgoMs: now - client.lastSeen
        }))
        .sort((a, b) => a.lastSeenAgoMs - b.lastSeenAgoMs);
    const activeClient = clients.find(client => client.lastSeenAgoMs <= BRIDGE_CLIENT_TTL_MS) || null;
    return {
        ok: true,
        bridge: {
            host: HOST,
            port: PORT,
            path: BRIDGE_PATH,
            legacyPath: LEGACY_BRIDGE_PATH,
            bridgeUrl: `http://${HOST}:${PORT}${BRIDGE_PATH === '/' ? '/' : BRIDGE_PATH}`,
            legacyBridgeUrl: `http://${HOST}:${PORT}${LEGACY_BRIDGE_PATH}`,
            mcpHttpUrl: `http://${HOST}:${PORT}${MCP_HTTP_PATH}`,
            rootMcpHttpUrl: `http://${HOST}:${PORT}/`,
            connected: !!activeClient,
            pageTitle: activeClient ? activeClient.title : '',
            pageUrl: activeClient ? activeClient.pageUrl : '',
            clients,
            pendingCalls: bridgeCalls.length,
            waitingResults: bridgeResults.size
        }
    };
};

const completePoll = (waiter, calls) => {
    clearTimeout(waiter.timer);
    sendJson(waiter.res, 200, {ok: true, calls});
};

const flushPollWaiters = () => {
    if (!bridgeCalls.length || !pollWaiters.length) return;
    while (bridgeCalls.length && pollWaiters.length) {
        const waiter = pollWaiters.shift();
        const calls = bridgeCalls.splice(0, Math.min(8, bridgeCalls.length));
        completePoll(waiter, calls);
    }
};

const enqueueBridgeCall = (name, args) => new Promise((resolve, reject) => {
    if (!hasActiveBridgeClient()) {
        reject(new Error('No 40code page is connected. Open the editor page with json-script-converter enabled, then retry.'));
        return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
        bridgeResults.delete(id);
        reject(new Error(`Timed out waiting for 40code page result after ${CALL_TIMEOUT_MS}ms`));
    }, CALL_TIMEOUT_MS);
    bridgeResults.set(id, {resolve, reject, timer});
    bridgeCalls.push({id, name, arguments: args || {}});
    flushPollWaiters();
});

const handlePoll = (req, res, url) => {
    const clientId = url.searchParams.get('clientId') || 'unknown';
    const title = url.searchParams.get('title') || '';
    const pageUrl = url.searchParams.get('pageUrl') || '';
    bridgeClients.set(clientId, {clientId, title, pageUrl, lastSeen: Date.now()});
    if (bridgeCalls.length) {
        sendJson(res, 200, {ok: true, calls: bridgeCalls.splice(0, Math.min(8, bridgeCalls.length))});
        return;
    }
    const waiter = {
        res,
        timer: null
    };
    waiter.timer = setTimeout(() => {
        const index = pollWaiters.indexOf(waiter);
        if (index >= 0) pollWaiters.splice(index, 1);
        sendJson(res, 200, {ok: true, calls: []});
    }, POLL_TIMEOUT_MS);
    pollWaiters.push(waiter);
    req.on('close', () => {
        const index = pollWaiters.indexOf(waiter);
        if (index >= 0) {
            pollWaiters.splice(index, 1);
            clearTimeout(waiter.timer);
        }
    });
};

const handleResult = async (req, res) => {
    const body = await readBody(req);
    const payload = body ? JSON.parse(body) : {};
    if (payload.clientId) {
        const previous = bridgeClients.get(payload.clientId);
        bridgeClients.set(payload.clientId, {
            clientId: payload.clientId,
            title: payload.title || (previous && previous.title) || '',
            pageUrl: payload.pageUrl || (previous && previous.pageUrl) || '',
            lastSeen: Date.now()
        });
    }
    const pending = bridgeResults.get(payload.id);
    if (!pending) {
        sendJson(res, 404, {ok: false, error: 'Unknown or expired call id'});
        return;
    }
    bridgeResults.delete(payload.id);
    clearTimeout(pending.timer);
    if (payload.error) {
        pending.reject(new Error(String(payload.error)));
    } else {
        pending.resolve(payload.result);
    }
    sendJson(res, 200, {ok: true});
};

const isAllowedOrigin = origin => {
    if (!origin) return true;
    try {
        const url = new URL(origin);
        return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
    } catch {
        return false;
    }
};

const handleMcpHttp = async (req, res) => {
    if (!isAllowedOrigin(req.headers.origin)) {
        sendJson(res, 403, {jsonrpc: '2.0', id: null, error: {code: -32000, message: 'Forbidden origin'}});
        return;
    }
    if (req.method === 'OPTIONS') {
        sendNoBody(res, 204);
        return;
    }
    if (req.method === 'GET') {
        sendNoBody(res, 405, {'Allow': 'POST, OPTIONS'});
        return;
    }
    if (req.method !== 'POST') {
        sendNoBody(res, 405, {'Allow': 'POST, OPTIONS'});
        return;
    }

    let message;
    try {
        const body = await readBody(req);
        message = body ? JSON.parse(body) : null;
    } catch (err) {
        sendJson(res, 400, makeRpcError(null, -32700, err && err.message ? err.message : String(err)));
        return;
    }

    if (!message || Array.isArray(message) || typeof message !== 'object') {
        sendJson(res, 400, makeRpcError(null, -32600, 'Expected a single JSON-RPC message object'));
        return;
    }

    if (message.method === undefined && ('result' in message || 'error' in message)) {
        sendNoBody(res, 202);
        return;
    }

    if (message.id === undefined && message.method) {
        await handleRpcRequest(message);
        sendNoBody(res, 202);
        return;
    }

    const response = await handleRpcRequest(message);
    if (!response) {
        sendNoBody(res, 202);
        return;
    }
    sendJson(res, 200, response);
};

const getBridgeSuffix = pathname => {
    if (pathname === MCP_HTTP_PATH) return null;

    if (pathname === LEGACY_BRIDGE_PATH || pathname.startsWith(`${LEGACY_BRIDGE_PATH}/`)) {
        const suffix = pathname.slice(LEGACY_BRIDGE_PATH.length);
        return suffix || '/';
    }

    if (BRIDGE_PATH === '/') {
        return pathname || '/';
    }

    if (pathname === BRIDGE_PATH || pathname.startsWith(`${BRIDGE_PATH}/`)) {
        const suffix = pathname.slice(BRIDGE_PATH.length);
        return suffix || '/';
    }

    return null;
};

const createBridgeServer = () => http.createServer(async (req, res) => {
    try {
        for (const [name, value] of Object.entries(corsHeaders())) {
            res.setHeader(name, value);
        }
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        const url = new URL(req.url, `http://${HOST}:${PORT}`);
        if (url.pathname === MCP_HTTP_PATH) {
            await handleMcpHttp(req, res);
            return;
        }
        const suffix = getBridgeSuffix(url.pathname);
        if (!suffix) {
            sendJson(res, 404, {ok: false, error: 'Not found'});
            return;
        }
        if (req.method === 'POST' && suffix === '/') {
            await handleMcpHttp(req, res);
            return;
        }
        if (req.method === 'GET' && suffix === '/poll') {
            handlePoll(req, res, url);
            return;
        }
        if (req.method === 'GET' && (suffix === '/' || suffix === '/status')) {
            sendJson(res, 200, getBridgeStatus());
            return;
        }
        if (req.method === 'POST' && suffix === '/result') {
            await handleResult(req, res);
            return;
        }
        sendJson(res, 404, {ok: false, error: 'Not found'});
    } catch (err) {
        sendJson(res, 500, {ok: false, error: err && err.message ? err.message : String(err)});
    }
});

let bridgeServer = null;
const startBridgeServer = () => {
    if (bridgeServer) return bridgeServer;
    bridgeServer = createBridgeServer();
    bridgeServer.on('error', error => {
        log(`bridge failed on http://${HOST}:${PORT}: ${error && error.message ? error.message : String(error)}`);
    });
    bridgeServer.listen(PORT, HOST, () => {
        log(`bridge listening on http://${HOST}:${PORT}${BRIDGE_PATH}`);
        log(`MCP HTTP endpoint on http://${HOST}:${PORT}${MCP_HTTP_PATH}`);
    });
    return bridgeServer;
};

const writeRpc = message => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
};

const makeRpcResult = (id, result) => ({jsonrpc: '2.0', id, result});
const makeRpcError = (id, code, message, data) => ({
    jsonrpc: '2.0',
    id,
    error: {
        code,
        message,
        ...(data === undefined ? {} : {data})
    }
});
const rpcResult = (id, result) => writeRpc(makeRpcResult(id, result));
const rpcError = (id, code, message, data) => writeRpc(makeRpcError(id, code, message, data));

const toMcpContent = result => ({
    content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
    }],
    isError: !!(result && result.ok === false)
});

const handleRpcRequest = async message => {
    const {id, method, params} = message;
    if (!method) {
        if (id !== undefined) return makeRpcError(id, -32600, 'Missing method');
        return null;
    }
    if (method.startsWith('notifications/')) return null;
    try {
        if (method === 'initialize') {
            return makeRpcResult(id, {
                protocolVersion: params && params.protocolVersion || PROTOCOL_VERSION,
                capabilities: {
                    tools: {},
                    resources: {}
                },
                instructions: SERVER_INSTRUCTIONS,
                serverInfo: {
                    name: SERVER_NAME,
                    version: SERVER_VERSION
                }
            });
        }
        if (method === 'ping') {
            return makeRpcResult(id, {});
        }
        if (method === 'tools/list') {
            return makeRpcResult(id, {tools: TOOL_DEFINITIONS});
        }
        if (method === 'tools/call') {
            const name = params && params.name;
            const args = params && params.arguments || {};
            if (!name) {
                return makeRpcError(id, -32602, 'tools/call missing params.name');
            }
            if (name === 'jsc_bridge_status') {
                return makeRpcResult(id, toMcpContent(getBridgeStatus()));
            }
            if (name === 'jsc_get_pseudocode_syntax') {
                return makeRpcResult(id, {
                    content: [{
                        type: 'text',
                        text: PSEUDOCODE_SYNTAX_GUIDE
                    }],
                    isError: false
                });
            }
            const result = await enqueueBridgeCall(name, args);
            return makeRpcResult(id, toMcpContent(result));
        }
        if (method === 'resources/list') {
            return makeRpcResult(id, {resources: RESOURCE_DEFINITIONS});
        }
        if (method === 'resources/read') {
            const uri = params && params.uri;
            if (uri === PSEUDOCODE_SYNTAX_URI) {
                return makeRpcResult(id, {
                    contents: [{
                        uri,
                        mimeType: 'text/markdown',
                        text: PSEUDOCODE_SYNTAX_GUIDE
                    }]
                });
            }
            return makeRpcError(id, -32602, `Unknown resource: ${uri || ''}`);
        }
        if (method === 'prompts/list') {
            return makeRpcResult(id, {prompts: []});
        }
        return makeRpcError(id, -32601, `Method not found: ${method}`);
    } catch (err) {
        return makeRpcResult(id, toMcpContent({
            ok: false,
            error: err && err.message ? err.message : String(err)
        }));
    }
};

const startStdioServer = () => {
    let stdinBuffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
        stdinBuffer += chunk;
        let index = stdinBuffer.indexOf('\n');
        while (index >= 0) {
            const line = stdinBuffer.slice(0, index).trim();
            stdinBuffer = stdinBuffer.slice(index + 1);
            if (line) {
                try {
                    const message = JSON.parse(line);
                    handleRpcRequest(message).then(response => {
                        if (response) writeRpc(response);
                    });
                } catch (err) {
                    rpcError(null, -32700, err && err.message ? err.message : String(err));
                }
            }
            index = stdinBuffer.indexOf('\n');
        }
    });

    process.stdin.on('end', () => {
        if (bridgeServer) bridgeServer.close();
    });
};

if (require.main === module) {
    startBridgeServer();
    startStdioServer();
}

module.exports = {
    startBridgeServer,
    getBridgeStatus,
    TOOL_DEFINITIONS
};
