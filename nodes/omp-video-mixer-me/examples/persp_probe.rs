//! Prototyp 87.1 (Kapitel 87): verhält sich `perspective` so, wie der PIP-2D-Pfad es braucht?
//! Prüft (a) Matrix-Konvention, (b) Alpha der Außenpixel, (c) Matrixwechsel zur Laufzeit ohne neue Caps,
//! (d) Zeit je Bild. Klein halten: wenige Bilder, `nice`.
use gstreamer as gst;
use gst::prelude::*;
use gstreamer_app as gst_app;

fn matrix(m: [f64; 9]) -> gst::glib::ValueArray {
    gst::glib::ValueArray::new(m.iter().map(|v| v.to_value()))
}

fn main() {
    gst::init().unwrap();
    let (w, h) = (std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(1280i32), std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(720i32));
    let fmt = std::env::args().nth(3).unwrap_or("AYUV".into());
    let desc = format!(
        "videotestsrc pattern=white is-live=false num-buffers=60 ! video/x-raw,format={fmt},width={w},height={h},framerate=25/1 ! perspective name=p off-edge-pixels=ignore ! appsink name=s sync=false emit-signals=false"
    );
    let pipe = gst::parse::launch(&desc).unwrap().downcast::<gst::Pipeline>().unwrap();
    let p = pipe.by_name("p").unwrap();
    let sink = pipe.by_name("s").unwrap().downcast::<gst_app::AppSink>().unwrap();
    // Skalierung 0.5 um die Mitte als Vorwärts- und als Rückwärtsabbildung ausprobieren
    let id = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    p.set_property("matrix", matrix(id));
    pipe.set_state(gst::State::Playing).unwrap();
    let mut caps_changes = 0;
    let mut last_caps: Option<gst::Caps> = None;
    let mut times = Vec::new();
    let px = |data: &[u8], x: i32, y: i32| -> [u8; 4] { let i = ((y * w + x) * 4) as usize; [data[i], data[i + 1], data[i + 2], data[i + 3]] };
    for n in 0..40 {
        let t0 = std::time::Instant::now();
        let s = match sink.pull_sample() { Ok(s) => s, Err(_) => break };
        times.push(t0.elapsed());
        let caps = s.caps().unwrap().to_owned();
        if last_caps.as_ref() != Some(&caps) { caps_changes += 1; last_caps = Some(caps); }
        let buf = s.buffer().unwrap();
        let map = buf.map_readable().unwrap();
        let d = map.as_slice();
        if n == 5 || n == 25 || n == 39 {
            println!("Bild {n}: Ecke(0,0)={:?} Mitte={:?} Ecke(w-1,h-1)={:?}", px(d, 0, 0), px(d, w / 2, h / 2), px(d, w - 1, h - 1));
        }
        // Matrix zur Laufzeit wechseln (ab Bild 10: Verkleinerung, ab 30: Trapez)
        if n == 10 {
            println!("-- Matrix: Skalierung 2 (Ziel->Quelle?) --"); p.set_property("matrix", matrix([2.0, 0.0, -(w as f64) / 2.0, 0.0, 2.0, -(h as f64) / 2.0, 0.0, 0.0, 1.0])); }
        if n == 30 { p.set_property("matrix", matrix([1.0, 0.3, 0.0, 0.0, 1.0, 0.0, 0.0002, 0.0, 1.0])); }
    }
    println!("Caps-Wechsel (inkl. erste Aushandlung): {caps_changes}");
    let total: std::time::Duration = times.iter().sum();
    println!("Mittel je Bild (Wandzeit, {w}x{h}): {:?}", total / times.len().max(1) as u32);
    pipe.set_state(gst::State::Null).unwrap();
}
