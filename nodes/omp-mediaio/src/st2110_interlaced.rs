//! RFC-4175-Entpacker für Halbbild-Ströme (ST 2110-20 mit `interlace`): setzt zwei Halbbilder zu einem Vollbild mit
//! verschränkten Zeilen zusammen. GStreamers `rtpvrawdepay` lehnt Halbbilder ab („interlaced formats not supported yet“,
//! 1.22), der Payloader (`rtpvrawpay`) sendet sie aber — deshalb nur dieses Gegenstück.
//!
//! Paketaufbau (RFC 4175 §4.3): 12-Byte-RTP-Kopf, 2 Byte erweiterte Sequenznummer, dann je Zeilenabschnitt 6 Byte Kopf
//! (Länge 16 Bit; F-Bit + Zeilennummer 15 Bit; C-Bit + Versatz 15 Bit), solange C gesetzt ist; danach die Nutzdaten der
//! Abschnitte in dieser Reihenfolge. Die Zeilennummer zählt innerhalb des Halbbilds (F = 0 oberes, 1 unteres). Bei
//! „oberes Halbbild zuerst“ ist Vollbildzeile = 2·Zeilennummer + F.
//!
//! Grenzen: nur 4:2:2 mit 8 Bit (`UYVY`, 4 Byte je 2 Pixel) und 10 Bit (`UYVP`, 5 Byte je 2 Pixel); ein Vollbild wird beim
//! Marker-Paket des zweiten Halbbilds ausgegeben; fehlt davon etwas, bleiben die Zeilen des Vorbilds stehen (kein Absturz).

use gstreamer_video::{VideoFormat, VideoInfo};

pub struct InterlacedAssembler {
    width: usize,
    height: usize,
    pgroup: usize,
    stride: usize,
    frame: Vec<u8>,
    /// Zähler: unvollständig verworfene Vollbilder (F=0 begann, bevor das vorige fertig war) und fehlerhafte Pakete.
    pub dropped_frames: u64,
    pub bad_packets: u64,
    got_top: bool,
}

impl InterlacedAssembler {
    pub fn new(width: usize, height: usize, depth: u8) -> Result<Self, String> {
        let (format, pgroup) = match depth {
            8 => (VideoFormat::Uyvy, 4),
            10 => (VideoFormat::Uyvp, 5),
            d => return Err(format!("Halbbild: Bittiefe {d} nicht unterstützt (8 oder 10)")),
        };
        if width % 2 != 0 || height % 2 != 0 {
            return Err("Halbbild: Breite und Höhe müssen gerade sein".into());
        }
        let info = VideoInfo::builder(format, width as u32, height as u32).build().map_err(|e| format!("VideoInfo: {e}"))?;
        let stride = info.stride()[0] as usize;
        Ok(Self { width, height, pgroup, stride, frame: vec![0; info.size()], dropped_frames: 0, bad_packets: 0, got_top: false })
    }

    /// Größe eines Vollbilds in Byte.
    pub fn frame_size(&self) -> usize {
        self.frame.len()
    }

    /// Ein RTP-Paket (mit Kopf) einarbeiten. Gibt das fertige Vollbild zurück, wenn dieses Paket das letzte des zweiten
    /// Halbbilds war (Marker-Bit).
    pub fn push(&mut self, rtp: &[u8]) -> Option<Vec<u8>> {
        if rtp.len() < 14 {
            self.bad_packets += 1;
            return None;
        }
        let marker = rtp[1] & 0x80 != 0;
        let mut p = 12 + 2; // RTP-Kopf + erweiterte Sequenznummer
        let mut sections = Vec::new();
        let mut last_f = 0u8;
        loop {
            if p + 6 > rtp.len() {
                self.bad_packets += 1;
                return None;
            }
            let len = u16::from_be_bytes([rtp[p], rtp[p + 1]]) as usize;
            let f = rtp[p + 2] >> 7;
            let line = (u16::from_be_bytes([rtp[p + 2], rtp[p + 3]]) & 0x7FFF) as usize;
            let cont = rtp[p + 4] >> 7 != 0;
            let off = (u16::from_be_bytes([rtp[p + 4], rtp[p + 5]]) & 0x7FFF) as usize;
            sections.push((len, f, line, off));
            last_f = f;
            p += 6;
            if !cont {
                break;
            }
        }
        for (len, f, line, off) in sections {
            if p + len > rtp.len() {
                self.bad_packets += 1;
                return None;
            }
            if f == 0 && !self.got_top && line == 0 && off == 0 {
                // neues Vollbild beginnt
            }
            let y = 2 * line + f as usize;
            let x_bytes = off / 2 * self.pgroup;
            let dst = y * self.stride + x_bytes;
            if y >= self.height || off >= self.width || x_bytes + len > self.stride || dst + len > self.frame.len() {
                self.bad_packets += 1;
                p += len;
                continue;
            }
            self.frame[dst..dst + len].copy_from_slice(&rtp[p..p + len]);
            p += len;
            if f == 0 {
                self.got_top = true;
            }
        }
        if marker && last_f == 1 {
            let out = self.frame.clone();
            if !self.got_top {
                self.dropped_frames += 1; // unteres Halbbild ohne oberes
            }
            self.got_top = false;
            return Some(out);
        }
        None
    }
}

/// Korrigiert die Zeilennummern eines von `rtpvrawpay` erzeugten Halbbild-Pakets nach RFC 4175: GStreamer trägt die Nummer
/// der VOLLBILD-Zeile ein (F = 0 gerade, F = 1 ungerade Zeilen), der RFC verlangt die Zeile INNERHALB des Halbbilds
/// (Vollbildzeile / 2). Ein Fremdempfänger würde sonst jedes Halbbild an die falsche Stelle setzen. Gibt `false` bei einem
/// unlesbaren Paket zurück (dann unverändert).
pub fn fix_payloader_line_numbers(rtp: &mut [u8]) -> bool {
    if rtp.len() < 14 {
        return false;
    }
    let mut p = 14;
    let mut heads = Vec::new();
    loop {
        if p + 6 > rtp.len() {
            return false;
        }
        let cont = rtp[p + 4] >> 7 != 0;
        heads.push(p);
        p += 6;
        if !cont {
            break;
        }
    }
    for h in heads {
        let f = rtp[h + 2] & 0x80;
        let line = u16::from_be_bytes([rtp[h + 2], rtp[h + 3]]) & 0x7FFF;
        let new = (line >> 1) | ((f as u16) << 8);
        rtp[h + 2..h + 4].copy_from_slice(&new.to_be_bytes());
    }
    true
}

#[cfg(all(test, feature = "mxl"))]
mod tests {
    use super::*;
    use gstreamer as gst;
    use gst::prelude::*;
    use gstreamer_app as gst_app;
    use std::sync::{Arc, Mutex};

    /// Erzeugt mit dem echten `rtpvrawpay` ein Halbbild und vergleicht das zusammengesetzte Bild bytegenau mit dem Original.
    fn roundtrip(depth: u8) {
        gst::init().unwrap();
        let (fmt, w, h) = (if depth == 10 { "UYVP" } else { "UYVY" }, 160usize, 90usize);
        let p = gst::parse::launch(&format!(
            "videotestsrc num-buffers=1 pattern=ball ! video/x-raw,width={w},height={h},framerate=25/1 ! videoconvert ! \
             video/x-raw,format={fmt} ! capssetter caps=\"video/x-raw,interlace-mode=interleaved,field-order=top-field-first\" \
             join=true replace=false ! tee name=t ! queue ! rtpvrawpay mtu=500 name=pay ! appsink name=rtp sync=false emit-signals=true t. ! queue ! appsink name=raw sync=false emit-signals=true"
        ))
        .unwrap()
        .downcast::<gst::Pipeline>()
        .unwrap();
        let rtp = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let raw = Arc::new(Mutex::new(None::<Vec<u8>>));
        let r1 = rtp.clone();
        p.by_name("rtp").unwrap().downcast::<gst_app::AppSink>().unwrap().set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |s| {
                    let sample = s.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    if let Some(list) = sample.buffer_list() {
                        for b in list.iter() {
                            r1.lock().unwrap().push(b.map_readable().unwrap().to_vec());
                        }
                    } else if let Some(b) = sample.buffer() {
                        r1.lock().unwrap().push(b.map_readable().unwrap().to_vec());
                    }
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );
        let r2 = raw.clone();
        p.by_name("raw").unwrap().downcast::<gst_app::AppSink>().unwrap().set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |s| {
                    let sample = s.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    *r2.lock().unwrap() = Some(sample.buffer().unwrap().map_readable().unwrap().to_vec());
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );
        p.set_state(gst::State::Playing).unwrap();
        let bus = p.bus().unwrap();
        let _ = bus.timed_pop_filtered(gst::ClockTime::from_seconds(10), &[gst::MessageType::Eos, gst::MessageType::Error]);
        p.set_state(gst::State::Null).unwrap();

        let packets = rtp.lock().unwrap().clone();
        assert!(packets.len() > 4, "zu wenige Pakete: {}", packets.len());
        let mut asm = InterlacedAssembler::new(w, h, depth).unwrap();
        let mut frames = Vec::new();
        for pk in &packets {
            let mut pk = pk.clone();
            assert!(fix_payloader_line_numbers(&mut pk));
            if let Some(f) = asm.push(&pk) {
                frames.push(f);
            }
        }
        assert_eq!(frames.len(), 1, "genau ein Vollbild erwartet, bad={} dropped={}", asm.bad_packets, asm.dropped_frames);
        let original = raw.lock().unwrap().clone().unwrap();
        assert_eq!(frames[0].len(), original.len());
        if frames[0] != original {
            let stride = original.len() / h;
            let bad: Vec<usize> = (0..h).filter(|y| frames[0][y * stride..(y + 1) * stride] != original[y * stride..(y + 1) * stride]).collect();
            let fs: Vec<String> = packets.iter().enumerate().filter(|(i, _)| *i < 6 || *i > packets.len() - 4).map(|(_, pk)| {
                let (l, f, ln, c, o) = (u16::from_be_bytes([pk[14], pk[15]]), pk[16] >> 7, u16::from_be_bytes([pk[16], pk[17]]) & 0x7FFF, pk[18] >> 7, u16::from_be_bytes([pk[18], pk[19]]) & 0x7FFF);
                format!("len{l} F{f} line{ln} c{c} off{o} m{}", pk[1] >> 7)
            }).collect();
            panic!("Bild weicht ab (depth={depth}); abweichende Zeilen {} von {h}: {:?}; Pakete {fs:?}; stride {stride}", bad.len(), &bad[..bad.len().min(12)]);
        }
        assert_eq!(asm.bad_packets, 0);
    }

    #[test]
    fn eight_bit_interlaced_frame_matches_original() {
        roundtrip(8);
    }

    #[test]
    fn ten_bit_interlaced_frame_matches_original() {
        roundtrip(10);
    }

    #[test]
    fn garbage_is_counted_not_fatal() {
        gst::init().unwrap();
        let mut a = InterlacedAssembler::new(160, 90, 8).unwrap();
        assert!(a.push(&[0u8; 5]).is_none());
        assert!(a.push(&[0x80; 40]).is_none());
        assert!(a.bad_packets >= 1);
    }
}
