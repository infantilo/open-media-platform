//! Essenz-/Transport-Metadaten eines MXL-Flows, gelesen aus der
//! **`flow_def` der MXL-Domain selbst** (`MxlContext::flow_def`, also
//! `mxlGetFlowDef`) statt aus verhandelten GStreamer-Caps.
//!
//! **Warum diese Quelle und nicht die Caps:** die `flow_def` ist das,
//! was der SCHREIBER über seinen Flow behauptet — Grain-Rate,
//! Bittiefe, Farbraum, Interlace-Modus, NMOS-Grouphint. GStreamer-Caps
//! am Lesepfad sind davon bereits eine abgeleitete, durch die eigene
//! Konvertierungskette veränderte Sicht (genau der Fehler, der bei
//! `videoWidth` schon einmal zu einem Messwert wurde, der nur die
//! eigene Konfiguration widerspiegelte, s. docs/decisions.md Nachtrag
//! 225). Ein Messgerät muss beides zeigen können: die **Deklaration**
//! (hier) und das **Ist** (Pipeline-Messung in `timing`/`main`) — erst
//! die Differenz der beiden deckt einen falsch deklarierten Flow auf.
//!
//! Zusätzlich wird daraus die **Shared-Memory-Datenrate** des Flows
//! berechnet (Grain-Größe × Grain-Rate). Das ist ausdrücklich ein
//! *rechnerischer* Wert aus der Deklaration, keine Messung am Ringpuffer
//! — im UI auch so benannt.

use serde_json::Value;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct VideoFlowMeta {
    pub media_type: Option<String>,
    pub grain_rate: Option<(u64, u64)>,
    pub width: Option<u64>,
    pub height: Option<u64>,
    pub interlace_mode: Option<String>,
    pub colorspace: Option<String>,
    pub bit_depth: Option<u64>,
    /// NMOS-Grouphint (`urn:x-nmos:tag:grouphint/v1.0`) — die Angabe, über
    /// die MXL/NMOS zusammengehörige Video- und Audioflows derselben
    /// Quelle verbindet. Für eine Lipsync-Messung die entscheidende
    /// Zusatzinformation: gehören die beiden getappten Flows überhaupt
    /// zur selben Quelle?
    pub grouphint: Option<String>,
    pub label: Option<String>,
    /// Nutzlast eines Grains in Byte (bei `video/v210` nach der
    /// v210-Packungsregel, sonst aus Komponenten-Bittiefe geschätzt).
    pub grain_bytes: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AudioFlowMeta {
    pub media_type: Option<String>,
    pub sample_rate: Option<u64>,
    pub channel_count: Option<u64>,
    pub bit_depth: Option<u64>,
    pub grouphint: Option<String>,
    pub label: Option<String>,
}

fn string_field(v: &Value, key: &str) -> Option<String> {
    v.get(key)?.as_str().map(str::to_string)
}

fn u64_field(v: &Value, key: &str) -> Option<u64> {
    v.get(key)?.as_u64()
}

/// Erster Grouphint-Eintrag. Der Tag ist laut IS-04 ein ARRAY von
/// Strings (MXL verlangt mindestens einen Eintrag im Format
/// `<gruppe>:<rolle>`); hier interessiert der erste, weil OMPs eigene
/// Schreiber genau einen setzen — ein fremder Schreiber mit mehreren
/// wird dadurch nicht falsch dargestellt, nur unvollständig, und das ist
/// besser als einen zusammengeklebten Pseudowert zu zeigen.
fn grouphint(v: &Value) -> Option<String> {
    v.get("tags")?
        .get("urn:x-nmos:tag:grouphint/v1.0")?
        .as_array()?
        .first()?
        .as_str()
        .map(str::to_string)
}

/// Zeilenlänge eines v210-Bildes in Byte. v210 packt sechs 10-bit-
/// Abtastwerte in 16 Byte, und jede Zeile wird auf ein Vielfaches von
/// 128 Byte aufgerundet (SMPTE/Apple-v210-Konvention, dieselbe, die
/// GStreamers `video/x-raw,format=v210` benutzt).
pub fn v210_stride(width: u64) -> u64 {
    width.div_ceil(48) * 128
}

pub fn parse_video(json: &str) -> VideoFlowMeta {
    let Ok(v) = serde_json::from_str::<Value>(json) else {
        return VideoFlowMeta::default();
    };
    let media_type = string_field(&v, "media_type");
    let width = u64_field(&v, "frame_width");
    let height = u64_field(&v, "frame_height");
    let bit_depth = v
        .get("components")
        .and_then(Value::as_array)
        .and_then(|c| c.first())
        .and_then(|c| c.get("bit_depth"))
        .and_then(Value::as_u64);
    let grain_bytes = match (media_type.as_deref(), width, height, bit_depth) {
        (Some("video/v210"), Some(w), Some(h), _) => Some(v210_stride(w) * h),
        // Allgemeiner Fall: Summe über alle deklarierten Komponenten,
        // Bits auf ganze Byte aufgerundet. Deckt Chroma-Unterabtastung
        // korrekt ab, weil jede Komponente ihre EIGENE Breite/Höhe
        // deklariert.
        (_, _, _, _) => v.get("components").and_then(Value::as_array).map(|components| {
            let bits: u64 = components
                .iter()
                .map(|c| {
                    let w = c.get("width").and_then(Value::as_u64).unwrap_or(0);
                    let h = c.get("height").and_then(Value::as_u64).unwrap_or(0);
                    let d = c.get("bit_depth").and_then(Value::as_u64).unwrap_or(0);
                    w * h * d
                })
                .sum();
            bits.div_ceil(8)
        }),
    };
    VideoFlowMeta {
        media_type,
        grain_rate: rational(&v, "grain_rate"),
        width,
        height,
        interlace_mode: string_field(&v, "interlace_mode"),
        colorspace: string_field(&v, "colorspace"),
        bit_depth,
        grouphint: grouphint(&v),
        label: string_field(&v, "label"),
        grain_bytes,
    }
}

pub fn parse_audio(json: &str) -> AudioFlowMeta {
    let Ok(v) = serde_json::from_str::<Value>(json) else {
        return AudioFlowMeta::default();
    };
    AudioFlowMeta {
        media_type: string_field(&v, "media_type"),
        sample_rate: rational(&v, "sample_rate").map(|(n, _)| n),
        channel_count: u64_field(&v, "channel_count"),
        bit_depth: u64_field(&v, "bit_depth"),
        grouphint: grouphint(&v),
        label: string_field(&v, "label"),
    }
}

fn rational(v: &Value, key: &str) -> Option<(u64, u64)> {
    let r = v.get(key)?;
    let numerator = r.get("numerator")?.as_u64()?;
    // Nenner darf fehlen (MXL setzt ihn bei ganzzahligen Raten wie
    // 48000 Hz nicht immer) — dann 1, nicht "unbekannte Rate".
    let denominator = r.get("denominator").and_then(Value::as_u64).unwrap_or(1).max(1);
    Some((numerator, denominator))
}

/// Shared-Memory-Datenrate eines Videoflows in Mbit/s, rechnerisch aus
/// Grain-Größe und Grain-Rate.
pub fn video_bitrate_mbps(meta: &VideoFlowMeta) -> Option<f64> {
    let bytes = meta.grain_bytes?;
    let (n, d) = meta.grain_rate?;
    (d > 0).then(|| bytes as f64 * 8.0 * (n as f64 / d as f64) / 1e6)
}

/// Dasselbe für Audio. MXL speichert die Abtastwerte als 32-bit-Float
/// pro Kanal (s. `MxlAudioInput`s `interleave_samples`), sofern die
/// `flow_def` nichts anderes deklariert.
pub fn audio_bitrate_mbps(meta: &AudioFlowMeta) -> Option<f64> {
    let rate = meta.sample_rate?;
    let channels = meta.channel_count?;
    let bits = meta.bit_depth.unwrap_or(32);
    Some(rate as f64 * channels as f64 * bits as f64 / 1e6)
}

/// Gehören Video- und Audioflow laut ihren NMOS-Grouphints zur selben
/// Quelle? Der Grouphint hat das Format `<gruppe>:<rolle>` — verglichen
/// wird nur der Gruppenteil. `None`, solange nicht beide einen tragen.
pub fn same_group(video: &VideoFlowMeta, audio: &AudioFlowMeta) -> Option<bool> {
    let v = video.grouphint.as_deref()?;
    let a = audio.grouphint.as_deref()?;
    let group = |s: &str| s.rsplit_once(':').map(|(g, _)| g.to_string()).unwrap_or_else(|| s.to_string());
    Some(group(v) == group(a))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exakt das Format, das `omp_mediaio::mxl::video_flow_def`
    /// schreibt (dort 1:1 nach `third_party/mxl/lib/tests/data/
    /// v210_flow.json` aufgebaut) — kein erfundenes Testschema.
    const VIDEO: &str = r#"{
        "id": "f1", "label": "Testquelle", "description": "OpenMediaPlatform: Testquelle",
        "tags": {"urn:x-nmos:tag:grouphint/v1.0": ["f1:Video"]},
        "format": "urn:x-nmos:format:video", "parents": [], "media_type": "video/v210",
        "grain_rate": {"numerator": 25, "denominator": 1},
        "frame_width": 640, "frame_height": 480,
        "interlace_mode": "progressive", "colorspace": "BT709",
        "components": [
            {"name": "Y", "width": 640, "height": 480, "bit_depth": 10},
            {"name": "Cb", "width": 320, "height": 480, "bit_depth": 10},
            {"name": "Cr", "width": 320, "height": 480, "bit_depth": 10}
        ]}"#;

    const AUDIO: &str = r#"{
        "id": "f2", "label": "Testquelle Audio",
        "tags": {"urn:x-nmos:tag:grouphint/v1.0": ["f1:Audio"]},
        "format": "urn:x-nmos:format:audio", "media_type": "audio/L24",
        "sample_rate": {"numerator": 48000, "denominator": 1},
        "channel_count": 2, "bit_depth": 32}"#;

    #[test]
    fn liest_video_deklaration_vollstaendig() {
        let m = parse_video(VIDEO);
        assert_eq!(m.media_type.as_deref(), Some("video/v210"));
        assert_eq!(m.grain_rate, Some((25, 1)));
        assert_eq!(m.width, Some(640));
        assert_eq!(m.height, Some(480));
        assert_eq!(m.interlace_mode.as_deref(), Some("progressive"));
        assert_eq!(m.colorspace.as_deref(), Some("BT709"));
        assert_eq!(m.bit_depth, Some(10));
        assert_eq!(m.grouphint.as_deref(), Some("f1:Video"));
        assert_eq!(m.label.as_deref(), Some("Testquelle"));
    }

    #[test]
    fn v210_zeilenlaenge_folgt_der_128_byte_regel() {
        // 640 Pixel → 14 Blöcke à 48 Pixel (aufgerundet) → 14 × 128.
        assert_eq!(v210_stride(640), 14 * 128);
        assert_eq!(v210_stride(1920), 40 * 128);
        // Exakt teilbar: 48 Pixel = genau ein Block.
        assert_eq!(v210_stride(48), 128);
    }

    #[test]
    fn video_datenrate_aus_grain_groesse_und_rate() {
        let m = parse_video(VIDEO);
        assert_eq!(m.grain_bytes, Some(14 * 128 * 480));
        let mbps = video_bitrate_mbps(&m).expect("mbps");
        assert!((mbps - (14.0 * 128.0 * 480.0 * 8.0 * 25.0 / 1e6)).abs() < 1e-6);
        assert!(mbps > 170.0 && mbps < 175.0, "640×480@25 v210 ≈ 172 Mbit/s, war {mbps}");
    }

    #[test]
    fn nicht_v210_faellt_auf_komponenten_summe_zurueck() {
        let json = VIDEO.replace("video/v210", "video/raw");
        let m = parse_video(&json);
        // (640 + 320 + 320) × 480 × 10 bit / 8.
        assert_eq!(m.grain_bytes, Some(1280 * 480 * 10 / 8));
    }

    #[test]
    fn liest_audio_deklaration() {
        let m = parse_audio(AUDIO);
        assert_eq!(m.sample_rate, Some(48000));
        assert_eq!(m.channel_count, Some(2));
        assert_eq!(m.media_type.as_deref(), Some("audio/L24"));
        let mbps = audio_bitrate_mbps(&m).expect("mbps");
        assert!((mbps - 3.072).abs() < 1e-9);
    }

    #[test]
    fn grouphint_verbindet_video_und_audio_derselben_quelle() {
        assert_eq!(same_group(&parse_video(VIDEO), &parse_audio(AUDIO)), Some(true));
        let fremd = AUDIO.replace("f1:Audio", "andere-quelle:Audio");
        assert_eq!(same_group(&parse_video(VIDEO), &parse_audio(&fremd)), Some(false));
        // Ohne Grouphint auf einer Seite: keine Aussage, nicht "nein".
        assert_eq!(same_group(&VideoFlowMeta::default(), &parse_audio(AUDIO)), None);
    }

    #[test]
    fn kaputtes_json_liefert_leere_metadaten_statt_panik() {
        assert_eq!(parse_video("{nicht json"), VideoFlowMeta::default());
        assert_eq!(parse_audio(""), AudioFlowMeta::default());
    }
}
