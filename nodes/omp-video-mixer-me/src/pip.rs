//! PIP-Pose (Kapitel 87, `docs/ENTWURF-PIP-MEHRFACH-2D.md`): vier Eckpunkte in Mischer-Pixeln, Reihenfolge
//! oben-links, oben-rechts, unten-rechts, unten-links. Rotation, Trapez und Perspektive sind dieselbe
//! Homographie — eine Datenform für Editor, Animation, Trefferprüfung und Transform-Element.
//!
//! Reine Rechenlogik ohne GStreamer, damit sie ohne Pipeline testbar ist.

use serde_json::Value;

use crate::pipeline::DveBox;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PipPose {
    pub c: [[f64; 2]; 4],
}

impl PipPose {
    pub fn from_box(b: &DveBox) -> Self {
        let (x0, y0) = (b.x as f64, b.y as f64);
        let (x1, y1) = ((b.x + b.width) as f64, (b.y + b.height) as f64);
        PipPose { c: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] }
    }

    /// Umschließendes Rechteck (für Pads ohne Transform-Element und für die Anzeige).
    pub fn bounds(&self) -> DveBox {
        let xs = self.c.iter().map(|p| p[0]);
        let ys = self.c.iter().map(|p| p[1]);
        let min = |it: &mut dyn Iterator<Item = f64>| it.fold(f64::INFINITY, f64::min);
        let max = |it: &mut dyn Iterator<Item = f64>| it.fold(f64::NEG_INFINITY, f64::max);
        let (x0, x1) = (min(&mut xs.clone()), max(&mut xs.clone()));
        let (y0, y1) = (min(&mut ys.clone()), max(&mut ys.clone()));
        DveBox { x: x0.round() as i32, y: y0.round() as i32, width: ((x1 - x0).round() as i32).max(2), height: ((y1 - y0).round() as i32).max(2) }
    }

    /// Achsparallel (kein Trapez, keine Drehung): dann genügt die Pad-Geometrie des Compositors.
    pub fn is_rect(&self) -> bool {
        let t = 0.5;
        let [a, b, c, d] = self.c;
        (a[0] - d[0]).abs() < t && (b[0] - c[0]).abs() < t && (a[1] - b[1]).abs() < t && (d[1] - c[1]).abs() < t
    }

    pub fn lerp(&self, to: &PipPose, t: f64) -> PipPose {
        let mut c = [[0.0; 2]; 4];
        for ((out, a), b) in c.iter_mut().zip(&self.c).zip(&to.c) {
            out[0] = a[0] + (b[0] - a[0]) * t;
            out[1] = a[1] + (b[1] - a[1]) * t;
        }
        PipPose { c }
    }

    /// Drehung um den Mittelpunkt (Grad, im Uhrzeigersinn bei Bildschirm-y-nach-unten).
    pub fn rotated(&self, degrees: f64) -> PipPose {
        let cx = self.c.iter().map(|p| p[0]).sum::<f64>() / 4.0;
        let cy = self.c.iter().map(|p| p[1]).sum::<f64>() / 4.0;
        let (s, co) = degrees.to_radians().sin_cos();
        let mut c = self.c;
        for p in c.iter_mut() {
            let (dx, dy) = (p[0] - cx, p[1] - cy);
            *p = [cx + dx * co - dy * s, cy + dx * s + dy * co];
        }
        PipPose { c }
    }

    /// Punkt im Viereck (Strahlverfahren, auch für nicht-konvexe/gedrehte Formen richtig).
    pub fn contains(&self, x: f64, y: f64) -> bool {
        let mut inside = false;
        let mut j = 3;
        for i in 0..4 {
            let (pi, pj) = (self.c[i], self.c[j]);
            if (pi[1] > y) != (pj[1] > y) && x < (pj[0] - pi[0]) * (y - pi[1]) / (pj[1] - pi[1]) + pi[0] {
                inside = !inside;
            }
            j = i;
        }
        inside
    }

    /// Matrix für `perspective` (Zeilen-weise, 3×3): bildet **Ziel**pixel auf **Quell**pixel ab (am Prototyp
    /// gemessen, `examples/persp_probe.rs`). Die Quelle ist ein Bild `cw`×`ch` Pixel, das Ziel das Viereck dieser
    /// Pose, durch `div` geteilt (Zeichenfläche des Slots kann kleiner als das Mischerbild sein).
    /// `None` bei entartetem Viereck.
    pub fn inverse_matrix(&self, cw: f64, ch: f64, div: f64) -> Option<[f64; 9]> {
        let src = [[0.0, 0.0], [cw, 0.0], [cw, ch], [0.0, ch]];
        let mut dst = self.c;
        for p in dst.iter_mut() {
            p[0] /= div;
            p[1] /= div;
        }
        let h = homography(&src, &dst)?;
        invert3(&h)
    }

    pub fn to_json(self) -> Value {
        let b = self.bounds();
        serde_json::json!({
            "x": b.x, "y": b.y, "width": b.width, "height": b.height,
            "corners": self.c.iter().map(|p| serde_json::json!([round2(p[0]), round2(p[1])])).collect::<Vec<_>>(),
        })
    }

    /// Aus `{corners:[[x,y]×4]}` oder `{x,y,width,height}`; optional `rotation` (Grad um die Mitte) wird danach angewandt.
    pub fn from_json(v: &Value) -> Option<PipPose> {
        let pose = Self::from_json_unrotated(v)?;
        match v.get("rotation").and_then(Value::as_f64).filter(|r| r.is_finite() && r.abs() > 1e-9) {
            Some(r) => Some(pose.rotated(r)),
            None => Some(pose),
        }
    }

    fn from_json_unrotated(v: &Value) -> Option<PipPose> {
        if let Some(arr) = v.get("corners").and_then(Value::as_array)
            && arr.len() == 4
        {
            let mut c = [[0.0; 2]; 4];
            for (i, p) in arr.iter().enumerate() {
                let p = p.as_array()?;
                c[i] = [p.first()?.as_f64()?, p.get(1)?.as_f64()?];
            }
            return Some(PipPose { c });
        }
        Some(PipPose::from_box(&DveBox {
            x: v.get("x")?.as_f64()? as i32,
            y: v.get("y")?.as_f64()? as i32,
            width: v.get("width")?.as_f64()? as i32,
            height: v.get("height")?.as_f64()? as i32,
        }))
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// Homographie H mit H·src = dst (4 Punktpaare), 3×3 zeilenweise, h22 = 1. Gauß mit Spaltenpivot.
fn homography(src: &[[f64; 2]; 4], dst: &[[f64; 2]; 4]) -> Option<[f64; 9]> {
    let mut a = [[0.0f64; 9]; 8];
    for i in 0..4 {
        let (x, y) = (src[i][0], src[i][1]);
        let (u, v) = (dst[i][0], dst[i][1]);
        a[2 * i] = [x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y, u];
        a[2 * i + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y, v];
    }
    for col in 0..8 {
        let piv = (col..8).max_by(|&r, &s| a[r][col].abs().partial_cmp(&a[s][col].abs()).unwrap())?;
        if a[piv][col].abs() < 1e-9 {
            return None;
        }
        a.swap(col, piv);
        let pivot_row = a[col];
        for (r, row) in a.iter_mut().enumerate() {
            if r != col {
                let f = row[col] / pivot_row[col];
                for (k, v) in row.iter_mut().enumerate().skip(col) {
                    *v -= f * pivot_row[k];
                }
            }
        }
    }
    let mut h = [0.0; 9];
    for i in 0..8 {
        h[i] = a[i][8] / a[i][i];
    }
    h[8] = 1.0;
    Some(h)
}

fn invert3(m: &[f64; 9]) -> Option<[f64; 9]> {
    let [a, b, c, d, e, f, g, h, i] = *m;
    let det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if det.abs() < 1e-12 {
        return None;
    }
    let k = 1.0 / det;
    let inv = [
        (e * i - f * h) * k,
        (c * h - b * i) * k,
        (b * f - c * e) * k,
        (f * g - d * i) * k,
        (a * i - c * g) * k,
        (c * d - a * f) * k,
        (d * h - e * g) * k,
        (b * g - a * h) * k,
        (a * e - b * d) * k,
    ];
    // Normierung auf m22 = 1 (perspective teilt ohnehin durch die dritte Zeile)
    if inv[8].abs() > 1e-12 { Some(inv.map(|v| v / inv[8])) } else { Some(inv) }
}

/// Oberster getroffener Slot: `slots` = (Slot, Pose, z) der **eingeschalteten** Slots; höchstes z gewinnt, bei
/// Gleichstand der höhere Slot-Index (liegt im Compositor auch oben).
pub fn hit_test(slots: &[(usize, PipPose, u32)], x: f64, y: f64) -> Option<usize> {
    slots.iter().filter(|(_, pose, _)| pose.contains(x, y)).max_by_key(|(slot, _, z)| (*z, *slot)).map(|(slot, _, _)| *slot)
}

/// Vorgabe-Fokuspose: 94 % des Bildes, mittig (Seitenverhältnis des Mischerbildes bleibt).
pub fn default_focus_pose(width: u32, height: u32) -> PipPose {
    let (w, h) = (width as f64, height as f64);
    // gerade Maße, damit die Pose exakt mittig sitzt
    let even = |v: f64| ((v / 2.0).round() * 2.0) as i32;
    let (fw, fh) = (even(w * 0.94), even(h * 0.94));
    PipPose::from_box(&DveBox { x: (width as i32 - fw) / 2, y: (height as i32 - fh) / 2, width: fw, height: fh })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(x: i32, y: i32, w: i32, h: i32) -> DveBox {
        DveBox { x, y, width: w, height: h }
    }

    fn apply(m: &[f64; 9], x: f64, y: f64) -> (f64, f64) {
        let w = m[6] * x + m[7] * y + m[8];
        ((m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w)
    }

    #[test]
    fn box_roundtrip_and_rect() {
        let p = PipPose::from_box(&b(100, 50, 400, 300));
        assert!(p.is_rect());
        assert_eq!(p.bounds(), b(100, 50, 400, 300));
        assert!(!p.rotated(10.0).is_rect());
        // 90° ergibt zwar ein Rechteck, aber mit vertauschten Ecken (Bild liegt gedreht): kein einfacher Pad-Fall
        assert!(!p.rotated(90.0).is_rect());
        let v = serde_json::json!({"x": 0, "y": 0, "width": 400, "height": 100, "rotation": 90});
        assert_eq!(PipPose::from_json(&v).unwrap().bounds().height, 400);
    }

    #[test]
    fn contains_handles_rotation() {
        let p = PipPose::from_box(&b(0, 0, 400, 100)).rotated(90.0); // wird hochkant um (200,50)
        assert!(p.contains(200.0, 50.0));
        assert!(p.contains(200.0, 200.0)); // hochkant: y reicht von -150 bis 250
        assert!(!p.contains(10.0, 50.0)); // links außerhalb der schmalen Seite
    }

    #[test]
    fn hit_test_prefers_higher_z() {
        let a = PipPose::from_box(&b(0, 0, 200, 200));
        let c = PipPose::from_box(&b(100, 100, 200, 200));
        let slots = [(0, a, 4), (1, c, 5)];
        assert_eq!(hit_test(&slots, 150.0, 150.0), Some(1));
        assert_eq!(hit_test(&slots, 10.0, 10.0), Some(0));
        assert_eq!(hit_test(&slots, 500.0, 500.0), None);
        let slots = [(0, a, 9), (1, c, 5)];
        assert_eq!(hit_test(&slots, 150.0, 150.0), Some(0));
    }

    #[test]
    fn inverse_matrix_maps_destination_corners_to_source_corners() {
        let pose = PipPose { c: [[100.0, 80.0], [500.0, 120.0], [460.0, 360.0], [80.0, 300.0]] };
        let m = pose.inverse_matrix(640.0, 360.0, 1.0).expect("matrix");
        let src = [(0.0, 0.0), (640.0, 0.0), (640.0, 360.0), (0.0, 360.0)];
        for (i, s) in src.iter().enumerate() {
            let (x, y) = apply(&m, pose.c[i][0], pose.c[i][1]);
            assert!((x - s.0).abs() < 1e-6 && (y - s.1).abs() < 1e-6, "Ecke {i}: ({x},{y}) statt {s:?}");
        }
    }

    #[test]
    fn inverse_matrix_respects_divisor() {
        let pose = PipPose::from_box(&b(0, 0, 1280, 720));
        let m = pose.inverse_matrix(640.0, 360.0, 2.0).unwrap();
        let (x, y) = apply(&m, 320.0, 180.0);
        assert!((x - 320.0).abs() < 1e-6 && (y - 180.0).abs() < 1e-6, "Vollbild bleibt Identität: ({x},{y})");
    }

    #[test]
    fn degenerate_quad_has_no_matrix() {
        let pose = PipPose { c: [[0.0, 0.0], [0.0, 0.0], [0.0, 0.0], [0.0, 0.0]] };
        assert!(pose.inverse_matrix(640.0, 360.0, 1.0).is_none());
    }

    #[test]
    fn json_roundtrip_and_legacy_box() {
        let p = PipPose { c: [[1.5, 2.0], [30.0, 4.0], [28.0, 40.0], [3.0, 38.0]] };
        assert_eq!(PipPose::from_json(&p.to_json()), Some(p));
        let legacy = serde_json::json!({"x": 10, "y": 20, "width": 100, "height": 50});
        assert_eq!(PipPose::from_json(&legacy).unwrap().bounds(), b(10, 20, 100, 50));
        assert!(PipPose::from_json(&serde_json::json!({"corners": [[1, 2]]})).is_none());
    }

    #[test]
    fn focus_pose_is_centered() {
        let p = default_focus_pose(1280, 720);
        let bb = p.bounds();
        assert_eq!(bb.x * 2 + bb.width, 1280);
        assert_eq!(bb.y * 2 + bb.height, 720);
        assert!(bb.width > 1100);
    }
}
