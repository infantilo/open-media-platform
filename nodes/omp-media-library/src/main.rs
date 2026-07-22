//! `omp-media-library` (`UMSETZUNG.md` C17, `ARCHITECTURE.md` §24.2) —
//! Media-Datei-Katalog mit technischen Metadaten und Segmentierung.
//!
//! Ein reiner Control-Plane-Node (kein `omp-mediaio`, kein GStreamer).
//! Scannt ein Verzeichnis (`OMP_MEDIA_DIR`) nach Mediendateien, analysiert
//! diese mit `ffprobe` und speichert Dauer, Video/Audio-Codec, Auflösung,
//! fps, Kanäle. Unterstützt Mark-In/Out-Segmente pro Datei.
//!
//! Methoden: `scan()`, `rescan(file)`, `cleanup()`, `setSegments(file, segments)`
//! Parameter: `entries` (readonly, Katalog als JSON)

mod uibundle;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamType,
    SetError, ParamStore, RawResponse,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VideoInfo {
    codec: String,
    width: u32,
    height: u32,
    fps: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AudioTrack {
    codec: String,
    channels: u32,
    sample_rate: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Segment {
    start: u64,  // ms
    end: u64,    // ms
    label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CatalogEntry {
    #[serde(rename = "fileName")]
    file_name: String,
    #[serde(rename = "filePath")]
    file_path: String,
    #[serde(rename = "durationMs")]
    duration_ms: u64,
    video: Option<VideoInfo>,
    audio: Vec<AudioTrack>,
    segments: Vec<Segment>,
}

struct LibraryState {
    entries: Vec<CatalogEntry>,
    media_dir: PathBuf,
    file_extensions: Vec<String>,
}

struct LibraryStore {
    state: Mutex<LibraryState>,
}

impl LibraryStore {
    fn new(media_dir: PathBuf, file_extensions: Vec<String>) -> Self {
        LibraryStore {
            state: Mutex::new(LibraryState {
                entries: Vec::new(),
                media_dir,
                file_extensions,
            }),
        }
    }

    fn do_scan(&self) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");

        if !state.media_dir.exists() {
            return Err(format!("Media directory does not exist: {}", state.media_dir.display()));
        }

        state.entries.clear();
        let media_dir = state.media_dir.clone();
        let file_extensions = state.file_extensions.clone();
        drop(state); // Release the lock before scanning

        let entries = self.scan_dir_impl(&media_dir, &file_extensions)?;

        let mut state = self.state.lock().expect("lock poisoned");
        state.entries = entries;
        Ok(())
    }

    fn scan_dir_impl(
        &self,
        dir: &Path,
        extensions: &[String],
    ) -> Result<Vec<CatalogEntry>, String> {
        let mut all_entries = Vec::new();
        let entries_dir = fs::read_dir(dir)
            .map_err(|e| format!("Failed to read directory: {}", e))?;

        for entry_result in entries_dir {
            let entry = entry_result
                .map_err(|e| format!("Failed to read entry: {}", e))?;
            let path = entry.path();

            if path.is_dir() {
                let sub_entries = self.scan_dir_impl(&path, extensions)?;
                all_entries.extend(sub_entries);
            } else if path.is_file() {
                if let Some(ext) = path.extension() {
                    let ext_str = ext.to_string_lossy().to_lowercase();
                    if extensions.iter().any(|e| e.to_lowercase() == ext_str) {
                        if let Ok(catalog_entry) = self.analyze_file(&path) {
                            all_entries.push(catalog_entry);
                        }
                    }
                }
            }
        }
        Ok(all_entries)
    }

    fn analyze_file(&self, path: &Path) -> Result<CatalogEntry, String> {
        let file_name = path
            .file_name()
            .ok_or("Invalid file name")?
            .to_string_lossy()
            .to_string();
        let file_path = path.to_string_lossy().to_string();

        let ffprobe_output = Command::new("ffprobe")
            .arg("-print_format")
            .arg("json")
            .arg("-show_format")
            .arg("-show_streams")
            .arg(&file_path)
            .output()
            .map_err(|e| format!("ffprobe failed: {}", e))?;

        if !ffprobe_output.status.success() {
            return Err(format!(
                "ffprobe error: {}",
                String::from_utf8_lossy(&ffprobe_output.stderr)
            ));
        }

        let json_str = String::from_utf8(ffprobe_output.stdout)
            .map_err(|e| format!("ffprobe output not UTF-8: {}", e))?;
        let data: Value = serde_json::from_str(&json_str)
            .map_err(|e| format!("ffprobe JSON parse error: {}", e))?;

        // Extract duration
        let duration_ms = data["format"]["duration"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .map(|d| (d * 1000.0) as u64)
            .unwrap_or(0);

        // Extract video and audio streams
        let mut video = None;
        let mut audio = Vec::new();

        if let Some(streams) = data["streams"].as_array() {
            for stream in streams {
                if stream["codec_type"].as_str() == Some("video") && video.is_none() {
                    if let (Some(codec), Some(width), Some(height)) = (
                        stream["codec_name"].as_str(),
                        stream["width"].as_i64(),
                        stream["height"].as_i64(),
                    ) {
                        let fps = stream["r_frame_rate"]
                            .as_str()
                            .and_then(|s| {
                                let parts: Vec<&str> = s.split('/').collect();
                                if parts.len() == 2 {
                                    let num = parts[0].parse::<f64>().ok()?;
                                    let den = parts[1].parse::<f64>().ok()?;
                                    if den > 0.0 {
                                        Some(num / den)
                                    } else {
                                        None
                                    }
                                } else {
                                    None
                                }
                            })
                            .unwrap_or(0.0);

                        video = Some(VideoInfo {
                            codec: codec.to_string(),
                            width: width as u32,
                            height: height as u32,
                            fps,
                        });
                    }
                } else if stream["codec_type"].as_str() == Some("audio") {
                    if let (Some(codec), Some(channels), Some(sample_rate)) = (
                        stream["codec_name"].as_str(),
                        stream["channels"].as_i64(),
                        stream["sample_rate"].as_str().and_then(|s| s.parse::<u32>().ok()),
                    ) {
                        audio.push(AudioTrack {
                            codec: codec.to_string(),
                            channels: channels as u32,
                            sample_rate,
                        });
                    }
                }
            }
        }

        Ok(CatalogEntry {
            file_name,
            file_path,
            duration_ms,
            video,
            audio,
            segments: Vec::new(),
        })
    }

    fn do_rescan(&self, file_path: &str) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");

        // Find and remove existing entry
        state.entries.retain(|e| e.file_path != file_path);

        // Re-analyze the file
        if let Ok(entry) = self.analyze_file(Path::new(file_path)) {
            state.entries.push(entry);
            Ok(())
        } else {
            Err(format!("Failed to rescan {}", file_path))
        }
    }

    fn do_cleanup(&self) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");

        state.entries.retain(|e| Path::new(&e.file_path).exists());
        Ok(())
    }

    fn do_set_segments(&self, file_path: &str, segments_json: &str) -> Result<(), String> {
        let segments: Vec<Segment> = serde_json::from_str(segments_json)
            .map_err(|e| format!("Invalid segments JSON: {}", e))?;

        let mut state = self.state.lock().expect("lock poisoned");

        if let Some(entry) = state.entries.iter_mut().find(|e| e.file_path == file_path) {
            entry.segments = segments;
            Ok(())
        } else {
            Err(format!("File not found in catalog: {}", file_path))
        }
    }

    fn get_entries_json(&self) -> Value {
        let state = self.state.lock().expect("lock poisoned");
        json!(state.entries)
    }
}

impl ParamStore for LibraryStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            parameters: vec![
                ParamSpec {
                    name: "entries".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
            ],
            methods: vec![
                MethodSpec {
                    name: "scan".to_string(),
                    args: vec![],
                },
                MethodSpec {
                    name: "rescan".to_string(),
                    args: vec![MethodArg {
                        name: "file".to_string(),
                        kind: ParamType::String,
                    }],
                },
                MethodSpec {
                    name: "cleanup".to_string(),
                    args: vec![],
                },
                MethodSpec {
                    name: "setSegments".to_string(),
                    args: vec![
                        MethodArg {
                            name: "file".to_string(),
                            kind: ParamType::String,
                        },
                        MethodArg {
                            name: "segments".to_string(),
                            kind: ParamType::String,
                        },
                    ],
                },
            ],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "entries" => Some(self.get_entries_json()),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        match name {
            "scan" => {
                self.do_scan().map_err(|_| InvokeError::Unknown)?;
                Ok(())
            }
            "rescan" => {
                let file = args
                    .get("file")
                    .and_then(|v| v.as_str())
                    .ok_or(InvokeError::Unknown)?;
                self.do_rescan(file)
                    .map_err(|_| InvokeError::Unknown)?;
                Ok(())
            }
            "cleanup" => {
                self.do_cleanup().map_err(|_| InvokeError::Unknown)?;
                Ok(())
            }
            "setSegments" => {
                let file = args
                    .get("file")
                    .and_then(|v| v.as_str())
                    .ok_or(InvokeError::Unknown)?;
                let segments = args
                    .get("segments")
                    .ok_or(InvokeError::Unknown)?
                    .to_string();
                self.do_set_segments(file, &segments)
                    .map_err(|_| InvokeError::Unknown)?;
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }

    fn extra_route(&self, method: &str, path: &str, _body: &[u8]) -> Option<RawResponse> {
        uibundle::route(method, path)
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Configuration from environment
    let label = std::env::var("OMP_LABEL").unwrap_or_else(|_| "Media Library".to_string());
    let host = std::env::var("OMP_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("OMP_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(0);
    let registry_url = std::env::var("OMP_REGISTRY_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8011".to_string());
    let nats_url = std::env::var("OMP_NATS_URL")
        .unwrap_or_else(|_| "nats://127.0.0.1:4222".to_string());
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let media_dir = std::env::var("OMP_MEDIA_DIR")
        .unwrap_or_else(|_| "/home/infantilo/OpenMediaPlatform/data".to_string());

    let file_extensions = [
        "mp4", "mov", "mkv", "mxf", "wav", "mp3", "m4a", "aac",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();

    let store = Arc::new(LibraryStore::new(PathBuf::from(media_dir), file_extensions));

    // Initial scan on startup
    store.do_scan().ok();

    // Node configuration
    let _handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders: vec![],
            receivers: vec![],
            instance_id,
            media_ready: omp_node_sdk::MediaReadySource::NotApplicable,
        },
        store,
    )
    .await?;

    // Run indefinitely
    tokio::signal::ctrl_c().await?;
    eprintln!("omp-media-library: shutdown requested");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_analyze_file_with_test_media() {
        // Test with the known test file in data/media/
        let test_file = Path::new("/home/infantilo/OpenMediaPlatform/data/media/test-smpte-5s.mp4");
        if !test_file.exists() {
            eprintln!("Test file not found, skipping test");
            return;
        }

        let store = LibraryStore::new(PathBuf::from("/tmp"), vec!["mp4".to_string()]);
        let result = store.analyze_file(test_file);

        assert!(result.is_ok(), "analyze_file should succeed");
        let entry = result.unwrap();

        // Verify basic metadata
        assert!(entry.duration_ms > 0, "duration should be > 0");
        assert_eq!(entry.file_name, "test-smpte-5s.mp4");

        // Verify video information
        assert!(entry.video.is_some(), "video stream should exist");
        let video = entry.video.unwrap();
        assert_eq!(video.codec, "h264");
        assert_eq!(video.width, 640);
        assert_eq!(video.height, 480);
        assert!(video.fps > 0.0);
    }

    #[test]
    fn test_catalog_entry_serialization() {
        let entry = CatalogEntry {
            file_name: "test.mp4".to_string(),
            file_path: "/path/to/test.mp4".to_string(),
            duration_ms: 5000,
            video: Some(VideoInfo {
                codec: "h264".to_string(),
                width: 1920,
                height: 1080,
                fps: 25.0,
            }),
            audio: vec![
                AudioTrack {
                    codec: "aac".to_string(),
                    channels: 2,
                    sample_rate: 48000,
                },
            ],
            segments: vec![
                Segment {
                    start: 0,
                    end: 1000,
                    label: "Intro".to_string(),
                },
            ],
        };

        let json = serde_json::to_value(&entry).expect("serialization should succeed");
        assert_eq!(json["fileName"].as_str().unwrap(), "test.mp4");
        assert_eq!(json["durationMs"].as_u64().unwrap(), 5000);
        assert_eq!(json["video"]["codec"].as_str().unwrap(), "h264");
        assert_eq!(json["audio"][0]["channels"].as_u64().unwrap(), 2);
        assert_eq!(json["segments"][0]["label"].as_str().unwrap(), "Intro");
    }

    #[test]
    fn test_segment_structure() {
        let segments_json = r#"[
            {"start": 0, "end": 1000, "label": "Intro"},
            {"start": 1000, "end": 5000, "label": "Main"}
        ]"#;

        let segments: Vec<Segment> = serde_json::from_str(segments_json).expect("parsing should succeed");
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].label, "Intro");
        assert_eq!(segments[1].start, 1000);
    }
}
