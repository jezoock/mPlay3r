mod portable;
mod streaming;

use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::http::{header, Response, StatusCode};
use tauri::{Manager, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

/// Security allowlist of canonical audio paths explicitly selected by the user.
struct AllowedPaths(Mutex<HashSet<PathBuf>>);

struct AppStorageState {
    is_portable: bool,
    data_dir: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopAppInfo {
    is_desktop: bool,
    is_portable: bool,
    data_dir: String,
    version: String,
}

#[derive(Serialize)]
struct DesktopAudioFile {
    path: String,
    url: String,
    name: String,
}

#[derive(Serialize)]
struct PlaylistFilePayload {
    name: String,
    content: String,
}

fn build_stream_url(canonical: &Path) -> String {
    let encoded = utf8_percent_encode(&canonical.to_string_lossy(), NON_ALPHANUMERIC).to_string();
    // On Windows WebView2 custom protocols use `http://<scheme>.localhost/`; macOS/Linux use `<scheme>://localhost/`.
    #[cfg(target_os = "windows")]
    {
        format!("http://mplay3r.localhost/{encoded}")
    }
    #[cfg(not(target_os = "windows"))]
    {
        format!("mplay3r://localhost/{encoded}")
    }
}

fn is_path_authorized(path: &Path, allowlist: &AllowedPaths) -> bool {
    allowlist
        .0
        .lock()
        .map(|set| set.contains(path))
        .unwrap_or(false)
}

fn authorize_audio_path(path: &Path, allowlist: &AllowedPaths) -> Option<DesktopAudioFile> {
    if !streaming::is_supported_audio(path) {
        return None;
    }
    let canonical = fs::canonicalize(path).ok()?;
    if !canonical.is_file() {
        return None;
    }
    let name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let url = build_stream_url(&canonical);
    let path_str = canonical.to_string_lossy().to_string();

    if let Ok(mut guard) = allowlist.0.lock() {
        guard.insert(canonical);
    }

    Some(DesktopAudioFile {
        path: path_str,
        url,
        name,
    })
}

fn file_path_to_pathbuf(fp: FilePath) -> Option<PathBuf> {
    fp.into_path().ok()
}

#[tauri::command]
fn get_app_info(storage: State<'_, AppStorageState>) -> DesktopAppInfo {
    DesktopAppInfo {
        is_desktop: true,
        is_portable: storage.is_portable,
        data_dir: storage.data_dir.to_string_lossy().to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

#[tauri::command]
async fn pick_audio_files(
    app: tauri::AppHandle,
    allowlist: State<'_, AllowedPaths>,
) -> Result<Vec<DesktopAudioFile>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Audio files", streaming::SUPPORTED_AUDIO_EXTS)
        .blocking_pick_files();

    let Some(paths) = picked else {
        return Ok(Vec::new());
    };

    Ok(paths
        .into_iter()
        .filter_map(file_path_to_pathbuf)
        .filter_map(|p| authorize_audio_path(&p, &allowlist))
        .collect())
}

#[tauri::command]
async fn pick_audio_folder(
    app: tauri::AppHandle,
    allowlist: State<'_, AllowedPaths>,
) -> Result<Vec<DesktopAudioFile>, String> {
    let Some(folder) = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(file_path_to_pathbuf)
    else {
        return Ok(Vec::new());
    };

    let mut found = Vec::new();
    streaming::scan_folder_recursive(&folder, &mut found);
    Ok(found
        .into_iter()
        .filter_map(|p| authorize_audio_path(&p, &allowlist))
        .collect())
}

#[tauri::command]
fn resolve_audio_paths(paths: Vec<String>, allowlist: State<'_, AllowedPaths>) -> Vec<DesktopAudioFile> {
    paths
        .into_iter()
        .filter_map(|raw| authorize_audio_path(Path::new(&raw), &allowlist))
        .collect()
}

#[tauri::command]
async fn pick_playlist_file(app: tauri::AppHandle) -> Result<Option<PlaylistFilePayload>, String> {
    let Some(path) = app
        .dialog()
        .file()
        .add_filter("Playlists", &["m3u", "m3u8", "pls"])
        .blocking_pick_file()
        .and_then(file_path_to_pathbuf)
    else {
        return Ok(None);
    };

    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "playlist.m3u8".to_string());

    Ok(Some(PlaylistFilePayload { name, content }))
}

#[tauri::command]
async fn save_playlist_file(
    app: tauri::AppHandle,
    content: String,
    default_name: String,
) -> Result<bool, String> {
    let Some(dest) = app
        .dialog()
        .file()
        .add_filter("M3U8 Playlist", &["m3u8", "m3u"])
        .set_file_name(&default_name)
        .blocking_save_file()
        .and_then(file_path_to_pathbuf)
    else {
        return Ok(false);
    };

    fs::write(dest, content).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn load_persisted_state(storage: State<'_, AppStorageState>) -> Option<String> {
    portable::read_state_file(&storage.data_dir)
}

#[tauri::command]
fn save_persisted_state(storage: State<'_, AppStorageState>, json: String) -> bool {
    portable::write_state_file(&storage.data_dir, &json).is_ok()
}

fn handle_stream_request(
    app: &tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let raw_encoded = request.uri().path().trim_start_matches('/');
    let decoded = match percent_decode_str(raw_encoded).decode_utf8() {
        Ok(path) => PathBuf::from(path.as_ref()),
        Err(_) => {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(Vec::new())
                .unwrap();
        }
    };

    // Only stream canonical paths previously authorized via user dialogs or restored playlists.
    if !is_path_authorized(&decoded, &app.state::<AllowedPaths>()) {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Vec::new())
            .unwrap();
    }

    let Ok(meta) = fs::metadata(&decoded) else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Vec::new())
            .unwrap();
    };
    let total_len = meta.len();
    let mime = streaming::mime_for_audio(&decoded);

    if let Some(range_val) = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok()) {
        if let Some((start, end)) = streaming::parse_byte_range(range_val, total_len) {
            if let Ok(chunk) = streaming::read_file_chunk(&decoded, start, end) {
                return Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_TYPE, mime)
                    .header(header::ACCEPT_RANGES, "bytes")
                    .header(header::CONTENT_LENGTH, chunk.len().to_string())
                    .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total_len}"))
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .body(chunk)
                    .unwrap();
            }
        }
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{total_len}"))
            .body(Vec::new())
            .unwrap();
    }

    if total_len == 0 {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_LENGTH, "0")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Vec::new())
            .unwrap();
    }

    let end = total_len - 1;
    match streaming::read_file_chunk(&decoded, 0, end) {
        Ok(data) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_LENGTH, data.len().to_string())
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(data)
            .unwrap(),
        Err(_) => Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Vec::new())
            .unwrap(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AllowedPaths(Mutex::new(HashSet::new())))
        .register_uri_scheme_protocol("mplay3r", |ctx, request| {
            handle_stream_request(ctx.app_handle(), request)
        })
        .setup(|app| {
            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(Path::to_path_buf));
            let config_dir = app.path().app_config_dir().ok();
            let (is_portable, data_dir) =
                portable::resolve_data_dir(exe_dir.as_deref(), config_dir.as_deref());
            app.manage(AppStorageState {
                is_portable,
                data_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            pick_audio_files,
            pick_audio_folder,
            resolve_audio_paths,
            pick_playlist_file,
            save_playlist_file,
            load_persisted_state,
            save_persisted_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running mPlay3r desktop application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("mplay3r_lib_{prefix}_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn authorizes_canonical_audio_paths_and_rejects_non_audio_or_traversal() {
        let dir = temp_dir("allowlist");
        let audio = dir.join("demo.flac");
        let secret = dir.join("notes.txt");
        fs::write(&audio, b"fLaC").unwrap();
        fs::write(&secret, b"private").unwrap();

        let allowlist = AllowedPaths(Mutex::new(HashSet::new()));

        // Non-audio files and directories must never enter the allowlist.
        assert!(authorize_audio_path(&secret, &allowlist).is_none());
        assert!(authorize_audio_path(&dir, &allowlist).is_none());

        // Valid audio file is canonicalized, registered, and encoded into a stream URL.
        let authorized = authorize_audio_path(&audio, &allowlist).expect("expected authorized audio");
        let canonical = fs::canonicalize(&audio).unwrap();
        assert_eq!(authorized.name, "demo.flac");
        assert_eq!(authorized.path, canonical.to_string_lossy());
        assert!(authorized.url.contains("mplay3r"));
        assert!(is_path_authorized(&canonical, &allowlist));

        // Unauthorized paths and uncanonicalized path-traversal segments must be rejected.
        let traversal = dir.join("..").join(dir.file_name().unwrap()).join("demo.flac");
        assert!(!is_path_authorized(&traversal, &allowlist));
        assert!(!is_path_authorized(Path::new("/etc/passwd"), &allowlist));

        let _ = fs::remove_dir_all(&dir);
    }
}
