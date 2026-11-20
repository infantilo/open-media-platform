//! Planung: Eingangsformat gegen Hausformat → nur die Stufen, die wirklich nötig sind. Passt alles, ist der Plan leer
//! und der Node kopiert bitgleich (kein Skalieren, keine Farbwandlung, kein Neuberechnen).
//!
//! Feste Stufenfolge (ARCHITECTURE §33.2 M3): Halbbild auflösen → Bildrate → Größe → Farbmatrix → Übertragungsfunktion →
//! Halbbild erzeugen; Ton: Kanalzuordnung → Abtastrate.
//!
//! Bildraten-Konvention wie MXL: bei Zeilensprung ist die Grain-Rate die **Vollbildrate** („1080i50“ = 25/1); die
//! Halbbildrate ist das Doppelte.

use serde::Serialize;

use crate::flowdef::InputFormat;
use crate::house::{HouseFormat, TransferPolicy};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    /// Pixelformat in das MXL-Videoformat (v210) bringen.
    PixelFormat,
    Deinterlace,
    FrameRate,
    Scale,
    ColorMatrix,
    TransferMap,
    Interlace,
    /// Tonformat in `audio/float32` bringen.
    SampleFormat,
    ChannelMap,
    Resample,
}

impl Stage {
    pub fn as_str(self) -> &'static str {
        match self {
            Stage::PixelFormat => "pixelFormat",
            Stage::Deinterlace => "deinterlace",
            Stage::FrameRate => "frameRate",
            Stage::Scale => "scale",
            Stage::ColorMatrix => "colorMatrix",
            Stage::TransferMap => "transferMap",
            Stage::Interlace => "interlace",
            Stage::SampleFormat => "sampleFormat",
            Stage::ChannelMap => "channelMap",
            Stage::Resample => "resample",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviationKind {
    MediaType,
    Scan,
    Rate,
    Size,
    Colorspace,
    Transfer,
    Channels,
    SampleRate,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Deviation {
    pub kind: DeviationKind,
    pub detail: String,
}

#[derive(Clone, Debug, Default)]
pub struct PlanOptions {
    /// Überstimmt `transferPolicy` des Hausformats.
    pub transfer_policy: Option<TransferPolicy>,
    /// Eingangskanäle (1-basiert), die nicht-PCM-Daten tragen: werden nie gemischt oder abgetastet.
    pub data_channels: Vec<u32>,
    /// Es gibt eine ausdrückliche Zuordnung Eingang → Haus (`normalize.audioMap`), das erzwingt die Kanalstufe.
    pub explicit_audio_map: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Plan {
    pub deviations: Vec<Deviation>,
    pub video_stages: Vec<Stage>,
    pub audio_stages: Vec<Stage>,
    /// Bild kann bitgleich kopiert werden (nichts zu tun und etwas da).
    pub copy_video: bool,
    pub copy_audio: bool,
    /// Grund, warum die Leitung nicht normalisiert wird (Sperre).
    pub blocked: Option<String>,
    /// Hinweise, die den Betrieb nicht stoppen (z. B. Übertragungsfunktion weicht ab, wird durchgereicht).
    pub warnings: Vec<String>,
    /// Beim Halbbild-Auflösen wird die doppelte Rate (Halbbilder werden Bilder) erzeugt; sonst nur ein Halbbild je Vollbild.
    pub deinterlace_double: bool,
}

impl Plan {
    pub fn all_stages(&self) -> Vec<Stage> {
        self.video_stages
            .iter()
            .chain(self.audio_stages.iter())
            .copied()
            .collect()
    }
}

fn same_ci(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

pub fn plan(input: &InputFormat, house: &HouseFormat, opts: &PlanOptions) -> Plan {
    let mut p = Plan::default();
    plan_video(input, house, opts, &mut p);
    plan_audio(input, house, opts, &mut p);
    if p.blocked.is_some() {
        p.copy_video = false;
        p.copy_audio = false;
    }
    p
}

fn plan_video(input: &InputFormat, house: &HouseFormat, opts: &PlanOptions, p: &mut Plan) {
    let Some(inp) = &input.video else { return };
    let Some(h) = &house.video else {
        // Keine Anforderung: durchreichen.
        p.copy_video = true;
        return;
    };

    if inp.media_type != "video/v210" {
        p.deviations.push(Deviation {
            kind: DeviationKind::MediaType,
            detail: format!("{} statt video/v210", inp.media_type),
        });
        p.video_stages.push(Stage::PixelFormat);
    }

    let size_diff = (inp.width, inp.height) != (h.width, h.height);
    let rate_diff = inp.rate != h.rate;
    let order_diff = inp.scan.is_interlaced() && h.scan.is_interlaced() && inp.scan != h.scan;
    let scan_diff = inp.scan.is_interlaced() != h.scan.is_interlaced() || order_diff;

    if size_diff {
        p.deviations.push(Deviation {
            kind: DeviationKind::Size,
            detail: format!(
                "{}×{} statt {}×{}",
                inp.width, inp.height, h.width, h.height
            ),
        });
    }
    if rate_diff {
        p.deviations.push(Deviation {
            kind: DeviationKind::Rate,
            detail: format!("{} statt {}", inp.rate, h.rate),
        });
    }
    if scan_diff {
        p.deviations.push(Deviation {
            kind: DeviationKind::Scan,
            detail: format!("{:?} statt {:?}", inp.scan, h.scan),
        });
    }

    // Arbeitsform ist progressiv; Zeilensprung-Eingang wird nur aufgelöst, wenn Größe, Rate, Raster oder Feldfolge
    // abweichen (reine Farbwandlung geht auch im Zeilensprung).
    let needs_progressive = inp.scan.is_interlaced() && (size_diff || rate_diff || scan_diff);
    let target_prog_rate = if h.scan.is_interlaced() {
        h.rate.doubled()
    } else {
        h.rate
    };
    let mut work_rate = inp.rate;
    let mut progressive_now = !inp.scan.is_interlaced();

    if needs_progressive {
        p.video_stages.push(Stage::Deinterlace);
        progressive_now = true;
        // Doppelte Rate (Halbbilder werden Bilder), wenn das zur Zielrate passt oder keine Rate passt.
        work_rate = if inp.rate == target_prog_rate {
            inp.rate
        } else {
            inp.rate.doubled()
        };
    }
    if progressive_now && work_rate != target_prog_rate {
        p.video_stages.push(Stage::FrameRate);
    }
    if size_diff {
        p.video_stages.push(Stage::Scale);
    }

    if let (Some(ci), Some(ch)) = (&inp.colorspace, &h.colorspace)
        && !same_ci(ci, ch)
    {
        p.deviations.push(Deviation {
            kind: DeviationKind::Colorspace,
            detail: format!("{ci} statt {ch}"),
        });
        p.video_stages.push(Stage::ColorMatrix);
    }

    if let (Some(ti), Some(th)) = (&inp.transfer, &h.transfer)
        && !same_ci(ti, th)
    {
        p.deviations.push(Deviation {
            kind: DeviationKind::Transfer,
            detail: format!("{ti} statt {th}"),
        });
        match opts.transfer_policy.unwrap_or(h.transfer_policy) {
            TransferPolicy::Warn => p.warnings.push(format!(
                "Übertragungsfunktion {ti} statt {th}: unverändert durchgereicht"
            )),
            TransferPolicy::Block => {
                p.blocked = Some(format!(
                    "Übertragungsfunktion {ti} statt {th} (Sperre eingestellt)"
                ))
            }
            TransferPolicy::Map => p.video_stages.push(Stage::TransferMap),
        }
    }

    if h.scan.is_interlaced() && progressive_now {
        p.video_stages.push(Stage::Interlace);
    }

    p.copy_video = p.video_stages.is_empty() && p.blocked.is_none();
}

fn plan_audio(input: &InputFormat, house: &HouseFormat, opts: &PlanOptions, p: &mut Plan) {
    let Some(inp) = &input.audio else { return };
    let Some(h) = &house.audio else {
        p.copy_audio = true;
        return;
    };

    if inp.media_type != "audio/float32" {
        p.deviations.push(Deviation {
            kind: DeviationKind::MediaType,
            detail: format!("{} statt audio/float32", inp.media_type),
        });
        p.audio_stages.push(Stage::SampleFormat);
    }
    if inp.channels != h.channels || opts.explicit_audio_map {
        if inp.channels != h.channels {
            p.deviations.push(Deviation {
                kind: DeviationKind::Channels,
                detail: format!("{} statt {} Kanäle", inp.channels, h.channels),
            });
        }
        p.audio_stages.push(Stage::ChannelMap);
    }
    if inp.sample_rate != h.sample_rate {
        p.deviations.push(Deviation {
            kind: DeviationKind::SampleRate,
            detail: format!("{} Hz statt {} Hz", inp.sample_rate, h.sample_rate),
        });
        p.audio_stages.push(Stage::Resample);
        if !opts.data_channels.is_empty() {
            p.blocked = Some("Datenkanäle (nicht-PCM) können nicht abgetastet werden: Abtastratenwandlung gesperrt".into());
        }
    }
    p.copy_audio = p.audio_stages.is_empty() && p.blocked.is_none();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flowdef::{AudioIn, VideoIn};
    use crate::house::{AudioHouse, Rate, Scan, VideoHouse};

    fn vin(w: u32, h: u32, rate: (u32, u32), scan: Scan, cs: &str) -> VideoIn {
        VideoIn {
            media_type: "video/v210".into(),
            width: w,
            height: h,
            rate: Rate::new(rate.0, rate.1),
            scan,
            colorspace: Some(cs.into()),
            transfer: Some("SDR".into()),
        }
    }
    fn vh(w: u32, h: u32, rate: (u32, u32), scan: Scan, cs: &str) -> VideoHouse {
        VideoHouse {
            width: w,
            height: h,
            rate: Rate::new(rate.0, rate.1),
            scan,
            colorspace: Some(cs.into()),
            transfer: Some("SDR".into()),
            transfer_policy: TransferPolicy::Warn,
        }
    }
    fn ain(rate: u32, ch: u32) -> AudioIn {
        AudioIn {
            media_type: "audio/float32".into(),
            sample_rate: rate,
            channels: ch,
        }
    }
    fn ah(rate: u32, ch: u32) -> AudioHouse {
        AudioHouse {
            sample_rate: rate,
            channels: ch,
            groups: vec![],
        }
    }
    fn vplan(i: VideoIn, h: VideoHouse) -> Plan {
        plan(
            &InputFormat {
                video: Some(i),
                audio: None,
            },
            &HouseFormat {
                video: Some(h),
                audio: None,
            },
            &PlanOptions::default(),
        )
    }

    #[test]
    fn eingang_gleich_haus_ist_leerer_plan_und_kopie() {
        let i = InputFormat {
            video: Some(vin(1920, 1080, (25, 1), Scan::InterlacedTff, "BT709")),
            audio: Some(ain(48000, 16)),
        };
        let h = HouseFormat {
            video: Some(vh(1920, 1080, (25, 1), Scan::InterlacedTff, "BT709")),
            audio: Some(ah(48000, 16)),
        };
        let p = plan(&i, &h, &PlanOptions::default());
        assert!(p.deviations.is_empty());
        assert!(p.video_stages.is_empty() && p.audio_stages.is_empty());
        assert!(p.copy_video && p.copy_audio);
        assert!(p.blocked.is_none());
    }

    #[test]
    fn gleiche_rate_in_anderer_schreibweise_keine_stufe() {
        let p = vplan(
            vin(1280, 720, (50, 2), Scan::Progressive, "BT709"),
            vh(1280, 720, (25, 1), Scan::Progressive, "BT709"),
        );
        assert!(p.video_stages.is_empty() && p.copy_video);
    }

    #[test]
    fn p5994_nach_i50_ist_rate_plus_halbbild_erzeugen() {
        let p = vplan(
            vin(1920, 1080, (60000, 1001), Scan::Progressive, "BT709"),
            vh(1920, 1080, (25, 1), Scan::InterlacedTff, "BT709"),
        );
        assert_eq!(p.video_stages, vec![Stage::FrameRate, Stage::Interlace]);
    }

    #[test]
    fn p50_720_nach_i50_1080_ist_groesse_plus_halbbild_erzeugen() {
        let p = vplan(
            vin(1280, 720, (50, 1), Scan::Progressive, "BT709"),
            vh(1920, 1080, (25, 1), Scan::InterlacedTff, "BT709"),
        );
        assert_eq!(p.video_stages, vec![Stage::Scale, Stage::Interlace]);
    }

    #[test]
    fn i50_bt601_nach_bt709_nur_farbmatrix() {
        let p = vplan(
            vin(1920, 1080, (25, 1), Scan::InterlacedTff, "BT601"),
            vh(1920, 1080, (25, 1), Scan::InterlacedTff, "BT709"),
        );
        assert_eq!(p.video_stages, vec![Stage::ColorMatrix]);
        assert!(!p.copy_video);
    }

    #[test]
    fn i50_nach_p50_ist_halbbild_aufloesen_mit_doppelter_rate_ohne_ratenstufe() {
        let p = vplan(
            vin(1920, 1080, (25, 1), Scan::InterlacedTff, "BT709"),
            vh(1920, 1080, (50, 1), Scan::Progressive, "BT709"),
        );
        assert_eq!(p.video_stages, vec![Stage::Deinterlace]);
    }

    #[test]
    fn p50_nach_i50_gleiche_groesse_nur_halbbild_erzeugen() {
        let p = vplan(
            vin(1920, 1080, (50, 1), Scan::Progressive, "BT709"),
            vh(1920, 1080, (25, 1), Scan::InterlacedTff, "BT709"),
        );
        assert_eq!(p.video_stages, vec![Stage::Interlace]);
    }

    #[test]
    fn i50_anderes_raster_wird_aufgeloest_skaliert_und_wieder_verschraenkt() {
        let p = vplan(
            vin(1440, 1080, (25, 1), Scan::InterlacedTff, "BT709"),
            vh(1920, 1080, (25, 1), Scan::InterlacedTff, "BT709"),
        );
        assert_eq!(
            p.video_stages,
            vec![Stage::Deinterlace, Stage::Scale, Stage::Interlace]
        );
    }

    #[test]
    fn feldfolge_bff_nach_tff_loest_auf_und_verschraenkt() {
        let p = vplan(
            vin(1920, 1080, (25, 1), Scan::InterlacedBff, "BT709"),
            vh(1920, 1080, (25, 1), Scan::InterlacedTff, "BT709"),
        );
        assert_eq!(p.video_stages, vec![Stage::Deinterlace, Stage::Interlace]);
    }

    #[test]
    fn feste_reihenfolge_bei_allen_abweichungen() {
        let p = vplan(
            vin(720, 576, (25, 1), Scan::InterlacedTff, "BT601"),
            vh(1280, 720, (60000, 1001), Scan::Progressive, "BT709"),
        );
        assert_eq!(
            p.video_stages,
            vec![
                Stage::Deinterlace,
                Stage::FrameRate,
                Stage::Scale,
                Stage::ColorMatrix
            ]
        );
    }

    #[test]
    fn hlg_eingang_bei_sdr_haus_warnt_oder_sperrt_oder_bildet_ab() {
        let mut i = vin(1920, 1080, (25, 1), Scan::Progressive, "BT2020");
        i.transfer = Some("HLG".into());
        let mut h = vh(1920, 1080, (25, 1), Scan::Progressive, "BT2020");
        let warn = vplan(i.clone(), h.clone());
        assert!(
            warn.blocked.is_none() && warn.warnings.len() == 1 && warn.copy_video,
            "Warnung: durchreichen"
        );
        h.transfer_policy = TransferPolicy::Block;
        let blocked = vplan(i.clone(), h.clone());
        assert!(blocked.blocked.is_some() && !blocked.copy_video);
        h.transfer_policy = TransferPolicy::Map;
        let mapped = vplan(i, h);
        assert_eq!(mapped.video_stages, vec![Stage::TransferMap]);
    }

    #[test]
    fn option_ueberstimmt_die_richtlinie_des_hausformats() {
        let mut i = vin(1920, 1080, (25, 1), Scan::Progressive, "BT709");
        i.transfer = Some("PQ".into());
        let h = vh(1920, 1080, (25, 1), Scan::Progressive, "BT709");
        let p = plan(
            &InputFormat {
                video: Some(i),
                audio: None,
            },
            &HouseFormat {
                video: Some(h),
                audio: None,
            },
            &PlanOptions {
                transfer_policy: Some(TransferPolicy::Block),
                ..Default::default()
            },
        );
        assert!(p.blocked.is_some());
    }

    #[test]
    fn ton_abweichungen_in_fester_reihenfolge() {
        let i = InputFormat {
            video: None,
            audio: Some(ain(44100, 2)),
        };
        let h = HouseFormat {
            video: None,
            audio: Some(ah(48000, 16)),
        };
        let p = plan(&i, &h, &PlanOptions::default());
        assert_eq!(p.audio_stages, vec![Stage::ChannelMap, Stage::Resample]);
        let only_rate = plan(
            &InputFormat {
                video: None,
                audio: Some(ain(44100, 16)),
            },
            &h,
            &PlanOptions::default(),
        );
        assert_eq!(only_rate.audio_stages, vec![Stage::Resample]);
    }

    #[test]
    fn ausdrueckliche_zuordnung_erzwingt_kanalstufe_auch_bei_gleicher_kanalzahl() {
        let i = InputFormat {
            video: None,
            audio: Some(ain(48000, 16)),
        };
        let h = HouseFormat {
            video: None,
            audio: Some(ah(48000, 16)),
        };
        let p = plan(
            &i,
            &h,
            &PlanOptions {
                explicit_audio_map: true,
                ..Default::default()
            },
        );
        assert_eq!(p.audio_stages, vec![Stage::ChannelMap]);
        assert!(!p.copy_audio);
    }

    #[test]
    fn datenkanaele_sperren_die_abtastratenwandlung() {
        let i = InputFormat {
            video: None,
            audio: Some(ain(44100, 2)),
        };
        let h = HouseFormat {
            video: None,
            audio: Some(ah(48000, 2)),
        };
        let p = plan(
            &i,
            &h,
            &PlanOptions {
                data_channels: vec![2],
                ..Default::default()
            },
        );
        assert!(p.blocked.is_some());
        assert!(!p.copy_audio);
    }

    #[test]
    fn haus_ohne_videoteil_reicht_video_durch_und_ton_bleibt_unabhaengig() {
        let i = InputFormat {
            video: Some(vin(320, 180, (25, 1), Scan::Progressive, "BT709")),
            audio: Some(ain(44100, 2)),
        };
        let h = HouseFormat {
            video: None,
            audio: Some(ah(48000, 2)),
        };
        let p = plan(&i, &h, &PlanOptions::default());
        assert!(p.copy_video && p.video_stages.is_empty());
        assert_eq!(p.audio_stages, vec![Stage::Resample]);
    }

    #[test]
    fn unbekannte_farbmatrix_im_eingang_ist_keine_abweichung() {
        let mut i = vin(1920, 1080, (25, 1), Scan::Progressive, "BT709");
        i.colorspace = None;
        let p = vplan(i, vh(1920, 1080, (25, 1), Scan::Progressive, "BT709"));
        assert!(p.video_stages.is_empty() && p.copy_video);
    }

    #[test]
    fn fremdes_pixelformat_braucht_umwandlung() {
        let mut i = vin(1920, 1080, (25, 1), Scan::Progressive, "BT709");
        i.media_type = "video/raw".into();
        let p = vplan(i, vh(1920, 1080, (25, 1), Scan::Progressive, "BT709"));
        assert_eq!(p.video_stages, vec![Stage::PixelFormat]);
    }
}
