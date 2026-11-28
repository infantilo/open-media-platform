# Doku-Index (generiert, Zeilennummern)

Erzeugt mit `sh docs/entwicklung/doku-index.sh`. Abschnitt gezielt lesen: Read mit offset=Zeile, limit=Länge bis zur nächsten Zeile.

## UMSETZUNG.md

10 0. Arbeitsregeln für Claude (bei jeder Sitzung befolgen)
62 1. Rahmenbedingungen Pro-Plan
76 2. Phasenübersicht und Kosten
102 3. Phase A — Fundament (P0)
266 4. Phase B — Flow-Editor GUI (`ARCHITECTURE.md` §4.5a)
388 5. Phase C — Playout-Node (Rust + GStreamer)
1122 6. Phase D — Hardening & SDK-Release (Überblick)
2262 6a. Kapitel 10 — Endziel-Anforderungen (`docs/END-GOAL-FEATURES.md`)
2765 6b. Kapitel 21 — Workflow Engine + Asset/Content Domain Model
3200 6c. Kapitel 22 — FFmpeg/FFprobe-Assistent (Wizard + Filter-Builder)
3639 6d. Kapitel 23 — FFmpeg-Assistent: Baukasten statt Sonderfall (Korrektur zu Kapitel 22)
4011 6e. Kapitel 24 — Operator-UI: echte Fenster (Minimieren/Maximieren/Vor-Reihenfolge/Anordnen)
4090 6f. Kapitel 25 — FFmpeg-Assistent: Aufgaben-Registry + erweiterte Audio-Matrix
4445 6g. Kapitel 27 — Playout-Automation: vom Rundown-Controller zum Channel-Automator
4736 7. Status-Checkliste (von Claude nach jedem Schritt pflegen)
5019 Kapitel 28: Node-Versionierung
5033 Kapitel 29: Einstellungen über die UI
5049 Kapitel 27 P7: Multi-Channel und Channel-Trigger
5053 Kapitel 27 P8: Asset-/Process-Preflight
5066 Kapitel 30: MXL Flow Synchronization Groups
5079 Kapitel 31: Tonmischer mit Gruppen-Bussen, Quellen-Streifen und framegenauem Take
5113 Kapitel 32: Tonmischer — Ausgänge einfach definieren, Mehrfach-Routing, Surround-Panner
5132 Kapitel 33: MXF-Mehrkanal-Audio-Labeling — SMPTE ST 377-4 / ST 377-41
5145 Kapitel 34: Lokale Geräte (USB Video/Audio) als MXL anbieten — `omp-device-hub`
5157 Kapitel 35: Cloud-Ressourcen dynamisch + Kosten
5177 Kapitel 36: Orchestrator-Module — Domänenfunktionen (Playout, Audio-Ausgabe, Cloud) vom Kern trennen
5206 Kapitel 37: SCTE-104/-35 — Werbeblöcke automatisch kennzeichnen und ins Signal einbetten
5230 Kapitel 38: X/Y-Panel — jede Quelle auf jede Senke schalten
5259 Kapitel 39: Playout-Puffer-Senke `omp-playout-buffer` — Failover-Puffer am Ende des Graphen
5317 Kapitel 40: Stream Deck per WebHID als Operator-Bedienpult
5383 Kapitel 41: Host entfernen + Wartungsmodus mit Make-before-break
5393 Kapitel 43: Eingang — File-QC, Review-Player, framegenaues Conform, Metadaten
5405 Kapitel 42: Geplante Live-Aufnahme mit Ressourcenplanung
5416 Kapitel 44: Funktionsrechte, Verantwortliche und Arbeitsplatz für Aufnahmen und Eingang
5444 Kapitel 45: Audio-Kanalplan der Aufnahme — mehrere Quellen, Shuffling, Gain, Stille
5454 Kapitel 46: Video folgt Audio (VfA) — Gesichtserkennung, Regie-Automat, einfache AFV-Gruppen
5468 Kapitel 47: Intercom — Gruppenrufe, Muting, virtuelle Sprechstellen
5558 Kapitel 48: Intercom-Server als eigener Dienst statt Orchestrator-Modul
5602 Kapitel 49: Austauschbare Fachdienste — Vertrag statt Produkt
5621 Kapitel 50: Intercom in der Handy-Kamera-Seite
5636 Kapitel 51: Tally mit mehreren Gebern
5651 Kapitel 52: Host-Auswahl und Lastverteilung für ffmpeg-Jobs
5669 Kapitel 53: Flow-Editor-Suche und Administrations-Untergruppen
5674 Kapitel 54: Wire-Format gemeinsam, Trend-Daten, Auto-Kalibrierung der Live-Reserve, Host-Topologie
5702 Kapitel 55: Trend-Vorwarnung, Suchfeld-Fix, Rest der offenen Punkte
5719 Kapitel 56: Netzwerkarme Platzierung — Verbünde statt Einzelrollen
5756 Kapitel 57: Audit 2026-10-23 — Umsetzung der ersten Punkte
5771 Kapitel 58: Audit 2026-10-23 — zweite Runde (B2 signierte Host-Kommandos, H1 SSRF, /metrics)
5790 Kapitel 59: Audit 2026-10-23 — dritte Runde (M1 Uhr, M2 Schaltraster, M4 Passwörter, M8 geplante Siche
5803 Kapitel 60: Audit 2026-10-23 — Lieferkette (Image-Digests, Actions per SHA)
5812 Kapitel 61: `-race` sauber und in der CI
5823 Kapitel 62: Audit 2026-10-23 — B1 Node-HTTP-API gesichert, M1 Uhr stellt sich selbst
5842 Kapitel 63: Intercom-Oberfläche für hundert und mehr Sprechstellen
5854 Kapitel 64: Audit 2026-10-23 — H7 Rechte-Cache, M8 Schlüsselbündel/Fremdziel, M11 systemd, H9 Panik-W
5865 Kapitel 65: Audit 2026-10-23 — H5 Rücksprung bei der Instanz-Migration, H4/M10 Fencing der Host-Komman
5877 Kapitel 66: Audit 2026-10-23 — B4/B5 Produktionsprofil
5888 Kapitel 67: Audit 2026-10-23 — M7 externes Alarming
5900 Kapitel 68: Audit 2026-10-23 — H1 Sitzung per HttpOnly-Cookie, CSP, CSRF-Schutz
5912 Kapitel 69: Startdialog im Node-Katalog des Flow-Editors
5921 Kapitel 70: Zwei Orchestratoren — Raft-Zeuge und Notausgang
5939 Kapitel 71: Node-Oberflächen auf eigenem Ursprung
5960 Kapitel 72: Support und Diagnose für Laien — Support-Paket und Selbsttest
6094 Kapitel 73: Auswertung von Support-Paket und Momentaufnahme
6104 Kapitel 74: Fremdplaylist-Import, Havarie-Mitlauf, Freigabe-Durchlauf, intuitivere Playout-UI
6156 Kapitel 76: Capture-Hardware und Netzwerkkarten — Magewell, Elgato, AJA, SDK-Karten anderer Hersteller,
6183 Kapitel 77: SRT aus Dateien mit Sprechererkennung
6203 Kapitel 78: Normen vor Eigenwegen — EBUCore, R 103, R 143
6224 Kapitel 79: HDR-Kennzeichnung, UHD-Messung, SRT mit komprimiertem Video
6237 Kapitel 80: TLS-Acceptor ersetzt `tiny_http`-TLS, Abhängigkeiten bereinigt
6247 Kapitel 81: Bildschirm- und Webseiten-Capture ohne Internet
6266 Kapitel 82: Datenbank-Wartung
6278 Kapitel 83: E-Mail-Alarmierung
6294 Kapitel 84: Cluster-Rolling-Update + rollierender Cluster-Neustart
6299 Kapitel 85: Verteilung importierter Microservices auf Hosts
6351 Kapitel 86: Dateiverwaltung — Explorer, Löschen, Upload, Filter „Datei fehlt“
6370 Kapitel 87: Mehrere PIPs, 2D-Pose, Klick-Fokus im Videomixer M/E
6385 Kapitel 88: Workflow-Schnittstelle — benannte Ausgänge und Eingänge
6429 Kapitel 89: Radio-Betrieb
6472 Kapitel 90: OGraf — Layout-Zonen, Rahmen-Transitions (Paternoster), vollwertiger OGraf-Editor
6499 Kapitel 91: Workflow-Suche, Ziehen/Verlängern/Jetzt beenden, dynamische Ereignisse als Auslöser
6509 Kapitel 92: Active-Directory-/LDAP-Anmeldung
6521 Kapitel 93: MIDI-Pulte — Mackie Control (iCON V1-M/P1-M mit Erweiterung), generisches Profil, Browser u
6535 Kapitel 94: Mitgelieferte Sendevorlagen, Trenner „Wipe“, Abspann
6550 Kapitel 95: Variablen in Child Events — Werte aus Playlist-Events in Grafik-Daten und Parameter
6561 Kapitel 96: Mehrkanal-Platz — ein Operator betreut mehrere Playout-Channels
6578 Kapitel 97: Eingang aufräumen — Prüfeinträge entfernen
6590 Kapitel 99: Studio-Mischer mit niedriger Latenz — ALSA, AES67, MXL
6620 Kapitel 100: Ausfall-Audit des Orchestrators — Absturz, Host-Ausfall, Standby, Umzug, Neustart
6656 Kapitel 101: MXL-Flow-Ansicht mit Schreiber-Zuordnung und Rest-Erkennung
6664 Kapitel 102: HLS-Eingang `omp-hls-source`
6677 Kapitel 103: Getrennte MXL-Domains als Option — D1, D2, D3-Kantenprüfung, D4-Ansicht
6689 Kapitel 103 (Fortsetzung): Domains je Workflow/Rolle, entfernte Hosts, Container-Nodes, Flow-Editor-Ansic
6698 Kapitel 103 (Teil 3): Domain-Brücke, IS-05 `mxl_domain_id`, Auto-Anordnen, Flow-Editor-Politur
6708 Kapitel 103 (Teil 4): offene Punkte — Sender-IS-05, Flows entfernter Hosts, Domain wechseln, Polling-Te
6717 Kapitel 103 (Teil 5): D7 Abschottung per Sandbox, Polling in den Nodes, Fit-All-Fehler
6729 Kapitel 104: PTZ-Kamerasteuerung `omp-ptz`
6742 Kapitel 105: TAMS — zeitadressierter Medienspeicher: Aufnahme, Wiedergabe, optional eigener Speicher
6784 Kapitel 106: Hauptkontrollraum (MCR / Ingest-Leitstelle) — Leitungen, Hausformat nur bei Abweichung, A/
6963 Kapitel 107: Audio-Matrix `omp-audio-matrix` — freie Ein-/Ausgänge, Kreuzschiene, Kanal-Labels, MCR-An
7052 Kapitel 108: Ausfallfreier Umzug über Hostgrenzen trotz MXL-Gegenstellen
7089 Kapitel 109: Ausfallfreies Hot-Standby

## ARCHITECTURE.md

9 1. Vision
38 2. Standard-Fundament
59 3. Layer-Architektur
83 4. Tech-Stack-Entscheidungen
245 5. Node-Contract (Plugin-Modell)
265 6. Media-Exchange-Strategie über Deployment-Stufen
1105 7. Phasenplan
1274 8. Erwartete Unwegbarkeiten — vorab bedacht
1305 9. Marktkompatibilität (Stand Juli 2026, per Recherche)
1342 10. Zukunftssicherheit / Markt-Drift-Risiken
1379 11. Offene Entscheidungen
1580 12. Nutzer- und Rollenmodell (AuthZ, geplant, ab P2 zusammen mit D3)
1661 13. Produktions-Microservices für den Regieplatz
1876 14. Rollen-gescoptes Operator-Console-UI („virtuelles Pult")
1942 15. Deterministische Ende-zu-Ende-Latenz & A/V/Daten-Synchronität
2102 16. Ressourcen-Kapazitätsplanung über die Zeit (Erweiterung von §6.2, geplant ab D7)
2155 17. Monitoring-Vertiefung: frame-genaue Erkennung, Operator- vs. Engineering-Sicht
2212 18. Remote-Host-Erkennung & Host-Agent
2428 19. Orchestrator-Redundanz / Control-Plane-HA (Konzept + Umsetzungsplan ab D12, 2026-08-18)
2827 20. 24/7 Broadcast-Grade Hardening — Gap-Analyse & Fahrplan (Zielbild, Priorisierung ausstehend)
3131 21. Ausfallsicherheits-Gesamtkonzept (konsolidiert, 2026-07-13)
3233 22. Professionelles UI-Gesamtkonzept (2026-07-13)
3403 23. MXL/DMF-Metadatenebene (2026-07-13)
3485 24. Playlist-Suite-Erweiterung: Media-Library, Cart-Assets, Plugin-Host,
4007 25. Zentralisierte Observability: Logs, Distributed Tracing, Diagnose-Cockpit (Teil 1 umgesetzt, 2026-09-
4193 26. FFmpeg/FFprobe-Assistent: geführte Bedienung statt roher CLI-Argumente (2026-09-25)
4321 27. Cloud-Ressourcen dynamisch bereitstellen, Kosten, Autoscaling
4438 28. Orchestrator-Module: Domänenfunktionen vom Kern trennen (Stufe 1 umgesetzt 2026-10-09, UMSETZUNG.md 
4508 29. SCTE-104/-35: Werbeblöcke kennzeichnen und ins Signal einbetten
4565 30. Playout-Puffer: Ausgangs-Anker und Failover-Puffer
4619 31. Netzwerkarme Platzierung: Verbünde statt Einzelrollen
4642 32. Getrennte MXL-Domains
4651 33. Hauptkontrollraum (MCR / Ingest-Leitstelle)
4785 34. Audio-Matrix `omp-audio-matrix` (Kap. 107, Plan 2026-11-24)
