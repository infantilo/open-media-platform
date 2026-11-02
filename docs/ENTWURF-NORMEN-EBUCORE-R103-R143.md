# Entwurf: Normen statt Eigenwege — EBUCore, R 103, R 143 (Kapitel 78)

Stand 2026-11-02. Nutzerauftrag: Normen der EBU prüfen, alles bis auf
objektbasiertes Audio (NGA/ADM) ausarbeiten und umsetzen. **Grundsatz:**
wo eine Norm existiert, wird sie erfüllt statt einen eigenen Weg zu gehen,
und die Norm wird in der Doku genannt (Nummer, Version, Abschnitt).

## 0. Was geprüft wurde — und was nicht belegt ist

Gegen die Originaldokumente gelesen (Download 2026-11-02, EBU):

| Norm | Version | Geprüft | Ergebnis |
|---|---|---|---|
| **EBU Tech 3293** (EBUCore) | 1.10, April 2020; XSD 1.10.1 | Spezifikation + offizielles XSD (`urn:ebu:metadata-schema:ebucore`) | umsetzen (Kap. 78.1/78.2) |
| **EBU R 103** | **3.0, Mai 2020** | Volltext | umsetzen (78.3/78.4) |
| **EBU R 143** | **3.0, März 2025** | Volltext (8 Seiten, Anhänge A–C) | Konformitätstabelle (78.5) |
| EBU Tech 3364 / ITU-R BS.2076 (ADM) | — | nur Querverweis in Tech 3293 | **ausgenommen** (Nutzerentscheidung) |

**Nicht belegt, deshalb nicht umgesetzt und nicht zitiert:** Tech 3325,
Tech 3345, Tech 3371, Tech 3373, Tech 3379, Tech 3392 — Nummer und Titel
ließen sich nicht bestätigen (Auszug aus einem KI-Text, nicht aus EBU-Quellen).
Wer sie für relevant hält, nennt bitte die EBU-Seite; dann wird nachgetragen.
Zu FIMS: nur als Konzept (Aufträge an Medien-Dienste mit Qualitätsprüfung)
relevant — OMP deckt das bereits mit dem Prozess-/Auftragssystem ab, keine
eigene Norm-Schicht nötig.

**Korrektur gegenüber dem Gespräch:** die in Umlauf befindlichen Zahlen
„RGB −5 % … 105 %“ stammen aus R 103 **v1.1**. Gültig ist v3.0 mit
Codewerten je Bittiefe (siehe 78.3).

## 1. Asset-Metadaten: Feld-Registry + EBUCore (78.1, 78.2)

### Ausgangslage
`asset.Metadata` hat sechs freie Blöcke (`system`, `technical`,
`descriptive`, `editorial`, `custom`, `ai`) als `map[string]any`.
Dynamische Felder gehen also, aber ohne Typ, Beschriftung, Pflicht,
Auswahlliste — und ohne Bezug zu einer Norm.

### Entscheidung
- **Das Speichermodell bleibt** (JSONB je Asset). Neu ist eine
  **Feld-Registry** (`asset_metadata_fields`): welche Felder gibt es je
  Asset-Typ, mit Typ, Beschriftung, Pflicht, Mehrfachwerten, Auswahlliste
  und optionalem **EBUCore-Ziel**.
- **Dynamisch:** Felder legt ein Administrator zur Laufzeit an (API + UI),
  ohne Neustart und ohne Migration. Schlüssel, die nicht in der Registry
  stehen, bleiben erlaubt (freie Felder, wie bisher) — sie werden nicht
  validiert und beim Export als generische Attribute weitergegeben.
- **Validierung** nur für registrierte Felder, nur im API-Pfad
  (`PUT /assets/{id}/metadata`); interne Schreiber (Ingest, Untertitel,
  Review) bleiben unberührt.
- **EBUCore ist die Austauschsprache**, nicht das Speichermodell. Grund:
  EBUCore ist ein Austauschformat und selbst erweiterbar (`typeLabel`,
  `technicalAttribute*`, eigene Namensräume), deckt aber nicht jedes interne
  Feld ab; ein Zwangs-Schema würde die dynamischen Felder aushebeln.
- Quelle der Struktur: Tech 3293 v1.10 §3 und `ebucore.xsd` 1.10.1.

### Abbildung (Export, `Format=EBUCore XML`)
| OMP | EBUCore |
|---|---|
| `Asset.Title` | `title/dc:title` |
| `Asset.Description` | `description/dc:description` |
| `Asset.ID` | `identifier/dc:identifier` (`typeLabel="OMP"`) |
| `Asset.CreatedAt` | `date/created@date`, `@time` |
| `Asset.Type` | `type/dc:type` |
| Ziel `alternativeTitle` | `alternativeTitle/dc:title` (`typeLabel` = Feldbeschriftung) |
| Ziel `description` | `description@typeLabel` (DPP-Muster, Tech 3293 §3.19) |
| Ziel `subject` | `subject/dc:subject` |
| Ziel `language` | `language/dc:language` |
| Ziel `genre` | `type/genre@typeDefinition` |
| Ziel `creator`, `contributor`, `publisher` | `…/contactDetails/name` bzw. `organisationDetails/organisationName` + `role` |
| Representation (Breite, Höhe, Bildrate, Codec, Kanäle, Abtastrate, Bitrate, Größe, Prüfsumme, Ort) | `format/videoFormat`, `audioFormat`, `containerFormat`, `fileSize`, `locator` |
| Feld ohne Ziel | `technicalAttributeString/-Integer/-Boolean@typeLabel` bzw. `description@typeLabel` |

Jede Ausgabe wird im Test **gegen das offizielle XSD** geprüft.

### Import
`POST /assets/{id}/ebucore` nimmt EBUCore-XML, überträgt die bekannten
Elemente (Umkehrung der Tabelle) in die Metadaten und legt unbekannte
`typeLabel`-Attribute als freie Felder ab. Vorschau vor dem Schreiben
(`?dryRun=1`).

### Kopplung an ein großes MAM
Austauschformat ist EBUCore (XML). Für ein konkretes System fehlt die
Gegenseite: Schnittstellenbeschreibung, Test-Zugang. Bis dahin liefern wir:
Export/Import je Asset, Sammel-Export, und einen **Ausgangs-Webhook** mit
dem EBUCore-Dokument beim Wechsel auf `published` (über die bestehende
Outbox, B9). Ein herstellerspezifischer Konnektor wird erst mit
dokumentierter Gegenseite gebaut; Hersteller-/Produktnamen kommen nicht in
Code oder Doku (Projektregel).

## 2. R 103 v3.0 — Bildpegel-Toleranz (78.3 live, 78.4 Datei)

Normtext (R 103 v3.0, Annex 1):
- **Bevorzugter Bereich** („Preferred Min/Max“) je Bittiefe:
  8 Bit 5–246 · 10 Bit 20–984 · 12 Bit 80–3936 · 16 Bit 1280–62976.
  Nenn-Videobereich 16–235 / 64–940 / 256–3760 / 4096–60160;
  Gesamtbereich 1–254 / 4–1019 / 16–4079 / 256–65279.
- Werte der **Komponenten R, G, B und der Luminanz Y** außerhalb des
  bevorzugten Bereichs = **Gamut-Fehler**.
- Alarm („Out-of-Gamut“) **erst, wenn der Fehler 1 % des Bildes
  überschreitet**; Bereiche außerhalb des aktiven Bildes sind auszunehmen.
- Messung mit **Filter** (vorher): horizontal 1/16·(1,2,3,4,3,2,1),
  vertikal ¼·(1,2,1) (bei Halbbildern innerhalb des Halbbilds).
- Gilt für SDR und HDR (PQ/HLG) im gleichen Container.
- R 103 empfiehlt *Messen und Beurteilen*, nicht automatisches Legalisieren
  („Legalizer mit Vorsicht“) — OMP korrigiert nichts.

Umsetzung 78.3 (`omp-scope`): bisher misst `qc.rs` auf einem herunterge-
rechneten Luma-Bild. Gamut braucht RGB und den Flächenanteil. Es kommt eine
zusätzliche Messung auf dem (R-103-gefilterten) RGB-Analysebild; Ausgabe:
Anteil je Komponente außerhalb, Flächenanteil gesamt, Alarm mit Haltezeit
bei > 1 %. Bittiefe 8 Bit zuerst (Analysebild), Tabelle für alle Tiefen.
Umsetzung 78.4 (Datei-QC): derselbe Kern als zusätzliche Prüfung im
Eingangs-QC, Ergebnis im Prüfbericht.

**Nicht Teil dieses Kapitels:** HDR-Falschfarbendarstellung (Leuchtdichte in
Nit). OMP hat keinen HDR-Pfad (kein PQ/HLG-Erkennen, kein HDR-Preview);
ohne den wäre die Anzeige geraten. Als eigener Schritt vormerken, sobald
HDR-Quellen im Betrieb sind.

## 3. R 143 v3.0 — Cybersecurity (78.5)

R 143 richtet sich an **Hersteller** („media vendors’ systems, software &
services“); der Betreiber nutzt es in Ausschreibungen. Für OMP bedeutet das:
wir können die dazugehörige **Security Controls Assertation** (xlsx, drei
Arbeitsblätter) ehrlich ausfüllen. Gliederung Anhang A: IS (Vendor-ISMS),
OS (Betriebssicherheit), SD (Entwicklung), IM (Incident-Management),
PS (physisch), CS (Cloud), BC (Betriebskontinuität), CM (Änderungen),
SC (Lieferkette), AA (Authentisierung/Autorisierung), DO (Doku), NE
(Netzwerk), EN (Verschlüsselung), BA (Basiskonfiguration), AP (Anwendung),
MR (Überwachung), DI (Daten/Rechte), NI (Netzinfrastruktur). Prioritäten
P1 (kritisch) / P2 (wichtig) / P3 (Best Practice).

Ergebnis 78.5: `docs/R143-KONFORMITAET.md` — je Kontrolle: Stand in OMP
(erfüllt / teilweise / offen / nicht zutreffend, weil Organisations- statt
Produktthema), Fundstelle im Code/Handbuch, Lücke. **Keine Selbsterklärung
ohne Beleg**; offene P1-Punkte werden mit den Audit-Funden
(`AUDIT_2026_10_23.md`) abgeglichen, nicht neu erfunden.

## 4. Schritte

| Schritt | Inhalt | Verifikation |
|---|---|---|
| 78.1 | Feld-Registry (Tabelle, Store, API, Validierung), Standardfelder mit EBUCore-Ziel | Store-/Handler-Tests; Golden-Routentabelle |
| 78.2 | EBUCore-Export/-Import je Asset, XSD-Prüfung im Test | Test mit `libxml2`-Validierung gegen `ebucore.xsd` 1.10.1 |
| 78.3 | R 103 in `omp-scope` (RGB, Filter, 1 %-Regel, Alarm) | Rust-Tests mit synthetischen Bildern; Live-Probe mit Testmuster |
| 78.4 | R 103 in der Datei-QC | Test mit präparierter Datei |
| 78.5 | R-143-Konformitätstabelle | Durchsicht gegen Code, Stichproben |
| 78.6 | UI: Feld-Verwaltung + Export/Import im Asset-Fenster | Browser-Klicktest |
| später | Webhook/Konnektor zum externen MAM (Gegenseite fehlt); HDR-Anzeige | — |

## 5. Quellen
- EBU Tech 3293 v1.10 (April 2020) und `ebucore.xsd` 1.10.1,
  <https://tech.ebu.ch/publications/tech3293>
- EBU R 103 v3.0 (Mai 2020), <https://tech.ebu.ch/publications/r103>
- EBU R 143 v3.0 (März 2025), <https://tech.ebu.ch/publications/r143>
