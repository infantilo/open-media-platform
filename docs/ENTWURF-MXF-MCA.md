# Entwurf: MXF-Mehrkanal-Audio-Labeling (SMPTE ST 377-4 / ST 377-41)

Stand 2026-10-07. Nutzerwunsch: „wir brauchen noch SMPTE 377-4 und 377-41“ —
**lesen im MXF-Player UND schreiben** (Recorder). Kein Beispiel-MXF mit MCA
vorhanden. Quellen (frei bei SMPTE): ST 377-4:2021, ST 377-41:2023,
ST 2067-8:2013 (Kanal-/Gruppenlabels), ST 428-12:2013 (Kanallabels L/R/C/…),
ST 377-1:2019 (Partitionen, Primer, Header-Metadaten). Keine Angabe stammt
aus dem Gedächtnis; die Tabellen unten sind aus den PDFs übernommen.

## 1. Was die Normen festlegen

**ST 377-4 (Framework).** Drei konkrete Unterklassen des abstrakten
`MCALabelSubDescriptor`, als SubDescriptors (`GenericDescriptor::SubDescriptors`,
Tag dyn, UL `06.0E.2B.34.01.01.01.09.06.01.01.04.06.10.00.00`) an den
(Wave/AES3)Audio-Descriptor des **File Package** gehängt:

| Klasse | Set-Key Byte 14/15 | Bedeutung |
|---|---|---|
| MCALabelSubDescriptor (abstrakt) | 01 6A | gemeinsame Items |
| AudioChannelLabelSubDescriptor | 01 6B | ein Audiokanal (Lautsprecher/Ziel) |
| SoundfieldGroupLabelSubDescriptor | 01 6C | Gruppe von Kanälen (z. B. 5.1) |
| GroupOfSoundfieldGroupsLabelSubDescriptor | 01 6D | gleichzeitig zu sendende Gruppen |

Set-Key (Tab. 1/2): `06 0E 2B 34 02 53 01 01 0D 01 01 01 01 01 <b15> 00` mit
b15 = 6A / 6B / 6C / 6D (Local Set, 2-Byte-Tags/2-Byte-Längen).

Items (alle Local Tags dynamisch → über den **Primer Pack** zuordnen):

| Item | Typ | UL (Bytes 9–16 nach `06.0E.2B.34.01.01.01.0E`) | Pflicht |
|---|---|---|---|
| MCA Label Dictionary ID | UL | 01.03.07.01.01.00.00.00 | ja |
| MCA Link ID | UUID | 01.03.07.01.05.00.00.00 | ja |
| MCA Tag Symbol | UTF-16 (2–8 alnum, Buchstabe vorn) | 01.03.07.01.02.00.00.00 | ja |
| MCA Tag Name | UTF-16 | 01.03.07.01.03.00.00.00 | nein |
| MCA Channel ID | UInt32 | 01.03.04.0A.00.00.00.00 | nein (bei Kanal-Label praktisch nötig) |
| RFC 5646 Spoken Language | ISO7 | Präfix `…01.01.01.0D`: 03.01.01.02.03.15.00.00 | nein |
| MCA Title / Title Version / Sub-Version / Episode | UTF-16 | 01.05.10 / 11 / 12 / 13 | nein |
| MCA Partition Kind / Number | UTF-16 | 01.04.01.05 / 06 | nein (paarweise) |
| MCA Audio Content Kind / Element Kind | UTF-16 | 03.02.01.02.20 / 21 | veraltet („soll nicht vorhanden sein“) |
| MCA Content | UTF-16 | 03.02.01.02.22 | nein (nur mit Use Class) |
| MCA Use Class | UTF-16 | 03.02.01.02.23 | nein (nur mit Content) |
| MCA Content Subtype | UTF-16 | 03.02.01.02.24 | nein |
| MCA Content Differentiator | UTF-16 | 03.02.01.02.25 | nein |
| MCA Spoken Language Attribute | ISO7 | 03.02.01.02.26 | nein |
| RFC 5646 Additional Spoken Languages | ISO7 | 03.02.01.02.27 | nein |
| MCA Additional Language Attributes | ISO7 | 03.02.01.02.28 | nein |
| SoundfieldGroupLinkID (nur Kanal-Label) | UUID | 01.03.07.01.06.00.00.00 | wenn Kanal in SG |
| GroupOfSoundfieldGroupsLinkID (nur SG-Label) | UUID-Array | 01.03.07.01.04.00.00.00 | wenn SG in GSG |

Regeln: Verknüpfung nur über MCA Link IDs, alle Labels im selben File
Package; ein Kanal gehört zu höchstens einer SG, eine SG zu beliebig vielen
GSG. **Vorrang:** Kanal-Wert > SG-Wert > GSG-Wert, fehlt ein optionales Item
und alle verknüpften Unterlabels haben denselben Wert, gilt dieser (§5.1.x.2).
Ein Kanal-Label ist über **MCA Channel ID** dem Audiokanal zugeordnet.
Textuelle Darstellung (Abschnitt 7) ist in der 2021er Fassung gestrichen.

**ST 377-41 (kontrolliertes Vokabular).** Nicht „Immersive“, sondern die
Werte-Listen für MCA-Items (Symbole sind maßgeblich):

* Partition Kind: `FL`, `REEL`, `ACT`, `PART` (FL ⇒ Number = 1).
* **MCA Content:** `PRM` Primary, `SAP` Second Audio Program, `HI` Hearing
  Impaired, `DV` Descriptive Video, `DX` Dialog, `MX` Music, `FX` Effects,
  `FFX` Filled Effects, `ME` Music&Effects, `OP` Optional M&E, `MESP` M&E mit
  Optional (GSG), `DME` (GSG), `NDME` (GSG), `PNAR` Program Narration, `ONAR`
  Optional Narration, `VO` Voice Over, `VI` Visually Impaired, `CM` Recorded
  Commentary, `LCM` Live Commentary, `MOS` Silence, `ADR`, `GRP`, `WLA`
  Walla, `CRD` Crowd, `VOC` Vocals, `FOL` Foley, `BG` Backgrounds, benutzerdef.
  `x-<1–4 Zeichen>`.
* **MCA Use Class:** `FCMP` Finished Composite, `ICMP` Intermediary
  Composite, `SMPL` Simplified, `SING` Singular — nur bestimmte Kombinationen
  mit Content erlaubt (Tab. 4/5; im Code als Prüftabelle).
* **Content Subtype:** `DIR`, `TECH`, `WRT`, `CAST`, `ANN`, `CTR`, `FS`,
  `PRP`, `CL`, `OTHER`.
* **Spoken Language Attribute / Additional Language Attributes:**
  `ORIGINAL`, `DUBBED` (je Zusatzsprache ein Eintrag, durch Leerraum getrennt).
* Abhängigkeiten: Content ⇔ Use Class (nur zusammen); Language Attribute nur
  mit Spoken Language; Additional Languages nur mit Spoken Language.

**Label-Dictionary-IDs (ULs der Kanäle/Gruppen)** stehen NICHT in 377-4/-41,
sondern in ST 428-12 (D-Cinema) und ST 2067-8 (IMF). Kanal-UL
`06.0E.2B.34.04.01.01.0D.03.02.01.{CH}.00.00.00.00` (428-12, Byte 12 = Kanal:
01 L, 02 R, 03 C, 04 LFE, 05 Ls, 06 Rs, 07 Lss, 08 Rss, 09 Lrs, 0A Rrs, 0B Lc,
0C Rc, 0D Cs, 0E HI, 0F VIN); ST 2067-8: Byte 12 = 20h, Byte 13/14 = Kanal
(01 M1, 02 M2, 03 Lt, 04 Rt, 05 Lst, 06 Rst, 07 S, 08.nn NSCnnn).
Soundfield Group (Byte 11 = 02, Byte 12 = Gruppe): 428-12: 01 „51“, 02 „71“,
03 „SDS“, 04 „61“, 05 „M“; 2067-8 (Byte 12 = 20h, Byte 13): 01 „ST“ Stereo,
02 „DM“, 03 „DNS“, 04 „30“, 05 „40“, 06 „50“, 07 „60“, 08 „70“, 09 „LtRt“,
0A „51EX“, 0B „HA“, 0C „VA“. Group of Soundfield Groups (Byte 11 = 03,
Byte 12 = 20h, Byte 13): 01 „MPg“, 02 „DVS“, 03 „Dcm“.

## 2. Umsetzung (Schritte, je einer pro Sitzung; Status in UMSETZUNG.md)

* **M1 — Bibliothek `omp-mxf-mca` (nur Lesen):** KLV-/Header-Metadaten-Parser
  (Partitionen, Primer, Sets), Modell (`McaLabels`), Auflösung der Vorrang-
  und Verknüpfungsregeln, Vokabular-/Validierungstabellen, Kanal→Track-Zuordnung
  per MCA Channel ID. Tests mit synthetisch aufgebauten Bytes (Builder im Test).
* **M2 — Schreiben (Injektor):** Labels in eine bestehende OP1a/OPAtom-Datei
  einfügen (Header-Metadaten neu schreiben, Partition-Offsets/RIP korrigieren,
  Essence unangetastet). Prüfung: Datei von `ffmpeg` erzeugen, injizieren,
  danach `ffprobe`/`mxfdemux` müssen sie weiter lesen und M1 die Labels
  zurückliefern (Round-Trip).
* **M3 — MXF-Player:** Labels beim Laden lesen, in die Audio-Regeln als Tags
  übersetzen (`lang:`, `role:` aus Content/Use Class, `ch:`), Vorrang vor dem
  Spurschema; Anzeige im Panel.
* **M4 — Recorder:** MXF-Ausgabe (`mxfmux`) und Labels aus der Konfiguration
  (Flow-Tags/Audio-Regeln → Kanal-/Gruppen-/GSG-Labels) per Injektor schreiben.
* **M5 — UI/Handbuch/Katalog.**

## 3. Offene Punkte / Risiken

* Es gibt **kein echtes MXF mit MCA** zum Gegenprüfen; Verifikation nur gegen
  den Normtext, Round-Trip und die Weiterlesbarkeit durch ffmpeg/GStreamer.
  Sobald der Nutzer eine echte Datei hat (z. B. aus IMF/Netflix), als
  Regressionstest aufnehmen.
* GStreamers `mxfdemux` und ffmpeg 5.1 liefern die Labels nicht verwertbar →
  eigener Parser nötig (begründet: Minimal-Dependency-Regel, keine passende
  Bibliothek im Workspace).
* `mxfmux` schreibt keine MCA-Sub-Descriptors; deshalb der Injektor (M2).
