# Playout-Automation (Kapitel 27)

Technische Referenz des Channel-Automators `omp-playout-automation` und seiner
Orchestrator-Domäne `playout` (Spec `~/automatisation.txt` §269/§270).
Bedienung im Panel: `docs/BENUTZERHANDBUCH.md`. Entscheidungen und Messungen je
Schritt: `UMSETZUNG.md` (Kapitel 27, §27.7) und `docs/decisions.md`.

## 1. Begriffe

- **Channel** — persistiertes Domänenobjekt des Orchestrators (`playout_channels`):
  Name, Zeitzone (IANA, nur Anzeige/Eingabe), optionale Gruppe, Bindung an eine
  Instanz **oder** an eine Workflow-Rolle (Rollenbindung überlebt Neustarts, die
  Instanz-ID nicht). Eine Automations-Instanz bedient genau einen Channel.
- **Primary Event** — ein Eintrag der Playlist (Clip, Live, Standbild, Testmuster,
  Steuer-Event). Läuft immer über einen der zwei A/B-`omp-channel-player` und den
  Mixer (`crosspoint.select` + `cut`/`autoTrans`).
- **Child Event** — zeitlich an ein Primary gebundene Nebenaktion (Grafik, Logo,
  Node-Befehl, Webhook, Channel-Trigger …).
- **Zeitbasis** — intern UTC (Wanduhr-Millisekunden), Anzeige im Panel lokal.
  Kein PTP im Dev-System (Entscheidung E5).

## 2. Playlist-Schema

Je Item (Parameter `items`, flaches JSON; Alt-Snapshots laden unverändert):

| Feld | Bedeutung |
|---|---|
| `id` | stabile Item-ID (`item<N>`, nie wiederverwendet) |
| `label` | Anzeigename |
| `eventType` | `CLIP`, `LIVE`, `PATTERN`, `IMAGE`, `BLACK`, `HOLD`, `JUMP` (aus dem Medium abgeleitet) |
| `file` / `pattern` / `senderId` / `sourceSelector` | Medium: Datei im Medienverzeichnis, Testmuster, feste Live-Quelle oder Live-Quelle per Kriterien |
| `asset` | Asset-Referenz `{assetId, versionId?, representationType?}` statt Rohdateiname |
| `durationMs` | Dauer; `0` = endlos (Live/HOLD) |
| `startType` | `sequence` (folgt dem Vorgänger), `manual` (nur per Operator-Cue+Take), `fixtime` |
| `startAt` / `fixtimeHms` | Fixzeit: RFC 3339 mit Offset (→ UTC, DST-sicher, hat Vorrang) bzw. Alt-Form `HH:MM:SS` |
| `transition`, `transitionRateFrames` | `cut` oder `mix` (Auto-Transition am Mixer) |
| `onMissing`, `fallbackFile` | Ausfallrichtlinie, s. §9 |
| `audio` | Audio-Absicht, s. §7 |
| `children` | Child Events, s. §4 |
| `icon`, `color`, `note` | reine Darstellung im Panel |

Die Methoden `append`, `appendAsset`, `updateItem` (Property-Editor: Patch,
alles-oder-nichts), `moveItem` (Cursor folgt), `remove`, `load` (ganze Liste),
`setStartType`, `setTransition`, `setAudio`, `setChildren`, `setMediaRef` ändern die Liste.
`schedule` liefert den berechneten UTC-Plan samt Warnungen (Überlappung, Lücke, Start
unbestimmt bei endlosem/manuellem Vorgänger) und die deterministische Aktions-Queue
(Reihenfolge bei Gleichstand: End < Cue < Take, danach Playlist-Position).

## 2a. Playlist-Tabelle: Spaltenauswahl

Die Playlist-Tabelle der Bedienoberfläche zeigt standardmäßig Titel, Dauer,
Zeit, Rest und Bereitschaft. Über das Zahnrad (⚙) über der Tabelle lassen sich
weitere Spalten einblenden; die Auswahl wird pro Browser gemerkt:

| Spalte | Inhalt |
|---|---|
| Typ | Event-Typ (CLIP, LIVE, IMAGE, HOLD, JUMP, PATTERN, BLACK) |
| Medium / Quelle | Dateiname, aufgelöste Live-Quelle bzw. Testmuster |
| Media-ID | Asset-ID, Sender-ID bzw. Auswahl-Tags der Live-Quelle |
| Transition | Cut oder Mix (mit Dauer in Frames) |
| Start | Sequenz, manuell oder Fixzeit (mit Datum/Uhrzeit) |
| Player | A oder B. Für ON AIR und CUED exakt, für übrige Events mit `~` markiert (voraussichtlich, da A/B je ladendem Event wechselt) |
| Status | ON AIR, CUED, gespielt, geplant, nicht bereit, fehlt |
| Gap / Overlap | Abstand zum Vorgänger laut Zeitplan: `0` nahtlos, `+x s` Lücke, `−x s` Überlappung (orange) |
| Audio | Gewählte Audio-Variante des Events |
| Child | Anzahl der Child Events |
| Bereitschaft | Ergebnis des Asset-Preflights (READY/NOT_READY/…) |

Reicht die Breite nicht, scrollt die Tabelle waagerecht.

## 3. Primary Events

- **CLIP/PATTERN/IMAGE** — Datei/Testmuster/Standbild auf den Standby-Player laden
  (Cue), beim Take am Mixer umschalten. Standbild wird mit `mediaType=image`
  ausdrücklich geladen (keine Erkennung an der Endung).
- **LIVE** — feste `senderId` (EXACT_ID) oder `sourceSelector` (§5); wird beim Cue/Take
  frisch aufgelöst, keine Verbindungs-Annahme.
- **HOLD** — hält die Sequenz an, das vorherige Bild bleibt stehen; Dauer 0 = bis der
  Operator weiterschaltet. **JUMP** — springt beim Erreichen zu `jumpTarget` (Item-ID).
- **Take-Arten:** `take` (Cue-Item), `next`, `nextLive` (nächstes Live-Item), Auto-Advance
  bei Item-Ende, Fixtime (harter Unterbrecher zur Wanduhrzeit, Journal verhindert
  Doppelfeuern), Carts (`cart.fire`/`cart.return`, unterbrechen und kehren zurück).
- **Auto-Advance wartet auf Fixtime:** ein Fixtime-Item in der Zukunft wird nur gecued
  und vom Fixtime-Takt gefeuert, nicht früh genommen.

## 4. Child Events

Typen: `GRAPHIC`, `LOGO`, `CHANNEL_BRANDING` (Grafik-Node `show`/`hide`);
`TRIGGER`, `NODE_COMMAND`, `AUDIO`, `VOICEOVER` (ausdrücklich `target` = Node-Label,
`method`, `params`, optional `stopMethod` — der Automator kennt keine Node-Typen);
`WEBHOOK` (HTTP-POST); `CHANNEL_TRIGGER` (§6).
**Abgelehnt statt simuliert:** `ROUTING`, `SOURCE`, `GPI` — dafür gibt
es keinen Ziel-Node; `setChildren` meldet es im Klartext.

**Voiceover (P9, §53/§135):** `VOICEOVER` ohne `method` ist ein eigener Typ, der den Audiomischer
steuert (der Automator plant, die Audioverarbeitung macht der Mischer). `params`:
`{"channel":"ch3","gainDb":0,"fadeInMs":300,"fadeOutMs":500,"duck":{"rule":"d3","amountDb":-12,"attackMs":80,"releaseMs":600},"priority":0}`.
`target` = Mischer-Label (leer → `targetAudioMixerLabel`). Start: Ducking-Regel an (Sprecher-Kanal als Schlüssel),
Kanal auf Stille, entstummen, einblenden; Stopp: ausblenden, stumm, Regel aus. Ein laufendes Voiceover mit
höherer `priority` blockiert den Start eines niedrigeren. Ein `VOICEOVER` mit `method` bleibt ein freier Node-Befehl.

**SCTE-35 (P9.2, §134):** `SCTE35` ist ein eigener Typ; Kodierung macht der Node `omp-scte35`
(Katalog „SCTE-35 Generator“), nicht der Playlist-Core. `target` = Label des Nodes, `params`:
`{"action":"out","durationMs":30000,"autoReturn":true,"returnAtStop":true}` → Start `splice.out`
(`splice_insert`, Out of Network, Dauer aus `params`/Kind-Dauer), Stopp `splice.in` mit derselben Event-ID;
oder `{"action":"signal","typeId":52,"endTypeId":53,"upid":"…"}` → `time_signal` mit Segmentation Descriptor
(0x34/0x35 Provider Placement Opportunity, 0x36/0x37 Distributor, 0x10/0x11 Programm, 0x22/0x23 Break).
Der Node liefert den Abschnitt als Parameter `lastSection`/`lastBase64`/`history` und optional als rohes
UDP-Datagramm (`OMP_SCTE35_UDP=host:port`). **Nicht enthalten:** Einbettung in einen MXL-ANC-Flow oder
Transportstrom, Verschlüsselung, Komponenten-Splices, PTS-genaue Vorlaufplanung (immer „sofort“).
**Klassifikation:** Item-Feld `adClass` (`block_start`, `block_end`, `commercial`, `promo`, leer = keine) —
Metadaten (Anzeige, As-Run-`detail.adClass`), löst selbst nichts aus.

**Untertitel (P9.4, §52):** `SUBTITLE` steuert die Untertitel-Engine des Grafik-Nodes (`omp-ograf`,
Modul `subtitles.rs`): `params`: `{"track":"demo-de","offsetMs":0}`, `target` leer = aufgelöster Grafik-Node
(`targetGraphicsLabel`). Start `subtitle.start`, Stopp `subtitle.stop`; am Node außerdem `subtitle.load/select`.
Spuren (Beispiel `docs/examples/demo-de.srt`): SRT oder WebVTT im Verzeichnis `OMP_SUBTITLE_DIR` (Standard `data/subtitles`, Spur-ID = Dateiname);
die Engine spielt gegen eine Uhr (mit Versatz) und setzt je Cue-Wechsel den Text der OGraf-Ebene `subtitle`
(Template `data/ograf-templates/subtitle`) — das Bild kommt über den vorhandenen Fill+Key-Pfad in den Bildmischer-DSK.
Parameter `subtitle` (ausgewählte Spur, läuft, Position, aktueller Text, Spuren). Grenzen: nur Text mit Zeilenumbruch
(keine Positionen/Farben/Stile aus der Datei), keine Live-/CEA-608-Untertitel, keine Mehrspur-Mischung.

Zeitmodi (`timing`): `ABSOLUTE` (`atUtc`), `RELATIVE_TO_START` (`delayMs`),
`RELATIVE_TO_END` (`delayMs` vor dem Ende, braucht feste Dauer), `FULL_PRIMARY`
(Start bis Primary-Ende, auch bei Live; `durationMs=0`).
Lebenszyklus: `SCHEDULED → ARMED → FIRED → ACTIVE → COMPLETED | FAILED | CANCELLED`.
Fehlerrichtlinie (`failurePolicy`): `IGNORE`, `WARN` (Standard), `RETRY` (count/delay),
`BLOCK` (mit `required`: Take wird im Preflight verweigert), `FALLBACK` (`fallbackTarget`).
Beim Primary-Wechsel werden nicht gestartete Kinder `CANCELLED`, gestartete erhalten
sofort ihren Stopp. Neustart: bereits gestartete Kinder werden nicht wiederholt (Ausführungs-
Journal `child:<item>:<child>:<on-air-sekunde>`), verpasste als `CANCELLED` gemeldet.
Zustand: Parameter `childEvents`.

## 5. Source Selector und Tags

Quellen-Sicht: `GET /api/v1/sources` (Filter `tag`, `mediaType`, `workflowId`). Tags
haben das Format `domain.name` (max. 32 je Quelle) und drei Herkünfte, die nie
vermischt werden: **EXPLICIT** (Operator, `PUT /api/v1/sources/{senderId}/tags`,
Postgres, Schlüssel `(node_id, sender_label)`) > **DERIVED** (Medientyp, Audio-
Kanalanzahl → `audio.mono|stereo|51`) > **DISCOVERED** (Node-Meldung via IS-04-Tag
`urn:x-omp:tags`). Namen beeinflussen nie die Wahl.

`sourceSelector` (JSON, Crate `omp-resolver`): `exactId`, `mediaType` (Standard `video`),
`minChannels`, `required[]`, `preferred[]`, `forbidden[]`, `group`, `workflow`, `context`,
`priorityIds[]`, `allowOffline`, `failOnAmbiguity`. Rangfolge: Sichtbarkeit → Capability →
Tags → Health → Quell-Kontext > Priorität > Workflow-Präferenz > Zahl erfüllter PREFERRED-
Tags > stabiler Tie-Breaker. Gleichstand vor dem Tie-Breaker wird gemeldet; mit
`failOnAmbiguity` gibt es dann keine Auswahl. Ohne Treffer: Fehler mit Begründung je Kandidat.

## 6. Channel-Trigger

Ein Channel steuert andere über den Orchestrator (`POST /api/v1/playout/channels/{id}/triggers`),
Zustellung per NATS (`omp.playout.…`) mit Wiederholung, Deduplizierung und Quittung
(`trigger-ack`). Events: `CHANNEL_NEXT`, `CHANNEL_NEXT_LIVE`, `CHANNEL_JUMP`, `CHANNEL_CUT`,
`CHANNEL_HOLD`, `CHANNEL_RESUME`, `CHANNEL_TRIGGER` (benannt, ohne eingebauten Handler).
Ziele: Channel-ID, Gruppe, `*`. **Standard ist verweigern:** nur Regeln
(`/api/v1/playout/trigger-rules`, Admin → Playout → Channels & Trigger) erlauben, wer wen steuert; jede Zustellung,
auch verweigerte, steht im Trigger-Protokoll. Late-Policy bei `targetTime`: `EXECUTE_IMMEDIATELY`,
`SKIP`, `RESYNC`, `QUEUE`. Grenze: der NATS-Absender ist auf Bus-Ebene nicht authentisiert
(der Orchestrator erzwingt die Rechte).

## 7. Audio-Capabilities und Audio-Absicht

`audio_capabilities` = die Audio-Flows **einer** Quelle (gleicher Node/Natural Group) mit
stabiler Kennung (Rolle `role.x` → `x`, sonst Label-Slug), Layout und Default-Marker
(`audio.default`). `setAudio(itemId, audioJson)` setzt die Absicht: ausdrückliche
`capability` > erwartete Tags (`expected`) > `channelPreference` > Quell-Default
(genau eine → vorgewählt, mehrere → keine willkürliche Wahl) > `globalDefault`; scheitert
die ausdrückliche Absicht, greift nur die konfigurierte `fallback`-Kette mit Warnung (keine
stille Ersatzwahl). `channels` ist der Event-Override je Mixerkanal.
Anwendung am Mixer (P6): Der Audiomischer-Kanal trägt eine Tag-Erwartung
(`setRouting`), der Automator meldet den Quell-Kontext (`setSourceContext`); je Kanal wird
die Audioquelle **desselben Kontexts** gewählt, Konflikte (zwei Kanäle, eine Quelle) und
nicht erfüllbare Erwartungen lassen den Kanal unverändert und werden gemeldet; ein
Handeingriff am Kanal pinnt ihn (Parameter `routing`/`mixState.routing`).

## 7a. Dynamische Audio-Ausgabe des Kanal-Players (Kapitel 27 / A3)

Der `omp-channel-player` hat nicht mehr einen festen Stereo-Ausgang, sondern **einen
MXL-Audio-Sender je Zielgruppe** des Ausgabeprofils (Standard: Programmton, Hörfilm/AD,
Originalton, Dolby E, 5.1 diskret). Konfiguration, Regeln und Vorlagen siehe
`docs/ENTWURF-AUDIO-REGELN.md`; sie liegen als ein Dokument im Orchestrator
(`GET/PUT /api/v1/audio-rules`, `GET /api/v1/audio-rules/default`). Der Node lädt es beim
Start und fällt ohne erreichbaren Orchestrator auf die eingebauten Standardwerte zurück.

- **Sender:** Der erste Sender heißt wie bisher „<Node> Audio“, die übrigen „<Node> Audio
  <Gruppenname>“. Die Gruppen-Tags stehen als NMOS-Tag `urn:x-omp:tags` am Sender.
  Änderungen an Anzahl/Aufbau der Gruppen wirken nach einem Neustart der Instanz.
- **Zuordnung je Event:** `load` nimmt das Argument `audioMapping` (ID einer Vorlage, z. B.
  `stereo-dolbye-hoerfilm`). Ohne Angabe gilt für MXF die Vorlage `stereo`, sonst der
  Programmton der Quelle (Live, Testton, Standbild, generische Datei).
- **Ersatzregeln:** Fehlt eine verlangte Spur, greifen die Regeln des Dokuments (Standard:
  Programmton aus 5.1 per Downmix, 5.1 per Upmix aus dem Stereo-Programmton). Ohne passende
  Regel bleibt die Gruppe still, mit Warnung.
- **In der Automation:** Das Event trägt `audioMapping` (flach im Event-JSON, per `updateItem` setzbar, leer = Standard des Players) und reicht es beim Laden an den Kanal-Player. Der Automation-Node spiegelt alle 2 s `audioPlans` (Plan je Kanal a/b), `audioGroups` und `audioMappings` vom Player.
- **Übergänge am Bildmischer:** `cut`, `mix`, `fadecut` (Ausblenden auf Schwarz, dann hart) und `cutfade` (hart auf Schwarz, dann aufblenden). Die Automation setzt vor jeder Rampe die Mischer-Art (`crosspoint.setTransType`) und die Dauer (`transitionRateFrames`).
- **Interlaced-Material:** Datei-Zweige (MXF und generisch) deinterlacen vor der Wandlung (`deinterlace`, `mode=auto`, obere Halbbilder → Einzelrate, z. B. 1080i25 → 25p). Progressive Quellen bleiben unberührt und kosten nichts. Vorher zeigte 1080i-Material Kammartefakte bei Bewegung.
- **Parameter am Player:** `audioPlan` (zuletzt aufgelöster Plan mit Matrizen, Ersatzregel und
  Warnungen), `audioGroups`, `audioMappings`.
- **Verarbeitung:** Der Kanal-Player führt `gain` (dB), `delay` (ms, z. B. für Laufzeitausgleich) und
  `loudness` je Gruppe aus. `loudness` ist ein dynamischer EBU-R128-Normalizer (ITU-R BS.1770,
  Short-Term-Messung über 3 s): Er führt den Gain sanft auf das Ziel nach (Parameter `target` in LUFS,
  Standard −23; `maxGain` ±dB, Standard 12; `ceiling` dBFS, Standard −1). Absenken geht schneller (6 dB/s)
  als Anheben (1 dB/s); bei Stille bleibt der Gain stehen. Es ist kein True-Peak-Limiter und hat keine
  Vorausschau: Die Obergrenze bezieht sich auf die zuletzt gesehenen Sample-Spitzen. Andere Schritte
  (später „Klare Sprache“) erscheinen als Warnung am Plan und werden nicht ausgeführt. Der MXF-Player
  und der MXF-Player direct führen noch keine Verarbeitungsschritte aus (nur Zuordnung und Matrizen).

## 8. Asset-Preflight und Materialisierung

`preflight_loop` (alle 5 s, asynchron zum Playout-Takt) prüft die anstehenden Events
beider Player-Ziele: Bereitschaft je Event `READY` / `NOT_READY` / `UNKNOWN`,
`start-spätestens = Sendezeit − Sicherheitsabstand (10 s) − geschätzte Dauer`.
Fehlendes Material wird als OMP-Prozess (`materialize`) bereitgestellt: Kopie nach
`<datei>.part`, Größe/SHA-256 prüfen, atomar umbenennen (nie eine halbe Datei im
Medienverzeichnis). API: `POST /api/v1/playout/channels/{id}/preflight` und `…/materialize`
(idempotent). Fenster: Parameter `preflightWindowMin` (Standard 15). Grenze: schreibt nur
Medienverzeichnisse auf dem Orchestrator-Rechner.

## 9. Ausfallrichtlinien (`onMissing`)

`HOLD` (Standard: nichts laden, Programm bleibt, Take schlägt mit Begründung fehl), `SKIP`,
`BLACK`, `STOP` (Schwarz + Automatik auf Hold), `FALLBACK` (`fallbackFile`),
`DEFAULT_FILLER` (Parameter `defaultFiller`, sonst Schwarz). Ohne Ersatzdatei/Filler gibt es
keinen Phantasie-Ersatz. Gilt beim Cue und beim Take.

## 10. Recovery

Der Node schreibt alle 1 s (nur bei Änderung, nie vor dem Laden) einen Snapshot über
`PUT /api/v1/playout/channels/{id}/state` (Optimistic Concurrency, Versionsabgleich bei 409):
Playlist samt Metadaten, Cursor, Modus, Carts, Kanal A/B, Ziel-Labels, On-Air-Start (UTC-ms),
Fixtime-Stand, Kind-Laufzeit. Nach `kill -9`/Neustart (gleiche Instanz-ID) wird er geladen:
ein on-air Item läuft nur weiter, wenn es laut Wanduhr noch in seiner Dauer liegt (sonst nicht
on air, nichts wird automatisch genommen, Operator-Meldung); aktiver Cart und Grafik-Zeitplan
werden nicht wiederhergestellt (gemeldet). Doppelausführung verhindert das Ausführungs-
Journal (`POST …/executions`, at-most-once, auch über Neustarts). Grenze: kein Abgleich mit
dem tatsächlichen Player-/Mixer-Zustand (Spec §115).

## 11. As-Run, Kennzahlen, Logs

- **As-Run** (`POST/GET /api/v1/playout/channels/{id}/as-run`, GET mit `kind`, `from`, `to`,
  `limit`, `format=csv`): je Primary Ist-Start/-Ende, Plan-Abweichung, Endstatus
  (`COMPLETED`, `INTERRUPTED`, `STOPPED`, `FAILED`), Child-Zeilen, Warnungen (gedrosselt),
  Trigger mit Korrelations-ID, manuelle Eingriffe mit Benutzername. Idempotent über `key`,
  Bereinigung täglich nach `AuditRetentionDays`. Ansicht: Admin → Playout → Channels & Trigger → As-Run-Protokoll
  (Filter, CSV-Export).
- **Metriken** (`/metrics`): `omp_playout_events_total`, `…_event_start_lateness_seconds`,
  `…_event_start_early_seconds`, `…_event_duration_seconds`, `…_child_event_failures_total`,
  `…_source_resolution_failures_total`, `…_audio_resolution_failures_total`,
  `…_asset_preflight_failures_total`, `…_channel_trigger_latency_seconds`,
  `…_operator_actions_total`.
- **Strukturierte Logs (§193):** der Node schreibt je As-Run-Ereignis eine JSON-Zeile auf stderr
  mit `channelId`, `eventId`, `childEventId`, `sourceId`, `correlationId`, `triggerId` (leere
  Felder entfallen). Mit der Node-Option `OMP_PLAYOUT_LOG_FILE` zusätzlich in eine Datei
  (durchsuchbar mit `grep`/`jq`); der Orchestrator hält von Node-stderr nur die letzten Zeilen für
  Absturzmeldungen.

## 12. APIs (Übersicht)

Orchestrator (`/api/v1/playout/…`): `channels` (GET/POST), `channels/{id}` (GET/PUT/DELETE),
`channels/{id}/state` (GET/PUT), `…/as-run` (GET/POST), `…/executions`, `…/preflight`,
`…/materialize`, `…/triggers`, `…/trigger-ack`, `triggers` (Protokoll), `trigger-rules`
(GET/POST/DELETE). Quellen: `GET /api/v1/sources`, `PUT /api/v1/sources/{senderId}/tags`.
Node-Methoden (`POST /api/v1/nodes/{id}/methods/{name}`, Body = Argumente als JSON-Objekt):
`append`, `appendAsset`, `load`, `remove`, `cue`, `take`, `next`, `nextLive`, `stop`,
`moveItem`, `updateItem`, `setStartType`, `setTransition`, `setAudio`, `setChildren`,
`setMediaRef`, `sendTrigger`, `cart.define|update|remove|fire|return`.
Wichtige Parameter: `items`, `currentItemId`, `cuedItemId`, `mode`, `schedule`, `childEvents`,
`triggerLog`, `audioRouting`, `channelId`, `persistence`, `target*Label`.

## 12a. Ereignis-Hooks / Plugin-Architektur (P9.3, Spec §130–133)

Prüfung „Plugin vs. Prozess vs. Node vs. Core“: OMP hat bereits den generischen Plugin-Host des Node-SDK
(`GET /plugins`, `PATCH /plugins/<id>`, über den Orchestrator unter `/api/v1/nodes/<id>/plugins`). Der Automator
registriert dort das Plugin **`event-hooks`** (Standard aus). Konfiguration:
`{"enabled":true,"config":{"hooks":[{"label":"Router","event":"primaryStart","url":"http://…","timeoutMs":2000}]}}`;
`event` = `playlistEvent` (Playlist geändert), `primaryStart`, `primaryEnd`, `childEvent`, `channelStart`,
`channelStop` oder `*`. Jede Zustellung ist ein JSON-POST (`event`, `at`, `channelId` + die As-Run-Zeile bzw.
Methode/Argumente). Aktionen (`execute`/`preflight`) sind die Child-Typen `WEBHOOK`/`NODE_COMMAND`/`SCTE35` —
keine zweite Mechanik. **Isolation:** eigener Zustell-Thread hinter begrenzter Warteschlange (256), `fire()` blockiert
nie, Zeitüberschreitung/Fehler/Absturz des Ziels landen nur in `hookStatus` (je Hook gesendet/fehlgeschlagen/letzter
Fehler, ungültige Einträge mit Grund, verworfene Meldungen) — nie im Event oder Takt. Die Konfiguration steht im
Channel-Snapshot (überlebt Neustarts). Grenze: `channelStop` kommt nur bei geordnetem Beenden (Ctrl-C), nicht bei SIGTERM/Absturz.

## 13. Migration: PIPELINE CONTROLLER → OMP (§270)

| PIPELINE-CONTROLLER-Funktion | Wo sie in OMP lebt |
|---|---|
| PlaylistEngine (Sequenz, Fixtime, Precue, Hold, NextLive, Lücken/Überlappung, Validierung) | `omp-playout-automation` (`playlist.rs`, `schedule.rs`), Plan + Warnungen im Parameter `schedule` |
| Child Events Trigger / Voiceover / Grafik | `children.rs`; Ausführung als Node-Befehle (IS-12/14-Methoden) bzw. Grafik-Node; Voiceover = `VOICEOVER`-Kind (Ducking im Audiomischer) |
| Child Event Record | `NODE_COMMAND` an `omp-recorder` (`record.start`/`record.stop`) |
| PlayerPipeline | `omp-channel-player` (A/B), `omp-mxf-player` |
| MxlSource / Live-Source-Handling | IS-04/MXL-Discovery + Quellen-Overlay (`/api/v1/sources`) + Crate `omp-resolver` |
| AudioRouter / AudioRules / AudioGroupConfig | Audio-Absicht (`setAudio`) + Mixer-Kanal-Erwartung/Quell-Kontext (`omp-audio-mixer`, P6) |
| Audio-Preset-Resilience (Fallback) | Fallback-Kette der Audio-Absicht (nur bei Cue/Take, kein Per-Track-Fallback zur Laufzeit — offen) |
| GrafixEngine / oGraf | `omp-ograf` |
| VoiceoverEngine | `VOICEOVER`-Kind + Mixer-Ducking; **offen:** eigener Voiceover-Trigger (P9) |
| ChannelBus (TCP/NDJSON) | Channel-Trigger über NATS + Orchestrator (§6) |
| File-Transfer-Manager-Plugin | Asset-System + Prozess-Schritt `materialize` (§8) |
| SCTE-35-Plugin | Node `omp-scte35` + Child `SCTE35` (P9.2); MXL-ANC-/TS-Ausgang offen |
| Plugin-System | SDK-Plugin-Host + Plugin `event-hooks` (HTTP-Ereignis-Hooks, §12a); Aktionen = Child-Typen; nichts automatisch als Plugin |
| As-Run (Tagesdatei) | persistenter As-Run-Store (§11) |
| Supervisor / Multi-Channel | OMP-Orchestrator/Launcher/Placement; Channel = eine Instanz |
| MarinaParser (externer Import) | nicht übernommen (außerhalb Umfang) |
| Subtitle-Engine | Untertitel-Engine im Grafik-Node (SRT/VTT) + Child `SUBTITLE` (P9.4) |

Der OMP-Adapter-Sidecar `omp-pipeline-controller` bleibt unverändert.
