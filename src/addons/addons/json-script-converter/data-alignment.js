const ownDataMatches = (scope, name, type) => {
    if (!scope || !scope.variables) return [];
    return Object.keys(scope.variables)
        .map(id => scope.variables[id])
        .filter(variable => variable && variable.name === name && (variable.type || '') === type)
        .sort((a, b) => String(a.id) < String(b.id) ? -1 : (String(a.id) > String(b.id) ? 1 : 0));
};

const dataRecordKey = record => [
    record.scope,
    record.wantType,
    record.name,
    Number(record.ordinal) || 0
].join('\u0000');

const recordsFromLegacySets = meta => {
    const records = [];
    const append = (names, scope, wantType) => {
        for (const name of names || []) {
            records.push({name: String(name), scope, wantType, ordinal: 0});
        }
    };
    append(meta && meta.declaredVars, 'global', '');
    append(meta && meta.declaredLists, 'global', 'list');
    append(meta && meta.declaredLocalVars, 'local', '');
    append(meta && meta.declaredLocalLists, 'local', 'list');
    return records;
};

const getScopeAwareRecords = meta => {
    const source = meta && Array.isArray(meta.declaredDataRecords)
        ? meta.declaredDataRecords
        : recordsFromLegacySets(meta);
    const records = source.map(record => ({
        name: String(record && record.name != null ? record.name : ''),
        scope: record && record.scope === 'local' ? 'local' : 'global',
        wantType: record && record.wantType === 'list' ? 'list' : '',
        ordinal: Number(record && record.ordinal) || 0,
        pendingId: record && record.pendingId ? String(record.pendingId) : ''
    }));
    const byKey = new Map(records.map(record => [dataRecordKey(record), record]));
    const pendingRecords = meta && meta.pendingDataRecords;
    if (pendingRecords && typeof pendingRecords.values === 'function') {
        for (const pending of pendingRecords.values()) {
            if (!pending) continue;
            const normalized = {
                name: String(pending.name == null ? '' : pending.name),
                scope: pending.scope === 'local' ? 'local' : 'global',
                wantType: pending.wantType === 'list' ? 'list' : '',
                ordinal: Number(pending.ordinal) || 0,
                pendingId: pending.id == null ? '' : String(pending.id)
            };
            const key = dataRecordKey(normalized);
            if (byKey.has(key)) {
                if (normalized.pendingId) byKey.get(key).pendingId = normalized.pendingId;
            } else {
                records.push(normalized);
                byKey.set(key, normalized);
            }
        }
    }
    return records;
};

const addRemap = (remaps, kind, requestedId, variable) => {
    if (!variable || requestedId == null || variable.id == null) return;
    remaps[kind].set(String(requestedId), {
        id: variable.id,
        name: variable.name
    });
};

const createData = (scope, id, name, type) => {
    if (!scope || typeof scope.createVariable !== 'function') return null;
    scope.createVariable(id, name, type, false);
    const byId = scope.variables && scope.variables[id];
    if (byId && byId.name === name && (byId.type || '') === type) return byId;
    return ownDataMatches(scope, name, type)[0] || null;
};

/**
 * Ensure pseudocode declarations exist in their exact Scratch scope.
 *
 * The returned remaps translate parser-only pending IDs to the VM IDs that
 * were found or created. This deliberately does not infer scope from a raw
 * name when structured declaration records are available.
 */
const alignPseudocodeDataDeclarations = ({target, stage, meta, freshId}) => {
    const remaps = {variable: new Map(), list: new Map()};
    const created = [];
    const handledPendingIds = new Set();
    const records = getScopeAwareRecords(meta || {});
    if (target && target.isStage && records.some(record => record.scope === 'local')) {
        return {
            ok: false,
            error: '舞台不支持局部变量或列表声明',
            referenceIdRemaps: remaps,
            created
        };
    }
    const recordCounts = new Map();
    for (const record of records) {
        const duplicateKey = [record.scope, record.wantType, record.name].join('\u0000');
        recordCounts.set(duplicateKey, (recordCounts.get(duplicateKey) || 0) + 1);
    }
    const duplicate = [...recordCounts.entries()].find(([, count]) => count > 1);
    if (duplicate) {
        const [scope, type, name] = duplicate[0].split('\u0000');
        return {
            ok: false,
            error: `同一作用域存在无法区分的同名${type === 'list' ? '列表' : '变量'}: ${name} (${scope})`,
            referenceIdRemaps: remaps,
            created
        };
    }

    let generatedIdCounter = 0;
    const allocateId = kind => typeof freshId === 'function'
        ? freshId(kind)
        : `${kind}-decl-${Date.now().toString(36)}-${generatedIdCounter++}`;
    const resolveScope = scope => {
        if (target && target.isStage) return stage || target;
        return scope === 'local' ? target : (stage || target);
    };

    for (const record of records) {
        const scope = resolveScope(record.scope);
        if (!scope) {
            return {ok: false, error: `无法确定数据作用域: ${record.name}`, referenceIdRemaps: remaps, created};
        }
        let variable = ownDataMatches(scope, record.name, record.wantType)[record.ordinal] || null;
        if (!variable) {
            const id = record.pendingId || allocateId(record.wantType === 'list' ? 'newlist' : 'newvar');
            try {
                variable = createData(scope, id, record.name, record.wantType);
            } catch (error) {
                return {
                    ok: false,
                    error: `创建${record.wantType === 'list' ? '列表' : '变量'}失败: ${error.message}`,
                    referenceIdRemaps: remaps,
                    created
                };
            }
            if (!variable) {
                return {
                    ok: false,
                    error: `创建${record.wantType === 'list' ? '列表' : '变量'}失败: ${record.name}`,
                    referenceIdRemaps: remaps,
                    created
                };
            }
            created.push({scope: record.scope, type: record.wantType, id: variable.id, name: variable.name});
        }
        if (record.pendingId) {
            handledPendingIds.add(String(record.pendingId));
            addRemap(remaps, record.wantType === 'list' ? 'list' : 'variable', record.pendingId, variable);
        }
    }

    const alignLegacyPending = (pending, localNames, type, kind) => {
        if (!pending || typeof pending[Symbol.iterator] !== 'function') return null;
        for (const [rawName, requestedId] of pending) {
            if (handledPendingIds.has(String(requestedId))) continue;
            const name = String(rawName);
            const isLocal = !!(localNames && localNames.has(name));
            const scope = resolveScope(isLocal ? 'local' : 'global');
            let variable = ownDataMatches(scope, name, type)[0] || null;
            if (!variable) {
                try {
                    variable = createData(scope, requestedId, name, type);
                } catch (error) {
                    return `创建${type === 'list' ? '列表' : '变量'}失败: ${error.message}`;
                }
                if (!variable) return `创建${type === 'list' ? '列表' : '变量'}失败: ${name}`;
                created.push({scope: isLocal ? 'local' : 'global', type, id: variable.id, name: variable.name});
            }
            addRemap(remaps, kind, requestedId, variable);
        }
        return null;
    };
    const variableError = alignLegacyPending(
        meta && meta.pendingVars,
        meta && meta.declaredLocalVars,
        '',
        'variable'
    );
    if (variableError) return {ok: false, error: variableError, referenceIdRemaps: remaps, created};
    const listError = alignLegacyPending(
        meta && meta.pendingLists,
        meta && meta.declaredLocalLists,
        'list',
        'list'
    );
    if (listError) return {ok: false, error: listError, referenceIdRemaps: remaps, created};
    return {ok: true, referenceIdRemaps: remaps, created};
};

const collectReferencedDataIds = blocks => {
    const referenced = new Set();
    const visitPrimitive = value => {
        if (!Array.isArray(value)) return;
        if ((value[0] === 12 || value[0] === 13) && value[2] != null) referenced.add(String(value[2]));
        for (const child of value) {
            if (Array.isArray(child)) visitPrimitive(child);
        }
    };
    for (const block of Object.values(blocks || {})) {
        if (!block || Array.isArray(block)) {
            visitPrimitive(block);
            continue;
        }
        for (const [fieldName, field] of Object.entries(block.fields || {})) {
            if (fieldName !== 'VARIABLE' && fieldName !== 'LIST') continue;
            const id = Array.isArray(field) ? field[1] : field && field.id;
            if (id != null) referenced.add(String(id));
        }
        for (const input of Object.values(block.inputs || {})) visitPrimitive(input);
    }
    return referenced;
};

/** Delete only unreferenced sprite-local data omitted from local declarations. */
const prunePseudocodeLocalData = ({target, blocks, meta}) => {
    if (!target || target.isStage || !target.variables) return {deleted: []};
    const referenced = collectReferencedDataIds(blocks);
    const reserveNames = (names, type) => {
        for (const name of names || []) {
            for (const variable of ownDataMatches(target, String(name), type)) {
                referenced.add(String(variable.id));
            }
        }
    };
    // Global headers describe stage-owned data. They must never reserve a
    // same-named entry in target.variables.
    reserveNames(meta && meta.declaredLocalVars, '');
    reserveNames(meta && meta.declaredLocalLists, 'list');
    const deleted = [];
    for (const id of Object.keys(target.variables)) {
        const variable = target.variables[id];
        const type = variable && (variable.type || '');
        if (!variable || (type !== '' && type !== 'list') || referenced.has(String(id))) continue;
        if (typeof target.deleteVariable === 'function') target.deleteVariable(id);
        else delete target.variables[id];
        deleted.push(id);
    }
    return {deleted};
};

const validatePseudocodeParseResult = parsed => {
    if (!parsed || typeof parsed !== 'object') {
        return {ok: false, errors: [{line: 1, col: 1, message: 'Invalid pseudocode parse result'}]};
    }
    if (parsed.errors && parsed.errors.length) return {ok: false, errors: parsed.errors};
    // Empty and declaration-only pseudocode are both valid replace payloads:
    // replace owns the complete script body and local declaration lists.
    return {ok: true, result: parsed};
};

const shouldAutoApplyEditorText = (text, mode) => mode === 'pseudo' || String(text || '').trim().length > 0;

export {
    alignPseudocodeDataDeclarations,
    prunePseudocodeLocalData,
    validatePseudocodeParseResult,
    shouldAutoApplyEditorText
};

export default {
    alignPseudocodeDataDeclarations,
    prunePseudocodeLocalData,
    validatePseudocodeParseResult,
    shouldAutoApplyEditorText
};
