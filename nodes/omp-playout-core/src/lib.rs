//! Gemeinsamer Sendekern. Reine Logik ohne Medien- und Netzzugriff; TV-Automation (`omp-playout-automation`)
//! und Radio-Automation nutzen dieselben Bausteine (docs/RADIO-PLAN.md, RB1).
pub mod playlist;
pub mod readiness;
pub mod schedule;
pub mod timeline;
pub mod trigger;
pub mod segue;
pub mod remote;
