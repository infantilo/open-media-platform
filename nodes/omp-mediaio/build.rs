// SPDX-FileCopyrightText: Contributors to OpenMediaPlatform.
//
// Erzeugt die FFI-Bindings für den Fabrics-Pfad (Kapitel 16 Teil 1,
// `docs/END-GOAL-FEATURES.md` §16.4) — nur aktiv mit Feature `fabrics`.
// Bewusst eine eigene, schlanke bindgen-Anbindung statt einer Erweiterung
// von `third_party/mxl/rust/mxl-sys` (dessen Wrapper-Header deckt nur
// `mxl.h`/`flow.h`/... ab, kein `fabrics.h` — und `mxl-sys` ist
// gitignorter Vendor-Code, ein Patch dort ginge bei jedem
// `install-mxl.sh`-Neuklon verloren, s. `docs/decisions.md` Nachtrag
// 41-43 zur selben Lektion beim CMake-Cache).
//
// **Zwei getrennte Bindings statt einer** (live entdeckt, nicht vorher
// erkennbar): `mxlFabrics*`-Symbole liegen in einer eigenen
// `libmxl-fabrics.so` (CMake-Target `mxl-fabrics`,
// `lib/fabrics/ofi/CMakeLists.txt`), NICHT in `libmxl.so` — und
// `libmxl-fabrics.so` linkt laut `ldd` nicht einmal gegen `libmxl.so`
// (die Fabrics-API nimmt bereits offene `mxlInstance`/`mxlFlowWriter`/
// `mxlFlowReader`-Handles als Parameter entgegen, statt sie selbst zu
// erzeugen). Deshalb: ein Bindings-Satz für die Instanz-/Flow-Verwaltung
// (`libmxl.so`) und ein zweiter, separat geladener Satz nur für
// `mxlFabrics*` (`libmxl-fabrics.so`) — beide über `.allowlist_function`
// auf ihre jeweilige Bibliothek beschränkt, damit bindgens
// Dynamic-Library-Modus (das eine `dlopen` + eine Methodentabelle pro
// generiertem Struct erzeugt) nicht versucht, Symbole aus der falschen
// `.so` zu laden. Gleiche Namens-Konvention wie `mxl-sys/build.rs`
// (führendes "mxl" aus Funktions-/Typnamen entfernt, CamelCase →
// snake_case für Funktionen).

// `bindgen` ist ein optionales Build-Dependency (nur unter Feature
// `fabrics` im Abhängigkeitsbaum, s. Cargo.toml `dep:bindgen`) — ohne
// dieses Feature existiert die Crate schlicht nicht, ein bloßer
// Laufzeit-Check auf `CARGO_FEATURE_FABRICS` in `main()` reicht deshalb
// NICHT (live entdeckt: der Standard-/`mxl`-only-Build schlug fehl, weil
// `bindgen::Builder` unten unbedingt referenziert wurde — Cargo
// kompiliert `build.rs` immer, unabhängig von Features, nur der
// eigentliche Bindgen-Aufruf darf bedingt sein). Der komplette
// bindgen-nutzende Teil steht deshalb hinter `#[cfg(feature =
// "fabrics")]`, mit einem leeren Fallback-`main()` sonst.
#[cfg(feature = "fabrics")]
fn main() {
    use std::env;
    use std::path::PathBuf;

    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR fehlt"));
    // Gleicher relativer Bezug zu third_party/mxl wie in den Cargo.toml-
    // Pfadabhängigkeiten (mxl/mxl-sys) — kein separater Env-Var nötig,
    // die Header liegen immer neben dem geklonten MXL-Quellbaum.
    let mxl_root = manifest_dir.join("../../third_party/mxl");
    let core_include = mxl_root.join("lib/include");
    let fabrics_include = mxl_root.join("lib/fabrics/include");

    if !fabrics_include.join("mxl/fabrics.h").exists() {
        panic!(
            "mxl/fabrics.h nicht gefunden unter {} — deploy/dev/install-mxl.sh gelaufen? \
             (third_party/mxl muss geklont sein, Feature `fabrics` braucht denselben \
             Quellbaum wie Feature `mxl`)",
            fabrics_include.display()
        );
    }

    println!("cargo:rerun-if-changed={}", core_include.display());
    println!("cargo:rerun-if-changed={}", fabrics_include.display());

    let clang_args = [
        format!("-I{}", core_include.display()),
        format!("-I{}", fabrics_include.display()),
    ];
    let out_path = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR fehlt"));

    // Instanz-/Flow-Verwaltung (mxl.h/flow.h/time.h) — lebt in libmxl.so.
    // Kapitel 16 Teil 2 (docs/END-GOAL-FEATURES.md §16.4, docs/
    // decisions.md): Grain-Ebene (`OpenGrain`/`CommitGrain`/`GetGrain`)
    // + `GetCurrentIndex`/`GetConfigInfo` zusätzlich zur bereits
    // vorhandenen Instanz-/Flow-Verwaltung aus Teil 1 — nötig, um einen
    // per Fabrics übertragenen Grain im lokalen Flow sichtbar zu machen
    // (Target-Seite) bzw. neue Grains in einem lokalen Flow zu erkennen
    // (Initiator-Seite), exakt das Muster aus `mxl-fabrics-demo`s
    // `runDiscrete()`.
    let core_bindings = bindgen::Builder::default()
        .clang_args(&clang_args)
        .header_contents(
            "mxl_core_wrapper.h",
            "#include <mxl/mxl.h>\n#include <mxl/flow.h>\n#include <mxl/time.h>\n",
        )
        .allowlist_function(
            "mxlCreateInstance|mxlDestroyInstance|mxlCreateFlowWriter|mxlReleaseFlowWriter|mxlCreateFlowReader|mxlReleaseFlowReader|mxlFlowWriterOpenGrain|mxlFlowWriterCommitGrain|mxlFlowReaderGetGrain|mxlFlowReaderGetConfigInfo|mxlGetCurrentIndex",
        )
        .derive_default(true)
        .derive_debug(true)
        .prepend_enum_name(false)
        .dynamic_library_name("libmxlcore")
        .dynamic_link_require_all(true)
        .parse_callbacks(Box::new(RenameCallback))
        .generate()
        .expect("bindgen für mxl.h/flow.h (Kernfunktionen) fehlgeschlagen");
    core_bindings
        .write_to_file(out_path.join("mxl_core_bindings.rs"))
        .expect("mxl_core_bindings.rs konnte nicht geschrieben werden");

    // Fabrics-API (fabrics.h) — lebt in libmxl-fabrics.so, unabhängig
    // von libmxl.so ladbar (nimmt offene Handles als Parameter entgegen).
    let fabrics_bindings = bindgen::Builder::default()
        .clang_args(&clang_args)
        .header_contents(
            "fabrics_wrapper.h",
            "#include <mxl/mxl.h>\n#include <mxl/flow.h>\n#include <mxl/fabrics.h>\n",
        )
        .allowlist_function("mxlFabrics.*")
        .derive_default(true)
        .derive_debug(true)
        .prepend_enum_name(false)
        .dynamic_library_name("libmxlfabrics")
        .dynamic_link_require_all(true)
        .parse_callbacks(Box::new(RenameCallback))
        .generate()
        .expect("bindgen für mxl/fabrics.h fehlgeschlagen");
    fabrics_bindings
        .write_to_file(out_path.join("fabrics_bindings.rs"))
        .expect("fabrics_bindings.rs konnte nicht geschrieben werden");
}

#[cfg(not(feature = "fabrics"))]
fn main() {}

/// Identische Umbenennungs-Konvention wie `mxl-sys/build.rs::CB` (führendes
/// "mxl" aus Funktions-/Typnamen entfernt, Funktionsnamen CamelCase →
/// snake_case) — bewusst dupliziert statt geteilt, da `mxl-sys`s Callback
/// nicht exportiert ist und dies der einzige weitere Aufrufer ist.
#[cfg(feature = "fabrics")]
#[derive(Debug)]
struct RenameCallback;

#[cfg(feature = "fabrics")]
impl bindgen::callbacks::ParseCallbacks for RenameCallback {
    fn item_name(&self, item_info: bindgen::callbacks::ItemInfo) -> Option<String> {
        match item_info.kind {
            bindgen::callbacks::ItemKind::Function => {
                Some(to_snake_case(&item_info.name.replace("mxl", "")))
            }
            bindgen::callbacks::ItemKind::Type => Some(item_info.name.replace("mxl", "")),
            _ => None,
        }
    }
}

#[cfg(feature = "fabrics")]
fn to_snake_case(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_uppercase() {
            if !out.is_empty() {
                out.push('_');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}
