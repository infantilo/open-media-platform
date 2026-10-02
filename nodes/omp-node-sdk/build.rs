//! Build-Stempel (Kapitel 28): `OMP_BUILD_VERSION` / `OMP_BUILD_COMMIT` /
//! `OMP_BUILD_AT` aus der Umgebung (setzt `make update-bundle`). Ohne sie bleibt
//! der Stempel "dev" — absichtlich KEIN `git rev-parse` und keine Uhrzeit hier,
//! sonst würde jeder Commit/Build alle Nodes neu kompilieren und binden.
fn main() {
    for key in ["OMP_BUILD_VERSION", "OMP_BUILD_COMMIT", "OMP_BUILD_AT"] {
        println!("cargo:rerun-if-env-changed={key}");
    }
    let get = |k: &str, default: &str| {
        let v = std::env::var(k).unwrap_or_default();
        let v = v.trim();
        // Nur harmlose Zeichen: der Stempel landet in einem JSON-Literal.
        if v.is_empty() || !v.chars().all(|c| c.is_ascii_alphanumeric() || ".-_:+".contains(c)) {
            default.to_string()
        } else {
            v.to_string()
        }
    };
    println!("cargo:rustc-env=OMP_SDK_BUILD_VERSION={}", get("OMP_BUILD_VERSION", "dev"));
    println!("cargo:rustc-env=OMP_SDK_BUILD_COMMIT={}", get("OMP_BUILD_COMMIT", ""));
    println!("cargo:rustc-env=OMP_SDK_BUILD_AT={}", get("OMP_BUILD_AT", ""));
}
