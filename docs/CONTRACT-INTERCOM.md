# Vertrag „Intercom“ (Diensttyp `intercom`)

Stand: Kapitel 49 (2026-10-22). Dieser Vertrag beschreibt, **was die Plattform von einem Intercom erwartet** — unabhängig davon,
wer es herstellt. Unser Node `omp-intercom` ist eine Implementierung; ein Intercom einer anderen Firma kann dieselbe
Schnittstelle bedienen (direkt oder über einen kleinen Adapter-Node) und ersetzt unseres, ohne dass Orchestrator oder Shell
geändert werden. Dasselbe Muster gilt für jede weitere Fachfunktion (Bildmischer, Tonmischer, …): Typ + Rollen + Prüfwerkzeug.

## 1. Aufbau

Ein Intercom ist ein **Dienst in einem Node** (ARCHITECTURE §28.5, `docs/MODULE-SCHREIBEN.md` §7). Der Node meldet sich wie jeder
Node bei der NMOS-Registry und bietet zusätzlich ein **Dienst-Manifest** (`GET /service.json`, ohne Anmeldung) an. Das
Dienst-Gateway des Orchestrators (`/api/v1/ext/<dienst>/…`) prüft Anmeldung und Funktionsrecht und leitet an den Node weiter.

Pflicht im Manifest: `"kind": "intercom"`, Name (`[a-z0-9-]`, frei wählbar — er erscheint nirgends fest im Plattform-Code),
Funktionsrechte mit Präfix `<name>.` und die Routen mit **Rollen** (§2).

## 2. Rollen

| Rolle | Methode, Pfad (Beispiel) | Pflicht | Bedeutung |
|---|---|---|---|
| `panels` | `GET /panels` | ja | Sprechstellen, die die anfragende Person öffnen darf |
| `status` | `GET /status` | ja | Betriebszustand (wer ist online) |
| `deck.state` | `GET /deck/{party}` | nein | Zustand **einer** Sprechstelle für Anzeigen/Stream Deck |
| `deck.command` | `POST /deck/{party}/command` | nein | Befehl an eine Sprechstelle |

Die Pfade wählt die Implementierung; maßgeblich sind Rolle, Methode und die Anzahl der Platzhalter (`{party}` = Teilnehmer-ID).
Clients finden die Route über `GET /api/v1/ext` (Typ `intercom`, `roles`), nie über einen festen Pfad oder Namen.

### Formen (Pflichtfelder; weitere Felder sind erlaubt)

* `panels`: `{"panels":[{"party_id":1,"name":"Regie 1","url":"https://…/panel?token=…"}]}` — `url` öffnet die Sprechstelle im
  Browser (Mikrofon: HTTPS oder `localhost`). Die Liste enthält nur Sprechstellen, die die Person öffnen darf.
* `status`: `{"parties":[{"id":1,"name":"Regie 1","online":true}]}`.
* `deck.state`: `{"me":{"id":1,"muted":false,"forced":false,"force":false,"dnd":false},"channels":[{"id":1,"name":"Regie",
  "talk_allowed":true,"talk":false,"listen":true,"listen_on":true,"level":1.0,"speakers":[2]}],"parties":[{"id":2,"name":"Kamera",
  "online":true,"speaking":false,"dnd":false}]}`.
* `deck.command`: Körper = ein Befehl als JSON-Objekt mit Feld `t`: `talk {ch,on}`, `listen {ch,on}`, `level {ch,v}` (0…1,5),
  `pan {ch,v}` (−1…1), `solo {ch,on}`, `mute {on}`, `dnd {on}`, `call {to:[id…]|"all",on}`.
* Rechte: `deck.*` nur für Sprechstellen, die die Person bedienen darf (eigene bzw. mit Administrationsrecht alle).

## 3. Sicherheit (gilt für jeden Dienst)

* Der Node nimmt **Dienst-Routen nur mit dem Dienst-Token** an (`X-OMP-Service-Token`, Wert aus `OMP_SERVICE_TOKEN`, vom
  Orchestrator beim Start gesetzt); ohne Token 401/403.
* Identität kommt als Header des Gateways (`X-OMP-User`, `-Groups`, `-Features`, `-Request-Host`, `-Node-Base`) und gilt nur mit
  gültigem Token. Ein Client kann sie nie selbst setzen.
* Audit: Antwort-Header `X-OMP-Audit` (URL-kodiertes JSON `{object, action, details}`); das Gateway schreibt den Eintrag.

## 4. Oberfläche

Der Dienst bringt seine Bedienoberflächen **selbst** mit (Manifest `ui`/`tiles`, `bundle` ohne führenden `/` = Datei des Dienstes
unter `<base>/ui/<datei>`, vom Gateway als `/api/v1/ext/<name>/_ui/<datei>` ausgeliefert):

* Admin-Tab (Einrichtung), Kachel der Operator-Konsole: ESM-Bundles, die ein Custom Element registrieren und die Host-Schnittstelle
  der Shell nutzen (`globalThis.__omp`: `t`, `apiFetch`, `showToast`, …; `ui/modules/host.ts`).
* Stream Deck: das Element der Node-Oberfläche (`/ui/bundle.js`) stellt die Eigenschaft `streamDeck` bereit
  (`ui/shell/streamdeck/adapter.ts`). Unsere Implementierung: `ui/modules/intercom/panel.ts`.

## 5. Weitere Erwartungen an ein Intercom (außerhalb des Dienstmanifests)

* **On Air:** schreibbarer Node-Parameter `onAir` (boolean) über die generische Parameter-API; dazu optional der Tally-Bus.
* **Programmton/Anbindung:** MXL/IS-05 wie jeder Medien-Node (Sender/Receiver in der Registry).
* **Metriken:** `metrics` im Manifest (Prometheus-Textformat) — empfohlen: `omp_intercom_parties`, `omp_intercom_late_ticks_total`.
* **Daten:** der Dienst hält seine Konfiguration selbst; mit `backup`/`import` im Manifest sorgt das Gateway für Sicherungskopie
  und Wiederherstellung in der Datenbank des Orchestrators (optional).

## 6. Prüfen

```
cd orchestrator
go run ./cmd/serviceconformance -node http://<node>:<port> -token <Dienst-Token> [-party <id>] [-mutate]
```

prüft Manifest und Vertrag, die Form der Antworten, dass jede Route ohne Token gesperrt ist, dass unbekannte Routen 404 liefern
und dass die Oberfläche ausgeliefert wird. Eine Implementierung gilt als vertragstreu, wenn alle Prüfungen bestehen. Dieselben
Prüfungen laufen beim Entdecken im Gateway (ein Manifest, das den Vertrag verletzt, wird nicht übernommen).

## 7. Ein anderes Produkt einsetzen (Ablauf)

1. Adapter-Node (oder Produkt mit eigener Schnittstelle) implementiert Manifest und Rollen; Funktionsrechte `<name>.use`/`.admin`.
2. `serviceconformance` besteht.
3. Den Node im Katalog eintragen und unseren `omp-intercom` nicht starten (oder stoppen). Rechte, Tabs, Kacheln und Stream Deck
   folgen dem neuen Dienst; bestehende Rechtevergaben auf `intercom.*` müssen auf die neuen IDs (`<name>.*`) übertragen werden.
