# Gebärdensprache aus Untertiteln (Konzept)

Stand 2026-10-29, **nur Konzept, noch kein Code.** Ziel: ein Node, der aus dem Untertitel-Datenstrom (`omp-subtitle-asr`) mit minimalen
Ressourcen einen Gebärdensprach-Avatar (DGS) als Fill+Key-MXL-Video erzeugt, das der Bildmischer als Bild-in-Bild einblendet.

## 1. Grenzen (ehrlich)

- Gebärdensprache ist keine Wort-für-Wort-Übersetzung. Die DGS hat eine eigene Grammatik (Raum, Mimik, Mundbild, Satzstellung).
- Automatische Übersetzung plus Avatar ist Forschungsstand und für Gehörlose spürbar schlechter verständlich als ein menschlicher
  Dolmetscher. Der Node ist ein **Zusatzangebot, klar als „automatisch“ gekennzeichnet**, kein Ersatz für Dolmetscher.
- Live kommt Verzögerung dazu: Untertitel brauchen schon einige Sekunden; der Avatar braucht den ganzen Satz. Rechnen mit 5–10 s zusätzlich.

## 2. Aufbau des Nodes `omp-sign-avatar`

```
Untertitel-Datenstrom (MXL, SubtitleInput) 
  → Satzbildung            (Satzende / Zeitlücke, wie die Abschnitte der Spracherkennung)
  → Text → Glossen         (regelbasiert, „NLP-light“, s. 3)
  → Glossen → Animation    (Lexikon aus Gelenk-Keyframes, Übergänge, Fingeralphabet als Rückfall, s. 4)
  → Software-Rasterizer    (Avatar mit Skelett, s. 5)
  → Fill + Key (MXL, Alpha direkt aus dem Rasterizer), nur bei Leser
```

Parameter (Entwurf): Eingang, Sprache, Avatar, Größe/Ausschnitt, Gebärdentempo, „Zeige Satz-Text“ (Kontrolle), Zustand
(Warteschlange, aktuelle Glossen, Verzögerung).

## 3. Text → Glossen („NLP-light“)

**Stand der Technik zum Wiederverwenden:** Es gibt offene Forschungs-Pipelines (Lemmatisierung, Wort-Umordnung, neuronale Übersetzung),
auch mit DGS-Daten. Sie sind für uns **nicht nutzbar**:
- Die gefundenen DGS-Repositories stehen unter GPL-3.0; der Code dürfte nicht in unser Apache-2.0-Projekt gelinkt werden.
- Die DGS-Korpusdaten sind auf Sprachforschung beschränkt; die Demo-Pipeline einer bekannten Übersetzungs-Demo steht unter einer
  nicht-kommerziellen Lizenz (CC BY-NC-SA).
- Neuronale Modelle sind rechenintensiv (gegen „minimale Ressourcen“) und hängen an genau diesen Daten.
- Gefunden wurde **keine** Apache-/MIT-lizenzierte DGS-Text-zu-Glossen-Lösung. Jede Quelle ist vor Nutzung selbst zu prüfen
  (LICENSE-Datei), die Suchergebnisse allein genügen nicht.

**Eigener regelbasierter Ansatz (klein, deterministisch, nachvollziehbar):**
1. Satz zerlegen (Interpunktion, Zahlen, Eigennamen erkennen).
2. **Grundform bilden** (Lemma): kleine eigene Wortliste „Wortform → Grundform“ für den Lexikon-Wortschatz; unbekannte Wörter bleiben
   unverändert. Ein vollständiges Lemma-Wörterbuch ist nicht nötig, weil nur Wörter mit vorhandener Gebärde zählen.
3. **Regeln** (Entwurf, von Gehörlosen-Fachleuten zu prüfen): Artikel, Hilfsverben und viele Präpositionen entfallen; Zeitangaben
   zuerst; Verb nach Objekt; Verneinung nach dem Verb; Fragewort am Satzende; Zahlen als Zahlgebärde; Mehrzahl optional durch Wiederholung.
4. **Nichtmanuelle Marker** pro Glosse/Satz: Fragemimik, Verneinungskopfschütteln, Brauen (Parameter an der Animation).
5. **Rückfall:** Eigennamen und unbekannte Wörter werden **buchstabiert** (Fingeralphabet). Ist ein Satz zu mehr als einem einstellbaren
   Anteil unbekannt, wird er nicht gebärdet, sondern als Text eingeblendet (kein Raten).

Die Regeln liegen als Datei (zum Beispiel JSON/TOML) neben dem Lexikon, damit Fachleute sie ändern können, ohne Code anzufassen.

## 4. Lexikon (Daten sind der Engpass)

- Eine Gebärde ist eine kurze Folge von **Gelenkdrehungen** (Arme, Hände, Finger, Kopf) plus Gesichtswerte (Brauen, Mund, Augen).
- Das Lexikon ist unser eigenes Datenformat; die Übergänge (Verschmelzung am Ende/Anfang zweier Gebärden) rechnet der Node.
- **Herkunft:** Aufnahmen mit gehörlosen Gebärdenden, vertraglich mit Rechten für uns (frei nutzbar im Produkt). Aus dem Video entstehen
  **offline** Gelenkdaten; das dafür verwendete Schätzverfahren muss eine erlaubende Lizenz haben, es läuft nur im Werkzeug, nicht im Node.
- Fremde Korpora (Forschungslizenz) werden nicht im Produkt verwendet.
- Phase 1 braucht nur Fingeralphabet und wenige Handformen, die wir selbst modellieren (keine Aufnahmen).

## 5. Software-Rasterizer (Avatar)

- Reines Rust auf der CPU: kein Browser, keine GPU, keine Treiber, ein sehr kleines Container-Image.
- Avatar: Oberkörper mit Kopf und beiden Händen, einige Tausend Dreiecke, Skelett mit Skinning, flache/Toon-Schattierung,
  Gesicht mit einfachen Formen (Brauen, Mund, Augen). Modell wird **selbst erstellt** (keine fremde Lizenz).
- Ausgabe etwa 480×540, 25 Bilder/s, BGRA mit Alpha aus dem Rasterizer; Wandlung nach v210 und MXL-Ausgang wie in `omp-ograf`.
- Nur bei Leser rendern (wie die anderen gesteuerten Ausgänge), sonst CPU nahe null.
- Erwartete Last: ein kleiner Bruchteil eines Kerns (**Schätzung, in Phase 1 zu messen**).
- Abhängigkeiten nur mit Apache/MIT/BSD; Lizenzen in `THIRD-PARTY-NOTICES.md` eintragen.

## 6. Risiken

- **Lesbarkeit** im kleinen Bild-in-Bild: Hände und Gesicht müssen groß und kontrastreich genug sein (Ausschnitt oben, Hintergrundfläche
  oder Umrandung optional).
- **Übersetzungsqualität:** hängt an den Regeln und am Lexikon; ohne Fachleute aus der Gebärdensprach-Gemeinschaft nicht belastbar.
- **Lexikongröße:** Aufnahmen sind der größte Kostenpunkt; ohne sie bleibt es bei Fingeralphabet und sehr kleinem Wortschatz.
- **Lizenzen:** vor jedem Zukauf/Import prüfen; nichts aus Forschungs- oder GPL-Quellen übernehmen.

## 7. Phase 1 — Spike (ohne Übersetzung, ohne Aufnahmen)

Ziel: Machbarkeit von Rendering und Ausgang messen, bevor in Daten und Regeln investiert wird.

1. **Crate `omp-sign-avatar`** (Node-Rahmen nach `omp-ograf`/`omp-subtitle-asr`): Registrierung, Fill+Key-MXL-Sender, Leser-gesteuerter Ausgang.
2. **Rasterizer** (`raster.rs`): Dreiecke mit Z-Puffer, Skinning (Gelenkmatrizen), Flat/Toon-Schattierung, Alpha; Unit-Tests mit
   bekannten Bildern (Dreieck, Verdeckung, Alpha-Rand).
3. **Avatar** (eingebettetes, selbst erstelltes Modell: Oberkörper, Kopf, Hände mit Fingergelenken) und ein festes **Fingeralphabet** A–Z
   plus Ziffern als handgemachte Posen.
4. **Wiedergabe** (`player.rs`): Posen-Folge mit weicher Überblendung; Parameter `text` buchstabiert den Satz (nur zum Testen), Tempo einstellbar.
5. **Messung:** CPU/RAM je Kachelgröße (480×540, 360×405), Bildrate, Lesbarkeit in der Mischer-PiP-Anzeige (Sichtprüfung durch den Nutzer).
6. **Abbruchkriterium:** Brauchen 25 Bilder/s bei 480×540 mehr als ein vereinbarter Anteil eines Kernes (Vorschlag: 15 %), wird die
   Auflösung oder die Dreieckszahl gesenkt, bevor weitergebaut wird.

Nicht Teil von Phase 1: Untertitel-Eingang, Glossen-Regeln, Lexikon-Aufnahmen, Mimik-Grammatik, Container-Paket, Handbuch.

## 7a. Phase 1 — Ergebnis (2026-10-29)

Umgesetzt in `nodes/omp-sign-avatar` (Rasterizer, Avatar, Fingeralphabet, Wiedergabe, Fill+Key-Ausgang). Reines Rust ohne
Fremdabhängigkeiten (nur GStreamer/MXL im Ausgaberahmen, wie die übrigen Nodes); `THIRD-PARTY-NOTICES.md` unverändert.

- **Rasterizer:** Z-Puffer, flache Toon-Schattierung, 2×2-Überabtastung (Alpha = Deckungsgrad), zeilenweise Spannen, nur geänderte
  Zeilen werden gelöscht/aufgelöst. Skinning ist in Phase 1 **starr** (jedes Teil an einem Knochen, Gelenke überlappen) — weiches
  Skinning erst, wenn die Lesbarkeit es verlangt.
- **Modell:** ca. 1300 Dreiecke, selbst erstellt (prozedural im Code), Hände 1,5-fach vergrößert für die Lesbarkeit im kleinen Bild.
- **Fingeralphabet A–Z, Ziffern 0–9:** Näherung aus Beschreibungen, **nicht von Gebärdenden geprüft** (§6). J/Z nur als Handform mit
  Handgelenk-Schwung, Ä/Ö/Ü als doppelter Grundbuchstabe, SCH/ß vereinfacht.
- **Ausgang:** zwei MXL-Flows (Fill BGRA→v210, Key GRAY8→v210), 25 Bilder/s; neu gezeichnet wird nur bei geänderter Haltung und
  nur, solange ein Leser den Flow liest (`gate_on_consumers`). Parameter `text`, `speed`, `loop`; Methoden `speak`, `stop`;
  Umgebung `OMP_SIGN_WIDTH/HEIGHT/SS` (Standard 480×540, SS=2).
- **Messung** (Dev-Rechner, mit anderer Last, nice; ein Kern = 100 %):

| Aufbau | Last |
|---|---|
| nur Rendern, 480×540, SS=2, Buchstabieren (Bench `--bench`) | ≈ 6 % (Roh ohne Haltungs-Cache: ≈ 17 %, 7 ms je Bild) |
| nur Rendern, 360×405, SS=2 | ≈ 3,5 % |
| ganzer Node, 480×540, SS=2, Leser aktiv, Dauerbewegung | ≈ 31 % (Wandlung nach v210 und MXL-Schreiben für zwei Flows inklusive) |
| ganzer Node, 360×405, SS=2, Leser aktiv | ≈ 7–11 % |

  Schlechtester Einzelbild-Renderaufwand 12–22 ms (< 40 ms Bildzeit). Das Abbruchkriterium (15 % eines Kerns für das **Rendern**)
  ist erfüllt; die Gesamtlast des Nodes wird von Wandlung und Ausgang bestimmt, nicht vom Rasterizer. **Empfehlung:** 360×405 als
  Standard fürs Bild-in-Bild, 480×540 nur wenn nötig.
- **Offen für den Nutzer:** Sichtprüfung der Lesbarkeit in der Mischer-PiP-Anzeige (Handformen, Größe), Entscheidung zu den Fragen in §9.
- Prüfwerkzeuge: `omp-sign-avatar --dump x.png --letter K` (Einzelbild), `--bench`, ignorierter Test `flow_probe` (liest den
  Key-Flow eines laufenden Nodes und schreibt ihn als PNG).

## 7b. Phase 2 — Stand (2026-10-29)

Entscheidung des Nutzers: gleich auf **Produktivqualität** hin bauen (kein Wegwerf-Demonstrator). Umgesetzt ist alles, was **ohne Aufnahmen** möglich ist:

- **Untertitel-Eingang:** Empfänger „Untertitel“ (`video/smpte291`, Text-Strom oder CEA-608) über denselben `SubtitleInput` wie Viewer/Multiviewer.
- **Lexikon als Daten** (`lexicon.rs`): JSON, Gebärde = Folge von Schlüsselhaltungen (Arme, Handform aus dem Fingeralphabet oder frei, Kopf); strenge Prüfung mit Fehlerpfad; `verified`-Pflicht (nicht freigegebene Einträge gelten als unbekannt). Prüfwerkzeug mit Kontaktbogen für Fachleute.
- **Regeln als Datei** (`rules.rs`): Sätze, Füllwörter, Zeit vorn, Verb hinten, Verneinung, Fragewort, Zahlen, Rückfallschwelle; getestet.
- **Engine** (`engine.rs`): Warteschlange, Verzugsmessung, Aufholen (schneller ab ¼/½ des Höchstverzugs), Verwerfen alter Sätze, Kopfschütteln (Verneinung) und Frage-Kopfhaltung, Text-Rückfall im Bild.
- **Panel-Zustand:** Warteschlange, Verzug, verworfen, gebärdet, als Text, letzte Glossen, Anteil unbekannt.
- **Produktiv-Rahmen:** Katalogeintrag, Instanz-Optionen (Größe klein/mittel/groß, Hintergrundkarte, Überabtastung, Lexikon, Regeln, Höchstverzug), Handbuch. Die Größe auf dem Sendebild stellt der Mischer (PIP-Box/-Preset) — der Avatar muss dafür nichts können.

**Noch nicht möglich, bewusst nicht vorgetäuscht:** ein **freigegebenes Lexikon** (braucht Aufnahmen/Mitarbeit von Gebärdenden — mit dem mitgelieferten Beispiel läuft alles über Buchstabieren/Text), **geprüfte Regeln** und ein **geprüftes Fingeralphabet**. Nicht manuelle Marker außer Kopf (Brauen/Mund) und weiches Skinning folgen mit den echten Daten (Phase 3).
Test am echten Ausgang: Satz mit Beispiel-Lexikon gebärdet (`translate`), überwiegend unbekannter Satz erscheint als Text im Fill-Flow (geprüft am MXL-Ausgang).

## 7c. Warum der Avatar nicht gebärdet, und die Datenfrage (2026-10-30)

**Befund:** Der ANC-Weg ist in Ordnung. Ein Test über echtes MXL (`outputs.rs`, `subtitle_input_reads_both_outputs_of_the_node`) schickt Text-Strom und CEA-608-Strom des Untertitel-Nodes in den Untertitel-Eingang; beide liefern den Text. Der Avatar „reagiert“ trotzdem nicht, weil das Lexikon leer bzw. nur mit nicht freigegebenen Einträgen gefüllt ist: Jedes Wort ist unbekannt, die Unbekannt-Quote liegt über `maxUnknownRatio` (0,5), der Satz fällt auf den Rückfall — bisher nur Text-Einblendung, keine Handbewegung.

**Rückfall wählbar (Option `OMP_SIGN_FALLBACK`, Parameter `fallback`):** `text` (Standard, wie bisher) oder `spell` — der Satz wird mit dem Fingeralphabet buchstabiert, der Text bleibt zur Kontrolle sichtbar. Das ist die ehrliche Lösung ohne Daten: Der Avatar bewegt sich, ohne dass erfundene Gebärden gezeigt werden. Das Fingeralphabet ist noch nicht von Gebärdenden geprüft (s. 7b); Buchstabieren ganzer Sätze ist langsam und für Gehörlose schwer lesbar, es bleibt eine Notlösung (Namen, einzelne Begriffe).

**Datenquellen, geprüft (Stand 2026-10-30) — keine ist für ein Produkt frei nutzbar:**

| Quelle | Inhalt | Lizenz | Nutzbar? |
|---|---|---|---|
| SignAvatars (ECCV 2024) | 3D-Bewegungsdaten (u. a. DGS) | CC BY-NC-SA, Nutzung nur auf Anfrage für Forschung; Lizenzanfrage an die Autoren | nein (nicht kommerziell); Rückfrage bei den Rechteinhabern möglich |
| DGS-Korpus (Hamburg) | Videos, Annotationen | CC BY-NC / Forschungslizenz | nein |
| Dicta-Sign | mehrsprachiges Lexikon | CC BY-NC-ND 4.0 | nein |
| 3DZSignDB (Algerisch), tschechische Mocap-Korpora | SiGML bzw. Mocap | CC BY-NC | nein, falsche Sprache |
| Sign-Language-Mocap-Archive (Studio Galt) | Mocap | CC0 | Lizenz ja, aber überwiegend amerikanische Gebärdensprache — für DGS unbrauchbar |
| MMS Player | Wiedergabe-Software | GPL-3.0 | nicht einbindbar (Apache-2.0-Projekt) |
| HamNoSys / SiGML / JASigning | Notation und Player | nicht geprüft | offen |

**Konsequenz:** Ein frei lizenziertes DGS-Lexikon mit Bewegungsdaten gibt es nach dieser Recherche nicht. Es bleiben drei Wege, die sich ergänzen:

1. **Lizenz anfragen** bei den Rechteinhabern (SignAvatars-Autoren, DGS-Korpus) für den kommerziellen Einsatz; Daten wären Bewegungsdaten eines fremden Skeletts und müssten auf unser Skelett umgesetzt werden (Retargeting-Werkzeug nötig).
2. **Eigenes Lexikon mit Gebärdenden** (Aufnahmen oder Authoring am Avatar), Freigabe `verified` durch Gebärdende. Aus Videos lassen sich Handhaltungen offline mit einem Apache-lizenzierten Schätzverfahren gewinnen; der Node selbst bleibt ohne Schätzer.
3. **Bis dahin:** Rückfall `spell` für Namen/Fachbegriffe plus Text-Einblendung.

Die Entscheidung zwischen 1 und 2 (und ob ein Authoring-Editor gebaut wird) liegt beim Nutzer.

## 8. Weitere Phasen (Entwurf)

- **Phase 2:** Untertitel-Eingang, Satzbildung, Glossen-Regeln (s. 3) mit Fachleuten, kleines Lexikon (≈100 Gebärden) aus Aufnahmen.
- **Phase 3:** Nichtmanuelle Marker, größeres Lexikon, Rückfall-Logik, Anzeige „automatisch“ im Bild.
- **Phase 4:** Container-Paket, Handbuch, Katalogeintrag, Diagnose (Warteschlange, Verzögerung).

## 9. Offene Fragen an den Nutzer

- Zweck: Demonstrator oder Produktivangebot?
- Können Gebärdende für Aufnahmen und für die Prüfung der Regeln gewonnen werden?
- Welche Auflösung/Position für das Bild-in-Bild (Standard 480×540 rechts unten)?
