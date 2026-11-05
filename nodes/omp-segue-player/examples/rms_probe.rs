//! Messwerkzeug: liest einen MXL-Audio-Flow direkt und gibt den Effektivwert (dBFS) je Fenster aus — zur Prüfung von Überblendungen.
//! `rms_probe <flow-id> <seit-TAI-ns> [Sekunden=12] [Fenster-ms=250] [Domain]`  → Zeilen `RMS <t_ms_seit_start> <dBFS>`
use omp_mediaio::mxl::MxlContext;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let flow = a.get(1).expect("flow-id");
    let since: u64 = a.get(2).expect("seit-TAI-ns").parse().expect("Zahl");
    let secs: f64 = a.get(3).map_or(12.0, |s| s.parse().unwrap_or(12.0));
    let win_ms: u64 = a.get(4).map_or(250, |s| s.parse().unwrap_or(250));
    let domain = a.get(5).cloned().unwrap_or_else(|| "/dev/shm/omp-mxl".into());
    let ctx = MxlContext::new(&domain).expect("MXL-Domain");
    let reader = ctx.instance().create_flow_reader(flow).expect("Flow").to_samples_reader().expect("Samples-Leser");
    let rate = mxl_sys::Rational { numerator: 48_000, denominator: 1 };
    let batch = 480u64;
    let win = (48 * win_ms) as usize;
    let mut index = ctx.ns_to_index(since, 48_000, 1).expect("Index") + batch - 1;
    let start = index + 1 - batch;
    let end = std::time::Instant::now() + std::time::Duration::from_secs_f64(secs);
    let (mut acc, mut n) = (0f64, 0usize);
    while std::time::Instant::now() < end {
        match reader.get_samples_non_blocking(index, batch as usize) {
            Ok(data) => {
                if let Ok((d1, d2)) = data.channel_data(0) {
                    for c in d1.chunks_exact(4).chain(d2.chunks_exact(4)) {
                        let v = f32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f64;
                        acc += v * v;
                        n += 1;
                        if n == win {
                            let rms = (acc / n as f64).sqrt();
                            let t = (index + 1 - batch - start) as f64 / 48.0;
                            println!("RMS {:.0} {:.2}", t, 20.0 * rms.max(1e-9).log10());
                            acc = 0.0;
                            n = 0;
                        }
                    }
                }
                index += batch;
            }
            Err(mxl::Error::OutOfRangeTooLate) => index = ctx.instance().get_current_index(&rate),
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(1)),
        }
    }
}
