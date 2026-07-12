use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::env;
use std::io::{self, BufRead, Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SERVER_NAME: &str = "40code-json-script-converter";
const SERVER_VERSION: &str = "0.3.0-native";
const PROTOCOL_VERSION: &str = "2025-06-18";
const LEGACY_BRIDGE_PATH: &str = "/json-script-converter/mcp";
const PSEUDOCODE_SYNTAX_URI: &str = "jsc://pseudocode/syntax";
const BODY_LIMIT: usize = 8 * 1024 * 1024;

#[cfg(windows)]
#[link(name = "user32")]
unsafe extern "system" {
    fn MessageBoxW(
        window: *mut std::ffi::c_void,
        text: *const u16,
        caption: *const u16,
        message_type: u32,
    ) -> i32;
}

const PSEUDOCODE_SYNTAX_GUIDE: &str = r#"# 40code json-script-converter pseudocode syntax

Use this syntax when calling edit_pseudocode. The pseudocode is converted to Scratch blocks inside the connected 40code editor.

Workflow:
1. Call get_target_info to learn targetRef values.
2. Call get_pseudocode for targets you will modify.
3. Create or replace SVG costumes/backdrops for vector UI. Use the bitmap costume tools when complete bitmap image data is available.
4. Apply code with edit_pseudocode.

Scripts are separated by a blank line. Use braces for script bodies and control blocks.

Global variables:
    #vars { screen, selectedLevel, createIndex }

Sprite-local variables:
    #localvars { buttonId }

Common event hats:
    on_flag_clicked() { broadcast("show-start") }
    on_broadcast("show-start") { show() }
    on_sprite_clicked() { broadcast("clicked") }
    on_clone_start() { buttonId = createIndex }

Common statements:
    screen = "start"
    selectedLevel += 1
    broadcast("show-help")
    wait(0.2)
    repeat(3) { change_y(10) }
    forever() { if (screen == "start") { show() } }

Useful looks and motion:
    goto_xy(0, 0)
    set_size(100)
    show()
    hide()
    switch_costume("Start Button")
    switch_backdrop("Start Screen")

For repeated menu buttons, use a global creation marker and local clone identity:
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
"#;

#[derive(Clone)]
struct Config {
    host: String,
    port: u16,
    bridge_path: String,
    mcp_http_path: String,
    call_timeout: Duration,
    poll_timeout: Duration,
    client_ttl: Duration,
}

struct BridgeCall {
    id: String,
    name: String,
    arguments: Value,
}

#[derive(Clone)]
struct BridgeClient {
    client_id: String,
    title: String,
    page_url: String,
    last_seen: Instant,
}

struct PendingCall {
    tx: Sender<Result<Value, String>>,
    created_at: Instant,
}

struct BridgeState {
    calls: VecDeque<BridgeCall>,
    pending: HashMap<String, PendingCall>,
    clients: HashMap<String, BridgeClient>,
}

struct Shared {
    config: Config,
    state: Mutex<BridgeState>,
    cv: Condvar,
    counter: AtomicU64,
}

fn normalize_path(value: String) -> String {
    let mut path = value.trim().to_string();
    if !path.starts_with('/') {
        path = format!("/{path}");
    }
    while path.len() > 1 && path.ends_with('/') {
        path.pop();
    }
    if path.is_empty() {
        "/".to_string()
    } else {
        path
    }
}

fn env_u16(name: &str, default: u16) -> u16 {
    env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn env_u64(name: &str, default: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn load_config() -> Config {
    Config {
        host: env::var("JSC_MCP_HOST").unwrap_or_else(|_| "127.0.0.1".to_string()),
        port: env_u16("JSC_MCP_PORT", 47740),
        bridge_path: normalize_path(
            env::var("JSC_MCP_BRIDGE_PATH").unwrap_or_else(|_| "/".to_string()),
        ),
        mcp_http_path: normalize_path(
            env::var("JSC_MCP_HTTP_PATH").unwrap_or_else(|_| "/mcp".to_string()),
        ),
        call_timeout: Duration::from_millis(env_u64("JSC_MCP_CALL_TIMEOUT_MS", 120000)),
        poll_timeout: Duration::from_millis(env_u64("JSC_MCP_POLL_TIMEOUT_MS", 25000)),
        client_ttl: Duration::from_millis(env_u64("JSC_MCP_CLIENT_TTL_MS", 60000)),
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis()
}

fn make_call_id(shared: &Shared) -> String {
    let n = shared.counter.fetch_add(1, Ordering::Relaxed);
    format!("jsc-call-{}-{}-{}", process::id(), now_millis(), n)
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": true
        }
    })
}

fn string_prop(description: &str) -> Value {
    json!({"type": "string", "description": description})
}

fn number_prop(description: &str) -> Value {
    json!({"type": "number", "description": description})
}

fn bool_prop(description: &str) -> Value {
    json!({"type": "boolean", "description": description})
}

fn array_prop(description: &str) -> Value {
    json!({"type": "array", "items": {"type": "string"}, "description": description})
}

fn object_prop(description: &str) -> Value {
    json!({"type": "object", "description": description, "additionalProperties": true})
}

fn tool_definitions() -> Vec<Value> {
    vec![
        tool(
            "jsc_bridge_status",
            "Return MCP bridge status and the connected 40code page URL without calling page tools.",
            json!({}),
            &[],
        ),
        tool(
            "jsc_get_pseudocode_syntax",
            "Return the pseudocode syntax guide for edit_pseudocode.",
            json!({}),
            &[],
        ),
        tool(
            "jsc_get_status",
            "Return the connected 40code page URL, status, current target, and target refs.",
            json!({}),
            &[],
        ),
        tool(
            "jsc_call_action",
            "Call any json-script-converter action payload directly.",
            json!({"action": object_prop("Action payload, hidden ACTION JSON, or batch payload.")}),
            &["action"],
        ),
        tool(
            "get_target_info",
            "List target/sprite/stage metadata.",
            json!({"targetRefs": array_prop("Target refs such as [\"a\", \"b\"]. Empty means all targets.")}),
            &[],
        ),
        tool(
            "get_pseudocode",
            "Read pseudocode for one or more targets.",
            json!({"targetRefs": array_prop("Target refs."), "startLine": number_prop("Optional 1-based start line."), "endLine": number_prop("Optional 1-based end line."), "lineRanges": {"type": "array", "items": object_prop("Line range.")}}),
            &[],
        ),
        tool(
            "search_text",
            "Search pseudocode text across targets.",
            json!({"query": string_prop("Text or regex pattern."), "targetRefs": array_prop("Target refs."), "caseSensitive": bool_prop("Case-sensitive search."), "regex": bool_prop("Regex search."), "maxResults": number_prop("Maximum returned matches.")}),
            &["query"],
        ),
        tool(
            "list_extensions",
            "List loaded, local, and optionally remote extensions.",
            json!({"query": string_prop("Optional search text."), "source": string_prop("Optional source filter."), "includeRemote": bool_prop("Query remote extension catalog."), "limit": number_prop("Maximum returned extensions.")}),
            &[],
        ),
        tool(
            "load_extension",
            "Load an extension by extensionId, slug, or URL.",
            json!({"extensionId": string_prop("Builtin/local extension id."), "slug": string_prop("TurboWarp extension slug."), "url": string_prop("Extension JavaScript URL.")}),
            &[],
        ),
        tool(
            "get_extension_blocks",
            "Return block/opcode metadata for a loaded extension.",
            json!({"extensionId": string_prop("Loaded extension id."), "query": string_prop("Optional opcode/name search text."), "limit": number_prop("Maximum returned blocks.")}),
            &["extensionId"],
        ),
        tool(
            "get_costume_info",
            "Return costume/backdrop metadata and SVG source when requested.",
            json!({"targetRef": string_prop("Target ref/name/id."), "targetRefs": array_prop("Optional multiple target refs."), "costumeName": string_prop("Costume/backdrop name."), "costumeIndex": number_prop("Zero-based costume/backdrop index."), "includeSvg": bool_prop("Include SVG source.")}),
            &[],
        ),
        tool(
            "inspect_costume",
            "Return a PNG data URL for a costume/backdrop image.",
            json!({"targetRef": string_prop("Target ref/name/id."), "costumeName": string_prop("Costume/backdrop name."), "costumeIndex": number_prop("Zero-based costume/backdrop index.")}),
            &[],
        ),
        tool(
            "get_stage_snapshot",
            "Return a PNG data URL screenshot of the stage.",
            json!({}),
            &[],
        ),
        tool(
            "click_green_flag",
            "Click the green flag / start the project.",
            json!({}),
            &[],
        ),
        tool("click_pause", "Pause the project.", json!({}), &[]),
        tool("click_stop", "Stop the project.", json!({}), &[]),
        tool(
            "create_sprite",
            "Create a new sprite.",
            json!({"name": string_prop("Requested sprite name.")}),
            &[],
        ),
        tool(
            "delete_sprite",
            "Delete a sprite. Pass confirm:true to skip in-page confirmation.",
            json!({"targetRef": string_prop("Target ref/name/id."), "name": string_prop("Sprite name."), "confirm": bool_prop("Confirm deletion.")}),
            &[],
        ),
        tool(
            "create_costume",
            "Create a blank costume/backdrop on a target.",
            json!({"targetRef": string_prop("Target ref/name/id."), "name": string_prop("Costume/backdrop name.")}),
            &[],
        ),
        tool(
            "delete_costume",
            "Delete a costume/backdrop. Pass confirm:true to skip in-page confirmation.",
            json!({"targetRef": string_prop("Target ref/name/id."), "costumeName": string_prop("Costume/backdrop name."), "costumeIndex": number_prop("Zero-based costume/backdrop index."), "confirm": bool_prop("Confirm deletion.")}),
            &[],
        ),
        tool(
            "create_svg_costume",
            "Create a new SVG costume/backdrop on a target.",
            json!({"targetRef": string_prop("Target ref/name/id."), "name": string_prop("Costume/backdrop name."), "svg": string_prop("Safe standalone SVG text."), "rotationCenterX": number_prop("Optional rotation center x."), "rotationCenterY": number_prop("Optional rotation center y.")}),
            &["svg"],
        ),
        tool(
            "replace_svg_costume",
            "Replace an existing costume/backdrop with SVG.",
            json!({"targetRef": string_prop("Target ref/name/id."), "costumeName": string_prop("Costume/backdrop name."), "costumeIndex": number_prop("Zero-based costume/backdrop index."), "newName": string_prop("Optional new costume/backdrop name."), "svg": string_prop("Safe standalone SVG text."), "rotationCenterX": number_prop("Optional rotation center x."), "rotationCenterY": number_prop("Optional rotation center y.")}),
            &["svg"],
        ),
        tool(
            "create_bitmap_costume",
            "Create a new bitmap costume/backdrop from image data. The image is normalized to PNG.",
            json!({"targetRef": string_prop("Target ref/name/id."), "name": string_prop("Costume/backdrop name."), "imageData": string_prop("PNG, JPEG, WebP, BMP, or GIF as a base64 data URL or raw base64 data."), "mimeType": string_prop("Image MIME type for raw base64. Defaults to image/png."), "rotationCenterX": number_prop("Optional rotation center x in source-image pixels."), "rotationCenterY": number_prop("Optional rotation center y in source-image pixels.")}),
            &["imageData"],
        ),
        tool(
            "replace_bitmap_costume",
            "Replace an existing costume/backdrop with bitmap image data. The image is normalized to PNG.",
            json!({"targetRef": string_prop("Target ref/name/id."), "costumeName": string_prop("Costume/backdrop name."), "costumeIndex": number_prop("Zero-based costume/backdrop index."), "newName": string_prop("Optional new costume/backdrop name."), "imageData": string_prop("PNG, JPEG, WebP, BMP, or GIF as a base64 data URL or raw base64 data."), "mimeType": string_prop("Image MIME type for raw base64. Defaults to image/png."), "rotationCenterX": number_prop("Optional rotation center x in source-image pixels."), "rotationCenterY": number_prop("Optional rotation center y in source-image pixels.")}),
            &["imageData"],
        ),
        tool(
            "edit_pseudocode",
            "Apply pseudocode edits. Read jsc://pseudocode/syntax first.",
            json!({"targetRef": string_prop("Target ref/name/id."), "mode": string_prop("replace or patch."), "pseudocode": string_prop("Full pseudocode when mode is replace."), "patches": {"type": "array", "items": object_prop("Patch object.")}, "edits": {"type": "array", "items": object_prop("Multi-target edit object.")}}),
            &[],
        ),
    ]
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn rpc_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message.into()}})
}

fn to_mcp_content(result: Value) -> Value {
    let is_error = result.get("ok").and_then(Value::as_bool) == Some(false);
    json!({
        "content": [{"type": "text", "text": serde_json::to_string_pretty(&result).unwrap_or_else(|_| "{}".to_string())}],
        "isError": is_error
    })
}

fn bridge_url(config: &Config) -> String {
    format!(
        "http://{}:{}{}",
        config.host,
        config.port,
        if config.bridge_path == "/" {
            "/"
        } else {
            &config.bridge_path
        }
    )
}

fn get_bridge_status(shared: &Shared) -> Value {
    let now = Instant::now();
    let state = shared.state.lock().unwrap();
    let mut clients: Vec<Value> = state
        .clients
        .values()
        .map(|client| {
            let last_seen_ms = now.duration_since(client.last_seen).as_millis() as u64;
            json!({
                "clientId": client.client_id,
                "title": client.title,
                "pageUrl": client.page_url,
                "lastSeenAgoMs": last_seen_ms,
                "lastSeenText": format!("{} 秒前", last_seen_ms / 1000)
            })
        })
        .collect();
    clients.sort_by_key(|item| {
        item.get("lastSeenAgoMs")
            .and_then(Value::as_u64)
            .unwrap_or(u64::MAX)
    });
    let active_client = clients.iter().find(|item| {
        item.get("lastSeenAgoMs")
            .and_then(Value::as_u64)
            .unwrap_or(u64::MAX)
            <= shared.config.client_ttl.as_millis() as u64
    });
    let connected = active_client.is_some();
    let page_title = active_client
        .and_then(|item| item.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let page_url = active_client
        .and_then(|item| item.get("pageUrl"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let status = if connected {
        "connected"
    } else {
        "waiting_for_page"
    };
    let status_text = if connected {
        "已连接：网页端已经接入本地桥接器，AI 软件可以调用当前页面工具"
    } else {
        "等待网页连接：请在页面里勾选“启用 MCP 桥接”"
    };
    let bridge_url = bridge_url(&shared.config);
    let mcp_http_url = format!(
        "http://{}:{}{}",
        shared.config.host, shared.config.port, shared.config.mcp_http_path
    );
    let pending_calls = state.calls.len();
    let waiting_results = state.pending.len();
    json!({
        "ok": true,
        "message": "40code MCP 本地桥接器正在运行。",
        "status": status,
        "statusText": status_text,
        "summary": format!(
            "运行中；{}；待发送任务 {} 个，等待返回结果 {} 个。",
            status_text,
            pending_calls,
            waiting_results
        ),
        "bridge": {
            "name": "40code MCP 本地桥接器",
            "host": shared.config.host,
            "port": shared.config.port,
            "path": shared.config.bridge_path,
            "legacyPath": LEGACY_BRIDGE_PATH,
            "bridgeUrl": bridge_url,
            "legacyBridgeUrl": format!("http://{}:{}{}", shared.config.host, shared.config.port, LEGACY_BRIDGE_PATH),
            "mcpHttpUrl": mcp_http_url,
            "rootMcpHttpUrl": format!("http://{}:{}/", shared.config.host, shared.config.port),
            "connected": connected,
            "pageTitle": page_title,
            "pageUrl": page_url,
            "status": status,
            "statusText": status_text,
            "pageHint": "网页端请连接 bridgeUrl；AI 软件请连接 mcpHttpUrl。",
            "clients": clients,
            "pendingCalls": pending_calls,
            "pendingCallsText": format!("待发送任务 {} 个", pending_calls),
            "waitingResults": waiting_results,
            "waitingResultsText": format!("等待返回结果 {} 个", waiting_results)
        }
    })
}

fn has_active_client(shared: &Shared) -> bool {
    let now = Instant::now();
    let state = shared.state.lock().unwrap();
    state
        .clients
        .values()
        .any(|client| now.duration_since(client.last_seen) <= shared.config.client_ttl)
}

fn enqueue_bridge_call(shared: &Shared, name: String, args: Value) -> Result<Value, String> {
    if !has_active_client(shared) {
        return Err("没有网页端连接到本地桥接器。请打开 40code 网页，进入 json-script-converter，并勾选“启用 MCP 桥接”后重试。".to_string());
    }
    let id = make_call_id(shared);
    let (tx, rx) = mpsc::channel();
    {
        let mut state = shared.state.lock().unwrap();
        state.pending.insert(
            id.clone(),
            PendingCall {
                tx,
                created_at: Instant::now(),
            },
        );
        state.calls.push_back(BridgeCall {
            id,
            name,
            arguments: args,
        });
        shared.cv.notify_all();
    }
    match rx.recv_timeout(shared.config.call_timeout) {
        Ok(result) => result,
        Err(_) => Err(format!(
            "等待网页端返回结果超时，已等待 {} 毫秒。",
            shared.config.call_timeout.as_millis()
        )),
    }
}

fn cleanup_pending(shared: &Shared) {
    let mut state = shared.state.lock().unwrap();
    let timeout = shared.config.call_timeout + Duration::from_secs(5);
    let now = Instant::now();
    state
        .pending
        .retain(|_, pending| now.duration_since(pending.created_at) <= timeout);
}

fn handle_rpc(shared: &Shared, message: Value) -> Option<Value> {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    if method.is_empty() {
        return Some(rpc_error(id, -32600, "JSON-RPC 请求缺少 method 字段。"));
    }
    if method.starts_with("notifications/") {
        return None;
    }
    let response = match method {
        "initialize" => rpc_result(
            id,
            json!({
                "protocolVersion": message.pointer("/params/protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL_VERSION),
                "capabilities": {"tools": {}, "resources": {}},
                "instructions": format!("This server edits 40code/Scratch projects through the json-script-converter addon. Before calling edit_pseudocode, read {} with resources/read or call jsc_get_pseudocode_syntax. Use the SVG costume tools for vector content and the bitmap costume tools for complete bitmap image data.", PSEUDOCODE_SYNTAX_URI),
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION}
            }),
        ),
        "ping" => rpc_result(id, json!({})),
        "tools/list" => rpc_result(id, json!({"tools": tool_definitions()})),
        "tools/call" => {
            let name = message
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or("");
            let args = message
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            if name.is_empty() {
                rpc_error(id, -32602, "tools/call 请求缺少 params.name。")
            } else if name == "jsc_bridge_status" {
                rpc_result(id, to_mcp_content(get_bridge_status(shared)))
            } else if name == "jsc_get_pseudocode_syntax" {
                rpc_result(
                    id,
                    json!({"content": [{"type": "text", "text": PSEUDOCODE_SYNTAX_GUIDE}], "isError": false}),
                )
            } else {
                let result = match enqueue_bridge_call(shared, name.to_string(), args) {
                    Ok(value) => value,
                    Err(error) => json!({"ok": false, "error": error}),
                };
                cleanup_pending(shared);
                rpc_result(id, to_mcp_content(result))
            }
        }
        "resources/list" => rpc_result(
            id,
            json!({"resources": [{
                "uri": PSEUDOCODE_SYNTAX_URI,
                "name": "40code 伪代码语法",
                "description": "edit_pseudocode 使用的语法说明和示例。",
                "mimeType": "text/markdown"
            }]}),
        ),
        "resources/read" => {
            let uri = message
                .pointer("/params/uri")
                .and_then(Value::as_str)
                .unwrap_or("");
            if uri == PSEUDOCODE_SYNTAX_URI {
                rpc_result(
                    id,
                    json!({"contents": [{"uri": uri, "mimeType": "text/markdown", "text": PSEUDOCODE_SYNTAX_GUIDE}]}),
                )
            } else {
                rpc_error(id, -32602, format!("未知资源：{uri}"))
            }
        }
        "prompts/list" => rpc_result(id, json!({"prompts": []})),
        _ => rpc_error(id, -32601, format!("不支持的 MCP 方法：{method}")),
    };
    Some(response)
}

struct HttpRequest {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn decode_component(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(hex);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn parse_query(raw: &str) -> HashMap<String, String> {
    let mut query = HashMap::new();
    for pair in raw.split('&').filter(|p| !p.is_empty()) {
        let mut parts = pair.splitn(2, '=');
        let key = decode_component(parts.next().unwrap_or(""));
        let value = decode_component(parts.next().unwrap_or(""));
        query.insert(key, value);
    }
    query
}

fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    stream.set_read_timeout(Some(Duration::from_secs(30))).ok();
    let mut buffer = Vec::new();
    let mut temp = [0u8; 4096];
    let header_end;
    loop {
        let n = stream.read(&mut temp).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("connection closed".to_string());
        }
        buffer.extend_from_slice(&temp[..n]);
        if buffer.len() > BODY_LIMIT {
            return Err("request too large".to_string());
        }
        if let Some(pos) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = pos + 4;
            break;
        }
    }

    let header_text = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = header_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "missing request line".to_string())?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/");
    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let content_length = headers
        .get("content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > BODY_LIMIT {
        return Err("request body too large".to_string());
    }
    let mut body = buffer[header_end..].to_vec();
    while body.len() < content_length {
        let n = stream.read(&mut temp).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&temp[..n]);
    }
    body.truncate(content_length);
    let (path, query) = if let Some((p, q)) = target.split_once('?') {
        (p.to_string(), parse_query(q))
    } else {
        (target.to_string(), HashMap::new())
    };
    Ok(HttpRequest {
        method,
        path,
        query,
        headers,
        body,
    })
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    status_text: &str,
    content_type: &str,
    body: &[u8],
) {
    let headers = format!(
        "HTTP/1.1 {status} {status_text}\r\n\
Content-Type: {content_type}\r\n\
Content-Length: {}\r\n\
Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
Access-Control-Allow-Headers: Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id\r\n\
Access-Control-Allow-Private-Network: true\r\n\
Access-Control-Expose-Headers: Mcp-Session-Id\r\n\
Cache-Control: no-store\r\n\
Connection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.write_all(body);
}

fn send_json(stream: &mut TcpStream, status: u16, value: Value) {
    let status_text = match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let body = serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec());
    write_response(
        stream,
        status,
        status_text,
        "application/json; charset=utf-8",
        &body,
    );
}

fn send_no_body(stream: &mut TcpStream, status: u16) {
    let status_text = match status {
        204 => "No Content",
        202 => "Accepted",
        405 => "Method Not Allowed",
        _ => "OK",
    };
    write_response(
        stream,
        status,
        status_text,
        "text/plain; charset=utf-8",
        b"",
    );
}

fn is_allowed_origin(origin: Option<&String>) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    origin.contains("127.0.0.1") || origin.contains("localhost") || origin.contains("[::1]")
}

fn bridge_suffix(config: &Config, path: &str) -> Option<String> {
    if path == config.mcp_http_path {
        return None;
    }
    if path == LEGACY_BRIDGE_PATH || path.starts_with(&format!("{LEGACY_BRIDGE_PATH}/")) {
        let suffix = &path[LEGACY_BRIDGE_PATH.len()..];
        return Some(if suffix.is_empty() {
            "/".to_string()
        } else {
            suffix.to_string()
        });
    }
    if config.bridge_path == "/" {
        return Some(if path.is_empty() {
            "/".to_string()
        } else {
            path.to_string()
        });
    }
    if path == config.bridge_path || path.starts_with(&format!("{}/", config.bridge_path)) {
        let suffix = &path[config.bridge_path.len()..];
        return Some(if suffix.is_empty() {
            "/".to_string()
        } else {
            suffix.to_string()
        });
    }
    None
}

fn handle_mcp_http(shared: &Shared, req: HttpRequest, stream: &mut TcpStream) {
    if !is_allowed_origin(req.headers.get("origin")) {
        send_json(
            stream,
            403,
            rpc_error(
                Value::Null,
                -32000,
                "当前网页来源不允许连接本地 MCP 桥接器。",
            ),
        );
        return;
    }
    if req.method == "OPTIONS" {
        send_no_body(stream, 204);
        return;
    }
    if req.method != "POST" {
        send_no_body(stream, 405);
        return;
    }
    let message: Value = match serde_json::from_slice(&req.body) {
        Ok(value) => value,
        Err(err) => {
            send_json(stream, 400, rpc_error(Value::Null, -32700, err.to_string()));
            return;
        }
    };
    if !message.is_object() || message.is_array() {
        send_json(
            stream,
            400,
            rpc_error(Value::Null, -32600, "请求体必须是单个 JSON-RPC 对象。"),
        );
        return;
    }
    if message.get("method").is_none()
        && (message.get("result").is_some() || message.get("error").is_some())
    {
        send_no_body(stream, 202);
        return;
    }
    let is_notification = message.get("id").is_none() && message.get("method").is_some();
    match handle_rpc(shared, message) {
        Some(response) if !is_notification => send_json(stream, 200, response),
        _ => send_no_body(stream, 202),
    }
}

fn handle_poll(shared: &Shared, req: HttpRequest, stream: &mut TcpStream) {
    let client_id = req
        .query
        .get("clientId")
        .cloned()
        .unwrap_or_else(|| "unknown".to_string());
    let title = req.query.get("title").cloned().unwrap_or_default();
    let page_url = req.query.get("pageUrl").cloned().unwrap_or_default();
    let deadline = Instant::now() + shared.config.poll_timeout;
    let mut state = shared.state.lock().unwrap();
    state.clients.insert(
        client_id.clone(),
        BridgeClient {
            client_id,
            title,
            page_url,
            last_seen: Instant::now(),
        },
    );
    loop {
        if !state.calls.is_empty() {
            let mut calls = Vec::new();
            for _ in 0..8 {
                let Some(call) = state.calls.pop_front() else {
                    break;
                };
                calls.push(json!({"id": call.id, "name": call.name, "arguments": call.arguments}));
            }
            drop(state);
            send_json(stream, 200, json!({"ok": true, "calls": calls}));
            return;
        }
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        let wait = deadline.saturating_duration_since(now);
        let (next_state, _) = shared.cv.wait_timeout(state, wait).unwrap();
        state = next_state;
    }
    drop(state);
    send_json(stream, 200, json!({"ok": true, "calls": []}));
}

fn handle_result(shared: &Shared, req: HttpRequest, stream: &mut TcpStream) {
    let payload: Value = match serde_json::from_slice(&req.body) {
        Ok(value) => value,
        Err(err) => {
            send_json(stream, 400, json!({"ok": false, "error": err.to_string()}));
            return;
        }
    };
    if let Some(client_id) = payload.get("clientId").and_then(Value::as_str) {
        let mut state = shared.state.lock().unwrap();
        let previous = state.clients.get(client_id);
        let title = payload
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| previous.map(|client| client.title.clone()))
            .unwrap_or_default();
        let page_url = payload
            .get("pageUrl")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| previous.map(|client| client.page_url.clone()))
            .unwrap_or_default();
        state.clients.insert(
            client_id.to_string(),
            BridgeClient {
                client_id: client_id.to_string(),
                title,
                page_url,
                last_seen: Instant::now(),
            },
        );
    }
    let id = payload.get("id").and_then(Value::as_str).unwrap_or("");
    let pending = {
        let mut state = shared.state.lock().unwrap();
        state.pending.remove(id)
    };
    let Some(pending) = pending else {
        send_json(
            stream,
            404,
            json!({"ok": false, "error": "未知或已过期的调用 ID。"}),
        );
        return;
    };
    if let Some(error) = payload.get("error").and_then(Value::as_str) {
        let _ = pending.tx.send(Err(error.to_string()));
    } else {
        let _ = pending
            .tx
            .send(Ok(payload.get("result").cloned().unwrap_or(Value::Null)));
    }
    send_json(stream, 200, json!({"ok": true}));
}

fn handle_http(shared: Arc<Shared>, mut stream: TcpStream) {
    let req = match read_http_request(&mut stream) {
        Ok(req) => req,
        Err(err) => {
            send_json(&mut stream, 400, json!({"ok": false, "error": err}));
            return;
        }
    };
    if req.method == "OPTIONS" {
        send_no_body(&mut stream, 204);
        return;
    }
    if req.path == shared.config.mcp_http_path {
        handle_mcp_http(&shared, req, &mut stream);
        return;
    }
    let Some(suffix) = bridge_suffix(&shared.config, &req.path) else {
        send_json(
            &mut stream,
            404,
            json!({"ok": false, "error": "没有找到这个接口。"}),
        );
        return;
    };
    match (req.method.as_str(), suffix.as_str()) {
        ("POST", "/") => handle_mcp_http(&shared, req, &mut stream),
        ("GET", "/poll") => handle_poll(&shared, req, &mut stream),
        ("GET", "/") | ("GET", "/status") => {
            send_json(&mut stream, 200, get_bridge_status(&shared))
        }
        ("POST", "/result") => handle_result(&shared, req, &mut stream),
        _ => send_json(
            &mut stream,
            404,
            json!({"ok": false, "error": "没有找到这个接口。"}),
        ),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StartupFailureKind {
    AlreadyRunning,
    PortInUse,
    Other,
}

fn is_address_in_use(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::AddrInUse || error.raw_os_error() == Some(10048)
}

fn probe_existing_bridge(config: &Config) -> bool {
    let host = match config.host.as_str() {
        "0.0.0.0" => "127.0.0.1",
        "::" => "::1",
        value => value,
    };
    let address = if host.contains(':') {
        format!("[{host}]:{}", config.port)
    } else {
        format!("{host}:{}", config.port)
    };
    let Ok(addresses) = address.to_socket_addrs() else {
        return false;
    };
    let status_path = if config.bridge_path == "/" {
        "/status".to_string()
    } else {
        format!("{}/status", config.bridge_path)
    };
    for socket_address in addresses {
        let Ok(mut stream) =
            TcpStream::connect_timeout(&socket_address, Duration::from_millis(500))
        else {
            continue;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
        let _ = stream.set_write_timeout(Some(Duration::from_millis(700)));
        let request = format!(
            "GET {status_path} HTTP/1.1\r\nHost: {host}:{}\r\nConnection: close\r\n\r\n",
            config.port
        );
        if stream.write_all(request.as_bytes()).is_err() {
            continue;
        }
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response);
        let Some((headers, body)) = response.split_once("\r\n\r\n") else {
            continue;
        };
        if !headers.starts_with("HTTP/1.1 200") && !headers.starts_with("HTTP/1.0 200") {
            continue;
        }
        let Ok(status) = serde_json::from_str::<Value>(body) else {
            continue;
        };
        if status.get("ok").and_then(Value::as_bool) == Some(true)
            && (status.pointer("/bridge/legacyPath").and_then(Value::as_str)
                == Some(LEGACY_BRIDGE_PATH)
                || status.pointer("/bridge/name").and_then(Value::as_str)
                    == Some("40code MCP 本地桥接器"))
        {
            return true;
        }
    }
    false
}

fn classify_startup_failure(error: &io::Error, existing_bridge: bool) -> StartupFailureKind {
    if is_address_in_use(error) {
        if existing_bridge {
            StartupFailureKind::AlreadyRunning
        } else {
            StartupFailureKind::PortInUse
        }
    } else {
        StartupFailureKind::Other
    }
}

fn startup_failure_message(config: &Config, error: &io::Error, kind: StartupFailureKind) -> String {
    match kind {
        StartupFailureKind::AlreadyRunning => format!(
            "40code MCP 本地桥接器已经在运行。\n\n\
             无需重复启动。请返回 40code 页面，勾选“启用 MCP 桥接”即可。\n\n\
             页面连接地址：{}\n\
             AI 软件 MCP 地址：http://{}:{}{}",
            bridge_url(config),
            config.host,
            config.port,
            config.mcp_http_path
        ),
        StartupFailureKind::PortInUse => format!(
            "40code MCP 本地桥接器无法启动。\n\n\
             本地端口 {} 已被其他程序占用。\n\
             请关闭占用该端口的程序，或重启电脑后再运行本程序。\n\n\
             如果已经启动过本桥接器，请只保留一个实例。\n\n\
             错误详情：{}",
            config.port, error
        ),
        StartupFailureKind::Other => format!(
            "40code MCP 本地桥接器启动失败。\n\n\
             请检查权限或网络设置后重试。\n\n\
             错误详情：{error}"
        ),
    }
}

#[cfg(windows)]
fn show_startup_message(message: &str, is_error: bool) {
    const MB_ICONERROR: u32 = 0x00000010;
    const MB_ICONINFORMATION: u32 = 0x00000040;
    const MB_SETFOREGROUND: u32 = 0x00010000;
    const MB_TOPMOST: u32 = 0x00040000;
    let title: Vec<u16> = "40code MCP 本地桥接器"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let text: Vec<u16> = message.encode_utf16().chain(std::iter::once(0)).collect();
    let icon = if is_error {
        MB_ICONERROR
    } else {
        MB_ICONINFORMATION
    };
    // Keep double-click startup failures visible after the console process exits.
    let _ = unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            icon | MB_SETFOREGROUND | MB_TOPMOST,
        )
    };
}

#[cfg(not(windows))]
fn show_startup_message(message: &str, _is_error: bool) {
    eprintln!("{message}");
}

fn report_startup_failure(config: &Config, error: &io::Error) -> i32 {
    let existing_bridge = is_address_in_use(error) && probe_existing_bridge(config);
    let kind = classify_startup_failure(error, existing_bridge);
    let message = startup_failure_message(config, error, kind);
    eprintln!("{message}");
    show_startup_message(&message, kind != StartupFailureKind::AlreadyRunning);
    if kind == StartupFailureKind::AlreadyRunning {
        0
    } else {
        1
    }
}

fn start_http(shared: Arc<Shared>) -> io::Result<()> {
    let addr = format!("{}:{}", shared.config.host, shared.config.port);
    let listener = TcpListener::bind(&addr)?;
    eprintln!("40code MCP 本地桥接器已启动。");
    eprintln!("网页端连接地址：{}", bridge_url(&shared.config));
    eprintln!(
        "AI 软件 MCP 地址：http://{}:{}{}",
        shared.config.host, shared.config.port, shared.config.mcp_http_path
    );
    eprintln!(
        "运行状态查看：http://{}:{}/status",
        shared.config.host, shared.config.port
    );
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let cloned = Arc::clone(&shared);
                thread::spawn(move || handle_http(cloned, stream));
            }
            Err(err) => eprintln!("接收连接失败：{err}"),
        }
    }
    Ok(())
}

fn start_stdio(shared: Arc<Shared>) {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else {
            break;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(trimmed) {
            Ok(message) => handle_rpc(&shared, message),
            Err(err) => Some(rpc_error(Value::Null, -32700, err.to_string())),
        };
        if let Some(response) = response {
            if let Ok(text) = serde_json::to_string(&response) {
                let _ = writeln!(stdout, "{text}");
                let _ = stdout.flush();
            }
        }
    }
}

fn main() {
    let config = load_config();
    let shared = Arc::new(Shared {
        config,
        state: Mutex::new(BridgeState {
            calls: VecDeque::new(),
            pending: HashMap::new(),
            clients: HashMap::new(),
        }),
        cv: Condvar::new(),
        counter: AtomicU64::new(1),
    });

    let stdio_shared = Arc::clone(&shared);
    thread::spawn(move || start_stdio(stdio_shared));

    if let Err(error) = start_http(Arc::clone(&shared)) {
        process::exit(report_startup_failure(&shared.config, &error));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config(port: u16) -> Config {
        Config {
            host: "127.0.0.1".to_string(),
            port,
            bridge_path: "/".to_string(),
            mcp_http_path: "/mcp".to_string(),
            call_timeout: Duration::from_secs(1),
            poll_timeout: Duration::from_secs(1),
            client_ttl: Duration::from_secs(1),
        }
    }

    #[test]
    fn duplicate_start_message_explains_that_the_bridge_is_ready() {
        let config = test_config(47740);
        let error = io::Error::from(io::ErrorKind::AddrInUse);
        let message = startup_failure_message(&config, &error, StartupFailureKind::AlreadyRunning);
        assert!(message.contains("已经在运行"));
        assert!(message.contains("无需重复启动"));
        assert!(message.contains("启用 MCP 桥接"));
    }

    #[test]
    fn occupied_port_message_includes_the_port_and_recovery() {
        let config = test_config(47740);
        let error = io::Error::from(io::ErrorKind::AddrInUse);
        let message = startup_failure_message(&config, &error, StartupFailureKind::PortInUse);
        assert!(message.contains("47740"));
        assert!(message.contains("已被其他程序占用"));
        assert!(message.contains("重启电脑"));
    }

    #[test]
    fn bridge_status_exposes_the_connected_page_url() {
        let mut clients = HashMap::new();
        clients.insert(
            "page-1".to_string(),
            BridgeClient {
                client_id: "page-1".to_string(),
                title: "40code Editor".to_string(),
                page_url: "https://example.com/editor?project=42#code".to_string(),
                last_seen: Instant::now(),
            },
        );
        let shared = Shared {
            config: test_config(47740),
            state: Mutex::new(BridgeState {
                calls: VecDeque::new(),
                pending: HashMap::new(),
                clients,
            }),
            cv: Condvar::new(),
            counter: AtomicU64::new(1),
        };

        let status = get_bridge_status(&shared);
        assert_eq!(
            status.pointer("/bridge/pageUrl").and_then(Value::as_str),
            Some("https://example.com/editor?project=42#code")
        );
        assert_eq!(
            status
                .pointer("/bridge/clients/0/pageUrl")
                .and_then(Value::as_str),
            Some("https://example.com/editor?project=42#code")
        );
    }

    #[test]
    fn existing_bridge_probe_recognizes_the_status_endpoint() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            let body = format!(r#"{{"ok":true,"bridge":{{"legacyPath":"{LEGACY_BRIDGE_PATH}"}}}}"#);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        assert!(probe_existing_bridge(&test_config(port)));
        server.join().unwrap();
    }
}
