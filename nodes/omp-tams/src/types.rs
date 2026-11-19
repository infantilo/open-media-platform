//! Nutzlasten der TAMS-API 8.2 (JSON). Nur, was Aufnahme und Wiedergabe brauchen (Schemas `flow-video`, `flow-audio`,
//! `flow-segment(-post)`, `flow-storage(-post)`, `service`, `webhook`, `flow-segment-bulk-failure`, `http-request`).
//!
//! Unbekannte Felder werden beim Lesen **ignoriert** (neuere Nebenversion, D-T4) und beim Schreiben nicht erzeugt.
//! Zeiten bleiben als `String`; Aufrufer parsen sie mit [`crate::time`]. Das hält die Nutzlast bitgleich zum Dienst.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const FORMAT_VIDEO: &str = "urn:x-nmos:format:video";
pub const FORMAT_AUDIO: &str = "urn:x-nmos:format:audio";
pub const FORMAT_MULTI: &str = "urn:x-nmos:format:multi";
pub const CONTAINER_MPEGTS: &str = "video/mp2t";
pub const CONTAINER_MP4: &str = "video/mp4";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Fraction {
    pub numerator: u32,
    #[serde(default = "one", skip_serializing_if = "is_one")]
    pub denominator: u32,
}
fn one() -> u32 {
    1
}
fn is_one(v: &u32) -> bool {
    *v == 1
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct VideoEssence {
    pub frame_width: u32,
    pub frame_height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_rate: Option<Fraction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interlace_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bit_depth: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub colorspace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transfer_characteristic: Option<String>,
    /// Muss `true` sein, wenn das Format Init-Segmente nutzt (CMAF, AppNote 0024).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub init_segments: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct AudioEssence {
    pub sample_rate: u32,
    pub channels: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bit_depth: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub init_segments: Option<bool>,
}

/// Flow zum Anlegen (`PUT /flows/{id}`). Felder, die der Dienst selbst führt (`created`, `timerange`, …), fehlen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FlowPut<E> {
    pub id: String,
    pub source_id: String,
    pub format: String,
    pub codec: String,
    pub container: String,
    pub essence_parameters: E,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Ziel-Dauer eines Segments in Sekunden.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub segment_duration: Option<Fraction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avg_bit_rate: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bit_rate: Option<u64>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tags: BTreeMap<String, String>,
}

pub type VideoFlowPut = FlowPut<VideoEssence>;
pub type AudioFlowPut = FlowPut<AudioEssence>;

/// `POST /flows/{id}/storage`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct StorageRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_id: Option<String>,
    /// Nur für Init-Segmente mit anderem MIME-Typ als die Medien-Segmente.
    #[serde(default, rename = "content_type", skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presigned: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HttpRequest {
    pub url: String,
    #[serde(default, rename = "content-type", skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MediaObjectSlot {
    pub object_id: String,
    pub put_url: HttpRequest,
    #[serde(default)]
    pub presigned: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StorageResponse {
    pub media_objects: Vec<MediaObjectSlot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GetUrl {
    pub url: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub presigned: Option<bool>,
}

/// `POST /flows/{id}/segments` (einzeln oder als Feld).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SegmentPost {
    pub object_id: String,
    pub timerange: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ts_offset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_timerange: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_duration: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_offset: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_frame_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub init_object_id: Option<String>,
}

/// Segment aus `GET /flows/{id}/segments`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Segment {
    pub object_id: String,
    pub timerange: String,
    #[serde(default)]
    pub ts_offset: Option<String>,
    #[serde(default)]
    pub object_timerange: Option<String>,
    #[serde(default)]
    pub last_duration: Option<String>,
    #[serde(default)]
    pub sample_offset: Option<u64>,
    #[serde(default)]
    pub sample_count: Option<u64>,
    #[serde(default)]
    pub key_frame_count: Option<u32>,
    #[serde(default)]
    pub init_object_id: Option<String>,
    #[serde(default)]
    pub get_urls: Vec<GetUrl>,
    #[serde(default)]
    pub init_object: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FailedSegment {
    pub object_id: String,
    #[serde(default)]
    pub timerange: Option<String>,
    #[serde(default)]
    pub error: Option<serde_json::Value>,
}

/// Antwort 200 auf `POST …/segments`: einzelne Segmente sind fehlgeschlagen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BulkFailure {
    pub failed_segments: Vec<FailedSegment>,
}

/// `GET /service`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServiceInfo {
    #[serde(rename = "type")]
    pub service_type: String,
    pub api_version: String,
    /// Zeitstempel-Zeichenkette: so lange darf ein Object unregistriert bleiben.
    pub min_object_timeout: String,
    #[serde(default)]
    pub min_presigned_url_timeout: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub service_version: Option<String>,
    #[serde(default)]
    pub event_stream_mechanisms: Vec<serde_json::Value>,
}

/// `POST /service/webhooks`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WebhookPost {
    pub url: String,
    pub events: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flow_ids: Option<Vec<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn video_flow_put_serialises_without_empty_fields() {
        let f = VideoFlowPut {
            id: "11111111-1111-4111-8111-111111111111".into(),
            source_id: "22222222-2222-4222-8222-222222222222".into(),
            format: FORMAT_VIDEO.into(),
            codec: "video/h264".into(),
            container: CONTAINER_MPEGTS.into(),
            essence_parameters: VideoEssence {
                frame_width: 1920,
                frame_height: 1080,
                frame_rate: Some(Fraction { numerator: 50, denominator: 1 }),
                ..Default::default()
            },
            label: Some("Studio A".into()),
            description: None,
            segment_duration: Some(Fraction { numerator: 2, denominator: 1 }),
            avg_bit_rate: None,
            max_bit_rate: None,
            tags: BTreeMap::new(),
        };
        let v = serde_json::to_value(&f).unwrap();
        assert_eq!(v["format"], "urn:x-nmos:format:video");
        assert_eq!(v["container"], "video/mp2t");
        assert_eq!(v["essence_parameters"]["frame_rate"], json!({"numerator": 50}));
        assert!(v.get("description").is_none() && v.get("tags").is_none());
        // Rundlauf
        let back: VideoFlowPut = serde_json::from_value(v).unwrap();
        assert_eq!(back, f);
    }

    #[test]
    fn storage_response_parses_the_documented_shape() {
        let r: StorageResponse = serde_json::from_value(json!({
            "media_objects": [
                {"object_id": "a", "put_url": {"url": "https://x/put?sig=1", "content-type": "video/mp2t"}, "presigned": true},
                {"object_id": "b", "put_url": {"url": "https://x/put2"}}
            ]
        }))
        .unwrap();
        assert_eq!(r.media_objects.len(), 2);
        assert_eq!(r.media_objects[0].put_url.content_type.as_deref(), Some("video/mp2t"));
        assert!(r.media_objects[0].presigned && !r.media_objects[1].presigned);
    }

    #[test]
    fn segment_post_omits_unset_fields_and_keeps_names() {
        let p = SegmentPost {
            object_id: "o1".into(),
            timerange: "[10:0_12:0)".into(),
            ts_offset: Some("0:0".into()),
            object_timerange: None,
            last_duration: None,
            sample_offset: None,
            sample_count: None,
            key_frame_count: Some(1),
            init_object_id: None,
        };
        assert_eq!(
            serde_json::to_value(&p).unwrap(),
            json!({"object_id": "o1", "timerange": "[10:0_12:0)", "ts_offset": "0:0", "key_frame_count": 1})
        );
    }

    #[test]
    fn unknown_fields_are_ignored_for_newer_minor_versions() {
        let s: Segment = serde_json::from_value(json!({
            "object_id": "o", "timerange": "[0:0_2:0)", "neues_feld": {"x": 1},
            "get_urls": [{"url": "https://x/o", "label": "a", "storage_id": "u", "presigned": false, "mehr": 1}]
        }))
        .unwrap();
        assert_eq!(s.get_urls[0].url, "https://x/o");
        let i: ServiceInfo = serde_json::from_value(json!({
            "type": "urn:x-tams:service:test", "api_version": "8.3", "min_object_timeout": "3600:0", "zusatz": true
        }))
        .unwrap();
        assert_eq!(crate::check_api_version(&i.api_version), crate::VersionCheck::NewerMinor);
    }

    #[test]
    fn bulk_failure_parses() {
        let b: BulkFailure = serde_json::from_value(json!({
            "failed_segments": [{"object_id": "o", "timerange": "[0:0_2:0)", "error": {"type": "x", "summary": "y"}}]
        }))
        .unwrap();
        assert_eq!(b.failed_segments[0].object_id, "o");
    }
}
