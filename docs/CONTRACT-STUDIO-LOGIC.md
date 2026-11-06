# Vertrag „Studio-Logik“ (Mikrofonlogik des Moderationsplatzes)

Stand: 2026-11-06 (Kapitel 89, RC2). Beschreibt, **was die Studio-Logik tut und wovon sie ausgeht**. `omp-studio-logic` ist die Implementierung;
sie liest den Mischer (`omp-audio-mixer`) und einen GPIO-Node (`docs/CONTRACT-GPIO.md`) über den Orchestrator-Proxy und schreibt dorthin
zurück. Die Regeln sind Daten (Parameter `config`), kein Code. Es gibt keine Norm dafür; Haltezeiten und Höchstdauern sind Eigenlösung.

## 1. Konfiguration (`config`, JSON)

```json
{
  "groups":  [{"name":"Moderator","channels":["ch1"],"light":1,
               "speakers":[{"kind":"channel","id":"ch2"}],"coughInput":2}],
  "studios": [{"name":"A","channels":["ch1"]},{"name":"B","channels":["ch3"]}],
  "maxCoughMs": 15000, "lightHoldMs": 3000
}
```
Ziele: Parameter `mixer` und `gpio` (Namen der Nodes, wie bei der Radio-Automation). Eine ungültige Konfiguration wird abgelehnt (Gruppennamen
eindeutig, Pins ab 1, Lautsprecher-`kind` = `channel`/`group`/`aux`). `GET/POST /state` sichert Konfiguration und Ziele.

## 2. Mikrofongruppe

Eine Gruppe ist **auf Sendung**, solange mindestens ein ihrer Kanäle am Mischer `channel.<id>.onAir` meldet. Ist ein Kanal nicht lesbar,
bleibt der letzte Zustand (ein Lesefehler schaltet nichts).
- **Rotlicht:** `light` = Ausgang am GPIO-Node. Die Logik sendet `setOutput(pin, onAir, holdMs = lightHoldMs)` bei Änderung und als Erneuerung
  alle `lightHoldMs/3`. **Fail-Safe:** fällt die Studio-Logik oder die Verbindung aus, verfällt die Haltezeit und das Licht geht aus.
- **Lautsprecher-Muting:** Ziele in `speakers` sind stumm, solange die Gruppe auf Sendung ist (`channel.<id>.setMute`, `group.<id>.setMute`,
  `aux.<id>.setMaster{muted}`), nur bei Änderung gesendet.

## 3. Cough (Räuspertaste)

Auslöser: Kontakt-Eingang `coughInput` (gedrückt = `true`) oder Methode `cough(group, on)`. Solange aktiv, sind alle Kanäle der Gruppe stumm.
Beim Beenden wird der **vorherige** Stummzustand jedes Kanals wiederhergestellt (ein schon stummer Kanal bleibt stumm). Beenden heißt:
Loslassen, `cough(…, false)`, **nicht erreichbarer GPIO-Node** (gilt als losgelassen) oder `maxCoughMs` bei Auslösung per Methode.
**Grenze:** Beendet sich die Studio-Logik selbst mitten im Cough, bleiben die Kanäle stumm (der Mischer kennt keine Haltezeit). Die Taste wirkt
im Mittel nach einem Takt (100 ms); gemessen 91 ms bis zum Stummschalten.

## 4. Studio-Übergabe

`offerHandover(from, to, atTai | atUnixMs | delayMs)` → `acceptHandover` → am Schaltpunkt werden die Kanäle des abgebenden Studios stumm und
die des annehmenden offen; `activeStudio` wird gesetzt. `abortHandover` bricht ab. Nicht angenommen bis zum Schaltpunkt: verfällt ohne Umschaltung.
Zu späte Annahme und ein Schaltpunkt in der Vergangenheit werden abgelehnt. Alles steht im Parameter `audit` (Text, aufsteigend, mit Soll- und Ist-TAI).
**Genauigkeit:** Der Mischer hat für Stummschaltungen kein `atTai`; die Umschaltung erfolgt im Takt der Studio-Logik (gemessen 95 ms nach Soll),
nicht sample-genau. Das Audit liegt bisher im Node (nicht in der Datenbank des Orchestrators).

## 5. Parameter und Methoden

`mixer`, `gpio`, `config` (schreibbar); `view` (Gruppen mit `onAir`/`cough`, Studios, `activeStudio`, `handover`), `audit`, `lastError` (lesbar).
Methoden: `cough(group, on)`, `offerHandover`, `acceptHandover`, `abortHandover`.
