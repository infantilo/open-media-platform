//! Vergleicht die Zeitbasis von `omp_mediaio::timebase::tai_now_ns()` mit der MXL-Zeit (`MxlContext::now_ns`).
use omp_mediaio::mxl::MxlContext;
fn main() {
    let ctx = MxlContext::new("/dev/shm/omp-mxl").expect("MXL");
    for _ in 0..5 {
        let a = omp_mediaio::timebase::tai_now_ns();
        let b = ctx.now_ns();
        let c = omp_mediaio::timebase::tai_now_ns();
        println!("timebase {a}  mxl {b}  Differenz mxl − timebase(Mitte) = {:.3} ms", (b as f64 - (a + c) as f64 / 2.0) / 1e6);
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}
