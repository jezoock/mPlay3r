use std::fs;
use std::path::{Path, PathBuf};

/// Resolves whether mPlay3r is running in portable mode and returns its data directory.
///
/// Portable mode activates automatically when:
/// - `MPLAY3R_PORTABLE=1` is set in the environment, OR
/// - a `portable.flag` file exists next to the executable, OR
/// - a `data/` directory already exists next to the executable.
pub fn resolve_data_dir(exe_dir: Option<&Path>, fallback_config_dir: Option<&Path>) -> (bool, PathBuf) {
    if let Some(dir) = exe_dir {
        let env_portable = std::env::var("MPLAY3R_PORTABLE")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        let flag_exists = dir.join("portable.flag").exists();
        let data_dir = dir.join("data");
        if env_portable || flag_exists || data_dir.is_dir() {
            return (true, data_dir);
        }
    }

    let config = fallback_config_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("mplay3r-data"));
    (false, config)
}

pub fn read_state_file(data_dir: &Path) -> Option<String> {
    fs::read_to_string(data_dir.join("state.json")).ok()
}

pub fn write_state_file(data_dir: &Path, json: &str) -> Result<(), String> {
    fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    fs::write(data_dir.join("state.json"), json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("mplay3r_{prefix}_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn detects_portable_mode_via_flag_file() {
        let exe_dir = temp_dir("portable_flag");
        let cfg_dir = temp_dir("fallback_cfg");
        fs::write(exe_dir.join("portable.flag"), "").unwrap();

        let (portable, resolved) = resolve_data_dir(Some(&exe_dir), Some(&cfg_dir));
        assert!(portable);
        assert_eq!(resolved, exe_dir.join("data"));

        let _ = fs::remove_dir_all(&exe_dir);
        let _ = fs::remove_dir_all(&cfg_dir);
    }

    #[test]
    fn detects_portable_mode_via_existing_data_dir() {
        let exe_dir = temp_dir("portable_data_dir");
        let cfg_dir = temp_dir("fallback_cfg_2");
        let existing_data = exe_dir.join("data");
        fs::create_dir_all(&existing_data).unwrap();

        let (portable, resolved) = resolve_data_dir(Some(&exe_dir), Some(&cfg_dir));
        assert!(portable);
        assert_eq!(resolved, existing_data);

        let _ = fs::remove_dir_all(&exe_dir);
        let _ = fs::remove_dir_all(&cfg_dir);
    }

    #[test]
    fn falls_back_to_os_config_dir_when_installed() {
        let exe_dir = temp_dir("installed_exe");
        let cfg_dir = temp_dir("installed_cfg");

        let (portable, resolved) = resolve_data_dir(Some(&exe_dir), Some(&cfg_dir));
        assert!(!portable);
        assert_eq!(resolved, cfg_dir);

        write_state_file(&resolved, r#"{"volume":0.8}"#).unwrap();
        assert_eq!(read_state_file(&resolved).as_deref(), Some(r#"{"volume":0.8}"#));

        let _ = fs::remove_dir_all(&exe_dir);
        let _ = fs::remove_dir_all(&cfg_dir);
    }
}
