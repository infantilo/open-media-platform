//! Zeitcode am Programmausgang (ST 12-2, ATC_LTC) als MXL-Daten-Flow je Mischer-Ebene, ein Grain je Bildperiode. Der Zeitcode ist
//! der des Eingangs, der gerade auf Programm liegt: Quellen mit Zeitcode-Ausgang (z. B. der Kanal-Player, Label „… Zeitcode (ANC)“
//! am selben Gerät) werden von der Erkennung gefunden und gelesen; liegt eine Quelle ohne Zeitcode (Testbild, Standbild, Freeze)
//! auf Programm, bleibt der Grain leer — ein falscher Zeitcode wäre schlimmer als keiner.
//! Der Zeitcode wandert also mit dem Bild durch den Mischer (Schnitt, Überblendung folgen dem Programm-Eingang). Die Laufzeit des
//! Mischers (Bild kommt später am Ausgang an als der Zeitcode der Quelle) gleicht `OMP_TC_SHIFT_FRAMES` aus; der Wert ist gemessen
//! (`tools/tc-offset`), nicht geschätzt.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};

use omp_mediaio::anc;
use omp_mediaio::mxl::{MxlContext, MxlDataOutput, TimecodeInput};


/// Zeitcode-Eingänge der Quellen (Schlüssel: Sender-ID des Video-Senders).
pub struct SourceTimecodes {
    context: Arc<MxlContext>,
    inputs: Mutex<HashMap<String, (String, Arc<TimecodeInput>)>>,
    /// Je Quelle: (PTS des Eingangsbildes in der Mischer-Pipeline, Grain-Index des Ursprungs) der letzten Bilder.
    origins: Mutex<HashMap<String, VecDeque<(u64, u64)>>>,
    outputs: Mutex<Vec<(Arc<MxlDataOutput>, Arc<Mutex<Option<String>>>)>>,
}

static BRIDGE: OnceLock<Arc<SourceTimecodes>> = OnceLock::new();

/// Die Brücke des Prozesses (gesetzt von `main`), von der Pipeline für Eingangs-Probe und Ausgangs-Hook gebraucht.
pub fn bridge() -> Option<Arc<SourceTimecodes>> {
    BRIDGE.get().cloned()
}

pub fn install(b: Arc<SourceTimecodes>) {
    let _ = BRIDGE.set(b);
}

impl SourceTimecodes {
    pub fn new(context: Arc<MxlContext>) -> Self {
        SourceTimecodes { context, inputs: Mutex::new(HashMap::new()), origins: Mutex::new(HashMap::new()), outputs: Mutex::new(Vec::new()) }
    }

    /// Gleicht die Verbindungen mit der Erkennung ab: `wanted` = Video-Sender-ID → Flow-ID des Zeitcode-Senders.
    pub fn sync(&self, wanted: &HashMap<String, String>) {
        let mut inputs = self.inputs.lock().expect("lock poisoned");
        inputs.retain(|sender, (flow, _)| wanted.get(sender) == Some(flow));
        for (sender, flow) in wanted {
            if inputs.contains_key(sender) {
                continue;
            }
            let input = Arc::new(TimecodeInput::new());
            match input.connect(self.context.clone(), flow) {
                Ok(()) => {
                    inputs.insert(sender.clone(), (flow.clone(), input));
                }
                Err(e) => eprintln!("omp-video-mixer-me: Zeitcode-Eingang {flow}: {e}"),
            }
        }
    }

    /// Eingangsbild von `sender` mit PTS `pts` stammt aus Grain `origin` der Quelle.
    pub fn note_input(&self, sender: &str, pts: u64, origin: u64) {
        let mut o = self.origins.lock().expect("lock poisoned");
        let q = o.entry(sender.to_string()).or_default();
        q.push_back((pts, origin));
        while q.len() > 48 {
            q.pop_front();
        }
    }

    pub fn add_output(&self, out: Arc<MxlDataOutput>, program: Arc<Mutex<Option<String>>>) -> usize {
        let mut o = self.outputs.lock().expect("lock poisoned");
        o.push((out, program));
        o.len() - 1
    }

    /// Zeitcode des Bildes, das die Ebene mit PTS `pts` ausgibt: das neueste Eingangsbild des Programm-Eingangs mit PTS ≤ `pts`
    /// (so wählt der Compositor), dessen Ursprungs-Grain im Zeitcode-Flow der Quelle nachgeschlagen wird.
    fn for_frame(&self, sender: &str, pts: u64) -> Option<anc::AtcInfo> {
        let origin = self.origins.lock().expect("lock poisoned").get(sender)?.iter().rev().find(|(p, _)| *p <= pts).map(|(_, o)| *o)?;
        self.inputs.lock().expect("lock poisoned").get(sender)?.1.at_index(origin)
    }

    /// Video-Schreiber-Hook der Ebene `level`: Zeitcode des soeben geschriebenen Bildes auf denselben Grain-Index.
    pub fn on_frame(&self, level: usize, index: u64, pts: Option<gstreamer::ClockTime>) {
        let outputs = self.outputs.lock().expect("lock poisoned");
        let Some((out, program)) = outputs.get(level) else { return };
        let sender = program.lock().expect("lock poisoned").clone();
        let tc = sender.and_then(|s| match pts {
            Some(p) => self.for_frame(&s, p.nseconds()).or_else(|| self.latest(&s)),
            None => self.latest(&s),
        });
        if let Ok(p) = payload(tc.as_ref()) {
            let _ = out.write_grain(index, &p);
        }
    }

    fn latest(&self, sender: &str) -> Option<anc::AtcInfo> {
        self.inputs.lock().expect("lock poisoned").get(sender)?.1.latest()
    }
}

/// Grain-Nutzlast zum Zeitcode (`None` = leer).
pub fn payload(tc: Option<&anc::AtcInfo>) -> Result<Vec<u8>, String> {
    match tc {
        Some(a) => anc::mxl_grain(&[anc::atc_packet(&a.timecode, a.valid)]),
        None => anc::mxl_grain(&[]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_carries_the_timecode_and_is_empty_without() {
        let tc = anc::Timecode::from_frame_number(25 * 90 + 4, 25, 1, false);
        let g = payload(Some(&anc::AtcInfo { timecode: tc, payload_type: 0, valid: true })).unwrap();
        assert_eq!(anc::parse_atc_grain(&g).unwrap().timecode.display(), "00:01:30:04");
        assert!(anc::parse_atc_grain(&payload(None).unwrap()).is_none());
    }
}
