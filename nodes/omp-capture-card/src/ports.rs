//! Port-Auswahl einer Karten-Instanz: `OMP_CARD_PORTS="0:in,0:out,1:in"` (Gerätenummer:Richtung).
//! Eine Instanz gehört zu EINER Karte und erzeugt je gewähltem Port einen Eingang (Sender) bzw.
//! Ausgang (Empfänger); Duplex-Ports bekommen beide, wie beim Geräte-Hub.

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Dir {
    In,
    Out,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PortSel {
    pub device: i32,
    pub dir: Dir,
}

/// `0:in,0:out,1:in` → sortiert, ohne Doppelte. Leere Eingabe oder ungültiger Eintrag = Fehler.
pub fn parse_ports(s: &str) -> Result<Vec<PortSel>, String> {
    let mut out: Vec<PortSel> = Vec::new();
    for part in s.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let (dev, dir) = part.split_once(':').ok_or_else(|| format!("OMP_CARD_PORTS: {part:?} ist nicht <Gerät>:<in|out>"))?;
        let device: i32 = dev.trim().parse().map_err(|_| format!("OMP_CARD_PORTS: Gerätenummer {dev:?} ungültig"))?;
        if device < 0 {
            return Err(format!("OMP_CARD_PORTS: Gerätenummer {device} negativ"));
        }
        let dir = match dir.trim() {
            "in" | "ingest" => Dir::In,
            "out" | "output" => Dir::Out,
            other => return Err(format!("OMP_CARD_PORTS: Richtung {other:?} unbekannt (in|out)")),
        };
        let sel = PortSel { device, dir };
        if !out.contains(&sel) {
            out.push(sel);
        }
    }
    if out.is_empty() {
        return Err("OMP_CARD_PORTS ist leer — im Start-Dialog mindestens einen Ein- oder Ausgang der Karte wählen".into());
    }
    out.sort();
    Ok(out)
}

pub fn format_ports(p: &[PortSel]) -> String {
    p.iter().map(|s| format!("{}:{}", s.device, if s.dir == Dir::In { "in" } else { "out" })).collect::<Vec<_>>().join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sorts_and_dedupes() {
        let p = parse_ports(" 1:in, 0:out ,0:in,0:out").unwrap();
        assert_eq!(format_ports(&p), "0:in,0:out,1:in");
    }

    #[test]
    fn rejects_bad_input() {
        assert!(parse_ports("").is_err());
        assert!(parse_ports("0").is_err());
        assert!(parse_ports("x:in").is_err());
        assert!(parse_ports("0:both").is_err());
        assert!(parse_ports("-1:in").is_err());
    }
}
