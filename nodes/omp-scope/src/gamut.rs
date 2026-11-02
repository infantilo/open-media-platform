//! Gamut-Prüfung nach **EBU R 103 v3.0** („Video Signal Tolerance in Digital Television
//! Systems“, Mai 2020, Annex 1) — UMSETZUNG.md Kapitel 78.3.
//!
//! Normtext, soweit hier umgesetzt:
//! * Die Komponenten **R, G, B und die Luminanz Y** sollen den bevorzugten Bereich
//!   („Preferred Min./Max.“) nicht verlassen, 8 Bit: **5 … 246** (10 Bit: 20 … 984, also das
//!   Vierfache — die Prüfung gilt daher bei jeder Quell-Bittiefe auf dem 8-Bit-Analysebild).
//! * Ein Wert außerhalb ist ein **Gamut-Fehler**. Angezeigt wird „Out-of-Gamut“ erst, wenn der
//!   Fehler **1 % des Bildes** überschreitet.
//! * Vor der Messung wird gefiltert: horizontal 1/16·(1,2,3,4,3,2,1), vertikal 1/4·(1,2,1).
//!   (Bei Halbbildern innerhalb des Halbbilds; das Analysebild ist ein Vollbild, siehe unten.)
//! * Bereiche außerhalb des aktiven Bildes werden ausgenommen — das Analysebild enthält
//!   ausschließlich das aktive Bild.
//!
//! **Abweichungen/Grenzen, bewusst benannt:**
//! * Gemessen wird auf dem *herunterskalierten* Analysebild (`WAVEFORM_WIDTH`×`ANALYSIS_HEIGHT`),
//!   nicht auf voller Auflösung. Die Skalierung wirkt selbst wie ein Tiefpass; ein einzelnes
//!   hellstes Pixel der Quelle kann dadurch unterhalb der Schwelle landen. Der Flächenanteil
//!   ist deshalb eine Näherung, keine Abnahmemessung. Eine Messung in Vollauflösung wäre ein
//!   eigener Schritt.
//! * Die Umrechnung YCbCr → R′G′B′ richtet sich nach dem `colorspace` der MXL-Flow-Deklaration
//!   (NMOS-Wert `BT601`/`BT709`/`BT2020`, sonst BT.709). Die falsche Matrix verschiebt Farbtöne und
//!   erzeugt scheinbare Gamut-Fehler — beim Testen der Datei-QC aufgefallen (ffmpeg kodiert
//!   ungetaggtes Material mit BT.601).
//! * R 103 nennt **keine Mindestdauer**. Die Haltezeit von [`GAMUT_HOLD_NS`] ist eine OMP-Wahl
//!   (gleiche Entprellung wie bei Schwarzbild), keine Vorgabe der Norm.
//! * R 103 empfiehlt Messen und Beurteilen, nicht automatisches Begrenzen — hier wird nichts
//!   korrigiert.

/// Bevorzugter Bereich für 8 Bit (R 103 v3.0, Table 1).
pub const PREFERRED_MIN: f32 = 5.0;
pub const PREFERRED_MAX: f32 = 246.0;

/// Ab diesem Anteil der Bildfläche (Prozent) zeigt R 103 „Out-of-Gamut“ an.
pub const AREA_LIMIT_PERCENT: f64 = 1.0;

/// OMP-Haltezeit, s. Moduldoku — nicht Teil der Norm.
pub const GAMUT_HOLD_NS: u64 = 1_000_000_000;

/// Koeffizienten der YCbCr→R′G′B′-Umrechnung: (Cr→R, Cb→G, Cr→G, Cb→B).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Matrix {
    cr_r: f32,
    cb_g: f32,
    cr_g: f32,
    cb_b: f32,
}

impl Matrix {
    pub const BT601: Matrix = Matrix { cr_r: 1.402, cb_g: 0.344136, cr_g: 0.714136, cb_b: 1.772 };
    pub const BT709: Matrix = Matrix { cr_r: 1.5748, cb_g: 0.1873, cr_g: 0.4681, cb_b: 1.8556 };
    pub const BT2020: Matrix = Matrix { cr_r: 1.4746, cb_g: 0.16455, cr_g: 0.57135, cb_b: 1.8814 };

    /// Aus dem `colorspace` der Flow-Deklaration (NMOS, z. B. "BT709"); unbekannt → BT.709.
    pub fn from_flow_colorspace(colorspace: Option<&str>) -> Matrix {
        match colorspace.map(|c| c.to_ascii_uppercase()).as_deref() {
            Some("BT601") => Matrix::BT601,
            Some("BT2020") | Some("BT2100") => Matrix::BT2020,
            _ => Matrix::BT709,
        }
    }
}

/// Ergebnis einer Einzelbildmessung. Anteile in Prozent der Bildfläche.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct GamutMeasurement {
    /// Fläche, auf der mindestens eine der Größen R, G, B, Y außerhalb liegt.
    pub area_percent: f64,
    pub r_percent: f64,
    pub g_percent: f64,
    pub b_percent: f64,
    pub y_percent: f64,
    /// Davon oberhalb der oberen Grenze (Spitzen) bzw. unterhalb der unteren (Tiefen).
    pub high_percent: f64,
    pub low_percent: f64,
}

impl GamutMeasurement {
    /// R 103: Fehler erst über 1 % der Bildfläche.
    pub fn exceeds_limit(&self) -> bool {
        self.area_percent > AREA_LIMIT_PERCENT
    }
}

/// Filter nach R 103: 7 Taps horizontal, 3 Taps vertikal, Ränder durch Wiederholen des Randpixels.
fn filter(plane: &[f32], w: usize, h: usize) -> Vec<f32> {
    const H: [f32; 7] = [1.0, 2.0, 3.0, 4.0, 3.0, 2.0, 1.0];
    let mut tmp = vec![0.0f32; w * h];
    for row in 0..h {
        for x in 0..w {
            let mut acc = 0.0;
            for (k, c) in H.iter().enumerate() {
                let xi = (x + k).saturating_sub(3).min(w - 1);
                acc += c * plane[row * w + xi];
            }
            tmp[row * w + x] = acc / 16.0;
        }
    }
    let mut out = vec![0.0f32; w * h];
    for row in 0..h {
        let up = row.saturating_sub(1);
        let down = (row + 1).min(h - 1);
        for x in 0..w {
            out[row * w + x] = (tmp[up * w + x] + 2.0 * tmp[row * w + x] + tmp[down * w + x]) / 4.0;
        }
    }
    out
}

/// Misst ein I420-Bild (8 Bit, Video-Range, Y `w`×`h`, Cb/Cr `w/2`×`h/2`, dicht gepackt).
/// `None` bei unpassenden Größen.
pub fn measure(y: &[u8], u: &[u8], v: &[u8], w: usize, h: usize, mx: Matrix) -> Option<GamutMeasurement> {
    if w < 2 || h < 2 || y.len() != w * h || u.len() != (w / 2) * (h / 2) || v.len() != u.len() {
        return None;
    }
    let (cw, _ch) = (w / 2, h / 2);
    let mut r = vec![0.0f32; w * h];
    let mut g = vec![0.0f32; w * h];
    let mut b = vec![0.0f32; w * h];
    let mut luma = vec![0.0f32; w * h];
    for row in 0..h {
        for x in 0..w {
            let i = row * w + x;
            let ci = (row / 2) * cw + (x / 2);
            let yy = (y[i] as f32 - 16.0) / 219.0;
            let cb = (u[ci] as f32 - 128.0) / 224.0;
            let cr = (v[ci] as f32 - 128.0) / 224.0;
            let rr = yy + mx.cr_r * cr;
            let bb = yy + mx.cb_b * cb;
            let gg = yy - mx.cb_g * cb - mx.cr_g * cr;
            // Zurück in 8-Bit-Codewerte (Video-Range), ohne zu begrenzen.
            r[i] = 16.0 + 219.0 * rr;
            g[i] = 16.0 + 219.0 * gg;
            b[i] = 16.0 + 219.0 * bb;
            luma[i] = y[i] as f32;
        }
    }
    let (r, g, b, luma) = (filter(&r, w, h), filter(&g, w, h), filter(&b, w, h), filter(&luma, w, h));

    let n = (w * h) as f64;
    let (mut any, mut rc, mut gc, mut bc, mut yc, mut hi, mut lo) = (0u32, 0u32, 0u32, 0u32, 0u32, 0u32, 0u32);
    for i in 0..w * h {
        let comps = [r[i], g[i], b[i], luma[i]];
        let out_of = |c: f32| !(PREFERRED_MIN..=PREFERRED_MAX).contains(&c);
        let flags = comps.map(out_of);
        if flags[0] {
            rc += 1;
        }
        if flags[1] {
            gc += 1;
        }
        if flags[2] {
            bc += 1;
        }
        if flags[3] {
            yc += 1;
        }
        if flags.iter().any(|&f| f) {
            any += 1;
            if comps.iter().any(|&c| c > PREFERRED_MAX) {
                hi += 1;
            }
            if comps.iter().any(|&c| c < PREFERRED_MIN) {
                lo += 1;
            }
        }
    }
    let pct = |c: u32| c as f64 / n * 100.0;
    Some(GamutMeasurement {
        area_percent: pct(any),
        r_percent: pct(rc),
        g_percent: pct(gc),
        b_percent: pct(bc),
        y_percent: pct(yc),
        high_percent: pct(hi),
        low_percent: pct(lo),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 64;
    const H: usize = 36;

    fn flat(y: u8, cb: u8, cr: u8) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        (vec![y; W * H], vec![cb; W * H / 4], vec![cr; W * H / 4])
    }

    #[test]
    fn nominal_grey_is_legal() {
        let (y, u, v) = flat(126, 128, 128);
        let m = measure(&y, &u, &v, W, H, Matrix::BT709).unwrap();
        assert_eq!(m.area_percent, 0.0);
        assert!(!m.exceeds_limit());
    }

    #[test]
    fn nominal_black_and_white_are_legal() {
        for level in [16u8, 235] {
            let (y, u, v) = flat(level, 128, 128);
            assert_eq!(measure(&y, &u, &v, W, H, Matrix::BT709).unwrap().area_percent, 0.0, "Y={level}");
        }
    }

    /// Y = 250 liegt über 246 → ganzes Bild Gamut-Fehler, auch im Luma-Anteil.
    #[test]
    fn superwhite_above_preferred_max_is_flagged() {
        let (y, u, v) = flat(250, 128, 128);
        let m = measure(&y, &u, &v, W, H, Matrix::BT709).unwrap();
        assert!((m.area_percent - 100.0).abs() < 1e-9);
        assert!((m.y_percent - 100.0).abs() < 1e-9);
        assert!((m.high_percent - 100.0).abs() < 1e-9);
        assert_eq!(m.low_percent, 0.0);
        assert!(m.exceeds_limit());
    }

    /// Y = 3 liegt unter 5 → Tiefen-Fehler.
    #[test]
    fn subblack_below_preferred_min_is_flagged_as_low() {
        let (y, u, v) = flat(3, 128, 128);
        let m = measure(&y, &u, &v, W, H, Matrix::BT709).unwrap();
        assert!((m.low_percent - 100.0).abs() < 1e-9);
        assert_eq!(m.high_percent, 0.0);
    }

    /// Y nominal, aber stark gesättigtes Rot: Luma legal, R deutlich über der Grenze —
    /// genau der Fall, den eine reine Luma-Prüfung übersieht.
    #[test]
    fn saturated_colour_is_caught_in_rgb_but_not_in_luma() {
        let (y, u, v) = flat(100, 128, 240);
        let m = measure(&y, &u, &v, W, H, Matrix::BT709).unwrap();
        assert_eq!(m.y_percent, 0.0);
        assert!(m.r_percent > 99.0, "R-Anteil {}", m.r_percent);
        assert!(m.exceeds_limit());
    }

    /// Ein kleiner Fleck unter 1 % der Fläche löst nach R 103 keinen Alarm aus.
    #[test]
    fn small_excursion_below_one_percent_does_not_exceed_limit() {
        let (mut y, u, v) = flat(126, 128, 128);
        // 2×2 Pixel ≈ 0,17 % von 64×36; das Filter verschmiert den Fleck auf wenige Nachbarn.
        for (r, c) in [(10, 10), (10, 11), (11, 10), (11, 11)] {
            y[r * W + c] = 255;
        }
        let m = measure(&y, &u, &v, W, H, Matrix::BT709).unwrap();
        assert!(m.area_percent < AREA_LIMIT_PERCENT, "{}", m.area_percent);
        assert!(!m.exceeds_limit());
    }

    /// Das Filter unterdrückt eine einzelne Spitze (ein Pixel, kein Alarm), bleibt aber bei
    /// flächigem Überschwingen wirksam.
    #[test]
    fn filter_suppresses_single_pixel_spike() {
        let (mut y, u, v) = flat(235, 128, 128);
        y[18 * W + 32] = 255; // 235 + (20·4/16)/4 ≈ nach Filter weit unter 246
        let m = measure(&y, &u, &v, W, H, Matrix::BT709).unwrap();
        assert_eq!(m.area_percent, 0.0);
    }

    /// Dasselbe Pixel ist mit BT.601 und BT.709 verschieden zu deuten (Y=145, Cb=54, Cr=34: Rot
    /// unter 0 bei falscher Matrix) — Wert aus dem Fund mit der Test-Datei der Datei-QC.
    #[test]
    fn wrong_matrix_creates_false_gamut_error() {
        let (y, u, v) = flat(145, 54, 34);
        assert!(measure(&y, &u, &v, W, H, Matrix::BT709).unwrap().exceeds_limit());
        assert!(!measure(&y, &u, &v, W, H, Matrix::BT601).unwrap().exceeds_limit());
        assert_eq!(Matrix::from_flow_colorspace(Some("BT601")), Matrix::BT601);
        assert_eq!(Matrix::from_flow_colorspace(None), Matrix::BT709);
    }

    #[test]
    fn wrong_plane_sizes_yield_none() {
        assert!(measure(&[0; 10], &[0; 3], &[0; 3], W, H, Matrix::BT709).is_none());
    }
}
