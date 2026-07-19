//! Minimaler SDP-Parser für die Ingest-Seite (Kapitel 19 Teil 1,
//! `docs/END-GOAL-FEATURES.md` §19.3a Punkt 4: "SDP-Annahme —
//! Empfangsseite parametrisiert sich aus einem gereichten SDP statt aus
//! Einzel-Env-Vars"). Bewusst kein vollständiger RFC-4566-Parser (keine
//! neue Dependency, Minimal-Dependency-Regel) — nur die vier Felder, die
//! `St2110VideoInput` tatsächlich braucht: Zieladresse (`c=`), Port
//! (`m=video`), Breite/Höhe/Framerate (`a=fmtp:96 ...`). Feldnamen/
//! -Format exakt nach dem, was `St2110VideoOutput::sdp` selbst erzeugt
//! (`nodes/omp-mediaio/src/st2110.rs`) und was echte 2110-Fremdgeräte
//! senden (RFC 4175/SMPTE ST 2110-20 `a=fmtp`-Konvention) — kein
//! Rätselraten über ein eigenes Schema.

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedVideoSdp {
    /// Aus der `c=`-Zeile — bei einer Multicast-Adresse identisch mit
    /// dem an `St2110VideoInput::new`s `multicast_group`-Parameter zu
    /// übergebenden Wert; ein optionales TTL-Suffix (`/<ttl>`, SDP-
    /// Multicast-Konvention) wird abgeschnitten.
    pub host: String,
    pub port: u16,
    pub width: i32,
    pub height: i32,
    pub framerate_numerator: i32,
    pub framerate_denominator: i32,
}

pub fn parse_video_sdp(sdp: &str) -> Result<ParsedVideoSdp, String> {
    let mut host: Option<String> = None;
    let mut port: Option<u16> = None;
    let mut width: Option<i32> = None;
    let mut height: Option<i32> = None;
    let mut framerate_numerator: Option<i32> = None;
    let mut framerate_denominator: Option<i32> = None;

    for line in sdp.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("c=IN IP4 ") {
            // "<address>[/<ttl>]" — TTL-Suffix ist nur für Multicast-
            // Adressen relevant und für den Gruppen-Beitritt selbst
            // ohne Bedeutung (udpsrc/auto-multicast kennt kein TTL-Feld
            // auf der Empfangsseite).
            host = Some(rest.split('/').next().unwrap_or(rest).trim().to_string());
        } else if let Some(rest) = line.strip_prefix("m=video ") {
            let port_token = rest.split_whitespace().next().ok_or("m=video-Zeile ohne Port")?;
            port = Some(
                port_token
                    .parse()
                    .map_err(|e| format!("m=video-Port '{port_token}' ungültig: {e}"))?,
            );
        } else if let Some(rest) = line.strip_prefix("a=fmtp:") {
            // "<payload-type> <key>=<value>; <key>=<value>; ..."
            let params = rest.split_once(' ').map(|(_, p)| p).unwrap_or(rest);
            for pair in params.split(';') {
                let pair = pair.trim();
                let Some((key, value)) = pair.split_once('=') else {
                    continue;
                };
                let key = key.trim();
                let value = value.trim();
                match key {
                    "width" => width = value.parse().ok(),
                    "height" => height = value.parse().ok(),
                    "exactframerate" => {
                        let (num, den) = value.split_once('/').unwrap_or((value, "1"));
                        framerate_numerator = num.parse().ok();
                        framerate_denominator = den.parse().ok().or(Some(1));
                    }
                    _ => {}
                }
            }
        }
    }

    Ok(ParsedVideoSdp {
        host: host.ok_or("SDP: keine c=IN IP4-Zeile gefunden")?,
        port: port.ok_or("SDP: keine m=video-Zeile gefunden")?,
        width: width.ok_or("SDP: kein width in a=fmtp gefunden")?,
        height: height.ok_or("SDP: kein height in a=fmtp gefunden")?,
        framerate_numerator: framerate_numerator.ok_or("SDP: kein exactframerate in a=fmtp gefunden")?,
        framerate_denominator: framerate_denominator.unwrap_or(1),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Echtes, von `St2110VideoOutput::sdp` erzeugtes SDP (Unicast) —
    /// Rundreise-Test: was der eigene Sender erzeugt, muss der eigene
    /// Parser wieder korrekt lesen.
    #[test]
    fn parses_own_generated_sdp() {
        let sdp = "v=0\r\n\
             o=- 0 0 IN IP4 127.0.0.1\r\n\
             s=OpenMediaPlatform ST2110\r\n\
             c=IN IP4 127.0.0.1\r\n\
             t=0 0\r\n\
             m=video 6000 RTP/AVP 96\r\n\
             a=rtpmap:96 raw/90000\r\n\
             a=fmtp:96 sampling=YCbCr-4:2:2; depth=8; width=1920; height=1080; \
             exactframerate=25/1; colorimetry=BT601-5\r\n";

        let parsed = parse_video_sdp(sdp).expect("parse_video_sdp");
        assert_eq!(
            parsed,
            ParsedVideoSdp {
                host: "127.0.0.1".to_string(),
                port: 6000,
                width: 1920,
                height: 1080,
                framerate_numerator: 25,
                framerate_denominator: 1,
            }
        );
    }

    /// Multicast-Adresse mit TTL-Suffix (echte Fremdgeräte-SDP-Form,
    /// SMPTE ST 2110/RFC-4566-Konvention) — Suffix muss abgeschnitten
    /// werden, sonst scheitert `udpsrc`s `address`-Property an einer
    /// ungültigen IP-Zeichenkette.
    #[test]
    fn strips_multicast_ttl_suffix() {
        let sdp = "v=0\r\n\
             c=IN IP4 239.1.1.1/32\r\n\
             m=video 20000 RTP/AVP 96\r\n\
             a=fmtp:96 width=1280; height=720; exactframerate=50\r\n";

        let parsed = parse_video_sdp(sdp).expect("parse_video_sdp");
        assert_eq!(parsed.host, "239.1.1.1");
        assert_eq!(parsed.port, 20000);
        assert_eq!(parsed.width, 1280);
        assert_eq!(parsed.height, 720);
        // "exactframerate=50" (kein "/") — Denominator fällt auf 1
        // zurück (SDP erlaubt ganzzahlige Framerates ohne Bruchform).
        assert_eq!(parsed.framerate_numerator, 50);
        assert_eq!(parsed.framerate_denominator, 1);
    }

    #[test]
    fn missing_field_reports_which_one() {
        let sdp = "v=0\r\nc=IN IP4 127.0.0.1\r\n";
        let err = parse_video_sdp(sdp).expect_err("should fail without m=video");
        assert!(err.contains("m=video"), "err = {err}");
    }
}
