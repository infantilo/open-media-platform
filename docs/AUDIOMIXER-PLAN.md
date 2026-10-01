# Audiomixer professionell (Kapitel 26) — Plan

Vorlage: `~/audiomixer.txt`. Erweiterung von `nodes/omp-audio-mixer`, keine
zweite Audio-Architektur.

## Bestandsanalyse (2026-10-01)

- Engine: GStreamer, ein `audiomixer` (Programm) + `pfl_mixer` (Solo/PFL, zweiter
  MXL-Sender). Kanalzweig dynamisch: Quelle → audioconvert → `equalizer-nbands`(3) →
  `audiodynamic` → `volume`(Makeup) → `level` → tee(PFL) → Mixer-Pad (Gain/Mute als
  Pad-Property).
- State: `ChannelState` in `main.rs` (Mutex<Vec>), Kommandos über mpsc zum
  Pipeline-Thread; Steuerung per `channel.<id>.set*`-Methoden (Parameter readonly).
- Metering: `level`-Element → SSE (`omp_mediaio::levels`), 0..1 linear ("AVL" = dieses
  Pegelkonzept, `<omp-meter>`).
- Vorhanden: Solo/PFL, AFV (Tally-Bus, cut/crossfade, Override), Presets
  (`/state` + Snapshot-Service). Nicht vorhanden: Gruppen, Pan, Delay, Aux/N-1, AutoMix,
  Ducking, Media-Automation, Szenen-Kontext, Gate, HPF.
- Keine LADSPA/LV2-Elemente installiert → eigenes DSP.

## Architektur

```
UI (bundle.js)  ──Methoden──▶  main.rs: Mixer-Modell (ChannelState, Gruppen, Regeln)
                                  │ Commands (mpsc)
                                  ▼
                        pipeline.rs: GStreamer-Graph + Engine-Thread (10 ms)
                                  │ Pad-Probes
                                  ▼
                        dsp.rs: Biquad-EQ, Gate/Expander, Kompressor, Delay, Pan,
                                Fader-Rampe, Detektoren (RMS/Peak), GR-Meter
                        automix.rs / ducking.rs: reine Rechenkerne (testbar)
```

Kanalkette neu: Quelle → convert → **Probe A** (HPF, EQ, Gate, Comp, Delay, Pan,
Detektor) → tee → [Pre-Aux-Sends] ; **Probe B** (Fader·Mute·AutoMix·Duck, geglättet)
→ tee → [Post-Aux-Sends] / Mixer-Pad (Unity) / PFL. Fader/Mute wandern vom Pad-Property
in Probe B (Voraussetzung für Pre/Post-Aux und sichtbaren Auto-/Duck-Anteil);
API (`setGain`/`setMute`) bleibt unverändert.

Fail-Safe: Engine-Gains liegen als Atomics (Ziel-dB) vor; veraltet der Detektor
(>500 ms keine Aktualisierung) oder fällt die Engine aus, rampt Probe B auf 0 dB
Auto-/Duck-Anteil (= manueller Fader).

## Phasen (jede einzeln verifiziert + committet)

1. **DSP-Kern**: `dsp.rs` (EQ 4 Bänder + HPF, Gate/Expander, Kompressor mit
   Attack/Release/Knee/GR, Delay, Pan, Fader) + Unit-Tests; Pipeline-Umbau; neue
   Methoden/Parameter; Rückwärtskompatibilität (alte Presets laden).
2. **AutoMix + Ducking**: Rechenkerne + Tests, Engine-Thread, Gruppen-Modell,
   Zustandsanzeige (Gain-Anteil auto/duck), Override.
3. **Aux / N-1 / Pre-Post**: dynamische Aux-Busse (eigene Mixer + MXL-Sender),
   Sends je Kanal, N-1 strukturell (Ausschlusskanal).
4. **Automation**: deklarative Kanal-Automation (Media-Player-Trigger), Szenen /
   Audio-Kontext aus Video-Tally, Szenen im `/state`.
5. **UI**: Center-Control (Tabs), Channel-Renderer Full/Compact/Dense/Grid(+Fader),
   Touch/Responsive, Operate/Mix, Display-Presets (localStorage = UI-Präferenz).
6. **Abschluss**: Tests/Lint/Build, UI-Matrix, Abschlussbericht (§98).

## Status

- [x] Phase 1 DSP-Kern (2026-10-01): `dsp.rs` (14 Unit-Tests), Pipeline-Umbau (Probe A/B, Master-Limiter), Methoden setEqGain/setEqHp/setEqBypass/setComp(erweitert)/setGate/setDelay/setPan, `type:"dsp"`-SSE-Meldungen (GR/Auto/Duck), Alt-State lädt; live gegen Test-Instanz verifiziert (Pan, HPF, Comp, Gate, Limiter, Fader, Mute)
- [x] Phase 2 AutoMix + Ducking (2026-10-01): `automation.rs` (Gain-Sharing-AutoMix mit Gewicht/Priorität/Sensitivity/Attack/Hold/Release/MaxAtten/Summenbegrenzung; Ducking mit Key→Target, Schwelle/Hysterese/Min-Trigger/Hold/langem Release/Max), `engine.rs` (10-ms-Thread, Fail-Safe: Engine-Beat + Detektor-Timeout), `model.rs` (Gruppen, Regeln), Methoden group.*/duck.*/channel.setGroup|setAutoMix|setManual|setDuckable, State/Preset; 42 Unit-Tests, live verifiziert (Dugan −6/−6, Prio, Manual, Duck −8 dB, Key stumm)
- [x] Phase 3 Aux / N-1 / Pre-Post (2026-10-01): 6 Aux-Slots (`OMP_AUDIO_MIXER_AUX_SLOTS`), Bus erst bei Aktivierung in die laufende Pipeline gebaut (eigener audiomixer + MXL-Sender per `add_sender`), Send = tee→queue+Gain-Probe (Pre = unverändert, Post = ×total_gain), N-1 strukturell (Ausschlusskanal gesperrt, alle anderen automatisch post-Fader), Aux-Pegel als SSE `aux-<id>`; live verifiziert; Fallstricke: Aux-Slots schon beim Start machen die Pipeline live → Programm-Mixer liefert Stille (daher lazy); tee-Zweig an laufendem tee funktioniert
- [ ] Phase 4 Automation + Szenen
- [ ] Phase 5 UI
- [ ] Phase 6 Abschluss
