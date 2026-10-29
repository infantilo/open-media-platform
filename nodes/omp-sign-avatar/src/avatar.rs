//! Selbst erstelltes Avatar-Modell (prozedural, keine fremden Daten): Oberkörper, Kopf, Arme und
//! zwei Hände mit je fünf Fingern. Skelett mit starrer Zuordnung (jedes Teil hängt an genau einem
//! Knochen); die Gelenke überlappen, sodass beim Beugen keine Lücken entstehen.
//!
//! Koordinaten (Meter, stilisiert): x nach rechts (Betrachter), y nach oben, z zum Betrachter.
//! „Dominante“ Hand = rechts im Bild (x > 0).

use crate::math::*;
use crate::raster::Raster;

/// Handform und Armstellung einer Seite.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ArmPose {
    /// Schulter-Drehung (Euler x,y,z, Bogenmaß).
    pub shoulder: V3,
    /// Ellbogenbeugung (negativ = Unterarm nach oben/vorn).
    pub elbow: f32,
    /// Unterarm-Verdrehung um die eigene Achse (π = Handfläche zum Betrachter bei gebeugtem Arm).
    pub twist: f32,
    pub wrist: V3,
    /// Krümmung Daumen, Zeige-, Mittel-, Ring-, kleiner Finger (0 gestreckt … 1 geschlossen).
    pub curl: [f32; 5],
    /// Daumen abspreizen (0 anliegend … 1 weit weg).
    pub thumb_abd: f32,
    /// Finger spreizen (−1 gekreuzt … 0 anliegend … 1 gespreizt).
    pub spread: f32,
}

impl ArmPose {
    pub const REST: ArmPose = ArmPose {
        shoulder: [0.0, 0.0, 0.12],
        elbow: -0.08,
        twist: 0.0,
        wrist: [0.0; 3],
        curl: [0.25, 0.25, 0.25, 0.25, 0.25],
        thumb_abd: 0.2,
        spread: 0.0,
    };

    pub fn lerp(&self, o: &ArmPose, t: f32) -> ArmPose {
        let l3 = |a: V3, b: V3| [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
        let mut curl = [0.0; 5];
        for i in 0..5 {
            curl[i] = lerp(self.curl[i], o.curl[i], t);
        }
        ArmPose {
            shoulder: l3(self.shoulder, o.shoulder),
            elbow: lerp(self.elbow, o.elbow, t),
            twist: lerp(self.twist, o.twist, t),
            wrist: l3(self.wrist, o.wrist),
            curl,
            thumb_abd: lerp(self.thumb_abd, o.thumb_abd, t),
            spread: lerp(self.spread, o.spread, t),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pose {
    /// Dominante Hand (rechts im Bild).
    pub dom: ArmPose,
    /// Andere Hand (links im Bild).
    pub off: ArmPose,
    /// Kopf (Euler x,y,z).
    pub head: V3,
}

impl Pose {
    pub const REST: Pose = Pose { dom: ArmPose::REST, off: ArmPose { shoulder: [0.0, 0.0, -0.12], ..ArmPose::REST }, head: [0.0; 3] };

    pub fn lerp(&self, o: &Pose, t: f32) -> Pose {
        Pose {
            dom: self.dom.lerp(&o.dom, t),
            off: self.off.lerp(&o.off, t),
            head: [lerp(self.head[0], o.head[0], t), lerp(self.head[1], o.head[1], t), lerp(self.head[2], o.head[2], t)],
        }
    }
}

// Knochenindizes
const TORSO: usize = 0;
const HEAD: usize = 1;
/// Je Seite: Oberarm, Unterarm, Hand, dann 5 Finger × 3 Glieder.
const SIDE_BASE: [usize; 2] = [2, 2 + 18];
const BONES: usize = 2 + 36;

fn finger_bone(side: usize, finger: usize, joint: usize) -> usize {
    SIDE_BASE[side] + 3 + finger * 3 + joint
}

struct Bone {
    parent: Option<usize>,
    /// Ruheposition im Elternraum.
    offset: V3,
}

struct Part {
    bone: usize,
    tris: Vec<[V3; 3]>,
    color: u32,
}

pub struct Avatar {
    bones: Vec<Bone>,
    parts: Vec<Part>,
}

const SKIN: u32 = 0xE0B090;
const SHIRT: u32 = 0x2F5D8A;
const HAIR: u32 = 0x3A2A20;
const DARK: u32 = 0x1A1A1A;
const HAND_SCALE: f32 = 1.5; // stilisiert groß: Hände müssen im kleinen Bild lesbar bleiben

fn box_tris(c: V3, h: V3) -> Vec<[V3; 3]> {
    let p = |sx: f32, sy: f32, sz: f32| [c[0] + sx * h[0], c[1] + sy * h[1], c[2] + sz * h[2]];
    let v = [
        p(-1.0, -1.0, -1.0), p(1.0, -1.0, -1.0), p(1.0, 1.0, -1.0), p(-1.0, 1.0, -1.0),
        p(-1.0, -1.0, 1.0), p(1.0, -1.0, 1.0), p(1.0, 1.0, 1.0), p(-1.0, 1.0, 1.0),
    ];
    let f = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]];
    let mut out = Vec::new();
    for q in f {
        out.push([v[q[0]], v[q[1]], v[q[2]]]);
        out.push([v[q[0]], v[q[2]], v[q[3]]]);
    }
    out
}

fn sphere_tris(c: V3, r: V3, lat: usize, lon: usize) -> Vec<[V3; 3]> {
    let pt = |i: usize, j: usize| {
        let th = std::f32::consts::PI * i as f32 / lat as f32;
        let ph = 2.0 * std::f32::consts::PI * j as f32 / lon as f32;
        [c[0] + r[0] * th.sin() * ph.cos(), c[1] + r[1] * th.cos(), c[2] + r[2] * th.sin() * ph.sin()]
    };
    let mut out = Vec::new();
    for i in 0..lat {
        for j in 0..lon {
            let (a, b, c2, d) = (pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1));
            if i > 0 {
                out.push([a, b, d]);
            }
            if i + 1 < lat {
                out.push([b, c2, d]);
            }
        }
    }
    out
}

impl Avatar {
    pub fn new() -> Avatar {
        let mut bones: Vec<Bone> = (0..BONES).map(|_| Bone { parent: None, offset: [0.0; 3] }).collect();
        let mut parts: Vec<Part> = Vec::new();
        let mut add = |bone: usize, tris: Vec<[V3; 3]>, color: u32| parts.push(Part { bone, tris, color });

        // Rumpf: Ursprung auf Brusthöhe.
        bones[TORSO] = Bone { parent: None, offset: [0.0, 0.0, 0.0] };
        add(TORSO, box_tris([0.0, -0.20, 0.0], [0.22, 0.30, 0.10]), SHIRT);
        add(TORSO, box_tris([0.0, 0.08, 0.0], [0.30, 0.06, 0.10]), SHIRT); // Schultern
        add(TORSO, box_tris([0.0, 0.17, 0.0], [0.04, 0.05, 0.04]), SKIN); // Hals

        // Kopf
        bones[HEAD] = Bone { parent: Some(TORSO), offset: [0.0, 0.22, 0.0] };
        add(HEAD, sphere_tris([0.0, 0.11, 0.0], [0.095, 0.125, 0.10], 14, 20), SKIN);
        add(HEAD, sphere_tris([0.0, 0.16, -0.015], [0.10, 0.10, 0.10], 8, 14), HAIR);
        for sx in [-1.0, 1.0] {
            add(HEAD, sphere_tris([sx * 0.037, 0.125, 0.092], [0.012, 0.012, 0.01], 4, 6), DARK); // Augen
            add(HEAD, box_tris([sx * 0.037, 0.153, 0.095], [0.022, 0.004, 0.004]), HAIR); // Brauen
        }
        add(HEAD, box_tris([0.0, 0.062, 0.097], [0.025, 0.004, 0.004]), 0x8A3B3B); // Mund

        for (side, sx) in [1.0f32, -1.0].into_iter().enumerate() {
            // side 0 = dominant (x>0)
            let b = SIDE_BASE[side];
            let upper = 0.26;
            let fore = 0.24;
            bones[b] = Bone { parent: Some(TORSO), offset: [sx * 0.30, 0.08, 0.0] };
            add(b, box_tris([0.0, -upper / 2.0, 0.0], [0.035, upper / 2.0 + 0.02, 0.035]), SHIRT);
            bones[b + 1] = Bone { parent: Some(b), offset: [0.0, -upper, 0.0] };
            add(b + 1, box_tris([0.0, -fore / 2.0, 0.0], [0.03, fore / 2.0 + 0.02, 0.03]), SKIN);
            bones[b + 2] = Bone { parent: Some(b + 1), offset: [0.0, -fore, 0.0] };
            let hs = HAND_SCALE;
            let palm_len = 0.085 * hs;
            add(b + 2, box_tris([0.0, -palm_len / 2.0, 0.0], [0.040 * hs, palm_len / 2.0, 0.015 * hs]), SKIN);
            // Finger: x-Position, Segmentlängen, Dicke
            let fx = [0.0, 0.028, 0.009, -0.010, -0.028];
            let seg: [[f32; 3]; 5] = [[0.03, 0.026, 0.022], [0.036, 0.022, 0.018], [0.040, 0.024, 0.019], [0.036, 0.022, 0.018], [0.028, 0.018, 0.016]];
            for f in 0..5 {
                let thick = if f == 0 { 0.011 } else { 0.0095 } * hs;
                let (base_x, base_y, base_z) = if f == 0 {
                    (sx * 0.040 * hs, -0.015 * hs, 0.006 * hs)
                } else {
                    (sx * fx[f] * hs, -palm_len, 0.0)
                };
                for j in 0..3 {
                    let bi = finger_bone(side, f, j);
                    let len = seg[f][j] * hs;
                    let parent = if j == 0 { b + 2 } else { bi - 1 };
                    let off = if j == 0 { [base_x, base_y, base_z] } else { [0.0, -seg[f][j - 1] * hs, 0.0] };
                    bones[bi] = Bone { parent: Some(parent), offset: off };
                    // 15 % Überlappung nach beiden Seiten gegen Lücken beim Beugen
                    add(bi, box_tris([0.0, -len / 2.0, 0.0], [thick, len / 2.0 * 1.15, thick]), SKIN);
                }
            }
        }
        Avatar { bones, parts }
    }

    pub fn triangle_count(&self) -> usize {
        self.parts.iter().map(|p| p.tris.len()).sum()
    }

    /// Knochen-Weltmatrizen für eine Haltung.
    fn world(&self, pose: &Pose) -> Vec<Xf> {
        let mut local: Vec<Xf> = vec![Xf::IDENTITY; BONES];
        local[HEAD] = Xf::euler(pose.head[0], pose.head[1], pose.head[2]);
        for (side, arm) in [&pose.dom, &pose.off].into_iter().enumerate() {
            let sx = if side == 0 { 1.0 } else { -1.0 };
            let b = SIDE_BASE[side];
            local[b] = Xf::euler(arm.shoulder[0], arm.shoulder[1], arm.shoulder[2]);
            // Beugung im Elternraum, davor Verdrehung um die eigene Achse
            local[b + 1] = Xf::euler(arm.elbow, 0.0, 0.0).then(&Xf::euler(0.0, arm.twist, 0.0));
            local[b + 2] = Xf::euler(arm.wrist[0], arm.wrist[1], arm.wrist[2]);
            for f in 0..5 {
                let curl = arm.curl[f];
                let ang = [1.25, 1.55, 1.05];
                for j in 0..3 {
                    let mut rx = -curl * ang[j];
                    let mut rz = 0.0;
                    if f == 0 {
                        // Daumen: Grundgelenk dreht seitlich weg (abspreizen) und etwas nach vorn
                        rx *= if j == 0 { 0.6 } else { 0.9 };
                        if j == 0 {
                            rz = sx * (0.15 + arm.thumb_abd * 0.9);
                            rx -= 0.3 * arm.thumb_abd;
                        }
                    } else if j == 0 {
                        // Spreizen: Mittelfinger 0, Nachbarn fächern symmetrisch
                        rz = sx * arm.spread * (f as f32 - 2.0) * -0.12;
                    }
                    local[finger_bone(side, f, j)] = Xf::euler(rx, 0.0, rz);
                }
            }
        }
        let mut world: Vec<Xf> = Vec::with_capacity(BONES);
        for i in 0..BONES {
            let bone = &self.bones[i];
            let l = Xf::translate(bone.offset).then(&local[i]);
            world.push(match bone.parent {
                Some(p) => world[p].then(&l),
                None => l,
            });
        }
        world
    }

    /// Haltung zeichnen (orthografische Kamera, Rumpfmitte bei `cx`,`cy`, `scale` Pixel je Meter).
    pub fn draw(&self, pose: &Pose, r: &mut Raster, cam: &Camera) {
        let world = self.world(pose);
        let ss = r.samples_per_axis() as f32;
        let light = normalize([0.35, 0.55, 0.75]);
        for part in &self.parts {
            let w = &world[part.bone];
            for t in &part.tris {
                let p = [w.apply(t[0]), w.apply(t[1]), w.apply(t[2])];
                let n = normalize(cross(sub(p[1], p[0]), sub(p[2], p[0])));
                // Beidseitig beleuchtet: zur Kamera zeigende Normale wählen
                let n = if n[2] < 0.0 { [-n[0], -n[1], -n[2]] } else { n };
                let d = dot(n, light).max(0.0);
                let shade = [0.55, 0.75, 0.9, 1.0][((d * 3.99) as usize).min(3)]; // Toon-Stufen
                let rgb = scale_rgb(part.color, shade);
                let s = |q: V3| [(q[0] - cam.cx) * cam.scale * ss + r.width as f32 * ss / 2.0, (cam.cy - q[1]) * cam.scale * ss + r.height as f32 * ss / 2.0, q[2]];
                r.triangle([s(p[0]), s(p[1]), s(p[2])], rgb);
            }
        }
    }
}

pub struct Camera {
    pub cx: f32,
    pub cy: f32,
    pub scale: f32,
}

impl Camera {
    /// Ausschnitt: Kopf bis Hüfte, Hände im Bild, passend für Breite `w` und Höhe `h`.
    pub fn framing(w: usize, h: usize) -> Camera {
        // Sichtbar ca. 1,0 m Breite; Oberkante über Kopf und erhobener Hand (y ≈ 0,64 m).
        let scale = w as f32 / 1.0;
        Camera { cx: 0.0, cy: 0.64 - h as f32 / scale / 2.0, scale }
    }
}

fn scale_rgb(c: u32, f: f32) -> u32 {
    let ch = |s: u32| (((c >> s) & 255) as f32 * f).min(255.0) as u32;
    (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_has_a_few_thousand_triangles() {
        let n = Avatar::new().triangle_count();
        assert!((1000..9000).contains(&n), "{n} Dreiecke");
    }

    #[test]
    fn rest_pose_renders_something_and_clear_removes_it() {
        let a = Avatar::new();
        let mut r = Raster::new(120, 135, 1);
        let cam = Camera::framing(120, 135);
        a.draw(&Pose::REST, &mut r, &cam);
        let (mut bgra, mut key) = (vec![0u8; 120 * 135 * 4], vec![0u8; 120 * 135]);
        r.resolve(&mut bgra, &mut key);
        let covered = key.iter().filter(|&&k| k > 0).count();
        assert!(covered > 1500, "nur {covered} Pixel bedeckt");
        r.clear();
        r.resolve(&mut bgra, &mut key);
        assert!(key.iter().all(|&k| k == 0));
    }

    #[test]
    fn raising_the_dominant_hand_moves_fingertips_up() {
        let a = Avatar::new();
        let tip = |pose: &Pose| {
            let w = a.world(pose);
            w[finger_bone(0, 2, 2)].apply([0.0, -0.02, 0.0])[1]
        };
        let mut up = Pose::REST;
        up.dom.elbow = -2.6;
        assert!(tip(&up) > tip(&Pose::REST) + 0.3);
    }
}
