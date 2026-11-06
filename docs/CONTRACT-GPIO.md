# Vertrag „GPIO“ (Kontakte: Eingänge, Ausgänge)

Stand: 2026-11-06 (Kapitel 89, RC1). Dieser Vertrag beschreibt, **was Studio-Logik, Automation und Tasten-Pulte von einem
Kontakt-Gerät erwarten** (Taster, Fernstart, Rotlicht, Relais) — unabhängig vom Hersteller. `omp-gpio` ist die Implementierung mit
einem **Simulator** als Gerät; ein Treiber für echte Hardware (USB, seriell, Netzwerk-Kontakte) setzt hinter dieselbe Zustandsmaschine
und ändert den Vertrag nicht. Muster wie `docs/CONTRACT-SEGUE-PLAYER.md`. Es gibt keine Norm für diese Schnittstelle (sie ist
herstellerabhängig); Entprellzeit, Haltezeit und der Fail-Safe-Mechanismus sind **Eigenlösung** von OMP.

## 1. Grundsatz

Ein Node hat `inputCount` Eingänge (GPI) und `outputCount` Ausgänge (GPO), nummeriert ab **1** (`pin`). Jeder Pin hat einen Namen
(`in1`, `out1`, … oder eigener). Pegel sind **Wahrheitswerte**: `true` = Kontakt aktiv/geschlossen. Die Bedeutung (z. B. Rotlicht =
`out1`) legt die Studio-Logik fest, nicht der Treiber.

## 2. Eingänge

Der Treiber meldet Rohwerte. **Entprellung:** eine Änderung gilt erst, wenn der Rohwert `debounceMs` (Standard 20 ms, 0…2000) unverändert
anliegt; Zurückprellen innerhalb der Zeit erzeugt kein Ereignis. Jede gemeldete Änderung wird genau einmal veröffentlicht.

**Ereignis** auf NATS `omp.gpio.<nodeId>.in.<pin>`:
`{"kind":"in","node":…,"pin":1,"name":"in1","level":true,"seq":n,"taiNs":…}` — `seq` zählt je Node aufsteigend über alle Ereignisse,
`taiNs` ist die TAI-Zeit der Entprellung (Auslösung + `debounceMs`).

## 3. Ausgänge und Fail-Safe

`setOutput(pin, level, holdMs)`:
- `holdMs = 0` (Standard): der Pegel bleibt, bis ein neuer Befehl kommt.
- `holdMs > 0` und `level` ≠ Fail-Safe-Pegel des Pins: **Haltezeit (Lease)**. Der Aufrufer muss `setOutput` vor Ablauf wiederholen; sonst fällt
  der Ausgang auf seinen **Fail-Safe-Pegel** (`failSafe`, Standard `false`; je Pin mit `configurePin` änderbar, z. B. ein Lautsprecher, der
  im Zweifel an bleibt). So bleibt ein Rotlicht nicht stehen, wenn die Studio-Logik ausfällt — die Studio-Logik erneuert z. B. alle 1 s mit `holdMs` 3000.
- Fail-Safe-Fall wird veröffentlicht: `omp.gpio.<nodeId>.out.<pin>` mit `"reason":"lease"`. Befehle melden `"reason":"command"` (nur bei Pegeländerung).

**Verbindungsverlust zum Gerät** (`linkUp` = false): alle Ausgänge gehen **sofort** auf ihren Fail-Safe-Pegel (`reason":"link"`),
Haltezeiten verfallen, `setOutput`/Eingangsmeldungen werden mit Fehler „Verbindung zum Gerät fehlt“ abgelehnt, das Ereignis
`omp.gpio.<nodeId>.link` (`{"up":false}`) geht hinaus. Bei Rückkehr werden die Eingänge neu gelesen (geänderte Pegel kommen sofort als
Ereignis, ohne Entprellwartezeit), danach `link` `{"up":true}`. **Neustart des Nodes:** Ausgänge beginnen auf Fail-Safe; Pegel und Haltezeiten
werden nicht gesichert, Namen, Fail-Safe-Pegel und Entprellzeit schon (`GET/POST /state`).

## 4. Methoden und Parameter

| Methode | Argumente | Wirkung |
|---|---|---|
| `setOutput` | `pin`, `level`, optional `holdMs` | setzt einen Ausgang (s. 3) |
| `configurePin` | `kind` (`in`/`out`), `pin`, optional `name`, `failSafe` (nur `out`) | benennt Pins, legt den Fail-Safe-Pegel fest |
| `simulateInput` | `pin`, `level` | **Simulator:** speist einen Rohwert ein (wie ein Gerät) |
| `simulateLink` | `up` | **Simulator:** lässt die Geräteverbindung ab-/aufbauen |

| Parameter | Bedeutung |
|---|---|
| `debounceMs` (schreibbar) | Entprellzeit |
| `linkUp` | Verbindung zum Gerät |
| `inputCount` / `outputCount` | Anzahl (Umgebung `OMP_GPIO_INPUTS` / `OMP_GPIO_OUTPUTS`, Standard 8/8, höchstens 64) |
| `inputs` / `outputs` | JSON-Arrays mit `pin`, `name`, `level` (Ausgänge zusätzlich `failSafe`) |
| `recent` | die letzten 50 Ereignisse (Betreff-Endung + Inhalt) |

## 5. Grenzen der ersten Umsetzung

Nur der Simulator als Gerät. Kein Tally-Abnehmer (Kontakt ← Tally des Mischers) — die Zuordnung „Mischerkanal → Rotlicht“ gehört in
`omp-studio-logic` (RC2) und läuft über `setOutput` mit Haltezeit. Keine Authentifizierung am Kontakt selbst; Schreiben erfolgt über den
Node-Proxy mit den üblichen Rechten.
