use crate::streaming::{
    is_supported_audio, mime_for_audio, parse_byte_range, read_file_chunk, scan_folder_recursive,
};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_REQUEST_BYTES: usize = 16 * 1024;
const DEFAULT_BROADCAST_JSON: &str =
    r#"{"roomName":"mPlay3r Listening Party","hostName":"Desktop Host","status":"stopped","positionSec":0,"playbackRate":1,"updatedAtMs":0}"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanShareServerConfig {
    pub server_name: String,
    pub port: u16,
    #[serde(default = "default_bind_address")]
    pub bind_address: String,
    pub shared_folders: Vec<String>,
    pub pin: String,
    pub bearer_token: String,
}

fn default_bind_address() -> String {
    "0.0.0.0".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanShareServerStatus {
    pub running: bool,
    pub url: Option<String>,
    pub server_name: Option<String>,
    pub port: Option<u16>,
    pub folder_count: usize,
    pub track_count: usize,
}

impl Default for LanShareServerStatus {
    fn default() -> Self {
        Self {
            running: false,
            url: None,
            server_name: None,
            port: None,
            folder_count: 0,
            track_count: 0,
        }
    }
}

#[derive(Debug, Clone)]
struct IndexedTrack {
    id: String,
    title: String,
    folder: String,
    format: String,
    size_bytes: u64,
    canonical_path: PathBuf,
}

#[derive(Debug, Clone)]
struct IndexedPlaylist {
    id: String,
    name: String,
    folder: String,
    track_ids: Vec<String>,
}

struct LibraryIndex {
    allowed_roots: Vec<PathBuf>,
    folders: Vec<String>,
    tracks: Vec<IndexedTrack>,
    tracks_by_id: HashMap<String, usize>,
    playlists: Vec<IndexedPlaylist>,
}

impl LibraryIndex {
    fn build(raw_folders: &[String]) -> Result<Self, String> {
        if raw_folders.is_empty() {
            return Err("At least one shared folder must be specified.".to_string());
        }

        let mut allowed_roots = Vec::new();
        for raw in raw_folders {
            let trimmed = raw.trim();
            if trimmed.is_empty() || trimmed.contains('\0') {
                return Err("Invalid shared folder path.".to_string());
            }
            let p = Path::new(trimmed);
            if p.components().any(|c| matches!(c, Component::ParentDir)) {
                return Err("Relative parent traversal (..) is forbidden in shared folders.".to_string());
            }
            let canonical = fs::canonicalize(p)
                .map_err(|_| format!("Shared folder does not exist: {trimmed}"))?;
            if !canonical.is_dir() {
                return Err(format!("Shared path is not a directory: {trimmed}"));
            }
            if !allowed_roots.contains(&canonical) {
                allowed_roots.push(canonical);
            }
        }

        let mut tracks = Vec::new();
        let mut tracks_by_id = HashMap::new();
        let mut folder_groups: BTreeMap<String, Vec<String>> = BTreeMap::new();

        for (root_idx, root) in allowed_roots.iter().enumerate() {
            let root_label = root
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("folder-{}", root_idx + 1));

            let mut discovered = Vec::new();
            scan_folder_recursive(root, &mut discovered);
            for file in discovered {
                let Ok(canonical) = fs::canonicalize(&file) else {
                    continue;
                };
                if !canonical.starts_with(root) || !canonical.is_file() || !is_supported_audio(&canonical) {
                    continue;
                }
                let Ok(meta) = fs::metadata(&canonical) else {
                    continue;
                };
                let rel_parent = canonical
                    .parent()
                    .and_then(|p| p.strip_prefix(root).ok())
                    .map(|rel| {
                        let s = rel.to_string_lossy().replace('\\', "/");
                        if s.is_empty() {
                            root_label.clone()
                        } else {
                            format!("{root_label}/{s}")
                        }
                    })
                    .unwrap_or_else(|| root_label.clone());

                let title = canonical
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "Untitled".to_string());
                let format = canonical
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_ascii_uppercase())
                    .unwrap_or_else(|| "AUDIO".to_string());

                let id = format!("trk-{}", tracks.len() + 1);
                let idx = tracks.len();
                tracks.push(IndexedTrack {
                    id: id.clone(),
                    title,
                    folder: rel_parent.clone(),
                    format,
                    size_bytes: meta.len(),
                    canonical_path: canonical,
                });
                tracks_by_id.insert(id.clone(), idx);
                folder_groups.entry(rel_parent).or_default().push(id);
            }
        }

        let folders: Vec<String> = folder_groups.keys().cloned().collect();
        let playlists: Vec<IndexedPlaylist> = folder_groups
            .into_iter()
            .enumerate()
            .map(|(idx, (folder, track_ids))| {
                let name = folder.rsplit('/').next().unwrap_or(&folder).to_string();
                IndexedPlaylist {
                    id: format!("pl-{}", idx + 1),
                    name,
                    folder,
                    track_ids,
                }
            })
            .collect();

        Ok(Self {
            allowed_roots,
            folders,
            tracks,
            tracks_by_id,
            playlists,
        })
    }

    fn is_path_inside_allowlist(&self, candidate: &Path) -> bool {
        let Ok(canonical) = fs::canonicalize(candidate) else {
            return false;
        };
        canonical.is_file()
            && is_supported_audio(&canonical)
            && self.allowed_roots.iter().any(|root| canonical.starts_with(root))
    }
}

#[derive(Clone)]
struct BroadcastState {
    revision: u64,
    state_json: String,
    listeners: usize,
    closed: bool,
}

#[derive(Clone)]
struct BroadcastHub {
    inner: Arc<(Mutex<BroadcastState>, Condvar)>,
}

impl BroadcastHub {
    fn new() -> Self {
        Self {
            inner: Arc::new((
                Mutex::new(BroadcastState {
                    revision: 1,
                    state_json: DEFAULT_BROADCAST_JSON.to_string(),
                    listeners: 0,
                    closed: false,
                }),
                Condvar::new(),
            )),
        }
    }

    fn current(&self) -> (u64, String, usize) {
        let guard = self.inner.0.lock().unwrap();
        (guard.revision, guard.state_json.clone(), guard.listeners)
    }

    fn update(&self, json: &str) -> (u64, String, usize) {
        let (lock, cvar) = &*self.inner;
        let mut guard = lock.lock().unwrap();
        guard.revision += 1;
        guard.state_json = json.to_string();
        let res = (guard.revision, guard.state_json.clone(), guard.listeners);
        cvar.notify_all();
        res
    }

    fn register_listener(&self) -> usize {
        let (lock, cvar) = &*self.inner;
        let mut guard = lock.lock().unwrap();
        guard.listeners += 1;
        let count = guard.listeners;
        cvar.notify_all();
        count
    }

    fn unregister_listener(&self) {
        let (lock, cvar) = &*self.inner;
        let mut guard = lock.lock().unwrap();
        guard.listeners = guard.listeners.saturating_sub(1);
        cvar.notify_all();
    }

    fn wait_next(&self, last_rev: u64, timeout: Duration) -> Option<(u64, String, usize, bool)> {
        let (lock, cvar) = &*self.inner;
        let guard = lock.lock().unwrap();
        if guard.closed {
            return Some((guard.revision, guard.state_json.clone(), guard.listeners, true));
        }
        if guard.revision != last_rev {
            return Some((guard.revision, guard.state_json.clone(), guard.listeners, false));
        }
        let (guard, _) = cvar.wait_timeout(guard, timeout).unwrap();
        if guard.closed {
            return Some((guard.revision, guard.state_json.clone(), guard.listeners, true));
        }
        if guard.revision != last_rev {
            Some((guard.revision, guard.state_json.clone(), guard.listeners, false))
        } else {
            None
        }
    }

    fn close(&self) {
        let (lock, cvar) = &*self.inner;
        let mut guard = lock.lock().unwrap();
        guard.closed = true;
        cvar.notify_all();
    }
}

struct SharedServerState {
    server_name: String,
    pin: String,
    bearer_token: String,
    index: LibraryIndex,
    broadcast: BroadcastHub,
}

struct ActiveLanServer {
    local_addr: SocketAddr,
    url: String,
    server_name: String,
    folder_count: usize,
    track_count: usize,
    shutdown: Arc<AtomicBool>,
    broadcast: BroadcastHub,
    worker: Option<JoinHandle<()>>,
}

impl ActiveLanServer {
    fn shutdown(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        self.broadcast.close();
        let wake_addr = if self.local_addr.ip().is_unspecified() {
            SocketAddr::from(([127, 0, 0, 1], self.local_addr.port()))
        } else {
            self.local_addr
        };
        let _ = TcpStream::connect_timeout(&wake_addr, Duration::from_millis(200));
        if let Some(handle) = self.worker.take() {
            let _ = handle.join();
        }
    }

    fn status(&self) -> LanShareServerStatus {
        LanShareServerStatus {
            running: true,
            url: Some(self.url.clone()),
            server_name: Some(self.server_name.clone()),
            port: Some(self.local_addr.port()),
            folder_count: self.folder_count,
            track_count: self.track_count,
        }
    }
}

impl Drop for ActiveLanServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Managed Tauri state holding at most one active embedded LAN HTTP/SSE server.
#[derive(Default)]
pub struct LanServerManager(Mutex<Option<ActiveLanServer>>);

impl LanServerManager {
    pub fn start(&self, config: LanShareServerConfig) -> Result<LanShareServerStatus, String> {
        if config.pin.trim().len() < 4 {
            return Err("LAN PIN must be at least 4 characters.".to_string());
        }
        if config.bearer_token.trim().len() < 16 {
            return Err("LAN Bearer token must be at least 16 characters.".to_string());
        }
        let server_name = if config.server_name.trim().is_empty() {
            "mPlay3r LAN Library".to_string()
        } else {
            config.server_name.trim().to_string()
        };

        let index = LibraryIndex::build(&config.shared_folders)?;
        let folder_count = index.allowed_roots.len();
        let track_count = index.tracks.len();

        // Stop any existing instance cleanly before binding the requested port.
        {
            let mut guard = self.0.lock().map_err(|_| "LAN server lock poisoned".to_string())?;
            if let Some(mut existing) = guard.take() {
                existing.shutdown();
            }
        }

        let bind_host = if config.bind_address.trim().is_empty() {
            "0.0.0.0"
        } else {
            config.bind_address.trim()
        };
        let listener = TcpListener::bind((bind_host, config.port))
            .map_err(|e| format!("Unable to bind LAN server on {bind_host}:{}: {e}", config.port))?;
        let local_addr = listener
            .local_addr()
            .map_err(|e| format!("Unable to inspect local socket address: {e}"))?;

        let advertised_host = if local_addr.ip().is_unspecified() {
            detect_lan_ipv4().unwrap_or_else(|| "127.0.0.1".to_string())
        } else {
            local_addr.ip().to_string()
        };
        let url = format!("http://{advertised_host}:{}", local_addr.port());

        let broadcast = BroadcastHub::new();
        let state = Arc::new(SharedServerState {
            server_name: server_name.clone(),
            pin: config.pin.trim().to_string(),
            bearer_token: config.bearer_token.trim().to_string(),
            index,
            broadcast: broadcast.clone(),
        });
        let shutdown = Arc::new(AtomicBool::new(false));
        let loop_shutdown = Arc::clone(&shutdown);

        let worker = thread::spawn(move || {
            for incoming in listener.incoming() {
                if loop_shutdown.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = incoming else {
                    continue;
                };
                let req_state = Arc::clone(&state);
                thread::spawn(move || {
                    let _ = handle_connection(stream, &req_state);
                });
            }
        });

        let active = ActiveLanServer {
            local_addr,
            url,
            server_name,
            folder_count,
            track_count,
            shutdown,
            broadcast,
            worker: Some(worker),
        };
        let status = active.status();

        let mut guard = self.0.lock().map_err(|_| "LAN server lock poisoned".to_string())?;
        *guard = Some(active);
        Ok(status)
    }

    pub fn stop(&self) -> bool {
        let Ok(mut guard) = self.0.lock() else {
            return false;
        };
        if let Some(mut active) = guard.take() {
            active.shutdown();
            true
        } else {
            false
        }
    }

    pub fn status(&self) -> LanShareServerStatus {
        let Ok(guard) = self.0.lock() else {
            return LanShareServerStatus::default();
        };
        guard
            .as_ref()
            .map(ActiveLanServer::status)
            .unwrap_or_default()
    }
}

fn detect_lan_ipv4() -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("1.1.1.1:80").ok()?;
    let ip = sock.local_addr().ok()?.ip();
    if ip.is_ipv4() && !ip.is_loopback() {
        Some(ip.to_string())
    } else {
        None
    }
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn has_traversal_segments(raw: &str) -> bool {
    let decoded = percent_decode_str(raw).decode_utf8_lossy();
    let check = |s: &str| {
        s.contains('\0')
            || s.contains('\\')
            || s.split('/').any(|seg| seg == "..")
    };
    check(raw) || check(&decoded)
}

struct ParsedRequest {
    method: String,
    raw_target: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: String,
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn read_http_request(stream: &mut TcpStream) -> Option<ParsedRequest> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));

    let mut buf = Vec::with_capacity(2048);
    let mut temp = [0u8; 1024];
    let header_end;
    loop {
        let n = stream.read(&mut temp).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&temp[..n]);
        if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
            header_end = pos + 4;
            break;
        }
        if buf.len() >= MAX_REQUEST_BYTES {
            return None;
        }
    }

    let head = std::str::from_utf8(&buf[..header_end - 4]).ok()?;
    let mut lines = head.split("\r\n");
    let first = lines.next()?;
    let mut parts = first.split_whitespace();
    let method = parts.next()?.to_ascii_uppercase();
    let raw_target = parts.next()?.to_string();

    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let content_len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
        .min(MAX_REQUEST_BYTES);

    while buf.len() < header_end + content_len {
        let n = stream.read(&mut temp).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&temp[..n]);
        if buf.len() > header_end + MAX_REQUEST_BYTES {
            break;
        }
    }

    let body_end = (header_end + content_len).min(buf.len());
    let body = String::from_utf8_lossy(&buf[header_end..body_end]).to_string();

    let (path, query_str) = raw_target
        .split_once('?')
        .map(|(p, q)| (p.to_string(), Some(q)))
        .unwrap_or_else(|| (raw_target.clone(), None));

    let mut query = HashMap::new();
    if let Some(qs) = query_str {
        for pair in qs.split('&') {
            if pair.is_empty() {
                continue;
            }
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            let k_dec = percent_decode_str(&k.replace('+', " "))
                .decode_utf8_lossy()
                .to_string();
            let v_dec = percent_decode_str(&v.replace('+', " "))
                .decode_utf8_lossy()
                .to_string();
            if !k_dec.is_empty() {
                query.insert(k_dec, v_dec);
            }
        }
    }

    Some(ParsedRequest {
        method,
        raw_target,
        path,
        query,
        headers,
        body,
    })
}

fn is_authenticated(req: &ParsedRequest, expected_token: &str) -> bool {
    if expected_token.is_empty() {
        return false;
    }
    if let Some(auth) = req.headers.get("authorization") {
        if let Some(token) = auth
            .strip_prefix("Bearer ")
            .or_else(|| auth.strip_prefix("bearer "))
        {
            return constant_time_eq(token.trim().as_bytes(), expected_token.as_bytes());
        }
    }
    if let Some(token) = req.query.get("token") {
        return constant_time_eq(token.trim().as_bytes(), expected_token.as_bytes());
    }
    false
}

fn write_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
    extra_headers: &[(&str, &str)],
) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Authorization, Content-Type, Range\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nConnection: close\r\n",
        body.len()
    );
    for (k, v) in extra_headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

fn write_json(stream: &mut TcpStream, status: &str, value: &serde_json::Value) -> std::io::Result<()> {
    let payload = value.to_string();
    write_response(
        stream,
        status,
        "application/json; charset=utf-8",
        payload.as_bytes(),
        &[],
    )
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn handle_connection(mut stream: TcpStream, state: &SharedServerState) -> std::io::Result<()> {
    let Some(req) = read_http_request(&mut stream) else {
        return Ok(());
    };

    if req.method == "OPTIONS" {
        return write_response(&mut stream, "204 No Content", "text/plain", &[], &[]);
    }

    if has_traversal_segments(&req.raw_target) || has_traversal_segments(&req.path) {
        return write_json(
            &mut stream,
            "403 Forbidden",
            &serde_json::json!({ "error": "Path traversal is forbidden" }),
        );
    }

    if req.method == "GET" && (req.path == "/" || req.path == "/index.html") {
        let html = format!(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{}</title></head><body style=\"font-family:system-ui,sans-serif;background:#0e1014;color:#f1f5f9;padding:1.5rem\"><h1>{}</h1><p>mPlay3r Desktop LAN Share is active ({} tracks across {} folders). Connect via the mPlay3r Library Share plugin using your PIN.</p></body></html>",
            html_escape(&state.server_name),
            html_escape(&state.server_name),
            state.index.tracks.len(),
            state.index.allowed_roots.len()
        );
        return write_response(
            &mut stream,
            "200 OK",
            "text/html; charset=utf-8",
            html.as_bytes(),
            &[],
        );
    }

    if req.method == "GET" && req.path == "/api/info" {
        return write_json(
            &mut stream,
            "200 OK",
            &serde_json::json!({
                "name": state.server_name,
                "version": env!("CARGO_PKG_VERSION"),
                "authRequired": true,
                "folderCount": state.index.folders.len(),
                "trackCount": state.index.tracks.len(),
            }),
        );
    }

    if req.method == "POST" && req.path == "/api/auth" {
        let submitted_pin = serde_json::from_str::<serde_json::Value>(&req.body)
            .ok()
            .and_then(|v| v.get("pin").and_then(|p| p.as_str()).map(ToString::to_string))
            .unwrap_or_default();
        if !submitted_pin.is_empty() && constant_time_eq(submitted_pin.as_bytes(), state.pin.as_bytes()) {
            return write_json(
                &mut stream,
                "200 OK",
                &serde_json::json!({
                    "token": state.bearer_token,
                    "name": state.server_name,
                }),
            );
        }
        return write_json(
            &mut stream,
            "401 Unauthorized",
            &serde_json::json!({ "error": "Invalid PIN" }),
        );
    }

    if !is_authenticated(&req, &state.bearer_token) {
        return write_response(
            &mut stream,
            "401 Unauthorized",
            "application/json; charset=utf-8",
            br#"{"error":"Unauthorized: valid Bearer token required"}"#,
            &[("WWW-Authenticate", "Bearer realm=\"mPlay3r LAN\"")],
        );
    }

    if req.method == "GET" && req.path == "/api/library" {
        return handle_library(&mut stream, &req, state);
    }

    if req.method == "GET" && req.path == "/api/playlists" {
        return handle_playlists(&mut stream, state);
    }

    if req.method == "GET" && req.path == "/api/broadcast/state" {
        let (_, json, _) = state.broadcast.current();
        return write_response(
            &mut stream,
            "200 OK",
            "application/json; charset=utf-8",
            json.as_bytes(),
            &[],
        );
    }

    if req.method == "POST" && req.path == "/api/broadcast/state" {
        let parsed: Result<serde_json::Value, _> = serde_json::from_str(&req.body);
        let Ok(val) = parsed else {
            return write_json(
                &mut stream,
                "400 Bad Request",
                &serde_json::json!({ "error": "Broadcast state must be valid JSON" }),
            );
        };
        if !val.is_object() {
            return write_json(
                &mut stream,
                "400 Bad Request",
                &serde_json::json!({ "error": "Broadcast state must be a JSON object" }),
            );
        }
        let (_, json, _) = state.broadcast.update(&val.to_string());
        return write_response(
            &mut stream,
            "200 OK",
            "application/json; charset=utf-8",
            json.as_bytes(),
            &[],
        );
    }

    if req.method == "GET" && req.path == "/api/broadcast/events" {
        return handle_broadcast_sse(&mut stream, state);
    }

    if req.method == "GET" {
        if let Some(track_id) = req.path.strip_prefix("/api/stream/") {
            let Some(&idx) = state.index.tracks_by_id.get(track_id.trim()) else {
                return write_json(
                    &mut stream,
                    "404 Not Found",
                    &serde_json::json!({ "error": "Track not found" }),
                );
            };
            let track = &state.index.tracks[idx];
            if !state.index.is_path_inside_allowlist(&track.canonical_path) {
                return write_json(
                    &mut stream,
                    "403 Forbidden",
                    &serde_json::json!({ "error": "File outside shared folder allowlist" }),
                );
            }
            return stream_audio_file(&mut stream, &req, &track.canonical_path);
        }
    }

    write_json(
        &mut stream,
        "404 Not Found",
        &serde_json::json!({ "error": "Endpoint not found" }),
    )
}

fn handle_library(
    stream: &mut TcpStream,
    req: &ParsedRequest,
    state: &SharedServerState,
) -> std::io::Result<()> {
    let folder_filter = req.query.get("folder").map(String::as_str).unwrap_or("").trim();
    let q_filter = req
        .query
        .get("q")
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let page: usize = req
        .query
        .get("page")
        .and_then(|v| v.parse().ok())
        .unwrap_or(1)
        .max(1);
    let limit: usize = req
        .query
        .get("limit")
        .and_then(|v| v.parse().ok())
        .unwrap_or(50)
        .clamp(1, 200);

    let filtered: Vec<&IndexedTrack> = state
        .index
        .tracks
        .iter()
        .filter(|t| {
            if !folder_filter.is_empty()
                && t.folder != folder_filter
                && !t.folder.starts_with(&format!("{folder_filter}/"))
            {
                return false;
            }
            if !q_filter.is_empty()
                && !t.title.to_ascii_lowercase().contains(&q_filter)
                && !t.folder.to_ascii_lowercase().contains(&q_filter)
            {
                return false;
            }
            true
        })
        .collect();

    let total = filtered.len();
    let total_pages = total.div_ceil(limit).max(1);
    let offset = (page - 1).saturating_mul(limit);
    let page_tracks: Vec<serde_json::Value> = filtered
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|t| {
            serde_json::json!({
                "id": t.id,
                "title": t.title,
                "folder": t.folder,
                "format": t.format,
                "sizeBytes": t.size_bytes,
            })
        })
        .collect();

    write_json(
        stream,
        "200 OK",
        &serde_json::json!({
            "serverName": state.server_name,
            "folder": folder_filter,
            "query": q_filter,
            "page": page,
            "limit": limit,
            "total": total,
            "totalPages": total_pages,
            "folders": state.index.folders,
            "tracks": page_tracks,
        }),
    )
}

fn handle_playlists(stream: &mut TcpStream, state: &SharedServerState) -> std::io::Result<()> {
    let playlists: Vec<serde_json::Value> = state
        .index
        .playlists
        .iter()
        .map(|pl| {
            let tracks: Vec<serde_json::Value> = pl
                .track_ids
                .iter()
                .filter_map(|id| state.index.tracks_by_id.get(id).map(|&i| &state.index.tracks[i]))
                .map(|t| {
                    serde_json::json!({
                        "id": t.id,
                        "title": t.title,
                        "folder": t.folder,
                        "format": t.format,
                        "sizeBytes": t.size_bytes,
                    })
                })
                .collect();
            serde_json::json!({
                "id": pl.id,
                "name": pl.name,
                "folder": pl.folder,
                "trackCount": tracks.len(),
                "tracks": tracks,
            })
        })
        .collect();

    write_json(stream, "200 OK", &serde_json::json!({ "playlists": playlists }))
}

fn stream_audio_file(
    stream: &mut TcpStream,
    req: &ParsedRequest,
    path: &Path,
) -> std::io::Result<()> {
    let Ok(meta) = fs::metadata(path) else {
        return write_json(
            stream,
            "404 Not Found",
            &serde_json::json!({ "error": "File not found" }),
        );
    };
    let total = meta.len();
    let mime = mime_for_audio(path);

    if let Some(range_header) = req.headers.get("range") {
        let Some((start, end)) = parse_byte_range(range_header, total) else {
            let cr = format!("bytes */{total}");
            return write_response(
                stream,
                "416 Range Not Satisfiable",
                "text/plain",
                b"Invalid Range",
                &[("Content-Range", &cr)],
            );
        };
        let chunk = read_file_chunk(path, start, end)?;
        let cr = format!("bytes {start}-{end}/{total}");
        return write_response(
            stream,
            "206 Partial Content",
            mime,
            &chunk,
            &[("Accept-Ranges", "bytes"), ("Content-Range", &cr)],
        );
    }

    if total == 0 {
        return write_response(stream, "200 OK", mime, &[], &[("Accept-Ranges", "bytes")]);
    }
    let data = read_file_chunk(path, 0, total - 1)?;
    write_response(stream, "200 OK", mime, &data, &[("Accept-Ranges", "bytes")])
}

fn format_sse_sync(rev: u64, state_json: &str, listeners: usize) -> String {
    format!(
        "id: {rev}\nevent: sync\ndata: {{\"revision\":{rev},\"serverTimeMs\":{},\"listeners\":{listeners},\"state\":{state_json}}}\n\n",
        now_ms()
    )
}

fn handle_broadcast_sse(stream: &mut TcpStream, state: &SharedServerState) -> std::io::Result<()> {
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let listeners = state.broadcast.register_listener();
    let (mut last_rev, initial_json, _) = state.broadcast.current();
    let first_frame = format_sse_sync(last_rev, &initial_json, listeners);
    let initial_payload = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nAccess-Control-Allow-Origin: *\r\n\r\n{first_frame}"
    );
    if stream.write_all(initial_payload.as_bytes()).is_err() || stream.flush().is_err() {
        state.broadcast.unregister_listener();
        return Ok(());
    }

    loop {
        match state.broadcast.wait_next(last_rev, Duration::from_secs(10)) {
            Some((_, _, _, true)) => break,
            Some((rev, json, count, false)) => {
                last_rev = rev;
                let frame = format_sse_sync(rev, &json, count);
                if stream.write_all(frame.as_bytes()).is_err() || stream.flush().is_err() {
                    break;
                }
            }
            None => {
                if stream.write_all(b": keepalive\n\n").is_err() || stream.flush().is_err() {
                    break;
                }
            }
        }
    }

    state.broadcast.unregister_listener();
    Ok(())
}

fn html_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("mplay3r_lan_{prefix}_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn http_raw(port: u16, req: &str) -> String {
        let mut sock = TcpStream::connect(("127.0.0.1", port)).unwrap();
        sock.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        sock.write_all(req.as_bytes()).unwrap();
        let mut out = Vec::new();
        let _ = sock.read_to_end(&mut out);
        String::from_utf8_lossy(&out).to_string()
    }

    #[test]
    fn enforces_auth_range_streaming_sse_and_traversal_guards_end_to_end() {
        let dir = temp_dir("e2e");
        let album = dir.join("Daft Punk");
        fs::create_dir_all(&album).unwrap();
        fs::write(album.join("01-Around.mp3"), b"0123456789ABCDEF").unwrap();
        fs::write(album.join("notes.txt"), b"should-not-be-indexed").unwrap();

        let mgr = LanServerManager::default();
        assert!(!mgr.status().running);

        let status = mgr
            .start(LanShareServerConfig {
                server_name: "Studio Desktop".to_string(),
                port: 0,
                bind_address: "127.0.0.1".to_string(),
                shared_folders: vec![dir.to_string_lossy().to_string()],
                pin: "654321".to_string(),
                bearer_token: "desktop-lan-secret-token-99".to_string(),
            })
            .expect("LAN server should start cleanly");

        assert!(status.running);
        assert_eq!(status.folder_count, 1);
        assert_eq!(status.track_count, 1);
        let port = status.port.unwrap();

        // 1. Public /api/info works without auth
        let info = http_raw(port, "GET /api/info HTTP/1.1\r\nHost: localhost\r\n\r\n");
        assert!(info.starts_with("HTTP/1.1 200 OK"));
        assert!(info.contains("\"Studio Desktop\""));
        assert!(info.contains("\"trackCount\":1"));

        // 2. Protected /api/library returns 401 without Bearer token
        let unauth = http_raw(port, "GET /api/library HTTP/1.1\r\nHost: localhost\r\n\r\n");
        assert!(unauth.starts_with("HTTP/1.1 401 Unauthorized"));

        // 3. Path traversal is globally rejected with 403
        let trav = http_raw(
            port,
            "GET /api/stream/..%2f..%2fetc%2fpasswd HTTP/1.1\r\nHost: localhost\r\n\r\n",
        );
        assert!(trav.starts_with("HTTP/1.1 403 Forbidden"));

        // 4. Wrong PIN -> 401; right PIN -> Bearer token
        let bad_pin_body = r#"{"pin":"000000"}"#;
        let bad_auth = http_raw(
            port,
            &format!(
                "POST /api/auth HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n{}",
                bad_pin_body.len(),
                bad_pin_body
            ),
        );
        assert!(bad_auth.starts_with("HTTP/1.1 401 Unauthorized"));

        let ok_pin_body = r#"{"pin":"654321"}"#;
        let ok_auth = http_raw(
            port,
            &format!(
                "POST /api/auth HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n{}",
                ok_pin_body.len(),
                ok_pin_body
            ),
        );
        assert!(ok_auth.starts_with("HTTP/1.1 200 OK"));
        assert!(ok_auth.contains("desktop-lan-secret-token-99"));

        // 5. Authorized /api/library & /api/playlists list only audio files
        let lib = http_raw(
            port,
            "GET /api/library?page=1&limit=10 HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer desktop-lan-secret-token-99\r\n\r\n",
        );
        assert!(lib.starts_with("HTTP/1.1 200 OK"));
        assert!(lib.contains("\"01-Around\""));
        assert!(!lib.contains("notes.txt"));

        let pls = http_raw(
            port,
            "GET /api/playlists HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer desktop-lan-secret-token-99\r\n\r\n",
        );
        assert!(pls.starts_with("HTTP/1.1 200 OK"));
        assert!(pls.contains("\"Daft Punk\""));

        // 6. HTTP 206 Partial Content Range streaming
        let range = http_raw(
            port,
            "GET /api/stream/trk-1 HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer desktop-lan-secret-token-99\r\nRange: bytes=4-11\r\n\r\n",
        );
        assert!(range.starts_with("HTTP/1.1 206 Partial Content"));
        assert!(range.contains("Content-Range: bytes 4-11/16"));
        assert!(range.ends_with("456789AB"));

        // 7. Broadcast Listening Party state + SSE initial frame
        let b_body = r#"{"status":"playing","positionSec":42,"playbackRate":1.25}"#;
        let b_post = http_raw(
            port,
            &format!(
                "POST /api/broadcast/state HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer desktop-lan-secret-token-99\r\nContent-Length: {}\r\n\r\n{}",
                b_body.len(),
                b_body
            ),
        );
        assert!(b_post.starts_with("HTTP/1.1 200 OK"));

        let mut sse_sock = TcpStream::connect(("127.0.0.1", port)).unwrap();
        sse_sock
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        sse_sock
            .write_all(
                b"GET /api/broadcast/events?token=desktop-lan-secret-token-99 HTTP/1.1\r\nHost: localhost\r\n\r\n",
            )
            .unwrap();
        let mut sse_text = String::new();
        let mut sse_buf = [0u8; 1024];
        for _ in 0..8 {
            let n = sse_sock.read(&mut sse_buf).unwrap();
            if n == 0 {
                break;
            }
            sse_text.push_str(&String::from_utf8_lossy(&sse_buf[..n]));
            if sse_text.contains("event: sync") && sse_text.contains("\n\n") {
                break;
            }
        }
        assert!(sse_text.contains("text/event-stream"));
        assert!(sse_text.contains("event: sync"));
        assert!(sse_text.contains("\"positionSec\":42"));
        drop(sse_sock);

        assert!(mgr.stop());
        assert!(!mgr.status().running);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_relative_traversal_in_shared_folders() {
        let mgr = LanServerManager::default();
        let err = mgr.start(LanShareServerConfig {
            server_name: "Bad".to_string(),
            port: 0,
            bind_address: "127.0.0.1".to_string(),
            shared_folders: vec!["/tmp/../etc".to_string()],
            pin: "123456".to_string(),
            bearer_token: "valid-length-token-123456".to_string(),
        });
        assert!(err.is_err());
    }
}
