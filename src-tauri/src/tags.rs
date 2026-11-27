use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

/// User-supplied text tag patch for an authorized local MP3 file.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTagPatch {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
}

/// Result returned after atomically writing an ID3v2.3 header to disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteAudioTagsResult {
    pub path: String,
    pub updated_frames: Vec<String>,
    pub bytes_written: usize,
}

/// Decoded ID3v2 text frames (used for verification and tests).
#[cfg(test)]
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DecodedId3Tags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
}

/// Maximum accepted ID3v2 header size (32 MB) to prevent unbounded allocations on malformed files.
const MAX_ID3V2_TAG_BYTES: usize = 32 * 1024 * 1024;

pub fn is_mp3_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("mp3"))
        .unwrap_or(false)
}

fn decode_syncsafe_u32(bytes: &[u8]) -> u32 {
    ((u32::from(bytes[0] & 0x7f)) << 21)
        | ((u32::from(bytes[1] & 0x7f)) << 14)
        | ((u32::from(bytes[2] & 0x7f)) << 7)
        | u32::from(bytes[3] & 0x7f)
}

fn encode_syncsafe_u32(val: u32) -> [u8; 4] {
    [
        ((val >> 21) & 0x7f) as u8,
        ((val >> 14) & 0x7f) as u8,
        ((val >> 7) & 0x7f) as u8,
        (val & 0x7f) as u8,
    ]
}

fn encode_id3v23_utf16le_frame(frame_id: &[u8; 4], text: &str) -> Vec<u8> {
    let utf16: Vec<u16> = text.encode_utf16().collect();
    // 1 byte encoding (0x01 = UTF-16 with BOM) + 2 bytes LE BOM + 2 bytes per UTF-16 code unit.
    let payload_len = 1 + 2 + utf16.len() * 2;
    let mut frame = Vec::with_capacity(10 + payload_len);
    frame.extend_from_slice(frame_id);
    frame.extend_from_slice(&(payload_len as u32).to_be_bytes());
    frame.extend_from_slice(&[0x00, 0x00]); // frame flags
    frame.push(0x01); // UTF-16 with BOM
    frame.extend_from_slice(&[0xff, 0xfe]); // UTF-16LE BOM
    for unit in utf16 {
        frame.extend_from_slice(&unit.to_le_bytes());
    }
    frame
}

fn is_valid_frame_id(id: &[u8]) -> bool {
    id.len() == 4 && id.iter().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

/// Extracts untouched existing ID3v2 frames (normalized to ID3v2.3 headers) and returns
/// `(preserved_frames, audio_payload_offset)`.
fn extract_existing_id3v2_frames(bytes: &[u8], skip_ids: &[[u8; 4]]) -> (Vec<Vec<u8>>, usize) {
    if bytes.len() < 10 || &bytes[0..3] != b"ID3" {
        return (Vec::new(), 0);
    }

    let major = bytes[3];
    let flags = bytes[5];
    let tag_size = decode_syncsafe_u32(&bytes[6..10]) as usize;
    if tag_size > MAX_ID3V2_TAG_BYTES || 10 + tag_size > bytes.len() {
        return (Vec::new(), 0);
    }

    let mut audio_offset = 10 + tag_size;
    // Skip optional 10-byte ID3v2.4 footer if footer flag (0x10) is present.
    if major == 4 && (flags & 0x10) != 0 && audio_offset + 10 <= bytes.len() {
        audio_offset += 10;
    }

    // Only parse frames for ID3v2.3 / ID3v2.4 without whole-tag unsynchronization.
    if (major != 3 && major != 4) || (flags & 0x80) != 0 {
        return (Vec::new(), audio_offset);
    }

    let limit = 10 + tag_size;
    let mut offset = 10usize;
    if (flags & 0x40) != 0 && offset + 4 <= limit {
        let ext_size = if major == 4 {
            decode_syncsafe_u32(&bytes[offset..offset + 4]) as usize
        } else {
            u32::from_be_bytes([bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]]) as usize
                + 4
        };
        offset = offset.saturating_add(ext_size);
    }

    let mut preserved = Vec::new();
    while offset + 10 <= limit {
        if bytes[offset] == 0 {
            break; // Padding reached.
        }
        let frame_id = &bytes[offset..offset + 4];
        if !is_valid_frame_id(frame_id) {
            break;
        }
        let frame_size = if major == 4 {
            decode_syncsafe_u32(&bytes[offset + 4..offset + 8]) as usize
        } else {
            u32::from_be_bytes([
                bytes[offset + 4],
                bytes[offset + 5],
                bytes[offset + 6],
                bytes[offset + 7],
            ]) as usize
        };
        let frame_flags = [bytes[offset + 8], bytes[offset + 9]];
        offset += 10;
        if frame_size == 0 || offset + frame_size > limit {
            break;
        }

        let mut id_arr = [0u8; 4];
        id_arr.copy_from_slice(frame_id);
        if !skip_ids.contains(&id_arr) {
            let mut normalized = Vec::with_capacity(10 + frame_size);
            normalized.extend_from_slice(&id_arr);
            normalized.extend_from_slice(&(frame_size as u32).to_be_bytes());
            normalized.extend_from_slice(&frame_flags);
            normalized.extend_from_slice(&bytes[offset..offset + frame_size]);
            preserved.push(normalized);
        }
        offset += frame_size;
    }

    (preserved, audio_offset)
}

/// Builds a fresh MP3 byte buffer with an ID3v2.3 header containing patched `TIT2`/`TPE1`/`TALB`
/// frames plus all untouched existing ID3v2 frames and the exact original audio payload.
pub fn apply_id3v23_patch_to_bytes(
    original: &[u8],
    patch: &AudioTagPatch,
) -> Result<(Vec<u8>, Vec<String>), String> {
    let mut patched_frames: Vec<([u8; 4], String)> = Vec::new();
    if let Some(title) = patch.title.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        patched_frames.push((*b"TIT2", title.to_string()));
    }
    if let Some(artist) = patch.artist.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        patched_frames.push((*b"TPE1", artist.to_string()));
    }
    if let Some(album) = patch.album.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        patched_frames.push((*b"TALB", album.to_string()));
    }

    if patched_frames.is_empty() {
        return Err("At least one non-empty tag field (title, artist, or album) is required.".to_string());
    }

    let skip_ids: Vec<[u8; 4]> = patched_frames.iter().map(|(id, _)| *id).collect();
    let (preserved_frames, audio_offset) = extract_existing_id3v2_frames(original, &skip_ids);

    let mut body = Vec::new();
    let mut updated_names = Vec::with_capacity(patched_frames.len());
    for (frame_id, text) in &patched_frames {
        body.extend_from_slice(&encode_id3v23_utf16le_frame(frame_id, text));
        updated_names.push(String::from_utf8_lossy(frame_id).to_string());
    }
    for frame in preserved_frames {
        body.extend_from_slice(&frame);
    }

    if body.len() > MAX_ID3V2_TAG_BYTES {
        return Err("Resulting ID3v2.3 tag exceeds maximum allowed size.".to_string());
    }

    let audio_payload = &original[audio_offset..];
    let mut output = Vec::with_capacity(10 + body.len() + audio_payload.len());
    output.extend_from_slice(b"ID3");
    output.push(3); // ID3v2.3
    output.push(0); // revision 0
    output.push(0); // flags
    output.extend_from_slice(&encode_syncsafe_u32(body.len() as u32));
    output.extend_from_slice(&body);
    output.extend_from_slice(audio_payload);

    Ok((output, updated_names))
}

fn temp_sibling_path(target: &Path) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "Target audio path has no parent directory.".to_string())?;
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("track.mp3");
    let pid = std::process::id();
    Ok(parent.join(format!(".{name}.mplay3r.{pid}.tmp")))
}

/// Atomically updates ID3v2.3 tags on an already-authorized canonical MP3 file path.
pub fn write_mp3_id3v2_tags(
    canonical_path: &Path,
    patch: &AudioTagPatch,
) -> Result<WriteAudioTagsResult, String> {
    if !is_mp3_path(canonical_path) {
        return Err("ID3v2 tag writing currently supports MP3 files only.".to_string());
    }
    let original = fs::read(canonical_path).map_err(|e| format!("Failed to read MP3 file: {e}"))?;
    let (updated_bytes, updated_frames) = apply_id3v23_patch_to_bytes(&original, patch)?;

    let tmp_path = temp_sibling_path(canonical_path)?;
    let write_res = (|| -> std::io::Result<()> {
        let mut tmp_file = File::create(&tmp_path)?;
        tmp_file.write_all(&updated_bytes)?;
        tmp_file.sync_all()?;
        Ok(())
    })();

    if let Err(err) = write_res {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed to write temporary MP3 file: {err}"));
    }

    if let Err(err) = fs::rename(&tmp_path, canonical_path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed to atomically replace MP3 file: {err}"));
    }

    Ok(WriteAudioTagsResult {
        path: canonical_path.to_string_lossy().to_string(),
        updated_frames,
        bytes_written: updated_bytes.len(),
    })
}

/// Decodes `TIT2`, `TPE1`, and `TALB` text frames from an ID3v2.3/v2.4 buffer (for round-trip checks).
#[cfg(test)]
pub fn decode_id3v2_tags(bytes: &[u8]) -> DecodedId3Tags {
    let mut out = DecodedId3Tags::default();
    if bytes.len() < 10 || &bytes[0..3] != b"ID3" {
        return out;
    }
    let major = bytes[3];
    let tag_size = decode_syncsafe_u32(&bytes[6..10]) as usize;
    let limit = (10 + tag_size).min(bytes.len());
    let mut offset = 10usize;

    while offset + 10 <= limit {
        if bytes[offset] == 0 {
            break;
        }
        let id = &bytes[offset..offset + 4];
        let size = if major == 4 {
            decode_syncsafe_u32(&bytes[offset + 4..offset + 8]) as usize
        } else {
            u32::from_be_bytes([
                bytes[offset + 4],
                bytes[offset + 5],
                bytes[offset + 6],
                bytes[offset + 7],
            ]) as usize
        };
        offset += 10;
        if size == 0 || offset + size > limit {
            break;
        }
        let data = &bytes[offset..offset + size];
        if id == b"TIT2" || id == b"TPE1" || id == b"TALB" {
            if let Some(decoded) = decode_text_frame(data) {
                match id {
                    b"TIT2" => out.title = Some(decoded),
                    b"TPE1" => out.artist = Some(decoded),
                    b"TALB" => out.album = Some(decoded),
                    _ => {}
                }
            }
        }
        offset += size;
    }
    out
}

#[cfg(test)]
fn decode_text_frame(data: &[u8]) -> Option<String> {
    if data.len() < 2 {
        return None;
    }
    let enc = data[0];
    let payload = &data[1..];
    let text = match enc {
        0 => payload.iter().map(|&b| b as char).collect::<String>(),
        1 => {
            let (is_be, slice) = if payload.len() >= 2 && payload[0] == 0xfe && payload[1] == 0xff {
                (true, &payload[2..])
            } else if payload.len() >= 2 && payload[0] == 0xff && payload[1] == 0xfe {
                (false, &payload[2..])
            } else {
                (false, payload)
            };
            let units: Vec<u16> = slice
                .chunks_exact(2)
                .map(|c| {
                    if is_be {
                        u16::from_be_bytes([c[0], c[1]])
                    } else {
                        u16::from_le_bytes([c[0], c[1]])
                    }
                })
                .collect();
            String::from_utf16_lossy(&units)
        }
        3 => String::from_utf8_lossy(payload).to_string(),
        _ => return None,
    };
    let clean = text.trim_matches('\0').trim().to_string();
    if clean.is_empty() {
        None
    } else {
        Some(clean)
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
        let dir = std::env::temp_dir().join(format!("mplay3r_tags_{prefix}_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn writes_unicode_id3v23_to_tagless_mp3_and_preserves_audio_payload_verbatim() {
        let dir = temp_dir("tagless");
        let mp3 = dir.join("track.mp3");
        // Fake MPEG frame sync payload
        let raw_audio = b"\xff\xfb\x90\x64AUDIO_FRAME_DATA_0123456789";
        fs::write(&mp3, raw_audio).unwrap();

        let res = write_mp3_id3v2_tags(
            &mp3,
            &AudioTagPatch {
                title: Some("Été — Cœur d'Amour".to_string()),
                artist: Some("Daft Punk".to_string()),
                album: Some("Discovery (Édition Spéciale)".to_string()),
            },
        )
        .expect("should write ID3v2.3 tags");

        assert_eq!(res.updated_frames, vec!["TIT2", "TPE1", "TALB"]);
        let written = fs::read(&mp3).unwrap();
        assert_eq!(&written[0..5], b"ID3\x03\x00");
        assert!(written.ends_with(raw_audio));

        let decoded = decode_id3v2_tags(&written);
        assert_eq!(decoded.title.as_deref(), Some("Été — Cœur d'Amour"));
        assert_eq!(decoded.artist.as_deref(), Some("Daft Punk"));
        assert_eq!(decoded.album.as_deref(), Some("Discovery (Édition Spéciale)"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn partial_tag_update_preserves_untouched_frames_and_existing_tags() {
        let dir = temp_dir("partial");
        let mp3 = dir.join("existing.mp3");
        let raw_audio = b"\xff\xfb\x90\x00RAW_PAYLOAD";

        // Build an initial ID3v2.3 file containing TIT2, TPE1, TALB, plus a custom COMM frame.
        let mut init_frames = Vec::new();
        init_frames.extend_from_slice(&encode_id3v23_utf16le_frame(b"TIT2", "Old Title"));
        init_frames.extend_from_slice(&encode_id3v23_utf16le_frame(b"TPE1", "Air"));
        init_frames.extend_from_slice(&encode_id3v23_utf16le_frame(b"TALB", "Moon Safari"));
        // Custom COMM frame (non-patched)
        let comm_payload = b"\x00eng\x00Kept Comment";
        init_frames.extend_from_slice(b"COMM");
        init_frames.extend_from_slice(&(comm_payload.len() as u32).to_be_bytes());
        init_frames.extend_from_slice(&[0, 0]);
        init_frames.extend_from_slice(comm_payload);

        let mut initial_file = Vec::new();
        initial_file.extend_from_slice(b"ID3\x03\x00\x00");
        initial_file.extend_from_slice(&encode_syncsafe_u32(init_frames.len() as u32));
        initial_file.extend_from_slice(&init_frames);
        initial_file.extend_from_slice(raw_audio);
        fs::write(&mp3, &initial_file).unwrap();

        let res = write_mp3_id3v2_tags(
            &mp3,
            &AudioTagPatch {
                title: Some("La Femme d'Argent".to_string()),
                artist: None,
                album: None,
            },
        )
        .unwrap();

        assert_eq!(res.updated_frames, vec!["TIT2"]);
        let updated = fs::read(&mp3).unwrap();
        assert!(updated.ends_with(raw_audio));
        // Existing COMM comment frame must still be present verbatim.
        assert!(updated.windows(b"Kept Comment".len()).any(|w| w == b"Kept Comment"));

        let decoded = decode_id3v2_tags(&updated);
        assert_eq!(decoded.title.as_deref(), Some("La Femme d'Argent"));
        assert_eq!(decoded.artist.as_deref(), Some("Air"));
        assert_eq!(decoded.album.as_deref(), Some("Moon Safari"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_non_mp3_files_and_empty_tag_patches() {
        let dir = temp_dir("reject");
        let flac = dir.join("song.flac");
        let mp3 = dir.join("song.mp3");
        fs::write(&flac, b"fLaC").unwrap();
        fs::write(&mp3, b"\xff\xfb\x90").unwrap();

        assert!(write_mp3_id3v2_tags(
            &flac,
            &AudioTagPatch {
                title: Some("Nope".to_string()),
                ..Default::default()
            }
        )
        .is_err());

        assert!(write_mp3_id3v2_tags(&mp3, &AudioTagPatch::default()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
