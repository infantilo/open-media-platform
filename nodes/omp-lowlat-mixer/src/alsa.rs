//! Minimale ALSA-PCM-Anbindung über `libasound.so.2`, zur Laufzeit per `libloading` geladen (kein Build gegen ALSA-Header).
//!
//! Nur das, was ein Block-Mischer braucht: Karte öffnen (Wiedergabe oder Aufnahme), Rate/Kanäle/Periodengröße setzen, einen Block
//! verschränkt lesen oder schreiben, Aussetzer (xrun) beheben. Zahlenformat wird in der Reihenfolge Float32, S32, S16 verhandelt
//! und hier nach/von f32 gewandelt. Signaturen nach `alsa/pcm.h` (ALSA-Bibliothek; kein Normdokument).

use std::ffi::{CStr, CString, c_char, c_int, c_long, c_uint, c_ulong, c_void};
use std::sync::Arc;

const STREAM_PLAYBACK: c_int = 0;
const STREAM_CAPTURE: c_int = 1;
const ACCESS_RW_INTERLEAVED: c_uint = 3;
const FMT_S16_LE: c_int = 2;
const FMT_S32_LE: c_int = 10;
const FMT_FLOAT_LE: c_int = 14;

type OpenFn = unsafe extern "C" fn(*mut *mut c_void, *const c_char, c_int, c_int) -> c_int;
type HFn = unsafe extern "C" fn(*mut c_void) -> c_int;
type SizeofFn = unsafe extern "C" fn() -> usize;
type HpAnyFn = unsafe extern "C" fn(*mut c_void, *mut c_void) -> c_int;
type HpSetUintFn = unsafe extern "C" fn(*mut c_void, *mut c_void, c_uint) -> c_int;
type HpSetIntFn = unsafe extern "C" fn(*mut c_void, *mut c_void, c_int) -> c_int;
type HpNearUintFn = unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_uint, *mut c_int) -> c_int;
type HpNearUlongFn = unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_ulong, *mut c_int) -> c_int;
type HpGetUlongFn = unsafe extern "C" fn(*const c_void, *mut c_ulong, *mut c_int) -> c_int;
type HpGetBufFn = unsafe extern "C" fn(*const c_void, *mut c_ulong) -> c_int;
type SwSetUlongFn = unsafe extern "C" fn(*mut c_void, *mut c_void, c_ulong) -> c_int;
type IoReadFn = unsafe extern "C" fn(*mut c_void, *mut c_void, c_ulong) -> c_long;
type IoWriteFn = unsafe extern "C" fn(*mut c_void, *const c_void, c_ulong) -> c_long;
type RecoverFn = unsafe extern "C" fn(*mut c_void, c_int, c_int) -> c_int;
type DelayFn = unsafe extern "C" fn(*mut c_void, *mut c_long) -> c_int;
type StrErrFn = unsafe extern "C" fn(c_int) -> *const c_char;

struct Lib {
    _lib: libloading::Library,
    open: OpenFn,
    close: HFn,
    prepare: HFn,
    start: HFn,
    drop_: HFn,
    hw_sizeof: SizeofFn,
    hw_any: HpAnyFn,
    hw_set_access: HpSetUintFn,
    hw_set_format: HpSetIntFn,
    hw_set_channels: HpSetUintFn,
    hw_set_rate_near: HpNearUintFn,
    hw_set_period_size_near: HpNearUlongFn,
    hw_set_periods_near: HpNearUintFn,
    hw_apply: HpAnyFn,
    hw_get_period_size: HpGetUlongFn,
    hw_get_buffer_size: HpGetBufFn,
    sw_sizeof: SizeofFn,
    sw_current: HpAnyFn,
    sw_set_start_threshold: SwSetUlongFn,
    sw_set_avail_min: SwSetUlongFn,
    sw_apply: HpAnyFn,
    readi: IoReadFn,
    writei: IoWriteFn,
    recover: RecoverFn,
    delay: DelayFn,
    strerror: StrErrFn,
}

fn load() -> Result<Arc<Lib>, String> {
    // SAFETY: Laden einer Systembibliothek; die Funktionszeiger bleiben gültig, solange `_lib` lebt (Teil derselben Struktur).
    unsafe {
        let lib = libloading::Library::new("libasound.so.2").map_err(|e| format!("libasound.so.2 nicht ladbar: {e}"))?;
        macro_rules! sym {
            ($n:literal) => {
                *lib.get($n).map_err(|e| format!("{}: {e}", String::from_utf8_lossy(&$n[..$n.len() - 1])))?
            };
        }
        Ok(Arc::new(Lib {
            open: sym!(b"snd_pcm_open\0"),
            close: sym!(b"snd_pcm_close\0"),
            prepare: sym!(b"snd_pcm_prepare\0"),
            start: sym!(b"snd_pcm_start\0"),
            drop_: sym!(b"snd_pcm_drop\0"),
            hw_sizeof: sym!(b"snd_pcm_hw_params_sizeof\0"),
            hw_any: sym!(b"snd_pcm_hw_params_any\0"),
            hw_set_access: sym!(b"snd_pcm_hw_params_set_access\0"),
            hw_set_format: sym!(b"snd_pcm_hw_params_set_format\0"),
            hw_set_channels: sym!(b"snd_pcm_hw_params_set_channels\0"),
            hw_set_rate_near: sym!(b"snd_pcm_hw_params_set_rate_near\0"),
            hw_set_period_size_near: sym!(b"snd_pcm_hw_params_set_period_size_near\0"),
            hw_set_periods_near: sym!(b"snd_pcm_hw_params_set_periods_near\0"),
            hw_apply: sym!(b"snd_pcm_hw_params\0"),
            hw_get_period_size: sym!(b"snd_pcm_hw_params_get_period_size\0"),
            hw_get_buffer_size: sym!(b"snd_pcm_hw_params_get_buffer_size\0"),
            sw_sizeof: sym!(b"snd_pcm_sw_params_sizeof\0"),
            sw_current: sym!(b"snd_pcm_sw_params_current\0"),
            sw_set_start_threshold: sym!(b"snd_pcm_sw_params_set_start_threshold\0"),
            sw_set_avail_min: sym!(b"snd_pcm_sw_params_set_avail_min\0"),
            sw_apply: sym!(b"snd_pcm_sw_params\0"),
            readi: sym!(b"snd_pcm_readi\0"),
            writei: sym!(b"snd_pcm_writei\0"),
            recover: sym!(b"snd_pcm_recover\0"),
            delay: sym!(b"snd_pcm_delay\0"),
            strerror: sym!(b"snd_strerror\0"),
            _lib: lib,
        }))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Sample {
    F32,
    S32,
    S16,
}

#[derive(Clone, Debug)]
pub struct PcmInfo {
    pub channels: usize,
    pub period_frames: usize,
    pub buffer_frames: usize,
    pub format: &'static str,
}

pub struct Pcm {
    lib: Arc<Lib>,
    h: *mut c_void,
    capture: bool,
    ch: usize,
    sample: Sample,
    raw: Vec<u8>,
    period: usize,
    pub info: PcmInfo,
    /// Anzahl behobener Aussetzer (xruns)
    pub xruns: u64,
}

// SAFETY: Ein `snd_pcm_t` darf von einem Thread zur Zeit benutzt werden; `Pcm` wird in genau einen Thread verschoben.
unsafe impl Send for Pcm {}

impl Drop for Pcm {
    fn drop(&mut self) {
        // SAFETY: `h` ist ein gültiges, von `snd_pcm_open` geliefertes Handle und wird nur hier geschlossen.
        unsafe {
            (self.lib.drop_)(self.h);
            (self.lib.close)(self.h);
        }
    }
}

impl Pcm {
    /// Öffnet `device` (z. B. `hw:0,0`, `plughw:1`, `null`) mit Zielwerten. Die tatsächlich verhandelten Werte stehen in `info`.
    /// `periods`: Anzahl Perioden im Puffer (Wiedergabe 2 = kleinste sichere Latenz).
    pub fn open(device: &str, capture: bool, channels: usize, rate: u32, period_frames: usize, periods: usize) -> Result<Pcm, String> {
        let lib = load()?;
        let name = CString::new(device).map_err(|_| "Gerätename enthält NUL".to_string())?;
        let mut h: *mut c_void = std::ptr::null_mut();
        // SAFETY: Alle Aufrufe folgen der ALSA-C-API; Zeiger zeigen auf lebende lokale Variablen bzw. Puffer passender Größe.
        unsafe {
            let r = (lib.open)(&mut h, name.as_ptr(), if capture { STREAM_CAPTURE } else { STREAM_PLAYBACK }, 0);
            if r < 0 {
                return Err(format!("{device}: {}", err_text(&lib, r)));
            }
            let mut pcm = Pcm { lib: lib.clone(), h, capture, ch: channels, sample: Sample::F32, raw: Vec::new(), period: period_frames, info: PcmInfo { channels, period_frames, buffer_frames: 0, format: "" }, xruns: 0 };
            let hw = vec![0u8; (lib.hw_sizeof)()];
            let hwp = hw.as_ptr() as *mut c_void;
            let chk = |what: &str, r: c_int| -> Result<(), String> { if r < 0 { Err(format!("{device}: {what}: {}", err_text(&lib, r))) } else { Ok(()) } };
            chk("hw_params_any", (lib.hw_any)(h, hwp))?;
            chk("access", (lib.hw_set_access)(h, hwp, ACCESS_RW_INTERLEAVED))?;
            let mut chosen = None;
            for (fmt, sample, name) in [(FMT_FLOAT_LE, Sample::F32, "f32"), (FMT_S32_LE, Sample::S32, "s32"), (FMT_S16_LE, Sample::S16, "s16")] {
                if (lib.hw_set_format)(h, hwp, fmt) >= 0 {
                    chosen = Some((sample, name));
                    break;
                }
            }
            let (sample, fname) = chosen.ok_or_else(|| format!("{device}: kein unterstütztes Zahlenformat (f32/s32/s16)"))?;
            pcm.sample = sample;
            pcm.info.format = fname;
            chk("channels", (lib.hw_set_channels)(h, hwp, channels as c_uint))?;
            let mut r = rate as c_uint;
            let mut dir: c_int = 0;
            chk("rate", (lib.hw_set_rate_near)(h, hwp, &mut r, &mut dir))?;
            if r != rate {
                return Err(format!("{device}: Abtastrate {rate} nicht verfügbar (Karte bietet {r})"));
            }
            let mut ps = period_frames as c_ulong;
            dir = 0;
            chk("period_size", (lib.hw_set_period_size_near)(h, hwp, &mut ps, &mut dir))?;
            let mut np = periods as c_uint;
            dir = 0;
            chk("periods", (lib.hw_set_periods_near)(h, hwp, &mut np, &mut dir))?;
            chk("hw_params", (lib.hw_apply)(h, hwp))?;
            let mut got_ps: c_ulong = 0;
            let mut got_buf: c_ulong = 0;
            (lib.hw_get_period_size)(hwp, &mut got_ps, &mut dir);
            (lib.hw_get_buffer_size)(hwp, &mut got_buf);
            pcm.period = got_ps as usize;
            pcm.info.period_frames = got_ps as usize;
            pcm.info.buffer_frames = got_buf as usize;
            // Software: Wiedergabe startet erst, wenn der Puffer einmal voll geschrieben ist (kein Anlaufen mit Lücke);
            // Aufnahme wird ausdrücklich gestartet.
            let sw = vec![0u8; (lib.sw_sizeof)()];
            let swp = sw.as_ptr() as *mut c_void;
            chk("sw_params_current", (lib.sw_current)(h, swp))?;
            chk("avail_min", (lib.sw_set_avail_min)(h, swp, got_ps))?;
            chk("start_threshold", (lib.sw_set_start_threshold)(h, swp, if capture { 1 } else { got_buf.max(1) }))?;
            chk("sw_params", (lib.sw_apply)(h, swp))?;
            chk("prepare", (lib.prepare)(h))?;
            if capture {
                chk("start", (lib.start)(h))?;
            }
            pcm.raw = vec![0u8; pcm.period * channels * match sample { Sample::F32 | Sample::S32 => 4, Sample::S16 => 2 }];
            Ok(pcm)
        }
    }

    pub fn period_frames(&self) -> usize {
        self.period
    }

    /// Frames, die noch im Wiedergabepuffer stehen (Latenz bis zum Wandler), oder 0.
    pub fn delay_frames(&mut self) -> i64 {
        let mut d: c_long = 0;
        // SAFETY: gültiges Handle, `d` lebt.
        let r = unsafe { (self.lib.delay)(self.h, &mut d) };
        if r < 0 { 0 } else { d as i64 }
    }

    fn recover(&mut self, err: c_int) -> Result<(), String> {
        self.xruns += 1;
        // SAFETY: gültiges Handle.
        let r = unsafe { (self.lib.recover)(self.h, err, 1) };
        if r < 0 {
            return Err(format!("ALSA nicht zu beheben: {}", err_text(&self.lib, r)));
        }
        if self.capture {
            // SAFETY: gültiges Handle.
            unsafe { (self.lib.start)(self.h) };
        }
        Ok(())
    }

    /// Liest genau eine Periode (blockiert bis sie da ist) und schreibt sie als f32 verschränkt nach `out` (`period * channels`).
    pub fn read(&mut self, out: &mut [f32]) -> Result<(), String> {
        debug_assert!(self.capture && out.len() >= self.period * self.ch);
        let mut done = 0usize;
        let frame_bytes = self.raw.len() / self.period;
        while done < self.period {
            // SAFETY: `raw` hat `period` Rahmen Platz; der Zeiger wird um `done` Rahmen versetzt, gelesen werden höchstens `period - done`.
            let n = unsafe { (self.lib.readi)(self.h, self.raw.as_mut_ptr().add(done * frame_bytes) as *mut c_void, (self.period - done) as c_ulong) };
            if n < 0 {
                self.recover(n as c_int)?;
                continue;
            }
            done += n as usize;
        }
        decode(&self.raw, self.sample, &mut out[..self.period * self.ch]);
        Ok(())
    }

    /// Schreibt eine Periode (`period * channels` f32 verschränkt); blockiert, wenn der Puffer voll ist.
    pub fn write(&mut self, data: &[f32]) -> Result<(), String> {
        debug_assert!(!self.capture && data.len() >= self.period * self.ch);
        encode(&data[..self.period * self.ch], self.sample, &mut self.raw);
        let frame_bytes = self.raw.len() / self.period;
        let mut done = 0usize;
        while done < self.period {
            // SAFETY: wie in `read`.
            let n = unsafe { (self.lib.writei)(self.h, self.raw.as_ptr().add(done * frame_bytes) as *const c_void, (self.period - done) as c_ulong) };
            if n < 0 {
                self.recover(n as c_int)?;
                continue;
            }
            done += n as usize;
        }
        Ok(())
    }
}

fn err_text(lib: &Lib, code: c_int) -> String {
    // SAFETY: `snd_strerror` liefert einen statischen NUL-terminierten Text.
    unsafe { CStr::from_ptr((lib.strerror)(code)).to_string_lossy().into_owned() }
}

fn decode(raw: &[u8], s: Sample, out: &mut [f32]) {
    match s {
        Sample::F32 => {
            for (o, c) in out.iter_mut().zip(raw.chunks_exact(4)) {
                *o = f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
            }
        }
        Sample::S32 => {
            for (o, c) in out.iter_mut().zip(raw.chunks_exact(4)) {
                *o = i32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f32 / 2_147_483_648.0;
            }
        }
        Sample::S16 => {
            for (o, c) in out.iter_mut().zip(raw.chunks_exact(2)) {
                *o = i16::from_le_bytes([c[0], c[1]]) as f32 / 32_768.0;
            }
        }
    }
}

fn encode(data: &[f32], s: Sample, raw: &mut [u8]) {
    match s {
        Sample::F32 => {
            for (c, v) in raw.chunks_exact_mut(4).zip(data) {
                c.copy_from_slice(&v.clamp(-1.0, 1.0).to_le_bytes());
            }
        }
        Sample::S32 => {
            for (c, v) in raw.chunks_exact_mut(4).zip(data) {
                c.copy_from_slice(&((v.clamp(-1.0, 1.0) as f64 * 2_147_483_647.0) as i32).to_le_bytes());
            }
        }
        Sample::S16 => {
            for (c, v) in raw.chunks_exact_mut(2).zip(data) {
                c.copy_from_slice(&((v.clamp(-1.0, 1.0) * 32_767.0) as i16).to_le_bytes());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_conversion_roundtrip() {
        let data = [0.0f32, 0.5, -0.5, 1.0, -1.0, 0.123];
        for s in [Sample::F32, Sample::S32, Sample::S16] {
            let bps = if s == Sample::S16 { 2 } else { 4 };
            let mut raw = vec![0u8; data.len() * bps];
            encode(&data, s, &mut raw);
            let mut out = vec![0.0f32; data.len()];
            decode(&raw, s, &mut out);
            for (a, b) in data.iter().zip(&out) {
                assert!((a - b).abs() < 1e-3, "{s:?}: {a} {b}");
            }
        }
    }

    /// Das ALSA-Plugin `null` braucht keine Hardware: prüft Laden, Aushandeln und Schreiben/Lesen im Zeitraster.
    #[test]
    fn null_device_write_and_read() {
        let mut p = match Pcm::open("null", false, 2, 48_000, 48, 2) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("ALSA nicht verfügbar, Test übersprungen: {e}");
                return;
            }
        };
        assert_eq!(p.info.channels, 2);
        assert_eq!(p.period_frames(), 48);
        let block = vec![0.25f32; 48 * 2];
        for _ in 0..20 {
            p.write(&block).unwrap();
        }
        let mut c = Pcm::open("null", true, 2, 48_000, 48, 2).unwrap();
        let mut out = vec![1.0f32; 48 * 2];
        c.read(&mut out).unwrap();
        assert!(out.iter().all(|v| *v == 0.0), "null liefert Stille");
    }
}
