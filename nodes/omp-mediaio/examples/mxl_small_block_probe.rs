//! Wie klein dürfen MXL-Audioblöcke sein, und was kostet Schreiben → Lesen dabei? (Studio-Mischer, Kap. 99)
//!
//! Eigener Flow in privater Domain unter /dev/shm (berührt keinen Live-Flow). Ein Schreiber-Thread schreibt alle
//! `block/48000` s einen Block mit absoluten Fälligkeitszeiten (Schlafen + kurzes Drehen), ein Leser-Thread holt jeden
//! Block blockierend ab. Latenz = Rückkehr aus `get_samples` − Zeitpunkt unmittelbar nach dem Commit (µs).
//!
//!   cargo run --release -p omp-mediaio --features mxl --example mxl_small_block_probe -- [block=48] [sekunden=10] [kanäle=2] [spin]
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let block: usize = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(48);
    let secs: u64 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(10);
    let ch: u32 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(2);
    let spin = a.get(4).is_some_and(|m| m == "spin");
    let domain = format!("/dev/shm/omp-smallblock-{}", std::process::id());
    std::fs::create_dir_all(&domain).unwrap();
    let rate = mxl_sys::Rational { numerator: 48_000, denominator: 1 };
    let flow_id = "5b1f2c3a-0000-4000-8000-0000000000a1";
    let def = omp_mediaio::mxl::audio_flow_def(flow_id, "small-block-probe", 48_000, ch);
    // Keine Flow-Optionen: `MxlInstance::create_flow_writer` reicht den Options-String als dangling Zeiger weiter
    // (`options.map(|cs| cs.as_ptr())` gibt den CString frei) — MXL meldet dann "Invalid JSON options".
    let t0 = Instant::now();
    let commit_us: Arc<Vec<AtomicU64>> = Arc::new((0..(secs as usize * 48_000 / block + 64)).map(|_| AtomicU64::new(0)).collect());
    let running = Arc::new(AtomicBool::new(true));

    let (dom_w, cu_w, run_w) = (domain.clone(), commit_us.clone(), running.clone());
    let base_index = Arc::new(AtomicU64::new(0));
    let bi_w = base_index.clone();
    let writer = std::thread::spawn(move || {
        let api = mxl::load_api("libmxl.so").expect("libmxl");
        let inst = mxl::MxlInstance::new(api, &dom_w, "").expect("instance");
        let (fw, _c, _) = inst.create_flow_writer(&def, None).expect("writer");
        let sw = fw.to_samples_writer().expect("samples writer");
        let start_index = inst.get_current_index(&rate) + 2 * block as u64;
        bi_w.store(start_index, Ordering::SeqCst);
        let period = Duration::from_nanos(block as u64 * 1_000_000_000 / 48_000);
        let mut next = Instant::now() + period;
        let mut n = 0usize;
        while run_w.load(Ordering::Relaxed) && n < cu_w.len() {
            let now = Instant::now();
            if next > now + Duration::from_micros(200) {
                std::thread::sleep(next - now - Duration::from_micros(200));
            }
            while Instant::now() < next {
                std::hint::spin_loop();
            }
            let idx = start_index + (n * block) as u64;
            let opened = sw.open_samples(idx, block);
            if let Err(e) = &opened {
                if n < 3 {
                    eprintln!("Schreiber: open_samples {idx}: {e:?}");
                }
            }
            if let Ok(mut acc) = opened {
                for c in 0..acc.channels().min(ch as usize) {
                    if let Ok((d1, _d2)) = acc.channel_data_mut(c) {
                        d1.fill(0);
                    }
                }
                let r = acc.commit();
                if let Err(e) = &r {
                    if n < 3 {
                        eprintln!("Schreiber: commit: {e:?}");
                    }
                }
                if r.is_ok() {
                    cu_w[n].store(t0.elapsed().as_micros() as u64 + 1, Ordering::SeqCst);
                }
            }
            n += 1;
            next += period;
        }
    });

    std::thread::sleep(Duration::from_millis(300));
    let api = mxl::load_api("libmxl.so").expect("libmxl");
    let inst = mxl::MxlInstance::new(api, &domain, "").expect("instance");
    let reader = inst.create_flow_reader(flow_id).expect("reader").to_samples_reader().expect("samples reader");
    let start_index = base_index.load(Ordering::SeqCst);
    let mut lat: Vec<f64> = Vec::new();
    // Der Ring ist kurz: erst beim aktuellen Stand einsteigen, nicht beim ersten Block des Schreibers.
    let mut n = ((inst.get_current_index(&rate).saturating_sub(start_index)) / block as u64 + 2) as usize;
    let mut timeouts = 0u32;
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end && n < commit_us.len() {
        let idx = start_index + (n * block) as u64;
        let got = if spin {
            let t = Instant::now();
            loop {
                match reader.get_samples_non_blocking(idx, block) {
                    Ok(d) => break Ok(d),
                    Err(e) => {
                        if t.elapsed() > Duration::from_millis(50) {
                            break Err(e);
                        }
                        std::hint::spin_loop();
                    }
                }
            }
        } else {
            reader.get_samples(idx, block, Duration::from_millis(50))
        };
        match got {
            Ok(_d) => {
                let now = t0.elapsed().as_micros() as u64;
                let c = commit_us[n].load(Ordering::SeqCst);
                if c > 0 && now >= c {
                    lat.push((now - c) as f64);
                }
                n += 1;
            }
            Err(e) => {
                if timeouts == 0 {
                    eprintln!("Leser: {e:?} bei Index {idx}");
                }
                timeouts += 1;
                if timeouts > 100 {
                    break;
                }
            }
        }
    }
    running.store(false, Ordering::Relaxed);
    let _ = writer.join();
    let _ = std::fs::remove_dir_all(&domain);
    lat.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p = |q: f64| lat.get(((lat.len().max(1) - 1) as f64 * q).round() as usize).copied().unwrap_or(f64::NAN);
    println!(
        "block={block} ({:.2} ms) kanaele={ch}: n={} timeouts={timeouts}  Schreiben→Lesen µs: Median {:.0}, p95 {:.0}, p99 {:.0}, max {:.0}",
        block as f64 / 48.0,
        lat.len(),
        p(0.5),
        p(0.95),
        p(0.99),
        p(1.0)
    );
}
