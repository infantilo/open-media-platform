# Entwurf: Modulationswächter und Havarieumschalter (`omp-failover`)

Stand: 2026-11-06 (Nutzerauftrag). Für Radio **und** Fernsehen; sitzt später **vor dem letzten Signalpunkt** (vor dem Ausspielweg / dem Playout-Puffer-Anker).
Fällt der Regieplatz davor oder die Strecke aus und gibt es länger kein Signal, ein Standbild (Freeze) oder Stille, schlägt er **Alarm** und schaltet ein
**Notsignal** (Standbild, Clip oder ein anderes Live-Signal — in einstellbarer Reihenfolge, „zuerst das, dann das …“). Zusätzlich **manuelle Umschaltung** im UI.

## 1. Funktionsumfang

| Funktion | Radio (Audio) | Fernsehen (Bild + Ton) |
|---|---|---|
| Signal fehlt (keine Daten) | ja | ja |
| Stille / Pegel unter Schwelle | ja | ja (Ton) |
| Standbild (Freeze, unveränderte Bilder) | – | ja |
| Schwarzbild (zu dunkel) | – | ja |
| Reihenfolge der Notquellen (Priorität) | Notquelle 1–3, Notclip (Datei, Schleife) | Notquelle 1–3, Notclip, Standbild |
| Alarm (`omp.alert.<node>`, Alarmwege des Orchestrators) | ja | ja |
| Automatische Rückkehr zum Hauptsignal (stabil `returnMs`, Mindestverweildauer) | ja | ja |
| Manuelle Umschaltung, Automatik zuschaltbar | ja | ja |
| Ereignisprotokoll (letzte 200) | ja | ja |

## 2. Entscheidungslogik (`failover.rs`, reine Zustandsmaschine, ohne Medien und Uhr testbar)

Je Quelle (Haupt, Notquellen) führt der Wächter zwei Zähler: **schlecht** (kein Signal / Stille / später Freeze, Schwarz) und **gut** (alles in Ordnung seit …).
Eine Quelle gilt als **gestört**, wenn ein Zustand länger als seine Haltezeit (`noSignalMs`, `silenceMs`) anliegt, und als **gesund**, wenn sie `healthyMs` lang in Ordnung war.
- **Automatik, Hauptsignal aktiv:** gestört → erste **gesunde** Quelle der Reihenfolge übernimmt (Alarm „Havarie“). Gibt es keine, bleibt das Hauptsignal stehen, Alarm „alle Quellen gestört“.
- **Automatik, Notquelle aktiv:** Hauptsignal `returnMs` lang gesund und Mindestverweildauer (`minHoldMs`) vorbei und `autoReturn` an → zurück (Alarm „Haupt wieder da“). Fällt die Notquelle aus, geht es zur nächsten gesunden Quelle der Reihenfolge, auch zum Hauptsignal.
- **Manuell:** die gewählte Quelle bleibt aktiv, egal was die Wächter sagen. Ist sie gestört, gibt es einen Alarm „manuell gewählte Quelle gestört“, aber keine automatische Umschaltung. „Automatik“ stellt die Regel wieder her.
- **Umschaltung hörbar sauber:** 20 ms Überblendung (Audio); Bild später auf Bildgrenze.
Alle Haltezeiten und Schwellen sind **Eigenlösung** (keine Norm legt sie fest); Standard: Signal fehlt 1,5 s, Stille −60 dBFS für 5 s, Freeze 5 s, Rückkehr nach 3 s Gesundheit, Mindestverweildauer 2 s.

## 3. Aufbau und Scheiben

1. **Kern + Audio (Radio)** — `omp-failover` mit MXL-Audio-Eingängen Haupt + Notquelle 1–3 + Notclip (Datei in Schleife), ein dauerhafter MXL-Audio-Ausgang, Alarm, Ereignisprotokoll, Bedienfeld.
2. **Bild (Fernsehen)** — Video-Eingänge/-Ausgang im Zielformat, Freeze- und Schwarzerkennung, Standbild als Notquelle, Umschaltung auf Bildgrenze, Bild und Ton gemeinsam (eine Entscheidung, ein Umschaltpunkt).
3. **Betrieb** — Anschluss an Alarmwege/Stream Deck, Prüfmuster zum Testen der Kette („Havarie proben“), Kennzahlen für `/metrics`, Doppelung (zwei Wächter hintereinander ist zu vermeiden).

## 4. Annahmen (bitte bestätigen oder korrigieren)

- Notquellen sind **andere MXL-Flows** (z. B. ein Segue-Player mit Notclip, ein Zuspieler, ein anderer Regieplatz) oder der **eingebaute Notclip** (Datei in Schleife). Standbild folgt in Scheibe 2.
- Der Wächter erzeugt **nie** selbst Ton, wenn alle Quellen gestört sind: er bleibt auf der aktiven Quelle und schlägt Alarm (kein „Rauschen“).
- Zwischen Hauptsignal und Ausgang liegt nur der Takt des Wächters (10 ms-Blöcke) — kein Puffer wie im Playout-Puffer.
