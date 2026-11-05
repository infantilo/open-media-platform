# Auftrag an Opus: Lückenanalyse und Plan für professionellen Radiobetrieb in der OpenMediaPlatform

## Kontext

Lies zuerst `CLAUDE.md`, `ARCHITECTURE.md`, `UMSETZUNG.md` (besonders §0, Kap. 27 Playout-Automation und Kap. 39 Playout-Buffer), `docs/PLAYOUT-AUTOMATION.md`, `docs/HANDBUCH.md` §9, `deploy/catalog.json` und `nodes/`. Die Plattform bildet TV-Playout aus kleinen, unabhängigen Nodes. Die Nodes sind über MXL und NMOS verkabelt. Dazu gehören Quellen, Mixer, Buffer, Recorder, Scheduler und Automation. Radio soll nach demselben Prinzip entstehen. Es soll weder ein Radio-Monolith werden noch ein TV-Node mit Radio-Schalter. Lies die Architektur selbst und stütze dich nicht auf diese Kurzfassung.

## Ziel

Eine Analyse und ein Plan für das, was bis zu einem professionellen, kreativen und zukunftsorientierten Radiobetrieb fehlt. Das gilt für Abwicklung (Sendung) und für Aufnahmen (Produktion, Mitschnitt, Archiv). Der Maßstab ist ein modernes Sendezentrum auf Rundfunkniveau, das über reinen Musik-Automationsbetrieb hinausgeht.

## Fragen

1. **Bestandsaufnahme.** Was von dem, was Radio braucht, trägt die Plattform schon (Audio-Mixer, Recorder, Scheduler, Playout-Automation, Intercom, Ingest/QC, Untertitel/ASR, SCTE/ANC, Cluster/HA)? Was ist mit wenig Aufwand nutzbar? Was passt konzeptionell nicht, und warum?
2. **Sendeablauf.** Was fehlt für Musikrotation und Sendeuhr (Clock/Format-Wheel), Regelwerk (Separation, Rotation, Quoten, Tageszeiten), Jingles, Sweeper, Moderationsbetten, Nachrichten, Verkehr und Wetter, Werbung und Spotblöcke, Netzschaltungen und Fensterprogramme? Wie sehen Segue, Übergangs- und Overlap-Logik aus (Intro-/Outro-Marker, Hook, Ramp, Cue-Punkte, Crossfade-Kurven, Ducking)? Wie verhält sich ein Voicetrack-Modell?
3. **Live-Betrieb im Studio.** Was braucht ein Moderationsplatz? Dazu zählen Fader-Panel und Hardware-Controller, Mikrofonlogik, Talkback, Telefonhybride, Gäste und Remote-Zuspielung (SIP, WebRTC, SRT, ISDN-Ablösung), Cough/Dump/Delay, Sendeampel und Mikrofon-Auf-Logik, Studio-Umschaltung und Studio-Übergabe. Wie wird das zum Node-Verbund, ohne einen Allround-Mixer zu bauen?
4. **Audio-Qualität und Normen.** Welche Anforderungen bestehen an Lautheit und Pegel (EBU R 128, True Peak), Loudness-Steuerung und Prozessierung (Multiband-Prozessor als Node?), Silence/Dead-Air-Erkennung, Notfall-Fallback (Notfall-Playlist, Satellitenzuspielung), Taktgenauigkeit und Zeitansage? Nenne die Normversion und lies den Normtext selbst, sonst zitiere sie nicht (vgl. UMSETZUNG §0 Regel 10).
5. **Ausspielung und Metadaten.** Wie gehen FM/RDS, DAB+ (DLS, Slideshow, EPG), HD Radio, Streaming (Icecast/HLS/DASH, ICY-Metadaten, Mehrfach-Bitraten, Ad-Insertion) und Podcast/On-Demand-Ausspielung in dieses Modell? Welche Normen und Formate gelten (RDS, DAB+/ETSI, DLS/SlideShow, EBUCore, Now-Playing-Schnittstellen)? Wie sind GVL/GEMA/AKM-konforme Musikmeldungen und Abrechnungen abbildbar?
6. **Aufnahmen und Produktion.** Wie sehen Mitschnitt (Compliance-Recording mit gesetzlicher Aufbewahrung), Mehrspur-Aufnahme, Interview-/Reportage-Ingest (Feldgeräte, mobile Upload), schnelles Schneiden im Browser (nicht-destruktiv, Transkript-basiert), Voicetracking, Nachbearbeitung, Rückholen in die Sendung („aufgenommen und sofort sendefähig") und Archiv mit Rechten, Retention und Wiederfinden aus? Wie hängt das an den bestehenden Nodes (Recorder, Ingest/QC, ASR, Review-Player)?
7. **Zukunft und Kreativität.** Was wäre mehr als der Stand der Technik? Denke an KI-gestützte Programmplanung (Stimmung, Energie, Tempo), automatische Moderationstexte und synthetische Stimmen (mit Kennzeichnung und Rechten), automatische Kapitel und Shownotes, Echtzeit-Transkription mit Suche, personalisierte oder regionalisierte Streams, objektbasiertes Audio (Next Generation Audio, ADM), Hörer-Interaktion (Votes, Anrufe, Social), datengetriebene Ausspielung und visuelles Radio (Studiokamera, Bildschirmtafel, OGraf). Trenne Machbares jetzt von Zukünftigem.
8. **Betrieb.** Welche Lücken gibt es bei Mehrmandanten-Betrieb (mehrere Sender und Programme auf einer Plattform), Rechten und Rollen für Redaktion, Moderation, Technik und Musikredaktion, Redundanz (Hauptweg und Standby, Cluster-Failover) und Monitoring (Sendeprotokoll, Audit)? Was ist mit Fernbetrieb, Heimstudio und Cloud/Kosten (Kap. 35)?
9. **Zuschnitt in Nodes.** Welche neuen Node-Typen und Orchestrator-Module wären nötig und wo lägen die Schnitte? Welche Schnittstellen und Verträge brauchen sie (analog zu `CONTRACT-MIXER-SETUP.md`)? Was lässt sich aus der TV-Automation wiederverwenden und was braucht einen eigenen Kern, etwa die Sendeuhr?
10. **Risiken und offene Entscheidungen.** Was ist unklar? Wo brauchst du eine Entscheidung von mir, bevor geplant werden kann?

## Regeln (aus dem Projekt)

- Keine Hersteller- oder Produktnamen im Code, in der Doku oder in der UI (Standing Rule).
- Normen vor Eigenwegen; Normtext selbst lesen, Version nennen.
- Neue UI-Texte laufen über `t()` in `de.ts` und `en.ts`.
- Neue Node-Features gehören ins Handbuch und in die Katalogbeschreibung.

## Ausgabe

- Zuerst eine Lückenmatrix: Fähigkeit, Status (vorhanden, teilweise, fehlt), Aufwand (S/M/L), Abhängigkeiten.
- Danach ein Zielbild mit Node-Zuschnitt und Datenflüssen.
- Dann ein Phasenplan im Stil von `UMSETZUNG.md` (ein Schritt pro Sitzung, mit Verifikationskriterien), geordnet nach Nutzen und Risiko.
- Zum Schluss eine Liste der Rückfragen an mich.
- Ändere keinen Code. Schreibe das Ergebnis als Vorschlag in eine neue Datei `docs/RADIO-PLAN.md` und übernimm nichts in `UMSETZUNG.md`, bis ich zugestimmt habe.
