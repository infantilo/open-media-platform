//! Kapitel 37 (`UMSETZUNG.md`): Werbeblöcke aus der Klassifikation der Playlist-Items (`adClass`)
//! erkennen und daraus SCTE-35/-104-Marker planen — REINE Logik (keine Uhr, kein Netz, kein State),
//! damit sie isoliert testbar bleibt. Die Kodierung und Ausgabe macht `omp-scte35`; die Ausführung
//! der hier erzeugten synthetischen Child Events (`SCTE35`, `auto: true`) liegt in `main.rs`.
//!
//! Regeln (`ARCHITECTURE.md` §29.2):
//! - `block_start` eröffnet einen Block (ein offener Block davor endet davor), `block_end` schließt ihn
//!   (inklusive); `commercial`/`promo` eröffnen einen Block, wenn keiner offen ist; ein Item ohne Klasse
//!   beendet einen offenen Block (exklusive). Ein `block_end` ohne offenen Block wird ignoriert.
//! - Blockdauer = Summe der Item-Dauern; ist eine Dauer 0 (Live/unbekannt), gibt es keine Dauer.
//! - Das Out sendet der **Vorgänger** des Blocks `preRoll` vor seinem Ende, das In das letzte Block-Item
//!   `preRoll` vor seinem Ende. Ohne Vorgänger (oder ohne feste Dauer des Vorgängers) kommt das Out mit
//!   dem ersten Block-Item sofort. Wird ein offener Block verlassen, schließt das nächste Item ihn.

use serde_json::{json, Value};

use crate::children::ChildEvent;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    pub enabled: bool,
    /// Label des `omp-scte35`-Nodes.
    pub target: String,
    /// Vorlauf in Millisekunden, mit dem Out/In vor dem Schnitt gesendet werden.
    pub pre_roll_ms: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { enabled: false, target: String::new(), pre_roll_ms: 4000 }
    }
}

impl Settings {
    pub fn active(&self) -> bool {
        self.enabled && !self.target.trim().is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub id: String,
    /// `adClass` (leer = keine).
    pub class: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    /// ID des ersten Items — Schlüssel für Event-Zuordnung.
    pub key: String,
    pub first: usize,
    pub last: usize,
    /// `None`, wenn mindestens ein Item keine feste Dauer hat.
    pub duration_ms: Option<u64>,
}

fn is_ad(class: &str) -> bool {
    matches!(class, "commercial" | "promo")
}

/// Alle Werbeblöcke der Playlist in Reihenfolge.
pub fn blocks(items: &[Item]) -> Vec<Block> {
    let mut out = Vec::new();
    let mut open: Option<usize> = None;
    let close = |out: &mut Vec<Block>, first: usize, last: usize| {
        let slice = &items[first..=last];
        let duration_ms = if slice.iter().all(|i| i.duration_ms > 0) { Some(slice.iter().map(|i| i.duration_ms).sum()) } else { None };
        out.push(Block { key: items[first].id.clone(), first, last, duration_ms });
    };
    for (i, it) in items.iter().enumerate() {
        let c = it.class.as_str();
        match (open, c) {
            (None, "block_start") => open = Some(i),
            (None, c) if is_ad(c) => open = Some(i),
            (None, _) => {}
            (Some(f), "block_start") => {
                close(&mut out, f, i - 1);
                open = Some(i);
            }
            (Some(f), "block_end") => {
                close(&mut out, f, i);
                open = None;
            }
            (Some(f), "") => {
                close(&mut out, f, i - 1);
                open = None;
            }
            (Some(_), _) => {}
        }
    }
    if let Some(f) = open {
        close(&mut out, f, items.len() - 1);
    }
    out
}

fn scte_child(id: &str, target: &str, timing: &str, delay_ms: u64, params: Value) -> Option<ChildEvent> {
    serde_json::from_value(json!({
        "id": id, "type": "SCTE35", "target": target, "timing": timing, "delayMs": delay_ms,
        "params": params, "failurePolicy": "RETRY", "retryCount": 2, "retryDelayMs": 500,
    }))
    .ok()
}

/// Synthetische Marker-Kinder für das Item `idx`, das gerade auf Sendung geht.
/// `open`: Schlüssel der Blöcke, deren Out schon gesendet wurde und deren In noch aussteht.
/// `item_duration_ms`: Dauer des Items `idx`. `onair_utc_ms`: Beginn des Items (für den absoluten Schnittzeitpunkt).
pub fn children_for(items: &[Item], idx: usize, open: &[String], s: &Settings, onair_utc_ms: i64) -> Vec<ChildEvent> {
    let mut out = Vec::new();
    if !s.active() || idx >= items.len() {
        return out;
    }
    let all = blocks(items);
    let here = all.iter().find(|b| b.first <= idx && idx <= b.last);
    let dur = items[idx].duration_ms;
    let t = s.target.as_str();

    // 1. Ein offener Block, in dem dieses Item nicht liegt, wird sofort geschlossen (Abbruch, Skip, Stop).
    for key in open {
        if here.is_none_or(|b| &b.key != key) {
            out.extend(scte_child(&format!("ad-close-{key}"), t, "RELATIVE_TO_START", 0, json!({"action": "close", "blockKey": key, "auto": true, "returnAtStop": false})));
        }
    }
    // 2. Erstes Item eines Blocks: Out sofort, falls der Vorgänger es nicht schon gesendet hat.
    if let Some(b) = here.filter(|b| b.first == idx) {
        let mut p = json!({"action": "out", "blockKey": b.key, "autoReturn": true, "onlyIfClosed": true, "auto": true, "returnAtStop": false});
        if let Some(d) = b.duration_ms {
            p["durationMs"] = json!(d);
        }
        out.extend(scte_child(&format!("ad-out-{}", b.key), t, "RELATIVE_TO_START", 0, p));
    }
    // 3. Vorgänger eines Blocks: Out `preRoll` vor dem eigenen Ende (nur mit fester Dauer).
    if dur > 0
        && let Some(next) = all.iter().find(|b| b.first == idx + 1 && here.is_none_or(|h| h.key != b.key))
    {
        let delay = s.pre_roll_ms.min(dur);
        let mut p = json!({"action": "out", "blockKey": next.key, "autoReturn": true, "auto": true, "returnAtStop": false, "cutAtUtcMs": onair_utc_ms + dur as i64});
        if let Some(d) = next.duration_ms {
            p["durationMs"] = json!(d);
        }
        out.extend(scte_child(&format!("ad-pre-{}", next.key), t, "RELATIVE_TO_END", delay, p));
    }
    // 4. Letztes Item eines Blocks: In `preRoll` vor dem Ende (nur mit fester Dauer).
    if let Some(b) = here.filter(|b| b.last == idx)
        && dur > 0
    {
        let delay = s.pre_roll_ms.min(dur);
        out.extend(scte_child(
            &format!("ad-in-{}", b.key),
            t,
            "RELATIVE_TO_END",
            delay,
            json!({"action": "in", "blockKey": b.key, "auto": true, "returnAtStop": false, "cutAtUtcMs": onair_utc_ms + dur as i64}),
        ));
    }
    out
}

/// Vorlauf in Millisekunden bis zum Schnitt (`cutAtUtcMs`), nie negativ; ohne Zeitpunkt der feste `leadMs`.
pub fn lead_ms(params: &Value, now_utc_ms: i64) -> u64 {
    match params.get("cutAtUtcMs").and_then(Value::as_i64) {
        Some(cut) => (cut - now_utc_ms).max(0) as u64,
        None => params.get("leadMs").and_then(Value::as_u64).unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn it(id: &str, class: &str, dur: u64) -> Item {
        Item { id: id.to_string(), class: class.to_string(), duration_ms: dur }
    }

    fn on() -> Settings {
        Settings { enabled: true, target: "SCTE-35".to_string(), pre_roll_ms: 4000 }
    }

    fn ids(c: &[ChildEvent]) -> Vec<&str> {
        c.iter().map(|c| c.id.as_str()).collect()
    }

    #[test]
    fn spots_in_a_row_form_one_block_with_the_summed_duration() {
        let items = [it("show", "", 60_000), it("s1", "commercial", 10_000), it("s2", "commercial", 20_000), it("p1", "promo", 5_000), it("show2", "", 60_000)];
        let b = blocks(&items);
        assert_eq!(b, vec![Block { key: "s1".into(), first: 1, last: 3, duration_ms: Some(35_000) }]);
    }

    #[test]
    fn explicit_start_and_end_frame_the_block_and_unclassified_items_inside_are_members() {
        let items = [it("a", "block_start", 1000), it("b", "", 2000), it("c", "block_end", 3000), it("d", "", 1000)];
        // ein Item ohne Klasse beendet den Block — auch ein explizit eröffneter
        assert_eq!(blocks(&items), vec![Block { key: "a".into(), first: 0, last: 0, duration_ms: Some(1000) }]);
        let items = [it("a", "block_start", 1000), it("b", "commercial", 2000), it("c", "block_end", 3000), it("d", "", 1000)];
        assert_eq!(blocks(&items), vec![Block { key: "a".into(), first: 0, last: 2, duration_ms: Some(6000) }]);
    }

    #[test]
    fn a_new_start_closes_the_previous_block_and_a_stray_end_is_ignored() {
        let items = [it("end", "block_end", 1000), it("a", "block_start", 1000), it("b", "block_start", 1000), it("c", "commercial", 1000)];
        let b = blocks(&items);
        assert_eq!(b.len(), 2);
        assert_eq!((b[0].key.as_str(), b[0].first, b[0].last), ("a", 1, 1));
        assert_eq!((b[1].key.as_str(), b[1].first, b[1].last), ("b", 2, 3));
    }

    #[test]
    fn an_unknown_duration_makes_the_block_open_ended() {
        let items = [it("a", "commercial", 1000), it("live", "commercial", 0)];
        assert_eq!(blocks(&items)[0].duration_ms, None);
    }

    #[test]
    fn a_block_at_the_end_of_the_list_is_closed() {
        let items = [it("x", "", 1000), it("a", "commercial", 1000)];
        assert_eq!(blocks(&items).len(), 1);
    }

    #[test]
    fn disabled_or_unaddressed_produces_nothing() {
        let items = [it("x", "", 10_000), it("a", "commercial", 1000)];
        assert!(children_for(&items, 0, &[], &Settings::default(), 0).is_empty());
        assert!(children_for(&items, 0, &[], &Settings { enabled: true, ..Settings::default() }, 0).is_empty());
    }

    #[test]
    fn the_predecessor_announces_the_block_pre_roll_before_its_end() {
        let items = [it("show", "", 60_000), it("s1", "commercial", 10_000), it("s2", "commercial", 20_000), it("show2", "", 60_000)];
        let c = children_for(&items, 0, &[], &on(), 1_000_000);
        assert_eq!(ids(&c), vec!["ad-pre-s1"]);
        assert_eq!(c[0].delay_ms, 4000);
        assert_eq!(c[0].params["blockKey"], "s1");
        assert_eq!(c[0].params["durationMs"], 30_000);
        assert_eq!(c[0].params["cutAtUtcMs"], 1_060_000);
        assert_eq!(c[0].params["returnAtStop"], false);
        assert!(c[0].validate().is_ok());
    }

    #[test]
    fn the_first_block_item_has_an_immediate_fallback_out_and_the_last_a_timed_in() {
        let items = [it("show", "", 60_000), it("s1", "commercial", 10_000), it("s2", "commercial", 20_000), it("show2", "", 60_000)];
        let first = children_for(&items, 1, &[], &on(), 0);
        assert_eq!(ids(&first), vec!["ad-out-s1"]);
        assert_eq!(first[0].params["onlyIfClosed"], true);
        let last = children_for(&items, 2, &[], &on(), 500);
        assert_eq!(ids(&last), vec!["ad-in-s1"]);
        assert_eq!((last[0].delay_ms, last[0].params["cutAtUtcMs"].as_i64()), (4000, Some(20_500)));
    }

    #[test]
    fn a_single_item_block_gets_out_and_in() {
        let items = [it("a", "commercial", 8000)];
        assert_eq!(ids(&children_for(&items, 0, &[], &on(), 0)), vec!["ad-out-a", "ad-in-a"]);
        // Vorlauf wird auf die Itemdauer begrenzt
        let c = children_for(&items, 0, &[], &Settings { pre_roll_ms: 20_000, ..on() }, 0);
        assert_eq!(c[1].delay_ms, 8000);
    }

    #[test]
    fn no_timed_in_without_a_fixed_duration_but_the_next_item_closes_the_open_block() {
        let items = [it("a", "commercial", 0), it("x", "", 5000)];
        assert_eq!(ids(&children_for(&items, 0, &[], &on(), 0)), vec!["ad-out-a"]);
        let c = children_for(&items, 1, &["a".to_string()], &on(), 0);
        assert_eq!(ids(&c), vec!["ad-close-a"]);
        assert_eq!(c[0].params["action"], "close");
    }

    #[test]
    fn a_predecessor_without_a_fixed_duration_sends_nothing_ahead() {
        let items = [it("live", "", 0), it("a", "commercial", 5000)];
        assert!(children_for(&items, 0, &[], &on(), 0).is_empty());
    }

    #[test]
    fn two_adjacent_blocks_send_in_and_the_next_out_from_the_same_item() {
        let items = [it("a", "block_start", 5000), it("e", "block_end", 5000), it("b", "block_start", 5000)];
        let c = children_for(&items, 1, &[], &on(), 0);
        assert_eq!(ids(&c), vec!["ad-pre-b", "ad-in-a"]);
    }

    #[test]
    fn items_inside_a_block_do_not_repeat_the_block_start() {
        let items = [it("a", "commercial", 5000), it("b", "commercial", 5000), it("c", "commercial", 5000)];
        assert!(children_for(&items, 1, &["a".to_string()], &on(), 0).is_empty());
    }

    #[test]
    fn lead_is_the_distance_to_the_cut_and_never_negative() {
        assert_eq!(lead_ms(&json!({"cutAtUtcMs": 10_000}), 6_000), 4000);
        assert_eq!(lead_ms(&json!({"cutAtUtcMs": 10_000}), 11_000), 0);
        assert_eq!(lead_ms(&json!({"leadMs": 1500}), 0), 1500);
        assert_eq!(lead_ms(&json!({}), 0), 0);
    }
}
