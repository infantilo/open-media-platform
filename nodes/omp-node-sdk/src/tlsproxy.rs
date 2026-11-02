//! TLS-Acceptor für den optionalen HTTPS-Listener (`OMP_HTTPS=1`, `https.rs`).
//!
//! Vorher bediente `tiny_http` mit dem Feature `ssl-rustls` das TLS selbst — fest an rustls 0.20 und ring 0.16 gebunden
//! (kein Upstream-Fix, `tiny_http 0.12.0` ist die letzte Version; mehrere Sicherheitsmeldungen, in `.cargo/audit.toml`
//! akzeptiert). Jetzt entschlüsselt dieser Acceptor mit **rustls 0.23** (`tokio-rustls`, Provider `ring`) und reicht die
//! Bytes unverändert an den ohnehin laufenden normalen Node-Port auf `127.0.0.1` weiter. Alle Routen, der Zugangsschutz
//! (`nodeauth`) und das Verhalten bleiben dadurch gleich, weil derselbe HTTP-Server antwortet; es gibt nur noch einen
//! HTTP-Server je Node statt zwei.
//!
//! Grenzen: höchstens [`MAX_CONNECTIONS`] gleichzeitige Verbindungen (weitere werden sofort geschlossen),
//! [`HANDSHAKE_TIMEOUT`] für den TLS-Aufbau. Leerlauf-Timeouts je Verbindung gibt es wie vorher nicht. Protokolle: TLS 1.2
//! und 1.3, keine Client-Zertifikate (das war schon bisher so — das ist der Browser-Zugang, nicht der mTLS-Pfad).

use std::io;
use std::net::TcpListener as StdListener;
use std::sync::Arc;
use std::time::Duration;

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio_rustls::TlsAcceptor;
use tokio_rustls::rustls::{self, pki_types::CertificateDer, pki_types::PrivateKeyDer, pki_types::pem::PemObject};

const MAX_CONNECTIONS: usize = 256;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Baut die Serverkonfiguration aus Zertifikatskette und Schlüssel (PEM).
pub(crate) fn server_config(cert_pem: &[u8], key_pem: &[u8]) -> Result<Arc<rustls::ServerConfig>, String> {
    let certs = CertificateDer::pem_slice_iter(cert_pem).collect::<Result<Vec<_>, _>>().map_err(|e| format!("Zertifikat: {e}"))?;
    if certs.is_empty() {
        return Err("Zertifikat: keine Zertifikate in der PEM-Datei".to_string());
    }
    let key = PrivateKeyDer::from_pem_slice(key_pem).map_err(|e| format!("Schlüssel: {e}"))?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS-Versionen: {e}"))?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("Zertifikat/Schlüssel passen nicht zusammen: {e}"))?;
    Ok(Arc::new(config))
}

/// Bindet `addr` sofort (Bind-Fehler sind so sichtbar) und betreibt den Acceptor in einem eigenen Thread. `backend_port`
/// ist der normale HTTP-Port dieses Nodes. Liefert den gebundenen TLS-Port.
pub(crate) fn spawn(addr: &str, backend_port: u16, cert_pem: &[u8], key_pem: &[u8]) -> io::Result<(u16, std::thread::JoinHandle<()>)> {
    let config = server_config(cert_pem, key_pem).map_err(io::Error::other)?;
    let listener = StdListener::bind(addr)?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let handle = std::thread::Builder::new().name("omp-tls-accept".into()).spawn(move || {
        let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(r) => r,
            Err(e) => {
                eprintln!("omp-node-sdk: TLS-Laufzeit nicht startbar: {e}");
                return;
            }
        };
        runtime.block_on(accept_loop(listener, config, backend_port));
    })?;
    Ok((port, handle))
}

async fn accept_loop(listener: StdListener, config: Arc<rustls::ServerConfig>, backend_port: u16) {
    let Ok(listener) = TcpListener::from_std(listener) else {
        eprintln!("omp-node-sdk: TLS-Listener nicht übernehmbar");
        return;
    };
    let acceptor = TlsAcceptor::from(config);
    let limit = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        let tcp = match listener.accept().await {
            Ok((tcp, _)) => tcp,
            Err(e) => {
                eprintln!("omp-node-sdk: TLS accept: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let Ok(permit) = limit.clone().try_acquire_owned() else {
            drop(tcp); // zu viele gleichzeitige Verbindungen
            continue;
        };
        let acceptor = acceptor.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let _ = serve_connection(tcp, acceptor, backend_port).await;
        });
    }
}

async fn serve_connection(tcp: TcpStream, acceptor: TlsAcceptor, backend_port: u16) -> io::Result<()> {
    let _ = tcp.set_nodelay(true);
    let mut tls = tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(tcp))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "TLS-Handshake zu langsam"))??;
    let mut backend = TcpStream::connect(("127.0.0.1", backend_port)).await?;
    let _ = backend.set_nodelay(true);
    tokio::io::copy_bidirectional(&mut tls, &mut backend).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_rustls::TlsConnector;
    use tokio_rustls::rustls::pki_types::ServerName;

    /// Selbst signiertes Zertifikat per openssl-CLI (wie `https.rs`); `None`, wenn openssl fehlt.
    fn make_cert(dir: &std::path::Path) -> Option<(Vec<u8>, Vec<u8>)> {
        let (crt, key) = (dir.join("c.pem"), dir.join("k.pem"));
        let ok = std::process::Command::new("openssl")
            .args(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:FALSE", "-keyout"])
            .arg(&key)
            .arg("-out")
            .arg(&crt)
            .output()
            .ok()?
            .status
            .success();
        ok.then(|| (std::fs::read(crt).unwrap(), std::fs::read(key).unwrap()))
    }

    /// Einfacher HTTP-Backend-Server auf 127.0.0.1 (antwortet auf jede Anfrage mit dem Wert von `X-Test` bzw. "hello").
    fn backend() -> u16 {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        std::thread::spawn(move || {
            for mut req in server.incoming_requests() {
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let echo = format!("hello:{}:{}", req.url(), body);
                let _ = req.respond(tiny_http::Response::from_string(echo));
            }
        });
        port
    }

    fn client_for(cert_pem: &[u8]) -> TlsConnector {
        let mut roots = rustls::RootCertStore::empty();
        for c in CertificateDer::pem_slice_iter(cert_pem) {
            roots.add(c.unwrap()).unwrap();
        }
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let cfg = rustls::ClientConfig::builder_with_provider(provider).with_safe_default_protocol_versions().unwrap().with_root_certificates(roots).with_no_client_auth();
        TlsConnector::from(Arc::new(cfg))
    }

    #[test]
    fn https_request_reaches_the_plain_backend() {
        let dir = std::env::temp_dir().join(format!("omp-tlsproxy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let Some((cert, key)) = make_cert(&dir) else {
            eprintln!("openssl nicht verfügbar — Test übersprungen");
            return;
        };
        let backend_port = backend();
        let (port, _h) = spawn("127.0.0.1:0", backend_port, &cert, &key).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let connector = client_for(&cert);
            let tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            let mut tls = connector.connect(ServerName::try_from("127.0.0.1").unwrap(), tcp).await.expect("TLS-Handshake mit dem Acceptor");
            let proto = tls.get_ref().1.protocol_version();
            assert!(matches!(proto, Some(rustls::ProtocolVersion::TLSv1_3) | Some(rustls::ProtocolVersion::TLSv1_2)), "{proto:?}");
            tls.write_all(b"POST /x?y=1 HTTP/1.1\r\nHost: t\r\nContent-Length: 4\r\nConnection: close\r\n\r\nabcd").await.unwrap();
            let mut out = String::new();
            let _ = tls.read_to_string(&mut out).await; // Verbindungsende ohne close_notify ist hier unerheblich
            assert!(out.starts_with("HTTP/1.1 200"), "{out}");
            assert!(out.contains("hello:/x?y=1:abcd"), "Anfrage samt Body muss unverändert ankommen: {out}");
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plaintext_and_garbage_are_rejected_without_hanging() {
        let dir = std::env::temp_dir().join(format!("omp-tlsproxy2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let Some((cert, key)) = make_cert(&dir) else { return };
        let (port, _h) = spawn("127.0.0.1:0", backend(), &cert, &key).unwrap();
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.write_all(b"GET / HTTP/1.1\r\nHost: t\r\n\r\n").unwrap(); // Klartext auf dem TLS-Port
        let mut buf = [0u8; 64];
        let n = s.read(&mut buf).unwrap_or(0);
        assert!(!String::from_utf8_lossy(&buf[..n]).contains("hello"), "Klartext darf nicht zum Backend durchgereicht werden");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bad_key_material_is_an_error() {
        assert!(server_config(b"", b"").is_err());
        assert!(server_config(b"-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n", b"nonsense").is_err());
    }
}
