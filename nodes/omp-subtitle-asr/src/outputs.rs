//! Bildgenaue Ausgänge des Untertitel-Nodes als MXL-Daten-Flows (`video/smpte291`): ein Grain je Bildperiode.
//!
//! * **Text-Strom** (privates Paket, `omp_mediaio::anc::text_packet`): trägt in jedem Grain den aktuell anzuzeigenden Text
//!   (leerer Grain = nichts). Viewer und Multiviewer lesen ihn über ihren Aux-Eingang.
//! * **CEA-608-Strom** (CDP, DID 0x61/SDID 0x01): Untertitel als Datenspur für Gateways, die ANC einbetten können.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, TryRecvError};
use std::sync::Arc;

use omp_mediaio::anc::{self, AncPacket};
use omp_mediaio::mxl::MxlDataOutput;

use crate::caption::{self, CaptionEncoder};
use crate::output;
use crate::playout::Playout;

/// VANC-Zeile der Pakete (frei wählbar, bei SCTE 104 ebenfalls 9).
const LINE: u16 = 9;

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// Gemeinsame Schleife: je Bild Text abholen, Wechsel ableiten, Grain schreiben.
fn frame_loop(
    out: MxlDataOutput,
    rx: Receiver<String>,
    width: usize,
    shutdown: Arc<AtomicBool>,
    heartbeat: Arc<AtomicU64>,
    frames: Arc<AtomicU64>,
    mut on_change: impl FnMut(Option<&str>),
    mut payload: impl FnMut() -> Result<Vec<u8>, String>,
) {
    let mut playout = Playout::default();
    let mut index = out.index_after_ns(0) + 1;
    while !shutdown.load(Ordering::Relaxed) {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        loop {
            match rx.try_recv() {
                Ok(text) => playout.push(output::cues_for_width(&text, now_ms(), width)),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }
        if let Some(change) = playout.tick(now_ms()) {
            on_change(change.as_deref());
        }
        match payload() {
            Ok(p) => {
                if out.write_grain(index, &p).is_ok() {
                    frames.fetch_add(1, Ordering::Relaxed);
                }
            }
            Err(e) => eprintln!("omp-subtitle-asr: Grain: {e}"),
        }
        index += 1;
        // Rückstand (z. B. nach langem Stillstand) nicht aufholen, sondern neu aufsetzen
        let head = out.current_index();
        if head > index + 2 {
            index = head + 1;
        }
        out.sleep_until_index(index);
    }
}

/// Text-Strom: in jedem Grain der aktuelle Text.
pub fn spawn_text(out: MxlDataOutput, rx: Receiver<String>, shutdown: Arc<AtomicBool>, heartbeat: Arc<AtomicU64>, frames: Arc<AtomicU64>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let state: std::cell::RefCell<(u16, Option<String>)> = std::cell::RefCell::new((0, None));
        let state_ref = &state;
        // `frame_loop` braucht zwei Rückrufe auf denselben Zustand: über RefCell teilen
        let on_change = move |t: Option<&str>| {
            let mut s = state_ref.borrow_mut();
            s.0 = s.0.wrapping_add(1);
            s.1 = t.map(str::to_string);
        };
        let payload = move || {
            let s = state_ref.borrow();
            match &s.1 {
                Some(t) => anc::mxl_grain(&[anc::text_packet(t, s.0, LINE)]),
                None => anc::mxl_grain(&[]),
            }
        };
        frame_loop(out, rx, output::MAX_LINE, shutdown, heartbeat, frames, on_change, payload);
    })
}

/// CEA-608-Strom: je Bild ein CDP.
pub fn spawn_cea(
    out: MxlDataOutput,
    rate: (u32, u32),
    rx: Receiver<String>,
    shutdown: Arc<AtomicBool>,
    heartbeat: Arc<AtomicU64>,
    frames: Arc<AtomicU64>,
) -> Result<std::thread::JoinHandle<()>, String> {
    let enc = CaptionEncoder::new(rate.0, rate.1)?;
    Ok(std::thread::spawn(move || {
        let enc = std::cell::RefCell::new(enc);
        let enc_ref = &enc;
        let on_change = move |t: Option<&str>| match t {
            Some(text) => enc_ref.borrow_mut().show(text),
            None => enc_ref.borrow_mut().clear(),
        };
        let payload = move || {
            let udw = enc_ref.borrow_mut().next_cdp();
            anc::mxl_grain(&[AncPacket { c_not_y: false, line: LINE, offset: 0, did: caption::DID_CDP, sdid: caption::SDID_CDP, udw }])
        };
        frame_loop(out, rx, caption::LINE_WIDTH, shutdown, heartbeat, frames, on_change, payload);
    }))
}

#[cfg(test)]
mod live_tests {
    use super::*;

    /// Liest den laufenden CEA-608-Flow eines Untertitel-Nodes und prüft die CDPs (manuell:
    /// `OMP_TEST_FLOW=<flow-id> cargo test -p omp-subtitle-asr -- --ignored --nocapture cea_flow`).
    #[test]
    #[ignore = "braucht einen laufenden Untertitel-Node und MXL-Umgebung"]
    fn cea_flow_carries_valid_cdps() {
        let flow = std::env::var("OMP_TEST_FLOW").expect("OMP_TEST_FLOW");
        let ctx = Arc::new(omp_mediaio::mxl::MxlContext::new(&std::env::var("OMP_MXL_DOMAIN").unwrap_or("/dev/shm/omp-mxl".into())).unwrap());
        let seen = Arc::new(std::sync::Mutex::new(Vec::<Vec<u8>>::new()));
        let seen_t = seen.clone();
        let _input = omp_mediaio::mxl::MxlDataInput::new(ctx, &flow, move |g| {
            if let Ok(packets) = anc::parse_mxl_grain(g) {
                for p in packets.into_iter().filter(|p| (p.did, p.sdid) == (caption::DID_CDP, caption::SDID_CDP)) {
                    seen_t.lock().unwrap().push(p.udw);
                }
            }
        })
        .unwrap();
        std::thread::sleep(std::time::Duration::from_secs(14));
        let cdps = seen.lock().unwrap();
        assert!(cdps.len() > 100, "zu wenige CDPs: {}", cdps.len());
        let mut non_null = 0;
        let mut last_seq: Option<u16> = None;
        for c in cdps.iter() {
            assert_eq!(&c[..2], &[0x96, 0x69]);
            assert_eq!(c[2] as usize, c.len());
            assert_eq!(c.iter().map(|b| *b as u32).sum::<u32>() % 256, 0, "Prüfsumme");
            let seq = u16::from_be_bytes([c[5], c[6]]);
            if let Some(l) = last_seq {
                assert_eq!(seq, l.wrapping_add(1), "lückenlose Folge");
            }
            last_seq = Some(seq);
            if (c[10], c[11]) != (0x80, 0x80) {
                non_null += 1;
            }
        }
        eprintln!("{} CDPs, davon {} mit 608-Daten", cdps.len(), non_null);
        assert!(non_null > 0, "keine Untertitel-Daten im Strom");
    }
}

#[cfg(test)]
mod loopback_tests {
    use super::*;
    use omp_mediaio::mxl::{MxlContext, SubtitleInput};
    use std::sync::mpsc::channel;
    use std::time::{Duration, Instant};

    fn libmxl_available() -> bool {
        std::env::var("LD_LIBRARY_PATH").unwrap_or_default().contains("mxl")
    }

    fn wait_for(input: &SubtitleInput, expect: &str) -> bool {
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(8) {
            if input.text().contains(expect) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        false
    }

    /// Text-Strom und CEA-608-Strom des Nodes über echtes MXL in den Untertitel-Eingang (wie bei Viewer und Gebärden-Avatar).
    #[test]
    fn subtitle_input_reads_both_outputs_of_the_node() {
        if !libmxl_available() {
            return;
        }
        let domain = std::env::temp_dir().join(format!("omp-mxl-sub-loop-{}", std::process::id()));
        std::fs::create_dir_all(&domain).unwrap();
        let ctx = Arc::new(MxlContext::new(&domain.to_string_lossy()).unwrap());
        let shutdown = Arc::new(AtomicBool::new(false));
        let rate = (25u32, 1u32);
        for (cea, id) in [(false, "5a1b0000-0000-4000-8000-000000000001"), (true, "5a1b0000-0000-4000-8000-000000000002")] {
            let out = MxlDataOutput::new(ctx.clone(), id, "Test", "Test", rate.0, rate.1).unwrap();
            let (tx, rx) = channel();
            let (hb, fr) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
            let h = if cea { spawn_cea(out, rate, rx, shutdown.clone(), hb, fr).unwrap() } else { spawn_text(out, rx, shutdown.clone(), hb, fr) };
            let input = SubtitleInput::new();
            input.connect(ctx.clone(), id).unwrap();
            std::thread::sleep(Duration::from_millis(300));
            tx.send("Heute regnet es nicht.".to_string()).unwrap();
            assert!(wait_for(&input, "Heute regnet"), "{}: Untertitel-Eingang liefert den Text nicht (text={:?}, flowed={})", if cea { "CEA-608" } else { "Text-Strom" }, input.text(), input.flowed());
            shutdown.store(true, Ordering::Relaxed);
            drop(tx);
            h.join().unwrap();
            shutdown.store(false, Ordering::Relaxed);
        }
        let _ = std::fs::remove_dir_all(&domain);
    }
}
