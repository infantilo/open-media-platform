# Entwurf Hauptkontrollraum (MCR) — Normlage und Entscheidungen

Zu `UMSETZUNG.md` Kapitel 106 und `ARCHITECTURE.md` §33. Stand: 2026-11-20, Schritt 106.0 (nur Doku).
Regel: Eine Norm wird nur zitiert, wenn ihr Originaltext gelesen wurde. Alles andere steht unten als „nicht belegt“.

## 1. Normlage (Originaltext gelesen)

### EBU R 37 — „The relative timing of the sound and vision components of a television signal“

- **Fassung:** R37-2007, Februar 2007 (erstmals 1986, überarbeitet 1997, 2002, 2006 zweimal, neu aufgelegt 2007). Quelle: `tech.ebu.ch/docs/r/r037.pdf`, am 2026-11-20 gelesen.
- **Grenzwerte am Ausgang für die Sendung (Tabelle 1):** Ton vor Bild **höchstens 40 ms**, Ton nach Bild **höchstens 60 ms**. Das ist der Gesamtwert (Ende zu Ende).
- **Genauigkeit je Stufe der Kette:** Ton **5 ms früh bis 15 ms spät** (Ton vor Bild = früh).
- **Messverfahren:** „Blip“ (1-kHz-Ton im Bezugspegel) und „Flash“ (Vollbild in Spitzenweiß), beide genau eine Bilddauer lang und gleichzeitig. Diese Marken sollen auch bei dateibasierter Verteilung erhalten bleiben.
- **Grundsatz:** Bild und Ton sollen in der Kette gleichzeitig geführt werden („coincident on the tape / in the file or data stream“) und nicht wegen nachfolgender Verarbeitungsverzögerungen vor- oder zurückgesetzt werden. Automatische Korrektur wird bevorzugt.
- **Übernommen in OMP:** (a) Fenster +40/−60 ms für die Ampel (so schon in `omp-scope`, `timing.rs`). (b) Der Normalizer ist eine Stufe der Kette und darf selbst höchstens 5 ms früh / 15 ms spät hinzufügen (Abnahme in 106.5). (c) Etiketten bleiben in jeder Stufe gleichzeitig erhalten (stützt ARCHITECTURE §33 M4). (d) Testsignal Blip/Flash (106.4).
- **Vorzeichen in R 37:** „sound before picture“ = Ton früh = **positiv** im Sinn der Tabelle (40 ms), „sound after picture“ = 60 ms.

### ITU-R BT.1359-1 — „Relative timing of sound and vision for broadcasting“ (1998)

- **Fassung:** BT.1359-1 (1998). Quelle: itu.int, `R-REC-BT.1359-1-199811-I!!PDF-E.pdf`, am 2026-11-20 gelesen.
- **Erkennbarkeit (Erwägung g und Anhang 1, Abs. 3):** etwa **+45 ms bis −125 ms**; **Annehmbarkeit** etwa **+90 ms bis −185 ms**. **Positiv = Ton eilt dem Bild voraus.**
- **Empfehlungen:** (2) Gesamtwert zwischen den Punkten 1' und 6' höchstens +90/−185 ms. (3) Bildquelle bis Nullbezug +25/−100 ms. (4) vom Ausgang des letzten Quellenwählers bis zum Sender +22,5/−30 ms. (5) Strecken außerhalb der Kontrolle des Senders höchstens ±2 ms Fehler.
- **Hinweis Zeitstempel (Anmerkung 2):** Zeitmarken sollen die Erhaltung des richtigen Versatzes in der Kette erleichtern. Das stützt Etiketten-Erhalt.
- **Übernommen in OMP:** nur als Hintergrund und Begründung der Asymmetrie; **als Alarm-Grenze gilt R 37, nicht BT.1359.**

### Auflösung des Widerspruchs „+40 gegen +45 ms“

Die **+45 ms** in `docs/decisions.md` (Messnotiz zum 2026-10-05) stammen nicht aus R 37, sondern sind die **Erkennbarkeitsschwelle aus BT.1359** (+45/−125 ms). Der Code in `omp-scope` (`R37_AUDIO_LEAD_LIMIT_MS = 40`, `R37_AUDIO_LAG_LIMIT_MS = 60`) ist richtig. Der Text dort ist eine Verwechslung. In `docs/decisions.md` wird die alte Notiz **nicht** umgeschrieben (Entscheidungsprotokoll), sondern hier und im Kapitel richtiggestellt.

### Vorzeichen-Konflikt im Bestand (neu gefunden, vor 106.4 zu beheben)

| Stelle | Positiv bedeutet |
|---|---|
| EBU R 37 / ITU-R BT.1359 | Ton **vor** Bild (Ton eilt voraus) |
| `omp-scope` (`timing.rs`, `av_offset_ms`) | Ton eilt voraus (stimmt mit der Norm überein) |
| `omp-mediaio/examples/av_marker_probe.rs` (Ton-Etikett minus Bild-Etikett) | Ton **hinkt nach** (**umgekehrt**) |
| ARCHITECTURE §33 M6 (Text) | übernimmt das Vorzeichen der Beispielprogramm-Konvention (**umgekehrt zur Norm**) |

**Festlegung für Kapitel 106:** Es gilt die **Normkonvention**: positiv = Ton vor Bild. Die Bibliotheksfunktion in `omp-mediaio::avmarker` (106.4) gibt in dieser Konvention aus (also `Bild-Etikett − Ton-Etikett`), das Beispielprogramm bekommt dasselbe Vorzeichen, und der Ausgleich in 106.5 richtet sich danach: **positiv (Ton früh) → Ton verzögern, negativ (Ton spät) → Bild verzögern.** ARCHITECTURE §33 M6 und die Abnahmekriterien in 106.4/106.5 sind entsprechend angepasst.

## 2. Transportnormen (Originaltext/Quellseite geprüft)

- **SRT:** Es gibt **keinen RFC**. Die Spezifikation ist der Internet-Draft `draft-sharabayko-srt-01` (letzte Fassung 2021-09-07, Datatracker-Stand: abgelaufener individueller Entwurf, Veröffentlichung als Independent-Submission nicht abgeschlossen). Im Code und in den Handbüchern wird er als „SRT (Internet-Draft draft-sharabayko-srt-01)“ bezeichnet, **nicht** als Norm.
- **RIST:** VSF **TR-06-1** (Simple Profile), aktuell Ausgabe **2020-06-25**; **TR-06-2** (Main Profile), laut Seite der VSF aktuell die Ausgabe **2024** (frühere Ausgaben 2020–2023 überholt). **GStreamer 1.22.0** (`ristsrc`/`ristsink`, lokal geprüft) beschreibt sich als „RIST TR-06-1 streaming specification“, setzt also das **Simple Profile** um. Main-Profile-Funktionen (Tunnel, Verschlüsselung) sind damit **nicht** abgedeckt. Vor 106.7 festhalten, was `ristsrc` bei mehreren Adressen (Bündelung) tatsächlich tut (Eigenschaft `bonding-addresses`) und das durch einen Versuch belegen.
- Die Abschnittsnummern von TR-06-1 (z. B. RTT-Echo Abschnitt 5.2.6) wurden nur über Sekundärangaben gesehen; **Originaltext der VSF-PDF vor dem Zitat im Code lesen** (Aufgabe in 106.7).

## 3. Nicht belegt (Originaltext hier nicht lesbar) — nicht als Norm zitieren

| Norm | Grund | Folge |
|---|---|---|
| SMPTE ST 2110-10, -20, -30 | kostenpflichtig, Text nicht zugänglich | im Code nur „ST 2110“ nennen, **ohne Abschnittsnummern**; Verhalten als Eigenschaft des Bestands (`omp-2110-gateway`) beschreiben |
| SMPTE ST 2059-1 | wie oben | RTP-Zeitstempel-Umrechnung (106.8) mit Beschreibung statt Norm-Abschnitt; Nutzer kann Text bereitstellen |
| SMPTE ST 337 (nicht-PCM-Daten) | wie oben | Regel „Datenkanäle nie interpolieren“ bleibt als **eigene Schutzregel** (Datenkanäle gehen sonst kaputt), nicht als Normzitat |
| AMWA IS-08 | frei zugänglich, in 106.3 vor dem Bau lesen | Kanalzuordnung nur „angelehnt an“, bis gelesen |

## 4. Nutzerentscheidungen (2026-11-20)

Stehen vollständig unter „Entschiedene Punkte“ in `UMSETZUNG.md` Kapitel 106 (E-M1 bis E-M10) und in `ARCHITECTURE.md` §33.2 (M3, M3a, M14, M15). Kurz: Haus- und Tonformat zur Laufzeit einstellbar; SDR↔HDR nur Mindest-Abbildung hinter austauschbarer Schnittstelle; A/V-Versatz in der Testphase messen und halten; inhaltsbasierte Messung gewünscht, Material fehlt; einfacher SRT-Strom reicht; Rückweg beides; Mitschnitt über den Ingest; Bildratenwandlung nur als Übergang; Alarme als Rand und automatisches Alarm-PiP, alles dynamisch.

## 5. Offene Punkte für spätere Schritte

- **106.4:** Vorzeichen-Angleichung des Beispielprogramms `av_marker_probe` (siehe oben).
- **106.7:** TR-06-1-Originaltext lesen, Bündelungsverhalten von `ristsrc` belegen, Ingest-Fähigkeit (TS-Eingang oder nur MXL) prüfen.
- **106.8:** ST-2059-Beschreibung ohne Normzitat, bis der Nutzer den Text liefert.
- **Hinweis zu 5 ms/15 ms je Stufe:** gilt für jede Stufe; die Abnahme in 106.5 misst den **Normalizer allein**, nicht die ganze Leitung.

## 6. Abbildungsdienst (Schritt 106.3b)

**Zweck:** Wandlungen, deren Qualität später aus der Community kommen soll (Übertragungsfunktion SDR/HLG/PQ, später Bildratenwandlung mit Bewegungsschätzung), sitzen hinter einer kleinen, stabilen Schnittstelle. Der Normalizer kennt nur diese Schnittstelle (`tonemap::StageBackend`).

**Eingebaut (`builtin`):** feste Kennlinie auf der Helligkeit (Y, begrenzter Bereich 16–235, 8 Bit), Farbigkeit unberührt. Gemeinsamer Bezug: Bezugsweiß = 1,0 linear (SDR 100 %, HLG 75 % Signal, PQ 203 cd/m²). Das sind Annahmen der Mindest-Abbildung, **keine** Normwerte aus gelesenem Text. **Kein Qualitätsversprechen**; im Katalog und Handbuch so benannt.

**Parameter:** `normalize.transferPolicy` = `house` (Regel des Hausformats) | `warn` (unverändert, mit Warnung) | `block` (Leitung sperren) | `map` (über den aktiven Dienst); `normalize.mapBackend` = `builtin` oder ein Dienst-Befehl. Startwert für den Dienst: `OMP_MAP_BACKEND`.

**Vertrag Version 1 (Fremdprozess, Standard-Ein-/Ausgabe):**

| | |
|---|---|
| Anfrage | 20 Bytes Kopf + `width*height` Bytes Y-Ebene, dicht gepackt: `"OMPM"`, version u32 LE (=1), width u32 LE, height u32 LE, from u8, to u8, 2 Bytes 0; Kurven: 0 SDR, 1 HLG, 2 PQ |
| Antwort | genau `width*height` Bytes Y-Ebene |
| Ende | Eingabe geschlossen → Dienst beendet sich |
| Fehler | Dienst tot oder Antwort unvollständig → Bild läuft unverändert weiter, Alarm „Abbildungsdienst …“ über den 2-s-Takt (`normalize.lastError`, Alert) |
| Latenz | Dienst läuft synchron pro Bild; er muss innerhalb einer Bilddauer antworten, sonst staut die Kette |

**Beispielaufruf:** `normalize.mapBackend = "/pfad/zu/omp-map-invert"` (Testdienst im Crate, invertiert die Helligkeit). Ersatz der eingebauten Stufe belegt durch `tests/backend_swap.rs` und den Live-Test `live_stage_transfer_map`.

**Frame-Rate-Stufe:** Dieselbe Idee (Stufe austauschbar, Vertrag mit Bildfolge statt einzelner Ebene) ist für die Bildratenwandlung vorgesehen; Vertrag Version 2 mit Mehrbild-Fenster ist **noch nicht** festgelegt und nicht gebaut. Heute läuft dafür `videorate` (Übergang, E-M8).

**Grenzen:** Nur Y-Ebene (8 Bit, Y42B); Eingang im Zeilensprung ohne Auflösen wird nicht unterstützt; Abbildung sitzt vor der Skalierung.

## 7. Leitungsmitschnitt und RIST (Schritt 106.7)

**Vorprüfung Ingest (2026-11-20):** Der vorhandene Ingest (`orchestrator/internal/modules/ingest`) und der Schreiber `omp-recorder` nehmen **nur MXL-Flows** auf (Quelle = Instanz/Sender, Aufnahme über `MxlVideoInput`/`MxlAudioInput` bzw. TAMS-Flow-ID). Ein Transportstrom-, SRT- oder RIST-Eingang existiert dort nicht. Folge nach Nutzerentscheidung E-M7 (keine zweite Aufnahme-Infrastruktur): **Der Mitschnitt einer Leitung ist der Mitschnitt des nativen MXL-Flows des Eingangs** (`omp-contribution`, ein Dekodierungsschritt, kein Normalizer) über den Ingest. **Ein Mitschnitt des Original-Transportstroms (ohne Dekodierung) ist damit nicht möglich** und wird dem Nutzer hier ausdrücklich so gemeldet. Der Node enthält keinen eigenen Speicherpfad.

**Relay:** Zusätzlich kann `omp-contribution` den ankommenden Transportstrom **unverändert** weiterleiten (`contrib.relayUri`, SRT oder RIST). Das ersetzt den Mitschnitt nicht, erlaubt aber, den Original-Strom an ein externes Ziel (z. B. ein Aufnahmegerät) zu geben.

**RIST:** Umgesetzt ist das Simple Profile (VSF TR-06-1) über GStreamer 1.22 `ristsrc`/`ristsink`. Das Main Profile (TR-06-2: Tunnel, Verschlüsselung) ist **nicht** abgedeckt. Der TR-06-1-Originaltext wurde in diesem Schritt **nicht** gelesen, deshalb nennt der Code keine Abschnittsnummern. Bündelung: `ristsrc` hat in 1.22 keine Eigenschaft `enable-bonding`; Bündelung läuft über `bonding-addresses` (Liste `adresse:port`), live belegt (siehe Status 106.7). Der RTP-Port muss gerade sein (RTCP = Port + 1). Die Statistik kommt aus `rist/x-receiver-stats` (Pakete statt Bytes; die Bitrate ist daraus als Näherung mit 1316 Byte je Paket berechnet).

## 8. Konfigurierbare Verarbeitungskette (Schritt 106.13g, Nutzerwunsch 2026-11-21)

**Ziel:** Welche Nodes eine Leitung verarbeiten, ist Daten und kein Code. Neue Microservices (Skalierer, später Filter) lassen sich einhängen, ohne `Materialize` zu ändern.

**Modell.** Eine *Stufe* ist `{id, nodeType, where: "pre"|"post", enabled, label?, params: {name: wert}}`.
- `pre` = vor dem Normalizer (sieht das Eingangsformat der Leitung), `post` = nach dem Normalizer (sieht das Hausformat).
- Der **Normalizer bleibt gesetzt** (Hausformat nur bei Abweichung, Etiketten, A/V-Ausgleich, Messung) und ist nicht Teil der Liste.
- Die Reihenfolge innerhalb von `pre` bzw. `post` ist die Reihenfolge der Liste.

**Ebenen (von allgemein zu besonders):** global (Einstellung `mcr.chain`) → Event (`chain` am Event) → Leitung (`chain` an der Leitung). Gilt die **nächstbesondere vorhandene Liste ganz** (keine Mischung); `null` = erbt, `[]` = ausdrücklich keine Stufen. Begründung: leicht erklärbar und prüfbar; Mischregeln wären in einer Sendeumgebung eine Fehlerquelle.

**Zulässige Typen:** Einstellung `mcr.stageTypes` (Liste von Node-Typen, Standard `["omp-scaler"]`), vom Administrator änderbar. Ein Typ außerhalb der Liste wird beim Speichern abgelehnt. Der Katalog bleibt unverändert (eigene Einträge kommen dort wie bisher dazu).

**Vertrag einer Stufe** (damit `Materialize` sie ohne Sonderfall verdrahten kann):
1. Erster Bild-Empfänger und erster Ton-Empfänger nehmen die Quelle der Stufe davor; Sender 1 (Bild) und Sender 2 (Ton) sind der Ausgang — dieselbe Namenskonvention wie beim Normalizer. Fehlt eine Art (reiner Bildfilter), wird sie am Ort durchgeschleift: die Verbindung zur nächsten Stufe geht dann vom **letzten Glied, das diese Art hat**, weiter.
2. Parameter kommen nach dem Start per `PATCH /params/<name>` aus den Daten (Quelle der Wahrheit = Datenbank, wie beim Normalizer), nicht über Umgebungsvariablen (kein Eingriff in die Allowlist der Host-Agenten).
3. Eine Stufe darf Format ändern; der Normalizer danach gleicht auf das Hausformat an. Stufen `post` sollen das Hausformat erhalten (Verantwortung des Betreibers, in der Oberfläche vermerkt).

**Was am Ende der Kette hängt:** `LineRoles.Output` = letzte Rolle der Kette (bei leerer `post`-Liste der Normalizer). Quellname „MCR/<Event>/<Leitung>“, Überwachung (Kachelquelle), Rückweg-Quelle und Workflow-Schnittstelle nutzen `Output`. Normalizer-Parameter, A/V-Messung und Abgleich bleiben am Normalizer.

**Auswirkungen:** Kapazitäts-Vorprüfung zählt die Stufen automatisch (Rollen des Workflows). Änderungen der Kette wirken beim nächsten Start (planned → testing); ein laufender Workflow ändert seine Rollen nicht (siehe 106.13).

**Nicht Teil dieses Schritts:** Filter-Nodes selbst; Bild-/Tonstufen mit mehreren Ausgängen; Umordnen laufender Ketten.
