const fs = require('fs');
const path = require('path');

const sourcePath = path.resolve(
    __dirname,
    '../../../src/addons/addons/json-script-converter/userscript.js'
);
const source = fs.readFileSync(sourcePath, 'utf8');

const section = (start, end) => {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex + start.length);
    if (startIndex < 0 || endIndex < 0) throw new Error(`Missing source section: ${start} ... ${end}`);
    return source.slice(startIndex, endIndex);
};

describe('json-script-converter page MCP safety contract', () => {
    test('reuses the canonical MCP catalog for page-side argument validation', () => {
        expect(source).toContain("import mcpToolCatalog from './mcp-tools.json';");
        expect(source).toContain('mcpPageSchemaValidator.compile(tool.inputSchema');
        const dispatch = section('executeExternalMcpAction = async', 'postMcpBridgeResult = async');
        expect(dispatch.indexOf('validateMcpPageToolArguments(toolName, rawArgs)')).toBeLessThan(
            dispatch.indexOf('normalizeAiActionPayload(payload)')
        );
    });

    test('accepts the canonical direct patch shape for edit_pseudocode', () => {
        const normalization = section('const normalizeAiCallableTypeName =', 'const buildAiHiddenActionResult =');
        const normalize = Function(
            'AI_MAX_TOOL_CALLS_PER_BATCH',
            'AI_RUNTIME_DATA_ITEMS_DEFAULT',
            'AI_RUNTIME_DATA_ITEMS_MAX',
            'AI_RUNTIME_LIST_ITEMS_DEFAULT',
            'AI_RUNTIME_LIST_ITEMS_MAX',
            'normalizeAiToolTargetIds',
            'normalizeAiToolLineRanges',
            `${normalization}\nreturn normalizeAiActionPayload;`
        )(32, 20, 100, 20, 200, () => [], () => []);
        const directPatch = normalize({
            type: 'edit_pseudocode',
            targetRef: 'j',
            mode: 'patch',
            patches: [{startLine: 1, endLine: 1, oldText: 'old', newText: 'new'}]
        });
        expect(directPatch).toMatchObject({
            ok: true,
            actions: [{
                kind: 'edit',
                type: 'edit_pseudocode',
                edit: {targetRef: 'j', mode: 'patch'}
            }]
        });
        expect(directPatch.actions[0].edit.patches).toHaveLength(1);

        const missingBody = normalize({type: 'edit_pseudocode', targetRef: 'j', mode: 'patch'});
        expect(missingBody).toMatchObject({ok: false});
        expect(missingBody.error).toContain('pseudocode、patches 或 edits');
        const zeroBudget = normalize({
            type: 'get_runtime_state',
            includeDataValues: false,
            maxDataItems: 0,
            maxListItems: 0
        });
        expect(zeroBudget).toMatchObject({
            ok: true,
            actions: [{
                kind: 'tool',
                tool: {
                    type: 'get_runtime_state',
                    includeDataValues: false,
                    maxDataItems: 0,
                    maxListItems: 0
                }
            }]
        });
    });

    test('treats zero runtime data limits as an explicit zero budget', () => {
        const runtimeStateAssignment = section('getAiRuntimeState = tool => {', 'getAiProjectOverview =')
            .trim()
            .replace(/^getAiRuntimeState\s*=\s*/, '')
            .replace(/^tool\s*=>/, 'function (tool)')
            .replace(/;\s*$/, '');
        const vm = {
            editingTarget: {id: 'sprite'},
            runtime: {
                targets: [],
                threads: [],
                stageWidth: 480,
                stageHeight: 360
            }
        };
        const getRuntimeState = Function(
            'vm',
            'getAiRuntimeContext',
            'getAiDeclaredDataAliases',
            'AI_RUNTIME_DATA_ITEMS_DEFAULT',
            'AI_RUNTIME_DATA_ITEMS_MAX',
            'AI_RUNTIME_LIST_ITEMS_DEFAULT',
            'AI_RUNTIME_LIST_ITEMS_MAX',
            `return (${runtimeStateAssignment});`
        )(
            vm,
            () => ({framerate: 30, effectiveFramerate: 30, stepTimeMs: 33, turboMode: false}),
            () => new Map(),
            20,
            100,
            20,
            200
        );
        const target = {
            id: 'sprite',
            isOriginal: true,
            isStage: false,
            sprite: {name: 'Sprite', costumes: []},
            variables: {
                score: {name: 'score', type: '', value: 10},
                items: {name: 'items', type: 'list', value: ['a', 'b']}
            }
        };
        vm.runtime.targets = [target];
        const context = {
            resolveAiTarget: () => ({target}),
            getAiTargetSummary: () => ({targetRef: 'a', displayName: 'Sprite'}),
            getTargetPseudocode: () => '',
            aiPseudocodeCache: new Map(),
            getAiRuntimeStatus: () => ({running: false})
        };

        const result = getRuntimeState.call(context, {
            targetIds: ['a'],
            includeDataValues: true,
            maxDataItems: 0,
            maxListItems: 0
        });
        expect(result).toMatchObject({
            ok: true,
            includeDataValues: true,
            maxDataItems: 0,
            maxListItems: 0,
            targets: [{dataValues: [], dataValuesTruncated: true}]
        });
    });

    test('reserves dangling references when assigning deterministic short block ids', () => {
        const remapHelpers = section('const shortIdAt =', 'const computeMatches =');
        const remapBlockIds = Function(
            `${remapHelpers}\nreturn remapBlockIdsForEditor;`
        )();

        const allReferenceSlots = remapBlockIds({
            original: {
                opcode: 'control_if',
                next: 'a',
                parent: 'b',
                inputs: {CONDITION: [3, 'c', 'd']}
            }
        });
        expect(Object.keys(allReferenceSlots)).toEqual(['e']);
        expect(allReferenceSlots.e).toMatchObject({
            next: 'a',
            parent: 'b',
            inputs: {CONDITION: [3, 'c', 'd']}
        });

        const blocks = {
            root: {
                opcode: 'event_whenflagclicked',
                next: 'chain',
                parent: null,
                inputs: {BROKEN_INPUT: [2, 'gx']},
                topLevel: true
            },
            chain: {
                opcode: 'control_wait',
                next: 'Wz',
                parent: 'root',
                inputs: {}
            }
        };
        // Without reserving the dangling "gx", the 206th key (Wz) would be
        // renamed to gx and BROKEN_INPUT would silently attach to that block.
        for (let i = 2; i < 205; i++) {
            blocks[`filler-${i}`] = {
                opcode: 'looks_hide',
                next: null,
                parent: null,
                inputs: {}
            };
        }
        blocks.Wz = {
            opcode: 'looks_say',
            next: null,
            parent: 'chain',
            inputs: {}
        };

        const remapped = remapBlockIds(blocks);
        expect(Object.keys(remapped)).toHaveLength(Object.keys(blocks).length);
        expect(remapped.root).toBeUndefined();
        expect(remapped.Wz).toBeUndefined();
        expect(remapped.gx).toBeUndefined();
        expect(remapped.a.inputs.BROKEN_INPUT[1]).toBe('gx');

        const scriptIds = [];
        for (let id = 'a'; id; id = remapped[id].next) scriptIds.push(id);
        expect(scriptIds).toEqual(['a', 'b', 'gy']);
        expect(remapped.gy).toMatchObject({opcode: 'looks_say', parent: 'b'});
    });

    test('uses a fresh per-document page identity instead of copied session storage', () => {
        const identity = section('const createMcpBridgeClientId =', 'const formatMcpBridgeStatus =');
        expect(identity).toContain('crypto.randomUUID()');
        expect(source).not.toContain('AI_MCP_BRIDGE_CLIENT_ID_SESSION_KEY');
        expect(identity).not.toMatch(/sessionStorage\.(?:getItem|setItem)/);
        expect(source).toContain('this.mcpBridgeClientId = createMcpBridgeClientId();');
    });

    test('keeps cancellation polling live while one page call executes serially', () => {
        const polling = section('pollMcpBridge = async () =>', 'startMcpBridge = () =>');
        const draining = section('drainMcpBridgeCalls = () =>', 'enqueueMcpBridgeCalls = calls =>');
        expect(polling).toContain('consumeMcpCancelledCallIds(data && data.cancelledCallIds)');
        expect(polling).toContain('calls.filter(call => call && !cancelledCallIds.has(String(call.id)))');
        expect(polling).toContain('this.enqueueMcpBridgeCalls(liveCalls);');
        expect(polling).not.toContain('await this.handleMcpBridgeCall');
        expect(draining).toContain('if (this.mcpBridgeStopped || this.mcpBridgeActiveCall) return;');
        expect(draining).toContain('controller: new AbortController()');
    });

    test('invalidates old executions before a newly loaded project can accept work', () => {
        const projectLoad = section('prepareForProjectLoad = () =>', 'finishProjectLoad = () =>');
        const generation = projectLoad.indexOf('this.mcpProjectGeneration++;');
        const cancel = projectLoad.indexOf('this.cancelMcpPageCalls(');
        const clearToken = projectLoad.indexOf("this.mcpBridgeRegistrationToken = '';");
        expect(generation).toBeGreaterThanOrEqual(0);
        expect(cancel).toBeGreaterThan(generation);
        expect(clearToken).toBeGreaterThan(cancel);

        const assertion = section('assertMcpCallActive = execution =>', 'setMcpCallExpiry =');
        expect(assertion).toContain('execution.projectGeneration !== this.mcpProjectGeneration');
        expect(assertion).toContain('execution.registrationToken !== this.mcpBridgeRegistrationToken');
        expect(assertion).toContain('Date.now() >= execution.expiresAt');
    });

    test('rechecks leases at project mutation commit points and rolls back async creates', () => {
        const edit = section('executeExternalMcpEdit =', 'executeExternalMcpAction =');
        expect(edit.indexOf('this.assertMcpCallActive(execution);')).toBeLessThan(
            edit.indexOf('this.applyAiApplications(prepared.applications)')
        );

        const projectTool = section('executeAiProjectTool =', 'getAiGreenFlagHatCount =');
        expect(projectTool).toContain('const addCostumeWithGuard = async');
        expect(projectTool).toContain('target.sprite.deleteCostumeAt(addedIndex);');
        expect(projectTool).toContain('vm.deleteSprite(created.id);');
        expect(projectTool).toMatch(/assertActive\(\);\s+vm\.deleteSprite\(resolved\.target\.id\)/);
        expect(projectTool).toMatch(/assertActive\(\);\s+const deleted = target\.deleteCostume/);
        expect(projectTool).toMatch(/assertActive\(\);\s+target\.sprite\.deleteCostumeAt\(found\.index\)/);
    });

    test('passes the MCP execution guard into every mutating tool family', () => {
        const toolDispatch = section('executeAiTool = async', 'normalizeAiEditPayload =');
        expect(toolDispatch).toContain('this.assertMcpCallActive(mcpExecution);');
        expect(toolDispatch).toContain('this.executeAiRuntimeControlTool(tool, mcpExecution)');
        expect(toolDispatch).toContain('this.executeAiProjectTool(tool, mcpExecution)');
        expect(toolDispatch).toContain('this.loadAiExtension(tool, mcpExecution)');

        const runtimeTool = section('executeAiRuntimeControlTool =', 'executeAiTool = async');
        expect(runtimeTool).toContain('const assertActive = () => this.assertMcpCallActive(execution);');
        expect(runtimeTool).toMatch(/assertActive\(\);\s+setPaused\(true\)/);
        expect(runtimeTool).toMatch(/assertActive\(\);\s+if \(typeof vm\.stopAll/);
    });

    test('does not retain full pseudocode round-trip graphs in write-safety caches', () => {
        const adapter = section('const getAiConverterWriteSafety =', 'const getAiRuntimeContext =');
        expect(adapter).toContain("rendered: typeof result.rendered === 'string' ? result.rendered : ''");
        expect(adapter).not.toMatch(/\n\s*result\s*[,}]/);
        const getWriteSafety = Function(
            'pseudoConverter',
            `${adapter}\nreturn getAiConverterWriteSafety;`
        )({
            preflightPseudocodeRoundTrip: () => ({
                safe: true,
                rendered: 'on_flag_clicked() {}',
                parsed: {largeGraph: true},
                comparison: {originalCanonical: {}, roundTrippedCanonical: {}, originalFacets: {}, roundTrippedFacets: {}}
            })
        });
        expect(getWriteSafety({}, {}, {}, {})).toEqual({
            available: true,
            writeSafe: true,
            unsafeReason: '',
            rendered: 'on_flag_clicked() {}'
        });

        const makeWriteSafety = pseudoConverter => Function(
            'pseudoConverter',
            `${adapter}\nreturn getAiConverterWriteSafety;`
        )(pseudoConverter);
        const unavailable = makeWriteSafety({})({}, {}, {}, {});
        expect(unavailable).toMatchObject({available: false, writeSafe: false});
        expect(unavailable.unsafeReason).toContain('仅支持只读分析');

        const malformed = makeWriteSafety({
            preflightPseudocodeRoundTrip: () => null
        })({}, {}, {}, {});
        expect(malformed).toMatchObject({available: true, writeSafe: false});
        expect(malformed.unsafeReason).toContain('未返回有效结果');

        const legacyPositive = makeWriteSafety({
            preflightPseudocodeRoundTrip: () => ({writeSafe: true, rendered: 'still readable'})
        })({}, {}, {}, {});
        expect(legacyPositive).toMatchObject({available: true, writeSafe: false, rendered: 'still readable'});
        expect(legacyPositive.unsafeReason).toContain('safe: true');

        const failed = makeWriteSafety({
            preflightPseudocodeRoundTrip: () => { throw new Error('preflight boom'); }
        })({}, {}, {}, {});
        expect(failed).toMatchObject({available: true, writeSafe: false});
        expect(failed.unsafeReason).toContain('preflight boom');

        const safetyCache = section('getAiCurrentTargetWriteSafety =', 'invalidateAiReadCaches =');
        expect(safetyCache).toContain('const cachedSafety = {');
        expect(safetyCache).toContain('if (!blocksOverride) this.aiWriteSafetyCache.set(target.id, cachedSafety);');
        expect(safetyCache).not.toContain('this.aiWriteSafetyCache.set(target.id, safety);');
        expect(safetyCache).not.toContain('.result');

        const overview = section('getAiProjectOverview =', 'executeAiRuntimeControlTool =');
        expect(overview).toContain('const preflightRendered = safety.rendered;');
        expect(overview).not.toContain('safety.result');
    });

    test('fails closed at every pseudocode write entry and commit point', () => {
        const overview = section('getAiProjectOverview =', 'executeAiRuntimeControlTool =');
        expect(overview).toContain('writeSafe: safety.writeSafe === true');
        expect(overview).not.toContain('writeSafe: safety.writeSafe !== false');

        const prepare = section('prepareAiEditPayload =', 'formatAiApplicationErrors =');
        expect(prepare).toContain('currentSafety.writeSafe !== true');
        expect(prepare).toContain('app.writeSafe = safety.writeSafe === true');
        expect(prepare).toContain('safety.writeSafe !== true');
        expect(prepare).not.toContain('safety.writeSafe === false');

        const commit = section('applyAiApplications =', 'submitAiChat =');
        expect(commit).toContain('app.writeSafe !== true');
        expect(commit).toContain('伪代码往返安全预检未明确通过；当前目标仅支持只读分析');

        const debugApply = section('applyTargetPseudocode:', 'applyAiEditPayload:');
        expect(debugApply).toContain('this.prepareAiEditPayload({');
        expect(debugApply).not.toContain('this.validatePseudoText(');
        expect(debugApply).not.toContain('parsed: checked.result');
    });

    test('bounds search snapshots before building paginated context results', async () => {
        expect(source).toContain('const AI_SEARCH_SNAPSHOT_MATCH_LIMIT = 2000;');
        expect(source).toContain('const AI_SEARCH_SNAPSHOT_CHAR_LIMIT = 2 * 1024 * 1024;');

        const searchHelpers = section('const searchAiRegexLinesInWorker =', 'const applyAiLinePatches =');
        expect(searchHelpers).toContain('hits.length >= value.maxResults');
        expect(searchHelpers).toContain('allMatches.length >= maxResults');
        const searchFunction = section('const searchAiPseudocodeLines =', 'const applyAiLinePatches =');
        const searchLines = Function(
            'splitAiLines',
            'AI_SEARCH_SNAPSHOT_MATCH_LIMIT',
            'AI_SEARCH_RESULT_LIMIT',
            `${searchFunction}\nreturn searchAiPseudocodeLines;`
        )(text => String(text || '').split('\n'), 2000, 50);
        const capped = await searchLines(Array.from({length: 2001}, () => 'hit').join('\n'), 'hit', {
            maxResults: Number.MAX_SAFE_INTEGER
        });
        expect(capped.matches).toHaveLength(2000);
        expect(capped.truncated).toBe(true);

        const searchTool = section("if (tool.type === 'search_text')", 'let entries = [];');
        expect(searchTool).not.toContain('Number.MAX_SAFE_INTEGER');
        expect(searchTool).toContain('AI_SEARCH_SNAPSHOT_MATCH_LIMIT - allMatches.length');
        expect(searchTool).toContain('AI_SEARCH_SNAPSHOT_CHAR_LIMIT - snapshotChars');
        expect(searchTool).toContain('truncated: !!nextCursor || !!snapshot.truncated');
    });

    test('puts the latest cursor page in the next AI context without repeating the target prefix', () => {
        const windowHelpers = section('const cacheAiPseudocodeReadWindows =', 'const renderTargetPseudocode =');
        const helpers = Function(
            `${windowHelpers}\nreturn {cacheAiPseudocodeReadWindows, prioritizeAiPseudocodeContextEntries};`
        )();
        const firstPageMarker = 'FIRST_PAGE_MUST_NOT_RETURN';
        const secondPageMarker = 'SECOND_PAGE_UNIQUE_SENTINEL';
        const firstPage = `${firstPageMarker}\n${'a'.repeat(48000 - firstPageMarker.length - 1)}`;
        const secondPage = `${secondPageMarker}\n${'b'.repeat(48000 - secondPageMarker.length - 1)}`;
        const fullPseudocode = `${firstPage}${secondPage}${'c'.repeat(1024)}`;
        expect(fullPseudocode.length).toBeGreaterThan(96000);

        const recentWindows = [];
        helpers.cacheAiPseudocodeReadWindows(recentWindows, {
            ok: true,
            type: 'get_pseudocode',
            mode: 'full',
            scope: 'targets',
            cursor: '48000',
            nextCursor: '96000',
            pseudocode: secondPage,
            segments: [{
                targetRef: 'a',
                rawName: 'Large sprite',
                displayName: 'Large sprite',
                targetType: 'sprite',
                startLine: 2,
                endLine: 2,
                totalLines: 3,
                startChar: 48000,
                endChar: 96000,
                totalChars: fullPseudocode.length,
                responseStartChar: 0,
                responseEndChar: secondPage.length,
                complete: false
            }]
        });

        const buildAssignment = section('buildAiMessages =', 'runAiModifyPseudocode =')
            .trim()
            .replace(/^buildAiMessages\s*=\s*/, '')
            .replace(/^\(([^)]*)\)\s*=>/, 'function ($1)')
            .replace(/;\s*$/, '');
        const target = {id: 'large-target'};
        const vm = {editingTarget: target};
        const buildAiMessages = Function(
            'vm',
            'hasAiVisionSupport',
            'collectAiImageAttachments',
            'summarizeAiFeedbackForPrompt',
            'stripAiImageAttachments',
            'getAiProjectContext',
            'normalizeAiContextCharBudget',
            'prioritizeAiPseudocodeContextEntries',
            'AI_ACTION_OPEN',
            'AI_ACTION_CLOSE',
            'AI_TOOL_OPEN',
            'AI_EDIT_OPEN',
            'AI_MAX_TOOL_CALLS_PER_BATCH',
            'AI_PSEUDOCODE_SYNTAX_GUIDE',
            `return (${buildAssignment});`
        )(
            vm,
            () => false,
            () => [],
            value => value,
            value => value,
            () => ({targets: [{targetRef: 'a'}], extensions: {core: [], loaded: []}}),
            value => Number(value) || 60000,
            helpers.prioritizeAiPseudocodeContextEntries,
            '<ACTION>',
            '</ACTION>',
            '<AI_TOOL>',
            '<AI_EDIT>',
            16,
            ''
        );
        const context = {
            state: {
                aiConfig: {contextCharBudget: 60000, toolNoConfirm: true},
                aiMessages: []
            },
            getKnownPseudocodeEntries: () => [{
                targetRef: 'a',
                rawName: 'Large sprite',
                displayName: 'Large sprite',
                targetType: 'sprite',
                pseudocode: fullPseudocode,
                totalLines: 3
            }],
            getAiTargetRef: () => 'a',
            getAiTargetSummary: () => ({targetRef: 'a'})
        };
        const feedback = {
            kind: 'tool_result',
            toolType: 'get_pseudocode',
            cursor: '48000',
            nextCursor: '96000',
            segments: [{targetRef: 'a', startLine: 2, endLine: 2}]
        };
        const messages = buildAiMessages.call(
            context,
            'inspect the second page',
            new Map([[target.id, fullPseudocode]]),
            feedback,
            null,
            recentWindows
        );
        const payload = JSON.parse(messages[1].content);
        expect(payload.availablePseudocode).toHaveLength(1);
        expect(payload.availablePseudocode[0]).toMatchObject({
            targetRef: 'a',
            contextSource: 'recent_get_pseudocode',
            cursor: '48000',
            nextCursor: '96000',
            startLine: 2,
            endLine: 2,
            startChar: 48000,
            endChar: 96000
        });
        expect(payload.availablePseudocode[0].pseudocode).toContain(secondPageMarker);
        expect(messages[1].content).not.toContain(firstPageMarker);
        expect(JSON.stringify(messages).split(secondPageMarker)).toHaveLength(2);

        const toolDispatch = section('executeAiTool = async', 'normalizeAiEditPayload =');
        expect(toolDispatch).toContain(
            'cacheAiPseudocodeReadWindows(executionContext.aiPseudocodeReadWindows, result);'
        );
    });

    test('clears every large read cache on workspace and project history switches', () => {
        const reset = section('prepareForExternalWorkspaceReset =', 'prepareForProjectLoad =');
        const historySwitch = section('switchAiHistoryProjectIfNeeded =', 'schedulePersistAiChatState =');
        expect(reset).toContain('this.invalidateAiReadCaches();');
        expect(reset).not.toContain('this.aiSearchSnapshots.clear();');
        expect(historySwitch).toContain('this.invalidateAiReadCaches();');
        expect(historySwitch).not.toContain('this.aiSearchSnapshots.clear();');
    });

    test('reports semantic blocks separately from serialized primitive entries', () => {
        const overview = section('getAiProjectOverview = () =>', 'executeAiRuntimeControlTool = async');
        expect(overview).toContain('const serializedEntryCount = Object.keys(blocks).length;');
        expect(overview).toContain(
            'const blockCount = Object.keys(blocks).filter(id => !Array.isArray(blocks[id])).length;'
        );
        expect(overview).toContain('totalBlocks += blockCount;');
        expect(overview).toContain('serializedEntryCount,');
    });

    test.each(['returned failure', 'thrown failure'])(
        'restores every touched target after a multi-target commit has a %s',
        failureMode => {
            const applyAssignment = section('applyAiApplications = applications => {', 'submitAiChat = async')
                .trim()
                .replace(/^applyAiApplications\s*=\s*/, '')
                .replace(/;\s*$/, '');
            const emitProjectChanged = jest.fn();
            const vm = {
                editingTarget: {id: 'not-an-edited-target'},
                runtime: {
                    getTargetForStage: () => null,
                    emitProjectChanged
                }
            };
            const renderTargetPseudocode = target => JSON.stringify({
                blocks: target.blocks,
                comments: target.comments,
                variables: target.variables
            });
            const makeApplyAiApplications = Function(
                'vm',
                'sb3',
                'remapBlockIdsForEditor',
                'renderTargetPseudocode',
                `return (${applyAssignment});`
            );
            const makeTarget = (id, label) => ({
                id,
                blocks: {root: {opcode: `original_${label}`}},
                comments: {comment: {text: `original comment ${label}`}},
                variables: {
                    [`variable-${label}`]: {
                        id: `variable-${label}`,
                        name: `variable ${label}`,
                        type: '',
                        isCloud: false,
                        value: {nested: [`original ${label}`]}
                    }
                }
            });
            const first = makeTarget('first', 'first');
            const second = makeTarget('second', 'second');
            const before = new Map([
                [first.id, renderTargetPseudocode(first)],
                [second.id, renderTargetPseudocode(second)]
            ]);
            const applications = [first, second].map(target => ({
                target,
                targetId: target.id,
                targetRef: target.id,
                targetName: target.id,
                writeSafe: true,
                parsed: {blocks: {root: {opcode: `replacement_${target.id}`}}},
                meta: {},
                originalBlocks: JSON.parse(JSON.stringify(target.blocks)),
                originalPseudocode: before.get(target.id),
                pseudocode: `replacement ${target.id}`
            }));
            const commitAttempts = [];
            const rollbackAttempts = [];
            const context = {
                includeCoords: false,
                jsonEditorComponent: {current: null},
                applyBlocksToWorkspace: jest.fn((raw, meta, target, options) => {
                    const isCommit = options && options.forcePseudo;
                    const attempts = isCommit ? commitAttempts : rollbackAttempts;
                    attempts.push(target.id);
                    target.blocks = JSON.parse(JSON.stringify(raw));
                    target.comments = {changed: {text: `changed ${target.id}`}};
                    const variable = Object.values(target.variables)[0];
                    if (variable) {
                        variable.value.nested[0] = `changed ${target.id}`;
                        variable.addedDuringCommit = true;
                    }
                    target.variables[`created-${target.id}`] = {
                        id: `created-${target.id}`,
                        name: 'created during commit',
                        type: '',
                        value: 1
                    };
                    if (isCommit && target === second) {
                        if (failureMode === 'thrown failure') throw new Error('second commit threw');
                        return {ok: false, error: 'second commit failed'};
                    }
                    return {ok: true, loadedExtensions: []};
                })
            };
            const applyAiApplications = makeApplyAiApplications.call(
                context,
                vm,
                {serialize: () => ({blocks: {}})},
                value => value,
                renderTargetPseudocode
            );

            const result = applyAiApplications(applications);

            expect(result).toMatchObject({ok: false, rolledBack: true});
            expect(commitAttempts).toEqual(['first', 'second']);
            expect(rollbackAttempts).toEqual(['second', 'first']);
            expect(renderTargetPseudocode(first)).toBe(before.get(first.id));
            expect(renderTargetPseudocode(second)).toBe(before.get(second.id));
            expect(emitProjectChanged).toHaveBeenCalledTimes(1);
        }
    );
});
