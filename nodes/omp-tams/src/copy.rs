//! Metadaten-Kopie eines Zeitbereichs (AppNote 0010, Dauerläufer): ein **neuer Flow** (eigene Source), dessen Segmente auf
//! **dieselben Objects** zeigen wie der Quell-Flow. Es werden keine Mediendaten bewegt; der Speicherbedarf bleibt gleich,
//! die Objects werden vom Dienst referenzgezählt und erst nach dem letzten Verweis gelöscht.
//!
//! Der Bereich wird auf **ganze Segmente** erweitert (ein Segment ist die kleinste Einheit, auf die ein Flow verweisen
//! kann, ohne die Zeitangaben des Objects umzudeuten); der tatsächlich kopierte Bereich steht im Ergebnis.

use crate::client::{Client, Error, Registered, SegmentQuery};
use crate::time::{Bound, TimeRange, Timestamp};
use crate::types::SegmentPost;

/// Felder, die der Dienst selbst führt: nie in den neuen Flow übernehmen.
const SERVER_FIELDS: &[&str] = &["created", "metadata_updated", "created_by", "modified_by", "updated", "metadata_version", "timerange", "segments_updated", "generation", "read_only"];
const BATCH: usize = 100;
const MAX_SEGMENTS: usize = 50_000;

#[derive(Debug, Clone, PartialEq)]
pub struct CopyReport {
    pub flow_id: String,
    pub source_id: String,
    pub segments: usize,
    /// Tatsächlich kopierter Bereich (Anfang des ersten bis Ende des letzten Segments), ns.
    pub from_ns: i128,
    pub to_ns: i128,
}

#[derive(Debug)]
pub enum CopyError {
    Client(Error),
    /// Im Bereich liegt kein Segment.
    Empty,
    /// Der Dienst hat einzelne Segmente abgelehnt (Rest ist angelegt).
    Partial(String),
}
impl std::fmt::Display for CopyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CopyError::Client(e) => write!(f, "{e}"),
            CopyError::Empty => write!(f, "im Zeitbereich liegt keine Aufnahme"),
            CopyError::Partial(s) => write!(f, "Segmente abgelehnt: {s}"),
        }
    }
}
impl From<Error> for CopyError {
    fn from(e: Error) -> Self {
        CopyError::Client(e)
    }
}

/// Beschreibung des neuen Flows aus der des Quell-Flows (rein, testbar).
pub fn derive_flow(src: &serde_json::Value, new_flow_id: &str, new_source_id: &str, label: Option<&str>) -> serde_json::Value {
    let mut v = src.clone();
    if let Some(o) = v.as_object_mut() {
        for k in SERVER_FIELDS {
            o.remove(*k);
        }
        o.insert("id".into(), new_flow_id.into());
        o.insert("source_id".into(), new_source_id.into());
        if let Some(l) = label {
            o.insert("label".into(), l.into());
        }
    }
    v
}

/// Kopiert `range` des Flows `src_flow` in den neuen Flow `new_flow_id`.
pub fn copy_range(client: &Client, src_flow: &str, new_flow_id: &str, new_source_id: &str, label: Option<&str>, range: TimeRange) -> Result<CopyReport, CopyError> {
    let src = client.get_flow(src_flow)?;
    let segs = client.list_segments(src_flow, &SegmentQuery { timerange: Some(range), accept_get_urls: Some(vec![]), ..Default::default() }, MAX_SEGMENTS)?;
    if segs.is_empty() {
        return Err(CopyError::Empty);
    }
    client.put_flow(new_flow_id, &derive_flow(&src, new_flow_id, new_source_id, label))?;
    let (mut from, mut to) = (i128::MAX, i128::MIN);
    let mut posts = Vec::with_capacity(segs.len());
    for s in &segs {
        if let Ok(TimeRange::Range { start: Some(a), end: Some(b) }) = TimeRange::parse(&s.timerange) {
            from = from.min(a.ts.ns());
            to = to.max(b.ts.ns());
        }
        posts.push(SegmentPost {
            object_id: s.object_id.clone(),
            timerange: s.timerange.clone(),
            ts_offset: s.ts_offset.clone(),
            object_timerange: s.object_timerange.clone(),
            last_duration: s.last_duration.clone(),
            sample_offset: s.sample_offset,
            sample_count: s.sample_count,
            key_frame_count: s.key_frame_count,
            init_object_id: s.init_object_id.clone(),
        });
    }
    for chunk in posts.chunks(BATCH) {
        if let Registered::Partial(f) = client.register_segments(new_flow_id, chunk)? {
            return Err(CopyError::Partial(format!("{f:?}")));
        }
    }
    Ok(CopyReport { flow_id: new_flow_id.to_string(), source_id: new_source_id.to_string(), segments: posts.len(), from_ns: from, to_ns: to })
}

/// `[start_end)` aus Nanosekunden.
pub fn range_ns(start: i128, end: i128) -> TimeRange {
    TimeRange::new(Some(Bound { ts: Timestamp::from_ns(start), inclusive: true }), Some(Bound { ts: Timestamp::from_ns(end), inclusive: false }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derived_flow_drops_server_fields_and_gets_new_identity() {
        let src = serde_json::json!({"id":"a","source_id":"s","format":"urn:x-nmos:format:video","codec":"video/h264","container":"video/mp2t","created":"x","metadata_updated":"y","read_only":true,"label":"Alt","essence_parameters":{"frame_width":320}});
        let d = derive_flow(&src, "b", "t", Some("Sendung 1"));
        assert_eq!(d["id"], "b");
        assert_eq!(d["source_id"], "t");
        assert_eq!(d["label"], "Sendung 1");
        assert_eq!(d["container"], "video/mp2t");
        assert_eq!(d["essence_parameters"]["frame_width"], 320);
        for k in ["created", "metadata_updated", "read_only"] {
            assert!(d.get(k).is_none(), "{k}");
        }
        let d2 = derive_flow(&src, "b", "t", None);
        assert_eq!(d2["label"], "Alt");
    }
}
