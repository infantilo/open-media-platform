# Vertrag „Mischer einrichten“ (Audio- und Bildmischer)

Stand: 2026-11-05. Dieser Vertrag beschreibt, **was die Plattform von einem Bild- oder Tonmischer erwartet**, damit die
Playout-Automation ihn aus den Vorgaben eines Channels einrichten kann und er Workflow-Stopp/-Start übersteht — unabhängig
davon, wer den Mischer herstellt. `omp-audio-mixer` und `omp-video-mixer-me` sind Implementierungen; ein Mischer eines
anderen Herstellers (auch über einen kleinen Adapter-Node) erfüllt dieselben Punkte und ersetzt unseren, ohne dass die
Automation oder der Orchestrator geändert werden. Muster wie in `docs/CONTRACT-INTERCOM.md`.

Alle Aufrufe laufen über den Node-Proxy des Orchestrators (`/api/v1/nodes/{nodeId}/params/<name>`,
`/api/v1/nodes/{nodeId}/methods/<name>`); Parameter und Methoden stehen im `descriptor.json` des Nodes.

## 1. Was die Automation tut

Ist in der Automation ein Mischer als Ziel gesetzt (`targetAudioMixerLabel`, `targetMixerLabel`), kann sie ihn einrichten:
von Hand (Methode `setupMixers`, Knopf „Mischer jetzt einrichten“) oder automatisch, sobald Mischer und beide Player
verbunden sind (Parameter `mixerAutoSetup`, Standard aus; Umgebungsvariable `OMP_PLAYOUT_MIXER_AUTO_SETUP=1`).

Das Einrichten ist **rein additiv und wiederholbar**: Es fügt nur hinzu, was fehlt. Vorhandene Kanäle und angeheftete
Quellen bleiben unverändert, nichts wird gelöscht oder umbenannt, ein zweiter Lauf ändert nichts.

- **Tonmischer:** je Player × Ausgabegruppe des Channels ein Kanal. Name `<Player> <Gruppenname>`, Quelle = der Gruppen-
  Sender des Players, „Audio folgt Video“ auf diesen Player (hart). Ein Kanal gilt als vorhanden, wenn schon ein Kanal diese
  Quelle nutzt **oder** der Name vergeben ist.
- **Bildmischer:** der Video-Sender jedes Players wird angeheftet (Tasten für PGM/PST), sofern nicht schon angeheftet.

## 2. Vorgaben des Channels (Quelle der Wahrheit)

`GET /api/v1/audio-rules/channel/{channelId}` (ohne eigenes Dokument des Channels der Plattform-Standard
`GET /api/v1/audio-rules`) liefert `outputProfile.groups[]` mit `label` und `tags` (z. B. `role:pt`). Jede Gruppe mit Tags ist
ein Programm (Programmton, Hörfilm, Originalton, Dolby E, 5.1 …). Gruppen ohne Tags werden übersprungen.

## 3. Was Player (Quellen) bieten

- Je Ausgabegruppe ein **Audio-Sender** (`format = urn:x-nmos:format:audio`) mit den Gruppen-Tags in `discovered_tags`
  (Schreibweise mit Punkt: `role.pt`). Zuordnung Gruppe → Sender: der Sender, der **alle** Tags der Gruppe trägt.
- Ein **Video-Sender** (`format = urn:x-nmos:format:video`) je Player.
- Sender-IDs dürfen sich bei jedem Start ändern; für die Zustandssicherung (§5) zählen Rollenname und Position in der Sender-Liste.

## 4. Was ein Mischer bieten muss

### Tonmischer

| Element | Art | Bedeutung |
|---|---|---|
| `mixState` | Parameter (lesbar) | JSON (Objekt oder als String): `channels[]` mit mindestens `id`, `label`, `source` (Sender-ID oder leer) |
| `addChannel` | Methode `{label}` | legt einen Kanal an; die ID vergibt der Mischer (die Automation findet ihn über den eindeutigen Namen wieder) |
| `channel.<id>.setSource` | Methode `{senderId}` | Quelle des Kanals |
| `channel.<id>.setFollow` | Methode `{targetNodeId, mode}` | „Audio folgt Video“: Kanal öffnet, wenn der Node `targetNodeId` im Programm des Bildmischers ist; `mode` = `off`, `cut` (hart) oder `crossfade` |
| `setVideoContext` | Methode `{source, active, takeAt, giver}` | Quelle ist im Programm / nicht mehr; `takeAt` = TAI-Zeitpunkt in ns (sample-genau schalten), `giver` = Bildmischer-Node |
| `setSourceContext` | Methode | semantische Zuordnung über Tags (optional) |

### Bildmischer

| Element | Art | Bedeutung |
|---|---|---|
| `crosspoint.pinnedSenderIds` | Parameter (lesbar) | angeheftete Quellen als JSON-Array von Sender-IDs |
| `crosspoint.pin` | Methode `{senderId}` | heftet eine Quelle an (doppelt = nichts) |
| `crosspoint.select`/`cut`/`take`/`autoTrans` | Methoden | Vorschau wählen, hart schneiden, Übergang |

Mehrere M/E-Ebenen tragen ein Präfix je Ebene (`crosspoint.…` für Ebene 1).

## 5. Zustand übersteht Workflow-Stopp/-Start

Der Orchestrator sichert den Bedienzustand jeder Workflow-Rolle (Stopp, alle 60 s, beim Speichern des Workflows) und spielt
ihn nach dem Start zurück. Ein Mischer macht das mit, wenn er **eines** von beiden bietet:

1. **`GET /state` und `POST /state`** (bevorzugt): `GET` liefert ein JSON-Dokument mit dem gesamten Bedienzustand, `POST`
   nimmt genau dieses Dokument wieder an (`{"ok":true}`). Sender- und Node-IDs im Dokument dürfen vorkommen: Der Orchestrator
   ersetzt sie vor dem Speichern durch stabile Platzhalter und löst sie nach dem Start gegen die neuen IDs auf (schemafrei,
   jedes JSON-Feld, das genau eine ID enthält).
2. Ohne `/state`: alle **schreibbaren Parameter** des Descriptors werden einzeln gelesen (`GET …/params/<name>`) und
   zurückgeschrieben (`PATCH`).

Wichtig für `POST /state`: Alles, was der Orchestrator zurückliest, muss unter denselben Pfaden stehen wie gesendet, soweit es
Sender-/Node-IDs betrifft. Zusätzliche vom Node ergänzte Felder sind unschädlich. Ist ein Zustand noch nicht zurückgespielt,
sichert der Orchestrator den (leeren) Ist-Stand **nicht** über den guten; der Merker steht im gespeicherten Eintrag und
übersteht auch einen Neustart des Orchestrators.

## 6. Prüfen

1. Workflow mit Player A/B, Mischer und Automation anlegen, in der Automation das Mischer-Ziel setzen.
2. Knopf „Mischer jetzt einrichten“: im Tonmischer erscheint je Player × Programm ein Kanal, im Bildmischer sind beide
   Player angeheftet. Zweiter Klick: keine Änderung.
3. Programm des Bildmischers zwischen den Playern wechseln: der Kanal des Players im Bild öffnet, der andere schließt.
4. Einstellung ändern, Workflow stoppen und starten: Einstellung ist wieder da.
