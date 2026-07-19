//! Minimaler SDP-Parser für AES67/ST-2110-30-Audio (Kapitel 19 Teil 3),
//! exakt nach dem Vorbild von `omp-2110-gateway/src/sdp.rs` (dortige
//! Moduldoku: bewusst kein voller RFC-4566-Parser, nur die Felder, die
//! `St2110AudioInput` tatsächlich braucht). Feldformat exakt nach dem,
//! was `St2110AudioOutput::sdp` selbst erzeugt
//! (`nodes/omp-mediaio/src/st2110.rs`) und was AES67-/Dante-Geräte im
//! AES67-Modus laut Audinate-Doku senden (`a=rtpmap:96 L24/<rate>/
//! <channels>`).

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedAudioSdp {
    pub session_name: Option<String>,
    /// S. `omp-2110-gateway::sdp::ParsedVideoSdp::host`-Doku — gleiches
    /// TTL-Abschneiden.
    pub host: String,
    pub port: u16,
    pub sample_rate: i32,
    pub channels: i32,
}

pub fn parse_audio_sdp(sdp: &str) -> Result<ParsedAudioSdp, String> {
    let mut session_name: Option<String> = None;
    let mut host: Option<String> = None;
    let mut port: Option<u16> = None;
    let mut sample_rate: Option<i32> = None;
    let mut channels: Option<i32> = None;

    for line in sdp.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("s=") {
            session_name = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("c=IN IP4 ") {
            host = Some(rest.split('/').next().unwrap_or(rest).trim().to_string());
        } else if let Some(rest) = line.strip_prefix("m=audio ") {
            let port_token = rest.split_whitespace().next().ok_or("m=audio-Zeile ohne Port")?;
            port = Some(
                port_token
                    .parse()
                    .map_err(|e| format!("m=audio-Port '{port_token}' ungültig: {e}"))?,
            );
        } else if let Some(rest) = line.strip_prefix("a=rtpmap:") {
            // "<payload-type> L24/<rate>/<channels>"
            let Some((_, encoding)) = rest.split_once(' ') else { continue };
            let mut parts = encoding.trim().split('/');
            let codec = parts.next().unwrap_or("");
            if codec != "L24" {
                continue;
            }
            sample_rate = parts.next().and_then(|v| v.parse().ok());
            channels = parts.next().and_then(|v| v.parse().ok());
        }
    }

    Ok(ParsedAudioSdp {
        session_name,
        host: host.ok_or("SDP: keine c=IN IP4-Zeile gefunden")?,
        port: port.ok_or("SDP: keine m=audio-Zeile gefunden")?,
        sample_rate: sample_rate.ok_or("SDP: kein a=rtpmap:...L24/<rate>/<channels> gefunden")?,
        channels: channels.unwrap_or(2),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Echtes, von `St2110AudioOutput::sdp` erzeugtes SDP — Rundreise-
    /// Test wie beim Video-Pendant.
    #[test]
    fn parses_own_generated_sdp() {
        let sdp = "v=0\r\n\
             o=- 0 0 IN IP4 127.0.0.1\r\n\
             s=OpenMediaPlatform ST2110-30/AES67\r\n\
             c=IN IP4 127.0.0.1\r\n\
             t=0 0\r\n\
             m=audio 6100 RTP/AVP 96\r\n\
             a=rtpmap:96 L24/48000/2\r\n\
             a=ptime:1\r\n";

        let parsed = parse_audio_sdp(sdp).expect("parse_audio_sdp");
        assert_eq!(
            parsed,
            ParsedAudioSdp {
                session_name: Some("OpenMediaPlatform ST2110-30/AES67".to_string()),
                host: "127.0.0.1".to_string(),
                port: 6100,
                sample_rate: 48000,
                channels: 2,
            }
        );
    }

    #[test]
    fn strips_multicast_ttl_suffix() {
        let sdp = "v=0\r\nc=IN IP4 239.5.5.5/32\r\nm=audio 7000 RTP/AVP 96\r\na=rtpmap:96 L24/48000/8\r\n";
        let parsed = parse_audio_sdp(sdp).expect("parse_audio_sdp");
        assert_eq!(parsed.host, "239.5.5.5");
        assert_eq!(parsed.channels, 8);
    }

    #[test]
    fn missing_field_reports_which_one() {
        let sdp = "v=0\r\nc=IN IP4 127.0.0.1\r\n";
        let err = parse_audio_sdp(sdp).expect_err("should fail without m=audio");
        assert!(err.contains("m=audio"), "err = {err}");
    }
}
