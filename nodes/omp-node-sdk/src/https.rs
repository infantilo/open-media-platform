//! Optionales HTTPS für den Descriptor-/Zusatz-Server (`OMP_HTTPS=1`).
//!
//! Hintergrund (Nutzerfund 2026-10-11): der Handy-Browser erlaubt Kamera/Mikrofon
//! (`getUserMedia`) nur über HTTPS, `omp-webrtc-gateway` liefert `camera.html` aber über den
//! normalen Node-Port. Mit `OMP_HTTPS=1` startet der Node zusätzlich einen TLS-Listener (eigener
//! Port, gleiche Routen, gleicher [`crate::ParamStore`]) mit einem selbst signierten Zertifikat
//! (per `openssl`-CLI erzeugt, unter `OMP_HTTPS_CERT_DIR` bzw. `.run/https` abgelegt und bei jedem
//! Start wiederverwendet — das Handy bestätigt die Warnung nur einmal je Adresse).
//! `GET /https-info` liefert `{"enabled":bool,"port":N,"url":"https://<OMP_HOST>:N"}`.

use std::net::IpAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU16, Ordering};

static HTTPS_PORT: AtomicU16 = AtomicU16::new(0);
static HTTPS_HOST: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Ist `OMP_HTTPS` gesetzt (1/true/auto)?
pub(crate) fn enabled() -> bool {
    matches!(
        std::env::var("OMP_HTTPS").unwrap_or_default().to_ascii_lowercase().as_str(),
        "1" | "true" | "auto" | "yes" | "on"
    )
}

pub(crate) fn set_bound(host: &str, port: u16) {
    let _ = HTTPS_HOST.set(host.to_string());
    HTTPS_PORT.store(port, Ordering::Relaxed);
}

/// Inhalt von `GET /https-info`.
pub(crate) fn info_json() -> serde_json::Value {
    let port = HTTPS_PORT.load(Ordering::Relaxed);
    if port == 0 {
        return serde_json::json!({"enabled": false});
    }
    let host = HTTPS_HOST.get().map(String::as_str).unwrap_or("127.0.0.1");
    let host = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.to_string() };
    serde_json::json!({"enabled": true, "port": port, "url": format!("https://{host}:{port}")})
}

fn cert_dir() -> PathBuf {
    if let Ok(d) = std::env::var("OMP_HTTPS_CERT_DIR") {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    std::env::current_dir().unwrap_or_else(|_| std::env::temp_dir()).join(".run").join("https")
}

/// Liefert (Zertifikat-PEM, Schlüssel-PEM) für `host`; erzeugt sie bei Bedarf per `openssl`.
pub(crate) fn load_or_create_cert(host: &str) -> Result<(Vec<u8>, Vec<u8>), String> {
    let dir = cert_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let safe: String = host.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' }).collect();
    let crt = dir.join(format!("{safe}.crt"));
    let key = dir.join(format!("{safe}.key"));
    if !(crt.exists() && key.exists()) {
        let san = match host.parse::<IpAddr>() {
            Ok(_) => format!("subjectAltName=IP:{host},IP:127.0.0.1,DNS:localhost"),
            Err(_) => format!("subjectAltName=DNS:{host},IP:127.0.0.1,DNS:localhost"),
        };
        // Zwei Instanzen können gleichzeitig starten: in Temp-Dateien erzeugen und atomar umbenennen
        // (zuerst Schlüssel, zuletzt das Zertifikat — dessen Existenz ist die Fertig-Markierung).
        let pid = std::process::id();
        let tmp_key = dir.join(format!("{safe}.key.tmp{pid}"));
        let tmp_crt = dir.join(format!("{safe}.crt.tmp{pid}"));
        let out = Command::new("openssl")
            .args(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "3650", "-subj"])
            .arg(format!("/CN={host}"))
            .args(["-addext", &san, "-keyout"])
            .arg(&tmp_key)
            .arg("-out")
            .arg(&tmp_crt)
            .output()
            .map_err(|e| format!("openssl nicht startbar: {e}"))?;
        if !out.status.success() {
            let _ = std::fs::remove_file(&tmp_key);
            let _ = std::fs::remove_file(&tmp_crt);
            return Err(format!("openssl: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        if crt.exists() {
            // anderer Prozess war schneller — dessen Paar behalten
            let _ = std::fs::remove_file(&tmp_key);
            let _ = std::fs::remove_file(&tmp_crt);
        } else {
            std::fs::rename(&tmp_key, &key).map_err(|e| format!("rename key: {e}"))?;
            std::fs::rename(&tmp_crt, &crt).map_err(|e| format!("rename crt: {e}"))?;
        }
    }
    let c = std::fs::read(&crt).map_err(|e| format!("read {}: {e}", crt.display()))?;
    let k = std::fs::read(&key).map_err(|e| format!("read {}: {e}", key.display()))?;
    Ok((c, k))
}
