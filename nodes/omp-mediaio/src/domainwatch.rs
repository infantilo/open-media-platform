//! Ereignisgesteuerte Beobachtung eines MXL-Domain-Verzeichnisses (inotify) — statt wiederholt nachzusehen, ob ein Flow
//! (noch) nicht existiert. Ein MXL-Schreiber legt einen Flow als `<id>.mxl-flow` an: erst in einem Temp-Verzeichnis
//! (`mkdtemp`) füllen, dann atomar umbenennen (`renameat2`, `third_party/mxl/lib/internal/src/FlowManager.cpp`) — das
//! erscheint hier als `IN_MOVED_TO`. Verschwinden (Schreiber beendet, Aufräumen) als `IN_DELETE`.
//! Kein Dienst im MXL selbst bietet "warte auf neuen Flow"; die Schreiber-Seite nutzt intern dasselbe (inotify).

use std::ffi::CString;
use std::io;
use std::os::fd::RawFd;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::time::Duration;

pub struct DomainWatch {
    fd: RawFd,
}

impl DomainWatch {
    pub fn new(dir: &Path) -> io::Result<Self> {
        let fd = unsafe { libc::inotify_init1(libc::IN_CLOEXEC | libc::IN_NONBLOCK) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let path = CString::new(dir.as_os_str().as_bytes()).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
        let mask = libc::IN_CREATE | libc::IN_MOVED_TO | libc::IN_DELETE | libc::IN_MOVED_FROM | libc::IN_DELETE_SELF;
        if unsafe { libc::inotify_add_watch(fd, path.as_ptr(), mask) } < 0 {
            let e = io::Error::last_os_error();
            unsafe { libc::close(fd) };
            return Err(e);
        }
        Ok(DomainWatch { fd })
    }

    /// Blockiert, bis sich im Verzeichnis etwas ändert oder `timeout` abläuft (`None` = ohne Grenze). `true` = Änderung.
    /// Alle anstehenden Ereignisse werden verbraucht, damit der nächste Aufruf wieder wartet.
    pub fn wait(&self, timeout: Option<Duration>) -> bool {
        let ms = timeout.map_or(-1, |d| d.as_millis().min(i32::MAX as u128) as i32);
        let mut p = libc::pollfd { fd: self.fd, events: libc::POLLIN, revents: 0 };
        let r = unsafe { libc::poll(&mut p, 1, ms) };
        if r <= 0 {
            return false; // Zeit abgelaufen oder unterbrochen
        }
        let mut buf = [0u8; 4096];
        loop {
            let n = unsafe { libc::read(self.fd, buf.as_mut_ptr().cast(), buf.len()) };
            if n <= 0 {
                break; // EAGAIN: leer
            }
        }
        true
    }
}

impl Drop for DomainWatch {
    fn drop(&mut self) {
        unsafe { libc::close(self.fd) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("omp-domainwatch-{}-{}", std::process::id(), line!()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn wakes_on_atomic_flow_creation_and_times_out_otherwise() {
        let dir = tmp();
        let w = DomainWatch::new(&dir).unwrap();
        // nichts passiert: Zeit läuft ab, kein falsches Wecken
        let t = Instant::now();
        assert!(!w.wait(Some(Duration::from_millis(150))));
        assert!(t.elapsed() >= Duration::from_millis(140));
        // Schreiber-Muster: Temp-Verzeichnis füllen, dann atomar umbenennen
        let d2 = dir.clone();
        let h = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            let tmpd = d2.join("tmp-abc123");
            std::fs::create_dir(&tmpd).unwrap();
            std::fs::write(tmpd.join("flow_def.json"), "{}").unwrap();
            std::fs::rename(&tmpd, d2.join("11111111-1111-1111-1111-111111111111.mxl-flow")).unwrap();
        });
        let t = Instant::now();
        assert!(w.wait(Some(Duration::from_secs(5))), "Anlegen muss wecken");
        assert!(t.elapsed() < Duration::from_secs(2));
        h.join().unwrap();
        // verbraucht: der nächste Aufruf wartet wieder
        while w.wait(Some(Duration::from_millis(50))) {}
        assert!(!w.wait(Some(Duration::from_millis(100))));
        // Entfernen weckt ebenfalls
        std::fs::remove_dir_all(dir.join("11111111-1111-1111-1111-111111111111.mxl-flow")).unwrap();
        assert!(w.wait(Some(Duration::from_secs(2))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_directory_is_an_error() {
        assert!(DomainWatch::new(Path::new("/nicht/vorhanden/omp")).is_err());
    }
}
