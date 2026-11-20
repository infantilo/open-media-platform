//! Austauschtest 106.3b: ein Fremdprozess mit minimalem Vertrag ersetzt die eingebaute Stufe, ohne Änderung am Aufrufer.
use omp_normalizer::tonemap::{make_backend, Curve, MapRequest};

#[test]
fn external_process_replaces_builtin() {
    let req = MapRequest { from: Curve::Hlg, to: Curve::Sdr, width: 4, height: 1 };
    let mut builtin = make_backend("builtin").unwrap();
    let mut a = vec![16u8, 100, 180, 235];
    builtin.map_luma(&req, &mut a).unwrap();

    let mut ext = make_backend(env!("CARGO_BIN_EXE_omp-map-invert")).unwrap();
    let mut b = vec![16u8, 100, 180, 235];
    ext.map_luma(&req, &mut b).unwrap();
    assert_eq!(b, vec![235, 151, 71, 16]); // invertiert
    assert_ne!(a, b);
    // mehrere Bilder nacheinander über denselben Dienst
    let mut c = vec![16u8, 16, 16, 16];
    ext.map_luma(&req, &mut c).unwrap();
    assert_eq!(c, vec![235; 4]);
}

#[test]
fn missing_service_is_an_error_not_a_panic() {
    assert!(make_backend("/nonexistent/service").is_err());
}
