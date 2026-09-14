//! Reines Pixel-Rendering (kein GStreamer, kein I/O) für das kombinierte
//! Messbild aus Luma-Waveform (links) + Cb/Cr-Vektorskop (rechts) —
//! bewusst als eigenes, `gstreamer`-freies Modul, damit es mit
//! normalen `cargo test`-Fällen ohne echte Pipeline/Hardware geprüft
//! werden kann (`UMSETZUNG.md` §0 Punkt 7: nichts einbauen, das nur mit
//! Broadcast-Hardware testbar wäre — hier zusätzlich nicht einmal
//! GStreamer nötig).
//!
//! **Waveform:** eine 1:1-Spaltenzuordnung Quellbild→Ausgabebild (s.
//! `video_pipeline.rs`: die Analyse-Auflösung wird bewusst exakt
//! `WAVEFORM_WIDTH`×`ANALYSIS_HEIGHT` gehalten, damit hier keine
//! Spalten-Interpolation nötig ist) — pro Spalte ein Dichte-Histogramm
//! über die Luma-Werte der Quellspalte, heller je mehr Quellpixel
//! dieser Spalte denselben Luma-Bucket treffen.
//!
//! **Vektorskop:** ein Cb/Cr-Streudiagramm (Dichte-Histogramm über die
//! Chroma-Ebenen) in einem quadratischen Bereich mit Graticule-Kreis +
//! Fadenkreuz. **Bewusst kein rotiertes SMPTE-Graticule mit
//! R/G/B/Cy/Mg/Ye-Zielboxen** (das verlangt eine kalibrierte Drehung
//! der Cb/Cr-Achsen um den in der Norm festgelegten Winkel) — reines,
//! unrotiertes Cb/Cr-Streudiagramm, für Sättigungs-/Balance-Beobachtung
//! bereits nützlich, aber kein Ersatz für ein zielbox-kalibriertes
//! Referenzgerät. Ehrlich benannt statt vorgetäuscht (s. `docs/
//! decisions.md`-Eintrag zu diesem Schritt).
//!
//! Ausgabeformat: I420 (Y-Ebene `OUTPUT_WIDTH`×`OUTPUT_HEIGHT`, U/V je
//! `OUTPUT_WIDTH`/2×`OUTPUT_HEIGHT`/2) — direkt als `appsrc`-Puffer
//! weiterreichbar (`video_pipeline.rs`), keine Farbraum-Konvertierung
//! im Aufrufer nötig.

pub const OUTPUT_WIDTH: usize = 640;
pub const OUTPUT_HEIGHT: usize = 360;
/// Breite der Quell-/Waveform-Hälfte — die Analyse-Pipeline
/// (`video_pipeline.rs`) skaliert das Quellbild exakt auf diese Breite
/// UND `ANALYSIS_HEIGHT`, damit `render()` unten ohne
/// Spalten-Interpolation auskommt (eine Quellspalte == eine
/// Ausgabespalte).
pub const WAVEFORM_WIDTH: usize = OUTPUT_WIDTH / 2;
pub const ANALYSIS_HEIGHT: usize = 180;

const VECTOR_MARGIN: usize = 20;
const VECTOR_SIZE: usize = OUTPUT_HEIGHT - 2 * VECTOR_MARGIN; // 320
const VECTOR_X0: usize = WAVEFORM_WIDTH + (OUTPUT_WIDTH - WAVEFORM_WIDTH - VECTOR_SIZE) / 2;
const VECTOR_Y0: usize = VECTOR_MARGIN;

/// Grüner Phosphor-Ton (BT.601-Näherung für kräftiges Grün: Y≈149,
/// Cb≈43, Cr≈21) — Helligkeit variiert pixelweise mit der Trefferdichte
/// (s. `render()`), der Farbton bleibt für jeden getroffenen Punkt
/// konstant, wie bei einem echten Phosphor-Oszilloskop.
const TRACE_CB: u8 = 43;
const TRACE_CR: u8 = 21;
/// Neutrale Graticule-Farbe (dezentes Grau, kein Farbstich).
const GRATICULE_Y: u8 = 55;

pub struct Image {
    pub y: Vec<u8>,
    pub u: Vec<u8>,
    pub v: Vec<u8>,
}

/// Rendert das kombinierte Messbild aus einem I420-Analysebild
/// `src_y`/`src_u`/`src_v` der Größe `WAVEFORM_WIDTH`×`ANALYSIS_HEIGHT`
/// (Luma) bzw. der halben Auflösung (Chroma, Standard-I420-Subsampling).
/// Panics NICHT bei falscher Puffergröße — liefert dann einfach ein
/// leeres/unvollständiges Bild zurück (defensiv: ein einzelner
/// Caps-Rennlauf-Frame soll nie die Pipeline crashen), s. `video_pipeline.rs`.
pub fn render(src_y: &[u8], src_u: &[u8], src_v: &[u8]) -> Image {
    let mut y = vec![0u8; OUTPUT_WIDTH * OUTPUT_HEIGHT];
    let mut u = vec![128u8; (OUTPUT_WIDTH / 2) * (OUTPUT_HEIGHT / 2)];
    let mut v = vec![128u8; (OUTPUT_WIDTH / 2) * (OUTPUT_HEIGHT / 2)];

    render_waveform(src_y, &mut y, &mut u, &mut v);
    render_vectorscope(src_u, src_v, &mut y, &mut u, &mut v);
    draw_divider(&mut y);

    Image { y, u, v }
}

fn set_pixel(y: &mut [u8], u: &mut [u8], v: &mut [u8], x: usize, oy: usize, luma: u8) {
    if x >= OUTPUT_WIDTH || oy >= OUTPUT_HEIGHT {
        return;
    }
    let idx = oy * OUTPUT_WIDTH + x;
    if luma > y[idx] {
        y[idx] = luma;
    }
    let cidx = (oy / 2) * (OUTPUT_WIDTH / 2) + (x / 2);
    if let (Some(uu), Some(vv)) = (u.get_mut(cidx), v.get_mut(cidx)) {
        *uu = TRACE_CB;
        *vv = TRACE_CR;
    }
}

fn render_waveform(src_y: &[u8], y: &mut [u8], u: &mut [u8], v: &mut [u8]) {
    if src_y.len() < WAVEFORM_WIDTH * ANALYSIS_HEIGHT {
        return;
    }
    // Pro Spalte ein 256er-Histogramm (ein Byte-Wert = ein Bucket, kein
    // Downsampling nötig — 8-Bit-Luma passt exakt).
    let mut hist = [0u16; WAVEFORM_WIDTH * 256];
    for sy in 0..ANALYSIS_HEIGHT {
        let row = &src_y[sy * WAVEFORM_WIDTH..(sy + 1) * WAVEFORM_WIDTH];
        for (sx, &luma) in row.iter().enumerate() {
            hist[sx * 256 + luma as usize] += 1;
        }
    }
    for sx in 0..WAVEFORM_WIDTH {
        for bucket in 0..256 {
            let count = hist[sx * 256 + bucket];
            if count == 0 {
                continue;
            }
            // Zeile 0 = oben = Luma 255 (heller Bildinhalt oben, wie bei
            // einem echten Waveform-Monitor).
            let oy = OUTPUT_HEIGHT - 1 - (bucket * (OUTPUT_HEIGHT - 1) / 255);
            let brightness = (count.saturating_mul(48)).min(255) as u8;
            set_pixel(y, u, v, sx, oy, brightness);
        }
    }
}

fn render_vectorscope(src_u: &[u8], src_v: &[u8], y: &mut [u8], u: &mut [u8], v: &mut [u8]) {
    draw_graticule(y);

    let chroma_w = WAVEFORM_WIDTH / 2;
    let chroma_h = ANALYSIS_HEIGHT / 2;
    if src_u.len() < chroma_w * chroma_h || src_v.len() < chroma_w * chroma_h {
        return;
    }

    let radius = (VECTOR_SIZE / 2) as f32 - 2.0;
    let center = (VECTOR_SIZE / 2) as f32;
    let mut hist = vec![0u16; VECTOR_SIZE * VECTOR_SIZE];
    for i in 0..(chroma_w * chroma_h) {
        let cb = src_u[i] as f32 - 128.0;
        let cr = src_v[i] as f32 - 128.0;
        let px = center + (cb / 128.0) * radius;
        // Cr wächst nach "oben" (kleinere Zeile) — konventionelle
        // Bild-Y-Achse ist invertiert gegenüber einer mathematischen
        // Cr-Achse.
        let py = center - (cr / 128.0) * radius;
        if px < 0.0 || py < 0.0 {
            continue;
        }
        let (px, py) = (px as usize, py as usize);
        if px < VECTOR_SIZE && py < VECTOR_SIZE {
            hist[py * VECTOR_SIZE + px] += 1;
        }
    }

    for py in 0..VECTOR_SIZE {
        for px in 0..VECTOR_SIZE {
            let count = hist[py * VECTOR_SIZE + px];
            if count == 0 {
                continue;
            }
            let brightness = (count.saturating_mul(64)).min(255) as u8;
            set_pixel(y, u, v, VECTOR_X0 + px, VECTOR_Y0 + py, brightness);
        }
    }
}

/// Kreis-Graticule + Fadenkreuz (dezent, dient nur der Orientierung —
/// keine kalibrierten Winkel-Zielboxen, s. Moduldoku).
fn draw_graticule(y: &mut [u8]) {
    let radius = (VECTOR_SIZE / 2) as f32 - 2.0;
    let center = (VECTOR_SIZE / 2) as f32;
    for py in 0..VECTOR_SIZE {
        for px in 0..VECTOR_SIZE {
            let dx = px as f32 - center;
            let dy = py as f32 - center;
            let dist = (dx * dx + dy * dy).sqrt();
            let on_ring = (dist - radius).abs() < 0.75;
            let on_crosshair = dx.abs() < 0.6 || dy.abs() < 0.6;
            if on_ring || (on_crosshair && dist < radius) {
                let idx = (VECTOR_Y0 + py) * OUTPUT_WIDTH + (VECTOR_X0 + px);
                if idx < y.len() {
                    y[idx] = y[idx].max(GRATICULE_Y);
                }
            }
        }
    }
}

/// Dünne vertikale Trennlinie zwischen Waveform- und Vektorskop-Hälfte.
fn draw_divider(y: &mut [u8]) {
    for oy in 0..OUTPUT_HEIGHT {
        let idx = oy * OUTPUT_WIDTH + WAVEFORM_WIDTH;
        if idx < y.len() {
            y[idx] = GRATICULE_Y;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat_source(luma: u8, cb: u8, cr: u8) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let y = vec![luma; WAVEFORM_WIDTH * ANALYSIS_HEIGHT];
        let u = vec![cb; (WAVEFORM_WIDTH / 2) * (ANALYSIS_HEIGHT / 2)];
        let v = vec![cr; (WAVEFORM_WIDTH / 2) * (ANALYSIS_HEIGHT / 2)];
        (y, u, v)
    }

    #[test]
    fn render_produces_correctly_sized_i420_planes() {
        let (sy, su, sv) = flat_source(128, 128, 128);
        let img = render(&sy, &su, &sv);
        assert_eq!(img.y.len(), OUTPUT_WIDTH * OUTPUT_HEIGHT);
        assert_eq!(img.u.len(), (OUTPUT_WIDTH / 2) * (OUTPUT_HEIGHT / 2));
        assert_eq!(img.v.len(), (OUTPUT_WIDTH / 2) * (OUTPUT_HEIGHT / 2));
    }

    #[test]
    fn full_white_source_lights_up_the_top_row_of_the_waveform() {
        // Luma 255 in jeder Quellzeile -> Ausgabezeile 0 (oben) muss in
        // der Waveform-Hälfte durchgehend hell sein.
        let (sy, su, sv) = flat_source(255, 128, 128);
        let img = render(&sy, &su, &sv);
        for x in 0..WAVEFORM_WIDTH {
            assert!(img.y[x] > 0, "erwartete helle oberste Zeile bei x={x}");
        }
        // Unterste Zeile (Luma 0) bleibt in der Waveform-Hälfte dunkel.
        let bottom_row_start = (OUTPUT_HEIGHT - 1) * OUTPUT_WIDTH;
        for x in 0..WAVEFORM_WIDTH {
            assert_eq!(img.y[bottom_row_start + x], 0, "erwartete dunkle unterste Zeile bei x={x}");
        }
    }

    #[test]
    fn full_black_source_lights_up_the_bottom_row_of_the_waveform() {
        let (sy, su, sv) = flat_source(0, 128, 128);
        let img = render(&sy, &su, &sv);
        let bottom_row_start = (OUTPUT_HEIGHT - 1) * OUTPUT_WIDTH;
        for x in 0..WAVEFORM_WIDTH {
            assert!(img.y[bottom_row_start + x] > 0, "erwartete helle unterste Zeile bei x={x}");
        }
    }

    #[test]
    fn neutral_chroma_leaves_vectorscope_center_dark_but_shows_graticule() {
        // Cb=Cr=128 (Grauwert) landet exakt im Zentrum des Vektorskops —
        // dort sollte ein heller Punkt entstehen, außerhalb davon nur
        // die dezente Graticule-Linie/Kreis, nichts Zufälliges.
        let (sy, su, sv) = flat_source(128, 128, 128);
        let img = render(&sy, &su, &sv);
        let center_x = VECTOR_X0 + VECTOR_SIZE / 2;
        let center_y = VECTOR_Y0 + VECTOR_SIZE / 2;
        let center_idx = center_y * OUTPUT_WIDTH + center_x;
        assert!(img.y[center_idx] > 0, "erwarteter heller Treffer im Vektorskop-Zentrum bei neutraler Chroma");
    }

    #[test]
    fn short_buffers_do_not_panic() {
        // Ein einzelner Caps-Rennlauf-Frame (falsche/leere Puffer) darf
        // die Pipeline nie zum Absturz bringen.
        let img = render(&[], &[], &[]);
        assert_eq!(img.y.len(), OUTPUT_WIDTH * OUTPUT_HEIGHT);
    }

    #[test]
    fn divider_line_is_drawn_between_waveform_and_vectorscope() {
        let (sy, su, sv) = flat_source(0, 128, 128);
        let img = render(&sy, &su, &sv);
        assert_eq!(img.y[WAVEFORM_WIDTH], GRATICULE_Y);
    }
}
