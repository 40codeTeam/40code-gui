import pseudocode from '../../../src/addons/addons/json-script-converter/pseudocode';
import {
    alignPseudocodeDataDeclarations,
    prunePseudocodeLocalData,
    validatePseudocodeParseResult,
    shouldAutoApplyEditorText
} from '../../../src/addons/addons/json-script-converter/data-alignment';

const makeVariable = (id, name, type = '') => ({id, name, type, value: type === 'list' ? [] : 0});

const makeTarget = (id, isStage, variables = []) => {
    const target = {
        id,
        isStage,
        variables: Object.fromEntries(variables.map(variable => [variable.id, variable])),
        createVariable: jest.fn((variableId, name, type) => {
            target.variables[variableId] = makeVariable(variableId, name, type);
        }),
        deleteVariable: jest.fn(variableId => {
            delete target.variables[variableId];
        })
    };
    return target;
};

const makeContext = ({globals = [], locals = []} = {}) => {
    const stage = makeTarget('stage', true, globals);
    const target = makeTarget('sprite', false, locals);
    const runtime = {getTargetForStage: () => stage};
    stage.runtime = runtime;
    target.runtime = runtime;
    return {stage, target, ctx: {target, vm: {runtime}}};
};

const metaFromParsed = parsed => ({
    pendingVars: parsed.pendingVars,
    pendingLists: parsed.pendingLists,
    pendingDataRecords: parsed.pendingDataRecords,
    declaredVars: parsed.declaredVars,
    declaredLists: parsed.declaredLists,
    declaredLocalVars: parsed.declaredLocalVars,
    declaredLocalLists: parsed.declaredLocalLists,
    declaredDataRecords: parsed.declaredDataRecords
});

describe('pseudocode data declaration apply behavior', () => {
    test('creates same-named global/local variables and lists with scope-aware pending identities', () => {
        const {stage, target, ctx} = makeContext();
        const parsed = pseudocode.parsePseudocode([
            '#vars { "score" as global_score }',
            '#localvars { "score" as local_score }',
            '#lists { "items" as global_items }',
            '#locallists { "items" as local_items }',
            '',
            'on_flag_clicked() {',
            '    global_score = 1',
            '    local_score = 2',
            '    list_add(global_items, "global")',
            '    list_add(local_items, "local")',
            '}'
        ].join('\n'), ctx);

        expect(parsed.errors).toEqual([]);
        expect(parsed.pendingDataRecords).toBeInstanceOf(Map);
        expect(parsed.pendingDataRecords.size).toBe(4);
        const pending = [...parsed.pendingDataRecords.values()];
        expect(new Set(pending.map(record => record.id)).size).toBe(4);
        expect(pending.map(record => [record.scope, record.wantType, record.name])).toEqual(expect.arrayContaining([
            ['global', '', 'score'],
            ['local', '', 'score'],
            ['global', 'list', 'items'],
            ['local', 'list', 'items']
        ]));
        const preflight = pseudocode.preflightPseudocodeRoundTrip(
            parsed.blocks,
            ctx,
            {includeCoords: false, dataRecords: parsed.declaredDataRecords}
        );
        expect(preflight).toMatchObject({safe: true, reasons: []});

        let nextId = 0;
        const result = alignPseudocodeDataDeclarations({
            target,
            stage,
            meta: metaFromParsed(parsed),
            freshId: kind => `${kind}-${nextId++}`
        });

        expect(result.ok).toBe(true);
        const stageData = Object.values(stage.variables).map(variable => [variable.name, variable.type]);
        expect(stageData).toEqual(expect.arrayContaining([
            ['score', ''],
            ['items', 'list']
        ]));
        const localData = Object.values(target.variables).map(variable => [variable.name, variable.type]);
        expect(localData).toEqual(expect.arrayContaining([
            ['score', ''],
            ['items', 'list']
        ]));
        for (const record of pending) {
            const owner = record.scope === 'local' ? target : stage;
            expect(owner.variables[record.id]).toMatchObject({name: record.name, type: record.wantType});
            const kind = record.wantType === 'list' ? 'list' : 'variable';
            expect(result.referenceIdRemaps[kind].get(record.id)).toMatchObject({id: record.id, name: record.name});
        }
    });

    test('global headers never reserve same-named sprite-local data during prune', () => {
        const {stage, target, ctx} = makeContext({
            globals: [makeVariable('global-score', 'score'), makeVariable('global-items', 'items', 'list')],
            locals: [makeVariable('local-score', 'score'), makeVariable('local-items', 'items', 'list')]
        });
        const parsed = pseudocode.parsePseudocode([
            '#vars { "score" as global_score }',
            '#lists { "items" as global_items }',
            '',
            'on_flag_clicked() {',
            '    global_score = 1',
            '    list_add(global_items, "global")',
            '}'
        ].join('\n'), ctx);
        expect(parsed.errors).toEqual([]);
        expect(alignPseudocodeDataDeclarations({target, stage, meta: metaFromParsed(parsed)}).ok).toBe(true);
        const result = prunePseudocodeLocalData({
            target,
            blocks: parsed.blocks,
            meta: metaFromParsed(parsed)
        });

        expect(result.deleted.sort()).toEqual(['local-items', 'local-score']);
        expect(target.variables).toEqual({});
        expect(Object.keys(stage.variables).sort()).toEqual(['global-items', 'global-score']);
    });

    test('local declarations preserve same-named local data even when blocks only reference globals', () => {
        const {target} = makeContext({
            globals: [makeVariable('global-score', 'score'), makeVariable('global-items', 'items', 'list')],
            locals: [makeVariable('local-score', 'score'), makeVariable('local-items', 'items', 'list')]
        });
        const result = prunePseudocodeLocalData({
            target,
            blocks: {},
            meta: {
                declaredLocalVars: new Set(['score']),
                declaredLocalLists: new Set(['items'])
            }
        });

        expect(result.deleted).toEqual([]);
        expect(Object.keys(target.variables).sort()).toEqual(['local-items', 'local-score']);
    });

    test('declaration-only pseudocode writes data without requiring any blocks', () => {
        const {stage, target, ctx} = makeContext();
        const parsed = pseudocode.parsePseudocode([
            '#localvars { "unused variable" }',
            '#locallists { "unused list" }'
        ].join('\n'), ctx);

        expect(validatePseudocodeParseResult(parsed).ok).toBe(true);
        const aligned = alignPseudocodeDataDeclarations({target, stage, meta: metaFromParsed(parsed)});
        expect(aligned.ok).toBe(true);
        const pruned = prunePseudocodeLocalData({target, blocks: parsed.blocks, meta: metaFromParsed(parsed)});
        expect(pruned.deleted).toEqual([]);
        const localData = Object.values(target.variables).map(variable => [variable.name, variable.type]);
        expect(localData).toEqual(expect.arrayContaining([
            ['unused variable', ''],
            ['unused list', 'list']
        ]));
    });

    test('empty replace is valid and removes the last authoritative local declarations', () => {
        const {stage, target, ctx} = makeContext({
            locals: [makeVariable('last-variable', 'last variable'), makeVariable('last-list', 'last list', 'list')]
        });
        const parsed = pseudocode.parsePseudocode('', ctx);

        expect(shouldAutoApplyEditorText('', 'pseudo')).toBe(true);
        expect(shouldAutoApplyEditorText('', 'json')).toBe(false);
        expect(validatePseudocodeParseResult(parsed)).toMatchObject({ok: true});
        expect(alignPseudocodeDataDeclarations({target, stage, meta: metaFromParsed(parsed)}).ok).toBe(true);
        const pruned = prunePseudocodeLocalData({target, blocks: parsed.blocks, meta: metaFromParsed(parsed)});
        expect(pruned.deleted.sort()).toEqual(['last-list', 'last-variable']);
        expect(target.variables).toEqual({});
    });

    test('write-safety normalizes pending variable, list, and broadcast IDs', () => {
        const {ctx} = makeContext();
        const parsed = pseudocode.parsePseudocode([
            'on_flag_clicked() {',
            '    future_score = 1',
            '    list_add(future_items, "item")',
            '    broadcast("ready")',
            '}'
        ].join('\n'), ctx);
        expect(parsed.errors).toEqual([]);
        const preflight = pseudocode.preflightPseudocodeRoundTrip(parsed.blocks, ctx, {
            includeCoords: false,
            dataRecords: parsed.declaredDataRecords,
            pendingVars: parsed.pendingVars,
            pendingLists: parsed.pendingLists,
            pendingBroadcasts: parsed.pendingBroadcasts,
            declaredLocalVars: parsed.declaredLocalVars,
            declaredLocalLists: parsed.declaredLocalLists
        });
        expect(preflight).toMatchObject({safe: true, reasons: []});
    });

    test('stage-local declarations are rejected before data creation', () => {
        const stage = makeTarget('stage', true);
        const runtime = {getTargetForStage: () => stage};
        stage.runtime = runtime;
        const parsed = pseudocode.parsePseudocode('#localvars { "score" }', {
            target: stage,
            vm: {runtime}
        });
        expect(validatePseudocodeParseResult(parsed)).toMatchObject({ok: false});
        const aligned = alignPseudocodeDataDeclarations({
            target: stage,
            stage,
            meta: metaFromParsed(parsed)
        });
        expect(aligned).toMatchObject({ok: false, error: '舞台不支持局部变量或列表声明'});
        expect(stage.createVariable).not.toHaveBeenCalled();
    });
});
