//! Panik-Wächter (Audit 2026-10-23 H9): ein Panic in einem Hintergrund-Thread ließ den Prozess weiterlaufen, während ein Teil des Nodes
//! tot war (vergiftete Mutexe, stehende Pipeline) — ein „Zombie“, den weder Launcher noch Orchestrator als ausgefallen erkennen.
//!
//! Regel: Panics in Anfrage-Threads (`omp-http-req`) und Tokio-Arbeitern sind auf eine Anfrage bzw. Aufgabe begrenzt und bleiben
//! zunächst folgenlos; häufen sie sich (Standard: 5 in 60 s), ist der Zustand vermutlich vergiftet — der Prozess beendet sich
//! (Exit 101) und wird vom Launcher neu gestartet. Ein Panic in **jedem anderen** Thread beendet den Prozess sofort. Abschalten:
//! `OMP_PANIC_POLICY=log` (nur melden).

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Panics in Anfrage-/Aufgaben-Threads, ab denen der Prozess aufgibt.
pub const MAX_ISOLATED_PANICS: usize = 5;
pub const WINDOW: Duration = Duration::from_secs(60);

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Folgenlos (nur gemeldet).
    Isolated,
    /// Prozess beenden.
    Exit,
}

/// Threads, deren Panic auf eine Anfrage/Aufgabe begrenzt ist.
fn isolated_thread(name: Option<&str>) -> bool {
    matches!(name, Some(n) if n == "omp-http-req" || n.starts_with("tokio-runtime-worker"))
}

/// Entscheidet über einen Panic. `history` hält die Zeitpunkte der jüngsten begrenzten Panics.
pub fn judge(thread: Option<&str>, history: &mut VecDeque<Instant>, now: Instant) -> Verdict {
    if !isolated_thread(thread) {
        return Verdict::Exit;
    }
    history.push_back(now);
    while history.front().is_some_and(|t| now.duration_since(*t) > WINDOW) {
        history.pop_front();
    }
    if history.len() >= MAX_ISOLATED_PANICS { Verdict::Exit } else { Verdict::Isolated }
}

/// Installiert den Wächter (einmal je Prozess; weitere Aufrufe ersetzen nur den Hook).
pub fn install() {
    if std::env::var("OMP_PANIC_POLICY").is_ok_and(|v| v.eq_ignore_ascii_case("log")) {
        return;
    }
    let previous = std::panic::take_hook();
    let history = Mutex::new(VecDeque::new());
    std::panic::set_hook(Box::new(move |info| {
        previous(info);
        let name = std::thread::current().name().map(str::to_string);
        let verdict = match history.lock() {
            Ok(mut h) => judge(name.as_deref(), &mut h, Instant::now()),
            Err(_) => Verdict::Exit,
        };
        if verdict == Verdict::Exit {
            eprintln!("omp-node-sdk: Panic in Thread {name:?} — Prozess beendet sich, der Launcher startet neu (OMP_PANIC_POLICY=log schaltet das ab)");
            std::process::exit(101);
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn other_threads_exit_at_once() {
        let mut h = VecDeque::new();
        assert_eq!(judge(Some("gst-pipeline"), &mut h, Instant::now()), Verdict::Exit);
        assert_eq!(judge(None, &mut h, Instant::now()), Verdict::Exit);
        assert!(h.is_empty());
    }

    #[test]
    fn request_panics_are_tolerated_until_they_pile_up() {
        let mut h = VecDeque::new();
        let t0 = Instant::now();
        for i in 0..MAX_ISOLATED_PANICS - 1 {
            assert_eq!(judge(Some("omp-http-req"), &mut h, t0 + Duration::from_secs(i as u64)), Verdict::Isolated);
        }
        assert_eq!(judge(Some("tokio-runtime-worker"), &mut h, t0 + Duration::from_secs(10)), Verdict::Exit);
    }

    #[test]
    fn old_panics_fall_out_of_the_window() {
        let mut h = VecDeque::new();
        let t0 = Instant::now();
        for i in 0..MAX_ISOLATED_PANICS - 1 {
            judge(Some("omp-http-req"), &mut h, t0 + Duration::from_secs(i as u64));
        }
        assert_eq!(judge(Some("omp-http-req"), &mut h, t0 + WINDOW + Duration::from_secs(30)), Verdict::Isolated);
        assert_eq!(h.len(), 1);
    }
}
