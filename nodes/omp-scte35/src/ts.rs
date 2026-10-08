//! MPEG-2-Transportstrom für SCTE 35 (Kapitel 37): ein Sidecar-Strom aus PAT, PMT (Stream-Typ 0x86,
//! `CUEI`-Registrierung) und den `splice_info_section`s auf einer festen PID — 188-Byte-Pakete mit
//! Continuity Counter. Reine Funktionen; die Ausgabe (UDP/SRT) steht in `main.rs`.

use crate::splice::crc32_mpeg;

pub const PACKET: usize = 188;
pub const PAT_PID: u16 = 0;
pub const PMT_PID: u16 = 0x1000;
pub const STREAM_TYPE_SCTE35: u8 = 0x86;
const PROGRAM: u16 = 1;
const TS_ID: u16 = 1;

/// Continuity Counter je PID.
#[derive(Default)]
pub struct Counters {
    pat: u8,
    pmt: u8,
    scte: u8,
}

fn next(cc: &mut u8) -> u8 {
    let v = *cc;
    *cc = (*cc + 1) & 0x0F;
    v
}

/// Verpackt einen PSI-Abschnitt in TS-Pakete (Pointer-Field 0, Rest mit 0xFF aufgefüllt).
fn packetize(section: &[u8], pid: u16, cc: &mut u8) -> Vec<[u8; PACKET]> {
    let mut data = Vec::with_capacity(section.len() + 1);
    data.push(0); // pointer_field
    data.extend_from_slice(section);
    let mut out = Vec::new();
    for (i, chunk) in data.chunks(PACKET - 4).enumerate() {
        let mut p = [0xFFu8; PACKET];
        p[0] = 0x47;
        p[1] = ((i == 0) as u8) << 6 | ((pid >> 8) as u8 & 0x1F);
        p[2] = pid as u8;
        p[3] = 0x10 | next(cc); // nur Nutzdaten
        p[4..4 + chunk.len()].copy_from_slice(chunk);
        out.push(p);
    }
    out
}

fn psi(table_id: u8, id: u16, body: &[u8]) -> Vec<u8> {
    let section_length = 5 + body.len() + 4;
    let mut s = vec![table_id, 0xB0 | ((section_length >> 8) as u8 & 0x0F), section_length as u8];
    s.extend_from_slice(&id.to_be_bytes());
    s.push(0xC1); // Version 0, current_next 1
    s.extend_from_slice(&[0, 0]); // section_number, last_section_number
    s.extend_from_slice(body);
    let crc = crc32_mpeg(&s);
    s.extend_from_slice(&crc.to_be_bytes());
    s
}

pub fn pat(c: &mut Counters) -> Vec<[u8; PACKET]> {
    let mut body = Vec::new();
    body.extend_from_slice(&PROGRAM.to_be_bytes());
    body.extend_from_slice(&(0xE000 | PMT_PID).to_be_bytes());
    packetize(&psi(0x00, TS_ID, &body), PAT_PID, &mut c.pat)
}

pub fn pmt(c: &mut Counters, scte_pid: u16) -> Vec<[u8; PACKET]> {
    let mut body = Vec::new();
    body.extend_from_slice(&0xFFFFu16.to_be_bytes()); // reserved + PCR_PID 0x1FFF (kein PCR)
    let prog_desc = [0x05, 0x04, b'C', b'U', b'E', b'I']; // registration_descriptor
    body.extend_from_slice(&(0xF000 | prog_desc.len() as u16).to_be_bytes());
    body.extend_from_slice(&prog_desc);
    body.push(STREAM_TYPE_SCTE35);
    body.extend_from_slice(&(0xE000 | scte_pid).to_be_bytes());
    body.extend_from_slice(&0xF000u16.to_be_bytes()); // ES_info_length 0
    packetize(&psi(0x02, PROGRAM, &body), PMT_PID, &mut c.pmt)
}

pub fn scte35(c: &mut Counters, scte_pid: u16, section: &[u8]) -> Vec<[u8; PACKET]> {
    packetize(section, scte_pid, &mut c.scte)
}

/// Ergebnis der Prüfung eines Stroms (Tests, Selbstcheck).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Parsed {
    pub pmt_pid: Option<u16>,
    pub streams: Vec<(u8, u16)>,
    pub sections: Vec<Vec<u8>>,
}

/// Liest PAT/PMT und setzt die Abschnitte der SCTE-35-PID wieder zusammen. Prüft Sync-Byte, CC, CRC.
pub fn parse(stream: &[u8]) -> Result<Parsed, String> {
    if stream.len() % PACKET != 0 {
        return Err("Länge ist kein Vielfaches von 188".to_string());
    }
    let mut out = Parsed::default();
    let mut last_cc: std::collections::HashMap<u16, u8> = Default::default();
    let mut bufs: std::collections::HashMap<u16, Vec<u8>> = Default::default();
    for p in stream.chunks(PACKET) {
        if p[0] != 0x47 {
            return Err("Sync-Byte fehlt".to_string());
        }
        let pid = ((p[1] as u16 & 0x1F) << 8) | p[2] as u16;
        let pusi = p[1] & 0x40 != 0;
        let cc = p[3] & 0x0F;
        if let Some(prev) = last_cc.insert(pid, cc)
            && cc != (prev + 1) & 0x0F
        {
            return Err(format!("Continuity-Counter-Sprung auf PID {pid}"));
        }
        let payload = &p[4..];
        let buf = bufs.entry(pid).or_default();
        if pusi {
            buf.clear();
            buf.extend_from_slice(&payload[1..]); // pointer_field = 0 vorausgesetzt
        } else {
            buf.extend_from_slice(payload);
        }
        // vollständig, sobald section_length erreicht ist
        if buf.len() >= 3 {
            let len = (((buf[1] & 0x0F) as usize) << 8 | buf[2] as usize) + 3;
            if buf.len() >= len {
                let sec = buf[..len].to_vec();
                buf.clear();
                if crc32_mpeg(&sec) != 0 {
                    return Err(format!("CRC falsch auf PID {pid}"));
                }
                match (pid, sec[0]) {
                    (PAT_PID, 0x00) => out.pmt_pid = Some(((sec[10] as u16 & 0x1F) << 8) | sec[11] as u16),
                    (_, 0x02) => {
                        let pil = ((sec[10] as usize & 0x0F) << 8) | sec[11] as usize;
                        let mut i = 12 + pil;
                        while i + 5 <= sec.len() - 4 {
                            let el = ((sec[i + 3] as usize & 0x0F) << 8) | sec[i + 4] as usize;
                            out.streams.push((sec[i], ((sec[i + 1] as u16 & 0x1F) << 8) | sec[i + 2] as u16));
                            i += 5 + el;
                        }
                    }
                    (_, 0xFC) => out.sections.push(sec),
                    _ => {}
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cue::Cue;

    fn flat(v: Vec<[u8; PACKET]>) -> Vec<u8> {
        v.into_iter().flatten().collect()
    }

    #[test]
    fn sidecar_stream_carries_pat_pmt_and_the_section() {
        let mut c = Counters::default();
        let sec = Cue::Out { event_id: 5, duration_ms: Some(30_000), auto_return: true, lead_ms: 4000 }.to_scte35(0).unwrap();
        let mut s = flat(pat(&mut c));
        s.extend(flat(pmt(&mut c, 500)));
        s.extend(flat(scte35(&mut c, 500, &sec)));
        let p = parse(&s).unwrap();
        assert_eq!(p.pmt_pid, Some(PMT_PID));
        assert_eq!(p.streams, vec![(0x86, 500)]);
        assert_eq!(p.sections, vec![sec]);
    }

    #[test]
    fn long_sections_span_packets_and_counters_continue() {
        let mut c = Counters::default();
        let sec = Cue::Signal { event_id: 1, type_id: 0x34, duration_ms: Some(1000), upid: vec![b'x'; 200], lead_ms: 0 }.to_scte35(0).unwrap();
        assert!(sec.len() > 184);
        let mut s = flat(scte35(&mut c, 500, &sec));
        s.extend(flat(scte35(&mut c, 500, &sec)));
        let p = parse(&s).unwrap();
        assert_eq!(p.sections.len(), 2);
        assert_eq!(p.sections[1], sec);
    }

    #[test]
    fn a_counter_gap_or_bad_crc_is_detected() {
        let mut c = Counters::default();
        let sec = Cue::Cancel { event_id: 1 }.to_scte35(0).unwrap();
        let mut a = flat(scte35(&mut c, 500, &sec));
        c.scte = (c.scte + 3) & 0x0F;
        a.extend(flat(scte35(&mut c, 500, &sec)));
        assert!(parse(&a).unwrap_err().contains("Continuity"));
        let mut c = Counters::default();
        let mut b = flat(scte35(&mut c, 500, &sec));
        b[10] ^= 0xFF;
        assert!(parse(&b).is_err());
    }

    #[test]
    fn ffprobe_recognises_the_scte35_stream_when_available() {
        let Ok(out) = std::process::Command::new("ffprobe").arg("-version").output() else { return };
        if !out.status.success() {
            return;
        }
        let mut c = Counters::default();
        let sec = Cue::Out { event_id: 5, duration_ms: Some(30_000), auto_return: true, lead_ms: 0 }.to_scte35(0).unwrap();
        let mut s = Vec::new();
        for _ in 0..5 {
            s.extend(flat(pat(&mut c)));
            s.extend(flat(pmt(&mut c, 500)));
            s.extend(flat(scte35(&mut c, 500, &sec)));
        }
        let path = std::env::temp_dir().join(format!("omp-scte35-{}.ts", std::process::id()));
        std::fs::write(&path, &s).unwrap();
        let o = std::process::Command::new("ffprobe").args(["-v", "error", "-show_entries", "stream=codec_name,codec_type,id", "-of", "default=nw=1"]).arg(&path).output().unwrap();
        let _ = std::fs::remove_file(&path);
        let text = String::from_utf8_lossy(&o.stdout);
        assert!(text.contains("codec_name=scte_35"), "ffprobe: {text} / {}", String::from_utf8_lossy(&o.stderr));
        assert!(text.contains("id=0x1f4"), "PID 500 = 0x1f4: {text}");
    }
}
