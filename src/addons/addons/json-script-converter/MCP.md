# json-script-converter MCP service

This addon can be controlled by external MCP clients through a local bridge.

40code Desktop starts the local MCP bridge through its built-in desktop API, so
desktop users do not need to download or run a separate program manually.

The web version needs a local bridge program. Download and run this standalone
Windows executable before enabling the page bridge:

```text
40code-mcp-bridge/40code-mcp-bridge-small.exe
```

In this repository the same executable is kept in
`static/40code-mcp-bridge/40code-mcp-bridge-small.exe` for web builds and in
`dist/40code-mcp-bridge/40code-mcp-bridge-small.exe` for the current local
build output.

## URL mode

On the web version, start `40code-mcp-bridge-small.exe` first. On 40code
Desktop, no manual start is needed. Then open the json-script-converter panel,
open the AI/config view, and enable **MCP bridge**. The enabled state is
remembered locally. MCP clients that support Streamable HTTP can then connect
with only this URL:

```text
http://127.0.0.1:47740/mcp
```

The page bridge used internally by the addon is:

```text
http://127.0.0.1:47740/
```

For convenience, JSON-RPC POST requests to `http://127.0.0.1:47740/` are also
handled as MCP requests. The old page bridge path
`/json-script-converter/mcp` remains supported for compatibility.

## Stdio mode

For MCP clients that prefer launching local servers, use this server command:

```json
{
  "mcpServers": {
    "40code-json-script-converter": {
      "command": "E:/S-my/40code/editor/40code-gui/dist/40code-mcp-bridge/40code-mcp-bridge-small.exe"
    }
  }
}
```

For development, the source server can also be launched directly:

```json
{
  "mcpServers": {
    "40code-json-script-converter": {
      "command": "node",
      "args": [
        "E:/S-my/40code/editor/40code-gui/src/addons/addons/json-script-converter/mcp-server.cjs"
      ]
    }
  }
}
```

Then open 40code GUI with the json-script-converter addon enabled, and enable
**MCP bridge** in the plugin UI. If another MCP service is already using port
`47740`, set `JSC_MCP_PORT` to another free port and update the bridge URL in
the plugin UI.

## Bridge

The MCP server opens a local HTTP bridge for the browser page:

```text
http://127.0.0.1:47740/
```

Environment variables:

- `JSC_MCP_PORT`: bridge port, default `47740`
- `JSC_MCP_HOST`: bridge host, default `127.0.0.1`
- `JSC_MCP_BRIDGE_PATH`: page bridge path, default `/`
- `JSC_MCP_HTTP_PATH`: MCP HTTP endpoint path, default `/mcp`
- `JSC_MCP_CALL_TIMEOUT_MS`: tool-call timeout, default `120000`

If you change the bridge URL, set this in the page before the addon starts:

```js
localStorage.setItem(
  'jsonScriptConverter.mcpBridgeUrl.v1',
  'http://127.0.0.1:47740'
);
```

## Tools

The MCP server exposes the same action names used by the addon AI panel, such
as `get_target_info`, `get_pseudocode`, `search_text`, `list_extensions`,
`load_extension`, `get_extension_blocks`, `get_costume_info`,
`create_sprite`, `create_svg_costume`, `edit_pseudocode`, `click_green_flag`,
`click_pause`, and `click_stop`.

Destructive tools like `delete_sprite` and `delete_costume` still ask for
in-page confirmation by default. Pass `confirm: true` only when the external
caller intentionally confirms the delete.

Use `jsc_bridge_status` to check whether the browser page is attached, and
`jsc_get_status` to inspect the connected page state and target refs.

## Pseudocode syntax

Clients do not need to read this repository to learn the edit syntax. The MCP
server advertises a syntax resource:

```text
jsc://pseudocode/syntax
```

Call `resources/list` and `resources/read`, or call the tool
`jsc_get_pseudocode_syntax`, before generating `edit_pseudocode` payloads. The
`initialize` response also includes server instructions that point clients to
this resource.
