/* eslint-disable */
// 伪代码 ↔ SB3 blocks 往返转换
// 输入输出都用"a/b/c 短 ID"形态（与 userscript.js 的 remapBlockIdsForEditor 对齐）。
// 支持：常用 ~80 个 opcode 使用友好名；其余走 op("opcode", inputs={...}, fields={...}) 通用语法。
//
// 往返原则：
//   - 每次导出都会在头部附带 vars/lists 名-ID 映射表（#vars{ ... }）；广播由引用自动创建
//   - 导出顶层脚本时带 at(x, y) 位置注解
//   - primType 由 OPCODE_DEFS 的 args 声明决定；reporter 作输入时自动包 [3, ..., shadow]
//   - menu shadow（如 motion_goto_menu）由 args 的 menu 元信息自动生成/解析
//   - 未登记的 opcode 用通用 op(...) 形式，mutation 原样保留

// ========================= OPCODE TABLE =========================
// kind: 'hat' | 'stmt' | 'c' | 'if-else' | 'reporter' | 'boolean' | 'cap'
// args: 按调用位置排列；{type: 'input'|'field', name, primType?, menu?}
//   primType: 4 math_number, 5 positive_number, 6 positive_integer, 7 integer,
//             8 angle, 9 color, 10 text, 11 broadcast, 12 variable, 13 list.
//             对布尔输入用 null（不配 shadow，写 [2, blockRef]）。
//   menu: {opcode, field} — 此输入需要配一个菜单 shadow 块；用字符串字面量传值
// substacks: substack input 名称数组（c / if-else 专用）
// infix: {op, prec} — 若存在，则 reporter 用中缀形式渲染
// prefix: {op, prec} — 一元前缀（operator_not 等）
const OPCODE_DEFS = [
    // ========== HATS ==========
    {opcode: 'event_whenflagclicked', name: 'on_flag_clicked', kind: 'hat', args: []},
    {opcode: 'event_whenbroadcastreceived', name: 'on_broadcast', kind: 'hat', args: [
        {type: 'field', name: 'BROADCAST_OPTION', kind: 'broadcast'}
    ]},
    {opcode: 'event_whenkeypressed', name: 'on_key_pressed', kind: 'hat', args: [
        {type: 'field', name: 'KEY_OPTION'}
    ]},
    {opcode: 'event_whenthisspriteclicked', name: 'on_sprite_clicked', kind: 'hat', args: []},
    {opcode: 'event_whenstageclicked', name: 'on_stage_clicked', kind: 'hat', args: []},
    {opcode: 'event_whenbackdropswitchesto', name: 'on_backdrop_switches_to', kind: 'hat', args: [
        {type: 'field', name: 'BACKDROP'}
    ]},
    {opcode: 'event_whengreaterthan', name: 'on_greater_than', kind: 'hat', args: [
        {type: 'field', name: 'WHENGREATERTHANMENU'},
        {type: 'input', name: 'VALUE', primType: 4}
    ]},
    {opcode: 'control_start_as_clone', name: 'on_clone_start', kind: 'hat', args: []},

    // ========== EVENTS (stmt) ==========
    {opcode: 'event_broadcast', name: 'broadcast', kind: 'stmt', args: [
        {type: 'input', name: 'BROADCAST_INPUT', primType: 11}
    ]},
    {opcode: 'event_broadcastandwait', name: 'broadcast_and_wait', kind: 'stmt', args: [
        {type: 'input', name: 'BROADCAST_INPUT', primType: 11}
    ]},

    // ========== CONTROL ==========
    {opcode: 'control_wait', name: 'wait', kind: 'stmt', args: [
        {type: 'input', name: 'DURATION', primType: 5}
    ]},
    {opcode: 'control_repeat', name: 'repeat', kind: 'c', args: [
        {type: 'input', name: 'TIMES', primType: 6}
    ], substacks: ['SUBSTACK']},
    {opcode: 'control_forever', name: 'forever', kind: 'c', args: [], substacks: ['SUBSTACK']},
    {opcode: 'control_if', name: 'if', kind: 'c', args: [
        {type: 'input', name: 'CONDITION', primType: null}
    ], substacks: ['SUBSTACK']},
    {opcode: 'control_if_else', name: 'if_else', kind: 'if-else', args: [
        {type: 'input', name: 'CONDITION', primType: null}
    ], substacks: ['SUBSTACK', 'SUBSTACK2']},
    {opcode: 'control_wait_until', name: 'wait_until', kind: 'stmt', args: [
        {type: 'input', name: 'CONDITION', primType: null}
    ]},
    {opcode: 'control_repeat_until', name: 'repeat_until', kind: 'c', args: [
        {type: 'input', name: 'CONDITION', primType: null}
    ], substacks: ['SUBSTACK']},
    {opcode: 'control_while', name: 'while', kind: 'c', args: [
        {type: 'input', name: 'CONDITION', primType: null}
    ], substacks: ['SUBSTACK']},
    {opcode: 'control_stop', name: 'stop', kind: 'cap', args: [
        {type: 'field', name: 'STOP_OPTION'}
    ]},
    {opcode: 'control_create_clone_of', name: 'create_clone_of', kind: 'stmt', args: [
        {type: 'input', name: 'CLONE_OPTION', primType: null, menu: {opcode: 'control_create_clone_of_menu', field: 'CLONE_OPTION'}}
    ]},
    {opcode: 'control_delete_this_clone', name: 'delete_this_clone', kind: 'cap', args: []},

    // ========== MOTION ==========
    {opcode: 'motion_movesteps', name: 'move', kind: 'stmt', args: [{type: 'input', name: 'STEPS', primType: 4}]},
    {opcode: 'motion_turnright', name: 'turn_right', kind: 'stmt', args: [{type: 'input', name: 'DEGREES', primType: 4}]},
    {opcode: 'motion_turnleft', name: 'turn_left', kind: 'stmt', args: [{type: 'input', name: 'DEGREES', primType: 4}]},
    {opcode: 'motion_gotoxy', name: 'goto_xy', kind: 'stmt', args: [
        {type: 'input', name: 'X', primType: 4}, {type: 'input', name: 'Y', primType: 4}
    ]},
    {opcode: 'motion_goto', name: 'goto', kind: 'stmt', args: [
        {type: 'input', name: 'TO', primType: null, menu: {opcode: 'motion_goto_menu', field: 'TO'}}
    ]},
    {opcode: 'motion_glidesecstoxy', name: 'glide_secs_to_xy', kind: 'stmt', args: [
        {type: 'input', name: 'SECS', primType: 4},
        {type: 'input', name: 'X', primType: 4},
        {type: 'input', name: 'Y', primType: 4}
    ]},
    {opcode: 'motion_glideto', name: 'glide_secs_to', kind: 'stmt', args: [
        {type: 'input', name: 'SECS', primType: 4},
        {type: 'input', name: 'TO', primType: null, menu: {opcode: 'motion_glideto_menu', field: 'TO'}}
    ]},
    {opcode: 'motion_pointindirection', name: 'point_in_direction', kind: 'stmt', args: [{type: 'input', name: 'DIRECTION', primType: 8}]},
    {opcode: 'motion_pointtowards', name: 'point_towards', kind: 'stmt', args: [
        {type: 'input', name: 'TOWARDS', primType: null, menu: {opcode: 'motion_pointtowards_menu', field: 'TOWARDS'}}
    ]},
    {opcode: 'motion_changexby', name: 'change_x', kind: 'stmt', args: [{type: 'input', name: 'DX', primType: 4}]},
    {opcode: 'motion_setx', name: 'set_x', kind: 'stmt', args: [{type: 'input', name: 'X', primType: 4}]},
    {opcode: 'motion_changeyby', name: 'change_y', kind: 'stmt', args: [{type: 'input', name: 'DY', primType: 4}]},
    {opcode: 'motion_sety', name: 'set_y', kind: 'stmt', args: [{type: 'input', name: 'Y', primType: 4}]},
    {opcode: 'motion_ifonedgebounce', name: 'if_on_edge_bounce', kind: 'stmt', args: []},
    {opcode: 'motion_setrotationstyle', name: 'set_rotation_style', kind: 'stmt', args: [{type: 'field', name: 'STYLE'}]},
    {opcode: 'motion_xposition', name: 'x_pos', kind: 'reporter', args: []},
    {opcode: 'motion_yposition', name: 'y_pos', kind: 'reporter', args: []},
    {opcode: 'motion_direction', name: 'direction', kind: 'reporter', args: []},

    // ========== LOOKS ==========
    {opcode: 'looks_say', name: 'say', kind: 'stmt', args: [{type: 'input', name: 'MESSAGE', primType: 10}]},
    {opcode: 'looks_sayforsecs', name: 'say_for', kind: 'stmt', args: [
        {type: 'input', name: 'MESSAGE', primType: 10},
        {type: 'input', name: 'SECS', primType: 4}
    ]},
    {opcode: 'looks_think', name: 'think', kind: 'stmt', args: [{type: 'input', name: 'MESSAGE', primType: 10}]},
    {opcode: 'looks_thinkforsecs', name: 'think_for', kind: 'stmt', args: [
        {type: 'input', name: 'MESSAGE', primType: 10},
        {type: 'input', name: 'SECS', primType: 4}
    ]},
    {opcode: 'looks_switchcostumeto', name: 'switch_costume', kind: 'stmt', args: [
        {type: 'input', name: 'COSTUME', primType: null, menu: {opcode: 'looks_costume', field: 'COSTUME'}}
    ]},
    {opcode: 'looks_nextcostume', name: 'next_costume', kind: 'stmt', args: []},
    {opcode: 'looks_switchbackdropto', name: 'switch_backdrop', kind: 'stmt', args: [
        {type: 'input', name: 'BACKDROP', primType: null, menu: {opcode: 'looks_backdrops', field: 'BACKDROP'}}
    ]},
    {opcode: 'looks_nextbackdrop', name: 'next_backdrop', kind: 'stmt', args: []},
    {opcode: 'looks_changesizeby', name: 'change_size', kind: 'stmt', args: [{type: 'input', name: 'CHANGE', primType: 4}]},
    {opcode: 'looks_setsizeto', name: 'set_size', kind: 'stmt', args: [{type: 'input', name: 'SIZE', primType: 4}]},
    {opcode: 'looks_changeeffectby', name: 'change_effect', kind: 'stmt', args: [
        {type: 'field', name: 'EFFECT'},
        {type: 'input', name: 'CHANGE', primType: 4}
    ]},
    {opcode: 'looks_seteffectto', name: 'set_effect', kind: 'stmt', args: [
        {type: 'field', name: 'EFFECT'},
        {type: 'input', name: 'VALUE', primType: 4}
    ]},
    {opcode: 'looks_cleargraphiceffects', name: 'clear_effects', kind: 'stmt', args: []},
    {opcode: 'looks_show', name: 'show', kind: 'stmt', args: []},
    {opcode: 'looks_hide', name: 'hide', kind: 'stmt', args: []},
    {opcode: 'looks_gotofrontback', name: 'goto_layer', kind: 'stmt', args: [{type: 'field', name: 'FRONT_BACK'}]},
    {opcode: 'looks_goforwardbackwardlayers', name: 'go_layers', kind: 'stmt', args: [
        {type: 'field', name: 'FORWARD_BACKWARD'},
        {type: 'input', name: 'NUM', primType: 7}
    ]},
    {opcode: 'looks_costumenumbername', name: 'costume', kind: 'reporter', args: [{type: 'field', name: 'NUMBER_NAME'}]},
    {opcode: 'looks_backdropnumbername', name: 'backdrop', kind: 'reporter', args: [{type: 'field', name: 'NUMBER_NAME'}]},
    {opcode: 'looks_size', name: 'size', kind: 'reporter', args: []},

    // ========== SOUND ==========
    {opcode: 'sound_play', name: 'play_sound', kind: 'stmt', args: [
        {type: 'input', name: 'SOUND_MENU', primType: null, menu: {opcode: 'sound_sounds_menu', field: 'SOUND_MENU'}}
    ]},
    {opcode: 'sound_playuntildone', name: 'play_sound_until_done', kind: 'stmt', args: [
        {type: 'input', name: 'SOUND_MENU', primType: null, menu: {opcode: 'sound_sounds_menu', field: 'SOUND_MENU'}}
    ]},
    {opcode: 'sound_stopallsounds', name: 'stop_all_sounds', kind: 'stmt', args: []},
    {opcode: 'sound_changevolumeby', name: 'change_volume', kind: 'stmt', args: [{type: 'input', name: 'VOLUME', primType: 4}]},
    {opcode: 'sound_setvolumeto', name: 'set_volume', kind: 'stmt', args: [{type: 'input', name: 'VOLUME', primType: 4}]},
    {opcode: 'sound_volume', name: 'volume', kind: 'reporter', args: []},

    // ========== PEN ==========
    {opcode: 'pen_clear', name: 'pen_clear', kind: 'stmt', args: []},
    {opcode: 'pen_stamp', name: 'pen_stamp', kind: 'stmt', args: []},
    {opcode: 'pen_penDown', name: 'pen_down', kind: 'stmt', args: []},
    {opcode: 'pen_penUp', name: 'pen_up', kind: 'stmt', args: []},
    {opcode: 'pen_setPenColorToColor', name: 'set_pen_color', kind: 'stmt', args: [{type: 'input', name: 'COLOR', primType: 9}]},
    {opcode: 'pen_setPenSizeTo', name: 'set_pen_size', kind: 'stmt', args: [{type: 'input', name: 'SIZE', primType: 4}]},
    {opcode: 'pen_changePenSizeBy', name: 'change_pen_size', kind: 'stmt', args: [{type: 'input', name: 'SIZE', primType: 4}]},

    // ========== SENSING ==========
    {opcode: 'sensing_askandwait', name: 'ask', kind: 'stmt', args: [{type: 'input', name: 'QUESTION', primType: 10}]},
    {opcode: 'sensing_resettimer', name: 'reset_timer', kind: 'stmt', args: []},
    {opcode: 'sensing_answer', name: 'answer', kind: 'reporter', args: []},
    {opcode: 'sensing_mousex', name: 'mouse_x', kind: 'reporter', args: []},
    {opcode: 'sensing_mousey', name: 'mouse_y', kind: 'reporter', args: []},
    {opcode: 'sensing_mousedown', name: 'mouse_down', kind: 'boolean', args: []},
    {opcode: 'sensing_loudness', name: 'loudness', kind: 'reporter', args: []},
    {opcode: 'sensing_timer', name: 'timer', kind: 'reporter', args: []},
    {opcode: 'sensing_dayssince2000', name: 'days_since_2000', kind: 'reporter', args: []},
    {opcode: 'sensing_username', name: 'username', kind: 'reporter', args: []},
    {opcode: 'sensing_current', name: 'current', kind: 'reporter', args: [{type: 'field', name: 'CURRENTMENU'}]},
    {opcode: 'sensing_distanceto', name: 'distance_to', kind: 'reporter', args: [
        {type: 'input', name: 'DISTANCETOMENU', primType: null, menu: {opcode: 'sensing_distancetomenu', field: 'DISTANCETOMENU'}}
    ]},
    {opcode: 'sensing_of', name: 'of', kind: 'reporter', args: [
        {type: 'field', name: 'PROPERTY'},
        {type: 'input', name: 'OBJECT', primType: null, menu: {opcode: 'sensing_of_object_menu', field: 'OBJECT'}}
    ]},
    {opcode: 'sensing_touchingobject', name: 'touching', kind: 'boolean', args: [
        {type: 'input', name: 'TOUCHINGOBJECTMENU', primType: null, menu: {opcode: 'sensing_touchingobjectmenu', field: 'TOUCHINGOBJECTMENU'}}
    ]},
    {opcode: 'sensing_touchingcolor', name: 'touching_color', kind: 'boolean', args: [{type: 'input', name: 'COLOR', primType: 9}]},
    {opcode: 'sensing_coloristouchingcolor', name: 'color_touching_color', kind: 'boolean', args: [
        {type: 'input', name: 'COLOR', primType: 9},
        {type: 'input', name: 'COLOR2', primType: 9}
    ]},
    {opcode: 'sensing_keypressed', name: 'key_pressed', kind: 'boolean', args: [
        {type: 'input', name: 'KEY_OPTION', primType: null, menu: {opcode: 'sensing_keyoptions', field: 'KEY_OPTION'}}
    ]},

    // ========== DATA ==========
    {opcode: 'data_setvariableto', name: 'set', kind: 'stmt', args: [
        {type: 'field', name: 'VARIABLE', kind: 'variable'},
        {type: 'input', name: 'VALUE', primType: 10}
    ]},
    {opcode: 'data_changevariableby', name: 'change_by', kind: 'stmt', args: [
        {type: 'field', name: 'VARIABLE', kind: 'variable'},
        {type: 'input', name: 'VALUE', primType: 4}
    ]},
    {opcode: 'data_showvariable', name: 'show_variable', kind: 'stmt', args: [{type: 'field', name: 'VARIABLE', kind: 'variable'}]},
    {opcode: 'data_hidevariable', name: 'hide_variable', kind: 'stmt', args: [{type: 'field', name: 'VARIABLE', kind: 'variable'}]},
    {opcode: 'data_variable', name: 'var', kind: 'reporter', args: [{type: 'field', name: 'VARIABLE', kind: 'variable'}]},
    {opcode: 'data_addtolist', name: 'list_add', kind: 'stmt', args: [
        {type: 'field', name: 'LIST', kind: 'list'},
        {type: 'input', name: 'ITEM', primType: 10}
    ]},
    {opcode: 'data_deleteoflist', name: 'list_delete', kind: 'stmt', args: [
        {type: 'field', name: 'LIST', kind: 'list'},
        {type: 'input', name: 'INDEX', primType: 7}
    ]},
    {opcode: 'data_deletealloflist', name: 'list_delete_all', kind: 'stmt', args: [{type: 'field', name: 'LIST', kind: 'list'}]},
    {opcode: 'data_insertatlist', name: 'list_insert', kind: 'stmt', args: [
        {type: 'field', name: 'LIST', kind: 'list'},
        {type: 'input', name: 'INDEX', primType: 7},
        {type: 'input', name: 'ITEM', primType: 10}
    ]},
    {opcode: 'data_replaceitemoflist', name: 'list_replace', kind: 'stmt', args: [
        {type: 'field', name: 'LIST', kind: 'list'},
        {type: 'input', name: 'INDEX', primType: 7},
        {type: 'input', name: 'ITEM', primType: 10}
    ]},
    {opcode: 'data_showlist', name: 'list_show', kind: 'stmt', args: [{type: 'field', name: 'LIST', kind: 'list'}]},
    {opcode: 'data_hidelist', name: 'list_hide', kind: 'stmt', args: [{type: 'field', name: 'LIST', kind: 'list'}]},
    {opcode: 'data_listcontents', name: 'list', kind: 'reporter', args: [{type: 'field', name: 'LIST', kind: 'list'}]},
    {opcode: 'data_itemoflist', name: 'list_item', kind: 'reporter', args: [
        {type: 'field', name: 'LIST', kind: 'list'},
        {type: 'input', name: 'INDEX', primType: 7}
    ]},
    {opcode: 'data_itemnumoflist', name: 'list_index_of', kind: 'reporter', args: [
        {type: 'field', name: 'LIST', kind: 'list'},
        {type: 'input', name: 'ITEM', primType: 10}
    ]},
    {opcode: 'data_lengthoflist', name: 'list_length', kind: 'reporter', args: [{type: 'field', name: 'LIST', kind: 'list'}]},
    {opcode: 'data_listcontainsitem', name: 'list_contains', kind: 'boolean', args: [
        {type: 'field', name: 'LIST', kind: 'list'},
        {type: 'input', name: 'ITEM', primType: 10}
    ]},

    // ========== OPERATORS ==========
    {opcode: 'operator_add', name: 'add', kind: 'reporter', args: [
        {type: 'input', name: 'NUM1', primType: 4},
        {type: 'input', name: 'NUM2', primType: 4}
    ], infix: {op: '+', prec: 8}},
    {opcode: 'operator_subtract', name: 'sub', kind: 'reporter', args: [
        {type: 'input', name: 'NUM1', primType: 4},
        {type: 'input', name: 'NUM2', primType: 4}
    ], infix: {op: '-', prec: 8}},
    {opcode: 'operator_multiply', name: 'mul', kind: 'reporter', args: [
        {type: 'input', name: 'NUM1', primType: 4},
        {type: 'input', name: 'NUM2', primType: 4}
    ], infix: {op: '*', prec: 9}},
    {opcode: 'operator_divide', name: 'div', kind: 'reporter', args: [
        {type: 'input', name: 'NUM1', primType: 4},
        {type: 'input', name: 'NUM2', primType: 4}
    ], infix: {op: '/', prec: 9}},
    {opcode: 'operator_mod', name: 'mod', kind: 'reporter', args: [
        {type: 'input', name: 'NUM1', primType: 4},
        {type: 'input', name: 'NUM2', primType: 4}
    ], infix: {op: '%', prec: 9}},
    {opcode: 'operator_random', name: 'random', kind: 'reporter', args: [
        {type: 'input', name: 'FROM', primType: 4},
        {type: 'input', name: 'TO', primType: 4}
    ]},
    {opcode: 'operator_gt', name: 'gt', kind: 'boolean', args: [
        {type: 'input', name: 'OPERAND1', primType: 10},
        {type: 'input', name: 'OPERAND2', primType: 10}
    ], infix: {op: '>', prec: 6}},
    {opcode: 'operator_lt', name: 'lt', kind: 'boolean', args: [
        {type: 'input', name: 'OPERAND1', primType: 10},
        {type: 'input', name: 'OPERAND2', primType: 10}
    ], infix: {op: '<', prec: 6}},
    {opcode: 'operator_equals', name: 'eq', kind: 'boolean', args: [
        {type: 'input', name: 'OPERAND1', primType: 10},
        {type: 'input', name: 'OPERAND2', primType: 10}
    ], infix: {op: '==', prec: 5}},
    {opcode: 'operator_and', name: 'and', kind: 'boolean', args: [
        {type: 'input', name: 'OPERAND1', primType: null},
        {type: 'input', name: 'OPERAND2', primType: null}
    ], infix: {op: '&&', prec: 4}},
    {opcode: 'operator_or', name: 'or', kind: 'boolean', args: [
        {type: 'input', name: 'OPERAND1', primType: null},
        {type: 'input', name: 'OPERAND2', primType: null}
    ], infix: {op: '||', prec: 3}},
    {opcode: 'operator_not', name: 'not', kind: 'boolean', args: [
        {type: 'input', name: 'OPERAND', primType: null}
    ], prefix: {op: '!', prec: 11}},
    {opcode: 'operator_join', name: 'join', kind: 'reporter', args: [
        {type: 'input', name: 'STRING1', primType: 10},
        {type: 'input', name: 'STRING2', primType: 10}
    ]},
    {opcode: 'operator_letter_of', name: 'letter_of', kind: 'reporter', args: [
        {type: 'input', name: 'LETTER', primType: 7},
        {type: 'input', name: 'STRING', primType: 10}
    ]},
    {opcode: 'operator_length', name: 'length', kind: 'reporter', args: [{type: 'input', name: 'STRING', primType: 10}]},
    {opcode: 'operator_contains', name: 'contains', kind: 'boolean', args: [
        {type: 'input', name: 'STRING1', primType: 10},
        {type: 'input', name: 'STRING2', primType: 10}
    ]},
    {opcode: 'operator_round', name: 'round', kind: 'reporter', args: [{type: 'input', name: 'NUM', primType: 4}]},
    {opcode: 'operator_mathop', name: 'math_op', kind: 'reporter', args: [
        {type: 'field', name: 'OPERATOR'},
        {type: 'input', name: 'NUM', primType: 4}
    ]}
];

// ========================= CHINESE NAMES (1:1 with opcode) =========================
// 所有 cname 必须唯一（parser 用 nameToDef 反查），与 name / opcode 共存三套标识。
const CNAMES = {
    'event_whenflagclicked': '当绿旗被点击',
    'event_whenbroadcastreceived': '当接收到',
    'event_whenkeypressed': '当按下键',
    'event_whenthisspriteclicked': '当角色被点击',
    'event_whenstageclicked': '当舞台被点击',
    'event_whenbackdropswitchesto': '当背景换成',
    'event_whengreaterthan': '当大于',
    'control_start_as_clone': '当作为克隆体启动时',
    'event_broadcast': '广播',
    'event_broadcastandwait': '广播并等待',
    'control_wait': '等待',
    'control_repeat': '重复执行',
    'control_forever': '永远',
    'control_if': '如果',
    'control_if_else': '如果否则',
    'control_wait_until': '等待直到',
    'control_repeat_until': '重复执行直到',
    'control_while': '当循环',
    'control_stop': '停止',
    'control_create_clone_of': '克隆',
    'control_delete_this_clone': '删除此克隆体',
    'motion_movesteps': '移动',
    'motion_turnright': '右转',
    'motion_turnleft': '左转',
    'motion_gotoxy': '移到坐标',
    'motion_goto': '移到',
    'motion_glidesecstoxy': '滑行到坐标',
    'motion_glideto': '滑行到',
    'motion_pointindirection': '面向方向',
    'motion_pointtowards': '面向',
    'motion_changexby': 'x增加',
    'motion_setx': 'x设为',
    'motion_changeyby': 'y增加',
    'motion_sety': 'y设为',
    'motion_ifonedgebounce': '碰到边缘就反弹',
    'motion_setrotationstyle': '设置旋转方式',
    'motion_xposition': 'x坐标',
    'motion_yposition': 'y坐标',
    'motion_direction': '方向',
    'looks_say': '说',
    'looks_sayforsecs': '说几秒',
    'looks_think': '思考',
    'looks_thinkforsecs': '思考几秒',
    'looks_switchcostumeto': '换成造型',
    'looks_nextcostume': '下一个造型',
    'looks_switchbackdropto': '换成背景',
    'looks_nextbackdrop': '下一个背景',
    'looks_changesizeby': '大小增加',
    'looks_setsizeto': '大小设为',
    'looks_changeeffectby': '特效增加',
    'looks_seteffectto': '特效设为',
    'looks_cleargraphiceffects': '清除图形特效',
    'looks_show': '显示',
    'looks_hide': '隐藏',
    'looks_gotofrontback': '移到最',
    'looks_goforwardbackwardlayers': '移层',
    'looks_costumenumbername': '造型',
    'looks_backdropnumbername': '背景',
    'looks_size': '大小',
    'sound_play': '播放声音',
    'sound_playuntildone': '播放声音等待播完',
    'sound_stopallsounds': '停止所有声音',
    'sound_changevolumeby': '音量增加',
    'sound_setvolumeto': '音量设为',
    'sound_volume': '音量',
    'pen_clear': '全部擦除',
    'pen_stamp': '图章',
    'pen_penDown': '落笔',
    'pen_penUp': '抬笔',
    'pen_setPenColorToColor': '画笔颜色设为',
    'pen_setPenSizeTo': '画笔粗细设为',
    'pen_changePenSizeBy': '画笔粗细增加',
    'sensing_askandwait': '询问',
    'sensing_resettimer': '计时器归零',
    'sensing_answer': '回答',
    'sensing_mousex': '鼠标x坐标',
    'sensing_mousey': '鼠标y坐标',
    'sensing_mousedown': '按下鼠标',
    'sensing_loudness': '响度',
    'sensing_timer': '计时器',
    'sensing_dayssince2000': '2000年至今天数',
    'sensing_username': '用户名',
    'sensing_current': '当前时间',
    'sensing_distanceto': '距离',
    'sensing_of': '属性',
    'sensing_touchingobject': '碰到',
    'sensing_touchingcolor': '碰到颜色',
    'sensing_coloristouchingcolor': '颜色碰到颜色',
    'sensing_keypressed': '按键被按下',
    'data_setvariableto': '设置变量',
    'data_changevariableby': '增加',
    'data_showvariable': '显示变量',
    'data_hidevariable': '隐藏变量',
    'data_variable': '变量',
    'data_addtolist': '加入列表',
    'data_deleteoflist': '删除列表项',
    'data_deletealloflist': '删除列表全部',
    'data_insertatlist': '插入列表',
    'data_replaceitemoflist': '替换列表项',
    'data_showlist': '显示列表',
    'data_hidelist': '隐藏列表',
    'data_listcontents': '列表',
    'data_itemoflist': '列表项',
    'data_itemnumoflist': '列表项编号',
    'data_lengthoflist': '列表长度',
    'data_listcontainsitem': '列表包含',
    'operator_add': '加',
    'operator_subtract': '减',
    'operator_multiply': '乘',
    'operator_divide': '除',
    'operator_mod': '取余',
    'operator_random': '随机数',
    'operator_gt': '大于',
    'operator_lt': '小于',
    'operator_equals': '等于',
    'operator_and': '与',
    'operator_or': '或',
    'operator_not': '非',
    'operator_join': '连接',
    'operator_letter_of': '字符',
    'operator_length': '长度',
    'operator_contains': '包含',
    'operator_round': '四舍五入',
    'operator_mathop': '数学运算'
};
for (const def of OPCODE_DEFS) {
    if (CNAMES[def.opcode]) def.cname = CNAMES[def.opcode];
}

// ========================= LOOKUP MAPS =========================
// nameToDef 同时接受：friendly name（如 repeat）、cname（如 重复）、raw opcode（如 control_repeat）
// —— 三种标识都能在 parser 里直接用。
const opcodeToDef = new Map();
const nameToDef = new Map();
for (const def of OPCODE_DEFS) {
    opcodeToDef.set(def.opcode, def);
    if (def.name) nameToDef.set(def.name, def);
    if (def.cname) nameToDef.set(def.cname, def);
    nameToDef.set(def.opcode, def);
}

const MATH_OP_NAME_TO_OPERATOR = new Map([
    ['abs', 'abs'],
    ['floor', 'floor'],
    ['ceiling', 'ceiling'],
    ['ceil', 'ceiling'],
    ['sqrt', 'sqrt'],
    ['sin', 'sin'],
    ['cos', 'cos'],
    ['tan', 'tan'],
    ['asin', 'asin'],
    ['acos', 'acos'],
    ['atan', 'atan'],
    ['ln', 'ln'],
    ['log', 'log'],
    ['exp', 'e ^'],
    ['e_pow', 'e ^'],
    ['pow_e', 'e ^'],
    ['pow10', '10 ^'],
    ['ten_pow', '10 ^']
]);
const MATH_OP_OPERATOR_TO_NAME = new Map([
    ['abs', 'abs'],
    ['floor', 'floor'],
    ['ceiling', 'ceiling'],
    ['sqrt', 'sqrt'],
    ['sin', 'sin'],
    ['cos', 'cos'],
    ['tan', 'tan'],
    ['asin', 'asin'],
    ['acos', 'acos'],
    ['atan', 'atan'],
    ['ln', 'ln'],
    ['log', 'log'],
    ['e ^', 'exp'],
    ['10 ^', 'pow10']
]);

const normalizeRuntimeBlockKind = value => {
    const text = String(value || '').toLowerCase();
    if (text === 'boolean') return 'boolean';
    if (text === 'reporter') return 'reporter';
    if (text === 'command') return 'stmt';
    if (text === 'hat' || text === 'event') return 'hat';
    if (text === 'conditional' || text === 'loop') return 'c';
    return '';
};

const runtimeArgPrimType = value => {
    const text = String(value || '').toLowerCase();
    if (text === 'boolean') return null;
    if (text === 'angle') return 8;
    if (text === 'color' || text === 'colour') return 9;
    if (text === 'number' || text === 'note') return 4;
    return 10;
};

const runtimeMaybeMessageText = value => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'object') {
        return String(value.default || value.defaultMessage || value.message || value.id || '');
    }
    return '';
};

const runtimeBlockArgumentOrder = info => {
    const args = info && info.arguments && typeof info.arguments === 'object' ? info.arguments : {};
    const texts = Array.isArray(info && info.text) ? info.text : [info && info.text];
    const ordered = [];
    for (const value of texts) {
        const text = runtimeMaybeMessageText(value);
        const re = /\[([^\]]+)]/g;
        let match;
        while ((match = re.exec(text))) {
            const name = match[1];
            if (Object.prototype.hasOwnProperty.call(args, name) && ordered.indexOf(name) < 0) {
                ordered.push(name);
            }
        }
    }
    for (const name of Object.keys(args)) {
        if (ordered.indexOf(name) < 0) ordered.push(name);
    }
    return ordered;
};

const runtimeOpcodeCanUseCallSyntax = opcode =>
    /^[a-zA-Z_$\u4e00-\u9fa5][a-zA-Z_0-9$\u4e00-\u9fa5]*$/.test(String(opcode || ''));

const getRuntimeOpcodeMetadata = ctx => {
    const runtime = ctx && ctx.vm && ctx.vm.runtime;
    const blockInfo = Array.isArray(runtime && runtime._blockInfo) ? runtime._blockInfo : [];
    const byOpcode = new Map();
    for (const category of blockInfo) {
        if (!category || !Array.isArray(category.blocks)) continue;
        const categoryId = String(category.id || '');
        const menuInfo = category.menuInfo || {};
        for (const convertedBlock of category.blocks) {
            const info = convertedBlock && convertedBlock.info;
            if (!info || typeof info !== 'object') continue;
            const rawOpcode = info.opcode == null ? '' : String(info.opcode);
            const json = convertedBlock && convertedBlock.json;
            const opcode = json && json.type ? String(json.type) :
                (categoryId && rawOpcode ? `${categoryId}_${rawOpcode}` : rawOpcode);
            if (!opcode) continue;
            const args = {};
            const argInfo = info.arguments && typeof info.arguments === 'object' ? info.arguments : {};
            for (const name of Object.keys(argInfo)) {
                const arg = argInfo[name] && typeof argInfo[name] === 'object' ? argInfo[name] : {};
                const menu = arg.menu && menuInfo ? menuInfo[arg.menu] : null;
                const menuAcceptsReporters = !!(arg.menu && menu && menu.acceptReporters);
                args[name] = {
                    name,
                    kind: arg.menu && !menuAcceptsReporters ? 'field' : 'input',
                    primType: runtimeArgPrimType(arg.type),
                    type: String(arg.type || '')
                };
            }
            const kind = normalizeRuntimeBlockKind(info.blockType);
            const orderedNames = runtimeBlockArgumentOrder(info);
            const orderedArgs = [];
            for (const name of orderedNames) {
                const arg = argInfo[name] && typeof argInfo[name] === 'object' ? argInfo[name] : {};
                if (String(arg.type || '').toLowerCase() === 'image') continue;
                const menu = arg.menu && menuInfo ? menuInfo[arg.menu] : null;
                const menuAcceptsReporters = !!(arg.menu && menu && menu.acceptReporters);
                if (arg.menu && !menuAcceptsReporters) {
                    orderedArgs.push({type: 'field', name});
                } else if (arg.menu) {
                    orderedArgs.push({
                        type: 'input',
                        name,
                        primType: null,
                        menu: {opcode: `${categoryId}_menu_${arg.menu}`, field: arg.menu}
                    });
                } else {
                    orderedArgs.push({type: 'input', name, primType: runtimeArgPrimType(arg.type)});
                }
            }
            const branchCount = Math.max(0, Number(info.branchCount) || 0);
            const substacks = [];
            for (let i = 0; i < branchCount; i++) substacks.push(`SUBSTACK${i > 0 ? i + 1 : ''}`);
            const def = runtimeOpcodeCanUseCallSyntax(opcode) && kind && !info.isDynamic ? {
                opcode,
                name: opcode,
                kind: kind === 'stmt' && info.isTerminal ? 'cap' : kind,
                args: orderedArgs,
                substacks,
                runtime: true
            } : null;
            byOpcode.set(opcode, {
                opcode,
                kind,
                blockType: String(info.blockType || ''),
                args,
                def
            });
        }
    }
    return byOpcode;
};

const getRuntimeOpcodeDefinitions = metadata => {
    const opcodeToRuntimeDef = new Map();
    const nameToRuntimeDef = new Map();
    for (const meta of metadata.values()) {
        const def = meta && meta.def;
        if (!def || opcodeToDef.has(def.opcode) || nameToDef.has(def.name)) continue;
        opcodeToRuntimeDef.set(def.opcode, def);
        nameToRuntimeDef.set(def.name, def);
    }
    return {opcodeToRuntimeDef, nameToRuntimeDef};
};

// ========================= UTIL =========================
const IDENT_RE = /^[a-zA-Z_][a-zA-Z_0-9]*$/;
// 包含 CJK 的合法标识符（用于裸引用变量名）
const BARE_IDENT_RE = /^[a-zA-Z_\u4e00-\u9fa5][a-zA-Z_0-9\u4e00-\u9fa5]*$/;
const escapeString = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
const isNumericLiteral = s => /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(String(s));
const indent = (n) => '    '.repeat(n);

// proccode 简化工具：`name %s %b ...`（首 token 后仅跟空格分隔的 %b/%s/%n 占位符）才算"简单"，
// 能把"定义/调用"渲染成 `name(args)` 形式省略引号和占位符；复杂 proccode 保留完整 "..." 形式。
const PROC_SIMPLE_RE = /^([^\s%]+)((?:\s+%[bsn])*)\s*$/;
const PROC_PLACEHOLDER_RE = /%[bsn]/;
const isSimpleProccode = (proccode) => PROC_SIMPLE_RE.test(String(proccode));
const getProcName = (proccode) => String(proccode).split(/\s+/)[0] || '';
const extractProcTypesFromProccode = (proccode) => {
    const m = String(proccode).match(/%[bsn]/g) || [];
    return m.map(x => x === '%b' ? 'b' : 's');
};
// 渲染 proccode 为 token：简单且 name 是合法 bare ident → 省引号；否则完整 "proccode"
const renderProcToken = (proccode) => {
    const s = String(proccode);
    if (isSimpleProccode(s)) {
        const name = getProcName(s);
        if (BARE_IDENT_RE.test(name)) return name;
    }
    return escapeString(s);
};
// 解析 name + paramTypes → 完整 proccode（当用户给的 proccode 没写占位符时用）
const composeProccode = (name, paramTypes) => {
    if (!paramTypes || !paramTypes.length) return name;
    return name + ' ' + paramTypes.map(t => t === 'b' ? '%b' : '%s').join(' ');
};

// 把任意变量名规范成标识符形态：非 [a-zA-Z_0-9 CJK] 的字符替换成 "_"，前导数字补 "_"。
// 用于 (1) 渲染裸变量名；(2) 补全候选；(3) 解析时反查被下划线化过的名字。
const sanitizeIdent = (name) => {
    if (!name) return '';
    let r = '';
    for (const ch of String(name)) r += /[a-zA-Z_0-9\u4e00-\u9fa5]/.test(ch) ? ch : '_';
    if (/^[0-9]/.test(r)) r = '_' + r;
    return r;
};

// 把短 ID 序列拓展器（与 userscript.js 中 shortIdAt 对齐 — 单独维护以解耦）
const shortIdAt = index => {
    let n = index, s = '';
    while (true) {
        s = String.fromCharCode(97 + (n % 26)) + s;
        n = Math.floor(n / 26);
        if (n === 0) break;
        n -= 1;
    }
    return s;
};

// ========================= RENDERER =========================
// blocks: SB3 压缩形态（短 ID 键）；ctx: {target, vm}
// 输出：伪代码字符串
const renderPseudocode = (blocks, ctx, options) => {
    const includeCoords = !options || options.includeCoords !== false;
    const targetComments = (ctx && ctx.target && ctx.target.comments) || {};
    // 1) 先把压缩 primitive 块展开——我们在渲染器内部操作时，反而更方便处理"规整"形态。
    //    不修改输入：深拷贝。
    const working = JSON.parse(JSON.stringify(blocks));
    const runtimeOpcodeMeta = getRuntimeOpcodeMetadata(ctx);
    const {opcodeToRuntimeDef} = getRuntimeOpcodeDefinitions(runtimeOpcodeMeta);
    const getOpcodeDef = opcode => opcodeToDef.get(opcode) || opcodeToRuntimeDef.get(opcode);
    const shouldRenderGeneric = (block, def) => !!(block && def && def.runtime && block.mutation);
    // 当前 define 作用域的参数名集合：renderBlockAsExpr 里遇到 argument_reporter_*
    // 且 VALUE 名字在这集合里时，裸标识符/字符串渲染（可读）；
    // 否则退回 arg("...") / arg_bool("...") 这种全限定形式（防御无 define 场景）。
    let currentProcArgs = null;
    // 2) 收集所有 variable/broadcast/list 的 name→id 映射（变量/列表用于头部，广播用于引用）
    const varMap = new Map(); // name -> id
    const broadcastMap = new Map();
    const listMap = new Map();
    const collectReference = (fields) => {
        if (!fields) return;
        for (const fieldName of Object.keys(fields)) {
            const f = fields[fieldName];
            if (!Array.isArray(f) || f.length < 2) continue;
            const [name, id] = f;
            if (!id) continue;
            if (fieldName === 'VARIABLE') varMap.set(String(name), id);
            else if (fieldName === 'LIST') listMap.set(String(name), id);
            else if (fieldName === 'BROADCAST_OPTION') broadcastMap.set(String(name), id);
        }
    };
    // 收集一个 primitive 数组里的 name-id 映射（仅 type 11/12/13）
    const collectInlinePrimitive = (arr) => {
        if (!Array.isArray(arr) || arr.length < 3) return;
        const type = arr[0];
        const name = arr[1];
        const refId = arr[2];
        if (!refId) return;
        if (type === 11) broadcastMap.set(String(name), refId);
        else if (type === 12) varMap.set(String(name), refId);
        else if (type === 13) listMap.set(String(name), refId);
    };
    for (const id of Object.keys(working)) {
        const b = working[id];
        if (Array.isArray(b)) {
            collectInlinePrimitive(b);
            continue;
        }
        if (b.fields) collectReference(b.fields);
        // inputs 里的内联 primitive 也要扫（event_broadcast 等块的 BROADCAST_INPUT 就是这种形态）
        if (b.inputs) {
            for (const k of Object.keys(b.inputs)) {
                const input = b.inputs[k];
                if (!Array.isArray(input)) continue;
                for (let i = 1; i < input.length; i++) {
                    if (Array.isArray(input[i])) collectInlinePrimitive(input[i]);
                }
            }
        }
    }

    // 3) 统计 parent 引用，方便定位 top-level。
    //    top-level 既看 `.topLevel: true`，也补充"没 parent 且不作为其他块 input/next 的块"——
    //    压缩 primitive 可能只在 inputs 里出现，不算独立脚本。
    const referencedAsChild = new Set();
    for (const id of Object.keys(working)) {
        const b = working[id];
        if (Array.isArray(b)) continue;
        if (b.next) referencedAsChild.add(b.next);
        if (b.inputs) {
            for (const key of Object.keys(b.inputs)) {
                const input = b.inputs[key];
                if (!Array.isArray(input)) continue;
                for (let i = 1; i < input.length; i++) {
                    const v = input[i];
                    if (typeof v === 'string') referencedAsChild.add(v);
                }
            }
        }
    }

    // 4) 找顶层脚本。按 (y, x) 排序 —— 和工作区视觉顺序一致，
     //    而不是用 JSON 键顺序（两者在用户眼里关联性为零，JSON 里 a/b/c 的物理位置可能很乱）。
     //    缺失坐标按 0 处理，次要 tiebreaker 用键名保持确定性。
    const scripts = [];
    for (const id of Object.keys(working)) {
        const b = working[id];
        if (Array.isArray(b)) continue;
        if (referencedAsChild.has(id)) continue;
        if (b.topLevel === false && b.parent) continue; // 有父就不是顶层
        scripts.push(id);
    }
    scripts.sort((idA, idB) => {
        const a = working[idA];
        const b = working[idB];
        const ay = typeof a.y === 'number' ? a.y : 0;
        const by = typeof b.y === 'number' ? b.y : 0;
        if (ay !== by) return ay - by;
        const ax = typeof a.x === 'number' ? a.x : 0;
        const bx = typeof b.x === 'number' ? b.x : 0;
        if (ax !== bx) return ax - bx;
        // tiebreaker：先按 id 长度再字典序，保持 shortIdAt 产出的 a<b<...<z<aa<ab<... 分配顺序（否则 'aa' < 'b' 会打乱）
        if (idA.length !== idB.length) return idA.length - idB.length;
        return idA < idB ? -1 : (idA > idB ? 1 : 0);
    });

    // 5) 渲染头部：按作用域分成全局 / 局部两组。
    //    "局部" = 当前 sprite target 的 variables 里有这条（sprite-only）；
    //    "全局" = stage 持有，或者查不到归属时按全局兜底。
    //    Broadcasts 永远是 global，不区分。
    const lines = [];
    const ctxTarget = ctx && ctx.target;
    const ctxStage = (ctx && ctx.vm && ctx.vm.runtime && ctx.vm.runtime.getTargetForStage)
        ? ctx.vm.runtime.getTargetForStage() : null;
    const isSpriteLocal = (name, wantType) => {
        // 只有在 editing target 为 sprite（非 stage）时才可能有"局部变量"；stage 的 variables 都视作全局。
        if (!ctxTarget || ctxTarget.isStage) return false;
        if (!ctxTarget.variables) return false;
        for (const id of Object.keys(ctxTarget.variables)) {
            const v = ctxTarget.variables[id];
            if (v && v.name === name && (v.type || '') === wantType) return true;
        }
        return false;
    };
    const renderHeader = (title, names) => {
        if (!names.length) return;
        lines.push(`${title} { ${names.map(escapeString).join(' ')} }`);
        lines.push('');
    };
    const splitByScope = (map, wantType) => {
        const global = [];
        const local = [];
        for (const name of [...map.keys()].sort()) {
            if (isSpriteLocal(name, wantType)) local.push(name);
            else global.push(name);
        }
        return {global, local};
    };
    const {global: globalVars, local: localVars} = splitByScope(varMap, '');
    const {global: globalLists, local: localLists} = splitByScope(listMap, 'list');
    renderHeader('#vars', globalVars);
    renderHeader('#localvars', localVars);
    renderHeader('#lists', globalLists);
    renderHeader('#locallists', localLists);

    const renderCommentLines = (text, depth) => {
        const normalized = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
        if (!normalized) return [];
        const prefix = indent(depth);
        return normalized.split('\n').map(line => `${prefix}// ${line}`);
    };
    const renderBlockCommentLines = (block, depth) => {
        const commentId = block && !Array.isArray(block) && block.comment;
        if (!commentId) return [];
        const comment = targetComments && targetComments[commentId];
        return renderCommentLines(comment && comment.text, depth);
    };
    const getWorkspaceComments = () => Object.keys(targetComments || {})
        .map(id => ({id, ...targetComments[id]}))
        .filter(comment => comment && !comment.blockId)
        .sort((a, b) => {
            const ay = Number.isFinite(Number(a.y)) ? Number(a.y) : 0;
            const by = Number.isFinite(Number(b.y)) ? Number(b.y) : 0;
            if (ay !== by) return ay - by;
            const ax = Number.isFinite(Number(a.x)) ? Number(a.x) : 0;
            const bx = Number.isFinite(Number(b.x)) ? Number(b.x) : 0;
            if (ax !== bx) return ax - bx;
            return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
        });

    // 6) 渲染每段脚本
    const renderExpr = (value, prec) => {
        // value 可能是 string (blockRef) 或 array (inline primitive like [10, "text"])
        if (Array.isArray(value)) return renderPrimitive(value);
        if (typeof value !== 'string') return String(value);
        return renderBlockAsExpr(value, prec);
    };

    const renderPrimitive = (prim) => {
        if (!Array.isArray(prim)) return '';
        const type = prim[0];
        if (type === 4 || type === 5 || type === 6 || type === 7 || type === 8) {
            // 纯数字
            const v = prim[1];
            if (isNumericLiteral(String(v))) return String(v);
            return escapeString(v);
        }
        if (type === 9) return escapeString(prim[1]); // color as #xxxxxx string
        if (type === 10) {
            const v = prim[1];
            if (typeof v === 'string' && v !== '' && isNumericLiteral(v)) return v;
            return escapeString(v);
        }
        if (type === 11) return `broadcast_ref(${escapeString(prim[1])})`;
        if (type === 12) {
            const name = prim[1];
            if (typeof name === 'string' && BARE_IDENT_RE.test(name)) return name;
            const s = typeof name === 'string' ? sanitizeIdent(name) : '';
            if (s && BARE_IDENT_RE.test(s)) return s;
            return `var(${escapeString(name)})`;
        }
        if (type === 13) {
            const name = prim[1];
            if (typeof name === 'string' && BARE_IDENT_RE.test(name)) return name;
            const s = typeof name === 'string' ? sanitizeIdent(name) : '';
            if (s && BARE_IDENT_RE.test(s)) return s;
            return `list(${escapeString(name)})`;
        }
        return `prim(${prim.map(escapeString).join(', ')})`;
    };

    // 尝试把变量 / 列表 reporter 渲染成裸标识符；不合适就返回 null，交给常规分支。
    const tryRenderAsBareRef = (b) => {
        if (b.opcode !== 'data_variable' && b.opcode !== 'data_listcontents') return null;
        const field = b.fields && (b.fields.VARIABLE || b.fields.LIST);
        if (!field) return null;
        const name = field[0];
        if (typeof name !== 'string') return null;
        if (BARE_IDENT_RE.test(name)) return name;
        const s = sanitizeIdent(name);
        if (s && BARE_IDENT_RE.test(s)) return s;
        return null;
    };

    const renderBlockAsExpr = (blockId, parentPrec) => {
        const b = working[blockId];
        if (!b) return escapeString(`<missing ${blockId}>`);
        if (Array.isArray(b)) return renderPrimitive(b);
        const bare = tryRenderAsBareRef(b);
        if (bare) return bare;
        // procedures 专用语法：参数 reporter 和 call 在 expr 位置
        if (b.opcode === 'argument_reporter_string_number') {
            const f = b.fields && b.fields.VALUE;
            const name = f ? String(f[0]) : '';
            if (currentProcArgs && currentProcArgs.has(name)) {
                return BARE_IDENT_RE.test(name) ? name : escapeString(name);
            }
            return `arg(${escapeString(name)})`;
        }
        if (b.opcode === 'argument_reporter_boolean') {
            const f = b.fields && b.fields.VALUE;
            const name = f ? String(f[0]) : '';
            if (currentProcArgs && currentProcArgs.has(name)) {
                return BARE_IDENT_RE.test(name) ? name : escapeString(name);
            }
            return `arg_bool(${escapeString(name)})`;
        }
        if (b.opcode === 'procedures_call') {
            return renderProceduresCall(b, 'expr');
        }
        if (b.opcode === 'operator_mathop') {
            const field = b.fields && b.fields.OPERATOR;
            const operator = field ? String(field[0]) : '';
            const name = MATH_OP_OPERATOR_TO_NAME.get(operator);
            if (name) {
                const input = b.inputs && b.inputs.NUM;
                const value = input ? renderInput(input, {type: 'input', name: 'NUM', primType: 4}, 0) : '0';
                return `${name}(${value})`;
            }
        }
        if (b.opcode === 'operator_not') {
            const operand = b.inputs && b.inputs.OPERAND;
            const innerId = operand && typeof operand[1] === 'string' ? operand[1] : null;
            const inner = innerId && working[innerId];
            if (inner && !Array.isArray(inner) && (
                inner.opcode === 'operator_lt' ||
                inner.opcode === 'operator_gt' ||
                inner.opcode === 'operator_equals'
            )) {
                const innerDef = getOpcodeDef(inner.opcode);
                const leftInput = inner.inputs && inner.inputs[innerDef.args[0].name];
                const rightInput = inner.inputs && inner.inputs[innerDef.args[1].name];
                const left = leftInput ? renderInput(leftInput, innerDef.args[0], innerDef.infix.prec) : '""';
                const right = rightInput ? renderInput(rightInput, innerDef.args[1], innerDef.infix.prec + 1) : '""';
                const op = inner.opcode === 'operator_lt'
                    ? '>='
                    : (inner.opcode === 'operator_gt' ? '<=' : '!=');
                const s = `${left} ${op} ${right}`;
                return innerDef.infix.prec < parentPrec ? `(${s})` : s;
            }
        }
        const def = getOpcodeDef(b.opcode);
        if (!def) return renderGenericCall(b);
        if (shouldRenderGeneric(b, def)) return renderGenericCall(b);
        if (def.prefix) {
            // !OPERAND
            const operand = b.inputs && b.inputs[def.args[0].name];
            const inner = operand ? renderInput(operand, def.args[0], def.prefix.prec) : 'false';
            const s = `${def.prefix.op}${inner}`;
            return def.prefix.prec < parentPrec ? `(${s})` : s;
        }
        if (def.infix) {
            const a = b.inputs && b.inputs[def.args[0].name];
            const c = b.inputs && b.inputs[def.args[1].name];
            const left = a ? renderInput(a, def.args[0], def.infix.prec) : '""';
            const right = c ? renderInput(c, def.args[1], def.infix.prec + 1) : '""';
            const s = `${left} ${def.infix.op} ${right}`;
            return def.infix.prec < parentPrec ? `(${s})` : s;
        }
        return `${def.name}(${def.args.map(a => renderArg(b, a)).join(', ')})`;
    };

    const renderInput = (inputArr, argDef, parentPrec) => {
        // inputArr: [type, blockRefOrPrim, shadowRefOrPrim?]
        if (!Array.isArray(inputArr)) return '';
        const rawType = inputArr[0];
        const primary = inputArr[1];
        if (primary === null || primary === undefined) return '""';
        if (Array.isArray(primary)) {
            // inline primitive：当槽位预期的 primType 与 primitive 类型一致时，只渲染名字
            // (避免 broadcast(broadcast_ref("x")) 这类冗余嵌套)
            const pType = primary[0];
            if (argDef && pType === argDef.primType && (pType === 11 || pType === 12 || pType === 13)) {
                return escapeString(primary[1]);
            }
            return renderPrimitive(primary);
        }
        if (typeof primary === 'string') {
            const refBlock = working[primary];
            if (refBlock && !Array.isArray(refBlock) && argDef && argDef.menu) {
                if (refBlock.opcode === argDef.menu.opcode && refBlock.fields && refBlock.fields[argDef.menu.field]) {
                    return escapeString(refBlock.fields[argDef.menu.field][0]);
                }
            }
            return renderBlockAsExpr(primary, parentPrec == null ? 0 : parentPrec);
        }
        return String(primary);
    };

    const renderArg = (block, argDef) => {
        if (argDef.type === 'field') {
            const f = block.fields && block.fields[argDef.name];
            if (!f) return '""';
            const val = f[0];
            // variable/list 字段：优先渲染成裸标识符（用户可读、parser 支持反向查找）
            if ((argDef.kind === 'variable' || argDef.kind === 'list') && typeof val === 'string') {
                if (BARE_IDENT_RE.test(val)) return val;
                const s = sanitizeIdent(val);
                if (s && BARE_IDENT_RE.test(s)) return s;
            }
            if (typeof val === 'string' && !isNumericLiteral(val)) return escapeString(val);
            return escapeString(String(val));
        }
        const inp = block.inputs && block.inputs[argDef.name];
        if (!inp) return '""';
        return renderInput(inp, argDef, 0);
    };

    // procedures_call 渲染：
    //   mode === 'stmt'       → `"proccode"(args...)`（stmt 位置，parser 从 STRING+LPAREN 识别为 stmt call）
    //   mode === 'expr'       → `"proccode"(args...)`（expr 位置，parser 从 strcall AST 识别为 reporter call）
    //   mode === 'topReturn'  → `callret("proccode", args...)`（顶层 reporter call 必须显式，否则会被当 stmt）
    // 没给 mode 时按 stmt 兜底；没传 mode 且 block.mutation.return === '1' 当 topReturn。
    const renderProceduresCall = (block, mode) => {
        const mutation = block.mutation || {};
        const proccode = String(mutation.proccode || '');
        const isReturn = mutation.return === '1';
        const resolvedMode = mode || (isReturn ? 'topReturn' : 'stmt');
        let argIds = [];
        try { argIds = JSON.parse(mutation.argumentids || '[]'); } catch (_) { argIds = []; }
        const argPieces = [];
        for (const aid of argIds) {
            const inp = block.inputs && block.inputs[aid];
            if (!inp) { argPieces.push('""'); continue; }
            argPieces.push(renderInput(inp, null, 0));
        }
        const procTok = renderProcToken(proccode);
        if (resolvedMode === 'topReturn') {
            return `callret(${[procTok, ...argPieces].join(', ')})`;
        }
        return `${procTok}(${argPieces.join(', ')})`;
    };

    // 未登记 opcode 的通用渲染：@op("opcode", shadow=..., fields={"K": "v"}, inputs={"K": expr}, mutation="json")
    // 嵌套 block ref（input 值是另一个 block）→ 递归成嵌套 @op(...)。
    // fields/inputs 的 key 一律用字符串字面量包，兼容含 !@#$%{}[] 等任意字符的 proccode 参数 id。
    const renderGenericCall = (block) => {
        const bits = [escapeString(block.opcode)];
        const meta = runtimeOpcodeMeta.get(block.opcode);
        if (meta && (meta.kind === 'boolean' || meta.kind === 'reporter')) {
            bits.push(`kind=${escapeString(meta.kind)}`);
        }
        if (block.shadow) bits.push('shadow=true');
        if (block.fields && Object.keys(block.fields).length) {
            const fParts = [];
            for (const k of Object.keys(block.fields)) {
                const f = block.fields[k];
                const v = Array.isArray(f) ? f[0] : f;
                fParts.push(`${escapeString(k)}: ${escapeString(String(v))}`);
            }
            bits.push(`fields={${fParts.join(', ')}}`);
        }
        if (block.inputs && Object.keys(block.inputs).length) {
            const iParts = [];
            for (const k of Object.keys(block.inputs)) {
                const inp = block.inputs[k];
                if (!Array.isArray(inp)) continue;
                const primary = inp[1];
                let valStr;
                if (Array.isArray(primary)) {
                    valStr = renderPrimitive(primary);
                } else if (typeof primary === 'string') {
                    const ref = working[primary];
                    if (!ref) valStr = escapeString(`<missing ${primary}>`);
                    else if (Array.isArray(ref)) valStr = renderPrimitive(ref);
                    else valStr = renderGenericCall(ref);
                } else {
                    valStr = '""';
                }
                iParts.push(`${escapeString(k)}: ${valStr}`);
            }
            if (iParts.length) bits.push(`inputs={${iParts.join(', ')}}`);
        }
        if (block.mutation) bits.push(`mutation=${escapeString(JSON.stringify(block.mutation))}`);
        return `@op(${bits.join(', ')})`;
    };

    // 变量名要作为裸标识符 LHS 输出时的渲染：原名已是合法标识符 → 原样；否则 sanitize 后若仍是合法 → 下划线形式；
    // 最后兜底用字符串字面量。
    const renderVarLHS = (name) => {
        if (!name) return '""';
        if (BARE_IDENT_RE.test(name)) return name;
        const s = sanitizeIdent(name);
        if (s && BARE_IDENT_RE.test(s)) return s;
        return escapeString(name);
    };

    const getVariableRefFromInput = inputArr => {
        if (!Array.isArray(inputArr)) return null;
        const primary = inputArr[1];
        if (Array.isArray(primary) && primary[0] === 12) {
            return {name: primary[1], id: primary[2]};
        }
        if (typeof primary === 'string') {
            const refBlock = working[primary];
            const field = refBlock && !Array.isArray(refBlock) && refBlock.opcode === 'data_variable' &&
                refBlock.fields && refBlock.fields.VARIABLE;
            if (field) return {name: field[0], id: field[1]};
        }
        return null;
    };

    const sameVariableRef = (a, b) => {
        if (!a || !b) return false;
        if (a.id && b.id) return a.id === b.id;
        return a.name === b.name;
    };

    const tryRenderCompoundSet = block => {
        const compoundOps = {
            operator_add: '+=',
            operator_subtract: '-=',
            operator_multiply: '*=',
            operator_divide: '/=',
            operator_mod: '%='
        };
        const vf = block.fields && block.fields.VARIABLE;
        const valueInput = block.inputs && block.inputs.VALUE;
        const valueBlockId = valueInput && typeof valueInput[1] === 'string' ? valueInput[1] : null;
        const valueBlock = valueBlockId && working[valueBlockId];
        if (!vf || !valueBlock || Array.isArray(valueBlock)) return null;
        const op = compoundOps[valueBlock.opcode];
        if (!op) return null;
        const def = getOpcodeDef(valueBlock.opcode);
        if (!def || !def.infix || !def.args || def.args.length < 2) return null;
        const leftInput = valueBlock.inputs && valueBlock.inputs[def.args[0].name];
        const rightInput = valueBlock.inputs && valueBlock.inputs[def.args[1].name];
        const targetRef = {name: vf[0], id: vf[1]};
        if (!sameVariableRef(targetRef, getVariableRefFromInput(leftInput))) return null;
        const right = rightInput ? renderInput(rightInput, def.args[1], def.infix.prec + 1) : '""';
        return `${renderVarLHS(vf[0])} ${op} ${right}`;
    };

    const renderStmtBlock = (blockId, depth) => {
        const out = [];
        let cur = blockId;
        while (cur) {
            const b = working[cur];
            if (!b || Array.isArray(b)) break;
            out.push(...renderBlockCommentLines(b, depth));
            // procedures 专用语法优先
            if (b.opcode === 'procedures_call') {
                out.push(indent(depth) + renderProceduresCall(b, 'stmt'));
                cur = b.next;
                continue;
            }
            if (b.opcode === 'procedures_return') {
                const valInp = b.inputs && b.inputs.VALUE;
                out.push(indent(depth) + `return ${valInp ? renderInput(valInp, null, 0) : '""'}`);
                cur = b.next;
                continue;
            }
            const def = getOpcodeDef(b.opcode);
            if (!def || shouldRenderGeneric(b, def)) {
                out.push(indent(depth) + renderGenericCall(b));
            } else if (b.opcode === 'data_setvariableto') {
                // 特殊渲染为 LHS = rhs 的形式。
                const vf = b.fields && b.fields.VARIABLE;
                const varName = vf ? vf[0] : '';
                const vInput = b.inputs && b.inputs.VALUE;
                const compound = tryRenderCompoundSet(b);
                if (compound) {
                    out.push(indent(depth) + compound);
                    cur = b.next;
                    continue;
                }
                const valueStr = vInput ? renderInput(vInput, def.args[1], 0) : '""';
                out.push(indent(depth) + `${renderVarLHS(varName)} = ${valueStr}`);
            } else if (b.opcode === 'data_changevariableby') {
                // 特殊渲染为 LHS += rhs 的形式。
                const vf = b.fields && b.fields.VARIABLE;
                const varName = vf ? vf[0] : '';
                const vInput = b.inputs && b.inputs.VALUE;
                const valueStr = vInput ? renderInput(vInput, def.args[1], 0) : '0';
                out.push(indent(depth) + `${renderVarLHS(varName)} += ${valueStr}`);
            } else if (def.kind === 'stmt' || def.kind === 'cap') {
                out.push(indent(depth) + `${def.name}(${def.args.map(a => renderArg(b, a)).join(', ')})`);
            } else if (def.kind === 'c') {
                const argsStr = def.args.map(a => renderArg(b, a)).join(', ');
                out.push(indent(depth) + `${def.name}(${argsStr}) {`);
                const subId = b.inputs && b.inputs[def.substacks[0]] && b.inputs[def.substacks[0]][1];
                if (typeof subId === 'string') out.push(...renderStmtBlock(subId, depth + 1));
                out.push(indent(depth) + '}');
            } else if (def.kind === 'if-else') {
                const condStr = renderArg(b, def.args[0]);
                out.push(indent(depth) + `if (${condStr}) {`);
                const sub1 = b.inputs && b.inputs[def.substacks[0]] && b.inputs[def.substacks[0]][1];
                if (typeof sub1 === 'string') out.push(...renderStmtBlock(sub1, depth + 1));
                out.push(indent(depth) + '} else {');
                const sub2 = b.inputs && b.inputs[def.substacks[1]] && b.inputs[def.substacks[1]][1];
                if (typeof sub2 === 'string') out.push(...renderStmtBlock(sub2, depth + 1));
                out.push(indent(depth) + '}');
            } else if (def.kind === 'hat') {
                // hat 在脚本头部处理；当 hat 出现在链中部属异常，按 stmt 兜底
                out.push(indent(depth) + `${def.name}(${def.args.map(a => renderArg(b, a)).join(', ')})`);
            } else {
                // reporter/boolean 不应该出现在语句位置；兜底
                out.push(indent(depth) + renderBlockAsExpr(cur, 0));
            }
            cur = b.next;
        }
        return out;
    };

    // procedures_definition + 它的 procedures_prototype shadow 组合渲染成
    //   define "proccode"(<params>) [warp] { body... }
    // 参数形态：string/number 默认裸或字符串名，boolean 加 `bool` 前缀；不再输出 `as "<id>"`。
    // argumentids 往返由 parser 侧从 ctx.target VM 现有 prototype 恢复（或稳定 hash 生成）。
    const renderProceduresDefine = (defId, atPrefix) => {
        const defBlock = working[defId];
        const out = [];
        const customInp = defBlock.inputs && defBlock.inputs.custom_block;
        const protoId = customInp && typeof customInp[1] === 'string' ? customInp[1] : null;
        const proto = protoId ? working[protoId] : null;
        if (!proto || Array.isArray(proto) || proto.opcode !== 'procedures_prototype') {
            out.push(`${atPrefix}{`);
            out.push(...renderStmtBlock(defId, 1));
            out.push('}');
            return out;
        }
        const mutation = proto.mutation || {};
        const proccode = String(mutation.proccode || '');
        const warp = mutation.warp === 'true';
        let argNames = [];
        let argDefaults = [];
        try { argNames = JSON.parse(mutation.argumentnames || '[]'); } catch (_) { argNames = []; }
        try { argDefaults = JSON.parse(mutation.argumentdefaults || '[]'); } catch (_) { argDefaults = []; }
        // 从 prototype.inputs 对应的 argument_reporter_* opcode 推类型（最权威），其次看 argdefaults 判 boolean。
        let argIds = [];
        try { argIds = JSON.parse(mutation.argumentids || '[]'); } catch (_) { argIds = []; }
        const types = argIds.map((aid, i) => {
            const inp = proto.inputs && proto.inputs[aid];
            const childId = inp && typeof inp[1] === 'string' ? inp[1] : null;
            const child = childId ? working[childId] : null;
            if (child && !Array.isArray(child) && child.opcode === 'argument_reporter_boolean') return 'b';
            if (argDefaults[i] === 'false') return 'b';
            return 's';
        });
        const params = argNames.map((rawName, i) => {
            const name = rawName != null ? String(rawName) : '';
            const namePart = BARE_IDENT_RE.test(name) ? name : escapeString(name);
            return types[i] === 'b' ? `bool ${namePart}` : namePart;
        });
        const headParts = [`define ${renderProcToken(proccode)}(${params.join(', ')})`];
        if (warp) headParts.push('warp');
        const head = `${atPrefix}${headParts.join(' ')}`;
        // body 里参数引用可裸写 —— 进 body 前 push，退出后恢复
        const prevProcArgs = currentProcArgs;
        currentProcArgs = new Set(argNames.map(n => n == null ? '' : String(n)));
        if (defBlock.next) {
            out.push(`${head} {`);
            out.push(...renderStmtBlock(defBlock.next, 1));
            out.push('}');
        } else {
            out.push(`${head} {`);
            out.push('}');
        }
        currentProcArgs = prevProcArgs;
        return out;
    };

    for (const topId of scripts) {
        const b = working[topId];
        const atPrefix = (includeCoords && b.topLevel !== false && (b.x !== undefined || b.y !== undefined)) ?
            `at(${Math.round(b.x || 0)}, ${Math.round(b.y || 0)}) ` : '';
        const topCommentLines = Array.isArray(b) ? [] : renderBlockCommentLines(b, 0);
        if (Array.isArray(b)) {
            // 孤立 primitive（不常见，当"漂浮值"输出）
            lines.push(`${atPrefix}${renderPrimitive(b)}`);
            lines.push('');
            continue;
        }
        // procedures 专用语法：定义和调用都走独立一行（不套 {}）
        if (b.opcode === 'procedures_definition') {
            lines.push(...topCommentLines);
            lines.push(...renderProceduresDefine(topId, atPrefix));
            lines.push('');
            continue;
        }
        if (b.opcode === 'procedures_call') {
            // 顶层：stmt call → 隐式 "proccode"(args) 形式；reporter call（mutation.return="1"）→ 必须显式 callret，
            // 否则 parser 会把裸 "proccode"(args) 当 stmt-call 而丢失 return 语义。
            const mode = (b.mutation && b.mutation.return === '1') ? 'topReturn' : 'stmt';
            lines.push(...topCommentLines);
            lines.push(`${atPrefix}${renderProceduresCall(b, mode)}`);
            lines.push('');
            continue;
        }
        if (b.opcode === 'argument_reporter_string_number' || b.opcode === 'argument_reporter_boolean') {
            lines.push(...topCommentLines);
            lines.push(`${atPrefix}${renderBlockAsExpr(topId, 0)}`);
            lines.push('');
            continue;
        }
        const def = getOpcodeDef(b.opcode);
        const effectiveDef = shouldRenderGeneric(b, def) ? null : def;
        if (effectiveDef && effectiveDef.kind === 'hat') {
            const argsStr = effectiveDef.args.map(a => renderArg(b, a)).join(', ');
            const head = `${atPrefix}${effectiveDef.name}(${argsStr})`;
            lines.push(...topCommentLines);
            if (b.next) {
                lines.push(`${head} {`);
                lines.push(...renderStmtBlock(b.next, 1));
                lines.push('}');
            } else {
                lines.push(head);
            }
        } else if (effectiveDef && (effectiveDef.kind === 'stmt' || effectiveDef.kind === 'cap' || effectiveDef.kind === 'c' || effectiveDef.kind === 'if-else')) {
            // top-level 语句串
            lines.push(`${atPrefix}{`);
            lines.push(...renderStmtBlock(topId, 1));
            lines.push('}');
        } else if (effectiveDef && (effectiveDef.kind === 'reporter' || effectiveDef.kind === 'boolean')) {
            // 浮动 reporter（Scratch 里可以从积木栏拖出单独的 reporter）
            lines.push(...topCommentLines);
            lines.push(`${atPrefix}${renderBlockAsExpr(topId, 0)}`);
        } else {
            lines.push(`${atPrefix}{`);
            lines.push(...renderStmtBlock(topId, 1));
            lines.push('}');
        }
        lines.push('');
    }

    const workspaceComments = getWorkspaceComments();
    for (const comment of workspaceComments) {
        lines.push(...renderCommentLines(comment.text, 0));
        lines.push('');
    }

    return lines.join('\n').replace(/\n+$/, '\n');
};

// ========================= PARSER =========================
// source: 伪代码字符串 → {blocks, errors}
// blocks: SB3 压缩形态（短 ID 键）
// 语义等价目标：经过 deserializeBlocks + newBlockIds 后产生合法积木

// ---- Tokenizer ----
const T = {
    IDENT: 'IDENT', NUMBER: 'NUMBER', STRING: 'STRING',
    LPAREN: '(', RPAREN: ')', LBRACE: '{', RBRACE: '}',
    COMMA: ',', COLON: ':', EQUALS: '=',
    OP: 'OP', NEWLINE: 'NL', EOF: 'EOF',
    HASH_KEYWORD: 'HASH', COMMENT: 'COMMENT'
};
const OPS_2CHAR = ['==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '%='];
const OPS_1CHAR = ['+', '-', '*', '/', '%', '<', '>', '!'];

const tokenize = (source) => {
    const tokens = [];
    const errors = [];
    let i = 0, line = 1, col = 1;
    const push = (type, value, pos) => tokens.push({
        type,
        value,
        line: pos && pos.line != null ? pos.line : line,
        col: pos && pos.col != null ? pos.col : col
    });
    const advance = (n) => {
        for (let k = 0; k < n; k++) {
            if (source[i] === '\n') { line++; col = 1; } else { col++; }
            i++;
        }
    };
    while (i < source.length) {
        const c = source[i];
        if (c === '\n') { push(T.NEWLINE, '\n'); advance(1); continue; }
        if (c === ' ' || c === '\t' || c === '\r') { advance(1); continue; }
        if (c === '#') {
            // # 行首关键字：#vars / #lists / #localvars / #locallists（或中文 #变量 / #列表 / #局部变量 / #局部列表）
            let j = i + 1;
            while (j < source.length && /[a-zA-Z_0-9\u4e00-\u9fa5]/.test(source[j])) j++;
            const word = source.slice(i + 1, j);
            push(T.HASH_KEYWORD, word);
            advance(j - i);
            continue;
        }
        if (c === '/' && source[i + 1] === '/') {
            const startLine = line;
            const startCol = col;
            advance(2);
            const start = i;
            while (i < source.length && source[i] !== '\n') advance(1);
            push(T.COMMENT, source.slice(start, i).trim(), {line: startLine, col: startCol});
            continue;
        }
        if (c === '/' && source[i + 1] === '*') {
            const startLine = line;
            const startCol = col;
            advance(2);
            const start = i;
            while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
                advance(1);
            }
            if (i >= source.length) {
                errors.push({line: startLine, col: startCol, message: '未闭合的块注释'});
                break;
            }
            push(T.COMMENT, source.slice(start, i).trim(), {line: startLine, col: startCol});
            advance(2);
            continue;
        }
        if (c === '(') { push(T.LPAREN, '('); advance(1); continue; }
        if (c === ')') { push(T.RPAREN, ')'); advance(1); continue; }
        if (c === '{') { push(T.LBRACE, '{'); advance(1); continue; }
        if (c === '}') { push(T.RBRACE, '}'); advance(1); continue; }
        if (c === ',') { push(T.COMMA, ','); advance(1); continue; }
        if (c === ':') { push(T.COLON, ':'); advance(1); continue; }
        if (c === '=' && source[i + 1] !== '=') { push(T.EQUALS, '='); advance(1); continue; }
        if (c === '"') {
            let j = i + 1;
            let s = '';
            while (j < source.length && source[j] !== '"') {
                if (source[j] === '\\' && j + 1 < source.length) {
                    const esc = source[j + 1];
                    if (esc === 'n') s += '\n';
                    else if (esc === 't') s += '\t';
                    else if (esc === 'r') s += '\r';
                    else if (esc === '\\') s += '\\';
                    else if (esc === '"') s += '"';
                    else s += esc;
                    j += 2;
                } else {
                    s += source[j];
                    j++;
                }
            }
            if (j >= source.length) {
                errors.push({line, col, message: '未闭合的字符串字面量'});
                break;
            }
            push(T.STRING, s);
            advance(j - i + 1);
            continue;
        }
        const two = source.slice(i, i + 2);
        if (OPS_2CHAR.indexOf(two) >= 0) { push(T.OP, two); advance(2); continue; }
        if (OPS_1CHAR.indexOf(c) >= 0) {
            // 小心：-/+ 前置可能是负号，parser 处理；这里一律当 OP
            push(T.OP, c);
            advance(1);
            continue;
        }
        if (/[0-9.]/.test(c)) {
            let j = i;
            if (source[j] === '.') j++;
            while (j < source.length && /[0-9]/.test(source[j])) j++;
            if (source[j] === '.') { j++; while (j < source.length && /[0-9]/.test(source[j])) j++; }
            if (source[j] === 'e' || source[j] === 'E') {
                j++;
                if (source[j] === '+' || source[j] === '-') j++;
                while (j < source.length && /[0-9]/.test(source[j])) j++;
            }
            push(T.NUMBER, source.slice(i, j));
            advance(j - i);
            continue;
        }
        if (/[a-zA-Z_$\u4e00-\u9fa5]/.test(c)) {
            let j = i;
            while (j < source.length && /[a-zA-Z_0-9$\u4e00-\u9fa5]/.test(source[j])) j++;
            push(T.IDENT, source.slice(i, j));
            advance(j - i);
            continue;
        }
        // @xxx：`@op` 以及将来可能的 @ 前缀关键字整体当作 IDENT
        if (c === '@') {
            let j = i + 1;
            while (j < source.length && /[a-zA-Z_0-9]/.test(source[j])) j++;
            if (j === i + 1) {
                errors.push({line, col, message: `无法识别的字符: @`});
                advance(1);
                continue;
            }
            push(T.IDENT, source.slice(i, j));
            advance(j - i);
            continue;
        }
        errors.push({line, col, message: `无法识别的字符: ${c}`});
        advance(1);
    }
    push(T.EOF, null);
    return {tokens, errors};
};

// ---- Parser ----
// Precedence table aligned with renderer's infix.prec values.
const BIN_OP_TO_OPCODE = {
    '+': 'operator_add', '-': 'operator_subtract', '*': 'operator_multiply', '/': 'operator_divide',
    '%': 'operator_mod',
    '==': 'operator_equals', '<': 'operator_lt', '>': 'operator_gt',
    '&&': 'operator_and', '||': 'operator_or'
};
const BIN_OP_ARGS = {
    '+': ['NUM1', 'NUM2', 4], '-': ['NUM1', 'NUM2', 4], '*': ['NUM1', 'NUM2', 4], '/': ['NUM1', 'NUM2', 4], '%': ['NUM1', 'NUM2', 4],
    '==': ['OPERAND1', 'OPERAND2', 10], '!=': ['OPERAND1', 'OPERAND2', 10], '<': ['OPERAND1', 'OPERAND2', 10], '>': ['OPERAND1', 'OPERAND2', 10],
    '<=': ['OPERAND1', 'OPERAND2', 10], '>=': ['OPERAND1', 'OPERAND2', 10],
    '&&': ['OPERAND1', 'OPERAND2', null], '||': ['OPERAND1', 'OPERAND2', null]
};
const BIN_OP_PREC = {
    '||': 3, '&&': 4, '==': 5, '!=': 5, '<': 6, '>': 6, '<=': 6, '>=': 6, '+': 8, '-': 8, '*': 9, '/': 9, '%': 9
};

const parsePseudocode = (source, ctx) => {
    const {tokens, errors: tokenErrors} = tokenize(source);
    const errors = [...tokenErrors];
    const ctxTarget = ctx && ctx.target;
    const runtimeOpcodeMeta = getRuntimeOpcodeMetadata(ctx);
    const {opcodeToRuntimeDef, nameToRuntimeDef} = getRuntimeOpcodeDefinitions(runtimeOpcodeMeta);
    const getOpcodeDef = opcode => opcodeToDef.get(opcode) || opcodeToRuntimeDef.get(opcode);
    const getNameDef = name => nameToDef.get(name) || nameToRuntimeDef.get(name);

    // id 分配
    let idCounter = 0;
    const newId = () => shortIdAt(idCounter++);
    // pending 变量/列表/广播 的 id 用一次性随机前缀，保证跨多次 parse 不会撞到之前一次已创建的变量 id。
    // 否则会出现 "第二次 parse 里新变量 bar 被分到 newvar-a，但上一次 foo 已经占了 newvar-a" 的错配。
    const pendingIdSeed = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
    const freshPendingId = prefix => `${prefix}-${pendingIdSeed}-${newId()}`;

    // 输出 blocks
    const outBlocks = {};
    const genericOpKindById = new Map();
    // 头部声明的名字集合（新语法：纯名字列表；仅作"这个脚本声明用到了哪些 var/list/broadcast"的元信息）
    // #vars / #lists 声明为全局（stage 作用域）；#localvars / #locallists 声明为角色本地（sprite 作用域）
    const declaredVars = new Set();
    const declaredLists = new Set();
    const declaredBroadcasts = new Set();
    const declaredLocalVars = new Set();
    const declaredLocalLists = new Set();
    // 解析过程中名字无法在目标上找到时产生的"待创建"表：name -> freshId
    const pendingVars = new Map();
    const pendingLists = new Map();
    const pendingBroadcasts = new Map();

    // procedures: proccode → [argumentids]。由 prescanDefines 预扫 + parseDefine 真正解析时填入；
    // buildProcedureCall 查这张表把 call 的 inputs key 对齐 definition 的 argumentids。
    const ctxProcedures = Object.create(null);
    const hashStr = s => {
        let h = 0;
        for (let i = 0; i < String(s).length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        return Math.abs(h).toString(36);
    };
    // 当前 define 作用域的参数映射：name → 'b' | 's'。body 内的裸标识符 / 字符串若命中这里，
    // compileExpr 直接产出 argument_reporter_* 而不是 var/list 查询。嵌套 define 不合法，一层栈够用。
    let currentProcParams = null;  // Map<name, 'b' | 's'> 或 null

    // 从 VM 里现有的 procedures_prototype 查某个 proccode 的 argumentids。找不到返回 null。
    const lookupVmPrototypeArgIds = (proccode) => {
        if (!ctxTarget || !ctxTarget.blocks || !ctxTarget.blocks._blocks) return null;
        const all = ctxTarget.blocks._blocks;
        for (const id of Object.keys(all)) {
            const b = all[id];
            if (b && b.opcode === 'procedures_prototype' && b.mutation && b.mutation.proccode === proccode) {
                try { return JSON.parse(b.mutation.argumentids || '[]'); } catch (_) { return null; }
            }
        }
        return null;
    };
    // 按 proccode + 期望参数数解析一套 argumentids：优先复用（ctxProcedures 或 VM），长度不够用 hash 扩充。
    const resolveProcArgIds = (proccode, expectedCount) => {
        let ids = ctxProcedures[proccode] || lookupVmPrototypeArgIds(proccode);
        if (!ids) ids = [];
        if (ids.length < expectedCount) {
            const filled = ids.slice();
            for (let i = filled.length; i < expectedCount; i++) filled.push(`${hashStr(proccode)}_arg_${i}`);
            ids = filled;
        }
        return ids;
    };
    // 把 call 侧的"简写 name"解析回完整 proccode；含 `%` → 已经是完整 proccode；否则按 name 查
    // prescan 填的 ctxProcedures / VM 的所有 prototype（简单 proccode 的首 token 当 name）。查不到返回原样。
    const resolveProccodeFromCallName = (nameOrProccode) => {
        const s = String(nameOrProccode);
        if (PROC_PLACEHOLDER_RE.test(s)) return s;
        if (ctxProcedures[s]) return s;
        for (const pc of Object.keys(ctxProcedures)) {
            if (isSimpleProccode(pc) && getProcName(pc) === s) return pc;
        }
        if (ctxTarget && ctxTarget.blocks && ctxTarget.blocks._blocks) {
            const all = ctxTarget.blocks._blocks;
            for (const id of Object.keys(all)) {
                const b = all[id];
                if (!b || b.opcode !== 'procedures_prototype' || !b.mutation) continue;
                const pc = String(b.mutation.proccode || '');
                if (pc === s) return pc;
                if (isSimpleProccode(pc) && getProcName(pc) === s) return pc;
            }
        }
        return s;
    };
    // 判断一个 name 是否是已知的 proc（用于 parseStatement / 主循环分派）
    const isKnownProcName = (name) => {
        const s = String(name);
        if (ctxProcedures[s]) return true;
        for (const pc of Object.keys(ctxProcedures)) {
            if (isSimpleProccode(pc) && getProcName(pc) === s) return true;
        }
        if (ctxTarget && ctxTarget.blocks && ctxTarget.blocks._blocks) {
            const all = ctxTarget.blocks._blocks;
            for (const id of Object.keys(all)) {
                const b = all[id];
                if (!b || b.opcode !== 'procedures_prototype' || !b.mutation) continue;
                const pc = String(b.mutation.proccode || '');
                if (pc === s) return true;
                if (isSimpleProccode(pc) && getProcName(pc) === s) return true;
            }
        }
        return false;
    };
    // AST 节点 → proc token 字符串（strlit 或裸 0-arg call）；否则 null
    const astAsProcToken = (ast) => {
        if (!ast) return null;
        if (ast.kind === 'strlit') return String(ast.value);
        if (ast.kind === 'call' && ast.args.length === 0 && Object.keys(ast.kwargs || {}).length === 0) {
            return String(ast.name);
        }
        return null;
    };

    // token 游标
    let cursor = 0;
    const peek = (k = 0) => tokens[Math.min(cursor + k, tokens.length - 1)];
    const eat = () => tokens[cursor++];
    const outComments = {};
    let commentCounter = 0;
    let pendingComments = [];
    const cleanCommentText = text => String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
    const queueCommentToken = tok => {
        const text = cleanCommentText(tok && tok.value);
        if (text) pendingComments.push(text);
    };
    const takePendingComments = () => {
        const comments = pendingComments;
        pendingComments = [];
        return comments;
    };
    const makeCommentRecord = (blockId, text) => {
        const lines = text.split('\n');
        const maxLineLength = lines.reduce((m, line) => Math.max(m, line.length), 0);
        return {
            blockId,
            text,
            x: null,
            y: null,
            width: Math.max(160, Math.min(360, maxLineLength * 7 + 28)),
            height: Math.max(80, Math.min(260, lines.length * 18 + 36)),
            minimized: false
        };
    };
    const appendWorkspaceComment = comments => {
        const text = (comments || []).map(cleanCommentText).filter(Boolean).join('\n');
        if (!text) return false;
        const commentId = `comment_${shortIdAt(commentCounter++)}`;
        outComments[commentId] = makeCommentRecord(null, text);
        return true;
    };
    const appendCommentsToBlock = (blockId, comments) => {
        const block = blockId && outBlocks[blockId];
        const text = (comments || []).map(cleanCommentText).filter(Boolean).join('\n');
        if (!block || Array.isArray(block) || !text) return false;
        if (block.comment && outComments[block.comment]) {
            outComments[block.comment].text += `\n${text}`;
            return true;
        }
        const commentId = `comment_${shortIdAt(commentCounter++)}`;
        block.comment = commentId;
        outComments[commentId] = makeCommentRecord(blockId, text);
        return true;
    };
    const skipNewlines = () => {
        while (peek().type === T.NEWLINE || peek().type === T.COMMENT) {
            if (peek().type === T.COMMENT) queueCommentToken(peek());
            cursor++;
        }
    };
    const appendInlineCommentsToBlock = blockId => {
        const comments = [];
        while (peek().type === T.COMMENT) {
            comments.push(peek().value);
            cursor++;
        }
        if (comments.length) appendCommentsToBlock(blockId, comments);
    };
    const expect = (type, value) => {
        const t = peek();
        if (t.type !== type || (value !== undefined && t.value !== value)) {
            errors.push({line: t.line, col: t.col, message: `预期 ${value || type}，得到 ${JSON.stringify(t.value)}`});
            return null;
        }
        return eat();
    };

    // 解析头部块 #vars { "name1" "name2" ... }
    // 只收集声明名字；空白/逗号/换行都当分隔符；不再接 `:id` 尾巴。
    const parseHeaderBlock = (set) => {
        expect(T.LBRACE);
        skipNewlines();
        while (peek().type !== T.RBRACE && peek().type !== T.EOF) {
            const tok = peek();
            if (tok.type === T.STRING || tok.type === T.IDENT) {
                set.add(String(tok.value));
                eat();
            } else if (tok.type === T.COMMA) {
                eat();
            } else {
                errors.push({line: tok.line, col: tok.col, message: `期待名字，得到 ${JSON.stringify(tok.value)}`});
                eat();
            }
            skipNewlines();
        }
        expect(T.RBRACE);
        skipNewlines();
    };

    // 拿 stage 的助手（broadcast 永远在 stage；sanitize-match 反查也会扫 stage）
    const getStage = () => (ctx && ctx.vm && ctx.vm.runtime && ctx.vm.runtime.getTargetForStage)
        ? ctx.vm.runtime.getTargetForStage() : null;

    // 用 "sanitize 后的名字" 反查真实变量：给用户一条捷径，可以用下划线形式引用带空格/标点的变量。
    const findBySanitizedName = (ident, wantType) => {
        const scan = (scope) => {
            if (!scope || !scope.variables) return null;
            for (const id of Object.keys(scope.variables)) {
                const v = scope.variables[id];
                if (!v) continue;
                if ((v.type || '') !== wantType) continue;
                if (sanitizeIdent(v.name) === ident) return {name: v.name, id: v.id};
            }
            return null;
        };
        return (ctxTarget && scan(ctxTarget)) || scan(getStage());
    };

    const findInScopeByName = (scope, name, wantType) => {
        if (!scope || !scope.variables) return null;
        for (const id of Object.keys(scope.variables)) {
            const v = scope.variables[id];
            if (v && v.name === name && (v.type || '') === wantType) {
                return {name: v.name, id: v.id};
            }
        }
        const safeName = sanitizeIdent(name);
        for (const id of Object.keys(scope.variables)) {
            const v = scope.variables[id];
            if (v && (v.type || '') === wantType && sanitizeIdent(v.name) === safeName) {
                return {name: v.name, id: v.id};
            }
        }
        return null;
    };

    const findMatchingName = (ident, names) => {
        for (const name of names) {
            if (name === ident) return name;
        }
        for (const name of names) {
            if (sanitizeIdent(name) === ident) return name;
        }
        return null;
    };

    const resolveDataRef = (name, wantType, pending, pendingPrefix, globalDeclared, localDeclared) => {
        const localName = findMatchingName(name, localDeclared);
        const globalName = findMatchingName(name, globalDeclared);
        const pendingName = findMatchingName(name, pending.keys());

        if (localName && ctxTarget && !ctxTarget.isStage) {
            const local = findInScopeByName(ctxTarget, localName, wantType);
            if (local) return local;
            if (!pending.has(localName)) pending.set(localName, freshPendingId(pendingPrefix));
            return {name: localName, id: pending.get(localName)};
        }

        if (globalName) {
            const global = findInScopeByName(getStage(), globalName, wantType);
            if (global) return global;
            if (!pending.has(globalName)) pending.set(globalName, freshPendingId(pendingPrefix));
            return {name: globalName, id: pending.get(globalName)};
        }

        if (localName) {
            const scoped = findInScopeByName(ctxTarget, localName, wantType) || findInScopeByName(getStage(), localName, wantType);
            if (scoped) return scoped;
            if (!pending.has(localName)) pending.set(localName, freshPendingId(pendingPrefix));
            return {name: localName, id: pending.get(localName)};
        }

        if (pendingName) return {name: pendingName, id: pending.get(pendingName)};

        if (ctxTarget && ctxTarget.lookupVariableByNameAndType) {
            const v = ctxTarget.lookupVariableByNameAndType(name, wantType);
            if (v) return {name: v.name, id: v.id};
        }
        const match = findBySanitizedName(name, wantType);
        if (match) return match;
        if (!pending.has(name)) pending.set(name, freshPendingId(pendingPrefix));
        return {name, id: pending.get(name)};
    };

    const resolveKnownDataIdent = name => {
        const varName = findMatchingName(name, declaredLocalVars) ||
            findMatchingName(name, declaredVars) ||
            findMatchingName(name, pendingVars.keys());
        if (varName) {
            const ref = resolveVariableRef(varName);
            return {prim: [12, ref.name, ref.id]};
        }
        const listName = findMatchingName(name, declaredLocalLists) ||
            findMatchingName(name, declaredLists) ||
            findMatchingName(name, pendingLists.keys());
        if (listName) {
            const ref = resolveListRef(listName);
            return {prim: [13, ref.name, ref.id]};
        }
        return null;
    };

    // 根据名字查变量：先真实名字精确命中，再扫 sanitize 后的匹配；否则登记 pending 留给 apply 阶段创建。
    // 返回 {name, id}，name 是 VM 里的真实变量名（sanitize 命中时与传入的 ident 可能不同）。
    const resolveVariableRef = (name) => resolveDataRef(
        name, '', pendingVars, 'newvar', declaredVars, declaredLocalVars
    );
    const resolveListRef = (name) => resolveDataRef(
        name, 'list', pendingLists, 'newlist', declaredLists, declaredLocalLists
    );
    const resolveVariableId = (name) => resolveVariableRef(name).id;
    const resolveListId = (name) => resolveListRef(name).id;
    const resolveBroadcastId = (name) => {
        // 广播永远在 stage 上；先查 stage 里的同名广播，有就复用，没有才挂 pending。
        const stage = getStage();
        if (stage && typeof stage.lookupBroadcastByInputValue === 'function') {
            const existing = stage.lookupBroadcastByInputValue(name);
            if (existing) return existing.id;
        }
        if (!pendingBroadcasts.has(name)) pendingBroadcasts.set(name, freshPendingId('newbroadcast'));
        return pendingBroadcasts.get(name);
    };

    const blockLoc = new Map();

    // 建立一个块对象（非 primitive），返回 id
    const addBlock = (opcode, opts) => {
        const id = newId();
        outBlocks[id] = {
            opcode,
            next: null,
            parent: opts && opts.parent !== undefined ? opts.parent : null,
            inputs: (opts && opts.inputs) || {},
            fields: (opts && opts.fields) || {},
            shadow: !!(opts && opts.shadow),
            topLevel: !!(opts && opts.topLevel)
        };
        if (opts && opts.topLevel) {
            outBlocks[id].x = opts.x || 0;
            outBlocks[id].y = opts.y || 0;
        }
        if (opts && (opts.line || opts.col)) {
            blockLoc.set(id, {
                line: tokenLine(opts),
                col: tokenCol(opts)
            });
        }
        if (opts && opts.mutation) outBlocks[id].mutation = opts.mutation;
        return id;
    };

    // 根据 primType 包一个压缩 primitive，返回 id
    const addPrimitiveBlock = (primArr) => {
        const id = newId();
        outBlocks[id] = primArr;
        return id;
    };

    // 解析表达式（Pratt，最低优先级 0）
    const parseExpression = (minPrec) => {
        return parseBinaryRHS(parseUnary(), minPrec || 0);
    };

    const parseUnary = () => {
        const t = peek();
        if (t.type === T.OP && (t.value === '!' || t.value === '-' || t.value === '+')) {
            if (t.value === '!') {
                eat();
                const inner = parseUnary();
                return {kind: 'not', inner, line: t.line, col: t.col};
            }
            if (t.value === '-' || t.value === '+') {
                // 一元 +/- 作用于数值字面量：合并到字面量里，保持语义简单
                eat();
                const inner = parseUnary();
                if (inner.kind === 'numlit') {
                    return {
                        kind: 'numlit',
                        value: (t.value === '-' ? -inner.value : inner.value),
                        raw: `${t.value}${inner.raw !== undefined ? inner.raw : inner.value}`,
                        line: t.line,
                        col: t.col
                    };
                }
                // 否则转成 operator_subtract(0, x) 或原值
                if (t.value === '-') {
                    return {
                        kind: 'binop',
                        op: '-',
                        left: {kind: 'numlit', value: 0, raw: '0', line: t.line, col: t.col},
                        right: inner,
                        line: t.line,
                        col: t.col
                    };
                }
                return inner;
            }
        }
        return parsePrimary();
    };

    const parseBinaryRHS = (left, minPrec) => {
        while (true) {
            const t = peek();
            if (t.type !== T.OP) return left;
            const prec = BIN_OP_PREC[t.value];
            if (prec === undefined || prec < minPrec) return left;
            eat();
            let right = parseUnary();
            // right-side with higher precedence operators should absorb first
            while (true) {
                const nt = peek();
                if (nt.type !== T.OP) break;
                const nprec = BIN_OP_PREC[nt.value];
                if (nprec === undefined || nprec <= prec) break;
                right = parseBinaryRHS(right, prec + 1);
                break;
            }
            left = {kind: 'binop', op: t.value, left, right, line: t.line, col: t.col};
        }
    };

    // 解析函数调用的 ( args... )，支持可选的 `IDENT = expr` kwarg 形态。
    // 只有 `@op(...)` 开启 kwarg 解析；其他调用如果出现 `IDENT=...` 当成语义错误（不动）。
    const parseCallTail = (supportsKwargs) => {
        const args = [];
        const kwargs = {};
        expect(T.LPAREN);
        skipNewlines();
        while (peek().type !== T.RPAREN && peek().type !== T.EOF) {
            if (supportsKwargs && peek().type === T.IDENT && peek(1).type === T.EQUALS) {
                const kwName = peek().value;
                eat(); eat();
                skipNewlines();
                kwargs[kwName] = parseExpression(0);
            } else {
                args.push(parseExpression(0));
            }
            skipNewlines();
            if (peek().type === T.COMMA) { eat(); skipNewlines(); continue; }
            break;
        }
        skipNewlines();
        expect(T.RPAREN);
        return {args, kwargs};
    };

    const astLine = ast => (ast && Number(ast.line) > 0 ? Number(ast.line) : 1);
    const astCol = ast => (ast && Number(ast.col) > 0 ? Number(ast.col) : 1);
    const tokenLine = token => (token && Number(token.line) > 0 ? Number(token.line) : 1);
    const tokenCol = token => (token && Number(token.col) > 0 ? Number(token.col) : 1);

    const parsePrimary = () => {
        const t = peek();
        if (t.type === T.NUMBER) {
            eat();
            return {kind: 'numlit', value: Number(t.value), raw: t.value, line: t.line, col: t.col};
        }
        if (t.type === T.STRING) {
            eat();
            // `"proccode"(args)` 隐式 procedure 调用：在 expr 位置就是 callret（reporter），
            // 在 stmt 位置另有 parseStatement 的 STRING+LPAREN 分支单独处理成 stmt call。
            if (peek().type === T.LPAREN) {
                const {args} = parseCallTail(false);
                return {kind: 'strcall', proccode: t.value, args, line: t.line, col: t.col};
            }
            return {kind: 'strlit', value: t.value, line: t.line, col: t.col};
        }
        if (t.type === T.LPAREN) {
            eat();
            const inner = parseExpression(0);
            expect(T.RPAREN);
            return inner;
        }
        // 对象字面量 { "key": expr, "key2": expr, ... } —— 仅用于 @op 的 fields/inputs kwarg。
        if (t.type === T.LBRACE) {
            eat();
            const entries = [];
            skipNewlines();
            while (peek().type !== T.RBRACE && peek().type !== T.EOF) {
                const keyTok = peek();
                let key;
                if (keyTok.type === T.STRING || keyTok.type === T.IDENT) {
                    key = String(keyTok.value);
                    eat();
                } else if (keyTok.type === T.NUMBER) {
                    key = String(keyTok.value);
                    eat();
                } else {
                    errors.push({line: keyTok.line, col: keyTok.col, message: `期待对象键，得到 ${JSON.stringify(keyTok.value)}`});
                    eat();
                    break;
                }
                expect(T.COLON);
                skipNewlines();
                const value = parseExpression(0);
                entries.push({key, value});
                skipNewlines();
                if (peek().type === T.COMMA) { eat(); skipNewlines(); continue; }
                break;
            }
            skipNewlines();
            expect(T.RBRACE);
            return {kind: 'objlit', entries, line: t.line, col: t.col};
        }
        if (t.type === T.IDENT) {
            const name = t.value;
            eat();
            // 函数调用：IDENT ( args )
            if (peek().type === T.LPAREN) {
                const {args, kwargs} = parseCallTail(name === '@op');
                return {kind: 'call', name, args, kwargs, line: t.line, col: t.col};
            }
            // 裸 IDENT：当 true/false/null 处理
            if (name === 'true') return {kind: 'boollit', value: true, line: t.line, col: t.col};
            if (name === 'false') return {kind: 'boollit', value: false, line: t.line, col: t.col};
            if (name === 'null') return {kind: 'null', line: t.line, col: t.col};
            // 其他裸 IDENT 视为 0 参函数调用（方便 `on_flag_clicked` 这种）
            return {kind: 'call', name, args: [], kwargs: {}, line: t.line, col: t.col};
        }
        errors.push({line: t.line, col: t.col, message: `意外 token: ${JSON.stringify(t.value)}`});
        eat();
        return {kind: 'strlit', value: '', line: tokenLine(t), col: tokenCol(t)};
    };

    const isDefinitelyStringExpr = ast => {
        if (!ast) return false;
        if (ast.kind === 'strlit') return true;
        if (ast.kind === 'call') {
            return ast.name === 'join' || ast.name === 'letter_of';
        }
        if (ast.kind === 'binop') return isDefinitelyStringExpr(ast.left) || isDefinitelyStringExpr(ast.right);
        if (ast.kind === 'not') return isDefinitelyStringExpr(ast.inner);
        return false;
    };

    // AST → blocks：把 reporter AST 编译成一个 block id（reporter / boolean 块）或直接内联 primitive
    // 返回："emitted": 'block' | 'prim', id (block id) 或 prim (Array)
    const compileExpr = (ast, parentId, expectedPrimType) => {
        if (!ast) return {prim: [10, '']};
        const withLoc = result => {
            if (result && result.line == null) result.line = astLine(ast);
            if (result && result.col == null) result.col = astCol(ast);
            return result;
        };
        if (ast.kind === 'numlit') {
            const primType = (expectedPrimType === 10 || expectedPrimType == null) ? 10 : expectedPrimType;
            return withLoc({prim: [primType, String(ast.value)]});
        }
        if (ast.kind === 'strlit') {
            // 在 define body 里且命中当前 proc 参数名 → 作为 argument_reporter_* 引用（参数优先于普通字符串）。
            if (currentProcParams && currentProcParams.has(ast.value)) {
                const t = currentProcParams.get(ast.value);
                const opcode = t === 'b' ? 'argument_reporter_boolean' : 'argument_reporter_string_number';
                const id = addBlock(opcode, {parent: parentId, line: astLine(ast), col: astCol(ast)});
                outBlocks[id].fields.VALUE = [ast.value, null];
                return withLoc({blockId: id});
            }
            const primType = (expectedPrimType == null) ? 10 : expectedPrimType;
            if (primType === 9) return withLoc({prim: [9, String(ast.value)]});
            if (primType === 11) {
                return withLoc({prim: [11, ast.value, resolveBroadcastId(ast.value)]});
            }
            return withLoc({prim: [primType, ast.value]});
        }
        if (ast.kind === 'strcall') {
            // expr 位置遇到 `"proccode"(args)` → reporter call（mutation.return="1"）
            return withLoc(buildProcedureCall(ast.proccode, ast.args, true, parentId, ast));
        }
        if (ast.kind === 'boollit') {
            return withLoc({prim: [10, ast.value ? 'true' : 'false']});
        }
        if (ast.kind === 'null') return withLoc({prim: [10, '']});
        if (ast.kind === 'not') {
            const id = addBlock('operator_not', {parent: parentId, line: astLine(ast), col: astCol(ast)});
            const r = compileExpr(ast.inner, id, null);
            setInputRef(id, 'OPERAND', r, null);
            return withLoc({blockId: id});
        }
        if (ast.kind === 'binop') {
            if (ast.op === '+' && (isDefinitelyStringExpr(ast.left) || isDefinitelyStringExpr(ast.right))) {
                errors.push({
                    line: astLine(ast),
                    col: astCol(ast),
                    message: '字符串拼接不能使用 +；请使用 join(a, b)。多个片段请嵌套 join，例如 join(join("第", n), "关")。'
                });
                return {prim: [10, '']};
            }
            if (ast.op === '>=' || ast.op === '<=' || ast.op === '!=') {
                const compareOp = ast.op === '>=' ? '<' : (ast.op === '<=' ? '>' : '==');
                const notId = addBlock('operator_not', {parent: parentId, line: astLine(ast), col: astCol(ast)});
                const compareId = addBlock(BIN_OP_TO_OPCODE[compareOp], {parent: notId, line: astLine(ast), col: astCol(ast)});
                const [a1, a2, primType] = BIN_OP_ARGS[compareOp];
                const rL = compileExpr(ast.left, compareId, primType);
                const rR = compileExpr(ast.right, compareId, primType);
                setInputRef(compareId, a1, rL, primType);
                setInputRef(compareId, a2, rR, primType);
                setInputRef(notId, 'OPERAND', {blockId: compareId}, null);
                return withLoc({blockId: notId});
            }
            const opcode = BIN_OP_TO_OPCODE[ast.op];
            const [a1, a2, primType] = BIN_OP_ARGS[ast.op];
            const id = addBlock(opcode, {parent: parentId, line: astLine(ast), col: astCol(ast)});
            const rL = compileExpr(ast.left, id, primType);
            const rR = compileExpr(ast.right, id, primType);
            setInputRef(id, a1, rL, primType);
            setInputRef(id, a2, rR, primType);
            return withLoc({blockId: id});
        }
        if (ast.kind === 'call') {
            if (ast.name === '@op') {
                return withLoc(compileOpCall(ast, parentId));
            }
            // procedures 专用：arg/arg_bool → argument_reporter_*，call/callret → procedures_call
            if (ast.name === 'arg' && ast.args.length === 1 && ast.args[0].kind === 'strlit') {
                const id = addBlock('argument_reporter_string_number', {parent: parentId, line: astLine(ast), col: astCol(ast)});
                outBlocks[id].fields.VALUE = [ast.args[0].value, null];
                return withLoc({blockId: id});
            }
            if (ast.name === 'arg_bool' && ast.args.length === 1 && ast.args[0].kind === 'strlit') {
                const id = addBlock('argument_reporter_boolean', {parent: parentId, line: astLine(ast), col: astCol(ast)});
                outBlocks[id].fields.VALUE = [ast.args[0].value, null];
                return withLoc({blockId: id});
            }
            if ((ast.name === 'call' || ast.name === 'callret') && ast.args.length >= 1) {
                const tok = astAsProcToken(ast.args[0]);
                if (tok != null) {
                    const proccode = resolveProccodeFromCallName(tok);
                    const restAsts = ast.args.slice(1);
                    return withLoc(buildProcedureCall(proccode, restAsts, ast.name === 'callret', parentId, ast));
                }
            }
            // 特判 var("x") / list("x") / broadcast_ref("x")
            if (ast.name === 'var' && ast.args.length === 1 && ast.args[0].kind === 'strlit') {
                const ref = resolveVariableRef(ast.args[0].value);
                return withLoc({prim: [12, ref.name, ref.id]});
            }
            if (ast.name === 'list' && ast.args.length === 1 && ast.args[0].kind === 'strlit') {
                const ref = resolveListRef(ast.args[0].value);
                return withLoc({prim: [13, ref.name, ref.id]});
            }
            if (ast.name === 'broadcast_ref' && ast.args.length === 1 && ast.args[0].kind === 'strlit') {
                const n = ast.args[0].value;
                return withLoc({prim: [11, n, resolveBroadcastId(n)]});
            }
            const mathOperator = MATH_OP_NAME_TO_OPERATOR.get(ast.name);
            if (mathOperator && ast.args.length === 1) {
                const id = addBlock('operator_mathop', {parent: parentId, line: astLine(ast), col: astCol(ast)});
                outBlocks[id].fields.OPERATOR = [mathOperator, null];
                const r = compileExpr(ast.args[0], id, 4);
                setInputRef(id, 'NUM', r, 4);
                return withLoc({blockId: id});
            }
            const def = getNameDef(ast.name);
            // 裸标识符：无参调用且 def 要么不是 reporter/boolean、要么根本没登记 → 当成对变量/列表的引用。
            // 支持 "a" 这种写法直接代表 var("a")；变量名是下划线化过的，也能反查到真实 VM 变量。
            const defIsExpr = def && (def.kind === 'reporter' || def.kind === 'boolean');
            if (ast.args.length === 0 && !defIsExpr) {
                // 先查当前 define 的参数，命中直接作为 argument_reporter_* 引用（参数优先于 var/list）
                if (currentProcParams && currentProcParams.has(ast.name)) {
                    const t = currentProcParams.get(ast.name);
                    const opcode = t === 'b' ? 'argument_reporter_boolean' : 'argument_reporter_string_number';
                    const id = addBlock(opcode, {parent: parentId, line: astLine(ast), col: astCol(ast)});
                    outBlocks[id].fields.VALUE = [ast.name, null];
                    return withLoc({blockId: id});
                }
                const declaredOrPending = resolveKnownDataIdent(ast.name);
                if (declaredOrPending) return withLoc(declaredOrPending);
                if (ctxTarget) {
                    if (ctxTarget.lookupVariableByNameAndType) {
                        const vExact = ctxTarget.lookupVariableByNameAndType(ast.name, '');
                        if (vExact) return withLoc({prim: [12, vExact.name, vExact.id]});
                        const lExact = ctxTarget.lookupVariableByNameAndType(ast.name, 'list');
                        if (lExact) return withLoc({prim: [13, lExact.name, lExact.id]});
                    }
                    const vSan = findBySanitizedName(ast.name, '');
                    if (vSan) return withLoc({prim: [12, vSan.name, vSan.id]});
                    const lSan = findBySanitizedName(ast.name, 'list');
                    if (lSan) return withLoc({prim: [13, lSan.name, lSan.id]});
                }
            }
            if (!def) {
                // reporter 位置 `foo(args)` 兜底：如果 name 能被 resolve 为已知 proccode → procedures_call reporter
                if (ast.name && isKnownProcName(ast.name)) {
                    const proccode = resolveProccodeFromCallName(ast.name);
                    return withLoc(buildProcedureCall(proccode, ast.args, true, parentId, ast));
                }
                errors.push({line: astLine(ast), col: astCol(ast), message: `未知函数: ${ast.name}`});
                return withLoc({prim: [10, '']});
            }
            // 建 block
            const id = addBlock(def.opcode, {parent: parentId, line: astLine(ast), col: astCol(ast)});
            applyCallArgsToBlock(id, def, ast.args);
            return withLoc({blockId: id});
        }
        errors.push({line: astLine(ast), col: astCol(ast), message: `无法编译表达式: ${JSON.stringify(ast)}`});
        return withLoc({prim: [10, '']});
    };

    // @op("opcode", shadow=?, fields={..}, inputs={..}, mutation="json") 的通用编译。
    // 仅支持最常见的 shadow_type=1 inputs 形态；mutation 保留原 JSON；遇到未覆盖的形态就尽力而为。
    const compileOpCall = (ast, parentId) => {
        const kwargs = ast.kwargs || {};
        const opArg = ast.args && ast.args[0];
        const opcode = (opArg && opArg.kind === 'strlit') ? opArg.value : '';
        if (!opcode) {
            errors.push({line: astLine(ast), col: astCol(ast), message: '@op 需要字符串 opcode 作为第一个参数'});
            return {prim: [10, '']};
        }
        const staticDef = getOpcodeDef(opcode);
        const runtimeMeta = runtimeOpcodeMeta.get(opcode);
        const isShadow = !!(kwargs.shadow && kwargs.shadow.kind === 'boollit' && kwargs.shadow.value);
        const id = addBlock(opcode, {parent: parentId, shadow: isShadow, line: astLine(ast), col: astCol(ast)});
        const kindKeys = ['kind', 'type', 'blockType', 'block_type', 'shape'];
        let opKind = (staticDef && staticDef.kind) || (runtimeMeta && runtimeMeta.kind);
        for (const key of kindKeys) {
            if (!kwargs[key]) continue;
            const explicitKind = normalizeRuntimeBlockKind(astToPlainString(kwargs[key]));
            if (explicitKind) {
                opKind = explicitKind;
                break;
            }
        }
        if (opKind) genericOpKindById.set(id, opKind);
        if (kwargs.fields && kwargs.fields.kind === 'objlit') {
            for (const entry of kwargs.fields.entries) {
                const v = astToPlainString(entry.value);
                outBlocks[id].fields[entry.key] = [v, null];
            }
        }
        if (kwargs.mutation && kwargs.mutation.kind === 'strlit') {
            try {
                outBlocks[id].mutation = JSON.parse(kwargs.mutation.value);
            } catch (_) { /* 坏 mutation 字符串忽略 */ }
        }
        if (kwargs.inputs && kwargs.inputs.kind === 'objlit') {
            for (const entry of kwargs.inputs.entries) {
                const key = entry.key;
                const staticArg = staticDef && Array.isArray(staticDef.args) ?
                    staticDef.args.find(arg => arg && arg.type !== 'field' && arg.name === key) : null;
                const slotMeta = runtimeMeta && runtimeMeta.args ? runtimeMeta.args[key] : null;
                const expectedPrimType = staticArg ? staticArg.primType :
                    (slotMeta && slotMeta.kind !== 'field' ? slotMeta.primType : undefined);
                const r = compileExpr(entry.value, id, expectedPrimType === undefined ? null : expectedPrimType);
                let ref = null;
                const child = r.blockId && outBlocks[r.blockId];
                if (child && !Array.isArray(child) && child.shadow) {
                    ref = [1, r.blockId];
                } else if (expectedPrimType !== undefined) {
                    ref = buildInputRef(r, id, expectedPrimType);
                } else if (r.blockId) {
                    ref = [1, r.blockId];
                } else if (r.prim) {
                    ref = [1, r.prim];
                }
                if (ref) outBlocks[id].inputs[key] = ref;
            }
        }
        return {blockId: id};
    };

    // call("proccode", v1, v2...) / callret(...) 构造 procedures_call block。
    // 按 proccode 找 argumentids（ctxProcedures → VM prototype → hash 兜底），把 input 按位置挂到对应 argumentid key。
    const buildProcedureCall = (proccode, argAsts, isReturn, parentBlockId, sourceAst) => {
        const argIds = resolveProcArgIds(proccode, argAsts.length);
        if (!ctxProcedures[proccode]) ctxProcedures[proccode] = argIds;
        // 顺便抄一份 prototype 的 warp 到 call 的 mutation（和 Scratch 生成一致）
        let protoWarp = false;
        const vmArg = lookupVmPrototypeArgIds(proccode);
        if (vmArg && ctxTarget && ctxTarget.blocks && ctxTarget.blocks._blocks) {
            const all = ctxTarget.blocks._blocks;
            for (const id of Object.keys(all)) {
                const b = all[id];
                if (b && b.opcode === 'procedures_prototype' && b.mutation && b.mutation.proccode === proccode) {
                    protoWarp = b.mutation.warp === 'true';
                    break;
                }
            }
        }
        const callId = addBlock('procedures_call', {
            parent: parentBlockId,
            line: astLine(sourceAst),
            col: astCol(sourceAst)
        });
        outBlocks[callId].mutation = {
            tagName: 'mutation',
            children: [],
            proccode,
            argumentids: JSON.stringify(argIds),
            warp: protoWarp ? 'true' : 'false'
        };
        if (isReturn) outBlocks[callId].mutation.return = '1';
        const n = Math.min(argAsts.length, argIds.length);
        for (let i = 0; i < n; i++) {
            const r = compileExpr(argAsts[i], callId, 10);
            if (r.blockId) outBlocks[callId].inputs[argIds[i]] = [1, r.blockId];
            else if (r.prim) outBlocks[callId].inputs[argIds[i]] = [1, r.prim];
        }
        return {blockId: callId, line: astLine(sourceAst), col: astCol(sourceAst)};
    };

    // 构建一个"输入引用"数组 [type, ref, shadow?]；返回 null 表示"不应该填此输入"
    const blockIsBooleanReporter = blockId => {
        const block = outBlocks[blockId];
        if (!block || Array.isArray(block)) return false;
        if (block.opcode === 'argument_reporter_boolean') return true;
        const def = getOpcodeDef(block.opcode);
        if (def && def.kind === 'boolean') return true;
        if (genericOpKindById.get(blockId) === 'boolean') return true;
        const meta = runtimeOpcodeMeta.get(block.opcode);
        return !!(meta && meta.kind === 'boolean');
    };

    const buildInputRef = (result, parentId, expectedPrimType) => {
        if (expectedPrimType == null) {
            // 布尔槽：只接受 reporter 块；字面量塞进去会让 Blockly 报 boolean mismatch
            if (result.blockId) {
                if (blockIsBooleanReporter(result.blockId)) return [2, result.blockId];
                const block = outBlocks[result.blockId];
                const opcode = block && block.opcode ? block.opcode : result.blockId;
                const loc = blockLoc.get(result.blockId) || blockLoc.get(parentId) || result;
                errors.push({line: tokenLine(loc), col: tokenCol(loc), message: `${opcode} 不能直接放进布尔输入，请写成比较表达式`});
            }
            return null;
        }
        if (result.prim) {
            const pType = result.prim[0];
            // 变量/列表/广播 primitive 放在"数字/文本/颜色"等值槽里时：
            // Scratch 语义是"reporter + shadow 默认"（type 3），而不是 type 1。
            // type 1 会让 Blockly 把变量块当作自己的 shadow，是个非法 shape，表现为
            // 积木应用后 "glow on block that does not exist"。
            if ((pType === 11 || pType === 12 || pType === 13) && pType !== expectedPrimType) {
                return [3, result.prim, defaultShadowPrim(expectedPrimType)];
            }
            return [1, result.prim];
        }
        if (result.blockId) {
            const shadow = defaultShadowPrim(expectedPrimType);
            return [3, result.blockId, shadow];
        }
        return null;
    };

    // 小助手：构建并设置 inputs[name]；若 buildInputRef 返回 null 则跳过（留空槽）
    const setInputRef = (blockId, inputName, result, expectedPrimType) => {
        const ref = buildInputRef(result, blockId, expectedPrimType);
        if (ref) outBlocks[blockId].inputs[inputName] = ref;
    };

    const defaultShadowPrim = (primType) => {
        if (primType === 4 || primType === 5 || primType === 6 || primType === 7 || primType === 8) {
            return [primType, ''];
        }
        if (primType === 9) return [9, '#990000'];
        if (primType === 10) return [10, ''];
        if (primType === 11) return [11, '', ''];
        return [10, ''];
    };

    // 把 AST 的参数列表应用到一个已建的 block 上（填 fields/inputs，含菜单 shadow）
    const applyCallArgsToBlock = (blockId, def, astArgs) => {
        for (let i = 0; i < def.args.length; i++) {
            const arg = def.args[i];
            const ast = astArgs[i];
            if (!ast) continue;
            if (arg.type === 'field') {
                // 字段：始终写成 [value, idOrNull] 两元素；菜单类字段 id 位填 null（匹配 Scratch 惯例）
                const str = astToPlainString(ast);
                if (arg.kind === 'variable') {
                    const ref = resolveVariableRef(str);
                    outBlocks[blockId].fields[arg.name] = [ref.name, ref.id];
                } else if (arg.kind === 'list') {
                    const ref = resolveListRef(str);
                    outBlocks[blockId].fields[arg.name] = [ref.name, ref.id];
                } else if (arg.name === 'BROADCAST_OPTION') {
                    outBlocks[blockId].fields[arg.name] = [str, resolveBroadcastId(str)];
                } else {
                    outBlocks[blockId].fields[arg.name] = [str, null];
                }
                continue;
            }
            // input
            if (arg.menu) {
                // 菜单槽既可以是下拉值，也可以拖入 reporter。字面量生成 menu shadow；
                // 变量/表达式生成 reporter + menu shadow fallback，匹配 Scratch 的输入 shape。
                const str = astToPlainString(ast);
                const menuId = addBlock(arg.menu.opcode, {
                    parent: blockId,
                    shadow: true,
                    fields: {[arg.menu.field]: [str, null]}
                });
                if (ast.kind === 'strlit' || ast.kind === 'numlit' || ast.kind === 'boollit') {
                    outBlocks[blockId].inputs[arg.name] = [1, menuId];
                    continue;
                }
                const r = compileExpr(ast, blockId, null);
                if (r.blockId) outBlocks[blockId].inputs[arg.name] = [3, r.blockId, menuId];
                else if (r.prim) outBlocks[blockId].inputs[arg.name] = [3, r.prim, menuId];
                else outBlocks[blockId].inputs[arg.name] = [1, menuId];
                continue;
            }
            const r = compileExpr(ast, blockId, arg.primType);
            setInputRef(blockId, arg.name, r, arg.primType);
        }
    };

    const astToPlainString = (ast) => {
        if (!ast) return '';
        if (ast.kind === 'strlit') return ast.value;
        if (ast.kind === 'numlit') return (ast.raw !== undefined) ? ast.raw : String(ast.value);
        if (ast.kind === 'boollit') return ast.value ? 'true' : 'false';
        if (ast.kind === 'call') return ast.name; // 兜底
        return '';
    };

    const applyControlStopMutation = blockId => {
        const block = outBlocks[blockId];
        const field = block && block.fields && block.fields.STOP_OPTION;
        const option = field ? String(field[0]) : '';
        const hasNext = option === 'other scripts in sprite';
        block.mutation = {
            tagName: 'mutation',
            children: [],
            hasnext: hasNext ? 'true' : 'false'
        };
    };

    const blockCanHaveNext = blockId => {
        const block = outBlocks[blockId];
        if (!block || Array.isArray(block)) return false;
        if (block.opcode === 'control_stop') {
            return block.mutation && block.mutation.hasnext === 'true';
        }
        if (block.opcode === 'control_forever' || block.opcode === 'control_delete_this_clone') {
            return false;
        }
        const def = getOpcodeDef(block.opcode);
        return !(def && def.kind === 'cap');
    };

    // 解析语句流：返回首块 id 或 null
    // 注：parseStatement 可能返回一条链的首块（赋值连等会产生多个 set 块通过 next 串起来），
    // 所以这里链接下一句时要先走到当前语句链的尾部再连。
    const parseStatementList = (parentBlockId) => {
        const heads = [];
        skipNewlines();
        while (true) {
            const t = peek();
            if (t.type === T.RBRACE || t.type === T.EOF) {
                if (pendingComments.length) {
                    const fallbackBlockId = heads.length ? heads[heads.length - 1] : parentBlockId;
                    if (fallbackBlockId) appendCommentsToBlock(fallbackBlockId, takePendingComments());
                    else appendWorkspaceComment(takePendingComments());
                }
                break;
            }
            const leadingComments = takePendingComments();
            const id = parseStatement(parentBlockId);
            if (id) {
                appendCommentsToBlock(id, leadingComments);
                appendInlineCommentsToBlock(id);
                heads.push(id);
            } else if (leadingComments.length) {
                pendingComments = leadingComments.concat(pendingComments);
            }
            skipNewlines();
        }
        for (let i = 0; i < heads.length; i++) {
            let tail = heads[i];
            while (outBlocks[tail] && outBlocks[tail].next) tail = outBlocks[tail].next;
            if (i < heads.length - 1) {
                if (blockCanHaveNext(tail)) {
                    outBlocks[tail].next = heads[i + 1];
                    outBlocks[heads[i + 1]].parent = tail;
                } else {
                    const loc = blockLoc.get(heads[i + 1]) || blockLoc.get(tail);
                    errors.push({line: tokenLine(loc), col: tokenCol(loc), message: `${outBlocks[tail].opcode} 后面不能继续接语句`});
                }
            }
        }
        return heads.length ? heads[0] : null;
    };

    const varRefAst = name => ({
        kind: 'call',
        name: 'var',
        args: [{kind: 'strlit', value: name}],
        kwargs: {},
        line: 1,
        col: 1
    });

    // 复合赋值：
    // target += RHS  → data_changevariableby(target, RHS)
    // target -= RHS / *= / /= / %= → set target to target op RHS
    const parseCompoundAssignment = (parentBlockId) => {
        const tok = peek();
        const name = String(tok.value);
        eat(); // target token
        const opToken = peek();
        const assignOp = String(opToken.value || '');
        const mathOp = assignOp.slice(0, -1);
        eat(); // compound operator
        const rhsAst = parseExpression(0);
        if (assignOp === '+=' && isDefinitelyStringExpr(rhsAst)) {
            errors.push({
                line: tokenLine(opToken),
                col: tokenCol(opToken),
                message: '字符串拼接不能使用 +=；请使用 join(a, b) 后再赋值，例如 name = join(name, "后缀")。'
            });
            return null;
        }
        const ref = resolveVariableRef(name);
        const id = addBlock(assignOp === '+=' ? 'data_changevariableby' : 'data_setvariableto', {
            parent: parentBlockId,
            line: tokenLine(tok),
            col: tokenCol(tok)
        });
        outBlocks[id].fields.VARIABLE = [ref.name, ref.id];
        if (assignOp === '+=') {
            const r = compileExpr(rhsAst, id, 4);
            setInputRef(id, 'VALUE', r, 4);
            return id;
        }
        if (!BIN_OP_TO_OPCODE[mathOp]) {
            errors.push({line: opToken.line, col: opToken.col, message: `不支持的复合赋值运算符: ${assignOp}`});
            return null;
        }
        const r = compileExpr({
            kind: 'binop',
            op: mathOp,
            left: varRefAst(name),
            right: rhsAst
        }, id, 10);
        setInputRef(id, 'VALUE', r, 10);
        return id;
    };

    // 赋值语句：target (= target)* = RHS
    // 连等按右结合顺序执行：c = b = a = a * 5  →  a = a * 5; b = a; c = b
    // 左侧可以是裸标识符（会经 sanitize 反查真实变量名）或字符串字面量（直接当变量名）。
    const parseAssignment = (parentBlockId) => {
        const targetNames = [];
        while ((peek().type === T.IDENT || peek().type === T.STRING) && peek(1).type === T.EQUALS) {
            const tok = peek();
            targetNames.push({raw: String(tok.value), wasIdent: tok.type === T.IDENT});
            eat(); // target token
            eat(); // '='
        }
        const rhsAst = parseExpression(0);
        const ids = [];
        for (let i = targetNames.length - 1; i >= 0; i--) {
            const t = targetNames[i];
            const valueAst = i === targetNames.length - 1 ? rhsAst : varRefAst(targetNames[i + 1].raw);
            const ref = resolveVariableRef(t.raw);
            const id = addBlock('data_setvariableto', {
                parent: parentBlockId,
                line: tokenLine(t),
                col: tokenCol(t)
            });
            outBlocks[id].fields.VARIABLE = [ref.name, ref.id];
            const r = compileExpr(valueAst, id, 10);
            setInputRef(id, 'VALUE', r, 10);
            ids.push(id);
        }
        for (let i = 0; i < ids.length - 1; i++) {
            outBlocks[ids[i]].next = ids[i + 1];
            outBlocks[ids[i + 1]].parent = ids[i];
        }
        return ids.length ? ids[0] : null;
    };

    // define "proccode"("argname" [as "argid"], ...) [warp] { body } —— 构造 procedures_definition +
    // procedures_prototype（shadow）+ 各参数的 argument_reporter_*（shadow）。body 里的 return / arg / arg_bool 由 compileExpr / parseStatement 分别处理。
    const parseDefine = (parentBlockId) => {
        eat(); // 'define'
        const pcTok = peek();
        if (pcTok.type !== T.STRING && pcTok.type !== T.IDENT) {
            errors.push({line: pcTok.line, col: pcTok.col, message: 'define 后需要 proccode（标识符或字符串）'});
            return null;
        }
        const rawProccode = String(pcTok.value);
        eat();
        expect(T.LPAREN);
        skipNewlines();
        // 参数语法：  [bool|str]  <ident-or-string-name>  [as "argumentid"]
        // 默认类型是 string/number；`bool` 前缀表示 boolean。
        // argumentid 省略时按 VM 已有 prototype 的 ids 回填，再不够就用 hash 生成，保持 round-trip 稳定。
        const paramNames = [];
        const paramTypes = [];
        const paramExplicitIds = [];
        while (peek().type !== T.RPAREN && peek().type !== T.EOF) {
            let type = 's';
            if (peek().type === T.IDENT && peek().value === 'bool') { eat(); type = 'b'; }
            else if (peek().type === T.IDENT && peek().value === 'str') { eat(); type = 's'; }
            const nameTok = peek();
            let pname;
            if (nameTok.type === T.IDENT || nameTok.type === T.STRING) {
                pname = String(nameTok.value);
                eat();
            } else {
                errors.push({line: nameTok.line, col: nameTok.col, message: 'define 参数需要标识符或字符串作为名字'});
                eat();
                skipNewlines();
                if (peek().type === T.COMMA) { eat(); skipNewlines(); }
                continue;
            }
            let explicitId = null;
            if (peek().type === T.IDENT && peek().value === 'as') {
                eat();
                const idTok = peek();
                if (idTok.type === T.STRING) { explicitId = idTok.value; eat(); }
                else { errors.push({line: idTok.line, col: idTok.col, message: 'as 后需要字符串 argumentid'}); eat(); }
            }
            paramNames.push(pname);
            paramTypes.push(type);
            paramExplicitIds.push(explicitId);
            skipNewlines();
            if (peek().type === T.COMMA) { eat(); skipNewlines(); continue; }
            break;
        }
        skipNewlines();
        expect(T.RPAREN);
        skipNewlines();
        let warp = false;
        if (peek().type === T.IDENT && peek().value === 'warp') {
            eat();
            warp = true;
            skipNewlines();
        }
        // 用户给的 rawProccode 若已带占位符（%b/%s），原样使用；否则按参数类型自动拼接完整 proccode。
        const proccode = PROC_PLACEHOLDER_RE.test(rawProccode)
            ? rawProccode
            : composeProccode(rawProccode, paramTypes);
        const vmIds = lookupVmPrototypeArgIds(proccode) || [];
        const paramIds = paramNames.map((_, i) => {
            if (paramExplicitIds[i] != null) return paramExplicitIds[i];
            if (i < vmIds.length) return vmIds[i];
            return `${hashStr(proccode)}_arg_${i}`;
        });
        const argdefaults = paramTypes.map(t => t === 'b' ? 'false' : '');
        const protoId = addBlock('procedures_prototype', {parent: null, shadow: true, line: tokenLine(pcTok), col: tokenCol(pcTok)});
        outBlocks[protoId].mutation = {
            tagName: 'mutation',
            children: [],
            proccode,
            argumentids: JSON.stringify(paramIds),
            argumentnames: JSON.stringify(paramNames),
            argumentdefaults: JSON.stringify(argdefaults),
            warp: warp ? 'true' : 'false'
        };
        for (let i = 0; i < paramIds.length; i++) {
            const op = paramTypes[i] === 'b' ? 'argument_reporter_boolean' : 'argument_reporter_string_number';
            const argId = addBlock(op, {parent: protoId, shadow: true, line: tokenLine(pcTok), col: tokenCol(pcTok)});
            outBlocks[argId].fields.VALUE = [paramNames[i], null];
            outBlocks[protoId].inputs[paramIds[i]] = [1, argId];
        }
        const defId = addBlock('procedures_definition', {parent: parentBlockId, line: tokenLine(pcTok), col: tokenCol(pcTok)});
        outBlocks[protoId].parent = defId;
        outBlocks[defId].inputs.custom_block = [1, protoId];
        // body：push 当前 proc 的参数上下文，让裸标识符/字符串识别为 argument_reporter_* 引用
        const prevProcParams = currentProcParams;
        const pm = new Map();
        for (let i = 0; i < paramNames.length; i++) pm.set(paramNames[i], paramTypes[i]);
        currentProcParams = pm;
        expect(T.LBRACE);
        const bodyFirst = parseStatementList(defId);
        expect(T.RBRACE);
        currentProcParams = prevProcParams;
        if (bodyFirst) {
            outBlocks[defId].next = bodyFirst;
            outBlocks[bodyFirst].parent = defId;
        }
        ctxProcedures[proccode] = paramIds;
        return defId;
    };

    // call("proccode", v1, v2, ...) 或 call(name, v1, ...) 作为语句；mutation 无 return 字段
    const parseCallStmt = (parentBlockId) => {
        eat(); // 'call'
        expect(T.LPAREN);
        skipNewlines();
        const pcTok = peek();
        if (pcTok.type !== T.STRING && pcTok.type !== T.IDENT) {
            errors.push({line: pcTok.line, col: pcTok.col, message: 'call 第一个参数需要 proccode（标识符或字符串）'});
            return null;
        }
        const proccode = resolveProccodeFromCallName(String(pcTok.value));
        eat();
        const argAsts = [];
        while (peek().type === T.COMMA) {
            eat();
            skipNewlines();
            argAsts.push(parseExpression(0));
        }
        skipNewlines();
        expect(T.RPAREN);
        const r = buildProcedureCall(proccode, argAsts, false, parentBlockId, {
            line: tokenLine(pcTok),
            col: tokenCol(pcTok)
        });
        return r.blockId || null;
    };

    // return <expr> / return —— 构造 TW 扩展 procedures_return block
    const parseReturn = (parentBlockId) => {
        const retTok = peek();
        eat(); // 'return'
        const retId = addBlock('procedures_return', {parent: parentBlockId, line: tokenLine(retTok), col: tokenCol(retTok)});
        if (peek().type !== T.NEWLINE && peek().type !== T.RBRACE && peek().type !== T.EOF) {
            const rhs = parseExpression(0);
            const r = compileExpr(rhs, retId, 10);
            if (r.blockId) outBlocks[retId].inputs.VALUE = [1, r.blockId];
            else if (r.prim) outBlocks[retId].inputs.VALUE = [1, r.prim];
        } else {
            outBlocks[retId].inputs.VALUE = [1, [10, '']];
        }
        return retId;
    };

    const isJsStyleVarDeclarationStart = () => {
        const t0 = peek();
        const t1 = peek(1);
        return t0.type === T.IDENT &&
            (t0.value === 'var' || t0.value === 'let') &&
            (t1.type === T.IDENT || t1.type === T.STRING);
    };

    const rejectJsStyleVarDeclaration = () => {
        const tok = peek();
        errors.push({
            line: tok.line,
            col: tok.col,
            message: '不支持 var/let 临时变量声明；请在伪代码开头使用 #vars 或 #localvars 声明变量，然后直接写赋值语句。'
        });
        while (peek().type !== T.NEWLINE && peek().type !== T.RBRACE && peek().type !== T.EOF) eat();
        if (peek().type === T.NEWLINE) eat();
        return null;
    };

    // 解析一条语句
    const parseStatement = (parentBlockId) => {
        // procedures 专用关键字优先（让 define/call/return 不被赋值路径吞掉，也绕开未知语句错误）
        if (peek().type === T.IDENT) {
            const kw = peek().value;
            if (kw === 'define') return parseDefine(parentBlockId);
            if (kw === 'call') return parseCallStmt(parentBlockId);
            if (kw === 'return') return parseReturn(parentBlockId);
        }
        if (isJsStyleVarDeclarationStart()) return rejectJsStyleVarDeclaration();
        // 隐式 stmt procedure call：`"proccode"(args)` 或裸 `foo(args)`（foo 非已登记 opcode/关键字）
        const implicitProc = (() => {
            const t0 = peek();
            const t1 = peek(1);
            if (t1.type !== T.LPAREN) return null;
            if (t0.type === T.STRING) return String(t0.value);
            if (t0.type === T.IDENT) {
                const nm = t0.value;
                // 排除关键字（define/call/return/@op/at）和已登记的语句 opcode
                if (nm === 'define' || nm === 'call' || nm === 'return' || nm === '@op' || nm === 'at') return null;
                const def = getNameDef(nm);
                if (def && (def.kind === 'hat' || def.kind === 'stmt' || def.kind === 'c' || def.kind === 'if-else' || def.kind === 'cap')) return null;
                if (isKnownProcName(nm)) return nm;
                return null;
            }
            return null;
        })();
        if (implicitProc != null) {
            const procTok = peek();
            const proccode = resolveProccodeFromCallName(implicitProc);
            eat(); // name token
            eat(); // LPAREN
            skipNewlines();
            const argAsts = [];
            if (peek().type !== T.RPAREN) {
                argAsts.push(parseExpression(0));
                while (peek().type === T.COMMA) {
                    eat();
                    skipNewlines();
                    argAsts.push(parseExpression(0));
                }
            }
            skipNewlines();
            expect(T.RPAREN);
            const r = buildProcedureCall(proccode, argAsts, false, parentBlockId, {
                line: tokenLine(procTok),
                col: tokenCol(procTok)
            });
            return r.blockId || null;
        }
        // 优先识别赋值：IDENT = ... / STRING = ...（含连等）
        if ((peek().type === T.IDENT || peek().type === T.STRING) && peek(1).type === T.EQUALS) {
            return parseAssignment(parentBlockId);
        }
        // 复合赋值：IDENT +=, -=, *=, /=, %= ... / STRING 同理
        if ((peek().type === T.IDENT || peek().type === T.STRING)
                && peek(1).type === T.OP && ['+=', '-=', '*=', '/=', '%='].indexOf(peek(1).value) >= 0) {
            return parseCompoundAssignment(parentBlockId);
        }
        const t = peek();
        if (t.type !== T.IDENT) {
            errors.push({line: t.line, col: t.col, message: `期待语句，得到 ${JSON.stringify(t.value)}`});
            eat();
            return null;
        }
        const name = t.value;
        eat();
        // args (+ 仅 @op 时消费 kwargs)
        const args = [];
        let kwargs = {};
        if (peek().type === T.LPAREN) {
            const r = parseCallTail(name === '@op');
            args.push(...r.args);
            kwargs = r.kwargs;
        }
        // @op 语句：绕开常规 def 分发，直接用通用路径构造 block（不接 substack）
        if (name === '@op') {
            const ast = {kind: 'call', name: '@op', args, kwargs, line: t.line, col: t.col};
            const r = compileOpCall(ast, parentBlockId);
            return r.blockId || null;
        }
        const def = getNameDef(name);
        if (!def) {
            errors.push({line: t.line, col: t.col, message: `未知语句: ${name}`});
            return null;
        }
        // substacks
        const subBodies = [];
        while (peek().type === T.LBRACE) {
            eat();
            const subFirst = parseStatementList(null);
            expect(T.RBRACE);
            subBodies.push(subFirst);
            skipNewlines();
            // if-else 的 else
            if (peek().type === T.IDENT && peek().value === 'else') {
                eat();
                expect(T.LBRACE);
                const elseFirst = parseStatementList(null);
                expect(T.RBRACE);
                subBodies.push(elseFirst);
                break;
            }
            break; // 一个语句至多支持一个主体（或 if-else 两个）
        }

        // 特判：if 跟两个主体 → 升级为 control_if_else（渲染时会写 if (...) { } else { }）
        if (name === 'if' && subBodies.length === 2) {
            const blockId = addBlock('control_if_else', {parent: parentBlockId, line: t.line, col: t.col});
            applyCallArgsToBlock(blockId, def, args); // CONDITION 槽位一样
            if (subBodies[0]) {
                outBlocks[blockId].inputs.SUBSTACK = [2, subBodies[0]];
                outBlocks[subBodies[0]].parent = blockId;
            }
            if (subBodies[1]) {
                outBlocks[blockId].inputs.SUBSTACK2 = [2, subBodies[1]];
                outBlocks[subBodies[1]].parent = blockId;
            }
            return blockId;
        }
        const blockId = addBlock(def.opcode, {parent: parentBlockId, line: t.line, col: t.col});
        applyCallArgsToBlock(blockId, def, args);
        if (def.opcode === 'control_stop') applyControlStopMutation(blockId);
        if (def.substacks && def.substacks.length) {
            for (let k = 0; k < def.substacks.length; k++) {
                const sub = subBodies[k];
                if (sub) {
                    outBlocks[blockId].inputs[def.substacks[k]] = [2, sub];
                    outBlocks[sub].parent = blockId;
                }
            }
        } else if (def.kind === 'hat' && subBodies.length) {
            outBlocks[blockId].next = subBodies[0];
            if (subBodies[0]) outBlocks[subBodies[0]].parent = blockId;
        }
        return blockId;
    };

    // 预扫 `define <proccode>(...)`：proccode 允许是 STRING 或 IDENT；把 proccode → argumentids 提前填进
    // ctxProcedures，这样当 call 出现在 define 之前、parse 顺序里 call 先遇到时也能用到正确的 argumentids。
    // 同时推断每个参数的类型（bool / s）；若用户给的 proccode 没写 `%` 占位符，按类型自动拼接出完整 proccode。
    const prescanDefines = () => {
        for (let k = 0; k < tokens.length - 2; k++) {
            if (tokens[k].type !== T.IDENT || tokens[k].value !== 'define') continue;
            const pcTok = tokens[k + 1];
            if (pcTok.type !== T.STRING && pcTok.type !== T.IDENT) continue;
            if (tokens[k + 2].type !== T.LPAREN) continue;
            const rawProccode = String(pcTok.value);
            const paramTypes = [];
            const explicitIds = [];
            let j = k + 3;
            let depth = 1;
            while (j < tokens.length && depth > 0) {
                const tok = tokens[j];
                if (tok.type === T.LPAREN) { depth++; j++; continue; }
                if (tok.type === T.RPAREN) { depth--; if (depth === 0) break; j++; continue; }
                // 类型修饰 bool / str：跟着的 IDENT/STRING 是参数名；记录类型
                let pendingType = 's';
                if (tok.type === T.IDENT && (tok.value === 'bool' || tok.value === 'str')) {
                    pendingType = tok.value === 'bool' ? 'b' : 's';
                    j++;
                    if (j >= tokens.length) break;
                }
                const nameTok = tokens[j];
                if (nameTok && (nameTok.type === T.STRING || nameTok.type === T.IDENT)) {
                    j++;
                    let aid = null;
                    if (j < tokens.length && tokens[j].type === T.IDENT && tokens[j].value === 'as'
                            && j + 1 < tokens.length && tokens[j + 1].type === T.STRING) {
                        aid = tokens[j + 1].value;
                        j += 2;
                    }
                    paramTypes.push(pendingType);
                    explicitIds.push(aid);
                    continue;
                }
                j++;  // COMMA / NEWLINE / 其他都跳
            }
            const proccode = PROC_PLACEHOLDER_RE.test(rawProccode)
                ? rawProccode
                : composeProccode(rawProccode, paramTypes);
            const vmIds = lookupVmPrototypeArgIds(proccode) || [];
            const ids = explicitIds.map((aid, idx) => {
                if (aid != null) return aid;
                if (idx < vmIds.length) return vmIds[idx];
                return `${hashStr(proccode)}_arg_${idx}`;
            });
            if (!ctxProcedures[proccode]) ctxProcedures[proccode] = ids;
        }
    };
    prescanDefines();

    // ---- 主循环 ----
    skipNewlines();
    while (peek().type !== T.EOF) {
        const t = peek();
        if (t.type === T.HASH_KEYWORD) {
            const kw = t.value;
            eat();
            if (kw === 'vars' || kw === '变量') parseHeaderBlock(declaredVars);
            else if (kw === 'lists' || kw === '列表') parseHeaderBlock(declaredLists);
            else if (kw === 'localvars' || kw === '局部变量') parseHeaderBlock(declaredLocalVars);
            else if (kw === 'locallists' || kw === '局部列表') parseHeaderBlock(declaredLocalLists);
            else {
                errors.push({line: t.line, col: t.col, message: `未知头部关键字: #${kw}`});
                // 尝试跳到下一个换行
                while (peek().type !== T.NEWLINE && peek().type !== T.EOF) eat();
            }
            skipNewlines();
            continue;
        }
        // 可选 at(x,y) 前缀
        let leadingComments = takePendingComments();
        let topX = 0, topY = 0, hasAt = false;
        if (t.type === T.IDENT && t.value === 'at' && peek(1).type === T.LPAREN) {
            eat(); // at
            eat(); // (
            const xAst = parseExpression(0);
            expect(T.COMMA);
            const yAst = parseExpression(0);
            expect(T.RPAREN);
            topX = Number(astToPlainString(xAst)) || 0;
            topY = Number(astToPlainString(yAst)) || 0;
            hasAt = true;
            // 允许跟换行
            skipNewlines();
            leadingComments = leadingComments.concat(takePendingComments());
        }
        const attachTopLevelComments = id => {
            appendCommentsToBlock(id, leadingComments);
            appendInlineCommentsToBlock(id);
        };
        const after = peek();
        if (isJsStyleVarDeclarationStart()) {
            rejectJsStyleVarDeclaration();
            skipNewlines();
            continue;
        }
        if (after.type === T.LBRACE) {
            // 顶层无名脚本：一串语句
            eat();
            const firstId = parseStatementList(null);
            expect(T.RBRACE);
            if (firstId) {
                outBlocks[firstId].topLevel = true;
                outBlocks[firstId].x = topX;
                outBlocks[firstId].y = topY;
                outBlocks[firstId].parent = null;
                attachTopLevelComments(firstId);
            }
            skipNewlines();
            continue;
        }
        // 顶层赋值：IDENT = ... / STRING = ...（含连等）或复合赋值
        if ((after.type === T.IDENT || after.type === T.STRING)
                && (peek(1).type === T.EQUALS
                    || (peek(1).type === T.OP && ['+=', '-=', '*=', '/=', '%='].indexOf(peek(1).value) >= 0))) {
            const id = parseStatement(null);
            if (id) {
                outBlocks[id].topLevel = true;
                outBlocks[id].x = topX;
                outBlocks[id].y = topY;
                outBlocks[id].parent = null;
                attachTopLevelComments(id);
            }
            skipNewlines();
            continue;
        }
        // 顶层隐式 stmt procedure call："proccode"(args) —— parseStatement 的 STRING+LPAREN 分支接住
        if (after.type === T.STRING && peek(1).type === T.LPAREN) {
            const id = parseStatement(null);
            if (id) {
                outBlocks[id].topLevel = true;
                outBlocks[id].x = topX;
                outBlocks[id].y = topY;
                outBlocks[id].parent = null;
                attachTopLevelComments(id);
            }
            skipNewlines();
            continue;
        }
        // IDENT 且是已知 hat/stmt/c/if-else/cap → 解析为语句；否则回退到表达式（浮动 reporter）
        if (after.type === T.IDENT) {
            const def = getNameDef(after.value);
            const asStmt = def && (def.kind === 'hat' || def.kind === 'stmt' || def.kind === 'c' || def.kind === 'if-else' || def.kind === 'cap');
            const isProcKeyword = after.value === 'define' || after.value === 'call' || after.value === 'return';
            // 裸 `foo(args)` 若 foo 是已知 proccode 的 name → 作 stmt procedures_call
            const isProcCallStmt = !def && peek(1).type === T.LPAREN && isKnownProcName(after.value);
            if (asStmt || after.value === '@op' || isProcKeyword || isProcCallStmt) {
                const id = parseStatement(null);
                if (id) {
                    outBlocks[id].topLevel = true;
                    outBlocks[id].x = topX;
                    outBlocks[id].y = topY;
                    outBlocks[id].parent = null;
                    attachTopLevelComments(id);
                }
                skipNewlines();
                continue;
            }
        }
        if (after.type === T.EOF) {
            if (leadingComments.length) appendWorkspaceComment(leadingComments);
            break;
        }
        // 其他：当作浮动表达式（top-level reporter/boolean 块）
        const expr = parseExpression(0);
        const r = compileExpr(expr, null, null);
        if (r.blockId) {
            outBlocks[r.blockId].topLevel = true;
            outBlocks[r.blockId].x = topX;
            outBlocks[r.blockId].y = topY;
            outBlocks[r.blockId].parent = null;
            attachTopLevelComments(r.blockId);
        } else if (r.prim) {
            // 浮动字面量：存为独立的 primitive 块
            const pid = addPrimitiveBlock(r.prim);
            // primitive 条目是数组形态，无法挂 topLevel/x/y；退而求其次保留为输出
            if (leadingComments.length) appendWorkspaceComment(leadingComments);
        }
        skipNewlines();
    }
    if (pendingComments.length) appendWorkspaceComment(takePendingComments());

    // 压缩 primitive：任何被 input 引用的 primitive-ish 块保留为对象形态也可，
    // 但为了输出更贴近 sb3.serialize 的样子，保持我们已经用数组形式 addPrimitiveBlock 的内联。
    // 目前所有 primitive 都作为 inline（直接写在 inputs 里），没有独立键；不需要压缩。

    return {
        blocks: outBlocks, errors,
        declaredVars, declaredLists, declaredBroadcasts,
        declaredLocalVars, declaredLocalLists,
        pendingVars, pendingLists, pendingBroadcasts,
        comments: outComments
    };
};

// ========================= TRANSLATE =========================
// 在同一段伪代码里把所有"标识符"改写成目标形态。
//   target: 'zh' 改写成中文 cname；'op' 改写成原版 opcode。
// 只动标识符，不碰字符串字面量 / 行注释 / 块注释。
const translatePseudocode = (source, target) => {
    if (target !== 'zh' && target !== 'op') return source;
    const map = new Map();
    for (const def of OPCODE_DEFS) {
        if (target === 'zh') {
            if (!def.cname) continue;
            if (def.name) map.set(def.name, def.cname);
            map.set(def.opcode, def.cname);
        } else {
            if (def.name) map.set(def.name, def.opcode);
            if (def.cname) map.set(def.cname, def.opcode);
        }
    }
    // 头部关键字 #vars / #lists / #localvars / #locallists ↔ #变量 / #列表 / #局部变量 / #局部列表
    const headerMap = new Map();
    const headerPairs = [
        ['vars', '变量'], ['lists', '列表'],
        ['localvars', '局部变量'], ['locallists', '局部列表']
    ];
    for (const [en, zh] of headerPairs) {
        if (target === 'zh') { headerMap.set(en, zh); headerMap.set(zh, zh); }
        else { headerMap.set(zh, en); headerMap.set(en, en); }
    }
    let out = '';
    let i = 0;
    const n = source.length;
    while (i < n) {
        const c = source[i];
        if (c === '"') {
            let j = i + 1;
            while (j < n && source[j] !== '"') {
                if (source[j] === '\\' && j + 1 < n) j += 2;
                else j++;
            }
            if (j < n) j++;
            out += source.slice(i, j);
            i = j; continue;
        }
        if (c === '/' && source[i + 1] === '/') {
            let j = i + 2;
            while (j < n && source[j] !== '\n') j++;
            out += source.slice(i, j);
            i = j; continue;
        }
        if (c === '/' && source[i + 1] === '*') {
            let j = i + 2;
            while (j + 1 < n && !(source[j] === '*' && source[j + 1] === '/')) j++;
            j = Math.min(n, j + 2);
            out += source.slice(i, j);
            i = j; continue;
        }
        if (c === '#') {
            let j = i + 1;
            while (j < n && /[a-zA-Z_0-9\u4e00-\u9fa5]/.test(source[j])) j++;
            const word = source.slice(i + 1, j);
            out += '#' + (headerMap.has(word) ? headerMap.get(word) : word);
            i = j; continue;
        }
        if (/[a-zA-Z_$\u4e00-\u9fa5]/.test(c)) {
            let j = i;
            while (j < n && /[a-zA-Z_0-9$\u4e00-\u9fa5]/.test(source[j])) j++;
            const ident = source.slice(i, j);
            out += map.has(ident) ? map.get(ident) : ident;
            i = j; continue;
        }
        out += c;
        i++;
    }
    return out;
};

// 补全用的关键词池：三套标识符 + 少量语法关键词。
const KEYWORD_NAMES = Array.from(new Set(
    OPCODE_DEFS.flatMap(d => [d.name, d.cname, d.opcode]).filter(Boolean)
        .concat([...MATH_OP_NAME_TO_OPERATOR.keys()])
        .concat(['var', 'list', 'broadcast', 'true', 'false', 'else', 'define', 'warp', 'at', 'op',
            'call', 'callret', 'arg', 'arg_bool', 'return', 'as'])
)).sort();

export default {
    renderPseudocode,
    parsePseudocode,
    translatePseudocode,
    sanitizeIdent,
    keywordNames: KEYWORD_NAMES,
    opcodeDefs: OPCODE_DEFS
};
