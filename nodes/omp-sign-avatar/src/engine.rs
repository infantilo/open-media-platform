//! Phase 2: Untertitel → Sätze → Glossen → Schlüsselfolgen, mit Warteschlange, Verzug und Rückfall (docs/GEBAERDENSPRACHE.md §3).
//! Zeit kommt von außen (`now_ms`), damit alles ohne Uhr testbar ist.

use std::collections::VecDeque;
use std::sync::Arc;

use crate::avatar::Pose;
use crate::lexicon::Lexicon;
use crate::player::Timeline;
use crate::rules::{self, Item, Rules, Sentence};

#[derive(Clone, Debug)]
pub struct EngineConfig {
    /// Grundtempo (1.0 = Normal).
    pub speed: f32,
    /// Nicht freigegebene Lexikon-Einträge zulassen (nur Tests!).
    pub allow_unverified: bool,
    /// Wartet ein Satz länger als dies auf die Wiedergabe, wird beschleunigt; bei Überschreitung werden ältere verworfen.
    pub max_delay_ms: f64,
    /// Mindestdauer der Text-Einblendung (Rückfall); sonst `70 ms` je Zeichen.
    pub min_overlay_ms: f64,
    /// Rückfall bei zu vielen unbekannten Wörtern: `false` = nur Text einblenden, `true` = den Satz buchstabieren (Fingeralphabet)
    /// und den Text zur Kontrolle dazu einblenden.
    pub fallback_spell: bool,
}

impl Default for EngineConfig {
    fn default() -> Self {
        EngineConfig { speed: 1.0, allow_unverified: false, max_delay_ms: 8000.0, min_overlay_ms: 2500.0, fallback_spell: false }
    }
}

struct Queued {
    sentence: Sentence,
    arrived_ms: f64,
}

struct Current {
    timeline: Timeline,
    started_ms: f64,
    overlay: Option<String>,
}

/// Ein Bild der Engine: Haltung und optionaler Einblendtext.
#[derive(Clone, Debug, PartialEq)]
pub struct Frame {
    pub pose: Pose,
    pub overlay: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Stats {
    pub queue_len: usize,
    /// Wartezeit des zuletzt gestarteten Satzes (Eingang bis Beginn der Wiedergabe).
    pub last_delay_ms: f64,
    pub dropped: u64,
    pub sentences: u64,
    pub signed: u64,
    pub fallbacks: u64,
    /// Glossen des laufenden/letzten Satzes (z. B. „HEUTE REGEN KOMMEN NICHT“).
    pub last_glosses: String,
    pub last_unknown_ratio: f32,
}

pub struct Engine {
    lex: Arc<Lexicon>,
    rules: Rules,
    cfg: EngineConfig,
    queue: VecDeque<Queued>,
    cur: Option<Current>,
    stats: Stats,
}

fn gloss_label(g: &rules::Gloss) -> String {
    match &g.item {
        Item::Sign(s) => s.clone(),
        Item::Spell(w) => format!("[{w}]"),
        Item::Digits(d) => format!("#{d}"),
    }
}

impl Engine {
    pub fn new(lex: Arc<Lexicon>, rules: Rules, cfg: EngineConfig) -> Engine {
        Engine { lex, rules, cfg, queue: VecDeque::new(), cur: None, stats: Stats::default() }
    }

    pub fn set_speed(&mut self, speed: f32) {
        self.cfg.speed = speed.clamp(0.25, 4.0);
    }

    pub fn set_fallback_spell(&mut self, spell: bool) {
        self.cfg.fallback_spell = spell;
    }

    pub fn fallback_spell(&self) -> bool {
        self.cfg.fallback_spell
    }

    pub fn stats(&self) -> Stats {
        Stats { queue_len: self.queue.len(), ..self.stats.clone() }
    }

    /// Untertitel-Text entgegennehmen (kann mehrere Sätze enthalten).
    pub fn submit(&mut self, text: &str, now_ms: f64) {
        for s in rules::translate(text, &self.lex, &self.rules, self.cfg.allow_unverified) {
            self.stats.sentences += 1;
            self.queue.push_back(Queued { sentence: s, arrived_ms: now_ms });
        }
    }

    /// Wiedergabe sofort durch einen fertigen Ablauf ersetzen (Testbetrieb „Buchstabieren“); verwirft die Warteschlange nicht.
    pub fn play_now(&mut self, timeline: Timeline, now_ms: f64) {
        self.cur = Some(Current { timeline, started_ms: now_ms, overlay: None });
    }

    pub fn clear(&mut self) {
        self.queue.clear();
        self.cur = None;
    }

    #[cfg(test)]
    fn idle(&self) -> bool {
        self.cur.is_none() && self.queue.is_empty()
    }

    fn build(&self, s: &Sentence, speed: f32) -> Timeline {
        let mut tl = Timeline::new(150.0 / speed);
        let t_start = tl.total_ms();
        for g in &s.glosses {
            match &g.item {
                Item::Sign(name) => {
                    if let Some(sign) = self.lex.signs.get(name) {
                        sign.push_into(&mut tl, speed);
                    }
                }
                Item::Spell(w) | Item::Digits(w) => tl.push_spelling(w, speed * 1.25),
            }
            if g.negation {
                // Kopfschütteln während/nach der Verneinung
                let base = tl.last_pose();
                for y in [0.3, -0.3, 0.3, 0.0] {
                    let mut p = base;
                    p.head[1] = y;
                    tl.push(110.0 / speed, 0.0, p);
                }
            }
            tl.push(0.0, 60.0 / speed, tl.last_pose());
        }
        let t_end = tl.total_ms();
        if s.question {
            tl.map_range(t_start, t_end, |p| p.head[0] += 0.14); // Frage: Kopf leicht nach vorn
        }
        tl.finish(220.0 / speed, 150.0 / speed);
        tl
    }

    /// Bild zum Zeitpunkt `now_ms`; startet bei Bedarf den nächsten Satz.
    pub fn tick(&mut self, now_ms: f64) -> Frame {
        if let Some(c) = &self.cur {
            if c.timeline.is_finished(((now_ms - c.started_ms) as f32).max(0.0)) {
                self.cur = None;
            }
        }
        if self.cur.is_none() {
            self.start_next(now_ms);
        }
        match &self.cur {
            Some(c) => Frame { pose: c.timeline.pose_at(((now_ms - c.started_ms) as f32).max(0.0)), overlay: c.overlay.clone() },
            None => Frame { pose: Pose::REST, overlay: None },
        }
    }

    fn start_next(&mut self, now_ms: f64) {
        // Zu großer Rückstand: nur den jüngsten Satz behalten (Verzug schrumpft, Verlust wird gezählt)
        if self.queue.front().is_some_and(|q| now_ms - q.arrived_ms > self.cfg.max_delay_ms) && self.queue.len() > 1 {
            let keep = self.queue.pop_back();
            self.stats.dropped += self.queue.len() as u64;
            self.queue.clear();
            self.queue.extend(keep);
        }
        let Some(q) = self.queue.pop_front() else { return };
        let waited = now_ms - q.arrived_ms;
        // Aufholen: ab halber Höchstverzögerung schneller gebärden
        let catch_up = if waited > self.cfg.max_delay_ms * 0.5 { 1.5 } else if waited > self.cfg.max_delay_ms * 0.25 { 1.2 } else { 1.0 };
        let speed = (self.cfg.speed * catch_up).clamp(0.25, 4.0);
        self.stats.last_delay_ms = waited;
        self.stats.last_unknown_ratio = q.sentence.unknown_ratio;
        self.stats.last_glosses = q.sentence.glosses.iter().map(gloss_label).collect::<Vec<_>>().join(" ");
        if q.sentence.text_fallback {
            self.stats.fallbacks += 1;
            let tl = if self.cfg.fallback_spell {
                Timeline::spell(&q.sentence.text, speed * 1.25)
            } else {
                let ms = (q.sentence.text.chars().count() as f64 * 70.0).max(self.cfg.min_overlay_ms);
                let mut tl = Timeline::new(ms as f32);
                tl.finish(0.0, 0.0);
                tl
            };
            self.cur = Some(Current { timeline: tl, started_ms: now_ms, overlay: Some(q.sentence.text.clone()) });
            self.stats.last_glosses = String::from(if self.cfg.fallback_spell { "(Buchstabiert)" } else { "(Text)" });
        } else {
            self.stats.signed += 1;
            self.cur = Some(Current { timeline: self.build(&q.sentence, speed), started_ms: now_ms, overlay: None });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lex() -> Arc<Lexicon> {
        Arc::new(
            Lexicon::from_json(
                r#"{"version":1,"signs":[
                  {"gloss":"HEUTE","pos":"time","verified":true,"keys":[{"ms":0,"pose":{"dom":{"hand":"B"}}},{"ms":300,"pose":{"dom":{"hand":"B","wrist":[0,0,0.4]}}}]},
                  {"gloss":"REGEN","pos":"noun","verified":true,"keys":[{"ms":0,"pose":{"dom":{"hand":"5"}}},{"ms":400,"pose":{"dom":{"hand":"5","shoulder":[-1.0,0,-0.3]}}}]},
                  {"gloss":"NICHT","pos":"negation","verified":true,"keys":[{"ms":0,"pose":{"dom":{"hand":"A"}}}]}
                ],"lemmas":{}}"#,
            )
            .unwrap(),
        )
    }

    fn engine() -> Engine {
        Engine::new(lex(), Rules::default_rules(), EngineConfig::default())
    }

    fn run_until_idle(e: &mut Engine, mut now: f64) -> f64 {
        let mut guard = 0;
        while (!e.idle() || e.cur.is_some()) && guard < 100_000 {
            e.tick(now);
            now += 40.0;
            guard += 1;
        }
        now
    }

    #[test]
    fn nothing_to_do_is_rest_without_overlay() {
        let mut e = engine();
        assert_eq!(e.tick(0.0), Frame { pose: Pose::REST, overlay: None });
        assert!(e.idle());
    }

    #[test]
    fn a_sentence_is_signed_and_the_avatar_returns_to_rest() {
        let mut e = engine();
        e.submit("Heute Regen nicht.", 0.0);
        assert_eq!(e.stats().sentences, 1);
        let f = e.tick(0.0);
        assert_eq!(f.overlay, None);
        assert_eq!(e.stats().last_glosses, "HEUTE REGEN NICHT");
        // irgendwann in der Mitte ist die Hand oben (nicht Ruhe)
        let mid = e.tick(900.0);
        assert_ne!(mid.pose, Pose::REST);
        let end = run_until_idle(&mut e, 900.0);
        assert!(end > 1500.0);
        assert_eq!(e.tick(end + 40.0).pose, Pose::REST);
        assert_eq!(e.stats().signed, 1);
    }

    #[test]
    fn negation_shakes_the_head_and_a_question_tilts_it() {
        let mut e = engine();
        e.submit("Regen nicht", 0.0);
        let mut max_yaw = 0.0f32;
        for i in 0..400 {
            max_yaw = max_yaw.max(e.tick(i as f64 * 20.0).pose.head[1].abs());
        }
        assert!(max_yaw > 0.25, "Kopfschütteln fehlt: {max_yaw}");
        let mut q = engine();
        q.submit("Regen?", 0.0);
        let mut max_tilt = 0.0f32;
        for i in 0..300 {
            max_tilt = max_tilt.max(q.tick(i as f64 * 20.0).pose.head[0]);
        }
        assert!(max_tilt > 0.1, "Frage-Kopfhaltung fehlt: {max_tilt}");
    }

    #[test]
    fn mostly_unknown_sentence_becomes_text_overlay_with_minimum_duration() {
        let mut e = engine();
        e.submit("Der Bundeskanzler eröffnete die Ausstellung", 0.0);
        let f = e.tick(0.0);
        assert_eq!(f.overlay.as_deref(), Some("Der Bundeskanzler eröffnete die Ausstellung"));
        assert_eq!(f.pose, Pose::REST);
        assert!(e.tick(2400.0).overlay.is_some());
        let later = e.tick(60_000.0);
        assert_eq!(later.overlay, None);
        assert_eq!(e.stats().fallbacks, 1);
    }

    #[test]
    fn queue_catches_up_and_drops_old_sentences_when_far_behind() {
        let mut e = engine();
        for i in 0..6 {
            e.submit(&format!("Heute Regen {i}."), 0.0);
        }
        // Wiedergabe beginnt erst nach 20 s (Rückstand > max_delay): nur der jüngste Satz bleibt
        e.tick(20_000.0);
        assert_eq!(e.stats().dropped, 5);
        assert_eq!(e.stats().queue_len, 0);
        assert!(e.stats().last_delay_ms >= 20_000.0);
        // Mäßiger Rückstand: schneller als normal
        let mut slow = engine();
        slow.submit("Heute Regen.", 0.0);
        slow.tick(0.0);
        let normal = slow.cur.as_ref().unwrap().timeline.total_ms();
        let mut late = engine();
        late.submit("Heute Regen.", 0.0);
        late.tick(5000.0); // > 50 % der Höchstverzögerung
        assert!(late.cur.as_ref().unwrap().timeline.total_ms() < normal * 0.8);
    }

    #[test]
    fn play_now_overrides_for_the_spelling_test() {
        let mut e = engine();
        e.play_now(Timeline::spell("ab", 1.0), 100.0);
        assert!(!e.idle() || e.cur.is_some());
        assert_ne!(e.tick(100.0 + 1000.0).pose, Pose::REST);
    }

    #[test]
    fn fallback_spell_fingerspells_unknown_sentences_with_text_shown() {
        let mut e = Engine::new(Arc::new(Lexicon::default()), Rules::default_rules(), EngineConfig { fallback_spell: true, ..Default::default() });
        e.submit("Kanzler eröffnet Ausstellung.", 0.0);
        e.tick(0.0);
        assert_eq!(e.stats().last_glosses, "(Buchstabiert)");
        let first = e.tick(100.0);
        assert_eq!(first.overlay.as_deref(), Some("Kanzler eröffnet Ausstellung."));
        let mut moved = false;
        let rest = e.tick(100.0).pose;
        for t in (200..3000).step_by(40) {
            if e.tick(t as f64).pose != rest {
                moved = true;
            }
        }
        assert!(moved, "Hände bewegen sich beim Buchstabieren");
    }
}
