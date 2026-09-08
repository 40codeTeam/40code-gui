# json-script-converter MCP service

This addon can be controlled by external MCP clients through a local bridge.
40code Desktop starts the bridge through its built-in desktop API. The web
version needs the standalone Windows bridge running before the page connection
is enabled:

```text
40code-mcp-bridge/40code-MCP本地桥接器.exe
```

The repository copies this executable to
`static/40code-mcp-bridge/40code-MCP本地桥接器.exe` for web builds and
`build/40code-mcp-bridge/40code-MCP本地桥接器.exe` for local desktop builds.

## MCP client setup

For Streamable HTTP, connect to:

```text
http://127.0.0.1:47740/mcp
```

JSON-RPC POST requests to `http://127.0.0.1:47740/` are also accepted. The old
page bridge prefix `/json-script-converter/mcp` remains available for
compatibility.

For stdio, launch the native bridge directly:

```json
{
  "mcpServers": {
    "40code-json-script-converter": {
      "command": "E:/S-my/40code/editor/40code-gui/build/40code-mcp-bridge/40code-MCP本地桥接器.exe"
    }
  }
}
```

During development, the Node bridge implements the same contract:

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

Open the json-script-converter AI/config view and enable **MCP bridge**. The
enabled state is remembered locally.

## Protocol and security

The preferred MCP protocol version is `2025-11-25`. The bridges also negotiate
the common compatibility versions listed in `mcp-tools.json`. A supported
client request receives that same version; an unknown version receives the
preferred version and is never echoed back.

HTTP `initialize` creates a random `Mcp-Session-Id`. Send it on every later MCP
HTTP request. Send the negotiated version as `MCP-Protocol-Version`; an omitted
version can be inferred from an initialized session, while an invalid,
unsupported, or conflicting version is rejected.

The server remains bound to a loopback host. If an HTTP request has an
`Origin`, it must be an exact allowed origin. Loopback origins on any local
development port, `https://40code.com`, and `https://www.40code.com` are
allowed by default. `JSC_MCP_ALLOWED_ORIGINS` can add comma-separated exact
origins for other trusted deployments. Hostnames are parsed exactly: arbitrary
subdomains and substring matches are never accepted. Successful CORS responses
return the request's exact value in `Access-Control-Allow-Origin`; the bridge
never sends a wildcard. Native clients may omit `Origin`.

Environment variables:

- `JSC_MCP_PORT`: bridge port, default `47740`
- `JSC_MCP_HOST`: loopback host, default `127.0.0.1`
- `JSC_MCP_BRIDGE_PATH`: page bridge path, default `/`
- `JSC_MCP_HTTP_PATH`: MCP HTTP endpoint, default `/mcp`
- `JSC_MCP_CALL_TIMEOUT_MS`: tool-call timeout, default `120000`
- `JSC_MCP_POLL_TIMEOUT_MS`: page long-poll timeout, default `25000`
- `JSC_MCP_CLIENT_TTL_MS`: page liveness window, default `60000`
- `JSC_MCP_ALLOWED_ORIGINS`: extra comma-separated exact page origins

If another program owns the port, the native executable shows a persistent
Chinese error dialog with recovery instructions. Starting a second bridge when
one is already running exits normally after explaining that no second instance
is needed.

## Pages and MCP sessions

Each browser page has its own queue. `jsc_list_pages` returns active page
metadata. `jsc_select_page {"clientId":"..."}` binds a page only for the
calling MCP session.

- With one active page, a session auto-selects it on its first page tool.
- With multiple active pages, page tools fail until that session calls
  `jsc_select_page`.
- A page reload rotates its random registration token, cancels old queued or
  leased calls, and resets affected session selection and page target
  references.

The raw `jsc_call_action` compatibility handler remains callable by name for
older clients, but it is intentionally absent from `tools/list`. New clients
should use the dedicated, strict tools.

## Dedicated tools

The canonical schemas live in `mcp-tools.json` and are reused by the browser
page, Node bridge, and native bridge. They reject unknown fields and constrain
enums, ranges, mutually exclusive selectors, pagination, and edit modes.

Start with `get_project_overview`. Useful focused reads include:

- `get_target_info`
- `get_runtime_state` with optional `targetRef` or `targetRefs`, data-value
  inclusion, and bounded data/list item limits (`0` explicitly requests no
  values/items)
- `get_pseudocode`
- `search_text`, which defaults to all targets, with bounded `contextLines`
  and cursor pagination (`maxResults` defaults to `50` and is capped at `200`)
- `get_costume_info`, `inspect_costume`, and `get_stage_snapshot`

`get_pseudocode {}` reads the current target. Broader reads must be explicit:

```json
{"scope":"targets","targetRefs":["a","b"],"maxChars":48000}
```

```json
{"scope":"all_sprites","maxChars":48000}
```

```json
{"scope":"all_targets","maxChars":48000}
```

The default `maxChars` is `48000`, and the maximum is `200000`. When a result
has `nextCursor`, pass it back as `cursor` until pagination finishes. A
`startLine`/`endLine` pair or strict per-target `lineRanges` can request
specific lines. A lone start or end line is invalid, and the paired form is
mutually exclusive with `lineRanges`.

Runtime control tools are `click_green_flag`, `click_pause`, and `click_stop`.
Project write tools include sprite/costume creation and deletion, SVG and
bitmap creation/replacement, and `edit_pseudocode`. External MCP execution is
trusted, so delete and write tools do not show an in-page confirmation.

Bitmap writes accept PNG, JPEG, WebP, BMP, or GIF as a base64 data URL or raw
base64 with `mimeType`. HTTP image URLs and abbreviated data are not accepted.
Page `imageAttachment` results are converted into standard MCP image content
(`type`, base64 `data`, and `mimeType`). Every tool result also includes
`structuredContent`; its image metadata does not repeat the large data URL.
The text content is only a short summary, so large pseudocode/search structures
are not serialized a second time.

## Pseudocode editing

Read `jsc://pseudocode/syntax` with `resources/read`, or call
`jsc_get_pseudocode_syntax`, before editing.

Prefer `edit_pseudocode` mode `patch` for localized changes. Use mode `replace`
only with a complete fetched target. A full replacement must keep every
declaration header, including declarations not referenced by the edited
scripts:

```text
#vars { screen selectedLevel }
#localvars { buttonId }
#lists { unlockedLevels }
#locallists { path }
```

When readable names conflict, fetched pseudocode uses `as` aliases. Preserve
the declarations and use the aliases exactly:

```text
#vars { "score" as global_score }
#localvars { "score" as local_score }
#lists { "items" as global_items }
#locallists { "items" as local_items }
```

## Internal page bridge contract

The addon page first calls `GET /poll` with `clientId`, `title`, and `pageUrl`.
The bridge returns a random `registrationToken`. Every later poll includes that
token and receives calls only from that page's queue.

Polling leases at most one call with `leaseToken` and `expiresAt`. Immediately
before execution, the page sends `POST /claim` with `clientId`,
`registrationToken`, call `id`, and `leaseToken`. Only a `200` response
authorizes execution. Cancellation, timeout, reload, or token rotation removes
the lease, so a later claim is rejected and the action is skipped.

After a successful claim, the page sends the same claimant fields to
`POST /result` with either `result` or `error`. Foreign, stale, unclaimed, and
late results are rejected. `notifications/cancelled` removes both queued and
leased calls. This claim boundary prevents a call cancelled after polling but
before execution from becoming a late write.
