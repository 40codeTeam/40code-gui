# 40code json-script-converter pseudocode syntax

Use this syntax when calling edit_pseudocode. The pseudocode is converted to Scratch blocks inside the connected 40code editor.

## Workflow

1. Call get_project_overview, then get_target_info when you need detailed target metadata.
2. Call get_pseudocode with an empty object for the current target. Use scope: "targets" with targetRefs, scope: "all_sprites", or scope: "all_targets" explicitly for broader reads. If nextCursor is returned, continue with cursor.
3. Create or replace vector costumes/backdrops with create_svg_costume or replace_svg_costume when the project needs visible UI. Use create_bitmap_costume or replace_bitmap_costume for bitmap image data.
4. Prefer edit_pseudocode mode: "patch" for localized changes. Use mode: "replace" only with complete fetched pseudocode, preserving its full declaration header.

## Basic shape

Scripts are separated by a blank line. Use braces for script bodies and control blocks.

Global variables:

    #vars { screen, selectedLevel, createIndex }

Sprite-local variables:

    #localvars { buttonId }

Lists:

    #lists { unlockedLevels }
    #locallists { path }

Keep all declaration headers when replacing a target, even when a declared value is not referenced by the edited scripts. When global/local values or variables/lists share a readable name, fetched pseudocode disambiguates them with an alias:

    #vars { "score" as global_score }
    #localvars { "score" as local_score }
    #lists { "items" as global_items }
    #locallists { "items" as local_items }

Use those aliases in expressions and assignments exactly as rendered. Do not remove or rename them during an unrelated edit.

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
