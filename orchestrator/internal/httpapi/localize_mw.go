package httpapi

import (
	"bytes"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// Englische Fassung der vom Server erzeugten deutschen Klartexte
// (Fehlermeldungen, Platzierungsgründe, Plan-Warnungen …). Die Grundtexte
// bleiben deutsch im Code; bei Accept-Language: en ersetzt diese Middleware
// bekannte Phrasen im Antwort-Body (nur text/plain und application/json,
// Streams/Downloads laufen unverändert durch). Unbekannte Texte bleiben
// deutsch — die Liste wächst mit Bedarf. Platzhalter "¤" steht für ein
// (ggf. JSON-escaptes) Anführungszeichen.
type l10nRule struct {
	re   *regexp.Regexp
	repl string
}

func lr(pattern, repl string) l10nRule {
	pattern = strings.ReplaceAll(pattern, "¤", `\\?"`)
	return l10nRule{re: regexp.MustCompile(pattern), repl: repl}
}

var l10nRules = []l10nRule{
	// Platzierung/Plan
	lr(`Ausweichhost gewählt`, `Fallback host chosen`),
	lr(`bevorzugter Host verfügbar`, `preferred host available`),
	lr(`kein passender Remote-Host, lokal gestartet`, `no suitable remote host, started locally`),
	lr(`Host-Liste nicht verfügbar, lokal gestartet`, `host list unavailable, started locally`),
	lr(`\(Affinitäts-Gruppe ¤?([^"\\ ]*)¤? bereits auf diesem Host\)`, `(affinity group $1 already on this host)`),
	lr(`über dem Schwellwert \(inkl\. erwartetem Bedarf von ([^)]*)\)`, `above the threshold (incl. expected demand of $1)`),
	lr(`Für den Node-Typ (\S+) liegt noch kein Messprofil vor — der Bedarf ist unbekannt`, `For node type $1 there is no measured profile yet — the demand is unknown`),
	lr(`¤(reason|status|state)¤:¤läuft ¤`, `"$1":"running"`),
	// Trigger-Protokoll / As-Run (Texte aus dem Orchestrator und der Playout-Automation)
	lr(`Channel „([^“]*)“ darf Channel „([^“]*)“ nicht steuern \(keine Regel\)`, `Channel “$1” may not control channel “$2” (no rule)`),
	lr(`keine Quittung vom Ziel-Channel`, `no acknowledgement from the target channel`),
	lr(`(\d+) ms verspätet, Policy SKIP`, `$1 ms late, policy SKIP`),
	lr(`— (\d+) ms verspätet`, `— $1 ms late`),
	lr(`\(RESYNC: Versatz gemeldet\)`, `(RESYNC: offset reported)`),
	lr(`abgelöst durch `, `superseded by `),
	lr(`(\d+) Versuche`, `$1 attempts`),
	// Bestätigungen / Betrieb
	lr(`Bestätigung erforderlich \(confirm: true\)`, `Confirmation required (confirm: true)`),
	lr(`Bestätigung falsch: Version ¤?([^"\\ ]*)¤? eintippen`, `Wrong confirmation: type version $1`),
	lr(`Backup fehlgeschlagen: `, `Backup failed: `),
	lr(`Sicherungen konnten nicht aufgelistet werden: `, `Backups could not be listed: `),
	lr(`Import fehlgeschlagen: `, `Import failed: `),
	lr(`Hochladen fehlgeschlagen \(evtl\. zu groß\): `, `Upload failed (possibly too large): `),
	lr(`Supervisor nicht erreichbar oder Restore bereits im Gange: `, `Supervisor unreachable or a restore is already running: `),
	lr(`Supervisor nicht erreichbar oder beschäftigt: `, `Supervisor unreachable or busy: `),
	lr(`Backup-Datei konnte nicht gelesen werden: `, `Backup file could not be read: `),
	lr(`restore eingeleitet — der Server ist für einige Sekunden nicht erreichbar`, `restore initiated — the server is unreachable for a few seconds`),
	lr(`update eingeleitet — der Server ist für einige Sekunden nicht erreichbar`, `update initiated — the server is unreachable for a few seconds`),
	lr(`Backup-Dienst nicht verfügbar`, `Backup service unavailable`),
	lr(`Backup vor dem Update fehlgeschlagen — Update abgebrochen: `, `Backup before the update failed — update aborted: `),
	lr(`Paket nicht anwendbar: `, `Package not applicable: `),
	lr(`Paket nicht verteilbar: `, `Package cannot be distributed: `),
	lr(`System-Update ist nicht aktiviert`, `System update is not enabled`),
	lr(`Supervisor nicht konfiguriert`, `Supervisor not configured`),
	lr(`Verteilung an Hosts nicht konfiguriert`, `Distribution to hosts not configured`),
	lr(`es läuft bereits (ein Rollout|eine Verteilung)`, `$1 is already running`),
	lr(`Rollout nicht verfügbar`, `Rollout unavailable`),
	lr(`Workflow-Dienst nicht verfügbar`, `Workflow service unavailable`),
	lr(`Rolle neu gestartet \(Node-ID bleibt, Verkabelung über den Workflow\)`, `Role restarted (node ID stays, wiring via the workflow)`),
	lr(`gilt für neu gestartete Instanzen; (\d+) laufende Instanz\(en\) laufen noch mit einem anderen Stand \(Admin → System-Update → „Veraltete neu starten“\)`, `applies to newly started instances; $1 running instance(s) still run with a different state (Admin → System update → “Restart outdated”)`),
	lr(`Einstellungen nicht konfiguriert`, `Settings not configured`),
	lr(`Speicherorte nicht konfiguriert`, `Storage locations not configured`),
	lr(`Node-Versionierung nicht konfiguriert`, `Node versioning not configured`),
	lr(`unbekannte Option für diesen Node-Typ`, `unknown option for this node type`),
	lr(`unbekannte Einstellung`, `unknown setting`),
	lr(`unbekannte Kategorie: `, `unknown category: `),
	lr(`Instanz nicht gefunden \(oder anderer Node-Typ\)`, `Instance not found (or different node type)`),
	lr(`path erforderlich`, `path required`),
	lr(`id und status erforderlich`, `id and status required`),
	lr(`Host nicht erreichbar: `, `Host unreachable: `),
	lr(`Remote-Prüfung nicht verfügbar`, `Remote check unavailable`),
	lr(`Prüfung nicht möglich: `, `Check not possible: `),
	lr(`\(zum Anlegen trotzdem force setzen\)`, `(set force to create anyway)`),
	lr(`Pfad nicht nutzbar: `, `Path not usable: `),
	lr(`Speicherort wird noch von (\d+) Node-Einstellung\(en\) verwendet \(z\. B\. (.*?)\) — dort zuerst ändern`, `Storage location is still used by $1 node setting(s) (e.g. $2) — change them there first`),
	lr(`Widerspruch mit anderen Einstellungen: `, `Conflict with other settings: `),
	lr(`alle Überschreibungen verworfen: `, `all overrides discarded: `),
	lr(`wirksam nach dem nächsten Neustart des Orchestrators`, `effective after the next orchestrator restart`),
	lr(`auf diesem Rechner nicht geprüft/vorhanden \(erzwungen\) — gilt dort, wo der Pfad existiert`, `not checked/present on this machine (forced) — applies where the path exists`),
	lr(`Pfad auf dem Remote-Host nicht prüfbar: `, `Path on the remote host cannot be checked: `),
	lr(`auf dem Remote-Host: (.*?) — der Start dort schlägt fehl, bis der Pfad stimmt`, `on the remote host: $1 — the start there fails until the path is correct`),
	lr(`ffmpeg ist auf diesem Host nicht verfügbar`, `ffmpeg is not available on this host`),
	lr(`ffmpegtools: ffmpeg ist auf diesem Host nicht in der Allow-Liste`, `ffmpegtools: ffmpeg is not on the allow list on this host`),
	lr(`audio-sim fehlgeschlagen: `, `audio-sim failed: `),
	// Audio-Regeln
	lr(`mindestens eine Zielgruppe ist nötig`, `at least one target group is required`),
	lr(`Spurschema ¤?(.*?)¤?: Spurnummer (\d+) ungültig oder doppelt`, `Track schema $1: track number $2 invalid or duplicated`),
	lr(`Spurnummer (\d+) ungültig`, `track number $1 invalid`),
	lr(`ungültiges Zeichen`, `invalid character`),
	lr(`schließende Klammer fehlt`, `closing bracket missing`),
	lr(`Regel ¤?(.*?)¤?: source muss ¤?file ¤? oder ¤?live ¤? sein`, `Rule $1: source must be file or live`),
	lr(`Gruppe ¤?(.*?)¤? ist bit-exakt, keine Verarbeitung erlaubt`, `group $1 is bit-exact, no processing allowed`),
	// Workflows / Plan
	lr(`braucht (\d+) Frames Verzögerung, aber keine Rolle entlang des Pfads unterstützt setOutputDelay`, `needs $1 frames of delay, but no role along the path supports setOutputDelay`),
	lr(`Zielband zu knapp für Pfad`, `Target band too tight for path`),
	lr(`Latenzbudget für Pfad (.*?) kann nicht geprüft werden`, `Latency budget for path $1 cannot be checked`),
	lr(`deklariert keine Video-Latenz`, `declares no video latency`),
	lr(`neue Version fehlgeschlagen, auf bisherigen Stand zurückgerollt: `, `new version failed, rolled back to the previous state: `),
	lr(`Neustart fehlgeschlagen: `, `Restart failed: `),
	lr(`Container-Überwachung fehlgeschlagen: `, `Container monitoring failed: `),
	lr(`\(Crash-Loop erkannt: (\d+) Neustarts in (\S+) — Auto-Restart gestoppt\)`, `(crash loop detected: $1 restarts in $2 — auto-restart stopped)`),
	lr(`Prozess abgestürzt`, `Process crashed`),
	// Prozess-Engine
	lr(`(\d+) Ausführung\(en\) laufen noch — erst abbrechen`, `$1 execution(s) still running — cancel them first`),
	lr(`(\d+) Ausführung\(en\) anderer Prozesse referenzieren diesen Prozess`, `$1 execution(s) of other processes reference this process`),
	lr(`Materialisierung auf Remote-Hosts wird nicht unterstützt`, `Materialization on remote hosts is not supported`),
	lr(`Dateiname verlässt das Medienverzeichnis`, `File name leaves the media directory`),
	lr(`Prüfsumme \(SHA-256\) stimmt nicht`, `Checksum (SHA-256) does not match`),
	lr(`kein Storage-Backend-Dienst verfügbar`, `no storage backend service available`),
	// Node-Versionen / Updates / Orte
	lr(`nodeversions: nicht gefunden`, `nodeversions: not found`),
	lr(`nodeversions: Version existiert bereits mit anderem Inhalt`, `nodeversions: version already exists with different content`),
	lr(`nodeversions: die produktive Version lässt sich nicht löschen`, `nodeversions: the productive version cannot be deleted`),
	lr(`nodeversions: Contract-Generation wird von diesem Orchestrator nicht unterstützt`, `nodeversions: contract generation is not supported by this orchestrator`),
	lr(`update-paket nicht gefunden`, `update package not found`),
	lr(`update-paket zu groß`, `update package too large`),
	lr(`paket wurde seit dem Upload verändert`, `package was modified since upload`),
	lr(`locations: nicht gefunden`, `locations: not found`),
	lr(`locations: Name oder Pfad \(auf diesem Host\) existiert bereits`, `locations: name or path (on this host) already exists`),
	lr(`locations: ungültig`, `locations: invalid`),
	lr(`absoluter Pfad erforderlich \(z\. B\. /mnt/medien\)`, `absolute path required (e.g. /mnt/media)`),
	lr(`Name enthält Steuerzeichen`, `name contains control characters`),
	lr(`ungültiger Pfad`, `invalid path`),
	lr(`ungültig`, `invalid`),
	lr(`supervisor nicht erreichbar \(läuft er\? deploy/dev/start-supervisor\.sh\)`, `supervisor unreachable (is it running? deploy/dev/start-supervisor.sh)`),
	lr(`kein Nachrichtenbus \(NATS\) verfügbar`, `no message bus (NATS) available`),
}

type l10nWriter struct {
	http.ResponseWriter
	status  int
	buf     bytes.Buffer
	capture bool
	decided bool
}

func (w *l10nWriter) decide() {
	if w.decided {
		return
	}
	w.decided = true
	ct := w.Header().Get("Content-Type")
	w.capture = strings.HasPrefix(ct, "text/plain") || strings.HasPrefix(ct, "application/json")
}

func (w *l10nWriter) WriteHeader(code int) {
	w.decide()
	if !w.capture {
		w.ResponseWriter.WriteHeader(code)
		return
	}
	w.status = code
}

func (w *l10nWriter) Write(b []byte) (int, error) {
	w.decide()
	if !w.capture {
		return w.ResponseWriter.Write(b)
	}
	return w.buf.Write(b)
}

func (w *l10nWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok && !w.capture {
		f.Flush()
	}
}

func (w *l10nWriter) finish() {
	if !w.capture {
		return
	}
	body := w.buf.String()
	for _, r := range l10nRules {
		body = r.re.ReplaceAllString(body, r.repl)
	}
	w.Header().Del("Content-Length")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	if w.status != 0 {
		w.ResponseWriter.WriteHeader(w.status)
	}
	_, _ = w.ResponseWriter.Write([]byte(body))
}

// localizeEnglish übersetzt bekannte deutsche Servertexte, wenn die UI
// Englisch anfragt (Accept-Language: en). SSE und Streams bleiben unberührt.
func localizeEnglish(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requestLang(r) != "en" || strings.Contains(r.Header.Get("Accept"), "text/event-stream") || !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		lw := &l10nWriter{ResponseWriter: w}
		next.ServeHTTP(lw, r)
		lw.finish()
	})
}
