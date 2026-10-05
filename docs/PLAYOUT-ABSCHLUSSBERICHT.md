# Abschlussbericht Kapitel 27 — Playout-Automation (Stand 2026-10-05)

Gemäß Spec §274. Technische Referenz: `docs/PLAYOUT-AUTOMATION.md`; Entscheidungen und
Messungen je Schritt: `UMSETZUNG.md` (Kapitel 27, §27.7), `docs/decisions.md`.

**Ehrliches Gesamtbild:** P1–P8 und P10 sind umgesetzt und live geprüft; **P9 (Subtitle,
Voiceover-Trigger, Plugins, SCTE-35) ist bewusst zurückgestellt** (Nutzerentscheidung
2026-10-02). Der Produktionsanspruch „kompletter 24/7-Channel“ (§272) ist damit für
Video/Live/Audio-Routing/Grafik/Trigger/Preflight/As-Run erfüllt, nicht für Untertitel und
SCTE-35. Ein Dauerbetrieb über Tage wurde **nicht** gemessen.

## Repository-Analyse
- **Genutzte OMP-Komponenten:** `omp-channel-player` (A/B), `omp-video-mixer-me`,
  `omp-audio-mixer`, `omp-ograf`, `omp-recorder`, Orchestrator (Launcher, Placement, Asset-
  System, Prozess-Engine, Audit, `/metrics`), NMOS-Registry (IS-04/05), NATS, Postgres.
- **Aus PIPELINE CONTROLLER übernommen (gelesen, neu gebaut):** Playlist-Engine-Verhalten
  (Sequenz, Fixtime, Precue, Hold, NextLive), Child-Event-Idee, Panel-Muster (Drag&Drop,
  Property-Editor, Carts-Raster). Mapping: `docs/PLAYOUT-AUTOMATION.md` §13.

## Architektur
- **Neue Module:** `omp-playout-automation` (`playlist`, `schedule`, `children`, `trigger`,
  `readiness`, `asrun`, `structlog`, `persist`, `remote`), Crate `omp-resolver`,
  Orchestrator-Pakete `playout`, `asrun`, `sourcetags`, `materialize`, `channeltrigger`.
- **State-Modell:** Channel als Postgres-Domäne mit versioniertem Snapshot (Optimistic
  Concurrency); Zeitbasis UTC.
- **Scheduler:** `schedule::plan`/`event_queue` (Anzeige/Planung), Ausführung über
  Auto-Advance, `fixtime_loop` und `child_loop`; Journal gegen Doppelausführung.
- **Resolver:** `omp-resolver` — eine Quelle der Wahrheit für Quellen- und Audioauswahl.
- **Channel-Trigger:** Orchestrator-Router + NATS, Regeln „wer darf wen“, Late-Policy.

## Playlist
Event-Typen CLIP/LIVE/PATTERN/IMAGE/BLACK/HOLD/JUMP; Startarten sequence/manual/fixtime
(RFC 3339 mit Offset); Child Events GRAPHIC/LOGO/CHANNEL_BRANDING, TRIGGER/NODE_COMMAND/
AUDIO/VOICEOVER, WEBHOOK, CHANNEL_TRIGGER mit vier Zeitmodi und Fehlerrichtlinien.
**Offen:** SUBTITLE, ROUTING, SOURCE, SCTE35, GPI (werden abgelehnt, nicht simuliert).

## Sources
Discovery über IS-04 (`GET /api/v1/sources`), Tags in drei Herkünften, Capabilities (Audio),
Health (offline nur auf Wunsch), dynamische Auswahl bei Cue/Take mit Begründung je Kandidat.
**Offen:** Wechsel einer *laufenden* Quelle bei Ausfall (§156/§157), Failover-Kandidaten
Primary/Backup (§76), Tag-Editor in der UI (§153).

## Audio
Semantisches Routing im Audiomischer (Kanal-Erwartung + Quell-Kontext + Event-Override),
Audio-Capabilities je Quelle, Audio-Absicht mit Fallback-Kette. **Offen:** Per-Track-Fallback
zur Laufzeit (§98), Mixer-UI für Erwartung/Konflikte, Preflight-Liste der Audio-Warnungen.

## Multi Channel
Channel-Gruppen, National/Regional per Trigger-Regeln, Trigger-Protokoll mit Zustellzustand.
Live geprüft im E2E-Test (National → Regional, `CHANNEL_HOLD`). **Offen:** Shared Playlist
Blocks, benannte Trigger mit Regel-Engine, Trigger-Graph als Grafik, Absender-Authentisierung
auf Bus-Ebene.

## Assets
Preflight mit Bereitschaft je Event, Materialisierung als Prozess-Schritt (atomar, Prüfsumme),
Ausfallrichtlinien HOLD/SKIP/BLACK/STOP/FALLBACK/DEFAULT_FILLER. **Offen:** Materialisierung auf
Remote-Hosts, Bereitschaft inkl. Child-Events/Audio, Asset-Auswahldialog im Panel.

## Reliability
Restart: Snapshot-Wiederherstellung mit Wanduhr-Regel (live per `kill -9` geprüft).
Idempotenz: Ausführungsjournal (Fixtime, Child, Trigger), idempotente As-Run-Zeilen.
Failover: allgemeiner Hot-Standby der Plattform (Kapitel 7) gilt für die Instanz; ein
playout-spezifischer Failover fehlt. **Offen:** Abgleich mit dem echten Player-/Mixer-Zustand
(§115).

## As-Run, Kennzahlen, Logs (P10)
As-Run-Store mit Admin-Ansicht und CSV, elf `omp_playout_*`-Kennzahlen, strukturierte
JSON-Logs mit Korrelations-IDs (optional in Datei), Bedienungs-Mitschnitt mit Benutzername.

## Tests
- Rust: `omp-playout-automation` 136, `omp-resolver` 21 Unit-Tests (grün, fünfmal wiederholt).
- Go: `internal/playout`, `asrun`, `materialize`, `sourcetags`, `httpapi` grün.
- UI: `deno test ui/shell` 72 grün (inkl. As-Run-Logik).
- **End-to-End:** `tools/playout-e2e/e2e.py` baut 7 Instanzen auf und prüft die Abnahme
  (Reihenfolge, Endstatus, Dauern, Live-Quelle per Tags, Audio-Absicht, Child Events inkl.
  Channel-Trigger, Zustellung + Ausführung am Regional-Channel, Bedienungsprotokoll, CSV,
  Kennzahl): **alle Prüfungen bestanden** (2026-10-05, 21 s Sendung).
- Live per Browser: As-Run-Ansicht im Admin-Bereich mit echten Daten.
- **Nicht getestet:** Dauerbetrieb 24/7, echte Remote-Hosts für Preflight, Subtitle/SCTE-35
  (nicht implementiert), Mixer-Audio-Anwendung im E2E (nur Absicht/Auflösung geprüft).
