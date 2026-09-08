use serde_json::{Map, Value, json};
use std::collections::{HashMap, VecDeque};
use std::env;
#[cfg(not(windows))]
use std::fs::File;
use std::io::{self, BufRead, Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SERVER_NAME: &str = "40code-json-script-converter";
const SERVER_VERSION: &str = "0.5.0";
const PROTOCOL_VERSION: &str = "2025-11-25";
const LEGACY_PROTOCOL_VERSION: &str = "2025-03-26";
const LEGACY_BRIDGE_PATH: &str = "/json-script-converter/mcp";
const PSEUDOCODE_SYNTAX_URI: &str = "jsc://pseudocode/syntax";
const BODY_LIMIT: usize = 8 * 1024 * 1024;
const TOOL_CATALOG_JSON: &str =
    include_str!("../../../src/addons/addons/json-script-converter/mcp-tools.json");
const PSEUDOCODE_SYNTAX_GUIDE: &str =
    include_str!("../../../src/addons/addons/json-script-converter/pseudocode-syntax.md");

const SERVER_INSTRUCTIONS: &str = concat!(
    "This server edits 40code/Scratch projects through the json-script-converter addon. ",
    "Before calling edit_pseudocode for the first time, read jsc://pseudocode/syntax with ",
    "resources/read or call jsc_get_pseudocode_syntax. ",
    "Start with get_project_overview, then use get_pseudocode to inspect only the code needed. ",
    "Call get_pseudocode with no arguments for the current target; use scope all_sprites, ",
    "all_targets, or targets explicitly for broader reads and follow cursor pagination. ",
    "Prefer mode patch for small changes. A full replacement must preserve every declaration ",
    "header from the fetched pseudocode, including readable as aliases used for conflicting names. ",
    "Use create_svg_costume and replace_svg_costume for vector UI elements. ",
    "Use create_bitmap_costume and replace_bitmap_costume when complete bitmap image data is available."
);

#[cfg(windows)]
#[link(name = "bcrypt")]
unsafe extern "system" {
    fn BCryptGenRandom(
        algorithm: *mut std::ffi::c_void,
        buffer: *mut u8,
        length: u32,
        flags: u32,
    ) -> i32;
}

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

#[derive(Clone)]
struct Config {
    host: String,
    port: u16,
    bridge_path: String,
    mcp_http_path: String,
    call_timeout: Duration,
    poll_timeout: Duration,
    client_ttl: Duration,
    allowed_origins: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CallState {
    Queued,
    Leased,
    Claimed,
}

struct PendingCall {
    tx: Sender<Result<Value, String>>,
    name: String,
    arguments: Value,
    client_id: String,
    registration_token: String,
    lease_token: String,
    deadline: Instant,
    expires_at_ms: u128,
    state: CallState,
    request_key: String,
}

#[derive(Clone)]
struct BridgeClient {
    client_id: String,
    registration_token: String,
    title: String,
    page_url: String,
    last_seen: Instant,
    queue: VecDeque<String>,
    cancelled_call_ids: VecDeque<String>,
}

struct McpSession {
    protocol_version: String,
    selected_client_id: Option<String>,
    last_seen: Instant,
}

struct BridgeState {
    pending: HashMap<String, PendingCall>,
    clients: HashMap<String, BridgeClient>,
    sessions: HashMap<String, McpSession>,
    request_calls: HashMap<String, String>,
    cancelled_requests: HashMap<String, Instant>,
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
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn env_u64(name: &str, default: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn load_config() -> Config {
    let requested_host = env::var("JSC_MCP_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let host = match requested_host.to_ascii_lowercase().as_str() {
        "127.0.0.1" | "localhost" | "::1" => requested_host,
        _ => "127.0.0.1".to_string(),
    };
    let mut allowed_origins = vec![
        "https://40code.com".to_string(),
        "https://www.40code.com".to_string(),
    ];
    if let Ok(configured) = env::var("JSC_MCP_ALLOWED_ORIGINS") {
        allowed_origins.extend(
            configured
                .split(',')
                .filter_map(normalize_configured_origin),
        );
    }
    allowed_origins.sort();
    allowed_origins.dedup();
    Config {
        host,
        port: env_u16("JSC_MCP_PORT", 47740),
        bridge_path: normalize_path(
            env::var("JSC_MCP_BRIDGE_PATH").unwrap_or_else(|_| "/".to_string()),
        ),
        mcp_http_path: normalize_path(
            env::var("JSC_MCP_HTTP_PATH").unwrap_or_else(|_| "/mcp".to_string()),
        ),
        call_timeout: Duration::from_millis(env_u64("JSC_MCP_CALL_TIMEOUT_MS", 120_000)),
        poll_timeout: Duration::from_millis(env_u64("JSC_MCP_POLL_TIMEOUT_MS", 25_000)),
        client_ttl: Duration::from_millis(env_u64("JSC_MCP_CLIENT_TTL_MS", 60_000)),
        allowed_origins,
    }
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(windows)]
fn fill_os_random(buffer: &mut [u8]) -> bool {
    const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x00000002;
    unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        ) >= 0
    }
}

#[cfg(not(windows))]
fn fill_os_random(buffer: &mut [u8]) -> bool {
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(buffer))
        .is_ok()
}

fn random_token(shared: &Shared) -> String {
    let mut bytes = [0_u8; 24];
    if !fill_os_random(&mut bytes) {
        let counter = shared.counter.fetch_add(1, Ordering::Relaxed);
        let fallback = format!(
            "{}:{}:{}:{:p}",
            process::id(),
            unix_millis(),
            counter,
            shared
        );
        for (index, byte) in fallback.bytes().enumerate() {
            bytes[index % bytes.len()] ^= byte.rotate_left((index % 8) as u32);
        }
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn catalog() -> Value {
    serde_json::from_str(TOOL_CATALOG_JSON).expect("canonical MCP tool catalog must be valid JSON")
}

fn protocol_versions() -> Vec<String> {
    catalog()["protocolVersions"]
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn supports_protocol(version: &str) -> bool {
    protocol_versions()
        .iter()
        .any(|supported| supported == version)
}

fn negotiate_protocol_version(requested: Option<&str>) -> String {
    requested
        .filter(|version| supports_protocol(version))
        .unwrap_or(PROTOCOL_VERSION)
        .to_string()
}

fn tool_definitions() -> Vec<Value> {
    catalog()["tools"].as_array().cloned().unwrap_or_default()
}

fn tool_definition(name: &str) -> Option<Value> {
    tool_definitions()
        .into_iter()
        .find(|tool| tool.get("name").and_then(Value::as_str) == Some(name))
}

fn type_matches(value: &Value, expected: &str) -> bool {
    match expected {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "number" => value.is_number() && value.as_f64().is_some_and(f64::is_finite),
        "integer" => {
            value.as_i64().is_some()
                || value.as_u64().is_some()
                || value
                    .as_f64()
                    .is_some_and(|number| number.is_finite() && number.fract() == 0.0)
        }
        "null" => value.is_null(),
        _ => true,
    }
}

fn schema_errors(value: &Value, schema: &Value, path: &str) -> Vec<String> {
    let mut errors = Vec::new();
    let Some(rule) = schema.as_object() else {
        return errors;
    };
    let valid = |subrule: &Value| schema_errors(value, subrule, path).is_empty();

    if let Some(all_of) = rule.get("allOf").and_then(Value::as_array) {
        for subrule in all_of {
            errors.extend(schema_errors(value, subrule, path));
        }
    }
    if rule
        .get("anyOf")
        .and_then(Value::as_array)
        .is_some_and(|any_of| !any_of.iter().any(valid))
    {
        errors.push(format!("{path} must match at least one allowed shape"));
    }
    if rule
        .get("oneOf")
        .and_then(Value::as_array)
        .is_some_and(|one_of| one_of.iter().filter(|subrule| valid(subrule)).count() != 1)
    {
        errors.push(format!("{path} must match exactly one allowed shape"));
    }
    if rule.get("not").is_some_and(valid) {
        errors.push(format!("{path} uses a forbidden field combination"));
    }
    if rule.get("const").is_some_and(|expected| value != expected) {
        errors.push(format!("{path} does not equal the required value"));
    }
    if rule
        .get("enum")
        .and_then(Value::as_array)
        .is_some_and(|values| !values.contains(value))
    {
        errors.push(format!("{path} is not an allowed enum value"));
    }
    match rule.get("type").and_then(Value::as_str) {
        Some(expected_type) if !type_matches(value, expected_type) => {
            errors.push(format!("{path} must be {expected_type}"));
            return errors;
        }
        _ => {}
    }

    if let Some(object) = value.as_object() {
        let properties = rule.get("properties").and_then(Value::as_object);
        if let Some(required) = rule.get("required").and_then(Value::as_array) {
            for name in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(name) {
                    errors.push(format!("{path}.{name} is required"));
                }
            }
        }
        if let Some(dependencies) = rule.get("dependencies").and_then(Value::as_object) {
            for (name, required) in dependencies {
                if !object.contains_key(name) {
                    continue;
                }
                if let Some(required) = required.as_array() {
                    for dependent in required.iter().filter_map(Value::as_str) {
                        if !object.contains_key(dependent) {
                            errors.push(format!("{path}.{dependent} is required with {name}"));
                        }
                    }
                }
            }
        }
        for (name, child) in object {
            if let Some(child_schema) = properties.and_then(|items| items.get(name)) {
                errors.extend(schema_errors(
                    child,
                    child_schema,
                    &format!("{path}.{name}"),
                ));
            } else if rule.get("additionalProperties").and_then(Value::as_bool) == Some(false) {
                errors.push(format!("{path}.{name} is not allowed"));
            }
        }
    }
    if let Some(array) = value.as_array() {
        if rule
            .get("minItems")
            .and_then(Value::as_u64)
            .is_some_and(|minimum| array.len() < minimum as usize)
        {
            errors.push(format!("{path} has too few items"));
        }
        if rule
            .get("maxItems")
            .and_then(Value::as_u64)
            .is_some_and(|maximum| array.len() > maximum as usize)
        {
            errors.push(format!("{path} has too many items"));
        }
        if rule.get("uniqueItems").and_then(Value::as_bool) == Some(true) {
            let mut serialized: Vec<String> = array.iter().map(Value::to_string).collect();
            let original_len = serialized.len();
            serialized.sort();
            serialized.dedup();
            if serialized.len() != original_len {
                errors.push(format!("{path} items must be unique"));
            }
        }
        if let Some(item_schema) = rule.get("items") {
            for (index, child) in array.iter().enumerate() {
                errors.extend(schema_errors(
                    child,
                    item_schema,
                    &format!("{path}[{index}]"),
                ));
            }
        }
    }
    if let Some(text) = value.as_str() {
        let length = text.chars().count() as u64;
        if rule
            .get("minLength")
            .and_then(Value::as_u64)
            .is_some_and(|limit| length < limit)
        {
            errors.push(format!("{path} is too short"));
        }
        if rule
            .get("maxLength")
            .and_then(Value::as_u64)
            .is_some_and(|limit| length > limit)
        {
            errors.push(format!("{path} is too long"));
        }
        if rule.get("pattern").and_then(Value::as_str) == Some("^https://")
            && !text.starts_with("https://")
        {
            errors.push(format!("{path} has an invalid format"));
        }
    }
    if let Some(number) = value.as_f64() {
        if rule
            .get("minimum")
            .and_then(Value::as_f64)
            .is_some_and(|limit| number < limit)
        {
            errors.push(format!("{path} is below the minimum"));
        }
        if rule
            .get("maximum")
            .and_then(Value::as_f64)
            .is_some_and(|limit| number > limit)
        {
            errors.push(format!("{path} is above the maximum"));
        }
    }
    errors
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn rpc_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message.into()}})
}

fn rpc_error_with_data(id: Value, code: i64, message: impl Into<String>, data: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message.into(), "data": data}})
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0] as u32;
        let second = chunk.get(1).copied().unwrap_or(0) as u32;
        let third = chunk.get(2).copied().unwrap_or(0) as u32;
        let value = (first << 16) | (second << 8) | third;
        output.push(TABLE[((value >> 18) & 63) as usize] as char);
        output.push(TABLE[((value >> 12) & 63) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[((value >> 6) & 63) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(value & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn percent_decode_bytes(input: &str) -> Vec<u8> {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = |value: u8| match value {
                b'0'..=b'9' => Some(value - b'0'),
                b'a'..=b'f' => Some(value - b'a' + 10),
                b'A'..=b'F' => Some(value - b'A' + 10),
                _ => None,
            };
            if let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                output.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    output
}

fn valid_image_mime(value: &str) -> bool {
    value.starts_with("image/")
        && value[6..]
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".+-".contains(character))
}

fn parse_image_attachment(attachment: &Value) -> Option<Value> {
    let object = attachment.as_object()?;
    if let Some(data_url) = object.get("dataUrl").and_then(Value::as_str) {
        let rest = data_url.strip_prefix("data:")?;
        let (metadata, payload) = rest.split_once(',')?;
        let segments: Vec<&str> = metadata.split(';').collect();
        let mime = object
            .get("mimeType")
            .and_then(Value::as_str)
            .or_else(|| segments.first().copied())?
            .to_ascii_lowercase();
        if !valid_image_mime(&mime) {
            return None;
        }
        let data = if segments
            .iter()
            .any(|segment| segment.eq_ignore_ascii_case("base64"))
        {
            payload
                .chars()
                .filter(|character| !character.is_whitespace())
                .collect()
        } else {
            base64_encode(&percent_decode_bytes(payload))
        };
        if data.is_empty() {
            None
        } else {
            Some(json!({"type": "image", "data": data, "mimeType": mime}))
        }
    } else {
        let data = object.get("data").and_then(Value::as_str)?;
        let mime = object
            .get("mimeType")
            .and_then(Value::as_str)?
            .to_ascii_lowercase();
        if !valid_image_mime(&mime) {
            return None;
        }
        Some(
            json!({"type": "image", "data": data.chars().filter(|character| !character.is_whitespace()).collect::<String>(), "mimeType": mime}),
        )
    }
}

fn normalize_structured(value: &Value, images: &mut Vec<Value>) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| normalize_structured(item, images))
                .collect(),
        ),
        Value::Object(object) => {
            let mut output = Map::new();
            for (key, child) in object {
                if key == "imageAttachment" {
                    if let Some(image) = parse_image_attachment(child) {
                        images.push(image);
                    }
                    let metadata = child
                        .as_object()
                        .map(|attachment| {
                            let mut value = Map::new();
                            for name in ["label", "mimeType", "width", "height"] {
                                if let Some(field) = attachment.get(name) {
                                    value.insert(name.to_string(), field.clone());
                                }
                            }
                            Value::Object(value)
                        })
                        .unwrap_or(Value::Null);
                    output.insert(key.clone(), metadata);
                } else {
                    output.insert(key.clone(), normalize_structured(child, images));
                }
            }
            Value::Object(output)
        }
        _ => value.clone(),
    }
}

fn short_text(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        value.to_string()
    } else {
        format!("{}…", value.chars().take(limit).collect::<String>())
    }
}

fn summarize_mcp_result(structured: &Value) -> String {
    if structured.get("ok").and_then(Value::as_bool) == Some(false)
        || structured.get("error").is_some()
    {
        let error = structured
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Tool call failed.");
        return format!("Error: {}", short_text(error, 2000));
    }
    if let Some(summary) = structured
        .get("summary")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
    {
        return short_text(summary, 1000);
    }
    let mut parts = Vec::new();
    if let Some(tool_type) = structured.get("type").and_then(Value::as_str) {
        parts.push(tool_type.to_string());
    }
    if let Some(scope) = structured.get("scope").and_then(Value::as_str) {
        parts.push(format!("scope={scope}"));
    }
    for key in [
        "pageCount",
        "targetCount",
        "totalTargetCount",
        "totalMatches",
        "returnedMatches",
        "returnedChars",
        "totalChars",
    ] {
        if let Some(number) = structured.get(key).filter(|value| value.is_number()) {
            parts.push(format!("{key}={number}"));
        }
    }
    if let Some(pseudocode) = structured.get("pseudocode").and_then(Value::as_str) {
        parts.push(format!(
            "pseudocode={} chars in structuredContent",
            pseudocode.chars().count()
        ));
    }
    if structured
        .get("nextCursor")
        .is_some_and(|cursor| !cursor.is_null())
    {
        parts.push("more results available via nextCursor".to_string());
    }
    if let Some(attachment) = structured.get("imageAttachment") {
        let label = attachment
            .get("label")
            .or_else(|| attachment.get("mimeType"))
            .and_then(Value::as_str)
            .unwrap_or("attached");
        parts.push(format!("image={}", short_text(label, 200)));
    }
    if parts.is_empty() {
        "Tool call completed; full result is in structuredContent.".to_string()
    } else {
        format!("Tool result: {}", parts.join("; "))
    }
}

fn to_mcp_content(result: Value) -> Value {
    let mut images = Vec::new();
    let clean = normalize_structured(&result, &mut images);
    let structured = if clean.is_object() {
        clean
    } else {
        json!({"result": clean})
    };
    let mut content = vec![json!({"type": "text", "text": summarize_mcp_result(&structured)})];
    content.extend(images);
    let is_error = structured.get("ok").and_then(Value::as_bool) == Some(false);
    json!({"content": content, "structuredContent": structured, "isError": is_error})
}

fn request_key(session_id: &str, request_id: &Value) -> String {
    format!("{session_id}\0{}", request_id)
}

fn ensure_session<'a>(state: &'a mut BridgeState, session_id: &str) -> &'a mut McpSession {
    let session = state
        .sessions
        .entry(session_id.to_string())
        .or_insert_with(|| McpSession {
            protocol_version: PROTOCOL_VERSION.to_string(),
            selected_client_id: None,
            last_seen: Instant::now(),
        });
    session.last_seen = Instant::now();
    session
}

fn finish_call_locked(
    state: &mut BridgeState,
    call_id: &str,
    outcome: Result<Value, String>,
) -> bool {
    let Some(pending) = state.pending.remove(call_id) else {
        return false;
    };
    if state
        .request_calls
        .get(&pending.request_key)
        .is_some_and(|id| id == call_id)
    {
        state.request_calls.remove(&pending.request_key);
    }
    if let Some(client) = state.clients.get_mut(&pending.client_id) {
        client.queue.retain(|id| id != call_id);
    }
    let _ = pending.tx.send(outcome);
    true
}

fn cancel_call_locked(state: &mut BridgeState, call_id: &str, reason: &str) -> bool {
    let cancelled_client = state
        .pending
        .get(call_id)
        .filter(|pending| pending.state != CallState::Queued)
        .map(|pending| pending.client_id.clone());
    if let Some(client) = cancelled_client.and_then(|client_id| state.clients.get_mut(&client_id)) {
        client.cancelled_call_ids.push_back(call_id.to_string());
    }
    finish_call_locked(state, call_id, Err(reason.to_string()))
}

fn cancel_client_calls_locked(state: &mut BridgeState, client_id: &str, reason: &str) {
    let ids: Vec<String> = state
        .pending
        .iter()
        .filter(|(_, pending)| pending.client_id == client_id)
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        cancel_call_locked(state, &id, reason);
    }
}

fn reset_client_selections_locked(state: &mut BridgeState, client_id: &str) {
    for session in state.sessions.values_mut() {
        if session.selected_client_id.as_deref() == Some(client_id) {
            session.selected_client_id = None;
        }
    }
}

fn prune_expired_clients_locked(state: &mut BridgeState, ttl: Duration) {
    let now = Instant::now();
    let expired: Vec<String> = state
        .clients
        .iter()
        .filter(|(_, client)| now.saturating_duration_since(client.last_seen) > ttl)
        .map(|(id, _)| id.clone())
        .collect();
    for client_id in expired {
        cancel_client_calls_locked(
            state,
            &client_id,
            "The selected 40code page disconnected before completing the call.",
        );
        state.clients.remove(&client_id);
        reset_client_selections_locked(state, &client_id);
    }
}

fn active_client_ids_locked(state: &mut BridgeState, ttl: Duration) -> Vec<String> {
    prune_expired_clients_locked(state, ttl);
    let mut clients: Vec<(String, Instant)> = state
        .clients
        .values()
        .map(|client| (client.client_id.clone(), client.last_seen))
        .collect();
    clients.sort_by_key(|item| std::cmp::Reverse(item.1));
    clients.into_iter().map(|item| item.0).collect()
}

fn resolve_page_locked(
    state: &mut BridgeState,
    session_id: &str,
    ttl: Duration,
) -> Result<String, String> {
    let active = active_client_ids_locked(state, ttl);
    let selected = ensure_session(state, session_id).selected_client_id.clone();
    if let Some(selected) = selected.filter(|id| active.contains(id)) {
        return Ok(selected);
    }
    ensure_session(state, session_id).selected_client_id = None;
    match active.len() {
        0 => Err("No 40code page is connected. Open the editor with json-script-converter enabled, then retry.".to_string()),
        1 => {
            let selected = active[0].clone();
            ensure_session(state, session_id).selected_client_id = Some(selected.clone());
            Ok(selected)
        }
        _ => Err("Multiple 40code pages are connected. Call jsc_list_pages, then jsc_select_page before using page tools.".to_string()),
    }
}

fn page_summary(client: &BridgeClient, selected: bool) -> Value {
    json!({
        "clientId": client.client_id,
        "title": client.title,
        "pageUrl": client.page_url,
        "selected": selected,
        "lastSeenAgoMs": Instant::now().saturating_duration_since(client.last_seen).as_millis() as u64,
        "queuedCalls": client.queue.len()
    })
}

fn list_pages(shared: &Shared, session_id: &str) -> Value {
    let mut state = shared.state.lock().unwrap();
    let active = active_client_ids_locked(&mut state, shared.config.client_ttl);
    let mut selected = ensure_session(&mut state, session_id)
        .selected_client_id
        .clone()
        .filter(|id| active.contains(id));
    if active.len() == 1 {
        selected = Some(active[0].clone());
    }
    ensure_session(&mut state, session_id).selected_client_id = selected.clone();
    let pages: Vec<Value> = active
        .iter()
        .filter_map(|id| state.clients.get(id))
        .map(|client| page_summary(client, selected.as_deref() == Some(&client.client_id)))
        .collect();
    json!({"ok": true, "selectedClientId": selected, "pageCount": pages.len(), "pages": pages})
}

fn select_page(shared: &Shared, session_id: &str, client_id: &str) -> Result<Value, String> {
    let mut state = shared.state.lock().unwrap();
    let active = active_client_ids_locked(&mut state, shared.config.client_ttl);
    if !active.iter().any(|id| id == client_id) {
        return Err(format!(
            "No active 40code page has clientId {client_id}. Call jsc_list_pages and retry."
        ));
    }
    ensure_session(&mut state, session_id).selected_client_id = Some(client_id.to_string());
    let summary = page_summary(state.clients.get(client_id).unwrap(), true);
    Ok(json!({"ok": true, "selectedPage": summary}))
}

fn enqueue_bridge_call(
    shared: &Shared,
    name: &str,
    arguments: Value,
    session_id: &str,
    request_id: &Value,
) -> Result<Value, String> {
    let call_id = random_token(shared);
    let lease_token = random_token(shared);
    let registration_token;
    let client_id;
    let key = request_key(session_id, request_id);
    let (tx, rx) = mpsc::channel();
    {
        let mut state = shared.state.lock().unwrap();
        if state.cancelled_requests.remove(&key).is_some() {
            return Err("MCP client cancelled the request before it was queued.".to_string());
        }
        client_id = resolve_page_locked(&mut state, session_id, shared.config.client_ttl)?;
        registration_token = state
            .clients
            .get(&client_id)
            .unwrap()
            .registration_token
            .clone();
        let expires_at_ms = unix_millis() + shared.config.call_timeout.as_millis();
        state.pending.insert(
            call_id.clone(),
            PendingCall {
                tx,
                name: name.to_string(),
                arguments,
                client_id: client_id.clone(),
                registration_token,
                lease_token,
                deadline: Instant::now() + shared.config.call_timeout,
                expires_at_ms,
                state: CallState::Queued,
                request_key: key.clone(),
            },
        );
        state.request_calls.insert(key, call_id.clone());
        state
            .clients
            .get_mut(&client_id)
            .unwrap()
            .queue
            .push_back(call_id.clone());
        shared.cv.notify_all();
    }
    match rx.recv_timeout(shared.config.call_timeout) {
        Ok(result) => result,
        Err(_) => {
            let mut state = shared.state.lock().unwrap();
            cancel_call_locked(
                &mut state,
                &call_id,
                &format!(
                    "Timed out waiting for the 40code page after {}ms",
                    shared.config.call_timeout.as_millis()
                ),
            );
            shared.cv.notify_all();
            Err(format!(
                "Timed out waiting for the 40code page after {}ms",
                shared.config.call_timeout.as_millis()
            ))
        }
    }
}

fn cancel_request(shared: &Shared, session_id: &str, request_id: &Value, reason: &str) -> bool {
    let key = request_key(session_id, request_id);
    let mut state = shared.state.lock().unwrap();
    let Some(call_id) = state.request_calls.get(&key).cloned() else {
        state.cancelled_requests.insert(key, Instant::now());
        while state.cancelled_requests.len() > 1024 {
            let oldest = state
                .cancelled_requests
                .iter()
                .min_by_key(|(_, created)| **created)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                state.cancelled_requests.remove(&oldest);
            } else {
                break;
            }
        }
        return false;
    };
    let cancelled = cancel_call_locked(&mut state, &call_id, reason);
    shared.cv.notify_all();
    cancelled
}

fn get_bridge_status(shared: &Shared) -> Value {
    let mut state = shared.state.lock().unwrap();
    let active = active_client_ids_locked(&mut state, shared.config.client_ttl);
    let clients: Vec<Value> = active
        .iter()
        .filter_map(|id| state.clients.get(id))
        .map(|client| page_summary(client, false))
        .collect();
    let first = clients.first();
    let queued = state
        .pending
        .values()
        .filter(|pending| pending.state == CallState::Queued)
        .count();
    let leased = state.pending.len() - queued;
    json!({
        "ok": true,
        "bridge": {
            "host": shared.config.host,
            "port": shared.config.port,
            "path": shared.config.bridge_path,
            "legacyPath": LEGACY_BRIDGE_PATH,
            "bridgeUrl": bridge_url(&shared.config),
            "legacyBridgeUrl": format!("http://{}:{}{}", shared.config.host, shared.config.port, LEGACY_BRIDGE_PATH),
            "mcpHttpUrl": format!("http://{}:{}{}", shared.config.host, shared.config.port, shared.config.mcp_http_path),
            "rootMcpHttpUrl": format!("http://{}:{}/", shared.config.host, shared.config.port),
            "connected": !clients.is_empty(),
            "pageTitle": first.and_then(|page| page.get("title")).and_then(Value::as_str).unwrap_or(""),
            "pageUrl": first.and_then(|page| page.get("pageUrl")).and_then(Value::as_str).unwrap_or(""),
            "clients": clients,
            "pendingCalls": queued,
            "waitingResults": leased
        }
    })
}

fn hidden_call_action_schema() -> Value {
    json!({
        "type": "object",
        "properties": {"action": {"oneOf": [{"type": "object"}, {"type": "string", "minLength": 1, "maxLength": 4000000}]}},
        "required": ["action"],
        "additionalProperties": false
    })
}

fn handle_rpc(shared: &Shared, message: Value, session_id: &str) -> Option<Value> {
    if !message.is_object() || message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Some(rpc_error(
            message.get("id").cloned().unwrap_or(Value::Null),
            -32600,
            "Expected a JSON-RPC 2.0 message object",
        ));
    }
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    if method.is_empty() {
        return Some(rpc_error(id, -32600, "Missing method"));
    }
    {
        let mut state = shared.state.lock().unwrap();
        ensure_session(&mut state, session_id);
    }
    if method == "notifications/cancelled" || method == "$/cancelRequest" {
        let request_id = message
            .pointer("/params/requestId")
            .or_else(|| message.pointer("/params/id"));
        if let Some(request_id) = request_id {
            let reason = message
                .pointer("/params/reason")
                .and_then(Value::as_str)
                .unwrap_or("MCP client cancelled the request.");
            cancel_request(shared, session_id, request_id, reason);
        }
        return None;
    }
    if method.starts_with("notifications/") {
        return None;
    }

    let response = match method {
        "initialize" => {
            let negotiated = negotiate_protocol_version(
                message
                    .pointer("/params/protocolVersion")
                    .and_then(Value::as_str),
            );
            {
                let mut state = shared.state.lock().unwrap();
                ensure_session(&mut state, session_id).protocol_version = negotiated.clone();
            }
            rpc_result(
                id,
                json!({
                    "protocolVersion": negotiated,
                    "capabilities": {"tools": {}, "resources": {}},
                    "instructions": SERVER_INSTRUCTIONS,
                    "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION}
                }),
            )
        }
        "ping" => rpc_result(id, json!({})),
        "tools/list" => rpc_result(id, json!({"tools": tool_definitions()})),
        "tools/call" => {
            if message.get("id").is_none() {
                return Some(rpc_error(
                    Value::Null,
                    -32600,
                    "tools/call must be a JSON-RPC request with an id",
                ));
            }
            let name = message
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or("");
            if name.is_empty() {
                rpc_error(id, -32602, "tools/call missing params.name")
            } else {
                let arguments = message
                    .pointer("/params/arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let definition = tool_definition(name);
                if definition.is_none() && name != "jsc_call_action" {
                    rpc_error(id, -32602, format!("Unknown tool: {name}"))
                } else {
                    let schema = definition
                        .as_ref()
                        .and_then(|tool| tool.get("inputSchema"))
                        .cloned()
                        .unwrap_or_else(hidden_call_action_schema);
                    let errors = schema_errors(&arguments, &schema, "$");
                    if !errors.is_empty() {
                        rpc_error_with_data(
                            id,
                            -32602,
                            format!("Invalid arguments for {name}"),
                            json!({"errors": errors}),
                        )
                    } else if name == "jsc_bridge_status" {
                        rpc_result(id, to_mcp_content(get_bridge_status(shared)))
                    } else if name == "jsc_list_pages" {
                        rpc_result(id, to_mcp_content(list_pages(shared, session_id)))
                    } else if name == "jsc_select_page" {
                        let result = select_page(
                            shared,
                            session_id,
                            arguments["clientId"].as_str().unwrap_or(""),
                        )
                        .unwrap_or_else(|error| json!({"ok": false, "error": error}));
                        rpc_result(id, to_mcp_content(result))
                    } else if name == "jsc_get_pseudocode_syntax" {
                        rpc_result(
                            id,
                            json!({
                                "content": [{"type": "text", "text": PSEUDOCODE_SYNTAX_GUIDE}],
                            "structuredContent": {"ok": true, "resourceUri": PSEUDOCODE_SYNTAX_URI},
                                "isError": false
                            }),
                        )
                    } else {
                        let result = enqueue_bridge_call(shared, name, arguments, session_id, &id)
                            .unwrap_or_else(|error| json!({"ok": false, "error": error}));
                        rpc_result(id, to_mcp_content(result))
                    }
                }
            }
        }
        "resources/list" => rpc_result(
            id,
            json!({"resources": [{
                "uri": PSEUDOCODE_SYNTAX_URI,
                "name": "40code pseudocode syntax",
                "description": "Syntax guide and examples for edit_pseudocode.",
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
                rpc_error(id, -32602, format!("Unknown resource: {uri}"))
            }
        }
        "prompts/list" => rpc_result(id, json!({"prompts": []})),
        _ => rpc_error(id, -32601, format!("Method not found: {method}")),
    };
    Some(response)
}

#[derive(Debug)]
struct HttpRequest {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn decode_component(input: &str) -> String {
    let replaced = input.replace('+', " ");
    String::from_utf8_lossy(&percent_decode_bytes(&replaced)).to_string()
}

fn parse_query(raw: &str) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for pair in raw.split('&').filter(|pair| !pair.is_empty()) {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        result.insert(decode_component(name), decode_component(value));
    }
    result
}

fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| error.to_string())?;
    let mut received = Vec::new();
    let mut buffer = [0_u8; 8192];
    let header_end;
    loop {
        let count = stream
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            return Err("Connection closed before request headers".to_string());
        }
        received.extend_from_slice(&buffer[..count]);
        if received.len() > BODY_LIMIT + 65_536 {
            return Err("Request too large".to_string());
        }
        if let Some(index) = received.windows(4).position(|window| window == b"\r\n\r\n") {
            header_end = index + 4;
            break;
        }
    }
    let header_text =
        std::str::from_utf8(&received[..header_end - 4]).map_err(|error| error.to_string())?;
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().ok_or("Missing request line")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or("Missing method")?.to_string();
    let target = parts.next().ok_or("Missing target")?.to_string();
    let (raw_path, raw_query) = target.split_once('?').unwrap_or((&target, ""));
    let raw_path = raw_path.to_string();
    let raw_query = raw_query.to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > BODY_LIMIT {
        return Err("Request body too large".to_string());
    }
    while received.len() < header_end + content_length {
        let count = stream
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            return Err("Connection closed before request body".to_string());
        }
        received.extend_from_slice(&buffer[..count]);
    }
    Ok(HttpRequest {
        method,
        path: decode_component(&raw_path),
        query: parse_query(&raw_query),
        headers,
        body: received[header_end..header_end + content_length].to_vec(),
    })
}

fn exact_origin_host(origin: &str) -> Result<String, ()> {
    let (scheme, authority) = origin.split_once("://").ok_or(())?;
    if scheme != "http" && scheme != "https" {
        return Err(());
    }
    if authority.is_empty() || authority.contains(['/', '?', '#', '@']) {
        return Err(());
    }
    let bracketed = authority.starts_with('[');
    let host = if bracketed {
        let end = authority.find(']').ok_or(())?;
        let host = &authority[1..end];
        if host.is_empty()
            || !host.chars().all(|character| {
                character.is_ascii_hexdigit() || character == ':' || character == '.'
            })
        {
            return Err(());
        }
        if authority.len() > end + 1 {
            let port = authority[end + 1..].strip_prefix(':').ok_or(())?;
            if port.is_empty() || port.parse::<u16>().is_err() {
                return Err(());
            }
        }
        host
    } else if let Some((host, port)) = authority.split_once(':') {
        if port.is_empty() || port.parse::<u16>().is_err() {
            return Err(());
        }
        host
    } else {
        authority
    };
    if host.is_empty()
        || (!bracketed
            && !host.chars().all(|character| {
                character.is_ascii_alphanumeric() || character == '-' || character == '.'
            }))
    {
        return Err(());
    }
    Ok(host.to_ascii_lowercase())
}

fn normalize_configured_origin(value: &str) -> Option<String> {
    let candidate = value.trim().strip_suffix('/').unwrap_or(value.trim());
    exact_origin_host(candidate).ok()?;
    Some(candidate.to_ascii_lowercase())
}

fn allowed_origin(origin: Option<&String>, configured: &[String]) -> Result<Option<String>, ()> {
    let Some(origin) = origin else {
        return Ok(None);
    };
    let host = exact_origin_host(origin)?;
    let is_loopback = host == "127.0.0.1" || host == "localhost" || host == "::1";
    if !is_loopback && !configured.iter().any(|allowed| allowed == origin) {
        return Err(());
    }
    Ok(Some(origin.clone()))
}

fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        410 => "Gone",
        500 => "Internal Server Error",
        _ => "OK",
    }
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
    origin: Option<&str>,
    extra_headers: &[(&str, &str)],
) {
    let mut headers = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id\r\nAccess-Control-Allow-Private-Network: true\r\nAccess-Control-Expose-Headers: Mcp-Session-Id, MCP-Protocol-Version\r\nCache-Control: no-store\r\nConnection: close\r\n",
        status_text(status),
        body.len()
    );
    if let Some(origin) = origin {
        headers.push_str(&format!(
            "Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\n"
        ));
    }
    for (name, value) in extra_headers {
        headers.push_str(&format!("{name}: {value}\r\n"));
    }
    headers.push_str("\r\n");
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn send_json(
    stream: &mut TcpStream,
    status: u16,
    value: Value,
    origin: Option<&str>,
    extra: &[(&str, &str)],
) {
    let body = serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec());
    write_response(
        stream,
        status,
        "application/json; charset=utf-8",
        &body,
        origin,
        extra,
    );
}

fn send_no_body(stream: &mut TcpStream, status: u16, origin: Option<&str>, extra: &[(&str, &str)]) {
    write_response(
        stream,
        status,
        "text/plain; charset=utf-8",
        b"",
        origin,
        extra,
    );
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

fn poll_payload_locked(state: &mut BridgeState, client_id: &str) -> Value {
    let cancelled: Vec<String> = state
        .clients
        .get_mut(client_id)
        .map(|client| client.cancelled_call_ids.drain(..).collect())
        .unwrap_or_default();
    let mut calls = Vec::new();
    while calls.is_empty() {
        let call_id = state
            .clients
            .get_mut(client_id)
            .and_then(|client| client.queue.pop_front());
        let Some(call_id) = call_id else { break };
        let expired = state
            .pending
            .get(&call_id)
            .is_some_and(|pending| Instant::now() >= pending.deadline);
        if expired {
            cancel_call_locked(state, &call_id, "Call lease expired before delivery.");
            continue;
        }
        let Some(pending) = state.pending.get_mut(&call_id) else {
            continue;
        };
        let token_matches = state
            .clients
            .get(client_id)
            .is_some_and(|client| client.registration_token == pending.registration_token);
        if pending.client_id != client_id || !token_matches {
            continue;
        }
        pending.state = CallState::Leased;
        calls.push(json!({
            "id": call_id,
            "name": pending.name,
            "arguments": pending.arguments,
            "leaseToken": pending.lease_token,
            "expiresAt": pending.expires_at_ms
        }));
    }
    let registration_token = state
        .clients
        .get(client_id)
        .map(|client| client.registration_token.clone())
        .unwrap_or_default();
    json!({"ok": true, "registrationToken": registration_token, "calls": calls, "cancelledCallIds": cancelled})
}

fn handle_poll(shared: &Shared, req: &HttpRequest, stream: &mut TcpStream, origin: Option<&str>) {
    let client_id = req.query.get("clientId").cloned().unwrap_or_default();
    if client_id.is_empty() || client_id.chars().count() > 256 {
        send_json(
            stream,
            400,
            json!({"ok": false, "error": "clientId is required and must be at most 256 characters"}),
            origin,
            &[],
        );
        return;
    }
    let supplied_token = req
        .query
        .get("registrationToken")
        .cloned()
        .unwrap_or_default();
    let title: String = req
        .query
        .get("title")
        .cloned()
        .unwrap_or_default()
        .chars()
        .take(1000)
        .collect();
    let page_url: String = req
        .query
        .get("pageUrl")
        .cloned()
        .unwrap_or_default()
        .chars()
        .take(8192)
        .collect();
    let mut state = shared.state.lock().unwrap();
    if supplied_token.is_empty() {
        if state.clients.contains_key(&client_id) {
            cancel_client_calls_locked(
                &mut state,
                &client_id,
                "The 40code page reloaded before completing the call.",
            );
            reset_client_selections_locked(&mut state, &client_id);
        }
        let registration_token = random_token(shared);
        state.clients.insert(
            client_id.clone(),
            BridgeClient {
                client_id,
                registration_token: registration_token.clone(),
                title,
                page_url,
                last_seen: Instant::now(),
                queue: VecDeque::new(),
                cancelled_call_ids: VecDeque::new(),
            },
        );
        shared.cv.notify_all();
        drop(state);
        send_json(
            stream,
            200,
            json!({"ok": true, "registrationToken": registration_token, "calls": [], "cancelledCallIds": []}),
            origin,
            &[],
        );
        return;
    }
    if state
        .clients
        .get(&client_id)
        .is_none_or(|client| client.registration_token != supplied_token)
    {
        drop(state);
        send_json(
            stream,
            403,
            json!({"ok": false, "error": "Invalid page registration token"}),
            origin,
            &[],
        );
        return;
    }
    if let Some(client) = state.clients.get_mut(&client_id) {
        if !title.is_empty() {
            client.title = title;
        }
        if !page_url.is_empty() {
            client.page_url = page_url;
        }
        client.last_seen = Instant::now();
    }
    let deadline = Instant::now() + shared.config.poll_timeout;
    loop {
        if state
            .clients
            .get(&client_id)
            .is_none_or(|client| client.registration_token != supplied_token)
        {
            drop(state);
            send_json(
                stream,
                409,
                json!({"ok": false, "error": "Page re-registered"}),
                origin,
                &[],
            );
            return;
        }
        let ready = state.clients.get(&client_id).is_some_and(|client| {
            !client.queue.is_empty() || !client.cancelled_call_ids.is_empty()
        });
        if ready || Instant::now() >= deadline {
            break;
        }
        let wait = deadline.saturating_duration_since(Instant::now());
        let (next, _) = shared.cv.wait_timeout(state, wait).unwrap();
        state = next;
    }
    let payload = poll_payload_locked(&mut state, &client_id);
    drop(state);
    send_json(stream, 200, payload, origin, &[]);
}

fn parse_json_body(req: &HttpRequest) -> Result<Value, String> {
    serde_json::from_slice(&req.body).map_err(|error| error.to_string())
}

fn validate_claimant(state: &BridgeState, payload: &Value) -> Result<String, (u16, &'static str)> {
    let client_id = payload
        .get("clientId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let registration_token = payload
        .get("registrationToken")
        .and_then(Value::as_str)
        .unwrap_or("");
    let Some(client) = state.clients.get(client_id) else {
        return Err((403, "Invalid page claimant"));
    };
    if registration_token.is_empty() || registration_token != client.registration_token {
        return Err((403, "Invalid page claimant"));
    }
    Ok(client_id.to_string())
}

fn handle_claim(shared: &Shared, req: &HttpRequest, stream: &mut TcpStream, origin: Option<&str>) {
    let payload = match parse_json_body(req) {
        Ok(payload) => payload,
        Err(error) => {
            send_json(
                stream,
                400,
                json!({"ok": false, "error": error}),
                origin,
                &[],
            );
            return;
        }
    };
    let mut state = shared.state.lock().unwrap();
    let client_id = match validate_claimant(&state, &payload) {
        Ok(client_id) => client_id,
        Err((status, error)) => {
            drop(state);
            send_json(
                stream,
                status,
                json!({"ok": false, "error": error}),
                origin,
                &[],
            );
            return;
        }
    };
    let call_id = payload.get("id").and_then(Value::as_str).unwrap_or("");
    let lease_token = payload
        .get("leaseToken")
        .and_then(Value::as_str)
        .unwrap_or("");
    let Some(pending) = state.pending.get_mut(call_id) else {
        drop(state);
        send_json(
            stream,
            410,
            json!({"ok": false, "error": "Unknown, cancelled, or expired call lease"}),
            origin,
            &[],
        );
        return;
    };
    if pending.client_id != client_id
        || pending.registration_token != payload["registrationToken"]
        || pending.lease_token != lease_token
        || pending.state != CallState::Leased
    {
        drop(state);
        send_json(
            stream,
            403,
            json!({"ok": false, "error": "Claim does not own this call lease"}),
            origin,
            &[],
        );
        return;
    }
    if Instant::now() >= pending.deadline {
        cancel_call_locked(&mut state, call_id, "Call lease expired before claim.");
        shared.cv.notify_all();
        drop(state);
        send_json(
            stream,
            410,
            json!({"ok": false, "error": "Call lease expired"}),
            origin,
            &[],
        );
        return;
    }
    pending.state = CallState::Claimed;
    let expires_at = pending.expires_at_ms;
    state.clients.get_mut(&client_id).unwrap().last_seen = Instant::now();
    drop(state);
    send_json(
        stream,
        200,
        json!({"ok": true, "expiresAt": expires_at}),
        origin,
        &[],
    );
}

fn handle_result(shared: &Shared, req: &HttpRequest, stream: &mut TcpStream, origin: Option<&str>) {
    let payload = match parse_json_body(req) {
        Ok(payload) => payload,
        Err(error) => {
            send_json(
                stream,
                400,
                json!({"ok": false, "error": error}),
                origin,
                &[],
            );
            return;
        }
    };
    let mut state = shared.state.lock().unwrap();
    let client_id = match validate_claimant(&state, &payload) {
        Ok(client_id) => client_id,
        Err((status, error)) => {
            drop(state);
            send_json(
                stream,
                status,
                json!({"ok": false, "error": error}),
                origin,
                &[],
            );
            return;
        }
    };
    let call_id = payload.get("id").and_then(Value::as_str).unwrap_or("");
    let lease_token = payload
        .get("leaseToken")
        .and_then(Value::as_str)
        .unwrap_or("");
    let Some(pending) = state.pending.get(call_id) else {
        drop(state);
        send_json(
            stream,
            410,
            json!({"ok": false, "error": "Unknown, cancelled, or expired call id"}),
            origin,
            &[],
        );
        return;
    };
    if pending.client_id != client_id
        || pending.registration_token != payload["registrationToken"]
        || pending.lease_token != lease_token
        || pending.state != CallState::Claimed
    {
        drop(state);
        send_json(
            stream,
            403,
            json!({"ok": false, "error": "Result does not own this call lease"}),
            origin,
            &[],
        );
        return;
    }
    if Instant::now() >= pending.deadline {
        cancel_call_locked(&mut state, call_id, "Call lease expired before result.");
        shared.cv.notify_all();
        drop(state);
        send_json(
            stream,
            410,
            json!({"ok": false, "error": "Call lease expired"}),
            origin,
            &[],
        );
        return;
    }
    let outcome = if let Some(error) = payload.get("error").filter(|value| !value.is_null()) {
        Err(error
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| error.to_string()))
    } else {
        Ok(payload.get("result").cloned().unwrap_or(Value::Null))
    };
    finish_call_locked(&mut state, call_id, outcome);
    if let Some(client) = state.clients.get_mut(&client_id) {
        client.last_seen = Instant::now();
        if let Some(title) = payload.get("title").and_then(Value::as_str) {
            client.title = title.to_string();
        }
        if let Some(page_url) = payload.get("pageUrl").and_then(Value::as_str) {
            client.page_url = page_url.to_string();
        }
    }
    drop(state);
    send_json(stream, 200, json!({"ok": true}), origin, &[]);
}

fn validate_http_protocol(req: &HttpRequest, session: &McpSession) -> Result<(), String> {
    let Some(version) = req.headers.get("mcp-protocol-version") else {
        return Ok(());
    };
    if !supports_protocol(version) {
        return Err(format!("Unsupported MCP-Protocol-Version: {version}"));
    }
    if version != &session.protocol_version {
        return Err(format!(
            "MCP-Protocol-Version does not match initialized session ({})",
            session.protocol_version
        ));
    }
    Ok(())
}

fn handle_mcp_http(
    shared: &Shared,
    req: &HttpRequest,
    stream: &mut TcpStream,
    origin: Option<&str>,
) {
    if req.method == "GET" {
        send_no_body(stream, 405, origin, &[("Allow", "POST, DELETE, OPTIONS")]);
        return;
    }
    if req.method == "DELETE" {
        let session_id = req
            .headers
            .get("mcp-session-id")
            .cloned()
            .unwrap_or_default();
        let mut state = shared.state.lock().unwrap();
        if !state.sessions.contains_key(&session_id) {
            drop(state);
            send_json(
                stream,
                404,
                rpc_error(Value::Null, -32001, "Unknown MCP session"),
                origin,
                &[],
            );
            return;
        }
        let calls: Vec<String> = state
            .request_calls
            .iter()
            .filter(|(key, _)| key.starts_with(&format!("{session_id}\0")))
            .map(|(_, id)| id.clone())
            .collect();
        for call_id in calls {
            cancel_call_locked(&mut state, &call_id, "MCP session closed.");
        }
        state
            .cancelled_requests
            .retain(|key, _| !key.starts_with(&format!("{session_id}\0")));
        state.sessions.remove(&session_id);
        shared.cv.notify_all();
        drop(state);
        send_no_body(stream, 204, origin, &[]);
        return;
    }
    if req.method != "POST" {
        send_no_body(stream, 405, origin, &[("Allow", "POST, DELETE, OPTIONS")]);
        return;
    }
    let message = match parse_json_body(req) {
        Ok(message) if message.is_object() && !message.is_array() => message,
        Ok(_) => {
            send_json(
                stream,
                400,
                rpc_error(
                    Value::Null,
                    -32600,
                    "Expected a single JSON-RPC message object",
                ),
                origin,
                &[],
            );
            return;
        }
        Err(error) => {
            send_json(
                stream,
                400,
                rpc_error(Value::Null, -32700, error),
                origin,
                &[],
            );
            return;
        }
    };
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        send_json(
            stream,
            400,
            rpc_error(
                message.get("id").cloned().unwrap_or(Value::Null),
                -32600,
                "Expected JSON-RPC 2.0",
            ),
            origin,
            &[],
        );
        return;
    }
    if message.get("method").is_none()
        && (message.get("result").is_some() || message.get("error").is_some())
    {
        send_no_body(stream, 202, origin, &[]);
        return;
    }
    let initializing = message.get("method").and_then(Value::as_str) == Some("initialize");
    let session_id;
    if initializing {
        session_id = random_token(shared);
        let mut state = shared.state.lock().unwrap();
        ensure_session(&mut state, &session_id);
    } else {
        session_id = req
            .headers
            .get("mcp-session-id")
            .cloned()
            .unwrap_or_default();
        let mut state = shared.state.lock().unwrap();
        let Some(session) = state.sessions.get_mut(&session_id) else {
            drop(state);
            send_json(
                stream,
                400,
                rpc_error(
                    message.get("id").cloned().unwrap_or(Value::Null),
                    -32001,
                    "Missing or unknown Mcp-Session-Id",
                ),
                origin,
                &[],
            );
            return;
        };
        if let Err(error) = validate_http_protocol(req, session) {
            drop(state);
            send_json(
                stream,
                400,
                rpc_error(
                    message.get("id").cloned().unwrap_or(Value::Null),
                    -32600,
                    error,
                ),
                origin,
                &[],
            );
            return;
        }
        session.last_seen = Instant::now();
    }
    let response = handle_rpc(shared, message.clone(), &session_id);
    let protocol_version = shared
        .state
        .lock()
        .unwrap()
        .sessions
        .get(&session_id)
        .map(|session| session.protocol_version.clone())
        .unwrap_or_else(|| LEGACY_PROTOCOL_VERSION.to_string());
    let extra = [
        ("Mcp-Session-Id", session_id.as_str()),
        ("MCP-Protocol-Version", protocol_version.as_str()),
    ];
    if message.get("id").is_none() && message.get("method").is_some() {
        send_no_body(stream, 202, origin, &extra);
    } else if let Some(response) = response {
        send_json(stream, 200, response, origin, &extra);
    } else {
        send_no_body(stream, 202, origin, &extra);
    }
}

fn handle_http(shared: Arc<Shared>, mut stream: TcpStream) {
    let req = match read_http_request(&mut stream) {
        Ok(req) => req,
        Err(error) => {
            send_json(
                &mut stream,
                400,
                json!({"ok": false, "error": error}),
                None,
                &[],
            );
            return;
        }
    };
    let origin = match allowed_origin(req.headers.get("origin"), &shared.config.allowed_origins) {
        Ok(origin) => origin,
        Err(()) => {
            send_json(
                &mut stream,
                403,
                json!({"ok": false, "error": "Forbidden origin"}),
                None,
                &[],
            );
            return;
        }
    };
    let origin_ref = origin.as_deref();
    if req.method == "OPTIONS" {
        send_no_body(&mut stream, 204, origin_ref, &[]);
        return;
    }
    if req.path == shared.config.mcp_http_path {
        handle_mcp_http(&shared, &req, &mut stream, origin_ref);
        return;
    }
    let Some(suffix) = bridge_suffix(&shared.config, &req.path) else {
        send_json(
            &mut stream,
            404,
            json!({"ok": false, "error": "Not found"}),
            origin_ref,
            &[],
        );
        return;
    };
    match (req.method.as_str(), suffix.as_str()) {
        ("POST", "/") => handle_mcp_http(&shared, &req, &mut stream, origin_ref),
        ("GET", "/poll") => handle_poll(&shared, &req, &mut stream, origin_ref),
        ("POST", "/claim") => handle_claim(&shared, &req, &mut stream, origin_ref),
        ("POST", "/result") => handle_result(&shared, &req, &mut stream, origin_ref),
        ("GET", "/") | ("GET", "/status") => send_json(
            &mut stream,
            200,
            get_bridge_status(&shared),
            origin_ref,
            &[],
        ),
        _ => send_json(
            &mut stream,
            404,
            json!({"ok": false, "error": "Not found"}),
            origin_ref,
            &[],
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
        "::1" => "::1",
        _ => "127.0.0.1",
    };
    let address = if host.contains(':') {
        format!("[{host}]:{}", config.port)
    } else {
        format!("{host}:{}", config.port)
    };
    let status_path = if config.bridge_path == "/" {
        "/status".to_string()
    } else {
        format!("{}/status", config.bridge_path)
    };
    let Ok(addresses) = address.to_socket_addrs() else {
        return false;
    };
    for socket_address in addresses {
        let Ok(mut stream) =
            TcpStream::connect_timeout(&socket_address, Duration::from_millis(500))
        else {
            continue;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
        let request = format!(
            "GET {status_path} HTTP/1.1\r\nHost: {host}:{}\r\nConnection: close\r\n\r\n",
            config.port
        );
        if stream.write_all(request.as_bytes()).is_err() {
            continue;
        }
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response);
        if response.starts_with("HTTP/1.1 200") && response.contains(LEGACY_BRIDGE_PATH) {
            return true;
        }
    }
    false
}

fn classify_startup_failure(error: &io::Error, existing: bool) -> StartupFailureKind {
    if is_address_in_use(error) {
        if existing {
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
            "40code MCP 本地桥接器已经在运行。\n\n无需重复启动。请返回 40code 页面，勾选“启用 MCP 桥接”即可。\n\n页面连接地址：{}\nAI 软件 MCP 地址：http://{}:{}{}",
            bridge_url(config),
            config.host,
            config.port,
            config.mcp_http_path
        ),
        StartupFailureKind::PortInUse => format!(
            "40code MCP 本地桥接器无法启动。\n\n本地端口 {} 已被其他程序占用。请关闭占用程序或重启电脑后重试。\n\n错误详情：{error}",
            config.port
        ),
        StartupFailureKind::Other => format!(
            "40code MCP 本地桥接器启动失败。\n\n请检查权限或网络设置后重试。\n\n错误详情：{error}"
        ),
    }
}

#[cfg(windows)]
fn show_startup_message(message: &str, is_error: bool) {
    const MB_ICONERROR: u32 = 0x10;
    const MB_ICONINFORMATION: u32 = 0x40;
    const MB_SETFOREGROUND: u32 = 0x10000;
    const MB_TOPMOST: u32 = 0x40000;
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
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            icon | MB_SETFOREGROUND | MB_TOPMOST,
        );
    }
}

#[cfg(not(windows))]
fn show_startup_message(message: &str, _is_error: bool) {
    eprintln!("{message}");
}

fn report_startup_failure(config: &Config, error: &io::Error) -> i32 {
    let kind = classify_startup_failure(
        error,
        is_address_in_use(error) && probe_existing_bridge(config),
    );
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
    let listener = TcpListener::bind(format!("{}:{}", shared.config.host, shared.config.port))?;
    eprintln!(
        "40code MCP 本地桥接器已启动：{}",
        bridge_url(&shared.config)
    );
    eprintln!(
        "MCP 地址：http://{}:{}{}",
        shared.config.host, shared.config.port, shared.config.mcp_http_path
    );
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let shared = Arc::clone(&shared);
                thread::spawn(move || handle_http(shared, stream));
            }
            Err(error) => eprintln!("接受连接失败：{error}"),
        }
    }
    Ok(())
}

fn write_stdio(output: &Arc<Mutex<io::Stdout>>, message: &Value) {
    if let Ok(text) = serde_json::to_string(message) {
        let mut output = output.lock().unwrap();
        let _ = writeln!(output, "{text}");
        let _ = output.flush();
    }
}

fn start_stdio(shared: Arc<Shared>) {
    let output = Arc::new(Mutex::new(io::stdout()));
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(trimmed) {
            Ok(message) => {
                let shared = Arc::clone(&shared);
                let output = Arc::clone(&output);
                thread::spawn(move || {
                    if let Some(response) = handle_rpc(&shared, message, "stdio") {
                        write_stdio(&output, &response);
                    }
                });
            }
            Err(error) => write_stdio(&output, &rpc_error(Value::Null, -32700, error.to_string())),
        }
    }
}

fn main() {
    let shared = Arc::new(Shared {
        config: load_config(),
        state: Mutex::new(BridgeState {
            pending: HashMap::new(),
            clients: HashMap::new(),
            sessions: HashMap::new(),
            request_calls: HashMap::new(),
            cancelled_requests: HashMap::new(),
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

    fn test_shared() -> Shared {
        Shared {
            config: Config {
                host: "127.0.0.1".to_string(),
                port: 47740,
                bridge_path: "/".to_string(),
                mcp_http_path: "/mcp".to_string(),
                call_timeout: Duration::from_millis(50),
                poll_timeout: Duration::from_millis(20),
                client_ttl: Duration::from_secs(60),
                allowed_origins: vec![
                    "https://40code.com".to_string(),
                    "https://www.40code.com".to_string(),
                ],
            },
            state: Mutex::new(BridgeState {
                pending: HashMap::new(),
                clients: HashMap::new(),
                sessions: HashMap::new(),
                request_calls: HashMap::new(),
                cancelled_requests: HashMap::new(),
            }),
            cv: Condvar::new(),
            counter: AtomicU64::new(1),
        }
    }

    #[test]
    fn canonical_catalog_is_strict_and_hides_raw_action_tool() {
        let tools = tool_definitions();
        assert!(!tools.iter().any(|tool| tool["name"] == "jsc_call_action"));
        assert!(
            tools
                .iter()
                .all(|tool| tool.pointer("/inputSchema/additionalProperties")
                    == Some(&Value::Bool(false)))
        );
        assert!(
            tools
                .iter()
                .any(|tool| tool["name"] == "get_project_overview")
        );
        let runtime_state = tools
            .iter()
            .find(|tool| tool["name"] == "get_runtime_state")
            .expect("runtime state tool must exist");
        assert_eq!(
            runtime_state.pointer("/inputSchema/properties/maxDataItems/minimum"),
            Some(&json!(0))
        );
        assert_eq!(
            runtime_state.pointer("/inputSchema/properties/maxListItems/minimum"),
            Some(&json!(0))
        );
    }

    #[test]
    fn syntax_resource_and_tool_return_shared_guide() {
        let shared = test_shared();
        let resource = handle_rpc(
            &shared,
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "resources/read",
                "params": {"uri": PSEUDOCODE_SYNTAX_URI}
            }),
            "syntax-resource-test",
        )
        .unwrap();
        let tool = handle_rpc(
            &shared,
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "jsc_get_pseudocode_syntax", "arguments": {}}
            }),
            "syntax-tool-test",
        )
        .unwrap();

        assert_eq!(
            resource
                .pointer("/result/contents/0/text")
                .and_then(Value::as_str),
            Some(PSEUDOCODE_SYNTAX_GUIDE)
        );
        assert_eq!(
            tool.pointer("/result/content/0/text")
                .and_then(Value::as_str),
            Some(PSEUDOCODE_SYNTAX_GUIDE)
        );
    }

    #[test]
    fn protocol_negotiation_never_echoes_unknown_versions() {
        assert_eq!(negotiate_protocol_version(Some("2025-06-18")), "2025-06-18");
        assert_eq!(
            negotiate_protocol_version(Some("not-real")),
            PROTOCOL_VERSION
        );
        assert_eq!(negotiate_protocol_version(None), PROTOCOL_VERSION);
        let shared = test_shared();
        let initialized = handle_rpc(
            &shared,
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2025-06-18"}
            }),
            "version-test",
        )
        .unwrap();
        assert_eq!(
            initialized
                .pointer("/result/serverInfo/version")
                .and_then(Value::as_str),
            Some("0.5.0")
        );
    }

    #[test]
    fn schema_enforces_pagination_ranges_and_one_of() {
        let schema = tool_definition("get_pseudocode").unwrap()["inputSchema"].clone();
        assert!(schema_errors(&json!({}), &schema, "$").is_empty());
        assert!(
            schema_errors(
                &json!({"scope": "targets", "targetRefs": ["a"], "maxChars": 1}),
                &schema,
                "$"
            )
            .is_empty()
        );
        assert!(!schema_errors(&json!({"startLine": 2}), &schema, "$").is_empty());
        assert!(
            !schema_errors(
                &json!({"scope": "all_targets", "targetRefs": ["a"]}),
                &schema,
                "$"
            )
            .is_empty()
        );
    }

    #[test]
    fn origin_validation_is_exact_and_never_wildcard() {
        let configured = vec![
            "https://40code.com".to_string(),
            "https://www.40code.com".to_string(),
            "https://editor.example.test".to_string(),
        ];
        assert_eq!(
            allowed_origin(Some(&"http://127.0.0.1:3000".to_string()), &configured)
                .unwrap()
                .as_deref(),
            Some("http://127.0.0.1:3000")
        );
        assert_eq!(
            allowed_origin(Some(&"https://40code.com".to_string()), &configured)
                .unwrap()
                .as_deref(),
            Some("https://40code.com")
        );
        assert!(
            allowed_origin(Some(&"http://127.0.0.1.evil.test".to_string()), &configured).is_err()
        );
        assert_eq!(
            allowed_origin(
                Some(&"https://editor.example.test".to_string()),
                &configured
            )
            .unwrap()
            .as_deref(),
            Some("https://editor.example.test")
        );
        assert!(allowed_origin(Some(&"https://evil.40code.com".to_string()), &configured).is_err());
    }

    #[test]
    fn image_attachments_become_image_content_and_structured_metadata() {
        let result = to_mcp_content(
            json!({"ok": true, "imageAttachment": {"label": "stage", "mimeType": "image/png", "dataUrl": "data:image/png;base64,YQ==", "width": 1, "height": 1}}),
        );
        assert_eq!(
            result.pointer("/content/1/type").and_then(Value::as_str),
            Some("image")
        );
        assert_eq!(
            result.pointer("/content/1/data").and_then(Value::as_str),
            Some("YQ==")
        );
        assert!(
            !result
                .pointer("/content/0/text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .contains("YQ==")
        );
        assert!(
            result
                .pointer("/structuredContent/imageAttachment/dataUrl")
                .is_none()
        );
        let pseudocode = "on_flag_clicked() {\n    show()\n}";
        let code_result = to_mcp_content(json!({
            "ok": true,
            "type": "get_pseudocode",
            "pseudocode": pseudocode,
            "returnedChars": pseudocode.len()
        }));
        assert_eq!(
            code_result
                .pointer("/structuredContent/pseudocode")
                .and_then(Value::as_str),
            Some(pseudocode)
        );
        assert!(
            !code_result
                .pointer("/content/0/text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .contains("on_flag_clicked")
        );
    }

    #[test]
    fn cancelled_leased_call_cannot_be_claimed() {
        let shared = test_shared();
        let (tx, _rx) = mpsc::channel();
        let mut state = shared.state.lock().unwrap();
        state.clients.insert(
            "page".to_string(),
            BridgeClient {
                client_id: "page".to_string(),
                registration_token: "registration".to_string(),
                title: String::new(),
                page_url: String::new(),
                last_seen: Instant::now(),
                queue: VecDeque::new(),
                cancelled_call_ids: VecDeque::new(),
            },
        );
        state.pending.insert(
            "call".to_string(),
            PendingCall {
                tx,
                name: "click_stop".to_string(),
                arguments: json!({}),
                client_id: "page".to_string(),
                registration_token: "registration".to_string(),
                lease_token: "lease".to_string(),
                deadline: Instant::now() + Duration::from_secs(1),
                expires_at_ms: unix_millis() + 1000,
                state: CallState::Leased,
                request_key: "stdio\0\"request\"".to_string(),
            },
        );
        state
            .request_calls
            .insert("stdio\0\"request\"".to_string(), "call".to_string());
        assert!(cancel_call_locked(&mut state, "call", "cancelled"));
        assert!(!state.pending.contains_key("call"));
        assert_eq!(
            state.clients["page"]
                .cancelled_call_ids
                .front()
                .map(String::as_str),
            Some("call")
        );
    }

    #[test]
    fn cancellation_before_queueing_leaves_a_bounded_tombstone() {
        let shared = test_shared();
        assert!(!cancel_request(
            &shared,
            "stdio",
            &json!("future"),
            "cancelled"
        ));
        let state = shared.state.lock().unwrap();
        assert!(
            state
                .cancelled_requests
                .contains_key(&request_key("stdio", &json!("future")))
        );
    }

    #[test]
    fn startup_messages_remain_actionable() {
        let config = test_shared().config;
        let error = io::Error::from(io::ErrorKind::AddrInUse);
        assert!(
            startup_failure_message(&config, &error, StartupFailureKind::AlreadyRunning)
                .contains("已经在运行")
        );
        assert!(
            startup_failure_message(&config, &error, StartupFailureKind::PortInUse)
                .contains("47740")
        );
    }
}
