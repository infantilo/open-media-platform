//! Liest eine MXL-`flow_def` (JSON) in das Eingangsformat.

use serde::Serialize;

use crate::house::{Rate, Scan};

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct VideoIn {
    pub media_type: String,
    pub width: u32,
    pub height: u32,
    pub rate: Rate,
    pub scan: Scan,
    pub colorspace: Option<String>,
    pub transfer: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AudioIn {
    pub media_type: String,
    pub sample_rate: u32,
    pub channels: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct InputFormat {
    pub video: Option<VideoIn>,
    pub audio: Option<AudioIn>,
}

fn rational(v: &serde_json::Value) -> Option<(u64, u64)> {
    if let Some(n) = v.as_u64() {
        return Some((n, 1));
    }
    let n = v.get("numerator")?.as_u64()?;
    let d = v
        .get("denominator")
        .and_then(|x| x.as_u64())
        .unwrap_or(1)
        .max(1);
    Some((n, d))
}

/// Video-`flow_def` → `VideoIn`.
pub fn parse_video(json: &str) -> Result<VideoIn, String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("flow_def: {e}"))?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let media_type = s("media_type").ok_or("flow_def ohne media_type")?;
    if !media_type.starts_with("video/") {
        return Err(format!("flow_def: Medientyp {media_type} ist kein Video"));
    }
    let n = |k: &str| v.get(k).and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let (width, height) = (n("frame_width"), n("frame_height"));
    if width == 0 || height == 0 {
        return Err("flow_def ohne Bildgröße".into());
    }
    let (rn, rd) = v
        .get("grain_rate")
        .and_then(rational)
        .ok_or("flow_def ohne grain_rate")?;
    if rn == 0 {
        return Err("flow_def: grain_rate 0".into());
    }
    Ok(VideoIn {
        media_type,
        width,
        height,
        rate: Rate::new(rn as u32, rd as u32),
        scan: Scan::from_mode(s("interlace_mode").as_deref().unwrap_or("progressive")),
        colorspace: s("colorspace"),
        transfer: s("transfer_characteristic"),
    })
}

/// Ton-`flow_def` → `AudioIn`.
pub fn parse_audio(json: &str) -> Result<AudioIn, String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("flow_def: {e}"))?;
    let media_type = v
        .get("media_type")
        .and_then(|x| x.as_str())
        .ok_or("flow_def ohne media_type")?
        .to_string();
    if !media_type.starts_with("audio/") {
        return Err(format!("flow_def: Medientyp {media_type} ist kein Ton"));
    }
    let sample_rate = v
        .get("sample_rate")
        .and_then(rational)
        .ok_or("flow_def ohne sample_rate")?
        .0 as u32;
    let channels = v
        .get("channel_count")
        .and_then(|x| x.as_u64())
        .ok_or("flow_def ohne channel_count")? as u32;
    if sample_rate == 0 || channels == 0 {
        return Err("flow_def: Abtastrate oder Kanalzahl 0".into());
    }
    Ok(AudioIn {
        media_type,
        sample_rate,
        channels,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_wird_gelesen() {
        let d = r#"{"media_type":"video/v210","frame_width":1920,"frame_height":1080,"grain_rate":{"numerator":25,"denominator":1},
            "interlace_mode":"interlaced_tff","colorspace":"BT709","transfer_characteristic":"SDR"}"#;
        let v = parse_video(d).unwrap();
        assert_eq!((v.width, v.height), (1920, 1080));
        assert_eq!(v.rate, Rate::new(25, 1));
        assert_eq!(v.scan, Scan::InterlacedTff);
        assert_eq!(v.colorspace.as_deref(), Some("BT709"));
        assert_eq!(v.transfer.as_deref(), Some("SDR"));
    }

    #[test]
    fn video_fehlende_felder_sind_fehler_oder_unbekannt() {
        assert!(parse_video(r#"{"media_type":"video/v210"}"#).is_err());
        let v = parse_video(r#"{"media_type":"video/v210","frame_width":320,"frame_height":180,"grain_rate":{"numerator":25}}"#).unwrap();
        assert_eq!(v.scan, Scan::Progressive);
        assert_eq!(v.colorspace, None);
        assert!(parse_audio(r#"{"media_type":"video/v210"}"#).is_err());
    }

    #[test]
    fn ton_wird_gelesen() {
        let a = parse_audio(
            r#"{"media_type":"audio/float32","sample_rate":{"numerator":48000},"channel_count":2}"#,
        )
        .unwrap();
        assert_eq!((a.sample_rate, a.channels), (48000, 2));
    }
}
