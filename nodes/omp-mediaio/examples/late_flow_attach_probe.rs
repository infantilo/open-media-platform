//! Misst, ob man auf einen NOCH NICHT EXISTIERENDEN MXL-Flow ohne Nachsehen im Takt warten kann: inotify auf das
//! Domain-Verzeichnis (`omp_mediaio::domainwatch`), Versuch erst bei einem Ereignis. Zählt Versuche und Wartezeit-Wecker und
//! die CPU-Zeit des Prozesses während des Wartens. Gegenstück zum Anlegen: `mxl_late_flow_writer <flow-id>` (anderer Prozess).
//!
//!   OMP_MXL_DOMAIN=/dev/shm/omp-probe-late cargo run --release -p omp-mediaio --example late_flow_attach_probe --features mxl -- <flow-id>

use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn process_cpu_ms() -> f64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe { libc::clock_gettime(libc::CLOCK_PROCESS_CPUTIME_ID, &mut ts) };
    ts.tv_sec as f64 * 1000.0 + ts.tv_nsec as f64 / 1e6
}

fn main() {
    let flow_id = std::env::args().nth(1).expect("flow-id arg");
    let domain = std::env::var("OMP_MXL_DOMAIN").expect("OMP_MXL_DOMAIN");
    let api = mxl::load_api("libmxl.so").expect("load_api");
    let instance = mxl::MxlInstance::new(api, &domain, "").expect("MxlInstance::new");
    let watch = omp_mediaio::domainwatch::DomainWatch::new(Path::new(&domain)).expect("DomainWatch");
    let (t0, cpu0) = (Instant::now(), process_cpu_ms());
    let (mut attempts, mut events) = (0u32, 0u32);
    println!("wartet auf {flow_id} in {domain}");
    loop {
        attempts += 1;
        // Wer Flow-Dateien selbst liest: nur wenn die Flow-Definition abrufbar ist, existiert der Flow vollständig.
        if instance.get_flow_def(&flow_id).is_ok() {
            let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
            println!(
                "ANGEHÄNGT epoch={}.{:09} nach {:.2} s, Versuche {attempts}, Ereignisse {events}, CPU im Warten {:.1} ms",
                now.as_secs(),
                now.subsec_nanos(),
                t0.elapsed().as_secs_f64(),
                process_cpu_ms() - cpu0
            );
            return;
        }
        // Ohne Ereignis bis zu 30 s schlafen — der einzige Wecker ist ein Eintrag im Verzeichnis.
        if watch.wait(Some(Duration::from_secs(30))) {
            events += 1;
        }
        if t0.elapsed() > Duration::from_secs(120) {
            println!("Zeitüberschreitung");
            return;
        }
    }
}
