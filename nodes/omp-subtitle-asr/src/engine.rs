//! Spracherkennungs-Engines hinter einer kleinen Schnittstelle. Der Node enthält selbst kein Modell: `whisper` spricht einen
//! lokalen `whisper-server` (whisper.cpp, HTTP `POST /inference`) an — austauschbar gegen jede Engine, die ein WAV-Segment
//! annimmt und Text liefert. `mock` ersetzt die Erkennung für Tests und Vorführungen (keine CPU-Last, kein Modell).

use std::time::Duration;

pub trait Engine: Send + Sync {
    fn name(&self) -> String;
    /// Erkennt ein Segment (16 kHz, mono). `language`: ISO-Code („de“) oder „auto“.
    fn transcribe(&self, pcm: &[i16], language: &str) -> Result<String, String>;
    /// Ob die Engine erreichbar ist (für die Statusanzeige).
    fn check(&self) -> Result<(), String>;
}

/// WAV-Container (PCM, 16 kHz, mono, 16 Bit) um die Samples.
pub fn wav_bytes(pcm: &[i16]) -> Vec<u8> {
    let data_len = (pcm.len() * 2) as u32;
    let mut v = Vec::with_capacity(44 + pcm.len() * 2);
    v.extend_from_slice(b"RIFF");
    v.extend_from_slice(&(36 + data_len).to_le_bytes());
    v.extend_from_slice(b"WAVEfmt ");
    v.extend_from_slice(&16u32.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes()); // PCM
    v.extend_from_slice(&1u16.to_le_bytes()); // mono
    v.extend_from_slice(&16_000u32.to_le_bytes());
    v.extend_from_slice(&32_000u32.to_le_bytes());
    v.extend_from_slice(&2u16.to_le_bytes());
    v.extend_from_slice(&16u16.to_le_bytes());
    v.extend_from_slice(b"data");
    v.extend_from_slice(&data_len.to_le_bytes());
    for s in pcm {
        v.extend_from_slice(&s.to_le_bytes());
    }
    v
}

/// Entfernt Platzhalter der Engine („[BLANK_AUDIO]“, „(Musik)“, „♪“) und überzählige Leerzeichen. Leer = nichts Sprachliches.
pub fn clean_text(raw: &str) -> String {
    let mut out = String::new();
    let mut depth = 0i32;
    for c in raw.chars() {
        match c {
            '[' | '(' => depth += 1,
            ']' | ')' => depth = (depth - 1).max(0),
            '♪' | '♫' => {}
            _ if depth > 0 => {}
            c => out.push(c),
        }
    }
    let text = out.split_whitespace().collect::<Vec<_>>().join(" ");
    // Bekannte Halluzination bei Stille/Rauschen: reine Satzzeichen
    if text.chars().all(|c| !c.is_alphanumeric()) { String::new() } else { text }
}

pub struct WhisperHttp {
    pub base_url: String,
}

impl WhisperHttp {
    fn agent(&self, secs: u64) -> ureq::Agent {
        ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(secs))).http_status_as_error(false).build().into()
    }

    pub fn multipart(wav: &[u8], language: &str, boundary: &str) -> Vec<u8> {
        let mut body = Vec::with_capacity(wav.len() + 512);
        let mut field = |name: &str, value: &str| {
            body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
        };
        field("response_format", "json");
        field("temperature", "0.0");
        field("language", language);
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"segment.wav\"\r\nContent-Type: audio/wav\r\n\r\n").as_bytes());
        body.extend_from_slice(wav);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        body
    }
}

impl Engine for WhisperHttp {
    fn name(&self) -> String {
        format!("whisper ({})", self.base_url)
    }

    fn transcribe(&self, pcm: &[i16], language: &str) -> Result<String, String> {
        let boundary = "ompasrboundary7d2c1f";
        let body = Self::multipart(&wav_bytes(pcm), if language.is_empty() { "auto" } else { language }, boundary);
        let mut resp = self
            .agent(60)
            .post(&format!("{}/inference", self.base_url.trim_end_matches('/')))
            .header("Content-Type", &format!("multipart/form-data; boundary={boundary}"))
            .send(&body[..])
            .map_err(|e| format!("Engine nicht erreichbar ({}): {e} — Engine starten oder in den Instanz-Optionen OMP_ASR_BIN und OMP_ASR_MODEL setzen (docs/ASR-UNTERTITEL.md)", self.base_url))?;
        let status = resp.status().as_u16();
        let text = resp.body_mut().read_to_string().map_err(|e| e.to_string())?;
        if status != 200 {
            return Err(format!("Engine antwortete HTTP {status}: {}", text.chars().take(200).collect::<String>()));
        }
        let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("Engine-Antwort kein JSON: {e}"))?;
        if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
            return Err(format!("Engine: {err}"));
        }
        Ok(clean_text(v.get("text").and_then(|t| t.as_str()).unwrap_or("")))
    }

    fn check(&self) -> Result<(), String> {
        // whisper-server liefert auf GET / eine Seite; jede HTTP-Antwort heißt „läuft“.
        self.agent(3).get(&self.base_url).call().map(|_| ()).map_err(|e| format!("Engine nicht erreichbar ({}): {e} — OMP_ASR_BIN und OMP_ASR_MODEL setzen oder Engine starten", self.base_url))
    }
}

/// Ersatz-Engine ohne Modell: liefert je Segment einen festen Text mit Länge — für Tests und Vorführungen.
pub struct Mock;

impl Engine for Mock {
    fn name(&self) -> String {
        "mock".to_string()
    }
    fn transcribe(&self, pcm: &[i16], _language: &str) -> Result<String, String> {
        Ok(format!("Testuntertitel, Segment von {:.1} Sekunden Länge.", pcm.len() as f64 / 16_000.0))
    }
    fn check(&self) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_is_well_formed() {
        let w = wav_bytes(&[1, -1, 2]);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(w[4..8].try_into().unwrap()), 36 + 6);
        assert_eq!(&w[36..40], b"data");
        assert_eq!(w.len(), 44 + 6);
    }

    #[test]
    fn clean_text_drops_tags_and_noise() {
        assert_eq!(clean_text(" [BLANK_AUDIO] "), "");
        assert_eq!(clean_text("(Musik) Guten  Abend ♪"), "Guten Abend");
        assert_eq!(clean_text("..."), "");
        assert_eq!(clean_text("Das ist [unverständlich] gut."), "Das ist gut.");
    }

    #[test]
    fn multipart_contains_fields_and_file() {
        let b = WhisperHttp::multipart(b"WAVDATA", "de", "XX");
        let s = String::from_utf8_lossy(&b);
        assert!(s.contains("name=\"language\"\r\n\r\nde\r\n"));
        assert!(s.contains("name=\"file\"; filename=\"segment.wav\""));
        assert!(s.contains("WAVDATA\r\n--XX--"));
    }

    #[test]
    fn mock_reports_the_length() {
        assert!(Mock.transcribe(&vec![0; 32_000], "de").unwrap().contains("2.0"));
    }

    /// Echte Sprache durch Segmentierer und laufenden whisper-Server (manuell:
    /// `OMP_ASR_URL=http://127.0.0.1:8178 OMP_ASR_TEST_WAV=…/jfk.wav cargo test -p omp-subtitle-asr -- --ignored`).
    #[test]
    #[ignore = "braucht laufenden whisper-Server und eine 16-kHz-Mono-WAV-Datei"]
    fn real_speech_through_segmenter_and_server() {
        let url = std::env::var("OMP_ASR_URL").expect("OMP_ASR_URL");
        let wav = std::fs::read(std::env::var("OMP_ASR_TEST_WAV").expect("OMP_ASR_TEST_WAV")).unwrap();
        let pcm: Vec<i16> = wav[44..].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
        let mut seg = crate::segment::Segmenter::new(crate::segment::Config::default());
        let mut segs = Vec::new();
        let mut now = 1_000_000;
        let silence = vec![0i16; 16_000 * 2];
        for chunk in pcm.chunks(1600).chain(silence.chunks(1600)) {
            now += chunk.len() as i64 / 16;
            segs.extend(seg.push(chunk, now));
        }
        segs.extend(seg.flush());
        assert!(!segs.is_empty(), "kein Segment erkannt");
        let engine = WhisperHttp { base_url: url };
        let text: Vec<String> = segs.iter().map(|s| engine.transcribe(&s.samples, "en").unwrap()).collect();
        let joined = text.join(" ");
        eprintln!("{} Segment(e): {joined}", segs.len());
        assert!(joined.to_lowercase().contains("country"), "{joined}");
        let cues = crate::output::cues_for(&joined, segs[0].start_ms);
        assert!(!cues.is_empty());
    }
}
