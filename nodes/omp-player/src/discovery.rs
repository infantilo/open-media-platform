//! Live-MXL-Quellen-Discovery für Playlist-Items (`ARCHITECTURE.md`
//! §24.6, `UMSETZUNG.md` C21) — exakt dasselbe 2s-Poll-Muster wie
//! `omp-switcher`/`omp-video-mixer-me`/`omp-audio-mixer` (C7/C10/C11):
//! `RegistryClient::list_senders()` pollen, `transport==MXL` filtern,
//! eigenen Sender + Lowres-Begleiter ausschließen. Hier eine vierte,
//! bewusst separate Kopie statt eines gemeinsamen `omp-node-sdk`-Helfers
//! — die vier Ausprägungen unterscheiden sich in Detailfiltern
//! (Keyfill-Paare beim Mixer, Lowres-Verlinkung beim Switcher,
//! Format-Filter je nach Rolle) genug, dass eine verfrühte Abstraktion
//! mehr Kopplung als Nutzen brächte (§24.6, explizite Entscheidung).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_node_sdk::is04::{self, RegistryClient, Sender, TRANSPORT_MXL};

const GROUPHINT_TAG: &str = "urn:x-nmos:tag:grouphint/v1.0";

/// Ein für die Auswahl als Playlist-Item infrage kommender MXL-Sender —
/// bereits nach Format (Video im Video-Profil, Audio im Jingle-Profil)
/// gefiltert, s. `discover`.
#[derive(Debug, Clone)]
pub struct DiscoveredSource {
    pub sender_id: String,
    pub label: String,
}

fn parse_grouphint(value: &str) -> Option<(&str, &str)> {
    let mut parts = value.splitn(3, ':');
    let group = parts.next()?;
    let role = parts.next()?;
    Some((group, role))
}

/// Ob `s` ein Lowres-Begleit-Sender ist (Rolle `low`) — solche Sender
/// werden nie selbst als Playlist-Item-Quelle angeboten, exakt gleiche
/// Ausschlussregel wie beim Switcher/Mixer.
fn is_lowres_companion(s: &Sender) -> bool {
    s.tags
        .get(GROUPHINT_TAG)
        .map(|values| values.iter().any(|v| matches!(parse_grouphint(v), Some((_, "low")))))
        .unwrap_or(false)
}

/// Ein Discovery-Durchlauf (blockierend, s. `spawn_blocking`-Aufrufer in
/// `discovery_loop`) — liefert die für `availableSources` angezeigte
/// Liste: nur Sender des durch `want_format` (`is04::FORMAT_VIDEO`/
/// `FORMAT_AUDIO`) vorgegebenen Formats, passend zum eigenen Profil
/// (`has_video`, s. `main.rs`).
pub fn discover(registry: &RegistryClient, own_sender_id: &str, want_format: &str) -> Result<Vec<DiscoveredSource>, String> {
    let senders = registry.list_senders().map_err(|e| e.to_string())?;

    let mut discovered = Vec::new();
    for s in &senders {
        if s.transport != TRANSPORT_MXL || s.id == own_sender_id || is_lowres_companion(s) {
            continue;
        }
        let Some(flow_id) = &s.flow_id else { continue };
        if !matches!(registry.get_flow_format(flow_id), Ok(f) if f == want_format) {
            continue;
        }
        discovered.push(DiscoveredSource { sender_id: s.id.clone(), label: s.label.clone() });
    }
    Ok(discovered)
}

/// Pollt alle 2s (gleiches Intervall wie C7/C10/C11) und schreibt das
/// Ergebnis nach `out` — ein fehlgeschlagener Poll (Registry kurz nicht
/// erreichbar) überschreibt die zuletzt bekannte Liste bewusst nicht
/// (gleiche Nachsicht wie anderswo: lieber ein kurz veraltetes Angebot
/// als ein leeres).
pub async fn discovery_loop(
    registry_url: String,
    own_sender_id: String,
    want_format: &'static str,
    out: Arc<Mutex<Vec<DiscoveredSource>>>,
) {
    let registry = RegistryClient::new(registry_url);
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    loop {
        interval.tick().await;
        let registry_for_poll = registry.clone();
        let own = own_sender_id.clone();
        let result = tokio::task::spawn_blocking(move || discover(&registry_for_poll, &own, want_format)).await;
        if let Ok(Ok(list)) = result {
            *out.lock().expect("lock poisoned") = list;
        }
    }
}

/// Löst einen per `senderId` referenzierten Live-Playlist-Eintrag zum
/// Cue-Zeitpunkt zu MXL-Flow-IDs auf (`main.rs`s `cue`-Handler) — bewusst
/// eine **frische** Registry-Anfrage statt des periodisch gepollten
/// `discovery_loop`-Caches (der nur die Auswahlliste speist): `cue()`
/// ist kein Hot-Path (operator-getaktet, kein 200ms-Tick), eine
/// garantiert aktuelle Auflösung ist hier wichtiger als der gesparte
/// Umlauf. `has_video` bestimmt, ob `sender_id` einen Video- oder
/// Audio-Sender referenziert (Video-Profil erwartet Video, Jingle-Profil
/// Audio — dieselbe Format-Zuordnung wie im `discovery_loop` selbst).
///
/// Sucht zusätzlich einen Begleit-Sender **anderen** Formats auf
/// demselben `device_id` (allgemeines NMOS Node→Device→Sender-Konzept —
/// alle Sender einer Node-Instanz teilen sich einen Device, s.
/// `omp_node_sdk::node::start` — nicht DSK-spezifisch, obwohl
/// `omp-video-mixer-me::discover_keyfill` dieselbe Idee zuerst für
/// Fill+Key genutzt hat): eine Live-Quelle mit eigenem Ton (z. B. eine
/// Kamera) bekommt so automatisch auch ihre Audiospur, ohne dass der
/// Operator zwei separate Auswahlen treffen muss. Kein Treffer für den
/// Begleiter ist kein Fehler — der entsprechende Zweig bleibt stumm
/// (Audio) bzw. schwarz (Video, praktisch nur im Jingle-Fall relevant),
/// gleiche Nachsicht wie ein `TestPattern`-Item mit `toneFrequency: 0`.
///
/// Liefert `None`, wenn `sender_id` aktuell nicht (mehr) mit dem
/// erwarteten Format auffindbar ist — der Aufrufer meldet das als
/// Fehler statt eine Vermutung anzuzeigen (kein "schwarz cuen und so
/// tun, als wäre alles in Ordnung").
pub fn resolve(registry: &RegistryClient, sender_id: &str, has_video: bool) -> Option<(Option<String>, Option<String>)> {
    let senders = registry.list_senders().ok()?;
    let primary = senders.iter().find(|s| s.id == sender_id)?;
    let primary_flow_id = primary.flow_id.clone()?;
    let expected_format = if has_video { is04::FORMAT_VIDEO } else { is04::FORMAT_AUDIO };
    if !matches!(registry.get_flow_format(&primary_flow_id), Ok(f) if f == expected_format) {
        return None;
    }
    let device_id = primary.device_id.clone();

    if !has_video {
        // Jingle-Profil: sender_id IST bereits der Audio-Sender, kein
        // Video-isel vorhanden, das einen Begleiter bräuchte.
        return Some((None, Some(primary_flow_id)));
    }

    let companion_flow_id = senders
        .iter()
        .find(|s| {
            s.device_id == device_id
                && s.id != sender_id
                && s.transport == TRANSPORT_MXL
                && !is_lowres_companion(s)
                && s.flow_id
                    .as_deref()
                    .is_some_and(|fid| matches!(registry.get_flow_format(fid), Ok(f) if f == is04::FORMAT_AUDIO))
        })
        .and_then(|s| s.flow_id.clone());

    Some((Some(primary_flow_id), companion_flow_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_grouphint_splits_group_and_role() {
        assert_eq!(parse_grouphint("abc123:high"), Some(("abc123", "high")));
        assert_eq!(parse_grouphint("abc123:low"), Some(("abc123", "low")));
        assert_eq!(parse_grouphint("no-colon"), None);
    }

    #[test]
    fn is_lowres_companion_detects_low_role_tag() {
        let mut low = Sender::new("s1", "Low", "dev1");
        low.tags.insert(GROUPHINT_TAG.to_string(), vec!["group1:low".to_string()]);
        assert!(is_lowres_companion(&low));

        let mut high = Sender::new("s2", "High", "dev1");
        high.tags.insert(GROUPHINT_TAG.to_string(), vec!["group1:high".to_string()]);
        assert!(!is_lowres_companion(&high));

        let plain = Sender::new("s3", "Plain", "dev1");
        assert!(!is_lowres_companion(&plain));
    }
}
