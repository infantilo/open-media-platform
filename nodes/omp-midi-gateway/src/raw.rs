//! USB-MIDI am Server (Kapitel 93, Weg B): Rohgeräte des Kernels (`/dev/snd/midiC<karte>D<gerät>`, ALSA RawMIDI). Klassenkonforme
//! USB-Geräte (iCON V1-M/P1-M und andere) erscheinen dort ohne Treiber. Ein Hilfsthread liest, öffnet nach Abziehen/Anstecken neu.
//! Keine Bibliothek nötig: die Geräte sind Zeichengeräte mit rohem MIDI-Byte-Strom (Minimal-Dependency-Regel).

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::surface::MidiPort;

#[derive(Clone, Debug, PartialEq)]
pub struct RawDevice {
    pub path: String,
    pub card: u32,
    pub device: u32,
    pub name: String,
}

/// Karten-Kurznamen aus `/proc/asound/cards` (Zeilen wie ` 1 [V1M            ]: USB-Audio - iCON V1-M`).
pub fn parse_cards(txt: &str) -> Vec<(u32, String)> {
    let mut out = vec![];
    for line in txt.lines() {
        let t = line.trim_start();
        let Some(idx) = t.split_whitespace().next().and_then(|x| x.parse::<u32>().ok()) else { continue };
        if !t.contains('[') {
            continue;
        }
        let name = t.split(" - ").nth(1).unwrap_or(t.split(']').next().unwrap_or("").trim_start_matches(|c: char| c.is_ascii_digit() || c.is_whitespace() || c == '[')).trim().to_string();
        out.push((idx, name));
    }
    out
}

/// `midiC1D0` → (1, 0).
pub fn parse_dev_name(n: &str) -> Option<(u32, u32)> {
    let rest = n.strip_prefix("midiC")?;
    let (c, d) = rest.split_once('D')?;
    Some((c.parse().ok()?, d.parse().ok()?))
}

pub fn list_devices() -> Vec<RawDevice> {
    let cards = parse_cards(&std::fs::read_to_string("/proc/asound/cards").unwrap_or_default());
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir("/dev/snd") {
        for e in rd.flatten() {
            let fname = e.file_name().to_string_lossy().to_string();
            if let Some((card, device)) = parse_dev_name(&fname) {
                let name = cards.iter().find(|(i, _)| *i == card).map(|(_, n)| n.clone()).unwrap_or_default();
                out.push(RawDevice { path: format!("/dev/snd/{fname}"), card, device, name });
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

struct Shared {
    up: AtomicBool,
    stop: AtomicBool,
    rx: Mutex<VecDeque<Vec<u8>>>,
    tx: Mutex<Option<File>>,
}

pub struct RawPort {
    label: String,
    sh: Arc<Shared>,
}

impl RawPort {
    pub fn open(path: &str, label: &str) -> RawPort {
        let sh = Arc::new(Shared { up: AtomicBool::new(false), stop: AtomicBool::new(false), rx: Mutex::new(VecDeque::new()), tx: Mutex::new(None) });
        let (s2, p) = (sh.clone(), path.to_string());
        std::thread::spawn(move || reader(s2, &p));
        RawPort { label: label.to_string(), sh }
    }
}

impl Drop for RawPort {
    fn drop(&mut self) {
        self.sh.stop.store(true, Ordering::Relaxed);
    }
}

fn reader(sh: Arc<Shared>, path: &str) {
    while !sh.stop.load(Ordering::Relaxed) {
        let f = OpenOptions::new().read(true).write(true).custom_flags(libc::O_NONBLOCK).open(path);
        let Ok(mut f) = f else {
            sleep_unless_stopped(&sh, Duration::from_millis(1000));
            continue;
        };
        if let Ok(w) = f.try_clone() {
            *sh.tx.lock().expect("lock poisoned") = Some(w);
        }
        sh.up.store(true, Ordering::Relaxed);
        let mut buf = [0u8; 512];
        while !sh.stop.load(Ordering::Relaxed) {
            let mut pfd = libc::pollfd { fd: f.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            // SAFETY: gültiger Zeiger auf ein pollfd, Länge 1
            let r = unsafe { libc::poll(&mut pfd, 1, 100) };
            if r < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                break;
            }
            if pfd.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
                break; // Gerät abgezogen
            }
            if r == 0 {
                continue;
            }
            match f.read(&mut buf) {
                Ok(0) => {}
                Ok(n) => sh.rx.lock().expect("lock poisoned").push_back(buf[..n].to_vec()),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        sh.up.store(false, Ordering::Relaxed);
        *sh.tx.lock().expect("lock poisoned") = None;
    }
}

fn sleep_unless_stopped(sh: &Shared, d: Duration) {
    let t = Instant::now();
    while t.elapsed() < d && !sh.stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(50));
    }
}

impl MidiPort for RawPort {
    fn name(&self) -> String {
        self.label.clone()
    }
    fn send_batch(&mut self, msgs: &[Vec<u8>]) {
        let mut g = self.sh.tx.lock().expect("lock poisoned");
        let Some(f) = g.as_mut() else { return };
        for m in msgs {
            let mut off = 0;
            let start = Instant::now();
            while off < m.len() {
                match f.write(&m[off..]) {
                    Ok(n) => off += n,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        if start.elapsed() > Duration::from_millis(50) {
                            break; // Puffer des Geräts voll: Nachricht verwerfen, der Zustandsabgleich holt sie nach
                        }
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    Err(_) => return,
                }
            }
        }
    }
    fn recv(&mut self) -> Vec<Vec<u8>> {
        self.sh.rx.lock().expect("lock poisoned").drain(..).collect()
    }
    fn is_up(&self) -> bool {
        self.sh.up.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cards_and_names() {
        let t = " 0 [PCH            ]: HDA-Intel - HDA Intel PCH\n                      HDA Intel PCH at 0xf7200000 irq 130\n 1 [V1M            ]: USB-Audio - iCON V1-M\n                      iCON V1-M at usb-0000:00:14.0-2, full speed\n";
        assert_eq!(parse_cards(t), vec![(0, "HDA Intel PCH".to_string()), (1, "iCON V1-M".to_string())]);
        assert_eq!(parse_dev_name("midiC1D0"), Some((1, 0)));
        assert_eq!(parse_dev_name("controlC0"), None);
        assert_eq!(parse_dev_name("midiC1"), None);
    }

    /// Eine Named Pipe, mit O_RDWR geöffnet, ist ein Rückkanal: was geschrieben wird, kommt wieder heraus — wie ein Pult im Echo-Betrieb.
    #[test]
    fn loopback_and_reconnect() {
        let dir = std::env::temp_dir().join(format!("omp-midi-raw-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("midi");
        let c = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
        // SAFETY: gültiger C-String, Modus 0600
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        let mut p = RawPort::open(path.to_str().unwrap(), "fifo");
        let t = Instant::now();
        while !p.is_up() && t.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(p.is_up());
        p.send_batch(&[vec![0x90, 0x10, 0x7f], vec![0xe0, 0, 64]]);
        let mut got = vec![];
        let t = Instant::now();
        while got.len() < 6 && t.elapsed() < Duration::from_secs(3) {
            for c in p.recv() {
                got.extend(c);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(got, vec![0x90, 0x10, 0x7f, 0xe0, 0, 64]);
        drop(p);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_device_stays_down() {
        let p = RawPort::open("/dev/snd/midiC99D99", "none");
        std::thread::sleep(Duration::from_millis(100));
        assert!(!p.is_up());
    }
}
