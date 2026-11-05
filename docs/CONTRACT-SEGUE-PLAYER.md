# Vertrag „Segue-Player“ (Radio-Abspieler mit mehreren Stimmen)

Stand: 2026-11-05 (Kapitel 89, RB2/RB3). Dieser Vertrag beschreibt, **was die Radio-Automation von einem Abspieler erwartet**, der
mehrere Dateien gleichzeitig und sample-genau überlappend abspielt — unabhängig davon, wer ihn herstellt. `omp-segue-player` ist die
Implementierung; ein anderer Abspieler (auch ein Adapter-Node vor fremder Hardware) erfüllt dieselben Punkte und ersetzt ihn, ohne
dass Automation oder Orchestrator sich ändern. Muster wie `docs/CONTRACT-MIXER-SETUP.md`.

Alle Aufrufe laufen über den Node-Proxy des Orchestrators (`/api/v1/nodes/{nodeId}/methods/<name>`, `…/params/<name>`); Parameter und
Methoden stehen im `descriptor.json`.

## 1. Grundsatz

Der Automator entscheidet **was und wann** (Datei, TAI-Zeitpunkt, Pegel, Kurven), der Abspieler **wie** (Frame-genaues Einsetzen,
Hüllkurven, Summieren). Übergänge sind atomar: Alle Stimmen laufen in **einem Prozess** auf **einer** Ausgabeuhr. Der Ausgang ist ein
Stereo-Ton (48 kHz, f32) als MXL-Audio-Sender und reißt nie ab (Stille, solange nichts spielt).

## 2. Stimmen

Eine **Stimme** ist eine abgespielte Datei. Der Aufrufer vergibt die `voiceId` (1–40 Zeichen: Buchstaben, Ziffern, `-` `_` `.`).
**Idempotenz:** Ein zweites `play` mit bekannter `voiceId` bewirkt nichts (kein Doppelstart nach Wiederholung, Neustart der Automation
oder Netzfehler). Die `voiceId` bleibt bis zum Neustart des Abspielers bekannt, auch nach dem Ende der Stimme.

Zustände (`voices[].state`): `loading` (wird decodiert) → `scheduled` (wartet auf `startAt`) → `playing` → `ended`; bei Fehlern `error`
mit Text in `error` (Datei nicht lesbar, alle Stimmen belegt, zu lang).

## 3. Methoden

| Methode | Argumente | Wirkung |
|---|---|---|
| `play` | `voiceId`, `file`, optional `startAt` (TAI in ns, 0/fehlt = sofort), `gainDb` (−60…+24, Standard 0), `offsetMs` (Start mitten in der Datei), `fadeInMs`, `fadeInCurve`, `stopAtMs` (Stelle in der Datei, an der das Ausblenden beginnt), `fadeOutMs`, `fadeOutCurve`, `label`, `introMs`, `hookMs`, `outroMs` (Marken, nur Anzeige) | lädt die Datei, plant den Start |
| `stop` | `voiceId`, optional `fadeMs`, `curve`, `atTai` | blendet aus (oder hart bei `fadeMs` 0) und beendet die Stimme; ab `atTai` (0 = sofort) |
| `fade` | `voiceId`, `gainDb`, optional `ms`, `curve`, `atTai` | fährt den Pegel der Stimme auf `gainDb` relativ zum Grundpegel |
| `stopAll` | optional `fadeMs` | beendet alle Stimmen |

`stop` und `fade` auf eine Stimme, die noch lädt, werden gemerkt und beim Einplanen angewandt (der Automator darf die Überblendung
vor dem Ende des Ladens befehlen). `file` ist ein Pfad im Medienverzeichnis des Nodes oder absolut.

**Kurven** (`curve`, `fadeInCurve`, `fadeOutCurve`): `linear`, `cosine` (Gleichleistung: Ein = sin, Aus = cos, Standard), `log`
(−60 dB … 0 dB).

## 4. Zeit

`startAt`/`atTai` sind **TAI-Zeitpunkte in Nanosekunden** (dieselbe Zeitbasis wie `takeAt` der Mischer). Der Abspieler rechnet sie auf
seine Ausgabeuhr (Frames bei 48 kHz) und setzt die Stimme **im exakten Frame** ein, auch mitten in einem 10-ms-Block. Liegt der
Zeitpunkt schon in der Vergangenheit (Datei kam zu spät), startet die Stimme beim nächsten Block und meldet die Verspätung in
`voices[].lateMs`. Der Parameter `taiNowNs` liefert die aktuelle TAI-Zeit des Nodes.

**Gemessen (2026-11-05, Release, direkter MXL-Schreiber):** Startabweichung der Stimme gegen `startAt` im Mittel −0,008 ms, Streuung 0,017 ms (< 1 Abtastwert bei 48 kHz). Zählweise im MXL-Audioflow: der Index eines Blocks ist der Index seines **letzten** Abtastwerts. Die Gleichleistungs-Überblendung hält die Summe bei 0,00 dB, eine lineare Überblendung fällt um 2,61 dB ein.

**Prüfung:** `make segue-check NODE_URL=… [FILE=…]` (`tools/segue-check`) prüft Aufbau und Verhalten (Idempotenz, `stop` vor Ladeende, Ablehnung ungültiger Eingaben).

## 5. Parameter (lesbar)

| Parameter | Bedeutung |
|---|---|
| `voices` | JSON-Array je bekannter Stimme: `voiceId`, `label`, `file`, `state`, `positionMs`, `durationMs`, `startAt`, `gainDb`, `lateMs`, `error`, `markers{introMs,hookMs,outroMs}` |
| `voiceCount` / `maxVoices` | gleichzeitig laufende / mögliche Stimmen (Standard 8) |
| `outputLevelDb` | Spitzenpegel des Ausgangs (≈ 100 ms gehalten) |
| `cacheMb` | belegter Zwischenspeicher decodierter Dateien |
| `taiNowNs` | TAI-Jetztzeit des Nodes |

## 6. Grenzen der ersten Umsetzung

Dateien werden vor dem Start vollständig in den Speicher decodiert (bis 20 Minuten, ≈ 23 MB je Minute Stereo). Es gibt einen Ausgang
(Programm) ohne Einzelspuren. Die Marken werden mitgeführt, aber vom Abspieler nicht ausgewertet — die Planung (Radio-Automation)
rechnet daraus `startAt`, `stopAtMs` und die Kurven. Das Wiederherstellen laufender Stimmen nach einem Neustart des Abspielers ist
nicht Teil dieses Vertrags (die Automation bestimmt aus ihrem Journal, was spielen müsste).
