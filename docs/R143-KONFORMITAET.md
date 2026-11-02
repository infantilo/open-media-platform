# EBU R 143 v3.0 — Konformität von OpenMediaPlatform (Kapitel 78.5)

Stand 2026-11-02. Grundlage: **EBU R 143 v3.0 „Cybersecurity Recommendation for media vendors’ systems,
software & services“ (März 2025)**, Annex B (Media Appliance: Produkt beim Kunden betrieben). Die
Gegenseite zu dieser Datei ist die Excel-Tabelle *Security Controls Assertation* der EBU (Arbeitsblatt B).

Die Tabelle wird bewusst **nicht schöngerechnet**: „erfüllt“ nur mit Beleg im Code oder in der Doku,
„teilweise“ mit der Lücke, „offen“ ohne Umschweife. Das Projekt ist laut README und `AUDIT_2026_10_23.md`
ein Proof of Concept ohne unabhängiges Sicherheitsaudit; diese Tabelle ersetzt kein Audit.

**Geltungsbereich**
- **Annex A (Hersteller-ISMS, Kontrollen IS, OS, SD, IM, PS, CS, BC, CM, SC)** betrifft die Organisation
  des Herstellers (Richtlinien, CISO, Zertifizierung, Schulung, Incident-Prozess). Das Projekt ist ein
  quelloffenes Vorhaben ohne Herstellerorganisation; **dazu wird keine Aussage getroffen**.
  Beiträge, die ein Produkt-Artefakt sind, stehen unten (OS-01/-02: CI-Scanner).
- **Annex C (SaaS)** gilt nicht: OMP wird nicht als Dienst angeboten.
- **Annex B** wird unten Punkt für Punkt bewertet. Prioritäten laut Norm: P1 = MUST, P2 = SHOULD, P3 = SHOULD (Best Practice).

Legende: **✔** erfüllt · **◐** teilweise · **✘** offen · **n/a** nicht zutreffend.

## Annex B — Produktanforderungen

### DO — Dokumentation
| ID | P | Anforderung (Kurzform) | Stand | Beleg / Lücke |
|---|---|---|---|---|
| M-DO-01 | P1 | Anleitung zum Ändern von Standardpasswörtern | ◐ | Beim ersten Start wird das erste Konto angelegt (Bootstrap nur lokal/mit Token, Audit H2); eine ausdrückliche Anleitung „Standardpasswort ändern“ fehlt in `docs/INSTALLATION.md`. Das Entwicklungskonto der Dev-Umgebung ist nur dort dokumentiert. |
| M-DO-02 | P2 | Beschreibung der Sicherheitsfunktionen | ◐ | Verstreut (README „Limits“, `ARCHITECTURE.md` §12/§20, `AUDIT_…`); eine zusammenhängende Sicherheitsbeschreibung fehlt. |
| M-DO-03 | P1 | Schnittstellen, Zugangspunkte, Netzkommunikation vollständig beschrieben | ◐ | `docs/INSTALLATION.md` §4 listet die Ports; die Routentabelle (`orchestrator/cmd/routetable/testdata/routes.golden.json`) beschreibt alle HTTP-Endpunkte mit Rechtepflicht. Es fehlt eine Gesamtübersicht der Node-Ports und NATS-Subjects als Betreiberdokument. |
| M-DO-04 | P2 | Integrationshinweise (nur nötige Ports offen) | ◐ | siehe M-DO-03; netzwerkarme Platzierung Kap. 56. |
| M-DO-05 | P1 | Härtungsempfehlungen | ◐ | systemd-Härtung (Audit M11) und Produktionsprofil `OMP_PROFILE=production` (Kap. 66) existieren; ein Härtungsleitfaden für Betreiber fehlt. |
| M-DO-06 | P1 | Patch-/Release-Prozess, besonders Sicherheitsupdates | ◐ | Signierte Update-Pakete mit Rollback (`docs/ENTWURF-SYSTEM-UPDATE.md`), Image-Pins per Digest, Dependabot/`govulncheck`/`cargo audit` in CI. Es fehlt eine schriftliche Zusage zu Fristen für Sicherheitsupdates. |

### AA — Authentisierung und Autorisierung
| ID | P | Anforderung | Stand | Beleg / Lücke |
|---|---|---|---|---|
| M-AA-01 | P2 | Zentrale Authentisierung (üblicher Dienst) | ✘ | Konten sind lokal; keine LDAP/OIDC/SAML-Anbindung (README „Limits“, `orchestrator/internal/auth/auth.go`). |
| M-AA-02 | P2 | Sitzungs-Timeout | ◐ | Token läuft nach 12 h ab (`auth.TokenTTL`); **kein** Inaktivitäts-Timeout. |
| M-AA-03 | P2 | Rollenbasierte Rechte (RBAC) | ✔ | Rechtestufen und Funktionsrechte (`internal/authz`, Kap. 44), je Route erzwungen (Routentabelle). |
| M-AA-04 | P2 | Personenbezogene Konten | ✔ | Lokale Nutzer, Organisationen (`internal/auth`, `internal/organizations`). |
| M-AA-05 | P2/P1 | Standardpasswörter ändern; **keine globalen versteckten Konten**; starke Passwortrichtlinie | ◐ | Mindestlänge 10 und Wiederholungs-/Namensprüfung (`auth.ValidatePassword`, Audit M4), Sperre nach 5 Fehlversuchen (`auth/lockout.go`). Keine versteckten Konten bekannt, **nicht systematisch geprüft**. Komplexitäts-/Ablaufregeln fehlen. |
| M-AA-06 | P1 | Mehrfaktor-Anmeldung für Internet-Schnittstellen | ✘ | Keine MFA. (OMP ist nicht für den direkten Internetbetrieb gedacht; die Norm verlangt die *Unterstützung*.) |
| M-AA-07 | P1 | Protokolle für Anmeldung, Autorisierung, Benutzeraktionen | ✔ | Audit-Log und Domänen-Audit (`internal/audit`, `internal/domainaudit`). |

### EN — Verschlüsselung
| ID | P | Anforderung | Stand | Beleg / Lücke |
|---|---|---|---|---|
| M-EN-01 | P1 | Passwörter nie im Klartext/umkehrbar speichern oder übertragen | ✔ | bcrypt (`auth/password.go`). Übertragung: nur über TLS gesichert, wenn TLS eingerichtet ist (siehe M-EN-03). |
| M-EN-02 | P2 | Ruhende Daten verschlüsselt (Stand der Technik) | ◐ | Schlüsselbündel der Sicherung verschlüsselt (Audit M8); Datenbank und Medien liegen unverschlüsselt, Verschlüsselung ist Sache des Betreibers (Datenträger). Nicht dokumentiert. |
| M-EN-03 | P1 | Authentisierte und verschlüsselte Netzprotokolle **unterstützen** | ◐ | mTLS Orchestrator↔Node und NATS-TLS sind **optional** und per Voreinstellung aus; Entwicklungs-NATS ohne Anmeldung (Audit B2 teilweise). Browser-Zugriff über TLS nur mit vorgeschaltetem Proxy. Im Produktionsprofil kritisch gemeldet (Kap. 66). |
| M-EN-04 | P2 | Zertifikate sicher verwalten und erneuern | ◐ | Zertifikatsausstellung per step-ca-Skript (`deploy/dev/mtls-issue-cert.sh`); automatische Erneuerung nicht belegt. |
| M-EN-05 | P1 | Kryptografische Schlüssel sicher verwalten | ◐ | JWT-Geheimnis gemeinsam in der Datenbank (Audit H10), Host-Kommando-Schlüssel mit Rotation; **Schlüssel liegen im Klartext in der Datenbank/Konfiguration**, kein HSM/KMS. |

### BA — Basiskonfiguration
| ID | P | Anforderung | Stand | Beleg / Lücke |
|---|---|---|---|---|
| M-BA-01 | P1 | Sicherheits- und Fehlerprotokolle; **gesicherte Weitergabe an zentrale Protokollplattform** | ◐ | Zentrale Protokolle und Nachverfolgung (`internal/logbus`, `internal/tracing`, ARCHITECTURE.md §25); Weitergabe an ein fremdes System (Syslog/SIEM) nur über Webhook für Alarme (Audit M7 teilweise). |
| M-BA-02 | P2 | Wechselmedien steuerbar | n/a | OMP kontrolliert keine Betriebssystem-Schnittstellen; Betreiberaufgabe. |
| M-BA-03 | P1 | Unnötige Protokolle abschalten | ◐ | Nur die in `INSTALLATION.md` §4 genannten Ports; Härtungsleitfaden fehlt (siehe M-DO-05). |
| M-BA-04 | P1 | Schutz vor Schadsoftware **möglich** | ✔ | Läuft als normaler Benutzer ohne Root (`INSTALLATION.md`), keine Kernelmodule; Virenscanner des Betreibers nicht behindert. Nicht getestet mit Scannern. |
| M-BA-05 | P2 | Daten für Echtzeitüberwachung bereitstellen | ✔ | `/metrics` (optional mit Token), Health-Ampel, Selbsttest, Alarm-Webhook. |
| M-BA-06 | P1 | Sicherung und Wiederherstellung | ✔ | `internal/backup`, geplante Sicherung, Fremdziel-Kopie (Audit M8), Support-Paket. Wiederherstellung wird als Verfahren beschrieben, regelmäßige Restore-Probe nicht automatisiert. |
| M-BA-07 | P1 | Trennung Software/Betriebssystem (OS patchbar) | ✔ | Ausführung als Benutzerprozesse/Container/systemd-Dienste, keine Appliance-Image-Bindung. |

### NE — Netzwerk
| ID | P | Anforderung | Stand | Beleg / Lücke |
|---|---|---|---|---|
| M-NE-01 | P1 | Feingranulare Netzsegmentierung **unterstützen** | ◐ | Steuer- und Medienebene getrennt gedacht (ARCHITECTURE.md), NIC-Zuordnung je Host; keine Dokumentation einer Segmentierung (VLAN-Plan). |
| M-NE-02 | P2–P3 | Betrieb ohne ständige Internetverbindung; Inhaltsprüfung; Jumphost; Verkehrsüberwachung | ◐ | Betrieb ohne Internet ist möglich (Offline-Installation, `docs/OFFLINE-INSTALLATION.md`); keine Call-Home-Funktion. Inhaltsprüfung/Jumphost/Verkehrsüberwachung sind Betreibersache und nicht dokumentiert. |

### AP — Anwendungssicherheit
| ID | P | Anforderung | Stand | Beleg / Lücke |
|---|---|---|---|---|
| M-AP-01 | P1 | Entwicklung nach Industrierichtlinien (z. B. OWASP Top 10) | ◐ | CodeQL (Go, TypeScript), `govulncheck`, `cargo audit`, Dependabot, Secret Scanning; Audit-Funde (Pfad-Traversal, SSRF, CSRF/CSP, Sperre) bearbeitet. **Keine** Abbildung der Maßnahmen auf OWASP Top 10, kein externer Test. |

## Zusammenfassung

| Stand | Anzahl (Annex B) |
|---|---|
| ✔ erfüllt | 8 |
| ◐ teilweise | 17 |
| ✘ offen | 2 |
| n/a | 1 |
| gesamt | 28 Kontrollen (DO 6, AA 7, EN 5, BA 7, NE 2, AP 1) |

**Offen mit P1 oder grundsätzlicher Wirkung** (Reihenfolge nach Nutzen):
1. **M-EN-03** — Verschlüsselung/Authentisierung standardmäßig an (Produktionsprofil ist der Weg; Dev-Stack bleibt offen).
2. **M-AA-06 / M-AA-01** — MFA und zentrale Anmeldung (OIDC); größerer Eigenbau, daher eigener Schritt.
3. **M-EN-05** — Schlüsselablage (KMS/Dateiberechtigungen).
4. **M-BA-01** — Weitergabe von Sicherheitsprotokollen an ein SIEM (Syslog nach RFC 5424 wäre die Norm-Lösung).
5. **Dokumentation** (M-DO-01…06): ein „Betreiberleitfaden Sicherheit“ schließt gleich sechs Zeilen.

Der Abgleich mit dem Audit: Die Punkte entsprechen den dort offenen B4/B5-Infrastrukturen, H1-Rest, H6, M5–M7, M12;
M-AA-01/-06 und M-BA-01 stehen im Audit **nicht** und sind durch R 143 neu sichtbar geworden.

## Hinweise
- Die EBU-Tabelle (xlsx) ist ein eigenes Dokument; wer sie ausfüllt, nimmt die Spalten dieser Datei als Vorlage
  und kürzt die Belege. Download: <https://tech.ebu.ch/publications/r143>.
- Bei jeder Änderung an Authentisierung, Verschlüsselung oder Protokollierung diese Datei mitführen.
