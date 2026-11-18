# Projekt-Review 2026-07-17: Bottlenecks, 24/7-Tauglichkeit, Skalierung, UI

Auftrag (Projektinhaber): das Projekt überprüfen auf Bottlenecks,
24/7-Tauglichkeit, Skalierbarkeit (später etliche Hosts gemeinsam,
eventuell auch KI-/Cloud-Dienste), mehrere Regieplätze, Remote-Regie,
mehrere gleichzeitig laufende Abwicklungen — und konkrete
Umsetzungs-Anweisungen für spätere Sonnet-Sitzungen formulieren.

**Methode:** Code gelesen, nicht angenommen — jeder Befund unten trägt
eine Datei-/Zeilenreferenz. Wo ein Thema bereits in bestehenden
Dokumenten konzipiert ist (`ARCHITECTURE.md` §17/§19/§20/§21/§22,
`docs/END-GOAL-FEATURES.md` Kapitel 7/11/12/14/15/16/17), wird dorthin
verwiesen statt dupliziert — dieses Review ergänzt die dort fehlende
**Code-Evidenz** und macht aus den Konzepten eine konkrete,
priorisierte Schritt-Liste (Abschnitt E).

Stand des Reviews: Commit `b7af713` (nach K11-Teil-1).

---

## A. Skalierungs-Bottlenecks (Code-Evidenz)

### A1. Registry-Vollabzug alle 2 Sekunden, unpaginiert

`orchestrator/internal/registry/poller.go:13` pollt die NMOS-Query-API
alle 2 s; `client.go:29–52` holt dabei **fünf komplette Listen**
(nodes, devices, senders, receivers, flows) ohne Pagination und baut
jedes Mal den vollen Snapshot neu. Bei der Ziel-Größenordnung
(„etliche Hosts", Dutzende Nodes, Hunderte Sender/Receiver) wächst
das linear in Payload und JSON-Decode-Kosten — alle 2 s, dauerhaft.
Der Code-Kommentar in `poller.go:11–12` benennt die vorgesehene
Lösung selbst: IS-04-Query-**WebSocket-Subscription** statt Voll-Poll.
Zusätzlich: `notifyChanges` (`poller.go:105–127`) vergleicht per
`reflect.DeepEqual` über alle Nodes — bei großen Beständen unnötig
teuer, aber erst nach dem Subscription-Umbau relevant.

### A2. `GET /api/v1/graph` macht pro Aufruf N×M serielle IS-05-HTTP-Roundtrips

`internal/graph/graph.go:222–245` (`buildEdges`): für **jeden
Receiver jedes Nodes** ein synchroner `GetActive`-HTTP-Call gegen den
jeweiligen Node — pro Graph-Abruf, seriell. Der Flow-Editor lädt den
Graphen bei jedem SSE-Event und jedem Reconnect neu; jeder offene
Browser multipliziert das. Bei 20 Nodes × 4 Receivern über mehrere
Hosts sind das 80 serielle WAN-Roundtrips pro Anzeige-Refresh — der
mit Abstand größte einzelne Skalierungs-Bottleneck im heutigen Code.
Die Edge-Wahrheit liegt dabei ohnehin beim Orchestrator selbst (alle
Connect/Disconnect laufen über ihn, `graph.go:148/189`) — ein
ereignisgetriebener Edge-Cache ist also ohne Semantik-Verlust möglich
(Rest-Risiko: von außen an OMP vorbei geschaltete IS-05-Connections;
dafür reicht ein langsamer Hintergrund-Reconcile).

### A3. UI ist poll-getrieben, SSE nur Deko; SSE-Hub verliert Events stumm

Alle Shell-Views pollen unabhängig: `workflows-view.ts:52` (3 s),
`hosts-view.ts:45` (4 s), `alarm-view.ts:70` (4 s),
`admin-view.ts:48` (Audit, 5 s) — pro offenem Browser-Tab. Der
SSE-Hub (`internal/sse/hub.go:34`) hat 16 Events Puffer pro Client
und **verwirft bei vollem Puffer stumm** (`hub.go:53–62`) — die
Views könnten sich darauf also heute gar nicht verlassen. Ergebnis:
Grundlast ~1 Request/s pro offenem Tab schon im Leerlauf, multipliziert
mit der Zahl der Regieplätze. Richtung: Views SSE-getrieben machen
(Poll nur als Fallback/Reconcile), Hub-Drops als `lost-events`-Signal
an den Client melden, damit der gezielt neu lädt.

### A4. Orchestrator-lokale Dateizustände blockieren jede zweite Instanz

Zwei Zustände leben als lokale Dateien statt in Postgres:
Launcher-Instanzen (`internal/launcher/launcher.go:217`,
`data/instances.json`) und das JWT-Secret
(`internal/auth/secret.go`, Datei unter `.run/`; per
`OMP_AUTH_JWT_SECRET_FILE` überschreibbar). Beides verhindert einen
zweiten Orchestrator (Standby oder horizontal) und macht den
Instanzbestand bei Host-Verlust unwiederbringlich —
`ARCHITECTURE.md` §19 (Control-Plane-HA) setzt „aller Zustand in
Postgres" voraus; diese zwei sind die konkreten Nachzügler.

### A5. Audit-Log: unbegrenztes Wachstum, festes Limit, keine Pagination

`internal/audit/audit.go:53` (`List(200)` hart in
`auth_handlers.go`), keine Retention, kein Index-gestütztes Blättern.
Bei 24/7-Betrieb mit auditierten Schreibzugriffen wächst
`audit_log` unbegrenzt; die Admin-UI zeigt stumm nur die letzten 200.

---

## B. 24/7-Tauglichkeit

### B1. Single Points of Failure — Konzept existiert, Umsetzung nicht

Orchestrator-Prozess, Postgres, NATS und nmos-cpp-Registry sind je
genau einmal vorhanden (Dev-Container, `Makefile:64–76`).
`ARCHITECTURE.md` §19 beschreibt die gestaffelte HA-Strategie und
§21 das Gesamtkonzept — **nichts davon ist begonnen**, und das ist
für den heutigen Projektstand auch richtig (§19: „kein
Umsetzungsschritt vor Bedarf"). Was aber *jetzt schon* fehlt und
billig ist: eine **Backup/Restore-Prozedur** für Postgres
(§20.6 nennt es bereits; es gibt weder Skript noch
Handbuch-Abschnitt noch je einen getesteten Restore).

### B2. Remote-Instanzen sind Resilienz-Bürger zweiter Klasse

Der Host-Agent loggt ein Prozessende nur
(`host-agent/internal/commands/commands.go:115–120`) — keine
Crash-Meldung an den Orchestrator, kein Auto-Restart, kein
Pendant zur lokalen `supervise()`-Kette (K7-Teil-1), und
`extraEnv`/Workflow-Settings erreichen Remote-Starts nicht
(`launcher.go` Remote-Pfad schickt nur den Typnamen; dokumentiert in
`docs/decisions.md` Nachtrag 7). Für „etliche Hosts" heißt das
heute: genau die Instanzen, die am wahrscheinlichsten remote laufen,
haben weder Crash-Erkennung noch Workflow-Auflösung. Das ist die
größte einzelne 24/7-Lücke mit klarem, begrenztem Fix (E-Schritt S3).

### B3. Erkennungs- und Startzeiten sind Dev-, nicht Broadcast-Kaliber

Health-Staleness 10 s (`orchestrator/main.go:42`), Registry-Expiry
12 s (`deploy/nmos/registry.json`), Registry-Poll 2 s,
`registrationTimeout` beim Workflow-Start 20 s
(`internal/workflows/service.go:28`). Für Failover-Ambitionen
(§20.1/§21) dominiert die Erkennungszeit jede Umschaltung —
frame-genaue Erkennung ist §17-Konzept. Kein Sofort-Handlungsbedarf,
aber jede künftige Redundanz-Arbeit muss zuerst hier ansetzen, nicht
beim Umschaltmechanismus.

### B4. Keine Metriken, kein Langzeit-Beweis

Kein `/metrics`, kein Prometheus/expvar im gesamten Orchestrator
(Volltextsuche). Damit gibt es keinen Weg, Memory-/Goroutine-/
FD-Wachstum über Tage zu sehen — 24/7-Tauglichkeit ist aktuell
unbeweisbar. Kapitel 14 (Ressourcen-Historie) braucht ohnehin eine
Zeitreihen-Grundlage; ein Metrics-Endpunkt ist deren natürlicher
erster Schritt. Ebenso fehlen Soak-Tests (§20.6: „Dauerlast,
Langzeit-Stabilität — heute nur `make check` pro Commit") und
Log-Rotation (`.run/orchestrator.log` wächst unbegrenzt; Node-stderr
nur als In-Memory-Tail).

---

## C. Multi-Host, mehrere Regieplätze, Remote-Regie, parallele Abwicklungen

### C1. Medienpfad zwischen Hosts: bewusste, aber reale Grenze

MXL ist Shared-Memory (`/dev/shm/omp-mxl`) — **ein** Host. Zwischen
Hosts existiert nur das ST-2110/SRT-Gateway (D4) als manuell zu
verdrahtender Sonderknoten. Kapitel 16 (MXL-native Fabrics/RDMA) ist
konzipiert, aber ausdrücklich an eine noch offene
Grundsatzentscheidung gebunden (16.5.1). Bis dahin gilt: „etliche
Hosts" heißt *Control-Plane* über Hosts, Medien bleiben pro Host —
das muss die Placement-/Workflow-Logik wissen (heute nirgends
erzwungen: man kann zwei Rollen mit MXL-Verbindung auf verschiedene
Hosts platzieren und es scheitert erst zur Laufzeit).

### C2. Parallele Abwicklungen teilen einen globalen Graphen und globale Rechte

Workflows (D7) existieren als Objekte, aber: der Flow-Editor zeigt
**einen** globalen Graphen aller Nodes; `configure`/`admin` sind
global (`"*"`); die Operator-Console kennt nur den impliziten
Stub-Workflow (`internal/consoles/resolve.go:15`,
`StubWorkflowID = "default"`). Zwei gleichzeitige Produktionen können
sich also heute gegenseitig sehen und (mit `configure`) gegenseitig
umverkabeln. Die Lösung ist vollständig in Kapitel 12
(Workflow = Regieplatz) + K11-Teil-4/K12-Teil-4 (Workflow-Scope im
Rollenmodell) konzipiert — dieses Review ändert daran nichts, stuft
es aber von „später" auf **Voraussetzung für mehrere Regieplätze**
hoch (E-Schritt S6).

### C3. Remote-Regie: kein TLS am Frontend

Alles läuft über Klartext-HTTP auf Port 8000; mTLS existiert nur
Orchestrator↔Mock-Node (D3 Teil 1). Bearer-Tokens in localStorage
plus `?access_token=` für SSE (`auth_middleware.go:59–73`) sind über
ein unverschlüsseltes WAN nicht vertretbar. Der billigste seriöse
Weg ist **kein** eigener TLS-Stack im Orchestrator, sondern ein
dokumentierter Reverse-Proxy (Caddy/nginx, TLS-Terminierung,
WebSocket/SSE-Durchleitung) + `HANDBUCH.md`-Abschnitt. (E-Schritt S7.)

### C4. „Eventuell auch Claude-/KI-Dienste"

Einordnung, keine Empfehlung zur Sofort-Umsetzung: der Node-Contract
(HTTP-Descriptor + NATS + NMOS-Registrierung) ist transportneutral
genug, dass ein „Dienst-Node" ohne Medienpfad (z. B.
Transkriptions-/Verschlagwortungs-/Assistenz-Dienst, der Events
konsumiert und Methoden anbietet) bereits heute als ganz normaler
Node registrierbar wäre — es braucht **keine** Architekturänderung,
nur einen Referenz-Node. Sinnvolle erste Anwendungsfälle, wenn es so
weit ist: Alarm-Triage (Alarm-View-Einträge zusammenfassen/priorisieren),
Audit-Log-Anfragen in natürlicher Sprache, Workflow-Vorprüfung.
Empfehlung: als eigenes END-GOAL-FEATURES-Kapitel konzipieren, wenn
der Nutzer es konkret will — nicht nebenbei bauen.

---

## D. User-Interface — was besser werden muss

Geordnet nach Wirkung, mit Verweis auf bestehende Konzepte:

1. **SSE-getriebene Views statt Poll-Orchester** (s. A3) — spürbar
   trägere Updates als nötig und unnötige Grundlast; zusammen mit A2
   der Kern von E-Schritt S1/S2.
2. **Blockierende `alert()`/`confirm()`-Dialoge**
   (`workflows-view.ts:144/169`, `admin-view.ts` Löschen) statt eines
   Toast-/Dialog-Bausteins in `ui/kit` — wirkt unprofessionell und
   blockiert bei Remote-Latenz den ganzen Tab. `flow-canvas.ts` hat
   bereits Toasts; die gehören als `<omp-toast>`/`<omp-confirm>` in
   `ui/kit` und überall verwendet (§22.2-Linie).
3. **Kein Workflow-Kontext in der Shell:** kein Umschalter „in
   welcher Produktion arbeite ich", Konsole hart auf „default"
   (C2). UI-Hälfte von Kapitel 12; ohne sie bleibt Multi-Regieplatz
   Theorie.
4. **Sprachmix und `lang="en"`** (`ui/index.html:2`) bei durchgehend
   deutschen Texten, gemischt mit englischen Begriffen („Connected",
   „Flow Editor", Fehlertexte englisch aus dem Backend). Entscheidung
   nötig: eine Sprache konsequent (Empfehlung: Deutsch im UI,
   Backend-Fehler durchreichen wie sie sind) — kein i18n-Framework.
5. **Keine Pagination/Suche/Filter:** Audit-Log fest 200 (A5),
   Nutzer-/Bindungslisten ungefiltert, Katalog ohne Suchfeld (bereits
   konzipiert als §22.3 Punkt 8 / §20.2). Wird mit wachsendem Bestand
   unbenutzbar.
6. **Kein Undo im Flow-Editor**, Löschen von Rollenbindungen ohne
   Rückfrage (`admin-view.ts#deleteBinding`) — destruktive Aktionen
   brauchen mindestens Confirm, besser Undo-Toast (§22-Linie).
7. **Settings-Panel (K1 Teil 3) fehlt weiterhin** — Theme, eigene
   Passwort-Änderung (K11-Teil-4), UI-Präferenzen haben keinen Ort.
8. **Zugänglichkeit:** kaum ARIA, kein Fokus-Management in Overlays
   (Login-Overlay, künftige Dialoge), Tastaturbedienung nur im
   Flow-Editor rudimentär. Für Bedienpulte im Dauerbetrieb relevant,
   aber nach 1–7 einzuordnen.

---

## E. Anweisungen für Sonnet (priorisierte Schritte)

Arbeitsregeln wie immer (`UMSETZUNG.md` §0): ein Schritt pro Sitzung,
research-before-code, live verifizieren (CDP für UI), dokumentieren
(`docs/decisions.md`-Nachtrag + Status-Checkliste), committen, nie
pushen. Reihenfolge ist Empfehlung; S1–S4 sind unabhängig
voneinander startbar.

### S1 — Graph-Edge-Cache (behebt A2)

**Ziel:** `GET /api/v1/graph` ohne IS-05-Roundtrips beantworten.
`graph.Service` hält Edges im Speicher: initial einmal per
`buildEdges` befüllt, danach ereignisgetrieben aktualisiert (eigene
`Connect`/`Disconnect`-Aufrufe mutieren den Cache direkt;
`node.removed` entfernt dessen Edges; `node.added` triggert einen
gezielten `GetActive`-Abgleich nur für diesen Node). Zusätzlich ein
langsamer Hintergrund-Reconcile (z. B. alle 60 s) gegen extern an OMP
vorbei geschaltete Connections — Abweichungen loggen und übernehmen.
**Verifikation:** Unit-Tests für Cache-Invalidierung; live: Graph
mit ≥3 Nodes, `GET /api/v1/graph`-Latenz vorher/nachher messen
(sichtbar konstant statt node-proportional), Edge nach
Connect/Disconnect/Node-Kill korrekt; Reconcile-Test: Connection
direkt per `curl` am Node schalten → taucht ≤60 s später im Graph auf.

### S2 — SSE-first-UI + Lost-Events-Signal (behebt A3, D1)

**Ziel:** `workflows-view`/`hosts-view`/`alarm-view`/`admin-view`
(Audit) aktualisieren auf SSE-Events statt Intervall-Poll; Poll
bleibt nur als Reconnect-/Fallback-Pfad (deutlich längeres Intervall,
z. B. 30 s). Voraussetzung backend-seitig: fehlende Events ergänzen
(`workflow.updated` existiert; `host.metrics`/`audit.appended` ggf.
neu — prüfen, was schon publiziert wird, bevor etwas Neues erfunden
wird). SSE-Hub: beim Drop (`hub.go:58–60`) dem betroffenen Client
beim nächsten erfolgreichen Send ein `{"type":"lost-events"}`
mitgeben — Views laden dann einmal voll nach.
**Verifikation:** CDP: Netzwerk-Tab-Zählung — im Leerlauf ≤2
Requests/30 s pro View statt 1/3–5 s; Änderung (Workflow-Start,
Host-Registrierung) erscheint <1 s ohne Poll; künstlicher
Event-Sturm (>16 Events Burst) führt zu genau einem Voll-Reload
statt stumm fehlender Zeilen.

### S3 — Remote-Parität für Instanzen (behebt B2; K7-Folgearbeit)

**Ziel:** Host-Agent meldet Prozessende als NATS-Event
(`omp.host.<hostId>.events`, `{instanceId, exitCode, stderrTail}`);
Orchestrator-Launcher behandelt es wie ein lokales `supervise`-Ende
(gleiche Crash-Loop-Bremse, gleiches `instance.restarted`-Event,
Neustart als Remote-Start-Kommando). Außerdem `extraEnv` remote
erlauben — **nicht** frei, sondern als Allowlist im Host-Agent
(zunächst nur `OMP_WIDTH`/`OMP_HEIGHT`), damit die dokumentierte
Sicherheitsgrenze (Agent-Katalog entscheidet, was läuft) intakt
bleibt. `workflows.rewireAfterRestart` muss unverändert greifen.
**Verifikation:** Zweit-„Host" als lokaler zweiter Agent-Prozess
(bestehendes D6-Testmuster); `kill -9` einer Remote-Instanz →
Auto-Restart + Rewire + UI-Zähler wie lokal; Workflow mit Auflösung
auf Remote-Rolle → NMOS-Registry zeigt die Auflösung (Kapitel-15-
Verifikationsmuster); nicht-gelistete Env-Var wird vom Agent
abgelehnt (Test).

### S4 — Launcher-Zustand + Instanz-Inventar nach Postgres (behebt A4 teilweise)

**Ziel:** `data/instances.json` durch eine `instances`-Tabelle
ersetzen (Migration `0005`), Läufer bleibt derselbe (Restart-Recovery
liest DB statt Datei). JWT-Secret-Handling unverändert lassen (per
Env-File bereits deployment-fähig), aber im `HANDBUCH.md`
dokumentieren, dass Produktions-Deployments
`OMP_AUTH_JWT_SECRET_FILE` setzen müssen.
**Verifikation:** bestehende Launcher-Restart-Persistenz-Tests auf
DB umgestellt und grün; live: Instanz starten → Orchestrator
neu starten → Instanz wird wieder adoptiert (heutiges Verhalten,
neue Quelle).

### S5 — Audit-Retention + Pagination (behebt A5, D5-Teil)

**Ziel:** `GET /api/v1/admin/audit-log?before=<id>&limit=` (Cursor
über `id`, Index existiert via BIGSERIAL PK); Retention als
Startup-+ täglicher Job (`DELETE ... WHERE occurred_at < now() -
interval`), Dauer per Env (`OMP_AUDIT_RETENTION_DAYS`, Default 90).
Admin-UI: „Mehr laden"-Button statt festem 200er-Fenster.
**Verifikation:** Handler-Tests für Cursor-Ränder; live: >200
Einträge erzeugen, Blättern per UI; Retention mit künstlich alten
Zeilen (SQL-Update) live prüfen.

### S6 — Workflow-Kontext in Shell + Rechte (behebt C2, D3; = Kapitel-12-Einstieg)

Kein neuer Entwurf — Kapitel 12 umsetzen, beginnend mit dessen
eigenem Teil 1, aber mit diesem Review als Dringlichkeits-Begründung:
Workflow-Auswahl in der App-Bar, Flow-Editor-Filter auf die Nodes
des gewählten Workflows (globale Sicht bleibt als „Alle" wählbar),
Konsolen-Route `/console/<workflowId>/…` real statt „default".
Workflow-Scope im Rollenmodell (K11-Teil-4/K12-Teil-4) erst danach.
**Verifikation:** laut Kapitel 12; zusätzlich Zwei-Workflows-Szenario:
zwei laufende Workflows, Editor-Filter zeigt jeweils nur die eigenen
Rollen-Instanzen.

### S7 — Remote-Zugriff dokumentiert absichern (behebt C3)

**Ziel:** kein Code, sondern Deployment: `deploy/dev/Caddyfile`
(oder nginx-Snippet) mit TLS-Terminierung + SSE-tauglicher
Durchleitung, `HANDBUCH.md`-Abschnitt „Remote-Zugriff/Reverse-Proxy"
(inkl. Hinweis: Bearer-Token + `?access_token=` setzen HTTPS voraus;
Orchestrator selbst bleibt hinter dem Proxy Klartext). Optional
kleiner Code-Beitrag: `X-Forwarded-*`-Verträglichkeit prüfen.
**Verifikation:** lokal Caddy mit self-signed vor Port 8000, Login +
SSE + Node-UI-Bundle über https://localhost funktionieren per CDP.

### S8 — Metrics-Endpunkt + Soak-Grundlage (behebt B4; Vorarbeit Kapitel 14)

**Ziel:** `/metrics` im Prometheus-Textformat **handgeschrieben**
(Minimal-Dependency-Regel §0 Punkt 5 — das Format ist trivial, kein
Client-Library-Zwang): Go-Runtime (goroutines, heap, GC), Registry-
(Nodes online/gesamt, Poll-Dauer), SSE-Clients+Drops, Launcher
(Instanzen, Restarts), HTTP-Request-Zähler. Dazu `make soak`:
Skript startet den Stack + 2 Nodes und sammelt `/metrics` alle 60 s
in eine CSV; Abbruchkriterium dokumentieren (Heap/Goroutines
monoton steigend über N Stunden = Befund).
**Verifikation:** `curl /metrics` well-formed (promtool nur falls
vorhanden, sonst Formatprüfung im Test); 1-h-Soak lokal ohne
monotonen Anstieg.

### S9 — Backup/Restore (behebt B1-Teilaspekt)

**Ziel:** `deploy/dev/backup-omp.sh` (`pg_dump` in
`.backups/<timestamp>.sql.gz`, Rotation N=14) +
`restore-omp.sh <file>` (mit Sicherheitsabfrage, Orchestrator muss
gestoppt sein) + `HANDBUCH.md`-Abschnitt. **Ein Restore wird im
Zuge des Schritts einmal wirklich durchgeführt** (Backup → Nutzer
anlegen → Restore → Nutzer wieder weg) — ein nie getesteter Restore
ist keiner.
**Verifikation:** genau dieser Rundlauf, dokumentiert.

### S10 — UI-Baustein-Konsolidierung (behebt D2, D4, D6-Teil)

**Ziel:** `<omp-toast>` + `<omp-confirm>` in `ui/kit` (Stil aus
`flow-canvas.ts`-Toasts extrahieren), alle `alert()`/`confirm()`
ersetzen (`workflows-view`, `admin-view`); Rollenbindungs-Löschen
bekommt Confirm; `ui/index.html` `lang="de"`; Sprachdurchsicht der
Shell-Texte (eine Sprache, Deutsch). Kein Framework, keine
i18n-Infrastruktur.
**Verifikation:** CDP-Klicktest aller ersetzten Pfade inkl.
Fehlerfall (Orchestrator gestoppt → Toast statt alert).

### Reihenfolge-Empfehlung und was bewusst NICHT ansteht

Empfohlen: **S1 → S2 → S3** (größte Wirkung auf Skalierung+24/7,
unabhängig), dann **S5/S9/S10** (klein, hygienisch), dann **S4**,
dann **S6** (größter Brocken, eigener Kapitel-12-Strang), **S7/S8**
nach Bedarf dazwischen. Ausdrücklich **nicht** aus diesem Review
heraus starten: Control-Plane-HA (§19 — erst wenn ein echter zweiter
Standort/Betriebsdruck existiert), Genlock-Redundanz (§20.1/§21.3 —
Nutzer-Grundsatzentscheidung offen), MXL-Fabrics (Kapitel 16 —
Grundsatzentscheidung 16.5.1 offen), Microservice-Import (§17
Teil 4/5), KI-Dienst-Node (C4 — erst als Kapitel konzipieren, wenn
konkret gewünscht).
