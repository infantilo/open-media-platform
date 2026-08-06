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
//! ausführliche Begründung.

/// Eine dauerhaft aktive Audio-Ausgangsgruppe — Kanalzahl ändert sich nie
/// zwischen Presets (nur die Routing-Koeffizienten tun das), s.
/// `pipeline.rs`-Moduldoku zur A/B-Slot-Architektur.
pub struct ProgramGroup {
    pub id: &'static str,
    pub label: &'static str,
    pub channels: u32,
}

pub const GROUPS: &[ProgramGroup] = &[
    ProgramGroup { id: "pt", label: "Programmton", channels: 2 },
    ProgramGroup { id: "ad", label: "Hörfilm/AD", channels: 2 },
    ProgramGroup { id: "ot", label: "Originalton", channels: 2 },
    ProgramGroup { id: "dolbye", label: "Dolby E", channels: 2 },
    ProgramGroup { id: "surround51", label: "5.1 Diskret", channels: 6 },
];

/// Eine Route ordnet EINE Quell-Tonspur (1-basiert) einem Ausgabekanal
/// einer Gruppe zu (`group_channel` 0-basiert: bei Stereo-Gruppen 0=L,
/// 1=R; bei `surround51` 0=L,1=R,2=C,3=LFE,4=SL,5=SR, s. PDF S.5).
pub struct Route {
    pub src_track: u8,
    pub group: &'static str,
    pub group_channel: u8,
}

pub struct AudioPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub routes: &'static [Route],
}

/// Die 13 offiziellen "PCMS ausspielen als"-Status (PDF S.3+4/5). Presets
/// mit nur einem Quellkanal für einen an sich stereo geführten
/// Ausgang (Mono, 2-Ton-Mono) speisen L UND R aus derselben Spur — so
/// bleibt jede Gruppe für Abnehmer immer ein echtes Stereo-Signal,
/// unabhängig davon, ob die Quelle mono war (Broadcast-Konvention,
/// entspricht der PDF-Spalte "PT" ohne "PT L"/"PT R"-Unterscheidung bei
/// Mono/2-Ton-Mono).
pub const PRESETS: &[AudioPreset] = &[
    AudioPreset {
        id: "mono",
        label: "Mono",
        routes: &[
            Route { src_track: 1, group: "pt", group_channel: 0 },
            Route { src_track: 1, group: "pt", group_channel: 1 },
        ],
    },
    AudioPreset {
        id: "stereo",
        label: "Stereo",
        routes: &[
            Route { src_track: 1, group: "pt", group_channel: 0 },
            Route { src_track: 2, group: "pt", group_channel: 1 },
        ],
    },
    // Nutzerentscheidung (2026-08-05): Track 2 ("AD/OT" laut PDF S.4
    // mehrdeutig) wird als AD interpretiert.
    AudioPreset {
        id: "2ton-mono",
        label: "2-Ton-Mono",
        routes: &[
            Route { src_track: 1, group: "pt", group_channel: 0 },
            Route { src_track: 1, group: "pt", group_channel: 1 },
            Route { src_track: 2, group: "ad", group_channel: 0 },
            Route { src_track: 2, group: "ad", group_channel: 1 },
        ],
    },
    AudioPreset {
        id: "stereo-hoerfilm",
        label: "Stereo/Hörfilm",
        routes: &[
            Route { src_track: 1, group: "pt", group_channel: 0 },
            Route { src_track: 2, group: "pt", group_channel: 1 },
            Route { src_track: 5, group: "ad", group_channel: 0 },
            Route { src_track: 6, group: "ad", group_channel: 1 },
        ],
    },
    AudioPreset {
        id: "stereo-ot-56",
        label: "Stereo/OT 5,6",
        routes: &[
            Route { src_track: 1, group: "pt", group_channel: 0 },
            Route { src_track: 2, group: "pt", group_channel: 1 },
            Route { src_track: 5, group: "ot", group_channel: 0 },
            Route { src_track: 6, group: "ot", group_channel: 1 },
        ],
    },
    AudioPreset {
        id: "stereo-ot",
        label: "Stereo/OT",
        routes: &[
            Route { src_track: 1, group: "pt", group_channel: 0 },
            Route { src_track: 2, group: "pt", group_channel: 1 },
            Route { src_track: 7, group: "ot", group_channel: 0 },
            Route { src_track: 8, group: "ot", group_channel: 1 },
        ],
    },
    AudioPreset {
        id: "stereo-hoerfilm-ot",
        label: "Stereo/Hörfilm/OT",
        routes: &[
            Route { src_track: 1, group: "pt", group_channel: 0 },
            Route { src_track: 2, group: "pt", group_channel: 1 },
            Route { src_track: 5, group: "ad", group_channel: 0 },
            Route { src_track: 6, group: "ad", group_channel: 1 },
            Route { src_track: 7, group: "ot", group_channel: 0 },
            Route { src_track: 8, group: "ot", group_channel: 1 },
        ],
    },
    AudioPreset {
        id: "stereo-dolbye",
        label: "Stereo/Dolby E",
        routes: &[
            Route { src_track: 1, group: "pt", group_channel: 0 },
            Route { src_track: 2, group: "pt", group_channel: 1 },
            Route { src_track: 3, group: "dolbye", group_channel: 0 },
            Route { src_track: 4, group: "dolbye", group_channel: 1 },
        ],
    },
    AudioPreset {
        id: "stereo-dolbye-hoerfilm",
        label: "Stereo/Dolby E/Hörfilm",
        routes: &[
            Route { src_track: 1, group: "pt", group_channel: 0 },
            Route { src_track: 2, group: "pt", group_channel: 1 },
            Route { src_track: 3, group: "dolbye", group_channel: 0 },
            Route { src_track: 4, group: "dolbye", group_channel: 1 },
            Route { src_track: 5, group: "ad", group_channel: 0 },
            Route { src_track: 6, group: "ad", group_channel: 1 },
        ],
    },
    AudioPreset {
        id: "stereo-dolbye-ot-56",
        label: "Stereo/Dolby E/OT 5,6",
        routes: &[
            Route { src_track: 1, group: "pt", group_channel: 0 },
            Route { src_track: 2, group: "pt", group_channel: 1 },
            Route { src_track: 3, group: "dolbye", group_channel: 0 },
            Route { src_track: 4, group: "dolbye", group_channel: 1 },
            Route { src_track: 5, group: "ot", group_channel: 0 },
            Route { src_track: 6, group: "ot", group_channel: 1 },
        ],
    },
    AudioPreset {
        id: "stereo-dolbye-ot",
        label: "Stereo/Dolby E/OT",
        routes: &[
            Route { src_track: 1, group: "pt", group_channel: 0 },
            Route { src_track: 2, group: "pt", group_channel: 1 },
            Route { src_track: 3, group: "dolbye", group_channel: 0 },
            Route { src_track: 4, group: "dolbye", group_channel: 1 },
            Route { src_track: 7, group: "ot", group_channel: 0 },
            Route { src_track: 8, group: "ot", group_channel: 1 },
        ],
    },
    AudioPreset {
        id: "stereo-dolbye-hoerfilm-ot",
        label: "Stereo/Dolby E/Hörfilm/OT",
        routes: &[
            Route { src_track: 1, group: "pt", group_channel: 0 },
            Route { src_track: 2, group: "pt", group_channel: 1 },
            Route { src_track: 3, group: "dolbye", group_channel: 0 },
            Route { src_track: 4, group: "dolbye", group_channel: 1 },
            Route { src_track: 5, group: "ad", group_channel: 0 },
            Route { src_track: 6, group: "ad", group_channel: 1 },
            Route { src_track: 7, group: "ot", group_channel: 0 },
            Route { src_track: 8, group: "ot", group_channel: 1 },
        ],
    },
    AudioPreset {
        id: "stereo-51-diskret",
        label: "Stereo/5.1 diskret",
        routes: &[
            // 1/2: Stereo-Kompatibilitäts-Downmix fürs pt-Programm.
            Route { src_track: 1, group: "pt", group_channel: 0 },
            Route { src_track: 2, group: "pt", group_channel: 1 },
            // 3/4: 5.1 L/R, 5/6: 5.1 C/LFE, 7/8: 5.1 SL/SR (PDF S.5).
            Route { src_track: 3, group: "surround51", group_channel: 0 },
            Route { src_track: 4, group: "surround51", group_channel: 1 },
            Route { src_track: 5, group: "surround51", group_channel: 2 },
            Route { src_track: 6, group: "surround51", group_channel: 3 },
            Route { src_track: 7, group: "surround51", group_channel: 4 },
            Route { src_track: 8, group: "surround51", group_channel: 5 },
        ],
    },
];

pub fn find_preset(id: &str) -> Option<&'static AudioPreset> {
    PRESETS.iter().find(|p| p.id == id)
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
