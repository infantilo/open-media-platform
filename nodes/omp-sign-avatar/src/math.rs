//! Kleine Vektor-/Transformationsmathematik (affin, Zeilenmatrix 3×3 + Verschiebung).

pub type V3 = [f32; 3];

#[derive(Clone, Copy, Debug)]
pub struct Xf {
    pub m: [[f32; 3]; 3],
    pub t: V3,
}

impl Xf {
    pub const IDENTITY: Xf = Xf { m: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], t: [0.0; 3] };

    pub fn translate(t: V3) -> Xf {
        Xf { t, ..Xf::IDENTITY }
    }

    /// Drehung R = Rx·Ry·Rz (Rz wirkt zuerst).
    pub fn euler(rx: f32, ry: f32, rz: f32) -> Xf {
        let (sx, cx) = rx.sin_cos();
        let (sy, cy) = ry.sin_cos();
        let (sz, cz) = rz.sin_cos();
        let rx = [[1.0, 0.0, 0.0], [0.0, cx, -sx], [0.0, sx, cx]];
        let ry = [[cy, 0.0, sy], [0.0, 1.0, 0.0], [-sy, 0.0, cy]];
        let rz = [[cz, -sz, 0.0], [sz, cz, 0.0], [0.0, 0.0, 1.0]];
        Xf { m: mul3(&mul3(&rx, &ry), &rz), t: [0.0; 3] }
    }

    /// `self` nach `child` (erst child, dann self).
    pub fn then(&self, child: &Xf) -> Xf {
        let m = mul3(&self.m, &child.m);
        let t = add(self.apply_dir(child.t), self.t);
        Xf { m, t }
    }

    pub fn apply(&self, p: V3) -> V3 {
        add(self.apply_dir(p), self.t)
    }

    pub fn apply_dir(&self, p: V3) -> V3 {
        [
            self.m[0][0] * p[0] + self.m[0][1] * p[1] + self.m[0][2] * p[2],
            self.m[1][0] * p[0] + self.m[1][1] * p[1] + self.m[1][2] * p[2],
            self.m[2][0] * p[0] + self.m[2][1] * p[1] + self.m[2][2] * p[2],
        ]
    }
}

fn mul3(a: &[[f32; 3]; 3], b: &[[f32; 3]; 3]) -> [[f32; 3]; 3] {
    let mut r = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    r
}

pub fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
pub fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
pub fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
pub fn dot(a: V3, b: V3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
pub fn normalize(a: V3) -> V3 {
    let l = dot(a, a).sqrt();
    if l < 1e-9 { [0.0, 0.0, 1.0] } else { [a[0] / l, a[1] / l, a[2] / l] }
}
pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn euler_x_quarter_turn_moves_y_to_z() {
        let r = Xf::euler(std::f32::consts::FRAC_PI_2, 0.0, 0.0);
        let p = r.apply([0.0, 1.0, 0.0]);
        assert!((p[2] - 1.0).abs() < 1e-6 && p[1].abs() < 1e-6);
    }

    #[test]
    fn then_applies_child_first() {
        let parent = Xf::translate([1.0, 0.0, 0.0]);
        let child = Xf::euler(0.0, 0.0, std::f32::consts::FRAC_PI_2);
        let p = parent.then(&child).apply([1.0, 0.0, 0.0]);
        assert!((p[0] - 1.0).abs() < 1e-6 && (p[1] - 1.0).abs() < 1e-6);
    }
}
