# Vertrag „MIDI-Pulte“ (Kapitel 93)

Stand: 2026-11-11. Dieser Vertrag beschreibt, **was OMP von einem MIDI-Bedienpult erwartet und wie es mit ihm spricht**: Fahrfader-Pulte
mit Mackie-Control-Protokoll (Hauptpult + Erweiterungen) und beliebige MIDI-Geräte über ein Profil. Es gibt zwei Wege mit derselben Logik:

| | **Weg A: Browser** (`ui/shell/midi/`) | **Weg B: Gateway-Node** (`nodes/omp-midi-gateway`) |
|---|---|---|
| Anschluss | Web MIDI (USB, Chrome/Edge, HTTPS/localhost, SysEx-Erlaubnis) | ALSA-Rohgeräte `/dev/snd/midiC<n>D<m>`, RTP-MIDI (AppleMIDI), Simulator |
| Läuft | solange die Seite offen ist | als Node, ohne Browser, platzierbar auf jedem Host |
| Bedienung | Knopf „MIDI“ in der App-Leiste | Bedienfeld des Nodes, Parameter `config` / Methode `setConfig` |
| Ziel | gewählter Audiomischer (Proxy-API) | Mischer nach Anzeigename (Orchestrator-Proxy, wie die Studio-Logik) |

Beide Wege teilen **Codec, Fader-Kennlinie, Pult-Logik und Profil-Zuordnung** (TypeScript und Rust, gegen dieselben Prüfwerte in
`docs/midi/golden.json` und `docs/midi/profile-golden.json` getestet).

## 1. Unterstützte Geräte

**iCON Pro Audio V1-M / V1-X, P1-M / P1-X** (und andere Pulte im Mackie-Control-Modus): Die Hersteller- bzw. Händlerangaben nennen für diese Geräte
Universal Mackie Control und HUI; die V1-M hat 9, jede Erweiterung 8 berührungsempfindliche Fahrfader. **Nicht geprüft (kein Gerät
vorhanden):** wie der Modus am Gerät umgeschaltet wird, wie die Erweiterung am Rechner erscheint (eigener USB-Anschluss → eigene
Einheit; so ist es hier angenommen) und ob das Gerät die Anmeldung (§2.4) verlangt. Das Handbuch des Geräts war nicht abrufbar. **HUI wird
nicht umgesetzt** (andere Sprache mit Ping/Zonen-Schaltern; MCU genügt für die genannten Geräte).

## 2. Mackie Control (MCU)

**Quelle und Prüfstatus (UMSETZUNG §0 Regel 10, ehrlich):** Mackie hat das Protokoll nicht veröffentlicht. Die Grundlage ist die Dokumentation des
Emagic-Logic-Control-Protokolls, den Vorläufer. OMP hat **das Originaldokument nicht gelesen**, sondern die unabhängige Nachforschung
*TouchMCU, „Mackie Control Protocol“* (GitHub NicoG60/TouchMCU, `doc/mackie_control_protocol.md`), die laut ihrer Angabe mit einem Mackie Control
Universal Pro (Firmware 3.0.0) und einem BabyHUI geprüft wurde, sowie *Mackie Control MIDI Map* (rncbc.org, Messung an einem MCU) gegengelesen. Alles
unten gilt daher als **gegen ein Originalgerät nur mittelbar belegt**; die Prüfwerte in `golden.json` sind von Hand aus diesen Quellen
hergeleitet, nicht vom Gerät. Der Test am echten iCON ist offen.

### 2.1 Nachrichten Pult → Rechner (alle auf MIDI-Kanal 1, außer Fader)
| Nachricht | Bedeutung |
|---|---|
| Note On/Off, Anschlag 127/0 | Taste gedrückt/losgelassen. Noten: Rec 0–7, Solo 8–15, Mute 16–23, Select 24–31, Drehgeber-Druck 32–39, Funktionstasten 40–103 (Tabelle `BUTTON` in `mcu.ts`/`mcu.rs`), Fader berührt 104–111, Master berührt 112 |
| Pitchbend, Kanal 1–9 | Fader 1–8 und Master, 14 Bit (0 = unten, 16383 = oben) |
| CC 16–23 | Drehgeber: Bit 6 = Gegenuhrzeigersinn, Bits 0–5 = Schritte |
| CC 60 | Jog-Rad (gleiche Kodierung); CC 46 externer Regler |

### 2.2 Nachrichten Rechner → Pult
| Nachricht | Bedeutung |
|---|---|
| Note On, Anschlag 0/1/127 | LED aus / blinkt / an (gleiche Noten wie die Tasten; 113–115: SMPTE, BEATS, Rude Solo) |
| Pitchbend Kanal 1–9 | Fahrfader fahren |
| CC 48–55 | LED-Kranz: Bit 6 = kleine LED, Bits 4–5 = Art (Punkt/Boost/Wrap/Spread), Bits 0–3 = Wert 0–11 |
| Kanaldruck `s v` | Pegel: oberes Halbbyte = Kanalzug 0–7, unteres = Stufe 0–12 (14/15: Übersteuerung setzen/löschen) |
| CC 64–75 | 7-Segment-Anzeigen (Zeichen 0x20–0x5F, Bit 6 = Punkt; 64 = ganz rechts) |
| SysEx `F0 00 00 66 14 12 <Offset> <ASCII…> F7` | Anzeige 2 × 55 Zeichen (Offset 0x00–0x37 oben, 0x38–0x6F unten) |

Die Zuordnung Pegel → Stufe ist **Sache des Rechners** (laut TouchMCU je Programm verschieden): OMP nimmt die Messskala des
Audiomischers (0–1) mal 12, gerundet, nie 0 bei hörbarem Signal.

### 2.3 SysEx-Kopf
`F0 00 00 66 <Gerät> <Befehl> …  F7`, Gerät `0x14` = Mackie Control, `0x15` = Erweiterung („XT“), `0x10`/`0x11` = Logic Control. OMP sendet
`0x14` (auch an Erweiterungen; ob Erweiterungen auf `0x15` bestehen, ist am Gerät zu prüfen).

### 2.4 Anmeldung
Das Pult fragt beim Einschalten (und auf `Device Query` `0x00`) mit `0x01` (7 Byte Seriennummer + 4 Byte Aufgabe). Der Rechner antwortet `0x02` mit
derselben Seriennummer und dem Antwortcode (`r0 = 0x7F & (c0 + (c1 ^ 0x0A) − c3)`, `r1 = 0x7F & ((c2 >> 4) ^ (c0 + c3))`,
`r2 = 0x7F & ((c3 − (c2 << 2)) ^ (c0 | c1))`, `r3 = 0x7F & (c1 − c2 + (0xF0 ^ (c3 << 4)))`). OMP sendet `Device Query` beim Start, beantwortet jede
Anmeldung und rechnet auch ohne sie weiter (viele USB-Pulte brauchen sie nicht). Zur Anmeldung gehört im Original eine Bestätigung `0x03`/Fehler
`0x04` **vom Pult**; OMP wertet sie nicht aus.

## 3. Verhalten (Pult-Logik)

* **Fader** → `channel.<id>.setGain` (`db`), dB nach der **Fader-Kennlinie** (OMP-Eigenlösung, keine Norm: stückweise linear in dB, −60 dB unten, 0 dB bei 75 %, +12 dB oben).
  Gedrosselt (50 ms je Kanal), der letzte Wert geht immer hinaus; Loslassen sendet sofort. Der gesetzte Wert wird bis zur Bestätigung des Mischers (höchstens 2 s) festgehalten, damit der Fader nicht zurückspringt.
* **Fahrfader** folgen Änderungen am Mischer (Operator, Szene, Automation); **unter dem Finger** wird nie gefahren (Berührungsmeldung). Meldungen eines Faders ohne Berührung gelten innerhalb 300 ms nach einer Fahrt als Echo.
* **Mute** → `setMute`, **Solo** → `setPfl` (Vorhören), **Select** wählt, **Rec-LED = On-Air** des Kanals (die Taste selbst tut nichts), **Drehgeber** → `setPan` (±5 % je Schritt, Druck = Mitte, Kranz zeigt die Stellung), **Name/Value** schaltet die untere Anzeigezeile zwischen Pegel und Pan.
* **Bank links/rechts** verschiebt um alle Kanalzüge aller Einheiten, **Kanal links/rechts** um 1. Ein Hauptpult (8 Züge) plus Erweiterungen zeigen aufeinanderfolgende Kanäle (Erweiterung 1 = Kanal 9–16 usw.). 7-Segment: Banknummer.
* **Master-Fader** (Strip 9 der ersten Einheit) führt – nur wenn gewählt – den Master eines **Aux-Bus** (`aux.<id>.setMaster`). Der Audiomischer hat keinen Hauptmaster-Pegel; ohne Ziel bleibt der Master-Fader ungenutzt.
* Alles, was die Logik nicht verbraucht (Transport, F-Tasten, Pfeile …), gibt es im Gateway als **NATS-Ereignis** (§6).

## 4. Generisches Profil

JSON, je Regler/Taste ein Eintrag (`docs/midi/profile-golden.json` zeigt alle Fälle):
`{ "id", "in": {type: cc|note|pitchbend, channel?, num?}, "mode": absolute|momentary|toggle|relative, "to": {node?, method, args?, arg?, min?, max?, step?, readParam?, onValue?, offValue?} }`.
`absolute` skaliert 0–127 (Pitchbend 0–16383) linear auf `min…max` in das Argument `arg`; `momentary` setzt `onValue`/`offValue` bei Druck/Loslassen (ohne `arg`: löst nur beim Drücken aus);
`toggle` schaltet bei jedem Druck um; `relative` (CC, Wert 64 = 0, 65 = +1, 63 = −1) liest `readParam`, addiert `Schritte × step`, klemmt auf `min/max` und schreibt. `node` ist der Anzeigename des Ziel-Nodes (leer = der gewählte Mischer). **Lernen:** die Oberfläche zeigt die nächste Bewegung am Gerät als Typ/Kanal/Nummer (Weg A: Knopf „Lernen“).

## 5. Netzwerk-MIDI (Weg B)

RTP-MIDI nach **RFC 6295** (Juni 2011; Befehlsabschnitt §3: Kopf mit B/J/Z/P-Flags, Delta-Zeiten §3.1, Laufstatus §3.2), Sitzungsverwaltung nach Apples
**„MIDI Network Driver Protocol“** (developer.apple.com; Pakete `IN`, `OK`, `NO`, `BY`, `CK`; Steuerport N, Datenport N+1; Uhr 10 kHz; Nutzlasttyp 0x61).
Die **Bytebreiten** der Sitzungspakete (Signatur `0xFFFF`, Version 2 als 4 Byte, Token/SSRC je 4 Byte, `CK`: Zähler + 3 Byte Füllung + 3 × 8 Byte) stehen im Apple-Text nur
in Bildern; sie sind dem Wireshark-Dissector `packet-applemidi.c` entnommen. Der Schleifentest (Hörer ↔ Einlader über 127.0.0.1) beweist nur Selbstverträglichkeit;
**Verträglichkeit mit macOS/rtpMIDI/Hardware ist nicht geprüft.**
Rollen: **Hörer** (`"listen": <Port>`) und **Einlader** (`"connect": "host:port"`). Abweichungen und Grenzen: kein Journal beim Senden (J = 0) und keine Wiederherstellung verlorener Pakete (Journale beim Empfang werden übersprungen),
kein segmentiertes SysEx, kein `RS` (Empfängerrückmeldung), keine Bonjour-Ankündigung (Hörer müssen am Gegenstück per Adresse eingetragen werden); Sitzung endet nach 90 s ohne Lebenszeichen der Gegenstelle (Apple: Uhrabgleich mindestens alle 60 s).

## 6. Node `omp-midi-gateway`

Parameter: `config` (lesen; JSON), `status`, `ports` (erkannte Rohgeräte), `recent`. Methoden: `setConfig(config)` (prüft und baut neu auf), `bank(delta)`, Simulator: `simulateTouch`, `simulateFader`, `simulatePress`, `simulateTurn`, `simulateLink`.
`config`: `{ "mixer": "<Anzeigename>", "masterAux": "<Aux-ID>", "mode": "mcu|profile", "units": [{"type":"raw","path":"/dev/snd/midiC1D0"} | {"type":"rtp","listen":5004} | {"type":"rtp","connect":"host:5004"} | {"type":"sim"}], "profile": {…} }` (höchstens 4 Einheiten; Rohgeräte nur unter `/dev/snd/midiC<n>D<m>`). Vorgabe aus `OMP_MIDI_CONFIG`; Sicherung/Wiederherstellung über `/state`.
NATS (`omp.midi.<node>.…`): `link` (`unit`, `name`, `up`), `button.<name>` (`down`; nur nicht verbrauchte Tasten) und im Profilmodus `control.<id>` — Auslöser für Workflows (Kap. 91). Kein Fernzugriff auf das Gerät ohne die üblichen Node-Rechte (Konfiguration wirkt wie „Operieren“).
**Rechte am Mischer:** wie bei der Studio-Logik schreibt der Node mit dem Service-Token seiner Instanz; dessen Bindung entsteht beim Start **innerhalb eines Workflows**. Als einzeln aus dem Katalog gestartete Instanz darf er den Mischer lesen, aber nicht bedienen (HTTP 403, Meldung im Status) — für einen Einzeltest vorübergehend eine Rollenbindung „operate“ der Instanz-ID auf den Mischer anlegen (Administration → Rechte).
**Rechte am Server:** der Prozess muss `/dev/snd/midiC*D*` lesen und schreiben dürfen (Gruppe `audio`).
