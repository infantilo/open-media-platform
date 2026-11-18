# Entwurf: Getrennte MXL-Domains auf einem Host (Vorplanung)

Stand 2026-11-18. **D1, D2, die Kantenprüfung aus D3 und die Ansicht aus D4 sind gebaut (UMSETZUNG Kapitel 103); D3-Rest und D5–D7 sind offen.** Nutzerauftrag: als Option starten. Dieser Entwurf hält fest, was heute gilt, was eine Trennung bringt, was sie kostet und in welchen
Schritten sie sich bauen ließe. Die Entscheidungen in §6 sind offen.

## 1. Ausgangslage (Ist)

- **Eine Domain je Host.** `OMP_MXL_DOMAIN` (Standard `/dev/shm/omp-mxl`) gilt für alle Nodes eines Hosts. Sie ist
  bewusst **nicht** je Instanz einstellbar (Kapitel 29, Grenze 4): eine Änderung je Instanz würde Flows trennen,
  ohne dass der Rest der Plattform es weiß.
- **Wo die Domain eingeht:** Launcher und Host-Agent geben die Umgebungsvariable an Prozess-Nodes weiter
  (`orchestrator/internal/launcher/envfilter`, Host-Agent-Allowlist). Container-Nodes mit `mxlAccess` bekommen den
  Pfad eingehängt (`podmanrun`, beschreibbar, `catalog.go` `MxlAccess`). Der Host-Agent legt das Verzeichnis an.
- **Was die Plattform über die Domain weiß:** nichts als Pfad. Platzierung, Umzug (Make-before-break),
  Evakuierung und der Scheduler rechnen mit „MXL ist host-lokal“; eine MXL-Verbindung über Hostgrenzen wird
  abgelehnt (409) und braucht einen Netz-Transport (2110, SRT, Fabrics).
- **Norm:** BCP-007-03 führt `mxl_domain_id` als Transportparameter der IS-05-Verbindung; OMP trägt dort heute
  `auto`. Das Modell mehrerer Domains ist also in der Norm vorgesehen, bei uns nur nicht ausgeprägt.
- **Sicherheit:** `HAERTUNG-PLAN.md` §1.1 beschreibt die Domain als gemeinsamen, beschreibbaren Bereich einer UID.
  Eine zweite Domain trennt Flows nach Pfad, nicht nach Kernel: dasselbe `/dev/shm`, dieselbe UID, dieselben
  Futexe. Echte Abschottung braucht Dateirechte/UIDs oder Container-Mounts (§4).

## 2. Wofür eine Trennung gut wäre

| Zweck | Nutzen | Dringlichkeit |
|---|---|---|
| **Test neben Live** auf demselben Host | Ein Testlauf kann keinen Live-Flow berühren, überfüllen oder aufräumen (`garbageCollect` löscht Flows ohne Sperre) | mittel |
| **Mandanten/Organisationen** (es gibt Organisationen im Rechtemodell) | getrennte Sichtbarkeit der Flows je Organisation | niedrig, solange ein Haus |
| **Speichergrenze je Bereich** | eigener tmpfs mit `size=`: ein voller Bereich legt die anderen nicht lahm (heute: Befund „Verwaiste Flows … /dev/shm voll“) | mittel |
| **Container mit minimalem Zugriff** | ein Fremd-Container sieht nur seine Domain statt alle Flows des Hosts | mittel (Sicherheit) |

Für einen einzelnen Betrieb mit einer Produktion ist der Nutzen heute klein. Sinnvoll wird es mit Test+Live auf
einer Maschine, mit Mandanten oder mit stärker abgeschotteten Fremd-Containern.

## 3. Entwurf

### 3.1 Begriff „Domain“ als Objekt

- Name (Kennung, nur `[a-z0-9-]`), Pfad (`/dev/shm/omp-mxl-<name>`; die Standarddomain `default` bleibt
  `/dev/shm/omp-mxl`), optionale Größe (eigener tmpfs), Besitzer (Organisation oder „System“).
- Gespeichert in Postgres (Migration), Verwaltung unter Administration (analog zu Speicheranbietern).
- Jede Instanz und jede Workflow-Rolle gehört zu **genau einer** Domain (Standard `default`).

### 3.2 Start und Umgebung

- Der Launcher setzt `OMP_MXL_DOMAIN` je Instanz aus der Domain der Rolle/Instanz (Rangfolge wie bei Node-Optionen,
  aber **nicht** über die freien Node-Optionen, sondern ein eigenes Feld, damit die Zuordnung prüfbar bleibt).
- Host-Agent: Allowlist erweitern, Pfad nur aus der bekannten Domainliste akzeptieren (kein freier Pfad vom Netz),
  Verzeichnis anlegen (und bei Größe: tmpfs mounten — braucht Rechte, nur als vorbereiteter Mount im Installationsskript,
  nicht zur Laufzeit).
- Container (`mxlAccess`): nur die Domain der Instanz einhängen, nicht die Standarddomain.

### 3.3 Verbindungen

- **Innerhalb einer Domain:** wie heute.
- **Über Domains hinweg auf demselben Host:** der Graph lehnt die Kante ab (wie bei Hostgrenzen), mit Hinweis
  „andere Domain“. Eine **Brücke** ist ein eigener Node (liest Flow aus Domain A, schreibt in Domain B): technisch
  ein Empfänger plus Sender mit zwei `MxlContext`. `omp-mediaio` kann das (zwei Kontexte in einem Prozess); es
  gibt keinen fertigen Brücken-Node. Die Brücke ist die einzige Stelle, an der Domains absichtlich zusammenkommen.
- **IS-05:** `mxl_domain_id` trägt dann eine echte Kennung statt `auto`; Zuweisung und Prüfung im Node-SDK
  (`connection.rs`).

### 3.4 Platzierung, Umzug, Anzeige

- Der Scheduler/Platzierer behandelt „Host + Domain“ als Paar: Make-before-break und Failover dürfen eine Rolle
  nur in die **gleiche** Domain des Zielhosts legen (die Domain muss dort existieren).
- Flow-Ansicht (Kapitel 101): `mxlflows.Scan(domain)` kann schon eine beliebige Domain lesen; die Ansicht bekäme
  eine Domain-Auswahl und die Liste aller Domains des Hosts (Verzeichnisse `omp-mxl*` in `/dev/shm`).
- Selbsttest: Hinweis pro Domain (Größe, Reste), nicht nur für die Standarddomain.

## 4. Abschottung (optional, gehört zur Sicherheitsstufe)

Pfad-Trennung allein schottet nicht ab. Stufen:

1. **Pfad** (kostenlos): Flows liegen getrennt, ein Fehlverhalten eines Nodes in A berührt B nur bei Absicht oder Fehler.
2. **Container-Mount** (billig für Container-Nodes): der Container sieht nur seine Domain.
3. **UID/Gruppe je Domain** (aufwendig): Dateirechte aus `HAERTUNG-PLAN.md` §1.1 (Lesen für alle, Schreiben für die
   Domain-Gruppe, `access` für Leser beschreibbar). Braucht je Domain eine Gruppe, die Prozess-Nodes ihre
   Zusatzgruppe, und angepasste `umask`; Prozess-Nodes laufen heute alle unter einer UID.

## 5. Schritte (Vorschlag, je ein Schritt pro Sitzung) — Stand: D1, D2, D4 (Ansicht), D3 (nur Kantenprüfung) erledigt

| Schritt | Inhalt | Prüfung |
|---|---|---|
| D1 | Domain-Objekt: Tabelle, API (anlegen/auflisten/löschen), Admin-Ansicht; Standarddomain `default` bleibt unverändert | Go-Tests, Umgebung unverändert für bestehende Instanzen |
| D2 | Launcher + Host-Agent: `OMP_MXL_DOMAIN` je Instanz aus der Zuordnung; Allowlist; Container-Mount je Domain | zwei Instanzen in zwei Domains, `mxl-info` je Domain, kein Flow in der falschen |
| D3 | Workflows: Domain je Rolle/Workflow wählbar; Kanten über Domains werden mit klarer Meldung abgelehnt; Platzierung/Umzug beachtet die Domain | Workflow-Tests, Umzug in gleiche Domain |
| D4 | Flow-Ansicht und Selbsttest je Domain | Browser |
| D5 | Brücken-Node Domain A → B (Video + Audio) | Flow in A erscheint in B, Latenz gemessen |
| D6 | IS-05 `mxl_domain_id` mit echter Kennung (BCP-007-03) + Konformitätsprüfung | eigenes Schema-Prüfwerkzeug |
| D7 | optional: Abschottung Stufe 3 | Rechte-Matrix |

## 6. Offene Entscheidungen

1. **Welcher Anlass?** Test neben Live, Mandanten oder Container-Abschottung — davon hängt ab, ob die Domain je
   Instanz, je Workflow oder je Organisation gewählt wird.
2. **Zuordnung:** je Workflow (einfach, passt zu Test/Live) oder je Rolle (flexibel, braucht Brücken im selben
   Workflow).
3. **Größenbegrenzung:** eigener tmpfs je Domain (Mount-Rechte nötig, Installationsskript) oder nur Überwachung.
4. **Cluster:** die Domain ist host-lokal; ein Cluster-weiter Domainname (gleiche Kennung auf jedem Host) ist
   einfacher als eine Zuordnung je Host.
5. **Abschottungsstufe** (§4) für den ersten Wurf.

## 7. Aufwand und Risiko

Mittel bis groß: D1–D4 sind überschaubar (je ein Schritt), D5 ist ein neuer Node, D6/D7 sind Normen- und
Sicherheitsarbeit. Das Hauptrisiko ist die Platzierungslogik (Umzug und Failover müssen die Domain kennen,
sonst landet eine Rolle auf einem Host ohne ihre Domain) und die Annahme „eine Domain je Host“ an vielen Stellen
(`OMP_MXL_DOMAIN` wird in mehreren Nodes und Werkzeugen direkt gelesen).
