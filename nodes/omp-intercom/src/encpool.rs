//! Gemeinsame Opus-Encoder (Kapitel 47.11): Teilnehmer, die **dasselbe** Hörsignal bekommen (typisch: alle Zuhörer
//! einer Partyline), teilen sich einen Encoder; die fertigen Opus-Pakete gehen an alle Peers der Gruppe. Das senkt die
//! Kodier-CPU im Normalfall von „je Zuhörer“ auf „je verschiedenem Hörsignal“.
//!
//! Gleichheit ist exakt (Bit für Bit), nie ein Näherungsvergleich — ein Teilnehmer bekommt nie ein fremdes Signal.
//! Die Zuordnung ist klebrig: bleibt ein Teilnehmer im selben Signalverbund, behält er seinen Encoder (der Browser-
//! Decoder sieht einen durchgehenden Strom); nur beim Wechsel des Verbunds springt er auf einen anderen Encoder.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;

use crate::mix::{FRAME, Out, PartyId};
use crate::peer::Peer;

/// Gruppiert Teilnehmer mit exakt gleichem Hörsignal. Reihenfolge: nach kleinster Teilnehmer-ID der Gruppe.
pub fn group_equal(outs: &BTreeMap<PartyId, &Out>) -> Vec<Vec<PartyId>> {
    let mut buckets: HashMap<u64, Vec<Vec<PartyId>>> = HashMap::new();
    for (id, out) in outs {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        for v in out.left.iter().chain(out.right.iter()) {
            v.to_bits().hash(&mut h);
        }
        let groups = buckets.entry(h.finish()).or_default();
        // Hash-Kollisionen ausschließen: gegen das erste Mitglied exakt vergleichen.
        match groups.iter_mut().find(|g| {
            let first = outs[&g[0]];
            first.left == out.left && first.right == out.right
        }) {
            Some(g) => g.push(*id),
            None => groups.push(vec![*id]),
        }
    }
    let mut all: Vec<Vec<PartyId>> = buckets.into_values().flatten().collect();
    all.sort_by_key(|g| g[0]);
    all
}

/// Wählt je Gruppe einen Encoder: bevorzugt den, den die meisten Mitglieder schon nutzen (und der nicht schon an eine
/// frühere Gruppe vergeben ist); sonst `None` (Aufrufer legt einen neuen oder freien an).
pub fn pick_sticky(groups: &[Vec<PartyId>], current: &BTreeMap<PartyId, u32>) -> Vec<Option<u32>> {
    let mut taken: BTreeSet<u32> = BTreeSet::new();
    let mut out = Vec::new();
    for g in groups {
        let mut votes: BTreeMap<u32, usize> = BTreeMap::new();
        for p in g {
            if let Some(e) = current.get(p) {
                *votes.entry(*e).or_default() += 1;
            }
        }
        let best = votes.into_iter().filter(|(e, _)| !taken.contains(e)).max_by_key(|(e, n)| (*n, std::cmp::Reverse(*e))).map(|(e, _)| e);
        if let Some(e) = best {
            taken.insert(e);
        }
        out.push(best);
    }
    out
}

struct Encoder {
    appsrc: gst_app::AppSrc,
    pipeline: gst::Pipeline,
    members: Arc<Mutex<Vec<Arc<Peer>>>>,
    clock: u64,
    last_used: Instant,
}

impl Drop for Encoder {
    fn drop(&mut self) {
        let pipeline = self.pipeline.clone();
        std::thread::spawn(move || {
            let _ = pipeline.set_state(gst::State::Null);
        });
    }
}

#[derive(Default)]
pub struct EncoderPool {
    encoders: BTreeMap<u32, Encoder>,
    next_id: u32,
    assigned: BTreeMap<PartyId, u32>,
}

fn build_encoder() -> Result<Encoder, String> {
    let caps = gst::Caps::builder("audio/x-raw")
        .field("format", "F32LE")
        .field("layout", "interleaved")
        .field("rate", 48_000i32)
        .field("channels", 2i32)
        .field("channel-mask", gst::Bitmask::new(0x3))
        .build();
    let pipeline = gst::Pipeline::new();
    let appsrc = gst_app::AppSrc::builder().caps(&caps).format(gst::Format::Time).is_live(true).do_timestamp(false).max_bytes((FRAME * 8 * 6) as u64).build();
    appsrc.set_property_from_str("leaky-type", "downstream");
    let conv = gst::ElementFactory::make("audioconvert").build().map_err(|e| e.to_string())?;
    // opusenc (GStreamer 1.22) nimmt nur S16LE: Wandlung hier, der Mix-Kern bleibt Float.
    let enc = gst::ElementFactory::make("opusenc").build().map_err(|e| e.to_string())?;
    enc.set_property("bitrate", 48_000i32);
    enc.set_property("complexity", 4i32);
    enc.set_property_from_str("frame-size", "20");
    enc.set_property_from_str("audio-type", "voice");
    enc.set_property("inband-fec", true);
    enc.set_property("packet-loss-percentage", 5i32);
    let sink = gst_app::AppSink::builder().sync(false).max_buffers(8).drop(true).build();
    pipeline.add_many([appsrc.upcast_ref::<gst::Element>(), &conv, &enc, sink.upcast_ref::<gst::Element>()]).map_err(|e| e.to_string())?;
    gst::Element::link_many([appsrc.upcast_ref::<gst::Element>(), &conv, &enc, sink.upcast_ref::<gst::Element>()]).map_err(|e| format!("link: {e}"))?;
    let members: Arc<Mutex<Vec<Arc<Peer>>>> = Arc::new(Mutex::new(Vec::new()));
    let cb_members = members.clone();
    sink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |s| {
                let sample = s.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                if let Some(buf) = sample.buffer() {
                    for peer in cb_members.lock().expect("lock poisoned").iter() {
                        peer.push_encoded(buf);
                    }
                }
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );
    pipeline.set_state(gst::State::Playing).map_err(|e| format!("Playing: {e}"))?;
    Ok(Encoder { appsrc, pipeline, members, clock: 0, last_used: Instant::now() })
}

impl EncoderPool {
    pub fn count(&self) -> usize {
        self.encoders.len()
    }

    /// Kodiert die Hörsignale der Teilnehmer in `outs` (nur die mit offener, nicht stiller Verbindung) und verteilt die Pakete.
    pub fn feed(&mut self, outs: &BTreeMap<PartyId, &Out>, peers: &BTreeMap<PartyId, Arc<Peer>>) {
        let groups = group_equal(outs);
        let picks = pick_sticky(&groups, &self.assigned);
        let mut used: BTreeSet<u32> = picks.iter().flatten().copied().collect();
        let mut new_assign: BTreeMap<PartyId, u32> = BTreeMap::new();
        let mut live: BTreeSet<u32> = BTreeSet::new();
        for (group, pick) in groups.iter().zip(picks) {
            let id = match pick.filter(|e| self.encoders.contains_key(e)) {
                Some(e) => e,
                None => {
                    // Freien (derzeit unbenutzten) Encoder nehmen, sonst neuen anlegen.
                    let free = self.encoders.keys().copied().find(|e| !used.contains(e) && !live.contains(e));
                    match free {
                        Some(e) => e,
                        None => match build_encoder() {
                            Ok(enc) => {
                                self.next_id += 1;
                                self.encoders.insert(self.next_id, enc);
                                self.next_id
                            }
                            Err(e) => {
                                eprintln!("omp-intercom: Encoder nicht anlegbar: {e}");
                                continue;
                            }
                        },
                    }
                }
            };
            used.insert(id);
            live.insert(id);
            let enc = self.encoders.get_mut(&id).expect("Encoder vorhanden");
            let members: Vec<Arc<Peer>> = group.iter().filter_map(|p| peers.get(p).cloned()).collect();
            *enc.members.lock().expect("lock poisoned") = members;
            enc.last_used = Instant::now();
            for p in group {
                new_assign.insert(*p, id);
            }
            let out = outs[&group[0]];
            let mut bytes = Vec::with_capacity(FRAME * 8);
            for i in 0..FRAME {
                bytes.extend_from_slice(&out.left[i].to_le_bytes());
                bytes.extend_from_slice(&out.right[i].to_le_bytes());
            }
            let mut buffer = gst::Buffer::from_slice(bytes);
            {
                let b = buffer.get_mut().expect("neuer Puffer");
                b.set_pts(gst::ClockTime::from_nseconds(enc.clock * 20_000_000));
                b.set_duration(gst::ClockTime::from_nseconds(20_000_000));
            }
            enc.clock += 1;
            let _ = enc.appsrc.push_buffer(buffer);
        }
        // Nicht benutzte Encoder: Mitglieder leeren; lange unbenutzte abbauen.
        for (id, enc) in self.encoders.iter() {
            if !live.contains(id) {
                enc.members.lock().expect("lock poisoned").clear();
            }
        }
        self.encoders.retain(|id, e| live.contains(id) || e.last_used.elapsed() < Duration::from_secs(10));
        self.assigned = new_assign;
    }

    /// Ein Teilnehmer hat keine Verbindung mehr / ist still: Zuordnung vergessen.
    pub fn forget(&mut self, id: PartyId) {
        self.assigned.remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(v: f32) -> Out {
        Out { left: vec![v; FRAME], right: vec![v; FRAME] }
    }

    #[test]
    fn identical_signals_share_a_group_and_differing_ones_do_not() {
        let (a, b, c, d) = (out(0.1), out(0.1), out(0.2), out(0.1));
        let mut m = BTreeMap::new();
        m.insert(1, &a);
        m.insert(2, &c);
        m.insert(3, &b);
        m.insert(4, &d);
        assert_eq!(group_equal(&m), vec![vec![1, 3, 4], vec![2]]);
    }

    #[test]
    fn left_right_difference_splits_groups_even_if_sums_match() {
        let mut x = out(0.1);
        let y = out(0.1);
        x.right[500] = 0.1000001;
        let mut m = BTreeMap::new();
        m.insert(1, &x);
        m.insert(2, &y);
        assert_eq!(group_equal(&m).len(), 2);
    }

    #[test]
    fn sticky_pick_prefers_majority_and_never_reuses_an_encoder_twice() {
        let groups = vec![vec![1, 2, 3], vec![4, 5]];
        let current: BTreeMap<PartyId, u32> = [(1, 7), (2, 7), (3, 8), (4, 7), (5, 9)].into_iter().collect();
        // Gruppe 1: Mehrheit Encoder 7; Gruppe 2 hätte 7 (Teilnehmer 4) oder 9 (Teilnehmer 5) → 7 ist vergeben → 9.
        assert_eq!(pick_sticky(&groups, &current), vec![Some(7), Some(9)]);
        assert_eq!(pick_sticky(&[vec![1]], &BTreeMap::new()), vec![None]);
    }

    #[test]
    fn sticky_pick_is_stable_when_groups_are_unchanged() {
        let groups = vec![vec![1, 2], vec![3]];
        let current: BTreeMap<PartyId, u32> = [(1, 5), (2, 5), (3, 6)].into_iter().collect();
        assert_eq!(pick_sticky(&groups, &current), vec![Some(5), Some(6)]);
    }
}
