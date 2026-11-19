# Vertrag „PTZ“ (Kamerasteuerung: Schwenken, Neigen, Zoomen, Voreinstellungen)

Stand: 2026-11-19 (Kapitel 104). Dieser Vertrag beschreibt, **was Bedienfelder, Stream Deck, Automation und Studio-Logik von einer
steuerbaren Kamera erwarten** — unabhängig vom Übertragungsweg. `omp-ptz` ist die Implementierung; sie spricht **VISCA über IP**.
Ein weiterer Treiber (z. B. ONVIF) setzt hinter dieselbe Zustandsmaschine und ändert den Vertrag nicht.

**Norm-Lage (Regel 10):** VISCA ist **keine Norm einer Normungsorganisation**, sondern eine Herstellerspezifikation. Die Byte-Folgen
stammen aus der Befehlsliste „VISCA over IP“ / VISCA-Befehle der Kamera-Familie ILME-FR7 des Herstellers Sony, Dokument
5-042-055-04 (1), © 2022 (Seiten 3–8 Paketformat und Antworten, 14–20 Befehle und Abfragen); der Originaltext wurde gelesen. Wertebereiche, die
die Liste je Modell offen lässt (Pan/Tilt-Weg, Zoom-Ende), liest OMP **nicht** fest ein; der Node reicht Rohwerte der Kamera durch.
**Eigenlösung von OMP** (nicht in VISCA): Haltezeit/Totmann, Normierung der Joystick-Werte, Namen der Voreinstellungen, Ereignisse.
**Noch nicht an echter Hardware geprüft** (Entwicklung nur gegen den eingebauten Simulator, §0 Regel 7).

## 1. Grundsatz

Eine Instanz = eine Kamera. Voreinstellungen zählen ab **1** (`preset`, Standard 1…16, höchstens 64); in der Kamera sind sie ab 0
nummeriert (Umrechnung im Node). Pan/Tilt/Zoom-Fahrten werden **normiert** angegeben (`-1…1`), Positionen als **Rohwerte** der Kamera.

## 2. Fahrt mit Haltezeit (Totmann)

Eine Fahrt läuft in der Kamera bis zum Stopp-Befehl. Darum gilt `move`/`zoom` nur für `holdMs` (Standard **1000 ms**, 100…5000): wer eine
Fahrt will, **erneuert** sie mindestens alle `holdMs/3` (das Bedienfeld alle 300 ms). Bleibt die Erneuerung aus, sendet der Node selbst
Stopp und meldet `omp.ptz.<node>.hold` (`"what":"pan-tilt"` oder `"zoom"`). Ein unveränderter Wert erzeugt **keinen** neuen Befehl an die
Kamera, nur eine neue Frist. Werte im Betrag unter 0,04 gelten als 0 (Totzone); (0, 0) = Stopp. `stop` hält immer an, auch ohne bekannte
Fahrt und ohne Verbindung (der Befehl wird gepuffert).

Geschwindigkeit: Pan höchstens Stufe `panMax` (Standard 0x18), Tilt `tiltMax` (Standard 0x14); der Betrag wird mit Exponent 1,5 auf
die Stufen 1…Max abgebildet (feiner im unteren Bereich). Zoom: Stufen 0…7. Die Liste nennt je Modell abweichende Höchststufen
(„Normal/Extended“); `panMax`/`tiltMax` sind deshalb einstellbar.

## 3. Methoden

| Methode | Argumente | Wirkung |
|---|---|---|
| `move` | `pan`, `tilt` (−1…1; rechts/oben positiv) | Fahrt (erneuern!), (0,0) stoppt |
| `zoom` | `speed` (−1…1; positiv = Tele) | Zoomfahrt (erneuern!), 0 stoppt |
| `stop` | — | Pan/Tilt und Zoom anhalten |
| `home` | — | Grundstellung der Kamera |
| `goto` | `pan`, `tilt` (Rohwerte, ganze Zahl), optional `speed` 0…1 | absolute Position (stoppt laufende Fahrt zuerst) |
| `zoomTo` | `pos` (Rohwert 0…65535) | absolute Zoomposition |
| `recall` | `preset` | Voreinstellung abrufen (stoppt laufende Fahrt zuerst) |
| `store` | `preset`, optional `name` | **aktuelle Lage** in der Kamera speichern und benennen |
| `clearPreset` | `preset` | Voreinstellung löschen |
| `renamePreset` | `preset`, `name` | Namen ändern (1…40 Zeichen), nur im Node |
| `setTarget` | `target` (`Adresse[:Port]`, Standard-Port 52381) | Kamera-Adresse wechseln (nicht im Simulatorbetrieb) |

Ohne Verbindung (`linkUp` = false) lehnen alle Methoden außer `stop`, `renamePreset` und `setTarget` mit „Kamera nicht erreichbar“ ab.
Fehler der Kamera (z. B. „nicht ausführbar“ bei einer nicht gespeicherten Voreinstellung) werden **nicht** als Fehler des Aufrufs gemeldet
(VISCA antwortet erst nach der Annahme), sondern als Ereignis `error` und in `cameraErrors` gezählt; eine abgelehnte Speicherung setzt
`stored` zurück.

## 4. Parameter

| Parameter | Bedeutung |
|---|---|
| `holdMs`, `panMax`, `tiltMax` (schreibbar) | s. 2 |
| `linkUp` | die Kamera antwortet (Frist 2,5 s ohne Antwort → `false`) |
| `moving` | der Node hält gerade eine Fahrt |
| `target`, `simulated` | Ziel und Simulatorbetrieb |
| `model` | Hersteller-/Modellkennung aus der Versionsabfrage |
| `panPos`, `tiltPos`, `zoomPos` | letzte abgefragte Rohwerte (alle 500 ms, während einer Fahrt alle 250 ms) |
| `cameraErrors` | Zähler der Fehlerantworten |
| `presets` | JSON-Array `{preset, name, stored}`; `stored` ist ein Merker des Nodes (die Kamera kennt ihn nicht) |
| `recent` | die letzten 50 Ereignisse |

## 5. Ereignisse (NATS `omp.ptz.<nodeId>.<art>`)

`link` (`up`), `hold` (`what`), `preset` (`preset`, `name`; beim Abruf), `error` (`code`, `text`, `command`). Jedes mit `seq`
(je Node aufsteigend) und `taiNs`.

## 6. Verbindung und Zustandssicherung

Ohne Verbindung sendet der Node jede Sekunde **RESET** (Steuer-Paket 0x0200, Sequenznummer des Geräts zurücksetzen, danach zählt der Node ab 1)
und eine Versionsabfrage als Lebenszeichen; das erste Antwortpaket setzt `linkUp`. Meldet die Kamera einen Sequenzfehler (Steuer-Antwort
0x0F01), folgt sofort ein neuer RESET. `GET/POST /state` sichert Ziel (nicht im Simulatorbetrieb), Haltezeit, Stufen, Namen und
`stored`-Merker; Fahrten nie.

## 7. Grenzen der ersten Umsetzung

Nur VISCA über IP (UDP), kein serielles VISCA, kein ONVIF, kein NDI-PTZ. Keine Fokus-/Blenden-/Belichtungssteuerung, keine
Tally-Kopplung, keine Auto-Verfolgung. Keine Authentifizierung gegenüber der Kamera (VISCA über IP kennt keine). Die Kamera akzeptiert
Befehle von jedem Absender im Netz: das Kameranetz gehört getrennt. Jeder `move`-Aufruf erscheint im Audit-Log (ca. 3 Einträge/s
bei gehaltenem Joystick). Preset-Nummern und Positionsbereiche sind modellabhängig und an echter Hardware ungeprüft.
