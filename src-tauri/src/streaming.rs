use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

pub const SUPPORTED_AUDIO_EXTS: &[&str] = &["mp3", "flac", "wav", "ogg", "oga", "opus", "m4a", "aac", "webm"];

/// Maximum bytes read per open-ended HTTP Range chunk (512 KB) to keep RAM flat on huge FLAC files.
pub const MAX_RANGE_CHUNK_BYTES: u64 = 512 * 1024;

/// Maximum bytes served for an explicit closed Range request (4 MB) to guard against excessive allocations.
pub const MAX_EXPLICIT_RANGE_BYTES: u64 = 4 * 1024 * 1024;

pub fn is_supported_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| SUPPORTED_AUDIO_EXTS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

pub fn mime_for_audio(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("mp3") => "audio/mpeg",
        Some("flac") => "audio/flac",
        Some("wav") => "audio/wav",
        Some("ogg") | Some("oga") => "audio/ogg",
        Some("opus") => "audio/opus",
        Some("m4a") => "audio/mp4",
        Some("aac") => "audio/aac",
        Some("webm") => "audio/webm",
        _ => "application/octet-stream",
    }
}

/// Parses a single HTTP `Range: bytes=start-end` header into inclusive `(start, end)` bounds.
pub fn parse_byte_range(header: &str, total_len: u64) -> Option<(u64, u64)> {
    if total_len == 0 {
        return None;
    }
    let spec = header.trim().strip_prefix("bytes=")?;
    let first_range = spec.split(',').next()?.trim();
    let (start_str, end_str) = first_range.split_once('-')?;

    if start_str.is_empty() {
        // Suffix range: bytes=-500
        let suffix: u64 = end_str.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        let capped = suffix.min(MAX_EXPLICIT_RANGE_BYTES);
        let start = total_len.saturating_sub(capped);
        return Some((start, total_len - 1));
    }

    let start: u64 = start_str.parse().ok()?;
    if start >= total_len {
        return None;
    }
    let requested_end = if end_str.is_empty() {
        start
            .saturating_add(MAX_RANGE_CHUNK_BYTES - 1)
            .min(total_len - 1)
    } else {
        let parsed_end = end_str.parse::<u64>().ok()?;
        if parsed_end < start {
            return None;
        }
        parsed_end
            .min(start.saturating_add(MAX_EXPLICIT_RANGE_BYTES - 1))
            .min(total_len - 1)
    };
    Some((start, requested_end))
}

/// Reads an exact inclusive byte slice `[start..=end]` from disk without loading the full file into memory.
pub fn read_file_chunk(path: &Path, start: u64, end: u64) -> Result<Vec<u8>, std::io::Error> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let len = (end - start + 1) as usize;
    let mut buf = vec![0u8; len];
    file.read_exact(&mut buf)?;
    Ok(buf)
}

/// Recursively discovers supported audio files in deterministic sorted order.
pub fn scan_folder_recursive(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut children: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|entry| entry.path()))
        .collect();
    children.sort();
    for path in children {
        if path.is_dir() {
            scan_folder_recursive(&path, out);
        } else if is_supported_audio(&path) {
            out.push(path);
        }
    }
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
        let dir = std::env::temp_dir().join(format!("mplay3r_stream_{prefix}_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn detects_audio_extensions_and_mimes() {
        assert!(is_supported_audio(Path::new("track.FLAC")));
        assert!(is_supported_audio(Path::new("/music/song.opus")));
        assert!(is_supported_audio(Path::new("clip.m4a")));
        assert!(!is_supported_audio(Path::new("readme.md")));
        assert!(!is_supported_audio(Path::new("no_extension")));
        assert_eq!(mime_for_audio(Path::new("a.flac")), "audio/flac");
        assert_eq!(mime_for_audio(Path::new("a.mp3")), "audio/mpeg");
        assert_eq!(mime_for_audio(Path::new("a.ogg")), "audio/ogg");
        assert_eq!(mime_for_audio(Path::new("a.wav")), "audio/wav");
        assert_eq!(mime_for_audio(Path::new("a.m4a")), "audio/mp4");
        assert_eq!(mime_for_audio(Path::new("a.bin")), "application/octet-stream");
    }

    #[test]
    fn parses_open_closed_and_suffix_byte_ranges() {
        assert_eq!(parse_byte_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_byte_range("bytes=100-", 1000), Some((100, 999)));
        assert_eq!(
            parse_byte_range("bytes=0-", 2_000_000),
            Some((0, MAX_RANGE_CHUNK_BYTES - 1))
        );
        assert_eq!(
            parse_byte_range("bytes=0-99999999", 20_000_000),
            Some((0, MAX_EXPLICIT_RANGE_BYTES - 1))
        );
        assert_eq!(parse_byte_range("bytes=-200", 1000), Some((800, 999)));
        assert_eq!(parse_byte_range("bytes=-0", 1000), None);
        assert_eq!(parse_byte_range("bytes=1500-2000", 1000), None);
        assert_eq!(parse_byte_range("bytes=500-200", 1000), None);
        assert_eq!(parse_byte_range("bytes=0-10", 0), None);
        assert_eq!(parse_byte_range("items=0-10", 1000), None);
    }

    #[test]
    fn reads_exact_byte_chunks_from_disk() {
        let dir = temp_dir("chunk");
        let file_path = dir.join("sample.wav");
        fs::write(&file_path, b"0123456789abcdef").unwrap();

        let slice = read_file_chunk(&file_path, 4, 9).unwrap();
        assert_eq!(slice, b"456789");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scans_folders_recursively_sorted_and_filters_non_audio() {
        let root = temp_dir("scan");
        let sub = root.join("album");
        fs::create_dir_all(&sub).unwrap();
        fs::write(root.join("02-beta.mp3"), b"").unwrap();
        fs::write(root.join("notes.txt"), b"").unwrap();
        fs::write(sub.join("01-alpha.FLAC"), b"").unwrap();
        fs::write(sub.join("cover.jpg"), b"").unwrap();

        let mut found = Vec::new();
        scan_folder_recursive(&root, &mut found);

        let names: Vec<String> = found
            .iter()
            .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
            .collect();
        assert_eq!(names, vec!["02-beta.mp3", "01-alpha.FLAC"]);

        let _ = fs::remove_dir_all(&root);
    }
}
