//! Reine Konfigurationslogik von `omp-contribution` (UMSETZUNG 106.6): Adresse, Betriebsart, Ton-PIDs, Passphrase-Datei.
//! Keine GStreamer-Abhängigkeit, damit sie ohne Laufzeit testbar ist.

/// SRT-Verbindungsart (SRT Internet-Draft draft-sharabayko-srt-01).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SrtMode {
    Caller,
    Listener,
    Rendezvous,
}

impl SrtMode {
    pub fn parse(s: &str) -> Result<SrtMode, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "caller" => Ok(SrtMode::Caller),
            "listener" => Ok(SrtMode::Listener),
            "rendezvous" => Ok(SrtMode::Rendezvous),
            other => Err(format!("unbekannte SRT-Betriebsart „{other}“ (caller, listener, rendezvous)")),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            SrtMode::Caller => "caller",
            SrtMode::Listener => "listener",
            SrtMode::Rendezvous => "rendezvous",
        }
    }
}

/// Prüft eine `srt://host:port`-Adresse. Eine Passphrase in der Adresse wird **abgelehnt** (sie käme sonst in Parameter
/// und Protokolle); sie gehört in `OMP_CONTRIB_PASSPHRASE_FILE`. Rückgabe: Adresse ohne Query.
pub fn validate_srt_uri(uri: &str) -> Result<String, String> {
    let u = uri.trim();
    let lower = u.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix("srt://") else {
        return Err(format!("Adresse muss mit srt:// beginnen (war: {})", redact(u)));
    };
    if lower.contains("passphrase=") {
        return Err("Passphrase gehört nicht in die Adresse (OMP_CONTRIB_PASSPHRASE_FILE verwenden)".into());
    }
    let (hostport, _query) = rest.split_once('?').unwrap_or((rest, ""));
    // Listener darf ohne Host (":9000") angegeben werden.
    let (host, port) = hostport.rsplit_once(':').ok_or("Adresse ohne Port")?;
    if port.parse::<u16>().is_err() {
        return Err(format!("ungültiger Port „{port}“"));
    }
    if host.contains('/') || host.contains('@') {
        return Err("Adresse enthält Pfad oder Zugangsdaten".into());
    }
    let orig_rest = &u["srt://".len()..];
    Ok(format!("srt://{}", orig_rest.split('?').next().unwrap_or("")))
}

/// Übertragungsweg der Leitung, aus dem Schema der Adresse abgeleitet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    Srt,
    Rist,
}

impl Transport {
    pub fn as_str(self) -> &'static str {
        match self {
            Transport::Srt => "srt",
            Transport::Rist => "rist",
        }
    }
}

/// RIST-Adresse `rist://host:port[,host:port...]` (VSF TR-06-1, Simple Profile; GStreamer `ristsrc`). Mehrere Einträge =
/// Bündelung (`bonding-addresses`), höchstens 4. Der RTP-Port muss gerade sein (RTCP = Port + 1). Rückgabe: Liste (Host, Port).
pub fn parse_rist_uri(uri: &str) -> Result<Vec<(String, u16)>, String> {
    let u = uri.trim();
    let rest = u.strip_prefix("rist://").or_else(|| u.strip_prefix("RIST://")).ok_or_else(|| format!("Adresse muss mit rist:// beginnen (war: {})", redact(u)))?;
    let mut out = Vec::new();
    for part in rest.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        if part.contains(['@', '/', '?']) {
            return Err("RIST-Adresse enthält Pfad, Abfrage oder Zugangsdaten".into());
        }
        let (host, port) = part.rsplit_once(':').ok_or("RIST-Adresse ohne Port")?;
        let port: u16 = port.parse().map_err(|_| format!("ungültiger Port „{port}“"))?;
        if port % 2 != 0 {
            return Err(format!("RIST-RTP-Port {port} muss gerade sein (RTCP = Port + 1)"));
        }
        out.push((if host.is_empty() { "0.0.0.0".to_string() } else { host.to_string() }, port));
    }
    if out.is_empty() {
        return Err("RIST-Adresse ohne Eintrag".into());
    }
    if out.len() > 4 {
        return Err("höchstens 4 Bündelungsadressen".into());
    }
    Ok(out)
}

/// Prüft die Leitungsadresse (SRT oder RIST) und liefert Übertragungsweg und bereinigte Adresse.
pub fn validate_line_uri(uri: &str) -> Result<(Transport, String), String> {
    let l = uri.trim().to_ascii_lowercase();
    if l.starts_with("rist://") {
        let list = parse_rist_uri(uri)?;
        Ok((Transport::Rist, format!("rist://{}", list.iter().map(|(h, p)| format!("{h}:{p}")).collect::<Vec<_>>().join(","))))
    } else {
        Ok((Transport::Srt, validate_srt_uri(uri)?))
    }
}

/// Relay-Ziel: leer = aus, sonst `srt://…` oder `rist://host:port` (ein Ziel).
pub fn validate_relay_uri(uri: &str) -> Result<String, String> {
    let u = uri.trim();
    if u.is_empty() {
        return Ok(String::new());
    }
    let (t, norm) = validate_line_uri(u)?;
    if t == Transport::Rist && norm.contains(',') {
        return Err("Relay über RIST: genau ein Ziel".into());
    }
    Ok(norm)
}

/// Adresse für die Anzeige: ohne Query und ohne `user:pass@`.
pub fn redact(uri: &str) -> String {
    let Some(i) = uri.find("://") else { return String::new() };
    let (scheme, rest) = uri.split_at(i + 3);
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let rest = match rest.find('@') {
        Some(at) if !rest[..at].contains('/') => &rest[at + 1..],
        _ => rest,
    };
    format!("{scheme}{rest}")
}

/// Ton-PIDs aus „0x101,0x102“ oder „257,258“. Leer = alle in PID-Reihenfolge. Höchstens 8.
pub fn parse_pids(s: &str) -> Result<Vec<u16>, String> {
    let mut out = Vec::new();
    for part in s.split([',', ' ']).map(str::trim).filter(|p| !p.is_empty()) {
        let v = if let Some(h) = part.strip_prefix("0x").or_else(|| part.strip_prefix("0X")) {
            u16::from_str_radix(h, 16)
        } else {
            part.parse::<u16>()
        }
        .map_err(|_| format!("ungültige PID „{part}“"))?;
        if v > 0x1FFF {
            return Err(format!("PID {part} außerhalb 0..8191"));
        }
        if out.contains(&v) {
            return Err(format!("PID {part} doppelt"));
        }
        out.push(v);
    }
    if out.len() > 8 {
        return Err("höchstens 8 Ton-PIDs".into());
    }
    Ok(out)
}

/// PID aus einem tsdemux-Padnamen (`audio_0101` → 0x101).
pub fn pid_from_pad_name(name: &str) -> Option<u16> {
    let (_, hex) = name.rsplit_once('_')?;
    u16::from_str_radix(hex, 16).ok()
}

/// Liest die Passphrase aus einer Datei. Die Datei darf für Gruppe/Andere nicht lesbar sein (≤ 0600). Das Ergebnis wird
/// nie protokolliert. Länge 10..79 Zeichen (SRT-Vorgabe).
#[cfg(unix)]
pub fn read_passphrase_file(path: &str) -> Result<String, String> {
    use std::os::unix::fs::PermissionsExt;
    let meta = std::fs::metadata(path).map_err(|e| format!("Passphrase-Datei: {e}"))?;
    if meta.permissions().mode() & 0o077 != 0 {
        return Err("Passphrase-Datei ist für Gruppe/Andere lesbar (chmod 600)".into());
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("Passphrase-Datei: {e}"))?;
    let p = text.trim_end_matches(['\n', '\r']).to_string();
    if !(10..=79).contains(&p.chars().count()) {
        return Err("Passphrase muss 10 bis 79 Zeichen lang sein".into());
    }
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_rules() {
        assert_eq!(validate_srt_uri("srt://10.0.0.1:9000?mode=caller&latency=200").unwrap(), "srt://10.0.0.1:9000");
        assert_eq!(validate_srt_uri("srt://:9000").unwrap(), "srt://:9000");
        assert!(validate_srt_uri("srt://h:9000?passphrase=geheim12345").unwrap_err().contains("Passphrase"));
        assert!(validate_srt_uri("http://h:1").is_err());
        assert!(validate_srt_uri("srt://h").is_err());
        assert!(validate_srt_uri("srt://h:abc").is_err());
        assert!(validate_srt_uri("srt://u:p@h:9").is_err());
    }

    #[test]
    fn error_message_does_not_leak_the_secret() {
        let e = validate_srt_uri("http://h:1?passphrase=geheim12345").unwrap_err();
        assert!(!e.contains("geheim"));
        assert_eq!(redact("srt://u:p@h:9?streamid=x"), "srt://h:9");
    }

    #[test]
    fn pids() {
        assert_eq!(parse_pids("0x101, 258").unwrap(), vec![0x101, 258]);
        assert!(parse_pids("").unwrap().is_empty());
        assert!(parse_pids("0x101,0x101").is_err());
        assert!(parse_pids("0x2000").is_err());
        assert!(parse_pids("1,2,3,4,5,6,7,8,9").is_err());
        assert_eq!(pid_from_pad_name("audio_0101"), Some(0x101));
        assert_eq!(pid_from_pad_name("video"), None);
    }

    #[test]
    fn rist_uris() {
        assert_eq!(parse_rist_uri("rist://10.0.0.1:5004").unwrap(), vec![("10.0.0.1".to_string(), 5004)]);
        let b = parse_rist_uri("rist://10.0.0.1:5004,10.0.1.1:5006").unwrap();
        assert_eq!(b.len(), 2);
        assert!(parse_rist_uri("rist://h:5005").unwrap_err().contains("gerade"));
        assert!(parse_rist_uri("rist://h").is_err());
        assert!(parse_rist_uri("rist://a:2,b:4,c:6,d:8,e:10").is_err());
        assert_eq!(validate_line_uri("rist://:5004").unwrap(), (Transport::Rist, "rist://0.0.0.0:5004".to_string()));
        assert_eq!(validate_line_uri("srt://:9000").unwrap().0, Transport::Srt);
    }

    #[test]
    fn relay_uris() {
        assert_eq!(validate_relay_uri("").unwrap(), "");
        assert!(validate_relay_uri("srt://10.0.0.9:9100").is_ok());
        assert!(validate_relay_uri("rist://a:4,b:6").is_err());
        assert!(validate_relay_uri("http://x:1").is_err());
    }

    #[test]
    fn modes() {
        assert_eq!(SrtMode::parse("Listener").unwrap(), SrtMode::Listener);
        assert!(SrtMode::parse("x").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn passphrase_file_permissions_and_length() {
        use std::os::unix::fs::PermissionsExt;
        let p = std::env::temp_dir().join(format!("omp-contrib-pp-{}", std::process::id()));
        std::fs::write(&p, "ein-langes-geheimnis\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_passphrase_file(p.to_str().unwrap()).unwrap_err().contains("lesbar"));
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(read_passphrase_file(p.to_str().unwrap()).unwrap(), "ein-langes-geheimnis");
        std::fs::write(&p, "kurz\n").unwrap();
        assert!(read_passphrase_file(p.to_str().unwrap()).unwrap_err().contains("10 bis 79"));
        let _ = std::fs::remove_file(&p);
    }
}
