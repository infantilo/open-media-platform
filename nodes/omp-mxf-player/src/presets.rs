//! Programmgruppen + Shuffle-Presets nach `Audio Tonspurerweiterung Q3
//! 2026 PD.pdf` (ORF-intern, `/home/infantilo/`): 8 MXF-Audiotonspuren
//! (Tonspur 1/2, 3/4, 5/6, 7/8) tragen je nach "Ton ausspielen als"-Status
//! unterschiedliche Signale (Programmton/PT, Hörfilm-Audio-Description/AD,
//! Originalton/OT, Dolby E, diskretes 5.1) — 13 offizielle Status ab
//! 15.9.2026 (PDF S.3, "PCMS ausspielen als"), hier als reine Daten
//! hinterlegt statt als Code-Verzweigung, damit künftige Presets (weitere
//! ORF-Status, XAVC-100/300-Varianten mit demselben Tonspur-Schema) ohne
//! Programmänderung ergänzbar bleiben (`pipeline.rs` liest nur `find_*`/
//! `matrix_for`, kennt keine der 13 Namen).
//!
//! **Nutzerwunsch 2026-08-06** ("Shuffle Presets und Output Groups
//! dynamisch... definieren, für einfachere künftige Anpassungen"):
//! `GROUPS`/`PRESETS` waren bis dahin `&'static`-Konstanten — jetzt
//! owned/laufzeit-veränderlich (`Settings`, per `Clone`/`serde::
//! Deserialize`), damit `main.rs` sie beim Start entweder vom
//! Orchestrator laden kann (`orchestrator_settings.rs`,
//! Postgres-gestützt über `PUT /api/v1/node-types/omp-mxf-player/
//! settings`) oder — ohne erreichbaren Orchestrator/Launcher, z. B.
//! lokale `cargo run`-Entwicklung — auf `default_settings()` unten
//! zurückfällt. Die Struct-*Form* bleibt unverändert, nur die
//! String-Felder sind jetzt `String` statt `&'static str` und die
//! Slices `Vec` statt `&'static [_]`.
//!
//! Track-Indizes sind 1-basiert (deckt sich mit der PDF-Nomenklatur
//! "Tonspur 1/2, 3/4, …") und referenzieren die MXF-Audiospuren in
//! Datei-/PCMS-Reihenfolge — s. `pipeline.rs`s Zuordnung der
//! `mxfdemux`-`track_%u`-Pads zu diesem Index (dort empirisch/defensiv
//! behandelt, nicht hier).
//!
//! **Dolby E bleibt bit-exakt**: jede Route in eine `dolbye`-Gruppe ist
//! immer eine reine 1:1-Auswahl (Koeffizient exakt 1.0, keine
//! Summierung) — kein Preset hier mischt/upmixt in diese Gruppe. S24LE
//! (Quellformat laut `ffprobe`) passt verlustfrei in F32LEs 24-Bit-
//! Mantisse, ein reiner Auswahl-Durchgriff über `audiomixmatrix`
//! verändert die Sample-Werte nicht — s. Plan-Dokument für die
//! ausführliche Begründung. Diese Invariante ist inhaltlich, nicht
//! technisch erzwungen — wer über die neue Einstellungsseite eine
//! `dolbye`-Route mit mehreren Quellspuren anlegt, bekäme technisch
//! eine Summierung statt eines reinen Durchgriffs (kein Validierungs-
//! Fehler dafür, s. orchestrator `validateMxfPlayerSettings` — bewusst
//! nur strukturelle, keine inhaltliche ORF-Konventions-Prüfung).

use serde::{Deserialize, Serialize};

/// Eine dauerhaft aktive Audio-Ausgangsgruppe — Kanalzahl ändert sich nie
/// zwischen Presets (nur die Routing-Koeffizienten tun das), s.
/// `pipeline.rs`-Moduldoku zur A/B-Slot-Architektur. Kanalzahl-Änderungen
/// selbst (neue/entfernte Gruppen) wirken erst nach einem Neustart der
/// Instanz (neue NMOS-Sender werden nur beim Start registriert,
/// Nutzerentscheidung 2026-08-06 — kein Live-Sender-Add/Remove-
/// Mechanismus, wie bei jedem anderen Node in diesem System auch).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProgramGroup {
    pub id: String,
    pub label: String,
    pub channels: u32,
}

/// Eine Route ordnet EINE Quell-Tonspur (1-basiert) einem Ausgabekanal
/// einer Gruppe zu (`group_channel` 0-basiert: bei Stereo-Gruppen 0=L,
/// 1=R; bei `surround51` 0=L,1=R,2=C,3=LFE,4=SL,5=SR, s. PDF S.5).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Route {
    #[serde(rename = "srcTrack")]
    pub src_track: u8,
    pub group: String,
    #[serde(rename = "groupChannel")]
    pub group_channel: u8,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AudioPreset {
    pub id: String,
    pub label: String,
    pub routes: Vec<Route>,
}

/// Das gesamte, laufzeit-ladbare Dokument — identisches JSON-Schema wie
/// `orchestrator/internal/httpapi/node_settings_handlers.go`s
/// `mxfPlayerSettings` (camelCase-Feldnamen dort/hier über
/// `#[serde(rename)]` synchron gehalten, s. Route oben).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    pub groups: Vec<ProgramGroup>,
    pub presets: Vec<AudioPreset>,
}

/// Die 13 offiziellen "PCMS ausspielen als"-Status (PDF S.3+4/5) + die 5
/// ORF-Programmgruppen — identischer Inhalt wie vor der Umstellung auf
/// laufzeit-ladbare Settings, dient jetzt als Fallback, wenn kein
/// Orchestrator erreichbar ist (s. Moduldoku), UND als Vorbelegung des
/// `node_type_settings`-Eintrags beim allerersten Abruf (orchestrator-
/// seitig identisch dupliziert, s. dortige `defaultMxfPlayerSettings`).
/// Presets mit nur einem Quellkanal für einen an sich stereo geführten
/// Ausgang (Mono, 2-Ton-Mono) speisen L UND R aus derselben Spur — so
/// bleibt jede Gruppe für Abnehmer immer ein echtes Stereo-Signal,
/// unabhängig davon, ob die Quelle mono war (Broadcast-Konvention,
/// entspricht der PDF-Spalte "PT" ohne "PT L"/"PT R"-Unterscheidung bei
/// Mono/2-Ton-Mono).
pub fn default_settings() -> Settings {
    let group = |id: &str, label: &str, channels: u32| ProgramGroup { id: id.to_string(), label: label.to_string(), channels };
    let route = |src_track: u8, group: &str, group_channel: u8| Route { src_track, group: group.to_string(), group_channel };
    let preset = |id: &str, label: &str, routes: Vec<Route>| AudioPreset { id: id.to_string(), label: label.to_string(), routes };

    Settings {
        groups: vec![
            group("pt", "Programmton", 2),
            group("ad", "Hörfilm/AD", 2),
            group("ot", "Originalton", 2),
            group("dolbye", "Dolby E", 2),
            group("surround51", "5.1 Diskret", 6),
        ],
        presets: vec![
            preset("mono", "Mono", vec![
                route(1, "pt", 0),
                route(1, "pt", 1),
            ]),
            preset("stereo", "Stereo", vec![
                route(1, "pt", 0),
                route(2, "pt", 1),
            ]),
            // Nutzerentscheidung (2026-08-05): Track 2 ("AD/OT" laut PDF
            // S.4 mehrdeutig) wird als AD interpretiert.
            preset("2ton-mono", "2-Ton-Mono", vec![
                route(1, "pt", 0),
                route(1, "pt", 1),
                route(2, "ad", 0),
                route(2, "ad", 1),
            ]),
            preset("stereo-hoerfilm", "Stereo/Hörfilm", vec![
                route(1, "pt", 0),
                route(2, "pt", 1),
                route(5, "ad", 0),
                route(6, "ad", 1),
            ]),
            preset("stereo-ot-56", "Stereo/OT 5,6", vec![
                route(1, "pt", 0),
                route(2, "pt", 1),
                route(5, "ot", 0),
                route(6, "ot", 1),
            ]),
            preset("stereo-ot", "Stereo/OT", vec![
                route(1, "pt", 0),
                route(2, "pt", 1),
                route(7, "ot", 0),
                route(8, "ot", 1),
            ]),
            preset("stereo-hoerfilm-ot", "Stereo/Hörfilm/OT", vec![
                route(1, "pt", 0),
                route(2, "pt", 1),
                route(5, "ad", 0),
                route(6, "ad", 1),
                route(7, "ot", 0),
                route(8, "ot", 1),
            ]),
            preset("stereo-dolbye", "Stereo/Dolby E", vec![
                route(1, "pt", 0),
                route(2, "pt", 1),
                route(3, "dolbye", 0),
                route(4, "dolbye", 1),
            ]),
            preset("stereo-dolbye-hoerfilm", "Stereo/Dolby E/Hörfilm", vec![
                route(1, "pt", 0),
                route(2, "pt", 1),
                route(3, "dolbye", 0),
                route(4, "dolbye", 1),
                route(5, "ad", 0),
                route(6, "ad", 1),
            ]),
            preset("stereo-dolbye-ot-56", "Stereo/Dolby E/OT 5,6", vec![
                route(1, "pt", 0),
                route(2, "pt", 1),
                route(3, "dolbye", 0),
                route(4, "dolbye", 1),
                route(5, "ot", 0),
                route(6, "ot", 1),
            ]),
            preset("stereo-dolbye-ot", "Stereo/Dolby E/OT", vec![
                route(1, "pt", 0),
                route(2, "pt", 1),
                route(3, "dolbye", 0),
                route(4, "dolbye", 1),
                route(7, "ot", 0),
                route(8, "ot", 1),
            ]),
            preset("stereo-dolbye-hoerfilm-ot", "Stereo/Dolby E/Hörfilm/OT", vec![
                route(1, "pt", 0),
                route(2, "pt", 1),
                route(3, "dolbye", 0),
                route(4, "dolbye", 1),
                route(5, "ad", 0),
                route(6, "ad", 1),
                route(7, "ot", 0),
                route(8, "ot", 1),
            ]),
            preset("stereo-51-diskret", "Stereo/5.1 diskret", vec![
                // 1/2: Stereo-Kompatibilitäts-Downmix fürs pt-Programm.
                route(1, "pt", 0),
                route(2, "pt", 1),
                // 3/4: 5.1 L/R, 5/6: 5.1 C/LFE, 7/8: 5.1 SL/SR (PDF S.5).
                route(3, "surround51", 0),
                route(4, "surround51", 1),
                route(5, "surround51", 2),
                route(6, "surround51", 3),
                route(7, "surround51", 4),
                route(8, "surround51", 5),
            ]),
        ],
    }
}

pub fn find_preset<'a>(presets: &'a [AudioPreset], id: &str) -> Option<&'a AudioPreset> {
    presets.iter().find(|p| p.id == id)
}

/// Baut die `audiomixmatrix`-Koeffizienten (Zeilen = Ausgabekanäle,
/// Spalten = Eingabekanäle — GStreamers eigene Konvention, s.
/// `pipeline.rs`) für EINE Gruppe aus den Routes eines Presets.
/// `input_channels` ist die Zahl tatsächlich in der Datei gefundener
/// Tonspuren (kann <8 sein bei älteren/kleineren Dateien) — eine Route,
/// die eine nicht existierende Spur referenziert, wird übersprungen (der
/// Zielkanal bleibt stumm), kein Fehler: dieselbe Nachsicht wie
/// PIPELINE CONTROLLERs Preset-Fallback (s. Plan-Dokument), nur ohne
/// dessen Laufzeit-Silence-Detection — hier rein statisch aus der
/// tatsächlichen Spurzahl.
pub fn matrix_for(preset: &AudioPreset, group_id: &str, group_channels: u32, input_channels: u32) -> Vec<Vec<f64>> {
    let mut matrix = vec![vec![0.0f64; input_channels as usize]; group_channels as usize];
    for route in preset.routes.iter().filter(|r| r.group == group_id) {
        let in_idx = (route.src_track as usize).saturating_sub(1);
        let out_idx = route.group_channel as usize;
        if in_idx < input_channels as usize && out_idx < group_channels as usize {
            matrix[out_idx][in_idx] = 1.0;
        }
    }
    matrix
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_has_five_groups_and_thirteen_presets() {
        let settings = default_settings();
        assert_eq!(settings.groups.len(), 5);
        assert_eq!(settings.presets.len(), 13);
    }

    #[test]
    fn find_preset_finds_by_id_and_none_for_unknown() {
        let settings = default_settings();
        assert!(find_preset(&settings.presets, "stereo").is_some());
        assert!(find_preset(&settings.presets, "does-not-exist").is_none());
    }

    #[test]
    fn matrix_for_stereo_is_identity_on_first_two_tracks() {
        let settings = default_settings();
        let preset = find_preset(&settings.presets, "stereo").unwrap();
        let matrix = matrix_for(preset, "pt", 2, 8);
        assert_eq!(matrix[0][0], 1.0);
        assert_eq!(matrix[1][1], 1.0);
        // Keine anderen Koeffizienten gesetzt.
        let sum: f64 = matrix.iter().flatten().sum();
        assert_eq!(sum, 2.0);
    }

    #[test]
    fn matrix_for_skips_routes_beyond_actual_track_count() {
        // "stereo-hoerfilm" routet auch auf Tracks 5/6 — bei einer Datei
        // mit nur 2 tatsächlichen Tracks (input_channels=2) muss die
        // Route auf Track 5/6 stumm bleiben statt zu fehlern (s.
        // matrix_for-Doku "dieselbe Nachsicht wie PIPELINE CONTROLLERs
        // Preset-Fallback").
        let settings = default_settings();
        let preset = find_preset(&settings.presets, "stereo-hoerfilm").unwrap();
        let matrix = matrix_for(preset, "ad", 2, 2);
        let sum: f64 = matrix.iter().flatten().sum();
        assert_eq!(sum, 0.0);
    }

    #[test]
    fn matrix_for_unknown_group_id_yields_all_zero_matrix() {
        let settings = default_settings();
        let preset = find_preset(&settings.presets, "stereo").unwrap();
        let matrix = matrix_for(preset, "does-not-exist", 2, 8);
        let sum: f64 = matrix.iter().flatten().sum();
        assert_eq!(sum, 0.0);
    }
}
