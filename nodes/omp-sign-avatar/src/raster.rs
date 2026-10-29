//! Software-Rasterizer: Dreiecke mit Z-Puffer, flache Farbe pro Dreieck, Kantenglättung durch
//! Überabtastung (`ss`×`ss` Samples je Pixel), Alpha = Deckungsgrad. Reines Rust, keine GPU.
//!
//! Koordinaten: Samplepixel (x nach rechts, y nach unten), z = Tiefe (größer = näher).

pub struct Raster {
    pub width: usize,
    pub height: usize,
    ss: usize,
    sw: usize,
    sh: usize,
    /// Je Sample: Tiefe (`f32::NEG_INFINITY` = leer).
    depth: Vec<f32>,
    /// Je Sample: 0x00RRGGBB.
    color: Vec<u32>,
    /// Zeilenbereich, den seit dem letzten `clear` beschrieben wurde (spart Löschen/Auflösen).
    dirty_rows: Option<(usize, usize)>,
    /// Zeilen des vorigen Bildes: `resolve` schreibt Vereinigung beider, alles andere bleibt unberührt (null).
    prev_rows: Option<(usize, usize)>,
}

impl Raster {
    pub fn new(width: usize, height: usize, ss: usize) -> Raster {
        let ss = ss.max(1);
        let (sw, sh) = (width * ss, height * ss);
        Raster {
            width,
            height,
            ss,
            sw,
            sh,
            depth: vec![f32::NEG_INFINITY; sw * sh],
            color: vec![0; sw * sh],
            dirty_rows: None,
            prev_rows: None,
        }
    }

    pub fn samples_per_axis(&self) -> usize {
        self.ss
    }

    pub fn clear(&mut self) {
        self.prev_rows = self.dirty_rows;
        if let Some((a, b)) = self.dirty_rows.take() {
            self.depth[a * self.sw..(b + 1) * self.sw].fill(f32::NEG_INFINITY);
        }
    }

    /// Ein Dreieck in Samplekoordinaten zeichnen (Vorder- und Rückseite).
    pub fn triangle(&mut self, v: [[f32; 3]; 3], rgb: u32) {
        let (x0, y0, x1, y1, x2, y2) = (v[0][0], v[0][1], v[1][0], v[1][1], v[2][0], v[2][1]);
        let area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
        if area.abs() < 1e-9 {
            return;
        }
        let minx = x0.min(x1).min(x2).floor().max(0.0) as usize;
        let maxx = (x0.max(x1).max(x2).ceil().min(self.sw as f32 - 1.0)).max(0.0) as usize;
        let miny = y0.min(y1).min(y2).floor().max(0.0) as usize;
        let maxy = (y0.max(y1).max(y2).ceil().min(self.sh as f32 - 1.0)).max(0.0) as usize;
        if x0.max(x1).max(x2) < 0.0 || y0.max(y1).max(y2) < 0.0 || x0.min(x1).min(x2) >= self.sw as f32 || y0.min(y1).min(y2) >= self.sh as f32 {
            return;
        }
        self.dirty_rows = Some(match self.dirty_rows {
            Some((a, b)) => (a.min(miny), b.max(maxy)),
            None => (miny, maxy),
        });
        let inv = 1.0 / area;
        // Kantenfunktionen w_i(x,y) = A_i*x + B_i*y + C_i, normiert auf Gesamtfläche.
        let (a0, b0) = ((y1 - y2) * inv, (x2 - x1) * inv);
        let (a1, b1) = ((y2 - y0) * inv, (x0 - x2) * inv);
        let c0 = (x1 * y2 - x2 * y1) * inv;
        let c1 = (x2 * y0 - x0 * y2) * inv;
        let (z0, z1, z2) = (v[0][2], v[1][2], v[2][2]);
        // Tiefe linear in x/y: z = z2 + w0*(z0-z2) + w1*(z1-z2)
        let (dz0, dz1) = (z0 - z2, z1 - z2);
        let dzdx = a0 * dz0 + a1 * dz1;
        let (a2, minx_i, maxx_i) = (-(a0 + a1), minx as i32, maxx as i32);
        for y in miny..=maxy {
            let py = y as f32 + 0.5;
            let (k0, k1) = (b0 * py + c0, b1 * py + c1);
            let k2 = 1.0 - k0 - k1;
            // Spanne [xs, xe], in der alle drei Gewichte ≥ 0 sind (je Kante eine Ungleichung in x).
            let (mut xs, mut xe) = (minx_i, maxx_i);
            let mut empty = false;
            for (a, k) in [(a0, k0), (a1, k1), (a2, k2)] {
                if a.abs() < 1e-12 {
                    empty |= k < 0.0;
                } else {
                    let edge = -k / a - 0.5; // x-Grenze (Pixelmitte)
                    if a > 0.0 { xs = xs.max(edge.ceil() as i32) } else { xe = xe.min(edge.floor() as i32) }
                }
            }
            if empty || xs > xe {
                continue;
            }
            let row = y * self.sw;
            let zrow = z2 + k0 * dz0 + k1 * dz1;
            let depth = &mut self.depth[row + xs as usize..=row + xe as usize];
            let color = &mut self.color[row + xs as usize..=row + xe as usize];
            let mut z = zrow + dzdx * (xs as f32 + 0.5);
            for (d, c) in depth.iter_mut().zip(color.iter_mut()) {
                if z > *d {
                    *d = z;
                    *c = rgb;
                }
                z += dzdx;
            }
        }
    }

    /// Auflösen nach BGRA (gerade Alpha, Deckungsgrad) und GRAY8-Key (Alpha). Puffer müssen
    /// `width*height*4` bzw. `width*height` Byte groß sein und über Aufrufe **dieselben** bleiben
    /// (anfangs null): geschrieben werden nur Zeilen, in denen dieses oder das vorige Bild etwas
    /// enthält.
    pub fn resolve(&self, bgra: &mut [u8], key: &mut [u8]) {
        let ss = self.ss;
        let norm = (ss * ss) as u32;
        let rows = match (self.dirty_rows, self.prev_rows) {
            (Some((a, b)), Some((c, d))) => Some((a.min(c) / ss, (b.max(d)) / ss)),
            (Some((a, b)), None) | (None, Some((a, b))) => Some((a / ss, b / ss)),
            (None, None) => None,
        };
        let Some((y0, y1)) = rows else { return };
        // Kehrwerte statt Division je Pixel (Wert·65536/n)
        let mut recip = [0u32; 65];
        for (n, r) in recip.iter_mut().enumerate().skip(1).take(norm as usize) {
            *r = 65536 / n as u32;
        }
        for y in y0..=y1.min(self.height - 1) {
            let out_px = &mut bgra[y * self.width * 4..(y + 1) * self.width * 4];
            let out_key = &mut key[y * self.width..(y + 1) * self.width];
            for (x, (px, k_out)) in out_px.chunks_exact_mut(4).zip(out_key.iter_mut()).enumerate() {
                let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
                for sy in 0..ss {
                    let row = (y * ss + sy) * self.sw + x * ss;
                    let (d, c) = (&self.depth[row..row + ss], &self.color[row..row + ss]);
                    for (d, c) in d.iter().zip(c) {
                        let on = (*d > f32::NEG_INFINITY) as u32;
                        let c = *c & 0u32.wrapping_sub(on);
                        r += (c >> 16) & 255;
                        g += (c >> 8) & 255;
                        b += c & 255;
                        n += on;
                    }
                }
                let k = recip[n as usize];
                let a = (n * 255 / norm) as u8;
                px[0] = ((b * k) >> 16) as u8;
                px[1] = ((g * k) >> 16) as u8;
                px[2] = ((r * k) >> 16) as u8;
                px[3] = a;
                *k_out = a;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(r: &Raster) -> (Vec<u8>, Vec<u8>) {
        let mut bgra = vec![0u8; r.width * r.height * 4];
        let mut key = vec![0u8; r.width * r.height];
        r.resolve(&mut bgra, &mut key);
        (bgra, key)
    }

    #[test]
    fn triangle_covers_expected_pixels_and_leaves_rest_empty() {
        let mut r = Raster::new(8, 8, 1);
        r.triangle([[0.0, 0.0, 0.0], [8.0, 0.0, 0.0], [0.0, 8.0, 0.0]], 0xFF0000);
        let (bgra, key) = render(&r);
        assert_eq!(key[0], 255);
        assert_eq!(&bgra[0..4], &[0, 0, 255, 255]); // BGRA: rot
        assert_eq!(key[7 * 8 + 7], 0); // gegenüberliegende Ecke bleibt leer
        // Hälfte des Quadrats (Diagonale gehört dem Dreieck nach Pixelmitte)
        let covered = key.iter().filter(|&&k| k == 255).count();
        assert!((28..=36).contains(&covered), "covered {covered}");
    }

    #[test]
    fn nearer_triangle_hides_farther_one_regardless_of_draw_order() {
        for near_first in [true, false] {
            let mut r = Raster::new(4, 4, 1);
            let big = |z| [[0.0, 0.0, z], [8.0, 0.0, z], [0.0, 8.0, z]];
            if near_first {
                r.triangle(big(5.0), 0x00FF00);
                r.triangle(big(1.0), 0x0000FF);
            } else {
                r.triangle(big(1.0), 0x0000FF);
                r.triangle(big(5.0), 0x00FF00);
            }
            let (bgra, _) = render(&r);
            assert_eq!(&bgra[0..4], &[0, 255, 0, 255], "near_first={near_first}");
        }
    }

    #[test]
    fn supersampling_gives_partial_alpha_on_edge() {
        let mut r = Raster::new(4, 4, 2);
        // Kante genau durch die Pixelmitte: x < 2.0 Sample = Pixel 1 halb gedeckt
        r.triangle([[0.0, 0.0, 0.0], [3.0, 0.0, 0.0], [0.0, 8.0, 0.0]], 0xFFFFFF);
        let (_, key) = render(&r);
        assert!(key.iter().any(|&k| k > 0 && k < 255), "kein Randpixel mit Teil-Alpha: {key:?}");
    }

    #[test]
    fn clear_empties_the_buffer_and_degenerate_triangle_is_ignored() {
        let mut r = Raster::new(4, 4, 1);
        r.triangle([[0.0, 0.0, 0.0], [4.0, 0.0, 0.0], [0.0, 4.0, 0.0]], 0xFFFFFF);
        r.triangle([[1.0, 1.0, 0.0], [1.0, 1.0, 0.0], [1.0, 1.0, 0.0]], 0xFFFFFF);
        r.clear();
        let (_, key) = render(&r);
        assert!(key.iter().all(|&k| k == 0));
    }

    #[test]
    fn triangle_outside_viewport_does_not_panic() {
        let mut r = Raster::new(4, 4, 2);
        r.triangle([[-50.0, -50.0, 0.0], [-20.0, -50.0, 0.0], [-50.0, -20.0, 0.0]], 1);
        r.triangle([[100.0, 100.0, 0.0], [120.0, 100.0, 0.0], [100.0, 120.0, 0.0]], 1);
        r.triangle([[-100.0, -100.0, 0.0], [300.0, -100.0, 0.0], [-100.0, 300.0, 0.0]], 0xFFFFFF);
        let (_, key) = render(&r);
        assert!(key.iter().all(|&k| k == 255));
    }
}
