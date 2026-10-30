//! ST 2110-40 (ANC über RTP, RFC 8331): MXL-Daten-Grain (`anc::mxl_grain`) → RTP-Pakete → UDP, samt Gegenstück zum Lesen (für
//! Rundlauf-Tests) und SDP-Text.
//!
//! **Stand: nur im Rundlauf geprüft** (Paketieren → Lesen, UDP auf Loopback). Mit echten ST-2110-40-Empfängern ist der Ausgang
//! **nicht** erprobt; Annahmen: ein Grain je Bild, ein RTP-Zeitstempel je Bild (90 kHz, aus der MXL-/TAI-Zeit des Grains),
//! Marker-Bit am letzten Paket des Bildes, auch leere Bilder senden ein Paket (ANC_Count 0). Nutzdaten-Aufbau je RTP-Paket:
//! `ESN(16) | Length(16) | ANC_Count(8) | F(2) + reserviert(22) | ANC-Pakete (auf 32 Bit aufgefüllt)`.
//!
//! Aufbau und Parität der einzelnen ANC-Pakete liefert [`crate::anc`].

use crate::anc::{self, AncPacket};

#[cfg(feature = "mxl")]
use std::net::UdpSocket;
#[cfg(feature = "mxl")]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(feature = "mxl")]
use std::sync::{Arc, Mutex};

#[cfg(feature = "mxl")]
use crate::mxl::{MxlContext, MxlDataInput};

/// Dynamischer RTP-Payload-Type des ANC-Stroms (im SDP bekanntgegeben).
pub const RTP_PT: u8 = 100;
/// Höchste RTP-Nutzlast (ohne RTP-Kopf), damit ein Paket in eine 1500-Byte-MTU passt.
pub const MAX_PAYLOAD: usize = 1200;
const RTP_HEADER: usize = 12;
/// ESN(2) + Length(2) + ANC_Count(1) + F/reserviert(3).
const ANC_HEADER: usize = 8;

/// Zerlegt Grains in RTP-Pakete; hält Folgenummer (32 Bit erweitert: unten RTP, oben ESN) und SSRC.
pub struct Packetizer {
    ssrc: u32,
    seq: u32,
}

impl Packetizer {
    pub fn new(ssrc: u32) -> Self {
        Packetizer { ssrc, seq: 0 }
    }

    /// Ein Bild (MXL-Daten-Grain) → ein oder mehrere RTP-Pakete. Ganze ANC-Pakete werden nie geteilt; passen sie nicht in
    /// [`MAX_PAYLOAD`], beginnt ein neues RTP-Paket. Das letzte Paket trägt das Marker-Bit.
    pub fn packetize(&mut self, grain: &[u8], timestamp: u32) -> Result<Vec<Vec<u8>>, String> {
        let packets = anc::parse_mxl_grain(grain)?;
        let field = grain.get(3).map_or(0, |b| b >> 6);
        let mut groups: Vec<(Vec<u8>, u8)> = vec![(Vec::new(), 0)];
        for p in &packets {
            let bytes = anc::rfc8331_packet(p)?;
            if ANC_HEADER + bytes.len() > MAX_PAYLOAD {
                return Err(format!("ANC-Paket mit {} Byte passt nicht in ein RTP-Paket", bytes.len()));
            }
            let last = groups.last_mut().expect("mindestens eine Gruppe");
            if ANC_HEADER + last.0.len() + bytes.len() > MAX_PAYLOAD {
                groups.push((bytes, 1));
            } else {
                last.0.extend_from_slice(&bytes);
                last.1 += 1;
            }
        }
        let n = groups.len();
        let mut out = Vec::with_capacity(n);
        for (i, (body, count)) in groups.into_iter().enumerate() {
            let mut pkt = Vec::with_capacity(RTP_HEADER + ANC_HEADER + body.len());
            pkt.push(0x80);
            pkt.push(((i + 1 == n) as u8) << 7 | RTP_PT);
            pkt.extend_from_slice(&(self.seq as u16).to_be_bytes());
            pkt.extend_from_slice(&timestamp.to_be_bytes());
            pkt.extend_from_slice(&self.ssrc.to_be_bytes());
            pkt.extend_from_slice(&((self.seq >> 16) as u16).to_be_bytes()); // ESN
            pkt.extend_from_slice(&(body.len() as u16).to_be_bytes());
            pkt.push(count);
            pkt.extend_from_slice(&[field << 6, 0, 0]);
            pkt.extend_from_slice(&body);
            out.push(pkt);
            self.seq = self.seq.wrapping_add(1);
        }
        Ok(out)
    }
}

/// Gelesenes RTP-Paket (Gegenstück zu [`Packetizer`]).
#[derive(Debug, PartialEq, Eq)]
pub struct ParsedRtp {
    /// Erweiterte Folgenummer (ESN << 16 | RTP-Folgenummer).
    pub seq: u32,
    pub timestamp: u32,
    pub ssrc: u32,
    pub marker: bool,
    pub field: u8,
    pub packets: Vec<AncPacket>,
}

pub fn parse_rtp(pkt: &[u8]) -> Result<ParsedRtp, String> {
    if pkt.len() < RTP_HEADER + ANC_HEADER {
        return Err("RTP-Paket zu kurz".to_string());
    }
    if pkt[0] >> 6 != 2 {
        return Err("RTP-Version ist nicht 2".to_string());
    }
    if pkt[0] & 0x3F != 0 {
        return Err("Padding/Erweiterung/CSRC werden nicht unterstützt".to_string());
    }
    if pkt[1] & 0x7F != RTP_PT {
        return Err(format!("unerwarteter Payload-Type {}", pkt[1] & 0x7F));
    }
    let payload = &pkt[RTP_HEADER..];
    let esn = u16::from_be_bytes([payload[0], payload[1]]) as u32;
    // Gleiches Format wie der MXL-Grain: Length | Count | F/reserviert | Pakete
    let packets = anc::parse_mxl_grain(&payload[2..])?;
    Ok(ParsedRtp {
        seq: esn << 16 | u16::from_be_bytes([pkt[2], pkt[3]]) as u32,
        timestamp: u32::from_be_bytes([pkt[4], pkt[5], pkt[6], pkt[7]]),
        ssrc: u32::from_be_bytes([pkt[8], pkt[9], pkt[10], pkt[11]]),
        marker: pkt[1] >> 7 == 1,
        field: payload[5] >> 6,
        packets,
    })
}

/// 90-kHz-RTP-Zeitstempel aus einer MXL-Zeit (TAI, ns).
pub fn rtp_timestamp(tai_ns: u64) -> u32 {
    ((tai_ns as u128 * 90_000 / 1_000_000_000) & 0xFFFF_FFFF) as u32
}

/// TTL der Multicast-Pakete (Socket) und im SDP (`c=`-Zeile) — beides muss übereinstimmen.
pub const MULTICAST_TTL: u32 = 16;

/// Angaben für das SDP, die vom Netz abhängen.
#[derive(Default, Clone, Debug)]
pub struct SdpOptions {
    /// Absenderadresse (`o=`, `a=source-filter`); `None` = unbekannt.
    pub origin_ip: Option<String>,
    /// PTP-Zeitbasis aktiv (`OMP_PTP_DOMAIN`): `a=ts-refclk:ptp=…`. Ohne Domäne: `localmac=` aus `mac`.
    pub ptp: bool,
    /// MAC der Sendeschnittstelle für `ts-refclk:localmac=` (Format `aa-bb-cc-dd-ee-ff`).
    pub mac: Option<String>,
}

fn is_multicast(host: &str) -> bool {
    host.split('.').next().and_then(|f| f.parse::<u8>().ok()).is_some_and(|f| (224..=239).contains(&f))
}

/// SDP für den ANC-Strom (ST 2110-40 / RFC 8331). `did_sdid` je Paar wie `0x61,0x01` (CEA-708-CDP).
///
/// Uhr (`a=ts-refclk`): mit `ptp` → `ptp=IEEE1588-2008:traceable` (die Großmeister-ID kennt der Node nicht, die Domäne gehört nicht in
/// diese Form); ohne PTP → `localmac=<MAC>` falls bekannt, sonst entfällt die Zeile. Bei Multicast mit bekannter Absenderadresse kommt
/// ein Quellenfilter (`a=source-filter`) dazu.
pub fn sdp(name: &str, dest_host: &str, port: u16, did_sdid: &[(u8, u8)], opts: &SdpOptions) -> String {
    let multicast = is_multicast(dest_host);
    let origin = opts.origin_ip.as_deref().unwrap_or("0.0.0.0");
    let pairs: Vec<String> = did_sdid.iter().map(|(d, s)| format!("DID_SDID={{0x{d:02X},0x{s:02X}}}")).collect();
    let mut s = String::new();
    s.push_str("v=0\r\n");
    s.push_str(&format!("o=- 0 0 IN IP4 {origin}\r\n"));
    s.push_str(&format!("s={name}\r\n"));
    s.push_str("t=0 0\r\n");
    s.push_str(&format!("m=video {port} RTP/AVP {RTP_PT}\r\n"));
    s.push_str(&format!("c=IN IP4 {}\r\n", if multicast { format!("{dest_host}/{MULTICAST_TTL}") } else { dest_host.to_string() }));
    if multicast && let Some(src) = &opts.origin_ip {
        s.push_str(&format!("a=source-filter: incl IN IP4 {dest_host} {src}\r\n"));
    }
    s.push_str(&format!("a=rtpmap:{RTP_PT} smpte291/90000\r\n"));
    s.push_str(&format!("a=fmtp:{RTP_PT} {}\r\n", pairs.join(";")));
    if opts.ptp {
        s.push_str("a=ts-refclk:ptp=IEEE1588-2008:traceable\r\n");
    } else if let Some(mac) = &opts.mac {
        s.push_str(&format!("a=ts-refclk:localmac={mac}\r\n"));
    }
    s.push_str("a=mediaclk:direct=0\r\n");
    s
}

/// Lokale IPv4-Adresse, über die `dest_host` erreicht würde (sendet nichts), und die MAC der zugehörigen Schnittstelle.
pub fn local_route_info(dest_host: &str) -> (Option<String>, Option<String>) {
    let probe_target = if is_multicast(dest_host) { "8.8.8.8" } else { dest_host };
    let ip = std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| s.connect((probe_target, 9)).map(|()| s))
        .and_then(|s| s.local_addr())
        .ok()
        .map(|a| a.ip().to_string())
        .filter(|ip| ip != "0.0.0.0");
    let mac = ip.as_deref().and_then(mac_of_ip);
    (ip, mac)
}

/// MAC der Schnittstelle mit der IPv4-Adresse `ip` (Linux: `/sys/class/net`, Adresse aus `/proc/net/fib_trie` ist aufwendig, daher über
/// `/proc/net/route`: Schnittstelle der Standardroute, wenn keine bessere Zuordnung möglich ist).
fn mac_of_ip(_ip: &str) -> Option<String> {
    let route = std::fs::read_to_string("/proc/net/route").ok()?;
    let iface = route.lines().skip(1).find_map(|l| {
        let f: Vec<&str> = l.split_whitespace().collect();
        (f.len() > 2 && f[1] == "00000000").then(|| f[0].to_string())
    })?;
    let mac = std::fs::read_to_string(format!("/sys/class/net/{iface}/address")).ok()?;
    let mac = mac.trim();
    (mac.len() == 17 && mac != "00:00:00:00:00:00").then(|| mac.replace(':', "-"))
}

#[cfg(feature = "mxl")]
fn grain_rate(def: &str) -> (u32, u32) {
    serde_json::from_str::<serde_json::Value>(def)
        .ok()
        .and_then(|v| Some((v.get("grain_rate")?.get("numerator")?.as_u64()? as u32, v.get("grain_rate")?.get("denominator").and_then(|d| d.as_u64()).unwrap_or(1) as u32)))
        .filter(|(n, d)| *n > 0 && *d > 0)
        .unwrap_or((25, 1))
}

#[cfg(feature = "mxl")]
/// MXL-Daten-Flow → ST-2110-40-RTP über UDP. Ein Lese-Thread (aus [`MxlDataInput`]) schickt je Grain die RTP-Pakete.
pub struct St2110AncOutput {
    _input: MxlDataInput,
    pub frames: Arc<AtomicU64>,
    pub packets: Arc<AtomicU64>,
    pub errors: Arc<AtomicU64>,
}

#[cfg(feature = "mxl")]
impl St2110AncOutput {
    pub fn new(context: Arc<MxlContext>, flow_id: &str, dest_host: &str, dest_port: u16, ssrc: u32) -> Result<Self, String> {
        let (num, den) = grain_rate(&context.flow_def(flow_id)?);
        let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("UDP-Socket: {e}"))?;
        let _ = socket.set_multicast_ttl_v4(MULTICAST_TTL);
        socket.connect((dest_host, dest_port)).map_err(|e| format!("UDP-Ziel {dest_host}:{dest_port}: {e}"))?;
        let packetizer = Mutex::new(Packetizer::new(ssrc));
        let (frames, packets, errors) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
        let (f, p, e) = (frames.clone(), packets.clone(), errors.clone());
        let ctx = context.clone();
        let input = MxlDataInput::new_indexed(context, flow_id, move |index, grain| {
            let ts = rtp_timestamp(ctx.index_to_ns(index, num, den).unwrap_or_else(|| ctx.now_ns()));
            match packetizer.lock().expect("lock poisoned").packetize(grain, ts) {
                Ok(pkts) => {
                    for pkt in pkts {
                        if socket.send(&pkt).is_ok() {
                            p.fetch_add(1, Ordering::Relaxed);
                        } else {
                            e.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    f.fetch_add(1, Ordering::Relaxed);
                }
                Err(_) => {
                    e.fetch_add(1, Ordering::Relaxed);
                }
            }
        })?;
        Ok(St2110AncOutput { _input: input, frames, packets, errors })
    }

    /// Hat der Flow Grains geliefert?
    pub fn flowed(&self) -> bool {
        self._input.flowed_handle().load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(feature = "mxl")]
    use std::net::UdpSocket;

    fn pkt(did: u8, n: usize) -> AncPacket {
        AncPacket { c_not_y: false, line: 9, offset: 0, did, sdid: 1, udw: (0..n).map(|i| (i * 7 + 3) as u8).collect() }
    }

    #[test]
    fn roundtrip_single_packet_has_marker_and_fields() {
        let grain = anc::mxl_grain(&[pkt(0x61, 40)]).unwrap();
        let mut p = Packetizer::new(0xAABBCCDD);
        let out = p.packetize(&grain, 123456).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0][0], 0x80);
        assert_eq!(out[0][1], 0x80 | RTP_PT, "Marker + Payload-Type");
        let r = parse_rtp(&out[0]).unwrap();
        assert_eq!((r.seq, r.timestamp, r.ssrc, r.marker), (0, 123456, 0xAABBCCDD, true));
        assert_eq!(r.packets, vec![pkt(0x61, 40)]);
    }

    #[test]
    fn empty_frame_still_sends_one_marked_packet() {
        let grain = anc::mxl_grain(&[]).unwrap();
        let out = Packetizer::new(1).packetize(&grain, 1).unwrap();
        assert_eq!(out.len(), 1);
        let r = parse_rtp(&out[0]).unwrap();
        assert!(r.marker && r.packets.is_empty());
        assert_eq!(out[0].len(), RTP_HEADER + ANC_HEADER);
    }

    #[test]
    fn large_frame_is_split_on_anc_packet_boundaries() {
        let packets: Vec<_> = (0..6).map(|i| pkt(0x60 + i, 200)).collect();
        let grain = anc::mxl_grain(&packets).unwrap();
        let out = Packetizer::new(7).packetize(&grain, 99).unwrap();
        assert!(out.len() >= 2, "{} Pakete", out.len());
        let mut got = Vec::new();
        for (i, o) in out.iter().enumerate() {
            assert!(o.len() - RTP_HEADER <= MAX_PAYLOAD);
            let r = parse_rtp(o).unwrap();
            assert_eq!(r.seq, i as u32);
            assert_eq!(r.marker, i + 1 == out.len(), "Marker nur am letzten");
            assert_eq!(r.timestamp, 99);
            got.extend(r.packets);
        }
        assert_eq!(got, packets);
    }

    #[test]
    fn sequence_carries_into_esn_after_16_bits() {
        let grain = anc::mxl_grain(&[]).unwrap();
        let mut p = Packetizer::new(1);
        p.seq = 0xFFFF;
        let a = parse_rtp(&p.packetize(&grain, 0).unwrap()[0]).unwrap();
        let b = parse_rtp(&p.packetize(&grain, 0).unwrap()[0]).unwrap();
        assert_eq!((a.seq, b.seq), (0xFFFF, 0x1_0000));
    }

    #[test]
    fn parser_rejects_damaged_input() {
        let grain = anc::mxl_grain(&[pkt(0x61, 10)]).unwrap();
        let mut out = Packetizer::new(1).packetize(&grain, 0).unwrap().remove(0);
        let mut bad = out.clone();
        bad[0] = 0x40;
        assert!(parse_rtp(&bad).is_err(), "Version");
        let last = out.len() - 6;
        out[last] ^= 0x10;
        assert!(parse_rtp(&out).is_err(), "Prüfsumme/Parität");
        assert!(parse_rtp(&[0x80; 10]).is_err(), "zu kurz");
    }

    #[test]
    fn rtp_timestamp_is_90khz_wrapping() {
        assert_eq!(rtp_timestamp(1_000_000_000), 90_000);
        assert_eq!(rtp_timestamp(40_000_000), 3_600);
        // 2^32 Ticks = 47721858844444 ns (abgerundet) → 0xFFFFFFFF; 1 ms später (+90 Ticks) läuft der Zähler über
        assert_eq!(rtp_timestamp(47_721_858_844_444), 0xFFFF_FFFF);
        assert_eq!(rtp_timestamp(47_721_858_844_444 + 1_000_000), 89);
    }

    #[test]
    fn sdp_names_smpte291_and_did_sdid() {
        let o = SdpOptions { origin_ip: Some("10.0.0.5".into()), ptp: false, mac: Some("aa-bb-cc-dd-ee-ff".into()) };
        let s = sdp("OMP ANC", "239.1.1.3", 6004, &[(0x61, 0x01)], &o);
        assert!(s.contains("m=video 6004 RTP/AVP 100"));
        assert!(s.contains("a=rtpmap:100 smpte291/90000"));
        assert!(s.contains("a=fmtp:100 DID_SDID={0x61,0x01}"));
        assert!(s.contains("c=IN IP4 239.1.1.3/16"), "TTL im SDP = TTL am Socket");
        assert!(s.contains("a=source-filter: incl IN IP4 239.1.1.3 10.0.0.5"));
        assert!(s.contains("a=ts-refclk:localmac=aa-bb-cc-dd-ee-ff"));
        assert!(s.contains("o=- 0 0 IN IP4 10.0.0.5"));
        assert!(s.contains("a=mediaclk:direct=0"));
    }

    #[test]
    fn sdp_uses_ptp_clock_when_enabled_and_omits_unknowns() {
        let s = sdp("x", "239.1.1.3", 6004, &[(0x61, 0x01), (0x41, 0x05)], &SdpOptions { ptp: true, ..Default::default() });
        assert!(s.contains("a=ts-refclk:ptp=IEEE1588-2008:traceable"));
        assert!(s.contains("DID_SDID={0x61,0x01};DID_SDID={0x41,0x05}"));
        assert!(!s.contains("source-filter") && !s.contains("localmac"));
        let u = sdp("x", "10.1.2.3", 6004, &[(0x61, 0x01)], &SdpOptions::default());
        assert!(u.contains("c=IN IP4 10.1.2.3\r\n") && !u.contains("ts-refclk"));
    }

    #[test]
    fn route_info_is_best_effort_and_never_panics() {
        let (ip, mac) = local_route_info("239.1.1.3");
        if let Some(mac) = mac {
            assert_eq!(mac.len(), 17);
            assert!(mac.contains('-'));
        }
        let _ = ip;
    }

    #[cfg(feature = "mxl")]
    #[test]
    fn udp_loopback_delivers_parseable_packets() {
        let rx = UdpSocket::bind("127.0.0.1:0").unwrap();
        rx.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
        let tx = UdpSocket::bind("127.0.0.1:0").unwrap();
        tx.connect(rx.local_addr().unwrap()).unwrap();
        let grain = anc::mxl_grain(&[pkt(0x61, 30)]).unwrap();
        for p in Packetizer::new(5).packetize(&grain, 42).unwrap() {
            tx.send(&p).unwrap();
        }
        let mut buf = [0u8; 2048];
        let n = rx.recv(&mut buf).unwrap();
        assert_eq!(parse_rtp(&buf[..n]).unwrap().packets, vec![pkt(0x61, 30)]);
    }

    #[cfg(feature = "mxl")]
    /// Ganze Kette über echtes MXL: Untertitel-Strom → `St2110AncOutput` → UDP → Lesen.
    #[test]
    fn mxl_flow_to_udp_roundtrip() {
        if !std::env::var("LD_LIBRARY_PATH").unwrap_or_default().contains("mxl") {
            return;
        }
        use crate::mxl::MxlDataOutput;
        let domain = std::env::temp_dir().join(format!("omp-mxl-anc40-{}", std::process::id()));
        std::fs::create_dir_all(&domain).unwrap();
        let ctx = Arc::new(MxlContext::new(&domain.to_string_lossy()).unwrap());
        let flow = "5a1b0000-0000-4000-8000-0000000000a4";
        let out = MxlDataOutput::new(ctx.clone(), flow, "Test ANC", "Test", 25, 1).unwrap();
        let rx = UdpSocket::bind("127.0.0.1:0").unwrap();
        rx.set_read_timeout(Some(std::time::Duration::from_secs(3))).unwrap();
        let port = rx.local_addr().unwrap().port();
        let sender = St2110AncOutput::new(ctx.clone(), flow, "127.0.0.1", port, 77).unwrap();

        let want = AncPacket { c_not_y: false, line: 9, offset: 0, did: 0x61, sdid: 0x01, udw: vec![0x96, 0x69, 0x10, 0x20, 0x30] };
        let grain = anc::mxl_grain(std::slice::from_ref(&want)).unwrap();
        let start = out.index_after_ns(0) + 1;
        let writer = std::thread::spawn(move || {
            for i in 0..60 {
                let _ = out.write_grain(start + i, &grain);
                out.sleep_until_index(start + i + 1);
            }
        });
        let mut seen = None;
        let mut buf = [0u8; 2048];
        let t0 = std::time::Instant::now();
        while t0.elapsed() < std::time::Duration::from_secs(5) && seen.is_none() {
            if let Ok(n) = rx.recv(&mut buf)
                && let Ok(r) = parse_rtp(&buf[..n])
                && !r.packets.is_empty()
            {
                seen = Some(r);
            }
        }
        writer.join().unwrap();
        let r = seen.expect("kein ANC-Paket über UDP angekommen");
        assert_eq!(r.packets, vec![want]);
        assert_eq!(r.ssrc, 77);
        assert!(r.marker);
        assert!(sender.frames.load(Ordering::Relaxed) > 0 && sender.errors.load(Ordering::Relaxed) == 0);
        let _ = std::fs::remove_dir_all(&domain);
    }
}
