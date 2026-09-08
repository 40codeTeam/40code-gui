#!/usr/bin/env node
'use strict';

const http = require('node:http');
const {randomUUID} = require('node:crypto');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const TOOL_CATALOG = require('./mcp-tools.json');

const normalizeHttpPath = value => {
    let path = String(value || '/').trim();
    if (!path.startsWith('/')) path = `/${path}`;
    return path.replace(/\/+$/, '') || '/';
};

const SERVER_NAME = '40code-json-script-converter';
const SERVER_VERSION = '0.5.0';
const PROTOCOL_VERSION = TOOL_CATALOG.protocolVersions[0];
const SUPPORTED_PROTOCOL_VERSIONS = new Set(TOOL_CATALOG.protocolVersions);
const requestedHost = process.env.JSC_MCP_HOST || '127.0.0.1';
const HOST = ['127.0.0.1', 'localhost', '::1'].includes(requestedHost.toLowerCase()) ? requestedHost : '127.0.0.1';
const DEFAULT_ALLOWED_ORIGINS = ['https://40code.com', 'https://www.40code.com'];
const normalizeConfiguredOrigin = value => {
    try {
        const parsed = new URL(String(value || '').trim());
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
            parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
        return parsed.origin;
    } catch {
        return null;
    }
};
const ALLOWED_PAGE_ORIGINS = new Set([
    ...DEFAULT_ALLOWED_ORIGINS,
    ...String(process.env.JSC_MCP_ALLOWED_ORIGINS || '').split(',')
].map(normalizeConfiguredOrigin).filter(Boolean));
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
    'Start with get_project_overview, then use get_pseudocode to inspect only the code needed.',
    'Call get_pseudocode with no arguments for the current target; use scope all_sprites, all_targets, or targets explicitly for broader reads and follow cursor pagination.',
    'Prefer mode patch for small changes. A full replacement must preserve every declaration header from the fetched pseudocode, including readable as aliases used for conflicting names.',
    'Use create_svg_costume and replace_svg_costume for vector UI elements.',
    'Use create_bitmap_costume and replace_bitmap_costume when complete bitmap image data is available.'
].join(' ');

const PSEUDOCODE_SYNTAX_GUIDE = readFileSync(
    path.join(__dirname, 'pseudocode-syntax.md'),
    'utf8'
);

const bridgeClients = new Map();
const bridgeCalls = new Map();
const pollWaiters = new Map();
const mcpSessions = new Map();
const requestCalls = new Map();
const cancelledRequests = new Map();

const log = (...args) => {
    console.error(`[${SERVER_NAME}]`, ...args);
};

const TOOL_DEFINITIONS = Object.freeze(TOOL_CATALOG.tools);
const TOOL_DEFINITION_BY_NAME = new Map(TOOL_DEFINITIONS.map(definition => [definition.name, definition]));

const RESOURCE_DEFINITIONS = [{
    uri: PSEUDOCODE_SYNTAX_URI,
    name: '40code pseudocode syntax',
    description: 'Syntax guide and examples for edit_pseudocode.',
    mimeType: 'text/markdown'
}];

const negotiateProtocolVersion = requested => SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION;

const getAllowedOrigin = origin => {
    if (!origin) return null;
    try {
        const parsed = new URL(origin);
        const hostname = parsed.hostname.toLowerCase();
        if (!['http:', 'https:'].includes(parsed.protocol)) return false;
        if (origin !== parsed.origin) return false;
        const isLoopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
        return isLoopback || ALLOWED_PAGE_ORIGINS.has(parsed.origin) ? origin : false;
    } catch {
        return false;
    }
};

const corsHeaders = origin => ({
    ...(origin ? {'Access-Control-Allow-Origin': origin, 'Vary': 'Origin'} : {}),
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version',
    'Cache-Control': 'no-store'
});

const sendJson = (res, status, payload, origin = null, extraHeaders = {}) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        ...corsHeaders(origin),
        ...extraHeaders
    });
    res.end(body);
};

const sendNoBody = (res, status, origin = null, extraHeaders = {}) => {
    res.writeHead(status, {
        ...corsHeaders(origin),
        ...extraHeaders
    });
    res.end();
};

const readBody = req => new Promise((resolve, reject) => {
    let body = '';
    let rejected = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
        if (rejected) return;
        body += chunk;
        if (Buffer.byteLength(body, 'utf8') > BODY_LIMIT) {
            rejected = true;
            reject(new Error('Request body too large'));
            req.destroy();
        }
    });
    req.on('end', () => {
        if (!rejected) resolve(body);
    });
    req.on('error', reject);
});

const jsonEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const validateSchema = (value, schema, path = '$') => {
    const errors = [];
    const check = (candidate, rule, currentPath) => {
        if (!rule || typeof rule !== 'object') return [];
        const local = [];
        const probe = subrule => check(candidate, subrule, currentPath).length === 0;
        if (rule.allOf) {
            rule.allOf.forEach(subrule => local.push(...check(candidate, subrule, currentPath)));
        }
        if (rule.anyOf && !rule.anyOf.some(probe)) local.push(`${currentPath} must match at least one allowed shape`);
        if (rule.oneOf && rule.oneOf.filter(probe).length !== 1) local.push(`${currentPath} must match exactly one allowed shape`);
        if (rule.not && probe(rule.not)) local.push(`${currentPath} uses a forbidden field combination`);
        if (rule.const !== undefined && !jsonEqual(candidate, rule.const)) local.push(`${currentPath} must equal ${JSON.stringify(rule.const)}`);
        if (rule.enum && !rule.enum.some(item => jsonEqual(candidate, item))) local.push(`${currentPath} must be one of ${rule.enum.join(', ')}`);

        const actualType = Array.isArray(candidate) ? 'array' : (candidate === null ? 'null' : typeof candidate);
        const typeMatches = !rule.type ||
            (rule.type === 'object' && actualType === 'object') ||
            (rule.type === 'array' && actualType === 'array') ||
            (rule.type === 'string' && actualType === 'string') ||
            (rule.type === 'boolean' && actualType === 'boolean') ||
            (rule.type === 'number' && actualType === 'number' && Number.isFinite(candidate)) ||
            (rule.type === 'integer' && actualType === 'number' && Number.isInteger(candidate));
        if (!typeMatches) {
            local.push(`${currentPath} must be ${rule.type}`);
            return local;
        }
        if (actualType === 'object') {
            const properties = rule.properties || {};
            for (const required of rule.required || []) {
                if (!Object.prototype.hasOwnProperty.call(candidate, required)) local.push(`${currentPath}.${required} is required`);
            }
            for (const [dependency, requiredFields] of Object.entries(rule.dependencies || {})) {
                if (!Object.prototype.hasOwnProperty.call(candidate, dependency) || !Array.isArray(requiredFields)) continue;
                requiredFields.forEach(required => {
                    if (!Object.prototype.hasOwnProperty.call(candidate, required)) local.push(`${currentPath}.${required} is required with ${dependency}`);
                });
            }
            for (const [key, child] of Object.entries(candidate)) {
                if (properties[key]) local.push(...check(child, properties[key], `${currentPath}.${key}`));
                else if (rule.additionalProperties === false) local.push(`${currentPath}.${key} is not allowed`);
            }
        }
        if (actualType === 'array') {
            if (rule.minItems !== undefined && candidate.length < rule.minItems) local.push(`${currentPath} needs at least ${rule.minItems} items`);
            if (rule.maxItems !== undefined && candidate.length > rule.maxItems) local.push(`${currentPath} allows at most ${rule.maxItems} items`);
            if (rule.uniqueItems && new Set(candidate.map(item => JSON.stringify(item))).size !== candidate.length) local.push(`${currentPath} items must be unique`);
            if (rule.items) candidate.forEach((item, index) => local.push(...check(item, rule.items, `${currentPath}[${index}]`)));
        }
        if (actualType === 'string') {
            const characterLength = Array.from(candidate).length;
            if (rule.minLength !== undefined && characterLength < rule.minLength) local.push(`${currentPath} is too short`);
            if (rule.maxLength !== undefined && characterLength > rule.maxLength) local.push(`${currentPath} is too long`);
            if (rule.pattern) {
                try {
                    if (!new RegExp(rule.pattern).test(candidate)) local.push(`${currentPath} has an invalid format`);
                } catch {
                    local.push(`${currentPath} has an invalid schema pattern`);
                }
            }
        }
        if (actualType === 'number') {
            if (rule.minimum !== undefined && candidate < rule.minimum) local.push(`${currentPath} must be at least ${rule.minimum}`);
            if (rule.maximum !== undefined && candidate > rule.maximum) local.push(`${currentPath} must be at most ${rule.maximum}`);
        }
        return local;
    };
    errors.push(...check(value, schema, path));
    return errors;
};

const requestKey = (sessionId, requestId) => `${sessionId}\u0000${JSON.stringify(requestId)}`;
const getSession = sessionId => {
    if (!mcpSessions.has(sessionId)) {
        mcpSessions.set(sessionId, {sessionId, protocolVersion: PROTOCOL_VERSION, selectedClientId: null, lastSeen: Date.now()});
    }
    const session = mcpSessions.get(sessionId);
    session.lastSeen = Date.now();
    return session;
};

const removeWaiter = waiter => {
    const waiters = pollWaiters.get(waiter.clientId);
    if (!waiters) return;
    waiters.delete(waiter);
    if (!waiters.size) pollWaiters.delete(waiter.clientId);
};

const completePoll = (waiter, status, payload) => {
    if (waiter.done) return;
    waiter.done = true;
    clearTimeout(waiter.timer);
    removeWaiter(waiter);
    sendJson(waiter.res, status, payload, waiter.origin);
};

const resetSelectionsForClient = clientId => {
    for (const session of mcpSessions.values()) {
        if (session.selectedClientId === clientId) session.selectedClientId = null;
    }
};

const finishBridgeCall = (record, outcome) => {
    if (!record || !bridgeCalls.has(record.id)) return false;
    bridgeCalls.delete(record.id);
    clearTimeout(record.timer);
    if (record.requestKey && requestCalls.get(record.requestKey) === record.id) requestCalls.delete(record.requestKey);
    const client = bridgeClients.get(record.clientId);
    if (client) client.queue = client.queue.filter(id => id !== record.id);
    if (outcome.error) record.reject(outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error)));
    else record.resolve(outcome.value);
    return true;
};

const cancelBridgeCall = (callId, reason) => {
    const record = bridgeCalls.get(callId);
    if (!record) return false;
    const client = bridgeClients.get(record.clientId);
    if (client && record.state !== 'queued') client.cancelledCallIds.push(record.id);
    return finishBridgeCall(record, {error: new Error(reason)});
};

const cancelCallsForClient = (clientId, reason) => {
    for (const record of Array.from(bridgeCalls.values())) {
        if (record.clientId === clientId) cancelBridgeCall(record.id, reason);
    }
};

const pruneExpiredClients = () => {
    const now = Date.now();
    for (const [clientId, client] of Array.from(bridgeClients.entries())) {
        if (now - client.lastSeen <= BRIDGE_CLIENT_TTL_MS) continue;
        cancelCallsForClient(clientId, 'The selected 40code page disconnected before completing the call.');
        const waiters = pollWaiters.get(clientId);
        if (waiters) Array.from(waiters).forEach(waiter => completePoll(waiter, 410, {ok: false, error: 'Page registration expired'}));
        bridgeClients.delete(clientId);
        resetSelectionsForClient(clientId);
    }
};

const getActiveClients = () => {
    pruneExpiredClients();
    return Array.from(bridgeClients.values()).sort((a, b) => b.lastSeen - a.lastSeen);
};

const pageSummary = (client, session) => ({
    clientId: client.clientId,
    title: client.title,
    pageUrl: client.pageUrl,
    selected: !!(session && session.selectedClientId === client.clientId),
    lastSeenAgoMs: Math.max(0, Date.now() - client.lastSeen),
    queuedCalls: client.queue.length
});

const listPages = sessionId => {
    const session = getSession(sessionId);
    const active = getActiveClients();
    if (!active.some(client => client.clientId === session.selectedClientId)) {
        session.selectedClientId = null;
    }
    if (active.length === 1) {
        session.selectedClientId = active[0].clientId;
    }
    const pages = active.map(client => pageSummary(client, session));
    return {ok: true, selectedClientId: session.selectedClientId, pageCount: pages.length, pages};
};

const selectPage = (sessionId, clientId) => {
    const session = getSession(sessionId);
    const client = getActiveClients().find(item => item.clientId === clientId);
    if (!client) throw new Error(`No active 40code page has clientId ${clientId}. Call jsc_list_pages and retry.`);
    session.selectedClientId = client.clientId;
    return {ok: true, selectedPage: pageSummary(client, session)};
};

const resolvePageForSession = sessionId => {
    const session = getSession(sessionId);
    const active = getActiveClients();
    const selected = active.find(client => client.clientId === session.selectedClientId);
    if (selected) return selected;
    session.selectedClientId = null;
    if (active.length === 1) {
        session.selectedClientId = active[0].clientId;
        return active[0];
    }
    if (!active.length) throw new Error('No 40code page is connected. Open the editor with json-script-converter enabled, then retry.');
    throw new Error('Multiple 40code pages are connected. Call jsc_list_pages, then jsc_select_page before using page tools.');
};

const takePageCalls = client => {
    const calls = [];
    while (client.queue.length && calls.length < 1) {
        const callId = client.queue.shift();
        const record = bridgeCalls.get(callId);
        if (!record || record.clientId !== client.clientId || record.registrationToken !== client.registrationToken) continue;
        if (Date.now() >= record.expiresAt) {
            cancelBridgeCall(record.id, `Timed out waiting for the 40code page after ${CALL_TIMEOUT_MS}ms`);
            continue;
        }
        record.state = 'leased';
        calls.push({
            id: record.id,
            name: record.name,
            arguments: record.arguments,
            leaseToken: record.leaseToken,
            expiresAt: record.expiresAt
        });
    }
    return calls;
};

const pollPayload = client => ({
    ok: true,
    registrationToken: client.registrationToken,
    calls: takePageCalls(client),
    cancelledCallIds: client.cancelledCallIds.splice(0, client.cancelledCallIds.length)
});

const flushPollWaitersForClient = clientId => {
    const client = bridgeClients.get(clientId);
    const waiters = pollWaiters.get(clientId);
    if (!client || !waiters || (!client.queue.length && !client.cancelledCallIds.length)) return;
    const waiter = waiters.values().next().value;
    if (waiter) completePoll(waiter, 200, pollPayload(client));
};

const enqueueBridgeCall = (name, args, sessionId, requestId) => new Promise((resolve, reject) => {
    const id = randomUUID();
    const key = requestKey(sessionId, requestId);
    if (cancelledRequests.delete(key)) {
        reject(new Error('MCP client cancelled the request before it was queued.'));
        return;
    }
    const client = resolvePageForSession(sessionId);
    const record = {
        id,
        name,
        arguments: args,
        clientId: client.clientId,
        registrationToken: client.registrationToken,
        leaseToken: randomUUID(),
        expiresAt: Date.now() + CALL_TIMEOUT_MS,
        state: 'queued',
        requestKey: key,
        resolve,
        reject,
        timer: null
    };
    record.timer = setTimeout(() => {
        cancelBridgeCall(id, `Timed out waiting for the 40code page after ${CALL_TIMEOUT_MS}ms`);
    }, CALL_TIMEOUT_MS);
    bridgeCalls.set(id, record);
    requestCalls.set(key, id);
    client.queue.push(id);
    flushPollWaitersForClient(client.clientId);
});

const cancelBridgeRequest = (sessionId, requestId, reason) => {
    const key = requestKey(sessionId, requestId);
    const callId = requestCalls.get(key);
    if (!callId) {
        cancelledRequests.set(key, Date.now());
        while (cancelledRequests.size > 1024) cancelledRequests.delete(cancelledRequests.keys().next().value);
        return false;
    }
    return cancelBridgeCall(callId, reason || 'MCP client cancelled the request.');
};

const getBridgeStatus = () => {
    const clients = getActiveClients();
    const activeClient = clients[0] || null;
    let queued = 0;
    let leased = 0;
    for (const record of bridgeCalls.values()) {
        if (record.state === 'leased') leased++;
        else queued++;
    }
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
            clients: clients.map(client => pageSummary(client, null)),
            pendingCalls: queued,
            waitingResults: leased
        }
    };
};

const handlePoll = (req, res, url, origin) => {
    const clientId = url.searchParams.get('clientId') || '';
    const suppliedToken = url.searchParams.get('registrationToken') || '';
    if (!clientId || clientId.length > 256) {
        sendJson(res, 400, {ok: false, error: 'clientId is required and must be at most 256 characters'}, origin);
        return;
    }
    const title = (url.searchParams.get('title') || '').slice(0, 1000);
    const pageUrl = (url.searchParams.get('pageUrl') || '').slice(0, 8192);
    let client = bridgeClients.get(clientId);
    if (!suppliedToken) {
        if (client) {
            cancelCallsForClient(clientId, 'The 40code page reloaded before completing the call.');
            const waiters = pollWaiters.get(clientId);
            if (waiters) Array.from(waiters).forEach(waiter => completePoll(waiter, 409, {ok: false, error: 'Page re-registered'}));
            resetSelectionsForClient(clientId);
        }
        client = {
            clientId,
            registrationToken: randomUUID(),
            title,
            pageUrl,
            lastSeen: Date.now(),
            queue: [],
            cancelledCallIds: []
        };
        bridgeClients.set(clientId, client);
        sendJson(res, 200, {ok: true, registrationToken: client.registrationToken, calls: [], cancelledCallIds: []}, origin);
        return;
    }
    if (!client || suppliedToken !== client.registrationToken) {
        sendJson(res, 403, {ok: false, error: 'Invalid page registration token'}, origin);
        return;
    }
    client.title = title || client.title;
    client.pageUrl = pageUrl || client.pageUrl;
    client.lastSeen = Date.now();
    if (client.queue.length || client.cancelledCallIds.length) {
        sendJson(res, 200, pollPayload(client), origin);
        return;
    }
    const waiter = {clientId, res, origin, timer: null, done: false};
    if (!pollWaiters.has(clientId)) pollWaiters.set(clientId, new Set());
    pollWaiters.get(clientId).add(waiter);
    waiter.timer = setTimeout(() => completePoll(waiter, 200, pollPayload(client)), POLL_TIMEOUT_MS);
    req.on('close', () => {
        if (waiter.done) return;
        waiter.done = true;
        clearTimeout(waiter.timer);
        removeWaiter(waiter);
    });
};

const handleResult = async (req, res, origin) => {
    let payload;
    try {
        const body = await readBody(req);
        payload = body ? JSON.parse(body) : {};
    } catch (error) {
        sendJson(res, 400, {ok: false, error: error.message || String(error)}, origin);
        return;
    }
    const client = bridgeClients.get(payload.clientId);
    if (!client || !payload.registrationToken || payload.registrationToken !== client.registrationToken) {
        sendJson(res, 403, {ok: false, error: 'Invalid page result claimant'}, origin);
        return;
    }
    client.lastSeen = Date.now();
    client.title = payload.title || client.title;
    client.pageUrl = payload.pageUrl || client.pageUrl;
    const record = bridgeCalls.get(payload.id);
    if (!record) {
        sendJson(res, 410, {ok: false, error: 'Unknown, cancelled, or expired call id'}, origin);
        return;
    }
    if (record.clientId !== payload.clientId || record.registrationToken !== payload.registrationToken ||
        record.leaseToken !== payload.leaseToken || record.state !== 'claimed') {
        sendJson(res, 403, {ok: false, error: 'Result does not own this call lease'}, origin);
        return;
    }
    if (Date.now() >= record.expiresAt) {
        cancelBridgeCall(record.id, `Timed out waiting for the 40code page after ${CALL_TIMEOUT_MS}ms`);
        sendJson(res, 410, {ok: false, error: 'Call lease expired'}, origin);
        return;
    }
    if (payload.error !== undefined && payload.error !== null) finishBridgeCall(record, {error: new Error(String(payload.error))});
    else finishBridgeCall(record, {value: payload.result === undefined ? null : payload.result});
    sendJson(res, 200, {ok: true}, origin);
};

const handleClaim = async (req, res, origin) => {
    let payload;
    try {
        const body = await readBody(req);
        payload = body ? JSON.parse(body) : {};
    } catch (error) {
        sendJson(res, 400, {ok: false, error: error.message || String(error)}, origin);
        return;
    }
    const client = bridgeClients.get(payload.clientId);
    if (!client || !payload.registrationToken || payload.registrationToken !== client.registrationToken) {
        sendJson(res, 403, {ok: false, error: 'Invalid page claim claimant'}, origin);
        return;
    }
    const record = bridgeCalls.get(payload.id);
    if (!record) {
        sendJson(res, 410, {ok: false, error: 'Unknown, cancelled, or expired call lease'}, origin);
        return;
    }
    if (record.clientId !== payload.clientId || record.registrationToken !== payload.registrationToken ||
        record.leaseToken !== payload.leaseToken || record.state !== 'leased') {
        sendJson(res, 403, {ok: false, error: 'Claim does not own this call lease'}, origin);
        return;
    }
    if (Date.now() >= record.expiresAt) {
        cancelBridgeCall(record.id, `Timed out waiting for the 40code page after ${CALL_TIMEOUT_MS}ms`);
        sendJson(res, 410, {ok: false, error: 'Call lease expired'}, origin);
        return;
    }
    client.lastSeen = Date.now();
    record.state = 'claimed';
    sendJson(res, 200, {ok: true, expiresAt: record.expiresAt}, origin);
};

const validateHttpProtocol = (req, session) => {
    const headerVersion = req.headers['mcp-protocol-version'];
    if (!headerVersion) return session ? null : 'MCP-Protocol-Version is required';
    if (!SUPPORTED_PROTOCOL_VERSIONS.has(headerVersion)) return `Unsupported MCP-Protocol-Version: ${headerVersion}`;
    if (session && headerVersion !== session.protocolVersion) return `MCP-Protocol-Version does not match initialized session (${session.protocolVersion})`;
    return null;
};

const handleMcpHttp = async (req, res, origin) => {
    if (req.method === 'GET') {
        sendNoBody(res, 405, origin, {'Allow': 'POST, DELETE, OPTIONS'});
        return;
    }
    if (req.method === 'DELETE') {
        const sessionId = req.headers['mcp-session-id'];
        const session = sessionId && mcpSessions.get(sessionId);
        if (!session) {
            sendJson(res, 404, makeRpcError(null, -32001, 'Unknown MCP session'), origin);
            return;
        }
        for (const [key, callId] of Array.from(requestCalls.entries())) {
            if (key.startsWith(`${sessionId}\u0000`)) cancelBridgeCall(callId, 'MCP session closed.');
        }
        for (const key of Array.from(cancelledRequests.keys())) {
            if (key.startsWith(`${sessionId}\u0000`)) cancelledRequests.delete(key);
        }
        mcpSessions.delete(sessionId);
        sendNoBody(res, 204, origin);
        return;
    }
    if (req.method !== 'POST') {
        sendNoBody(res, 405, origin, {'Allow': 'POST, DELETE, OPTIONS'});
        return;
    }

    let message;
    try {
        const body = await readBody(req);
        message = body ? JSON.parse(body) : null;
    } catch (err) {
        sendJson(res, 400, makeRpcError(null, -32700, err && err.message ? err.message : String(err)), origin);
        return;
    }
    if (!message || Array.isArray(message) || typeof message !== 'object') {
        sendJson(res, 400, makeRpcError(null, -32600, 'Expected a single JSON-RPC message object'), origin);
        return;
    }
    if (message.jsonrpc !== '2.0') {
        sendJson(res, 400, makeRpcError(message.id === undefined ? null : message.id, -32600, 'Expected JSON-RPC 2.0'), origin);
        return;
    }
    if (message.method === undefined && ('result' in message || 'error' in message)) {
        sendNoBody(res, 202, origin);
        return;
    }

    const initializing = message.method === 'initialize';
    let sessionId;
    let session;
    if (initializing) {
        sessionId = randomUUID();
        session = getSession(sessionId);
    } else {
        sessionId = req.headers['mcp-session-id'];
        session = sessionId && mcpSessions.get(sessionId);
        if (!session) {
            sendJson(res, 400, makeRpcError(message.id === undefined ? null : message.id, -32001, 'Missing or unknown Mcp-Session-Id'), origin);
            return;
        }
        session.lastSeen = Date.now();
        const protocolError = validateHttpProtocol(req, session);
        if (protocolError) {
            sendJson(res, 400, makeRpcError(message.id === undefined ? null : message.id, -32600, protocolError), origin);
            return;
        }
    }

    const response = await handleRpcRequest(message, sessionId);
    const headers = {'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': session.protocolVersion};
    if (message.id === undefined && message.method) {
        sendNoBody(res, 202, origin, headers);
        return;
    }
    if (!response) {
        sendNoBody(res, 202, origin, headers);
        return;
    }
    sendJson(res, 200, response, origin, headers);
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
        const allowedOrigin = getAllowedOrigin(req.headers.origin);
        if (allowedOrigin === false) {
            sendJson(res, 403, {ok: false, error: 'Forbidden origin'});
            return;
        }
        if (req.method === 'OPTIONS') {
            sendNoBody(res, 204, allowedOrigin);
            return;
        }
        const url = new URL(req.url, `http://${HOST}:${PORT}`);
        if (url.pathname === MCP_HTTP_PATH) {
            await handleMcpHttp(req, res, allowedOrigin);
            return;
        }
        const suffix = getBridgeSuffix(url.pathname);
        if (!suffix) {
            sendJson(res, 404, {ok: false, error: 'Not found'}, allowedOrigin);
            return;
        }
        if (req.method === 'POST' && suffix === '/') {
            await handleMcpHttp(req, res, allowedOrigin);
            return;
        }
        if (req.method === 'GET' && suffix === '/poll') {
            handlePoll(req, res, url, allowedOrigin);
            return;
        }
        if (req.method === 'GET' && (suffix === '/' || suffix === '/status')) {
            sendJson(res, 200, getBridgeStatus(), allowedOrigin);
            return;
        }
        if (req.method === 'POST' && suffix === '/result') {
            await handleResult(req, res, allowedOrigin);
            return;
        }
        if (req.method === 'POST' && suffix === '/claim') {
            await handleClaim(req, res, allowedOrigin);
            return;
        }
        sendJson(res, 404, {ok: false, error: 'Not found'}, allowedOrigin);
    } catch (err) {
        const origin = getAllowedOrigin(req.headers.origin);
        sendJson(res, 500, {ok: false, error: err && err.message ? err.message : String(err)}, origin === false ? null : origin);
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

const parseImageAttachment = attachment => {
    if (!attachment || typeof attachment !== 'object') return null;
    const dataUrl = typeof attachment.dataUrl === 'string' ? attachment.dataUrl : '';
    if (dataUrl.startsWith('data:')) {
        const comma = dataUrl.indexOf(',');
        if (comma < 0) return null;
        const metadata = dataUrl.slice(5, comma);
        const segments = metadata.split(';');
        const mimeType = (attachment.mimeType || segments[0] || '').toLowerCase();
        if (!/^image\/[a-z0-9.+-]+$/.test(mimeType)) return null;
        const payload = dataUrl.slice(comma + 1);
        try {
            const data = segments.some(segment => segment.toLowerCase() === 'base64') ?
                payload.replace(/\s+/g, '') : Buffer.from(decodeURIComponent(payload), 'utf8').toString('base64');
            if (!data) return null;
            return {type: 'image', data, mimeType};
        } catch {
            return null;
        }
    }
    if (typeof attachment.data === 'string' && /^image\/[a-z0-9.+-]+$/i.test(attachment.mimeType || '')) {
        return {type: 'image', data: attachment.data.replace(/\s+/g, ''), mimeType: attachment.mimeType.toLowerCase()};
    }
    return null;
};

const normalizeStructuredResult = (value, images) => {
    if (Array.isArray(value)) return value.map(item => normalizeStructuredResult(item, images));
    if (!value || typeof value !== 'object') return value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
        if (key === 'imageAttachment') {
            const image = parseImageAttachment(child);
            if (image) images.push(image);
            output.imageAttachment = child && typeof child === 'object' ? {
                ...(child.label === undefined ? {} : {label: child.label}),
                ...(child.mimeType === undefined ? {} : {mimeType: child.mimeType}),
                ...(child.width === undefined ? {} : {width: child.width}),
                ...(child.height === undefined ? {} : {height: child.height})
            } : null;
        } else {
            output[key] = normalizeStructuredResult(child, images);
        }
    }
    return output;
};

const shortText = (value, limit = 1000) => {
    const text = String(value === undefined || value === null ? '' : value);
    return text.length <= limit ? text : `${text.slice(0, limit)}…`;
};

const summarizeMcpResult = structured => {
    if (structured.ok === false || structured.error) return `Error: ${shortText(structured.error || 'Tool call failed.', 2000)}`;
    if (typeof structured.summary === 'string' && structured.summary.trim()) return shortText(structured.summary.trim());
    const parts = [];
    if (structured.type) parts.push(String(structured.type));
    if (structured.scope) parts.push(`scope=${structured.scope}`);
    for (const key of ['pageCount', 'targetCount', 'totalTargetCount', 'totalMatches', 'returnedMatches', 'returnedChars', 'totalChars']) {
        if (Number.isFinite(structured[key])) parts.push(`${key}=${structured[key]}`);
    }
    if (typeof structured.pseudocode === 'string') parts.push(`pseudocode=${structured.pseudocode.length} chars in structuredContent`);
    if (structured.nextCursor) parts.push('more results available via nextCursor');
    if (structured.imageAttachment) parts.push(`image=${shortText(structured.imageAttachment.label || structured.imageAttachment.mimeType || 'attached', 200)}`);
    return parts.length ? `Tool result: ${parts.join('; ')}` : 'Tool call completed; full result is in structuredContent.';
};

const toMcpContent = result => {
    const images = [];
    const clean = normalizeStructuredResult(result === undefined ? null : result, images);
    const structuredContent = clean && typeof clean === 'object' && !Array.isArray(clean) ? clean : {result: clean};
    return {
        content: [
            {type: 'text', text: summarizeMcpResult(structuredContent)},
            ...images
        ],
        structuredContent,
        isError: !!(structuredContent && structuredContent.ok === false)
    };
};

const HIDDEN_CALL_ACTION_SCHEMA = {
    type: 'object',
    properties: {
        action: {oneOf: [{type: 'object'}, {type: 'string', minLength: 1, maxLength: 4000000}]}
    },
    required: ['action'],
    additionalProperties: false
};

const handleRpcRequest = async (message, sessionId = 'stdio') => {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
        const invalidId = message && typeof message === 'object' && !Array.isArray(message) && message.id !== undefined ? message.id : null;
        return makeRpcError(invalidId, -32600, 'Expected a JSON-RPC 2.0 message object');
    }
    const {id, method, params} = message;
    if (!method) {
        if (id !== undefined) return makeRpcError(id, -32600, 'Missing method');
        return null;
    }
    const session = getSession(sessionId);
    if (method === 'notifications/cancelled' || method === '$/cancelRequest') {
        const requestId = params && (params.requestId === undefined ? params.id : params.requestId);
        if (requestId !== undefined) cancelBridgeRequest(sessionId, requestId, params && params.reason);
        return null;
    }
    if (method.startsWith('notifications/')) return null;
    try {
        if (method === 'initialize') {
            session.protocolVersion = negotiateProtocolVersion(params && params.protocolVersion);
            return makeRpcResult(id, {
                protocolVersion: session.protocolVersion,
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
            if (id === undefined) return makeRpcError(null, -32600, 'tools/call must be a JSON-RPC request with an id');
            const name = params && params.name;
            const args = params && Object.prototype.hasOwnProperty.call(params, 'arguments') ? params.arguments : {};
            if (!name || typeof name !== 'string') {
                return makeRpcError(id, -32602, 'tools/call missing params.name');
            }
            const definition = TOOL_DEFINITION_BY_NAME.get(name);
            if (!definition && name !== 'jsc_call_action') {
                return makeRpcError(id, -32602, `Unknown tool: ${name}`);
            }
            const validationErrors = validateSchema(args, definition ? definition.inputSchema : HIDDEN_CALL_ACTION_SCHEMA);
            if (validationErrors.length) {
                return makeRpcError(id, -32602, `Invalid arguments for ${name}`, {errors: validationErrors});
            }
            if (name === 'jsc_bridge_status') {
                return makeRpcResult(id, toMcpContent(getBridgeStatus()));
            }
            if (name === 'jsc_list_pages') {
                return makeRpcResult(id, toMcpContent(listPages(sessionId)));
            }
            if (name === 'jsc_select_page') {
                return makeRpcResult(id, toMcpContent(selectPage(sessionId, args.clientId)));
            }
            if (name === 'jsc_get_pseudocode_syntax') {
                return makeRpcResult(id, {
                    content: [{
                        type: 'text',
                        text: PSEUDOCODE_SYNTAX_GUIDE
                    }],
                    structuredContent: {ok: true, resourceUri: PSEUDOCODE_SYNTAX_URI},
                    isError: false
                });
            }
            const result = await enqueueBridgeCall(name, args, sessionId, id);
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
                    handleRpcRequest(message, 'stdio').then(response => {
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
    TOOL_DEFINITIONS,
    PSEUDOCODE_SYNTAX_GUIDE,
    SUPPORTED_PROTOCOL_VERSIONS,
    negotiateProtocolVersion,
    validateSchema,
    toMcpContent,
    handleRpcRequest,
    _test: {
        bridgeClients,
        bridgeCalls,
        mcpSessions,
        requestCalls,
        cancelledRequests,
        cancelBridgeRequest,
        takePageCalls,
        selectPage,
        getAllowedOrigin
    }
};
