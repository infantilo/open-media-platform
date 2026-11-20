//! `omp-normalizer` — reine Logik des Hauptkontrollraums (UMSETZUNG Kapitel 106.1): Hausformat, Eingangsformat aus
//! MXL-`flow_def`, Planung der Wandlungsstufen (nur bei Abweichung), Versatz-Schätzer und Rampenplaner.
//!
//! Dieses Crate hat bewusst keine GStreamer- oder MXL-Abhängigkeit. Es entscheidet nur, **was** zu tun ist; der Node
//! (106.2) setzt es um.

pub mod audiomap;
pub mod avsync;
pub mod flowdef;
pub mod house;
pub mod offset;
pub mod plan;
pub mod ramp;
pub mod tonemap;
