# Fehlercodes

<!-- GENERIERT aus orchestrator/internal/errcodes/catalog.go — nicht von Hand ändern: `cd orchestrator && go run ./cmd/errcodedoc > ../docs/FEHLERCODES.md` -->

Jeder bekannte Fehler hat einen stabilen Code **OMP-nnnn**. Die Oberfläche zeigt ihn mit Ursache und Lösungsschritten an
(Administration → Diagnose, Support, Node-Diagnose 🩺, Startdialog). Dieselbe Liste liegt im Support-Paket (`api/errorcodes.json`).
Meldungen lassen sich auch selbst mit einem Code versehen: eine Meldung mit `[OMP-3001]` wird direkt zugeordnet.

## 1xxx — Plattform und Rechner

### OMP-1001

**Datenbank nicht erreichbar** — Fehler

**Ursache:** Der Orchestrator erreicht die PostgreSQL-Datenbank nicht. Ohne sie gehen Anmeldung, Workflows, Protokolle und Zeitleiste nicht.

**Was tun?**

1. Prüfen, ob PostgreSQL (bzw. Patroni) läuft: „make status“ oder der Dienst des Datenbank-Containers.
2. Adresse und Passwort in OMP_POSTGRES_URL prüfen.
3. Bei einem Patroni-Verbund: nur der Primary nimmt Schreibzugriffe an — „patronictl list“ zeigt ihn.
4. Danach den Orchestrator neu starten.

### OMP-1002

**Nachrichtenbus (NATS) nicht erreichbar** — Fehler

**Ursache:** Der Orchestrator oder ein Node erreicht NATS nicht. Telemetrie, Host-Kommandos und Ereignisse bleiben aus.

**Was tun?**

1. Prüfen, ob die NATS-Container laufen (Port 4222).
2. OMP_NATS_URL (und bei TLS die Zertifikate) prüfen.
3. Der Orchestrator verbindet sich selbst wieder, sobald NATS erreichbar ist; Nodes ggf. neu starten.

### OMP-1003

**NMOS-Registry nicht erreichbar** — Fehler

**Ursache:** Die Registry, bei der sich alle Nodes anmelden, antwortet nicht. Neue Nodes erscheinen nicht, der Graph bleibt leer oder veraltet.

**Was tun?**

1. Prüfen, ob der Registry-Container läuft (Port 8010/8011).
2. OMP_REGISTRY_URL prüfen.
3. Nodes melden sich nach dem Neustart der Registry selbst wieder an (bis zu einer Minute).

### OMP-1004

**Cluster ohne Mehrheit** — Fehler

**Ursache:** Zu wenige Orchestratoren sind erreichbar, um einen Leader zu wählen. Automatik, Failover und Zeitplan stehen.

**Was tun?**

1. Den Partner-Orchestrator wieder starten oder erreichbar machen.
2. Läuft dauerhaft nur einer: Administration → Cluster → Notausgang (nur wenn der Partner wirklich aus ist).
3. Auf Dauer einen Raft-Zeugen als dritte Stimme betreiben.

### OMP-1005

**Speicherplatz voll** — Fehler

**Ursache:** Auf dem Rechner ist kein Platz mehr. Aufnahmen, Datenbank und Protokolle können nicht mehr schreiben.

**Was tun?**

1. Administration → Support zeigt, welche Platte voll ist.
2. Alte Aufnahmen, Sicherungen und Update-Pakete löschen.
3. Dauerhaft: Platte vergrößern oder Aufbewahrungsfristen verkürzen (Administration → Einstellungen).

### OMP-1006

**Zugriff vom Betriebssystem verweigert** — Fehler

**Ursache:** Der Prozess darf eine Datei, ein Verzeichnis oder eine Funktion nicht benutzen.

**Was tun?**

1. Im Log steht der Pfad: Besitzer und Rechte prüfen (ls -l).
2. Der Dienst läuft unter einem eigenen Benutzer — diesem das Verzeichnis zugänglich machen.
3. Für Uhr stellen und Echtzeit sind besondere Rechte nötig; sie fehlen in Containern (siehe OMP-5002).

### OMP-1007

**Port schon belegt** — Fehler

**Ursache:** Ein anderer Prozess benutzt die Adresse, die dieser Dienst öffnen will — oft eine Altinstanz, die nicht beendet wurde.

**Was tun?**

1. Mit „ss -ltnp“ nachsehen, wer den Port hält.
2. Die Altinstanz beenden (unter Instanzen oder per Prozess).
3. Dann den Dienst neu starten.

### OMP-1008

**Einstellung fehlt oder ist ungültig** — Fehler

**Ursache:** Eine Umgebungsvariable (OMP_…) oder ein Wert in der Konfiguration hat ein falsches Format oder fehlt. Der Dienst startet deshalb nicht oder ohne diese Funktion.

**Was tun?**

1. Die Meldung nennt die Einstellung — Wert und Format prüfen (Administration → Einstellungen oder die Umgebung des Dienstes).
2. Den Dienst danach neu starten.

### OMP-1013

**Wert ungewöhnlich hoch für diese Tageszeit** — Hinweis

**Ursache:** Der Wert liegt deutlich über dem, was zur selben Tageszeit an den Tagen davor üblich war. Das System ist nicht ausgefallen, verhält sich aber anders als sonst.

**Was tun?**

1. Prüfen, ob sich etwas geändert hat: neue Instanzen, ein Workflow, ein Update (Administration → Zeitleiste zeigt, was zu dieser Zeit geschah).
2. Die Diagnose (🩺) der Instanzen auf diesem Host zeigt, welche Last verursacht.
3. Ist die Last gewollt (z. B. neue Produktion), ist nichts zu tun — die Baseline passt sich nach einigen Tagen an.

### OMP-1014

**Verbrauch wächst stetig (mögliches Leck)** — Hinweis

**Ursache:** Speicher, offene Dateien oder Threads steigen seit Stunden gleichmäßig an, ohne wieder zu fallen. So sieht ein Leck aus: früher oder später ist die Grenze erreicht und der Prozess stürzt ab.

**Was tun?**

1. Den betroffenen Prozess zu einem ruhigen Zeitpunkt neu starten (nicht während einer Sendung) — das setzt den Verbrauch zurück.
2. Wächst er danach wieder: Administration → Support → Support-Paket erstellen und senden, damit der Fehler gefunden werden kann.
3. Die Hochrechnung im Befund zeigt, wie viel Zeit bleibt.

### OMP-1010

**Arbeitsspeicher knapp** — Hinweis

**Ursache:** Der Rechner hat fast keinen freien Arbeitsspeicher mehr; das System beendet Prozesse.

**Was tun?**

1. Nicht benötigte Instanzen stoppen.
2. Instanzen auf andere Hosts verteilen (Scheduler → Platzierung).
3. Wächst der Verbrauch dauernd, ist es ein Speicherleck: Node neu starten und das Support-Paket senden.

### OMP-1011

**Zu viele offene Dateien** — Hinweis

**Ursache:** Der Prozess hat die erlaubte Zahl offener Dateien und Verbindungen fast oder ganz erreicht. Meist ein Leck.

**Was tun?**

1. Den Node neu starten.
2. Das Limit (LimitNOFILE) des Dienstes erhöhen.
3. Steigt die Zahl wieder, das Support-Paket senden.

### OMP-1012

**Prozessor überlastet** — Hinweis

**Ursache:** Der Rechner oder ein einzelner Prozess ist voll ausgelastet; Bild und Ton können aussetzen.

**Was tun?**

1. Auflösung oder Bildrate senken.
2. Instanzen auf andere Hosts verteilen.
3. Rechenintensive Aufgaben (ffmpeg-Jobs) nicht während der Sendung starten.

## 2xxx — Nodes und Instanzen

### OMP-2012

**Container-Laufzeit meldet einen Fehler** — Fehler

**Ursache:** Podman konnte einen Container nicht beobachten oder beenden. Der Node läuft möglicherweise weiter oder ist halb beendet.

**Was tun?**

1. Mit „podman ps -a“ nachsehen, ob der Container noch läuft.
2. Einen hängenden Container mit „podman rm -f <Name>“ entfernen.
3. Dann die Instanz neu starten.

### OMP-2013

**Umzug oder Neustart gescheitert** — Fehler

**Ursache:** Beim Umzug auf einen anderen Host oder beim Neustart mit neuer Version ist etwas schiefgegangen. Das System ist, wenn möglich, auf den bisherigen Stand zurückgegangen.

**Was tun?**

1. Unter Instanzen prüfen, ob die Instanz läuft — meist läuft sie auf dem bisherigen Host weiter.
2. Steht „Rücksprung gescheitert“ in der Meldung: Instanz von Hand neu starten.
3. Zielhost prüfen (online, Platz, Programm vorhanden) und den Umzug wiederholen.

### OMP-2002

**Container-Image nicht vorhanden** — Fehler

**Ursache:** Der Node läuft als Container, sein Image gibt es auf diesem Rechner nicht und kann auch nicht geladen werden.

**Was tun?**

1. Das Image bauen oder laden (Name steht in der Meldung), z. B. „podman build“.
2. Katalogeintrag prüfen: stimmt der Image-Name?
3. Ist der Node nicht nötig, einen anderen Typ verwenden.

### OMP-2003

**Programmdatei des Nodes fehlt** — Fehler

**Ursache:** Die Datei, die den Node starten soll, gibt es nicht oder ist nicht ausführbar.

**Was tun?**

1. Die Nodes bauen: „cargo build --release“ im Ordner nodes/ (bzw. „make nodes“).
2. Pfad des Katalogeintrags und Ausführungsrecht prüfen.
3. Bei Remote-Hosts: Die Datei muss auf diesem Host liegen.

### OMP-2004

**Prozess abgestürzt** — Fehler

**Ursache:** Der Node-Prozess hat sich unerwartet beendet. Der Orchestrator startet ihn automatisch neu, gibt aber nach mehreren Abstürzen in kurzer Zeit auf.

**Was tun?**

1. Unter Instanzen steht die letzte Fehlermeldung des Prozesses.
2. Instanz neu starten.
3. Stürzt sie wieder ab: Administration → Support → Support-Paket erstellen und senden.
4. Die Diagnose (🩺 an der Kachel) zeigt den Zustand der Pipeline.

### OMP-2005

**Node hat sich nicht rechtzeitig angemeldet** — Fehler

**Ursache:** Der Prozess läuft, meldete sich aber nicht bei der Registry (Rechner ausgelastet, Registry nicht erreichbar oder Fehler beim Start).

**Was tun?**

1. Auslastung des Hosts prüfen (Administration → Support).
2. Erreichbarkeit der Registry prüfen (OMP-1003).
3. Log der Instanz ansehen (Diagnose), dann neu starten.

### OMP-2007

**Gespeicherter Zustand einer Rolle nicht wiederhergestellt** — Hinweis

**Ursache:** Nach einem Neustart konnte der gespeicherte Bedienzustand (z. B. Quellenwahl) nicht zurückgespielt werden.

**Was tun?**

1. Nichts tun: der Zustand bleibt erhalten und wird automatisch erneut versucht.
2. Erst nach mehreren Fehlversuchen wird er freigegeben — dann die Quellen von Hand neu wählen.

### OMP-2008

**Ungültige Einstellung** — Fehler

**Ursache:** Ein Wert im Startdialog oder in den Einstellungen liegt außerhalb des erlaubten Bereichs. Es wurde nichts gestartet.

**Was tun?**

1. Den genannten Wert korrigieren (Bereich steht in der Meldung).
2. Leeres Feld = Standardwert des Node-Typs.

### OMP-2009

**Instanz startet wiederholt neu** — Hinweis

**Ursache:** Der Prozess endet immer wieder von selbst und wird automatisch neu gestartet. Das ist instabil.

**Was tun?**

1. Ursache unter Administration → Diagnose suchen (Meldungen dieses Nodes).
2. Die Diagnose an der Kachel (🩺) zeigt Pipeline und Meldungen.
3. Support-Paket erstellen und senden.

### OMP-2010

**Läuft mit alter Version** — Hinweis

**Ursache:** Das Programm wurde seit dem Start durch ein Update ersetzt; die Instanz läuft noch mit dem alten Stand.

**Was tun?**

1. Neu starten, wenn es der Betrieb erlaubt — nicht während einer Sendung.

### OMP-2011

**Host nicht verfügbar** — Fehler

**Ursache:** Der gewählte Host ist offline, im Wartungsmodus oder dem Orchestrator unbekannt.

**Was tun?**

1. Unter Hosts prüfen, ob der Host online ist (OMP-5001).
2. Wartungsmodus beenden oder einen anderen Host wählen.

### OMP-2014

**Host kann diesen Node-Typ nicht ausführen** — Fehler

**Ursache:** Der Host-Agent kennt den Node-Typ nicht oder kann seine Ausführungsart (z. B. Container mit Podman) nicht bedienen.

**Was tun?**

1. Einen anderen Host wählen (Startdialog → Host) oder den Node lokal starten.
2. Katalog des Host-Agents (catalog.json) prüfen: Eintrag und Programm müssen auf diesem Host vorhanden sein.
3. Container-Nodes brauchen einen Host-Agent mit Podman-Unterstützung (neuere Version).

### OMP-2001

**Node nicht erreichbar** — Fehler

**Ursache:** Der Orchestrator erreicht den Node nicht (beendet, gerade gestartet, umgezogen oder überlastet). Nach Stop, Start oder Umzug ist das kurz normal.

**Was tun?**

1. Unter Instanzen prüfen, ob der Prozess läuft; sonst neu starten.
2. Bleibt es bestehen: Auslastung des Hosts prüfen und die Diagnose (🩺) öffnen.
3. Bei einem Node auf einem Remote-Host auch dessen Host-Agent prüfen (OMP-5001).

## 3xxx — Medien und Pipeline

### OMP-3001

**Medien-Flow nicht vorhanden** — Fehler

**Ursache:** Ein Node will einen Flow lesen, den die Quelle (noch) nicht schreibt. Meist wurde der Leser vor der Quelle gestartet oder die Quelle ist ausgefallen.

**Was tun?**

1. Die Quelle prüfen: läuft sie und liefert sie Bild (🩺 an ihrer Kachel)?
2. Reihenfolge beim Start: erst die Quellen, dann Mischer und Viewer.
3. Der Leser versucht es selbst erneut; hilft das nicht, den Leser neu starten.

### OMP-3002

**Austauschspeicher /dev/shm voll oder nicht beschreibbar** — Hinweis

**Ursache:** Über /dev/shm tauschen die Nodes Videobilder aus. Ist er voll, bleibt das Bild stehen.

**Was tun?**

1. Verwaiste Flows unter /dev/shm/omp-mxl entfernen (vorher die Nodes stoppen).
2. /dev/shm vergrößern (Mount-Option size=).
3. Danach die Nodes neu starten.

### OMP-3009

**GStreamer-Baustein oder Plugin fehlt** — Fehler

**Ursache:** Die Pipeline braucht einen Baustein, den GStreamer auf diesem Rechner nicht kennt — ein Plugin-Paket ist nicht installiert.

**Was tun?**

1. Der Name des Bausteins steht in der Meldung („x264enc“, „videoconvert“ …).
2. Mit „gst-inspect-1.0 <Name>“ prüfen und das passende Paket nachinstallieren (z. B. gstreamer1.0-plugins-ugly für x264).
3. Danach den Node neu starten.

### OMP-3010

**Schreiben in den Medien-Austausch fehlgeschlagen** — Fehler

**Ursache:** Der Node kann ein Bild nicht in den Austauschspeicher (MXL) schreiben — meist ist /dev/shm voll oder der Flow wurde von außen entfernt.

**Was tun?**

1. Administration → Support: Ist /dev/shm voll (OMP-3002)?
2. Verwaiste Flows entfernen und den Node neu starten.

### OMP-3003

**Bildformat nicht aushandelbar** — Fehler

**Ursache:** Zwei Bausteine einigen sich nicht auf ein gemeinsames Format (Auflösung, Bildrate, Pixelformat).

**Was tun?**

1. Auflösung und Bildrate von Quelle und Ziel vergleichen und angleichen.
2. Einen Scaler dazwischenschalten.
3. Meldung und Format im Support-Paket senden, wenn beide gleich eingestellt sind.

### OMP-3004

**Fehler in der Medien-Pipeline** — Fehler

**Ursache:** Ein Baustein der Pipeline meldet einen Fehler im Datenstrom; die Verarbeitung steht oder ist gestört.

**Was tun?**

1. Die Diagnose (🩺 an der Kachel) zeigt, welcher Baustein in welchem Zustand ist.
2. Den Node neu starten.
3. Kommt es wieder: Support-Paket erstellen und senden.

### OMP-3005

**Eingabegerät nicht verfügbar** — Fehler

**Ursache:** Die Karte oder Kamera fehlt, ist von einem anderen Programm belegt oder der Treiber ist nicht geladen.

**Was tun?**

1. Gerät und Kabel prüfen; Treiber geladen?
2. Ein anderes Programm (oder eine zweite Instanz) belegt das Gerät: beenden.
3. Unter Hosts zeigt das Inventar die erkannten I/O-Ports.

### OMP-3006

**Kein Bild oder Ton von der Quelle** — Fehler

**Ursache:** Der Node läuft, bekommt von der verbundenen Quelle aber keine Daten — oder liefert selbst keine.

**Was tun?**

1. Die Quelle davor prüfen (🩺 an ihrer Kachel): läuft sie, liefert sie Bild?
2. Die Verbindung im Flow Editor prüfen.
3. Hilft das nicht, den Node neu starten.

### OMP-3007

**Bildrate eingebrochen** — Hinweis

**Ursache:** Der Node liefert deutlich weniger Bilder pro Sekunde als sonst — meist Überlastung.

**Was tun?**

1. Last des Hosts prüfen (Administration → Support).
2. Instanzen auf andere Hosts verteilen.
3. Auflösung oder Bildrate senken.

### OMP-3008

**Puffer in der Pipeline voll** — Hinweis

**Ursache:** Ein Puffer ist an seiner Grenze: der Baustein dahinter nimmt Daten zu langsam ab.

**Was tun?**

1. Last des Hosts prüfen.
2. Prüfen, ob der Ausgang hängt (z. B. Ziel erreichbar, Platte beschreibbar).
3. Den Node neu starten.

## 4xxx — Verbindungen

### OMP-4001

**Verbindung: Sender-Seite nicht ansprechbar (404)** — Hinweis

**Ursache:** Der Node bietet keine Sender-seitige Verbindungs-Schnittstelle an. Bei reinen Sendern ist das normal.

**Was tun?**

1. Meist harmlos: die Verbindung wird über die Empfängerseite hergestellt.
2. Nur wenn die Verbindung wirklich fehlt: Empfänger im Flow Editor neu verbinden.

### OMP-4002

**Verbindung konnte nicht hergestellt werden** — Fehler

**Ursache:** Der Empfänger hat die Verbindungsanfrage (NMOS IS-05) abgelehnt oder war nicht erreichbar.

**Was tun?**

1. Prüfen, ob Sender und Empfänger online sind (🩺 an beiden Kacheln).
2. Formate müssen passen (Video mit Video, Ton mit Ton).
3. Erneut verbinden; steht der Fehler wieder da, im Diagnose-Tab die Spur (Trace) des Vorgangs öffnen.

### OMP-4003

**MXL verbindet keine verschiedenen Hosts** — Fehler

**Ursache:** MXL tauscht Bilder nur innerhalb eines Rechners aus; Quelle und Ziel liegen auf verschiedenen Hosts.

**Was tun?**

1. Quelle und Ziel auf denselben Host legen, oder
2. ein Gateway (ST 2110, SRT, Fabrics) dazwischenschalten.

### OMP-4004

**Formate passen nicht zusammen** — Fehler

**Ursache:** Sender und Empfänger tragen verschiedene Medienarten (z. B. Video auf einen Audio-Eingang).

**Was tun?**

1. Eine Verbindung zwischen passenden Anschlüssen herstellen: Video mit Video, Ton mit Ton.

## 5xxx — Hosts

### OMP-5003

**Host-Kommando abgelehnt** — Fehler

**Ursache:** Der Host-Agent hat ein Kommando des Orchestrators nicht angenommen: Signatur, Zeit oder Amtszeit stimmen nicht.

**Was tun?**

1. Uhren von Orchestrator und Host vergleichen (die Zeit darf nur wenige Sekunden abweichen).
2. Nach einem Schlüsselwechsel: Administration → Hosts → Schlüssel des Hosts erneuern.
3. Den Host-Agent neu starten.

### OMP-5004

**Host-Agent zu alt für diese Funktion** — Hinweis

**Ursache:** Der Host-Agent kennt das Kommando noch nicht (älterer Stand als der Orchestrator).

**Was tun?**

1. Host-Agent auf den Stand des Orchestrators bringen (System-Update oder neu bauen und starten).

### OMP-5005

**Host-Grenze für Jobs erreicht** — Hinweis

**Ursache:** Auf dem Host laufen schon so viele ffmpeg-Jobs, wie er laut Einstellung gleichzeitig ausführen darf.

**Was tun?**

1. Warten, bis ein Job fertig ist, oder einen anderen Host wählen.
2. Die Grenze in der tools.json des Hosts anheben, wenn der Rechner es verträgt.

### OMP-5006

**Echtzeit-Priorität auf dem Host nicht erlaubt** — Hinweis

**Ursache:** Der Host-Agent darf Prozessen keine Echtzeit-Priorität oder feste Prozessorkerne geben (fehlende Rechte). Der Node läuft trotzdem, aber ohne diesen Schutz vor Aussetzern.

**Was tun?**

1. Dem Dienst die Rechte geben: LimitRTPRIO/LimitNICE in der systemd-Unit des Host-Agents, Programme chrt und taskset installiert.
2. In Containern (z. B. LXD) sind diese Rechte meist nicht vergeben — dann ist der Hinweis erwartet.
3. Den Host-Agent neu starten.

### OMP-5007

**tools.json des Host-Agents ungültig** — Fehler

**Ursache:** Die Datei, die festlegt, welche Programme (ffmpeg …) der Host ausführen darf, ist fehlerhaft oder leer. Ohne sie nimmt der Host keine Jobs an.

**Was tun?**

1. Die Meldung nennt die Stelle: Pfade müssen absolut sein, mindestens ein Programm muss freigegeben sein.
2. Datei korrigieren und den Host-Agent neu starten.

### OMP-5001

**Host meldet sich nicht** — Fehler

**Ursache:** Vom Host-Agent kommt keine Telemetrie mehr: Rechner aus, Netzwerk getrennt oder Dienst beendet. Instanzen dort sind vermutlich nicht erreichbar.

**Was tun?**

1. Rechner und Netzwerkverbindung prüfen.
2. Den Dienst „omp-host-agent“ auf dem Host prüfen und starten.
3. Ein dauerhaft stillgelegter Host: unter Hosts entfernen.

### OMP-5002

**Uhr nicht synchron** — Hinweis

**Ursache:** Die Systemuhr des Rechners ist nicht mit einer Zeitquelle abgeglichen oder kennt den TAI-Versatz nicht. Das stört Videoübergabe und Schaltzeitpunkte.

**Was tun?**

1. Zeitsynchronisation einrichten (chrony oder PTP).
2. In Containern (z. B. LXD) darf die Uhr nicht gestellt werden — dort Zeitquelle auf dem Gastgeber einrichten.
3. Danach prüft Administration → Support die Uhr erneut.

## 6xxx — Zugriff

### OMP-6001

**Nicht angemeldet oder Sitzung abgelaufen** — Hinweis

**Ursache:** Die Anmeldung gilt nicht mehr (abgelaufen, abgemeldet oder ein Administrator hat Sitzungen beendet).

**Was tun?**

1. Neu anmelden.

### OMP-6002

**Keine Berechtigung** — Hinweis

**Ursache:** Dein Konto darf diese Aktion nicht ausführen.

**Was tun?**

1. Einen Administrator um das Recht bitten (Administration → Rechte).

### OMP-6003

**Support-Zugang: nur lesen oder nicht mehr gültig** — Hinweis

**Ursache:** Ein Support-Zugang darf nur ansehen, nicht ändern — oder er ist abgelaufen, widerrufen oder falsch.

**Was tun?**

1. Soll etwas geändert werden, muss das ein Administrator mit eigenem Konto tun.
2. Ist der Zugang abgelaufen oder widerrufen: Administration → Support → neuen Support-Zugang erzeugen und den Link erneut senden.

## 7xxx — Update

### OMP-7002

**Datensicherung oder Wiederherstellung fehlgeschlagen** — Fehler

**Ursache:** Die Sicherung der Datenbank konnte nicht erstellt oder eingespielt werden. Bestehende Daten wurden nicht verändert.

**Was tun?**

1. Ist die Datenbank erreichbar (OMP-1001) und Platz frei (OMP-1005)?
2. Die Meldung im Diagnose-Tab ansehen; „pg_dump“ muss im Datenbank-Container vorhanden sein.
3. Sicherung erneut starten.

### OMP-7001

**Update-Paket abgelehnt** — Fehler

**Ursache:** Die Signatur des Pakets stimmt nicht oder das Paket ist beschädigt. Es wurde nichts verändert.

**Was tun?**

1. Das Paket erneut von der Originalquelle laden.
2. Prüfen, ob der richtige Schlüssel hinterlegt ist (OMP_UPDATE_PUBKEY_FILE).

