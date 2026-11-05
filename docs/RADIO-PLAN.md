# Radio auf der OpenMediaPlatform — Lückenanalyse, Zielbild und Phasenplan (Vorschlag)

Stand: 2026-11-05. Auftrag: `docs/RADIO-ANALYSE-PROMPT.md`. **Reiner Vorschlag, kein Code.** Nichts davon ist in
`UMSETZUNG.md` übernommen. Das geschieht erst, wenn der Nutzer zugestimmt hat (§0 Regel 8: Optionen nennen, Nutzer entscheidet).

Grundlage sind die Projektdateien, die ich selbst gelesen habe: `CLAUDE.md`, `ARCHITECTURE.md` (§1–§5, §12–§14, §20.6–§21,
§24, §28–§31), `UMSETZUNG.md` (§0, Kap. 27 mit §27.1–§27.7, Kap. 39, 42–45, 47–49, 74, 75), `docs/PLAYOUT-AUTOMATION.md`,
`docs/HANDBUCH.md` §9, `docs/CONTRACT-MIXER-SETUP.md`, `docs/ASR-UNTERTITEL.md`, `docs/ENTWURF-INGEST.md`,
`docs/ENTWURF-FILE-QC.md` und `deploy/catalog.json`. Dazu kommen gezielte Blicke in den Code unter `nodes/`
(`omp-playout-automation`, `omp-channel-player`, `omp-audio-mixer`, `omp-recorder`, `omp-intercom`, `omp-audio-rules`).
Aussagen über den Code nennen die Fundstelle. Was ich nur vermute, ist als **ungeprüft** markiert.

**Normen-Regel (UMSETZUNG §0 Regel 10):** Zitiert werden nur Normen, deren Originaltext ich für diesen Plan gelesen habe.
Abschnitt 11 führt sie mit Version auf. Andere Nummern stehen hier nur mit dem Vermerk **(unbelegt)**. Vor einem
Umsetzungsschritt muss jemand den Originaltext dieser Normen lesen.

---

## 0. Kernaussagen

1. **Die Plattform trägt Radio zur Hälfte schon.** Vorhanden sind der Tonmischer (N-1, AutoMix, Ducking, PFL,
   Medien-Automation „Kanal auf → Player startet", sample-genaues Schalten per `takeAt`), der Recorder (auch reiner Ton,
   bis 8 Eingänge), Channel, As-Run, Trigger, Carts, Fixzeit und Child Events. Dazu kommen Eingang/QC mit R-128-Messung,
   Auto-Untertitel (ASR), Intercom mit Gastlinks, Gateways (AES67, SRT, WebRTC), Mandanten-Scope, Rechte, Audit,
   Cluster-HA und Hot-Standby. Diese Teile sind fachneutral und werden **wiederverwendet**, nicht nachgebaut.
2. **Der Sendekern ist heute TV-förmig, und das ist der eigentliche Bruch.** `omp-playout-automation` schaltet jedes
   Event über **zwei** Kanal-Player (A/B) und den **Bild**mischer-Crosspoint. Der Ton folgt über „Audio folgt Video"
   (`take_on_targets`, `nodes/omp-playout-automation/src/main.rs:2827`, sucht den Video-Sender am Mischer und bricht ohne ihn ab).
   Radio braucht das Gegenteil: tongeführte Übergänge mit **mehr als zwei gleichzeitig klingenden Elementen** (Ausklang
   des Titels, Jingle, Moderation über dem Intro, Einstieg des nächsten Titels), Marker im Material und Blendkurven.
   Ein „Radio-Schalter" in diesem Node wäre genau der TV-Node mit Radio-Schalter, den der Auftrag ausschließt.
3. **Zwei neue Kerne sind nötig, alles andere sind kleine Nodes und Verträge.**
   - **Segue-Player** (`omp-segue-player`): ein Prozess spielt N Stimmen sample-genau mit Markern und Kurven. Die
     Begründung ist dieselbe wie bei der Mischerentscheidung §13.1/§13.2: ein Übergang ist eine atomare,
     sample-genaue Operation. Er gehört deshalb nicht über mehrere MXL-Hops verteilt.
   - **Sendeuhr / Musikplanung** (`omp-programmplanung`): ein eigener Fachdienst mit eigener Musikdatenbank
     (Kategorien, Rotation, Separation, Uhren). Er läuft Tage im Voraus, nicht im Sendetakt. Nach dem Muster von Kap. 48/49
     ist er ein austauschbarer Dienst hinter einem Vertrag. Er liefert einen fertigen Sendeablauf (Log), den die
     Radio-Automation abspielt.
4. **Die Radio-Automation ist ein eigener Node, der den Kanal-Kern teilt.** Persistenz, As-Run, Trigger, Carts,
   Fixzeit und Child Events werden aus `omp-playout-automation` in eine gemeinsame Crate `omp-playout-core` gezogen. Das
   ist ein Umbau ohne Verhaltensänderung. Darauf sitzen zwei Nodes mit eigenem Takt: TV (unverändert) und Radio
   (Segue, Backtiming, weiche Fixzeiten). Die Orchestrator-Domäne `playout` (Channel, Zustand, As-Run) bleibt eine.
5. **Normenlage für Ton ist klar und gelesen.** Produziert wird nach EBU R 128 (2023, V5) mit −23,0 LUFS und höchstens
   −1 dBTP. Für die Verbreitung gelten EBU R 128 s3 (2023) und Tech 3401 (2023): Ziel −23 LUFS, Zwischenwert −20 bis
   −16 LUFS. Grenzwerte je Verbreitungsweg stehen in Tech 3344 v2.1 (2016), zum Beispiel ein Endstufen-Begrenzer bei
   −2 dBTP vor dem Encoder. Heute fehlt ein **True-Peak-Begrenzer**: der Normalizer im Kanal-Player ist ausdrücklich
   keiner (`nodes/omp-audio-rules/src/loudness.rs:12`).
6. **Am frühesten nutzbar ist die Strecke Aufnahme → Eingang → sofort sendefähig.** Fast alle Glieder existieren
   (Kap. 42/43/74). Am meisten Neues und das größte Risiko liegt bei Musikplanung, SIP-Telefonie und der Ausspielung
   (DAB-Datendienste, Streaming).

---

## 1. Lückenmatrix

Status: **V** = vorhanden, **T** = teilweise, **F** = fehlt. Aufwand: **S** ≈ 1 Sitzung, **M** ≈ 2–3, **L** ≥ 4.

### 1.1 Grundlagen und Audio-only-Betrieb

| Fähigkeit | Status | Aufwand | Abhängigkeiten / Befund |
|---|---|---|---|
| MXL-Audioflüsse, NMOS-Sender/-Empfänger, X/Y-Kreuzschiene, Tags (`role.*`) | V | – | fachneutral, direkt nutzbar |
| Kanal-Player mit reiner Tondatei (ohne Bildspur) | T | S | `media_ready` verlangt Bild **und** Ton (`omp-channel-player/src/pipeline.rs:197`). Ein Datei-Zweig ohne Video-Pad bleibt **ungeprüft** |
| Workflow ohne Bild (Anker, Latenzbudget, Start-Vorschau) | T | S | `omp-playout-buffer` hat immer ≥1 Bildspur (v210-Ring, ≈ 0,45 GiB bei 1080p25). Ein reiner Ton-Anker fehlt |
| Recorder reiner Ton | V | – | ein verbundener Empfänger genügt (`omp-recorder/src/pipeline.rs:642`). Matroska/AAC bis 8, MXF bis 32 Kanäle |
| Abhören im Browser | V | – | `omp-audio-monitor`, PFL-Bus im Mischer |
| Messung R 128 / True Peak / Stille live | V | – | `omp-scope` (Stille als gehaltener Alarm, 2 s) |
| Tasten-Bedienpult (WebHID, Kap. 40) | V | – | Adapter je Node; ein Radio-Adapter fehlt (S) |

### 1.2 Sendeablauf

| Fähigkeit | Status | Aufwand | Abhängigkeiten / Befund |
|---|---|---|---|
| Channel als Domänenobjekt, Persistenz, Neustart, As-Run, Kennzahlen | V | – | Domäne `playout` (Kap. 27 P1/P10), wiederverwendbar |
| Fixzeit (hart), Hold, Jump, manueller Start/Ende, Carts mit Rückkehr | V | – | im TV-Node. Wird für Radio in `omp-playout-core` gezogen |
| Weiche Fixzeit / Backtiming (Uhr treffen durch Kürzen/Auffüllen) | F | M | radio-typisch. Braucht Marker und Füllregeln aus der Planung |
| Sendeuhr / Format-Wheel, Kategorien, Rotation | F | L | neuer Dienst `omp-programmplanung` |
| Regelwerk (Separation Interpret/Titel/Tempo, Quoten, Tageszeiten) | F | L | Teil der Programmplanung, deterministischer Löser mit Begründung (Muster §31) |
| Jingles, Sweeper, Moderationsbetten | T | S–M | Carts und `VOICEOVER`-Kind (Ducking) gibt es. Das Bett unter Live-Moderation mit Marker-Ende fehlt |
| Nachrichten, Verkehr, Wetter (Fixzeit-Blöcke, Live-Zuspielung, Fremdsender-Übernahme) | T | M | Fixzeit, LIVE-Event und Quellen-Resolver vorhanden. Verkehrsdurchsagen-Unterbrechung (Vorrangquelle) fehlt |
| Werbung, Spotblöcke | T | M | `adClass`-Blockbildung und SCTE-35 sind vorhanden (für TV). Für Radio fehlen Blockplanung mit Längenausgleich und Streaming-Marker |
| Netzschaltungen, Fensterprogramme (Regionalisierung) | T | M | Channel-Trigger über NATS mit Regeln und Late-Policy (P7) passt. Es fehlt ein Fenster-Takt mit sample-genauem gemeinsamem Ein-/Ausstieg |
| Segue: Intro-/Outro-Marker, Hook, Ramp, Cue-Punkte, Crossfade-Kurven | F | L | Kern des neuen `omp-segue-player`. Heute gibt es nur SOM/EOM (`somMs`/`eomMs`) und Cut/Mix am **Bild**mischer |
| Overlap mit mehr als zwei Elementen | F | L | A/B-Modell strukturell auf zwei begrenzt (§13.3 „ehrliche v1-Grenze") |
| Ducking unter Sprache | V | – | `DuckEngine` im Mischer (`omp-audio-mixer/src/automation.rs`), Voiceover-Kind |
| Voicetrack-Modell (VT im Kontext von Vor- und Nachfolger) | F | M | eigener Event-Typ plus Aufnahme-Oberfläche (§6) |
| Notfall-Playlist, Dead-Air-Kette | T | M | Erkennung (Scope) und Ausfallrichtlinien (`onMissing`, Filler) gibt es. Die Kette „Stille → Ersatzquelle" ohne Mensch fehlt |
| Fremd-Log importieren / Havarie-Mitlauf | T | S | Adapter-Gerüst `ForeignFormat` (Kap. 74), Mitlauf vertagt |

### 1.3 Live-Studio

| Fähigkeit | Status | Aufwand | Abhängigkeiten / Befund |
|---|---|---|---|
| Mischpult mit Fadern, EQ, Dynamik, Gate, AutoMix, N-1, Aux, PFL | V | – | `omp-audio-mixer` |
| Fader-Start (Kanal auf → Player startet) | V | – | Medien-Automation `rules.rs`/`media.rs` (Kap. 26) |
| Mikrofonlogik (Mic offen → Rotlicht, Lautsprecher-Muting, On-Air-Tally) | T | M | `onAir` je Kanal gibt es im Mischer. Die Regel-Schicht und die Hardware-Ausgänge fehlen |
| GPIO (Rotlicht, Taster, Fernstart) | F | M | `GPI`-Kind wird heute abgelehnt („kein Ziel-Node"). Neuer Node `omp-gpio` |
| Räuspertaste (Cough), Talkback zum Studio | T | S | Cough = momentanes Stummschalten (Mischer-Methode vorhanden, Taste fehlt). Talkback über Intercom (IFB) |
| Telefonhybrid / SIP | F | L | Intercom kennt nur WebRTC und Gastlinks, kein SIP (`omp-intercom/src/admin.rs:146`). Neuer `omp-sip-gateway` |
| Gäste/Remote per Browser (WebRTC), SRT-Zuspielung | V/T | S | WebRTC-Gateway (Kamera) und Intercom-Gäste vorhanden. Ein reiner Ton-Gastzugang mit N-1-Rückweg fehlt |
| Dump/Delay (Sendeverzögerung mit Löschen und Wiederaufbau) | T | M | `omp-playout-buffer` kann Verzögerung und Wiederauffüllen (±1 % Tonhöhe). „Dump" und ein Ton-Profil fehlen |
| Studio-Umschaltung und -Übergabe (A → B mit Quittung) | T | M | X/Y-Bouquets schalten. Ein Übergabe-Protokoll mit Bestätigung beider Seiten fehlt |
| Fader-Hardware (MIDI-Controller) | F | M | analog zum Tasten-Bedienpult clientseitig. MIDI **(unbelegt)** |

### 1.4 Audio-Qualität

| Fähigkeit | Status | Aufwand | Abhängigkeiten / Befund |
|---|---|---|---|
| R-128-Messung von Dateien im Eingang (I, LRA, TP) | V | – | File-QC (Kap. 43) |
| Lautheitswert als Asset-Metadatum, Wiedergabe-Gain daraus | F | S | R 128 s3 j): vor dem Playout normalisieren, als neue Datei **oder** über Loudness-Metadaten |
| Dynamischer Normalizer im Player | T | – | vorhanden, aber kein True-Peak-Begrenzer und ohne Vorausschau |
| True-Peak-Begrenzer, Verbreitungs-Prozessor (Multiband, AGC) | F | L | neuer Node `omp-audio-processor` je Verbreitungsweg |
| Kurzform-Inhalte (Spots) nach R 128 s1 | F | S | QC-Profil: Max. Short-term ≤ −18,0 LUFS, keine LRA-Regel |
| Stille-/Dead-Air-Erkennung mit Aktion | T | M | Scope erkennt Stille, löst aber nichts aus |
| Zeitansage, Uhrzeit-Genauigkeit | T | S | PTP/TAI-Pfad und `takeAt` vorhanden. Ein Zeitzeichen-Generator fehlt (Normbezug **unbelegt**) |

### 1.5 Ausspielung und Metadaten

| Fähigkeit | Status | Aufwand | Abhängigkeiten / Befund |
|---|---|---|---|
| Now-Playing-Drehscheibe (ein Ereignis, viele Abnehmer) | F | M | Quelle: Radio-Automation/As-Run. NATS-Subjekt plus HTTP/SSE |
| DAB+-Datendienste: Dynamic Label, DL Plus, SlideShow, SPI | F | M–L | ETSI TS 102 980, TS 101 499, TS 102 818 (gelesen). Die Zuführung zum Multiplexer ist **unbelegt** |
| DAB+-Audiokodierung, Multiplex, Sender | F | – | **außerhalb** (Fremdgerät). OMP liefert Ton plus PAD-Daten. ETSI TS 102 563 nur zur Einordnung |
| FM/RDS (RT, RT+), MPX | F | M | IEC 62106 **(unbelegt, kostenpflichtig, nicht gelesen)**. MPX-Erzeugung außerhalb |
| Hybrides digitales UKW-Verfahren (IBOC) | F | – | **außerhalb**, in Europa nicht verbreitet. Nur als Abnehmer der Now-Playing-Daten |
| Streaming HLS, Mehrfach-Bitraten, Marker | F | M | RFC 8216 (gelesen). `omp-stream-encoder` |
| Streaming DASH | F | M | ISO/IEC 23009-1 **(unbelegt)** |
| HTTP-Dauerstrom mit In-Band-Titeln (ICY-Verfahren) | F | S | de-facto-Verfahren, **keine Norm** |
| Ad-Insertion im Stream | T | M | SCTE-35 aus dem TV-Pfad ist wiederverwendbar. HLS-Abbildung über `EXT-X-DATERANGE` mit SCTE-35-Attributen (RFC 8216 §4.3.2.7) |
| Podcast / On-Demand | F | M | Feed-Format **(unbelegt)**, Kapitel und Transkript aus ASR |
| EBUCore-Metadaten | V | – | Tech 3293 1.10 (Kap. 78). Musikfelder fehlen |
| Musikmeldung an Verwertungsgesellschaften | T | M | As-Run hat Ist-Zeiten. Werk-, Urheber- und Tonträgerdaten sowie die Meldeformate fehlen (Formate **unbelegt**, Rückfrage) |

### 1.6 Aufnahmen und Produktion

| Fähigkeit | Status | Aufwand | Abhängigkeiten / Befund |
|---|---|---|---|
| Geplante Aufnahme mit Ressourcenplanung | V | – | Modul `ingest` (Kap. 42) |
| Compliance-Mitschnitt (lückenlos, segmentiert, Aufbewahrung, zeitadressiert) | F | M | Recorder schreibt eine Datei je `start`/`stop`. Segment-Rotation, Lückenfreiheit und Abruf fehlen |
| Mehrspur-Aufnahme | T | S | bis 8 Eingänge in **eine** Datei. Getrennte Dateien je Spur fehlen |
| Feld-Ingest, Upload, mobile Aufnahme | T | S–M | Upload (Kap. 86), Eingang/QC (Kap. 43), WebRTC. Eine Handy-Aufnahme mit Upload fehlt |
| Browser-Schnitt (nicht-destruktiv, Wellenform) | F | L | neues UI-Modul plus Render-Job (Transkodier-Jobs mit Host-Wahl, Kap. 52) |
| Transkript-basierter Schnitt | F | M | ASR liefert Abschnitte, **keine Wortzeiten** |
| Voicetracking | F | M | Aufnahmeplatz im Log-Kontext plus VT-Event |
| „Aufgenommen und sofort sendefähig" | T | S | Kette Recorder → Asset → QC → Freigabe → `appendAsset` live gefahren (Kap. 74.4). Lautheitswert und automatisches Anhängen fehlen |
| Archiv: Rechte, Aufbewahrung, Wiederfinden | T | M | Asset/EBUCore, Aufbewahrungs-Aufräumen (Handbuch 5a), Dateiverwaltung. Rechtefelder, Sperrfristen und Volltextsuche fehlen |

### 1.7 Betrieb

| Fähigkeit | Status | Aufwand | Abhängigkeiten / Befund |
|---|---|---|---|
| Mehrere Sender auf einer Plattform | T | M | Organisationen = Zugriffs-Scope, **keine** Datentrennung (`orchestrator/internal/organizations`). Channel-Gruppen vorhanden |
| Rollen Redaktion, Moderation, Technik, Musikredaktion | T | S | Funktionsrechte (Kap. 44), Rollenbindungen. Neue Funktionsrechte nötig |
| Redundanz Haupt-/Standby-Automation | T | M | Hot-Standby je Rolle (break-before-make). Ein gespiegelter Log auf einem Zweitsystem fehlt |
| Sendeprotokoll, Audit, Alarmierung | V | – | As-Run, Domänen-Audit, externes Alarming (Kap. 67/83) |
| Fernbetrieb, Heimstudio | T | M | Konsole im Browser, WebRTC. Niedrige Latenz beim Abhören ist vorgemerkt („WebRTC-Audio später") |
| Cloud/Kosten | T | – | Kap. 35 trägt. Radio braucht wenig Rechenleistung und ist ein guter Kandidat |

---

## 2. Bestandsaufnahme im Detail (Frage 1)

**Direkt nutzbar (kein oder kleiner Aufwand):**

- **Tonmischer** `omp-audio-mixer`. Er ist bereits ein Studio-Pult: dynamische Kanäle, EQ, Kompressor, Gate,
  Phase, Delay, Pan, Aux/N-1 (für Telefon- und Gast-Rückwege), Gruppen, PFL, Master-Limiter und AutoMix für Talkrunden.
  Er duckt (Schlüssel-Kanal senkt Ziele), hat Szenen und eine Medien-Automation (Fader-Start). Er schaltet sample-genau
  über `takeAt`. Fehlt: Mikrofonlogik als Regel, Cough als Taste, ein True-Peak-Limiter im Ausgang.
- **Recorder.** Reiner Ton ist möglich, ebenso Kanalpläne und MXF mit MCA-Labels. Fehlen: Rotation und Lückenfreiheit für den Mitschnitt.
- **Domäne `playout`:** Channel, Snapshot mit Optimistic Concurrency, Ausführungs-Journal, As-Run mit CSV, Trigger
  mit Regeln, Kennzahlen. Das ist alles fachneutral.
- **Eingang/QC/Review** (Kap. 43): R-128-Messung, Stille, Clipping, Freigabe-Flag, Review-Player mit Ton.
- **ASR** (`omp-subtitle-asr`): lokale Spracherkennung live und aus Dateien, Sprechererkennung (Kap. 77), SRT-Spuren.
  Für Radio bringt sie Transkripte, Suche, Shownotes und eine Vorstufe für den Schnitt.
- **Intercom:** Talkback, IFB mit Unterbrechung, Gastlinks, Fernbedienung per Tasten-Bedienpult über Vertragsrollen.
- **Gateways:** AES67 (Studio-Netze, Fremdpulte), SRT (Zuspielung, Sat-Ersatzweg), WebRTC (Gäste per Browser).
- **Cluster/HA:** Raft, Patroni, Hot-Standby, Make-before-break-Wartung, Rolling Update. Alles direkt nutzbar.
- **SCTE-35:** Die Marker-Kodierung ist medienneutral. Für Radio-Streams ist sie über HLS-Marker wiederverwendbar.

**Konzeptionell unpassend, und warum:**

- **`omp-playout-automation` als Radio-Automation.** Der Take läuft über Video-Crosspoint und A/B. Ohne Bildmischer bricht
  er mit „Standby-Kanal-Video-Sender am Mixer nicht gefunden" ab (`main.rs:2877`). Übergänge sind Bildmischer-Arten
  (cut/mix/fadecut/cutfade). Das Zeitmodell ist Primary-sequenziell mit harten Fixzeiten. Radio plant dagegen auf weiche
  Stundenmarken und auf Material-Marker.
- **`omp-channel-player`** ist „eine von zwei physischen Quellen am Video-Mixer-Crosspoint" (Moduldoku) mit genau einem
  Zweig. Für N überlappende Elemente bräuchte man N Player plus Mischerkanäle plus gekoppelte `takeAt`-Rampen über
  Prozessgrenzen. Das sind viele MXL-Hops für eine Operation, die als eine erlebt wird (Argument §13.1).
- **`omp-playout-buffer`** ist ein Ausgangs-Anker für den Bildpfad (v210-Ring). Für reinen Ton ist er überdimensioniert. Seine
  **Logik** (Fill/Run/Hold, Wiederauffüllen mit ±1 % Tonhöhe) ist dagegen genau das, was eine Sendeverzögerung braucht.
- **Grafik/OGraf, Bildmischer, VfA:** für den Ton-Sendeweg irrelevant. Für „visuelles Radio" (§7) bleiben sie wertvoll.

---

## 3. Zielbild: Node-Zuschnitt und Datenflüsse

### 3.1 Leitlinien

1. **Der Automator entscheidet was, wann und warum. Die Nodes entscheiden wie** (Spec-Leitregel aus Kap. 27, unverändert).
2. **Sample-genau Gekoppeltes bleibt in einem Prozess** (Segue im Segue-Player, Summieren im Mischer). Lose Gekoppeltes
   wird zu getrennten Nodes (Planung, Daten, Encoder, Logger).
3. **Planung ist nicht Abwicklung.** Die Musikplanung erzeugt Tage im Voraus einen Log. Die Automation spielt ihn ab,
   passt ihn an (Backtiming) und meldet den Ist-Stand zurück.
4. **Produktion und Verbreitung sind getrennt** (R 128 s3 g), Tech 3401 §2). Im Sendekern wird auf −23 LUFS
   produziert und gemischt. Verbreitungsprozessoren je Weg kommen erst danach.
5. **Verträge statt Produkte** (Kap. 49). Jeder neue Fachdienst bekommt ein `CONTRACT-*.md` und einen Konformitätstest.

### 3.2 Neue Nodes und Dienste

| Name (Vorschlag) | Art | Kern | Ein/Aus | Begründung des Schnitts |
|---|---|---|---|---|
| `omp-segue-player` | Media-Node (Rust) | N Stimmen, sample-genaue Starts auf TAI, Marker (Intro, Hook, Outro/Segue, Ramp, Fade-Punkte), Blendkurven, Gain aus Lautheits-Metadaten, Stimmen-Stems optional | aus: Programm-Ton (+ optional Stems je Ebene) | Übergänge sind atomar (§13.1-Argument). Ersetzt für Radio das A/B-Paar |
| `omp-radio-automation` | Control-Plane-Node | spielt den Log ab: Segue-Plan, weiche Fixzeit/Backtiming, Carts/Jingles, Nachrichten-Fixzeit, Fensterprogramme, VT-Events, Notfall-Log | steuert Segue-Player, Mischer, Datendienste | eigener Takt. Teilt `omp-playout-core` mit dem TV-Node |
| `omp-playout-core` | Rust-Crate (kein Node) | Persistenz-Client, Ausführungs-Journal, As-Run, Child-Event-Lebenszyklus, Trigger, Carts, Remote-Proxy | – | heraus aus `omp-playout-automation`, ohne Verhaltensänderung |
| `omp-programmplanung` | Fachdienst (Stufe 2, `extsvc`) | Musikdatenbank, Kategorien, Uhren, Regeln, Log-Erzeugung mit Begründung, Abgleich mit As-Run | aus: Log (Vertrag) | eigene Daten, Release-Zyklus und Austauschbarkeit = die Gründe aus §28.5 für Stufe 2 |
| `omp-studio-logic` | Control-Plane-Node | Mikrofonlogik, Rotlicht/On-Air, Lautsprecher-Muting, Cough, Studio-Übergabe | liest Mischer-`onAir`/Tally, schreibt GPIO/Mischer | Regeln getrennt vom Mischer (Muster `omp-vfa`) |
| `omp-gpio` | Geräte-Node | generische Ein-/Ausgänge (USB/seriell/Netzwerk-Kontakte) als NMOS-Ressource und Tally-Abnehmer | GPI → Ereignis, GPO ← Methode | schließt die heutige Lücke „GPI-Kind ohne Ziel" |
| `omp-sip-gateway` | Gateway-Node | Telefonleitungen ⇄ MXL, Rückweg N-1 vom Mischer, Leitungs-Warteschlange für Hörer-Anrufe | MXL-Ton je Leitung | eigenes Protokoll, eigene Abhängigkeiten. SIP **(unbelegt)** |
| `omp-audio-delay` | Media-Node | Sendeverzögerung mit Dump (Sprung), Wiederaufbau (±1 % Tonhöhe), Notquelle | MXL-Ton → MXL-Ton | Logik aus `omp-playout-buffer/buffer.rs` als Crate teilen, ohne Bildring |
| `omp-audio-processor` | Media-Node | Verbreitungsprozessor je Weg: AGC, Multiband, True-Peak-Begrenzer, Profile (FM/DAB/Stream) | MXL-Ton → MXL-Ton | Verbreitungsseite (Tech 3401 §5). Eine Instanz je Weg |
| `omp-now-playing` | Dienst/Modul | ein Ereignismodell (Titel, Interpret, Sendung, Bild, Kategorie) → DLS/DL Plus, SLS, SPI, RDS-RT/RT+, ICY, Web/App | NATS/HTTP/SSE | eine Wahrheit, viele Formatierer |
| `omp-radio-data` | Daten-Node | PAD-Inhalte für DAB+ (DL, DL Plus, MOT SlideShow), RDS-Daten, SPI-XML | an Fremd-Encoder/-Mux (Schnittstelle **unbelegt**) | getrennt vom Ton, unabhängig neu startbar |
| `omp-stream-encoder` | Media-Node | HLS (Mehrfach-Bitraten), HTTP-Dauerstrom, Marker (`EXT-X-DATERANGE`), In-Band-Titel | MXL-Ton → HTTP | eine Instanz je Ausspielweg |
| Modul `logger` (Orchestrator) + Recorder-Rotation | Modul + Erweiterung | lückenloser Mitschnitt je Sendeweg, Aufbewahrung, Abruf nach Uhrzeit, Export mit Prüfsumme | – | Planung/Abruf gehören in die Steuerebene, Schreiben in den Recorder |
| UI-Modul `audio-editor` | Shell-Modul | nicht-destruktiver Schnitt (EDL), Wellenform, Transkript-Schnitt, VT-Aufnahme | Render als Transkodier-Job | keine Medienpipeline im Browser, Rendern auf Hosts (Kap. 52) |

**Bewusst kein neuer Node:** Mischpult (vorhanden), Abhören (vorhanden), Gastzugang per Browser (Intercom/WebRTC
erweitern), Sat-Ersatzweg (Gateway = Live-Quelle), Nachrichtenstudio (ein zweiter Workflow mit eigenem Mischer).

### 3.3 Datenflüsse (Sendeweg eines Programms)

```
            ┌──────────────── Steuerebene ────────────────────────────────────────────────┐
 Musikplan  │ omp-programmplanung ──Log(Vertrag)──▶ omp-radio-automation ──As-Run──▶ Domäne playout │
 (Tage vor) │        ▲  Ist-Abgleich ◀──────────────────────┘    │  │  │                       │
            │        │                          Segue-Plan ◀──────┘  │  └─▶ omp-now-playing ──┐ │
            └────────┼──────────────────────────────────────────────┼───────────────────────┼─┘
                     │                                              │ Methoden/Tally          │
 Medien (MXL, Ton):  │                                              ▼                         ▼
   Dateien ─▶ omp-segue-player ─┐                          omp-audio-mixer (Studio)    omp-radio-data
   Mikros  ─▶ (AES67/Gerät) ────┼─▶ Mischer-Kanäle ──PGM──▶ omp-audio-delay ─▶ omp-audio-processor(FM)  ─▶ Fremd-Sender
   Telefon ─▶ omp-sip-gateway ──┤   N-1 zurück ──▶ SIP/Gäste          │       ├▶ omp-audio-processor(DAB) ─▶ Fremd-Encoder (+PAD)
   Gäste   ─▶ webrtc/intercom ──┘                                     │       └▶ omp-stream-encoder ─▶ HLS/HTTP
                                                                      └▶ omp-recorder (Logger-Rotation) ─▶ Modul logger
 Studio-Logik: omp-studio-logic ◀── onAir/Tally ── Mischer ; ──▶ omp-gpio (Rotlicht, Lautsprecher-Muting)
 Notfall: omp-scope(Stille) ──Alarm──▶ omp-radio-automation (Notfall-Log) bzw. omp-audio-delay (Notquelle)
```

**Mischer im Automatikbetrieb:** Läuft der Kanal ohne Moderator, kann der Segue-Player direkt auf den Delay/Processor-Pfad
gehen. Der Mischer ist dann optional, und der Workflow entscheidet. So bleibt ein reiner Automatik-Kanal klein (wenige
Prozesse, wenig CPU) und für Cloud-Betrieb geeignet.

### 3.4 Was aus der TV-Automation wiederverwendet wird und was einen eigenen Kern braucht

| Baustein | Wiederverwendung | Eigener Radio-Kern |
|---|---|---|
| Channel, Snapshot, Journal, As-Run, Kennzahlen, Logs | unverändert (Domäne `playout`, Crate `omp-playout-core`) | – |
| Child Events (Lebenszyklus, Fehlerrichtlinie, Zeitmodi) | unverändert | neue Typen: `SEGUE_MARK`, `BED`, `GPO`, `NOW_PLAYING` |
| Carts / Interrupt | unverändert | Cart-Wand im UI-Bundle des Segue-Players |
| Fixzeit (hart) | unverändert | **weiche** Fixzeit mit Backtiming und Füllregeln |
| Channel-Trigger (NATS) | unverändert | Fensterprogramm-Takt (gemeinsamer TAI-Schaltpunkt) |
| Quellen-Resolver, Tags | unverändert | – |
| Werbeblöcke (`adClass`, SCTE-35) | Blockbildung und Marker | Blocklängen-Ausgleich, Stream-Marker |
| Fremdformat-Adapter (`ForeignFormat`) | Gerüst | Import des Logs aus der Programmplanung (wenn nicht nativ) |
| Timeline/Plan (`schedule`) | Präfixsummen-Idee | Segue-Zeitlinie mit Überlappungen (Ende ≠ Start des Nächsten) |
| Take-Pfad (`take_on_targets`) | **nein** | Segue-Plan an den Segue-Player |
| Sendeuhr / Musikplanung | – | vollständig neu (`omp-programmplanung`) |

### 3.5 Verträge (analog `CONTRACT-MIXER-SETUP.md`)

1. **`CONTRACT-SEGUE-PLAYER.md`**: Was die Automation von einem mehrstimmigen Ton-Player erwartet. Dazu gehören
   `voice.load{asset, markers, gainDb}`, `voice.startAt{taiNs}` und `voice.fade{curve, toDb, atTaiNs, durMs}`.
   Außerdem `voice.stop`, die Parameter `voices[]` (Zustand, Position, nächster Marker) und `/state` GET/POST.
   Kurvennamen sind festgelegt (linear, logarithmisch, S-Kurve, konstante Leistung). Konformitätstest: zwei Stimmen
   überlappen, und der Mess-Ton zeigt die Kurve auf ±1 ms.
2. **`CONTRACT-PROGRAMMPLANUNG.md`**: Log-Schema (Stunden, Elemente mit Asset-Referenz, Kategorie, Marker,
   Soll-Zeit, Weich/Hart, Füllkandidaten, Begründung). Dazu kommen die Rückmeldung As-Run → Planung (Abgleich gespielt/
   gekürzt/ausgefallen), Versionierung (Log-Stand, Änderungen nach Freigabe) und ein Export für Musikmeldungen.
3. **`CONTRACT-NOW-PLAYING.md`**: ein Ereignis (Felder, Herkunft, Gültigkeit) und je Abnehmer die Abbildungsregeln:
   DL ≤ 128 Byte, DL-Plus-Inhaltstypen, SLS-Bildgrenzen, SPI-Felder, RDS-RT **(unbelegt)**.
4. **`CONTRACT-STUDIO-LOGIC.md`**: Mic-Gruppen, Regeln (Mic offen → GPO x, Lautsprecher-Kanal y stumm), Übergabe-Protokoll.
5. **`CONTRACT-GPIO.md`**: Ein- und Ausgänge als Ressourcen, Entprellung, Fail-Safe-Zustand bei Verbindungsverlust.

---

## 4. Sendeablauf im Detail (Frage 2)

**Planungsebene (Programmplanung):**

- **Kategorien** (z. B. Power/Recurrent/Gold/Neu), **Uhren** je Stunde und Tagesteil (Slots: Kategorie, Jingle, Nachrichten
  hart :00, Spotblock, Moderation), **Wochenraster** (welche Uhr wann).
- **Regeln** mit Gewicht: Separation (Titel, Interpret, Titelname, Album), Tempo-, Energie- und Stimmungsfolgen,
  Tageszeit-Sperren, Quoten (z. B. Anteil Landessprache, Neuheiten), Intro-Länge ≥ Moderationsfenster.
  Harte Regeln filtern, weiche gehen in eine Kostenfunktion. Der Löser ist deterministisch und gierig mit
  begrenzter Rückverfolgung und liefert eine Begründung je Platz, wie bei der Platzierung §31. Kein LLM im Planungsweg.
- Ergebnis: ein **Log** je Tag mit Füllreserven (Kandidaten zum Kürzen und Auffüllen), freigegeben von der Musikredaktion.

**Abwicklungsebene (Radio-Automation):**

- **Backtiming / weiche Fixzeit:** Eine „harte" Marke (Nachrichten :00:00) muss getroffen werden. Die Automation rechnet
  ab jetzt bis zur Marke rückwärts. Sie kürzt am nächsten Segue-Punkt, lässt einen Füllkandidaten weg oder fügt einen
  Kurz-Jingle oder ein Bett ein. Eine Song-Blende auf einen festgelegten Outro-Marker darf um höchstens X s verschoben
  werden (Parameter). Alles steht im As-Run mit Begründung.
- **Segue-Logik je Übergang:** Aus den Markern des alten (Outro/Segue-Punkt, Fade-Start) und des neuen Elements (Intro-Ende,
  Hook, Ramp) entstehen der Startzeitpunkt des Nächsten und die Kurven. Regeln je Kategoriepaar:
  Titel→Titel (Kreuzblende), Titel→Jingle (Jingle über Ausklang), Jingle→Titel (Titel startet unter dem Jingle-Ende),
  Bett unter Moderation (Bett läuft, Duck über Mic-Pegel, Ende auf Marker oder Moderator-Taste).
- **Ducking:** Der Mischer macht es weiter (DuckEngine). Für automatische Sweeper über Titeln (ohne Mic) blendet der
  Segue-Player selbst, sample-genau innerhalb einer Stimme.
- **Nachrichten/Verkehr/Wetter:** harte Fixzeit plus LIVE-Event (Nachrichtenstudio über Resolver-Tag `role.news`),
  Rückkehr per Marker oder Taste. Eine Verkehrsdurchsage ist eine **Vorrangquelle** (Cart-Prinzip mit Rückkehr), auslösbar
  per GPI, Taste oder Trigger.
- **Werbung:** Spotblock als Element mit Soll-Länge. Ausgleich über Füller oder Jingle. Kurzform-QC nach R 128 s1.
  Stream-Marker für Ersetzung im Netz (§5).
- **Fensterprogramme:** Der Mantel-Kanal sendet einen Fenster-Trigger mit TAI-Schaltpunkt an die Regional-Kanäle
  (Channel-Trigger P7). Alle schalten auf dasselbe Sample, und die Rückkehr läuft genauso. Late-Policy `RESYNC` gibt es schon.
- **Voicetrack-Modell:** VT ist ein eigenes Element mit Bezug auf Vorgänger und Nachfolger (IDs) und eigenen Segue-Markern.
  Wird der Log später geändert und ein Nachbar ausgetauscht, wird der VT als „Kontext geändert" markiert (Hinweis an die
  Redaktion, kein stilles Weiterspielen in falschem Zusammenhang).

---

## 5. Live-Studio, Audio-Qualität, Ausspielung (Fragen 3–5)

### 5.1 Moderationsplatz als Node-Verbund

Ein Moderationsplatz ist ein **Workflow** aus Mischer, Segue-Player (Cart-Wand und Log), Studio-Logik, GPIO,
SIP-Gateway, Intercom und Abhören. Er ist kein Allround-Node. Bedient wird er in **einer** Konsole (Kap. 14, Kacheln) mit
Rechten je Rolle. Moderator, Produzent und Technik sehen jeweils ihren Ausschnitt.

- **Mikrofonlogik:** `omp-studio-logic` liest `onAir` je Mischerkanal (vorhanden) und bildet Gruppen (Moderator, Gäste).
  Regeln: Mic auf → Rotlicht (GPO), Studio-Lautsprecher stumm, Talkback ins Studio gesperrt oder auf Kopfhörer umgeleitet.
  Die Regeln stehen als Daten im Vertrag, nicht im Code.
- **Cough/Räuspern:** Taste (Panel, Tasten-Bedienpult, GPI) → momentanes Stummschalten des Kanals über die
  vorhandene Mischer-Methode. Fail-Safe: Loslassen oder Verbindungsverlust heißt „wieder offen", und das ist im Vertrag festgelegt.
- **Telefon:** `omp-sip-gateway` liefert je Leitung einen MXL-Fluss. Der Rückweg ist ein N-1-Bus des Mischers (vorhanden).
  Vorgespräch läuft über PFL/Aux. Die Leitungs-Warteschlange (wartend, im Vorgespräch, auf Sendung) zeigt der Produzent.
- **Remote/Gäste:** SRT (vorhanden), WebRTC-Gast mit reinem Ton und N-1-Rückweg (Intercom-Gastlink erweitern).
  Die ISDN-Ablösung ist damit SIP plus SRT plus WebRTC.
- **Dump/Delay:** `omp-audio-delay` sitzt vor der Verbreitung. Dump springt um einen Abschnitt nach vorn (Verzögerung
  schrumpft). Der Wiederaufbau läuft über die vorhandene Wiederauffüll-Technik (gleichmäßig eingefügte Mittelwerte, ±1 %
  Tonhöhe). Auf der Ausgangsseite ist der Node auch die **Notquelle**: bei Eingangsausfall Puffer, danach Ersatzquelle statt Stille.
- **Studio-Übergabe:** Studio A bietet an, B nimmt an, und der Schaltpunkt liegt auf einem TAI-Zeitpunkt (X/Y-Bouquet plus Quittung).
  Abbrechbar, im Audit festgehalten.

### 5.2 Lautheit und Pegel (gelesene Normen, Abschnitt 11)

| Punkt | Vorgabe | Quelle | OMP-Umsetzung |
|---|---|---|---|
| Programm-Lautheit Produktion | −23,0 LUFS, live ±1,0 LU, QC-Toleranz ±0,2 LU | EBU R 128 (2023) h), i) | QC-Profil „Radio Produktion", Mischer-Anzeige |
| Max. True Peak Produktion | −1 dBTP (Messtoleranz ±0,3 dB) | EBU R 128 m) | Mischer-Master-Limiter → True-Peak-Begrenzer |
| Messverfahren | BS.1770 inkl. Gating Gl. (7) und EBU Tech 3341 | EBU R 128 k), ITU-R BS.1770-5 | `omp-scope` gibt BS.1770 an. **Konformität mit Tech 3341 ungeprüft** (Tech 3341 nicht gelesen) |
| Kurzform (Spots, Jingles) | −23,0 LUFS, Max. Short-term ≤ −18,0 LUFS, −1 dBTP, keine LRA-Grenze | EBU R 128 s1 (2020) | QC-Profil „Kurzform" |
| Alt-Material | vor dem Playout auf −23,0 LUFS, als neue Datei **oder** über Loudness-Metadaten | EBU R 128 s3 j) | Asset-Feld „Lautheit" + Wiedergabe-Gain im Segue-Player |
| Verbreitungs-Lautheit | Standard −23,0 LUFS, sonst im Bereich −20,0…−16,0 LUFS | R 128 s3 k), n); Tech 3401 §5 | Profil im `omp-audio-processor` |
| Digitale Wege | Signalaufbereitung unabhängig vom FM-Processing | R 128 s3 o) | eigene Prozessor-Instanz je Weg |
| Vor dem Encoder | Endstufen-Begrenzer −2 dBTP, bei niedriger Bitrate tiefer | EBU Tech 3344 v2.1 | Profil „Encoder" |
| FM-Stereo-Aussteuerung | Begrenzerschwelle −9,7 dBTP (praktisch −10 dBTP), bezogen auf 1 kHz, 50 µs | EBU Tech 3344 v2.1 §4.2 | Profil „FM", MPX außerhalb von OMP |
| Streaming | unverändert −23,0 LUFS mit Metadaten, sonst Zwischenwert −20…−16 LUFS | EBU R 128 s2 (2023) e), g) | Profil im Stream-Encoder |
| Messanzeige im Studio | relative Skala, EBU +9, Short-term für Selbstfahrer-Studios, Hervorhebung ±2 LU (S) bzw. ±3 LU (M), IL mit einer Nachkommastelle | EBU Tech 3401 §4.2 | Mischer-UI (Konsole 2) und Scope |
| Dynamik in der Produktion | Kompression nur künstlerisch, PLR und LRA beobachten | Tech 3401 §4.1 | Anzeige PLR/LRA im Scope |

**Kein normierter Weg (Eigenlösungen, als solche gekennzeichnet):** Stille-/Dead-Air-Erkennung (Schwelle, Haltezeit,
Aktion), Notfall-Playlist, Zeitansage. Für die Uhr gibt es PTP/TAI. Eine Norm für einen Zeitzeichen-Ton habe ich nicht gelesen **(unbelegt)**.

**Multiband-Prozessor als Node?** Ja, auf der Verbreitungsseite und je Weg (FM ≠ DAB ≠ Stream). In der Produktion nicht:
Tech 3401 §4.1 verlangt, die Dynamik in der Produktion intakt zu lassen. Erst die Verbreitung passt an.

### 5.3 Ausspielung und Metadaten

- **Now-Playing** ist die Drehscheibe. Quelle sind die Ereignisse der Radio-Automation (Element on air, aus der As-Run-Zeile)
  und Moderations-Overrides. Jeder Abnehmer ist ein Formatierer:
  - **DAB+ Dynamic Label / DL Plus:** Ein DL-Text hat höchstens 128 Byte. DL-Plus-Objekte müssen in **einer**
    DL-Nachricht liegen. Die 64 Inhaltstypen (z. B. Titel, Interpret) **entsprechen exakt RDS RT+** (ETSI TS 102 980
    V2.1.2 §5, §5.1). Damit gibt es eine Abbildung für DAB und RDS.
  - **SlideShow:** JPEG/PNG (APNG möglich). Empfänger müssen Bilder bis 50 kByte (51 200 Byte) dekodieren und
    320 × 240 Pixel darstellen. Kleinere Bilder werden zentriert, größere dürfen beschnitten oder verworfen werden
    (ETSI TS 101 499 V3.2.1). OMP rendert Slides deshalb auf 320 × 240 und ≤ 50 kByte, auf Wunsch per OGraf-Vorlage (Cover, Moderatorbild, Verkehrsgrafik).
  - **SPI/EPG:** XML nach ETSI TS 102 818 V3.5.1 (2023-12), für Rundfunk (DAB/DRM) und IP. Es ist auch als
    Austauschformat zwischen Sendern gedacht. Die Daten kommen aus Programmplanung und Sendeschema.
  - **DAB+-Ton:** Kodierung HE-AACv2 nach ETSI TS 102 563 V2.1.1. PAD für Labels und Datendienste ist vorgesehen. Encoder
    und Multiplexer sind Fremdgeräte. Wie OMP die PAD-Daten dorthin liefert, ist offen **(Schnittstelle unbelegt, Rückfrage)**.
  - **FM/RDS:** RT/RT+ und Sendername. IEC 62106 ist **nicht gelesen (unbelegt)**. Die Anbindung eines RDS-Coders
    ist offen.
  - **Streaming:** HLS nach RFC 8216 (Version 7 des Protokolls; Informational-RFC, kein Standards-Track). Marker
    über `EXT-X-DATERANGE` mit SCTE-35-Attributen. Mehrfach-Bitraten über Master-Playlist. DASH **(unbelegt)**.
    HTTP-Dauerstrom mit In-Band-Titeln (ICY-Verfahren) ist de facto ohne Norm und wird als solcher dokumentiert.
  - **IBOC-Hybridverfahren:** außerhalb. Abnehmer nur über Now-Playing, falls je gebraucht.
- **Musikmeldung/Abrechnung:** Aus der As-Run (Ist-Start, Ist-Dauer, unterbrochen ja/nein) und den Werkdaten der Programmplanung
  (Titel, Urheber, Verlag, Tonträger, Tonträger-Kennung) entsteht ein Bericht je Zeitraum und Verwertungsgesellschaft.
  Die **Meldeformate habe ich nicht gelesen (unbelegt)**. Sie müssen vor der Umsetzung beschafft werden (Rückfrage R7).
  Die Werk-Kennungen (z. B. Tonträger-Kennung) sind ebenfalls **unbelegt**.
- **EBUCore** (Tech 3293 1.10, Kap. 78) trägt die Archiv- und Austauschseite. Musikfelder kommen über die vorhandene Feld-Registry dazu.

---

## 6. Aufnahmen und Produktion (Frage 6)

- **Compliance-Mitschnitt:** Der Recorder bekommt eine Rotation (`record.segmentS`, lückenlos: neues Segment ab dem
  Folge-Sample, Überlappung von einem Block zur Prüfung). Ein neues Orchestrator-Modul `logger` plant je Sendeweg einen
  Dauermitschnitt (auf Basis des `ingest`-Moduls), setzt die Aufbewahrung durch (Handbuch 5a), bietet Abruf nach Uhrzeit
  (Ausschnitt von–bis, wandübergreifend) und Export mit Prüfsumme sowie Audit-Eintrag (wer hat was gehört). Die
  **gesetzliche** Aufbewahrungsfrist ist eine Rechtsfrage und **unbelegt** (Rückfrage R6). Zugriff gibt es nur mit eigenem Funktionsrecht.
- **Mehrspur:** Recorder um „Datei je Spur" erweitern (Interview mit getrennten Mikros, Nachbearbeitung).
- **Feld-Ingest:** Upload vorhanden. Neu: eine **Aufnahme-Seite fürs Handy** (Browser, wie die Kamera-Seite,
  Einladungslink). Sie nimmt lokal auf und lädt nach, mit Wiederaufnahme bei Netzabbruch. Danach läuft die Eingangs-Kette (QC, Freigabe).
- **Browser-Schnitt** (`audio-editor`): nicht-destruktiv als EDL über Assets (Bereiche, Blenden, Gain, Spuren), Wellenform
  aus vorberechneten Spitzenwerten. Gerendert wird erst bei „Fertig" als Transkodier-Job auf einem Host (Kap. 52). Das Ergebnis
  ist ein neues Asset mit Herkunftsverweis.
- **Transkript-Schnitt:** ASR um **Wortzeiten** erweitern (Engine-Option, Kap. 75). Text markieren → Bereich schneiden. Das
  Transkript bleibt am Asset (Suche, Shownotes).
- **Voicetracking:** Aufnahmeplatz im `audio-editor`. Er spielt den Ausklang des Vorgängers und den Anfang des Nachfolgers aus dem Log,
  nimmt über Browser-Mikro oder Studio-Kanal auf und setzt die Segue-Marker. Das Ergebnis ist ein VT-Element im Log.
- **Sofort sendefähig:** Recorder → Asset → QC (mit Lautheitswert) → Freigabe (manuell oder automatisch nach Profil) →
  `appendAsset` in den Log der Radio-Automation oder als Cart. Die Glieder gibt es (Kap. 74.4). Neu sind nur der Lautheitswert und
  ein „Nach Freigabe anhängen".
- **Archiv:** Rechte (Sperrfrist, Sendegebiet, Wiederholungen), Aufbewahrungsklassen, Suche über EBUCore-Felder und Transkript.
  Für ein volles MAM bleibt die Grenze aus §24.2/§20.8 bestehen. Rückfrage R10.

---

## 7. Zukunft und Kreativität (Frage 7)

**Jetzt machbar (Bausteine vorhanden, Aufwand S–M je Punkt):**

- **Echtzeit-Transkription mit Suche** über alle Sendewege (ASR live plus Logger) mit Zeitsprung in den Mitschnitt.
- **Automatische Kapitel und Shownotes** aus Transkript, Sprecherwechsel (Kap. 77) und As-Run (Titelwechsel).
- **Visuelles Radio:** Studiokamera(s) mit „Video folgt Audio" (Kap. 46, vorhanden) plus OGraf-Bauchbinden aus Now-Playing
  plus Stream. Das ist ein TV-Workflow mit Radio als Quelle und kein Radio-Sonderfall.
- **Regionalisierte Streams:** Fensterprogramme als eigene Channel-Instanzen und eigene Stream-Encoder.
- **Hörer-Interaktion:** Votes und Wünsche als Webhook-Eingang → Vorschlagsliste für die Musikredaktion (nicht automatisch on air).

**Später (eigene Entscheidung, Forschungsanteil):**

- **KI-Planungshilfe** (Stimmung, Energie, Tempo aus Audio-Analyse) als **Merkmal** für den deterministischen Löser, nicht
  als Löser. Begründung je Platz bleibt Pflicht.
- **Automatische Moderationstexte und synthetische Stimmen:** nur mit Kennzeichnung im Signal und in den Metadaten
  (DL, SPI, As-Run), Einwilligung der Stimm-Spender und Freigabe durch einen Menschen. Rechtsrahmen **unbelegt** (Rückfrage R11).
- **Personalisierte Streams** (serverseitig je Hörer gemischt): bricht den linearen Sendeweg, braucht einen eigenen Rechtsrahmen (Meldung je Hörer).
- **Objektbasiertes Audio / NGA:** Das ADM-Metadatenmodell ist im Projekt bisher ausdrücklich ausgenommen (Kap. 78). Normen
  **nicht gelesen (unbelegt)**. Voraussetzung wären Stems aus dem Segue-Player und dem Mischer, und die sind im Zuschnitt
  bereits vorgesehen.
- **Datengetriebene Ausspielung** (Hörerzahlen → Planung): erst mit eigener Datenquelle, Datenschutzprüfung nötig.

---

## 8. Betrieb (Frage 8)

- **Mehrmandanten:** Organisationen sind heute nur ein Zugriffs-Scope ohne Datentrennung. Für mehrere Sender **einer** Anstalt
  reicht das. Für fremde Mandanten auf einer Plattform (Dienstleister-Betrieb) nicht. Rückfrage R3.
- **Rollen und Rechte:** neue Funktionsrechte `radio.plan` (Musikredaktion), `radio.log.release`, `radio.vt`,
  `radio.studio.operate`, `logger.listen` (Datenschutz), `logger.export`. Bindungen je Channel bzw. Workflow wie bisher.
- **Redundanz:** Hot-Standby für Segue-Player und Radio-Automation. Der Bedienzustand läuft über `/state`, der Log aus
  der Domäne `playout`. Ein **Zweitsystem** (zweiter Standort) spielt denselben Log im Gleichlauf als Havarie. Kap. 74 hat
  den Mitlauf vertagt. Für Radio ist er wegen der geringen Datenrate günstig. Der Notfall-Log liegt lokal auf dem Host des Delay-Nodes.
- **Monitoring:** As-Run, Kennzahlen, Alarm-Weiterleitung und Stille-Alarm vorhanden. Neu: Kennzahl „Dead-Air-Sekunden",
  „Backtiming-Abweichung an harten Marken", „Lautheit je Stunde (IL)".
- **Fernbetrieb/Heimstudio:** Konsole im Browser, Mikro über WebRTC (Gast-Pfad), Abhören mit niedriger Latenz (vorgemerkter
  Punkt „WebRTC-Audio später" wird hier fällig). Die Sendeverantwortung bleibt am Studio-Logik-Node (wer ist on air).
- **Cloud/Kosten (Kap. 35):** Reiner Automatikbetrieb (Segue-Player, Automation, Processor, Encoder) ist klein. Ich schätze
  ihn als cloud-tauglich ein, **ungemessen**. Studios mit lokalen Mikrofonen bleiben vor Ort, angebunden über AES67/SRT.

---

## 9. Phasenplan (Stil `UMSETZUNG.md`, ein Schritt je Sitzung)

Reihenfolge nach Nutzen und Risiko: zuerst die Grundlagen mit kleinem Risiko (Ton ohne Bild, Lautheit), dann der Sendekern,
danach Studio, Ausspielung und Planung. Jede Verifikation ist **klein und kurz** zu halten (wenige Instanzen, ≈ 10-s-Proben,
Instanzen danach löschen; Rücksicht auf die CPU des Entwicklungsrechners). Jeder Schritt endet mit Handbuch §9,
Benutzerhandbuch, Katalogbeschreibung und neuen UI-Texten über `t()` in `de.ts`/`en.ts`.

### Phase RA — Ton ohne Bild (Fundament)

- **RA1 — Kanal-Player und Workflow ohne Bild (S).** Datei ohne Bildspur, `media_ready` nur für vorhandene Medien,
  Start-Vorschau ohne Bild-Anker-Warnung für reine Ton-Workflows.
  *Verifikation:* `cargo test -p omp-channel-player`. Live: WAV/FLAC laden → Ton-Flow fließt (`mxl-info`, eindeutiges Label),
  `media_ready` wahr, kein Bild-Flow angelegt. Workflow mit Player → Recorder startet ohne Warnung.
- **RA2 — Lautheit als Asset-Merkmal (S).** QC-Ergebnis I/LRA/TP/Max-S als Asset-Feld. Profile „Radio Produktion"
  (R 128) und „Kurzform" (R 128 s1).
  *Verifikation:* Go-Tests (Profilgrenzen ±0,2 LU). Zwei Testdateien (eine laut, ein 20-s-Spot mit Max-S > −18) →
  Befunde wie erwartet, Feld im Asset sichtbar.
- **RA3 — Ton-Verzögerung `omp-audio-delay` (M, 2 Sitzungen).** Logik aus `buffer.rs` als gemeinsame Crate, Ton-Profil,
  Dump, Wiederaufbau, Notquelle.
  *Verifikation:* Unit-Tests der gemeinsamen Crate (bestehende 19 Tests weiter grün). Live mit Marker-Ton:
  Verzögerung 8 s, Dump −4 s hörbar und messbar. Wiederaufbau auf 8 s in der erwarteten Zeit (1 %), keine Lücke/kein Klick
  (Scope: keine Stille-Alarme). Eingang trennen → Notquelle nach Pufferende.

### Phase RB — Sendekern

- **RB1 — Crate `omp-playout-core` (M, 2 Sitzungen).** Herauslösen ohne Verhaltensänderung.
  *Verifikation:* `cargo test -p omp-playout-automation` unverändert grün. Golden-Vergleich der Descriptor-Parameter und
  -Methoden vorher/nachher identisch. Durchlauf-Test (`tools/durchlauf-e2e`) und Timing-Test grün.
- **RB2 — `CONTRACT-SEGUE-PLAYER.md` + Konformitätstest (S).** Nur Vertrag und Prüfwerkzeug (gegen einen Mock).
  *Verifikation:* Prüfwerkzeug läuft gegen den Mock grün und gegen einen absichtlich falschen Mock rot.
- **RB3 — `omp-segue-player` Kern (L, 3 Sitzungen).** N Stimmen, `startAt` auf TAI, Kurven, Marker, Gain aus Lautheit.
  *Verifikation:* Konformitätstest grün. Messung mit Marker-Tönen: Startabweichung ≤ 1 ms, Kurvenverlauf gegen Sollkurve,
  4 Stimmen gleichzeitig ohne Aussetzer (CPU-Messung kurz, 10 s). Neustart: `/state` stellt Stimmen wieder her (ohne Doppelstart).
- **RB4 — `omp-radio-automation` Grundlauf (L, 2–3 Sitzungen).** Log laden (Domäne `playout`), Segue-Plan, Carts, harte Fixzeit, As-Run.
  *Verifikation:* Unit-Tests der Segue-Planung (Marker-Fälle, Titel→Titel, Jingle über Ausklang). Live: Log mit 3 Titeln und
  1 Jingle läuft durch, As-Run-Zeiten gegen Soll ≤ 1 Bildlänge Äquivalent (≤ 20 ms), Neustart ohne Doppelausführung.
- **RB5 — Backtiming / weiche Fixzeit (M).**
  *Verifikation:* Unit-Tests (Kürzen am Segue, Füllkandidat weglassen, Jingle einfügen). Live: harte Marke 3 min voraus
  wird auf ±100 ms getroffen, Begründung im As-Run.
- **RB6 — Dead-Air-Kette (S).** Scope-Stille → Alarm → Automation (Notfall-Log) bzw. Delay (Notquelle). Haltezeiten als
  Eigenlösung dokumentiert.
  *Verifikation:* Quelle stumm schalten → Umschaltung nach eingestellter Zeit, Alarm/As-Run/Audit-Eintrag, Rückkehr nach Freigabe.

### Phase RC — Studio

- **RC1 — `omp-gpio` + `CONTRACT-GPIO.md` (M).** Simulator-Gerät zuerst (Regel 7: ohne Hardware testbar).
  *Verifikation:* Simulator: GPI → NATS-Ereignis, GPO ← Methode, Fail-Safe-Zustand bei Verbindungsverlust.
- **RC2 — `omp-studio-logic` (M).** Mic-Gruppen, Rotlicht, Lautsprecher-Muting, Cough, Übergabe.
  *Verifikation:* Mischerkanal öffnen → GPO (Simulator) an, Lautsprecher-Kanal stumm. Cough hält stumm, Loslassen öffnet.
  Übergabe A→B schaltet auf TAI-Zeitpunkt, Abbruch möglich, Audit vorhanden. CDP-Klicktest der Konsole.
- **RC3 — Ton-Gastzugang mit N-1 (S).** Intercom-/WebRTC-Gast nur Ton, Rückweg aus Mischer-N-1.
  *Verifikation:* Browser-Gast (Headless mit Testton) hört N-1 ohne eigene Stimme (Pegelmessung), Mischerkanal erhält Gast-Ton.
- **RC4 — `omp-sip-gateway` (L, 3 Sitzungen).** Erst nach Rückfrage R5 (Protokollumfang, Dependency-Begründung §0 Regel 5).
  *Verifikation:* zwei lokale SIP-Endpunkte (Software), Anruf annehmen, Ton in beide Richtungen, Warteschlange im Panel.

### Phase RD — Ausspielung

- **RD1 — `omp-now-playing` + `CONTRACT-NOW-PLAYING.md` (M).**
  *Verifikation:* Element on air → Ereignis auf NATS und SSE. DL-Formatierer kürzt UTF-8-sicher auf ≤ 128 Byte, DL-Plus-Tags
  zeigen auf Titel/Interpret (Unit-Tests gegen TS 102 980).
- **RD2 — `omp-stream-encoder` HLS + HTTP-Dauerstrom (M, 2 Sitzungen).**
  *Verifikation:* Playlist validiert gegen RFC 8216 (Tags, Segmentdauer ≤ Ziel), zwei Bitraten, Wiedergabe im Headless-Browser,
  Titelwechsel im Dauerstrom, `EXT-X-DATERANGE` bei Spotblock.
- **RD3 — `omp-audio-processor` (L, 3 Sitzungen).** True-Peak-Begrenzer zuerst, dann AGC/Multiband, Profile FM/DAB/Stream.
  *Verifikation:* Scope am Ausgang: Max TP ≤ Profilwert (−2 dBTP Encoder, −9,7 dBTP FM-Bezug), IL im Zielfenster nach
  10-min-Testprogramm (kurz halten: 2 min Probe). Bypass ohne Pegeländerung.
- **RD4 — `omp-radio-data` DL/DL Plus/SlideShow/SPI (M, 2 Sitzungen).** Erst nach Rückfrage R8 (Zuführung zum Encoder).
  *Verifikation:* Slides 320 × 240, ≤ 51 200 Byte (Unit-Test), SPI-XML gegen das Schema aus TS 102 818 validiert.
- **RD5 — RDS-Daten (S–M).** Erst nach Beschaffung und Lektüre von IEC 62106.

### Phase RE — Aufnahme und Produktion

- **RE1 — Recorder-Rotation + Modul `logger` (M, 2 Sitzungen).**
  *Verifikation:* 3 Segmente à 20 s ohne Lücke (Sample-Zählung über die Grenzen), Abruf „von–bis" über eine Segmentgrenze,
  Aufräumen nach Aufbewahrung (verkürzt im Test), Audit beim Anhören.
- **RE2 — Sofort sendefähig (S).** Nach Freigabe automatisch an Log/Cart anhängen.
  *Verifikation:* Aufnahme stoppen → in ≤ 30 s im Log mit Lautheitswert, Wiedergabe-Gain korrekt.
- **RE3 — Handy-Aufnahme mit Upload (M).**
  *Verifikation:* Headless-Seite nimmt Testton auf, Upload nach Abbruch fortgesetzt, Eingang/QC läuft.
- **RE4 — `audio-editor` nicht-destruktiv (L, 3 Sitzungen).**
  *Verifikation:* EDL speichern/laden, Render-Job erzeugt neues Asset (Dauer = Summe der Bereiche ± 1 Block), Original unverändert. CDP-Klicktest.
- **RE5 — Wortzeiten in der ASR + Transkript-Schnitt (M).**
  *Verifikation:* Testsatz → Wortzeiten, Wort markieren → Bereich im Editor auf ±50 ms.
- **RE6 — Voicetracking (M).**
  *Verifikation:* VT im Kontext aufnehmen, Marker setzen, Log spielt VT mit Segue. Nachbar tauschen → Warnung „Kontext geändert".

### Phase RF — Programmplanung

- **RF1 — `CONTRACT-PROGRAMMPLANUNG.md` + Import in die Radio-Automation (S).** Log-Schema, Rückmeldung, Versionen.
  *Verifikation:* Beispiel-Log (Datei) lädt, As-Run-Rückmeldung entspricht Schema.
- **RF2 — Dienst `omp-programmplanung`: Datenbank, Kategorien, Uhren (L, 2 Sitzungen).** Stufe-2-Dienst über `extsvc`.
  *Verifikation:* Konformität des Dienst-Manifests (`cmd/serviceconformance`), CRUD mit Rechten/Audit, Sicherung über Gateway.
- **RF3 — Regel-Löser mit Begründung (L, 3 Sitzungen).**
  *Verifikation:* Unit-Tests je Regel, ein Tag mit 200 Testtiteln: keine Verletzung harter Regeln, Begründung je Platz, deterministisch (zweimal gleich).
- **RF4 — Musikmeldung-Export (M).** Erst nach R7 (Formate).
  *Verifikation:* Export eines Testtags gegen das beschaffte Format, Summen = As-Run.

### Phase RG — Betrieb und Zukunft (je einzeln freizugeben)

RG1 Funktionsrechte Radio (S) · RG2 Zweitsystem im Gleichlauf (M) · RG3 Echtzeit-Transkript-Suche über Logger (M) ·
RG4 Kapitel/Shownotes (S) · RG5 Podcast-Ausspielung (M, Feed-Format vorher lesen) · RG6 Fader-Controller per MIDI (M) ·
RG7 KI-Merkmale für die Planung (Forschung) · RG8 synthetische Stimme mit Kennzeichnung (erst nach R11).

**Empfohlene erste fünf Sitzungen:** RA1 → RA2 → RB1 → RB2 → RB3 (Teil 1). Sie liefern sofort Nutzen (Ton-Workflows,
Lautheit) und bauen mit kleinem Risiko den Kern vor, der alles Weitere trägt.

---

## 10. Risiken und offene Entscheidungen (Frage 10)

**Risiken:**

1. **Kernumbau `omp-playout-core`:** Er berührt einen sendefähigen, live geprüften Node. Gegenmittel: Golden-Vergleich,
   Durchlauf- und Timing-Tests vor und nach dem Umbau, kein Umbau in einem Zug (Muster Kap. 36).
2. **Sample-Genauigkeit über Prozessgrenzen:** Segue-Player ↔ Mischer (Ducking unter Live-Mic) läuft über MXL plus `takeAt`. Die
   Mischer-Latenz muss gemessen werden (Marker-Ton), sonst sind Bett-Enden „auf Marker" ungenau.
3. **Musikplanung ist fachlich tief.** Ein guter Löser lohnt sich erst mit echten Daten und Regeln einer Musikredaktion. Ohne
   Fachpartner droht ein Demo-Löser.
4. **SIP-Abhängigkeiten:** Eine Bibliothek oder ein Plugin ist nötig (Regel 5). Interop mit realen Anlagen ist nur mit Gegenstellen prüfbar.
5. **Fremdgeräte-Schnittstellen** (DAB-Encoder/PAD-Zuführung, RDS-Coder): nicht genormt bzw. nicht gelesen. Ohne Zielgerät
   ist nur gegen Simulatoren prüfbar (Regel 7).
6. **Recht:** Mitschnitt-Pflichten, Musikmeldung, Datenschutz beim Mitschnitt-Abhören, synthetische Stimmen. Das ist alles
   unbelegt und keine Technikfrage.
7. **Scope-Konflikt mit dem Architekturplan:** `ARCHITECTURE.md` §7 (P3 „Radio & MAM bewusst nach 2029 verschoben") und §20.8
   schließen Radio-Automation aus. Ein Start widerspricht dem Plan, bis der Nutzer das ausdrücklich ändert.
8. **CPU des Entwicklungsrechners:** viele neue Nodes. Tests klein halten (Messung kurz, Instanzen sofort löschen).

**Entscheidungen, die ich vor der Planung brauche:** siehe Rückfragen. Bis dahin gelten die Empfehlungen in Klammern.

---

## 11. Gelesene Normen (Originaltext, für diesen Plan)

| Dokument | Version | Was daraus verwendet ist |
|---|---|---|
| EBU R 128 „Loudness normalisation and permitted maximum level of audio signals" | 2023 (V5, November 2023) | −23,0 LUFS, ±1,0 LU live, ±0,2 LU QC, −1 dBTP (±0,3 dB), Verweise s1–s4, Tech 3341–3344, 3401 |
| EBU R 128 s1 „Loudness Parameters for Short-form Content" | August 2020 | Max. Short-term −18,0 LUFS, keine LRA-Grenze |
| EBU R 128 s2 „Loudness in Streaming" | V3, November 2023 | unverändert −23,0 LUFS; Zwischenwert −20…−16 LUFS |
| EBU R 128 s3 „Loudness in Radio" | November 2023 | Produktion/Verbreitung trennen; Alt-Material per Datei oder Metadaten; Verbreitung −23 bzw. −20…−16 LUFS; digitale Wege ohne FM-Processing |
| EBU Tech 3401 „Guidelines for Radio production and distribution in accordance with EBU R 128" | November 2023 | Programm-Hierarchie (§1.2), Produktionsregeln (§4.1), Messanzeige (§4.2), Verbreitung und FM-Optionen (§5, §5.1) |
| EBU Tech 3344 „Guidelines for distribution and reproduction in accordance with EBU R 128" | Version 2.1, Juli 2016 | FM-Stereo-Begrenzer −9,7 dBTP (§4.2), Endstufen-Begrenzer −2 dBTP vor dem Encoder |
| ITU-R BS.1770 | -5 (11/2023), nur Titel und Ausgabe geprüft | als Messverfahren-Bezug. **Algorithmus-Details nicht neu gelesen** |
| ETSI TS 102 980 „Dynamic Label Plus" | V2.1.2 (2019-02) | 64 Inhaltstypen = RDS RT+, DL ≤ 128 Byte, Objekte in einer DL-Nachricht |
| ETSI TS 101 499 „SlideShow; User Application Specification" | V3.2.1 (2023-07) | JPEG/PNG/APNG, ≤ 51 200 Byte, 320 × 240, Verhalten bei abweichender Größe |
| ETSI TS 102 818 „XML Specification for Service and Programme Information (SPI)" | V3.5.1 (2023-12), Geltungsbereich gelesen | SPI für DAB/DRM/IP und als Austauschformat |
| ETSI TS 102 563 „DAB+ audio coding (MPEG HE-AACv2)" | V2.1.1 (2017-01), Geltungsbereich gelesen | HE-AACv2, PAD für Labels und Datendienste |
| IETF RFC 8216 „HTTP Live Streaming" | August 2017 (Informational, Protokollversion 7) | Playlist-Modell, `EXT-X-DATERANGE` (§4.3.2.7) mit SCTE-35 |
| EBU Tech 3293 (EBUCore) | 1.10 | bereits in Kap. 78 gelesen und umgesetzt |

**Nicht gelesen, daher unbelegt:** IEC 62106 (RDS/RT+), ETSI EN 300 401 (DAB-Grundnorm, nur als Verweis in TS 102 980/102 563),
EBU Tech 3341/3342/3343, ITU-R BS.412, ISO/IEC 23009-1 (DASH), SIP, MIDI, ADM (ITU-R BS.2076 / EBU Tech 3364), Feed-Formate für
Podcasts, Werk- und Tonträgerkennungen, Meldeformate der Verwertungsgesellschaften, Rechtsgrundlagen der Mitschnitt-Aufbewahrung.

---

## 12. Rückfragen an den Nutzer

1. **Scope:** Soll Radio jetzt beginnen? Das hebt `ARCHITECTURE.md` §7 (P3 „nach 2029") und §20.8 für Radio-Automation auf.
   Wenn ja: als neues Kapitel in `UMSETZUNG.md` mit den Phasen RA–RG?
2. **Zuschnitt Sendekern:** (a) neuer `omp-segue-player` (N Stimmen in einem Prozess) **(empfohlen)** oder (b) N Kanal-Player
   plus Mischer-Rampen über `takeAt`? Und: eigene `omp-radio-automation` auf gemeinsamer Crate **(empfohlen)** statt
   Profil-Schalter im TV-Node?
3. **Mehrmandanten:** nur mehrere Programme **einer** Anstalt (heutiger Org-Scope reicht) oder auch fremde Mandanten mit Datentrennung?
4. **Programmplanung:** selbst bauen (RF2/RF3) oder zuerst nur den Vertrag plus Import eines extern geplanten Logs (RF1) und
   den Löser später? Gibt es eine Musikredaktion als Fachpartner und echte Regelwerke?
5. **Telefonie:** Wird SIP gebraucht (welche Gegenstellen: Telefonanlage, Netzbetreiber)? Oder reichen zunächst WebRTC-Gäste und SRT?
6. **Mitschnitt:** Welche Rechtsordnung(en), welche Aufbewahrungsfrist, wer darf anhören/exportieren?
7. **Musikmeldung:** Für welche Länder und Verwertungsgesellschaften? Können Sie die Meldeformate (Spezifikationen) beschaffen?
8. **Verbreitungswege:** Welche sind real: FM mit RDS, DAB+ (eigener Multiplex oder Zulieferung), nur Streaming? Welche
   Schnittstelle erwartet der vorhandene DAB-Encoder bzw. RDS-Coder für Datendienste (Spezifikation beschaffbar)?
9. **Verbreitungs-Lautheit:** −23 LUFS (Normstandard) oder ein Zwischenwert −20…−16 LUFS? Für FM: Option 1, 2 oder 3 aus Tech 3401 §5.1?
10. **Archiv:** Bleibt es bei „kein MAM" (§24.2/§20.8), mit nur Rechtefeldern und Suche, oder ist ein Radio-Archiv mit Rechteverwaltung gewünscht?
11. **Synthetische Stimmen / KI-Texte:** grundsätzlich gewünscht? Wenn ja, unter welchen Kennzeichnungs- und Freigaberegeln?
12. **Hardware:** Gibt es GPIO-Geräte, Fader-Controller und Studio-Rotlicht, an denen getestet werden kann, oder bleibt es vorerst beim Simulator?
13. **Reihenfolge:** Passt der Einstieg RA1 → RA2 → RB1 → RB2 → RB3, oder hat ein Live-Studio (Phase RC) Vorrang vor dem Automatik-Kern?
