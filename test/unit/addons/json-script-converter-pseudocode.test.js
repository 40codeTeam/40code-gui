import pseudocode, {
    canonicalizePseudocodeBlocks,
    comparePseudocodeRoundTrip,
    preflightPseudocodeRoundTrip
} from '../../../src/addons/addons/json-script-converter/pseudocode';

const makeVariable = (id, name, type = '') => ({id, name, type});

const makeContext = ({globals = [], locals = [], blocks = {}, runtimeBlockInfo = []} = {}) => {
    const stage = {
        isStage: true,
        variables: Object.fromEntries(globals.map(variable => [variable.id, variable]))
    };
    const target = {
        isStage: false,
        variables: Object.fromEntries(locals.map(variable => [variable.id, variable])),
        blocks: {_blocks: blocks}
    };
    target.lookupVariableByNameAndType = (name, type) => {
        const own = Object.values(target.variables).find(variable => variable.name === name && variable.type === type);
        return own || Object.values(stage.variables).find(variable => variable.name === name && variable.type === type) || null;
    };
    return {
        target,
        vm: {runtime: {getTargetForStage: () => stage, _blockInfo: runtimeBlockInfo}}
    };
};

const literalInput = value => [1, [10, String(value)]];
const numericInput = value => [1, [4, String(value)]];
const integerInput = value => [1, [7, String(value)]];
const reporterInput = (blockId, shadowType = 10) => [3, blockId, [shadowType, '']];

const makeProcedureDefinitionBlocks = ({
    proccode,
    argumentIds = [],
    argumentNames = [],
    argumentTypes = [],
    argumentDefaults = argumentTypes.map(type => type === 'b' ? 'false' : ''),
    warp = 'false',
    mutationExtra = {}
}) => {
    const mutation = {
        tagName: 'mutation',
        children: [],
        proccode,
        argumentids: JSON.stringify(argumentIds),
        argumentnames: JSON.stringify(argumentNames),
        argumentdefaults: JSON.stringify(argumentDefaults),
        warp,
        ...mutationExtra
    };
    const blocks = {
        definition: {
            opcode: 'procedures_definition', next: null, parent: null,
            inputs: {custom_block: [1, 'prototype']}, fields: {}, shadow: false, topLevel: true
        },
        prototype: {
            opcode: 'procedures_prototype', next: null, parent: 'definition',
            inputs: {}, fields: {}, mutation, shadow: true, topLevel: false
        }
    };
    for (let i = 0; i < argumentIds.length; i++) {
        const reporterId = `prototype-arg-${i}`;
        blocks.prototype.inputs[argumentIds[i]] = [1, reporterId];
        blocks[reporterId] = {
            opcode: argumentTypes[i] === 'b'
                ? 'argument_reporter_boolean'
                : 'argument_reporter_string_number',
            next: null,
            parent: 'prototype',
            inputs: {},
            fields: {VALUE: [argumentNames[i], null]},
            shadow: true,
            topLevel: false
        };
    }
    return {blocks, mutation};
};

describe('pseudocode data aliases', () => {
    test('global and local variables with the same name retain scope and IDs', () => {
        const ctx = makeContext({
            globals: [makeVariable('global-score-id', 'score')],
            locals: [makeVariable('local-score-id', 'score')]
        });
        const blocks = {
            a: {
                opcode: 'data_setvariableto',
                next: 'b',
                parent: null,
                inputs: {VALUE: literalInput(1)},
                fields: {VARIABLE: ['score', 'global-score-id']},
                shadow: false,
                topLevel: true
            },
            b: {
                opcode: 'data_setvariableto',
                next: null,
                parent: 'a',
                inputs: {VALUE: literalInput(2)},
                fields: {VARIABLE: ['score', 'local-score-id']},
                shadow: false,
                topLevel: false
            }
        };

        const rendered = pseudocode.renderPseudocode(blocks, ctx, {includeCoords: false});
        expect(rendered).toContain('#vars { "score" as global_score }');
        expect(rendered).toContain('#localvars { "score" as local_score }');
        expect(rendered).toContain('global_score = 1');
        expect(rendered).toContain('local_score = 2');

        const parsed = pseudocode.parsePseudocode(rendered, ctx);
        expect(parsed.errors).toEqual([]);
        const ids = Object.values(parsed.blocks)
            .filter(block => block && !Array.isArray(block) && block.opcode === 'data_setvariableto')
            .map(block => block.fields.VARIABLE[1]);
        expect(ids).toEqual(['global-score-id', 'local-score-id']);
        expect(preflightPseudocodeRoundTrip(blocks, ctx, {includeCoords: false}).safe).toBe(true);
        expect(preflightPseudocodeRoundTrip(parsed.blocks, ctx, {
            includeCoords: false,
            dataRecords: parsed.declaredDataRecords,
            pendingVars: parsed.pendingVars,
            pendingLists: parsed.pendingLists,
            pendingBroadcasts: parsed.pendingBroadcasts,
            declaredLocalVars: parsed.declaredLocalVars,
            declaredLocalLists: parsed.declaredLocalLists
        }).safe).toBe(true);
    });

    test('sanitized-name collisions receive deterministic distinct aliases', () => {
        const ctx = makeContext({
            globals: [
                makeVariable('space-id', 'a b'),
                makeVariable('dash-id', 'a-b')
            ]
        });
        const blocks = {
            a: {
                opcode: 'data_setvariableto', next: 'b', parent: null,
                inputs: {VALUE: literalInput(1)}, fields: {VARIABLE: ['a b', 'space-id']},
                shadow: false, topLevel: true
            },
            b: {
                opcode: 'data_setvariableto', next: null, parent: 'a',
                inputs: {VALUE: literalInput(2)}, fields: {VARIABLE: ['a-b', 'dash-id']},
                shadow: false, topLevel: false
            }
        };

        const rendered = pseudocode.renderPseudocode(blocks, ctx, {includeCoords: false});
        expect(rendered).toContain('"a b" as global_a_b');
        expect(rendered).toContain('"a-b" as global_a_b_2');
        const parsed = pseudocode.parsePseudocode(rendered, ctx);
        expect(parsed.errors).toEqual([]);
        const ids = Object.values(parsed.blocks)
            .filter(block => block && !Array.isArray(block) && block.opcode === 'data_setvariableto')
            .map(block => block.fields.VARIABLE[1]);
        expect(ids).toEqual(['space-id', 'dash-id']);
    });

    test('global and local lists with the same name keep distinct references', () => {
        const ctx = makeContext({
            globals: [makeVariable('global-items-id', 'items', 'list')],
            locals: [makeVariable('local-items-id', 'items', 'list')]
        });
        const blocks = {
            a: {
                opcode: 'data_addtolist', next: 'b', parent: null,
                inputs: {ITEM: literalInput('global')}, fields: {LIST: ['items', 'global-items-id']},
                shadow: false, topLevel: true
            },
            b: {
                opcode: 'data_addtolist', next: null, parent: 'a',
                inputs: {ITEM: literalInput('local')}, fields: {LIST: ['items', 'local-items-id']},
                shadow: false, topLevel: false
            }
        };
        const rendered = pseudocode.renderPseudocode(blocks, ctx, {includeCoords: false});
        expect(rendered).toContain('#lists { "items" as global_items }');
        expect(rendered).toContain('#locallists { "items" as local_items }');
        const parsed = pseudocode.parsePseudocode(rendered, ctx);
        expect(parsed.errors).toEqual([]);
        const ids = Object.values(parsed.blocks)
            .filter(block => block && !Array.isArray(block) && block.opcode === 'data_addtolist')
            .map(block => block.fields.LIST[1]);
        expect(ids).toEqual(['global-items-id', 'local-items-id']);
    });

    test('a variable and list with the same name use kind-specific aliases', () => {
        const ctx = makeContext({
            globals: [
                makeVariable('shared-variable-id', 'shared'),
                makeVariable('shared-list-id', 'shared', 'list')
            ]
        });
        const blocks = {
            a: {
                opcode: 'data_setvariableto', next: 'b', parent: null,
                inputs: {VALUE: literalInput(1)}, fields: {VARIABLE: ['shared', 'shared-variable-id']},
                shadow: false, topLevel: true
            },
            b: {
                opcode: 'data_addtolist', next: null, parent: 'a',
                inputs: {ITEM: literalInput('item')}, fields: {LIST: ['shared', 'shared-list-id']},
                shadow: false, topLevel: false
            }
        };
        const rendered = pseudocode.renderPseudocode(blocks, ctx, {includeCoords: false});
        expect(rendered).toContain('#vars { "shared" as global_var_shared }');
        expect(rendered).toContain('#lists { "shared" as global_list_shared }');
        const parsed = pseudocode.parsePseudocode(rendered, ctx);
        expect(parsed.errors).toEqual([]);
        const parsedBlocks = Object.values(parsed.blocks).filter(block => block && !Array.isArray(block));
        expect(parsedBlocks.find(block => block.opcode === 'data_setvariableto').fields.VARIABLE[1])
            .toBe('shared-variable-id');
        expect(parsedBlocks.find(block => block.opcode === 'data_addtolist').fields.LIST[1])
            .toBe('shared-list-id');
    });

    test('generated aliases do not collide with a real unaliased name', () => {
        const ctx = makeContext({
            globals: [
                makeVariable('real-alias-id', 'global_score'),
                makeVariable('global-score-id', 'score')
            ],
            locals: [makeVariable('local-score-id', 'score')]
        });
        const blocks = {
            a: {
                opcode: 'data_setvariableto', next: 'b', parent: null,
                inputs: {VALUE: literalInput(1)}, fields: {VARIABLE: ['global_score', 'real-alias-id']},
                shadow: false, topLevel: true
            },
            b: {
                opcode: 'data_setvariableto', next: 'c', parent: 'a',
                inputs: {VALUE: literalInput(2)}, fields: {VARIABLE: ['score', 'global-score-id']},
                shadow: false, topLevel: false
            },
            c: {
                opcode: 'data_setvariableto', next: null, parent: 'b',
                inputs: {VALUE: literalInput(3)}, fields: {VARIABLE: ['score', 'local-score-id']},
                shadow: false, topLevel: false
            }
        };
        const rendered = pseudocode.renderPseudocode(blocks, ctx, {includeCoords: false});
        expect(rendered).toContain('"global_score"');
        expect(rendered).toContain('"score" as global_score_2');
        expect(rendered).toContain('"score" as local_score');
        const parsed = pseudocode.parsePseudocode(rendered, ctx);
        expect(parsed.errors).toEqual([]);
        const ids = Object.values(parsed.blocks)
            .filter(block => block && !Array.isArray(block) && block.opcode === 'data_setvariableto')
            .map(block => block.fields.VARIABLE[1]);
        expect(ids).toEqual(['real-alias-id', 'global-score-id', 'local-score-id']);
    });

    test('empty, whitespace, and quoted names survive rendering and parsing', () => {
        const quotedName = '  say "hello"  ';
        const ctx = makeContext({
            globals: [
                makeVariable('empty-id', ''),
                makeVariable('quoted-id', quotedName)
            ]
        });
        const blocks = {
            a: {
                opcode: 'data_setvariableto', next: 'b', parent: null,
                inputs: {VALUE: literalInput(1)}, fields: {VARIABLE: ['', 'empty-id']},
                shadow: false, topLevel: true
            },
            b: {
                opcode: 'data_setvariableto', next: null, parent: 'a',
                inputs: {VALUE: literalInput(2)}, fields: {VARIABLE: [quotedName, 'quoted-id']},
                shadow: false, topLevel: false
            }
        };
        const rendered = pseudocode.renderPseudocode(blocks, ctx, {includeCoords: false});
        expect(rendered).toContain('"" as global_value');
        expect(rendered).toContain('"  say \\"hello\\"  "');
        const parsed = pseudocode.parsePseudocode(rendered, ctx);
        expect(parsed.errors).toEqual([]);
        const ids = Object.values(parsed.blocks)
            .filter(block => block && !Array.isArray(block) && block.opcode === 'data_setvariableto')
            .map(block => block.fields.VARIABLE[1]);
        expect(ids).toEqual(['empty-id', 'quoted-id']);
    });

    test('headers include unreferenced target-local variables and lists', () => {
        const ctx = makeContext({
            globals: [
                makeVariable('unused-global-variable-id', 'unused global variable'),
                makeVariable('unused-global-list-id', 'unused global list', 'list')
            ],
            locals: [
                makeVariable('unused-variable-id', 'unused variable'),
                makeVariable('unused-list-id', 'unused list', 'list')
            ]
        });
        const blocks = {
            a: {
                opcode: 'event_whenflagclicked', next: null, parent: null,
                inputs: {}, fields: {}, shadow: false, topLevel: true
            }
        };
        const rendered = pseudocode.renderPseudocode(blocks, ctx, {includeCoords: false});
        expect(rendered).toContain('#localvars { "unused variable" }');
        expect(rendered).toContain('#locallists { "unused list" }');
        expect(rendered).not.toContain('unused global variable');
        expect(rendered).not.toContain('unused global list');
        const parsed = pseudocode.parsePseudocode(rendered, ctx);
        expect(parsed.declaredLocalVars).toEqual(new Set(['unused variable']));
        expect(parsed.declaredLocalLists).toEqual(new Set(['unused list']));
    });

    test('a referenced global is declared and aliased against an unreferenced local', () => {
        const ctx = makeContext({
            globals: [
                makeVariable('global-score-id', 'score'),
                makeVariable('unused-global-id', 'stage only')
            ],
            locals: [
                makeVariable('local-score-id', 'score'),
                makeVariable('unused-local-id', 'sprite only')
            ]
        });
        const blocks = {
            a: {
                opcode: 'data_setvariableto', next: null, parent: null,
                inputs: {VALUE: literalInput(1)}, fields: {VARIABLE: ['score', 'global-score-id']},
                shadow: false, topLevel: true
            }
        };
        const rendered = pseudocode.renderPseudocode(blocks, ctx, {includeCoords: false});
        expect(rendered).toContain('#vars { "score" as global_score }');
        expect(rendered).toContain('#localvars { "score" as local_score "sprite only" }');
        expect(rendered).toContain('global_score = 1');
        expect(rendered).not.toContain('stage only');
        const parsed = pseudocode.parsePseudocode(rendered, ctx);
        expect(parsed.errors).toEqual([]);
        const setBlock = Object.values(parsed.blocks)
            .find(block => block && !Array.isArray(block) && block.opcode === 'data_setvariableto');
        expect(setBlock.fields.VARIABLE).toEqual(['score', 'global-score-id']);
    });

    test('candidate preflight reuses existing scoped data records instead of duplicating headers', () => {
        // Mirrors the 88.sb3 `特效` edit path: a rendered target declares all
        // locals, the AI changes only wait(0.1), then the parsed candidate is
        // rendered and parsed once more by the fail-closed write preflight.
        const ctx = makeContext({
            globals: [makeVariable('player-health-id', '玩家-血量')],
            locals: [
                makeVariable('effect-index-id', '*i'),
                makeVariable('effect-ghost-id', '*虚像')
            ]
        });
        const blocks = {
            a: {
                opcode: 'event_whenflagclicked', next: 'b', parent: null,
                inputs: {}, fields: {}, shadow: false, topLevel: true
            },
            b: {
                opcode: 'data_setvariableto', next: 'c', parent: 'a',
                inputs: {VALUE: literalInput(100)}, fields: {VARIABLE: ['*虚像', 'effect-ghost-id']},
                shadow: false, topLevel: false
            },
            c: {
                opcode: 'control_wait', next: 'd', parent: 'b',
                inputs: {DURATION: numericInput(0.1)}, fields: {}, shadow: false, topLevel: false
            },
            d: {
                opcode: 'data_setvariableto', next: null, parent: 'c',
                inputs: {VALUE: literalInput(999999)}, fields: {VARIABLE: ['玩家-血量', 'player-health-id']},
                shadow: false, topLevel: false
            }
        };
        const rendered = pseudocode.renderPseudocode(blocks, ctx, {includeCoords: false});
        const candidate = rendered.replace('wait(0.1)', 'wait(0.2)');
        expect(candidate).not.toBe(rendered);
        const parsed = pseudocode.parsePseudocode(candidate, ctx);
        expect(parsed.errors).toEqual([]);

        const result = preflightPseudocodeRoundTrip(parsed.blocks, ctx, {
            includeCoords: false,
            dataRecords: parsed.declaredDataRecords,
            pendingVars: parsed.pendingVars,
            pendingLists: parsed.pendingLists,
            pendingBroadcasts: parsed.pendingBroadcasts,
            declaredLocalVars: parsed.declaredLocalVars,
            declaredLocalLists: parsed.declaredLocalLists
        });

        expect(result.safe).toBe(true);
        expect(result.comparison.equal).toBe(true);
        expect((result.rendered.match(/"\*i"/g) || [])).toHaveLength(1);
        expect((result.rendered.match(/"\*虚像"/g) || [])).toHaveLength(1);
        expect((result.rendered.match(/"玩家-血量"/g) || [])).toHaveLength(1);
    });
});

describe('pseudocode arithmetic roundtrip', () => {
    test('operator_add preserves a non-numeric value in a numeric slot', () => {
        const ctx = makeContext();
        const blocks = {
            a: {
                opcode: 'looks_say', next: null, parent: null,
                inputs: {MESSAGE: reporterInput('b')}, fields: {}, shadow: false, topLevel: true
            },
            b: {
                opcode: 'operator_add', next: null, parent: 'a',
                inputs: {NUM1: numericInput('hello'), NUM2: numericInput(2)}, fields: {},
                shadow: false, topLevel: false
            }
        };

        const result = preflightPseudocodeRoundTrip(blocks, ctx, {includeCoords: false});
        expect(result.rendered).toContain('say("hello" + 2)');
        expect(result.safe).toBe(true);
        expect(result.comparison.equal).toBe(true);
        expect(Object.values(result.parsed.blocks).some(block => (
            block && !Array.isArray(block) && block.opcode === 'operator_add'
        ))).toBe(true);
    });

    test.each([
        {
            name: 'join',
            opcode: 'operator_join',
            inputs: {STRING1: literalInput('left'), STRING2: literalInput('right')},
            rendered: 'join("left", "right") + 3'
        },
        {
            name: 'letter_of',
            opcode: 'operator_letter_of',
            inputs: {LETTER: [1, [6, '1']], STRING: literalInput('abc')},
            rendered: 'letter_of(1, "abc") + 3'
        }
    ])('operator_add preserves a nested $name reporter', ({opcode, inputs, rendered}) => {
        const ctx = makeContext();
        const blocks = {
            a: {
                opcode: 'looks_say', next: null, parent: null,
                inputs: {MESSAGE: reporterInput('b')}, fields: {}, shadow: false, topLevel: true
            },
            b: {
                opcode: 'operator_add', next: null, parent: 'a',
                inputs: {NUM1: reporterInput('c', 4), NUM2: numericInput(3)}, fields: {},
                shadow: false, topLevel: false
            },
            c: {
                opcode, next: null, parent: 'b', inputs, fields: {}, shadow: false, topLevel: false
            }
        };

        const result = preflightPseudocodeRoundTrip(blocks, ctx, {includeCoords: false});
        expect(result.rendered).toContain(rendered);
        expect(result.safe).toBe(true);
        expect(result.comparison.equal).toBe(true);
        const opcodes = Object.values(result.parsed.blocks)
            .filter(block => block && !Array.isArray(block))
            .map(block => block.opcode);
        expect(opcodes).toContain('operator_add');
        expect(opcodes).toContain(opcode);
    });

    test('changevariableby with a join RHS keeps += and its opcode', () => {
        const ctx = makeContext({locals: [makeVariable('score-id', 'score')]});
        const blocks = {
            a: {
                opcode: 'data_changevariableby', next: null, parent: null,
                inputs: {VALUE: reporterInput('b', 4)}, fields: {VARIABLE: ['score', 'score-id']},
                shadow: false, topLevel: true
            },
            b: {
                opcode: 'operator_join', next: null, parent: 'a',
                inputs: {STRING1: literalInput('left'), STRING2: literalInput('right')}, fields: {},
                shadow: false, topLevel: false
            }
        };

        const result = preflightPseudocodeRoundTrip(blocks, ctx, {includeCoords: false});
        expect(result.rendered).toContain('score += join("left", "right")');
        expect(result.safe).toBe(true);
        const change = Object.values(result.parsed.blocks).find(block => (
            block && !Array.isArray(block) && block.opcode === 'data_changevariableby'
        ));
        expect(change).toBeDefined();
        expect(result.parsed.blocks[change.inputs.VALUE[1]].opcode).toBe('operator_join');
    });

    test('setvariableto of self plus value remains setvariableto with an add child', () => {
        const ctx = makeContext({locals: [makeVariable('score-id', 'score')]});
        const blocks = {
            a: {
                opcode: 'data_setvariableto', next: null, parent: null,
                inputs: {VALUE: reporterInput('b')}, fields: {VARIABLE: ['score', 'score-id']},
                shadow: false, topLevel: true
            },
            b: {
                opcode: 'operator_add', next: null, parent: 'a',
                inputs: {NUM1: reporterInput('c', 4), NUM2: numericInput(2)}, fields: {},
                shadow: false, topLevel: false
            },
            c: {
                opcode: 'data_variable', next: null, parent: 'b',
                inputs: {}, fields: {VARIABLE: ['score', 'score-id']}, shadow: false, topLevel: false
            }
        };

        const result = preflightPseudocodeRoundTrip(blocks, ctx, {includeCoords: false});
        expect(result.rendered).toContain('score = score + 2');
        expect(result.rendered).not.toContain('score += 2');
        expect(result.safe).toBe(true);
        expect(result.comparison.equal).toBe(true);
        const set = Object.values(result.parsed.blocks).find(block => (
            block && !Array.isArray(block) && block.opcode === 'data_setvariableto'
        ));
        expect(set).toBeDefined();
        expect(result.parsed.blocks[set.inputs.VALUE[1]].opcode).toBe('operator_add');
        expect(Object.values(result.parsed.blocks).some(block => (
            block && !Array.isArray(block) && block.opcode === 'data_changevariableby'
        ))).toBe(false);
    });
});

describe('pseudocode semantic roundtrip preflight', () => {
    test('pure canonical helpers ignore block IDs', () => {
        const first = {
            a: {opcode: 'looks_say', next: null, parent: null, inputs: {MESSAGE: literalInput('hi')}, fields: {}, shadow: false}
        };
        const second = {
            arbitrary: {opcode: 'looks_say', next: null, parent: null, inputs: {MESSAGE: literalInput('hi')}, fields: {}, shadow: false}
        };
        expect(canonicalizePseudocodeBlocks(first)).toEqual(canonicalizePseudocodeBlocks(second));
        expect(comparePseudocodeRoundTrip(first, second).equal).toBe(true);
    });

    test('@op reporter with a fallback shadow is read-only', () => {
        const ctx = makeContext();
        const blocks = {
            a: {
                opcode: 'extension_statement', next: null, parent: null,
                inputs: {VALUE: [3, 'b', [10, 'fallback']]}, fields: {}, shadow: false, topLevel: true
            },
            b: {
                opcode: 'extension_reporter', next: null, parent: 'a',
                inputs: {}, fields: {}, shadow: false, topLevel: false
            }
        };
        const result = preflightPseudocodeRoundTrip(blocks, ctx, {includeCoords: false});
        expect(result.safe).toBe(false);
        expect(result.readOnly).toBe(true);
        expect(result.reasons.join(' ')).toMatch(/input type 3/);
        expect(result.reasons.join(' ')).toMatch(/fallback shadow/);
    });

    test('a canonical @op remains write-safe', () => {
        const ctx = makeContext();
        const blocks = {
            a: {
                opcode: 'extension_simple', next: null, parent: null,
                inputs: {VALUE: literalInput('hello')},
                fields: {MODE: ['plain', null]},
                mutation: {tagName: 'mutation', children: [], mode: 'plain'},
                shadow: false, topLevel: true
            }
        };
        const result = preflightPseudocodeRoundTrip(blocks, ctx, {includeCoords: false});
        expect(result.safe).toBe(true);
        expect(result.readOnly).toBe(false);
        expect(result.comparison.equal).toBe(true);
    });

    test('normal known opcodes ignore inactive shadows, dropdown IDs, and coordinates', () => {
        const ctx = makeContext();
        const blocks = {
            a: {
                opcode: 'event_whenflagclicked', next: 'b', parent: null,
                inputs: {}, fields: {}, shadow: false, topLevel: true, x: 123, y: 456
            },
            b: {
                opcode: 'motion_setrotationstyle', next: 'c', parent: 'a',
                inputs: {}, fields: {STYLE: ['left-right', 'non-semantic-dropdown-id']},
                shadow: false, topLevel: false
            },
            c: {
                opcode: 'looks_say', next: null, parent: 'b',
                inputs: {MESSAGE: [3, 'd', [10, 'inactive fallback']]}, fields: {},
                shadow: false, topLevel: false
            },
            d: {
                opcode: 'operator_join', next: null, parent: 'c',
                inputs: {STRING1: literalInput('hello'), STRING2: literalInput('world')}, fields: {},
                shadow: false, topLevel: false
            }
        };
        const result = preflightPseudocodeRoundTrip(blocks, ctx, {includeCoords: false});
        expect(result.safe).toBe(true);
        expect(result.readOnly).toBe(false);
        expect(result.reasons).toEqual([]);
    });

    test('explicit non-top-level orphan scripts stay hidden and force read-only', () => {
        const blocks = {
            real: {
                opcode: 'looks_say', next: null, parent: null,
                inputs: {MESSAGE: literalInput('real script')}, fields: {}, shadow: false, topLevel: true
            },
            legacy: {
                opcode: 'looks_say', next: null, parent: null,
                inputs: {MESSAGE: literalInput('legacy root')}, fields: {}, shadow: false
            },
            orphan: {
                opcode: 'looks_say', next: null, parent: null,
                inputs: {MESSAGE: literalInput('hidden orphan')}, fields: {}, shadow: false, topLevel: false
            }
        };

        const result = preflightPseudocodeRoundTrip(blocks, makeContext(), {includeCoords: false});
        expect(result.rendered).toContain('real script');
        expect(result.rendered).toContain('legacy root');
        expect(result.rendered).not.toContain('hidden orphan');
        expect(result.readOnly).toBe(true);
        expect(result.reasons.join(' ')).toMatch(/explicit non-top-level orphan/);
        expect(result.comparison.equal).toBe(true);
    });

    test('known empty substacks canonicalize missing and [1, null] equally while @op stays strict', () => {
        const knownWithNull = {
            control: {
                opcode: 'control_if_else', next: null, parent: null,
                inputs: {SUBSTACK: [1, null]}, fields: {}, shadow: false, topLevel: true
            }
        };
        const knownMissing = {
            parsed: {
                opcode: 'control_if_else', next: null, parent: null,
                inputs: {}, fields: {}, shadow: false, topLevel: true
            }
        };
        expect(comparePseudocodeRoundTrip(knownWithNull, knownMissing).equal).toBe(true);

        const unknownWithNull = {
            extension: {
                opcode: 'extension_branch', next: null, parent: null,
                inputs: {SUBSTACK: [1, null]}, fields: {}, shadow: false, topLevel: true
            }
        };
        const unknownMissing = {
            parsed: {
                opcode: 'extension_branch', next: null, parent: null,
                inputs: {}, fields: {}, shadow: false, topLevel: true
            }
        };
        expect(comparePseudocodeRoundTrip(unknownWithNull, unknownMissing).equal).toBe(false);
    });

    test('known empty substacks do not differ only because the omitted branch is appended later', () => {
        const original = {
            control: {
                opcode: 'control_if_else', next: null, parent: null,
                inputs: {SUBSTACK: [1, null], SUBSTACK2: [2, 'else-body']},
                fields: {}, shadow: false, topLevel: true
            },
            'else-body': {
                opcode: 'looks_say', next: null, parent: 'control',
                inputs: {MESSAGE: literalInput('else')}, fields: {}, shadow: false, topLevel: false
            }
        };
        const roundTripped = {
            parsed: {
                opcode: 'control_if_else', next: null, parent: null,
                inputs: {SUBSTACK2: [2, 'parsed-else-body']},
                fields: {}, shadow: false, topLevel: true
            },
            'parsed-else-body': {
                opcode: 'looks_say', next: null, parent: 'parsed',
                inputs: {MESSAGE: literalInput('else')}, fields: {}, shadow: false, topLevel: false
            }
        };

        const comparison = comparePseudocodeRoundTrip(original, roundTripped);
        expect(comparison.equal).toBe(true);
        expect(comparison.reasons).toEqual([]);
    });

    test('letter_of preserves Scratch positive-integer input type 6', () => {
        const blocks = {
            letter: {
                opcode: 'operator_letter_of', next: null, parent: null,
                inputs: {LETTER: [1, [6, '1']], STRING: literalInput('abc')},
                fields: {}, shadow: false, topLevel: true
            }
        };

        const result = preflightPseudocodeRoundTrip(blocks, makeContext(), {includeCoords: false});
        expect(result.safe).toBe(true);
        const parsedLetter = Object.values(result.parsed.blocks).find(block => (
            block && !Array.isArray(block) && block.opcode === 'operator_letter_of'
        ));
        expect(parsedLetter.inputs.LETTER).toEqual([1, [6, '1']]);
    });

    test('known menu shadows ignore an omitted dropdown ID placeholder', () => {
        const blocks = {
            key: {
                opcode: 'sensing_keypressed', next: null, parent: null,
                inputs: {KEY_OPTION: [1, 'menu']}, fields: {}, shadow: false, topLevel: true
            },
            menu: {
                opcode: 'sensing_keyoptions', next: null, parent: 'key', inputs: {},
                fields: {KEY_OPTION: ['space']}, shadow: true, topLevel: false
            }
        };

        const result = preflightPseudocodeRoundTrip(blocks, makeContext(), {includeCoords: false});
        expect(result.safe).toBe(true);
        expect(result.reasons).toEqual([]);
        const parsedMenu = Object.values(result.parsed.blocks).find(block => (
            block && !Array.isArray(block) && block.opcode === 'sensing_keyoptions'
        ));
        expect(parsedMenu.fields.KEY_OPTION).toEqual(['space', null]);
    });

    test('sound effects and drag mode use friendly core syntax instead of @op', () => {
        const blocks = {
            hat: {
                opcode: 'event_whenflagclicked', next: 'change-effect', parent: null,
                inputs: {}, fields: {}, shadow: false, topLevel: true
            },
            'change-effect': {
                opcode: 'sound_changeeffectby', next: 'set-effect', parent: 'hat',
                inputs: {VALUE: numericInput(10)}, fields: {EFFECT: ['PITCH', null]},
                shadow: false, topLevel: false
            },
            'set-effect': {
                opcode: 'sound_seteffectto', next: 'clear-effects', parent: 'change-effect',
                inputs: {VALUE: numericInput(100)}, fields: {EFFECT: ['PAN', null]},
                shadow: false, topLevel: false
            },
            'clear-effects': {
                opcode: 'sound_cleareffects', next: 'drag-mode', parent: 'set-effect',
                inputs: {}, fields: {}, shadow: false, topLevel: false
            },
            'drag-mode': {
                opcode: 'sensing_setdragmode', next: null, parent: 'clear-effects',
                inputs: {}, fields: {DRAG_MODE: ['draggable', null]}, shadow: false, topLevel: false
            }
        };

        const result = preflightPseudocodeRoundTrip(blocks, makeContext(), {includeCoords: false});
        expect(result.rendered).toContain('change_sound_effect("PITCH", 10)');
        expect(result.rendered).toContain('set_sound_effect("PAN", 100)');
        expect(result.rendered).toContain('clear_sound_effects()');
        expect(result.rendered).toContain('set_drag_mode("draggable")');
        expect(result.rendered).not.toContain('@op(');
        expect(result.parsed.errors).toEqual([]);
        expect(result.safe).toBe(true);
    });

    test.each(['.000', '001', '1e+02'])('type 10 numeric text preserves its lexical spelling: %s', raw => {
        const blocks = {
            say: {
                opcode: 'looks_say', next: null, parent: null,
                inputs: {MESSAGE: [1, [10, raw]]}, fields: {}, shadow: false, topLevel: true
            }
        };

        const result = preflightPseudocodeRoundTrip(blocks, makeContext(), {includeCoords: false});
        expect(result.safe).toBe(true);
        expect(result.rendered).toContain(`say(${raw})`);
        const parsedSay = Object.values(result.parsed.blocks).find(block => (
            block && !Array.isArray(block) && block.opcode === 'looks_say'
        ));
        expect(parsedSay.inputs.MESSAGE).toEqual([1, [10, raw]]);
    });

    test('procedure calls rebuild value and boolean inputs from proccode placeholders', () => {
        const proccode = 'custom %s %b %n';
        const argumentIds = ['text-id', 'boolean-id', 'number-id'];
        const callMutation = {
            tagName: 'mutation',
            children: [],
            proccode,
            argumentids: JSON.stringify(argumentIds),
            warp: 'true'
        };
        const prototype = {
            opcode: 'procedures_prototype',
            next: null,
            parent: null,
            inputs: {},
            fields: {},
            mutation: {
                ...callMutation,
                argumentnames: JSON.stringify(['text', 'condition', 'number']),
                argumentdefaults: JSON.stringify(['', 'false', ''])
            },
            shadow: true,
            topLevel: false
        };
        const blocks = {
            call: {
                opcode: 'procedures_call', next: null, parent: null,
                inputs: {
                    'text-id': [3, 'text-reporter', [10, 'inactive text fallback']],
                    'boolean-id': [2, 'boolean-reporter'],
                    'number-id': [3, [12, 'score', 'score-id'], [10, 'inactive number fallback']]
                },
                fields: {}, mutation: callMutation, shadow: false, topLevel: true
            },
            'text-reporter': {
                opcode: 'operator_join', next: null, parent: 'call',
                inputs: {STRING1: literalInput('left'), STRING2: literalInput('right')},
                fields: {}, shadow: false, topLevel: false
            },
            'boolean-reporter': {
                opcode: 'operator_equals', next: null, parent: 'call',
                inputs: {OPERAND1: literalInput('left'), OPERAND2: literalInput('right')},
                fields: {}, shadow: false, topLevel: false
            }
        };
        const ctx = makeContext({
            locals: [makeVariable('score-id', 'score')],
            blocks: {prototype}
        });

        const result = preflightPseudocodeRoundTrip(blocks, ctx, {includeCoords: false});
        expect(result.rendered).not.toContain('@op("procedures_call"');
        expect(result.parsed.errors).toEqual([]);
        expect(result.safe).toBe(true);
        expect(result.reasons).toEqual([]);

        const parsedCall = Object.values(result.parsed.blocks).find(block => (
            block && !Array.isArray(block) && block.opcode === 'procedures_call'
        ));
        expect(parsedCall.mutation).toEqual(callMutation);
        expect(parsedCall.inputs['text-id'][0]).toBe(3);
        expect(result.parsed.blocks[parsedCall.inputs['text-id'][1]].opcode).toBe('operator_join');
        expect(parsedCall.inputs['boolean-id'][0]).toBe(2);
        expect(result.parsed.blocks[parsedCall.inputs['boolean-id'][1]].opcode).toBe('operator_equals');
        expect(parsedCall.inputs['number-id'][0]).toBe(3);
        expect(parsedCall.inputs['number-id'][1]).toEqual([12, 'score', 'score-id']);
    });

    test('procedure-call canonical comparison ignores fallbacks but preserves active values and mutation', () => {
        const mutation = {
            tagName: 'mutation',
            children: [],
            proccode: 'report %s',
            argumentids: '["value-id"]',
            warp: 'false',
            return: '1'
        };
        const original = {
            call: {
                opcode: 'procedures_call', next: null, parent: null,
                inputs: {'value-id': [3, [12, 'score', 'score-id'], [10, 'old fallback']]},
                fields: {}, mutation, shadow: false, topLevel: true
            }
        };
        const sameActiveValue = {
            parsed: {
                opcode: 'procedures_call', next: null, parent: null,
                inputs: {'value-id': [3, [12, 'score', 'score-id'], [10, 'new fallback']]},
                fields: {}, mutation: {...mutation}, shadow: false, topLevel: true
            }
        };
        expect(comparePseudocodeRoundTrip(original, sameActiveValue).equal).toBe(true);

        const changedActiveValue = JSON.parse(JSON.stringify(sameActiveValue));
        changedActiveValue.parsed.inputs['value-id'][1] = [12, 'other', 'other-id'];
        expect(comparePseudocodeRoundTrip(original, changedActiveValue).equal).toBe(false);

        const mutationChanges = [
            ['proccode', 'other %s'],
            ['argumentids', '["other-id"]'],
            ['warp', 'true'],
            ['return', '0']
        ];
        for (const [key, value] of mutationChanges) {
            const changed = JSON.parse(JSON.stringify(sameActiveValue));
            changed.parsed.mutation[key] = value;
            expect(comparePseudocodeRoundTrip(original, changed).equal).toBe(false);
        }
    });

    test.each([
        ['pen_stamp %s'],
        ['图章 %s']
    ])('procedure name colliding with an opcode or alias uses the quoted full proccode: %s', proccode => {
        const argumentIds = ['value-id'];
        const mutation = {
            tagName: 'mutation', children: [], proccode,
            argumentids: JSON.stringify(argumentIds), warp: 'false'
        };
        const blocks = {
            call: {
                opcode: 'procedures_call', next: null, parent: null,
                inputs: {'value-id': literalInput('hello')},
                fields: {}, mutation, shadow: false, topLevel: true
            }
        };
        const ctx = makeContext({
            blocks: {
                prototype: {
                    opcode: 'procedures_prototype', inputs: {}, fields: {}, mutation,
                    shadow: true, topLevel: false
                }
            }
        });

        const result = preflightPseudocodeRoundTrip(blocks, ctx, {includeCoords: false});
        expect(result.rendered).toContain(`${JSON.stringify(proccode)}("hello")`);
        expect(result.parsed.errors).toEqual([]);
        expect(result.safe).toBe(true);
        const parsedOpcodes = Object.values(result.parsed.blocks)
            .filter(block => block && !Array.isArray(block))
            .map(block => block.opcode);
        expect(parsedOpcodes).toContain('procedures_call');
        expect(parsedOpcodes).not.toContain('pen_stamp');
    });

    test.each([0, 1, 2, 3])(
        'an unchanged %i-argument prototype restores its complete VM mutation',
        argumentCount => {
            const argumentIds = Array.from({length: argumentCount}, (_, i) => `argument-id-${i}`);
            const argumentNames = Array.from({length: argumentCount}, (_, i) => `argument_${i}`);
            const argumentTypes = Array.from({length: argumentCount}, (_, i) => i % 2 ? 'b' : 's');
            const placeholders = argumentTypes.map(type => type === 'b' ? '%b' : '%s').join(' ');
            const proccode = `preserve_${argumentCount}${placeholders ? ` ${placeholders}` : ''}`;
            const argumentDefaults = Array.from(
                {length: argumentCount + 2},
                (_, i) => `noncanonical-default-${i}`
            );
            const fixture = makeProcedureDefinitionBlocks({
                proccode,
                argumentIds,
                argumentNames,
                argumentTypes,
                argumentDefaults,
                warp: 'true',
                mutationExtra: {unknownField: {nested: ['keep', argumentCount]}}
            });
            const ctx = makeContext({blocks: fixture.blocks});

            const result = preflightPseudocodeRoundTrip(fixture.blocks, ctx, {includeCoords: false});
            expect(result.parsed.errors).toEqual([]);
            expect(result.safe).toBe(true);
            const parsedPrototype = Object.values(result.parsed.blocks).find(block => (
                block && !Array.isArray(block) && block.opcode === 'procedures_prototype'
            ));
            expect(parsedPrototype.mutation).toEqual(fixture.mutation);
        }
    );

    test('a changed procedure signature gets a canonical prototype mutation', () => {
        const fixture = makeProcedureDefinitionBlocks({
            proccode: 'rename %s',
            argumentIds: ['argument-id'],
            argumentNames: ['old_name'],
            argumentTypes: ['s'],
            argumentDefaults: ['', 'extra default'],
            mutationExtra: {unknownField: 'remove when signature changes'}
        });
        const parsed = pseudocode.parsePseudocode(
            'define "rename %s"(new_name) {\n}\n',
            makeContext({blocks: fixture.blocks})
        );

        expect(parsed.errors).toEqual([]);
        const prototype = Object.values(parsed.blocks).find(block => (
            block && !Array.isArray(block) && block.opcode === 'procedures_prototype'
        ));
        expect(prototype.mutation).toEqual({
            tagName: 'mutation',
            children: [],
            proccode: 'rename %s',
            argumentids: '["argument-id"]',
            argumentnames: '["new_name"]',
            argumentdefaults: '[""]',
            warp: 'false'
        });
    });

    test('multiple VM prototypes with one proccode reject writeback instead of guessing', () => {
        const fixture = makeProcedureDefinitionBlocks({
            proccode: 'ambiguous %s',
            argumentIds: ['argument-id'],
            argumentNames: ['value'],
            argumentTypes: ['s']
        });
        const duplicatePrototype = JSON.parse(JSON.stringify(fixture.blocks.prototype));
        const ctx = makeContext({
            blocks: {...fixture.blocks, duplicatePrototype}
        });

        const result = preflightPseudocodeRoundTrip(fixture.blocks, ctx, {includeCoords: false});
        expect(result.readOnly).toBe(true);
        expect(result.reasons.join(' ')).toMatch(/多个 prototype/);
    });

    test('procedure parameters colliding with aliases and keywords render as explicit arg calls', () => {
        const argumentNames = ['大小', '克隆', 'true', 'size', 'runtime_alias'];
        const argumentIds = argumentNames.map((_, i) => `argument-id-${i}`);
        const argumentTypes = ['s', 's', 's', 's', 'b'];
        const fixture = makeProcedureDefinitionBlocks({
            proccode: 'use_args %s %s %s %s %b',
            argumentIds,
            argumentNames,
            argumentTypes
        });
        const statementIds = [];
        for (let i = 0; i < 4; i++) {
            const statementId = `say-${i}`;
            const reporterId = `body-arg-${i}`;
            statementIds.push(statementId);
            fixture.blocks[statementId] = {
                opcode: 'looks_say', next: null, parent: null,
                inputs: {MESSAGE: [3, reporterId, [10, '']]}, fields: {}, shadow: false, topLevel: false
            };
            fixture.blocks[reporterId] = {
                opcode: 'argument_reporter_string_number', next: null, parent: statementId,
                inputs: {}, fields: {VALUE: [argumentNames[i], null]}, shadow: false, topLevel: false
            };
        }
        const conditionId = 'condition';
        fixture.blocks[conditionId] = {
            opcode: 'control_if', next: null, parent: null,
            inputs: {CONDITION: [2, 'body-arg-4']}, fields: {}, shadow: false, topLevel: false
        };
        fixture.blocks['body-arg-4'] = {
            opcode: 'argument_reporter_boolean', next: null, parent: conditionId,
            inputs: {}, fields: {VALUE: ['runtime_alias', null]}, shadow: false, topLevel: false
        };
        statementIds.push(conditionId);
        fixture.blocks.definition.next = statementIds[0];
        for (let i = 0; i < statementIds.length; i++) {
            const statement = fixture.blocks[statementIds[i]];
            statement.parent = i === 0 ? 'definition' : statementIds[i - 1];
            statement.next = statementIds[i + 1] || null;
        }
        const runtimeBlockInfo = [{
            id: 'runtime',
            blocks: [{
                info: {opcode: 'alias', blockType: 'reporter', text: 'runtime alias', arguments: {}},
                json: {type: 'runtime_alias'}
            }]
        }];
        const ctx = makeContext({blocks: fixture.blocks, runtimeBlockInfo});

        const result = preflightPseudocodeRoundTrip(fixture.blocks, ctx, {includeCoords: false});
        expect(result.rendered).toContain('arg("大小")');
        expect(result.rendered).toContain('arg("克隆")');
        expect(result.rendered).toContain('arg("true")');
        expect(result.rendered).toContain('arg("size")');
        expect(result.rendered).toContain('arg_bool("runtime_alias")');
        expect(result.parsed.errors).toEqual([]);
        expect(result.safe).toBe(true);
        const parsedBlocks = Object.values(result.parsed.blocks)
            .filter(block => block && !Array.isArray(block));
        expect(parsedBlocks.some(block => block.opcode === 'looks_size')).toBe(false);
        const bodyArgumentNames = parsedBlocks
            .filter(block => block.opcode.indexOf('argument_reporter_') === 0 && !block.shadow)
            .map(block => block.fields.VALUE[0]);
        expect(bodyArgumentNames).toEqual(argumentNames);
    });

    test('@op with a multi-statement substack is read-only', () => {
        const ctx = makeContext();
        const blocks = {
            a: {
                opcode: 'extension_branch', next: null, parent: null,
                inputs: {SUBSTACK: [2, 'b']}, fields: {}, shadow: false, topLevel: true
            },
            b: {
                opcode: 'looks_say', next: 'c', parent: 'a',
                inputs: {MESSAGE: literalInput('one')}, fields: {}, shadow: false, topLevel: false
            },
            c: {
                opcode: 'looks_say', next: null, parent: 'b',
                inputs: {MESSAGE: literalInput('two')}, fields: {}, shadow: false, topLevel: false
            }
        };
        const result = preflightPseudocodeRoundTrip(blocks, ctx, {includeCoords: false});
        expect(result.safe).toBe(false);
        expect(result.readOnly).toBe(true);
        expect(result.reasons.join(' ')).toMatch(/multi-statement substack/);
    });

    test('exact duplicates are renderable but rejected for writeback', () => {
        const ctx = makeContext({
            locals: [
                makeVariable('duplicate-a', 'score'),
                makeVariable('duplicate-b', 'score')
            ]
        });
        const result = preflightPseudocodeRoundTrip({}, ctx, {includeCoords: false});
        expect(result.rendered).toContain('"score" as local_score');
        expect(result.rendered).toContain('"score" as local_score_2');
        expect(result.readOnly).toBe(true);
        expect(result.reason).toMatch(/exact duplicates in the same scope/);
    });
});
