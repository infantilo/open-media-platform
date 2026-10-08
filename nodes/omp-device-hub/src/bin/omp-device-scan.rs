//! `omp-device-scan [wurzel]` — gibt die erkannten Capture-Geräte als JSON aus (Kap. 34.1).
fn main() {
    let root = std::env::args().nth(1).unwrap_or_else(|| "/".to_string());
    let devices = omp_device_hub::scan(std::path::Path::new(&root));
    println!("{}", serde_json::to_string_pretty(&devices).expect("serialize"));
}
