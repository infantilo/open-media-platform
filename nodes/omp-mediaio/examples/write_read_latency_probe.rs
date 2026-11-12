//! Mess-Sonde „Schreiben→Lesen“ (HAERTUNG-PLAN.md Schritt 98.0): Zeit zwischen
//! Grain-Commit des Schreibers und Aufwachen des blockierenden Lesers.
//!
//! Zwei Betriebsarten:
//!   --self        Eigener Testflow in privater Domain unter /dev/shm (Schreiber-Thread
//!                 und Leser-Thread mit je eigener MXL-Instanz). Berührt keinen Live-Flow.
//!                 Zusätzlich wird der Stempel des Schreibers (vor `commit`) ausgewertet.
//!   <flow-id>     Nur-Leser an einem bestehenden Live-Flow (wie ein weiterer Viewer).
//!
//! Messprinzip: Der Schreiber setzt `lastWriteTime` (TAI) unmittelbar vor `wakeAll`
//! (PosixDiscreteFlowWriter::commit). Der Leser nimmt direkt nach der Rückkehr aus
//! `get_complete_grain` die TAI-Zeit. Differenz = Wecklatenz plus Leseaufwand.
//! Werte größer als eine Bildperiode sind „behind“ (Leser lag zurück oder ein
//! neuerer Commit kam dazwischen) und fließen NICHT in die Perzentile ein, werden
//! aber gezählt und ausgegeben.
//!
//! Aufruf:
//!   cargo run --release -p omp-mediaio --features mxl --example write_read_latency_probe -- --self [sekunden] [fps]
//!   OMP_MXL_DOMAIN=/dev/shm/omp-mxl cargo run --release -p omp-mediaio --features mxl --example write_read_latency_probe -- <flow-id> [sekunden]
//! Ausgabe: eine Zeile `LATENCY ...` (µs) und eine Zeile `PROC ...` (CPU-Ticks, Kontextwechsel).
use std::time::Duration;

fn percentile(v: &mut [f64], p: f64) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() - 1) as f64 * p).round() as usize]
}

/// utime+stime (Ticks) und Kontextwechsel aus /proc/self (nicht aus `ps`).
fn proc_snapshot() -> (u64, u64, u64) {
    let stat = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
    let after = stat.rsplit(')').next().unwrap_or("");
    let f: Vec<&str> = after.split_whitespace().collect();
    // Felder nach ")": state=0 ... utime=11 stime=12
    let ut = f.get(11).and_then(|s| s.parse().ok()).unwrap_or(0);
    let st = f.get(12).and_then(|s| s.parse().ok()).unwrap_or(0);
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let ctx = |key: &str| -> u64 {
        status
            .lines()
            .find(|l| l.starts_with(key))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0)
    };
    (ut + st, ctx("voluntary_ctxt_switches"), ctx("nonvoluntary_ctxt_switches"))
}

struct Result {
    n: usize,
    behind: u64,
    timeouts: u64,
    lat_us: Vec<f64>,
    stamp_us: Vec<f64>,
}

fn reader(domain: &str, flow_id: &str, secs: u64, num: i64, den: i64, self_mode: bool) -> Result {
    let api = mxl::load_api("libmxl.so").expect("load_api");
    let inst = mxl::MxlInstance::new(api, domain, "").expect("MxlInstance");
    let r = inst.create_flow_reader(flow_id).expect("flow_reader");
    let rd = r.to_grain_reader().expect("grain_reader");
    let rate = mxl_sys::Rational { numerator: num, denominator: den };
    let period_us = 1_000_000.0 * den as f64 / num as f64;
    let mut index = inst.get_current_index(&rate) + 1;
    let (mut behind, mut timeouts) = (0u64, 0u64);
    let (mut lat, mut stamp_lat) = (Vec::new(), Vec::new());
    let t0 = std::time::Instant::now();
    while t0.elapsed() < Duration::from_secs(secs) {
        match rd.get_complete_grain(index, Duration::from_millis(200)) {
            Ok(g) => {
                let now = inst.get_time();
                if g.index != index {
                    index = inst.get_current_index(&rate) + 1;
                    behind += 1;
                    continue;
                }
                let lw = rd.get_runtime_info().map(|i| i.lastWriteTime).unwrap_or(0);
                let d = now.saturating_sub(lw) as f64 / 1000.0;
                if lw == 0 || lw > now || d > period_us {
                    behind += 1;
                } else {
                    lat.push(d);
                    if self_mode && g.payload.len() >= 8 {
                        let st = u64::from_le_bytes(g.payload[..8].try_into().unwrap());
                        if st != 0 && st <= now {
                            stamp_lat.push((now - st) as f64 / 1000.0);
                        }
                    }
                }
                index += 1;
            }
            Err(mxl::Error::Timeout) | Err(mxl::Error::OutOfRangeTooEarly) => timeouts += 1,
            Err(mxl::Error::OutOfRangeTooLate) => {
                index = inst.get_current_index(&rate) + 1;
                behind += 1;
            }
            Err(_) => std::thread::sleep(Duration::from_millis(2)),
        }
    }
    Result { n: lat.len(), behind, timeouts, lat_us: lat, stamp_us: stamp_lat }
}

fn report(tag: &str, v: &mut Vec<f64>) {
    println!(
        "LATENCY {tag} n={} us p50={:.1} p95={:.1} p99={:.1} max={:.1}",
        v.len(),
        percentile(v, 0.5),
        percentile(v, 0.95),
        percentile(v, 0.99),
        percentile(v, 1.0)
    );
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let first = args.get(1).cloned().unwrap_or_else(|| "--self".into());
    let self_mode = first == "--self";
    let secs: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(10);
    let before = proc_snapshot();

    let res = if self_mode {
        let fps: i64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(25);
        let domain = format!("/dev/shm/omp-probe-{}", std::process::id());
        std::fs::create_dir_all(&domain).expect("domain");
        let flow_id = "5fbec3b1-1b0f-4d52-a3cb-0a1d5b6e0a98".to_string();
        let (w, h) = (1920i64, 1080i64);
        let flow_def = serde_json::json!({
            "id": flow_id, "label": "write-read-latency-probe", "description": "98.0 probe",
            "tags": {"urn:x-nmos:tag:grouphint/v1.0": [format!("{flow_id}:Video")]},
            "format": "urn:x-nmos:format:video", "parents": [], "media_type": "video/v210",
            "grain_rate": {"numerator": fps, "denominator": 1},
            "frame_width": w, "frame_height": h, "interlace_mode": "progressive",
            "colorspace": "BT709", "transfer_characteristic": "SDR",
            "components": [
                {"name": "Y", "width": w, "height": h, "bit_depth": 10},
                {"name": "Cb", "width": w / 2, "height": h, "bit_depth": 10},
                {"name": "Cr", "width": w / 2, "height": h, "bit_depth": 10}
            ],
        })
        .to_string();
        let dom_w = domain.clone();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_w = stop.clone();
        let writer = std::thread::spawn(move || {
            let api = mxl::load_api("libmxl.so").expect("load_api");
            let inst = mxl::MxlInstance::new(api, &dom_w, "").expect("MxlInstance");
            let (fw, _cfg, _) = inst.create_flow_writer(&flow_def, None).expect("writer");
            let gw = fw.to_grain_writer().expect("grain_writer");
            let rate = mxl_sys::Rational { numerator: fps, denominator: 1 };
            let mut index = inst.get_current_index(&rate);
            while !stop_w.load(std::sync::atomic::Ordering::Relaxed) {
                let ts = inst.index_to_timestamp(index, &rate).unwrap_or(0);
                // Auf den Bildbeginn warten (Takt wie ein echter Schreiber).
                let now = inst.get_time();
                if ts > now {
                    inst.sleep_for(Duration::from_nanos(ts - now));
                }
                if let Ok(mut g) = gw.open_grain(index) {
                    let total = g.total_slices();
                    let st = inst.get_time();
                    g.payload_mut()[..8].copy_from_slice(&st.to_le_bytes());
                    let _ = g.commit(total);
                }
                index += 1;
            }
        });
        // Schreiber anlaufen lassen, dann lesen.
        std::thread::sleep(Duration::from_millis(500));
        let r = reader(&domain, &flow_id, secs, fps, 1, true);
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = writer.join();
        let _ = std::fs::remove_dir_all(&domain);
        println!("MODE self fps={fps} secs={secs} 1920x1080 v210 (eigene Domain, gelöscht)");
        r
    } else {
        let domain = std::env::var("OMP_MXL_DOMAIN").unwrap_or_else(|_| "/dev/shm/omp-mxl".into());
        let api = mxl::load_api("libmxl.so").expect("load_api");
        let inst = mxl::MxlInstance::new(api, &domain, "").expect("MxlInstance");
        let def: serde_json::Value = serde_json::from_str(&inst.get_flow_def(&first).expect("flow_def")).unwrap();
        let num = def["grain_rate"]["numerator"].as_i64().expect("nur Video-Flows (grain_rate)");
        let den = def["grain_rate"]["denominator"].as_i64().unwrap_or(1);
        drop(inst);
        println!("MODE live flow={first} secs={secs}");
        reader(&domain, &first, secs, num, den, false)
    };

    let after = proc_snapshot();
    let mut lat = res.lat_us.clone();
    report("commit->wake(lastWriteTime)", &mut lat);
    if self_mode {
        let mut st = res.stamp_us.clone();
        report("stamp->wake(vor commit)", &mut st);
    }
    println!("COUNT samples={} behind={} timeouts={}", res.n, res.behind, res.timeouts);
    println!(
        "PROC cpu_ticks={} voluntary_ctxt={} nonvoluntary_ctxt={}",
        after.0 - before.0,
        after.1 - before.1,
        after.2 - before.2
    );
}
