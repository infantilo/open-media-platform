# Audiomixer Kapitel 26 — Abschlussbericht

## Architektur
Wiederverwendet: GStreamer-Pipeline, `ChannelState`/Methoden-API, `levels`-SSE, `/state`-Presets,
AFV, Solo/PFL, Master-Limiter, Orchestrator-Proxy-Muster von `omp-playout-automation`.
Neu: `dsp.rs` (Echtzeit-DSP als Pad-Probes), `automation.rs` (AutoMix/Ducking-Kerne),
`engine.rs` (10-ms-Thread), `model.rs` (Gruppen/Regeln), `rules.rs` (Automation, On-Air, Kontext),
`media.rs` (Ausführung), `ui/*.js` (Konsole). Grund: keine LADSPA/LV2-Plugins vorhanden, Pre/Post-Aux
und AutoMix-Anteile brauchen eine eigene Fader-Stufe.

## Audio
Kanal: Quelle → convert/resample/caps → Probe A (HPF, EQ 4 Bänder, Detektor, Gate, Kompressor,
Delay, Pan, Phase) → level → tee → [PFL | Aux-Sends | queue → Probe B (Fader·Mute·AutoMix·Duck·Gruppe)
→ Programm-Mixer]. AutoMix/Ducking sitzen im Engine-Thread, schreiben nur Gain-Anteile.

## AutoMix
Detektor (Speech/RMS/Short/Peak) je Kanal, Gain-Sharing Gain_i = L_i/ΣL (Gewicht, Priorität,
Sensitivity, Sharing-Exponent), Attack/Hold/Release, Max-Absenkung, Summenbegrenzung, Gruppen-Isolation,
Last-Mic-Hold.

## Ducking
Key-Kanäle (Kanal oder Gruppe) → Ziele; Detektor, Schwelle, Hysterese, Min-Auslösedauer (kurze Peaks
lösen nichts aus), Hold, langes Release, Betrag/Max; stumme Keys lösen nicht aus; kein Kompressor.

## Automation / Kontext
Deklarative Regeln Trigger→Aktion je Kanal; Ausführer wählt die Methode per Ziel-Descriptor.
Tally → AudioContext → Szene (Manual-Kanäle geschützt).

## Routing
6 Aux-Slots, Bus lazy gebaut, Send = tee→queue+Gain-Probe (Pre unverändert, Post ×Fader-Gesamtgain);
N-1 strukturell (Ausschlusskanal gesperrt, übrige automatisch Post).

## UI
Presets Auto/Desktop/Compact/Dicht/Grid/Touch, Fader optional, Operate/Mix, Gruppen-Header,
Layouts side/stacked/sheet, Pointer-Events, Fine-Modus, Tastatur, ARIA. Präferenzen nur localStorage.

## Sicherheit
Engine-Beat >1 s → Fader-Stufe ignoriert AutoMix/Duck; Detektor >500 ms alt → 0 dB; Media-Fehler
nur Status. Alte Presets laden (Defaults für neue Felder), Kanal-IDs/Methoden unverändert.

## Tests
63 Rust-Unit-Tests (DSP, AutoMix, Ducking, Engine, Regeln, Modell, Sends), CDP-Tests `tests-ui/`
(Maus, Touch, Layoutmatrix, Audio-State-Invarianz), Stresstest 40 Neustarts ohne Ausfall
(fand 5 GStreamer-Races), Descriptor-Schema (contract-check) PASS.

## Einschränkungen
Compressor-Sidechain/Auto-Gain nicht umgesetzt (optional); Loudness = Short-Term-Energie, kein echtes
LUFS; Debug-Build 64 Kanäle ≈400 % CPU (Aggregation, Release-Build nicht gemessen); N-1-Kanalentfernung
verursacht ~1 s Aux-Lücke; contract-check Registrierung nicht gegen echte Registry geprüft; Orchestrator-
Proxy-Pfad der Media-Automation nur gegen Stub getestet.
