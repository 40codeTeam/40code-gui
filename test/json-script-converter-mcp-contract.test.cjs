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
const SYNTAX_GUIDE_PATH = path.join(ROOT, 'src/addons/addons/json-script-converter/pseudocode-syntax.md');
const RUST_SOURCE_PATH = path.join(ROOT, 'tools/40code-mcp-bridge-rs/src/main.rs');
const CATALOG = require('../src/addons/addons/json-script-converter/mcp-tools.json');
const bridgeModule = require('../src/addons/addons/json-script-converter/mcp-server.cjs');

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
                try { json = JSON.parse(text); } catch { /* asserted by caller when relevant */ }
            }
            resolve({status: res.statusCode, headers: res.headers, text, json});
        });
    });
    req.once('error', reject);
    if (body !== null) req.write(body);
    req.end();
});

const waitForServer = async port => {
    let lastError;
    for (let attempt = 0; attempt < 60; attempt++) {
        try {
            const response = await request(port, 'GET', '/status');
            if (response.status === 200) return;
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw lastError || new Error('bridge did not start');
};

const rpc = (port, message, session) => request(port, 'POST', '/mcp', {
    headers: session ? {
        'Mcp-Session-Id': session.id,
        'MCP-Protocol-Version': session.version
    } : {},
    body: message
});

test('Node and native bridge share one strict canonical tool catalog', () => {
    assert.deepEqual(bridgeModule.TOOL_DEFINITIONS, CATALOG.tools);
    assert.equal(CATALOG.protocolVersions[0], '2025-11-25');
    assert.equal(CATALOG.tools.some(tool => tool.name === 'jsc_call_action'), false);
    assert.equal(CATALOG.tools.some(tool => tool.name === 'get_project_overview'), true);
    assert.equal(CATALOG.tools.some(tool => tool.name === 'get_runtime_state'), true);
    for (const tool of CATALOG.tools) {
        assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
        assert.deepEqual(
            Object.keys(tool.annotations).sort(),
            ['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint'],
            `${tool.name} annotations`
        );
        for (const value of Object.values(tool.annotations)) assert.equal(typeof value, 'boolean', tool.name);
    }
});

test('Node and native bridge return one shared pseudocode syntax guide', async () => {
    const expected = fs.readFileSync(SYNTAX_GUIDE_PATH, 'utf8');
    assert.equal(bridgeModule.PSEUDOCODE_SYNTAX_GUIDE, expected);

    const resource = await bridgeModule.handleRpcRequest({
        jsonrpc: '2.0', id: 1, method: 'resources/read', params: {uri: 'jsc://pseudocode/syntax'}
    }, 'syntax-resource-test');
    const tool = await bridgeModule.handleRpcRequest({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: {name: 'jsc_get_pseudocode_syntax', arguments: {}}
    }, 'syntax-tool-test');
    assert.equal(resource.result.contents[0].text, expected);
    assert.equal(tool.result.content[0].text, expected);

    const rustSource = fs.readFileSync(RUST_SOURCE_PATH, 'utf8');
    const rustInclude = rustSource.match(
        /const PSEUDOCODE_SYNTAX_GUIDE: &str =\s*include_str!\("([^"]+)"\);/
    );
    assert.ok(rustInclude, 'native bridge must embed the shared guide at compile time');
    assert.equal(path.resolve(path.dirname(RUST_SOURCE_PATH), rustInclude[1]), SYNTAX_GUIDE_PATH);
});

test('strict schemas cover current/all pagination, search context, runtime data and mutually exclusive edits', () => {
    const schema = name => CATALOG.tools.find(tool => tool.name === name).inputSchema;
    assert.deepEqual(bridgeModule.validateSchema({}, schema('get_pseudocode')), []);
    assert.deepEqual(bridgeModule.validateSchema({scope: 'targets', targetRefs: ['a'], maxChars: 1}, schema('get_pseudocode')), []);
    assert.notDeepEqual(bridgeModule.validateSchema({startLine: 2}, schema('get_pseudocode')), []);
    assert.notDeepEqual(bridgeModule.validateSchema({scope: 'all_targets', targetRefs: ['a']}, schema('get_pseudocode')), []);
    assert.equal(schema('search_text').properties.scope.default, 'all_targets');
    assert.equal(schema('search_text').properties.maxResults.default, 50);
    assert.deepEqual(bridgeModule.validateSchema({query: 'score'}, schema('search_text')), []);
    assert.deepEqual(bridgeModule.validateSchema({query: 'score', contextLines: 10, cursor: 'next'}, schema('search_text')), []);
    assert.notDeepEqual(bridgeModule.validateSchema({query: 'score', contextLines: 11}, schema('search_text')), []);
    assert.deepEqual(bridgeModule.validateSchema({targetRef: 'a', includeDataValues: true, maxDataItems: 100, maxListItems: 200}, schema('get_runtime_state')), []);
    assert.deepEqual(bridgeModule.validateSchema({includeDataValues: false, maxDataItems: 0, maxListItems: 0}, schema('get_runtime_state')), []);
    assert.notDeepEqual(bridgeModule.validateSchema({maxDataItems: -1}, schema('get_runtime_state')), []);
    assert.notDeepEqual(bridgeModule.validateSchema({targetRef: 'a', targetRefs: ['b']}, schema('get_runtime_state')), []);
    assert.notDeepEqual(bridgeModule.validateSchema({targetRef: 'a', mode: 'replace', pseudocode: '', patches: []}, schema('edit_pseudocode')), []);
});

test('read schemas reject ambiguous line ranges and costume selectors', () => {
    const Ajv = require('ajv');
    const ajv = new Ajv({allErrors: true});
    const byName = new Map(CATALOG.tools.map(tool => [tool.name, tool]));
    const validatePseudocode = ajv.compile(byName.get('get_pseudocode').inputSchema);
    assert.equal(validatePseudocode({startLine: 1, endLine: 2, lineRanges: [{startLine: 3, endLine: 4}]}), false);
    assert.equal(validatePseudocode({startLine: 1, endLine: 2}), true);
    assert.equal(validatePseudocode({lineRanges: [{startLine: 3, endLine: 4}]}), true);

    const validateCostumeInfo = ajv.compile(byName.get('get_costume_info').inputSchema);
    assert.equal(validateCostumeInfo({targetRef: 'a', costumeName: 'one', costumeIndex: 0}), false);
    assert.equal(validateCostumeInfo({targetRef: 'a', costumeName: 'one'}), true);
    assert.equal(validateCostumeInfo({targetRef: 'a'}), true);

    assert.notEqual(bridgeModule.validateSchema(
        {startLine: 1, endLine: 2, lineRanges: [{startLine: 3, endLine: 4}]},
        byName.get('get_pseudocode').inputSchema
    ).length, 0);
    assert.equal(bridgeModule.validateSchema(
        {targetRef: 'a', costumeName: 'one'},
        byName.get('get_costume_info').inputSchema
    ).length, 0);
    assert.notEqual(bridgeModule.validateSchema(
        {targetRef: 'a', costumeName: 'one', costumeIndex: 0},
        byName.get('get_costume_info').inputSchema
    ).length, 0);
});

test('initialize negotiates supported versions and never echoes arbitrary input', async () => {
    const supported = await bridgeModule.handleRpcRequest({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18'}}, 'supported-test');
    const unknown = await bridgeModule.handleRpcRequest({jsonrpc: '2.0', id: 2, method: 'initialize', params: {protocolVersion: 'made-up-version'}}, 'unknown-test');
    assert.equal(supported.result.protocolVersion, '2025-06-18');
    assert.equal(unknown.result.protocolVersion, '2025-11-25');
    assert.equal(supported.result.serverInfo.version, '0.5.0');
    const rustVersion = fs.readFileSync(RUST_SOURCE_PATH, 'utf8')
        .match(/const SERVER_VERSION: &str = "([^"]+)";/);
    assert.ok(rustVersion, 'native bridge must declare its MCP server version');
    assert.equal(rustVersion[1], supported.result.serverInfo.version);
});

test('cancellation arriving before queue insertion leaves a one-shot tombstone', async () => {
    const session = 'pre-cancel-test';
    await bridgeModule.handleRpcRequest({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 'future'}}, session);
    const response = await bridgeModule.handleRpcRequest({
        jsonrpc: '2.0',
        id: 'future',
        method: 'tools/call',
        params: {name: 'click_stop', arguments: {}}
    }, session);
    assert.equal(response.result.isError, true);
    assert.match(response.result.structuredContent.error, /cancelled.*before.*queued/i);
});

test('imageAttachment becomes standard MCP image content plus structuredContent', () => {
    const result = bridgeModule.toMcpContent({
        ok: true,
        imageAttachment: {label: 'stage', mimeType: 'image/png', dataUrl: 'data:image/png;base64,YQ==', width: 1, height: 1}
    });
    assert.deepEqual(result.content[1], {type: 'image', data: 'YQ==', mimeType: 'image/png'});
    assert.doesNotMatch(result.content[0].text, /YQ==/);
    assert.equal(result.structuredContent.imageAttachment.dataUrl, undefined);
    assert.equal(result.structuredContent.imageAttachment.label, 'stage');

    const pseudocode = 'on_flag_clicked() {\n    show()\n}';
    const codeResult = bridgeModule.toMcpContent({ok: true, type: 'get_pseudocode', pseudocode, returnedChars: pseudocode.length});
    assert.equal(codeResult.structuredContent.pseudocode, pseudocode);
    assert.doesNotMatch(codeResult.content[0].text, /on_flag_clicked/);
    assert.match(codeResult.content[0].text, /structuredContent/);
});

test('HTTP contract uses exact Origin, session/version headers, claimant tokens and a cancellation-safe claim gate', async t => {
    const port = await getFreePort();
    const child = spawn(process.execPath, [SERVER_PATH], {
        cwd: ROOT,
        env: {
            ...process.env,
            JSC_MCP_PORT: String(port),
            JSC_MCP_CALL_TIMEOUT_MS: '3000',
            JSC_MCP_POLL_TIMEOUT_MS: '250',
            JSC_MCP_CLIENT_TTL_MS: '10000',
            JSC_MCP_ALLOWED_ORIGINS: 'https://editor.example.test'
        },
        stdio: ['pipe', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    t.after(() => {
        child.stdin.end();
        child.kill();
    });
    await waitForServer(port);

    const allowedOrigin = 'http://127.0.0.1:3000';
    const preflight = await request(port, 'OPTIONS', '/result', {headers: {Origin: allowedOrigin}});
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], allowedOrigin);
    assert.notEqual(preflight.headers['access-control-allow-origin'], '*');
    const productionOrigin = await request(port, 'OPTIONS', '/poll', {headers: {Origin: 'https://40code.com'}});
    assert.equal(productionOrigin.status, 204);
    assert.equal(productionOrigin.headers['access-control-allow-origin'], 'https://40code.com');
    const configuredOrigin = await request(port, 'OPTIONS', '/mcp', {headers: {Origin: 'https://editor.example.test'}});
    assert.equal(configuredOrigin.status, 204);
    assert.equal(configuredOrigin.headers['access-control-allow-origin'], 'https://editor.example.test');
    const forbidden = await request(port, 'OPTIONS', '/result', {headers: {Origin: 'https://evil.40code.com'}});
    assert.equal(forbidden.status, 403);

    const registration = await request(port, 'GET', '/poll?clientId=page-1&title=Editor&pageUrl=http%3A%2F%2F127.0.0.1%3A3000');
    assert.equal(registration.status, 200, stderr);
    const registrationToken = registration.json.registrationToken;
    assert.match(registrationToken, /^[0-9a-f-]{32,}$/i);

    const initialized = await rpc(port, {jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: 'arbitrary'}});
    assert.equal(initialized.status, 200);
    assert.equal(initialized.json.result.protocolVersion, '2025-11-25');
    const session = {id: initialized.headers['mcp-session-id'], version: initialized.json.result.protocolVersion};
    assert.ok(session.id);

    const wrongVersion = await request(port, 'POST', '/mcp', {
        headers: {'Mcp-Session-Id': session.id, 'MCP-Protocol-Version': 'arbitrary'},
        body: {jsonrpc: '2.0', id: 2, method: 'tools/list'}
    });
    assert.equal(wrongVersion.status, 400);

    const listed = await rpc(port, {jsonrpc: '2.0', id: 3, method: 'tools/list'}, session);
    assert.deepEqual(listed.json.result.tools, CATALOG.tools);
    assert.equal(listed.json.result.tools.some(tool => tool.name === 'jsc_call_action'), false);
    assert.equal(listed.json.result.tools.find(tool => tool.name === 'get_project_overview').annotations.readOnlyHint, true);
    assert.equal(listed.json.result.tools.find(tool => tool.name === 'edit_pseudocode').annotations.readOnlyHint, false);

    const solePage = await rpc(port, {jsonrpc: '2.0', id: 4, method: 'tools/call', params: {name: 'jsc_list_pages', arguments: {}}}, session);
    assert.equal(solePage.json.result.structuredContent.selectedClientId, 'page-1');
    assert.equal(solePage.json.result.structuredContent.pages[0].selected, true);

    const requestId = 'leased-call';
    const pendingCall = rpc(port, {jsonrpc: '2.0', id: requestId, method: 'tools/call', params: {name: 'click_stop', arguments: {}}}, session);
    const poll = await request(port, 'GET', `/poll?clientId=page-1&registrationToken=${encodeURIComponent(registrationToken)}`);
    assert.equal(poll.status, 200);
    assert.equal(poll.json.calls.length, 1);
    const leased = poll.json.calls[0];
    assert.equal(leased.name, 'click_stop');
    assert.ok(leased.expiresAt > Date.now());

    const cancelled = await rpc(port, {jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId, reason: 'test cancellation'}}, session);
    assert.equal(cancelled.status, 202);
    const rejectedClaim = await request(port, 'POST', '/claim', {body: {
        clientId: 'page-1', registrationToken, id: leased.id, leaseToken: leased.leaseToken
    }});
    assert.equal(rejectedClaim.status, 410);
    const callResponse = await pendingCall;
    assert.equal(callResponse.json.result.isError, true);
    assert.match(callResponse.json.result.structuredContent.error, /test cancellation/);

    const lateResult = await request(port, 'POST', '/result', {body: {
        clientId: 'page-1', registrationToken, id: leased.id, leaseToken: leased.leaseToken, result: {ok: true}
    }});
    assert.equal(lateResult.status, 410);

    const claimedRequestId = 'claimed-call';
    const pendingClaimedCall = rpc(port, {
        jsonrpc: '2.0', id: claimedRequestId, method: 'tools/call', params: {name: 'click_stop', arguments: {}}
    }, session);
    const claimedPoll = await request(port, 'GET', `/poll?clientId=page-1&registrationToken=${encodeURIComponent(registrationToken)}`);
    assert.equal(claimedPoll.json.calls.length, 1);
    assert.deepEqual(claimedPoll.json.cancelledCallIds, [leased.id]);
    const claimedLease = claimedPoll.json.calls[0];
    const acceptedClaim = await request(port, 'POST', '/claim', {body: {
        clientId: 'page-1', registrationToken, id: claimedLease.id, leaseToken: claimedLease.leaseToken
    }});
    assert.equal(acceptedClaim.status, 200);
    const cancelledAfterClaim = await rpc(port, {
        jsonrpc: '2.0', method: 'notifications/cancelled',
        params: {requestId: claimedRequestId, reason: 'cancelled after claim'}
    }, session);
    assert.equal(cancelledAfterClaim.status, 202);
    const claimedCallResponse = await pendingClaimedCall;
    assert.equal(claimedCallResponse.json.result.isError, true);
    assert.match(claimedCallResponse.json.result.structuredContent.error, /cancelled after claim/);
    const cancellationPoll = await request(port, 'GET', `/poll?clientId=page-1&registrationToken=${encodeURIComponent(registrationToken)}`);
    assert.equal(cancellationPoll.json.calls.length, 0);
    assert.deepEqual(cancellationPoll.json.cancelledCallIds, [claimedLease.id]);

    const registration2 = await request(port, 'GET', '/poll?clientId=page-2&title=Second');
    const registrationToken2 = registration2.json.registrationToken;
    const initialized2 = await rpc(port, {jsonrpc: '2.0', id: 10, method: 'initialize', params: {protocolVersion: '2025-11-25'}});
    const session2 = {id: initialized2.headers['mcp-session-id'], version: '2025-11-25'};
    const pages = await rpc(port, {jsonrpc: '2.0', id: 11, method: 'tools/call', params: {name: 'jsc_list_pages', arguments: {}}}, session2);
    assert.equal(pages.json.result.structuredContent.pageCount, 2);

    const ambiguous = await rpc(port, {jsonrpc: '2.0', id: 12, method: 'tools/call', params: {name: 'get_project_overview', arguments: {}}}, session2);
    assert.equal(ambiguous.json.result.isError, true);
    assert.match(ambiguous.json.result.structuredContent.error, /Multiple 40code pages/);
    const selected = await rpc(port, {jsonrpc: '2.0', id: 13, method: 'tools/call', params: {name: 'jsc_select_page', arguments: {clientId: 'page-2'}}}, session2);
    assert.equal(selected.json.result.structuredContent.selectedPage.clientId, 'page-2');

    const selectedCall = rpc(port, {jsonrpc: '2.0', id: 14, method: 'tools/call', params: {name: 'get_project_overview', arguments: {}}}, session2);
    const page2Poll = await request(port, 'GET', `/poll?clientId=page-2&registrationToken=${encodeURIComponent(registrationToken2)}`);
    assert.equal(page2Poll.json.calls.length, 1);
    const page2Lease = page2Poll.json.calls[0];
    const foreignClaim = await request(port, 'POST', '/claim', {body: {
        clientId: 'page-1', registrationToken, id: page2Lease.id, leaseToken: page2Lease.leaseToken
    }});
    assert.equal(foreignClaim.status, 403);
    const page2Claim = await request(port, 'POST', '/claim', {body: {
        clientId: 'page-2', registrationToken: registrationToken2, id: page2Lease.id, leaseToken: page2Lease.leaseToken
    }});
    assert.equal(page2Claim.status, 200);
    const page2Result = await request(port, 'POST', '/result', {body: {
        clientId: 'page-2', registrationToken: registrationToken2, id: page2Lease.id, leaseToken: page2Lease.leaseToken,
        result: {ok: true, type: 'get_project_overview'}
    }});
    assert.equal(page2Result.status, 200);
    assert.equal((await selectedCall).json.result.structuredContent.type, 'get_project_overview');

    const reloadCall = rpc(port, {jsonrpc: '2.0', id: 15, method: 'tools/call', params: {name: 'get_runtime_state', arguments: {}}}, session2);
    const beforeReload = await request(port, 'GET', `/poll?clientId=page-2&registrationToken=${encodeURIComponent(registrationToken2)}`);
    const staleLease = beforeReload.json.calls[0];
    const reloaded = await request(port, 'GET', '/poll?clientId=page-2&title=SecondReloaded');
    assert.notEqual(reloaded.json.registrationToken, registrationToken2);
    const reloadResponse = await reloadCall;
    assert.equal(reloadResponse.json.result.isError, true);
    assert.match(reloadResponse.json.result.structuredContent.error, /reloaded/);
    const staleClaim = await request(port, 'POST', '/claim', {body: {
        clientId: 'page-2', registrationToken: reloaded.json.registrationToken, id: staleLease.id, leaseToken: staleLease.leaseToken
    }});
    assert.equal(staleClaim.status, 410);
    const afterReloadPages = await rpc(port, {jsonrpc: '2.0', id: 16, method: 'tools/call', params: {name: 'jsc_list_pages', arguments: {}}}, session2);
    assert.equal(afterReloadPages.json.result.structuredContent.selectedClientId, null);
});
