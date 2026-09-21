//! ICE hinter einer NAT-Grenze (Nachtrag 245). Läuft der Node in einem
//! Container/einer VM mit privatem Netz (z. B. dem ChromeOS-Linux-Container
//! `100.115.92.x`), meldet `webrtcbin` dem Browser nur dessen interne
//! Adressen — ein Handy im WLAN erreicht sie nicht, die Medien kommen nie an.
//! Abhilfe ohne TURN:
//! - `OMP_WEBRTC_ICE_PORT=<udp-port>`: libnice bindet genau diesen einen
//!   UDP-Port (BUNDLE + rtcp-mux → ein Port je Sitzung), sodass er auf dem
//!   Host per Portweiterleitung erreichbar gemacht werden kann.
//! - `OMP_WEBRTC_PUBLIC_IP=<ip>`: die Adresse der UDP-Host-Kandidaten in der
//!   SDP-Antwort wird durch die von außen erreichbare Adresse des Hosts
//!   ersetzt (Port bleibt, daher muss der weitergeleitete Port gleich sein).
//!
//! Ohne beide Variablen ändert sich nichts.

use gstreamer as gst;
use gstreamer::prelude::*;

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

/// Legt den festen UDP-Port am ICE-Agenten von `webrtcbin` fest (falls
/// konfiguriert) und schaltet ICE-TCP ab (würde nur zusätzliche, ebenfalls
/// unerreichbare Kandidaten erzeugen).
pub fn configure(webrtcbin: &gst::Element) {
    let Some(port) = env_nonempty("OMP_WEBRTC_ICE_PORT").and_then(|p| p.parse::<u32>().ok()) else {
        return;
    };
    let ice = webrtcbin.property::<gst::Object>("ice-agent");
    ice.set_property("min-rtp-port", port);
    ice.set_property("max-rtp-port", port);
    ice.set_property("ice-tcp", false);
}

/// Ersetzt die Adresse der IPv4-UDP-Host-Kandidaten durch
/// `OMP_WEBRTC_PUBLIC_IP` und entfernt alle anderen Kandidaten (TCP, IPv6,
/// Link-Local — vom Handy aus ohnehin nicht erreichbar). Ohne Variable oder
/// ohne passenden Kandidaten bleibt die SDP unverändert.
pub fn rewrite_candidates(sdp: &str) -> String {
    match env_nonempty("OMP_WEBRTC_PUBLIC_IP") {
        Some(ip) => rewrite_with(sdp, &ip),
        None => sdp.to_string(),
    }
}

fn rewrite_with(sdp: &str, public_ip: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut seen_per_media: Vec<String> = Vec::new();
    let mut any = false;
    for line in sdp.split("\r\n") {
        if let Some(rest) = line.strip_prefix("a=candidate:") {
            let f: Vec<&str> = rest.split(' ').collect();
            let usable = f.len() >= 8
                && f[2].eq_ignore_ascii_case("udp")
                && f[4].contains('.')
                && f[6] == "typ"
                && f[7] == "host";
            if usable {
                let rewritten = format!(
                    "a=candidate:{} {} {} {} {} {} typ host",
                    f[0], f[1], f[2], f[3], public_ip, f[5]
                );
                // Je m-Line jeden Kandidaten nur einmal (mehrere lokale
                // Interfaces liefern sonst identische Einträge).
                if !seen_per_media.contains(&rewritten) {
                    seen_per_media.push(rewritten.clone());
                    out.push(rewritten);
                    any = true;
                }
            }
            continue;
        }
        if line.starts_with("m=") {
            seen_per_media.clear();
        }
        out.push(line.to_string());
    }
    if !any {
        return sdp.to_string();
    }
    out.join("\r\n")
}

#[cfg(test)]
mod tests {
    use super::rewrite_with;

    #[test]
    fn keeps_only_udp_ipv4_host_candidates_and_swaps_address() {
        let sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\n\
a=candidate:1 1 UDP 2015363327 2001:db8::1 45992 typ host\r\n\
a=candidate:2 1 TCP 1015021823 100.115.92.203 9 typ host tcptype active\r\n\
a=candidate:4 1 UDP 2015363583 100.115.92.203 58828 typ host\r\n\
a=candidate:7 1 UDP 2015363839 fe80::1 51362 typ host\r\n\
a=sendonly\r\n";
        let out = rewrite_with(sdp, "192.168.1.50");
        assert!(out.contains("a=candidate:4 1 UDP 2015363583 192.168.1.50 58828 typ host"));
        assert!(!out.contains("2001:db8"));
        assert!(!out.contains("tcptype"));
        assert!(!out.contains("100.115.92.203"));
        assert!(!out.contains("fe80"));
        assert!(out.contains("a=sendonly"));
    }

    #[test]
    fn unchanged_without_usable_candidate() {
        let sdp = "v=0\r\na=candidate:2 1 TCP 1 100.115.92.203 9 typ host tcptype active\r\n";
        assert_eq!(rewrite_with(sdp, "1.2.3.4"), sdp);
    }
}
