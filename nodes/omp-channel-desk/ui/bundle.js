// ui/shell/client-id.ts
var cached = "";
function clientId() {
  if (cached) return cached;
  try {
    const saved = sessionStorage.getItem("omp-client-id");
    if (saved) return cached = saved;
  } catch {
  }
  const b = crypto.getRandomValues(new Uint8Array(8));
  cached = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  try {
    sessionStorage.setItem("omp-client-id", cached);
  } catch {
  }
  return cached;
}

// ui/shell/connection.ts
var TOKEN_KEY = "omp-auth-token";
var SSE_RECONNECT_INITIAL_DELAY_MS = 1e3;
var SSE_RECONNECT_MAX_DELAY_MS = 3e4;
var DEGRADED_RECOVERY_PROBE_INTERVAL_MS = 3e3;
var ConnectionMonitor = class extends EventTarget {
  #state = "connected";
  #es = null;
  #reconnectDelayMs = SSE_RECONNECT_INITIAL_DELAY_MS;
  #reconnectTimer;
  #nextRetryAt = null;
  #degradedProbeTimer;
  get state() {
    return this.#state;
  }
  get nextRetryAt() {
    return this.#nextRetryAt;
  }
  // Idempotent: zweiter/dritter Aufruf (App-Bar UND flow-canvas rufen
  // beide start() in ihrem connectedCallback) öffnet keine zweite
  // EventSource-Verbindung.
  start() {
    if (this.#es) return;
    this.#connect();
  }
  // Für den "Jetzt verbinden"-Knopf im Disconnected-Banner: verwirft
  // den laufenden Backoff-Timer und versucht sofort neu, statt auf den
  // nächsten geplanten Versuch zu warten.
  reconnectNow() {
    clearTimeout(this.#reconnectTimer);
    this.#es?.close();
    this.#es = null;
    this.#connect();
  }
  #connect() {
    const token = localStorage.getItem(TOKEN_KEY);
    const cid = `cid=${encodeURIComponent(clientId())}`;
    const url = token ? `/api/v1/events?access_token=${encodeURIComponent(token)}&${cid}` : `/api/v1/events?${cid}`;
    const es = new EventSource(url);
    this.#es = es;
    es.onopen = () => {
      this.#reconnectDelayMs = SSE_RECONNECT_INITIAL_DELAY_MS;
      this.#nextRetryAt = null;
      this.#setState("connected");
    };
    es.onmessage = (ev) => {
      this.dispatchEvent(new CustomEvent("sse-message", {
        detail: ev.data
      }));
    };
    es.onerror = () => {
      es.close();
      this.#setState("disconnected");
      this.#scheduleReconnect();
    };
  }
  #scheduleReconnect() {
    clearTimeout(this.#reconnectTimer);
    this.#nextRetryAt = Date.now() + this.#reconnectDelayMs;
    this.dispatchEvent(new Event("retry-scheduled"));
    this.#reconnectTimer = setTimeout(() => this.#connect(), this.#reconnectDelayMs);
    this.#reconnectDelayMs = Math.min(this.#reconnectDelayMs * 2, SSE_RECONNECT_MAX_DELAY_MS);
  }
  // apiFetch() meldet hierüber fehlgeschlagene Requests — nur relevant,
  // während der SSE-Stream selbst noch lebt ("connected"): ist er schon
  // "disconnected", ist das ohnehin der schlechtere, bereits sichtbare
  // Zustand; ein einzelner Fetch-Fehler soll ihn nicht überschreiben.
  reportApiFailure() {
    if (this.#state === "connected") {
      this.#setState("degraded");
      this.#startDegradedRecoveryProbe();
    }
  }
  reportApiSuccess() {
    if (this.#state === "degraded") this.#setState("connected");
  }
  #setState(next) {
    if (next !== "degraded") this.#stopDegradedRecoveryProbe();
    if (this.#state === next) return;
    this.#state = next;
    this.dispatchEvent(new CustomEvent("statechange", {
      detail: {
        state: next,
        nextRetryAt: this.#nextRetryAt
      }
    }));
  }
  // "degraded" ist als Sekundärsignal gedacht, nicht als Sackgasse: ohne
  // diesen Probe könnte ein einzelner, längst veralteter Fetch-Fehlschlag
  // (s. Kommentar bei DEGRADED_RECOVERY_PROBE_INTERVAL_MS oben) den
  // Zustand für den Rest der Sitzung einfrieren, wenn gerade niemand eine
  // andere apiFetch()-Aktion auslöst. apiFetch() selbst ruft hier wieder
  // rein (reportApiSuccess()/-Failure()), es ist also derselbe Pfad wie
  // jeder andere Aufrufer — kein Sonderfall.
  #startDegradedRecoveryProbe() {
    if (this.#degradedProbeTimer !== void 0) return;
    const probe = () => {
      this.#degradedProbeTimer = void 0;
      if (this.#state !== "degraded") return;
      apiFetch("/healthz").finally(() => {
        if (this.#state === "degraded") {
          this.#degradedProbeTimer = setTimeout(probe, DEGRADED_RECOVERY_PROBE_INTERVAL_MS);
        }
      });
    };
    this.#degradedProbeTimer = setTimeout(probe, DEGRADED_RECOVERY_PROBE_INTERVAL_MS);
  }
  #stopDegradedRecoveryProbe() {
    clearTimeout(this.#degradedProbeTimer);
    this.#degradedProbeTimer = void 0;
  }
};
var connectionMonitor = new ConnectionMonitor();
async function apiFetch(input, init) {
  try {
    const res = await fetch(input, init);
    if (res.ok || res.status < 500) {
      connectionMonitor.reportApiSuccess();
    } else {
      connectionMonitor.reportApiFailure();
    }
    return res;
  } catch (err) {
    connectionMonitor.reportApiFailure();
    throw err;
  }
}

// ui/shell/i18n/de.ts
var de = {
  "lang.title": "Sprache",
  "mc.allTimeline": "Gesamt-Timeline",
  "mc.allTimelineTip": "Alle Channels auf einer gemeinsamen Zeitachse ein-/ausblenden",
  "mc.title": "Mehrkanal-\xDCbersicht",
  "mc.overview": "\xDCbersicht",
  "mc.empty": "Keine Playout-Channels zugewiesen.",
  "mc.loading": "Channels werden gesucht \u2026",
  "mc.onAir": "Auf Sendung",
  "mc.next": "Danach",
  "mc.nothing": "nichts auf Sendung",
  "mc.edit": "Bearbeiten",
  "mc.window": "Fenster",
  "mc.winMin": "{n} min",
  "mc.selectAll": "Alle w\xE4hlen",
  "mc.selectNone": "Keine",
  "mc.selected": "{n} gew\xE4hlt",
  "mc.gang": "Gruppen-Start",
  "mc.gangHint": "Wirkt auf alle gew\xE4hlten Channels gleichzeitig.",
  "mc.act.next": "Next",
  "mc.act.take": "Take",
  "mc.act.nextLive": "Next Live",
  "mc.act.hold": "Hold",
  "mc.act.auto": "Auto",
  "mc.confirm": "{action} auf {n} Channels ausf\xFChren?\n{names}",
  "mc.result.ok": "{action}: {n} Channels ausgef\xFChrt",
  "mc.result.fail": "{action}: {n} fehlgeschlagen \u2014 {names}",
  "mc.stat.events": "{n} Events",
  "mc.stat.rest": "Rest {t}",
  "mc.stat.ends": "Ende {at}",
  "mc.health.ok": "l\xE4uft",
  "mc.health.wait": "wartet auf Bedienung",
  "mc.health.warn": "Achtung",
  "mc.health.offline": "keine Verbindung",
  "mc.wait.hold": "HOLD",
  "mc.wait.endHold": "Manual Hold",
  "mc.wait.manualStart": "manuell",
  "mc.wait.cued": "gecued",
  "mc.keys": "Alt+\u2190 / Alt+\u2192 wechselt den Channel, Alt+0 zeigt die \xDCbersicht",
  "mc.noBundle": "Oberfl\xE4che von {name} nicht ladbar.",
  "app.tab.flow": "Flow Editor",
  "app.tab.workflows": "Workflows",
  "app.tab.process": "Prozesse",
  "app.tab.assets": "Assets",
  "app.tab.hosts": "Hosts",
  "app.tab.instances": "Instanzen",
  "app.tab.alarms": "Alarme",
  "app.tab.health": "Health",
  "app.tab.signalPath": "Signalweg",
  "app.tab.scheduler": "Scheduler",
  "app.tab.admin": "Administration",
  "app.conn.connected": "\u25CF Verbunden",
  "app.conn.degraded": "\u25CF Eingeschr\xE4nkt",
  "app.conn.disconnected": "\u25CF Getrennt",
  "app.conn.lost": "Verbindung zum Orchestrator verloren \u2014 neuer Versuch in {secs}s",
  "app.conn.retryNow": "Jetzt verbinden",
  "auth.loggedInAs": "Angemeldet als {user}",
  "auth.logout": "Abmelden",
  "op.problem.overdue": "Frist \xFCberschritten",
  "op.problem.failed": "fehlgeschlagen",
  "op.problem.not_admitted": "nicht zugelassen (Ressourcen)",
  "op.problem.waiting_resources": "wartet auf Ressourcen",
  "op.problem.qc_not_run": "QC konnte nicht ausgef\xFChrt werden",
  "op.problem.qc_failed": "QC mit Fehlern",
  "op.problem.rejected": "abgelehnt \u2013 Nacharbeit",
  "op.state.awaiting_qc": "wartet auf QC",
  "op.state.qc_running": "QC l\xE4uft",
  "op.state.qc_failed_to_run": "QC nicht ausf\xFChrbar",
  "op.state.awaiting_review": "wartet auf Pr\xFCfung",
  "op.state.in_review": "in Pr\xFCfung",
  "op.state.conforming": "Conform",
  "op.state.ready_for_approval": "zur Freigabe",
  "op.state.approved": "freigegeben",
  "op.state.rejected": "abgelehnt",
  "op.state.archived": "archiviert",
  "op.state.scheduled": "geplant",
  "op.state.blocked": "nicht zugelassen",
  "op.state.waiting_for_resources": "wartet auf Ressourcen",
  "op.state.starting": "startet",
  "op.state.recording": "nimmt auf",
  "op.state.finalizing": "wird abgeschlossen",
  "op.state.processing": "wird verarbeitet",
  "op.state.completed": "fertig",
  "op.state.failed": "fehlgeschlagen",
  "op.state.cancelled": "abgebrochen",
  "op.home.title": "Arbeitsplatz",
  "op.home.workflows": "Workflows",
  "op.home.noWorkflow": "Zurzeit l\xE4uft kein Workflow, den Sie bedienen k\xF6nnen.",
  "op.home.tools": "Werkzeuge",
  "op.home.tasks": "Meine Aufgaben",
  "op.home.noTasks": "Keine offenen Aufgaben.",
  "op.home.noTasksShort": "keine offenen Aufgaben",
  "op.home.taskCount": "{n} Aufgaben",
  "op.home.problemCount": "{n} mit Problem",
  "op.home.taskSummary": "{total} offen \xB7 {mine} bei mir \xB7 {problems} mit Problem",
  "op.home.taskError": "Aufgaben aus {module} nicht ladbar: {message}",
  "op.home.hello": "Willkommen, {name}",
  "op.home.open": "\xD6ffnen",
  "op.home.back": "Arbeitsplatz",
  "op.task.col.kind": "Art",
  "op.task.col.title": "Aufgabe",
  "op.task.col.state": "Stand",
  "op.task.col.who": "Zust\xE4ndig",
  "op.task.col.due": "Frist",
  "op.task.kind.qc": "Datei pr\xFCfen",
  "op.task.kind.recording": "Aufnahme",
  "op.task.kind.approval": "Freigabe",
  "op.task.mine": "ich",
  "op.task.group": "Gruppe {group}",
  "op.task.claimable": "Gruppe {group} \u2013 \xFCbernehmbar",
  "op.due.in": "in {span}",
  "op.due.ago": "seit {span} \xFCberf\xE4llig",
  "op.tiles.unavailable": "Die Arbeitsansichten konnten gerade nicht geladen werden.",
  "op.tiles.retry": "Erneut versuchen",
  "inst.cpu.core": "eines Kerns",
  "inst.cpu.coreTitle": "100 % = ein voll ausgelasteter Kern. Der Hauptwert bezieht sich auf alle Kerne des Hosts und ist mit der Host-Auslastung vergleichbar.",
  "hosts.sensors": "Temp. / Leistung",
  "hosts.sensorsTitle": "Temperatur des Hosts (CPU/Plattform) und Leistungsaufnahme. Rot ab 85 \xB0C; Alarm \xFCber OMP_ALERT_TEMP_C.",
  "hosts.sensorsNone": "Der Host liefert keine Temperatur-/Leistungswerte (VM, kein Sensor oder keine Leserechte) \u2014 nicht gemessen",
  "hosts.powerRapl": "Leistung des CPU-Pakets (RAPL), ohne Rest des Systems",
  "hosts.powerBattery": "Gesamtleistung des Ger\xE4ts (Akku)",
  "op.tile.failed": "Die Ansicht \u201E{label}\u201C konnte nicht geladen werden.",
  "op.badge": "\u26A0 {n} Aufgaben",
  "op.badge.title": "{n} Aufgaben brauchen Aufmerksamkeit ({overdue} \xFCberf\xE4llig) \u2014 zum Arbeitsplatz",
  "auth.home": "\u{1F3E0} Arbeitsplatz",
  "auth.homeTitle": "Zur\xFCck zum Arbeitsplatz (Workflows, Aufgaben, Werkzeuge)",
  "auth.switchWorkflow": "\u{1F3E0} Workflow wechseln",
  "auth.switchWorkflowTitle": "Zur\xFCck zur Workflow-Auswahl",
  "admin.title": "Administration",
  "admin.group.platform": "Plattform",
  "admin.cluster.access": "Zugang & Rechte",
  "admin.cluster.operations": "Betrieb",
  "admin.cluster.maintenance": "Wartung",
  "admin.tab.users": "Nutzer",
  "admin.tab.organizations": "Organisationen",
  "admin.tab.groups": "Gruppen",
  "admin.tab.bindings": "Rechte",
  "admin.tab.catalog": "Node-Katalog",
  "admin.tab.nodeversions": "Node-Versionen",
  "admin.tab.storage": "Storage",
  "admin.tab.audit": "Audit-Log",
  "admin.tab.diagnose": "Diagnose",
  "admin.tab.backup": "Backup/Restore",
  "admin.tab.update": "System-Update",
  "admin.tab.settings": "Einstellungen",
  "admin.tab.cluster": "Cluster",
  "sp.title": "Signalweg",
  "sp.intro": "Zeigt, \xFCber welche Nodes ein Signal gerade tats\xE4chlich von der Quelle zum Ziel l\xE4uft (aktive Verbindungen), und wo die Kette bricht. Quelle und Ziel sind einzeln w\xE4hlbar: nur die Quelle zeigt alle Ketten, die von ihr ausgehen, nur das Ziel alle, die dort ankommen.",
  "sp.clear": "Auswahl l\xF6schen",
  "sp.noMatch": "Keine Treffer",
  "sp.source": "Quelle",
  "sp.target": "Ziel",
  "sp.via": "\xFCber Node (optional)",
  "sp.chooseSource": "Quelle suchen oder w\xE4hlen \u2026",
  "sp.chooseTarget": "Ziel suchen oder w\xE4hlen \u2026",
  "sp.noVia": "Node suchen (optional) \u2026",
  "sp.loading": "Lade \u2026",
  "sp.pick": "Quelle und/oder Ziel w\xE4hlen \u2014 mit nur einer Seite siehst du alles, was von der Quelle ausgeht bzw. am Ziel ankommt.",
  "sp.noPath": "Kein Signalweg: Zwischen Quelle und Ziel besteht keine aktive Verbindungskette. Pr\xFCfe, ob alle Teilst\xFCcke verbunden sind (Flow-Editor).",
  "sp.noPathVia": "Kein Signalweg: Zwischen Quelle und Ziel besteht keine aktive Verbindungskette \xFCber die gew\xE4hlte Node. Pr\xFCfe, ob alle Teilst\xFCcke verbunden sind (Flow-Editor).",
  "sp.noDownstream": "Von dieser Quelle geht keine aktive Verbindung aus. Pr\xFCfe im Flow-Editor, ob sie angeschlossen ist.",
  "sp.noUpstream": "Am Ziel kommt keine aktive Verbindung an. Pr\xFCfe im Flow-Editor, ob eine Quelle angeschlossen ist.",
  "sp.path": "Weg",
  "sp.pathN": "Weg {n} von {total}",
  "sp.connections.one": "1 Verbindung",
  "sp.connections.many": "{n} Verbindungen",
  "sp.issue.hostSilent": "Der Host {host} meldet sich nicht mehr (betrifft: {nodes})",
  "sp.issue.hostOverloaded": "Der Host {host} ist stark ausgelastet (betrifft: {nodes})",
  "sp.issue.hostClock": "Die Uhr von {host} ist nicht synchron (betrifft: {nodes})",
  "sp.issue.notReady": "{node} l\xE4uft, liefert aber gerade kein Bild oder keinen Ton",
  "sp.issue.neverReady": "{node} hat noch kein Bild und keinen Ton geliefert (oder meldet seine Bereitschaft nicht)",
  "sp.fix.neverReady": "Wenn dieser Node Medien liefern soll: die Quelle davor und seine Einstellungen pr\xFCfen. Manche Node-Typen melden ihre Bereitschaft nicht \u2014 dann ist der Hinweis harmlos.",
  "sp.issue.noFrames": "{node} liefert seit Kurzem keine Bilder mehr",
  "sp.issue.fpsDrop": "{node}: Bildrate eingebrochen ({last} statt {avg} Bilder/s)",
  "sp.issue.restarts": "{node} wurde {n}-mal automatisch neu gestartet",
  "sp.fix.offline": "Unter Instanzen nachsehen, ob der Prozess l\xE4uft; sonst neu starten.",
  "sp.fix.crashed": "Unter Instanzen steht die letzte Fehlermeldung. Neu starten; st\xFCrzt er wieder ab, Support-Paket erstellen (Administration \u2192 Support).",
  "sp.fix.formatMismatch": "Eine Verbindung zwischen passenden Anschl\xFCssen (Video mit Video, Ton mit Ton) herstellen.",
  "sp.fix.mxlAcrossHosts": "Quelle und Ziel auf denselben Host legen oder ein Gateway dazwischenschalten.",
  "sp.fix.loop": "Die Verbindung, die den Ausgang wieder in den Eingang zur\xFCckf\xFChrt, entfernen.",
  "sp.fix.hostSilent": "Rechner, Netzwerk und den Dienst \u201Eomp-host-agent\u201C des Hosts pr\xFCfen. Instanzen dort sind vermutlich nicht erreichbar.",
  "sp.fix.hostOverloaded": "Instanzen auf einen anderen Host verschieben, bevor Bild oder Ton aussetzen.",
  "sp.fix.hostClock": "Zeitsynchronisation (chrony/PTP) des Hosts pr\xFCfen; eine falsche Uhr st\xF6rt die Video\xFCbergabe.",
  "sp.fix.notReady": "Die Quelle davor pr\xFCfen: ohne Eingangssignal oder Datei liefert dieser Node nichts. Hilft das nicht, den Node neu starten.",
  "sp.fix.noFrames": "Den Node neu starten. Kommt danach wieder nichts, die Quelle davor pr\xFCfen und das Support-Paket erstellen.",
  "sp.fix.fpsDrop": "Meist \xDCberlastung: Last des Hosts pr\xFCfen und Instanzen verteilen.",
  "sp.fix.restarts": "Der Prozess endet immer wieder von selbst. Ursache unter Administration \u2192 Diagnose suchen oder das Support-Paket erstellen.",
  "sp.verdict.fix": "Was tun? {fix}",
  "sp.overview.title": "Alle Ziele auf einen Blick",
  "sp.overview.hint": "Warum kommt hier nichts an? F\xFCr jedes Ziel (Viewer, Recorder, Gateway \u2026) wird die Kette r\xFCckw\xE4rts gepr\xFCft und die erste Fehlerstelle genannt.",
  "sp.overview.none": "Es ist keine Quelle angeschlossen",
  "sp.overview.ok": "Alles in Ordnung",
  "sp.overview.show": "Kette zeigen",
  "sp.overview.empty": "Keine Ziele gefunden (Nodes ohne Ausgang).",
  "sp.verdict.ok": "\u2714 Signalweg in Ordnung",
  "sp.verdict.warn": "\u26A0 Signalweg steht, mit Hinweisen",
  "sp.verdict.error": "\u2716 Erste Fehlerstelle: {text}",
  "sp.truncated": "Nur die ersten {max} Wege (k\xFCrzeste zuerst) werden gezeigt.",
  "sp.host": "Host: {host}",
  "sp.hostUnknown": "Host unbekannt",
  "sp.hostLocal": "lokal",
  "sp.online": "online",
  "sp.offline": "offline",
  "sp.net": "Netz: {demand}",
  "sp.card": "Karte: {percent} % von {link}",
  "sp.netLink": "Netz {demand}",
  "sp.localLink": "lokal, kein Netz",
  "sp.issue.loop": "Schleife: {node} wird von {from} gespeist \u2013 es kommt kein Signal aus einer echten Quelle",
  "sp.issue.offline": "{node} ist offline",
  "sp.issue.monitor": "{node} meldet (Status-\xDCberwachung): {text}",
  "sp.issue.crashed": "{node} ist abgest\xFCrzt",
  "sp.issue.formatMismatch": "Formate passen nicht: {from} \u2192 {to}",
  "sp.issue.transportDiffers": "Transporte unterschiedlich: {from} \u2192 {to}",
  "sp.issue.mxlAcrossHosts": "MXL ist host-lokal, Quelle und Ziel liegen auf verschiedenen Hosts (Gateway n\xF6tig)",
  "sp.issue.netUnknownLink": "Netz: {demand} \u2014 Link-Geschwindigkeit der Karte von {host} unbekannt, Reserve nicht pr\xFCfbar",
  "sp.issue.netTooBig": "Netz: braucht {demand}, die Karte von {host} schafft nur {link} je Richtung",
  "sp.issue.netOverThreshold": "Netzkarte von {host} zu {percent} % belegt (Grenzwert {threshold} %)",
  "sp.anyInput": "{node} (jeder Eingang)",
  "sp.activeInput": "Eingang (aktive Quelle)",
  "sp.format.video": "Video",
  "sp.format.audio": "Audio",
  "sp.format.data": "Daten",
  "sp.format.mux": "Mux",
  "login.lead": "Eine offene Plattform f\xFCr softwaredefinierte Medien- und Broadcast-Infrastrukturen \u2013 entwickelt f\xFCr Interoperabilit\xE4t, Flexibilit\xE4t und die Anforderungen von morgen.",
  "login.tag": "Standards. Technologie. Freiheit.",
  "login.title": "Anmelden",
  "login.sub": "Zugang zur Control Plane",
  "login.user": "Nutzername",
  "login.password": "Passwort",
  "login.failed": "Anmeldung fehlgeschlagen.",
  "op.noWorkflow.title": "Kein aktiver Workflow",
  "op.noWorkflow.text": "Du hast Bedienrechte f\xFCr mindestens eine Rolle, aber aktuell l\xE4uft kein Workflow, der dazu passt. Sobald ein zugewiesener Workflow gestartet wird, erscheint er hier.",
  "op.reload": "Neu laden",
  "op.pickWorkflow": "Workflow w\xE4hlen",
  "op.roles.one": "1 Rolle",
  "op.roles.many": "{n} Rollen",
  "op.hostLocal": "Lokal",
  "console.none": "Keine Konsole f\xFCr diesen Nutzer zugewiesen.",
  "console.loading": "L\xE4dt \u2026",
  "console.bundleFailed": 'UI-Bundle f\xFCr "{node}" konnte nicht geladen werden.',
  "cloud.suggest": "Cloud-Vorschlag {p0}: {p1}\xD7 {p2} dazunehmen",
  "cloud.calculating": "Kosten werden berechnet \u2026",
  "cloud.costFailed": "Kosten nicht verf\xFCgbar",
  "cloud.cost": "ca. {p0} {p1} (gesch\xE4tzt, ohne Datentransfer)",
  "cloud.hint": "Vorschlag aus dem Engpass dieser Zeit: so viele Cloud-Hosts w\xFCrden die \xDCberlast aufl\xF6sen. Die Kosten sind eine Vorberechnung, keine Abrechnung.",
  "cloud.reserve": "Reservieren",
  "cloud.confirm": "{p1}: {p0} Cloud-Host(s) reservieren? Das verursacht Kosten ({p2}).",
  "cloud.reserved": "Cloud-Kapazit\xE4t reserviert",
  "cloud.reserveFailed": "Reservierung fehlgeschlagen: {p0}",
  "app.module.loadFailed": "Die Oberfl\xE4che von \u201E{name}\u201C konnte nicht geladen werden.",
  "console.unavailable": "Dienst nicht verf\xFCgbar \u2013 der Node antwortet nicht.",
  "board.arrangeAll": "\u229E Alle anordnen",
  "board.arrangeAllTitle": "Alle Kacheln in einem Raster neu anordnen und ausklappen",
  "board.dragMove": "Ziehen zum Verschieben",
  "board.dragResize": "Ziehen zum Skalieren",
  "board.restore": "Wiederherstellen",
  "board.minimize": "Minimieren",
  "board.maximize": "Maximieren",
  "board.preview": "Vorschau",
  "board.previewTitle": "Live-Vorschau in der Kachel ein-/ausblenden",
  "board.noUi": "Dieser Node hat keine eigene Bedienoberfl\xE4che.",
  "board.taskbar": "Minimierte Fenster",
  "board.layouts": "Layouts \u2026",
  "board.layoutSave": "Layout speichern",
  "board.layoutSaveTitle": "Aktuelle Fensteranordnung unter einem Namen speichern",
  "board.layoutSaveConfirm": "Speichern",
  "board.layoutDelete": "Layout l\xF6schen",
  "board.layoutName": "Name des Layouts:",
  "board.layoutConfirmDelete": 'Layout "{name}" l\xF6schen?',
  "board.hostTitle": "Host: {host}",
  "up.next": "N\xE4chster Workflow: {name}",
  "up.starting": "Workflow startet: {name}",
  "up.now": "startet jetzt \u2026",
  "up.planned": "geplant {when} Uhr",
  "up.dayShort": "T",
  "kit.cancel": "Abbrechen",
  "kit.ok": "OK",
  "kit.delete": "L\xF6schen",
  "kit.searchPlaceholder": "\u{1F50D} Quellen suchen \u2026",
  "kit.searchAria": "Quellen suchen",
  "kit.noHits": "Keine Treffer",
  "kit.noSources": "Keine Quellen verf\xFCgbar",
  "wfi.button": "Schnittstelle\u2026",
  "wfi.buttonTitle": "Ausg\xE4nge und Eing\xE4nge des Workflows festlegen (was Bediener sehen und schalten)",
  "wfi.title": "Schnittstelle von {p0}",
  "wfi.intro": "Bediener sehen nur die hier benannten Ausg\xE4nge und Eing\xE4nge, nicht alle Sender der Rollen.",
  "wfi.outputs": "Ausg\xE4nge",
  "wfi.inputs": "Eing\xE4nge",
  "wfi.outputsHint": "Was dieser Workflow nach au\xDFen liefert, z. B. PGM. Mehrere Sender (Bild + Ton) bilden einen Ausgang.",
  "wfi.inputsHint": "Was dieser Workflow von au\xDFen annimmt, z. B. Zuspiel.",
  "wfi.name": "Name (eindeutig)",
  "wfi.labelPlaceholder": "Anzeigename (optional)",
  "wfi.portPlaceholder": "Port der Rolle (leer: Ausgang = alle Sender, Eingang = erster)",
  "wfi.addMember": "+ Sender/Empf\xE4nger",
  "wfi.removeMember": "Mitglied entfernen",
  "wfi.removePort": "Entfernen",
  "wfi.newOutput": "Neuer Ausgang, z. B. PGM",
  "wfi.newInput": "Neuer Eingang, z. B. Zuspiel",
  "wfi.add": "Anlegen",
  "wfi.nameTaken": "Der Name ist leer oder schon vergeben.",
  "wfi.problems": "Ein Mitglied verweist auf eine Rolle, die es nicht gibt, oder ein Ausgang hat kein Mitglied.",
  "wfi.notRunning": "Der Workflow l\xE4uft nicht oder liefert keine Quelle.",
  "wfi.noMatch": "Kein Sender des Ausgangs passt zum Ziel (Medienart).",
  "wfi.connected": "{p0} geschaltet.",
  "wfi.fedBy": "Gespeist von {p0} \u2192 {p1}",
  "wfi.unlink": "Zuordnung l\xF6sen",
  "wfi.edgeTip": "Verbindung \xFCber die Workflow-Schnittstelle",
  "wfi.feedTip": "Dauerhafte Zuordnung (Ausgang \u2192 Eingang); anklicken und mit Entf trennen",
  "wfi.disconnected": "Verbindung getrennt.",
  "wfi.disconnect": "Trennen (Entf)",
  "flow.removeStoppedRoles": "Die Rolle(n) {p0} laufen nicht mehr (gestoppt). Beim Speichern werden sie samt ihren Verbindungen aus dem Workflow entfernt. Fortfahren?",
  "kit.workflowOutputs": "Workflow-Ausg\xE4nge",
  "kit.currentWorkflow": "Aktueller Workflow",
  "kit.otherWorkflows": "Andere Workflows",
  "kit.otherUnassigned": "Sonstige / nicht zugeordnet",
  "hosts.54f664": "Online",
  "hosts.8d9da4": "Offline",
  "hosts.75d9aa": "Noch kein Host registriert.",
  "hosts.ec53a8": "Status",
  "hosts.b021df": "Label",
  "hosts.c8f4b8": "Hostname",
  "hosts.2b5538": "CPU",
  "hosts.e53619": "RAM",
  "hosts.72ce72": "Netz",
  "hosts.52f9ec": "GPU",
  "hosts.25850a": "Verlauf (1h)",
  "hosts.be62a5": "Min/\xD8/Max CPU",
  "hosts.4d62c2": "Zuletzt gesehen",
  "hosts.514366": "Host online",
  "hosts.eda8d2": "Host offline \u2014 zuletzt gesehen {p0}",
  "hosts.61ea4b": "Host offline \u2014 keine Telemetrie empfangen",
  "hosts.424d6d": "Vorschlag: ",
  "hosts.c77b3a": "kein Ausweichhost frei",
  "hosts.857412": " \xFCberlastet (Grund: {p0}, CPU {p1}% / RAM {p2}%{p3}{p4}),\n          {p5} Instanz(en) betroffen \u2014 {p6}\n        ",
  "hosts.e50108": "Rolle ",
  "hosts.7fdb90": " zieht in ",
  "hosts.bcf38d": " automatisch auf ",
  "hosts.0f1de4": " um, falls kein Eingriff erfolgt.",
  "hosts.578226": "Jetzt ausf\xFChren",
  "hosts.4b9727": "Abbrechen",
  "hosts.995111": "+ Neuen Host hinzuf\xFCgen",
  "hosts.remove": "Entfernen",
  "hosts.maintOn": "Wartung",
  "hosts.maintOff": "Wartung beenden",
  "hosts.maintConfirm": "Host {p0} in den Wartungsmodus versetzen? Er bekommt keine neue Last, alle Workflow-Rollen werden ausfallfrei (Make-before-break) auf andere Hosts umgezogen. Eigenst\xE4ndige Instanzen bleiben stehen und werden gemeldet.",
  "hosts.maintEvacuating": "Wartung: wird geleert ({p0}/{p1})",
  "hosts.maintDrained": "Wartung: leer",
  "hosts.maintBlocked": "Wartung: {p0} nicht verschiebbar",
  "hosts.maintBanner": "WARTUNG",
  "hosts.maintMoveBtn": "Verschieben \u2026",
  "hosts.maintMoveDialogTitle": "Instanz {p0} verschieben",
  "hosts.maintMoveDialogInfo": "Die Instanz wird gestoppt und auf dem gew\xE4hlten Host neu gestartet \u2014 das Signal f\xE4llt kurz aus. Verbindungen und Einstellungen werden \xFCbernommen.",
  "hosts.maintMoveCancel": "Abbrechen",
  "rd.placementPinned": "Placement: an Host gebunden (nie automatisch umziehen)",
  "hosts.maintReason.hostBound": "an Hardware dieses Hosts gebunden, wird nie automatisch umgezogen",
  "hosts.maintReason.standalone": "eigenst\xE4ndige Instanz, kein unterbrechungsfreier Umzug m\xF6glich",
  "hosts.maintMoveFailed": "Verschieben fehlgeschlagen: {p0}",
  "hosts.maintMoveStarted": "Verschieben gestartet: {p0}",
  "hosts.maintLocal": "Orchestrator-Host (lokal)",
  "hosts.removeConfirm": "Host \u201E{p0}\u201C aus der Registry entfernen? Sein Host-Agent muss sich neu mit einem Token registrieren.",
  "hosts.removeFailed": "Entfernen fehlgeschlagen: {p0}",
  "hosts.080196": "Hosts ({p0})",
  "inst.50c3a7": "Instanz",
  "inst.ec53a8": "Status",
  "inst.c2ca16": "Host",
  "inst.974607": "Neustarts",
  "inst.03a35d": "Prozess abgest\xFCrzt",
  "inst.93e356": "Von Hand gestartet, geh\xF6rt zu keinem Workflow",
  "inst.3e3d94": "Keine Instanz l\xE4uft.",
  "inst.24f47c": "Workflow",
  "inst.9e4506": "Nach {p0} sortieren",
  "inst.aba7a7": "Abgest\xFCrzt",
  "inst.d4a100": "L\xE4uft",
  "inst.f9ab8e": "Das Programm wurde durch ein Update ersetzt; diese Instanz l\xE4uft noch mit dem alten Stand bis zum n\xE4chsten Neustart.",
  "inst.2b4695": "veraltet",
  "inst.bedfb0": "Laufende Instanzen ({p0})",
  "alarmv.d89d48": 'Aktion fehlgeschlagen (fehlende Berechtigung "operate" oder Orchestrator nicht erreichbar).',
  "alarmv.3eb4f8": "\u2713 Keine aktiven Alarme.",
  "alarmv.6b43af": "Quittiert ({p0})",
  "alarmv.1a722d": "Maskiert ({p0})",
  "alarmv.077f20": "\n        Alarme ({p0} kritisch, {p1} Warnung{p2})\n      ",
  "alarmv.95ee27": ", bis zur Zustands\xE4nderung",
  "alarmv.577e3a": "Wiederherstellen",
  "alarmv.4cac0b": "Kommentar (optional)",
  "alarmv.0e8eac": "Gesehen \u2014 bleibt sichtbar, z\xE4hlt nicht mehr als laut",
  "alarmv.146e19": "Quittieren",
  "alarmv.2ba8d2": "Dauer der Maskierung",
  "alarmv.b41fc6": "bis \xC4nderung",
  "alarmv.ce0e13": "Ausblenden aus Footer/Z\xE4hler",
  "alarmv.5323ef": "Maskieren",
  "alarms.c6fbd0": "Kritisch",
  "alarms.d00803": "Warnung",
  "alarms.72ce72": "Netz",
  "alarms.50c3a7": "Instanz",
  "alarms.03a35d": "Prozess abgest\xFCrzt",
  "alarms.a0457b": "{p0}\xD7 automatisch neu gestartet",
  "alarms.31c1e2": "Ausweichhost: {p0}",
  "alarms.c77b3a": "kein Ausweichhost frei",
  "alarms.c2ca16": "Host",
  "alarms.fee224": "\xFCberlastet ({p0}: CPU {p1}% / RAM {p2}%{p3}), {p4} Instanz(en) betroffen \u2014 {p5}",
  "alarms.808471": "OFFLINE \u2014 unerwartet ausgefallen (zuletzt gesehen {p0}), nicht manuell beendet",
  "alarms.3494ff": "offline \u2014 keine Telemetrie seit Orchestrator-Start empfangen",
  "alarms.24f47c": "Workflow",
  "alarms.ffca7b": "gestartet fehlgeschlagen",
  "health.396d45": "Healthy",
  "health.2b329f": "Unhealthy",
  "health.3cab03": "Inactive",
  "health.502f11": "Sync-Quelle: {p0}",
  "health.49ae97": "Partially Healthy",
  "health.97e7c9": "Link",
  "health.d8e87c": "Sync",
  "health.kpi.title": "Medien-Verf\xFCgbarkeit (24 h)",
  "health.kpi.hint": "Anteil der beobachteten Zeit, in der der Node Medien lieferte (Meldung \u201Emedia_ready\u201C). Zeiten ohne Meldung z\xE4hlen nicht. Der Verlauf geht bei einem Neustart des Orchestrators verloren.",
  "health.kpi.node": "Node",
  "health.kpi.avail": "Verf\xFCgbarkeit",
  "health.kpi.outages": "Ausf\xE4lle",
  "health.kpi.longest": "L\xE4ngster Ausfall",
  "health.kpi.rates": "Raten (aktuell, \xD8, min)",
  "health.kpi.observed": "Beobachtet",
  "health.1b62eb": "Health \u2014 AMWA BCP-008",
  "health.41ecdf": "{p0} Node(s) mit BCP-008-Support \xB7 aktualisiert alle {p1}s",
  "health.3b7344": "L\xE4dt\u2026",
  "health.efc263": "Keine laufenden Instanzen mit BCP-008-Support gefunden. ",
  "health.45e570": "(2110-Gateway, DeckLink, AES67-Gateway, SRT-Gateway, Recorder, Viewer, Video-Mixer unterst\xFCtzen BCP-008.)",
  "health.4333cf": "Z\xE4hler/Meldungen dieses Nodes zur\xFCcksetzen",
  "health.c963b3": "\u21BA Reset",
  "listen.a27ba8": "kein Audiostrom",
  "listen.b34670": "Abh\xF6rlautst\xE4rke",
  "listen.977a2d": "Schnellwahl",
  "listen.c8108d": "Taste anklicken, um sie mit einer Quelle zu belegen",
  "listen.ab6eb8": "Beschriftung (z. B. PGM)",
  "listen.33dddf": "Leeren",
  "listen.4b9727": "Abbrechen",
  "listen.b97d23": "Speichern",
  "listen.c15782": "Keine Audioquellen gefunden.",
  "listen.24e79f": "Taste {p0} belegen",
  "listen.e7d29a": "\u201E{p0}\u201C ist gerade nicht verf\xFCgbar.",
  "listen.45cef4": "Kan\xE4le",
  "listen.bbc45d": "Stereo",
  "listen.ca293d": "Mono-Summe (L+R) \u2014 Kompatibilit\xE4tscheck",
  "listen.7834b5": "Nur linker Kanal auf beiden Ohren",
  "listen.878f43": "Nur rechter Kanal auf beiden Ohren",
  "listen.c5103a": "\u{1F3A7} Kopfh\xF6rer-Ausgleich",
  "listen.178039": "Crossfeed: mischt einen gefilterten, leicht verz\xF6gerten Anteil des Gegenkanals zu \u2014 so wie Boxen es akustisch tun. ",
  "listen.5d839e": "Verhindert, dass das Stereobild auf Kopfh\xF6rern zu breit wirkt.",
  "listen.63e7ec": "St\xE4rke",
  "listen.00cd7b": "Mute",
  "listen.f0bddc": "Absenken (\u221220 dB)",
  "listen.669306": "Ton verz\xF6gern, bis er zum Bild in Viewer/Multiviewer passt",
  "listen.85d6d3": "Leer \u2014 Rechtsklick oder \u201EBelegen\u201C",
  "listen.6fd701": "Abh\xF6r-Controller auf-/zuklappen",
  "listen.30f29f": "ABH\xD6REN",
  "listen.756de8": "Abh\xF6ren beenden",
  "hwiz.8adbea": "Bare-Metal",
  "hwiz.5f5b8f": "Cloud (AWS EC2)",
  "hwiz.704b3b": "Zusatzkapazit\xE4t, kein PTP/Multicast (\xA76)",
  "hwiz.851e7f": "Nur Admins k\xF6nnen ein Bootstrap-Token erzeugen.",
  "hwiz.fe39d4": "Token-Erzeugung fehlgeschlagen ({p0}).",
  "hwiz.876ed3": "Orchestrator nicht erreichbar.",
  "hwiz.2b9a71": "Neuen Host hinzuf\xFCgen \u2014 Fehler",
  "hwiz.dee66f": "Neuen Host hinzuf\xFCgen (Schritt {p0}/4)",
  "hwiz.3a4a80": "Wo l\xE4uft der neue Host? Der Host-Agent verh\xE4lt sich in allen drei F\xE4llen identisch \u2014 die Auswahl bestimmt nur das unten erzeugte Provisionierungs-Skript.",
  "hwiz.2a44e7": "Label f\xFCr den neuen Host",
  "hwiz.ce2855": "z. B. Regie-Host-C",
  "hwiz.4b9727": "Abbrechen",
  "hwiz.c39838": "Weiter",
  "hwiz.25d4d9": "Bootstrap-Token wird erzeugt \u2026",
  "hwiz.7b0156": "Token erzeugt, g\xFCltig f\xFCr ",
  "hwiz.874bdf": ". Pr\xFCfe die drei Adressen (vom Zielhost aus erreichbar, ggf. anpassen) und \xFCbertrage das Skript auf den neuen Host.",
  "hwiz.df9147": "Orchestrator-URL",
  "hwiz.939ad8": "Registry-URL (vermutet)",
  "hwiz.70dfc1": "Kopiert!",
  "hwiz.c5ce55": "Skript kopieren",
  "hwiz.e50954": "Weiter \u2014 auf Anmeldung warten",
  "hwiz.cb070c": "Token abgelaufen",
  "hwiz.21a0ca": ' \u2014 \u201E{p0}" hat sich nicht gemeldet.',
  "hwiz.fa44f4": "Warte auf Anmeldung von \u201E",
  "hwiz.2ff25e": '" \u2026 (Token l\xE4uft in {p0} ab)',
  "hwiz.8a1656": "Neuen Token erzeugen",
  "hwiz.4d839e": "Der Host erscheint bei Anmeldung ohnehin in der Hosts-Liste.",
  "hwiz.2c25a7": "Host registriert.",
  "hwiz.b021df": "Label",
  "hwiz.c8f4b8": "Hostname",
  "hwiz.abbdd4": "Architektur",
  "hwiz.4d7915": "Fertig",
  "hwiz.8311b9": "Schlie\xDFen",
  "loc.fad7a2": " Hinweis: {p0}",
  "loc.669349": "Speicherorte konnten nicht geladen werden.",
  "loc.3e96ca": "Orchestrator-Rechner",
  "loc.b4e5a7": "Trotzdem anlegen",
  "loc.53b57b": "Speicherort angelegt.{p0}",
  "loc.0025a8": "Speicherort \u201E{p0}\u201C entfernen? Die Dateien bleiben unber\xFChrt, nur der Eintrag verschwindet.",
  "loc.513d30": "Entfernen",
  "loc.18a80a": "Lokale Speicherorte",
  "loc.6ab318": "Verzeichnisse oder Netzwerk-Shares, die ein Host lokal eingeh\xE4ngt hat (NFS/SMB/Platte \u2014 das Einh\xE4ngen selbst geschieht am Betriebssystem, z. B. per /etc/fstab). ",
  "loc.764153": "Hier bekommen sie einen Namen, werden auf Erreichbarkeit und Platz gepr\xFCft und erscheinen in Admin \u2192 Einstellungen als Auswahl f\xFCr Pfad-Optionen (z. B. das Medienverzeichnis eines Players).",
  "loc.54d2e5": "Noch keine Speicherorte angelegt.",
  "loc.49ee30": "Name",
  "loc.c2ca16": "Host",
  "loc.b6a791": "Pfad",
  "loc.7f5acf": "Zustand",
  "loc.f7a012": "Verwendung",
  "loc.44621c": "{p0} Einstellung(en)",
  "loc.e01524": "Auslaufen lassen",
  "loc.1a1a97": "Reaktivieren",
  "loc.88cb27": "Notiz (optional)",
  "loc.443e0a": "Pr\xFCfen und anlegen",
  "loc.7ae5b1": "Notiz",
  "nprev.a50d91": "Vorschau",
  "nprev.08fd3e": "nicht verbunden",
  "abar.5262ab": "Klicken: Alarme-Tab \xF6ffnen",
  "abar.ae4f82": "{p0} Warnung(en)",
  "sett.c2ca16": "Host",
  "sett.4c94fe": "Orchestrator",
  "sett.0cc091": " (Remote-Host)",
  "sett.b36046": " \xB7 Neustart n\xF6tig",
  "sett.eba8ae": "Standard des Nodes",
  "sett.545dfe": "Typ-Wert",
  "sett.eb6d8a": "Standard",
  "sett.6c3a69": "Node",
  "sett.ef891c": "Einstellungen konnten nicht geladen werden.",
  "sett.435a5a": "Fehler {p0}",
  "sett.473549": "Anfrage fehlgeschlagen: {p0}",
  "sett.808dfe": "{p0}\n\nTrotzdem speichern (der Pfad existiert z. B. nur auf einem Remote-Host)?",
  "sett.fad7a2": " Hinweis: {p0}",
  "sett.688b22": " {p0} laufende Instanz(en) brauchen einen Neustart (System-Update \u2192 \u201EVeraltete Instanzen neu starten\u201C, oder Instanz neu starten).",
  "sett.948895": "\u201E{p0}\u201C gespeichert \u2014 wirksam nach dem n\xE4chsten Neustart des Orchestrators.",
  "sett.27014d": "Einstellungen",
  "sett.089fb5": "Hier werden die bisher nur per Umgebungsvariable m\xF6glichen Einstellungen verwaltet. \xC4nderungen an Node-Optionen gelten ",
  "sett.347f18": "f\xFCr neu gestartete Instanzen (laufende zeigen \u201Everaltet\u201C bis zum Neustart); Betriebswerte des Orchestrators gelten nach dessen Neustart. ",
  "sett.3ef13f": "Geheimnisse und Infrastruktur-Zug\xE4nge (JWT, TLS, Datenbank) sind bewusst nicht hier \xE4nderbar.",
  "sett.3287f2": "Node-Optionen",
  "sett.33e760": "Keine Node-Typen mit Optionen (deploy/node-options.json).",
  "sett.b66666": "Alle Instanzen dieses Typs (Standard)",
  "sett.12915a": "Nur Instanz: {p0}{p1}{p2}",
  "sett.dbc566": "Typ:",
  "sett.695edd": "Gilt f\xFCr:",
  "sett.7f769f": "Neustart n\xF6tig f\xFCr: {p0} \u2014 die ge\xE4nderten Werte gelten dort erst nach einem Neustart.",
  "sett.a664c2": "Hinweis: Auf Remote-Hosts pr\xFCft der Host-Agent jeden Wert selbst gegen SEIN Schema (node-options.json neben seinem Katalog) und SEIN Dateisystem; ",
  "sett.a3ccd7": "nicht dort deklarierte Variablen werden ignoriert. Pfade gelten dort \u2014 \u201EPfad pr\xFCfen\u201C fragt bei einer Remote-Instanz den Host.",
  "sett.b97d23": "Speichern",
  "sett.02fa34": "Zur\xFCcksetzen",
  "sett.3e3767": "Speicherort w\xE4hlen \u2026",
  "sett.5fc6ec": "Pfad pr\xFCfen",
  "sett.c21537": "Kein Pfad angegeben.",
  "sett.a85e64": "Pr\xFCfe \u2026",
  "sett.f3de9d": "Pr\xFCfung fehlgeschlagen.",
  "sett.c97fd8": "Orchestrator (Betriebswerte)",
  "sett.cd73c1": "Wird geladen \u2026",
  "sett.17a397": "Beim letzten Start wurden \xDCberschreibungen verworfen:\n{p0}",
  "sett.a51de6": "Start-Konfiguration (nur lesend, Geheimnisse maskiert)",
  "sett.ef8d9d": "{p0} Aktiv: {p1}{p2} \xB7 erlaubt {p3}\u2013{p4}",
  "sched.13ac40": "l\xE4uft noch",
  "sched.4ff5c9": "sp\xE4ter",
  "sched.17d70d": "fr\xFCher",
  "sched.0d9d6e": "t\xE4glich",
  "sched.b7ca91": "w\xF6chentlich",
  "sched.mv.extend": "Ende verschieben (verl\xE4ngern/verk\xFCrzen)",
  "sched.mv.start": "Start verschieben",
  "sched.mv.move": "Verschieben",
  "sched.mv.confirm": "\u201E{p0}\u201C: {p1}\nBisher {p2} \u2192 neu {p3}.\n\xDCbernehmen?",
  "sched.mv.ok": "\xDCbernehmen",
  "sched.stopNow": "Jetzt beenden",
  "sched.stopNow.confirm": "\u201E{p0}\u201C jetzt sofort beenden? Der Zeitplan bleibt unver\xE4ndert.",
  "sched.616d9c": "Speichern fehlgeschlagen: {p0}",
  "sched.982fb6": "Keine Workflows vorhanden.",
  "sched.ffaac1": "Scheduler",
  "sched.c10105": "Tag",
  "sched.14098f": "Woche",
  "sched.1570ac": "Monat",
  "sched.02afda": "Heute",
  "sched.5f42f2": "Auf eine leere Stelle einer Zeile ziehen, um einen Zeitplan anzulegen",
  "sched.d050aa": "Neu ziehen als:",
  "sched.880a4f": "Auto-Pool",
  "sched.1dc921": "Ressourcen (Vorschau beim Ziehen)",
  "sched.7ff6ed": "Ressourcen (geplant)",
  "sched.f7d87d": "Engpass",
  "sched.f6db1b": "Bedarf/Kapazit\xE4t unbekannt",
  "sched.0c6e43": "Geplanter Bedarf = gemessenes Profil je Node-Typ (CPU: 95. Perzentil, RAM: Maximum) aller Workflows, die zu diesem Zeitpunkt laufen, ",
  "sched.449b97": "gegen die Kapazit\xE4t des Hosts. Rollen ohne Messprofil sind schraffiert (Bedarf unbekannt, nicht null).",
  "sched.569499": "Ohne Host-Festlegung (Auto-Platzierung)",
  "sched.446205": "{p0} Kerne",
  "sched.6a3c1a": "Netz {p0} je Richtung",
  "sched.0595be": "Summe aller erreichbaren Hosts: ",
  "sched.22b4a1": "Kapazit\xE4t unbekannt",
  "sched.95c28d": "Momentaufnahme der aktuellen Auslastung (nicht die Planung)",
  "sched.ed7157": "jetzt: CPU {p0} % \xB7 RAM {p1} %",
  "sched.92e155": "Kein Engpass. Freie Reserve (bis Grenzwert), Minimum im Ausschnitt: ",
  "sched.a161c7": "{p0} Netz",
  "sched.a98328": "Netzwerk",
  "sched.cddb50": "{p0} \xB7 CPU {p1} von {p2} Kernen",
  "sched.c3b17e": " \xB7 frei bis Grenzwert: {p0} Kerne",
  "sched.21a957": "{p0} \xB7 RAM {p1} von {p2}",
  "sched.c19736": " \xB7 frei bis Grenzwert: {p0}",
  "sched.0a7180": "{p0} \xB7 GPU {p1} % von {p2}",
  "sched.bd46bd": " \xB7 frei bis Grenzwert: {p0} %",
  "sched.7d0cfb": " \xB7 keine NVIDIA-GPU erkannt (nvidia-smi nicht verf\xFCgbar; Host-Agent: OMP_HOST_AGENT_GPU_INDEX nicht auf off?)",
  "sched.3bb3f9": "\n(100 % = eine volle GPU; Bedarf nur f\xFCr Typen mit gemessenem GPU-Profil)",
  "sched.560b4b": "{p0} \xB7 VRAM {p1} von {p2}",
  "sched.0818ec": " \xB7 kein Host mit gemeldeter GPU",
  "sched.f36f2d": "\n(VRAM ist eine harte Grenze: \xDCberlauf bricht Prozesse ab)",
  "sched.ab0c20": " von {p0} je Richtung",
  "sched.f154b0": " \xB7 Link-Geschwindigkeit der Karte unbekannt (Host-Agent: OMP_HOST_AGENT_NET_IFACE setzen)",
  "sched.130aa4": "\n~ = Annahme (Format der Rolle nicht gesetzt: 1080p50, bzw. Nennwert)",
  "sched.f6ba17": "{p0} \xB7 {p1}: {p2} von {p3} Port(s) belegt \xB7 frei: {p4}",
  "sched.f333a8": " Kerne",
  "sched.72ce72": "Netz",
  "sched.5baf86": "\n\u26A1 Wert = aktuell gemessene Host-Auslastung (h\xF6her als die Planung)",
  "sched.ce7463": "\n\u26A0 Bedarf unbekannt (kein Messprofil): {p0}",
  "sched.fd07d2": "\n(ung\xFCnstigster Zeitpunkt des Tages)",
  "sched.19706e": "{p0} h {p1} min",
  "sched.ed6c70": "von Hand",
  "sched.6131ad": "per Zeitplan",
  "sched.96f435": "\xFCbernommen",
  "sched.e8da08": "beim Orchestrator-Start vorgefunden",
  "sched.d9d61d": "von Hand gestoppt",
  "sched.58740c": "per Zeitplan gestoppt",
  "sched.e98ab7": "Ende nicht beobachtet",
  "sched.f621af": "Lauf: {p0} ({p1}) \u2192 {p2}",
  "sched.23c086": "Dauer: {p0}",
  "sched.b3259b": "Geplant: {p0} \u2192 {p1}",
  "sched.722ee1": "Start {p0} {p1} als geplant",
  "sched.ec6aed": "\u26A0 {p0} vor dem geplanten Stop beendet",
  "sched.700ecf": "{p0} nach dem geplanten Stop beendet",
  "sched.05f798": "Auf eine leere Stelle ziehen: neuen Zeitplan anlegen",
  "sched.162657": "Zeitplan hinzuf\xFCgen",
  "sched.71a8aa": "Start {p0}",
  "sched.9ed479": "kein Start",
  "sched.c1e806": "Stop {p0}",
  "sched.a3a320": "kein Stop",
  "sched.a6122a": "Start",
  "sched.11a755": "Stop",
  "sched.48bff0": "\u26A0 Ressourcen-Engpass durch diese \xC4nderung: {p0}",
  "sched.4c2f74": "Zeitplan anlegen: {p0}",
  "sched.9c3ca2": "Einmalig am {p0}",
  "sched.045d26": "T\xE4glich",
  "sched.e50e76": "W\xF6chentlich ({p0})",
  "sched.9a6ec4": " (als 23:59 gespeichert)",
  "sched.5daac8": "Dauer",
  "sched.d86ee9": "Netz {p0}{p1}{p2}",
  "sched.b61145": "Bedarf",
  "sched.ab1867": "\u26A0 {p0} von {p1} Rolle(n) ohne Messprofil \u2014 Bedarf unvollst\xE4ndig",
  "sched.ba0c15": "\u2713 kein neuer Ressourcen-Engpass im sichtbaren Ausschnitt",
  "sched.4b9727": "Abbrechen",
  "sched.6212ff": "Anlegen",
  "wf.dd4edc": "Regieplatz",
  "wf.324118": "Input",
  "wf.29c2c0": "Output",
  "wf.b22f04": "Audio",
  "wf.34e2d1": "Video",
  "wf.e64b29": "Grafik",
  "wf.81c1cc": "Daten",
  "wf.9090e4": "Steuerung",
  "wf.2dc84a": "Host fest",
  "wf.24eb99": "Workflow-Name ist erforderlich.",
  "wf.b97d23": "Speichern",
  "wf.6212ff": "Anlegen",
  "wf.b5f13f": 'Workflow \u201E{p0}" wirklich stoppen?',
  "wf.4c4650": "Stoppen",
  "wf.drift1": "Achtung: Bei diesen Rollen weicht der aktuelle Stand vom gespeicherten Startzustand ab: {p0}.\nBeim Stoppen gilt beim n\xE4chsten Start der GESPEICHERTE Stand \u2014 Ihre \xC4nderungen seit dem Speichern gehen verloren.\n(Abbrechen und \u201EIm Workflow speichern\u201C \xFCbernimmt den aktuellen Stand.)",
  "wf.drift2": "Trotzdem stoppen",
  "wf.2fcdd3": "Stoppen fehlgeschlagen: {p0}",
  "wf.a85624": 'Workflow \u201E{p0}" wirklich pausieren?',
  "wf.d63f99": "Pausieren",
  "wf.a73f32": "Pausieren fehlgeschlagen: {p0}",
  "wf.43069e": "Export fehlgeschlagen: {p0}",
  "wf.8a7bae": "Duplizieren fehlgeschlagen: {p0}",
  "wf.7d5095": 'Workflow als \u201E{p0}" dupliziert.',
  "wf.e7dba3": "Import fehlgeschlagen: Datei ist kein g\xFCltiges JSON ({p0})",
  "wf.6cdb17": "Import fehlgeschlagen: {p0}",
  "wf.db21f2": 'Workflow \u201E{p0}" importiert.',
  "wf.05f6da": "L\xF6schen fehlgeschlagen: {p0}",
  "wf.8a9663": "Workflows ({p0})",
  "wf.8df699": "+ Neu",
  "wf.881fa7": "Grafisch entwerfen",
  "wf.5af5fb": "Importieren",
  "wf.b7d029": "Nur sinnvoll f\xFCr Export\u2192Import auf demselben System (dieselben Nutzerkonten) \u2014 ",
  "wf.196e31": "ein Export auf ein anderes System bleibt ohne diese Option portabel.",
  "wf.937351": "Rollenbindungen und Alarmregeln mit exportieren",
  "wf.ad8902": "Noch kein Workflow angelegt.",
  "wf.bd4e9e": "Kein Workflow entspricht dem aktuellen Filter.",
  "wf.4d0c9d": "Suche (Titel, Beschreibung, Tags) \u2026",
  "wf.111336": "Alle Kategorien",
  "wf.bcec0a": "Alle Status",
  "wf.91d470": "Sicherheitsabfrage beim Stoppen",
  "wf.7b3fe9": "Latenzbudget {p0} Frames",
  "wf.46f0b8": "{p0} Zeitplan{p1}",
  "wf.527daf": "Fortsetzen",
  "wf.a6122a": "Start",
  "wf.11a755": "Stop",
  "wf.5ad05d": "Bearbeiten",
  "wf.f7bfda": "Erst stoppen/pausieren, dann bearbeiten",
  "wf.971a83": "Grafisch bearbeiten",
  "wf.1010b0": "L\xF6schen",
  "wf.bc9ab0": "Erst stoppen/pausieren, dann l\xF6schen",
  "wf.8721fc": "Exportieren",
  "wf.529fdd": "Duplizieren",
  "wf.5e9890": "Legt eine Kopie dieses Workflows an (gestoppt, neuer Name).",
  "wf.a12710": "Workflow bearbeiten",
  "wf.dfb7da": "Neuen Workflow anlegen",
  "wf.8311b9": "Schlie\xDFen",
  "wf.b2d236": "Workflow-Name",
  "wf.3b82d6": "Katalog-Metadaten (optional)",
  "wf.a964f6": "Titel (Fallback: Workflow-Name)",
  "wf.35bedb": "Beschreibung",
  "wf.ed8a68": "Tags (kommagetrennt)",
  "wf.f8c1f7": "Kategorie \u2026",
  "wf.bbef58": "Rollen & Verbindungen: {p0} Rolle(n), {p1} Verbindung(en)",
  "wf.6d7c2c": "Rollen & Verbindungen: noch keine Rolle angelegt",
  "wf.276af7": "Grafisch bearbeiten \u2192",
  "wf.17c01d": "Programm-Format (optional)",
  "wf.5be567": "Programm-Format des Workflows \u2014 leer l\xE4sst jeden Node bei seinem eigenen Default.",
  "wf.d6aaa2": "Node-Standard (kein Programm-Format)",
  "wf.f64b3f": "Latenzbudget in Video-Frames (optional)",
  "wf.741ee9": "Zeitsteuerung (optional)",
  "wf.ec5db6": "+ Zeitplan",
  "wf.b7d530": "Sicherheitsabfrage beim Stoppen verlangen",
  "wf.0d9d6e": "t\xE4glich",
  "wf.b7ca91": "w\xF6chentlich",
  "asset.311f64": " von v{p0}",
  "asset.ad67a7": "Entwurf",
  "asset.1806d2": "ver\xF6ffentlicht",
  "asset.e9e284": "Ver\xF6ffentlichen",
  "asset.f19dbc": "Archivieren",
  "asset.a7f595": "{p0}: das Asset wurde zwischenzeitlich ge\xE4ndert \u2014 Ansicht neu geladen, bitte erneut versuchen.",
  "asset.a1f55a": "{p0}: diese Version ist nicht mehr im Entwurf und damit unver\xE4nderlich \u2014 bitte eine neue Version anlegen.",
  "asset.22aa79": "{p0}: keine Berechtigung.",
  "asset.6212ff": "Anlegen",
  "asset.f4379f": "Asset \u201E{p0}\u201C angelegt.",
  "asset.f5ce47": "Asset \u201E{p0}\u201C als gel\xF6scht markieren? Das ist ein Endzustand \u2014 er l\xE4sst sich nicht r\xFCckg\xE4ngig machen.",
  "asset.1010b0": "L\xF6schen",
  "asset.a0ba57": "Statuswechsel",
  "asset.d9a5d0": "Status: {p0}",
  "asset.d6ea46": "Metadaten speichern",
  "asset.5156b5": "Metadaten gespeichert.",
  "asset.78e208": "Version anlegen",
  "asset.c3b3be": "Version v{p0} angelegt (Entwurf).",
  "asset.aa9c03": "v{p0} ver\xF6ffentlichen? Danach ist die Version unver\xE4nderlich und wird zur aktuellen Version des Assets.",
  "asset.969e32": "v{p0}: {p1} erledigt.",
  "asset.d6bd6d": "Representation anlegen",
  "asset.82ffcd": "Representation angelegt.",
  "asset.bcaf91": "Representation \u201E{p0}\u201C ({p1}) entfernen?",
  "asset.513d30": "Entfernen",
  "asset.635d5f": "Representation entfernen",
  "asset.a2d14c": "Collection anlegen fehlgeschlagen: {p0}",
  "asset.8e4d30": "Collection \u201E{p0}\u201C angelegt.",
  "asset.616d9c": "Speichern fehlgeschlagen: {p0}",
  "asset.314d13": "Collection aktualisiert.",
  "asset.295f4a": "Collection \u201E{p0}\u201C l\xF6schen? Die enthaltenen Assets bleiben unver\xE4ndert erhalten.",
  "asset.05f6da": "L\xF6schen fehlgeschlagen: {p0}",
  "asset.3f05b9": "Hinzuf\xFCgen fehlgeschlagen: {p0}",
  "asset.64bd21": "Entfernen fehlgeschlagen: {p0}",
  "asset.094e46": "Beziehung anlegen fehlgeschlagen: {p0}",
  "asset.9c121d": "Beziehung angelegt.",
  "asset.fd5d3f": "Diese Beziehung entfernen?",
  "asset.8df699": "+ Neu",
  "asset.9aedea": "Assets",
  "asset.a9fc91": "Collections",
  "asset.e603cf": "+ Neue Collection",
  "asset.436362": "Suche (Titel, Beschreibung, Typ, Metadaten) \u2026",
  "asset.purge": "Gel\xF6schte aufr\xE4umen ({p0})",
  "asset.purge.title": "Als gel\xF6scht markierte Assets endg\xFCltig entfernen (mit Versionen, Darstellungen, Pr\xFCfdaten und Proxys; die Quelldateien bleiben)",
  "asset.purge.confirm": "{p0} gel\xF6schte Assets endg\xFCltig entfernen? Das l\xE4sst sich nicht r\xFCckg\xE4ngig machen. Versionen, Darstellungen, QC-Berichte und Proxys dazu werden mit entfernt, die Quelldateien auf der Platte bleiben unber\xFChrt.",
  "asset.purge.ok": "Endg\xFCltig entfernen",
  "asset.purge.done": "{p0} Assets entfernt",
  "asset.purge.what": "Aufr\xE4umen",
  "asset.7cf160": "Gel\xF6schte anzeigen",
  "asset.189c03": "Alle Typen",
  "asset.bcec0a": "Alle Status",
  "asset.81c00b": "Assets ({p0})",
  "asset.030c2c": "Assets ({p0} von {p1})",
  "asset.d82a29": "Noch kein Asset angelegt.",
  "asset.134dba": "Kein Asset passt zum Filter.",
  "asset.4f17fd": "Collections ({p0})",
  "asset.3c636c": 'Noch keine Collection angelegt \u2014 mit \u201E+ Neue Collection" die erste anlegen.',
  "asset.fc1c89": "Links ein Asset ausw\xE4hlen oder mit \u201E+ Neu\u201C anlegen.",
  "asset.c90ab1": 'Links eine Collection ausw\xE4hlen oder mit \u201E+ Neue Collection" anlegen.',
  "asset.ce0116": "\n        Angelegt von {p0} am {p1}\n      ",
  "asset.5ad05d": "Bearbeiten",
  "asset.6a7843": "Mitglieder ({p0})",
  "asset.a88ee3": "+ Asset hinzuf\xFCgen",
  "asset.046622": "Noch kein Asset in dieser Collection.",
  "asset.074891": "Beziehungen ({p0})",
  "asset.d19df7": "Keine Beziehung zu anderen Assets (z. B. \u201Eabgeleitet von\u201C, \u201ETeil von\u201C).",
  "asset.565da9": "Verkn\xFCpfte Prozessl\xE4ufe{p0} ({p1})",
  "asset.a6915d": "Zuerst eine Version ausw\xE4hlen.",
  "asset.8599a1": "Kein Prozesslauf verkn\xFCpft. Verkn\xFCpfen geschieht im Prozesse-Tab an der jeweiligen Execution.",
  "asset.9f8ebb": "\n        Typ {p0} \xB7 aktuelle Version {p1} \xB7\n        angelegt von {p2} am {p3} \xB7\n        zuletzt ge\xE4ndert von {p4} am {p5}\n      ",
  "asset.d3fbe7": "Status \xE4ndern:",
  "asset.6e8ae6": "Endzustand \u2014 keine weiteren Statuswechsel.",
  "asset.154818": "Metadaten",
  "asset.efacd0": "Noch keine Metadaten.",
  "asset.54741f": "Versionen ({p0})",
  "asset.d3bb06": "+ Neue Version",
  "asset.0ac367": "Noch keine Version \u2014 eine Version b\xFCndelt die technischen Dateien (Representations) eines Standes.",
  "asset.ec53a8": "Status",
  "asset.9bc05d": "Basis",
  "asset.14ad87": "\xC4nderungsgrund",
  "asset.2c51ef": "Angelegt",
  "asset.49fb73": "\u2605 = aktuelle Version. Zeile anklicken, um deren Representations zu sehen.",
  "asset.199987": "Representations{p0} ({p1})",
  "asset.6a2235": "Zuerst eine Version anlegen.",
  "asset.a59590": "v{p0} ist {p1} und damit unver\xE4nderlich \u2014 f\xFCr andere Dateien eine neue Version anlegen.",
  "asset.7f6a70": "Keine Representations (z. B. Master, Proxy, Thumbnail).",
  "asset.c2ea84": "Typ",
  "asset.601a93": "Speicherort",
  "asset.5f06f4": "Technik",
  "asset.4b9727": "Abbrechen",
  "asset.e2fe67": "Neues Asset",
  "asset.c9d8af": "z. B. video",
  "asset.18a802": "Titel",
  "asset.45befe": "Titel *",
  "asset.c8e212": "Typ *",
  "asset.344254": "Freier Wert \u2014 Vorschl\xE4ge per Pfeiltaste.",
  "asset.35bedb": "Beschreibung",
  "asset.00b84d": "Titel und Typ sind erforderlich.",
  "asset.b49ee1": "Collection bearbeiten",
  "asset.9ee309": "Neue Collection",
  "asset.b97d23": "Speichern",
  "asset.6699b7": "Titel ist erforderlich.",
  "asset.c68bfe": "Asset zu \u201E{p0}\u201C hinzuf\xFCgen",
  "asset.0ce4cb": "\u2013 kein weiteres Asset verf\xFCgbar \u2013",
  "asset.26e905": "Asset",
  "asset.5f4110": "Hinzuf\xFCgen",
  "asset.20f3e9": "Kein Asset ausgew\xE4hlt.",
  "asset.7963f5": "Beziehung von \u201E{p0}\u201C",
  "asset.398542": "Richtung",
  "asset.323d87": "Anderes Asset *",
  "asset.aa0d98": "Art der Beziehung *",
  "asset.205050": "Anderes Asset und Art der Beziehung sind erforderlich.",
  "asset.7114fa": "Neue Version",
  "asset.d4746f": "\u2013 keine (unabh\xE4ngiger Stand) \u2013",
  "asset.b9f0e4": "z. B. neuer Farbabgleich",
  "asset.060e7f": "Basiert auf",
  "asset.c7688e": "Die neue Version startet als Entwurf; Representations werden an ihr erg\xE4nzt, dann ver\xF6ffentlicht.",
  "asset.ea7ae7": "Representation zu v{p0}",
  "asset.6008d4": "z. B. master",
  "asset.6fc755": "/media/clip.mov oder s3://bucket/key",
  "asset.1b3b2a": "Speicher *",
  "asset.6a54d0": "Pfad/URI *",
  "asset.ceab9e": "Technische Angaben (optional)",
  "asset.520d0d": "Format",
  "asset.8ca990": "Codec",
  "asset.0e7278": "Container",
  "asset.f04780": "Breite (px)",
  "asset.4572e8": "H\xF6he (px)",
  "asset.f5a3b3": "Bildrate (fps)",
  "asset.ea2e71": "Abtastrate (Hz)",
  "asset.45cef4": "Kan\xE4le",
  "asset.39f415": "Bitrate (bit/s)",
  "asset.3d5734": "Gr\xF6\xDFe (Bytes)",
  "asset.efd646": "Pr\xFCfsumme",
  "asset.4d3ebb": "Typ, Speicher und Pfad/URI sind erforderlich.",
  "asset.1159be": "{p0}: keine g\xFCltige {p1}Zahl.",
  "asset.b1d04a": "Metadaten: {p0}",
  "asset.6d686f": "Feldname",
  "asset.48bce5": "JSON-Wert",
  "asset.5a597b": "Wert",
  "asset.fc9b0f": "Strukturierter Wert (Zahl/Ja-Nein/Liste) \u2014 als JSON bearbeiten",
  "asset.53f0ae": "Feld entfernen",
  "proc.11386c": "Zugewiesen: {p0}",
  "proc.83d9fd": "Nicht zugewiesen",
  "proc.d3e635": "Zuletzt ge\xE4ndert",
  "proc.49ee30": "Name",
  "proc.62c21d": "Angelegt von",
  "proc.ec53a8": "Status",
  "proc.73f8e4": 'Prozess \u201E{p0}" mit allen Versionen und der Ausf\xFChrungs-Historie endg\xFCltig l\xF6schen?',
  "proc.1010b0": "L\xF6schen",
  "proc.05f6da": "L\xF6schen fehlgeschlagen: {p0}",
  "proc.862e41": 'Prozess \u201E{p0}" gel\xF6scht.',
  "proc.055ecb": "Anlegen fehlgeschlagen: {p0}",
  "proc.efc8c6": "Prozess-Definition angelegt.",
  "proc.9c01ed": "Version anlegen fehlgeschlagen: {p0}",
  "proc.62626a": "Version angelegt{p0}.",
  "proc.433ea0": "Ung\xFCltiges Input-JSON: {p0}",
  "proc.f6d6b4": "Start fehlgeschlagen: {p0}",
  "proc.38419a": "Execution gestartet.",
  "proc.ba4a47": "Verkn\xFCpfen fehlgeschlagen: {p0}",
  "proc.e14b84": "Asset verkn\xFCpft.",
  "proc.64bd21": "Entfernen fehlgeschlagen: {p0}",
  "proc.ca6fd6": "Zuweisen fehlgeschlagen: {p0}",
  "proc.fc886f": "Aktion fehlgeschlagen: {p0}",
  "proc.8df699": "+ Neu",
  "proc.cbb97d": "Suche (Name, Kategorie, Beschreibung, Nutzer) \u2026",
  "proc.2c9513": "Sortieren:",
  "proc.5adedc": "Prozesse ({p0})",
  "proc.dbd8d0": "Prozesse ({p0} von {p1})",
  "proc.f07b49": "Noch keine Prozess-Definition angelegt.",
  "proc.b2e353": "Kein Prozess passt zum Filter.",
  "proc.0d7ac2": "Links eine Prozess-Definition ausw\xE4hlen.",
  "proc.a75bfb": "\n          Angelegt von {p0} am {p1}\n        ",
  "proc.e524e0": "Prozess l\xF6schen",
  "proc.4a833e": "L\xF6scht den Prozess mit allen Versionen und der Historie (nicht m\xF6glich, solange Ausf\xFChrungen laufen)",
  "proc.54741f": "Versionen ({p0})",
  "proc.d3bb06": "+ Neue Version",
  "proc.72fc01": "Noch keine Version.",
  "proc.b9b524": "Start-Schritt",
  "proc.2c51ef": "Angelegt",
  "proc.5ad05d": "Bearbeiten",
  "proc.6e31cb": "\xD6ffnet v{p0} im grafischen Editor \u2014 Speichern legt eine neue Draft-Version an",
  "proc.e9e284": "Ver\xF6ffentlichen",
  "proc.f19dbc": "Archivieren",
  "proc.f50fc9": "Starten",
  "proc.ba1f4c": "Deprecaten",
  "proc.d8cfda": "Executions ({p0})",
  "proc.b36d04": "Noch keine Execution.",
  "proc.bdff97": "Gestartet",
  "proc.e5a557": "Abgeschlossen",
  "proc.4b9727": "Abbrechen",
  "proc.d63f99": "Pausieren",
  "proc.527daf": "Fortsetzen",
  "proc.84f4b2": "\n      Schritte{p0}\n    ",
  "proc.a2a88e": "Human Tasks dieser Execution",
  "proc.718f46": "Verkn\xFCpfte Assets ({p0})",
  "proc.c63d58": "+ Asset verkn\xFCpfen",
  "proc.626cee": "Keine Asset-Version verkn\xFCpft \u2014 z. B. eine Datei, die dieser Lauf gelesen oder erzeugt hat.",
  "proc.513d30": "Entfernen",
  "proc.8500e1": "Asset verkn\xFCpfen",
  "proc.1fdf08": "Verkn\xFCpft eine Asset-Version mit dieser Execution \u2014 z. B. eine Datei, die dieser Lauf gelesen (Input) oder erzeugt (Output) hat.",
  "proc.e24d2a": "\u2013 Asset w\xE4hlen \u2013",
  "proc.e9c23c": "\u2013 l\xE4dt \u2026 \u2013",
  "proc.09aee0": "\u2013 keine Version vorhanden \u2013",
  "proc.1b0fe9": "\u2013 zuerst ein Asset w\xE4hlen \u2013",
  "proc.45e007": "Output \u2014 von diesem Lauf erzeugt",
  "proc.c36918": "Input \u2014 von diesem Lauf gelesen",
  "proc.2c7495": "Verkn\xFCpfen",
  "proc.db8c44": "Bitte ein Asset und eine Version w\xE4hlen.",
  "proc.a6fed1": "Meine Human Tasks ({p0})",
  "proc.2084fb": "F\xFCr mich beanspruchen",
  "proc.bc0a4d": "Genehmigen",
  "proc.5e17b3": "Ablehnen",
  "proc.c4ca49": "\xC4nderungen anfordern",
  "proc.8435ef": "Kommentar (optional):",
  "proc.47c409": "Neue Prozess-Definition",
  "proc.31805a": "Kategorie (optional)",
  "proc.234de2": "Beschreibung (optional)",
  "proc.6212ff": "Anlegen",
  "proc.681403": "Name ist erforderlich.",
  "proc.d1ceb6": "Execution starten",
  "proc.ad18ad": "Input als JSON (optional, leer lassen f\xFCr kein Input).",
  "flow.49602e": "unbekannter Fehler",
  "flow.90e2ce": "MXL ist host-lokal \u2014 f\xFCr Hostgrenzen ST-2110/SRT-Gateway (D4) einsetzen",
  "flow.616b70": "Layout konnte nicht gespeichert werden: {p0}",
  "flow.6b0072": "{p0} abgest\xFCrzt: {p1}",
  "flow.a2865c": "{p0} automatisch neu gestartet ({p1}. Neustart)",
  "flow.879697": "Host nicht mehr erreichbar",
  "flow.08e5ad": "Prozess-Absturz",
  "flow.20b36c": 'Rolle \u201E{p0}" auf Standby umgeschaltet ({p1})',
  "flow.b40ef3": "Orchestrator-Host (lokal)",
  "flow.02d6ca": "Unzugeordnet",
  "flow.28a45c": "Gruppen \xFCber mehrere Hosts",
  "flow.ef06dd": "Workflow nicht gefunden.",
  "flow.ea2b0e": 'Workflow \u201E{p0}" ist gerade \u201E{p1}" \u2014 kurz warten und erneut versuchen.',
  "flow.a7431c": "Ungespeicherte \xC4nderungen verwerfen?",
  "flow.3a12ad": "Verbindung trennen",
  "flow.26927b": "Zielrolle anklicken, um zu verbinden (oder hier klicken zum Abbrechen) \u2014 ziehen zum Verschieben",
  "flow.26ea5c": "Klicken, dann Zielrolle anklicken, um zu verbinden \u2014 ziehen zum Verschieben",
  "flow.50a83a": "Doppelklick zum Umbenennen \u2014 dieser Name erscheint als Sender-/Crosspoint-Label (Nutzerwunsch 2026-07-30: sprechende Namen).",
  "flow.fc94ec": "Rolle entfernen",
  "flow.19bea4": "Ein Workflow braucht mindestens eine Rolle.",
  "flow.a65046": 'Name "{p0}" ist schon vergeben oder ung\xFCltig.',
  "flow.50ba57": "Verbindung besteht bereits.",
  "flow.616d9c": "Speichern fehlgeschlagen: {p0}",
  "flow.00d76f": "Workflow gespeichert.",
  "flow.b2892b": "Im Workflow speichern nicht m\xF6glich \u2014 ohne Launcher-Instanz (nicht \xFCber den Katalog gestartet): {p0}",
  "flow.303686": "Keine speicherbaren Nodes in diesem Workflow.",
  "flow.3fa58b": "Workflow gespeichert (wirkt beim n\xE4chsten Start).",
  "flow.224cb4": "{p0} \u2014 Doppelklick zum Bearbeiten",
  "flow.010533": "Bearbeiten (live): {p0}",
  "flow.f3e350": "Bearbeiten: {p0}",
  "flow.de024d": "Auto-Anordnen",
  "flow.486700": "Kacheln nach Signalfluss anordnen \u2014 Quellen links, Senken rechts.",
  "flow.b97d23": "Speichern",
  "flow.27e3d2": "Keine ungespeicherten \xC4nderungen",
  "flow.save_live_state": "Speichert auch den aktuellen Zustand der Nodes (Muster, Keyer, Kan\xE4le \u2026) als Startzustand",
  "flow.82f357": "Verlassen",
  "flow.05b4ea": "Alle einpassen",
  "flow.9f38fa": "In der Host-Ansicht bestimmen die Host-Zonen die Anordnung.",
  "flow.981290": "Host-Ansicht: An",
  "flow.7818c8": "Host-Ansicht: Aus",
  "flow.5c618d": "Gruppe aufl\xF6sen",
  "flow.1b8280": "Als Workflow speichern",
  "flow.566f18": "Name der Gruppe:",
  "flow.14466a": "Neue Gruppe",
  "flow.ec7506": "Gruppe enth\xE4lt keine Nodes.",
  "flow.2bd04d": "Als Workflow speichern nicht m\xF6glich \u2014 ohne Launcher-Instanz (nicht \xFCber den Katalog gestartet): {p0}",
  "flow.dc80a2": "Als Workflow speichern fehlgeschlagen: {p0}",
  "flow.bec446": 'Workflow \u201E{p0}" angelegt und l\xE4uft bereits (aus der laufenden Gruppe \xFCbernommen).',
  "flow.514366": "Host online",
  "flow.eda8d2": "Host offline \u2014 zuletzt gesehen {p0}",
  "flow.61ea4b": "Host offline \u2014 keine Telemetrie empfangen",
  "flow.1efb39": "Offline \xB7 zuletzt {p0}",
  "flow.7bb93c": "Offline \xB7 keine Telemetrie",
  "flow.17b308": "Geplant (nicht gestartet)",
  "flow.4d543b": "{p0} Kacheln",
  "flow.8f9c92": "Zone ausklappen",
  "flow.f98ead": "Zone einklappen",
  "flow.db1020": "Breite ziehen",
  "flow.abd1ab": "Teil des gerade angezeigten Traces (Diagnose-Cockpit, ARCHITECTURE.md \xA725.3).",
  "flow.tallyFrom": "Auf Sendung durch: {p0}",
  "flow.25b847": "Standby (warm) \u2014 \xFCbernimmt automatisch, wenn die Prim\xE4rrolle ausf\xE4llt (K7 Teil 4).",
  "flow.0fb497": "Instanz stoppen",
  "flow.3c5208": "Workflow stoppen",
  "flow.a50d91": "Vorschau",
  "flow.08fd3e": "nicht verbunden",
  "flow.7cfa62": "Kein anderer Host verf\xFCgbar.",
  "flow.3d4180": '\u201E{p0}" nach \u201E{p1}" verschieben? Die Instanz wird gestoppt und dort neu gestartet, bestehende Verbindungen werden nach M\xF6glichkeit wiederhergestellt.',
  "flow.cc0806": "Verschieben",
  "flow.f6dbd5": "Umzug fehlgeschlagen: {p0}",
  "flow.e16d95": 'Rolle \u201E{p0}" nach \u201E{p1}" verschieben? Eine neue Instanz startet dort, Bedienzustand/Verbindungen werden \xFCbernommen \u2014 erst danach wird die alte Instanz gestoppt.',
  "flow.07f4ca": "Rollen-Umzug fehlgeschlagen: {p0}",
  "flow.c23a7f": "Diagnose \xF6ffnen",
  "flow.eeaf61": "Verbindung fehlgeschlagen: {p0}",
  "flow.e6871e": "Trennen fehlgeschlagen: {p0}",
  "flow.3b7344": "L\xE4dt\u2026",
  "flow.c9533f": "Als Operator ansehen \u2197",
  "flow.d7db68": "Descriptor konnte nicht geladen werden: {p0}",
  "flow.6f8bd9": "Rollen-Zielformat",
  "flow.386c76": "Node-Standard",
  "flow.c3d104": "\xDCbernehmen (Node neu starten)",
  "flow.dbf07d": 'Rolle "{p0}" mit neuem Format neu starten? Der Node ist dabei kurz nicht erreichbar, der Rest des Workflows l\xE4uft weiter.',
  "flow.7b8028": "Neustart fehlgeschlagen: {p0}",
  "flow.459c64": 'Rolle "{p0}" wird mit neuem Format neu gestartet \u2026',
  "flow.502f11": "Sync-Quelle: {p0}",
  "flow.ab3278": "Auto-Reset \xE4ndern fehlgeschlagen: {p0}",
  "flow.30f273": "Auto-Reset",
  "flow.68212a": "Delay \xE4ndern fehlgeschlagen: {p0}",
  "flow.7b2ec4": "Delay (ms)",
  "flow.e4dd8e": "Z\xE4hler zur\xFCcksetzen",
  "flow.926b5a": "Reset fehlgeschlagen: {p0}",
  "flow.418e13": 'Parameter \u201E{p0}" fehlgeschlagen: {p1}',
  "flow.a5a7f7": 'Wert f\xFCr \u201E{p0}" ({p1}):',
  "flow.f19b62": 'Methode \u201E{p0}" fehlgeschlagen: {p1}',
  "flow.1644b5": "Szene anwenden",
  "flow.0087f5": "Snapshot anwenden fehlgeschlagen: {p0}",
  "flow.28c94f": "Snapshot mit {p0} Fehler(n) angewendet",
  "flow.322f5f": "Node-Katalog",
  "flow.191493": "Katalog leer.",
  "flow.26fdfa": "Suchen\u2026",
  "flow.c977e2": "Keine Treffer.",
  "flow.ada9a7": "Zielhost",
  "flow.390d13": "\u25CB {p0} (offline)",
  "flow.b6057c": "Bedarf unbekannt (erster Start dieses Typs)",
  "flow.bd6623": " (Typ-Sch\xE4tzung, kein Wert f\xFCr diesen Host)",
  "flow.3cfe9b": "\u21BB {p0}\xD7 automatisch neu gestartet",
  "flow.f1da4b": "Host: {p0}",
  "flow.03a35d": "Prozess abgest\xFCrzt",
  "flow.513d30": "Entfernen",
  "flow.11a755": "Stop",
  "flow.f6d6b4": "Start fehlgeschlagen: {p0}",
  "flow.f0052e": "{p0} wird gestartet \u2026",
  "flow.cb1616": 'Instanz \u201E{p0}" wirklich stoppen?',
  "flow.4c4650": "Stoppen",
  "flow.confirmStartNode": 'Node \u201E{p0}" wirklich starten?',
  "inst.actions": "Aktionen",
  "inst.rename": "Umbenennen",
  "inst.migrate": "Verschieben \u2026",
  "inst.save": "Speichern",
  "inst.cancel": "Abbrechen",
  "inst.renameTitle": "Anzeigename \xE4ndern (die Instanz-ID bleibt)",
  "inst.migrateTitle": "Instanz auf einen anderen Host verschieben",
  "inst.renameFailed": "Umbenennen fehlgeschlagen: {p0}",
  "inst.migrateFailed": "Verschieben fehlgeschlagen: {p0}",
  "inst.confirmMigrate": 'Instanz \u201E{p0}" auf Host \u201E{p1}" verschieben?',
  "inst.confirmMigrateLabel": "Verschieben",
  "inst.localHost": "lokal",
  "inst.renameNotApplied": "Name gespeichert, der Node ist aber nicht erreichbar bzw. kann ihn noch nicht live \xFCbernehmen \u2014 gilt nach dem n\xE4chsten Neustart.",
  "flow.nameOptional": "Name (optional)",
  "flow.nodeSearch.placeholder": "Node suchen\u2026",
  "flow.nodeSearch.none": "Kein Node gefunden",
  "flow.nodeSearch.hidden": "Node \u201E{p0}\u201C ist Teil eines laufenden Workflows und in dieser Ansicht ausgeblendet.",
  "flow.nodeSearch.title": "Node suchen",
  "psc.target.placeholder": "leer = Standard der Job-Einstellungen",
  "psc.target.label": "Ausf\xFChrungsort (ffmpeg/ffprobe)",
  "psc.target.help": "Wo der Schritt l\xE4uft: leer = Standard (Administration \u2192 ffmpeg-Jobs), auto = nach Last, local = Orchestrator-Rechner, host:<id>, pool:<name>.",
  "topo.title": "Topologie der Hosts",
  "topo.hint": "K\xE4sten sind Hosts mit ihren Nodes, Linien Verbindungen zwischen Hosts (Zahl = Anzahl der Verbindungen, Dicke w\xE4chst mit ihr). Verbindungen innerhalb eines Hosts stehen im Kasten. Der senkrechte Strich im CPU-Balken ist die Grenze, ab der Jobs nicht mehr starten (Live-Reserve). Ein Klick auf einen Kasten zeigt unten seinen Verlauf.",
  "hosts.clock.badge": "Uhr",
  "hosts.clock.unsynced": "Die Systemuhr dieses Hosts ist nicht synchronisiert (NTP/PTP): Zeitfehler bis {err} \xB5s, Schaltzeitpunkte und MXL-Zeitstempel weichen von anderen Hosts ab.",
  "hosts.clock.tai": "Der TAI-Versatz der Systemuhr ist nicht gesetzt (CLOCK_TAI = UTC, derzeit 37 s daneben): MXL-Zeitstempel und Schaltzeitpunkte stimmen nicht mit anderen Hosts \xFCberein. Mit chrony (`leapsectz`/`tai`) oder ptp4l setzen.",
  "hosts.clock.unsynced+tai": "Die Systemuhr ist weder synchronisiert (NTP/PTP) noch ist der TAI-Versatz gesetzt: MXL-Zeitstempel und Schaltzeitpunkte weichen von anderen Hosts ab.",
  "hosts.clock.fix.no-permission": "Der Rechner hat versucht, die Uhr selbst zu stellen, darf es aber nicht (CAP_SYS_TIME fehlt): als root starten, AmbientCapabilities=CAP_SYS_TIME im systemd-Dienst setzen oder chrony installieren.",
  "hosts.clock.fix.no-server": "Der Rechner hat versucht, die Uhr selbst zu stellen, aber kein NTP-Server antwortete (OMP_CLOCK_NTP_SERVERS pr\xFCfen).",
  "topo.none": "Noch keine Hosts oder Nodes.",
  "topo.local": "Orchestrator-Host",
  "topo.extern": "Ohne Instanz (extern)",
  "topo.offline": "offline",
  "topo.maintenance": "Wartung",
  "topo.nodes": "{p0} Nodes",
  "topo.more": "+{p0} weitere",
  "topo.internal": "{p0} interne Verbindungen",
  "topo.jobs": "Jobs {p0}",
  "topo.linkTitle": "{p0} \u2192 {p1}: {p2} Verbindung(en) ({p3})",
  "trend.title": "Verlauf",
  "trend.host": "Host",
  "trend.metric.cpu": "CPU",
  "trend.metric.mem": "RAM",
  "trend.metric.live": "Live-Nodes (CPU)",
  "trend.metric.gpu": "GPU",
  "trend.metric.temp": "Temperatur",
  "trend.metric.power": "Leistung",
  "trend.note.temp": "CPU-/Plattformtemperatur des Hosts in \xB0C (nur Hosts mit Sensor; Alarm ab OMP_ALERT_TEMP_C).",
  "trend.note.power": "Leistungsaufnahme in Watt: CPU-Paket (RAPL) bzw. Gesamtger\xE4t bei Akkubetrieb (nur wenn der Host sie liefert).",
  "trend.metric.net": "Netz",
  "trend.collecting": "Es werden noch Messwerte gesammelt.",
  "trend.noData": "F\xFCr diese Gr\xF6\xDFe liegen keine Messwerte vor (nicht gemessen).",
  "trend.reserveLimit": "Jobs starten nur unter {p0} %",
  "trend.peak": "Spitze",
  "trend.note.cpu": "Gesamtauslastung des Hosts; Linie = Mittelwert, Band = bis zur Spitze.",
  "trend.note.mem": "Belegter Arbeitsspeicher in % des Hosts.",
  "trend.note.live": "CPU-Anteil der vom Orchestrator bzw. Host-Agent gestarteten Nodes (ohne ffmpeg-Jobs) \u2014 Grundlage der Auto-Kalibrierung der Live-Reserve.",
  "trend.note.gpu": "Auslastung der konfigurierten GPU (nur mit OMP_HOST_AGENT_GPU_INDEX).",
  "trend.note.net": "Auslastung der Netzwerkkarte in % der Linkgeschwindigkeit (nur wenn bekannt).",
  "alarms.predicted": "{p0}: Trend \u2014 der Host erreicht voraussichtlich in ca. {p1} min die Grenze (jetzt CPU {p2} % / RAM {p3} %), {p4} Instanz(en) betroffen \u2014 {p5}",
  "hosts.predicted": "{p0}: Trend \u2014 der Host erreicht voraussichtlich in ca. {p1} min die Grenze (jetzt CPU {p2} % / RAM {p3} %), {p4} Instanz(en) betroffen \u2014 {p5}",
  "hosts.predictedBadge": "Vorwarnung",
  "flow.nameOptionalTitle": 'Eigener Anzeigename der Instanz (leer = automatisch \u201ETyp (Kurz-ID)"). Die Instanz-ID bleibt unabh\xE4ngig davon.',
  "inst.restart": "Neustart",
  "inst.restartTitle": "Node-Prozess beenden und neu starten (Sendung dieser Instanz wird unterbrochen)",
  "inst.confirmRestart": 'Instanz \u201E{p0}" wirklich neu starten? Laufende Ausgabe dieses Nodes wird kurz unterbrochen.',
  "inst.confirmRestartLabel": "Neu starten",
  "inst.restartFailed": "Neustart fehlgeschlagen: {p0}",
  "inst.restarted": '\u201E{p0}" wurde neu gestartet.',
  "flow.sd.title": "Node starten: {p0}",
  "flow.sd.startBtn": "Starten \u2026",
  "flow.sd.addRoleBtn": "Als Rolle hinzuf\xFCgen",
  "flow.sd.running": "{p0} laufend",
  "flow.sd.name": "Name (optional)",
  "flow.sd.namePh": "automatisch",
  "flow.sd.nameHint": "Erscheint in Kachel und Kreuzschiene. Leer = automatischer Name mit Kurz-ID.",
  "flow.sd.local": "(lokal)",
  "cc.title": "Karte und Anschl\xFCsse",
  "cc.none": "Auf diesem Host wurden keine Capture-Karten erkannt.",
  "cc.unnamed": "Capture-Karte",
  "cc.selectAll": "Alle freien w\xE4hlen",
  "cc.connector": "Anschluss {p0}",
  "cc.in": "Eingang",
  "cc.out": "Ausgang",
  "cc.noIn": "kein Eingang",
  "cc.noOut": "kein Ausgang",
  "cc.both": "Ein- und Ausgang (Duplex)",
  "cc.remove": "Entfernen",
  "cc.removeTitle": "Dieses von Hand angelegte Ger\xE4t aus der Liste entfernen (nur wenn kein Anschluss belegt ist)",
  "cc.manual": "Karte ohne automatische Erkennung hinzuf\xFCgen (Matrox xMIO / DSX LE5)",
  "cc.manualHint": "Matrox liefert kein \xF6ffentliches GStreamer-Plugin und keine Ger\xE4teabfrage. Legen Sie hier die Anschl\xFCsse Ihrer Karte an; f\xFCr den Betrieb braucht der Host ein auf dem Matrox-SDK gebautes Plugin.",
  "cc.manualName": "Name, z. B. xMIO3",
  "cc.manualCount": "Anschl\xFCsse:",
  "cc.manualAdd": "Hinzuf\xFCgen",
  "cc.kindDuplex": "Ein- und Ausgang (Duplex)",
  "cc.kindIn": "nur Eingang",
  "cc.kindOut": "nur Ausgang",
  "cc.elements": "GStreamer-Elemente des Matrox-Plugins",
  "cc.elementsHint": "Vier Elementnamen, durch Komma getrennt: Videoquelle, Audioquelle, Videosenke, Audiosenke.",
  "cc.free": "frei",
  "cc.used": "belegt ({p0})",
  "cc.pick": "Mindestens einen Anschluss w\xE4hlen. Duplex-Anschl\xFCsse liefern Eingang und Ausgang gleichzeitig.",
  "cc.summary": "Gew\xE4hlt: {p0} Eingang/Eing\xE4nge, {p1} Ausgang/Ausg\xE4nge \u2014 alle in einer Instanz.",
  "cc.needHost": "Zuerst einen Host w\xE4hlen: Karten werden auf dem Host erkannt, an dem sie stecken.",
  "cc.searching": "Karten werden gesucht \u2026",
  "cc.error": "Kartenerkennung fehlgeschlagen: {p0}",
  "flow.sd.settings": "Einstellungen ({p0})",
  "flow.sd.settingsHint": "Nur ausf\xFCllen, was f\xFCr diese Instanz abweichen soll. Leere Felder \xFCbernehmen den Wert des Node-Typs bzw. den Standard.",
  "flow.sd.emptyIs": "leer = {p0}",
  "flow.sd.emptyDefault": "leer = Standard des Nodes",
  "flow.sd.resolution": "Aufl\xF6sung",
  "flow.sd.resolutionHint": "Bildgr\xF6\xDFe in Pixeln. \u201EEigene Werte\u201C f\xFCr andere Ma\xDFe; Standard = Format des Workflows bzw. des Nodes.",
  "flow.sd.rateHint": "Bilder pro Sekunde (29,97 und 59,94 sind 30000/1001 bzw. 60000/1001). \u201EEigene Werte\u201C f\xFCr Z\xE4hler/Nenner.",
  "flow.sd.rate": "Bildrate",
  "flow.sd.presetDefault": "Standard (Format des Workflows bzw. des Nodes)",
  "flow.sd.presetCustom": "Eigene Werte \u2026",
  "flow.sd.fps": "{p0} Bilder/s",
  "flow.sd.width": "Breite",
  "flow.sd.height": "H\xF6he",
  "flow.sd.rateNum": "Z\xE4hler",
  "flow.sd.rateDen": "Nenner",
  "flow.confirmStartLabel": "Starten",
  "wf.confirmStart": 'Workflow \u201E{p0}" wirklich starten?',
  "wf.confirmStartLabel": "Starten",
  "wf.confirmDelete": 'Workflow \u201E{p0}" wirklich l\xF6schen?',
  "wf.confirmDeleteLabel": "L\xF6schen",
  "flow.a271df": "Stop fehlgeschlagen: {p0}",
  "flow.f876c0": "Instanz wird gestoppt \u2026",
  "flow.b5f13f": 'Workflow \u201E{p0}" wirklich stoppen?',
  "flow.f38594": "Workflow-Stop fehlgeschlagen: {p0}",
  "flow.75b57f": 'Workflow \u201E{p0}" wird gestoppt \u2026',
  "rd.514366": "Host online",
  "rd.eda8d2": "Host offline \u2014 zuletzt gesehen {p0}",
  "rd.61ea4b": "Host offline \u2014 keine Telemetrie empfangen",
  "rd.cc1bd0": "Workflow konnte nicht geladen werden.",
  "rd.e80be5": 'Rolle \u201E{p0}" wirklich entfernen?',
  "rd.14ab7f": "ihre Verbindungen",
  "rd.30eb50": "eine Standby-Zuordnung darauf",
  "rd.7ada64": " und ",
  "rd.62beac": 'Rolle \u201E{p0}" wirklich entfernen? Dabei gehen auch {p1} verloren.',
  "rd.513d30": "Entfernen",
  "rd.a65046": 'Name "{p0}" ist schon vergeben oder ung\xFCltig.',
  "rd.fb8aa5": "Name und mindestens eine Rolle sind n\xF6tig.",
  "rd.616d9c": "Speichern fehlgeschlagen: {p0}",
  "rd.b2d236": "Workflow-Name",
  "rd.dc352f": "Ziel-Host f\xFCr die n\xE4chste hinzugef\xFCgte Rolle (Klick oder Ziehen aus dem Katalog links).",
  "rd.008897": "\u21B6 R\xFCckg\xE4ngig",
  "rd.281e1f": "R\xFCckg\xE4ngig (Strg+Z)",
  "rd.d84dd6": "Wiederholen (Strg+Y)",
  "rd.c90d8d": "Ziehen: verschieben \xB7 vom Kreis rechts zum Kreis links ziehen: verbinden \xB7 ",
  "rd.de5aed": "Kante oder \u2715 anklicken: entfernen \xB7 \u270E oder Doppelklick auf den Namen: umbenennen \xB7 ",
  "rd.e743cd": "Strg+Z/Strg+Y: r\xFCckg\xE4ngig/wiederholen",
  "rd.b55aba": "Speichert \u2026",
  "rd.b97d23": "Speichern",
  "rd.6212ff": "Anlegen",
  "rd.8311b9": "Schlie\xDFen",
  "rd.322f5f": "Node-Katalog",
  "rd.0926c5": "Katalog wird geladen \u2026",
  "rd.26fdfa": "Suchen\u2026",
  "rd.c977e2": "Keine Treffer.",
  "rd.da4ea0": "{p0} \u2014 auf die Fl\xE4che ziehen, um an einer bestimmten Position anzulegen, ",
  "rd.8e078a": "oder klicken f\xFCr die Standardposition.",
  "rd.64b0b3": "{p0} \u2192 {p1} \u2014 anklicken zum Entfernen",
  "rd.50a83a": "Doppelklick zum Umbenennen \u2014 dieser Name erscheint als Sender-/Crosspoint-Label (Nutzerwunsch 2026-07-30: sprechende Namen).",
  "rd.cd85cd": "Umbenennen",
  "rd.d9e1ac": "Ziel-Host dieser Rolle.",
  "rd.f60d6f": "Host: (lokal)",
  "rd.ee4ff2": "Host: {p0}{p1}",
  "rd.3b742a": "Host: {p0} (nicht registriert)",
  "rd.d48d37": "Standard-Format dieser Rolle \u2014 leer l\xE4sst den Node bei seinem eigenen Default.",
  "rd.2c585c": "Format: Node-Standard",
  "rd.f53db2": "Warme Standby-Rolle f\xFCr eine andere Rolle desselben Node-Typs \u2014 \xFCbernimmt automatisch, wenn die Prim\xE4rrolle ausf\xE4llt (K7 Teil 4).",
  "rd.7ce364": "Standby f\xFCr: \u2014",
  "rd.2238e9": "Standby f\xFCr: {p0}",
  "rd.b94a25": "Placement-Eskalation bei Host-\xDCberlast (D6 Teil 4) \u2014 advisory zeigt nur einen Alarm, auto-confirm-window/auto ziehen die Rolle automatisch auf einen gesunden Ausweichhost um.",
  "rd.a92c96": "Best\xE4tigungsfenster in Sekunden, bevor die Migration ohne Eingriff automatisch ausgef\xFChrt wird (leer = 30s).",
  "rd.dfb4af": "Placement: advisory",
  "rd.87c900": "Placement: auto (Best\xE4tigung)",
  "rd.41cdd7": "Placement: auto (sofort)",
  "rd.0a298f": "Ebenen:",
  "rd.0618c4": "Anzahl unabh\xE4ngiger M/E-Ebenen dieses Mixers, jede mit eigenem PGM-Ausgang (z. B. f\xFCr einen Studio-Monitor unabh\xE4ngig vom Sende-PGM) \u2014 leer/1 = Node-eigener Default, nur beim Start wirksam.",
  "rd.e7cb49": "Physischer DeckLink-Port, den diese Rolle exklusiv belegt (D13 I/O-Karten-Claim) \u2014 legt device-number/Richtung beim Start fest. Ohne freien passenden Port lehnt der Orchestrator den Start ehrlich ab, statt mit dem eingebauten Default (device-number=0, Eingang) in einen Crash-Loop zu laufen. 'Nicht zugewiesen' beh\xE4lt genau dieses alte, ungepr\xFCfte Default-Verhalten bei.",
  "rd.59d216": "I/O-Port: nicht zugewiesen",
  "rd.c1ae46": "Eine Rolle kann sich nicht selbst verbinden.",
  "rd.af7d46": "Diese Verbindung besteht bereits.",
  "pe.872073": "Aktionen",
  "pe.a0c169": "Menschen",
  "pe.708dee": "Ablauf",
  "pe.4bf36f": "Eingang",
  "pe.469b92": "Registriert",
  "pe.379ee8": "Bereit",
  "pe.9b9437": "In Pr\xFCfung",
  "pe.6bb8d0": "Freigegeben",
  "pe.18a0e4": "Ver\xF6ffentlicht",
  "pe.d11aee": "Archiviert",
  "pe.768a27": "Abgelaufen",
  "pe.b74b71": "Gel\xF6scht",
  "pe.2567e3": 'Schritt "{p0}" wirklich entfernen? Verweise darauf (next/branches/compensation) werden mit entfernt.',
  "pe.c0fdae": "Ung\xFCltige oder bereits vergebene Schritt-ID.",
  "pe.f6f742": "Prozess-Ablauf",
  "pe.060d74": "{p0} Schritte",
  "pe.b1ca0c": "\u26A1 Ausl\xF6ser ({p0})",
  "pe.5528e3": "\u26A1 Ausl\xF6ser: nur manuell",
  "pe.c979b7": "Festlegen, bei welchem Ereignis der Prozess automatisch startet",
  "pe.de024d": "Auto-Anordnen",
  "pe.7cf6d9": "\xC4nderungsgrund (optional)",
  "pe.d6ed5a": "Doppelklick auf eine Kachel: einstellen \xB7 vom Kreis rechts auf eine Kachel ziehen: verbinden \xB7 ",
  "pe.feebfd": "Verbindung anklicken: entfernen",
  "pe.b97d23": "Speichern",
  "pe.4b9727": "Abbrechen",
  "pe.642d30": "Bausteine",
  "pe.e4259d": "Klicken oder auf die Fl\xE4che ziehen.",
  "pe.0aed56": "{p0} Auf diesem Server nicht ausf\xFChrbar \u2014 ein Prozess mit diesem Baustein w\xFCrde beim Erreichen des Schritts fehlschlagen.",
  "pe.d3a973": "Nicht verf\xFCgbar ({p0})",
  "pe.efe2f6": "{p0} \u2192 {p1} (next) \u2014 anklicken zum Entfernen",
  "pe.dd75f3": "{p0} \u2192 {p1} (branch: {p2}) \u2014 anklicken zum Entfernen",
  "pe.6c6ab3": "nicht ausf\xFChrbar",
  "pe.b9de46": "\u2606 als Start setzen",
  "pe.c8a8be": "Automatisch starten, wenn \u2026",
  "pe.d4054d": "\n        Ohne Ausl\xF6ser startet der Prozess nur manuell (\u201EStarten\u201C). Die Daten des Ereignisses stehen den Schritten als Start-Eingabe zur Verf\xFCgung (z. B. die Asset-ID).\n        Ausl\xF6ser wirken erst, wenn die Version ver\xF6ffentlicht ist.",
  "pe.ff11ee": "Kein Ausl\xF6ser \u2014 nur manueller Start.",
  "pe.7e436d": "eigenes Subject, z. B. omp.process.x.fertig",
  "pe.trigFilter": 'Filter (optional), z. B. input.severity == "critical"',
  "pe.trigFilterHint": "Ausdruck \xFCber input.* (Nutzlast) und subject; der Prozess startet nur, wenn er wahr ist",
  "pe.trigGroup.asset": "Assets",
  "pe.trigGroup.alarm": "Alarme",
  "pe.trigGroup.ingest": "Stream-Ingest / Aufnahmen",
  "pe.trigGroup.files": "Dateien",
  "pe.trigGroup.process": "Prozesse",
  "pe.trigGroup.bus": "Weitere Ereignisse (auf dem Bus beobachtet)",
  "pe.trigRemove": "Ausl\xF6ser entfernen",
  "pe.trigSeen": "Zuletzt gesehen {p0} ({p1}\xD7)",
  "pe.trigNever": "Noch nicht gesehen \u2014 Felder und Test stehen nach dem ersten Ereignis bereit",
  "pe.trigFields": "Felder der Nutzlast (Klick f\xFCgt in den Filter ein):",
  "pe.trigExample": "Beispiel: {p0}",
  "pe.trigInsert": "In den Filter einf\xFCgen",
  "pe.trigSample": "Letzte Nutzlast",
  "pe.trigNoSample": "Kein Beispiel vorhanden \u2014 Test erst nach dem ersten Ereignis m\xF6glich",
  "pe.trigMatch": "\u2714 Trifft auf die letzte Nutzlast zu",
  "pe.trigNoMatch": "\u25CB Trifft auf die letzte Nutzlast nicht zu",
  "pe.trigSearch": "Ereignis suchen (Name, Subject, Gruppe) \u2026",
  "pe.trigChoose": "Ereignis w\xE4hlen \u2026",
  "pe.trigUse": "Eigenes Subject verwenden: {p0}",
  "pe.083fea": "Eigenes Ereignis (erweitert) \u2026",
  "pe.c481e8": "+ Ausl\xF6ser",
  "pe.bf8310": "\xDCbernehmen",
  "pe.9b9089": "Jeder Ausl\xF6ser braucht ein Ereignis.",
  "pe.889b4d": "Bitte einen Namen f\xFCr den Weg angeben.",
  "pe.c99319": "Welcher Weg f\xFChrt hierher?",
  "pe.371e70": "Immer (unabh\xE4ngig vom Ergebnis)",
  "pe.87860e": "Danach weiter mit diesem Schritt",
  "pe.af7d46": "Diese Verbindung besteht bereits.",
  "pe.7d870e": "Erweitert: eigener Weg-Name",
  "pe.9c9482": "Weg-Name",
  "pe.24e7ff": "Verbinden",
  "am.0c5944": "Quelle {p0}",
  "am.550585": "Auxinput {p0}",
  "am.cebd3b": "Haupt-Eingabedatei",
  "am.a081a7": "Audio-Matrix bearbeiten",
  "am.4b9727": "Abbrechen",
  "am.bf8310": "\xDCbernehmen",
  "am.8a5d35": "Ordnet einzelne Quellkan\xE4le (aus der Haupt-Eingabedatei oder zus\xE4tzlichen Dateien) beliebigen Ausgangsspuren zu \u2014 anteilig gemischt (%) und verz\xF6gert (ms). Eine Zelle mit Anteil 0 tr\xE4gt nichts bei. Ausgangsspuren ohne jeden Beitrag werden nicht erzeugt.",
  "am.436760": "Kanal-Layout:",
  "am.754de8": "Quellen",
  "am.18dca7": "Ausklappen",
  "am.5f67b0": "Einklappen",
  "am.be7644": "Auxinput {p0}:",
  "am.90a9e7": "Zusatzquelle {p0} (Name optional)",
  "am.e649e0": "Diese Zusatzquelle entfernen",
  "am.71a326": "Pfad:",
  "am.c799cf": "Pfad der zus\xE4tzlichen Quelldatei",
  "am.364ee0": "Ausgangsspuren:",
  "am.d65493": "Downmixer",
  "am.8e0889": "Verz\xF6gerung:",
  "am.513d30": "Entfernen",
  "am.d4157e": "Quellkanal \\ Ausgangsspur",
  "am.d8b559": "Spur {p0}",
  "am.5ba81a": "Klicken zum Bearbeiten",
  "am.9aa012": "Klicken zum Routen",
  "am.5fe6a4": "{p0}: Pfad fehlt.",
  "am.7efd6f": "Mindestens eine Zelle mit Anteil > 0 wird gebraucht.",
  "fg.10c6b6": "Filter-Kette bearbeiten",
  "fg.3ce2cc": "Automatisch anordnen",
  "fg.4b9727": "Abbrechen",
  "fg.bf8310": "\xDCbernehmen",
  "fg.75f7d9": "Ausgang {p0}",
  "fg.04f5e1": "Filter suchen \u2026",
  "fg.f3a961": "Kein Filter passt.",
  "fg.642d30": "Bausteine",
  "fg.5a3fe6": "Filter (aus echter ffmpeg-Liste):",
  "fg.4bf36f": "Eingang",
  "fg.2b73e4": "Ausgang",
  "fg.c45971": "Name (optional)",
  "fg.8999d7": "Eing\xE4nge:",
  "fg.a2c1ed": "Ausg\xE4nge:",
  "fg.440a36": "Standard: {p0}",
  "fg.cbc4b0": "keine Optionen",
  "psc.d1762c": "ung\xFCltiger Wert",
  "psc.e54b72": " (offline)",
  "psc.a03494": "Einen Wert aus dem Prozesslauf einsetzen (Start-Eingabe, Ergebnis eines vorherigen Schritts \u2026)",
  "psc.98ceeb": "Suchen \u2026",
  "psc.3c50c3": "eigenes Eingabefeld, z. B. path",
  "psc.b5e41b": "input.\u2026 einf\xFCgen",
  "psc.60a1f1": "Start-Eingabe-Felder werden beim manuellen Start (JSON) oder vom ausl\xF6senden Ereignis geliefert.",
  "psc.6e2c9a": "Keine passenden Werte.",
  "psc.513d30": "Entfernen",
  "psc.8fef4a": "\u2013 Wert w\xE4hlen \u2013",
  "psc.edfa2f": "Wert, z. B. approved oder 0",
  "psc.1c5e10": "Einfache Regel verwenden",
  "psc.d26d26": "Eigener Ausdruck (erweitert)",
  "psc.b8865a": "Dieser Ausdruck passt nicht in eine einfache Regel \u2014 bleibt als eigener Ausdruck.",
  "psc.00760a": "Wartezeit",
  "psc.b4b8e1": "Danach geht der Ablauf automatisch weiter.",
  "psc.b950fb": "Wartezeit: keine g\xFCltige Zahl.",
  "psc.60e9f0": "z. B. Beitrag freigeben",
  "psc.1f0172": "z. B. Untertitel pr\xFCfen",
  "psc.9d735f": "leer = jeder darf \xFCbernehmen",
  "psc.01daf3": "optional, z. B. redaktion",
  "psc.68dd6f": "Titel der Aufgabe",
  "psc.01531f": "Erscheint im Prozesse-Tab unter \u201EHuman Tasks\u201C. Leer = Schrittname.",
  "psc.49f6db": "Beschreibung / Anweisung",
  "psc.c1ebd6": "Zust\xE4ndige Person",
  "psc.e897f3": "Rolle",
  "psc.c30f58": "Priorit\xE4t",
  "psc.bea463": "Ergebnis: \u201Efreigegeben\u201C, \u201Eabgelehnt\u201C oder \u201E\xC4nderungen angefordert\u201C \u2014 ziehe je Ergebnis eine Verbindung zum passenden n\xE4chsten Schritt.",
  "psc.ad8b47": "Name des Ja-Wegs",
  "psc.254c6b": "Name des Nein-Wegs",
  "psc.9e5c87": "Regel",
  "psc.9c21c3": "Trifft die Regel zu, nimmt der Ablauf den Ja-Weg, sonst den Nein-Weg.",
  "psc.92f762": "Die Wege entstehen, indem du vom Ausgang dieses Schritts zum n\xE4chsten Schritt ziehst und den Weg ausw\xE4hlst.",
  "psc.f07dc2": "Regel: bitte einen Wert w\xE4hlen oder einen Ausdruck eingeben.",
  "psc.65e89f": "Name des Wegs, z. B. hd",
  "psc.cd850a": "Fall entfernen",
  "psc.9242d7": "Wenn",
  "psc.12a29c": "optional, z. B. sonst",
  "psc.919f43": "Die F\xE4lle werden von oben nach unten gepr\xFCft; der erste zutreffende bestimmt den Weg.",
  "psc.22fd61": "Weg, wenn kein Fall zutrifft",
  "psc.f22388": "Leer = der Prozess schl\xE4gt fehl, wenn kein Fall passt.",
  "psc.31c191": "Jeder Fall braucht einen Weg-Namen und eine Regel.",
  "psc.541b6d": "Mindestens ein Fall ist n\xF6tig.",
  "psc.f00a7d": "Header, z. B. Authorization",
  "psc.5a597b": "Wert",
  "psc.144d62": "Feld",
  "psc.7b71ec": "Wert (Text)",
  "psc.d38e8c": "Gesendete Daten",
  "psc.02fbcf": "Wird als JSON-Objekt gesendet (nur bei POST/PUT/PATCH). Verschachtelte Daten: \u201EErweitert (JSON)\u201C.",
  "psc.decdc1": "Gesendete Daten sind verschachtelt \u2014 bearbeitbar unter \u201EErweitert (JSON)\u201C.",
  "psc.41aa69": "Methode",
  "psc.8f2cbd": "Adresse (URL)",
  "psc.e6ea93": "Mit \u201E{x} Variable\u201C Werte aus dem Prozesslauf einsetzen.",
  "psc.bf50d5": "Header",
  "psc.755b1d": "Zeitlimit f\xFCr die Antwort",
  "psc.fc9b98": "Leer = 30 Sekunden.",
  "psc.61a248": "Antworten au\xDFerhalb 200\u2013299 gelten als Fehler (\u2192 Wiederholung/Fehlerbehandlung unten).",
  "psc.d494fb": "Adresse (URL) fehlt.",
  "psc.de6fc7": "Zeitlimit: keine g\xFCltige Zahl.",
  "psc.81d089": "Optionen durchsuchen \u2026",
  "psc.440a36": "Standard: {p0}",
  "psc.f86918": "\u2013 ffmpeg-Standard f\xFCr den Container \u2013",
  "psc.a8f960": "\u2013 aus der Dateiendung ableiten \u2013",
  "psc.95b1db": "kein Filter gesetzt.",
  "psc.0a42fd": "Filter-Kette bearbeiten \u2026",
  "psc.a09a38": "Filter entfernen",
  "psc.cb4d72": "Filter aktiv ({p0} Filter-Schritt(e)).",
  "psc.f15630": "Audio-Matrix bearbeiten \u2026",
  "psc.3309b0": "Quellkan\xE4le aus dieser oder zus\xE4tzlichen Dateien grafisch auf Ausgangsspuren routen, mischen und verz\xF6gern.",
  "psc.2668ce": "${input.path} oder ein eigener Pfad",
  "psc.b2cbf0": "Ausgabespur {p0}",
  "psc.a56112": "z. B. 0:a:0 \u2014 oder ein Label aus Filter-Kette/Audio-Matrix",
  "psc.4b1725": "[{p0}] einf\xFCgen",
  "psc.b22f04": "Audio",
  "psc.34e2d1": "Video",
  "psc.b5b672": "Untertitel",
  "psc.e9da74": "Spur entfernen",
  "psc.d3402e": "Quelle",
  "psc.d0636b": "Roher Stream-Spezifizierer (z. B. 0:a:0 f\xFCr Eingabedatei 0, erste Tonspur) oder ein Label aus Filter-Kette/Audio-Matrix (in eckigen Klammern).",
  "psc.913302": "Medientyp",
  "psc.8ca990": "Codec",
  "psc.8a0483": "Leer = ffmpeg-Standard.",
  "psc.e8a64f": "Metadaten (optional)",
  "psc.ae9836": "Beliebige Schl\xFCssel, z. B. title, language (ISO-639-2) \u2014 nicht auf title/language beschr\xE4nkt.",
  "psc.095815": "Video-/Audio-Codec oben sind deaktiviert, solange unten mindestens eine Ausgabespur konfiguriert ist \u2014 die Ausgabespuren-Liste \xFCbernimmt die Zuordnung dann vollst\xE4ndig.",
  "psc.2c6327": "Video-Codec",
  "psc.24f9d3": "Leer = ffmpeg-Standard f\xFCr den Container.",
  "psc.16202d": "Audio-Codec",
  "psc.7ddbbe": "Eingabedatei",
  "psc.8adabd": "Ausgabedatei",
  "psc.6bbca5": "Container erzwingen (optional)",
  "psc.74d4bd": "Leer = ffmpeg leitet ihn aus der Endung der Ausgabedatei ab.",
  "psc.f92383": "Filter (optional)",
  "psc.99d757": "Weitere Eingabedateien",
  "psc.82095d": "Nur n\xF6tig, wenn der Filter oben mehr als eine Quelle referenziert \u2014 Eingabedatei oben ist Index 0, hier Index 1, 2, \u2026.",
  "psc.5bfab8": "Ausgabespuren (optional \u2014 f\xFCr unabh\xE4ngige Mehrfachspuren, z. B. mehrere Sprachfassungen)",
  "psc.9205c3": "Eingabe- und Ausgabedatei sind Pflicht.",
  "psc.328a1f": "Eine weitere Eingabedatei ist leer.",
  "psc.a3017d": "Jede Ausgabespur braucht eine Quelle.",
  "psc.6b4c3c": "Clip {p0}",
  "psc.b153d1": "leer = von Anfang an",
  "psc.c7c6db": "leer = bis zum Ende",
  "psc.fb36dc": "Clip entfernen",
  "psc.e2eaea": "Beschnitt Start (optional)",
  "psc.4e75ed": "ffmpeg-Zeitangabe, z. B. 5 oder 00:00:05.5 \u2014 schneidet den Clip-Anfang weg.",
  "psc.1f0b03": "Beschnitt Ende (optional)",
  "psc.410164": "ffmpeg-Zeitangabe \u2014 schneidet den Clip ab hier weg.",
  "psc.c3115f": "Quelldatei",
  "psc.318be7": "Kein Beschnitt m\xF6glich, keine Codec-Wahl (bleibt exakt wie die Quellen) \u2014 nur zuverl\xE4ssig f\xFCr Container, die ffmpegs concat-Protokoll unterst\xFCtzt (v. a. MPEG-TS/-PS, z. B. .ts-Dateien aus Zuspielungen). Bei inkompatiblen Quellen meldet ffmpeg beim Ausf\xFChren einen Fehler statt eine falsche Datei zu erzeugen.",
  "psc.965445": "Alle Clips werden neu kodiert (Zusammenf\xFCgen per Filter, kein reiner Stream-Copy) \u2014 leer = ffmpeg-Standard.",
  "psc.71259a": "Die Reihenfolge der Clips unten ist die Reihenfolge in der Ausgabedatei \u2014 mit \u2191/\u2193 umsortieren.",
  "psc.b81bfe": "Verlustfrei (Stream-Copy, kein Neukodieren)",
  "psc.82b994": "Ausgabedatei fehlt.",
  "psc.9fd8eb": "Mindestens zwei Clips sind n\xF6tig.",
  "psc.aecc0d": "Jeder Clip braucht eine Quelldatei.",
  "psc.07a093": "Gesamtdauer in Sekunden (f\xFCr die Zeitleisten-Vorschau)",
  "psc.4ff54c": "Ereignis {p0}",
  "psc.6e4c80": "Text (z. B. Bauchbinde, Abspann-Credits)",
  "psc.fe1905": "Bild (z. B. Senderlogo)",
  "psc.d43301": "${input.logoPath} oder ein eigener Pfad",
  "psc.d01e32": "Sekunden ab Anfang",
  "psc.28d341": "leer = mittig (Text) bzw. 0 (Bild)",
  "psc.c8421f": "leer = unten (Text) bzw. 0 (Bild)",
  "psc.9dffbf": "Text",
  "psc.ed95ac": "Doppelpunkt und Hochkomma werden automatisch escaped.",
  "psc.aa69ac": "Bilddatei",
  "psc.3795c7": "Ereignis entfernen",
  "psc.9563fc": "Start (Sekunden)",
  "psc.5381b9": "Ende (Sekunden)",
  "psc.8ef81c": "Position X (optional)",
  "psc.8f4463": "ffmpeg-Ausdruck, z. B. 10 oder (w-overlay_w)/2.",
  "psc.ec97a1": "Position Y (optional)",
  "psc.edfec0": "ffmpeg-Ausdruck, z. B. 10 oder h-overlay_h-20.",
  "psc.37ba1f": "Eingabedatei (Video)",
  "psc.406613": "Overlays erfordern eine Neukodierung des Bildes \u2014 leer = ffmpeg-Standard.",
  "psc.fc2ebc": "Ton wird unver\xE4ndert durchgereicht, falls vorhanden \u2014 Codec nur bei Bedarf setzen.",
  "psc.f46020": "Gesamtdauer (nur f\xFCr die Zeitleisten-Vorschau)",
  "psc.26d291": "Zeitleiste (nicht ziehbar, nur zur Orientierung):",
  "psc.4aaf16": "Mindestens ein Ereignis ist n\xF6tig.",
  "psc.5f5f22": "Jedes Ereignis braucht eine g\xFCltige Start-/Endzeit (Ende > Start).",
  "psc.9c9479": "Jedes Text-Ereignis braucht einen Text.",
  "psc.049b05": "Jedes Bild-Ereignis braucht eine Bilddatei.",
  "psc.6646ff": "\u2013 Werkzeug w\xE4hlen \u2013",
  "psc.a59b9d": "{p0} (auf diesem Server nicht verf\xFCgbar!)",
  "psc.2c4740": "\u2013 Vorlage \xFCbernehmen (optional) \u2013",
  "psc.574722": "Argument (z. B. -crf oder ein Wert)",
  "psc.6940ee": "Parameter suchen \u2026",
  "psc.a6eb55": "{p0} globale Flags (-h full)",
  "psc.345b00": "{p0} Parameter",
  "psc.a96ba4": "{p0} Parameter bisher (l\xE4dt weiter im Hintergrund)",
  "psc.d79ecf": "Parameter-Index l\xE4dt \u2026",
  "psc.cbb958": "globales Flag",
  "psc.a0f383": "globales Flag, -h full",
  "psc.cbc4b0": "keine Optionen",
  "psc.89cdb8": "Parameter suchen",
  "psc.8c458f": 'Durchsucht globale CLI-Flags (kuratiert + vollst\xE4ndig aus "ffmpeg -h full"), ALLE AVOptions aller Encoder/Decoder/Muxer/Demuxer/Filter dieses Servers (z. B. "crf" findet direkt libx264s -crf) sowie Werkzeug-/Filter-Namen selbst \u2014 Klick auf einen Treffer f\xFCgt ihn als Argument ein.',
  "psc.cd6dbf": " Die Platzhalter input.path usw. per \u201E{x} Variable\u201C durch echte Werte ersetzen oder beim Start mitgeben.",
  "psc.a7b058": "Befehlszeile einf\xFCgen \u2026",
  "psc.e91a0f": 'Eine komplette Argumentzeile einf\xFCgen (z. B. aus einer Anleitung) \u2014 wird an Leerzeichen getrennt, "\u2026" h\xE4lt zusammen.',
  "psc.4eb447": "Argumente (ohne Programmname):",
  "psc.40c573": "Werkzeug",
  "psc.819ee1": "Auf diesem Server freigegeben: {p0}.",
  "psc.8330a3": "Auf diesem Server ist kein Werkzeug freigegeben.",
  "psc.07411f": "Vorlage",
  "psc.c9d7f8": "Argumente",
  "psc.8584a0": "Je Zeile ein Argument \u2014 Leerzeichen innerhalb einer Zeile bleiben erhalten (kein Anf\xFChrungszeichen-Problem). Bekannte Flags werden beim Tippen vorgeschlagen und ihr Wert gepr\xFCft.",
  "psc.ffd103": "Erzeugte Argumente (Vorschau):",
  "psc.3ce979": "Auf diesem Server ist weder ffmpeg noch ffprobe freigegeben \u2014 der Assistent braucht mindestens eines von beiden.",
  "psc.8c5713": "Aufgabe",
  "psc.443b5b": "Stattdessen rohe Argumente eingeben (Experten-Modus)",
  "psc.df82e3": "Stattdessen den Assistenten verwenden",
  "psc.31b5c0": "Zeitlimit",
  "psc.733355": "Leer = 5 Minuten.",
  "psc.305b37": "Werkzeug fehlt.",
  "psc.05b4e5": "Aufgabe w\xE4hlen.",
  "psc.d8e721": "\u2013 zuerst Microservice w\xE4hlen \u2013",
  "psc.1b1539": "Diese Funktion braucht keine Angaben.",
  "psc.e9716b": "Zahl",
  "psc.074e19": "Typ: {p0}",
  "psc.5d2bfb": "{p0} (Microservice l\xE4uft gerade nicht)",
  "psc.5eea30": "\u2013 Funktion w\xE4hlen \u2013",
  "psc.6bf2f0": "dieser Microservice bietet keine Funktionen an",
  "psc.edb0ba": "{p0} (nicht mehr angeboten)",
  "psc.4bc1ca": "\u2013 Microservice w\xE4hlen \u2013",
  "psc.882bf5": "keine laufenden Microservices gefunden",
  "psc.bd2472": "{p0} (l\xE4uft gerade nicht)",
  "psc.b1a5f2": "Microservice",
  "psc.cf6708": "Nur laufende Instanzen werden angeboten. Der Prozess ruft genau diese Instanz auf.",
  "psc.b104f8": "Funktion",
  "psc.ce7b6e": "Microservice und Funktion w\xE4hlen.",
  "psc.bb7773": "{p0}: keine g\xFCltige Zahl.",
  "psc.249a28": "immer die neueste ver\xF6ffentlichte Version",
  "psc.4b6924": "genau v{p0}",
  "psc.4d0aaf": "festgelegte Version (nicht mehr ver\xF6ffentlicht)",
  "psc.729570": "\u2013 Prozess w\xE4hlen \u2013",
  "psc.d6e26f": "Prozess",
  "psc.5d56b7": "L\xE4uft als eigener Prozesslauf; dieser Schritt wartet, bis er fertig ist.",
  "psc.34b6cd": "Version",
  "psc.96b30c": "Start-Eingabe f\xFCr den Unterprozess",
  "psc.be6e5d": "Die Start-Eingabe ist verschachtelt \u2014 bearbeitbar unter \u201EErweitert (JSON)\u201C.",
  "psc.78f7d8": "Prozess w\xE4hlen.",
  "psc.980d97": "z. B. omp.process.beitrag.fertig",
  "psc.3a9d26": "Kanal (Subject)",
  "psc.da13c4": "Name, unter dem andere Systeme diese Nachricht abonnieren. Punkte trennen Ebenen.",
  "psc.c2df59": "Inhalt",
  "psc.16e638": "Der Inhalt ist verschachtelt \u2014 bearbeitbar unter \u201EErweitert (JSON)\u201C.",
  "psc.8b8a99": "Kanal (Subject) fehlt.",
  "psc.1a58bf": "Keine Einstellungen n\xF6tig \u2014 verbinde diesen Schritt mit allen Schritten, die gleichzeitig laufen sollen.",
  "psc.3ee9be": "Keine Einstellungen n\xF6tig \u2014 der Ablauf geht weiter, sobald ALLE eingehenden Wege angekommen sind.",
  "psc.7cc481": "F\xFCr diesen Schritt-Typ gibt es kein Formular \u2014 Einstellungen ggf. unter \u201EErweitert (JSON)\u201C.",
  "psc.441f14": "z. B. Proxy erzeugen",
  "psc.2eb6eb": "Anzeigename",
  "psc.f0ab2e": "Erscheint auf der Kachel und im Variablen-Picker nachfolgender Schritte.",
  "psc.69794d": "Wenn etwas schiefgeht",
  "psc.d6ea9c": "Abstand jedes Mal verdoppeln",
  "psc.cb3186": "Versuche insgesamt",
  "psc.877b38": "Pause zwischen Versuchen",
  "psc.f39ab3": "Bei Fehler automatisch wiederholen",
  "psc.7abaf8": "\u2013 nichts r\xFCckg\xE4ngig machen \u2013",
  "psc.c288c7": "Maximale Laufzeit dieses Schritts",
  "psc.faa307": "Leer = unbegrenzt. Bei \xDCberschreitung gilt der Schritt als fehlgeschlagen.",
  "psc.d8dc39": "R\xFCckg\xE4ngig machen mit",
  "psc.a92403": "Schl\xE4gt der Prozess sp\xE4ter fehl, l\xE4uft dieser Schritt, um die Wirkung hier aufzuheben (z. B. Datei wieder l\xF6schen).",
  "psc.9b0008": "Erweitert: Einstellungen als JSON",
  "psc.3404a3": "Solange dieser Bereich ge\xF6ffnet ist, gilt das JSON unten statt des Formulars.",
  "psc.4b9727": "Abbrechen",
  "psc.bf8310": "\xDCbernehmen",
  "psc.291226": "Ung\xFCltiges JSON: {p0}",
  "psc.51e448": "Versuche insgesamt: mindestens 2.",
  "psc.d0fee9": "Pause zwischen Versuchen: keine g\xFCltige Zahl.",
  "psc.3328a4": "Maximale Laufzeit: keine g\xFCltige Zahl.",
  "adm.5e3e07": "Deaktivieren",
  "adm.1a1a97": "Reaktivieren",
  "adm.ad2749": "Workflow-Rolle",
  "adm.74cacb": "eigenst\xE4ndig",
  "adm.361528": "das installierte Binary",
  "adm.dfb6b8": "installiertes Binary",
  "adm.00b3d4": "Stand unbekannt",
  "adm.db0548": " \xB7 aus Versionsspeicher {p0}",
  "adm.fc16a0": "signiert ({p0})",
  "adm.312ccb": "(Standard)",
  "adm.36311b": "Klicken, um nach dieser trace_id zu filtern: ",
  "adm.6970d8": "Ansehen",
  "adm.993f73": "Bedienen",
  "adm.c752db": "Konfigurieren",
  "adm.d977b4": "Administrieren",
  "adm.5b0f32": "Organisation anlegen fehlgeschlagen: {p0}",
  "adm.44bbde": 'Organisation "{p0}" wirklich l\xF6schen?',
  "adm.1010b0": "L\xF6schen",
  "adm.ea96f5": '"{p0}" ist die Standard-Organisation und kann nicht gel\xF6scht werden.',
  "adm.fc057a": '"{p0}" hat noch Nutzer oder Objekte (Workflows/Assets/\u2026) \u2014 erst diese verschieben oder entfernen.',
  "adm.05f6da": "L\xF6schen fehlgeschlagen: {p0}",
  "adm.c9957a": "Organisation \xE4ndern fehlgeschlagen: {p0}",
  "adm.dir.title": "Active Directory / LDAP",
  "adm.dir.enabled": "Anmeldung per Verzeichnis ist aktiv",
  "adm.dir.test": "Verbindung testen",
  "adm.dir.testing": "Pr\xFCfe \u2026",
  "adm.dir.testOk": "Verbindung und Dienstkonto in Ordnung.",
  "adm.dir.testFailed": "Fehlgeschlagen: {p0}",
  "adm.dir.notConfigured": "Nicht eingerichtet.",
  "adm.dir.hint": "Verzeichnisgruppen werden OMP-Gruppen zugeordnet. Bei jeder Anmeldung eines Verzeichnisnutzers wird seine Mitgliedschaft in den hier zugeordneten OMP-Gruppen nachgef\xFChrt (Mitglied, wenn er im Verzeichnis in der Gruppe ist, sonst entfernt). Die Rechte h\xE4ngen wie bisher an den OMP-Gruppen. Nutzer werden bei der ersten Anmeldung angelegt; lokale Konten funktionieren weiter.",
  "adm.dir.hintOff": "Zuordnungen lassen sich schon vorbereiten. Sie wirken, sobald die Anbindung eingerichtet ist.",
  "adm.dir.ldapGroup": "Verzeichnisgruppe (Name oder DN, z. B. Regie1)",
  "adm.dir.pickGroup": "OMP-Gruppe w\xE4hlen \u2026",
  "adm.dir.add": "Zuordnen",
  "adm.dir.addFailed": "Zuordnung fehlgeschlagen: {p0}",
  "adm.dir.userTag": "Verzeichnisnutzer \u2014 Passwort wird im Active Directory verwaltet",
  "adm.dir.disabled": "nicht eingeschaltet",
  "adm.dir.saved": "Gespeichert und angewendet.",
  "adm.dir.saveFailed": "Speichern fehlgeschlagen: {p0}",
  "adm.dir.loadError": "Die Einstellungen sind nicht nutzbar: {p0}",
  "adm.dir.f.enabled": "Anmeldung",
  "adm.dir.f.enabledLabel": "Anmeldung per Active Directory einschalten",
  "adm.dir.f.fromEnv": "Die Werte stammen noch aus den Umgebungsvariablen OMP_LDAP_*; nach dem Speichern gelten die hier eingetragenen.",
  "adm.dir.f.urls": "Server (Dom\xE4nencontroller)",
  "adm.dir.f.urlsHelp": "Eine Adresse je Zeile; bei Ausfall wird der n\xE4chste versucht. ldaps:// (Port 636) ist verschl\xFCsselt.",
  "adm.dir.f.startTls": "StartTLS",
  "adm.dir.f.startTlsLabel": "bei ldap:// (Port 389) auf Verschl\xFCsselung umschalten",
  "adm.dir.f.allowPlain": "Klartext",
  "adm.dir.f.allowPlainLabel": "unverschl\xFCsselt erlauben (nur Labor)",
  "adm.dir.f.allowPlainWarn": "Passw\xF6rter laufen offen \xFCbers Netz!",
  "adm.dir.f.ca": "CA-Zertifikat",
  "adm.dir.f.caHelp": "Zertifizierungsstelle der Dom\xE4nencontroller als PEM einf\xFCgen; leer = Systemzertifikate.",
  "adm.dir.f.caFile": "(Zus\xE4tzlich aus Umgebung: {p0})",
  "adm.dir.f.baseDn": "Suchbasis (Base DN)",
  "adm.dir.f.bindDn": "Dienstkonto (DN)",
  "adm.dir.f.bindDnHelp": "Konto mit Leserecht f\xFCr Nutzer und Gruppen. Leer = anonyme Suche (AD erlaubt das meist nicht).",
  "adm.dir.f.pw": "Dienstkonto-Kennwort",
  "adm.dir.f.pwKeep": "(gespeichert \u2014 leer lassen, um es zu behalten)",
  "adm.dir.f.pwHelp": "Wird verschl\xFCsselt gespeichert (braucht OMP_STORAGE_SECRET_KEY) und nie angezeigt.",
  "adm.dir.f.userFilter": "Nutzerfilter",
  "adm.dir.f.userFilterHelp": "{user} wird durch den Anmeldenamen ersetzt. Leer = Vorgabe (Anmeldung mit Name oder Name@Dom\xE4ne).",
  "adm.dir.f.userAttr": "Namensattribut",
  "adm.dir.f.groupBaseDn": "Gruppen-Suchbasis",
  "adm.dir.f.sameAsBase": "wie Suchbasis",
  "adm.dir.f.groupFilter": "Gruppenfilter",
  "adm.dir.f.groupFilterHelp": "{dn} wird durch den DN des Nutzers ersetzt. Vorgabe liest auch verschachtelte Gruppen.",
  "adm.dir.f.required": "Pflichtgruppe",
  "adm.dir.f.requiredHelp": "Optional: nur Mitglieder dieser Gruppe (Name oder DN) d\xFCrfen sich anmelden.",
  "adm.dir.f.timeout": "Zeitlimit (s)",
  "adm.dir.whereSettings": "Die Verbindung wird unter Wartung \u2192 Einstellungen \u2192 Active Directory eingerichtet.",
  "adm.740737": "Gruppe anlegen fehlgeschlagen: {p0}",
  "adm.f0fe51": "Gruppe speichern fehlgeschlagen: {p0}",
  "adm.006ae0": 'Gruppe "{p0}" wirklich l\xF6schen?',
  "adm.b0eec4": "{p0} Rollenbindungen dieser Gruppe jetzt mit entfernen und die Gruppe trotzdem l\xF6schen?",
  "adm.bbd42e": "Gruppe + Bindungen l\xF6schen",
  "adm.116589": "Mitglied hinzuf\xFCgen fehlgeschlagen: {p0}",
  "adm.473556": "Mitglied entfernen fehlgeschlagen: {p0}",
  "adm.d6c746": "Verbindung erfolgreich.",
  "adm.c18d1f": "Der letzte Verbindungstest ist fehlgeschlagen. Trotzdem speichern?",
  "adm.712bf9": "Die Verbindung wurde noch nicht getestet. Trotzdem speichern?",
  "adm.71af06": "Trotzdem speichern",
  "adm.055ecb": "Anlegen fehlgeschlagen: {p0}",
  "adm.d033fe": "Storage-Backend angelegt.",
  "adm.616d9c": "Speichern fehlgeschlagen: {p0}",
  "adm.24bd50": "Storage-Backend aktualisiert.",
  "adm.22ae39": 'Storage-Backend "{p0}" ({p1}/{p2}) wirklich entfernen? ',
  "adm.cab673": "Dateien, die bereits dort liegen, werden dadurch NICHT gel\xF6scht \u2014 nur die Verwaltung dieses Ziels hier.",
  "adm.513d30": "Entfernen",
  "adm.64bd21": "Entfernen fehlgeschlagen: {p0}",
  "adm.8f63e4": "Nutzer anlegen fehlgeschlagen: {p0}",
  "adm.d125d4": "Nutzer angelegt, automatische Anmeldung fehlgeschlagen \u2014 bitte manuell anmelden.",
  "adm.50e59c": 'Nutzer "{p0}" wirklich l\xF6schen?',
  "adm.5d0b05": "Passwort-Reset fehlgeschlagen: {p0}",
  "adm.f397bc": "Rollenbindung anlegen fehlgeschlagen: {p0}",
  "adm.a9b709": 'Rollenbindung "{p0}" \u2192 {p1} ({p2}) wirklich l\xF6schen?',
  "adm.b8b2ff": "Backup fehlgeschlagen: {p0}",
  "adm.31299d": "Hochladen fehlgeschlagen: {p0}",
  "adm.3eceda": "Download fehlgeschlagen: {p0}",
  "adm.4c4de5": "Version {p0}",
  "adm.b5d818": "{p0}: {p1} als produktiv festlegen? Es gilt f\xFCr neu gestartete Instanzen. Laufende Instanzen bleiben ",
  "adm.0e3a0a": "unver\xE4ndert, bis sie neu gestartet werden (System-Update \u2192 \u201EVeraltete neu starten\u201C).",
  "adm.a8aea0": "Festlegen",
  "adm.89b0ff": "Festlegen fehlgeschlagen",
  "adm.88ca3b": "Trotzdem umstellen",
  "adm.224408": "Keine laufende Instanz muss umgestellt werden.",
  "adm.9a9247": "{p0} Instanz(en) nacheinander auf {p1} umstellen?\n\n{p2}\n\n",
  "adm.150afc": "Jede Instanz wird neu gestartet (kurzer Signalausfall), ihre Verbindungen werden wiederhergestellt. ",
  "adm.5d9e5b": "Startet eine neue Version nicht, l\xE4uft die Instanz mit dem bisherigen Stand weiter und der Rollout bricht ab.",
  "adm.603736": "Rollout starten",
  "adm.2597aa": "Rollout nicht gestartet: {p0}",
  "adm.68797a": "{p0} {p1} aus dem Versionsspeicher l\xF6schen?",
  "adm.290534": "L\xF6schen fehlgeschlagen",
  "adm.2b5ab6": "Node-Versionen",
  "adm.667df2": "Je Node-Typ liegen mehrere Binary-Versionen im Versionsspeicher (aus hochgeladenen Update-Paketen und dem ",
  "adm.3ca706": "jeweils installierten Stand). Die produktive Version gilt f\xFCr neu gestartete lokale Instanzen; Auf- und ",
  "adm.bfb34a": "Abw\xE4rtswechsel ist \u201Eandere Version produktiv setzen\u201C. Dev-Builds sind nicht versioniert und werden nicht archiviert.",
  "adm.3397a7": "Installierte Binaries archivieren",
  "adm.ff58ad": "Archivieren fehlgeschlagen",
  "adm.2f5000": "ohne Build-Stempel (\xE4lterer/Dev-Build)",
  "adm.3846c6": "Installiert: {p0} \xB7 Produktiv: {p1}",
  "adm.ec4dde": "Produktiv setzen",
  "adm.8c876a": "Keine archivierten Versionen (Dev-Build oder noch kein Update-Paket).",
  "adm.0c7131": "Zur\xFCck zum installierten Binary",
  "adm.f43217": "Rollout l\xE4uft \u2026",
  "adm.2d37e3": "{p0} laufende Instanz(en) auf {p1} umstellen \u2026",
  "adm.66a668": " \xB7 veraltet (Neustart n\xF6tig)",
  "adm.4f37c8": " \xB7 Remote-Host (Versionsspeicher gilt nur lokal)",
  "adm.207f5e": "Update-Paket abgelehnt: {p0}",
  "adm.17421d": "Version {p0} an alle registrierten Remote-Hosts verteilen? Host-Agent und Node-Binaries auf den ",
  "adm.41c0d3": "Hosts werden ersetzt; ein neuer Host-Agent wird erst nach dessen Neustart aktiv, laufende Instanzen behalten ",
  "adm.77ae28": "den alten Stand bis zu ihrem Neustart.",
  "adm.b63a37": "Verteilen",
  "adm.a7b1ed": "Verteilen fehlgeschlagen: {p0}",
  "adm.98298f": "{p0} veraltete Instanz(en) jetzt neu starten? Ihre Signale unterbrechen sich dabei kurz ",
  "adm.979273": "(Workflow-Rollen behalten Node-IDs und Bedienzustand).",
  "adm.bad5b8": "Neu starten",
  "adm.7b8028": "Neustart fehlgeschlagen: {p0}",
  "adm.e89f49": "Nicht alle Instanzen neu gestartet: {p0}",
  "adm.901c45": 'Update-Paket \u201E{p0}" vom Server l\xF6schen?',
  "adm.1ec094": "Version {p0} jetzt installieren? Der Server (Orchestrator) wird daf\xFCr neu gestartet und ",
  "adm.7dd803": "ist einige Sekunden nicht erreichbar. Laufende Nodes bleiben in Betrieb, laufen aber bis zu ihrem ",
  "adm.776d94": "n\xE4chsten Neustart mit dem alten Stand.",
  "adm.e117f9": " Dieses Update \xE4ndert die Datenbank ({p0} Migration(en)).",
  "adm.6c6655": "Installieren",
  "adm.20f290": "Update fehlgeschlagen: {p0}",
  "adm.a346cd": "Update l\xE4uft \u2026",
  "adm.ed0484": "Der Server wird gesichert, angehalten, aktualisiert und neu ",
  "adm.737d1d": "gestartet. Diese Seite l\xE4dt automatisch neu, sobald er wieder erreichbar ist (kann bis zu ~1\u20132 Minuten dauern). ",
  "adm.450de1": "Bei einem Fehler stellt der Supervisor den vorherigen Stand automatisch wieder her \u2014 das Ergebnis steht danach ",
  "adm.64e9be": "hier unter \u201EVerlauf\u201C.",
  "adm.059a95": "System-Update",
  "adm.2a87f2": "Firmware wird gelesen \u2026",
  "adm.cd73c1": "Wird geladen \u2026",
  "adm.f4f4c4": "Vertrauensw\xFCrdige Signaturschl\xFCssel: {p0}",
  "adm.e898a8": "Kein Signaturschl\xFCssel hinterlegt (.run/update-trusted.pub) \u2014 Pakete werden abgelehnt.",
  "adm.9df498": "\nACHTUNG: unsignierte Pakete sind erlaubt (OMP_UPDATE_ALLOW_UNSIGNED, nur Entwicklung).",
  "adm.e9553d": "{p0} laufende Node-Instanz(en) nutzen noch einen \xE4lteren Stand als die installierten Dateien ",
  "adm.9301a7": "\u2014 sie werden beim n\xE4chsten Neustart (Instanz oder Workflow) aktualisiert.",
  "adm.0c2f79": "Startet neu \u2026",
  "adm.b7843f": "Veraltete Instanzen jetzt neu starten",
  "adm.d5fe38": "Ein Update auf {p0} l\xE4uft (Phase: {p1}).",
  "adm.9e6d27": "Supervisor nicht erreichbar: {p0} \u2014 ohne ihn kann kein Update angewendet werden (deploy/dev/start-supervisor.sh).",
  "adm.e2bdb7": "Wird hochgeladen und gepr\xFCft \u2026",
  "adm.684cab": "Update-Paket hochladen (.tar.gz):",
  "adm.e05a6b": "Hochgeladene Pakete ({p0})",
  "adm.7fcec6": "Noch kein Paket hochgeladen.",
  "adm.9ac107": "Ausgew\xE4hlt",
  "adm.751a99": "Ausw\xE4hlen",
  "adm.6bf4de": "Architektur: {p0}{p1}{p2}\n",
  "adm.cbe66e": "Voraussetzung: mindestens Version {p0}\n",
  "adm.b57cef": "Hinweis: {p0}\n",
  "adm.2ebe10": "Dieses Update \xE4ndert die Datenbank ({p0}). Ein Backup wird zwingend vorher angelegt.",
  "adm.3f6065": "Verteilung l\xE4uft \u2026",
  "adm.a85888": "Keine Remote-Hosts registriert.",
  "adm.c0fc67": "Vorher ein Datenbank-Backup anlegen",
  "adm.a2eeb2": "Auch installieren, wenn nicht neuer als die installierte Version (Downgrade)",
  "adm.700ea0": "Zur Best\xE4tigung die Versionsnummer eintippen: {p0}",
  "adm.69a300": "Jetzt installieren",
  "adm.2f93d5": "Verlauf",
  "adm.641ad5": "Noch kein Update durchgef\xFChrt.",
  "adm.5a64e9": "FEHLGESCHLAGEN, zur\xFCckgerollt",
  "adm.bf3cfc": "Aktualisieren",
  "adm.13e8c8": 'Backup \u201E{p0}" wirklich zur\xFCckspielen? Dies ERSETZT den kompletten ',
  "adm.d62715": "aktuellen Datenbankinhalt (Nutzer, Rollenbindungen, Audit-Log, Layouts, Snapshots, ",
  "adm.676834": "Workflows, Hosts) unwiderruflich.",
  "adm.c8ef6c": "Zur\xFCckspielen",
  "adm.3f341c": "Restore fehlgeschlagen: {p0}",
  "adm.e91dd5": "Datei konnte nicht als Katalog-Eintrag gelesen werden (ung\xFCltiges JSON).",
  "adm.1ee99d": "Env muss g\xFCltiges JSON sein (Objekt aus String-Paaren), z. B. {}",
  "adm.6cdb17": "Import fehlgeschlagen: {p0}",
  "adm.c32b0c": " (Version {p0})",
  "adm.34066f": 'Katalog-Eintrag "{p0}"{p1} wirklich entfernen?',
  "adm.8a554c": "Beitritt fehlgeschlagen: {p0}",
  "adm.e66e64": '\u201E{p0}" ist der Leader und das einzige verbleibende Cluster-Mitglied \u2014 ',
  "adm.835eb0": "Entfernen ist gesperrt, das w\xFCrde den Cluster dauerhaft unbrauchbar machen.",
  "adm.4e0b70": '\u201E{p0}" ({p1}) ist der aktuelle Leader. Nach dem Entfernen w\xE4hlen die ',
  "adm.b8b22a": "verbleibenden {p0} Mitglieder automatisch einen neuen Leader. Wirklich entfernen?",
  "adm.f7c6bf": 'Mitglied "{p0}" ({p1}) wirklich aus dem Cluster entfernen?',
  "adm.da5fc1": "Nutzer ({p0})",
  "adm.4b9727": "Abbrechen",
  "adm.e6319b": "+ Neuer Nutzer",
  "adm.a9e8b4": '"Rechte" bei einem Nutzer zeigt ALLE seine Rechte an einem Ort: direkt zugewiesene ',
  "adm.e2e8f7": "Rollenbindungen UND \xFCber Gruppenmitgliedschaft geerbte \u2014 Rollenbindungen/Gruppen/",
  "adm.7bb70b": "Organisation bleiben die Verwaltungs-Werkzeuge, diese Ansicht hier ist die Antwort.",
  "adm.5ea427": 'Noch kein Nutzer angelegt \u2014 mit "+ Neuer Nutzer" den ersten (Admin-)Nutzer anlegen.',
  "adm.f5f8d4": "Nutzername",
  "adm.2c51ef": "Angelegt",
  "adm.17b83a": "Organisation",
  "adm.e897f3": "Rolle",
  "adm.4820a0": "Rechte von {p0}",
  "adm.64b2a5": "Globaler Admin \u2014 hat automatisch alle Rechte auf alles, unabh\xE4ngig von Bindungen/Gruppen unten.",
  "adm.65f9b0": "Direkt zugewiesen",
  "adm.5241aa": '\xDCber Gruppe "{p0}"',
  "adm.89d043": "Mitglied in {p0} \u2014 diese Gruppe(n) haben aber (noch) keine eigenen Rechte.",
  "adm.1f9d88": "Keine Rechte \u2014 dieser Nutzer kann sich anmelden, aber nichts sehen oder bedienen, ",
  "adm.1e5016": 'bis er direkt oder \xFCber eine Gruppe eine Rollenbindung bekommt ("+ Neue Bindung" unten bei Rollenbindungen).',
  "adm.3e45af": "Passwort",
  "adm.6212ff": "Anlegen",
  "adm.94b42c": "\xE4ndern",
  "adm.7ea51d": "Organisation dieses Nutzers \xE4ndern",
  "adm.e3afed": "Admin",
  "adm.191f52": "neues Passwort",
  "adm.a294ab": "Rechte \u25B2",
  "adm.ae7313": "Rechte \u25BC",
  "adm.927eb5": "Alle Rechte dieses Nutzers anzeigen \u2014 direkt zugewiesen UND \xFCber Gruppenmitgliedschaft geerbt",
  "adm.201c47": "Organisationen ({p0})",
  "adm.42d3b7": "+ Neue Organisation",
  "adm.8e03b1": "Eine Organisation trennt Sichtbarkeit: Nutzer sehen nur Workflows/Assets/Prozesse ihrer eigenen Organisation. ",
  "adm.51113f": 'Jeder Nutzer geh\xF6rt genau einer Organisation an (\xE4nderbar im Tab "Nutzer").',
  "adm.cc1552": "Noch keine Organisation geladen.",
  "adm.49ee30": "Name",
  "adm.b718ad": "ID",
  "adm.90292d": "Name der Organisation",
  "adm.a45bce": "Storage-Backends ({p0})",
  "adm.1033d2": "Bestimmt, wo Asset-Dateien tats\xE4chlich liegen (S3/MinIO). Mehrere Backends k\xF6nnen gleichzeitig aktiv sein, ",
  "adm.5a8979": "Hinzuf\xFCgen/Entfernen wirkt sofort, kein Neustart n\xF6tig. Nur Super-Admins (globales Admin-Recht) sehen diesen Tab.",
  "adm.074a2f": "Noch nicht aktiviert",
  "adm.027b77": "Diese Funktion braucht serverseitig ",
  "adm.ee8dd8": "OMP_STORAGE_SECRET_KEY",
  "adm.73e569": " \u2014 einen Base64-kodierten\n        32-Byte-Schl\xFCssel, mit dem die Zugangsdaten der Backends verschl\xFCsselt in der Datenbank abgelegt werden.\n        Dieser eine Schl\xFCssel muss aus Sicherheitsgr\xFCnden au\xDFerhalb der UI gesetzt werden (er verschl\xFCsselt die\n        \xFCbrigen Geheimnisse, kann sich also nicht selbst verwalten) \u2014 alles Weitere l\xE4uft danach vollst\xE4ndig hier.",
  "adm.c2730d": "Erzeugen, z. B.: ",
  "adm.4aa4d5": "openssl rand -base64 32",
  "adm.93d4c0": ", dann als Umgebungsvariable\n        setzen und den Orchestrator neu starten.",
  "adm.9534f2": 'Noch kein Storage-Backend angelegt \u2014 mit "+ Neues Backend" das erste anlegen.',
  "adm.2a6ba7": "Endpoint",
  "adm.30edf7": "Bucket",
  "adm.2e3a68": "Access Key",
  "adm.ea52c3": "SSL",
  "adm.ec53a8": "Status",
  "adm.b47c95": "aktiv",
  "adm.7c76fa": "deaktiviert",
  "adm.5ad05d": "Bearbeiten",
  "adm.c0171a": "Nimmt keine neuen Uploads mehr an, liefert bestehende Dateien weiter aus",
  "adm.9cf390": "Nimmt wieder neue Uploads an",
  "adm.2688a5": "Name *",
  "adm.5fc938": "z. B. Prim\xE4rer Media-Bucket",
  "adm.b13884": "Provider *",
  "adm.c35977": "Endpoint *",
  "adm.af0262": "Bucket *",
  "adm.f2129f": "z. B. omp-assets",
  "adm.3871a2": "Access Key *",
  "adm.5eb6bb": "Secret Key",
  "adm.f85e9e": " (leer = unver\xE4ndert)",
  "adm.2109fc": "unver\xE4ndert lassen",
  "adm.8264ad": "Testet\u2026",
  "adm.6a0795": "Verbindung testen",
  "adm.b97d23": "Speichern",
  "adm.3149a3": "Name, Provider, Endpoint, Bucket und Access Key sind erforderlich.",
  "adm.7121c2": "Secret Key ist beim Anlegen erforderlich.",
  "adm.1265eb": "Gruppen ({p0})",
  "adm.663258": "+ Neue Gruppe",
  "adm.022b83": "B\xFCndelt Rechte f\xFCr mehrere Nutzer: eine Rollenbindung auf eine Gruppe gilt f\xFCr alle ihre Mitglieder. ",
  "adm.06144f": 'Trennt sich klar von "Organisationen" \u2014 die steuern Sichtbarkeit (wer sieht welche Workflows/Assets), ',
  "adm.1d455d": "Gruppen steuern Rechte (wer darf was); beides bleibt unabh\xE4ngig nebeneinander bestehen.",
  "adm.657888": 'Noch keine Gruppe angelegt \u2014 mit "+ Neue Gruppe" die erste anlegen.',
  "adm.916ea4": "Name der Gruppe",
  "adm.234de2": "Beschreibung (optional)",
  "adm.35bedb": "Beschreibung",
  "adm.ee5ce7": "Mitglieder \u25B2",
  "adm.be45f7": "Mitglieder \u25BC",
  "adm.6a7843": "Mitglieder ({p0})",
  "adm.638b34": "Noch kein Mitglied.",
  "adm.e2d84f": "+ Hinzuf\xFCgen",
  "adm.ccdd47": "Rechte dieser Gruppe",
  "adm.422405": "Noch keine \u2014 unter Admin \u2192 Rechte bei der Gruppe vergeben.",
  "adm.2578ee": "Rollenbindungen ({p0})",
  "adm.473936": "+ Neue Bindung",
  "adm.aa6c6f": 'Einzelne Bindungen anlegen/l\xF6schen (Subjekt: Nutzer ODER Gruppe). F\xFCr "was darf Nutzer X ',
  "adm.c4e6da": 'insgesamt" (direkt + \xFCber alle Gruppen) im Tab "Nutzer" bei der Person auf "Rechte" klicken.',
  "adm.782a90": "Noch keine Rollenbindung angelegt.",
  "adm.18c4aa": "Nach Nutzer",
  "adm.d4bcb3": "Nach Node/Rolle",
  "adm.e9cc81": "Nutzer \u2192 Node",
  "adm.75894c": "Node \u2192 Nutzer",
  "adm.8a940a": "Nutzer",
  "adm.3b77a5": "Gruppe",
  "adm.e5b1cd": "\u2013 Gruppe w\xE4hlen \u2013",
  "adm.14a665": "\u2013 keine Gruppe vorhanden \u2013",
  "adm.3096f0": "Rollenname (* = ganzer Workflow)",
  "adm.3a7309": "Node-ID (* = alle Nodes)",
  "adm.e5c1c7": "Ganzer Workflow",
  "adm.a78fea": "Alle Nodes",
  "adm.3dda54": "Node-Katalog ({p0})",
  "adm.2132be": "Suche nach Label, Typ, Beschreibung \u2026",
  "adm.438c04": "Importierte Microservices laufen als Podman-Container (OCI-Image) und durchlaufen vor der Aufnahme denselben Contract-Check wie `make contract` \u2014 ein Kandidat, der den Node-Contract nicht erf\xFCllt, wird abgelehnt.",
  "adm.c7c031": "Keine Katalog-Eintr\xE4ge passen zur Suche.",
  "adm.f74d2d": "Noch keine Katalog-Eintr\xE4ge.",
  "adm.d2dfcc": "Node/Microservice importieren",
  "adm.8311b9": "Schlie\xDFen",
  "adm.2256dc": "Aus exportierter Datei vorbef\xFCllen:",
  "adm.c2ea84": "Typ",
  "adm.7c9eea": "z. B. omp-thirdparty-node",
  "adm.b021df": "Label",
  "adm.2eb6eb": "Anzeigename",
  "adm.be53a0": "Image",
  "adm.34b6cd": "Version",
  "adm.722ff0": "Erwartete Ressourcen",
  "adm.ea50f3": "Command-Override",
  "adm.6f865e": "optional, Leerzeichen-getrennt",
  "adm.47a997": "Env (JSON-Objekt, optional)",
  "adm.5af5fb": "Importieren",
  "adm.7003e3": "Import abgelehnt: Contract-Check nicht bestanden",
  "adm.e9e1f9": "Importiert",
  "adm.5e4eb4": "Eingebaut",
  "adm.0095a9": "Export",
  "adm.e6e18b": "Audit-Log ({p0} geladen)",
  "adm.5f30db": "Noch keine protokollierten Aktionen.",
  "adm.718271": "Zeit",
  "adm.41aa69": "Methode",
  "adm.b6a791": "Pfad",
  "adm.4446bb": "L\xE4dt \u2026",
  "adm.5cc9dd": "Mehr laden",
  "adm.56f489": "Diagnose ({p0} geladen)",
  "adm.9a4c0a": "Keine Log-Zeilen f\xFCr diesen Filter.",
  "adm.51ff86": "Noch keine zentralisierten Log-Zeilen.",
  "adm.a0db49": "Level",
  "adm.6c3a69": "Node",
  "adm.dd4ec0": "Trace",
  "adm.d87d49": "Nachricht",
  "adm.fb9f6f": "Node-ID",
  "adm.05e870": "Alle Level",
  "adm.902b0d": "Error",
  "adm.56525a": "Warn",
  "adm.4059b0": "Info",
  "adm.9cbd4a": "Trace-ID",
  "adm.2b98bc": "Filtern",
  "adm.cf743f": "Filter zur\xFCcksetzen",
  "adm.24f46f": "Backups ({p0})",
  "adm.97a791": "Erstellt \u2026",
  "adm.edb4fa": "Backup jetzt erstellen",
  "adm.2b953c": "Ein Backup ist ein vollst\xE4ndiger pg_dump der Orchestrator-Datenbank (Nutzer, Rollenbindungen, ",
  "adm.1e8584": "Audit-Log, Layouts, Snapshots, Workflows, Hosts) \u2014 komprimiert, sofort als Download. ",
  "adm.9349ee": "Dieselbe Rotation (14 neueste behalten) wie \u201Emake backup\u201C.",
  "adm.b86bfc": "Noch kein Backup vorhanden.",
  "adm.2099e6": "Herunterladen",
  "adm.2bd339": "Restore",
  "adm.150dcd": "Wird hochgeladen \u2026",
  "adm.047e43": "Backup-Datei hochladen (statt aus der Liste oben zu w\xE4hlen):",
  "adm.aec2da": "Noch kein Backup vorhanden \u2014 erst eines erstellen oder eine Datei oben hochladen.",
  "adm.2a2629": "ERSETZT den kompletten aktuellen Datenbankinhalt (Nutzer, Rollenbindungen, Audit-Log, ",
  "adm.316a1c": "Layouts, Snapshots, Workflows, Hosts) mit dem gew\xE4hlten Stand \u2014 nicht r\xFCckg\xE4ngig zu ",
  "adm.46dc6f": "machen, au\xDFer durch ein weiteres Restore. Der Orchestrator ist w\xE4hrend des Vorgangs ",
  "adm.4ec161": "(wenige Sekunden) nicht erreichbar, diese Seite l\xE4dt danach automatisch neu.",
  "adm.2cfe4a": "Backup w\xE4hlen \u2026",
  "adm.80c34c": "Zur Best\xE4tigung exakt eintippen: {p0}",
  "adm.42e0ae": "Restore wird eingeleitet \u2026",
  "adm.ea2f07": "Server wird neu gestartet \u2026",
  "adm.69d86c": "Sende den Restore-Auftrag an den Supervisor.",
  "adm.e55e76": "Datenbank wird zur\xFCckgespielt, der Orchestrator startet danach automatisch neu \u2014 ",
  "adm.84e42d": "diese Seite l\xE4dt sich von selbst neu, sobald er wieder erreichbar ist.",
  "adm.cl.role": "Rolle",
  "adm.cl.witness": "Zeuge (stimmt nur ab)",
  "adm.cl.lostTitle": "Cluster ohne Mehrheit",
  "adm.cl.lostText": "Seit {p0} s ist kein Leader erreichbar: Failover, Scheduler und alles, was nur der Leader tut, stehen. Meist ist der andere Orchestrator ausgefallen oder nicht erreichbar. Dauerhaft vermeiden: einen dritten Raft-Knoten (Zeuge, eigener Rechner) einrichten.\n\nIst der Partner wirklich aus und bleibt es, kann dieser Orchestrator als Einzelknoten weiterbetrieben werden (Notausgang).",
  "adm.cl.solo": "Als Einzelknoten weiterbetreiben \u2026",
  "adm.cl.soloConfirm": "Notausgang: Dieser Orchestrator wird beim n\xE4chsten Start als EINZIGER Knoten weiterbetrieben und vergisst seine Partner.\n\nNur ausf\xFChren, wenn der andere Orchestrator wirklich ausgefallen ist und nicht mehr startet. L\xE4uft er noch, entstehen zwei Leader nebeneinander (Split-Brain): beide steuern dieselben Hosts und Nodes.\n\nDanach diesen Orchestrator neu starten. Den Partner sp\xE4ter als neues Mitglied wieder aufnehmen (mit frischem Datenverzeichnis).",
  "adm.cl.soloConfirmBtn": "Vormerken",
  "adm.cl.pendingTitle": "Notausgang vorgemerkt",
  "adm.cl.pendingText": "Beim n\xE4chsten Start l\xE4uft dieser Orchestrator als Einzelknoten. Jetzt neu starten (systemctl restart oder make stop && make start). Vorher l\xE4sst sich die Vormerkung noch zur\xFCcknehmen.",
  "adm.cl.cancel": "Vormerkung zur\xFCcknehmen",
  "adm.58518d": "Cluster ({p0} Mitglieder)",
  "adm.6c359d": "+ Weiteren Orchestrator hinzuf\xFCgen",
  "adm.3a035f": "Cluster-Status wird geladen \u2026",
  "adm.67691f": "Diese Instanz",
  "adm.7f5acf": "Zustand",
  "adm.5158a2": "Leader",
  "adm.cf5f30": "Term",
  "adm.2aeb64": "Angewandter Log-Index",
  "adm.262954": "{p0} (diese Instanz)",
  "adm.76d1d0": "Raft-Adresse",
  "adm.1771bd": "Node-ID und Raft-Adresse der neuen Instanz eintragen, das Skript unten auf ihr ausf\xFChren, ",
  "adm.13b8c8": "warten bis sie l\xE4uft (passiv, ohne Selbst-Bootstrap) \u2014 dann hier beitreten lassen.",
  "adm.045fdc": "Node-ID, z. B. node-2",
  "adm.ca9750": "Raft-Adresse, z. B. host-2:8300",
  "adm.c5ce55": "Skript kopieren",
  "adm.70dfc1": "Kopiert!",
  "adm.5728d7": "Jetzt beitreten lassen",
  "adm.d07366": "Der letzte verbleibende Leader kann nicht entfernt werden.",
  "kss.8b9c05": " (nicht verf\xFCgbar)",
  "kss.1e116b": "\u2014 ausw\xE4hlen \u2014",
  "alv2.1f3b58": "{p0} von {p1} um {p2}",
  "alv2.6edd48": ", bis {p0}",
  "aps.wfSearch": "Workflow suchen \u2026",
  "aps.wfNone": "Kein Treffer",
  "aps.00a8fd": "Workflow: Alle",
  "hw2.592c6d": "virtuelle Maschine im eigenen Netz",
  "loc2.1c3172": "z. B. Archiv-Share",
  "set2.09cc1e": "\u201E{p0}\u201C gespeichert.",
  "set2.9ad047": "wirksam: {p0} ({p1})",
  "set2.ae997f": "gespeichert: {p0} \u2014 gilt erst nach Neustart des Orchestrators",
  "ver.a4394c": "Entwicklungsstand",
  "ver.afterRelease": "Entwicklungsstand nach {p0}, +{p1}",
  "ver.f7c666": "Firmware {p0}{p1}",
  "aml.ec4721": "Mono (1)",
  "aml.5d9b47": "Mono",
  "aml.490585": "Stereo (2)",
  "aml.64d485": "Eigene Anzahl \u2026",
  "aml.935327": "Kanal {p0}",
  "aml.24354f": "Mono \u2192 Stereo (dupliziert)",
  "aml.672b84": "Der eine Kanal geht unver\xE4ndert (100%) auf beide Ausgangsspuren.",
  "aml.f5f0a7": "Stereo \u2192 Mono (Summe, \u22123dB je Kanal)",
  "aml.5284e1": "L und R werden mit je 70,7% (\u22123dB) auf eine Ausgangsspur summiert.",
  "aml.40faff": "L/R unver\xE4ndert (100%), Center und der gleichseitige Surround-Kanal mit \u22123dB (70,7%) zugemischt. LFE bleibt bewusst unber\xFCcksichtigt (g\xE4ngige Praxis) \u2014 bei Bedarf danach manuell erg\xE4nzen.",
  "avl.093ab0": "Beschreibend",
  "avl.02822c": "Redaktionell",
  "avl.c52083": "Technisch",
  "avl.133411": "Eigene Felder",
  "avl.a45da9": "System",
  "avl.4bf36f": "Eingang",
  "avl.469b92": "Registriert",
  "avl.379ee8": "Bereit",
  "avl.9b9437": "In Pr\xFCfung",
  "avl.6bb8d0": "Freigegeben",
  "avl.18a0e4": "Ver\xF6ffentlicht",
  "avl.d11aee": "Archiviert",
  "avl.768a27": "Abgelaufen",
  "avl.b74b71": "Gel\xF6scht",
  "avl.29cb3a": '{p0}: Feld ohne Namen (Wert "{p1}")',
  "avl.70ac00": '{p0}: Feld "{p1}" ist kein g\xFCltiger Wert (JSON erwartet)',
  "avl.d94f16": "{p0} Mbit/s",
  "ll.8ffe83": "nicht gepr\xFCft",
  "ll.1700cd": " \xB7 frei {p0} von {p1}",
  "ll.a1b35e": "lesbar, {p0} Eintr\xE4ge{p1}",
  "sl.23c90e": "Manuell/{p0}",
  "sl.51279b": "Manuell gestartet",
  "sl.72ce72": "Netz",
  "sl.501ffd": "{p0} Gbit/s",
  "sl.d94f16": "{p0} Mbit/s",
  "stl.0a6892": "Allgemein",
  "stl.440a36": "Standard: {p0}",
  "stl.36a797": "Standard: vom Node bestimmt",
  "stl.cca832": "erlaubt: {p0} bis {p1}",
  "stl.e2aa67": "Datei",
  "stl.6c4ca0": "Verzeichnis",
  "stl.b2780d": "muss existieren",
  "wpl.d6616a": "Bedarf unbekannt",
  "wpl.4bb2ed": "keine Messwerte (lokal)",
  "wpl.72049b": "keine Messwerte",
  "wpl.e580f1": "jetzt {p0}",
  "pscl.edf89b": "Node-Funktion",
  "pscl.3ec2a9": "Ruft eine Funktion eines laufenden Microservice auf (z. B. Aufnahme starten, Grafik zeigen).",
  "pscl.252f47": "Web-Aufruf (HTTP)",
  "pscl.be6156": "Ruft eine Web-Adresse auf (REST-API eines anderen Systems).",
  "pscl.ba264e": "Datei-Werkzeug (ffmpeg)",
  "pscl.50dc19": "F\xFChrt ein freigegebenes Werkzeug wie ffmpeg/ffprobe aus \u2014 z. B. Proxy erzeugen, Metadaten auslesen.",
  "pscl.490ba3": "Benachrichtigung",
  "pscl.6b7645": "Sendet eine Nachricht auf den Ereignisbus, auf die andere Systeme reagieren k\xF6nnen.",
  "pscl.9da01f": "Unterprozess",
  "pscl.96a4f7": "Startet einen anderen Prozess und wartet, bis er fertig ist.",
  "pscl.ae59d5": "Wenn \u2026 dann",
  "pscl.1a789c": "Pr\xFCft eine Regel und verzweigt in einen Ja- oder Nein-Weg.",
  "pscl.a6e3cb": "Verteiler (mehrere F\xE4lle)",
  "pscl.29f701": "Pr\xFCft mehrere Regeln der Reihe nach und nimmt den Weg des ersten zutreffenden Falls.",
  "pscl.755c8f": "Parallel aufteilen",
  "pscl.6f5185": "Startet alle verbundenen Folgeschritte gleichzeitig.",
  "pscl.834ac6": "Zusammenf\xFChren",
  "pscl.c8f0b4": "Wartet, bis alle eingehenden Wege angekommen sind.",
  "pscl.f152a5": "Warten",
  "pscl.402c2d": "Pausiert den Ablauf f\xFCr eine feste Zeit.",
  "pscl.efb477": "Timer",
  "pscl.534969": "Wie \u201EWarten\u201C: l\xE4uft nach Ablauf der Zeit weiter.",
  "pscl.4ca08f": "Aufgabe f\xFCr Person",
  "pscl.774c40": "Legt eine Aufgabe an, die eine Person erledigen muss, bevor es weitergeht.",
  "pscl.c947f6": "Freigabe",
  "pscl.5f3043": "Eine Person gibt frei, lehnt ab oder fordert \xC4nderungen an \u2014 je Ergebnis ein eigener Weg.",
  "pscl.e4fa94": "Task (generisch)",
  "pscl.8faa35": "Platzhalter ohne eingebaute Ausf\xFChrung.",
  "pscl.6c5de6": "Schleife",
  "pscl.2b4ae5": "Noch nicht ausf\xFChrbar.",
  "pscl.3727f6": "Auf Ereignis warten",
  "pscl.dcc732": "Noch nicht ausf\xFChrbar \u2014 Prozess-Start durch Ereignisse \xFCber \u201EAusl\xF6ser\u201C in der Werkzeugleiste.",
  "pscl.cec559": "Kompensation",
  "pscl.3e9f80": "HTTP-Status (z. B. 200)",
  "pscl.f385d3": "Antwort (Inhalt)",
  "pscl.0d3958": "Exit-Code (0 = ok)",
  "pscl.b65498": "Ausgabe (stdout)",
  "pscl.daeec0": "Fehlerausgabe (stderr)",
  "pscl.7c0760": "Entscheidung",
  "pscl.cd0559": "Kommentar",
  "pscl.9d885e": "Bearbeitet von",
  "pscl.6cf0a2": "Gew\xE4hlter Weg",
  "pscl.2f0304": "Ergebnis (gesamt)",
  "pscl.8c7a60": "Asset-ID",
  "pscl.406438": "Neuer Status",
  "pscl.06464c": "Ge\xE4ndert von",
  "pscl.a405eb": "Asset wurde angelegt",
  "pscl.18a802": "Titel",
  "pscl.c2ea84": "Typ",
  "pscl.e94273": "Asset-Metadaten wurden ge\xE4ndert",
  "pscl.481861": "Asset-Version wurde angelegt",
  "pscl.3ef4be": "Versions-ID",
  "pscl.668bfa": "Versionsnummer",
  "pscl.f87cf1": "Asset-Version wurde ver\xF6ffentlicht",
  "pscl.e1ed1e": "Asset wechselt auf \u201E{p0}\u201C",
  "pscl.cedbae": "Start-Eingabe / ausl\xF6sendes Ereignis",
  "pscl.0ac1be": "Ergebnis von \u201E{p0}\u201C ({p1})",
  "pscl.b74155": "ID dieses Prozesslaufs",
  "pscl.5657ea": "Prozesslauf",
  "pscl.44923c": "Korrelations-ID",
  "pscl.a65a49": "Anzahl bisheriger Wiederholungen",
  "pscl.4ef614": "ist gleich",
  "pscl.d83ad5": "ist nicht gleich",
  "pscl.7b8174": "ist gr\xF6\xDFer als",
  "pscl.a113df": "ist mindestens",
  "pscl.d2c8f8": "ist kleiner als",
  "pscl.c64548": "ist h\xF6chstens",
  "pscl.a4aaeb": "enth\xE4lt",
  "pscl.460b70": "beginnt mit",
  "pscl.dd578a": "\xC4nderungen angefordert",
  "pscl.b397ec": "Nein",
  "pscl.847202": "Sekunden",
  "pscl.2006ff": "Minuten",
  "pscl.f45588": "Stunden",
  "pscl.5f5c5a": "keine Wiederholung",
  "pscl.616a18": "bis zu {p0} Versuche, {p1} Abstand",
  "pscl.b987ca": "Technische Metadaten auslesen",
  "pscl.4b6338": "Liefert Codec, Aufl\xF6sung, Dauer usw. als JSON im Ergebnis-Feld \u201EAusgabe (stdout)\u201C.",
  "pscl.ebf39e": "Proxy erzeugen (H.264, 960 px breit)",
  "pscl.71816a": "Kleine Sichtungskopie der Quelldatei.",
  "pscl.e0f287": "Vorschaubild erzeugen",
  "pscl.5ad538": "Einzelbild bei Sekunde 5, 480 px breit.",
  "pscl.e33f6d": "Tonspur als WAV extrahieren",
  "pscl.272a13": "Einzelbild aus einem Video, z. B. f\xFCr eine Vorschaukachel.",
  "pscl.44038d": "Format/Codec konvertieren",
  "pscl.fef9af": "Container, Video-/Audio-Codec und deren Einstellungen frei w\xE4hlen \u2014 mit echten erlaubten Werten und Hilfetexten von diesem Server. Enth\xE4lt auch die grafische Audio-Matrix und den Filter-Graph-Builder.",
  "pscl.1d7d40": "Tonspur extrahieren",
  "pscl.7faa8d": "Nur den Ton einer Datei speichern, mit frei w\xE4hlbarem Audio-Codec.",
  "pscl.b1e82a": "Clips aneinanderh\xE4ngen (Schnittliste)",
  "pscl.8f2c02": "Mehrere Dateien in einer festgelegten Reihenfolge zu einer Ausgabedatei zusammenf\xFCgen \u2014 je Clip optional mit Start-/End-Beschnitt.",
  "pscl.02bf41": "Overlay/Senderkennung/Abspann zeitgesteuert einblenden",
  "pscl.ca9a47": "Text (z. B. Bauchbinde, Abspann-Credits) oder ein Bild (z. B. Senderlogo) zu festgelegten Zeiten \xFCber das Video legen.",
  "pscl.c974f8": "Lautheit normalisieren (EBU R128)",
  "pscl.7cfc14": "Tonspur auf eine Ziel-Lautheit (LUFS) bringen, z. B. f\xFCr Sendeabnahme (-23 LUFS) oder Streaming-Plattformen. Einpass-Verfahren \u2014 f\xFCr eine noch pr\xE4zisere Zweipass-Messung den Experten-Modus nutzen.",
  "pscl.eee8e9": "Verlustfreier Passthrough/Remux (Container wechseln)",
  "pscl.853c91": "Container wechseln ohne Neukodierung (Stream-Copy) \u2014 schnell, aber nur zwischen kompatiblen Containern/Codecs m\xF6glich.",
  "pscl.dcd50a": "Streaming-Ausgabeleiter (Multi-Bitrate HLS)",
  "pscl.9e4fd7": "Mehrere Aufl\xF6sungen/Bitraten gleichzeitig als HLS-Ausgabeleiter (Master-Playlist + je Rendition ein Unterordner) \u2014 f\xFCr adaptives Streaming in Web-/App-Playern.",
  "pscl.be80be": "Zu pr\xFCfende Datei",
  "pscl.7d7927": "Zu pr\xFCfende Datei fehlt.",
  "pscl.7ddbbe": "Eingabedatei",
  "pscl.70f1da": "Ausgabedatei (Bild)",
  "pscl.a0ef65": "Zeitpunkt im Video",
  "pscl.86b066": "Breite in Pixeln",
  "pscl.08822b": "Pixel",
  "pscl.969a03": "H\xF6he wird proportional berechnet.",
  "pscl.9205c3": "Eingabe- und Ausgabedatei sind Pflicht.",
  "pscl.f6dd2b": "Breite: keine g\xFCltige Zahl.",
  "pscl.8adabd": "Ausgabedatei",
  "pscl.16202d": "Audio-Codec",
  "pscl.1ea5b7": "Leer = ffmpeg-Standard f\xFCr die gew\xE4hlte Dateiendung.",
  "pscl.0b9820": "Ziel-Lautheit (LUFS)",
  "pscl.85ee17": "EBU R128 (Sendeabnahme Broadcast): -23. H\xE4ufige Streaming-Ziele: -16 (YouTube), -14 (Spotify/Apple Music).",
  "pscl.475054": "Maximaler True Peak (dBTP)",
  "pscl.d7f1ac": "EBU R128 empfiehlt -1 oder niedriger.",
  "pscl.0c605b": "Lautheits-Schwankungsbreite / LRA (LU)",
  "pscl.749393": "Leer = ffmpeg-Standard f\xFCr die gew\xE4hlte Dateiendung. Das Bild wird immer unver\xE4ndert \xFCbernommen (Stream-Copy).",
  "pscl.738fb5": "Ziel-Lautheit: keine g\xFCltige Zahl.",
  "pscl.b46f8d": "Maximaler True Peak: keine g\xFCltige Zahl.",
  "pscl.b2cee1": "Lautheits-Schwankungsbreite: keine g\xFCltige Zahl gr\xF6\xDFer 0.",
  "pscl.6bbca5": "Container erzwingen (optional)",
  "pscl.74d4bd": "Leer = ffmpeg leitet ihn aus der Endung der Ausgabedatei ab.",
  "pscl.4c7e15": "Ausgabeverzeichnis",
  "pscl.94a565": "Master-Playlist (master.m3u8) landet direkt hier, je Rendition ein Unterordner mit Segmenten.",
  "pscl.c93db4": "Segmentl\xE4nge (Sekunden)",
  "pscl.f59f69": "Renditionen",
  "pscl.4cba27": "Mindestens eine \u2014 jede wird als eigene Bitrate/Aufl\xF6sung in der Ausgabeleiter erzeugt. Name nur Buchstaben/Zahlen/Bindestrich (wird als Verzeichnisname verwendet).",
  "pscl.475096": "Rendition {p0}",
  "pscl.49ee30": "Name",
  "pscl.9a9491": "Breite (Pixel)",
  "pscl.cd2da5": "H\xF6he (Pixel)",
  "pscl.64153c": "Video-Bitrate (kbit/s)",
  "pscl.45845d": "Audio-Bitrate (kbit/s)",
  "pscl.d99ff6": "Eingabedatei und Ausgabeverzeichnis sind Pflicht.",
  "pscl.98a492": "Segmentl\xE4nge: keine g\xFCltige Zahl gr\xF6\xDFer 0.",
  "pscl.138685": "Mindestens eine Rendition ist n\xF6tig.",
  "pscl.cf38a8": "Jede Rendition braucht einen Namen.",
  "pscl.d1865d": '"{p0}": Name darf nur Buchstaben, Zahlen und Bindestrich enthalten.',
  "pscl.67d2c0": '"{p0}": Breite/H\xF6he m\xFCssen g\xFCltige Zahlen gr\xF6\xDFer 0 sein.',
  "pscl.754226": '"{p0}": Video-Bitrate muss eine g\xFCltige Zahl gr\xF6\xDFer 0 sein.',
  "pscl.202bf1": '"{p0}": Audio-Bitrate muss eine g\xFCltige Zahl gr\xF6\xDFer 0 sein.',
  "pscl.73802f": "Rendition-Namen m\xFCssen eindeutig sein.",
  "pscl.bf4c3c": "Bereich: {p0} bis {p1}",
  "pscl.440a36": "Standard: {p0}",
  "pscl.cce2fa": 'M\xF6gliche Werte (kombinierbar mit "+", z. B. {p0}+{p1}): {p2}',
  "pscl.c55048": "Ausgabedatei ohne Nachfrage \xFCberschreiben.",
  "pscl.f464ad": "Niemals \xFCberschreiben \u2014 bricht ab, falls die Ausgabedatei existiert.",
  "pscl.72cb7c": "Unterdr\xFCckt ffmpegs Versions-/Build-Bannerausgabe.",
  "pscl.7d0ede": "Ausf\xFChrlichkeit der Konsolenausgabe.",
  "pscl.041552": "Startzeit (vor -i: Eingabe-seeking, schnell; nach -i: Ausgabe-seeking, exakter).",
  "pscl.3cb7b9": "Maximale Dauer ab Startzeit.",
  "pscl.1085b1": "Endzeit (Alternative zu -t).",
  "pscl.f32cca": "Container-Format erzwingen (sonst aus der Dateiendung abgeleitet).",
  "pscl.847d4a": 'W\xE4hlt Streams f\xFCr die Ausgabe aus, z. B. "0:v" oder "1:a:0".',
  "pscl.0230a4": "Keine Videospur in die Ausgabe \xFCbernehmen.",
  "pscl.36692c": "Keine Tonspur in die Ausgabe \xFCbernehmen.",
  "pscl.39341f": "Keine Untertitelspur in die Ausgabe \xFCbernehmen.",
  "pscl.a81aa9": "Keine Datenspur in die Ausgabe \xFCbernehmen.",
  "pscl.aaf04a": 'Codec f\xFCr alle Streams (Kurzform f\xFCr -c:v/-c:a/-c:s zusammen), z. B. "copy".',
  "pscl.748b37": "Video-Codec, z. B. libx264 oder copy.",
  "pscl.76a00d": "Audio-Codec, z. B. aac oder copy.",
  "pscl.eb5986": "Untertitel-Codec.",
  "pscl.97d5ed": 'Video-Zielbitrate, z. B. "4M".',
  "pscl.5608df": 'Audio-Zielbitrate, z. B. "192k".',
  "pscl.93946f": "Audio-Abtastrate in Hz, z. B. 48000.",
  "pscl.118fc3": "Anzahl Audiokan\xE4le.",
  "pscl.579128": "Video-Bildrate in fps.",
  "pscl.f2e288": 'Videoaufl\xF6sung, z. B. "1920x1080".',
  "pscl.cce5db": 'Seitenverh\xE4ltnis, z. B. "16:9".',
  "pscl.a86942": "Video-Filterkette (Kurzform f\xFCr -filter:v).",
  "pscl.1f23d9": "Audio-Filterkette (Kurzform f\xFCr -filter:a).",
  "pscl.21909e": "Mehrfach-Ein-/Ausgang-Filtergraph.",
  "pscl.044b6e": 'Metadaten-Schl\xFCssel=Wert, z. B. "title=Mein Titel".',
  "pscl.503bf8": "Anzahl Encoding-Threads (0 = automatisch).",
  "pscl.046953": "Ausgabe bei der k\xFCrzesten Eingabespur beenden.",
  "pscl.03361f": "GOP-Gr\xF6\xDFe (Abstand zwischen Keyframes).",
  "pscl.b70c5f": "Maximale Anzahl aufeinanderfolgender B-Frames.",
  "pscl.b74742": "Zeitstempel-/Frame-Anpassung bei der Ausgabe.",
  "pscl.53e1fb": "Erwartet einen von: {p0}",
  "pscl.9b0b40": 'Erwartet "true" oder "false".',
  "pscl.13a83c": "Erwartet eine Zahl.",
  "pscl.e2bc00": "Erwartet einen Wert zwischen {p0} und {p1}.",
  "pscl.d2383a": '"{p0}" nimmt keinen Wert (Ein-/Aus-Flag).',
  "pscl.29c387": 'Erwartet eine Dauer, z. B. "5" oder "00:01:23.5".',
  "pscl.3c326c": "Adresse (URL) fehlt",
  "pscl.4423d3": "Werkzeug fehlt",
  "pscl.a400c0": "Node/Funktion fehlt",
  "pscl.d92700": "Kanal fehlt",
  "pscl.bf4504": "Regel fehlt",
  "pscl.131bec": "mindestens ein Fall n\xF6tig",
  "pscl.a9dca0": "Prozess fehlt",
  "pscl.d60d5c": "Wartezeit fehlt",
  "misc.failedWith": "{p0} fehlgeschlagen: {p1}",
  "misc.wfSaveFailed": "Im Workflow speichern fehlgeschlagen: {p0}",
  "misc.failed": "fehlgeschlagen",
  "y.dm51": "5.1 \u2192 Stereo (ITU-Downmix, \u22123dB)",
  "y.addIn": "+ Eingang",
  "y.addOut": "+ Ausgang",
  "y.std": "\u2013 Standard \u2013",
  "y.oneTile": "1 Kachel",
  "y.addEntry": "+ Eintrag",
  "y.addCase": "+ Fall",
  "y.addTrack": "+ Ausgabespur",
  "y.typo": "\u2248 Tippfehler?",
  "y.addArg": "+ Argument",
  "y.redo": "\u21B7 Wiederholen",
  "y.orgStd": "{p0} (Standard)",
  "y.newBackend": "+ Neues Backend",
  "y.global": "(Global)",
  "y.importNode": "+ Node/Microservice importieren",
  "y.netPart": " / Netz {p0}%",
  "y.dupField": '{p0}: Feld "{p1}" doppelt',
  "y.addRel": "+ Beziehung",
  "y.addRep": "+ Representation",
  "y.addField": "+ Feld",
  "y.assign": "\u270E Belegen",
  "y.netPct": " \xB7 Netz {p0} %",
  "y.netRxTx": " \xB7 Netz Rx {p0} \xB7 Tx {p1}",
  "sched.ownLane": "{p0} \u2014 eigener Anteil (gemeinsame Maschine)",
  "sched.sharedMachine": "Gemeinsame Maschine: ",
  "sched.placementHint": " Laufende Workflows z\xE4hlen auf dem Host, auf dem sie tats\xE4chlich laufen; geplante Rollen ohne Host-Festlegung werden dem Host zugeordnet, den die Platzierung beim Start voraussichtlich w\xE4hlt (geringste Auslastung, ohne Hosts im Wartungsmodus) \u2014 eine Prognose.",
  "sched.editOk": "OK",
  "y.bottleneck": "\u26A0 Engpass: {p0}{p1}",
  "y.resBottleneck": "\n\u26A0 Ressourcen-Engpass: {p0}",
  "y.stdOpt": "\u2014 Standard{p0} \u2014",
  "y.cores": "~{p0} Kerne \xB7 {p1}",
  "portTags.titleOut": "Tags von Ausgang \u201E{label}\u201C",
  "portTags.titleIn": "Tags von Eingang \u201E{label}\u201C",
  "portTags.inherited": "Automatisch (nicht \xE4nderbar):",
  "portTags.inheritedHint": "\u24D8 aus Medientyp/Kanalzahl abgeleitet, \u25CC vom Node gemeldet",
  "portTags.placeholder": "z. B. role.commentator",
  "portTags.add": "Tag hinzuf\xFCgen",
  "portTags.remove": "Tag entfernen",
  "portTags.none": "Keine eigenen Tags",
  "portTags.save": "Speichern",
  "portTags.cancel": "Abbrechen",
  "portTags.unknown": "Port nicht in der Registry gefunden \u2014 Node offline?",
  "portTags.loadFailed": "Tags konnten nicht geladen werden: {err}",
  "portTags.err.invalid": "Format: domain.name (Kleinbuchstaben, Ziffern, Bindestrich), z. B. audio.commentator",
  "portTags.err.duplicate": "Tag ist bereits gesetzt",
  "portTags.err.limit": "H\xF6chstens 32 Tags je Port",
  "portTags.button": "Tags der Ports bearbeiten",
  "portTags.saveFirst": "Erst speichern oder abbrechen, bevor ein anderer Port gew\xE4hlt wird",
  "flow.migrateButton": "Auf anderen Host verschieben",
  "anchor.noRemove": "Der Playout-Puffer ist der feste Ausgang dieses Workflows und l\xE4sst sich nicht entfernen.",
  "anchor.tooltip": "Ausgangs-Anker \u2014 fest verankert",
  "anchor.depthLabel": "Puffer (ms)",
  "anchor.depthTitle": "Puffertiefe dieses Workflows in Millisekunden (leer = 2500). Je gr\xF6\xDFer, desto l\xE4ngere Ausf\xE4lle davor werden \xFCberbr\xFCckt \u2014 und desto mehr Speicher wird belegt.",
  "sd.title": "Stream-Deck-Test und Simulator",
  "sd.model": "Modell",
  "sd.connectReal": "Echtes Ger\xE4t verbinden",
  "sd.disconnect": "Trennen",
  "sd.simulate": "Simulator starten",
  "sd.sendGrid": "Testraster senden",
  "sd.brightness": "Helligkeit",
  "sd.connected": "Verbunden: {name}",
  "sd.notConnected": "Nicht verbunden",
  "sd.log": "Ereignisse",
  "sd.err.no-webhid": "Dieser Browser unterst\xFCtzt WebHID nicht (Chrome oder Edge am Desktop verwenden).",
  "sd.err.insecure-context": "WebHID braucht HTTPS oder localhost.",
  "sd.err.denied": "Zugriff auf das Ger\xE4t wurde nicht erlaubt.",
  "sd.err.unsupported-model": "Dieses Stream-Deck-Modell wird noch nicht unterst\xFCtzt.",
  "sd.err.open-failed": "Das Ger\xE4t lie\xDF sich nicht \xF6ffnen (h\xE4lt ein anderes Programm es? udev-Regel gesetzt?).",
  "sd.renderTest": "Render-Test",
  "board.streamDeck": "Stream Deck",
  "midi.button": "MIDI",
  "midi.title": "MIDI-Pulte",
  "midi.hint": "Fahrfader-Pulte (z. B. iCON V1-M/P1-M mit Erweiterung) und andere MIDI-Ger\xE4te steuern den Audiomischer. USB-Ger\xE4te h\xE4ngen direkt am Browser (Chrome oder Edge); Pulte am Server oder im Netzwerk (RTP-MIDI) bedient der Node \u201EMIDI-Gateway\u201C.",
  "midi.mode": "Betriebsart",
  "midi.mode.mcu": "Mackie Control (Mischpult)",
  "midi.mode.profile": "Generisches Profil (Regler und Tasten zuordnen)",
  "midi.search": "MIDI-Ger\xE4te suchen",
  "midi.unit.main": "Hauptpult",
  "midi.unit.ext": "Erweiterung {n}",
  "midi.none": "\u2013 keins \u2013",
  "midi.mixer": "Audiomischer",
  "midi.mixer.none": "\u2013 Node w\xE4hlen \u2013",
  "midi.masterAux": "Master-Fader f\xFChrt Aux-Bus (ID, leer = keiner)",
  "midi.start": "Starten",
  "midi.stop": "Beenden",
  "midi.sim": "Simulator starten (Pult + Erweiterung)",
  "midi.status.running": "L\xE4uft",
  "midi.status.stopped": "Nicht gestartet",
  "midi.unit.state": "{name}: {state}",
  "midi.unit.online": "meldet sich",
  "midi.unit.silent": "noch still",
  "midi.bank": "Bank {n}",
  "midi.err.no-webmidi": "Dieser Browser unterst\xFCtzt Web MIDI nicht (Chrome oder Edge am Desktop verwenden).",
  "midi.err.insecure-context": "Web MIDI braucht HTTPS oder localhost.",
  "midi.err.denied": "Zugriff auf MIDI wurde nicht erlaubt (SysEx-Erlaubnis n\xF6tig).",
  "midi.err.no-port": "Kein MIDI-Ger\xE4t gew\xE4hlt.",
  "midi.err.no-profile": "Kein g\xFCltiges Profil.",
  "midi.err.imap": "Dieser Anschluss geh\xF6rt der Programmier-Software iMAP des Pults (Anschluss 4) \u2014 einen der Anschl\xFCsse \u201EDAW 1\u20133\u201C w\xE4hlen.",
  "midi.err.no-mixer": "Bitte einen Audiomischer w\xE4hlen.",
  "midi.profile.label": "Profil (JSON)",
  "midi.profile.check": "Pr\xFCfen",
  "midi.profile.ok": "Profil in Ordnung ({n} Regler).",
  "midi.profile.example": "Beispiel einf\xFCgen",
  "midi.learn": "Lernen",
  "midi.learn.wait": "Bewege einen Regler oder dr\xFCcke eine Taste am Ger\xE4t \u2026",
  "midi.learn.got": "{type} {num}, Kanal {ch}, Wert {v}",
  "midi.last": "Zuletzt erkannt",
  "midi.sim.title": "Simulator",
  "midi.sim.touch": "Fader ber\xFChren und ziehen",
  "midi.keys.label": "Tasten, Funktionsfeld und Jog (JSON, leer = Standardbelegung)",
  "midi.keys.check": "Tasten pr\xFCfen",
  "midi.keys.example": "Beispiel einf\xFCgen",
  "midi.keys.ok": "Tastenbelegung in Ordnung.",
  "midi.keys.hint": "Standard: F1\u2013F8 wirken auf den gew\xE4hlten Kanal (Mute, PFL, Phase, EQ-Bypass, Comp, Gate, Main, Alle Mute aus), Pfeile w\xE4hlen Kanal / \xB11 dB, \u201ESolo\u201C l\xF6scht das Vorh\xF6ren, Scrub schaltet das Jog-Rad um, die acht Ansichtstasten w\xE4hlen Seiten. Alles andere (Play, Stop \u2026) meldet das Gateway als Ereignis.",
  "midi.sim.keys": "Funktionstasten, Seiten, Jog",
  "perm.title": "Rechte",
  "perm.feat.title": "Funktionsrechte",
  "perm.feat.hint": "Einzelne Funktionen der Module (z. B. Aufnahmen anlegen, Dateien pr\xFCfen). Wirken sofort; wer \u201EKonfigurieren\u201C auf allem hat, darf ohnehin alles.",
  "perm.feat.none": "Keine Funktionsrechte vorhanden (kein Modul mit Funktionsrechten aktiv).",
  "perm.feat.all": "Alle Rechte des Moduls",
  "perm.feat.viaAll": "\xFCber \u201EAlle Rechte des Moduls\u201C",
  "perm.feat.viaGroup": "geerbt von Gruppe {p0}",
  "perm.feat.viaAdmin": "Administrator darf alles",
  "perm.hint": "Ein Recht je Nutzer/Gruppe und Bereich. \xC4nderungen gelten sofort. Suche findet Namen, Nodes, Workflows, Rollen und Prozesse.",
  "perm.search.ph": "Suchen: Nutzer, Gruppe, Node, Workflow, Prozess \u2026",
  "perm.mode.subject": "Wer? (Nutzer/Gruppen)",
  "perm.mode.resource": "Worauf? (Bereiche)",
  "perm.users": "Nutzer",
  "perm.groups": "Gruppen",
  "perm.admin.tag": "Admin",
  "perm.kind.all": "Alle",
  "perm.kind.global": "Global",
  "perm.kind.workflow": "Workflow",
  "perm.kind.role": "Workflow-Rolle",
  "perm.kind.node": "Node",
  "perm.kind.process": "Prozess",
  "perm.kind.user": "Nutzer",
  "perm.kind.group": "Gruppe",
  "perm.scope.global": "Alles (global)",
  "perm.scope.whole": "ganzer Workflow",
  "perm.verb.view": "Ansehen",
  "perm.verb.operate": "Bedienen",
  "perm.verb.configure": "Konfigurieren",
  "perm.verb.admin": "Administrieren",
  "perm.verbdesc.view": "darf nur zusehen",
  "perm.verbdesc.operate": "darf schalten und Werte \xE4ndern",
  "perm.verbdesc.configure": "darf zus\xE4tzlich Aufbau und Einstellungen \xE4ndern",
  "perm.verbdesc.admin": "voller Zugriff inklusive Rechtevergabe",
  "perm.legend": "Die Rechte bauen aufeinander auf: Administrieren schlie\xDFt Konfigurieren, Bedienen und Ansehen ein.",
  "perm.empty.pick": "Links einen Eintrag w\xE4hlen.",
  "perm.none": "Noch keine Rechte vergeben.",
  "perm.none.resource": "Noch niemand hat Rechte auf diesen Bereich.",
  "perm.noMatch": "Keine Treffer.",
  "perm.count": "{p0} Rechte",
  "perm.members": "{p0} Mitglieder",
  "perm.members.list": "Mitglieder: {p0}",
  "perm.members.none": "Keine Mitglieder",
  "perm.memberOf": "Mitglied in: {p0}",
  "perm.admin.note": "Administrator \u2013 hat automatisch Vollzugriff.",
  "perm.inherited": "Geerbt \xFCber Gruppe {p0}",
  "perm.openGroup": "Zur Gruppe",
  "perm.missing": "existiert nicht mehr",
  "perm.add.title": "Recht hinzuf\xFCgen",
  "perm.add.pickScope": "Bereich suchen (Node, Workflow, Prozess \u2026)",
  "perm.add.pickSubject": "Nutzer oder Gruppe suchen \u2026",
  "perm.add.btn": "Hinzuf\xFCgen",
  "perm.more": "\u2026 {p0} weitere, weiter tippen",
  "perm.remove": "Entfernen",
  "perm.removeConfirm": "Recht \u201E{p2}\u201C von {p0} auf {p1} entfernen?",
  "perm.error": "Speichern fehlgeschlagen: {p0}",
  "aud.a.login": "Anmeldung",
  "aud.a.userCreate": "Nutzer angelegt",
  "aud.a.userDelete": "Nutzer {p0} gel\xF6scht",
  "aud.a.userPw": "Passwort von {p0} zur\xFCckgesetzt",
  "aud.a.userOrg": "Organisation von {p0} ge\xE4ndert",
  "aud.a.userRevoke": "Sitzungen von {p0} beendet",
  "aud.a.orgCreate": "Organisation angelegt",
  "aud.a.orgDelete": "Organisation {p0} gel\xF6scht",
  "aud.a.bindCreate": "Recht vergeben",
  "aud.a.bindDelete": "Recht entfernt",
  "aud.a.groupCreate": "Gruppe angelegt",
  "aud.a.groupUpdate": "Gruppe {p0} ge\xE4ndert",
  "aud.a.groupDelete": "Gruppe {p0} gel\xF6scht",
  "aud.a.groupAdd": "Mitglied zu Gruppe {p0} hinzugef\xFCgt",
  "aud.a.groupRemove": "{p1} aus Gruppe {p0} entfernt",
  "aud.a.wfCreate": "Workflow angelegt",
  "aud.a.wfImport": "Workflow importiert",
  "aud.a.wfSave": "Workflow {p0} gespeichert",
  "aud.a.wfDelete": "Workflow {p0} gel\xF6scht",
  "aud.a.wfStart": "Workflow {p0} gestartet",
  "aud.a.wfStop": "Workflow {p0} gestoppt",
  "aud.a.wfPause": "Workflow {p0} pausiert",
  "aud.a.wfRoleRestart": "Rolle {p1} in {p0} neu gestartet",
  "aud.a.wfRoleMigrate": "Rolle {p1} in {p0} auf anderen Host umgezogen",
  "aud.a.migConfirm": "Umzug von Rolle {p1} in {p0} best\xE4tigt",
  "aud.a.migCancel": "Umzug von Rolle {p1} in {p0} abgebrochen",
  "aud.a.instStart": "Instanz gestartet",
  "aud.a.instStop": "Instanz {p0} beendet",
  "aud.a.instEdit": "Instanz {p0} ge\xE4ndert",
  "aud.a.instRestart": "Instanz {p0} neu gestartet",
  "aud.a.instMigrate": "Instanz {p0} auf anderen Host umgezogen",
  "aud.a.instToken": "Dienst-Token f\xFCr {p0} ausgestellt",
  "aud.a.hostDelete": "Host {p0} entfernt",
  "aud.a.hostMaint": "Host {p0} in Wartung versetzt",
  "aud.a.hostMaintEnd": "Wartung von Host {p0} beendet",
  "aud.a.hostToken": "Host-Beitrittscode erzeugt",
  "aud.a.hostRegister": "Host registriert",
  "aud.a.clusterJoin": "Cluster-Beitritt",
  "aud.a.clusterLeave": "Cluster-Mitglied {p0} entfernt",
  "aud.a.catImport": "Node-Typ importiert",
  "aud.a.catDelete": "Node-Typ {p0} entfernt",
  "aud.a.edgeCreate": "Verbindung hergestellt",
  "aud.a.edgeDelete": "Verbindung getrennt",
  "aud.a.layoutSave": "Layout {p0} gespeichert",
  "aud.a.snapSave": "Szene gespeichert",
  "aud.a.snapApply": "Szene angewendet",
  "aud.a.srcTags": "Quellen-Tags ge\xE4ndert",
  "aud.a.sinkTags": "Ziel-Tags ge\xE4ndert",
  "aud.a.nodeLayoutSave": "Layout auf {p0} gespeichert",
  "aud.a.nodeLayoutApply": "Layout {p1} auf {p0} angewendet",
  "aud.a.nodeLayoutDelete": "Layout {p1} von {p0} gel\xF6scht",
  "aud.a.inviteCreate": "Einladung f\xFCr {p0} erstellt",
  "aud.a.inviteDelete": "Einladung f\xFCr {p0} zur\xFCckgezogen",
  "aud.a.nodeParam": "{p0}: Parameter \u201E{p1}\u201C ge\xE4ndert",
  "aud.a.nodeState": "{p0}: Zustand gesetzt",
  "aud.a.nodePlugin": "{p0}: Plugin \u201E{p1}\u201C ge\xE4ndert",
  "aud.a.nodeMethod": "{p0}: {p1}",
  "aud.a.procCreate": "Prozess angelegt",
  "aud.a.procSave": "Prozess {p0} ge\xE4ndert",
  "aud.a.procDelete": "Prozess {p0} gel\xF6scht",
  "aud.a.procVersion": "Neue Version von Prozess {p0}",
  "aud.a.procPublish": "Prozessversion ver\xF6ffentlicht",
  "aud.a.procDeprecate": "Prozessversion als veraltet markiert",
  "aud.a.procArchive": "Prozessversion archiviert",
  "aud.a.procStart": "Prozess gestartet",
  "aud.a.procCancel": "Prozessausf\xFChrung abgebrochen",
  "aud.a.procPause": "Prozessausf\xFChrung pausiert",
  "aud.a.procResume": "Prozessausf\xFChrung fortgesetzt",
  "aud.a.taskAssign": "Aufgabe zugewiesen",
  "aud.a.taskDone": "Aufgabe erledigt",
  "aud.a.chCreate": "Playout-Kanal angelegt",
  "aud.a.chDelete": "Playout-Kanal gel\xF6scht",
  "aud.a.assetCreate": "Asset angelegt",
  "aud.a.assetMeta": "Asset-Metadaten ge\xE4ndert",
  "aud.a.assetStatus": "Asset-Status ge\xE4ndert",
  "aud.a.storeCreate": "Speicher-Backend angelegt",
  "aud.a.storeEdit": "Speicher-Backend ge\xE4ndert",
  "aud.a.storeDelete": "Speicher-Backend gel\xF6scht",
  "aud.a.locCreate": "Speicherort angelegt",
  "aud.a.locEdit": "Speicherort ge\xE4ndert",
  "aud.a.locDelete": "Speicherort gel\xF6scht",
  "aud.a.backup": "Sicherung erstellt",
  "aud.a.restore": "Sicherung wiederhergestellt",
  "aud.a.updUpload": "Update-Paket hochgeladen",
  "aud.a.updApply": "Update angewendet",
  "aud.a.updDist": "Update an Hosts verteilt",
  "aud.a.updRestart": "Veraltete Instanzen neu gestartet",
  "aud.a.updDelete": "Update-Paket gel\xF6scht",
  "aud.a.setSys": "Systemeinstellung {p0} ge\xE4ndert",
  "aud.a.setNode": "Einstellung {p1} f\xFCr {p0} ge\xE4ndert",
  "aud.a.verRollout": "Node-Version {p0} ausgerollt",
  "aud.a.verProd": "Node-Version {p0} als produktiv markiert",
  "aud.a.alarmAck": "Alarm quittiert",
  "aud.a.alarmUnack": "Alarm-Quittierung aufgehoben",
  "aud.m.crosspoint.take": "Take",
  "aud.m.crosspoint.cut": "Cut",
  "aud.m.crosspoint.autoTrans": "Auto-\xDCbergang",
  "aud.m.crosspoint.select": "Quelle vorgew\xE4hlt",
  "aud.m.crosspoint.setTransitionPosition": "\xDCberblend-Fader bewegt",
  "aud.m.crosspoint.setTransType": "\xDCbergangsart ge\xE4ndert",
  "aud.m.crosspoint.setTransRate": "\xDCbergangsdauer ge\xE4ndert",
  "aud.m.crosspoint.pin": "Quelle angeheftet",
  "aud.m.take": "Take",
  "aud.m.select": "Quelle gew\xE4hlt",
  "aud.m.selectSource": "Quelle gew\xE4hlt",
  "aud.m.load": "Clip geladen",
  "aud.m.cue": "Clip eingestellt",
  "aud.m.play": "Abspielen",
  "aud.m.playAt": "Abspielen zu Zeitpunkt",
  "aud.m.stop": "Stopp",
  "aud.m.seek": "Suchen",
  "aud.m.append": "Eintrag angeh\xE4ngt",
  "aud.m.updateItem": "Eintrag ge\xE4ndert",
  "aud.m.show": "Einblenden",
  "aud.m.hide": "Ausblenden",
  "aud.m.addChannel": "Kanal hinzugef\xFCgt",
  "aud.m.addAux": "Aux-Bus hinzugef\xFCgt",
  "aud.m.record.start": "Aufnahme gestartet",
  "aud.m.record.stop": "Aufnahme gestoppt",
  "aud.m.keyer.setEnabled": "Keyer umgeschaltet",
  "aud.m.pip.setEnabled": "PiP umgeschaltet",
  "aud.m.pip.applyPreset": "PiP-Preset angewendet",
  "aud.m.pip.toggleFocus": "PiP-Fokus umgeschaltet",
  "aud.m.pip.focus": "PiP in den Fokus gefahren",
  "aud.m.pip.unfocus": "PiP-Fokus beendet",
  "aud.m.pip.clickAt": "PiP im PGM-Bild angeklickt",
  "aud.m.setRouting": "Routing ge\xE4ndert",
  "aud.m.setVideoContext": "Video-Kontext gesetzt",
  "aud.m.setSourceContext": "Quell-Kontext gesetzt",
  "aud.m.clearSourceContext": "Quell-Kontext gel\xF6scht",
  "aud.m.setChildren": "Unterelemente gesetzt",
  "aud.m.setOffered": "Angebot gesetzt",
  "aud.m.setTransition": "\xDCbergang gesetzt",
  "aud.cw.setGain": "Pegel",
  "aud.cw.setPan": "Panorama",
  "aud.cw.setMute": "Mute",
  "aud.cw.setEqGain": "EQ-Gain",
  "aud.cw.setEqBand": "EQ-Band",
  "aud.cw.setSource": "Quelle",
  "aud.cw.setFollow": "Audio folgt Video",
  "aud.cw.setPfl": "PFL",
  "aud.cw.setSend": "Send",
  "aud.cat.login": "Anmeldungen",
  "aud.cat.users": "Nutzer",
  "aud.cat.rights": "Rechte & Gruppen",
  "aud.cat.workflows": "Workflows",
  "aud.cat.instances": "Instanzen & Hosts",
  "aud.cat.graph": "Verbindungen & Layouts",
  "aud.cat.layout": "Ansichts-Layout (automatisch)",
  "aud.cat.operate": "Bedienung (Schalten, Fader)",
  "aud.cat.processes": "Prozesse",
  "aud.cat.media": "Medien & Speicher",
  "aud.cat.system": "System",
  "aud.title": "Audit-Log",
  "aud.hint": "Wer hat wann was ge\xE4ndert? Reine Abfragen werden nicht protokolliert. \u201EBedienung\u201C (Schalten, Fader) und das automatische Ansichts-Layout sind standardm\xE4\xDFig ausgeblendet.",
  "aud.search.ph": "Suchen: Nutzer, Node, Workflow, Prozess \u2026",
  "aud.user.all": "Alle Nutzer",
  "aud.res.all": "Alle Ergebnisse",
  "aud.res.onlyOk": "Nur erfolgreiche",
  "aud.res.onlyFailed": "Nur Fehlschl\xE4ge",
  "aud.range.1h": "Letzte Stunde",
  "aud.range.24h": "24 Stunden",
  "aud.range.7d": "7 Tage",
  "aud.range.30d": "30 Tage",
  "aud.range.all": "Alles",
  "aud.cats": "Bereiche",
  "aud.cats.all": "Alle",
  "aud.cats.default": "Standard",
  "aud.count": "{p0} Eintr\xE4ge geladen",
  "aud.empty": "Keine Eintr\xE4ge f\xFCr diese Filter.",
  "aud.more": "\xC4ltere laden",
  "aud.loading": "Lade \u2026",
  "aud.csv": "Als CSV exportieren",
  "aud.today": "Heute",
  "aud.yesterday": "Gestern",
  "aud.by": "von {p0}",
  "aud.generic": "\xC4nderung: {p0}",
  "aud.details": "Technische Details",
  "aud.res.ok": "erledigt",
  "aud.res.400": "ung\xFCltige Eingabe",
  "aud.res.401": "nicht angemeldet / falsche Zugangsdaten",
  "aud.res.403": "keine Berechtigung",
  "aud.res.404": "nicht gefunden",
  "aud.res.409": "Konflikt (Zustand passte nicht)",
  "aud.res.422": "Eingabe abgelehnt",
  "aud.res.429": "zu viele Anfragen",
  "aud.res.5xx": "Serverfehler",
  "aud.res.other": "fehlgeschlagen",
  "aud.reset": "Filter zur\xFCcksetzen",
  "sup.tab.check": "Selbsttest",
  "sup.tab.baseline": "Baseline & Trends",
  "sup.tab.bundle": "Support-Paket",
  "sup.tab.freeze": "Momentaufnahmen",
  "sup.tab.analysis": "Auswertung",
  "sup.tab.access": "Support-Zugang",
  "sup.title": "Support",
  "sup.hint": "Hier sehen Sie auf einen Blick, ob das System gesund ist, und k\xF6nnen alle Informationen f\xFCr den Support in einer Datei zusammenstellen.",
  "sup.recheck": "Jetzt pr\xFCfen",
  "sup.loadFailed": "Der Selbsttest konnte nicht geladen werden",
  "sup.checkedAt": "Gepr\xFCft um {time} \u2014 aktualisiert sich alle 30 Sekunden",
  "sup.whatToDo": "Was tun?",
  "sup.fine": "{n} Pr\xFCfungen in Ordnung",
  "sup.bundle.title": "Support-Paket erstellen",
  "sup.bundle.text": "Erzeugt eine ZIP-Datei mit Zustand, Meldungen und Systemdaten dieses Systems. Sie enth\xE4lt keine Medien, keine Passw\xF6rter, Tokens oder Schl\xFCssel und kein Audit-Log. Bitte die Datei unver\xE4ndert an den Support senden.",
  "sup.bundle.window": "Meldungen der letzten",
  "sup.bundle.create": "Support-Paket erstellen",
  "sup.bundle.working": "Das Paket wird zusammengestellt \u2026 (bis zu einer Minute)",
  "sup.bundle.done": "Fertig: {name} ({size} KB) wurde heruntergeladen.",
  "sup.bundle.failed": "Das Paket konnte nicht erstellt werden: {error}",
  "sup.window.30": "30 Minuten",
  "sup.window.120": "2 Stunden",
  "sup.window.1440": "24 Stunden",
  "admin.tab.clients": "Verbundene Clients",
  "clients.title": "Verbundene Clients",
  "clients.summary": "{total} Verbindung(en), {users} angemeldete(r) Benutzer",
  "clients.none": "Keine identifizierten Clients verbunden.",
  "clients.error": "Clients konnten nicht geladen werden.",
  "clients.col.user": "Benutzer",
  "clients.col.ip": "Adresse",
  "clients.col.since": "Verbunden seit",
  "clients.col.agent": "Browser",
  "clients.col.actions": "Aktion",
  "clients.disconnect": "Trennen",
  "clients.disconnect.hint": "Schlie\xDFt nur diese Verbindung; der Browser verbindet sich nach wenigen Sekunden von selbst wieder.",
  "clients.disconnect.confirm": "Verbindung von {user} ({ip}) trennen? Der Browser baut sie nach wenigen Sekunden selbst wieder auf.",
  "clients.disconnect.done": "Verbindung getrennt.",
  "clients.endSessions": "Abmelden",
  "clients.endSessions.hint": "Beendet alle Anmeldungen dieses Benutzers; er muss sich neu anmelden.",
  "clients.endSessions.confirm": "Alle Anmeldungen von {user} beenden? Der Benutzer wird auf allen Ger\xE4ten abgemeldet und muss sich neu anmelden.",
  "clients.endSessions.done": "Benutzer abgemeldet.",
  "clients.error.action": "Aktion fehlgeschlagen.",
  "aud.a.clientKick": "Client getrennt",
  "clients.search": "Suchen: Benutzer, Adresse, Browser, Ger\xE4t (z. B. midi, streamdeck, simulator)",
  "clients.summary.filtered": " \u2014 {n} angezeigt",
  "clients.noMatch": "Kein Client passt zur Suche.",
  "clients.col.devices": "Ger\xE4te",
  "clients.dev.midi": "MIDI",
  "clients.dev.deck": "Stream Deck",
  "clients.dev.sim": "Simulator",
  "admin.tab.support": "Support",
  "tl.title": "Zeitleiste",
  "tl.hint": "Was hat sich um 14:02 ge\xE4ndert? Alles Wichtige auf einer Achse: St\xF6rungen, Neustarts, Bedienungen, \xC4nderungen und Marker. In den Balken klicken oder den Regler ziehen zeigt, was zu diesem Zeitpunkt gest\xF6rt war.",
  "tl.window": "Zeitraum",
  "tl.window.1h": "letzte Stunde",
  "tl.window.6h": "letzte 6 Stunden",
  "tl.window.24h": "letzte 24 Stunden",
  "tl.window.7d": "letzte 7 Tage",
  "tl.cat.fault": "St\xF6rungen",
  "tl.cat.marker": "Marker",
  "tl.cat.change": "\xC4nderungen",
  "tl.cat.ops": "Betrieb",
  "tl.cat.log": "Fehler-Logs",
  "tl.operate": "Bedienung (Regler, Schnitte) anzeigen",
  "tl.loading": "Wird geladen \u2026",
  "tl.loadFailed": "Die Zeitleiste konnte nicht geladen werden: {error}",
  "tl.empty": "Im gew\xE4hlten Zeitraum ist nichts aufgezeichnet.",
  "tl.truncated": "Nur die neuesten {n} Zeilen werden angezeigt \u2014 Zeitraum verkleinern f\xFCr mehr Details.",
  "tl.slider": "Zeitpunkt w\xE4hlen",
  "tl.pick": "Zeitpunkt w\xE4hlen: in den Balken klicken oder den Regler ziehen",
  "tl.now": "jetzt",
  "tl.stateAt": "Zustand um {time}",
  "tl.backToNow": "Zur\xFCck zu jetzt",
  "tl.problems.title": "Zu diesem Zeitpunkt gest\xF6rt",
  "tl.problems.none": "Es war nichts Auff\xE4lliges aufgezeichnet.",
  "tl.problems.since": "seit {time}",
  "tl.changes.title": "Das hat sich in den {min} Minuten davor ge\xE4ndert",
  "tl.changes.none": "Davor wurde nichts aufgezeichnet.",
  "tl.limit": "Angezeigt wird, was aufgezeichnet wurde: Abst\xFCrze, Neustarts, Medien- und Host-Ausf\xE4lle, Uhr, Workflows, Bedienungen, Marker. Der Zustand vor dem letzten Neustart des Orchestrators ist nicht bekannt.",
  "note.marker": "Was ist passiert? Eine kurze Notiz hilft dem Support sp\xE4ter (optional, h\xF6chstens 200 Zeichen).",
  "note.markerOk": "Marker setzen",
  "note.freeze": "Warum wird eingefroren? Was ist passiert? (optional, h\xF6chstens 200 Zeichen)",
  "note.freezeOk": "Einfrieren",
  "app.close": "Schlie\xDFen",
  "app.menu.devices": "Ger\xE4te",
  "app.menu.devices.title": "Stream Deck und MIDI-Pulte",
  "app.menu.support": "Support",
  "app.menu.support.title": "Marker setzen und Einfrieren",
  "tl.mark": "\u2691 Marker",
  "tl.mark.title": "Problem jetzt markieren: setzt einen Marker auf die Zeitleiste, damit der Support diese Minute findet",
  "tl.marked": "Marker gesetzt um {time}",
  "tl.markFailed": "Marker konnte nicht gesetzt werden: {error}",
  "tl.k.instance.crashed": "{label} ist abgest\xFCrzt \u2014 {message}",
  "tl.k.instance.restarted": "{label} wurde automatisch neu gestartet",
  "tl.k.node.notready": "{label} liefert kein Bild und keinen Ton mehr",
  "tl.k.node.ready": "{label} liefert wieder Bild und Ton",
  "tl.k.host.silent": "Host {label} meldet sich nicht mehr",
  "tl.k.host.resumed": "Host {label} meldet sich wieder",
  "tl.k.host.clock.lost": "Die Uhr von {label} ist nicht mehr synchron",
  "tl.k.host.clock.ok": "Die Uhr von {label} ist wieder synchron",
  "tl.k.workflow.failover": "Ausfallumschaltung im Workflow {workflow} ({trigger})",
  "tl.k.workflow.status.running": "Workflow {name} l\xE4uft",
  "tl.k.workflow.status.stopped": "Workflow {name} wurde gestoppt",
  "tl.k.workflow.status.failed": "Workflow {name} ist fehlgeschlagen: {error}",
  "tl.k.workflow.status.other": "Workflow {name}: {status}",
  "tl.k.workflow.migration": "Umzug im Workflow {workflow}: {status}",
  "tl.k.host.registered": "Host {label} hat sich angemeldet",
  "tl.k.host.removed": "Host {id} wurde entfernt",
  "tl.k.host.maintenance": "Wartungsmodus von Host {id} ge\xE4ndert",
  "tl.k.edge.added": "Verbindung hergestellt ({id})",
  "tl.k.edge.removed": "Verbindung getrennt ({id})",
  "tl.k.marker": "{actor} hat \u201EProblem jetzt\u201C markiert",
  "tl.k.marker.note": "{actor} hat markiert: {note}",
  "tl.k.orchestrator.started": "Orchestrator gestartet (Version {version})",
  "tl.k.domain": "{type} {id}: {action}",
  "tl.k.other": "Ereignis {kind}",
  "admin.tab.timeline": "Zeitleiste",
  "nd.button": "Diagnose: Was ist mit diesem Node los?",
  "nd.title": "Diagnose: {node}",
  "nd.loading": "Wird geladen \u2026",
  "nd.refresh": "Aktualisieren",
  "nd.close": "Schlie\xDFen",
  "nd.failed": "Die Diagnose konnte nicht geladen werden: {error}",
  "nd.localHost": "l\xE4uft auf diesem Rechner",
  "nd.remoteHost": "l\xE4uft auf einem Host",
  "nd.findings": "Befunde",
  "nd.findings.none": "Keine Probleme gefunden.",
  "nd.fine": "{n} Pr\xFCfungen in Ordnung",
  "nd.whatToDo": "Was tun?",
  "nd.facts": "Prozess und Medien",
  "nd.f.restarts": "Automatische Neustarts",
  "nd.f.cpu": "Prozessor",
  "nd.f.ram": "Arbeitsspeicher",
  "nd.f.threads": "Threads",
  "nd.f.files": "Offene Dateien",
  "nd.f.media": "Bild und Ton",
  "nd.f.ready": "liefert",
  "nd.f.notReady": "liefert nicht",
  "nd.f.fps": "Bilder pro Sekunde",
  "nd.pipeline": "Pipeline",
  "nd.pipeline.hint": "Von der Quelle (links) zum Ausgang (rechts). Rot umrandet: Baustein im falschen Zustand. Gelb: Puffer voll \u2014 der Baustein dahinter nimmt zu langsam ab. Ein Balken zeigt den F\xFCllstand.",
  "flow.workflowBand": "Workflows",
  "flow.alarm.crashed": "Abgest\xFCrzt",
  "flow.alarm.restarts": "Wurde {n}\xD7 neu gestartet",
  "flow.alarm.offline": "Nicht erreichbar",
  "nd.pipeline.empty": "Die Pipeline enth\xE4lt noch keine Bausteine.",
  "nd.pipeline.inside": "{n} Elemente",
  "nd.pipeline.fill": "Puffer zu {p} % gef\xFCllt",
  "nd.pipeline.note.unsupported": "Dieser Node-Typ meldet seine Pipeline nicht (nur Nodes mit GStreamer-Pipeline und neuer Version).",
  "nd.pipeline.note.offline": "Der Node meldet sich nicht \u2014 seine Pipeline ist nicht abrufbar.",
  "nd.pipeline.note.none": "Der Node hat noch keine Pipeline angemeldet.",
  "nd.pipeline.note.unavailable": "Die Pipeline konnte nicht abgerufen werden.",
  "nd.events": "Ereignisse der letzten 24 Stunden",
  "nd.events.none": "Keine aufgezeichnet.",
  "nd.logs": "Meldungen (Fehler und Warnungen, letzte 24 Stunden)",
  "nd.logs.none": "Keine Meldungen.",
  "nd.footer": "Aktualisiert sich alle 8 Sekunden. F\xFCr den Support: Administration \u2192 Support \u2192 Support-Paket erstellen.",
  "ec.badge": "Fehlercode",
  "ec.cause": "Ursache:",
  "ec.steps": "Was tun?",
  "ec.doc": "Beschreibung im Handbuch: {path} (Abschnitt {code})",
  "ec.more": "Ursache und L\xF6sungsschritte",
  "sup.access.title": "Support-Zugang f\xFCr externe Hilfe",
  "sup.access.text": "Erzeugt einen Link, mit dem der Support das System f\xFCr begrenzte Zeit ansehen kann \u2014 nur lesen, ohne Konto und ohne dass Sie Passw\xF6rter weitergeben. Der Link gilt bis zum Ablauf oder bis Sie ihn widerrufen; alles, was der Support tut, steht im Audit-Log.",
  "sup.access.duration": "G\xFCltig f\xFCr",
  "sup.access.note": "Notiz (z. B. Ticket-Nummer)",
  "sup.access.create": "Support-Zugang erzeugen",
  "sup.access.d.60": "1 Stunde",
  "sup.access.d.240": "4 Stunden",
  "sup.access.d.1440": "24 Stunden",
  "sup.access.d.4320": "3 Tage",
  "sup.access.created": "Zugang erzeugt. Diesen Link jetzt an den Support senden \u2014 er wird nur jetzt angezeigt:",
  "sup.access.copy": "Link kopieren",
  "sup.access.copied": "Link kopiert",
  "sup.access.expires": "g\xFCltig bis {time}",
  "sup.access.failed": "Der Zugang konnte nicht erzeugt werden: {error}",
  "sup.access.list": "Bisherige Zug\xE4nge",
  "sup.access.none": "Noch kein Support-Zugang erzeugt.",
  "sup.access.status.active": "aktiv",
  "sup.access.status.expired": "abgelaufen",
  "sup.access.status.revoked": "widerrufen",
  "sup.access.used": "{n}\xD7 angemeldet, zuletzt {time}",
  "sup.access.unused": "noch nie benutzt",
  "sup.access.revoke": "Widerrufen",
  "sup.access.revokeConfirm": "Diesen Support-Zugang jetzt beenden? Der Support verliert den Zugriff sofort.",
  "sup.access.revokeLabel": "Widerrufen",
  "sup.access.by": "von {user}",
  "sup.access.banner": "Support-Zugang \u2014 nur lesen, g\xFCltig bis {until} (noch {min} Min.)",
  "sup.access.linkFailed": "Support-Link ung\xFCltig",
  "fr.button": "\u2744 Einfrieren",
  "fr.button.title": "Die letzten Minuten einfrieren: speichert Zeitleiste, Meldungen, Messreihen und Pipeline-Zustand als Paket f\xFCr den Support",
  "fr.done": "Eingefroren: die letzten {min} Minuten sind gespeichert",
  "fr.failed": "Einfrieren fehlgeschlagen: {error}",
  "fr.card.title": "Eingefrorene Momentaufnahmen (\u201EFlugschreiber\u201C)",
  "fr.card.text": "H\xE4lt die letzten Minuten fest, bevor sie \xFCberschrieben werden: Ereignisse und Meldungen, Kennzahlen je Node (Bildrate, Medien bereit), CPU und Speicher je Prozess und der Pipeline-Zustand. Das passiert auf Knopfdruck (\u2744 oben) und automatisch, wenn etwas ausf\xE4llt \u2014 Absturz, Medien weg, Host verstummt, Ausfallumschaltung (h\xF6chstens alle 5 Minuten). Aufbewahrt werden 30 Tage.",
  "fr.now": "Jetzt die letzten 10 Minuten einfrieren",
  "fr.note": "Notiz (optional)",
  "fr.none": "Noch nichts eingefroren.",
  "fr.trigger.manual": "von Hand",
  "fr.trigger.auto": "automatisch",
  "fr.window": "{min} min",
  "fr.download": "Herunterladen",
  "fr.delete": "L\xF6schen",
  "fr.deleteConfirm": "Diese Momentaufnahme l\xF6schen?",
  "fr.deleteLabel": "L\xF6schen",
  "fr.node": "\u2744 Einfrieren",
  "fr.node.title": "Die letzten Minuten dieses Nodes einfrieren (Pipeline-Zustand und Messreihen)",
  "tl.k.freeze": "{actor} hat die letzten {minutes} Minuten eingefroren",
  "tl.k.freeze.note": "{actor} hat die letzten {minutes} Minuten eingefroren: {note}",
  "tl.k.freeze.auto": "Automatisch eingefroren ({reason})",
  "tr.title": "Baseline und Trends",
  "tr.none": "Noch keine Verl\xE4ufe aufgezeichnet \u2014 die Auswertung beginnt nach einigen Minuten.",
  "tr.building": "Der Verlauf ist {days} Tage lang ({n} Reihen gepr\xFCft). F\xFCr \u201Eungew\xF6hnlich f\xFCr diese Tageszeit\u201C braucht das System mindestens 3 Tage Verlauf; stetiges Wachstum (Lecks) erkennt es schon nach 8 Stunden.",
  "tr.ready": "Das System vergleicht mit dem \xDCblichen: {n} Verl\xE4ufe werden gepr\xFCft, der l\xE4ngste ist {days} Tage lang. Nichts Auff\xE4lliges, solange hier nichts steht.",
  "tr.clean": "Aktuell weicht nichts vom \xDCblichen ab und nichts w\xE4chst stetig.",
  "tr.chart.drift": "Verlauf der letzten Stunden \u2014 gestrichelt: Wert zu Beginn des Anstiegs",
  "tr.chart.deviation": "Verlauf \u2014 gestrichelt: das \xDCbliche zu dieser Tageszeit",
  "tr.m.host.cpu": "Prozessorlast",
  "tr.m.host.mem": "Arbeitsspeicher",
  "tr.m.host.net": "Netzwerklast",
  "tr.m.proc.rss": "Speicher",
  "tr.m.proc.cpu": "Prozessorlast",
  "tr.m.proc.fds": "offene Dateien",
  "tr.m.proc.threads": "Threads",
  "tr.m.orch.heap": "Speicher des Orchestrators",
  "tr.m.orch.goroutines": "Goroutinen des Orchestrators",
  "tr.m.orch.fds": "offene Dateien des Orchestrators",
  "tl.k.trend.drift": "{label}: {metric} w\xE4chst stetig (jetzt {value})",
  "tl.k.trend.deviation": "{label}: {metric} ungew\xF6hnlich hoch (jetzt {value}, \xFCblich {baseline})",
  "dg.title": "Diagnose",
  "dg.hint": "Was l\xE4uft schief, und wo? \u201EProbleme\u201C fasst gleichartige Meldungen zusammen, \u201EMeldungen\u201C zeigt jede einzelne Zeile. Meldungen stammen aus dem Orchestrator und werden 24 Stunden bis einige Tage aufbewahrt.",
  "dg.view.groups": "Probleme",
  "dg.view.rows": "Meldungen",
  "dg.search.ph": "Suchen im Meldungstext \u2026",
  "dg.node.all": "Alle Nodes",
  "dg.node.gone": "nicht mehr vorhanden",
  "dg.range.1h": "Letzte Stunde",
  "dg.range.24h": "24 Stunden",
  "dg.range.7d": "7 Tage",
  "dg.range.all": "Alles",
  "dg.levels": "Stufe",
  "dg.level.error": "Fehler",
  "dg.level.warn": "Warnungen",
  "dg.level.info": "Info",
  "dg.chip.trace": "Vorgang {p0}",
  "dg.chip.kind": "Meldungsart: {p0}",
  "dg.count.groups": "{p0} Problemarten \xB7 {p1} Meldungen",
  "dg.count.rows": "{p0} Meldungen geladen",
  "dg.loading": "Lade \u2026",
  "dg.empty": "Keine Meldungen f\xFCr diese Filter \u2013 das System meldet nichts Auff\xE4lliges.",
  "dg.last": "zuletzt {p0}",
  "dg.since": "erstmals {p0}",
  "dg.affects": "Betrifft: {p0}",
  "dg.showRows": "Einzelmeldungen anzeigen",
  "dg.showTrace": "Alle Schritte dieses Vorgangs",
  "dg.copy": "Kopieren",
  "dg.more": "\xC4ltere laden",
  "dg.source": "Quelle",
  "dg.host": "Host",
  "dg.ago.now": "gerade eben",
  "dg.ago.min": "vor {p0} Min.",
  "dg.ago.h": "vor {p0} Std.",
  "dg.ago.d": "vor {p0} Tagen",
  "dg.affects.gone": "{p0} inzwischen beendete Nodes",
  "dg.lv.error": "Fehler",
  "dg.lv.warn": "Warnung",
  "dg.lv.info": "Info",
  "pscl.pr.duration": "ffprobe: Dauer (Sekunden)",
  "pscl.pr.size": "ffprobe: Dateigr\xF6\xDFe (Bytes)",
  "pscl.pr.bitrate": "ffprobe: Gesamt-Bitrate (bit/s)",
  "pscl.pr.container": "ffprobe: Container-Format",
  "pscl.pr.timecode": "ffprobe: Start-Timecode (falls vorhanden)",
  "pscl.pr.vcodec": "ffprobe: Video-Codec (erster Videostream)",
  "pscl.pr.width": "ffprobe: Bildbreite (Pixel)",
  "pscl.pr.height": "ffprobe: Bildh\xF6he (Pixel)",
  "pscl.pr.fps": "ffprobe: Bildrate (z. B. 25/1)",
  "pscl.pr.fieldorder": "ffprobe: Halbbild-Reihenfolge (progressive/tt/bb)",
  "pscl.pr.pixfmt": "ffprobe: Pixelformat",
  "pscl.pr.vduration": "ffprobe: Videostream-Dauer (Sekunden)",
  "pscl.pr.vstart": "ffprobe: Videostream-Startzeit (Sekunden)",
  "pscl.pr.acodec": "ffprobe: Audio-Codec (erste Tonspur)",
  "pscl.pr.samplerate": "ffprobe: Abtastrate (Hz)",
  "pscl.pr.channels": "ffprobe: Kan\xE4le der ersten Tonspur",
  "pscl.pr.audiocount": "ffprobe: Anzahl Tonspuren",
  "pscl.pr.streamcount": "ffprobe: Anzahl Streams insgesamt",
  "psc.var.back": "\u21BA Wert w\xE4hlen",
  "psc.var.back.title": "Zur\xFCck zur Auswahl (die Variable wird verworfen)",
  "psc.var.active": "Variable \u2013 wird erst beim Ausf\xFChren eingesetzt",
  "psc.default": "\u2013 ffmpeg-Standard \u2013",
  "psc.yes": "ja",
  "psc.no": "nein",
  "psc.pair.remove": "Argument entfernen (Flag und Wert)",
  "psc.pair.flag": "Flag, z. B. -crf",
  "psc.pair.value": "Wert",
  "psc.pair.browse": "H\xE4ufige Flags \u2014 oder oben suchen (auch Encoder-, Format- und Filter-Optionen). Klick f\xFCgt Flag und passendes Wertfeld ein.",
  "psc.pair.nov": "ohne Wert",
  "psc.pair.sel": "Auswahl",
  "psc.pair.time": "Zeit",
  "psc.pair.num": "Zahl",
  "psc.pair.text": "Text",
  "psc.pair.add.hint": "\xD6ffnet die Auswahl aller Flags und Optionen \u2014 mit Beschreibung, Auswahlliste bzw. Wertebereich",
  "psc.pair.free": "Freitext-Argument",
  "psc.pair.free.hint": "Eine leere Zeile f\xFCr ein Argument, das in der Auswahl fehlt",
  "psc.sec.files": "Dateien",
  "psc.sec.clips": "Clips (Reihenfolge = Ergebnis)",
  "psc.sec.result": "Ergebnis",
  "psc.sec.encoding": "Kodierung",
  "psc.sec.events": "Ereignisse auf der Zeitachse",
  "psc.sec.settings": "Einstellungen",
  "psc.sec.command": "Befehl (Vorschau)",
  "psc.sec.more": "Weitere Einstellungen (Zeitlimit)",
  "psc.mode.wizard": "Assistent",
  "psc.mode.expert": "Experte (Argumente)",
  "psc.mode.wizard.hint": "Gef\xFChrtes Formular f\xFCr g\xE4ngige Aufgaben",
  "psc.mode.expert.hint": "Beliebige ffmpeg-Argumente mit Auswahl je Flag",
  "an.title": "Paket auswerten",
  "an.text": "Ein Support-Paket oder eine Momentaufnahme (ZIP) hochladen: Befunde, Ausf\xE4lle, Zeitleiste und Kurven auf einen Blick.",
  "an.choose": "ZIP w\xE4hlen \u2026",
  "an.copy": "Bericht f\xFCr KI kopieren",
  "an.copied": "Bericht kopiert \u2013 in ein Gespr\xE4ch mit einer KI einf\xFCgen",
  "an.failed": "Auswertung fehlgeschlagen: {error}",
  "an.run": "Auswerten",
  "an.next": "N\xE4chster Schritt:",
  "an.outages": "Ausf\xE4lle (Medien nicht bereit)",
  "an.open": "offen",
  "an.timeline": "Zeitleiste",
  "an.notable": "Auff\xE4llige Messreihen",
  "an.allSeries": "Alle Messreihen",
  "an.logs": "Meldungen (gruppiert)",
  "an.pipelines": "Pipeline-Zustand enthalten f\xFCr",
  "pscl.sub.label": "Untertitel (SRT)",
  "pscl.sub.help": "Erzeugt aus dem Ton einer Mediendatei eine SRT-Untertiteldatei, optional mit Sprechererkennung. Die Arbeit macht ein Auto-Untertitel-Node; der Schritt wartet, bis sie fertig ist. Das Ergebnis l\xE4sst sich als Kind-Event SUBTITLE in der Playout-Automation abspielen.",
  "pscl.sub.missing": "Datei oder Asset-ID fehlt",
  "pscl.sub.o.srt": "SRT-Datei (Pfad)",
  "pscl.sub.o.track": "Spur f\xFCr das Kind-Event SUBTITLE",
  "pscl.sub.o.speakers": "Anzahl erkannter Sprecher",
  "pscl.sub.o.cues": "Anzahl Untertitel",
  "psc.sub.file": "Mediendatei (Pfad)",
  "psc.sub.file.help": "Absoluter Pfad, auf dem Rechner des Untertitel-Nodes lesbar. ${\u2026}-Ausdr\xFCcke sind m\xF6glich.",
  "psc.sub.asset": "oder Asset-ID",
  "psc.sub.asset.help": "Statt des Pfads: die Quelle dieses Assets. Das Ergebnis wird als Darstellung am Asset abgelegt.",
  "psc.sub.track": "Tonspur",
  "psc.sub.lang": "Sprache",
  "psc.sub.lang.help": "Code wie de oder en; leer = automatisch",
  "psc.sub.speakers": "Sprecher",
  "psc.sub.sp.auto": "automatisch erkennen",
  "psc.sub.sp.one": "1 (ohne Namen)",
  "psc.sub.names": "Namen (kommagetrennt)",
  "psc.sub.style": "Schreibweise",
  "psc.sub.name": "Name der Spur",
  "psc.sub.name.help": "leer = aus dem Dateinamen",
  "psc.sub.err": "Datei oder Asset-ID angeben",
  "asset.ebu.export": "EBUCore \u2193",
  "asset.ebu.exportHint": "Metadaten als EBUCore-XML (EBU Tech 3293) exportieren \u2013 f\xFCr den Austausch mit anderen Systemen",
  "asset.ebu.exportFailed": "EBUCore-Export fehlgeschlagen (HTTP {p0})",
  "asset.ebu.import": "EBUCore \u2191",
  "asset.ebu.importHint": "EBUCore-XML (EBU Tech 3293) einlesen und in die Metadaten \xFCbernehmen",
  "asset.ebu.importConfirm": "{p0} Werte aus \u201E{p1}\u201C in die Metadaten \xFCbernehmen? Vorhandene Schl\xFCssel werden \xFCberschrieben, Titel und Beschreibung bleiben.",
  "asset.ebu.importOk": "\xDCbernehmen",
  "asset.ebu.importFailed": "EBUCore-Import abgelehnt: {p0}",
  "asset.ebu.imported": "{p0} Werte aus EBUCore \xFCbernommen",
  "asset.fields.manage": "Felder\u2026",
  "asset.fields.title": "Metadatenfelder",
  "asset.fields.hint": "Registrierte Felder bekommen Typ, Beschriftung und Pr\xFCfung beim Speichern. Schl\xFCssel ohne Eintrag bleiben als freie Felder erlaubt. Das EBUCore-Ziel bestimmt, wohin der Wert im Austauschformat kommt.",
  "asset.fields.loadFailed": "Felder konnten nicht geladen werden (HTTP {p0})",
  "asset.fields.required": "Pflicht",
  "asset.fields.multiple": "Mehrfachwerte",
  "asset.fields.builtin": "mitgeliefert",
  "asset.fields.allTypes": "alle Typen",
  "asset.fields.delete": "L\xF6schen",
  "asset.fields.deleteConfirm": "Feld \u201E{p0}\u201C l\xF6schen? Gespeicherte Werte bleiben als freie Felder erhalten.",
  "asset.fields.new": "Neues Feld",
  "asset.fields.category": "Kategorie",
  "asset.fields.key": "Schl\xFCssel",
  "asset.fields.keyHint": "Buchstaben, Ziffern, Unterstrich; beginnt mit einem Buchstaben",
  "asset.fields.label": "Beschriftung",
  "asset.fields.labelPh": "Anzeigename",
  "asset.fields.dataType": "Datentyp",
  "asset.fields.enumValues": "Auswahlwerte (bei Typ enum, durch Komma getrennt)",
  "asset.fields.enumPh": "A, B, C",
  "asset.fields.assetType": "Asset-Typ",
  "asset.fields.ebucore": "EBUCore-Ziel",
  "asset.fields.ebucoreHint": "Leer: der Wert geht als beschriftetes Zusatzfeld in den Export",
  "asset.fields.noTarget": "(kein festes Ziel)",
  "asset.fields.create": "Anlegen",
  "asset.fields.created": "Feld \u201E{p0}\u201C angelegt",
  "amail.title": "E-Mail-Alarmierung",
  "amail.intro": "Verschickt Alarme (Node-Alarme, Host online/offline, Medien-Gesundheit, Last) zus\xE4tzlich per E-Mail. \xC4nderungen wirken nach wenigen Sekunden, ohne Neustart. Gesendet wird nur vom f\xFChrenden Orchestrator.",
  "amail.source.ui": "Wirksame Quelle: diese Einstellung.",
  "amail.source.env": "Wirksame Quelle: Umgebungsvariablen (OMP_ALERT_SMTP_*). Speichern hier \xFCberschreibt sie.",
  "amail.source.none": "Noch nicht eingerichtet.",
  "amail.enabled": "E-Mail-Alarmierung aktiv",
  "amail.host": "SMTP-Server",
  "amail.port": "Port (leer = Standard)",
  "amail.security": "Verschl\xFCsselung",
  "amail.sec.starttls": "STARTTLS (Port 587)",
  "amail.sec.tls": "TLS (Port 465)",
  "amail.sec.none": "keine (nur vertrauensw\xFCrdiges LAN)",
  "amail.user": "Benutzer (leer = ohne Anmeldung)",
  "amail.password": "Kennwort",
  "amail.passwordSet": "gespeichert \u2014 leer lassen, um es zu behalten",
  "amail.from": "Absender",
  "amail.save": "Speichern",
  "amail.test": "Testmail senden",
  "amail.reset": "Einstellung entfernen",
  "amail.saved": "E-Mail-Alarmierung gespeichert.",
  "amail.testOk": "Testmail wurde vom Server angenommen.",
  "amail.removed": "Einstellung entfernt.",
  "amail.loadFailed": "E-Mail-Einstellung konnte nicht geladen werden.",
  "amail.confirmRemove": "Die Einstellung in der Oberfl\xE4che entfernen? Danach gelten wieder die Umgebungsvariablen (falls gesetzt).",
  "amail.to": "Standard-Empf\xE4nger (wenn keine Regel passt, mit Komma)",
  "amail.routes.title": "Empf\xE4ngerregeln nach Alarmart und Schweregrad",
  "amail.routes.add": "+ Regel hinzuf\xFCgen",
  "amail.routes.none": "Keine Regeln \u2014 alle Alarme gehen an die Standard-Empf\xE4nger.",
  "amail.route.name": "Name der Regel",
  "amail.route.status": "Statusbeilage",
  "amail.route.statusNone": "keine",
  "amail.route.statusText": "Status als Text",
  "amail.route.statusGraph": "Status als Text + Node-Grafik (PNG im Mailtext)",
  "amail.route.statusSvg": "Status als Text + Node-Grafik (SVG-Anhang)",
  "amail.testStatusRules": "Wie die Regeln",
  "amail.testStatusTitle": "Statusbeilage der Testmail (auch ohne Alarmart)",
  "amail.statusPreview": "Statusvorschau",
  "amail.statusPreviewHint": "Zeigt die Beilage mit dem aktuellen Zustand an \u2014 ohne Mailserver, ohne Versand",
  "amail.route.statusHint": "Zustand von Orchestrator, Hosts (Medienserver), beteiligten Workflows und der Signalweg vom Alarm-Node bis zur Wurzel. Bei mehreren passenden Regeln gilt der gr\xF6\xDFte Wunsch f\xFCr die ganze Mail.",
  "amail.route.to": "Empf\xE4nger dieser Regel (leer = nicht senden)",
  "amail.route.kinds": "Alarmarten",
  "amail.route.kindsAll": "alle Arten",
  "amail.route.kindsN": "{p0} Arten",
  "amail.route.sev": "Schweregrad",
  "amail.route.remove": "Regel entfernen",
  "amail.route.enabled": "aktiv",
  "amail.sev.critical": "kritisch",
  "amail.sev.warning": "Warnung",
  "amail.sev.info": "Info / Entwarnung",
  "amail.kind.node-alert": "Node-Alarm (z. B. Pipeline gerissen)",
  "amail.kind.host-offline": "Host offline",
  "amail.kind.media-lost": "Sendeweg liefert keine Medien",
  "amail.kind.node-silent": "Node ohne Lebenszeichen",
  "amail.kind.load-high": "Last zu hoch",
  "amail.kind.host-online": "Host wieder online",
  "amail.kind.node-recovered": "Node meldet sich wieder",
  "amail.kind.media-recovered": "Sendeweg liefert wieder Medien",
  "amail.kind.load-recovered": "Last wieder normal",
  "amail.testAs": "Testmail wie Alarm:",
  "amail.testDirect": "direkt an alle Empf\xE4nger",
  "amail.testSevDefault": "Standard-Schweregrad",
  "amail.testSentTo": "Testmail angenommen. Empf\xE4nger: {p0}",
  "amail.testNobody": "Dieser Alarm w\xFCrde keine Mail ausl\xF6sen (unterdr\xFCckt).",
  "amail.routeDefaultName": "Regel {p0}",
  "amail.route.workflows": "Workflows",
  "amail.route.workflowsAll": "alle Workflows (auch Alarme ohne Workflow)",
  "amail.route.workflowsN": "{p0} Workflow(s)",
  "amail.route.workflowGone": "{p0} (nicht mehr vorhanden)",
  "amail.route.workflowsNone": "Keine Workflows angelegt.",
  "amail.testNoWorkflow": "kein Workflow",
  "wf.importNotes": "Hinweis zum Import: {p0}",
  "amail.kind.process-failed": "Prozess fehlgeschlagen",
  "amail.route.processes": "Prozesse",
  "amail.route.processesAll": "alle Prozesse",
  "amail.route.processesN": "{p0} Prozess(e)",
  "amail.route.processGone": "{p0} (nicht mehr vorhanden)",
  "amail.route.processesNone": "Keine Prozesse angelegt.",
  "amail.testNoProcess": "kein Prozess",
  "amail.routes.help": "Ein Alarm geht an die Empf\xE4nger aller passenden Regeln (Art UND Schweregrad m\xFCssen passen; nichts angehakt = alle). Ist bei Workflows oder Prozessen etwas angehakt, muss der Alarm zus\xE4tzlich zu einem davon geh\xF6ren (ein Treffer in einer der beiden Listen gen\xFCgt). Node-Alarme geh\xF6ren zum Workflow ihrer Rolle, Host-Alarme zu allen laufenden Workflows mit einer Rolle auf diesem Host, Prozess-Alarme zu ihrem Prozess. Passt keine Regel, erhalten ihn die Standard-Empf\xE4nger. Eine passende Regel ohne Empf\xE4nger unterdr\xFCckt die Mail.",
  "amail.kind.qc-failed": "Datei hat die QC nicht bestanden",
  "amail.kind.qc-error": "QC konnte nicht ausgef\xFChrt werden",
  "amail.kind.file-rejected": "Datei im Eingang abgelehnt",
  "amail.kind.user-action": "Manuelle Benutzeraktion",
  "amail.group.nodes": "Nodes",
  "amail.group.hosts": "Hosts",
  "amail.group.process": "Prozesse",
  "amail.group.review": "Eingang (Dateien)",
  "amail.group.user": "Benutzeraktionen",
  "amail.optIn": "nur wenn ausdr\xFCcklich gew\xE4hlt",
  "amail.route.actions": "Benutzeraktionen",
  "amail.route.actionsHint": "nur f\xFCr \u201EManuelle Benutzeraktion\u201C; leer = alle. Beispiele: review.rejected, workflow.*",
  "amail.testAction": "Aktion, z. B. review.rejected",
  "setx.tab.nodes": "Node-Optionen",
  "setx.tab.system": "Betriebswerte",
  "setx.tab.mail": "E-Mail-Alarmierung",
  "setx.tab.directory": "Active Directory",
  "setx.search": "Einstellungen durchsuchen \u2026",
  "setx.noHits": "Keine Einstellung passt zu \u201E{p0}\u201C in diesem Reiter.",
  "setx.clear": "Suche l\xF6schen",
  "clro.title": "Cluster-Rollout (alle Orchestrator-Mitglieder nacheinander)",
  "clro.hint": "Mitglieder werden einzeln aktualisiert bzw. neu gestartet, der Leader zuletzt nach F\xFChrungs\xFCbergabe. Voraussetzung: mindestens 3 stimmberechtigte Mitglieder und ein Paket mit Kennzeichnung \u201ErollingSafe\u201C.",
  "clro.status": "{p0} \u2013 {p1}",
  "clro.kindUpdate": "Update auf {p0}",
  "clro.kindRestart": "Neustart",
  "clro.state.running": "l\xE4uft",
  "clro.state.failed": "angehalten (Fehler)",
  "clro.state.done": "fertig",
  "clro.state.cancelled": "abgebrochen",
  "clro.step.pending": "wartet",
  "clro.step.distributing": "Paket wird geladen",
  "clro.step.applying": "wird angewendet",
  "clro.step.verifying": "wird gepr\xFCft",
  "clro.step.done": "fertig",
  "clro.step.failed": "Fehler",
  "clro.resume": "Rollout fortsetzen",
  "clro.cancel": "Rollout abbrechen",
  "clro.restart": "Cluster rollierend neu starten",
  "clro.restartConfirm": "Alle Orchestrator-Mitglieder werden nacheinander neu gestartet, der Leader zuletzt. Laufende Sendungen werden nicht neu gestartet. Fortfahren?",
  "clro.startUpdate": "Rollierend auf alle Mitglieder einspielen",
  "clro.updateConfirm": "Version {p0} nacheinander auf alle Orchestrator-Mitglieder einspielen? Bei einem Fehler h\xE4lt der Rollout an; bereits aktualisierte Mitglieder bleiben unver\xE4ndert.",
  "clro.notSafe": "Paket nicht als \u201ErollingSafe\u201C gekennzeichnet \u2013 f\xFCr den Cluster-Rollout nicht zugelassen.",
  "clro.precheck": "Vorpr\xFCfung nicht bestanden: {p0}",
  "clro.startFailed": "Cluster-Rollout: {p0}",
  "clro.hostsFirst": "Host-Agents zuerst verteilen",
  "clro.hosts": "Host-Agents",
  "cathost.title": "Hosts",
  "cathost.title.n": "Hosts ({ok} von {total} bereit)",
  "cathost.distribute": "Auf Hosts verteilen \u2026",
  "cathost.needVersion": "Zum Verteilen muss der Typ mit einer Version importiert sein.",
  "cathost.noHosts": "Es sind keine Hosts registriert.",
  "cathost.allDone": "Der Typ ist bereits auf allen Hosts vorgesehen.",
  "cathost.state.ok": "bereit",
  "cathost.state.pending": "wartet",
  "cathost.state.installing": "wird installiert \u2026",
  "cathost.state.failed": "fehlgeschlagen",
  "cathost.state.offline": "Host offline \u2013 wird nachgezogen",
  "cathost.state.removing": "wird entfernt \u2026",
  "cathost.retry": "Erneut versuchen",
  "cathost.remove": "Entfernen",
  "cathost.removeConfirm": "\u201E{name}\u201C von Host \u201E{host}\u201C entfernen? Das Image und \u2013 falls es der letzte Stand ist \u2013 das Datenvolumen werden dort gel\xF6scht.",
  "cathost.failed": "Verteilung: {p0}",
  "cathost.dialogTitle": "\u201E{name}\u201C auf Hosts verteilen",
  "cathost.dialogInfo": "Das Image wird als signiertes Bundle zu den gew\xE4hlten Hosts \xFCbertragen. Jeder Host pr\xFCft Signatur und Pr\xFCfsumme und entscheidet selbst, welche Erweiterungen (z. B. Host-Netz) er erlaubt.",
  "cathost.cancel": "Abbrechen",
  "cathost.start": "Verteilen",
  "cathost.pickOne": "Bitte mindestens einen Host w\xE4hlen.",
  "hostsw.title": "Software-Stand der Hosts",
  "hostsw.refresh": "Aktualisieren",
  "hostsw.loading": "l\xE4dt \u2026",
  "hostsw.mixed": "Unterschiedliche St\xE4nde desselben Node-Typs auf verschiedenen Hosts: {p0}",
  "hostsw.localName": "{p0} (Orchestrator-Rechner)",
  "hostsw.orch": "Orchestrator",
  "hostsw.agent": "Host-Agent",
  "hostsw.builtAt": "gebaut {p0}",
  "hostsw.deviates": "weicht vom Orchestrator ab",
  "hostsw.deviatesTitle": "Der Orchestrator l\xE4uft mit {p0}.",
  "hostsw.summary": "{p0} Node-Typen, {p1} Instanzen laufen",
  "hostsw.outdated": "{p0} Instanz(en) veraltet",
  "hostsw.outdatedShort": "{p0} veraltet",
  "hostsw.col.type": "Node-Typ",
  "hostsw.col.version": "Version",
  "hostsw.col.commit": "Commit",
  "hostsw.col.built": "Gebaut",
  "hostsw.col.running": "L\xE4uft",
  "hostsw.fileTime": "\xC4nderungszeit der Datei (der Stempel tr\xE4gt keine Bauzeit)",
  "hostsw.staleBanner": "{p0} Host(s) mit \xE4lterem Stand: {p1}",
  "hostsw.staleAgent": "Host-Agent \xE4lter",
  "hostsw.staleNodes": "{p0} Node-Typ(en) \xE4lter",
  "hostsw.newerOn": "neuer auf {p0}: {p1}",
  "hostsw.col.note": "Hinweis",
  "files.filter.label": "Dateien",
  "files.filter.all": "Dateien: alle",
  "files.filter.problem": "Dateiproblem (fehlt/teilweise/nicht erreichbar)",
  "files.filter.ok": "alle Dateien vorhanden",
  "files.filter.missing": "Datei fehlt",
  "files.filter.partial": "teilweise fehlend",
  "files.filter.unreachable": "Datei nicht erreichbar",
  "files.filter.unchecked": "nie gepr\xFCft",
  "files.filter.none": "ohne Datei",
  "files.state.present": "vorhanden",
  "files.state.missing": "Datei fehlt",
  "files.state.unreachable": "nicht erreichbar",
  "files.state.unknown": "nicht pr\xFCfbar",
  "files.state.unchecked": "nie gepr\xFCft",
  "files.col.state": "Datei",
  "files.check": "Dateien jetzt pr\xFCfen",
  "files.checked": "Dateien gepr\xFCft.",
  "files.warn.missing": "Eine Datei dieses Assets fehlt",
  "files.openExplorer": "Im Datei-Explorer zeigen"
};

// ui/shell/i18n/en.ts
var en = {
  "lang.title": "Language",
  "mc.allTimeline": "All timelines",
  "mc.allTimelineTip": "Show/hide all channels on one shared time axis",
  "mc.title": "Multi-channel overview",
  "mc.overview": "Overview",
  "mc.empty": "No playout channels assigned.",
  "mc.loading": "Looking for channels \u2026",
  "mc.onAir": "On air",
  "mc.next": "Next",
  "mc.nothing": "nothing on air",
  "mc.edit": "Edit",
  "mc.window": "Window",
  "mc.winMin": "{n} min",
  "mc.selectAll": "Select all",
  "mc.selectNone": "None",
  "mc.selected": "{n} selected",
  "mc.gang": "Gang roll",
  "mc.gangHint": "Acts on all selected channels at once.",
  "mc.act.next": "Next",
  "mc.act.take": "Take",
  "mc.act.nextLive": "Next Live",
  "mc.act.hold": "Hold",
  "mc.act.auto": "Auto",
  "mc.confirm": "Run {action} on {n} channels?\n{names}",
  "mc.result.ok": "{action}: {n} channels done",
  "mc.result.fail": "{action}: {n} failed \u2014 {names}",
  "mc.stat.events": "{n} events",
  "mc.stat.rest": "left {t}",
  "mc.stat.ends": "ends {at}",
  "mc.health.ok": "running",
  "mc.health.wait": "waiting for operator",
  "mc.health.warn": "attention",
  "mc.health.offline": "no connection",
  "mc.wait.hold": "HOLD",
  "mc.wait.endHold": "Manual hold",
  "mc.wait.manualStart": "manual",
  "mc.wait.cued": "cued",
  "mc.keys": "Alt+\u2190 / Alt+\u2192 switches channel, Alt+0 shows the overview",
  "mc.noBundle": "Interface of {name} could not be loaded.",
  "app.tab.flow": "Flow Editor",
  "app.tab.workflows": "Workflows",
  "app.tab.process": "Processes",
  "app.tab.assets": "Assets",
  "app.tab.hosts": "Hosts",
  "app.tab.instances": "Instances",
  "app.tab.alarms": "Alarms",
  "app.tab.health": "Health",
  "app.tab.signalPath": "Signal path",
  "app.tab.scheduler": "Scheduler",
  "app.tab.admin": "Administration",
  "app.conn.connected": "\u25CF Connected",
  "app.conn.degraded": "\u25CF Degraded",
  "app.conn.disconnected": "\u25CF Disconnected",
  "app.conn.lost": "Connection to the orchestrator lost \u2014 retrying in {secs}s",
  "app.conn.retryNow": "Connect now",
  "auth.loggedInAs": "Signed in as {user}",
  "auth.logout": "Sign out",
  "op.problem.overdue": "overdue",
  "op.problem.failed": "failed",
  "op.problem.not_admitted": "not admitted (resources)",
  "op.problem.waiting_resources": "waiting for resources",
  "op.problem.qc_not_run": "QC could not run",
  "op.problem.qc_failed": "QC found errors",
  "op.problem.rejected": "rejected \u2013 rework",
  "op.state.awaiting_qc": "waiting for QC",
  "op.state.qc_running": "QC running",
  "op.state.qc_failed_to_run": "QC could not run",
  "op.state.awaiting_review": "waiting for review",
  "op.state.in_review": "in review",
  "op.state.conforming": "conforming",
  "op.state.ready_for_approval": "ready for approval",
  "op.state.approved": "approved",
  "op.state.rejected": "rejected",
  "op.state.archived": "archived",
  "op.state.scheduled": "scheduled",
  "op.state.blocked": "not admitted",
  "op.state.waiting_for_resources": "waiting for resources",
  "op.state.starting": "starting",
  "op.state.recording": "recording",
  "op.state.finalizing": "finishing",
  "op.state.processing": "processing",
  "op.state.completed": "done",
  "op.state.failed": "failed",
  "op.state.cancelled": "cancelled",
  "op.home.title": "Workstation",
  "op.home.workflows": "Workflows",
  "op.home.noWorkflow": "No workflow you can operate is running right now.",
  "op.home.tools": "Tools",
  "op.home.tasks": "My tasks",
  "op.home.noTasks": "No open tasks.",
  "op.home.noTasksShort": "no open tasks",
  "op.home.taskCount": "{n} tasks",
  "op.home.problemCount": "{n} with a problem",
  "op.home.taskSummary": "{total} open \xB7 {mine} mine \xB7 {problems} with a problem",
  "op.home.taskError": "Tasks from {module} could not be loaded: {message}",
  "op.home.hello": "Welcome, {name}",
  "op.home.open": "Open",
  "op.home.back": "Workstation",
  "op.task.col.kind": "Type",
  "op.task.col.title": "Task",
  "op.task.col.state": "Status",
  "op.task.col.who": "Responsible",
  "op.task.col.due": "Due",
  "op.task.kind.qc": "Check file",
  "op.task.kind.recording": "Recording",
  "op.task.kind.approval": "Approval",
  "op.task.mine": "me",
  "op.task.group": "group {group}",
  "op.task.claimable": "group {group} \u2013 can be taken",
  "op.due.in": "in {span}",
  "op.due.ago": "overdue for {span}",
  "op.tiles.unavailable": "The work views could not be loaded right now.",
  "op.tiles.retry": "Try again",
  "inst.cpu.core": "of one core",
  "inst.cpu.coreTitle": "100 % = one fully used core. The main value refers to all cores of the host and is comparable with the host load.",
  "hosts.sensors": "Temp. / power",
  "hosts.sensorsTitle": "Host temperature (CPU/platform) and power draw. Red from 85 \xB0C; alert via OMP_ALERT_TEMP_C.",
  "hosts.sensorsNone": "The host reports no temperature/power values (VM, no sensor or no read permission) \u2014 not measured",
  "hosts.powerRapl": "CPU package power (RAPL), excluding the rest of the system",
  "hosts.powerBattery": "Total device power (battery)",
  "op.tile.failed": "The view \u201C{label}\u201D could not be loaded.",
  "op.badge": "\u26A0 {n} tasks",
  "op.badge.title": "{n} tasks need attention ({overdue} overdue) \u2014 go to workstation",
  "auth.home": "\u{1F3E0} Workstation",
  "auth.homeTitle": "Back to the workstation (workflows, tasks, tools)",
  "auth.switchWorkflow": "\u{1F3E0} Switch workflow",
  "auth.switchWorkflowTitle": "Back to the workflow selection",
  "admin.title": "Administration",
  "admin.group.platform": "Platform",
  "admin.cluster.access": "Access & rights",
  "admin.cluster.operations": "Operations",
  "admin.cluster.maintenance": "Maintenance",
  "admin.tab.users": "Users",
  "admin.tab.organizations": "Organizations",
  "admin.tab.groups": "Groups",
  "admin.tab.bindings": "Permissions",
  "admin.tab.catalog": "Node catalog",
  "admin.tab.nodeversions": "Node versions",
  "admin.tab.storage": "Storage",
  "admin.tab.audit": "Audit log",
  "admin.tab.diagnose": "Diagnostics",
  "admin.tab.backup": "Backup/Restore",
  "admin.tab.update": "System update",
  "admin.tab.settings": "Settings",
  "admin.tab.cluster": "Cluster",
  "sp.title": "Signal path",
  "sp.intro": "Shows which nodes a signal actually passes from the source to the destination right now (active connections) and where the chain breaks. Source and destination can be chosen independently: a source alone shows every chain leaving it, a destination alone every chain arriving there.",
  "sp.clear": "Clear selection",
  "sp.noMatch": "No matches",
  "sp.source": "Source",
  "sp.target": "Destination",
  "sp.via": "via node (optional)",
  "sp.chooseSource": "Search or choose source \u2026",
  "sp.chooseTarget": "Search or choose destination \u2026",
  "sp.noVia": "Search node (optional) \u2026",
  "sp.loading": "Loading \u2026",
  "sp.pick": "Choose a source and/or a destination \u2014 with only one side you see everything that leaves the source or arrives at the target.",
  "sp.noPath": "No signal path: there is no active chain of connections between source and destination. Check that all segments are connected (Flow Editor).",
  "sp.noPathVia": "No signal path: there is no active chain of connections between source and destination through the chosen node. Check that all segments are connected (Flow Editor).",
  "sp.noDownstream": "No active connection leaves this source. Check in the flow editor that it is connected.",
  "sp.noUpstream": "No active connection arrives at this destination. Check in the flow editor that a source is connected.",
  "sp.path": "Path",
  "sp.pathN": "Path {n} of {total}",
  "sp.connections.one": "1 connection",
  "sp.connections.many": "{n} connections",
  "sp.issue.hostSilent": "The host {host} is no longer reporting (affects: {nodes})",
  "sp.issue.hostOverloaded": "The host {host} is heavily loaded (affects: {nodes})",
  "sp.issue.hostClock": "The clock of {host} is not synchronised (affects: {nodes})",
  "sp.issue.notReady": "{node} is running but currently delivers no picture or sound",
  "sp.issue.neverReady": "{node} has not delivered any picture or sound yet (or does not report readiness)",
  "sp.fix.neverReady": "If this node is supposed to deliver media: check the source before it and its settings. Some node types do not report readiness \u2014 then this notice is harmless.",
  "sp.issue.noFrames": "{node} has stopped delivering frames",
  "sp.issue.fpsDrop": "{node}: frame rate dropped ({last} instead of {avg} frames/s)",
  "sp.issue.restarts": "{node} was restarted automatically {n} times",
  "sp.fix.offline": "Check under Instances whether the process runs; otherwise restart it.",
  "sp.fix.crashed": "The last error is shown under Instances. Restart it; if it crashes again, create the support package (Administration \u2192 Support).",
  "sp.fix.formatMismatch": "Connect matching ports (video to video, audio to audio).",
  "sp.fix.mxlAcrossHosts": "Put source and target on the same host or insert a gateway between them.",
  "sp.fix.loop": "Remove the connection that feeds the output back into the input.",
  "sp.fix.hostSilent": "Check the machine, the network and the \u201Comp-host-agent\u201D service of the host. Instances there are probably unreachable.",
  "sp.fix.hostOverloaded": "Move instances to another host before picture or sound drop out.",
  "sp.fix.hostClock": "Check time synchronisation (chrony/PTP) of the host; a wrong clock disturbs video exchange.",
  "sp.fix.notReady": "Check the source before it: without an input signal or file this node delivers nothing. If that does not help, restart the node.",
  "sp.fix.noFrames": "Restart the node. If nothing comes afterwards, check the source before it and create the support package.",
  "sp.fix.fpsDrop": "Usually overload: check the host load and spread instances.",
  "sp.fix.restarts": "The process keeps ending on its own. Look for the cause under Administration \u2192 Diagnose or create the support package.",
  "sp.verdict.fix": "What to do? {fix}",
  "sp.overview.title": "All targets at a glance",
  "sp.overview.hint": "Why does nothing arrive here? For every target (viewer, recorder, gateway \u2026) the chain is checked backwards and the first fault is named.",
  "sp.overview.none": "No source is connected",
  "sp.overview.ok": "Everything is fine",
  "sp.overview.show": "Show chain",
  "sp.overview.empty": "No targets found (nodes without an output).",
  "sp.verdict.ok": "\u2714 Signal path OK",
  "sp.verdict.warn": "\u26A0 Signal path is up, with warnings",
  "sp.verdict.error": "\u2716 First fault: {text}",
  "sp.truncated": "Only the first {max} paths (shortest first) are shown.",
  "sp.host": "Host: {host}",
  "sp.hostUnknown": "Host unknown",
  "sp.hostLocal": "local",
  "sp.online": "online",
  "sp.offline": "offline",
  "sp.net": "Network: {demand}",
  "sp.card": "NIC: {percent} % of {link}",
  "sp.netLink": "Network {demand}",
  "sp.localLink": "local, no network",
  "sp.issue.loop": "Loop: {node} is fed by {from} \u2013 no signal from a real source",
  "sp.issue.offline": "{node} is offline",
  "sp.issue.monitor": "{node} reports (status monitoring): {text}",
  "sp.issue.crashed": "{node} has crashed",
  "sp.issue.formatMismatch": "Formats do not match: {from} \u2192 {to}",
  "sp.issue.transportDiffers": "Different transports: {from} \u2192 {to}",
  "sp.issue.mxlAcrossHosts": "MXL is host-local, source and destination are on different hosts (gateway needed)",
  "sp.issue.netUnknownLink": "Network: {demand} \u2014 link speed of the NIC on {host} unknown, headroom cannot be checked",
  "sp.issue.netTooBig": "Network: needs {demand}, the NIC on {host} only manages {link} per direction",
  "sp.issue.netOverThreshold": "NIC on {host} is {percent} % utilized (threshold {threshold} %)",
  "sp.anyInput": "{node} (any input)",
  "sp.activeInput": "Input (active source)",
  "sp.format.video": "Video",
  "sp.format.audio": "Audio",
  "sp.format.data": "Data",
  "sp.format.mux": "Mux",
  "login.lead": "An open platform for software-defined media and broadcast infrastructures \u2013 built for interoperability, flexibility and the demands of tomorrow.",
  "login.tag": "Standards. Technology. Freedom.",
  "login.title": "Sign in",
  "login.sub": "Access to the control plane",
  "login.user": "Username",
  "login.password": "Password",
  "login.failed": "Sign-in failed.",
  "op.noWorkflow.title": "No active workflow",
  "op.noWorkflow.text": "You have operating rights for at least one role, but no matching workflow is running right now. As soon as an assigned workflow is started, it will appear here.",
  "op.reload": "Reload",
  "op.pickWorkflow": "Choose a workflow",
  "op.roles.one": "1 role",
  "op.roles.many": "{n} roles",
  "op.hostLocal": "Local",
  "console.none": "No console assigned to this user.",
  "console.loading": "Loading \u2026",
  "console.bundleFailed": 'The UI bundle for "{node}" could not be loaded.',
  "cloud.suggest": "Cloud suggestion {p0}: add {p1}\xD7 {p2}",
  "cloud.calculating": "calculating cost \u2026",
  "cloud.costFailed": "cost unavailable",
  "cloud.cost": "approx. {p0} {p1} (estimate, excluding data transfer)",
  "cloud.hint": "Suggestion derived from the bottleneck in this period: this many cloud hosts would resolve the overload. The cost is a pre-calculation, not a bill.",
  "cloud.reserve": "Reserve",
  "cloud.confirm": "{p1}: reserve {p0} cloud host(s)? This incurs costs ({p2}).",
  "cloud.reserved": "Cloud capacity reserved",
  "cloud.reserveFailed": "Reservation failed: {p0}",
  "app.module.loadFailed": "The interface of \u201C{name}\u201D could not be loaded.",
  "console.unavailable": "Service unavailable \u2013 the node is not responding.",
  "board.arrangeAll": "\u229E Arrange all",
  "board.arrangeAllTitle": "Rearrange all tiles in a grid and expand them",
  "board.dragMove": "Drag to move",
  "board.dragResize": "Drag to resize",
  "board.restore": "Restore",
  "board.minimize": "Minimize",
  "board.maximize": "Maximize",
  "board.preview": "Preview",
  "board.previewTitle": "Show/hide live preview in the tile",
  "board.noUi": "This node has no UI of its own.",
  "board.taskbar": "Minimized windows",
  "board.layouts": "Layouts \u2026",
  "board.layoutSave": "Save layout",
  "board.layoutSaveTitle": "Save the current window arrangement under a name",
  "board.layoutSaveConfirm": "Save",
  "board.layoutDelete": "Delete layout",
  "board.layoutName": "Layout name:",
  "board.layoutConfirmDelete": 'Delete layout "{name}"?',
  "board.hostTitle": "Host: {host}",
  "up.next": "Next workflow: {name}",
  "up.starting": "Workflow starting: {name}",
  "up.now": "starting now \u2026",
  "up.planned": "scheduled {when}",
  "up.dayShort": "d",
  "kit.cancel": "Cancel",
  "kit.ok": "OK",
  "kit.delete": "Delete",
  "kit.searchPlaceholder": "\u{1F50D} Search sources \u2026",
  "kit.searchAria": "Search sources",
  "kit.noHits": "No matches",
  "kit.noSources": "No sources available",
  "wfi.button": "Interface\u2026",
  "wfi.buttonTitle": "Define the outputs and inputs of this workflow (what operators see and switch)",
  "wfi.title": "Interface of {p0}",
  "wfi.intro": "Operators only see the outputs and inputs named here, not every sender of the roles.",
  "wfi.outputs": "Outputs",
  "wfi.inputs": "Inputs",
  "wfi.outputsHint": "What this workflow delivers, e.g. PGM. Several senders (picture + sound) form one output.",
  "wfi.inputsHint": "What this workflow accepts from outside, e.g. feed.",
  "wfi.name": "Name (unique)",
  "wfi.labelPlaceholder": "Display name (optional)",
  "wfi.portPlaceholder": "Port of the role (empty: output = all senders, input = first)",
  "wfi.addMember": "+ sender/receiver",
  "wfi.removeMember": "Remove member",
  "wfi.removePort": "Remove",
  "wfi.newOutput": "New output, e.g. PGM",
  "wfi.newInput": "New input, e.g. feed",
  "wfi.add": "Add",
  "wfi.nameTaken": "The name is empty or already used.",
  "wfi.problems": "A member refers to a role that does not exist, or an output has no member.",
  "wfi.notRunning": "The workflow is not running or provides no source.",
  "wfi.noMatch": "No sender of the output matches the target (media type).",
  "wfi.connected": "{p0} connected.",
  "wfi.fedBy": "Fed by {p0} \u2192 {p1}",
  "wfi.unlink": "Unlink",
  "wfi.edgeTip": "Connection through the workflow interface",
  "wfi.feedTip": "Permanent assignment (output \u2192 input); click and press Del to disconnect",
  "wfi.disconnected": "Connection removed.",
  "wfi.disconnect": "Disconnect (Del)",
  "flow.removeStoppedRoles": "The role(s) {p0} are no longer running (stopped). Saving removes them, with their connections, from the workflow. Continue?",
  "kit.workflowOutputs": "Workflow outputs",
  "kit.currentWorkflow": "Current workflow",
  "kit.otherWorkflows": "Other workflows",
  "kit.otherUnassigned": "Other / unassigned",
  "hosts.54f664": "Online",
  "hosts.8d9da4": "Offline",
  "hosts.75d9aa": "No host registered yet.",
  "hosts.ec53a8": "Status",
  "hosts.b021df": "Label",
  "hosts.c8f4b8": "Hostname",
  "hosts.2b5538": "CPU",
  "hosts.e53619": "RAM",
  "hosts.72ce72": "Network",
  "hosts.52f9ec": "GPU",
  "hosts.25850a": "Trend (1h)",
  "hosts.be62a5": "Min/avg/max CPU",
  "hosts.4d62c2": "Last seen",
  "hosts.514366": "Host online",
  "hosts.eda8d2": "Host offline \u2014 last seen {p0}",
  "hosts.61ea4b": "Host offline \u2014 no telemetry received",
  "hosts.424d6d": "Suggestion: ",
  "hosts.c77b3a": "no fallback host available",
  "hosts.857412": " overloaded (reason: {p0}, CPU {p1}% / RAM {p2}%{p3}{p4}),\n          {p5} instance(s) affected \u2014 {p6}\n        ",
  "hosts.e50108": "Role ",
  "hosts.7fdb90": " moves in ",
  "hosts.bcf38d": " automatically to ",
  "hosts.0f1de4": " if no action is taken.",
  "hosts.578226": "Run now",
  "hosts.4b9727": "Cancel",
  "hosts.995111": "+ Add new host",
  "hosts.remove": "Remove",
  "hosts.maintOn": "Maintenance",
  "hosts.maintOff": "End maintenance",
  "hosts.maintConfirm": "Put host {p0} into maintenance mode? It gets no new load and all workflow roles are moved to other hosts without interruption (make-before-break). Standalone instances stay and are reported.",
  "hosts.maintEvacuating": "Maintenance: draining ({p0}/{p1})",
  "hosts.maintDrained": "Maintenance: empty",
  "hosts.maintBlocked": "Maintenance: {p0} not movable",
  "hosts.maintBanner": "MAINTENANCE",
  "hosts.maintMoveBtn": "Move \u2026",
  "hosts.maintMoveDialogTitle": "Move instance {p0}",
  "hosts.maintMoveDialogInfo": "The instance is stopped and restarted on the chosen host \u2014 the signal drops briefly. Connections and settings are carried over.",
  "hosts.maintMoveCancel": "Cancel",
  "rd.placementPinned": "Placement: bound to host (never move automatically)",
  "hosts.maintReason.hostBound": "bound to hardware on this host, never moved automatically",
  "hosts.maintReason.standalone": "standalone instance, no seamless move possible",
  "hosts.maintMoveFailed": "Move failed: {p0}",
  "hosts.maintMoveStarted": "Move started: {p0}",
  "hosts.maintLocal": "Orchestrator host (local)",
  "hosts.removeConfirm": "Remove host {p0} from the registry? Its host agent must re-register with a new token.",
  "hosts.removeFailed": "Removal failed: {p0}",
  "hosts.080196": "Hosts ({p0})",
  "inst.50c3a7": "Instance",
  "inst.ec53a8": "Status",
  "inst.c2ca16": "Host",
  "inst.974607": "Restarts",
  "inst.03a35d": "Process crashed",
  "inst.93e356": "Started manually, belongs to no workflow",
  "inst.3e3d94": "No instance is running.",
  "inst.24f47c": "Workflow",
  "inst.9e4506": "Sort by {p0}",
  "inst.aba7a7": "Crashed",
  "inst.d4a100": "Running",
  "inst.f9ab8e": "The program was replaced by an update; this instance keeps running the old version until its next restart.",
  "inst.2b4695": "outdated",
  "inst.bedfb0": "Running instances ({p0})",
  "alarmv.d89d48": 'Action failed (missing "operate" permission or orchestrator unreachable).',
  "alarmv.3eb4f8": "\u2713 No active alarms.",
  "alarmv.6b43af": "Acknowledged ({p0})",
  "alarmv.1a722d": "Masked ({p0})",
  "alarmv.077f20": "\n        Alarms ({p0} critical, {p1} warning{p2})\n      ",
  "alarmv.95ee27": ", until the state changes",
  "alarmv.577e3a": "Restore",
  "alarmv.4cac0b": "Comment (optional)",
  "alarmv.0e8eac": "Seen \u2014 stays visible, no longer counts as loud",
  "alarmv.146e19": "Acknowledge",
  "alarmv.2ba8d2": "Mask duration",
  "alarmv.b41fc6": "until change",
  "alarmv.ce0e13": "Hide from footer/counter",
  "alarmv.5323ef": "Mask",
  "alarms.c6fbd0": "Critical",
  "alarms.d00803": "Warning",
  "alarms.72ce72": "Network",
  "alarms.50c3a7": "Instance",
  "alarms.03a35d": "Process crashed",
  "alarms.a0457b": "{p0}\xD7 restarted automatically",
  "alarms.31c1e2": "Fallback host: {p0}",
  "alarms.c77b3a": "no fallback host available",
  "alarms.c2ca16": "Host",
  "alarms.fee224": "overloaded ({p0}: CPU {p1}% / RAM {p2}%{p3}), {p4} instance(s) affected \u2014 {p5}",
  "alarms.808471": "OFFLINE \u2014 failed unexpectedly (last seen {p0}), not ended manually",
  "alarms.3494ff": "offline \u2014 no telemetry received since orchestrator start",
  "alarms.24f47c": "Workflow",
  "alarms.ffca7b": "start failed",
  "health.396d45": "Healthy",
  "health.2b329f": "Unhealthy",
  "health.3cab03": "Inactive",
  "health.502f11": "Sync source: {p0}",
  "health.49ae97": "Partially healthy",
  "health.97e7c9": "Link",
  "health.d8e87c": "Sync",
  "health.kpi.title": "Media availability (24 h)",
  "health.kpi.hint": 'Share of the observed time in which the node delivered media ("media_ready" report). Times without reports do not count. The history is lost when the orchestrator restarts.',
  "health.kpi.node": "Node",
  "health.kpi.avail": "Availability",
  "health.kpi.outages": "Outages",
  "health.kpi.longest": "Longest outage",
  "health.kpi.rates": "Rates (current, avg, min)",
  "health.kpi.observed": "Observed",
  "health.1b62eb": "Health \u2014 AMWA BCP-008",
  "health.41ecdf": "{p0} node(s) with BCP-008 support \xB7 refreshed every {p1}s",
  "health.3b7344": "Loading\u2026",
  "health.efc263": "No running instances with BCP-008 support found. ",
  "health.45e570": "(2110 gateway, DeckLink, AES67 gateway, SRT gateway, recorder, viewer and video mixer support BCP-008.)",
  "health.4333cf": "Reset the counters/messages of this node",
  "health.c963b3": "\u21BA Reset",
  "listen.a27ba8": "no audio stream",
  "listen.b34670": "Monitor volume",
  "listen.977a2d": "Quick select",
  "listen.c8108d": "Click a key to assign it a source",
  "listen.ab6eb8": "Label (e.g. PGM)",
  "listen.33dddf": "Clear",
  "listen.4b9727": "Cancel",
  "listen.b97d23": "Save",
  "listen.c15782": "No audio sources found.",
  "listen.24e79f": "Assign key {p0}",
  "listen.e7d29a": "\u201C{p0}\u201D is currently not available.",
  "listen.45cef4": "Channels",
  "listen.bbc45d": "Stereo",
  "listen.ca293d": "Mono sum (L+R) \u2014 compatibility check",
  "listen.7834b5": "Left channel only on both ears",
  "listen.878f43": "Right channel only on both ears",
  "listen.c5103a": "\u{1F3A7} Headphone compensation",
  "listen.178039": "Crossfeed: mixes a filtered, slightly delayed portion of the opposite channel \u2014 like loudspeakers do acoustically. ",
  "listen.5d839e": "Prevents the stereo image from sounding too wide on headphones.",
  "listen.63e7ec": "Strength",
  "listen.00cd7b": "Mute",
  "listen.f0bddc": "Dim (\u221220 dB)",
  "listen.669306": "Delay the sound until it matches the picture in the viewer/multiviewer",
  "listen.85d6d3": "Empty \u2014 right-click or \u201CAssign\u201D",
  "listen.6fd701": "Expand/collapse the monitor controller",
  "listen.30f29f": "MONITOR",
  "listen.756de8": "Stop monitoring",
  "hwiz.8adbea": "Bare metal",
  "hwiz.5f5b8f": "Cloud (AWS EC2)",
  "hwiz.704b3b": "Additional capacity, no PTP/multicast (\xA76)",
  "hwiz.851e7f": "Only admins can create a bootstrap token.",
  "hwiz.fe39d4": "Token creation failed ({p0}).",
  "hwiz.876ed3": "Orchestrator unreachable.",
  "hwiz.2b9a71": "Add new host \u2014 error",
  "hwiz.dee66f": "Add new host (step {p0}/4)",
  "hwiz.3a4a80": "Where does the new host run? The host agent behaves identically in all three cases \u2014 the choice only determines the provisioning script generated below.",
  "hwiz.2a44e7": "Label for the new host",
  "hwiz.ce2855": "e.g. Control-Room-Host-C",
  "hwiz.4b9727": "Cancel",
  "hwiz.c39838": "Next",
  "hwiz.25d4d9": "Creating bootstrap token \u2026",
  "hwiz.7b0156": "Token created, valid for ",
  "hwiz.874bdf": ". Check the three addresses (reachable from the target host, adjust if needed) and copy the script to the new host.",
  "hwiz.df9147": "Orchestrator URL",
  "hwiz.939ad8": "Registry URL (assumed)",
  "hwiz.70dfc1": "Copied!",
  "hwiz.c5ce55": "Copy script",
  "hwiz.e50954": "Next \u2014 wait for registration",
  "hwiz.cb070c": "Token expired",
  "hwiz.21a0ca": " \u2014 \u201C{p0}\u201D did not register.",
  "hwiz.fa44f4": "Waiting for \u201C",
  "hwiz.2ff25e": "\u201D to register \u2026 (token expires in {p0})",
  "hwiz.8a1656": "Create new token",
  "hwiz.4d839e": "The host appears in the hosts list anyway once it registers.",
  "hwiz.2c25a7": "Host registered.",
  "hwiz.b021df": "Label",
  "hwiz.c8f4b8": "Hostname",
  "hwiz.abbdd4": "Architecture",
  "hwiz.4d7915": "Done",
  "hwiz.8311b9": "Close",
  "loc.fad7a2": " Note: {p0}",
  "loc.669349": "Storage locations could not be loaded.",
  "loc.3e96ca": "Orchestrator machine",
  "loc.b4e5a7": "Create anyway",
  "loc.53b57b": "Storage location created.{p0}",
  "loc.0025a8": "Remove storage location \u201C{p0}\u201D? The files stay untouched, only the entry disappears.",
  "loc.513d30": "Remove",
  "loc.18a80a": "Local storage locations",
  "loc.6ab318": "Directories or network shares that a host has mounted locally (NFS/SMB/disk \u2014 the mounting itself happens in the operating system, e.g. via /etc/fstab). ",
  "loc.764153": "Here they get a name, are checked for reachability and free space, and appear in Admin \u2192 Settings as a choice for path options (e.g. the media directory of a player).",
  "loc.54d2e5": "No storage locations created yet.",
  "loc.49ee30": "Name",
  "loc.c2ca16": "Host",
  "loc.b6a791": "Path",
  "loc.7f5acf": "State",
  "loc.f7a012": "Usage",
  "loc.44621c": "{p0} setting(s)",
  "loc.e01524": "Phase out",
  "loc.1a1a97": "Reactivate",
  "loc.88cb27": "Note (optional)",
  "loc.443e0a": "Check and create",
  "loc.7ae5b1": "Note",
  "nprev.a50d91": "Preview",
  "nprev.08fd3e": "not connected",
  "abar.5262ab": "Click: open the alarms tab",
  "abar.ae4f82": "{p0} warning(s)",
  "sett.c2ca16": "Host",
  "sett.4c94fe": "Orchestrator",
  "sett.0cc091": " (remote host)",
  "sett.b36046": " \xB7 restart needed",
  "sett.eba8ae": "Node default",
  "sett.545dfe": "Type value",
  "sett.eb6d8a": "Default",
  "sett.6c3a69": "Node",
  "sett.ef891c": "Settings could not be loaded.",
  "sett.435a5a": "Error {p0}",
  "sett.473549": "Request failed: {p0}",
  "sett.808dfe": "{p0}\n\nSave anyway (e.g. the path only exists on a remote host)?",
  "sett.fad7a2": " Note: {p0}",
  "sett.688b22": " {p0} running instance(s) need a restart (System update \u2192 \u201CRestart outdated instances\u201D, or restart the instance).",
  "sett.948895": "\u201C{p0}\u201D saved \u2014 effective after the next orchestrator restart.",
  "sett.27014d": "Settings",
  "sett.089fb5": "Settings that so far could only be set via environment variables are managed here. Changes to node options apply ",
  "sett.347f18": "to newly started instances (running ones show \u201Coutdated\u201D until restarted); orchestrator operating values apply after its restart. ",
  "sett.3ef13f": "Secrets and infrastructure access (JWT, TLS, database) are deliberately not changeable here.",
  "sett.3287f2": "Node options",
  "sett.33e760": "No node types with options (deploy/node-options.json).",
  "sett.b66666": "All instances of this type (default)",
  "sett.12915a": "Instance only: {p0}{p1}{p2}",
  "sett.dbc566": "Type:",
  "sett.695edd": "Applies to:",
  "sett.7f769f": "Restart needed for: {p0} \u2014 the changed values only apply there after a restart.",
  "sett.a664c2": "Note: on remote hosts the host agent checks every value itself against ITS schema (node-options.json next to its catalog) and ITS file system; ",
  "sett.a3ccd7": "variables not declared there are ignored. Paths apply there \u2014 \u201CCheck path\u201D asks the host for a remote instance.",
  "sett.b97d23": "Save",
  "sett.02fa34": "Reset",
  "sett.3e3767": "Choose storage location \u2026",
  "sett.5fc6ec": "Check path",
  "sett.c21537": "No path given.",
  "sett.a85e64": "Checking \u2026",
  "sett.f3de9d": "Check failed.",
  "sett.c97fd8": "Orchestrator (operating values)",
  "sett.cd73c1": "Loading \u2026",
  "sett.17a397": "Overrides were discarded at the last start:\n{p0}",
  "sett.a51de6": "Start configuration (read-only, secrets masked)",
  "sett.ef8d9d": "{p0} Active: {p1}{p2} \xB7 allowed {p3}\u2013{p4}",
  "sched.13ac40": "still running",
  "sched.4ff5c9": "later",
  "sched.17d70d": "earlier",
  "sched.0d9d6e": "daily",
  "sched.b7ca91": "weekly",
  "sched.mv.extend": "Move end (extend/shorten)",
  "sched.mv.start": "Move start",
  "sched.mv.move": "Move",
  "sched.mv.confirm": '"{p0}": {p1}\nWas {p2} \u2192 now {p3}.\nApply?',
  "sched.mv.ok": "Apply",
  "sched.stopNow": "End now",
  "sched.stopNow.confirm": 'End "{p0}" right now? The schedule stays unchanged.',
  "sched.616d9c": "Saving failed: {p0}",
  "sched.982fb6": "No workflows available.",
  "sched.ffaac1": "Scheduler",
  "sched.c10105": "Day",
  "sched.14098f": "Week",
  "sched.1570ac": "Month",
  "sched.02afda": "Today",
  "sched.5f42f2": "Drag onto an empty spot of a row to create a schedule",
  "sched.d050aa": "Drag new as:",
  "sched.880a4f": "Auto pool",
  "sched.1dc921": "Resources (preview while dragging)",
  "sched.7ff6ed": "Resources (planned)",
  "sched.f7d87d": "Bottleneck",
  "sched.f6db1b": "Demand/capacity unknown",
  "sched.0c6e43": "Planned demand = measured profile per node type (CPU: 95th percentile, RAM: maximum) of all workflows running at that time, ",
  "sched.449b97": "against the capacity of the host. Roles without a measured profile are hatched (demand unknown, not zero).",
  "sched.569499": "Without host assignment (auto placement)",
  "sched.446205": "{p0} cores",
  "sched.6a3c1a": "Network {p0} per direction",
  "sched.0595be": "Sum of all reachable hosts: ",
  "sched.22b4a1": "Capacity unknown",
  "sched.95c28d": "Snapshot of the current load (not the plan)",
  "sched.ed7157": "now: CPU {p0} % \xB7 RAM {p1} %",
  "sched.92e155": "No bottleneck. Free headroom (up to threshold), minimum in the visible range: ",
  "sched.a161c7": "{p0} network",
  "sched.a98328": "Network",
  "sched.cddb50": "{p0} \xB7 CPU {p1} of {p2} cores",
  "sched.c3b17e": " \xB7 free up to threshold: {p0} cores",
  "sched.21a957": "{p0} \xB7 RAM {p1} of {p2}",
  "sched.c19736": " \xB7 free up to threshold: {p0}",
  "sched.0a7180": "{p0} \xB7 GPU {p1} % of {p2}",
  "sched.bd46bd": " \xB7 free up to threshold: {p0} %",
  "sched.7d0cfb": " \xB7 no NVIDIA GPU detected (nvidia-smi unavailable; host agent: OMP_HOST_AGENT_GPU_INDEX not set to off?)",
  "sched.3bb3f9": "\n(100 % = one full GPU; demand only for types with a measured GPU profile)",
  "sched.560b4b": "{p0} \xB7 VRAM {p1} of {p2}",
  "sched.0818ec": " \xB7 no host with a reported GPU",
  "sched.f36f2d": "\n(VRAM is a hard limit: overflow kills processes)",
  "sched.ab0c20": " of {p0} per direction",
  "sched.f154b0": " \xB7 NIC link speed unknown (host agent: set OMP_HOST_AGENT_NET_IFACE)",
  "sched.130aa4": "\n~ = assumption (role format not set: 1080p50, or nominal value)",
  "sched.f6ba17": "{p0} \xB7 {p1}: {p2} of {p3} port(s) in use \xB7 free: {p4}",
  "sched.f333a8": " cores",
  "sched.72ce72": "Network",
  "sched.5baf86": "\n\u26A1 value = currently measured host load (higher than the plan)",
  "sched.ce7463": "\n\u26A0 Demand unknown (no measured profile): {p0}",
  "sched.fd07d2": "\n(worst time of the day)",
  "sched.19706e": "{p0} h {p1} min",
  "sched.ed6c70": "manually",
  "sched.6131ad": "by schedule",
  "sched.96f435": "adopted",
  "sched.e8da08": "found at orchestrator start",
  "sched.d9d61d": "stopped manually",
  "sched.58740c": "stopped by schedule",
  "sched.e98ab7": "End not observed",
  "sched.f621af": "Run: {p0} ({p1}) \u2192 {p2}",
  "sched.23c086": "Duration: {p0}",
  "sched.b3259b": "Planned: {p0} \u2192 {p1}",
  "sched.722ee1": "Start {p0} {p1} than planned",
  "sched.ec6aed": "\u26A0 {p0} ended before the planned stop",
  "sched.700ecf": "{p0} ended after the planned stop",
  "sched.05f798": "Drag onto an empty spot: create a new schedule",
  "sched.162657": "Add schedule",
  "sched.71a8aa": "Start {p0}",
  "sched.9ed479": "no start",
  "sched.c1e806": "Stop {p0}",
  "sched.a3a320": "no stop",
  "sched.a6122a": "Start",
  "sched.11a755": "Stop",
  "sched.48bff0": "\u26A0 Resource bottleneck caused by this change: {p0}",
  "sched.4c2f74": "Create schedule: {p0}",
  "sched.9c3ca2": "Once on {p0}",
  "sched.045d26": "Daily",
  "sched.e50e76": "Weekly ({p0})",
  "sched.9a6ec4": " (saved as 23:59)",
  "sched.5daac8": "Duration",
  "sched.d86ee9": "Network {p0}{p1}{p2}",
  "sched.b61145": "Demand",
  "sched.ab1867": "\u26A0 {p0} of {p1} role(s) without a measured profile \u2014 demand incomplete",
  "sched.ba0c15": "\u2713 no new resource bottleneck in the visible range",
  "sched.4b9727": "Cancel",
  "sched.6212ff": "Create",
  "wf.dd4edc": "Control room",
  "wf.324118": "Input",
  "wf.29c2c0": "Output",
  "wf.b22f04": "Audio",
  "wf.34e2d1": "Video",
  "wf.e64b29": "Graphics",
  "wf.81c1cc": "Data",
  "wf.9090e4": "Control",
  "wf.2dc84a": "host fixed",
  "wf.24eb99": "Workflow name is required.",
  "wf.b97d23": "Save",
  "wf.6212ff": "Create",
  "wf.b5f13f": "Really stop workflow \u201C{p0}\u201D?",
  "wf.4c4650": "Stop",
  "wf.drift1": "Warning: for these roles the current state differs from the saved start state: {p0}.\nWhen stopped, the next start uses the SAVED state \u2014 your changes since saving will be lost.\n(Cancel and use \u201CSave in workflow\u201D to keep the current state.)",
  "wf.drift2": "Stop anyway",
  "wf.2fcdd3": "Stopping failed: {p0}",
  "wf.a85624": "Really pause workflow \u201C{p0}\u201D?",
  "wf.d63f99": "Pause",
  "wf.a73f32": "Pausing failed: {p0}",
  "wf.43069e": "Export failed: {p0}",
  "wf.8a7bae": "Duplicating failed: {p0}",
  "wf.7d5095": "Workflow duplicated as \u201C{p0}\u201D.",
  "wf.e7dba3": "Import failed: file is not valid JSON ({p0})",
  "wf.6cdb17": "Import failed: {p0}",
  "wf.db21f2": "Workflow \u201C{p0}\u201D imported.",
  "wf.05f6da": "Deleting failed: {p0}",
  "wf.8a9663": "Workflows ({p0})",
  "wf.8df699": "+ New",
  "wf.881fa7": "Design graphically",
  "wf.5af5fb": "Import",
  "wf.b7d029": "Only useful for export\u2192import on the same system (same user accounts) \u2014 ",
  "wf.196e31": "an export to another system stays portable without this option.",
  "wf.937351": "Export role bindings and alert rules too",
  "wf.ad8902": "No workflow created yet.",
  "wf.bd4e9e": "No workflow matches the current filter.",
  "wf.4d0c9d": "Search (title, description, tags) \u2026",
  "wf.111336": "All categories",
  "wf.bcec0a": "All statuses",
  "wf.91d470": "Confirmation when stopping",
  "wf.7b3fe9": "Latency budget {p0} frames",
  "wf.46f0b8": "{p0} schedule{p1}",
  "wf.527daf": "Resume",
  "wf.a6122a": "Start",
  "wf.11a755": "Stop",
  "wf.5ad05d": "Edit",
  "wf.f7bfda": "Stop/pause first, then edit",
  "wf.971a83": "Edit graphically",
  "wf.1010b0": "Delete",
  "wf.bc9ab0": "Stop/pause first, then delete",
  "wf.8721fc": "Export",
  "wf.529fdd": "Duplicate",
  "wf.5e9890": "Creates a copy of this workflow (stopped, new name).",
  "wf.a12710": "Edit workflow",
  "wf.dfb7da": "Create new workflow",
  "wf.8311b9": "Close",
  "wf.b2d236": "Workflow name",
  "wf.3b82d6": "Catalog metadata (optional)",
  "wf.a964f6": "Title (fallback: workflow name)",
  "wf.35bedb": "Description",
  "wf.ed8a68": "Tags (comma-separated)",
  "wf.f8c1f7": "Category \u2026",
  "wf.bbef58": "Roles & connections: {p0} role(s), {p1} connection(s)",
  "wf.6d7c2c": "Roles & connections: no role created yet",
  "wf.276af7": "Edit graphically \u2192",
  "wf.17c01d": "Programme format (optional)",
  "wf.5be567": "Programme format of the workflow \u2014 empty leaves every node at its own default.",
  "wf.d6aaa2": "Node default (no programme format)",
  "wf.f64b3f": "Latency budget in video frames (optional)",
  "wf.741ee9": "Scheduling (optional)",
  "wf.ec5db6": "+ Schedule",
  "wf.b7d530": "Require confirmation when stopping",
  "wf.0d9d6e": "daily",
  "wf.b7ca91": "weekly",
  "asset.311f64": " of v{p0}",
  "asset.ad67a7": "Draft",
  "asset.1806d2": "published",
  "asset.e9e284": "Publish",
  "asset.f19dbc": "Archive",
  "asset.a7f595": "{p0}: the asset was changed in the meantime \u2014 view reloaded, please try again.",
  "asset.a1f55a": "{p0}: this version is no longer a draft and therefore immutable \u2014 please create a new version.",
  "asset.22aa79": "{p0}: no permission.",
  "asset.6212ff": "Create",
  "asset.f4379f": "Asset \u201C{p0}\u201D created.",
  "asset.f5ce47": "Mark asset \u201C{p0}\u201D as deleted? This is a final state \u2014 it cannot be undone.",
  "asset.1010b0": "Delete",
  "asset.a0ba57": "Status change",
  "asset.d9a5d0": "Status: {p0}",
  "asset.d6ea46": "Save metadata",
  "asset.5156b5": "Metadata saved.",
  "asset.78e208": "Create version",
  "asset.c3b3be": "Version v{p0} created (draft).",
  "asset.aa9c03": "Publish v{p0}? Afterwards the version is immutable and becomes the current version of the asset.",
  "asset.969e32": "v{p0}: {p1} done.",
  "asset.d6bd6d": "Create representation",
  "asset.82ffcd": "Representation created.",
  "asset.bcaf91": "Remove representation \u201C{p0}\u201D ({p1})?",
  "asset.513d30": "Remove",
  "asset.635d5f": "Remove representation",
  "asset.a2d14c": "Creating collection failed: {p0}",
  "asset.8e4d30": "Collection \u201C{p0}\u201D created.",
  "asset.616d9c": "Saving failed: {p0}",
  "asset.314d13": "Collection updated.",
  "asset.295f4a": "Delete collection \u201C{p0}\u201D? The contained assets remain unchanged.",
  "asset.05f6da": "Deleting failed: {p0}",
  "asset.3f05b9": "Adding failed: {p0}",
  "asset.64bd21": "Removing failed: {p0}",
  "asset.094e46": "Creating relation failed: {p0}",
  "asset.9c121d": "Relation created.",
  "asset.fd5d3f": "Remove this relation?",
  "asset.8df699": "+ New",
  "asset.9aedea": "Assets",
  "asset.a9fc91": "Collections",
  "asset.e603cf": "+ New collection",
  "asset.436362": "Search (title, description, type, metadata) \u2026",
  "asset.purge": "Clean up deleted ({p0})",
  "asset.purge.title": "Permanently remove assets marked as deleted (with versions, representations, review data and proxies; source files stay)",
  "asset.purge.confirm": "Permanently remove {p0} deleted assets? This cannot be undone. Their versions, representations, QC reports and proxies are removed with them; the source files on disk stay untouched.",
  "asset.purge.ok": "Remove permanently",
  "asset.purge.done": "{p0} assets removed",
  "asset.purge.what": "Clean up",
  "asset.7cf160": "Show deleted",
  "asset.189c03": "All types",
  "asset.bcec0a": "All statuses",
  "asset.81c00b": "Assets ({p0})",
  "asset.030c2c": "Assets ({p0} of {p1})",
  "asset.d82a29": "No asset created yet.",
  "asset.134dba": "No asset matches the filter.",
  "asset.4f17fd": "Collections ({p0})",
  "asset.3c636c": "No collection created yet \u2014 create the first one with \u201C+ New collection\u201D.",
  "asset.fc1c89": "Select an asset on the left or create one with \u201C+ New\u201D.",
  "asset.c90ab1": "Select a collection on the left or create one with \u201C+ New collection\u201D.",
  "asset.ce0116": "\n        Created by {p0} on {p1}\n      ",
  "asset.5ad05d": "Edit",
  "asset.6a7843": "Members ({p0})",
  "asset.a88ee3": "+ Add asset",
  "asset.046622": "No asset in this collection yet.",
  "asset.074891": "Relations ({p0})",
  "asset.d19df7": "No relation to other assets (e.g. \u201Cderived from\u201D, \u201Cpart of\u201D).",
  "asset.565da9": "Linked process runs{p0} ({p1})",
  "asset.a6915d": "Select a version first.",
  "asset.8599a1": "No process run linked. Linking is done in the Processes tab on the respective execution.",
  "asset.9f8ebb": "\n        Type {p0} \xB7 current version {p1} \xB7\n        created by {p2} on {p3} \xB7\n        last changed by {p4} on {p5}\n      ",
  "asset.d3fbe7": "Change status:",
  "asset.6e8ae6": "Final state \u2014 no further status changes.",
  "asset.154818": "Metadata",
  "asset.efacd0": "No metadata yet.",
  "asset.54741f": "Versions ({p0})",
  "asset.d3bb06": "+ New version",
  "asset.0ac367": "No version yet \u2014 a version bundles the technical files (representations) of one state.",
  "asset.ec53a8": "Status",
  "asset.9bc05d": "Base",
  "asset.14ad87": "Reason for change",
  "asset.2c51ef": "Created",
  "asset.49fb73": "\u2605 = current version. Click a row to see its representations.",
  "asset.199987": "Representations{p0} ({p1})",
  "asset.6a2235": "Create a version first.",
  "asset.a59590": "v{p0} is {p1} and therefore immutable \u2014 create a new version for other files.",
  "asset.7f6a70": "No representations (e.g. master, proxy, thumbnail).",
  "asset.c2ea84": "Type",
  "asset.601a93": "Storage location",
  "asset.5f06f4": "Technical",
  "asset.4b9727": "Cancel",
  "asset.e2fe67": "New asset",
  "asset.c9d8af": "e.g. video",
  "asset.18a802": "Title",
  "asset.45befe": "Title *",
  "asset.c8e212": "Type *",
  "asset.344254": "Free value \u2014 suggestions via arrow keys.",
  "asset.35bedb": "Description",
  "asset.00b84d": "Title and type are required.",
  "asset.b49ee1": "Edit collection",
  "asset.9ee309": "New collection",
  "asset.b97d23": "Save",
  "asset.6699b7": "Title is required.",
  "asset.c68bfe": "Add asset to \u201C{p0}\u201D",
  "asset.0ce4cb": "\u2013 no further asset available \u2013",
  "asset.26e905": "Asset",
  "asset.5f4110": "Add",
  "asset.20f3e9": "No asset selected.",
  "asset.7963f5": "Relation from \u201C{p0}\u201D",
  "asset.398542": "Direction",
  "asset.323d87": "Other asset *",
  "asset.aa0d98": "Kind of relation *",
  "asset.205050": "Other asset and kind of relation are required.",
  "asset.7114fa": "New version",
  "asset.d4746f": "\u2013 none (independent state) \u2013",
  "asset.b9f0e4": "e.g. new colour grade",
  "asset.060e7f": "Based on",
  "asset.c7688e": "The new version starts as a draft; representations are added to it, then it is published.",
  "asset.ea7ae7": "Representation for v{p0}",
  "asset.6008d4": "e.g. master",
  "asset.6fc755": "/media/clip.mov or s3://bucket/key",
  "asset.1b3b2a": "Storage *",
  "asset.6a54d0": "Path/URI *",
  "asset.ceab9e": "Technical details (optional)",
  "asset.520d0d": "Format",
  "asset.8ca990": "Codec",
  "asset.0e7278": "Container",
  "asset.f04780": "Width (px)",
  "asset.4572e8": "Height (px)",
  "asset.f5a3b3": "Frame rate (fps)",
  "asset.ea2e71": "Sample rate (Hz)",
  "asset.45cef4": "Channels",
  "asset.39f415": "Bitrate (bit/s)",
  "asset.3d5734": "Size (bytes)",
  "asset.efd646": "Checksum",
  "asset.4d3ebb": "Type, storage and path/URI are required.",
  "asset.1159be": "{p0}: not a valid {p1}number.",
  "asset.b1d04a": "Metadata: {p0}",
  "asset.6d686f": "Field name",
  "asset.48bce5": "JSON value",
  "asset.5a597b": "Value",
  "asset.fc9b0f": "Structured value (number/yes-no/list) \u2014 edit as JSON",
  "asset.53f0ae": "Remove field",
  "proc.11386c": "Assigned: {p0}",
  "proc.83d9fd": "Unassigned",
  "proc.d3e635": "Last changed",
  "proc.49ee30": "Name",
  "proc.62c21d": "Created by",
  "proc.ec53a8": "Status",
  "proc.73f8e4": "Permanently delete process \u201C{p0}\u201D with all versions and the execution history?",
  "proc.1010b0": "Delete",
  "proc.05f6da": "Deleting failed: {p0}",
  "proc.862e41": "Process \u201C{p0}\u201D deleted.",
  "proc.055ecb": "Creating failed: {p0}",
  "proc.efc8c6": "Process definition created.",
  "proc.9c01ed": "Creating version failed: {p0}",
  "proc.62626a": "Version created{p0}.",
  "proc.433ea0": "Invalid input JSON: {p0}",
  "proc.f6d6b4": "Start failed: {p0}",
  "proc.38419a": "Execution started.",
  "proc.ba4a47": "Linking failed: {p0}",
  "proc.e14b84": "Asset linked.",
  "proc.64bd21": "Removing failed: {p0}",
  "proc.ca6fd6": "Assigning failed: {p0}",
  "proc.fc886f": "Action failed: {p0}",
  "proc.8df699": "+ New",
  "proc.cbb97d": "Search (name, category, description, user) \u2026",
  "proc.2c9513": "Sort:",
  "proc.5adedc": "Processes ({p0})",
  "proc.dbd8d0": "Processes ({p0} of {p1})",
  "proc.f07b49": "No process definition created yet.",
  "proc.b2e353": "No process matches the filter.",
  "proc.0d7ac2": "Select a process definition on the left.",
  "proc.a75bfb": "\n          Created by {p0} on {p1}\n        ",
  "proc.e524e0": "Delete process",
  "proc.4a833e": "Deletes the process with all versions and the history (not possible while executions are running)",
  "proc.54741f": "Versions ({p0})",
  "proc.d3bb06": "+ New version",
  "proc.72fc01": "No version yet.",
  "proc.b9b524": "Start step",
  "proc.2c51ef": "Created",
  "proc.5ad05d": "Edit",
  "proc.6e31cb": "Opens v{p0} in the graphical editor \u2014 saving creates a new draft version",
  "proc.e9e284": "Publish",
  "proc.f19dbc": "Archive",
  "proc.f50fc9": "Start",
  "proc.ba1f4c": "Deprecate",
  "proc.d8cfda": "Executions ({p0})",
  "proc.b36d04": "No execution yet.",
  "proc.bdff97": "Started",
  "proc.e5a557": "Completed",
  "proc.4b9727": "Cancel",
  "proc.d63f99": "Pause",
  "proc.527daf": "Resume",
  "proc.84f4b2": "\n      Steps{p0}\n    ",
  "proc.a2a88e": "Human tasks of this execution",
  "proc.718f46": "Linked assets ({p0})",
  "proc.c63d58": "+ Link asset",
  "proc.626cee": "No asset version linked \u2014 e.g. a file this run read or produced.",
  "proc.513d30": "Remove",
  "proc.8500e1": "Link asset",
  "proc.1fdf08": "Links an asset version to this execution \u2014 e.g. a file this run read (input) or produced (output).",
  "proc.e24d2a": "\u2013 choose asset \u2013",
  "proc.e9c23c": "\u2013 loading \u2026 \u2013",
  "proc.09aee0": "\u2013 no version available \u2013",
  "proc.1b0fe9": "\u2013 choose an asset first \u2013",
  "proc.45e007": "Output \u2014 produced by this run",
  "proc.c36918": "Input \u2014 read by this run",
  "proc.2c7495": "Link",
  "proc.db8c44": "Please choose an asset and a version.",
  "proc.a6fed1": "My human tasks ({p0})",
  "proc.2084fb": "Claim for me",
  "proc.bc0a4d": "Approve",
  "proc.5e17b3": "Reject",
  "proc.c4ca49": "Request changes",
  "proc.8435ef": "Comment (optional):",
  "proc.47c409": "New process definition",
  "proc.31805a": "Category (optional)",
  "proc.234de2": "Description (optional)",
  "proc.6212ff": "Create",
  "proc.681403": "Name is required.",
  "proc.d1ceb6": "Start execution",
  "proc.ad18ad": "Input as JSON (optional, leave empty for no input).",
  "flow.49602e": "unknown error",
  "flow.90e2ce": "MXL is host-local \u2014 use an ST-2110/SRT gateway (D4) across host boundaries",
  "flow.616b70": "Layout could not be saved: {p0}",
  "flow.6b0072": "{p0} crashed: {p1}",
  "flow.a2865c": "{p0} restarted automatically (restart #{p1})",
  "flow.879697": "Host no longer reachable",
  "flow.08e5ad": "Process crash",
  "flow.20b36c": "Role \u201C{p0}\u201D switched to standby ({p1})",
  "flow.b40ef3": "Orchestrator host (local)",
  "flow.02d6ca": "Unassigned",
  "flow.28a45c": "Groups across several hosts",
  "flow.ef06dd": "Workflow not found.",
  "flow.ea2b0e": "Workflow \u201C{p0}\u201D is currently \u201C{p1}\u201D \u2014 wait a moment and try again.",
  "flow.a7431c": "Discard unsaved changes?",
  "flow.3a12ad": "Disconnect",
  "flow.26927b": "Click a target role to connect (or click here to cancel) \u2014 drag to move",
  "flow.26ea5c": "Click, then click a target role to connect \u2014 drag to move",
  "flow.50a83a": "Double-click to rename \u2014 this name appears as the sender/crosspoint label (user request 2026-07-30: speaking names).",
  "flow.fc94ec": "Remove role",
  "flow.19bea4": "A workflow needs at least one role.",
  "flow.a65046": 'Name "{p0}" is already taken or invalid.',
  "flow.50ba57": "Connection already exists.",
  "flow.616d9c": "Saving failed: {p0}",
  "flow.00d76f": "Workflow saved.",
  "flow.b2892b": "Saving into the workflow is not possible \u2014 no launcher instance (not started via the catalog): {p0}",
  "flow.303686": "No savable nodes in this workflow.",
  "flow.3fa58b": "Workflow saved (takes effect at the next start).",
  "flow.224cb4": "{p0} \u2014 double-click to edit",
  "flow.010533": "Edit (live): {p0}",
  "flow.f3e350": "Edit: {p0}",
  "flow.de024d": "Auto-arrange",
  "flow.486700": "Arrange tiles by signal flow \u2014 sources left, sinks right.",
  "flow.b97d23": "Save",
  "flow.27e3d2": "No unsaved changes",
  "flow.save_live_state": "Also saves the current state of the nodes (pattern, keyer, channels \u2026) as the start state",
  "flow.82f357": "Leave",
  "flow.05b4ea": "Fit all",
  "flow.9f38fa": "In host view the host zones determine the layout.",
  "flow.981290": "Host view: on",
  "flow.7818c8": "Host view: off",
  "flow.5c618d": "Ungroup",
  "flow.1b8280": "Save as workflow",
  "flow.566f18": "Group name:",
  "flow.14466a": "New group",
  "flow.ec7506": "The group contains no nodes.",
  "flow.2bd04d": "Saving as a workflow is not possible \u2014 no launcher instance (not started via the catalog): {p0}",
  "flow.dc80a2": "Saving as a workflow failed: {p0}",
  "flow.bec446": "Workflow \u201C{p0}\u201D created and already running (taken over from the running group).",
  "flow.514366": "Host online",
  "flow.eda8d2": "Host offline \u2014 last seen {p0}",
  "flow.61ea4b": "Host offline \u2014 no telemetry received",
  "flow.1efb39": "Offline \xB7 last seen {p0}",
  "flow.7bb93c": "Offline \xB7 no telemetry",
  "flow.17b308": "Planned (not started)",
  "flow.4d543b": "{p0} tiles",
  "flow.8f9c92": "Expand zone",
  "flow.f98ead": "Collapse zone",
  "flow.db1020": "Drag to resize",
  "flow.abd1ab": "Part of the currently shown trace (diagnostics cockpit, ARCHITECTURE.md \xA725.3).",
  "flow.tallyFrom": "On air via: {p0}",
  "flow.25b847": "Standby (warm) \u2014 takes over automatically if the primary role fails (K7 part 4).",
  "flow.0fb497": "Stop instance",
  "flow.3c5208": "Stop workflow",
  "flow.a50d91": "Preview",
  "flow.08fd3e": "not connected",
  "flow.7cfa62": "No other host available.",
  "flow.3d4180": "Move \u201C{p0}\u201D to \u201C{p1}\u201D? The instance is stopped and restarted there; existing connections are restored where possible.",
  "flow.cc0806": "Move",
  "flow.f6dbd5": "Move failed: {p0}",
  "flow.e16d95": "Move role \u201C{p0}\u201D to \u201C{p1}\u201D? A new instance starts there, operating state/connections are taken over \u2014 only then is the old instance stopped.",
  "flow.07f4ca": "Role move failed: {p0}",
  "flow.c23a7f": "Open diagnostics",
  "flow.eeaf61": "Connection failed: {p0}",
  "flow.e6871e": "Disconnect failed: {p0}",
  "flow.3b7344": "Loading\u2026",
  "flow.c9533f": "View as operator \u2197",
  "flow.d7db68": "Descriptor could not be loaded: {p0}",
  "flow.6f8bd9": "Role target format",
  "flow.386c76": "Node default",
  "flow.c3d104": "Apply (restart node)",
  "flow.dbf07d": 'Restart role "{p0}" with the new format? The node is briefly unreachable, the rest of the workflow keeps running.',
  "flow.7b8028": "Restart failed: {p0}",
  "flow.459c64": 'Role "{p0}" is being restarted with the new format \u2026',
  "flow.502f11": "Sync source: {p0}",
  "flow.ab3278": "Changing auto-reset failed: {p0}",
  "flow.30f273": "Auto-reset",
  "flow.68212a": "Changing delay failed: {p0}",
  "flow.7b2ec4": "Delay (ms)",
  "flow.e4dd8e": "Reset counters",
  "flow.926b5a": "Reset failed: {p0}",
  "flow.418e13": "Parameter \u201C{p0}\u201D failed: {p1}",
  "flow.a5a7f7": "Value for \u201C{p0}\u201D ({p1}):",
  "flow.f19b62": "Method \u201C{p0}\u201D failed: {p1}",
  "flow.1644b5": "Apply scene",
  "flow.0087f5": "Applying snapshot failed: {p0}",
  "flow.28c94f": "Snapshot applied with {p0} error(s)",
  "flow.322f5f": "Node catalog",
  "flow.191493": "Catalog empty.",
  "flow.26fdfa": "Search\u2026",
  "flow.c977e2": "No matches.",
  "flow.ada9a7": "Target host",
  "flow.390d13": "\u25CB {p0} (offline)",
  "flow.b6057c": "Demand unknown (first start of this type)",
  "flow.bd6623": " (type estimate, no value for this host)",
  "flow.3cfe9b": "\u21BB restarted automatically {p0}\xD7",
  "flow.f1da4b": "Host: {p0}",
  "flow.03a35d": "Process crashed",
  "flow.513d30": "Remove",
  "flow.11a755": "Stop",
  "flow.f6d6b4": "Start failed: {p0}",
  "flow.f0052e": "{p0} is starting \u2026",
  "flow.cb1616": "Really stop instance \u201C{p0}\u201D?",
  "flow.4c4650": "Stop",
  "flow.confirmStartNode": "Really start node \u201C{p0}\u201D?",
  "inst.actions": "Actions",
  "inst.rename": "Rename",
  "inst.migrate": "Move \u2026",
  "inst.save": "Save",
  "inst.cancel": "Cancel",
  "inst.renameTitle": "Change display name (instance ID stays)",
  "inst.migrateTitle": "Move instance to another host",
  "inst.renameFailed": "Rename failed: {p0}",
  "inst.migrateFailed": "Move failed: {p0}",
  "inst.confirmMigrate": 'Move instance "{p0}" to host "{p1}"?',
  "inst.confirmMigrateLabel": "Move",
  "inst.localHost": "local",
  "inst.renameNotApplied": "Name saved, but the node is unreachable or cannot apply it live yet \u2014 it takes effect after the next restart.",
  "flow.nameOptional": "Name (optional)",
  "flow.nodeSearch.placeholder": "Find node\u2026",
  "flow.nodeSearch.none": "No node found",
  "flow.nodeSearch.hidden": "Node \u201C{p0}\u201D belongs to a running workflow and is hidden in this view.",
  "flow.nodeSearch.title": "Find node",
  "psc.target.placeholder": "empty = default from the job settings",
  "psc.target.label": "Execution location (ffmpeg/ffprobe)",
  "psc.target.help": "Where the step runs: empty = default (Administration \u2192 ffmpeg jobs), auto = by load, local = orchestrator machine, host:<id>, pool:<name>.",
  "topo.title": "Host topology",
  "topo.hint": "Boxes are hosts with their nodes, lines are connections between hosts (number = connections, thickness grows with it). Connections inside a host are listed in its box. The vertical mark in the CPU bar is the limit above which jobs no longer start (live reserve). Click a box to see its history below.",
  "hosts.clock.badge": "Clock",
  "hosts.clock.unsynced": "This host's system clock is not synchronised (NTP/PTP): time error up to {err} \xB5s, switch times and MXL timestamps differ from other hosts.",
  "hosts.clock.tai": "The system clock's TAI offset is not set (CLOCK_TAI equals UTC, currently 37 s off): MXL timestamps and switch times do not match other hosts. Set it with chrony (`leapsectz`/`tai`) or ptp4l.",
  "hosts.clock.unsynced+tai": "The system clock is neither synchronised (NTP/PTP) nor has its TAI offset set: MXL timestamps and switch times differ from other hosts.",
  "hosts.clock.fix.no-permission": "The machine tried to set its own clock but is not allowed to (CAP_SYS_TIME missing): run as root, set AmbientCapabilities=CAP_SYS_TIME in the systemd unit, or install chrony.",
  "hosts.clock.fix.no-server": "The machine tried to set its own clock but no NTP server answered (check OMP_CLOCK_NTP_SERVERS).",
  "topo.none": "No hosts or nodes yet.",
  "topo.local": "Orchestrator host",
  "topo.extern": "No instance (external)",
  "topo.offline": "offline",
  "topo.maintenance": "maintenance",
  "topo.nodes": "{p0} nodes",
  "topo.more": "+{p0} more",
  "topo.internal": "{p0} internal connections",
  "topo.jobs": "jobs {p0}",
  "topo.linkTitle": "{p0} \u2192 {p1}: {p2} connection(s) ({p3})",
  "trend.title": "History",
  "trend.host": "Host",
  "trend.metric.cpu": "CPU",
  "trend.metric.mem": "RAM",
  "trend.metric.live": "Live nodes (CPU)",
  "trend.metric.gpu": "GPU",
  "trend.metric.temp": "Temperature",
  "trend.metric.power": "Power",
  "trend.note.temp": "CPU/platform temperature of the host in \xB0C (only hosts with a sensor; alert above OMP_ALERT_TEMP_C).",
  "trend.note.power": "Power draw in watts: CPU package (RAPL) or whole device on battery (only if the host reports it).",
  "trend.metric.net": "Network",
  "trend.collecting": "Still collecting measurements.",
  "trend.noData": "No measurements for this quantity (not measured).",
  "trend.reserveLimit": "jobs start only below {p0} %",
  "trend.peak": "peak",
  "trend.note.cpu": "Total host load; line = average, band = up to the peak.",
  "trend.note.mem": "Used memory in % of the host.",
  "trend.note.live": "CPU share of nodes started by the orchestrator or host agent (without ffmpeg jobs) \u2014 basis of the live-reserve auto-calibration.",
  "trend.note.gpu": "Utilisation of the configured GPU (only with OMP_HOST_AGENT_GPU_INDEX).",
  "trend.note.net": "Network card utilisation in % of link speed (only when known).",
  "alarms.predicted": "{p0}: trend \u2014 the host is expected to reach its limit in about {p1} min (now CPU {p2} % / RAM {p3} %), {p4} instance(s) affected \u2014 {p5}",
  "hosts.predicted": "{p0}: trend \u2014 the host is expected to reach its limit in about {p1} min (now CPU {p2} % / RAM {p3} %), {p4} instance(s) affected \u2014 {p5}",
  "hosts.predictedBadge": "Early warning",
  "flow.nameOptionalTitle": 'Custom display name for the instance (empty = automatic "Type (short ID)"). The instance ID is unaffected.',
  "inst.restart": "Restart",
  "inst.restartTitle": "Stop and restart the node process (this instance's output is interrupted)",
  "inst.confirmRestart": `Really restart instance "{p0}"? This node's running output will be briefly interrupted.`,
  "inst.confirmRestartLabel": "Restart",
  "inst.restartFailed": "Restart failed: {p0}",
  "inst.restarted": '"{p0}" was restarted.',
  "flow.sd.title": "Start node: {p0}",
  "flow.sd.startBtn": "Start \u2026",
  "flow.sd.addRoleBtn": "Add as role",
  "flow.sd.running": "{p0} running",
  "flow.sd.name": "Name (optional)",
  "flow.sd.namePh": "automatic",
  "flow.sd.nameHint": "Shown on the tile and in the crosspoint matrix. Empty = automatic name with short ID.",
  "flow.sd.local": "(local)",
  "cc.title": "Card and connectors",
  "cc.none": "No capture cards were detected on this host.",
  "cc.unnamed": "Capture card",
  "cc.selectAll": "Select all free",
  "cc.connector": "Connector {p0}",
  "cc.in": "Input",
  "cc.out": "Output",
  "cc.noIn": "no input",
  "cc.noOut": "no output",
  "cc.both": "Input and output (duplex)",
  "cc.remove": "Remove",
  "cc.removeTitle": "Remove this manually added device from the list (only when no connector is in use)",
  "cc.manual": "Add a card without automatic detection (Matrox xMIO / DSX LE5)",
  "cc.manualHint": "Matrox ships no public GStreamer plugin and no device query. Create your card's connectors here; operation needs a plugin built on the Matrox SDK on the host.",
  "cc.manualName": "Name, e.g. xMIO3",
  "cc.manualCount": "Connectors:",
  "cc.manualAdd": "Add",
  "cc.kindDuplex": "Input and output (duplex)",
  "cc.kindIn": "input only",
  "cc.kindOut": "output only",
  "cc.elements": "GStreamer elements of the Matrox plugin",
  "cc.elementsHint": "Four element names, comma separated: video source, audio source, video sink, audio sink.",
  "cc.free": "free",
  "cc.used": "in use ({p0})",
  "cc.pick": "Choose at least one connector. Duplex connectors provide input and output at the same time.",
  "cc.summary": "Selected: {p0} input(s), {p1} output(s) \u2014 all in one instance.",
  "cc.needHost": "Choose a host first: cards are detected on the host they are installed in.",
  "cc.searching": "Searching for cards \u2026",
  "cc.error": "Card detection failed: {p0}",
  "flow.sd.settings": "Settings ({p0})",
  "flow.sd.settingsHint": "Fill in only what should differ for this instance. Empty fields take the node type's value or the default.",
  "flow.sd.emptyIs": "empty = {p0}",
  "flow.sd.emptyDefault": "empty = node default",
  "flow.sd.resolution": "Resolution",
  "flow.sd.resolutionHint": 'Picture size in pixels. "Custom values" for other sizes; default = workflow or node format.',
  "flow.sd.rateHint": 'Frames per second (29.97 and 59.94 are 30000/1001 and 60000/1001). "Custom values" for numerator/denominator.',
  "flow.sd.rate": "Frame rate",
  "flow.sd.presetDefault": "Default (workflow or node format)",
  "flow.sd.presetCustom": "Custom values \u2026",
  "flow.sd.fps": "{p0} fps",
  "flow.sd.width": "Width",
  "flow.sd.height": "Height",
  "flow.sd.rateNum": "Numerator",
  "flow.sd.rateDen": "Denominator",
  "flow.confirmStartLabel": "Start",
  "wf.confirmStart": "Really start workflow \u201C{p0}\u201D?",
  "wf.confirmStartLabel": "Start",
  "wf.confirmDelete": "Really delete workflow \u201C{p0}\u201D?",
  "wf.confirmDeleteLabel": "Delete",
  "flow.a271df": "Stop failed: {p0}",
  "flow.f876c0": "Instance is stopping \u2026",
  "flow.b5f13f": "Really stop workflow \u201C{p0}\u201D?",
  "flow.f38594": "Workflow stop failed: {p0}",
  "flow.75b57f": "Workflow \u201C{p0}\u201D is stopping \u2026",
  "rd.514366": "Host online",
  "rd.eda8d2": "Host offline \u2014 last seen {p0}",
  "rd.61ea4b": "Host offline \u2014 no telemetry received",
  "rd.cc1bd0": "Workflow could not be loaded.",
  "rd.e80be5": "Really remove role \u201C{p0}\u201D?",
  "rd.14ab7f": "its connections",
  "rd.30eb50": "a standby assignment on it",
  "rd.7ada64": " and ",
  "rd.62beac": "Really remove role \u201C{p0}\u201D? This also loses {p1}.",
  "rd.513d30": "Remove",
  "rd.a65046": 'Name "{p0}" is already taken or invalid.',
  "rd.fb8aa5": "A name and at least one role are required.",
  "rd.616d9c": "Saving failed: {p0}",
  "rd.b2d236": "Workflow name",
  "rd.dc352f": "Target host for the next added role (click or drag from the catalog on the left).",
  "rd.008897": "\u21B6 Undo",
  "rd.281e1f": "Undo (Ctrl+Z)",
  "rd.d84dd6": "Redo (Ctrl+Y)",
  "rd.c90d8d": "Drag: move \xB7 drag from the circle on the right to the circle on the left: connect \xB7 ",
  "rd.de5aed": "Click an edge or \u2715: remove \xB7 \u270E or double-click the name: rename \xB7 ",
  "rd.e743cd": "Ctrl+Z/Ctrl+Y: undo/redo",
  "rd.b55aba": "Saving \u2026",
  "rd.b97d23": "Save",
  "rd.6212ff": "Create",
  "rd.8311b9": "Close",
  "rd.322f5f": "Node catalog",
  "rd.0926c5": "Loading catalog \u2026",
  "rd.26fdfa": "Search\u2026",
  "rd.c977e2": "No matches.",
  "rd.da4ea0": "{p0} \u2014 drag onto the canvas to place it at a specific position, ",
  "rd.8e078a": "or click for the default position.",
  "rd.64b0b3": "{p0} \u2192 {p1} \u2014 click to remove",
  "rd.50a83a": "Double-click to rename \u2014 this name appears as the sender/crosspoint label (user request 2026-07-30: speaking names).",
  "rd.cd85cd": "Rename",
  "rd.d9e1ac": "Target host of this role.",
  "rd.f60d6f": "Host: (local)",
  "rd.ee4ff2": "Host: {p0}{p1}",
  "rd.3b742a": "Host: {p0} (not registered)",
  "rd.d48d37": "Default format of this role \u2014 empty leaves the node at its own default.",
  "rd.2c585c": "Format: node default",
  "rd.f53db2": "Warm standby role for another role of the same node type \u2014 takes over automatically if the primary role fails (K7 part 4).",
  "rd.7ce364": "Standby for: \u2014",
  "rd.2238e9": "Standby for: {p0}",
  "rd.b94a25": "Placement escalation on host overload (D6 part 4) \u2014 advisory only shows an alarm, auto-confirm-window/auto automatically move the role to a healthy fallback host.",
  "rd.a92c96": "Confirmation window in seconds before the migration is executed automatically without intervention (empty = 30s).",
  "rd.dfb4af": "Placement: advisory",
  "rd.87c900": "Placement: auto (confirmation)",
  "rd.41cdd7": "Placement: auto (immediate)",
  "rd.0a298f": "Levels:",
  "rd.0618c4": "Number of independent M/E levels of this mixer, each with its own PGM output (e.g. for a studio monitor independent of the broadcast PGM) \u2014 empty/1 = node default, only effective at start.",
  "rd.e7cb49": "Physical DeckLink port this role claims exclusively (D13 I/O card claim) \u2014 sets device-number/direction at start. Without a free matching port the orchestrator honestly refuses the start instead of running into a crash loop with the built-in default (device-number=0, input). 'Not assigned' keeps exactly this old, unchecked default behaviour.",
  "rd.59d216": "I/O port: not assigned",
  "rd.c1ae46": "A role cannot connect to itself.",
  "rd.af7d46": "This connection already exists.",
  "pe.872073": "Actions",
  "pe.a0c169": "People",
  "pe.708dee": "Flow",
  "pe.4bf36f": "Input",
  "pe.469b92": "Registered",
  "pe.379ee8": "Ready",
  "pe.9b9437": "In review",
  "pe.6bb8d0": "Approved",
  "pe.18a0e4": "Published",
  "pe.d11aee": "Archived",
  "pe.768a27": "Expired",
  "pe.b74b71": "Deleted",
  "pe.2567e3": 'Really remove step "{p0}"? References to it (next/branches/compensation) are removed too.',
  "pe.c0fdae": "Invalid or already used step ID.",
  "pe.f6f742": "Process flow",
  "pe.060d74": "{p0} steps",
  "pe.b1ca0c": "\u26A1 Triggers ({p0})",
  "pe.5528e3": "\u26A1 Triggers: manual only",
  "pe.c979b7": "Define on which event the process starts automatically",
  "pe.de024d": "Auto-arrange",
  "pe.7cf6d9": "Reason for change (optional)",
  "pe.d6ed5a": "Double-click a tile: configure \xB7 drag from the circle on the right onto a tile: connect \xB7 ",
  "pe.feebfd": "Click a connection: remove",
  "pe.b97d23": "Save",
  "pe.4b9727": "Cancel",
  "pe.642d30": "Building blocks",
  "pe.e4259d": "Click or drag onto the canvas.",
  "pe.0aed56": "{p0} Not executable on this server \u2014 a process with this block would fail when the step is reached.",
  "pe.d3a973": "Not available ({p0})",
  "pe.efe2f6": "{p0} \u2192 {p1} (next) \u2014 click to remove",
  "pe.dd75f3": "{p0} \u2192 {p1} (branch: {p2}) \u2014 click to remove",
  "pe.6c6ab3": "not executable",
  "pe.b9de46": "\u2606 set as start",
  "pe.c8a8be": "Start automatically when \u2026",
  "pe.d4054d": "\n        Without a trigger the process only starts manually (\u201CStart\u201D). The data of the event is available to the steps as start input (e.g. the asset ID).\n        Triggers only take effect once the version is published.",
  "pe.ff11ee": "No trigger \u2014 manual start only.",
  "pe.7e436d": "own subject, e.g. omp.process.x.done",
  "pe.trigFilter": 'Filter (optional), e.g. input.severity == "critical"',
  "pe.trigFilterHint": "Expression over input.* (payload) and subject; the process starts only if it is true",
  "pe.trigGroup.asset": "Assets",
  "pe.trigGroup.alarm": "Alarms",
  "pe.trigGroup.ingest": "Stream ingest / recordings",
  "pe.trigGroup.files": "Files",
  "pe.trigGroup.process": "Processes",
  "pe.trigGroup.bus": "Other events (observed on the bus)",
  "pe.trigRemove": "Remove trigger",
  "pe.trigSeen": "Last seen {p0} ({p1}\xD7)",
  "pe.trigNever": "Not seen yet \u2014 fields and test become available after the first event",
  "pe.trigFields": "Payload fields (click to insert into the filter):",
  "pe.trigExample": "Example: {p0}",
  "pe.trigInsert": "Insert into the filter",
  "pe.trigSample": "Last payload",
  "pe.trigNoSample": "No sample yet \u2014 the test works after the first event",
  "pe.trigMatch": "\u2714 Matches the last payload",
  "pe.trigNoMatch": "\u25CB Does not match the last payload",
  "pe.trigSearch": "Search event (name, subject, group) \u2026",
  "pe.trigChoose": "Choose event \u2026",
  "pe.trigUse": "Use custom subject: {p0}",
  "pe.083fea": "Custom event (advanced) \u2026",
  "pe.c481e8": "+ Trigger",
  "pe.bf8310": "Apply",
  "pe.9b9089": "Every trigger needs an event.",
  "pe.889b4d": "Please enter a name for the path.",
  "pe.c99319": "Which path leads here?",
  "pe.371e70": "Always (regardless of the result)",
  "pe.87860e": "Then continue with this step",
  "pe.af7d46": "This connection already exists.",
  "pe.7d870e": "Advanced: custom path name",
  "pe.9c9482": "Path name",
  "pe.24e7ff": "Connect",
  "am.0c5944": "Source {p0}",
  "am.550585": "Aux input {p0}",
  "am.cebd3b": "Main input file",
  "am.a081a7": "Edit audio matrix",
  "am.4b9727": "Cancel",
  "am.bf8310": "Apply",
  "am.8a5d35": "Assigns individual source channels (from the main input file or additional files) to any output tracks \u2014 mixed proportionally (%) and delayed (ms). A cell with share 0 contributes nothing. Output tracks without any contribution are not created.",
  "am.436760": "Channel layout:",
  "am.754de8": "Sources",
  "am.18dca7": "Expand",
  "am.5f67b0": "Collapse",
  "am.be7644": "Aux input {p0}:",
  "am.90a9e7": "Additional source {p0} (name optional)",
  "am.e649e0": "Remove this additional source",
  "am.71a326": "Path:",
  "am.c799cf": "Path of the additional source file",
  "am.364ee0": "Output tracks:",
  "am.d65493": "Downmixer",
  "am.8e0889": "Delay:",
  "am.513d30": "Remove",
  "am.d4157e": "Source channel \\ output track",
  "am.d8b559": "Track {p0}",
  "am.5ba81a": "Click to edit",
  "am.9aa012": "Click to route",
  "am.5fe6a4": "{p0}: path missing.",
  "am.7efd6f": "At least one cell with a share > 0 is needed.",
  "fg.10c6b6": "Edit filter chain",
  "fg.3ce2cc": "Arrange automatically",
  "fg.4b9727": "Cancel",
  "fg.bf8310": "Apply",
  "fg.75f7d9": "Output {p0}",
  "fg.04f5e1": "Search filters \u2026",
  "fg.f3a961": "No filter matches.",
  "fg.642d30": "Building blocks",
  "fg.5a3fe6": "Filters (from the real ffmpeg list):",
  "fg.4bf36f": "Input",
  "fg.2b73e4": "Output",
  "fg.c45971": "Name (optional)",
  "fg.8999d7": "Inputs:",
  "fg.a2c1ed": "Outputs:",
  "fg.440a36": "Default: {p0}",
  "fg.cbc4b0": "no options",
  "psc.d1762c": "invalid value",
  "psc.e54b72": " (offline)",
  "psc.a03494": "Insert a value from the process run (start input, result of a previous step \u2026)",
  "psc.98ceeb": "Search \u2026",
  "psc.3c50c3": "own input field, e.g. path",
  "psc.b5e41b": "insert input.\u2026",
  "psc.60a1f1": "Start input fields are provided on manual start (JSON) or by the triggering event.",
  "psc.6e2c9a": "No matching values.",
  "psc.513d30": "Remove",
  "psc.8fef4a": "\u2013 choose value \u2013",
  "psc.edfa2f": "Value, e.g. approved or 0",
  "psc.1c5e10": "Use simple rule",
  "psc.d26d26": "Custom expression (advanced)",
  "psc.b8865a": "This expression does not fit a simple rule \u2014 it stays a custom expression.",
  "psc.00760a": "Wait time",
  "psc.b4b8e1": "The flow then continues automatically.",
  "psc.b950fb": "Wait time: not a valid number.",
  "psc.60e9f0": "e.g. Approve post",
  "psc.1f0172": "e.g. Review subtitles",
  "psc.9d735f": "empty = anyone may claim",
  "psc.01daf3": "optional, e.g. editorial",
  "psc.68dd6f": "Task title",
  "psc.01531f": "Appears in the Processes tab under \u201CHuman tasks\u201D. Empty = step name.",
  "psc.49f6db": "Description / instruction",
  "psc.c1ebd6": "Responsible person",
  "psc.e897f3": "Role",
  "psc.c30f58": "Priority",
  "psc.bea463": "Result: \u201Capproved\u201D, \u201Crejected\u201D or \u201Cchanges requested\u201D \u2014 draw one connection per result to the matching next step.",
  "psc.ad8b47": "Name of the yes path",
  "psc.254c6b": "Name of the no path",
  "psc.9e5c87": "Rule",
  "psc.9c21c3": "If the rule applies, the flow takes the yes path, otherwise the no path.",
  "psc.92f762": "The paths are created by dragging from the output of this step to the next step and choosing the path.",
  "psc.f07dc2": "Rule: please choose a value or enter an expression.",
  "psc.65e89f": "Name of the path, e.g. hd",
  "psc.cd850a": "Remove case",
  "psc.9242d7": "If",
  "psc.12a29c": "optional, e.g. otherwise",
  "psc.919f43": "The cases are checked from top to bottom; the first one that applies determines the path.",
  "psc.22fd61": "Path if no case applies",
  "psc.f22388": "Empty = the process fails if no case matches.",
  "psc.31c191": "Every case needs a path name and a rule.",
  "psc.541b6d": "At least one case is required.",
  "psc.f00a7d": "Header, e.g. Authorization",
  "psc.5a597b": "Value",
  "psc.144d62": "Field",
  "psc.7b71ec": "Value (text)",
  "psc.d38e8c": "Data sent",
  "psc.02fbcf": "Sent as a JSON object (only for POST/PUT/PATCH). Nested data: \u201CAdvanced (JSON)\u201D.",
  "psc.decdc1": "The data sent is nested \u2014 editable under \u201CAdvanced (JSON)\u201D.",
  "psc.41aa69": "Method",
  "psc.8f2cbd": "Address (URL)",
  "psc.e6ea93": "Use \u201C{x} Variable\u201D to insert values from the process run.",
  "psc.bf50d5": "Headers",
  "psc.755b1d": "Response timeout",
  "psc.fc9b98": "Empty = 30 seconds.",
  "psc.61a248": "Responses outside 200\u2013299 count as errors (\u2192 retry/error handling below).",
  "psc.d494fb": "Address (URL) missing.",
  "psc.de6fc7": "Timeout: not a valid number.",
  "psc.81d089": "Search options \u2026",
  "psc.440a36": "Default: {p0}",
  "psc.f86918": "\u2013 ffmpeg default for the container \u2013",
  "psc.a8f960": "\u2013 derive from the file extension \u2013",
  "psc.95b1db": "no filter set.",
  "psc.0a42fd": "Edit filter chain \u2026",
  "psc.a09a38": "Remove filter",
  "psc.cb4d72": "Filter active ({p0} filter step(s)).",
  "psc.f15630": "Edit audio matrix \u2026",
  "psc.3309b0": "Route, mix and delay source channels from this or additional files graphically onto output tracks.",
  "psc.2668ce": "${input.path} or a custom path",
  "psc.b2cbf0": "Output track {p0}",
  "psc.a56112": "e.g. 0:a:0 \u2014 or a label from the filter chain/audio matrix",
  "psc.4b1725": "insert [{p0}]",
  "psc.b22f04": "Audio",
  "psc.34e2d1": "Video",
  "psc.b5b672": "Subtitles",
  "psc.e9da74": "Remove track",
  "psc.d3402e": "Source",
  "psc.d0636b": "Raw stream specifier (e.g. 0:a:0 for input file 0, first audio track) or a label from the filter chain/audio matrix (in square brackets).",
  "psc.913302": "Media type",
  "psc.8ca990": "Codec",
  "psc.8a0483": "Empty = ffmpeg default.",
  "psc.e8a64f": "Metadata (optional)",
  "psc.ae9836": "Any keys, e.g. title, language (ISO-639-2) \u2014 not limited to title/language.",
  "psc.095815": "Video/audio codec above are disabled as long as at least one output track is configured below \u2014 the output track list then takes over the assignment completely.",
  "psc.2c6327": "Video codec",
  "psc.24f9d3": "Empty = ffmpeg default for the container.",
  "psc.16202d": "Audio codec",
  "psc.7ddbbe": "Input file",
  "psc.8adabd": "Output file",
  "psc.6bbca5": "Force container (optional)",
  "psc.74d4bd": "Empty = ffmpeg derives it from the extension of the output file.",
  "psc.f92383": "Filter (optional)",
  "psc.99d757": "Additional input files",
  "psc.82095d": "Only needed if the filter above references more than one source \u2014 the input file above is index 0, here index 1, 2, \u2026.",
  "psc.5bfab8": "Output tracks (optional \u2014 for independent multiple tracks, e.g. several language versions)",
  "psc.9205c3": "Input and output file are required.",
  "psc.328a1f": "An additional input file is empty.",
  "psc.a3017d": "Every output track needs a source.",
  "psc.6b4c3c": "Clip {p0}",
  "psc.b153d1": "empty = from the start",
  "psc.c7c6db": "empty = until the end",
  "psc.fb36dc": "Remove clip",
  "psc.e2eaea": "Trim start (optional)",
  "psc.4e75ed": "ffmpeg time value, e.g. 5 or 00:00:05.5 \u2014 cuts off the start of the clip.",
  "psc.1f0b03": "Trim end (optional)",
  "psc.410164": "ffmpeg time value \u2014 cuts the clip off from here.",
  "psc.c3115f": "Source file",
  "psc.318be7": "No trimming possible, no codec choice (stays exactly like the sources) \u2014 only reliable for containers supported by ffmpeg's concat protocol (mainly MPEG-TS/-PS, e.g. .ts files from feeds). With incompatible sources ffmpeg reports an error when running instead of producing a wrong file.",
  "psc.965445": "All clips are re-encoded (joined via filter, no pure stream copy) \u2014 empty = ffmpeg default.",
  "psc.71259a": "The order of the clips below is the order in the output file \u2014 reorder with \u2191/\u2193.",
  "psc.b81bfe": "Lossless (stream copy, no re-encoding)",
  "psc.82b994": "Output file missing.",
  "psc.9fd8eb": "At least two clips are required.",
  "psc.aecc0d": "Every clip needs a source file.",
  "psc.07a093": "Total duration in seconds (for the timeline preview)",
  "psc.4ff54c": "Event {p0}",
  "psc.6e4c80": "Text (e.g. lower third, end credits)",
  "psc.fe1905": "Image (e.g. channel logo)",
  "psc.d43301": "${input.logoPath} or a custom path",
  "psc.d01e32": "Seconds from the start",
  "psc.28d341": "empty = centred (text) or 0 (image)",
  "psc.c8421f": "empty = bottom (text) or 0 (image)",
  "psc.9dffbf": "Text",
  "psc.ed95ac": "Colon and apostrophe are escaped automatically.",
  "psc.aa69ac": "Image file",
  "psc.3795c7": "Remove event",
  "psc.9563fc": "Start (seconds)",
  "psc.5381b9": "End (seconds)",
  "psc.8ef81c": "Position X (optional)",
  "psc.8f4463": "ffmpeg expression, e.g. 10 or (w-overlay_w)/2.",
  "psc.ec97a1": "Position Y (optional)",
  "psc.edfec0": "ffmpeg expression, e.g. 10 or h-overlay_h-20.",
  "psc.37ba1f": "Input file (video)",
  "psc.406613": "Overlays require re-encoding of the picture \u2014 empty = ffmpeg default.",
  "psc.fc2ebc": "Audio is passed through unchanged if present \u2014 only set a codec if needed.",
  "psc.f46020": "Total duration (only for the timeline preview)",
  "psc.26d291": "Timeline (not draggable, for orientation only):",
  "psc.4aaf16": "At least one event is required.",
  "psc.5f5f22": "Every event needs a valid start/end time (end > start).",
  "psc.9c9479": "Every text event needs a text.",
  "psc.049b05": "Every image event needs an image file.",
  "psc.6646ff": "\u2013 choose tool \u2013",
  "psc.a59b9d": "{p0} (not available on this server!)",
  "psc.2c4740": "\u2013 apply template (optional) \u2013",
  "psc.574722": "Argument (e.g. -crf or a value)",
  "psc.6940ee": "Search parameters \u2026",
  "psc.a6eb55": "{p0} global flags (-h full)",
  "psc.345b00": "{p0} parameters",
  "psc.a96ba4": "{p0} parameters so far (still loading in the background)",
  "psc.d79ecf": "Parameter index loading \u2026",
  "psc.cbb958": "global flag",
  "psc.a0f383": "global flag, -h full",
  "psc.cbc4b0": "no options",
  "psc.89cdb8": "Search parameters",
  "psc.8c458f": `Searches global CLI flags (curated + complete from "ffmpeg -h full"), ALL AVOptions of all encoders/decoders/muxers/demuxers/filters of this server (e.g. "crf" directly finds libx264's -crf) as well as tool/filter names themselves \u2014 clicking a hit inserts it as an argument.`,
  "psc.cd6dbf": " Replace the placeholders input.path etc. with real values via \u201C{x} Variable\u201D or provide them at start.",
  "psc.a7b058": "Insert command line \u2026",
  "psc.e91a0f": 'Insert a complete argument line (e.g. from a tutorial) \u2014 split at spaces, "\u2026" keeps things together.',
  "psc.4eb447": "Arguments (without program name):",
  "psc.40c573": "Tool",
  "psc.819ee1": "Enabled on this server: {p0}.",
  "psc.8330a3": "No tool is enabled on this server.",
  "psc.07411f": "Template",
  "psc.c9d7f8": "Arguments",
  "psc.8584a0": "One argument per line \u2014 spaces inside a line are kept (no quoting problem). Known flags are suggested while typing and their value is checked.",
  "psc.ffd103": "Generated arguments (preview):",
  "psc.3ce979": "Neither ffmpeg nor ffprobe is enabled on this server \u2014 the wizard needs at least one of them.",
  "psc.8c5713": "Task",
  "psc.443b5b": "Enter raw arguments instead (expert mode)",
  "psc.df82e3": "Use the wizard instead",
  "psc.31b5c0": "Timeout",
  "psc.733355": "Empty = 5 minutes.",
  "psc.305b37": "Tool missing.",
  "psc.05b4e5": "Choose a task.",
  "psc.d8e721": "\u2013 choose a microservice first \u2013",
  "psc.1b1539": "This function needs no input.",
  "psc.e9716b": "Number",
  "psc.074e19": "Type: {p0}",
  "psc.5d2bfb": "{p0} (microservice is not running right now)",
  "psc.5eea30": "\u2013 choose function \u2013",
  "psc.6bf2f0": "this microservice offers no functions",
  "psc.edb0ba": "{p0} (no longer offered)",
  "psc.4bc1ca": "\u2013 choose microservice \u2013",
  "psc.882bf5": "no running microservices found",
  "psc.bd2472": "{p0} (not running right now)",
  "psc.b1a5f2": "Microservice",
  "psc.cf6708": "Only running instances are offered. The process calls exactly this instance.",
  "psc.b104f8": "Function",
  "psc.ce7b6e": "Choose microservice and function.",
  "psc.bb7773": "{p0}: not a valid number.",
  "psc.249a28": "always the latest published version",
  "psc.4b6924": "exactly v{p0}",
  "psc.4d0aaf": "pinned version (no longer published)",
  "psc.729570": "\u2013 choose process \u2013",
  "psc.d6e26f": "Process",
  "psc.5d56b7": "Runs as its own process run; this step waits until it has finished.",
  "psc.34b6cd": "Version",
  "psc.96b30c": "Start input for the subprocess",
  "psc.be6e5d": "The start input is nested \u2014 editable under \u201CAdvanced (JSON)\u201D.",
  "psc.78f7d8": "Choose a process.",
  "psc.980d97": "e.g. omp.process.post.done",
  "psc.3a9d26": "Channel (subject)",
  "psc.da13c4": "Name under which other systems subscribe to this message. Dots separate levels.",
  "psc.c2df59": "Content",
  "psc.16e638": "The content is nested \u2014 editable under \u201CAdvanced (JSON)\u201D.",
  "psc.8b8a99": "Channel (subject) missing.",
  "psc.1a58bf": "No settings needed \u2014 connect this step to all steps that should run simultaneously.",
  "psc.3ee9be": "No settings needed \u2014 the flow continues as soon as ALL incoming paths have arrived.",
  "psc.7cc481": "This step type has no form \u2014 settings possibly under \u201CAdvanced (JSON)\u201D.",
  "psc.441f14": "e.g. Create proxy",
  "psc.2eb6eb": "Display name",
  "psc.f0ab2e": "Appears on the tile and in the variable picker of following steps.",
  "psc.69794d": "If something goes wrong",
  "psc.d6ea9c": "Double the interval each time",
  "psc.cb3186": "Total attempts",
  "psc.877b38": "Pause between attempts",
  "psc.f39ab3": "Retry automatically on error",
  "psc.7abaf8": "\u2013 undo nothing \u2013",
  "psc.c288c7": "Maximum runtime of this step",
  "psc.faa307": "Empty = unlimited. If exceeded the step counts as failed.",
  "psc.d8dc39": "Undo with",
  "psc.a92403": "If the process fails later, this step runs to undo the effect here (e.g. delete the file again).",
  "psc.9b0008": "Advanced: settings as JSON",
  "psc.3404a3": "While this section is open, the JSON below applies instead of the form.",
  "psc.4b9727": "Cancel",
  "psc.bf8310": "Apply",
  "psc.291226": "Invalid JSON: {p0}",
  "psc.51e448": "Total attempts: at least 2.",
  "psc.d0fee9": "Pause between attempts: not a valid number.",
  "psc.3328a4": "Maximum runtime: not a valid number.",
  "adm.5e3e07": "Deactivate",
  "adm.1a1a97": "Reactivate",
  "adm.ad2749": "Workflow role",
  "adm.74cacb": "standalone",
  "adm.361528": "the installed binary",
  "adm.dfb6b8": "installed binary",
  "adm.00b3d4": "State unknown",
  "adm.db0548": " \xB7 from version store {p0}",
  "adm.fc16a0": "signed ({p0})",
  "adm.312ccb": "(default)",
  "adm.36311b": "Click to filter by this trace_id: ",
  "adm.6970d8": "View",
  "adm.993f73": "Operate",
  "adm.c752db": "Configure",
  "adm.d977b4": "Administer",
  "adm.5b0f32": "Creating organization failed: {p0}",
  "adm.44bbde": 'Really delete organization "{p0}"?',
  "adm.1010b0": "Delete",
  "adm.ea96f5": '"{p0}" is the default organization and cannot be deleted.',
  "adm.fc057a": '"{p0}" still has users or objects (workflows/assets/\u2026) \u2014 move or remove them first.',
  "adm.05f6da": "Deleting failed: {p0}",
  "adm.c9957a": "Changing organization failed: {p0}",
  "adm.dir.title": "Active Directory / LDAP",
  "adm.dir.enabled": "Directory sign-in is active",
  "adm.dir.test": "Test connection",
  "adm.dir.testing": "Checking \u2026",
  "adm.dir.testOk": "Connection and service account OK.",
  "adm.dir.testFailed": "Failed: {p0}",
  "adm.dir.notConfigured": "Not set up.",
  "adm.dir.hint": "Directory groups are mapped to OMP groups. Whenever a directory user signs in, their membership in the mapped OMP groups is brought up to date (member if they are in the directory group, otherwise removed). Permissions still hang on the OMP groups. Users are created on first sign-in; local accounts keep working.",
  "adm.dir.hintOff": "You can prepare mappings already. They take effect once the connection is set up.",
  "adm.dir.ldapGroup": "Directory group (name or DN, e.g. Regie1)",
  "adm.dir.pickGroup": "Choose OMP group \u2026",
  "adm.dir.add": "Map",
  "adm.dir.addFailed": "Mapping failed: {p0}",
  "adm.dir.userTag": "Directory user \u2014 password is managed in Active Directory",
  "adm.dir.disabled": "not switched on",
  "adm.dir.saved": "Saved and applied.",
  "adm.dir.saveFailed": "Saving failed: {p0}",
  "adm.dir.loadError": "The settings are not usable: {p0}",
  "adm.dir.f.enabled": "Sign-in",
  "adm.dir.f.enabledLabel": "Switch on Active Directory sign-in",
  "adm.dir.f.fromEnv": "The values still come from the environment variables OMP_LDAP_*; after saving, the values entered here apply.",
  "adm.dir.f.urls": "Servers (domain controllers)",
  "adm.dir.f.urlsHelp": "One address per line; if one fails, the next is tried. ldaps:// (port 636) is encrypted.",
  "adm.dir.f.startTls": "StartTLS",
  "adm.dir.f.startTlsLabel": "switch to encryption on ldap:// (port 389)",
  "adm.dir.f.allowPlain": "Plain text",
  "adm.dir.f.allowPlainLabel": "allow unencrypted (lab only)",
  "adm.dir.f.allowPlainWarn": "Passwords travel in the clear!",
  "adm.dir.f.ca": "CA certificate",
  "adm.dir.f.caHelp": "Paste the domain controllers' certificate authority as PEM; empty = system certificates.",
  "adm.dir.f.caFile": "(Additionally from environment: {p0})",
  "adm.dir.f.baseDn": "Search base (Base DN)",
  "adm.dir.f.bindDn": "Service account (DN)",
  "adm.dir.f.bindDnHelp": "Account with read access to users and groups. Empty = anonymous search (AD usually forbids it).",
  "adm.dir.f.pw": "Service account password",
  "adm.dir.f.pwKeep": "(stored \u2014 leave empty to keep it)",
  "adm.dir.f.pwHelp": "Stored encrypted (needs OMP_STORAGE_SECRET_KEY) and never shown.",
  "adm.dir.f.userFilter": "User filter",
  "adm.dir.f.userFilterHelp": "{user} is replaced by the sign-in name. Empty = default (sign in with name or name@domain).",
  "adm.dir.f.userAttr": "Name attribute",
  "adm.dir.f.groupBaseDn": "Group search base",
  "adm.dir.f.sameAsBase": "same as search base",
  "adm.dir.f.groupFilter": "Group filter",
  "adm.dir.f.groupFilterHelp": "{dn} is replaced by the user's DN. The default also reads nested groups.",
  "adm.dir.f.required": "Required group",
  "adm.dir.f.requiredHelp": "Optional: only members of this group (name or DN) may sign in.",
  "adm.dir.f.timeout": "Timeout (s)",
  "adm.dir.whereSettings": "The connection is set up under Maintenance \u2192 Settings \u2192 Active Directory.",
  "adm.740737": "Creating group failed: {p0}",
  "adm.f0fe51": "Saving group failed: {p0}",
  "adm.006ae0": 'Really delete group "{p0}"?',
  "adm.b0eec4": "Also remove {p0} role bindings of this group now and delete the group anyway?",
  "adm.bbd42e": "Delete group + bindings",
  "adm.116589": "Adding member failed: {p0}",
  "adm.473556": "Removing member failed: {p0}",
  "adm.d6c746": "Connection successful.",
  "adm.c18d1f": "The last connection test failed. Save anyway?",
  "adm.712bf9": "The connection has not been tested yet. Save anyway?",
  "adm.71af06": "Save anyway",
  "adm.055ecb": "Creating failed: {p0}",
  "adm.d033fe": "Storage backend created.",
  "adm.616d9c": "Saving failed: {p0}",
  "adm.24bd50": "Storage backend updated.",
  "adm.22ae39": 'Really remove storage backend "{p0}" ({p1}/{p2})? ',
  "adm.cab673": "Files already stored there are NOT deleted by this \u2014 only the management of this target here.",
  "adm.513d30": "Remove",
  "adm.64bd21": "Removing failed: {p0}",
  "adm.8f63e4": "Creating user failed: {p0}",
  "adm.d125d4": "User created, automatic sign-in failed \u2014 please sign in manually.",
  "adm.50e59c": 'Really delete user "{p0}"?',
  "adm.5d0b05": "Password reset failed: {p0}",
  "adm.f397bc": "Creating role binding failed: {p0}",
  "adm.a9b709": 'Really delete role binding "{p0}" \u2192 {p1} ({p2})?',
  "adm.b8b2ff": "Backup failed: {p0}",
  "adm.31299d": "Upload failed: {p0}",
  "adm.3eceda": "Download failed: {p0}",
  "adm.4c4de5": "Version {p0}",
  "adm.b5d818": "{p0}: set {p1} as productive? It applies to newly started instances. Running instances stay ",
  "adm.0e3a0a": "unchanged until they are restarted (System update \u2192 \u201CRestart outdated\u201D).",
  "adm.a8aea0": "Set",
  "adm.89b0ff": "Setting failed",
  "adm.88ca3b": "Switch anyway",
  "adm.224408": "No running instance needs to be switched.",
  "adm.9a9247": "Switch {p0} instance(s) one after another to {p1}?\n\n{p2}\n\n",
  "adm.150afc": "Every instance is restarted (brief signal loss), its connections are restored. ",
  "adm.5d9e5b": "If a new version does not start, the instance keeps running with the previous state and the rollout aborts.",
  "adm.603736": "Start rollout",
  "adm.2597aa": "Rollout not started: {p0}",
  "adm.68797a": "Delete {p0} {p1} from the version store?",
  "adm.290534": "Deleting failed",
  "adm.2b5ab6": "Node versions",
  "adm.667df2": "Per node type several binary versions are in the version store (from uploaded update packages and the ",
  "adm.3ca706": "currently installed state). The productive version applies to newly started local instances; upgrading and ",
  "adm.bfb34a": "downgrading is \u201Cset another version productive\u201D. Dev builds are not versioned and are not archived.",
  "adm.3397a7": "Archive installed binaries",
  "adm.ff58ad": "Archiving failed",
  "adm.2f5000": "without build stamp (older/dev build)",
  "adm.3846c6": "Installed: {p0} \xB7 Productive: {p1}",
  "adm.ec4dde": "Set productive",
  "adm.8c876a": "No archived versions (dev build or no update package yet).",
  "adm.0c7131": "Back to the installed binary",
  "adm.f43217": "Rollout running \u2026",
  "adm.2d37e3": "Switching {p0} running instance(s) to {p1} \u2026",
  "adm.66a668": " \xB7 outdated (restart needed)",
  "adm.4f37c8": " \xB7 remote host (version store only applies locally)",
  "adm.207f5e": "Update package rejected: {p0}",
  "adm.17421d": "Distribute version {p0} to all registered remote hosts? Host agent and node binaries on the ",
  "adm.41c0d3": "hosts are replaced; a new host agent only becomes active after its restart, running instances keep ",
  "adm.77ae28": "the old state until their restart.",
  "adm.b63a37": "Distribute",
  "adm.a7b1ed": "Distributing failed: {p0}",
  "adm.98298f": "Restart {p0} outdated instance(s) now? Their signals are briefly interrupted ",
  "adm.979273": "(workflow roles keep their node IDs and operating state).",
  "adm.bad5b8": "Restart",
  "adm.7b8028": "Restart failed: {p0}",
  "adm.e89f49": "Not all instances restarted: {p0}",
  "adm.901c45": "Delete update package \u201C{p0}\u201D from the server?",
  "adm.1ec094": "Install version {p0} now? The server (orchestrator) is restarted for this and ",
  "adm.7dd803": "is unreachable for a few seconds. Running nodes stay in operation, but keep running with the old state until ",
  "adm.776d94": "their next restart.",
  "adm.e117f9": " This update changes the database ({p0} migration(s)).",
  "adm.6c6655": "Install",
  "adm.20f290": "Update failed: {p0}",
  "adm.a346cd": "Update running \u2026",
  "adm.ed0484": "The server is backed up, stopped, updated and restarted. ",
  "adm.737d1d": "This page reloads automatically as soon as it is reachable again (can take up to ~1\u20132 minutes). ",
  "adm.450de1": "On failure the supervisor automatically restores the previous state \u2014 the result is then shown ",
  "adm.64e9be": "under \u201CHistory\u201D.",
  "adm.059a95": "System update",
  "adm.2a87f2": "Reading firmware \u2026",
  "adm.cd73c1": "Loading \u2026",
  "adm.f4f4c4": "Trusted signature keys: {p0}",
  "adm.e898a8": "No signature key stored (.run/update-trusted.pub) \u2014 packages are rejected.",
  "adm.9df498": "\nWARNING: unsigned packages are allowed (OMP_UPDATE_ALLOW_UNSIGNED, development only).",
  "adm.e9553d": "{p0} running node instance(s) still use an older state than the installed files ",
  "adm.9301a7": "\u2014 they are updated at the next restart (instance or workflow).",
  "adm.0c2f79": "Restarting \u2026",
  "adm.b7843f": "Restart outdated instances now",
  "adm.d5fe38": "An update to {p0} is running (phase: {p1}).",
  "adm.9e6d27": "Supervisor unreachable: {p0} \u2014 without it no update can be applied (deploy/dev/start-supervisor.sh).",
  "adm.e2bdb7": "Uploading and checking \u2026",
  "adm.684cab": "Upload update package (.tar.gz):",
  "adm.e05a6b": "Uploaded packages ({p0})",
  "adm.7fcec6": "No package uploaded yet.",
  "adm.9ac107": "Selected",
  "adm.751a99": "Select",
  "adm.6bf4de": "Architecture: {p0}{p1}{p2}\n",
  "adm.cbe66e": "Prerequisite: at least version {p0}\n",
  "adm.b57cef": "Note: {p0}\n",
  "adm.2ebe10": "This update changes the database ({p0}). A backup is created beforehand without exception.",
  "adm.3f6065": "Distribution running \u2026",
  "adm.a85888": "No remote hosts registered.",
  "adm.c0fc67": "Create a database backup first",
  "adm.a2eeb2": "Install even if not newer than the installed version (downgrade)",
  "adm.700ea0": "To confirm, type the version number: {p0}",
  "adm.69a300": "Install now",
  "adm.2f93d5": "History",
  "adm.641ad5": "No update performed yet.",
  "adm.5a64e9": "FAILED, rolled back",
  "adm.bf3cfc": "Refresh",
  "adm.13e8c8": "Really restore backup \u201C{p0}\u201D? This REPLACES the entire ",
  "adm.d62715": "current database content (users, role bindings, audit log, layouts, snapshots, ",
  "adm.676834": "workflows, hosts) irrevocably.",
  "adm.c8ef6c": "Restore",
  "adm.3f341c": "Restore failed: {p0}",
  "adm.e91dd5": "The file could not be read as a catalog entry (invalid JSON).",
  "adm.1ee99d": "Env must be valid JSON (object of string pairs), e.g. {}",
  "adm.6cdb17": "Import failed: {p0}",
  "adm.c32b0c": " (version {p0})",
  "adm.34066f": 'Really remove catalog entry "{p0}"{p1}?',
  "adm.8a554c": "Joining failed: {p0}",
  "adm.e66e64": "\u201C{p0}\u201D is the leader and the only remaining cluster member \u2014 ",
  "adm.835eb0": "removal is blocked, it would make the cluster permanently unusable.",
  "adm.4e0b70": "\u201C{p0}\u201D ({p1}) is the current leader. After removal the ",
  "adm.b8b22a": "remaining {p0} members automatically elect a new leader. Really remove?",
  "adm.f7c6bf": 'Really remove member "{p0}" ({p1}) from the cluster?',
  "adm.da5fc1": "Users ({p0})",
  "adm.4b9727": "Cancel",
  "adm.e6319b": "+ New user",
  "adm.a9e8b4": "\u201CPermissions\u201D on a user shows ALL their permissions in one place: directly assigned ",
  "adm.e2e8f7": "role bindings AND ones inherited via group membership \u2014 role bindings/groups/",
  "adm.7bb70b": "organization remain the management tools, this view here is the answer.",
  "adm.5ea427": "No user created yet \u2014 create the first (admin) user with \u201C+ New user\u201D.",
  "adm.f5f8d4": "Username",
  "adm.2c51ef": "Created",
  "adm.17b83a": "Organization",
  "adm.e897f3": "Role",
  "adm.4820a0": "Permissions of {p0}",
  "adm.64b2a5": "Global admin \u2014 automatically has all rights on everything, regardless of the bindings/groups below.",
  "adm.65f9b0": "Directly assigned",
  "adm.5241aa": 'Via group "{p0}"',
  "adm.89d043": "Member of {p0} \u2014 but these group(s) have no rights (yet).",
  "adm.1f9d88": "No rights \u2014 this user can sign in, but cannot see or operate anything ",
  "adm.1e5016": "until they get a role binding directly or via a group (\u201C+ New binding\u201D below under role bindings).",
  "adm.3e45af": "Password",
  "adm.6212ff": "Create",
  "adm.94b42c": "change",
  "adm.7ea51d": "Change this user's organization",
  "adm.e3afed": "Admin",
  "adm.191f52": "new password",
  "adm.a294ab": "Permissions \u25B2",
  "adm.ae7313": "Permissions \u25BC",
  "adm.927eb5": "Show all permissions of this user \u2014 directly assigned AND inherited via group membership",
  "adm.201c47": "Organizations ({p0})",
  "adm.42d3b7": "+ New organization",
  "adm.8e03b1": "An organization separates visibility: users only see workflows/assets/processes of their own organization. ",
  "adm.51113f": "Every user belongs to exactly one organization (changeable in the \u201CUsers\u201D tab).",
  "adm.cc1552": "No organization loaded yet.",
  "adm.49ee30": "Name",
  "adm.b718ad": "ID",
  "adm.90292d": "Organization name",
  "adm.a45bce": "Storage backends ({p0})",
  "adm.1033d2": "Determines where asset files actually live (S3/MinIO). Several backends can be active at the same time, ",
  "adm.5a8979": "adding/removing takes effect immediately, no restart needed. Only super admins (global admin right) see this tab.",
  "adm.074a2f": "Not activated yet",
  "adm.027b77": "This function requires server-side ",
  "adm.ee8dd8": "OMP_STORAGE_SECRET_KEY",
  "adm.73e569": " \u2014 a Base64-encoded\n        32-byte key used to store the backends' credentials encrypted in the database.\n        For security reasons this one key must be set outside the UI (it encrypts the\n        other secrets, so it cannot manage itself) \u2014 everything else is done entirely here afterwards.",
  "adm.c2730d": "Generate, e.g.: ",
  "adm.4aa4d5": "openssl rand -base64 32",
  "adm.93d4c0": ", then set it as an environment variable\n        and restart the orchestrator.",
  "adm.9534f2": "No storage backend created yet \u2014 create the first one with \u201C+ New backend\u201D.",
  "adm.2a6ba7": "Endpoint",
  "adm.30edf7": "Bucket",
  "adm.2e3a68": "Access key",
  "adm.ea52c3": "SSL",
  "adm.ec53a8": "Status",
  "adm.b47c95": "active",
  "adm.7c76fa": "deactivated",
  "adm.5ad05d": "Edit",
  "adm.c0171a": "No longer accepts new uploads, keeps serving existing files",
  "adm.9cf390": "Accepts new uploads again",
  "adm.2688a5": "Name *",
  "adm.5fc938": "e.g. Primary media bucket",
  "adm.b13884": "Provider *",
  "adm.c35977": "Endpoint *",
  "adm.af0262": "Bucket *",
  "adm.f2129f": "e.g. omp-assets",
  "adm.3871a2": "Access key *",
  "adm.5eb6bb": "Secret key",
  "adm.f85e9e": " (empty = unchanged)",
  "adm.2109fc": "leave unchanged",
  "adm.8264ad": "Testing\u2026",
  "adm.6a0795": "Test connection",
  "adm.b97d23": "Save",
  "adm.3149a3": "Name, provider, endpoint, bucket and access key are required.",
  "adm.7121c2": "Secret key is required when creating.",
  "adm.1265eb": "Groups ({p0})",
  "adm.663258": "+ New group",
  "adm.022b83": "Bundles rights for several users: a role binding on a group applies to all its members. ",
  "adm.06144f": "Clearly separate from \u201COrganizations\u201D \u2014 those control visibility (who sees which workflows/assets), ",
  "adm.1d455d": "groups control rights (who may do what); both remain independent of each other.",
  "adm.657888": "No group created yet \u2014 create the first one with \u201C+ New group\u201D.",
  "adm.916ea4": "Group name",
  "adm.234de2": "Description (optional)",
  "adm.35bedb": "Description",
  "adm.ee5ce7": "Members \u25B2",
  "adm.be45f7": "Members \u25BC",
  "adm.6a7843": "Members ({p0})",
  "adm.638b34": "No member yet.",
  "adm.e2d84f": "+ Add",
  "adm.ccdd47": "Rights of this group",
  "adm.422405": "None yet \u2014 assign them under Admin \u2192 Permissions for the group.",
  "adm.2578ee": "Role bindings ({p0})",
  "adm.473936": "+ New binding",
  "adm.aa6c6f": "Create/delete individual bindings (subject: user OR group). For \u201Cwhat may user X ",
  "adm.c4e6da": "do overall\u201D (directly + via all groups) click \u201CPermissions\u201D on the person in the \u201CUsers\u201D tab.",
  "adm.782a90": "No role binding created yet.",
  "adm.18c4aa": "By user",
  "adm.d4bcb3": "By node/role",
  "adm.e9cc81": "User \u2192 node",
  "adm.75894c": "Node \u2192 user",
  "adm.8a940a": "User",
  "adm.3b77a5": "Group",
  "adm.e5b1cd": "\u2013 choose group \u2013",
  "adm.14a665": "\u2013 no group available \u2013",
  "adm.3096f0": "Role name (* = whole workflow)",
  "adm.3a7309": "Node ID (* = all nodes)",
  "adm.e5c1c7": "Whole workflow",
  "adm.a78fea": "All nodes",
  "adm.3dda54": "Node catalog ({p0})",
  "adm.2132be": "Search by label, type, description \u2026",
  "adm.438c04": "Imported microservices run as Podman containers (OCI image) and pass the same contract check as `make contract` before being accepted \u2014 a candidate that does not fulfil the node contract is rejected.",
  "adm.c7c031": "No catalog entries match the search.",
  "adm.f74d2d": "No catalog entries yet.",
  "adm.d2dfcc": "Import node/microservice",
  "adm.8311b9": "Close",
  "adm.2256dc": "Prefill from exported file:",
  "adm.c2ea84": "Type",
  "adm.7c9eea": "e.g. omp-thirdparty-node",
  "adm.b021df": "Label",
  "adm.2eb6eb": "Display name",
  "adm.be53a0": "Image",
  "adm.34b6cd": "Version",
  "adm.722ff0": "Expected resources",
  "adm.ea50f3": "Command override",
  "adm.6f865e": "optional, space-separated",
  "adm.47a997": "Env (JSON object, optional)",
  "adm.5af5fb": "Import",
  "adm.7003e3": "Import rejected: contract check failed",
  "adm.e9e1f9": "Imported",
  "adm.5e4eb4": "Built in",
  "adm.0095a9": "Export",
  "adm.e6e18b": "Audit log ({p0} loaded)",
  "adm.5f30db": "No logged actions yet.",
  "adm.718271": "Time",
  "adm.41aa69": "Method",
  "adm.b6a791": "Path",
  "adm.4446bb": "Loading \u2026",
  "adm.5cc9dd": "Load more",
  "adm.56f489": "Diagnostics ({p0} loaded)",
  "adm.9a4c0a": "No log lines for this filter.",
  "adm.51ff86": "No centralized log lines yet.",
  "adm.a0db49": "Level",
  "adm.6c3a69": "Node",
  "adm.dd4ec0": "Trace",
  "adm.d87d49": "Message",
  "adm.fb9f6f": "Node ID",
  "adm.05e870": "All levels",
  "adm.902b0d": "Error",
  "adm.56525a": "Warn",
  "adm.4059b0": "Info",
  "adm.9cbd4a": "Trace ID",
  "adm.2b98bc": "Filter",
  "adm.cf743f": "Reset filter",
  "adm.24f46f": "Backups ({p0})",
  "adm.97a791": "Creating \u2026",
  "adm.edb4fa": "Create backup now",
  "adm.2b953c": "A backup is a complete pg_dump of the orchestrator database (users, role bindings, ",
  "adm.1e8584": "audit log, layouts, snapshots, workflows, hosts) \u2014 compressed, immediately as a download. ",
  "adm.9349ee": "Same rotation (keep the 14 newest) as \u201Cmake backup\u201D.",
  "adm.b86bfc": "No backup yet.",
  "adm.2099e6": "Download",
  "adm.2bd339": "Restore",
  "adm.150dcd": "Uploading \u2026",
  "adm.047e43": "Upload backup file (instead of choosing from the list above):",
  "adm.aec2da": "No backup yet \u2014 create one first or upload a file above.",
  "adm.2a2629": "REPLACES the entire current database content (users, role bindings, audit log, ",
  "adm.316a1c": "layouts, snapshots, workflows, hosts) with the chosen state \u2014 cannot be undone ",
  "adm.46dc6f": "except by another restore. The orchestrator is unreachable during the process ",
  "adm.4ec161": "(a few seconds), this page reloads automatically afterwards.",
  "adm.2cfe4a": "Choose backup \u2026",
  "adm.80c34c": "To confirm, type exactly: {p0}",
  "adm.42e0ae": "Starting restore \u2026",
  "adm.ea2f07": "Server is restarting \u2026",
  "adm.69d86c": "Sending the restore job to the supervisor.",
  "adm.e55e76": "The database is being restored, the orchestrator then restarts automatically \u2014 ",
  "adm.84e42d": "this page reloads by itself as soon as it is reachable again.",
  "adm.cl.role": "Role",
  "adm.cl.witness": "Witness (votes only)",
  "adm.cl.lostTitle": "Cluster without a majority",
  "adm.cl.lostText": "No leader has been reachable for {p0} s: failover, the scheduler and everything only the leader does are stopped. Usually the other orchestrator is down or unreachable. To avoid this permanently: set up a third Raft node (witness, separate machine).\n\nIf the partner is really down and stays down, this orchestrator can be run as a single node (emergency exit).",
  "adm.cl.solo": "Continue as single node \u2026",
  "adm.cl.soloConfirm": "Emergency exit: at its next start this orchestrator runs as the ONLY node and forgets its partners.\n\nOnly do this if the other orchestrator has really failed and will not start again. If it is still running you get two leaders side by side (split brain): both control the same hosts and nodes.\n\nRestart this orchestrator afterwards. Re-add the partner later as a new member (with a fresh data directory).",
  "adm.cl.soloConfirmBtn": "Schedule",
  "adm.cl.pendingTitle": "Emergency exit scheduled",
  "adm.cl.pendingText": "At its next start this orchestrator runs as a single node. Restart it now (systemctl restart or make stop && make start). Until then the scheduling can still be withdrawn.",
  "adm.cl.cancel": "Withdraw scheduling",
  "adm.58518d": "Cluster ({p0} members)",
  "adm.6c359d": "+ Add another orchestrator",
  "adm.3a035f": "Loading cluster status \u2026",
  "adm.67691f": "This instance",
  "adm.7f5acf": "State",
  "adm.5158a2": "Leader",
  "adm.cf5f30": "Term",
  "adm.2aeb64": "Applied log index",
  "adm.262954": "{p0} (this instance)",
  "adm.76d1d0": "Raft address",
  "adm.1771bd": "Enter node ID and Raft address of the new instance, run the script below on it, ",
  "adm.13b8c8": "wait until it is running (passive, without self-bootstrap) \u2014 then let it join here.",
  "adm.045fdc": "Node ID, e.g. node-2",
  "adm.ca9750": "Raft address, e.g. host-2:8300",
  "adm.c5ce55": "Copy script",
  "adm.70dfc1": "Copied!",
  "adm.5728d7": "Let it join now",
  "adm.d07366": "The last remaining leader cannot be removed.",
  "kss.8b9c05": " (not available)",
  "kss.1e116b": "\u2014 choose \u2014",
  "alv2.1f3b58": "{p0} of {p1} at {p2}",
  "alv2.6edd48": ", until {p0}",
  "aps.wfSearch": "Search workflow \u2026",
  "aps.wfNone": "No match",
  "aps.00a8fd": "Workflow: All",
  "hw2.592c6d": "virtual machine in its own network",
  "loc2.1c3172": "e.g. archive share",
  "set2.09cc1e": "\u201C{p0}\u201D saved.",
  "set2.9ad047": "effective: {p0} ({p1})",
  "set2.ae997f": "saved: {p0} \u2014 only applies after an orchestrator restart",
  "ver.a4394c": "development build",
  "ver.afterRelease": "development build after {p0}, +{p1}",
  "ver.f7c666": "Firmware {p0}{p1}",
  "aml.ec4721": "Mono (1)",
  "aml.5d9b47": "Mono",
  "aml.490585": "Stereo (2)",
  "aml.64d485": "Custom count \u2026",
  "aml.935327": "Channel {p0}",
  "aml.24354f": "Mono \u2192 stereo (duplicated)",
  "aml.672b84": "The single channel goes unchanged (100%) to both output tracks.",
  "aml.f5f0a7": "Stereo \u2192 mono (sum, \u22123dB per channel)",
  "aml.5284e1": "L and R are summed at 70.7% (\u22123dB) each onto one output track.",
  "aml.40faff": "L/R unchanged (100%), centre and the same-side surround channel mixed in at \u22123dB (70.7%). LFE is deliberately left out (common practice) \u2014 add it manually afterwards if needed.",
  "avl.093ab0": "Descriptive",
  "avl.02822c": "Editorial",
  "avl.c52083": "Technical",
  "avl.133411": "Custom fields",
  "avl.a45da9": "System",
  "avl.4bf36f": "Ingest",
  "avl.469b92": "Registered",
  "avl.379ee8": "Ready",
  "avl.9b9437": "In review",
  "avl.6bb8d0": "Approved",
  "avl.18a0e4": "Published",
  "avl.d11aee": "Archived",
  "avl.768a27": "Expired",
  "avl.b74b71": "Deleted",
  "avl.29cb3a": '{p0}: field without a name (value "{p1}")',
  "avl.70ac00": '{p0}: field "{p1}" is not a valid value (JSON expected)',
  "avl.d94f16": "{p0} Mbit/s",
  "ll.8ffe83": "not checked",
  "ll.1700cd": " \xB7 free {p0} of {p1}",
  "ll.a1b35e": "readable, {p0} entries{p1}",
  "sl.23c90e": "Manual/{p0}",
  "sl.51279b": "Started manually",
  "sl.72ce72": "Network",
  "sl.501ffd": "{p0} Gbit/s",
  "sl.d94f16": "{p0} Mbit/s",
  "stl.0a6892": "General",
  "stl.440a36": "Default: {p0}",
  "stl.36a797": "Default: determined by the node",
  "stl.cca832": "allowed: {p0} to {p1}",
  "stl.e2aa67": "File",
  "stl.6c4ca0": "Directory",
  "stl.b2780d": "must exist",
  "wpl.d6616a": "Demand unknown",
  "wpl.4bb2ed": "no measurements (local)",
  "wpl.72049b": "no measurements",
  "wpl.e580f1": "now {p0}",
  "pscl.edf89b": "Node function",
  "pscl.3ec2a9": "Calls a function of a running microservice (e.g. start recording, show graphic).",
  "pscl.252f47": "Web call (HTTP)",
  "pscl.be6156": "Calls a web address (REST API of another system).",
  "pscl.ba264e": "File tool (ffmpeg)",
  "pscl.50dc19": "Runs an enabled tool such as ffmpeg/ffprobe \u2014 e.g. create a proxy, read metadata.",
  "pscl.490ba3": "Notification",
  "pscl.6b7645": "Sends a message on the event bus that other systems can react to.",
  "pscl.9da01f": "Subprocess",
  "pscl.96a4f7": "Starts another process and waits until it has finished.",
  "pscl.ae59d5": "If \u2026 then",
  "pscl.1a789c": "Checks a rule and branches into a yes or no path.",
  "pscl.a6e3cb": "Switch (several cases)",
  "pscl.29f701": "Checks several rules in turn and takes the path of the first matching case.",
  "pscl.755c8f": "Split in parallel",
  "pscl.6f5185": "Starts all connected following steps at the same time.",
  "pscl.834ac6": "Join",
  "pscl.c8f0b4": "Waits until all incoming paths have arrived.",
  "pscl.f152a5": "Wait",
  "pscl.402c2d": "Pauses the flow for a fixed time.",
  "pscl.efb477": "Timer",
  "pscl.534969": "Like \u201CWait\u201D: continues after the time has elapsed.",
  "pscl.4ca08f": "Task for a person",
  "pscl.774c40": "Creates a task that a person has to complete before the flow continues.",
  "pscl.c947f6": "Approval",
  "pscl.5f3043": "A person approves, rejects or requests changes \u2014 a separate path per result.",
  "pscl.e4fa94": "Task (generic)",
  "pscl.8faa35": "Placeholder without built-in execution.",
  "pscl.6c5de6": "Loop",
  "pscl.2b4ae5": "Not executable yet.",
  "pscl.3727f6": "Wait for event",
  "pscl.dcc732": "Not executable yet \u2014 start processes by events via \u201CTriggers\u201D in the toolbar.",
  "pscl.cec559": "Compensation",
  "pscl.3e9f80": "HTTP status (e.g. 200)",
  "pscl.f385d3": "Response (content)",
  "pscl.0d3958": "Exit code (0 = ok)",
  "pscl.b65498": "Output (stdout)",
  "pscl.daeec0": "Error output (stderr)",
  "pscl.7c0760": "Decision",
  "pscl.cd0559": "Comment",
  "pscl.9d885e": "Edited by",
  "pscl.6cf0a2": "Chosen path",
  "pscl.2f0304": "Result (overall)",
  "pscl.8c7a60": "Asset ID",
  "pscl.406438": "New status",
  "pscl.06464c": "Changed by",
  "pscl.a405eb": "Asset was created",
  "pscl.18a802": "Title",
  "pscl.c2ea84": "Type",
  "pscl.e94273": "Asset metadata was changed",
  "pscl.481861": "Asset version was created",
  "pscl.3ef4be": "Version ID",
  "pscl.668bfa": "Version number",
  "pscl.f87cf1": "Asset version was published",
  "pscl.e1ed1e": "Asset changes to \u201C{p0}\u201D",
  "pscl.cedbae": "Start input / triggering event",
  "pscl.0ac1be": "Result of \u201C{p0}\u201D ({p1})",
  "pscl.b74155": "ID of this process run",
  "pscl.5657ea": "Process run",
  "pscl.44923c": "Correlation ID",
  "pscl.a65a49": "Number of previous retries",
  "pscl.4ef614": "is equal to",
  "pscl.d83ad5": "is not equal to",
  "pscl.7b8174": "is greater than",
  "pscl.a113df": "is at least",
  "pscl.d2c8f8": "is less than",
  "pscl.c64548": "is at most",
  "pscl.a4aaeb": "contains",
  "pscl.460b70": "starts with",
  "pscl.dd578a": "Changes requested",
  "pscl.b397ec": "No",
  "pscl.847202": "Seconds",
  "pscl.2006ff": "Minutes",
  "pscl.f45588": "Hours",
  "pscl.5f5c5a": "no retry",
  "pscl.616a18": "up to {p0} attempts, {p1} interval",
  "pscl.b987ca": "Read technical metadata",
  "pscl.4b6338": "Delivers codec, resolution, duration etc. as JSON in the result field \u201COutput (stdout)\u201D.",
  "pscl.ebf39e": "Create proxy (H.264, 960 px wide)",
  "pscl.71816a": "Small viewing copy of the source file.",
  "pscl.e0f287": "Create thumbnail",
  "pscl.5ad538": "Single frame at second 5, 480 px wide.",
  "pscl.e33f6d": "Extract audio track as WAV",
  "pscl.272a13": "Single frame from a video, e.g. for a preview tile.",
  "pscl.44038d": "Convert format/codec",
  "pscl.fef9af": "Freely choose container, video/audio codec and their settings \u2014 with the real allowed values and help texts from this server. Also contains the graphical audio matrix and the filter graph builder.",
  "pscl.1d7d40": "Extract audio track",
  "pscl.7faa8d": "Save only the sound of a file, with a freely selectable audio codec.",
  "pscl.b1e82a": "Join clips (cut list)",
  "pscl.8f2c02": "Join several files in a defined order into one output file \u2014 optionally with start/end trimming per clip.",
  "pscl.02bf41": "Overlay/channel ID/credits timed insert",
  "pscl.ca9a47": "Overlay text (e.g. lower third, end credits) or an image (e.g. channel logo) on the video at defined times.",
  "pscl.c974f8": "Normalize loudness (EBU R128)",
  "pscl.7cfc14": "Bring the audio track to a target loudness (LUFS), e.g. for broadcast acceptance (-23 LUFS) or streaming platforms. Single-pass method \u2014 use expert mode for an even more precise two-pass measurement.",
  "pscl.eee8e9": "Lossless passthrough/remux (change container)",
  "pscl.853c91": "Change container without re-encoding (stream copy) \u2014 fast, but only possible between compatible containers/codecs.",
  "pscl.dcd50a": "Streaming output ladder (multi-bitrate HLS)",
  "pscl.9e4fd7": "Several resolutions/bitrates at once as an HLS output ladder (master playlist + one subfolder per rendition) \u2014 for adaptive streaming in web/app players.",
  "pscl.be80be": "File to check",
  "pscl.7d7927": "File to check missing.",
  "pscl.7ddbbe": "Input file",
  "pscl.70f1da": "Output file (image)",
  "pscl.a0ef65": "Point in the video",
  "pscl.86b066": "Width in pixels",
  "pscl.08822b": "Pixels",
  "pscl.969a03": "Height is calculated proportionally.",
  "pscl.9205c3": "Input and output file are required.",
  "pscl.f6dd2b": "Width: not a valid number.",
  "pscl.8adabd": "Output file",
  "pscl.16202d": "Audio codec",
  "pscl.1ea5b7": "Empty = ffmpeg default for the chosen file extension.",
  "pscl.0b9820": "Target loudness (LUFS)",
  "pscl.85ee17": "EBU R128 (broadcast acceptance): -23. Common streaming targets: -16 (YouTube), -14 (Spotify/Apple Music).",
  "pscl.475054": "Maximum true peak (dBTP)",
  "pscl.d7f1ac": "EBU R128 recommends -1 or lower.",
  "pscl.0c605b": "Loudness range / LRA (LU)",
  "pscl.749393": "Empty = ffmpeg default for the chosen file extension. The picture is always passed through unchanged (stream copy).",
  "pscl.738fb5": "Target loudness: not a valid number.",
  "pscl.b46f8d": "Maximum true peak: not a valid number.",
  "pscl.b2cee1": "Loudness range: not a valid number greater than 0.",
  "pscl.6bbca5": "Force container (optional)",
  "pscl.74d4bd": "Empty = ffmpeg derives it from the extension of the output file.",
  "pscl.4c7e15": "Output directory",
  "pscl.94a565": "Master playlist (master.m3u8) ends up directly here, one subfolder with segments per rendition.",
  "pscl.c93db4": "Segment length (seconds)",
  "pscl.f59f69": "Renditions",
  "pscl.4cba27": "At least one \u2014 each is created as its own bitrate/resolution in the output ladder. Name only letters/numbers/hyphen (used as directory name).",
  "pscl.475096": "Rendition {p0}",
  "pscl.49ee30": "Name",
  "pscl.9a9491": "Width (pixels)",
  "pscl.cd2da5": "Height (pixels)",
  "pscl.64153c": "Video bitrate (kbit/s)",
  "pscl.45845d": "Audio bitrate (kbit/s)",
  "pscl.d99ff6": "Input file and output directory are required.",
  "pscl.98a492": "Segment length: not a valid number greater than 0.",
  "pscl.138685": "At least one rendition is required.",
  "pscl.cf38a8": "Every rendition needs a name.",
  "pscl.d1865d": '"{p0}": name may only contain letters, numbers and hyphen.',
  "pscl.67d2c0": '"{p0}": width/height must be valid numbers greater than 0.',
  "pscl.754226": '"{p0}": video bitrate must be a valid number greater than 0.',
  "pscl.202bf1": '"{p0}": audio bitrate must be a valid number greater than 0.',
  "pscl.73802f": "Rendition names must be unique.",
  "pscl.bf4c3c": "Range: {p0} to {p1}",
  "pscl.440a36": "Default: {p0}",
  "pscl.cce2fa": 'Possible values (combinable with "+", e.g. {p0}+{p1}): {p2}',
  "pscl.c55048": "Overwrite the output file without asking.",
  "pscl.f464ad": "Never overwrite \u2014 aborts if the output file exists.",
  "pscl.72cb7c": "Suppresses ffmpeg's version/build banner output.",
  "pscl.7d0ede": "Verbosity of the console output.",
  "pscl.041552": "Start time (before -i: input seeking, fast; after -i: output seeking, more exact).",
  "pscl.3cb7b9": "Maximum duration from the start time.",
  "pscl.1085b1": "End time (alternative to -t).",
  "pscl.f32cca": "Force container format (otherwise derived from the file extension).",
  "pscl.847d4a": 'Selects streams for the output, e.g. "0:v" or "1:a:0".',
  "pscl.0230a4": "Do not include a video track in the output.",
  "pscl.36692c": "Do not include an audio track in the output.",
  "pscl.39341f": "Do not include a subtitle track in the output.",
  "pscl.a81aa9": "Do not include a data track in the output.",
  "pscl.aaf04a": 'Codec for all streams (short form for -c:v/-c:a/-c:s together), e.g. "copy".',
  "pscl.748b37": "Video codec, e.g. libx264 or copy.",
  "pscl.76a00d": "Audio codec, e.g. aac or copy.",
  "pscl.eb5986": "Subtitle codec.",
  "pscl.97d5ed": 'Video target bitrate, e.g. "4M".',
  "pscl.5608df": 'Audio target bitrate, e.g. "192k".',
  "pscl.93946f": "Audio sample rate in Hz, e.g. 48000.",
  "pscl.118fc3": "Number of audio channels.",
  "pscl.579128": "Video frame rate in fps.",
  "pscl.f2e288": 'Video resolution, e.g. "1920x1080".',
  "pscl.cce5db": 'Aspect ratio, e.g. "16:9".',
  "pscl.a86942": "Video filter chain (short form for -filter:v).",
  "pscl.1f23d9": "Audio filter chain (short form for -filter:a).",
  "pscl.21909e": "Multi-input/output filter graph.",
  "pscl.044b6e": 'Metadata key=value, e.g. "title=My title".',
  "pscl.503bf8": "Number of encoding threads (0 = automatic).",
  "pscl.046953": "End the output at the shortest input track.",
  "pscl.03361f": "GOP size (distance between keyframes).",
  "pscl.b70c5f": "Maximum number of consecutive B-frames.",
  "pscl.b74742": "Timestamp/frame adjustment on output.",
  "pscl.53e1fb": "Expects one of: {p0}",
  "pscl.9b0b40": 'Expects "true" or "false".',
  "pscl.13a83c": "Expects a number.",
  "pscl.e2bc00": "Expects a value between {p0} and {p1}.",
  "pscl.d2383a": '"{p0}" takes no value (on/off flag).',
  "pscl.29c387": 'Expects a duration, e.g. "5" or "00:01:23.5".',
  "pscl.3c326c": "Address (URL) missing",
  "pscl.4423d3": "Tool missing",
  "pscl.a400c0": "Node/function missing",
  "pscl.d92700": "Channel missing",
  "pscl.bf4504": "Rule missing",
  "pscl.131bec": "at least one case required",
  "pscl.a9dca0": "Process missing",
  "pscl.d60d5c": "Wait time missing",
  "misc.failedWith": "{p0} failed: {p1}",
  "misc.wfSaveFailed": "Saving into the workflow failed: {p0}",
  "misc.failed": "failed",
  "y.dm51": "5.1 \u2192 stereo (ITU downmix, \u22123dB)",
  "y.addIn": "+ Input",
  "y.addOut": "+ Output",
  "y.std": "\u2013 Default \u2013",
  "y.oneTile": "1 tile",
  "y.addEntry": "+ Entry",
  "y.addCase": "+ Case",
  "y.addTrack": "+ Output track",
  "y.typo": "\u2248 Typo?",
  "y.addArg": "+ Argument",
  "y.redo": "\u21B7 Redo",
  "y.orgStd": "{p0} (default)",
  "y.newBackend": "+ New backend",
  "y.global": "(Global)",
  "y.importNode": "+ Import node/microservice",
  "y.netPart": " / Network {p0}%",
  "y.dupField": '{p0}: field "{p1}" duplicated',
  "y.addRel": "+ Relation",
  "y.addRep": "+ Representation",
  "y.addField": "+ Field",
  "y.assign": "\u270E Assign",
  "y.netPct": " \xB7 Network {p0} %",
  "y.netRxTx": " \xB7 Network Rx {p0} \xB7 Tx {p1}",
  "sched.ownLane": "{p0} \u2014 own share (shared machine)",
  "sched.sharedMachine": "Shared machine: ",
  "sched.placementHint": " Running workflows count on the host they actually run on; planned roles without a fixed host are assigned to the host placement will most likely choose at start (lowest load, excluding hosts in maintenance) \u2014 a forecast.",
  "sched.editOk": "OK",
  "y.bottleneck": "\u26A0 Bottleneck: {p0}{p1}",
  "y.resBottleneck": "\n\u26A0 Resource bottleneck: {p0}",
  "y.stdOpt": "\u2014 Default{p0} \u2014",
  "y.cores": "~{p0} cores \xB7 {p1}",
  "portTags.titleOut": "Tags of output \u201C{label}\u201D",
  "portTags.titleIn": "Tags of input \u201C{label}\u201D",
  "portTags.inherited": "Automatic (read-only):",
  "portTags.inheritedHint": "\u24D8 derived from media type/channel count, \u25CC reported by the node",
  "portTags.placeholder": "e.g. role.commentator",
  "portTags.add": "Add tag",
  "portTags.remove": "Remove tag",
  "portTags.none": "No custom tags",
  "portTags.save": "Save",
  "portTags.cancel": "Cancel",
  "portTags.unknown": "Port not found in the registry \u2014 node offline?",
  "portTags.loadFailed": "Could not load tags: {err}",
  "portTags.err.invalid": "Format: domain.name (lowercase, digits, hyphen), e.g. audio.commentator",
  "portTags.err.duplicate": "Tag is already set",
  "portTags.err.limit": "At most 32 tags per port",
  "portTags.button": "Edit port tags",
  "portTags.saveFirst": "Save or cancel before choosing another port",
  "flow.migrateButton": "Move to another host",
  "anchor.noRemove": "The playout buffer is the fixed output of this workflow and cannot be removed.",
  "anchor.tooltip": "Output anchor \u2014 fixed",
  "anchor.depthLabel": "Buffer (ms)",
  "anchor.depthTitle": "Buffer depth of this workflow in milliseconds (empty = 2500). The larger, the longer an outage upstream is bridged \u2014 and the more memory is used.",
  "sd.title": "Stream Deck test and simulator",
  "sd.model": "Model",
  "sd.connectReal": "Connect real device",
  "sd.disconnect": "Disconnect",
  "sd.simulate": "Start simulator",
  "sd.sendGrid": "Send test grid",
  "sd.brightness": "Brightness",
  "sd.connected": "Connected: {name}",
  "sd.notConnected": "Not connected",
  "sd.log": "Events",
  "sd.err.no-webhid": "This browser does not support WebHID (use Chrome or Edge on desktop).",
  "sd.err.insecure-context": "WebHID requires HTTPS or localhost.",
  "sd.err.denied": "Access to the device was not granted.",
  "sd.err.unsupported-model": "This Stream Deck model is not supported yet.",
  "sd.err.open-failed": "The device could not be opened (is another program holding it? udev rule set?).",
  "sd.renderTest": "Render test",
  "board.streamDeck": "Stream Deck",
  "midi.button": "MIDI",
  "midi.title": "MIDI surfaces",
  "midi.hint": "Motorised-fader surfaces (e.g. iCON V1-M/P1-M with extender) and other MIDI devices control the audio mixer. USB devices connect directly to the browser (Chrome or Edge); surfaces on the server or on the network (RTP-MIDI) are handled by the \u201CMIDI gateway\u201D node.",
  "midi.mode": "Mode",
  "midi.mode.mcu": "Mackie Control (mixing console)",
  "midi.mode.profile": "Generic profile (map knobs and keys)",
  "midi.search": "Find MIDI devices",
  "midi.unit.main": "Main surface",
  "midi.unit.ext": "Extender {n}",
  "midi.none": "\u2013 none \u2013",
  "midi.mixer": "Audio mixer",
  "midi.mixer.none": "\u2013 choose node \u2013",
  "midi.masterAux": "Master fader drives aux bus (ID, empty = none)",
  "midi.start": "Start",
  "midi.stop": "Stop",
  "midi.sim": "Start simulator (surface + extender)",
  "midi.status.running": "Running",
  "midi.status.stopped": "Not started",
  "midi.unit.state": "{name}: {state}",
  "midi.unit.online": "responding",
  "midi.unit.silent": "still silent",
  "midi.bank": "Bank {n}",
  "midi.err.no-webmidi": "This browser does not support Web MIDI (use Chrome or Edge on desktop).",
  "midi.err.insecure-context": "Web MIDI requires HTTPS or localhost.",
  "midi.err.denied": "MIDI access was not allowed (SysEx permission required).",
  "midi.err.no-port": "No MIDI device selected.",
  "midi.err.no-profile": "No valid profile.",
  "midi.err.imap": "This port belongs to the surface's programming software iMAP (port 4) \u2014 choose one of the \u201CDAW 1\u20133\u201D ports.",
  "midi.err.no-mixer": "Please choose an audio mixer.",
  "midi.profile.label": "Profile (JSON)",
  "midi.profile.check": "Check",
  "midi.profile.ok": "Profile is valid ({n} controls).",
  "midi.profile.example": "Insert example",
  "midi.learn": "Learn",
  "midi.learn.wait": "Move a knob or press a key on the device \u2026",
  "midi.learn.got": "{type} {num}, channel {ch}, value {v}",
  "midi.last": "Last seen",
  "midi.sim.title": "Simulator",
  "midi.sim.touch": "Touch and drag the fader",
  "midi.keys.label": "Keys, function field and jog (JSON, empty = default mapping)",
  "midi.keys.check": "Check keys",
  "midi.keys.example": "Insert example",
  "midi.keys.ok": "Key mapping is valid.",
  "midi.keys.hint": "Default: F1\u2013F8 act on the selected channel (mute, PFL, phase, EQ bypass, comp, gate, main, clear mutes), arrows select channel / \xB11 dB, \u201CSolo\u201D clears listening, Scrub switches the jog wheel, the eight view keys choose pages. Everything else (play, stop \u2026) is reported as an event by the gateway.",
  "midi.sim.keys": "Function keys, pages, jog",
  "perm.title": "Permissions",
  "perm.feat.title": "Feature rights",
  "perm.feat.hint": "Single functions of the modules (e.g. create recordings, check files). They take effect immediately; anyone with \u201CConfigure\u201D on everything may do it all anyway.",
  "perm.feat.none": "No feature rights available (no module with feature rights is active).",
  "perm.feat.all": "All rights of the module",
  "perm.feat.viaAll": "through \u201CAll rights of the module\u201D",
  "perm.feat.viaGroup": "inherited from group {p0}",
  "perm.feat.viaAdmin": "administrators may do everything",
  "perm.hint": "One right per user/group and scope. Changes apply immediately. Search finds names, nodes, workflows, roles and processes.",
  "perm.search.ph": "Search: user, group, node, workflow, process \u2026",
  "perm.mode.subject": "Who? (users/groups)",
  "perm.mode.resource": "On what? (scopes)",
  "perm.users": "Users",
  "perm.groups": "Groups",
  "perm.admin.tag": "Admin",
  "perm.kind.all": "All",
  "perm.kind.global": "Global",
  "perm.kind.workflow": "Workflow",
  "perm.kind.role": "Workflow role",
  "perm.kind.node": "Node",
  "perm.kind.process": "Process",
  "perm.kind.user": "User",
  "perm.kind.group": "Group",
  "perm.scope.global": "Everything (global)",
  "perm.scope.whole": "whole workflow",
  "perm.verb.view": "View",
  "perm.verb.operate": "Operate",
  "perm.verb.configure": "Configure",
  "perm.verb.admin": "Administer",
  "perm.verbdesc.view": "may only watch",
  "perm.verbdesc.operate": "may switch and change values",
  "perm.verbdesc.configure": "may also change setup and settings",
  "perm.verbdesc.admin": "full access including granting rights",
  "perm.legend": "Rights build on each other: Administer includes Configure, Operate and View.",
  "perm.empty.pick": "Pick an entry on the left.",
  "perm.none": "No rights granted yet.",
  "perm.none.resource": "Nobody has rights on this scope yet.",
  "perm.noMatch": "No matches.",
  "perm.count": "{p0} rights",
  "perm.members": "{p0} members",
  "perm.members.list": "Members: {p0}",
  "perm.members.none": "No members",
  "perm.memberOf": "Member of: {p0}",
  "perm.admin.note": "Administrator \u2013 automatically has full access.",
  "perm.inherited": "Inherited via group {p0}",
  "perm.openGroup": "Open group",
  "perm.missing": "no longer exists",
  "perm.add.title": "Add right",
  "perm.add.pickScope": "Search scope (node, workflow, process \u2026)",
  "perm.add.pickSubject": "Search user or group \u2026",
  "perm.add.btn": "Add",
  "perm.more": "\u2026 {p0} more, keep typing",
  "perm.remove": "Remove",
  "perm.removeConfirm": "Remove right \u201C{p2}\u201D of {p0} on {p1}?",
  "perm.error": "Saving failed: {p0}",
  "aud.a.login": "Sign-in",
  "aud.a.userCreate": "User created",
  "aud.a.userDelete": "User {p0} deleted",
  "aud.a.userPw": "Password of {p0} reset",
  "aud.a.userOrg": "Organization of {p0} changed",
  "aud.a.userRevoke": "Sessions of {p0} revoked",
  "aud.a.orgCreate": "Organization created",
  "aud.a.orgDelete": "Organization {p0} deleted",
  "aud.a.bindCreate": "Right granted",
  "aud.a.bindDelete": "Right removed",
  "aud.a.groupCreate": "Group created",
  "aud.a.groupUpdate": "Group {p0} changed",
  "aud.a.groupDelete": "Group {p0} deleted",
  "aud.a.groupAdd": "Member added to group {p0}",
  "aud.a.groupRemove": "{p1} removed from group {p0}",
  "aud.a.wfCreate": "Workflow created",
  "aud.a.wfImport": "Workflow imported",
  "aud.a.wfSave": "Workflow {p0} saved",
  "aud.a.wfDelete": "Workflow {p0} deleted",
  "aud.a.wfStart": "Workflow {p0} started",
  "aud.a.wfStop": "Workflow {p0} stopped",
  "aud.a.wfPause": "Workflow {p0} paused",
  "aud.a.wfRoleRestart": "Role {p1} in {p0} restarted",
  "aud.a.wfRoleMigrate": "Role {p1} in {p0} moved to another host",
  "aud.a.migConfirm": "Move of role {p1} in {p0} confirmed",
  "aud.a.migCancel": "Move of role {p1} in {p0} cancelled",
  "aud.a.instStart": "Instance started",
  "aud.a.instStop": "Instance {p0} stopped",
  "aud.a.instEdit": "Instance {p0} changed",
  "aud.a.instRestart": "Instance {p0} restarted",
  "aud.a.instMigrate": "Instance {p0} moved to another host",
  "aud.a.instToken": "Service token issued for {p0}",
  "aud.a.hostDelete": "Host {p0} removed",
  "aud.a.hostMaint": "Host {p0} put into maintenance",
  "aud.a.hostMaintEnd": "Maintenance of host {p0} ended",
  "aud.a.hostToken": "Host join code created",
  "aud.a.hostRegister": "Host registered",
  "aud.a.clusterJoin": "Cluster join",
  "aud.a.clusterLeave": "Cluster member {p0} removed",
  "aud.a.catImport": "Node type imported",
  "aud.a.catDelete": "Node type {p0} removed",
  "aud.a.edgeCreate": "Connection made",
  "aud.a.edgeDelete": "Connection removed",
  "aud.a.layoutSave": "Layout {p0} saved",
  "aud.a.snapSave": "Scene saved",
  "aud.a.snapApply": "Scene applied",
  "aud.a.srcTags": "Source tags changed",
  "aud.a.sinkTags": "Sink tags changed",
  "aud.a.nodeLayoutSave": "Layout saved on {p0}",
  "aud.a.nodeLayoutApply": "Layout {p1} applied on {p0}",
  "aud.a.nodeLayoutDelete": "Layout {p1} deleted from {p0}",
  "aud.a.inviteCreate": "Invite created for {p0}",
  "aud.a.inviteDelete": "Invite for {p0} withdrawn",
  "aud.a.nodeParam": "{p0}: parameter \u201C{p1}\u201D changed",
  "aud.a.nodeState": "{p0}: state applied",
  "aud.a.nodePlugin": "{p0}: plugin \u201C{p1}\u201D changed",
  "aud.a.nodeMethod": "{p0}: {p1}",
  "aud.a.procCreate": "Process created",
  "aud.a.procSave": "Process {p0} changed",
  "aud.a.procDelete": "Process {p0} deleted",
  "aud.a.procVersion": "New version of process {p0}",
  "aud.a.procPublish": "Process version published",
  "aud.a.procDeprecate": "Process version deprecated",
  "aud.a.procArchive": "Process version archived",
  "aud.a.procStart": "Process started",
  "aud.a.procCancel": "Process execution cancelled",
  "aud.a.procPause": "Process execution paused",
  "aud.a.procResume": "Process execution resumed",
  "aud.a.taskAssign": "Task assigned",
  "aud.a.taskDone": "Task completed",
  "aud.a.chCreate": "Playout channel created",
  "aud.a.chDelete": "Playout channel deleted",
  "aud.a.assetCreate": "Asset created",
  "aud.a.assetMeta": "Asset metadata changed",
  "aud.a.assetStatus": "Asset status changed",
  "aud.a.storeCreate": "Storage backend created",
  "aud.a.storeEdit": "Storage backend changed",
  "aud.a.storeDelete": "Storage backend deleted",
  "aud.a.locCreate": "Storage location created",
  "aud.a.locEdit": "Storage location changed",
  "aud.a.locDelete": "Storage location deleted",
  "aud.a.backup": "Backup created",
  "aud.a.restore": "Backup restored",
  "aud.a.updUpload": "Update package uploaded",
  "aud.a.updApply": "Update applied",
  "aud.a.updDist": "Update distributed to hosts",
  "aud.a.updRestart": "Outdated instances restarted",
  "aud.a.updDelete": "Update package deleted",
  "aud.a.setSys": "System setting {p0} changed",
  "aud.a.setNode": "Setting {p1} changed for {p0}",
  "aud.a.verRollout": "Node version {p0} rolled out",
  "aud.a.verProd": "Node version {p0} marked productive",
  "aud.a.alarmAck": "Alarm acknowledged",
  "aud.a.alarmUnack": "Alarm acknowledgement removed",
  "aud.m.crosspoint.take": "Take",
  "aud.m.crosspoint.cut": "Cut",
  "aud.m.crosspoint.autoTrans": "Auto transition",
  "aud.m.crosspoint.select": "Source preselected",
  "aud.m.crosspoint.setTransitionPosition": "Transition fader moved",
  "aud.m.crosspoint.setTransType": "Transition type changed",
  "aud.m.crosspoint.setTransRate": "Transition rate changed",
  "aud.m.crosspoint.pin": "Source pinned",
  "aud.m.take": "Take",
  "aud.m.select": "Source selected",
  "aud.m.selectSource": "Source selected",
  "aud.m.load": "Clip loaded",
  "aud.m.cue": "Clip cued",
  "aud.m.play": "Play",
  "aud.m.playAt": "Play at time",
  "aud.m.stop": "Stop",
  "aud.m.seek": "Seek",
  "aud.m.append": "Item appended",
  "aud.m.updateItem": "Item changed",
  "aud.m.show": "Show",
  "aud.m.hide": "Hide",
  "aud.m.addChannel": "Channel added",
  "aud.m.addAux": "Aux bus added",
  "aud.m.record.start": "Recording started",
  "aud.m.record.stop": "Recording stopped",
  "aud.m.keyer.setEnabled": "Keyer toggled",
  "aud.m.pip.setEnabled": "PiP toggled",
  "aud.m.pip.applyPreset": "PiP preset applied",
  "aud.m.pip.toggleFocus": "PiP focus toggled",
  "aud.m.pip.focus": "PiP brought into focus",
  "aud.m.pip.unfocus": "PiP focus ended",
  "aud.m.pip.clickAt": "PiP clicked in the PGM picture",
  "aud.m.setRouting": "Routing changed",
  "aud.m.setVideoContext": "Video context set",
  "aud.m.setSourceContext": "Source context set",
  "aud.m.clearSourceContext": "Source context cleared",
  "aud.m.setChildren": "Children set",
  "aud.m.setOffered": "Offer set",
  "aud.m.setTransition": "Transition set",
  "aud.cw.setGain": "Level",
  "aud.cw.setPan": "Pan",
  "aud.cw.setMute": "Mute",
  "aud.cw.setEqGain": "EQ gain",
  "aud.cw.setEqBand": "EQ band",
  "aud.cw.setSource": "Source",
  "aud.cw.setFollow": "Audio follows video",
  "aud.cw.setPfl": "PFL",
  "aud.cw.setSend": "Send",
  "aud.cat.login": "Sign-ins",
  "aud.cat.users": "Users",
  "aud.cat.rights": "Rights & groups",
  "aud.cat.workflows": "Workflows",
  "aud.cat.instances": "Instances & hosts",
  "aud.cat.graph": "Connections & layouts",
  "aud.cat.layout": "View layout (automatic)",
  "aud.cat.operate": "Operation (switching, faders)",
  "aud.cat.processes": "Processes",
  "aud.cat.media": "Media & storage",
  "aud.cat.system": "System",
  "aud.title": "Audit log",
  "aud.hint": "Who changed what, and when? Plain reads are not logged. \u201COperation\u201D (switching, faders) and automatic view layout are hidden by default.",
  "aud.search.ph": "Search: user, node, workflow, process \u2026",
  "aud.user.all": "All users",
  "aud.res.all": "All results",
  "aud.res.onlyOk": "Successful only",
  "aud.res.onlyFailed": "Failures only",
  "aud.range.1h": "Last hour",
  "aud.range.24h": "24 hours",
  "aud.range.7d": "7 days",
  "aud.range.30d": "30 days",
  "aud.range.all": "All time",
  "aud.cats": "Areas",
  "aud.cats.all": "All",
  "aud.cats.default": "Default",
  "aud.count": "{p0} entries loaded",
  "aud.empty": "No entries for these filters.",
  "aud.more": "Load older",
  "aud.loading": "Loading \u2026",
  "aud.csv": "Export as CSV",
  "aud.today": "Today",
  "aud.yesterday": "Yesterday",
  "aud.by": "by {p0}",
  "aud.generic": "Change: {p0}",
  "aud.details": "Technical details",
  "aud.res.ok": "done",
  "aud.res.400": "invalid input",
  "aud.res.401": "not signed in / wrong credentials",
  "aud.res.403": "not permitted",
  "aud.res.404": "not found",
  "aud.res.409": "conflict (state did not fit)",
  "aud.res.422": "input rejected",
  "aud.res.429": "too many requests",
  "aud.res.5xx": "server error",
  "aud.res.other": "failed",
  "aud.reset": "Reset filters",
  "sup.tab.check": "Self-test",
  "sup.tab.baseline": "Baseline & trends",
  "sup.tab.bundle": "Support bundle",
  "sup.tab.freeze": "Snapshots",
  "sup.tab.analysis": "Analysis",
  "sup.tab.access": "Support access",
  "sup.title": "Support",
  "sup.hint": "See at a glance whether the system is healthy, and collect everything support needs into one file.",
  "sup.recheck": "Check now",
  "sup.loadFailed": "The self-test could not be loaded",
  "sup.checkedAt": "Checked at {time} \u2014 refreshes every 30 seconds",
  "sup.whatToDo": "What to do?",
  "sup.fine": "{n} checks fine",
  "sup.bundle.title": "Create support package",
  "sup.bundle.text": "Creates a ZIP file with the state, messages and system data of this system. It contains no media, no passwords, tokens or keys and no audit log. Please send the file to support unchanged.",
  "sup.bundle.window": "Messages of the last",
  "sup.bundle.create": "Create support package",
  "sup.bundle.working": "Collecting the package \u2026 (up to a minute)",
  "sup.bundle.done": "Done: {name} ({size} KB) was downloaded.",
  "sup.bundle.failed": "The package could not be created: {error}",
  "sup.window.30": "30 minutes",
  "sup.window.120": "2 hours",
  "sup.window.1440": "24 hours",
  "admin.tab.clients": "Connected clients",
  "clients.title": "Connected clients",
  "clients.summary": "{total} connection(s), {users} signed-in user(s)",
  "clients.none": "No identified clients connected.",
  "clients.error": "Could not load clients.",
  "clients.col.user": "User",
  "clients.col.ip": "Address",
  "clients.col.since": "Connected for",
  "clients.col.agent": "Browser",
  "clients.col.actions": "Action",
  "clients.disconnect": "Disconnect",
  "clients.disconnect.hint": "Closes only this connection; the browser reconnects by itself after a few seconds.",
  "clients.disconnect.confirm": "Disconnect {user} ({ip})? The browser will reconnect by itself after a few seconds.",
  "clients.disconnect.done": "Connection closed.",
  "clients.endSessions": "Sign out",
  "clients.endSessions.hint": "Ends all sessions of this user; they must sign in again.",
  "clients.endSessions.confirm": "End all sessions of {user}? They will be signed out on every device and must sign in again.",
  "clients.endSessions.done": "User signed out.",
  "clients.error.action": "Action failed.",
  "aud.a.clientKick": "Client disconnected",
  "clients.search": "Search: user, address, browser, device (e.g. midi, streamdeck, simulator)",
  "clients.summary.filtered": " \u2014 {n} shown",
  "clients.noMatch": "No client matches the search.",
  "clients.col.devices": "Devices",
  "clients.dev.midi": "MIDI",
  "clients.dev.deck": "Stream Deck",
  "clients.dev.sim": "simulator",
  "admin.tab.support": "Support",
  "tl.title": "Timeline",
  "tl.hint": "What changed at 14:02? Everything important on one axis: faults, restarts, operations, changes and markers. Click the bars or drag the slider to see what was wrong at that moment.",
  "tl.window": "Period",
  "tl.window.1h": "last hour",
  "tl.window.6h": "last 6 hours",
  "tl.window.24h": "last 24 hours",
  "tl.window.7d": "last 7 days",
  "tl.cat.fault": "Faults",
  "tl.cat.marker": "Markers",
  "tl.cat.change": "Changes",
  "tl.cat.ops": "Operation",
  "tl.cat.log": "Error logs",
  "tl.operate": "Show operation (faders, cuts)",
  "tl.loading": "Loading \u2026",
  "tl.loadFailed": "The timeline could not be loaded: {error}",
  "tl.empty": "Nothing was recorded in the chosen period.",
  "tl.truncated": "Only the newest {n} rows are shown \u2014 narrow the period for more detail.",
  "tl.slider": "Choose a point in time",
  "tl.pick": "Choose a point in time: click the bars or drag the slider",
  "tl.now": "now",
  "tl.stateAt": "State at {time}",
  "tl.backToNow": "Back to now",
  "tl.problems.title": "Faulty at that moment",
  "tl.problems.none": "Nothing unusual was recorded.",
  "tl.problems.since": "since {time}",
  "tl.changes.title": "This changed in the {min} minutes before",
  "tl.changes.none": "Nothing was recorded before.",
  "tl.limit": "Shows what was recorded: crashes, restarts, media and host outages, clock, workflows, operations, markers. The state before the last orchestrator restart is not known.",
  "note.marker": "What happened? A short note helps support later (optional, at most 200 characters).",
  "note.markerOk": "Set marker",
  "note.freeze": "Why are you freezing? What happened? (optional, at most 200 characters)",
  "note.freezeOk": "Freeze",
  "app.close": "Close",
  "app.menu.devices": "Devices",
  "app.menu.devices.title": "Stream Deck and MIDI desks",
  "app.menu.support": "Support",
  "app.menu.support.title": "Set marker and freeze",
  "tl.mark": "\u2691 Marker",
  "tl.mark.title": "Mark a problem now: puts a marker on the timeline so support can find this minute",
  "tl.marked": "Marker set at {time}",
  "tl.markFailed": "The marker could not be set: {error}",
  "tl.k.instance.crashed": "{label} crashed \u2014 {message}",
  "tl.k.instance.restarted": "{label} was restarted automatically",
  "tl.k.node.notready": "{label} no longer delivers picture or sound",
  "tl.k.node.ready": "{label} delivers picture and sound again",
  "tl.k.host.silent": "Host {label} stopped reporting",
  "tl.k.host.resumed": "Host {label} reports again",
  "tl.k.host.clock.lost": "The clock of {label} is no longer synchronised",
  "tl.k.host.clock.ok": "The clock of {label} is synchronised again",
  "tl.k.workflow.failover": "Failover in workflow {workflow} ({trigger})",
  "tl.k.workflow.status.running": "Workflow {name} is running",
  "tl.k.workflow.status.stopped": "Workflow {name} was stopped",
  "tl.k.workflow.status.failed": "Workflow {name} failed: {error}",
  "tl.k.workflow.status.other": "Workflow {name}: {status}",
  "tl.k.workflow.migration": "Move in workflow {workflow}: {status}",
  "tl.k.host.registered": "Host {label} registered",
  "tl.k.host.removed": "Host {id} was removed",
  "tl.k.host.maintenance": "Maintenance mode of host {id} changed",
  "tl.k.edge.added": "Connection made ({id})",
  "tl.k.edge.removed": "Connection removed ({id})",
  "tl.k.marker": "{actor} marked \u201Cproblem now\u201D",
  "tl.k.marker.note": "{actor} marked: {note}",
  "tl.k.orchestrator.started": "Orchestrator started (version {version})",
  "tl.k.domain": "{type} {id}: {action}",
  "tl.k.other": "Event {kind}",
  "admin.tab.timeline": "Timeline",
  "nd.button": "Diagnosis: what is wrong with this node?",
  "nd.title": "Diagnosis: {node}",
  "nd.loading": "Loading \u2026",
  "nd.refresh": "Refresh",
  "nd.close": "Close",
  "nd.failed": "The diagnosis could not be loaded: {error}",
  "nd.localHost": "runs on this machine",
  "nd.remoteHost": "runs on a host",
  "nd.findings": "Findings",
  "nd.findings.none": "No problems found.",
  "nd.fine": "{n} checks fine",
  "nd.whatToDo": "What to do?",
  "nd.facts": "Process and media",
  "nd.f.restarts": "Automatic restarts",
  "nd.f.cpu": "Processor",
  "nd.f.ram": "Memory",
  "nd.f.threads": "Threads",
  "nd.f.files": "Open files",
  "nd.f.media": "Picture and sound",
  "nd.f.ready": "delivering",
  "nd.f.notReady": "not delivering",
  "nd.f.fps": "Frames per second",
  "nd.pipeline": "Pipeline",
  "nd.pipeline.hint": "From the source (left) to the output (right). Red outline: element in the wrong state. Yellow: buffer full \u2014 the element after it takes data too slowly. A bar shows the fill level.",
  "flow.workflowBand": "Workflows",
  "flow.alarm.crashed": "Crashed",
  "flow.alarm.restarts": "Restarted {n}\xD7",
  "flow.alarm.offline": "Not reachable",
  "nd.pipeline.empty": "The pipeline has no elements yet.",
  "nd.pipeline.inside": "{n} elements",
  "nd.pipeline.fill": "buffer {p} % full",
  "nd.pipeline.note.unsupported": "This node type does not report its pipeline (only nodes with a GStreamer pipeline and a recent version).",
  "nd.pipeline.note.offline": "The node is not reporting \u2014 its pipeline cannot be fetched.",
  "nd.pipeline.note.none": "The node has not registered a pipeline yet.",
  "nd.pipeline.note.unavailable": "The pipeline could not be fetched.",
  "nd.events": "Events of the last 24 hours",
  "nd.events.none": "None recorded.",
  "nd.logs": "Messages (errors and warnings, last 24 hours)",
  "nd.logs.none": "No messages.",
  "nd.footer": "Refreshes every 8 seconds. For support: Administration \u2192 Support \u2192 Create support package.",
  "ec.badge": "error code",
  "ec.cause": "Cause:",
  "ec.steps": "What to do?",
  "ec.doc": "Description in the manual: {path} (section {code})",
  "ec.more": "Cause and solution steps",
  "sup.access.title": "Support access for outside help",
  "sup.access.text": "Creates a link that lets support look at the system for a limited time \u2014 read-only, without an account and without handing out passwords. The link works until it expires or you revoke it; everything support does is in the audit log.",
  "sup.access.duration": "Valid for",
  "sup.access.note": "Note (e.g. ticket number)",
  "sup.access.create": "Create support access",
  "sup.access.d.60": "1 hour",
  "sup.access.d.240": "4 hours",
  "sup.access.d.1440": "24 hours",
  "sup.access.d.4320": "3 days",
  "sup.access.created": "Access created. Send this link to support now \u2014 it is shown only once:",
  "sup.access.copy": "Copy link",
  "sup.access.copied": "Link copied",
  "sup.access.expires": "valid until {time}",
  "sup.access.failed": "The access could not be created: {error}",
  "sup.access.list": "Previous accesses",
  "sup.access.none": "No support access created yet.",
  "sup.access.status.active": "active",
  "sup.access.status.expired": "expired",
  "sup.access.status.revoked": "revoked",
  "sup.access.used": "signed in {n}\xD7, last {time}",
  "sup.access.unused": "never used",
  "sup.access.revoke": "Revoke",
  "sup.access.revokeConfirm": "End this support access now? Support loses access immediately.",
  "sup.access.revokeLabel": "Revoke",
  "sup.access.by": "by {user}",
  "sup.access.banner": "Support access \u2014 read-only, valid until {until} ({min} min left)",
  "sup.access.linkFailed": "Support link invalid",
  "fr.button": "\u2744 Freeze",
  "fr.button.title": "Freeze the last minutes: saves timeline, messages, measurement series and pipeline state as a package for support",
  "fr.done": "Frozen: the last {min} minutes are saved",
  "fr.failed": "Freeze failed: {error}",
  "fr.card.title": "Frozen snapshots (\u201Cflight recorder\u201D)",
  "fr.card.text": "Keeps the last minutes before they are overwritten: events and messages, per-node figures (frame rate, media ready), CPU and memory per process and the pipeline state. It happens on a button press (\u2744 at the top) and automatically when something fails \u2014 crash, media lost, host silent, failover (at most every 5 minutes). Kept for 30 days.",
  "fr.now": "Freeze the last 10 minutes now",
  "fr.note": "Note (optional)",
  "fr.none": "Nothing frozen yet.",
  "fr.trigger.manual": "by hand",
  "fr.trigger.auto": "automatic",
  "fr.window": "{min} min",
  "fr.download": "Download",
  "fr.delete": "Delete",
  "fr.deleteConfirm": "Delete this snapshot?",
  "fr.deleteLabel": "Delete",
  "fr.node": "\u2744 Freeze",
  "fr.node.title": "Freeze the last minutes of this node (pipeline state and measurement series)",
  "tl.k.freeze": "{actor} froze the last {minutes} minutes",
  "tl.k.freeze.note": "{actor} froze the last {minutes} minutes: {note}",
  "tl.k.freeze.auto": "Frozen automatically ({reason})",
  "tr.title": "Baseline and trends",
  "tr.none": "No series recorded yet \u2014 the analysis starts after a few minutes.",
  "tr.building": "The history is {days} days long ({n} series checked). \u201CUnusual for this time of day\u201D needs at least 3 days of history; steady growth (leaks) is detected after 8 hours.",
  "tr.ready": "The system compares against the usual: {n} series are checked, the longest is {days} days long. Nothing unusual as long as nothing is listed here.",
  "tr.clean": "Currently nothing deviates from the usual and nothing keeps growing.",
  "tr.chart.drift": "Course of the last hours \u2014 dashed: value at the start of the rise",
  "tr.chart.deviation": "Course \u2014 dashed: the usual value at this time of day",
  "tr.m.host.cpu": "CPU load",
  "tr.m.host.mem": "memory",
  "tr.m.host.net": "network load",
  "tr.m.proc.rss": "memory",
  "tr.m.proc.cpu": "CPU load",
  "tr.m.proc.fds": "open files",
  "tr.m.proc.threads": "threads",
  "tr.m.orch.heap": "orchestrator memory",
  "tr.m.orch.goroutines": "orchestrator goroutines",
  "tr.m.orch.fds": "orchestrator open files",
  "tl.k.trend.drift": "{label}: {metric} keeps growing (now {value})",
  "tl.k.trend.deviation": "{label}: {metric} unusually high (now {value}, usual {baseline})",
  "dg.title": "Diagnostics",
  "dg.hint": "What is going wrong, and where? \u201CProblems\u201D groups similar messages, \u201CMessages\u201D shows every single line. Messages come from the orchestrator and are kept for a limited time.",
  "dg.view.groups": "Problems",
  "dg.view.rows": "Messages",
  "dg.search.ph": "Search message text \u2026",
  "dg.node.all": "All nodes",
  "dg.node.gone": "no longer exists",
  "dg.range.1h": "Last hour",
  "dg.range.24h": "24 hours",
  "dg.range.7d": "7 days",
  "dg.range.all": "All time",
  "dg.levels": "Level",
  "dg.level.error": "Errors",
  "dg.level.warn": "Warnings",
  "dg.level.info": "Info",
  "dg.chip.trace": "Operation {p0}",
  "dg.chip.kind": "Message kind: {p0}",
  "dg.count.groups": "{p0} problem kinds \xB7 {p1} messages",
  "dg.count.rows": "{p0} messages loaded",
  "dg.loading": "Loading \u2026",
  "dg.empty": "No messages for these filters \u2013 the system reports nothing unusual.",
  "dg.last": "last {p0}",
  "dg.since": "first {p0}",
  "dg.affects": "Affects: {p0}",
  "dg.showRows": "Show individual messages",
  "dg.showTrace": "All steps of this operation",
  "dg.copy": "Copy",
  "dg.more": "Load older",
  "dg.source": "Source",
  "dg.host": "Host",
  "dg.ago.now": "just now",
  "dg.ago.min": "{p0} min ago",
  "dg.ago.h": "{p0} h ago",
  "dg.ago.d": "{p0} days ago",
  "dg.affects.gone": "{p0} nodes that have since ended",
  "dg.lv.error": "Error",
  "dg.lv.warn": "Warning",
  "dg.lv.info": "Info",
  "pscl.pr.duration": "ffprobe: duration (seconds)",
  "pscl.pr.size": "ffprobe: file size (bytes)",
  "pscl.pr.bitrate": "ffprobe: overall bit rate (bit/s)",
  "pscl.pr.container": "ffprobe: container format",
  "pscl.pr.timecode": "ffprobe: start timecode (if present)",
  "pscl.pr.vcodec": "ffprobe: video codec (first video stream)",
  "pscl.pr.width": "ffprobe: picture width (pixels)",
  "pscl.pr.height": "ffprobe: picture height (pixels)",
  "pscl.pr.fps": "ffprobe: frame rate (e.g. 25/1)",
  "pscl.pr.fieldorder": "ffprobe: field order (progressive/tt/bb)",
  "pscl.pr.pixfmt": "ffprobe: pixel format",
  "pscl.pr.vduration": "ffprobe: video stream duration (seconds)",
  "pscl.pr.vstart": "ffprobe: video stream start time (seconds)",
  "pscl.pr.acodec": "ffprobe: audio codec (first audio stream)",
  "pscl.pr.samplerate": "ffprobe: sample rate (Hz)",
  "pscl.pr.channels": "ffprobe: channels of the first audio stream",
  "pscl.pr.audiocount": "ffprobe: number of audio streams",
  "pscl.pr.streamcount": "ffprobe: total number of streams",
  "psc.var.back": "\u21BA Pick a value",
  "psc.var.back.title": "Back to the selector (the variable is discarded)",
  "psc.var.active": "Variable \u2013 substituted when the step runs",
  "psc.default": "\u2013 ffmpeg default \u2013",
  "psc.yes": "yes",
  "psc.no": "no",
  "psc.pair.remove": "Remove argument (flag and value)",
  "psc.pair.flag": "Flag, e.g. -crf",
  "psc.pair.value": "Value",
  "psc.pair.browse": "Common flags \u2014 or search above (also encoder, format and filter options). Click inserts the flag with a matching value field.",
  "psc.pair.nov": "no value",
  "psc.pair.sel": "choice",
  "psc.pair.time": "time",
  "psc.pair.num": "number",
  "psc.pair.text": "text",
  "psc.pair.add.hint": "Opens the list of all flags and options \u2014 with description, choices or value range",
  "psc.pair.free": "Free-text argument",
  "psc.pair.free.hint": "An empty line for an argument not found in the list",
  "psc.sec.files": "Files",
  "psc.sec.clips": "Clips (order = result)",
  "psc.sec.result": "Result",
  "psc.sec.encoding": "Encoding",
  "psc.sec.events": "Events on the timeline",
  "psc.sec.settings": "Settings",
  "psc.sec.command": "Command (preview)",
  "psc.sec.more": "More settings (time limit)",
  "psc.mode.wizard": "Wizard",
  "psc.mode.expert": "Expert (arguments)",
  "psc.mode.wizard.hint": "Guided form for common tasks",
  "psc.mode.expert.hint": "Any ffmpeg arguments with a picker per flag",
  "an.title": "Analyse package",
  "an.text": "Upload a support package or snapshot (ZIP): findings, outages, timeline and curves at a glance.",
  "an.choose": "Choose ZIP \u2026",
  "an.copy": "Copy report for AI",
  "an.copied": "Report copied \u2013 paste it into a conversation with an AI",
  "an.failed": "Analysis failed: {error}",
  "an.run": "Analyse",
  "an.next": "Next step:",
  "an.outages": "Outages (media not ready)",
  "an.open": "open",
  "an.timeline": "Timeline",
  "an.notable": "Notable series",
  "an.allSeries": "All series",
  "an.logs": "Log messages (grouped)",
  "an.pipelines": "Pipeline state included for",
  "pscl.sub.label": "Subtitles (SRT)",
  "pscl.sub.help": "Creates an SRT subtitle file from a media file's audio, optionally with speaker detection. An auto-subtitle node does the work; the step waits until it is done. The result can be played as a SUBTITLE child event in playout automation.",
  "pscl.sub.missing": "File or asset ID missing",
  "pscl.sub.o.srt": "SRT file (path)",
  "pscl.sub.o.track": "Track for the SUBTITLE child event",
  "pscl.sub.o.speakers": "Number of detected speakers",
  "pscl.sub.o.cues": "Number of cues",
  "psc.sub.file": "Media file (path)",
  "psc.sub.file.help": "Absolute path, readable on the subtitle node's machine. ${\u2026} expressions are allowed.",
  "psc.sub.asset": "or asset ID",
  "psc.sub.asset.help": "Instead of a path: the source of this asset. The result is stored as a representation on the asset.",
  "psc.sub.track": "Audio track",
  "psc.sub.lang": "Language",
  "psc.sub.lang.help": "Code like de or en; empty = automatic",
  "psc.sub.speakers": "Speakers",
  "psc.sub.sp.auto": "detect automatically",
  "psc.sub.sp.one": "1 (no names)",
  "psc.sub.names": "Names (comma-separated)",
  "psc.sub.style": "Label style",
  "psc.sub.name": "Track name",
  "psc.sub.name.help": "empty = from the file name",
  "psc.sub.err": "Enter a file or asset ID",
  "asset.ebu.export": "EBUCore \u2193",
  "asset.ebu.exportHint": "Export metadata as EBUCore XML (EBU Tech 3293) for exchange with other systems",
  "asset.ebu.exportFailed": "EBUCore export failed (HTTP {p0})",
  "asset.ebu.import": "EBUCore \u2191",
  "asset.ebu.importHint": "Read an EBUCore XML file (EBU Tech 3293) into the metadata",
  "asset.ebu.importConfirm": 'Apply {p0} values from "{p1}" to the metadata? Existing keys are overwritten; title and description stay.',
  "asset.ebu.importOk": "Apply",
  "asset.ebu.importFailed": "EBUCore import rejected: {p0}",
  "asset.ebu.imported": "{p0} values applied from EBUCore",
  "asset.fields.manage": "Fields\u2026",
  "asset.fields.title": "Metadata fields",
  "asset.fields.hint": "Registered fields get a type, a label and validation on save. Keys without an entry stay allowed as free fields. The EBUCore target decides where the value goes in the exchange format.",
  "asset.fields.loadFailed": "Could not load fields (HTTP {p0})",
  "asset.fields.required": "required",
  "asset.fields.multiple": "multiple values",
  "asset.fields.builtin": "built-in",
  "asset.fields.allTypes": "all types",
  "asset.fields.delete": "Delete",
  "asset.fields.deleteConfirm": 'Delete field "{p0}"? Stored values remain as free fields.',
  "asset.fields.new": "New field",
  "asset.fields.category": "Category",
  "asset.fields.key": "Key",
  "asset.fields.keyHint": "Letters, digits, underscore; starts with a letter",
  "asset.fields.label": "Label",
  "asset.fields.labelPh": "Display name",
  "asset.fields.dataType": "Data type",
  "asset.fields.enumValues": "Choices (for type enum, comma separated)",
  "asset.fields.enumPh": "A, B, C",
  "asset.fields.assetType": "Asset type",
  "asset.fields.ebucore": "EBUCore target",
  "asset.fields.ebucoreHint": "Empty: the value is exported as a labelled additional field",
  "asset.fields.noTarget": "(no fixed target)",
  "asset.fields.create": "Create",
  "asset.fields.created": 'Field "{p0}" created',
  "amail.title": "E-mail alerting",
  "amail.intro": "Also sends alerts (node alerts, host online/offline, media health, load) by e-mail. Changes take effect within seconds, no restart needed. Only the leading orchestrator sends.",
  "amail.source.ui": "Active source: this setting.",
  "amail.source.env": "Active source: environment variables (OMP_ALERT_SMTP_*). Saving here overrides them.",
  "amail.source.none": "Not set up yet.",
  "amail.enabled": "E-mail alerting enabled",
  "amail.host": "SMTP server",
  "amail.port": "Port (empty = default)",
  "amail.security": "Encryption",
  "amail.sec.starttls": "STARTTLS (port 587)",
  "amail.sec.tls": "TLS (port 465)",
  "amail.sec.none": "none (trusted LAN only)",
  "amail.user": "User (empty = no login)",
  "amail.password": "Password",
  "amail.passwordSet": "stored \u2014 leave empty to keep it",
  "amail.from": "Sender",
  "amail.save": "Save",
  "amail.test": "Send test mail",
  "amail.reset": "Remove setting",
  "amail.saved": "E-mail alerting saved.",
  "amail.testOk": "Test mail was accepted by the server.",
  "amail.removed": "Setting removed.",
  "amail.loadFailed": "Could not load the e-mail setting.",
  "amail.confirmRemove": "Remove the setting from the UI? The environment variables apply again (if set).",
  "amail.to": "Default recipients (if no rule matches, comma-separated)",
  "amail.routes.title": "Recipient rules by alert type and severity",
  "amail.routes.add": "+ Add rule",
  "amail.routes.none": "No rules \u2014 all alerts go to the default recipients.",
  "amail.route.name": "Rule name",
  "amail.route.status": "Status attachment",
  "amail.route.statusNone": "none",
  "amail.route.statusText": "Status as text",
  "amail.route.statusGraph": "Status as text + node graphic (PNG inline)",
  "amail.route.statusSvg": "Status as text + node graphic (SVG attachment)",
  "amail.testStatusRules": "As per rules",
  "amail.testStatusTitle": "Status attachment of the test mail (also without an alarm kind)",
  "amail.statusPreview": "Status preview",
  "amail.statusPreviewHint": "Shows the attachment with the current state \u2014 no mail server, nothing is sent",
  "amail.route.statusHint": "State of orchestrator, hosts (media servers), involved workflows and the signal path from the alarming node up to its root. With several matching rules the largest request applies to the whole mail.",
  "amail.route.to": "Recipients of this rule (empty = send nothing)",
  "amail.route.kinds": "Alert types",
  "amail.route.kindsAll": "all types",
  "amail.route.kindsN": "{p0} types",
  "amail.route.sev": "Severity",
  "amail.route.remove": "Remove rule",
  "amail.route.enabled": "active",
  "amail.sev.critical": "critical",
  "amail.sev.warning": "warning",
  "amail.sev.info": "info / recovery",
  "amail.kind.node-alert": "Node alert (e.g. pipeline broke)",
  "amail.kind.host-offline": "Host offline",
  "amail.kind.media-lost": "Signal path delivers no media",
  "amail.kind.node-silent": "Node silent (no heartbeat)",
  "amail.kind.load-high": "Load too high",
  "amail.kind.host-online": "Host back online",
  "amail.kind.node-recovered": "Node reports again",
  "amail.kind.media-recovered": "Signal path delivers media again",
  "amail.kind.load-recovered": "Load back to normal",
  "amail.testAs": "Test mail as alert:",
  "amail.testDirect": "directly to all recipients",
  "amail.testSevDefault": "default severity",
  "amail.testSentTo": "Test mail accepted. Recipients: {p0}",
  "amail.testNobody": "This alert would trigger no mail (suppressed).",
  "amail.routeDefaultName": "Rule {p0}",
  "amail.route.workflows": "Workflows",
  "amail.route.workflowsAll": "all workflows (also alerts without a workflow)",
  "amail.route.workflowsN": "{p0} workflow(s)",
  "amail.route.workflowGone": "{p0} (no longer exists)",
  "amail.route.workflowsNone": "No workflows defined.",
  "amail.testNoWorkflow": "no workflow",
  "wf.importNotes": "Import note: {p0}",
  "amail.kind.process-failed": "Process failed",
  "amail.route.processes": "Processes",
  "amail.route.processesAll": "all processes",
  "amail.route.processesN": "{p0} process(es)",
  "amail.route.processGone": "{p0} (no longer exists)",
  "amail.route.processesNone": "No processes defined.",
  "amail.testNoProcess": "no process",
  "amail.routes.help": "An alert goes to the recipients of all matching rules (type AND severity must match; nothing ticked = all). If workflows or processes are ticked, the alert must also belong to one of them (a hit in either list is enough). Node alerts belong to the workflow of their role, host alerts to all running workflows with a role on that host, process alerts to their process. If no rule matches, the default recipients get it. A matching rule without recipients suppresses the mail.",
  "amail.kind.qc-failed": "File failed QC",
  "amail.kind.qc-error": "QC could not be run",
  "amail.kind.file-rejected": "File rejected at intake",
  "amail.kind.user-action": "Manual user action",
  "amail.group.nodes": "Nodes",
  "amail.group.hosts": "Hosts",
  "amail.group.process": "Processes",
  "amail.group.review": "Intake (files)",
  "amail.group.user": "User actions",
  "amail.optIn": "only when explicitly chosen",
  "amail.route.actions": "User actions",
  "amail.route.actionsHint": "only for \u201CManual user action\u201D; empty = all. Examples: review.rejected, workflow.*",
  "amail.testAction": "Action, e.g. review.rejected",
  "setx.tab.nodes": "Node options",
  "setx.tab.system": "Operating values",
  "setx.tab.mail": "E-mail alerting",
  "setx.tab.directory": "Active Directory",
  "setx.search": "Search settings \u2026",
  "setx.noHits": "No setting matches \u201C{p0}\u201D in this tab.",
  "setx.clear": "Clear search",
  "clro.title": "Cluster rollout (all orchestrator members, one after another)",
  "clro.hint": "Members are updated or restarted one at a time, the leader last after a leadership transfer. Requires at least 3 voting members and a package marked \u201CrollingSafe\u201D.",
  "clro.status": "{p0} \u2013 {p1}",
  "clro.kindUpdate": "Update to {p0}",
  "clro.kindRestart": "Restart",
  "clro.state.running": "running",
  "clro.state.failed": "halted (error)",
  "clro.state.done": "done",
  "clro.state.cancelled": "cancelled",
  "clro.step.pending": "waiting",
  "clro.step.distributing": "loading package",
  "clro.step.applying": "applying",
  "clro.step.verifying": "verifying",
  "clro.step.done": "done",
  "clro.step.failed": "error",
  "clro.resume": "Resume rollout",
  "clro.cancel": "Cancel rollout",
  "clro.restart": "Rolling cluster restart",
  "clro.restartConfirm": "All orchestrator members will be restarted one after another, the leader last. Running broadcasts are not restarted. Continue?",
  "clro.startUpdate": "Roll out to all members",
  "clro.updateConfirm": "Roll out version {p0} to all orchestrator members one after another? On an error the rollout halts; members already updated stay as they are.",
  "clro.notSafe": "Package is not marked \u201CrollingSafe\u201D \u2013 not allowed for the cluster rollout.",
  "clro.precheck": "Precheck failed: {p0}",
  "clro.startFailed": "Cluster rollout: {p0}",
  "clro.hostsFirst": "Distribute to host agents first",
  "clro.hosts": "Host agents",
  "cathost.title": "Hosts",
  "cathost.title.n": "Hosts ({ok} of {total} ready)",
  "cathost.distribute": "Distribute to hosts \u2026",
  "cathost.needVersion": "To distribute it, the type must be imported with a version.",
  "cathost.noHosts": "No hosts are registered.",
  "cathost.allDone": "The type is already planned on every host.",
  "cathost.state.ok": "ready",
  "cathost.state.pending": "waiting",
  "cathost.state.installing": "installing \u2026",
  "cathost.state.failed": "failed",
  "cathost.state.offline": "host offline \u2013 will catch up",
  "cathost.state.removing": "removing \u2026",
  "cathost.retry": "Retry",
  "cathost.remove": "Remove",
  "cathost.removeConfirm": "Remove \u201C{name}\u201D from host \u201C{host}\u201D? The image and \u2013 if it is the last version \u2013 the data volume are deleted there.",
  "cathost.failed": "Distribution: {p0}",
  "cathost.dialogTitle": "Distribute \u201C{name}\u201D to hosts",
  "cathost.dialogInfo": "The image is sent to the chosen hosts as a signed bundle. Each host verifies signature and checksum and decides for itself which extensions (e.g. host network) it allows.",
  "cathost.cancel": "Cancel",
  "cathost.start": "Distribute",
  "cathost.pickOne": "Please choose at least one host.",
  "hostsw.title": "Software versions by host",
  "hostsw.refresh": "Refresh",
  "hostsw.loading": "loading \u2026",
  "hostsw.mixed": "Different builds of the same node type on different hosts: {p0}",
  "hostsw.localName": "{p0} (orchestrator machine)",
  "hostsw.orch": "Orchestrator",
  "hostsw.agent": "Host agent",
  "hostsw.builtAt": "built {p0}",
  "hostsw.deviates": "differs from orchestrator",
  "hostsw.deviatesTitle": "The orchestrator runs {p0}.",
  "hostsw.summary": "{p0} node types, {p1} instances running",
  "hostsw.outdated": "{p0} instance(s) outdated",
  "hostsw.outdatedShort": "{p0} outdated",
  "hostsw.col.type": "Node type",
  "hostsw.col.version": "Version",
  "hostsw.col.commit": "Commit",
  "hostsw.col.built": "Built",
  "hostsw.col.running": "Running",
  "hostsw.fileTime": "File modification time (the stamp carries no build time)",
  "hostsw.staleBanner": "{p0} host(s) with an older build: {p1}",
  "hostsw.staleAgent": "host agent older",
  "hostsw.staleNodes": "{p0} node type(s) older",
  "hostsw.newerOn": "newer on {p0}: {p1}",
  "hostsw.col.note": "Note",
  "files.filter.label": "Files",
  "files.filter.all": "Files: all",
  "files.filter.problem": "File problem (missing/partial/unreachable)",
  "files.filter.ok": "all files present",
  "files.filter.missing": "file missing",
  "files.filter.partial": "partly missing",
  "files.filter.unreachable": "file unreachable",
  "files.filter.unchecked": "never checked",
  "files.filter.none": "no file",
  "files.state.present": "present",
  "files.state.missing": "file missing",
  "files.state.unreachable": "unreachable",
  "files.state.unknown": "not checkable",
  "files.state.unchecked": "never checked",
  "files.col.state": "File",
  "files.check": "Check files now",
  "files.checked": "Files checked.",
  "files.warn.missing": "A file of this asset is missing",
  "files.openExplorer": "Show in file explorer"
};

// ui/shell/i18n.ts
var DICTS = {
  de,
  en
};
var STORAGE_KEY = "omp-lang";
function isLang(v) {
  return v === "de" || v === "en";
}
function detect() {
  if (typeof document === "undefined") return "de";
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLang(saved)) return saved;
  } catch {
  }
  try {
    return navigator.language?.toLowerCase().startsWith("de") ? "de" : "en";
  } catch {
    return "de";
  }
}
var current = detect();
function t(key, params) {
  let s = DICTS[current][key] ?? DICTS.de[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
try {
  document.documentElement.lang = current;
} catch {
}

// ui/kit/omp-confirm.ts
var TEMPLATE = document.createElement("template");
TEMPLATE.innerHTML = `
  <style>
    :host {
      position: fixed;
      inset: 0;
      /* Live-Fund 2026-09-11 (Nutzerreport: "sicherheits abfrage dialog
         sieht man nicht, erst wenn man verlassen dr\xFCckt"): der
         grafische Rollen-Designer (ui/shell/workflows-view.ts
         #openRoleDesigner) l\xE4uft als eigenes Vollbild-Overlay mit
         z-index:2000 und undurchsichtigem Hintergrund \u2014 ein confirmDialog()
         aus einer Aktion INNERHALB dieses Overlays (z. B. Node
         entfernen) landete darunter und war bis zum Schlie\xDFen des
         Overlays unsichtbar, aber weiterhin bedienbar (Fokus/Enter
         gingen an den unsichtbaren Dialog). Dasselbe Muster nutzen
         ui/shell/auth.ts (Login-Overlay) und ui/shell/host-wizard.ts
         (ebenfalls z-index:2000/1100). confirmDialog() ist als
         universeller "wirklich sicher?"-Baustein gedacht, der IMMER
         \xFCber jedem aufrufenden Overlay liegen muss \u2014 deshalb bewusst
         h\xF6her als jeder bekannte Overlay-z-index in der Shell. */
      z-index: 3000;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--omp-font, system-ui, sans-serif);
      font-size: var(--omp-font-size-sm, 12px);
    }
    .backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
    }
    .dialog {
      position: relative;
      background: var(--omp-surface, #24272b);
      color: var(--omp-text, #e8eaed);
      border: 1px solid var(--omp-border, #3a3f45);
      border-radius: var(--omp-radius, 6px);
      padding: var(--omp-space-4, 16px);
      max-width: 360px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }
    .message {
      margin-bottom: var(--omp-space-3, 12px);
      white-space: pre-wrap;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--omp-space-2, 8px);
    }
    button {
      all: unset;
      box-sizing: border-box;
      cursor: pointer;
      font-family: inherit;
      font-size: inherit;
      padding: 6px 14px;
      border-radius: var(--omp-radius, 6px);
      border: 1px solid var(--omp-border, #3a3f45);
      background: var(--omp-surface-raised, #2f3339);
      color: inherit;
      text-align: center;
    }
    button.confirm {
      background: var(--omp-error, #e53935);
      border-color: var(--omp-error, #e53935);
      color: #fff;
    }
  </style>
  <div class="backdrop" part="backdrop"></div>
  <div class="dialog" part="dialog" role="alertdialog">
    <div class="message" part="message"><slot></slot></div>
    <div class="actions">
      <button class="cancel" type="button" part="cancel"></button>
      <button class="confirm" type="button" part="confirm"></button>
    </div>
  </div>
`;
var OmpConfirm = class extends HTMLElement {
  #cancelBtn;
  #confirmBtn;
  constructor() {
    super();
    const shadow = this.attachShadow({
      mode: "open"
    });
    shadow.append(TEMPLATE.content.cloneNode(true));
    this.#cancelBtn = shadow.querySelector("button.cancel");
    this.#confirmBtn = shadow.querySelector("button.confirm");
    shadow.querySelector(".backdrop").addEventListener("click", () => this.#resolve(false));
    this.#cancelBtn.addEventListener("click", () => this.#resolve(false));
    this.#confirmBtn.addEventListener("click", () => this.#resolve(true));
  }
  connectedCallback() {
    this.#cancelBtn.textContent = this.getAttribute("cancel-label") || t("kit.cancel");
    this.#confirmBtn.textContent = this.getAttribute("confirm-label") || t("kit.delete");
    this.#cancelBtn.focus();
    document.addEventListener("keydown", this.#onKeyDown);
  }
  disconnectedCallback() {
    document.removeEventListener("keydown", this.#onKeyDown);
  }
  #onKeyDown = (ev) => {
    if (ev.key === "Escape") this.#resolve(false);
  };
  #resolve(value) {
    this.dispatchEvent(new CustomEvent("resolve", {
      detail: value
    }));
  }
};
if (!customElements.get("omp-confirm")) {
  customElements.define("omp-confirm", OmpConfirm);
}
function confirmDialog(message, opts = {}) {
  return new Promise((resolve) => {
    const el = document.createElement("omp-confirm");
    el.textContent = message;
    if (opts.confirmLabel) el.setAttribute("confirm-label", opts.confirmLabel);
    if (opts.cancelLabel) el.setAttribute("cancel-label", opts.cancelLabel);
    el.addEventListener("resolve", (ev) => {
      resolve(ev.detail);
      el.remove();
    }, {
      once: true
    });
    document.body.appendChild(el);
  });
}

// ui/kit/omp-toast.ts
var TEMPLATE2 = document.createElement("template");
TEMPLATE2.innerHTML = `
  <style>
    :host {
      position: fixed;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
      /* Live-Fund 2026-09-11 (s. omp-confirm.ts, dieselbe Ursache):
         showToast()-Aufrufer, die standardm\xE4\xDFig an document.body h\xE4ngen
         (z. B. role-designer.ts), k\xF6nnen aus einem Vollbild-Overlay
         (workflows-view.ts #openRoleDesigner, z-index:2000) heraus
         aufgerufen werden \u2014 ein Toast unterhalb davon war unsichtbar,
         verschwand aber trotzdem nach 4s ungesehen. \xDCber dem h\xF6chsten
         bekannten Overlay-z-index, aber unter omp-confirm (3000), falls
         beide gleichzeitig offen sind. */
      z-index: 2500;
      display: block;
    }
    div {
      background: var(--omp-error, #e53935);
      color: #fff;
      padding: var(--omp-space-2, 8px) var(--omp-space-4, 16px);
      border-radius: var(--omp-radius, 6px);
      font-family: var(--omp-font, system-ui, sans-serif);
      font-size: var(--omp-font-size-md, 14px);
      opacity: 0.95;
      white-space: pre-wrap;
      max-width: 60vw;
    }
    :host([variant="info"]) div {
      background: var(--omp-info, #4285f4);
    }
  </style>
  <div part="message"><slot></slot></div>
`;
var DEFAULT_DURATION_MS = 4e3;
var OmpToast = class extends HTMLElement {
  constructor() {
    super();
    const shadow = this.attachShadow({
      mode: "open"
    });
    shadow.append(TEMPLATE2.content.cloneNode(true));
  }
};
if (!customElements.get("omp-toast")) {
  customElements.define("omp-toast", OmpToast);
}
var enhancer;
function showToast(message, opts = {}) {
  const toast = document.createElement("omp-toast");
  toast.setAttribute("data-role", "toast");
  const code = (opts.variant ?? "error") === "error" ? enhancer?.(message) : void 0;
  toast.textContent = code && !message.includes(code) ? `${message} (${code})` : message;
  if (opts.variant) toast.setAttribute("variant", opts.variant);
  (opts.host ?? document.body).appendChild(toast);
  setTimeout(() => toast.remove(), opts.durationMs ?? DEFAULT_DURATION_MS);
}

// ui/shell/ui-bundle.ts
var TOKEN_KEY2 = "omp-auth-token";
var PROBE_INTERVAL_MS = 3e3;
var PROBE_TIMEOUT_MS = 4e3;
var PROBE_FAILS_FOR_OVERLAY = 2;
function watchAvailability(container, el, apiBase) {
  let fails = 0;
  let overlay;
  const timer = setInterval(async () => {
    if (!el.isConnected) {
      clearInterval(timer);
      overlay?.remove();
      return;
    }
    let up;
    try {
      const res = await fetch(`${apiBase}/ui/manifest.json`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        cache: "no-store"
      });
      up = res.ok || res.status === 401 || res.status === 403;
    } catch {
      up = false;
    }
    fails = up ? 0 : fails + 1;
    if (fails >= PROBE_FAILS_FOR_OVERLAY && !overlay) {
      if (getComputedStyle(container).position === "static") container.style.position = "relative";
      overlay = document.createElement("div");
      overlay.setAttribute("role", "alert");
      overlay.dataset.ompUnavailable = "1";
      overlay.style.cssText = "position:absolute;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;text-align:center;padding:16px;background:color-mix(in srgb, var(--omp-bg, #111) 85%, transparent);color:var(--omp-error, #e55);font-family:var(--omp-font, sans-serif);font-weight:600;";
      overlay.textContent = t("console.unavailable");
      container.appendChild(overlay);
    } else if (up && overlay) {
      overlay.remove();
      overlay = void 0;
    }
  }, PROBE_INTERVAL_MS);
}
var isolationEnabled;
function isolationAvailable() {
  isolationEnabled ??= fetch("/api/v1/ui-origin").then((r) => r.ok).catch(() => false);
  return isolationEnabled;
}
async function mountIsolated(container, apiBase) {
  if (!await isolationAvailable()) return null;
  let url = "";
  try {
    const res = await fetch(`${apiBase}/ui-grant`, {
      method: "POST"
    });
    if (!res.ok) return null;
    const g = await res.json();
    if (!g.isolated || !g.url) return null;
    url = g.url;
  } catch {
    return null;
  }
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-modals");
  frame.setAttribute("data-role", "isolated-node-ui");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.style.cssText = "display:block;width:100%;height:320px;border:0;background:transparent;";
  frame.src = url;
  container.replaceChildren(frame);
  return new Promise((resolve) => {
    let settled = false;
    const onMessage = (ev) => {
      if (!frame.isConnected) {
        removeEventListener("message", onMessage);
        return;
      }
      if (ev.source !== frame.contentWindow) return;
      const m = ev.data;
      if (m?.omp !== "ui") return;
      if (m.type === "size" && typeof m.height === "number") {
        const cap = Math.max(300, innerHeight - 140);
        frame.style.height = `${Math.max(120, Math.min(m.height, cap))}px`;
      } else if (m.type === "ready" && !settled) {
        settled = true;
        resolve(frame);
      } else if (m.type === "error" && !settled) {
        settled = true;
        removeEventListener("message", onMessage);
        frame.remove();
        resolve(null);
      }
    };
    addEventListener("message", onMessage);
    setTimeout(() => {
      if (!settled) {
        settled = true;
        removeEventListener("message", onMessage);
        frame.remove();
        resolve(null);
      }
    }, 15e3);
  });
}
async function mountUIBundleEl(container, apiBase) {
  const isolated = await mountIsolated(container, apiBase);
  if (isolated) {
    watchAvailability(container, isolated, apiBase);
    return isolated;
  }
  try {
    const res = await fetch(`${apiBase}/ui/manifest.json`);
    if (!res.ok) return null;
    const manifest = await res.json();
    if (!manifest.tag) return null;
    const token = localStorage.getItem(TOKEN_KEY2);
    const bundleUrl = token ? `${apiBase}/ui/bundle.js?access_token=${encodeURIComponent(token)}` : `${apiBase}/ui/bundle.js`;
    await import(
      /* webpackIgnore: true */
      bundleUrl
    );
    const nodeId = apiBase.split("/").pop() ?? "";
    container.replaceChildren();
    const el = document.createElement(manifest.tag);
    el.setAttribute("node-id", nodeId);
    container.appendChild(el);
    watchAvailability(container, el, apiBase);
    return el;
  } catch {
    return null;
  }
}

// ui/shell/streamdeck/adapter.ts
var RELAYOUT_EVENT = "omp-streamdeck-relayout";
function adapterOf(el) {
  const a = el?.streamDeck;
  return a && typeof a.getLayout === "function" && typeof a.onKey === "function" ? a : null;
}

// ui/shell/streamdeck/autoraster-logic.ts
function buildItems(d) {
  const items = [];
  for (const p of d.parameters) {
    if (p.readonly) continue;
    if (p.type === "boolean") items.push({
      kind: "toggle",
      name: p.name
    });
    else if (p.type === "enum" && p.range && "values" in p.range && p.range.values.length > 0) {
      items.push({
        kind: "enum",
        name: p.name,
        values: p.range.values
      });
    }
  }
  for (const m of d.methods) if (m.args.length === 0) items.push({
    kind: "trigger",
    name: m.name
  });
  return items;
}
function buildDialItems(d) {
  const out = [];
  for (const p of d.parameters) {
    if (!p.readonly && p.type === "number" && p.range && "min" in p.range && p.range.max > p.range.min) {
      out.push({
        name: p.name,
        min: p.range.min,
        max: p.range.max,
        unit: p.unit ?? ""
      });
    }
  }
  return out;
}
function dialStep(spec) {
  const raw = (spec.max - spec.min) / 100;
  const exp = Math.floor(Math.log10(raw));
  for (const m of [
    1,
    2,
    5,
    10
  ]) {
    const v = m * Math.pow(10, exp);
    if (v >= raw * 0.999) return Math.round(v * 1e9) / 1e9;
  }
  return raw;
}
function applyDial(value, delta, spec) {
  const v = Math.min(spec.max, Math.max(spec.min, value + delta * dialStep(spec)));
  return Math.round(v * 1e6) / 1e6;
}
function nextEnum(values, cur) {
  const i = values.indexOf(String(cur));
  return values[(i + 1) % values.length];
}
function shortName(name) {
  return name.replace(/[._]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
}
function keyFor(item, value) {
  if (item.kind === "toggle") return {
    label: shortName(item.name),
    state: value === true ? "onair" : "off",
    dim: value === void 0
  };
  if (item.kind === "enum") return {
    label: shortName(item.name),
    sub: value === void 0 ? void 0 : String(value),
    state: "off"
  };
  return {
    label: shortName(item.name),
    state: "off",
    icon: "\u25B6"
  };
}
function formatDial(v, unit) {
  if (typeof v !== "number") return "\u2013";
  return `${Math.round(v * 100) / 100}${unit ? ` ${unit}` : ""}`;
}
function layoutAuto(items, dials, values, cols, rows, dialCount, page) {
  const cells = cols * rows;
  const perPage = items.length > cells ? cells - 1 : cells;
  const pages = Math.max(1, Math.ceil(items.length / Math.max(1, perPage)));
  const p = Math.min(Math.max(0, page), pages - 1);
  const visible2 = items.slice(p * perPage, p * perPage + perPage);
  const keys = Array.from({
    length: rows
  }, () => Array(cols).fill(null));
  const grid = Array.from({
    length: rows
  }, () => Array(cols).fill(null));
  visible2.forEach((it, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    keys[r][c] = keyFor(it, values[it.name]);
    grid[r][c] = it;
  });
  const dialPages = dialCount > 0 ? Math.max(1, Math.ceil(dials.length / dialCount)) : 1;
  const visibleDials = dialCount > 0 ? dials.slice(p % dialPages * dialCount, p % dialPages * dialCount + dialCount) : [];
  const dd = visibleDials.map((d) => ({
    label: shortName(d.name),
    value: formatDial(values[d.name], d.unit),
    fill: typeof values[d.name] === "number" ? (values[d.name] - d.min) / (d.max - d.min) : void 0
  }));
  return {
    keys,
    dials: dd,
    pages: Math.max(pages, dialCount > 0 ? dialPages : 1),
    cells: grid,
    visible: visible2,
    visibleDials
  };
}

// ui/shell/streamdeck/autoraster.ts
function proxyIO(nodeId) {
  const base = `/api/v1/nodes/${nodeId}`;
  return {
    async descriptor() {
      const r = await apiFetch(`${base}/descriptor`);
      if (!r.ok) throw new Error(`descriptor ${r.status}`);
      return await r.json();
    },
    async getParam(name) {
      const r = await apiFetch(`${base}/params/${name}`);
      if (!r.ok) throw new Error(`param ${name} ${r.status}`);
      const j = await r.json();
      return j && typeof j === "object" && "value" in j ? j.value : j;
    },
    async setParam(name, value) {
      const r = await apiFetch(`${base}/params/${name}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          value
        })
      });
      if (!r.ok) throw new Error(`set ${name} ${r.status}`);
    },
    async call(name, body) {
      const r = await apiFetch(`${base}/methods/${name}`, {
        method: "POST",
        headers: body ? {
          "Content-Type": "application/json"
        } : void 0,
        body: body ? JSON.stringify(body) : void 0
      });
      if (!r.ok) throw new Error(`call ${name} ${r.status}`);
    }
  };
}
var AutoRasterAdapter = class {
  io;
  #items;
  #dials;
  #values;
  #last;
  #ready;
  #ctx;
  /** Node meldet `operatorWait` (Playout-Automation): wartet die Sendung auf den Operator, blinkt die „next“-Taste. */
  #hasWait;
  #waiting;
  #phase;
  #blink;
  /** Vom Broker gesetzt: Anzeige neu aufbauen. */
  onChange;
  /** Vom Broker gesetzt: Fehlermeldung. */
  onError;
  constructor(io) {
    this.io = io;
    this.#items = [];
    this.#dials = [];
    this.#values = {};
    this.#last = null;
    this.#ready = false;
    this.#ctx = null;
    this.#hasWait = false;
    this.#waiting = false;
    this.#phase = false;
    this.#blink = null;
    this.onChange = () => {
    };
    this.onError = () => {
    };
    void this.#init();
  }
  async #init() {
    try {
      const d = await this.io.descriptor();
      this.#items = buildItems(d);
      this.#dials = buildDialItems(d);
      this.#hasWait = d.parameters.some((p) => p.name === "operatorWait");
      this.#ready = true;
      await this.refresh();
    } catch (e) {
      this.onError(e);
    }
    this.onChange();
  }
  getLayout(ctx) {
    this.#ctx = ctx;
    if (!this.#ready) return {
      keys: [
        [
          {
            label: "\u2026",
            dim: true
          }
        ]
      ]
    };
    this.#last = layoutAuto(this.#items, this.#dials, this.#values, ctx.cols, ctx.rows, ctx.dials, ctx.page);
    if (this.#waiting) {
      this.#last.cells.forEach((row, r) => row.forEach((it, c) => {
        const k = this.#last.keys[r][c];
        if (k && it?.kind === "trigger" && it.name === "next") this.#last.keys[r][c] = {
          ...k,
          state: this.#phase ? "cue" : "off",
          sub: "!"
        };
      }));
    }
    return this.#last;
  }
  onKey(row, col, down) {
    if (!down) return;
    const item = this.#last?.cells[row]?.[col];
    if (!item) return;
    void this.#act(item);
  }
  async #act(item) {
    try {
      if (item.kind === "toggle") {
        const v = !(this.#values[item.name] === true);
        this.#values[item.name] = v;
        this.onChange();
        await this.io.setParam(item.name, v);
      } else if (item.kind === "enum") {
        const v = nextEnum(item.values, this.#values[item.name]);
        this.#values[item.name] = v;
        this.onChange();
        await this.io.setParam(item.name, v);
      } else {
        await this.io.call(item.name);
      }
    } catch (e) {
      this.onError(e);
    }
    await this.refresh();
  }
  onDial(index, delta) {
    const spec = this.#last?.visibleDials[index];
    if (!spec) return;
    const cur = typeof this.#values[spec.name] === "number" ? this.#values[spec.name] : spec.min;
    const v = applyDial(cur, delta, spec);
    this.#values[spec.name] = v;
    this.onChange();
    this.io.setParam(spec.name, v).catch((e) => this.onError(e));
  }
  async refresh() {
    const names = /* @__PURE__ */ new Set();
    for (const i of this.#last?.visible ?? this.#items.slice(0, 64)) if (i.kind !== "trigger") names.add(i.name);
    for (const d of this.#last?.visibleDials ?? []) names.add(d.name);
    let changed = false;
    await Promise.all([
      ...names
    ].map(async (n) => {
      try {
        const v = await this.io.getParam(n);
        if (JSON.stringify(v) !== JSON.stringify(this.#values[n])) {
          this.#values[n] = v;
          changed = true;
        }
      } catch {
      }
    }));
    if (this.#hasWait) {
      try {
        const raw = await this.io.getParam("operatorWait");
        const w = typeof raw === "string" ? JSON.parse(raw) : raw;
        this.#setWaiting(!!(w && typeof w === "object" && w.kind));
      } catch {
      }
    }
    if (changed) this.onChange();
  }
  #setWaiting(on) {
    if (on === this.#waiting) return;
    this.#waiting = on;
    this.#phase = on;
    if (on) {
      this.#blink = globalThis.setInterval(() => {
        this.#phase = !this.#phase;
        this.onChange();
      }, 500);
    } else if (this.#blink) {
      clearInterval(this.#blink);
      this.#blink = null;
    }
    this.onChange();
  }
  dispose() {
    if (this.#blink) clearInterval(this.#blink);
    this.#blink = null;
  }
  get context() {
    return this.#ctx;
  }
};

// ui/shell/streamdeck/plot-logic.ts
var clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function biquadMagDb(kind, f0, q, gainDb, f, fs = 48e3) {
  f0 = clamp(f0, 10, fs * 0.45);
  q = clamp(q, 0.1, 20);
  const w0 = 2 * Math.PI * f0 / fs, sw = Math.sin(w0), cw = Math.cos(w0);
  const alpha = sw / (2 * q), A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (kind === "hp") {
    b0 = (1 + cw) / 2;
    b1 = -(1 + cw);
    b2 = b0;
    a0 = 1 + alpha;
    a1 = -2 * cw;
    a2 = 1 - alpha;
  } else if (kind === "peak") {
    b0 = 1 + alpha * A;
    b1 = -2 * cw;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cw;
    a2 = 1 - alpha / A;
  } else {
    const s = 2 * Math.sqrt(A) * alpha;
    if (kind === "low") {
      b0 = A * (A + 1 - (A - 1) * cw + s);
      b1 = 2 * A * (A - 1 - (A + 1) * cw);
      b2 = A * (A + 1 - (A - 1) * cw - s);
      a0 = A + 1 + (A - 1) * cw + s;
      a1 = -2 * (A - 1 + (A + 1) * cw);
      a2 = A + 1 + (A - 1) * cw - s;
    } else {
      b0 = A * (A + 1 + (A - 1) * cw + s);
      b1 = -2 * A * (A - 1 + (A + 1) * cw);
      b2 = A * (A + 1 + (A - 1) * cw - s);
      a0 = A + 1 - (A - 1) * cw + s;
      a1 = 2 * (A - 1 - (A + 1) * cw);
      a2 = A + 1 - (A - 1) * cw - s;
    }
  }
  const w = 2 * Math.PI * f / fs, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
  const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}
function eqResponseDb(spec, f) {
  let db = spec.hp ? biquadMagDb("hp", spec.hp, Math.SQRT1_2, 0, f) : 0;
  for (const b of spec.bands) if (Math.abs(b.g) > 0.01) db += biquadMagDb(b.kind, b.f, b.q, b.g, f);
  return db;
}
function compOutDb(spec, x) {
  const { thr, ratio, knee, makeup } = spec;
  const r = Math.max(1, ratio);
  let y;
  if (2 * (x - thr) < -knee) y = x;
  else if (knee > 0 && 2 * Math.abs(x - thr) <= knee) y = x + (1 / r - 1) * (x - thr + knee / 2) ** 2 / (2 * knee);
  else y = thr + (x - thr) / r;
  return y + makeup;
}
var widthToQ = (freq, widthHz) => clamp(freq / Math.max(widthHz, 1), 0.1, 20);

// ui/shell/streamdeck/adapters/audio-mixer-logic.ts
var eqBand = (prop, band, label) => ({
  prop,
  label,
  min: -24,
  max: 12,
  step: 0.5,
  unit: "dB",
  set: (v) => ({
    method: "setEqGain",
    body: {
      band,
      gainDb: v
    }
  })
});
var MODE_PARAMS = {
  eq: {
    params: [
      eqBand("eqLow", "low", "Low"),
      eqBand("eqMid", "mid", "Mid"),
      eqBand("eqMid2", "mid2", "Mid 2"),
      eqBand("eqHigh", "high", "High")
    ],
    toggles: [
      {
        prop: "eqBypass",
        label: "EQ Bypass",
        set: (on) => ({
          method: "setEqBypass",
          body: {
            bypass: on
          }
        })
      }
    ]
  },
  dyn: {
    params: [
      {
        prop: "compThreshold",
        label: "Comp Thr",
        min: -60,
        max: 0,
        step: 1,
        unit: "dB",
        set: (v) => ({
          method: "setComp",
          body: {
            thresholdDb: v
          }
        })
      },
      {
        prop: "compRatio",
        label: "Comp Ratio",
        min: 1,
        max: 20,
        step: 0.5,
        unit: ":1",
        set: (v) => ({
          method: "setComp",
          body: {
            ratio: v
          }
        })
      },
      {
        prop: "compMakeup",
        label: "Makeup",
        min: 0,
        max: 24,
        step: 0.5,
        unit: "dB",
        set: (v) => ({
          method: "setComp",
          body: {
            makeupDb: v
          }
        })
      },
      {
        prop: "gateThreshold",
        label: "Gate Thr",
        min: -90,
        max: 0,
        step: 1,
        unit: "dB",
        set: (v) => ({
          method: "setGate",
          body: {
            thresholdDb: v
          }
        })
      }
    ],
    toggles: [
      {
        prop: "compEnabled",
        label: "Comp",
        set: (on) => ({
          method: "setComp",
          body: {
            enabled: on
          }
        })
      },
      {
        prop: "gateEnabled",
        label: "Gate",
        set: (on) => ({
          method: "setGate",
          body: {
            enabled: on
          }
        })
      }
    ]
  },
  pan: {
    params: [
      {
        prop: "pan",
        label: "Pan",
        min: -1,
        max: 1,
        step: 0.05,
        unit: "",
        set: (v) => ({
          method: "setPan",
          body: {
            pan: v
          }
        })
      }
    ],
    toggles: [
      {
        prop: "phaseInvert",
        label: "Phase",
        set: (on) => ({
          method: "setPhase",
          body: {
            invert: on
          }
        })
      },
      {
        prop: "mainRoute",
        label: "Main",
        set: (on) => ({
          method: "setMainRoute",
          body: {
            routed: on
          }
        })
      }
    ]
  }
};
var EXTRA_PROPS = {
  eq: [
    "eqHpEnabled",
    "eqHpFreq",
    ...[
      "Low",
      "Mid",
      "Mid2",
      "High"
    ].flatMap((b) => [
      `eq${b}Freq`,
      `eq${b}Width`
    ])
  ],
  dyn: [
    "compKnee"
  ]
};
var GAIN = {
  prop: "gain",
  min: -60,
  max: 12,
  step: 0.5,
  unit: "dB"
};
var clamp2 = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
var roundTo = (v, step) => Math.round(Math.round(v / step) * step * 1e6) / 1e6;
function nudged(cur, steps, p) {
  return roundTo(clamp2(cur + steps * p.step, p.min, p.max), p.step);
}
function fmt(v, unit) {
  if (typeof v !== "number") return "\u2013";
  const t2 = Math.abs(v) >= 100 ? v.toFixed(0) : (Math.round(v * 100) / 100).toString();
  return unit ? `${t2} ${unit}` : t2;
}
var chShort = (c) => c.label.replace(/^omp-/, "").replace(/\s+Sender\s*\d+$/i, "") || c.id;
var EQ_DEF = [
  [
    "Low",
    "low",
    100,
    200
  ],
  [
    "Mid",
    "peak",
    1e3,
    1e3
  ],
  [
    "Mid2",
    "peak",
    3500,
    3500
  ],
  [
    "High",
    "high",
    8e3,
    4e3
  ]
];
function plotSpec(s, id, mode, focus) {
  const n = (prop, d) => num(s, id, prop) ?? d;
  if (mode === "eq") {
    return {
      kind: "eq",
      bypass: bool(s, id, "eqBypass"),
      hp: bool(s, id, "eqHpEnabled") ? n("eqHpFreq", 80) : null,
      bands: EQ_DEF.map(([b, kind, f0, w0]) => {
        const f = n(`eq${b}Freq`, f0);
        return {
          kind,
          f,
          q: widthToQ(f, n(`eq${b}Width`, w0)),
          g: n(`eq${b}`, 0)
        };
      }),
      focus
    };
  }
  if (mode === "dyn") {
    return {
      kind: "dyn",
      on: bool(s, id, "compEnabled"),
      thr: n("compThreshold", 0),
      ratio: n("compRatio", 1),
      makeup: n("compMakeup", 0),
      knee: n("compKnee", 0),
      gateOn: bool(s, id, "gateEnabled"),
      gateThr: n("gateThreshold", -90)
    };
  }
  return null;
}
var num = (s, id, prop) => {
  const v = s.values[`${id}.${prop}`];
  return typeof v === "number" ? v : void 0;
};
var bool = (s, id, prop) => s.values[`${id}.${prop}`] === true;
function empty(rows, cols) {
  return {
    keys: Array.from({
      length: rows
    }, () => Array(cols).fill(null)),
    act: Array.from({
      length: rows
    }, () => Array(cols).fill(null))
  };
}
function layoutAudioMixer(s, cols, rows, dialCount, page) {
  const { keys, act } = empty(rows, cols);
  const dialAct = [];
  const dials = [];
  const sel = s.channels.find((c) => c.id === s.sel);
  if (s.mode !== "mix" && sel) {
    const m = MODE_PARAMS[s.mode];
    const modeKeys = [
      [
        "mix",
        "\u25C0 Mix"
      ],
      [
        "eq",
        "EQ"
      ],
      [
        "dyn",
        "Dynamik"
      ],
      [
        "pan",
        "Pan"
      ]
    ];
    modeKeys.forEach(([mode, label], i) => {
      if (i >= cols) return;
      keys[0][i] = {
        label,
        sub: i === 0 ? chShort(sel) : void 0,
        state: mode === s.mode ? "preset" : "off"
      };
      act[0][i] = {
        t: "mode",
        mode
      };
    });
    const focus = Math.min(s.focus, m.params.length - 1);
    const showSelectors = rows >= 2 && (rows >= 3 || page % 2 === 0);
    if (showSelectors) {
      m.params.forEach((p2, i) => {
        if (i >= cols) return;
        keys[1][i] = {
          label: p2.label,
          sub: fmt(num(s, sel.id, p2.prop), p2.unit),
          state: i === focus ? "preset" : "off"
        };
        act[1][i] = {
          t: "focus",
          index: i
        };
      });
      m.toggles.forEach((t2, j) => {
        const c = m.params.length + j;
        if (c >= cols) return;
        const on = bool(s, sel.id, t2.prop);
        keys[1][c] = {
          label: t2.label,
          state: on ? "onair" : "off"
        };
        const a = t2.set(!on);
        act[1][c] = {
          t: "call",
          id: sel.id,
          ...a
        };
      });
    }
    const fp = m.params[focus];
    const showNudge = rows >= 3 || rows === 2 && page % 2 === 1;
    if (showNudge) {
      const r = rows >= 3 ? 2 : 1;
      const steps = [
        [
          "\u2212",
          -1
        ],
        [
          "+",
          1
        ],
        [
          "\u2212\u2212",
          -5
        ],
        [
          "++",
          5
        ]
      ];
      steps.forEach(([label, n], i) => {
        if (i >= cols) return;
        keys[r][i] = {
          label,
          sub: i === 0 ? `${fp.label} ${fmt(num(s, sel.id, fp.prop), fp.unit)}` : void 0
        };
        act[r][i] = {
          t: "nudge",
          steps: n
        };
      });
    }
    m.params.slice(0, dialCount).forEach((p2, i) => {
      const cur = num(s, sel.id, p2.prop);
      dials.push({
        label: p2.label,
        value: fmt(cur, p2.unit),
        fill: cur === void 0 ? void 0 : (cur - p2.min) / (p2.max - p2.min)
      });
      dialAct.push({
        id: sel.id,
        p: p2,
        press: m.toggles[i] ? {
          t: "call",
          id: sel.id,
          ...m.toggles[i].set(!bool(s, sel.id, m.toggles[i].prop))
        } : void 0
      });
    });
    const spec = plotSpec(s, sel.id, s.mode, focus);
    if (spec) {
      const start = m.params.length + m.toggles.length;
      const cw = Math.min(4, cols - start);
      if (rows >= 3 && cw >= 2) {
        for (let r = 0; r < 3; r++) for (let c = 0; c < cw; c++) keys[r][start + c] = {
          plot: {
            spec,
            cx: c,
            cy: r,
            cw,
            ch: 3
          }
        };
      }
      for (let i = 0; i < dialCount; i++) {
        const plot = {
          spec,
          cx: i,
          cy: 0,
          cw: dialCount,
          ch: 1
        };
        dials[i] = dials[i] ? {
          ...dials[i],
          plot
        } : {
          label: "",
          value: "",
          plot
        };
      }
    }
    return {
      keys,
      act,
      dials,
      dialAct,
      pages: rows === 2 ? 2 : 1
    };
  }
  const screens = rows >= 3 ? 1 : rows === 2 ? 2 : 3;
  const probe = Math.ceil(s.channels.length / cols) * screens;
  const reserve = probe > 1;
  const cap = Math.max(1, reserve ? cols - 1 : cols);
  const chPages = Math.max(1, Math.ceil(s.channels.length / cap));
  const pages = chPages * screens;
  const p = clamp2(page, 0, pages - 1);
  const slice = s.channels.slice(Math.floor(p / screens) * cap, Math.floor(p / screens) * cap + cap);
  const screen = p % screens;
  const rowKinds = rows >= 3 ? [
    "mute",
    "pfl",
    "sel"
  ] : rows === 2 ? screen === 0 ? [
    "mute",
    "sel"
  ] : [
    "pfl",
    "sel"
  ] : [
    [
      "mute",
      "pfl",
      "sel"
    ][screen]
  ];
  slice.forEach((c, i) => {
    rowKinds.forEach((kind, r) => {
      if (kind === "mute") {
        const on = bool(s, c.id, "mute");
        keys[r][i] = {
          label: chShort(c),
          sub: "MUTE",
          state: on ? "onair" : "off"
        };
        act[r][i] = {
          t: "call",
          id: c.id,
          method: "setMute",
          body: {
            muted: !on
          }
        };
      } else if (kind === "pfl") {
        const on = bool(s, c.id, "pfl");
        keys[r][i] = {
          label: chShort(c),
          sub: "PFL",
          state: on ? "cue" : "off"
        };
        act[r][i] = {
          t: "call",
          id: c.id,
          method: "setPfl",
          body: {
            enabled: !on
          }
        };
      } else {
        keys[r][i] = {
          label: chShort(c),
          sub: fmt(num(s, c.id, "gain"), "dB"),
          state: c.id === s.sel ? "preset" : "off"
        };
        act[r][i] = {
          t: "select",
          id: c.id
        };
      }
    });
  });
  slice.slice(0, dialCount).forEach((c) => {
    const g = num(s, c.id, "gain");
    dials.push({
      label: chShort(c),
      value: fmt(g, "dB"),
      fill: g === void 0 ? void 0 : (g - GAIN.min) / (GAIN.max - GAIN.min),
      dim: bool(s, c.id, "mute")
    });
    dialAct.push({
      id: c.id,
      p: {
        ...GAIN,
        set: (v) => ({
          method: "setGain",
          body: {
            db: v
          }
        })
      },
      press: {
        t: "call",
        id: c.id,
        method: "setMute",
        body: {
          muted: !bool(s, c.id, "mute")
        }
      }
    });
  });
  return {
    keys,
    act,
    dials,
    dialAct,
    pages
  };
}

// ui/shell/streamdeck/adapters/audio-mixer.ts
var BASE_PROPS = [
  "gain",
  "mute",
  "pfl"
];
function audioMixerAdapter(io) {
  const st = {
    channels: [],
    values: {},
    sel: null,
    mode: "mix",
    focus: 0
  };
  let last = null;
  const a = {
    onChange: () => {
    },
    onError: (_e) => {
    },
    getLayout(ctx) {
      last = layoutAudioMixer(st, ctx.cols, ctx.rows, ctx.dials, ctx.page);
      return last;
    },
    onKey(row, col, down) {
      if (!down) return;
      const x = last?.act[row]?.[col];
      if (x) void run(x);
    },
    onDial(i, delta) {
      const d = last?.dialAct[i];
      if (!d) return;
      const key = `${d.id}.${d.p.prop}`;
      const cur = typeof st.values[key] === "number" ? st.values[key] : d.p.min;
      const v = nudged(cur, delta, d.p);
      st.values[key] = v;
      a.onChange();
      const c = d.p.set(v);
      io.call(`channel.${d.id}.${c.method}`, c.body).catch(a.onError);
    },
    onDialPress(i, down) {
      const d = last?.dialAct[i];
      if (down && d?.press) void run(d.press);
    },
    async refresh() {
      try {
        const raw = await io.getParam("channels");
        const list = typeof raw === "string" ? JSON.parse(raw) : raw ?? [];
        st.channels = list.map((c) => ({
          id: c.id,
          label: c.label
        }));
        if (st.sel && !st.channels.some((c) => c.id === st.sel)) {
          st.sel = null;
          st.mode = "mix";
        }
      } catch (e) {
        a.onError(e);
        return;
      }
      const props = /* @__PURE__ */ new Map();
      for (const c of st.channels) props.set(c.id, [
        ...BASE_PROPS
      ]);
      if (st.sel && st.mode !== "mix") {
        const m = MODE_PARAMS[st.mode];
        props.set(st.sel, [
          ...BASE_PROPS,
          ...m.params.map((p) => p.prop),
          ...m.toggles.map((t2) => t2.prop),
          ...st.mode === "pan" ? [] : EXTRA_PROPS[st.mode]
        ]);
      }
      let changed = false;
      await Promise.all([
        ...props
      ].flatMap(([id, ps]) => ps.map(async (p) => {
        try {
          const v = await io.getParam(`channel.${id}.${p}`);
          if (st.values[`${id}.${p}`] !== v) {
            st.values[`${id}.${p}`] = v;
            changed = true;
          }
        } catch {
        }
      })));
      if (changed || st.channels.length) a.onChange();
    }
  };
  async function run(x) {
    try {
      if (x.t === "select") {
        st.sel = x.id;
        st.mode = "eq";
        st.focus = 0;
        await a.refresh();
      } else if (x.t === "mode") {
        st.mode = x.mode;
        st.focus = 0;
        await a.refresh();
      } else if (x.t === "focus") {
        st.focus = x.index;
      } else if (x.t === "nudge") {
        if (st.sel && st.mode !== "mix") {
          const p = MODE_PARAMS[st.mode].params[Math.min(st.focus, MODE_PARAMS[st.mode].params.length - 1)];
          const key = `${st.sel}.${p.prop}`;
          const cur = typeof st.values[key] === "number" ? st.values[key] : p.min;
          const v = nudged(cur, x.steps, p);
          st.values[key] = v;
          const c = p.set(v);
          a.onChange();
          await io.call(`channel.${st.sel}.${c.method}`, c.body);
        }
      } else {
        await io.call(`channel.${x.id}.${x.method}`, x.body);
        await a.refresh();
        return;
      }
    } catch (e) {
      a.onError(e);
    }
    a.onChange();
  }
  return a;
}

// ui/shell/streamdeck/adapters/device-hub-logic.ts
var kindText = (d) => `${d.kind === "video" ? "Video" : "Audio"} ${d.direction === "output" ? "Aus" : "Ein"}`;
function deviceKey(d) {
  const err = d.status.startsWith("error");
  return {
    label: d.name,
    sub: `${kindText(d)} \xB7 ${d.offered ? "EIN" : "AUS"}`,
    state: err ? "error" : d.offered ? "preset" : "off",
    dim: !d.present
  };
}
function layoutHub(devices, cols, rows, dialCount, page) {
  const slots = Math.max(1, rows * cols);
  const items = [
    {
      key: {
        label: "NEU SUCHEN",
        state: "cue"
      },
      act: {
        t: "rescan"
      }
    },
    ...devices.map((d) => ({
      key: deviceKey(d),
      act: {
        t: "toggle",
        id: d.id,
        on: !d.offered
      }
    }))
  ];
  const cap = items.length > slots ? Math.max(1, slots - 1) : slots;
  const pages = Math.max(1, Math.ceil(items.length / cap));
  const p = Math.min(Math.max(0, page), pages - 1);
  const keys = Array.from({
    length: rows
  }, () => Array(cols).fill(null));
  const act = Array.from({
    length: rows
  }, () => Array(cols).fill(null));
  items.slice(p * cap, p * cap + cap).forEach((it, i) => {
    keys[Math.floor(i / cols)][i % cols] = it.key;
    act[Math.floor(i / cols)][i % cols] = it.act;
  });
  const on = devices.filter((d) => d.offered).length;
  const dials = [
    {
      label: "Angeboten",
      value: `${on}/${devices.length}`,
      fill: devices.length ? on / devices.length : 0
    },
    {
      label: "Eing\xE4nge",
      value: String(devices.filter((d) => d.direction === "input" && d.offered).length)
    },
    {
      label: "Ausg\xE4nge",
      value: String(devices.filter((d) => d.direction === "output" && d.offered).length)
    },
    {
      label: "Fehler",
      value: String(devices.filter((d) => d.status.startsWith("error")).length),
      dim: !devices.some((d) => d.status.startsWith("error"))
    }
  ];
  return {
    keys,
    act,
    dials: dials.slice(0, dialCount),
    pages
  };
}

// ui/shell/streamdeck/adapters/device-hub.ts
function deviceHubAdapter(io) {
  let devices = [];
  let last = null;
  const a = {
    onChange: () => {
    },
    onError: (_e) => {
    },
    getLayout(ctx) {
      last = layoutHub(devices, ctx.cols, ctx.rows, ctx.dials, ctx.page);
      return last;
    },
    onKey(row, col, down) {
      if (!down) return;
      const x = last?.act[row]?.[col];
      if (!x) return;
      void (async () => {
        try {
          if (x.t === "rescan") {
            await io.call("rescan");
            setTimeout(() => void a.refresh(), 1500);
          } else {
            const d = devices.find((v) => v.id === x.id);
            if (d) d.offered = x.on;
            a.onChange();
            await io.call("setOffered", {
              id: x.id,
              on: x.on
            });
            await a.refresh();
          }
        } catch (e) {
          a.onError(e);
          await a.refresh();
        }
        a.onChange();
      })();
    },
    async refresh() {
      try {
        const raw = await io.getParam("devices");
        const v = typeof raw === "string" ? JSON.parse(raw) : raw;
        devices = (Array.isArray(v) ? v : []).map((d) => ({
          id: String(d.id),
          name: String(d.name ?? d.id),
          kind: String(d.kind ?? ""),
          direction: String(d.direction ?? "input"),
          offered: d.offered === true,
          present: d.present !== false,
          status: String(d.status ?? "")
        }));
        a.onChange();
      } catch (e) {
        a.onError(e);
      }
    }
  };
  return a;
}

// ui/shell/streamdeck/adapters/ograf-logic.ts
var layerOf = (s, id) => id ? s.layers.find((l) => l.id === id) : void 0;
function continueTarget(s) {
  const l = layerOf(s, s.sel);
  if (l) return l;
  return s.layers.length === 1 ? s.layers[0] : void 0;
}
function controlList(s) {
  const sel = s.templates.find((t2) => t2.id === s.sel);
  const onAir = !!layerOf(s, s.sel);
  const c = continueTarget(s);
  const multi = !!c && c.stepCount > 1;
  return [
    {
      key: {
        label: "TAKE",
        sub: sel?.label,
        state: sel && !onAir ? "preset" : "off",
        dim: !sel || onAir
      },
      act: {
        t: "take"
      }
    },
    {
      key: {
        label: "TAKE OUT",
        state: onAir ? "onair" : "off",
        dim: !onAir
      },
      act: {
        t: "out"
      }
    },
    {
      key: {
        label: "CONTINUE",
        sub: multi ? `${c.step + 1}/${c.stepCount}` : void 0,
        state: c?.canContinue ? "cue" : "off",
        dim: !c?.canContinue
      },
      act: {
        t: "cont"
      }
    },
    {
      key: {
        label: "ALLE AUS",
        sub: s.layers.length ? `${s.layers.length} on air` : void 0,
        state: s.layers.length ? "error" : "off",
        dim: !s.layers.length
      },
      act: {
        t: "clear"
      }
    }
  ];
}
function presetKey(s, t2) {
  const l = layerOf(s, t2.id);
  const selected = t2.id === s.sel;
  return {
    label: t2.label,
    sub: l ? l.stepCount > 1 ? `ON AIR ${l.step + 1}/${l.stepCount}` : "ON AIR" : t2.stepCount > 1 ? `${t2.stepCount} Schritte` : void 0,
    state: l ? "onair" : selected ? "preset" : "off",
    // Gewählt und on air: Rahmen-Hinweis über den Untertitel
    ...l && selected ? {
      icon: "\u25B6"
    } : {}
  };
}
function dialsFor(s, count) {
  const sel = s.templates.find((t2) => t2.id === s.sel);
  const names = s.layers.map((l) => l.label).join(", ");
  const all = [
    {
      label: "Preset",
      value: sel?.label ?? "\u2013",
      fill: s.templates.length > 1 && sel ? s.templates.indexOf(sel) / (s.templates.length - 1) : void 0
    },
    {
      label: "TAKE/OUT",
      value: layerOf(s, s.sel) ? "ON AIR" : sel ? "bereit" : "\u2013",
      dim: !sel
    },
    {
      label: "CONTINUE",
      value: continueTarget(s)?.canContinue ? "bereit" : "\u2013",
      dim: !continueTarget(s)?.canContinue
    },
    {
      label: "On Air",
      value: s.layers.length ? `${s.layers.length}: ${names}` : "\u2013",
      dim: !s.layers.length
    },
    {
      label: "ALLE AUS",
      value: s.layers.length ? "dr\xFCcken" : "\u2013",
      dim: !s.layers.length
    },
    {
      label: "",
      value: ""
    }
  ];
  return all.slice(0, count);
}
function dialActions(count) {
  return [
    null,
    {
      t: "take"
    },
    {
      t: "cont"
    },
    null,
    {
      t: "clear"
    },
    null
  ].slice(0, count);
}
function layoutOgraf(s, cols, rows, dialCount, page) {
  const ctrls = controlList(s);
  const n = s.templates.length;
  const single = rows < 2;
  const presetRows = single ? 1 : rows - 1;
  const perPage = (reserve) => Math.max(1, presetRows * cols - (single && reserve ? 1 : 0));
  let cap = perPage(false);
  let pages = single ? 1 + Math.max(1, Math.ceil(n / cap)) : Math.max(1, Math.ceil(n / cap));
  if (single || pages > 1) {
    cap = perPage(true);
    pages = single ? 1 + Math.max(1, Math.ceil(n / cap)) : Math.max(1, Math.ceil(n / cap));
  }
  const ctrlSlots = single && pages > 1 ? cols - 1 : cols;
  const p = Math.min(Math.max(0, page), pages - 1);
  const keys = Array.from({
    length: rows
  }, () => Array(cols).fill(null));
  const act = Array.from({
    length: rows
  }, () => Array(cols).fill(null));
  const putPresets = (row0, chunk, perRow) => {
    s.templates.slice(chunk * cap, chunk * cap + cap).forEach((t2, i) => {
      const r = row0 + Math.floor(i / perRow), c = i % perRow;
      if (r < row0 + presetRows) {
        keys[r][c] = presetKey(s, t2);
        act[r][c] = {
          t: "pick",
          id: t2.id
        };
      }
    });
  };
  const putCtrls = (r) => {
    ctrls.slice(0, ctrlSlots).forEach((it, c) => {
      keys[r][c] = it.key;
      act[r][c] = it.act;
    });
  };
  if (!single) {
    putPresets(0, p, cols);
    putCtrls(rows - 1);
  } else if (p === 0) putCtrls(0);
  else putPresets(0, p - 1, cols);
  return {
    keys,
    act,
    dials: dialsFor(s, dialCount),
    dialAct: dialActions(dialCount),
    pages
  };
}
function stepTemplate(s, delta) {
  const n = s.templates.length;
  if (!n) return null;
  const i = s.templates.findIndex((t2) => t2.id === s.sel);
  const j = i < 0 ? delta > 0 ? 0 : n - 1 : Math.min(n - 1, Math.max(0, i + (delta > 0 ? 1 : -1)));
  return s.templates[j].id;
}

// ui/shell/streamdeck/adapters/ograf.ts
var arr = (raw) => {
  const v = typeof raw === "string" ? JSON.parse(raw) : raw;
  return Array.isArray(v) ? v : [];
};
function ografAdapter(io) {
  const st = {
    templates: [],
    layers: [],
    sel: null
  };
  let last = null;
  async function run(x) {
    try {
      if (x.t === "pick") st.sel = x.id;
      else if (x.t === "take") {
        if (st.sel && !st.layers.some((l) => l.id === st.sel)) await io.call("show", {
          templateId: st.sel,
          data: {}
        });
      } else if (x.t === "out") {
        if (st.sel && st.layers.some((l) => l.id === st.sel)) await io.call("hide", {
          layerId: st.sel
        });
      } else if (x.t === "cont") {
        const c = continueTarget(st);
        if (c?.canContinue) await io.call("continue", {
          layerId: c.id
        });
      } else if (x.t === "clear") {
        if (st.layers.length) await io.call("hide", {});
      }
      if (x.t !== "pick") await a.refresh();
    } catch (e) {
      a.onError(e);
    }
    a.onChange();
  }
  const a = {
    onChange: () => {
    },
    onError: (_e) => {
    },
    getLayout(ctx) {
      last = layoutOgraf(st, ctx.cols, ctx.rows, ctx.dials, ctx.page);
      return last;
    },
    onKey(row, col, down) {
      if (!down) return;
      const x = last?.act[row]?.[col];
      if (x) void run(x);
    },
    onDial(i, delta) {
      if (i !== 0) return;
      st.sel = stepTemplate(st, delta);
      a.onChange();
    },
    onDialPress(i, down) {
      const x = last?.dialAct[i];
      if (down && x) void run(x);
    },
    async refresh() {
      try {
        const [tpl, lay] = await Promise.all([
          io.getParam("templates"),
          io.getParam("layers")
        ]);
        st.templates = arr(tpl).map((t2) => ({
          id: t2.id,
          label: t2.label || t2.id,
          stepCount: t2.stepCount ?? 1
        }));
        st.layers = arr(lay);
        if (st.sel && !st.templates.some((t2) => t2.id === st.sel)) st.sel = null;
        st.sel ??= st.layers[0]?.id ?? st.templates[0]?.id ?? null;
        a.onChange();
      } catch (e) {
        a.onError(e);
      }
    }
  };
  return a;
}

// nodes/omp-xy-panel/ui/logic.js
(() => {
  const ROOT = "";
  function normSources(list) {
    return (list || []).map((s) => ({
      kind: "source",
      id: s.senderId,
      label: s.label || s.senderId,
      nodeId: s.nodeId,
      nodeLabel: s.nodeLabel || s.nodeId,
      mediaType: s.mediaType || "",
      tags: (s.tags || []).map((t2) => t2.tag),
      online: s.online !== false
    }));
  }
  function normSinks(list) {
    return (list || []).map((s) => ({
      kind: "sink",
      id: s.receiverId,
      label: s.label || s.receiverId,
      nodeId: s.nodeId,
      nodeLabel: s.nodeLabel || s.nodeId,
      mediaType: s.mediaType || "",
      tags: (s.tags || []).map((t2) => t2.tag),
      online: s.online !== false
    }));
  }
  function stripInstanceId(s) {
    return String(s ?? "").replace(/\s*\([0-9a-f]{8}\)/g, "");
  }
  function nodeNames(points) {
    const raw = /* @__PURE__ */ new Map();
    for (const p of points) raw.set(p.nodeId, p.nodeLabel);
    const count = /* @__PURE__ */ new Map();
    for (const l of raw.values()) {
      const k = stripInstanceId(l);
      count.set(k, (count.get(k) || 0) + 1);
    }
    const out = /* @__PURE__ */ new Map();
    for (const [id, l] of raw) out.set(id, count.get(stripInstanceId(l)) > 1 ? l : stripInstanceId(l));
    return out;
  }
  function shortLabel(p, nodeName) {
    const l = stripInstanceId(p.label);
    const n = stripInstanceId(nodeName);
    if (n && l.startsWith(n) && l.length > n.length) return l.slice(n.length).trim() || l;
    return l;
  }
  function fullName(p, nodeName) {
    const n = nodeName === void 0 ? stripInstanceId(p.nodeLabel) : nodeName;
    const l = n && stripInstanceId(n) !== n ? String(p.label ?? "") : stripInstanceId(p.label);
    return n && l.startsWith(n) ? l : n && l.startsWith(stripInstanceId(n)) ? l : `${n} \xB7 ${l}`;
  }
  function groupPointsByNode(points) {
    const m = /* @__PURE__ */ new Map();
    for (const p of points) {
      if (!m.has(p.nodeId)) m.set(p.nodeId, []);
      m.get(p.nodeId).push(p);
    }
    return m;
  }
  function flattenGroup(groups, groupId, seen = /* @__PURE__ */ new Set()) {
    const g = groups[groupId];
    if (!g || seen.has(groupId)) return [];
    seen.add(groupId);
    const out = [
      ...g.nodeIds || []
    ];
    for (const c of g.groupIds || []) out.push(...flattenGroup(groups, c, seen));
    return out;
  }
  function buildModel({ nodes, groupTree, workflows, virtual }) {
    const groups = groupTree && groupTree.groups || {};
    const known = /* @__PURE__ */ new Set([
      ...(nodes || []).map((n) => n.id),
      ...(virtual || []).map((v) => v.id)
    ]);
    const nodeLabel = new Map((nodes || []).map((n) => [
      n.id,
      n.label || n.id
    ]));
    const folders = /* @__PURE__ */ new Map();
    const rootIds = [];
    const assigned = /* @__PURE__ */ new Set();
    const keep = (ids) => [
      ...new Set(ids)
    ].filter((id) => known.has(id));
    const groupByWf = /* @__PURE__ */ new Map();
    for (const g of Object.values(groups)) if (g.workflowId) groupByWf.set(g.workflowId, g);
    const hiddenGroups = /* @__PURE__ */ new Set();
    for (const wf of workflows || []) {
      const label = wf.definition && wf.definition.title || wf.name || wf.id;
      const wfNodes = [
        ...(virtual || []).filter((v) => v.workflowId === wf.id).map((v) => v.id),
        ...Object.values(wf.runtime || {}).map((r) => r && r.nodeId).filter(Boolean)
      ];
      const linked = groupByWf.get(wf.id);
      let nodeIds = wfNodes;
      let folderIds = [];
      if (linked) {
        hiddenGroups.add(linked.id);
        nodeIds = [
          ...linked.nodeIds || [],
          ...wfNodes
        ];
        folderIds = (linked.groupIds || []).filter((id) => groups[id]).map((id) => "grp:" + id);
      }
      nodeIds = keep(nodeIds);
      nodeIds.forEach((id) => assigned.add(id));
      folders.set("wf:" + wf.id, {
        id: "wf:" + wf.id,
        label,
        kind: "workflow",
        folderIds,
        nodeIds
      });
      rootIds.push("wf:" + wf.id);
    }
    for (const g of Object.values(groups)) {
      folders.set("grp:" + g.id, {
        id: "grp:" + g.id,
        label: g.label || g.id,
        kind: "group",
        folderIds: (g.groupIds || []).filter((id) => groups[id]).map((id) => "grp:" + id),
        nodeIds: keep(g.nodeIds || [])
      });
    }
    for (const g of Object.values(groups)) {
      for (const id of flattenGroup(groups, g.id)) if (known.has(id)) assigned.add(id);
      if (g.parentId === null || g.parentId === void 0) {
        if (!hiddenGroups.has(g.id)) rootIds.push("grp:" + g.id);
      }
    }
    const unassignedIds = [
      ...known
    ].filter((id) => !assigned.has(id));
    folders.set("unassigned", {
      id: "unassigned",
      label: "",
      kind: "unassigned",
      folderIds: [],
      nodeIds: unassignedIds
    });
    rootIds.push("unassigned");
    return {
      folders,
      rootIds,
      nodeLabel
    };
  }
  function interfacePoints(resolved, sources, labels) {
    const bySender = new Map((sources || []).map((s) => [
      s.id,
      s
    ]));
    const outSources = [];
    const inSinks = [];
    const virtual = [];
    for (const ifc of resolved || []) {
      if (!ifc || !ifc.workflowId) continue;
      for (const o of ifc.outputs || []) {
        const nodeId = `ifc-out:${ifc.workflowId}:${o.name}`;
        const nodeLabel = `${labels && labels.out || "Output"}: ${o.label || o.name}`;
        let any = false;
        for (const m of o.members || []) {
          const orig = bySender.get(m.portId);
          if (!orig) continue;
          outSources.push({
            ...orig,
            nodeId,
            nodeLabel
          });
          any = true;
        }
        if (any) virtual.push({
          id: nodeId,
          workflowId: ifc.workflowId
        });
      }
      for (const i of ifc.inputs || []) {
        const nodeId = `ifc-in:${ifc.workflowId}:${i.name}`;
        const nodeLabel = `${labels && labels.in || "Input"}: ${i.label || i.name}`;
        inSinks.push({
          kind: "sink",
          id: nodeId,
          label: nodeLabel,
          nodeId,
          nodeLabel,
          mediaType: "",
          tags: [],
          online: i.available !== false,
          ifc: {
            workflowId: ifc.workflowId,
            name: i.name
          },
          feedSenderIds: i.feedSenderIds || []
        });
        virtual.push({
          id: nodeId,
          workflowId: ifc.workflowId
        });
      }
    }
    return {
      sources: outSources,
      sinks: inSinks,
      virtual
    };
  }
  function folderNodeIds(model, folderId, seen = /* @__PURE__ */ new Set()) {
    const f = model.folders.get(folderId);
    if (!f || seen.has(folderId)) return [];
    seen.add(folderId);
    const out = [
      ...f.nodeIds
    ];
    for (const c of f.folderIds) out.push(...folderNodeIds(model, c, seen));
    return [
      ...new Set(out)
    ];
  }
  function levelContents(model, path, pointsByNode) {
    const countOf = (fid) => folderNodeIds(model, fid).reduce((n, id) => n + (pointsByNode.get(id) || []).length, 0);
    const folderEntry = (fid) => {
      const f2 = model.folders.get(fid);
      return {
        id: fid,
        label: f2.label,
        kind: f2.kind,
        count: countOf(fid)
      };
    };
    const crumbs = path.map((fid) => ({
      id: fid,
      label: (model.folders.get(fid) || {}).label || fid,
      kind: (model.folders.get(fid) || {}).kind
    }));
    if (path.length === 0) {
      return {
        crumbs,
        folders: model.rootIds.map(folderEntry).filter((f2) => f2.count > 0),
        nodes: []
      };
    }
    const f = model.folders.get(path[path.length - 1]);
    if (!f) return {
      crumbs,
      folders: [],
      nodes: []
    };
    return {
      crumbs,
      folders: f.folderIds.map(folderEntry).filter((e) => e.count > 0),
      nodes: f.nodeIds.filter((id) => (pointsByNode.get(id) || []).length > 0).map((id) => ({
        id,
        label: model.nodeLabel.get(id) || id,
        points: pointsByNode.get(id)
      }))
    };
  }
  function folderLabel(folder, t2) {
    return folder.kind === "unassigned" ? t2("unassigned") : folder.label;
  }
  function matchesQuery(p, q) {
    q = (q || "").trim().toLowerCase();
    if (!q) return true;
    return [
      p.label,
      p.nodeLabel,
      ...p.tags
    ].some((s) => String(s).toLowerCase().includes(q));
  }
  function filterPoints(points, { media, query }) {
    return points.filter((p) => (!media || p.mediaType === media) && matchesQuery(p, query));
  }
  function compatible2(source, sink) {
    if (!source || !sink) return false;
    if (!source.mediaType || !sink.mediaType) return true;
    return source.mediaType === sink.mediaType;
  }
  function routeMap(edges) {
    const m = /* @__PURE__ */ new Map();
    for (const e of edges || []) m.set(e.toReceiver, e.fromSender);
    return m;
  }
  function sharedTags(a, b) {
    const set = new Set(b.tags);
    return a.tags.filter((t2) => !t2.startsWith("media.") && set.has(t2));
  }
  function planTagRoutes(sources, sinks, { fallbackOrder = false, byTags = true } = {}) {
    const routes = [];
    const unmatched = [];
    const used = /* @__PURE__ */ new Set();
    const live = sources.filter((s) => s.online);
    for (const sink of sinks) {
      let best = null;
      let bestScore = 0;
      for (const s of byTags ? live : []) {
        if (!s.mediaType || s.mediaType !== sink.mediaType) continue;
        const n = sharedTags(s, sink).length;
        if (n === 0) continue;
        if (!best || n > bestScore || n === bestScore && used.has(best.id) && !used.has(s.id)) {
          best = s;
          bestScore = n;
        }
      }
      if (best && bestScore > 0) {
        used.add(best.id);
        routes.push({
          from: best,
          to: sink,
          reason: "tag",
          tags: sharedTags(best, sink)
        });
      } else {
        unmatched.push(sink);
      }
    }
    if (!fallbackOrder && byTags) return {
      routes,
      unmatched
    };
    const stillUnmatched = [];
    for (const sink of unmatched) {
      const cand = live.find((s) => !used.has(s.id) && s.mediaType && s.mediaType === sink.mediaType);
      if (cand) {
        used.add(cand.id);
        routes.push({
          from: cand,
          to: sink,
          reason: "order",
          tags: []
        });
      } else stillUnmatched.push(sink);
    }
    return {
      routes,
      unmatched: stillUnmatched
    };
  }
  const BOUQUET_LAYOUT = "xy-bouquets";
  function refFor(p) {
    return {
      nodeId: p.nodeId,
      nodeLabel: p.nodeLabel,
      label: p.label
    };
  }
  function resolveRef(ref, points) {
    if (!ref) return null;
    return points.find((p) => p.nodeId === ref.nodeId && p.label === ref.label) || points.find((p) => p.nodeLabel === ref.nodeLabel && p.label === ref.label) || null;
  }
  function describeRef(ref) {
    const l = String(ref.label ?? "");
    return l.startsWith(ref.nodeLabel) ? l : `${ref.nodeLabel} \xB7 ${l}`;
  }
  function parseBouquets(blob) {
    const list = blob && Array.isArray(blob.bouquets) ? blob.bouquets : [];
    return list.filter((b) => b && typeof b.id === "string" && typeof b.name === "string" && (b.kind === "routes" || b.kind === "tags" || b.kind === "bundle" && Array.isArray(b.items)));
  }
  function newId() {
    return "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function routesBouquet(name, pairs) {
    return {
      id: newId(),
      name,
      kind: "routes",
      routes: pairs.map(({ from, to }) => ({
        from: refFor(from),
        to: refFor(to)
      }))
    };
  }
  function tagsBouquet(name, sourceNode, sinkNode, fallbackOrder) {
    return {
      id: newId(),
      name,
      kind: "tags",
      source: {
        nodeId: sourceNode.id,
        nodeLabel: sourceNode.label
      },
      sink: {
        nodeId: sinkNode.id,
        nodeLabel: sinkNode.label
      },
      fallbackOrder: !!fallbackOrder
    };
  }
  function resolveBouquet(b, sources, sinks) {
    const routes = [];
    const missing = [];
    if (b.kind === "routes") {
      for (const r of b.routes || []) {
        const from = resolveRef(r.from, sources);
        const to = resolveRef(r.to, sinks);
        if (!from) missing.push(describeRef(r.from));
        else if (!to) missing.push(describeRef(r.to));
        else if (!compatible2(from, to)) missing.push(describeRef(r.to));
        else routes.push({
          from,
          to,
          reason: "bouquet",
          tags: []
        });
      }
    } else {
      const src = sources.filter((s) => s.nodeId === b.source.nodeId || s.nodeLabel === b.source.nodeLabel);
      const snk = sinks.filter((s) => s.nodeId === b.sink.nodeId || s.nodeLabel === b.sink.nodeLabel);
      if (!src.length) missing.push(b.source.nodeLabel);
      if (!snk.length) missing.push(b.sink.nodeLabel);
      if (src.length && snk.length) {
        const plan3 = planTagRoutes(src, snk, {
          fallbackOrder: b.fallbackOrder
        });
        routes.push(...plan3.routes);
        for (const u of plan3.unmatched) missing.push(fullName(u));
      }
    }
    return {
      routes,
      missing
    };
  }
  function bundleBouquet(name, points, mode) {
    return {
      id: newId(),
      name,
      kind: "bundle",
      mode: mode === "tags" ? "tags" : "order",
      items: points.map((p) => ({
        ...refFor(p),
        mediaType: p.mediaType
      }))
    };
  }
  function planBundle(b, sources, sinks, mode) {
    const how = (mode || b.mode) === "tags" ? "tags" : "order";
    const routes = [];
    const missing = [];
    const slot = /* @__PURE__ */ new Map();
    const used = /* @__PURE__ */ new Set();
    for (const item of b.items || []) {
      const from = resolveRef(item, sources);
      const media = item.mediaType || from && from.mediaType || "";
      const n = slot.get(media) || 0;
      slot.set(media, n + 1);
      if (!from) {
        missing.push(describeRef(item));
        continue;
      }
      if (!from.online) {
        missing.push(describeRef(item) + " (offline)");
        continue;
      }
      const cands = sinks.filter((s) => s.mediaType === media);
      let to = null;
      let tags = [];
      if (how === "order") {
        to = cands[n] || null;
      } else {
        let score = 0;
        for (const s of cands) {
          if (used.has(s.id)) continue;
          const sh = sharedTags(from, s);
          if (sh.length > score) {
            to = s;
            score = sh.length;
            tags = sh;
          }
        }
      }
      if (!to || used.has(to.id)) {
        missing.push(describeRef(item));
        continue;
      }
      used.add(to.id);
      routes.push({
        from,
        to,
        reason: how === "tags" ? "tag" : "order",
        tags
      });
    }
    return {
      routes,
      missing
    };
  }
  globalThis.OmpXyLogic = {
    ROOT,
    BOUQUET_LAYOUT,
    normSources,
    normSinks,
    stripInstanceId,
    nodeNames,
    shortLabel,
    fullName,
    groupPointsByNode,
    flattenGroup,
    buildModel,
    interfacePoints,
    folderNodeIds,
    levelContents,
    folderLabel,
    matchesQuery,
    filterPoints,
    compatible: compatible2,
    routeMap,
    sharedTags,
    planTagRoutes,
    refFor,
    resolveRef,
    parseBouquets,
    routesBouquet,
    tagsBouquet,
    bundleBouquet,
    planBundle,
    resolveBouquet
  };
})();

// ui/shell/streamdeck/adapters/xy-panel-logic.ts
var L = () => globalThis.OmpXyLogic;
var MEDIA_CYCLE = [
  "",
  "video",
  "audio",
  "data"
];
var MEDIA_LABEL = {
  "": "Alle",
  video: "Video",
  audio: "Audio",
  data: "Daten"
};
var strip = (s) => String(s ?? "").replace(/\s*\([0-9a-f]{8}\)/g, "");
var pointName = (p) => {
  const n = strip(p.nodeLabel).replace(/^omp-/, "");
  const l = strip(p.label);
  return l.startsWith(strip(p.nodeLabel)) && l.length > strip(p.nodeLabel).length ? l.slice(strip(p.nodeLabel).length).trim() || l : l;
};
function compatible(a, b) {
  if (!a || !b) return false;
  if (!a.mediaType || !b.mediaType) return true;
  return a.mediaType === b.mediaType;
}
var visible = (pts, media) => pts.filter((p) => !media || p.mediaType === media);
function stepSelection(pts, cur, delta) {
  if (!pts.length) return null;
  const i = pts.findIndex((p) => p.id === cur);
  const n = i < 0 ? delta > 0 ? 0 : pts.length - 1 : Math.min(pts.length - 1, Math.max(0, i + (delta > 0 ? 1 : -1)));
  return pts[n].id;
}
var nodeOf = (p) => strip(p.nodeLabel).replace(/^omp-/, "") || "?";
function categories(pts) {
  return [
    ...new Set(pts.map(nodeOf))
  ];
}
function filtered(pts, media, cat) {
  return visible(pts, media).filter((p) => !cat || nodeOf(p) === cat);
}
function keyName(p, all) {
  return all.filter((x) => nodeOf(x) === nodeOf(p)).length === 1 ? nodeOf(p) : pointName(p);
}
function columnControls(s) {
  const c = controlList2(s);
  const by = (l) => c.find((x) => x.key.label === l);
  return [
    by("TAKE"),
    by("Trennen"),
    by("AUTO"),
    by("Medium")
  ];
}
function controlList2(s) {
  const canTake = !!s.selSrc && !!s.selDst;
  return [
    {
      key: {
        label: "TAKE",
        sub: s.draft ? `\u25CF ${s.draft.length}` : void 0,
        state: canTake ? "onair" : "off",
        dim: !canTake
      },
      act: {
        t: "take"
      }
    },
    {
      key: {
        label: "AUTO",
        sub: s.auto ? "an" : "aus",
        state: s.auto ? "preset" : "off"
      },
      act: {
        t: "auto"
      }
    },
    {
      key: {
        label: "Medium",
        sub: MEDIA_LABEL[s.media]
      },
      act: {
        t: "media"
      }
    },
    {
      key: {
        label: "Trennen",
        dim: !s.selDst
      },
      act: {
        t: "disc"
      }
    },
    {
      key: {
        label: "\u25C0 Quellen"
      },
      act: {
        t: "scroll",
        row: "src",
        dir: -1
      }
    },
    {
      key: {
        label: "Quellen \u25B6"
      },
      act: {
        t: "scroll",
        row: "src",
        dir: 1
      }
    },
    {
      key: {
        label: "\u25C0 Ziele"
      },
      act: {
        t: "scroll",
        row: "dst",
        dir: -1
      }
    },
    {
      key: {
        label: "Ziele \u25B6"
      },
      act: {
        t: "scroll",
        row: "dst",
        dir: 1
      }
    }
  ];
}
function plan(ctrls, cols, rows, reserve) {
  const ctrlRows = rows >= 3 ? rows - 2 : rows;
  const cap = Math.max(1, ctrlRows * cols - (reserve ? 1 : 0));
  const chunks = Math.max(1, Math.ceil(ctrls / cap));
  const pages = rows >= 3 ? chunks : rows === 2 ? 1 + chunks : 2 + chunks;
  return {
    cap,
    chunks,
    pages
  };
}
var pathOf = (s, side) => (side === "src" ? s.srcPath : s.dstPath) ?? [];
var catOf = (s, side) => (side === "src" ? s.srcCat : s.dstCat) ?? null;
var allOf = (s, side) => side === "src" ? s.sources : s.sinks;
function scoped(s, side) {
  const all = allOf(s, side);
  const path = pathOf(s, side);
  if (!path.length || !s.model) return all;
  const ids = new Set(L().folderNodeIds(s.model, path[path.length - 1]));
  return all.filter((p) => p.nodeId !== void 0 && ids.has(p.nodeId));
}
var sideList = (s, side) => filtered(scoped(s, side), s.media, catOf(s, side));
function validPath(model, path) {
  if (!model) return [];
  const i = path.findIndex((f) => !model.folders.has(f));
  return i >= 0 ? path.slice(0, i) : path;
}
var folderTitle = (f) => f.kind === "unassigned" ? "Nicht zugewiesen" : f.label;
function topEntries(s, side) {
  const out = [];
  const cat = catOf(s, side);
  const path = pathOf(s, side);
  const media = visible(allOf(s, side), s.media);
  const model = s.model;
  const byNode = /* @__PURE__ */ new Map();
  for (const p of media) if (p.nodeId !== void 0) byNode.set(p.nodeId, [
    ...byNode.get(p.nodeId) ?? [],
    p
  ]);
  const level = model ? L().levelContents(model, path, byNode) : null;
  const folders = level?.folders ?? [];
  const folderKeys = () => folders.map((f) => ({
    key: {
      label: folderTitle(f),
      sub: f.kind === "workflow" ? "Workflow" : f.kind === "group" ? "Gruppe" : "Ordner"
    },
    act: {
      t: "folder",
      side,
      id: f.id
    }
  }));
  if (!path.length) {
    out.push({
      key: {
        label: "Alle",
        sub: "Kategorie",
        state: cat === null ? "preset" : "off"
      },
      act: {
        t: "cat",
        side,
        name: null
      }
    });
    if (folders.some((f) => f.kind !== "unassigned")) out.push(...folderKeys());
    else for (const n of categories(media)) out.push({
      key: {
        label: n,
        sub: "Kategorie",
        state: n === cat ? "preset" : "off"
      },
      act: {
        t: "cat",
        side,
        name: n
      }
    });
    return out;
  }
  const here = level?.crumbs[level.crumbs.length - 1];
  out.push({
    key: {
      label: "\u2191 Hoch",
      sub: path.length > 1 ? "Ebene" : "Home"
    },
    act: {
      t: "up",
      side
    }
  });
  out.push({
    key: {
      label: here ? folderTitle(here) : "Ordner",
      sub: "Ebene",
      state: cat === null ? "preset" : "off"
    },
    act: {
      t: "cat",
      side,
      name: null
    }
  });
  out.push(...folderKeys());
  const direct = new Set((level?.nodes ?? []).map((n) => n.id));
  const inLevel = media.filter((p) => p.nodeId !== void 0 && direct.has(p.nodeId));
  for (const n of categories(inLevel)) out.push({
    key: {
      label: n,
      sub: "Node",
      state: n === cat ? "preset" : "off"
    },
    act: {
      t: "cat",
      side,
      name: n
    }
  });
  return out;
}
function layoutColumns(s, cols, rows, dialCount, pages) {
  const midC = Math.floor((cols - 1) / 2);
  const w = {
    src: midC,
    dst: cols - 1 - midC
  };
  const x0 = {
    src: 0,
    dst: midC + 1
  };
  const keys = Array.from({
    length: rows
  }, () => Array(cols).fill(null));
  const act = Array.from({
    length: rows
  }, () => Array(cols).fill(null));
  const sel = s.sources.find((x) => x.id === s.selSrc);
  const nameOf = new Map(s.sources.map((x) => [
    x.id,
    keyName(x, s.sources)
  ]));
  const reserved = (r, c) => pages > 1 && r === rows - 1 && c === cols - 1;
  for (const side of [
    "src",
    "dst"
  ]) {
    const all = allOf(s, side);
    const cat = catOf(s, side);
    const catOff = (side === "src" ? s.srcCatOff : s.dstCatOff) ?? 0;
    const off = side === "src" ? s.srcOff : s.dstOff;
    const W = w[side], X = x0[side];
    const top = topEntries(s, side);
    const catPer = top.length > W ? Math.max(1, W - 1) : W;
    const co = Math.min(catOff, Math.max(0, top.length - 1));
    top.slice(co, co + catPer).forEach((e, i) => {
      keys[0][X + i] = e.key;
      act[0][X + i] = e.act;
    });
    if (top.length > W) {
      keys[0][X + W - 1] = {
        label: "mehr \u25B6",
        sub: `${Math.min(top.length, co + catPer)}/${top.length}`
      };
      act[0][X + W - 1] = {
        t: "more",
        side,
        what: "cat"
      };
    }
    const pts = sideList(s, side);
    const free = [];
    for (let r = 1; r < rows; r++) for (let i = 0; i < W; i++) if (!reserved(r, X + i)) free.push([
      r,
      X + i
    ]);
    const per = pts.length > free.length ? Math.max(1, free.length - 1) : free.length;
    const o = Math.min(off, Math.max(0, pts.length - 1));
    pts.slice(o, o + per).forEach((pt, i) => {
      const [r, c] = free[i];
      if (side === "src") {
        keys[r][c] = {
          label: keyName(pt, all),
          sub: cat || keyName(pt, all) === nodeOf(pt) ? void 0 : nodeOf(pt),
          state: pt.id === s.selSrc ? "preset" : "off",
          dim: !pt.online
        };
      } else {
        const from = s.routes[pt.id];
        const routedFromSel = !!from && from === s.selSrc;
        keys[r][c] = {
          label: keyName(pt, all),
          sub: from ? nameOf.get(from) ?? "?" : "\u2014",
          state: pt.id === s.selDst ? "cue" : routedFromSel ? "onair" : "off",
          dim: !pt.online || !!sel && !compatible(sel, pt)
        };
      }
      act[r][c] = {
        t: side,
        id: pt.id
      };
    });
    if (pts.length > free.length) {
      const [r, c] = free[free.length - 1];
      keys[r][c] = {
        label: "mehr \u25B6",
        sub: `${Math.min(pts.length, o + per)}/${pts.length}`
      };
      act[r][c] = {
        t: "more",
        side,
        what: "pt"
      };
    }
  }
  columnControls(s).slice(0, rows).forEach((it, r) => {
    keys[r][midC] = it.key;
    act[r][midC] = it.act;
  });
  return {
    keys,
    act,
    dials: dialsFor2(s, dialCount),
    pages
  };
}
var hasRecCells = (s, cols, rows) => s.canSaveBouquets === true && cols * rows >= 8;
var bouquetCapacity = (s, cols, rows) => Math.max(1, cols * rows - (hasRecCells(s, cols, rows) ? 4 : 2));
var bouquetPages = (s, cols, rows) => {
  const n = s.bouquets?.length ?? 0;
  return n ? Math.ceil(n / bouquetCapacity(s, cols, rows)) : hasRecCells(s, cols, rows) ? 1 : 0;
};
function bouquetLayout(s, cols, rows, dialCount, bqPage, pages) {
  const keys = Array.from({
    length: rows
  }, () => Array(cols).fill(null));
  const act = Array.from({
    length: rows
  }, () => Array(cols).fill(null));
  const cap = bouquetCapacity(s, cols, rows);
  const rec = hasRecCells(s, cols, rows);
  const list = s.bouquets ?? [];
  const hasDst = !!s.sinks.find((x) => x.id === s.selDst);
  keys[0][0] = {
    label: "\u21B6 Zur\xFCck",
    sub: s.undoSecs ? `${s.undoSecs} s` : void 0,
    dim: !s.undoSecs
  };
  act[0][0] = {
    t: "undo"
  };
  if (rec) {
    if (s.draft) {
      keys[0][1] = {
        label: "\u25A0 Speichern",
        sub: `${s.draft.length} Schaltung(en)`,
        state: "onair",
        dim: !s.draft.length
      };
      act[0][1] = {
        t: "recSave"
      };
      keys[0][2] = {
        label: "\u2715 Verwerfen"
      };
      act[0][2] = {
        t: "recDrop"
      };
    } else {
      keys[0][1] = {
        label: "\u25CF Aufzeichnen",
        sub: "Take sammelt"
      };
      act[0][1] = {
        t: "rec"
      };
    }
  }
  const skip = (r, c) => r === 0 && (c === 0 || rec && c <= 2) || r === rows - 1 && c === cols - 1;
  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (skip(r, c)) continue;
      const b = list[bqPage * cap + n++];
      if (!b) continue;
      const run = s.lastRun && s.lastRun.id === b.id ? s.lastRun : null;
      const bundle = b.kind === "bundle";
      keys[r][c] = {
        label: String(b.name),
        sub: run ? run.bad ? `${run.ok} ok, ${run.bad} Fehler` : `${run.ok} geschaltet` : bundle ? hasDst ? `B\xFCndel ${b.items?.length ?? 0}` : "B\xFCndel: Ziel w\xE4hlen" : b.kind === "tags" ? "per Tags" : `${b.routes?.length ?? 0} Schaltungen`,
        state: run ? run.bad ? "error" : "onair" : "off",
        dim: bundle && !hasDst
      };
      act[r][c] = {
        t: "bq",
        id: b.id
      };
    }
  }
  return {
    keys,
    act,
    dials: dialsFor2(s, dialCount),
    pages
  };
}
function levelEntry(s, side) {
  const list = topEntries(s, side);
  if (!list.length) return null;
  const i = Math.min(Math.max(0, (side === "src" ? s.srcCur : s.dstCur) ?? 0), list.length - 1);
  return {
    ...list[i],
    index: i,
    count: list.length
  };
}
function dialsFor2(s, dialCount) {
  const dials = [];
  if (dialCount > 0) {
    const ss = s.sources.find((x) => x.id === s.selSrc), sd = s.sinks.find((x) => x.id === s.selDst);
    const lv = (side, label) => {
      const e = levelEntry(s, side);
      return {
        label,
        value: e ? String(e.key.label) : "\u2013",
        fill: e && e.count > 1 ? (e.index + 1) / e.count : void 0
      };
    };
    dials.push(s.levelMode ? lv("src", "Ebene Q") : {
      label: "Quelle",
      value: ss ? pointName(ss) : "\u2013"
    });
    if (dialCount > 1) dials.push(s.levelMode ? lv("dst", "Ebene Z") : {
      label: "Ziel",
      value: sd ? pointName(sd) : "\u2013"
    });
    if (dialCount > 2) dials.push(s.levelMode ? {
      label: "Modus",
      value: "Ebene"
    } : {
      label: "Medium",
      value: MEDIA_LABEL[s.media]
    });
    if (dialCount > 3) dials.push({
      label: "AUTO",
      value: s.auto ? "an" : "aus",
      dim: !s.auto
    });
    if (dialCount > 5) {
      dials.push(lv("src", "Ebene Q"));
      dials.push(lv("dst", "Ebene Z"));
    }
  }
  return dials;
}
function layoutXy(s, cols, rows, dialCount, page) {
  const bq = bouquetPages(s, cols, rows);
  if (cols >= 5 && rows >= 3) {
    const pages = 1 + bq;
    const p2 = Math.min(Math.max(0, page), pages - 1);
    return p2 === 0 ? layoutColumns(s, cols, rows, dialCount, pages) : bouquetLayout(s, cols, rows, dialCount, p2 - 1, pages);
  }
  const ctrls = controlList2(s);
  let pl = plan(ctrls.length, cols, rows, false);
  const reserve = pl.pages > 1 || bq > 0;
  if (reserve) pl = plan(ctrls.length, cols, rows, true);
  const total = pl.pages + bq;
  if (page >= pl.pages && bq > 0) return bouquetLayout(s, cols, rows, dialCount, Math.min(page, total - 1) - pl.pages, total);
  const p = Math.min(Math.max(0, page), pl.pages - 1);
  const slots = Math.max(1, rows < 3 ? cols - (reserve ? 1 : 0) : cols);
  const keys = Array.from({
    length: rows
  }, () => Array(cols).fill(null));
  const act = Array.from({
    length: rows
  }, () => Array(cols).fill(null));
  const srcs = visible(s.sources, s.media);
  const dsts = visible(s.sinks, s.media);
  const sel = s.sources.find((x) => x.id === s.selSrc);
  const nameOf = new Map(s.sources.map((x) => [
    x.id,
    pointName(x)
  ]));
  const srcRow = (r) => {
    srcs.slice(s.srcOff, s.srcOff + slots).forEach((pt, c) => {
      keys[r][c] = {
        label: pointName(pt),
        sub: strip(pt.nodeLabel).replace(/^omp-/, ""),
        state: pt.id === s.selSrc ? "preset" : "off",
        dim: !pt.online
      };
      act[r][c] = {
        t: "src",
        id: pt.id
      };
    });
  };
  const dstRow = (r) => {
    dsts.slice(s.dstOff, s.dstOff + slots).forEach((pt, c) => {
      const from = s.routes[pt.id];
      const routedFromSel = !!from && from === s.selSrc;
      keys[r][c] = {
        label: pointName(pt),
        sub: from ? nameOf.get(from) ?? "?" : "\u2014",
        state: pt.id === s.selDst ? "cue" : routedFromSel ? "onair" : "off",
        dim: !pt.online || !!sel && !compatible(sel, pt)
      };
      act[r][c] = {
        t: "dst",
        id: pt.id
      };
    });
  };
  const ctrlRowsAt = (from, count, chunk) => {
    ctrls.slice(chunk * pl.cap, chunk * pl.cap + pl.cap).forEach((it, i) => {
      const r = from + Math.floor(i / cols), c = i % cols;
      if (r < from + count) {
        keys[r][c] = it.key;
        act[r][c] = it.act;
      }
    });
  };
  if (rows >= 3) {
    srcRow(0);
    dstRow(1);
    ctrlRowsAt(2, rows - 2, p);
  } else if (rows === 2) {
    if (p === 0) {
      srcRow(0);
      dstRow(1);
    } else ctrlRowsAt(0, 2, p - 1);
  } else if (p === 0) srcRow(0);
  else if (p === 1) dstRow(0);
  else ctrlRowsAt(0, 1, p - 2);
  const dials = dialsFor2(s, dialCount);
  return {
    keys,
    act,
    dials,
    pages: total
  };
}

// ui/shell/streamdeck/adapters/xy-panel.ts
var L2 = () => globalThis.OmpXyLogic;
var SLOW_MS = 15e3;
function coreIO(panelId = "") {
  const panelHdr = panelId ? {
    "X-OMP-Panel": panelId
  } : {};
  const jget = async (u) => {
    const r = await apiFetch(u);
    if (!r.ok) throw new Error(`${u}: ${r.status}`);
    return r.json();
  };
  const norm = (list, idKey) => (list || []).map((s) => ({
    id: String(s[idKey]),
    label: s.label || String(s[idKey]),
    nodeLabel: s.nodeLabel || s.nodeId || "",
    mediaType: s.mediaType || "",
    online: s.online !== false,
    nodeId: s.nodeId,
    tags: (s.tags || []).map((t2) => t2.tag)
  }));
  const jgetOpt = async (u) => {
    try {
      const r = await apiFetch(u);
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  };
  let slow = null;
  return {
    async load() {
      const [graph, sources, sinks] = await Promise.all([
        jget("/api/v1/graph"),
        jget("/api/v1/sources"),
        jget("/api/v1/sinks")
      ]);
      const routes = {};
      for (const e of graph.edges || []) routes[e.toReceiver] = e.fromSender;
      if (!slow || Date.now() - slow.at > SLOW_MS) {
        const [layout, workflows, bq, me] = await Promise.all([
          jgetOpt("/api/v1/layouts/default"),
          jgetOpt("/api/v1/workflows"),
          jgetOpt("/api/v1/layouts/xy-bouquets"),
          jgetOpt("/api/v1/auth/whoami")
        ]);
        slow = {
          at: Date.now(),
          groupTree: layout && layout.groups || {
            groups: {}
          },
          workflows: Array.isArray(workflows) ? workflows : [],
          bouquets: L2()?.parseBouquets(bq) ?? [],
          canSave: !!me && (me.canConfigure ?? me.isAdmin) === true
        };
      }
      return {
        sources: norm(sources, "senderId"),
        sinks: norm(sinks, "receiverId"),
        routes,
        nodes: graph.nodes || [],
        groupTree: slow.groupTree,
        workflows: slow.workflows,
        bouquets: slow.bouquets,
        canSave: slow.canSave
      };
    },
    async saveBouquet(b) {
      const blob = await jgetOpt("/api/v1/layouts/xy-bouquets") ?? {
        version: 1,
        bouquets: []
      };
      const list = Array.isArray(blob.bouquets) ? blob.bouquets : [];
      const r = await apiFetch("/api/v1/layouts/xy-bouquets", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ...blob,
          version: blob.version ?? 1,
          bouquets: [
            ...list,
            b
          ]
        })
      });
      if (!r.ok) throw new Error((await r.text()).trim() || String(r.status));
      slow = null;
    },
    async connect(from, to) {
      const r = await apiFetch("/api/v1/graph/edges", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...panelHdr
        },
        body: JSON.stringify({
          from,
          to
        })
      });
      if (!r.ok) throw new Error((await r.text()).trim() || String(r.status));
    },
    async disconnect(to) {
      const r = await apiFetch(`/api/v1/graph/edges/${encodeURIComponent(to)}`, {
        method: "DELETE",
        headers: panelHdr
      });
      if (!r.ok) throw new Error((await r.text()).trim() || String(r.status));
    }
  };
}
var UNDO_MS = 6e4;
function xyPanelAdapter(io) {
  const st = {
    sources: [],
    sinks: [],
    routes: {},
    selSrc: null,
    selDst: null,
    media: "",
    auto: true,
    srcOff: 0,
    dstOff: 0,
    srcPath: [],
    dstPath: [],
    bouquets: []
  };
  let last = null;
  let undo = null;
  let lastRunTimer;
  const pushUndo = (tos) => {
    undo = {
      at: Date.now(),
      prev: tos.map((to) => ({
        to,
        from: st.routes[to] ?? null
      }))
    };
  };
  const undoSecs = () => {
    if (!undo || Date.now() - undo.at > UNDO_MS) return 0;
    return Math.max(1, Math.ceil((UNDO_MS - (Date.now() - undo.at)) / 1e3));
  };
  async function take() {
    const from = st.sources.find((x) => x.id === st.selSrc), to = st.sinks.find((x) => x.id === st.selDst);
    if (!from || !to) return;
    if (!compatible(from, to)) return;
    if (st.draft) {
      if (!st.draft.some((d) => d.from.id === from.id && d.to.id === to.id)) st.draft.push({
        from,
        to
      });
      st.selDst = null;
      return;
    }
    pushUndo([
      to.id
    ]);
    await io.connect(from.id, to.id);
    st.selDst = null;
    await a.refresh();
  }
  async function runBouquet(id) {
    const b = (st.bouquets ?? []).find((x) => x.id === id);
    if (!b) return;
    const logic = L2();
    let plan3;
    if (b.kind === "bundle") {
      const dst = st.sinks.find((x) => x.id === st.selDst);
      if (!dst) throw new Error(`${b.name}: erst ein Ziel w\xE4hlen (dessen Node ist das B\xFCndel-Ziel)`);
      plan3 = logic.planBundle(b, st.sources.map(withTags), st.sinks.filter((x) => x.nodeId === dst.nodeId).map(withTags));
    } else plan3 = logic.resolveBouquet(b, st.sources.map(withTags), st.sinks.map(withTags));
    if (plan3.routes.length) pushUndo(plan3.routes.map((r) => r.to.id));
    let ok = 0;
    const bad = [];
    for (const r of plan3.routes) {
      try {
        await io.connect(r.from.id, r.to.id);
        ok++;
      } catch (e) {
        bad.push(`${r.to.label} (${e instanceof Error ? e.message : e})`);
      }
    }
    st.lastRun = {
      id,
      ok,
      bad: bad.length + plan3.missing.length
    };
    clearTimeout(lastRunTimer);
    lastRunTimer = setTimeout(() => {
      st.lastRun = null;
      a.onChange();
    }, 4e3);
    await a.refresh();
    if (bad.length || plan3.missing.length) {
      a.onError(new Error(`${b.name}: ${ok} geschaltet, nicht auffindbar/nicht schaltbar: ${[
        ...plan3.missing,
        ...bad
      ].join("; ")}`));
    }
  }
  async function saveDraft() {
    const d = st.draft;
    if (!d || !d.length || !io.saveBouquet) return;
    const now = /* @__PURE__ */ new Date();
    const name = `Deck ${now.toLocaleTimeString("de-DE", {
      hour12: false
    })}`;
    await io.saveBouquet(L2().routesBouquet(name, d.map(({ from, to }) => ({
      from: withTags(from),
      to: withTags(to)
    }))));
    st.draft = null;
    await a.refresh();
  }
  async function doUndo() {
    if (!undoSecs() || !undo) return;
    const e = undo;
    undo = null;
    const bad = [];
    for (const p of e.prev) {
      try {
        if (p.from) await io.connect(p.from, p.to);
        else await io.disconnect(p.to);
      } catch (err) {
        bad.push(err instanceof Error ? err.message : String(err));
      }
    }
    await a.refresh();
    if (bad.length) a.onError(new Error(`R\xFCckg\xE4ngig fehlgeschlagen: ${bad.join("; ")}`));
  }
  const withTags = (p) => ({
    ...p,
    tags: p.tags ?? [],
    nodeId: p.nodeId ?? p.nodeLabel
  });
  async function run(x) {
    try {
      if (x.t === "src") {
        st.selSrc = x.id;
        if (st.auto && st.selDst && st.routes[st.selDst] !== x.id) await take();
      } else if (x.t === "dst") {
        st.selDst = x.id;
        if (st.auto && st.selSrc && st.routes[x.id] !== st.selSrc) await take();
      } else if (x.t === "take") await take();
      else if (x.t === "disc") {
        if (st.selDst) {
          pushUndo([
            st.selDst
          ]);
          await io.disconnect(st.selDst);
          st.selDst = null;
          await a.refresh();
        }
      } else if (x.t === "auto") st.auto = !st.auto;
      else if (x.t === "media") {
        st.media = MEDIA_CYCLE[(MEDIA_CYCLE.indexOf(st.media) + 1) % MEDIA_CYCLE.length];
        st.srcOff = st.dstOff = st.srcCatOff = st.dstCatOff = 0;
        st.srcCat = st.dstCat = null;
      } else if (x.t === "cat") {
        if (x.side === "src") st.srcCat = x.name, st.srcOff = 0;
        else st.dstCat = x.name, st.dstOff = 0;
      } else if (x.t === "folder") {
        const path = (x.side === "src" ? st.srcPath : st.dstPath) ?? [];
        setSide(x.side, [
          ...path,
          x.id
        ]);
      } else if (x.t === "up") {
        const path = (x.side === "src" ? st.srcPath : st.dstPath) ?? [];
        setSide(x.side, path.slice(0, -1));
      } else if (x.t === "bq") await runBouquet(x.id);
      else if (x.t === "undo") await doUndo();
      else if (x.t === "rec") st.draft = [];
      else if (x.t === "recDrop") st.draft = null;
      else if (x.t === "recSave") await saveDraft();
      else if (x.t === "more") {
        const w = Math.max(1, Math.floor(((a.cols || 9) - 1) / 2));
        const n = x.what === "cat" ? topEntries(st, x.side).length : sideList(st, x.side).length;
        const key = x.what === "cat" ? x.side === "src" ? "srcCatOff" : "dstCatOff" : x.side === "src" ? "srcOff" : "dstOff";
        const next = (st[key] ?? 0) + (x.what === "cat" ? Math.max(1, w - 1) : Math.max(1, (a.rows - 1) * w - 1));
        st[key] = next >= n ? 0 : next;
      } else if (x.t === "scroll") {
        const side = x.row;
        const n = sideList(st, side).length;
        const step = Math.max(1, (a.cols || 8) - 1);
        const key = side === "src" ? "srcOff" : "dstOff";
        st[key] = Math.min(Math.max(0, n - 1), Math.max(0, st[key] + x.dir * step));
      }
    } catch (e) {
      a.onError(e);
    }
    a.onChange();
  }
  function setSide(side, path) {
    if (side === "src") st.srcPath = path, st.srcCat = null, st.srcOff = 0, st.srcCatOff = 0;
    else st.dstPath = path, st.dstCat = null, st.dstOff = 0, st.dstCatOff = 0;
  }
  const a = {
    cols: 0,
    rows: 0,
    dials: 0,
    onChange: () => {
    },
    onError: (_e) => {
    },
    getLayout(ctx) {
      a.cols = ctx.cols;
      a.rows = ctx.rows;
      a.dials = ctx.dials;
      st.undoSecs = undoSecs();
      last = layoutXy(st, ctx.cols, ctx.rows, ctx.dials, ctx.page);
      return last;
    },
    onKey(row, col, down) {
      if (!down) return;
      const x = last?.act[row]?.[col];
      if (x) void run(x);
    },
    onDial(i, delta) {
      const side = i === 4 ? "src" : i === 5 ? "dst" : st.levelMode && i < 2 ? i === 0 ? "src" : "dst" : null;
      if (side) {
        const n = topEntries(st, side).length;
        const key = side === "src" ? "srcCur" : "dstCur";
        st[key] = Math.min(Math.max(0, n - 1), Math.max(0, (st[key] ?? 0) + (delta > 0 ? 1 : -1)));
        a.onChange();
        return;
      }
      if (i === 0) st.selSrc = stepSelection(sideList(st, "src"), st.selSrc, delta);
      else if (i === 1) st.selDst = stepSelection(sideList(st, "dst"), st.selDst, delta);
      else if (i === 2) void run({
        t: "media"
      });
      a.onChange();
    },
    onDialPress(i, down) {
      if (!down) return;
      const side = i === 4 ? "src" : i === 5 ? "dst" : st.levelMode && i < 2 ? i === 0 ? "src" : "dst" : null;
      if (side) {
        const e = levelEntry(st, side);
        if (e) {
          if (side === "src") st.srcCur = 0;
          else st.dstCur = 0;
          void run(e.act);
        }
      } else if (i === 1) void run({
        t: "take"
      });
      else if (i === 2 && a.dials < 6) {
        st.levelMode = !st.levelMode;
        a.onChange();
      } else if (i === 3) void run({
        t: "auto"
      });
    },
    dispose() {
      clearTimeout(lastRunTimer);
    },
    async refresh() {
      try {
        const d = await io.load();
        st.sources = d.sources;
        st.sinks = d.sinks;
        st.routes = d.routes;
        if (d.nodes) {
          const model = L2()?.buildModel({
            nodes: d.nodes,
            groupTree: d.groupTree,
            workflows: d.workflows
          });
          st.model = model && model.rootIds.length > 1 ? model : null;
          st.srcPath = validPath(st.model, st.srcPath ?? []);
          st.dstPath = validPath(st.model, st.dstPath ?? []);
        }
        st.bouquets = d.bouquets ?? [];
        st.canSaveBouquets = d.canSave === true && !!io.saveBouquet;
        if (st.selSrc && !st.sources.some((x) => x.id === st.selSrc)) st.selSrc = null;
        if (st.selDst && !st.sinks.some((x) => x.id === st.selDst)) st.selDst = null;
        a.onChange();
      } catch (e) {
        a.onError(e);
      }
    }
  };
  return a;
}

// ui/shell/streamdeck/adapters/video-mixer-logic.ts
var TRANS_TYPES = [
  "mix",
  "vfade",
  "fadecut",
  "cutfade"
];
var TRANS_RATES = [
  6,
  12,
  25,
  50
];
var TYPE_LABEL = {
  mix: "MIX",
  vfade: "V-FADE",
  fadecut: "FADE-CUT",
  cutfade: "CUT-FADE"
};
function deckLabel(label) {
  return label.replace(/^omp-/, "").replace(/\s+Sender\s*\d+$/i, "");
}
function plan2(entries, ctrls, cols, rows, reserve) {
  const srcCap = Math.max(1, reserve ? cols - 1 : cols);
  const srcPages = Math.max(1, Math.ceil(entries / srcCap));
  const ctrlRows = rows >= 3 ? rows - 2 : rows;
  const ctrlCap = Math.max(1, ctrlRows * cols - (reserve ? 1 : 0));
  const ctrlChunks = Math.max(1, Math.ceil(ctrls / ctrlCap));
  const pages = rows >= 3 ? Math.max(srcPages, ctrlChunks) : rows === 2 ? srcPages + ctrlChunks : 2 * srcPages + ctrlChunks;
  return {
    srcCap,
    srcPages,
    ctrlCap,
    ctrlChunks,
    pages
  };
}
function controlItems(s) {
  const items = [
    {
      key: {
        label: "CUT"
      },
      act: {
        method: "crosspoint.cut"
      }
    },
    {
      key: {
        label: "AUTO"
      },
      act: {
        method: "crosspoint.autoTrans"
      }
    },
    {
      key: {
        label: "DSK",
        state: s.keyer ? "onair" : "off"
      },
      act: {
        method: "keyer.setEnabled",
        body: {
          enabled: !s.keyer
        }
      }
    },
    {
      key: {
        label: "\xDCbergang",
        sub: TYPE_LABEL[s.transType] ?? s.transType
      },
      act: {
        method: "crosspoint.setTransType",
        body: {
          type: TRANS_TYPES[(TRANS_TYPES.indexOf(s.transType) + 1) % TRANS_TYPES.length]
        }
      }
    },
    {
      key: {
        label: "Rate",
        sub: s.transRate ? `${s.transRate} f` : "\u2013"
      },
      act: {
        method: "crosspoint.setTransRate",
        body: {
          frames: TRANS_RATES[(TRANS_RATES.indexOf(s.transRate) + 1) % TRANS_RATES.length]
        }
      }
    },
    // Standbild des PGM-Bildes aufnehmen; es erscheint danach als angeheftete Quelle (auch als Taste).
    {
      key: {
        label: "FREEZE",
        sub: "Standbild"
      },
      act: {
        method: "freeze.capture"
      }
    }
  ];
  for (const p of s.pipPresets) {
    const on = s.pipEnabled && s.activePip === p.id;
    items.push({
      key: {
        label: p.name || p.id,
        sub: "PIP",
        state: on ? "cue" : "off"
      },
      act: on ? {
        method: "pip.setEnabled",
        body: {
          enabled: false
        }
      } : {
        method: "pip.applyPreset",
        body: {
          id: p.id
        }
      }
    });
  }
  for (const sl of s.pipSlots ?? []) {
    if (!sl.enabled) continue;
    items.push({
      key: {
        label: `PIP ${sl.slot + 1}`,
        sub: "Fokus",
        state: sl.focused ? "cue" : "off"
      },
      act: {
        method: "pip.toggleFocus",
        body: {
          slot: sl.slot
        }
      }
    });
  }
  return items;
}
function layoutVideoMixer(s, cols, rows, page) {
  const ctrls = controlItems(s);
  let pl = plan2(s.entries.length, ctrls.length, cols, rows, false);
  const reserve = pl.pages > 1;
  if (reserve) pl = plan2(s.entries.length, ctrls.length, cols, rows, true);
  const p = Math.min(Math.max(0, page), pl.pages - 1);
  const keys = Array.from({
    length: rows
  }, () => Array(cols).fill(null));
  const act = Array.from({
    length: rows
  }, () => Array(cols).fill(null));
  const srcRow = (r, bus, sp) => {
    const slice = s.entries.slice(sp * pl.srcCap, sp * pl.srcCap + pl.srcCap);
    slice.forEach((e, c) => {
      const cur = bus === "pgm" ? s.program : s.preset;
      const live = e.senderId === cur;
      const flag = e.problem ? e.problem === "error" ? " \u2716" : " !" : "";
      keys[r][c] = {
        label: deckLabel(e.label) || "BLK",
        sub: bus.toUpperCase() + flag,
        state: live ? bus === "pgm" ? "onair" : "preset" : e.problem === "error" ? "error" : "off"
      };
      act[r][c] = {
        method: bus === "pgm" ? "crosspoint.take" : "crosspoint.select",
        body: {
          senderId: e.senderId
        }
      };
    });
  };
  const ctrlRows = (from, count, chunk) => {
    ctrls.slice(chunk * pl.ctrlCap, chunk * pl.ctrlCap + pl.ctrlCap).forEach((it, i) => {
      const r = from + Math.floor(i / cols), c = i % cols;
      if (r < from + count) {
        keys[r][c] = it.key;
        act[r][c] = it.act;
      }
    });
  };
  if (rows >= 3) {
    srcRow(0, "pgm", p % pl.srcPages);
    srcRow(1, "pre", p % pl.srcPages);
    ctrlRows(2, rows - 2, p % pl.ctrlChunks);
  } else if (rows === 2) {
    if (p < pl.srcPages) {
      srcRow(0, "pgm", p);
      srcRow(1, "pre", p);
    } else ctrlRows(0, 2, p - pl.srcPages);
  } else if (p < 2 * pl.srcPages) srcRow(0, p % 2 === 0 ? "pgm" : "pre", Math.floor(p / 2));
  else ctrlRows(0, 1, p - 2 * pl.srcPages);
  return {
    keys,
    act,
    pages: pl.pages
  };
}

// ui/shell/streamdeck/adapters/video-mixer.ts
function videoMixerAdapter(api) {
  let last = null;
  return {
    getLayout(ctx) {
      const s = api.state();
      if (!s) return {
        keys: [
          [
            {
              label: "\u2026",
              dim: true
            }
          ]
        ]
      };
      last = layoutVideoMixer(s, ctx.cols, ctx.rows, ctx.page);
      return last;
    },
    onKey(row, col, down) {
      if (!down) return;
      const a = last?.act[row]?.[col];
      if (a) void api.call(a.method, a.body);
    }
  };
}

// ui/shell/streamdeck/adapters/index.ts
var FACTORIES = {
  "omp-video-mixer-me-panel": (el) => {
    const api = el.deckApi;
    return api ? videoMixerAdapter(api) : null;
  },
  "omp-xy-panel": (_el, nodeId) => xyPanelAdapter(coreIO(nodeId)),
  "omp-ograf-panel": (_el, nodeId) => ografAdapter(proxyIO(nodeId)),
  "omp-device-hub-panel": (_el, nodeId) => deviceHubAdapter(proxyIO(nodeId)),
  "omp-audio-mixer-panel": (_el, nodeId) => audioMixerAdapter(proxyIO(nodeId))
};
function adapterFor(el, nodeId) {
  return adapterOf(el) ?? FACTORIES[el.localName]?.(el, nodeId) ?? null;
}

// ui/shell/streamdeck/broker-logic.ts
function tabSlots(cols, tabCount) {
  const all = cols - 1;
  return tabCount > all ? Math.max(1, all - 1) : all;
}
function composeLayout(model, tabs, active, tabPage, content, contentPage) {
  const { cols, rows } = model;
  const keys = Array(cols * rows).fill(null);
  const presses = Array(cols * rows).fill({
    kind: "none"
  });
  keys[0] = {
    icon: "\u2302",
    label: "Home",
    state: active === null ? "preset" : "off"
  };
  presses[0] = {
    kind: "home"
  };
  const slots = tabSlots(cols, tabs.length);
  const tabPages = Math.max(1, Math.ceil(tabs.length / slots));
  const tp = Math.min(Math.max(0, tabPage), tabPages - 1);
  tabs.slice(tp * slots, tp * slots + slots).forEach((tab, i) => {
    keys[1 + i] = {
      label: tab.label,
      state: tab.id === active ? "preset" : "off"
    };
    presses[1 + i] = {
      kind: "tab",
      id: tab.id
    };
  });
  if (tabs.length > cols - 1 && cols >= 3) {
    keys[cols - 1] = {
      icon: "\u21C4",
      label: `${tp + 1}/${tabPages}`
    };
    presses[cols - 1] = {
      kind: "tabPage"
    };
  }
  const contentRows = rows - 1;
  let contentPages = 1;
  let dials = [];
  if (active === null) {
    const shown = new Set(tabs.slice(tp * slots, tp * slots + slots).map((x) => x.id));
    tabs.filter((x) => !shown.has(x.id)).slice(0, cols * contentRows).forEach((tab, i) => {
      const idx = cols + i;
      keys[idx] = {
        label: tab.label,
        state: "off"
      };
      presses[idx] = {
        kind: "tab",
        id: tab.id
      };
    });
  } else if (content) {
    for (let r = 0; r < contentRows; r++) {
      for (let c = 0; c < cols; c++) {
        const k = content.keys[r]?.[c];
        if (k) {
          keys[(r + 1) * cols + c] = k;
          presses[(r + 1) * cols + c] = {
            kind: "content",
            row: r,
            col: c
          };
        }
      }
    }
    contentPages = Math.max(1, content.pages ?? 1);
    if (contentPages > 1) {
      const last = cols * rows - 1;
      keys[last] = {
        icon: "\u21C4",
        label: `${Math.min(contentPage, contentPages - 1) + 1}/${contentPages}`
      };
      presses[last] = {
        kind: "contentPage"
      };
    }
    dials = content.dials ?? [];
  } else {
    keys[cols] = {
      label: "\u2026",
      dim: true
    };
  }
  return {
    keys,
    presses,
    dials,
    tabPages,
    contentPages
  };
}
var DialCoalescer = class {
  #sum = /* @__PURE__ */ new Map();
  add(i, delta) {
    this.#sum.set(i, (this.#sum.get(i) ?? 0) + delta);
  }
  take() {
    const out = [
      ...this.#sum
    ].filter(([, d]) => d !== 0);
    this.#sum.clear();
    return out;
  }
};

// ui/shell/streamdeck/models.ts
var VENDOR_ID = 4057;
function rotationMatrix(r, w, h) {
  if (r === 180) return [
    -1,
    0,
    0,
    -1,
    w,
    h
  ];
  if (r === 90) return [
    0,
    -1,
    1,
    0,
    0,
    w
  ];
  return [
    1,
    0,
    0,
    1,
    0,
    0
  ];
}
function rotatedSize(r, w, h) {
  return r === 90 ? [
    h,
    w
  ] : [
    w,
    h
  ];
}
var key15 = {
  cols: 5,
  rows: 3,
  keySize: 72,
  rotation: 180,
  dials: 0
};
var xl = {
  cols: 8,
  rows: 4,
  keySize: 96,
  rotation: 180,
  dials: 0
};
var MODELS = [
  {
    pid: 108,
    name: "Stream Deck XL",
    ...xl
  },
  {
    pid: 143,
    name: "Stream Deck XL 2022",
    ...xl
  },
  {
    pid: 109,
    name: "Stream Deck 2019",
    ...key15
  },
  {
    pid: 128,
    name: "Stream Deck MK.2",
    ...key15
  },
  {
    pid: 165,
    name: "Stream Deck MK.2 Scissor",
    ...key15
  },
  {
    pid: 132,
    name: "Stream Deck +",
    cols: 4,
    rows: 2,
    keySize: 120,
    // Hersteller: „keine Drehung“; Vorlage dreht. Am Gerät zu klären (40.2-Gerätetest).
    rotation: 0,
    dials: 4,
    strip: {
      w: 800,
      h: 100
    }
  },
  {
    // Hersteller-HID-Seite „Stream Deck + XL“ (2026-10-13): 9×4 Tasten 112 px, 6 Dials,
    // Streifen 1200×100; alle Bilder (Tasten, Streifen) 90° gegen den Uhrzeigersinn gedreht.
    pid: 198,
    name: "Stream Deck + XL",
    cols: 9,
    rows: 4,
    keySize: 112,
    rotation: 90,
    dials: 6,
    strip: {
      w: 1200,
      h: 100
    }
  }
];
function modelForPid(pid) {
  return MODELS.find((m) => m.pid === pid);
}
function keyCount(m) {
  return m.cols * m.rows;
}

// ui/shell/streamdeck/plot-draw.ts
function drawEq(g, s, W, H, p) {
  const pad = Math.max(4, H * 0.06);
  const X = (f) => pad + Math.log10(f / 20) / 3 * (W - 2 * pad);
  const Y = (db) => H / 2 - db / 18 * (H / 2 - pad);
  g.lineWidth = 1;
  g.strokeStyle = p.grid;
  for (const f of [
    100,
    1e3,
    1e4
  ]) {
    g.beginPath();
    g.moveTo(X(f), pad);
    g.lineTo(X(f), H - pad);
    g.stroke();
  }
  for (const d of [
    -12,
    -6,
    6,
    12
  ]) {
    g.beginPath();
    g.moveTo(pad, Y(d));
    g.lineTo(W - pad, Y(d));
    g.stroke();
  }
  g.strokeStyle = p.dim;
  g.beginPath();
  g.moveTo(pad, Y(0));
  g.lineTo(W - pad, Y(0));
  g.stroke();
  g.lineWidth = Math.max(2, H * 0.025);
  g.strokeStyle = s.bypass ? p.dim : p.accent;
  g.lineJoin = "round";
  g.beginPath();
  const n = Math.max(40, Math.round(W / 4));
  for (let i = 0; i <= n; i++) {
    const f = 20 * Math.pow(1e3, i / n);
    const y = Y(Math.max(-18, Math.min(18, eqResponseDb(s, f))));
    if (i) g.lineTo(X(f), y);
    else g.moveTo(X(f), y);
  }
  g.stroke();
  s.bands.forEach((b, i) => {
    g.beginPath();
    g.arc(X(b.f), Y(Math.max(-18, Math.min(18, b.g))), Math.max(3, H * 0.035), 0, Math.PI * 2);
    g.fillStyle = i === s.focus ? p.text : "transparent";
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = p.text;
    g.stroke();
  });
}
function drawDyn(g, s, W, H, p) {
  const pad = Math.max(4, Math.min(W, H) * 0.08);
  const side = Math.min(W - 2 * pad, H - 2 * pad);
  const x0 = (W - side) / 2, y0 = (H - side) / 2;
  const lo = -60, hi = 0;
  const X = (db) => x0 + (Math.max(lo, Math.min(hi, db)) - lo) / (hi - lo) * side;
  const Y = (db) => y0 + side - (Math.max(lo, Math.min(hi, db)) - lo) / (hi - lo) * side;
  g.lineWidth = 1;
  g.strokeStyle = p.grid;
  for (const d of [
    -48,
    -36,
    -24,
    -12
  ]) {
    g.beginPath();
    g.moveTo(X(d), y0);
    g.lineTo(X(d), y0 + side);
    g.stroke();
    g.beginPath();
    g.moveTo(x0, Y(d));
    g.lineTo(x0 + side, Y(d));
    g.stroke();
  }
  g.strokeStyle = p.dim;
  g.strokeRect(x0, y0, side, side);
  g.beginPath();
  g.moveTo(X(lo), Y(lo));
  g.lineTo(X(hi), Y(hi));
  g.stroke();
  if (s.gateOn && s.gateThr > lo) {
    g.strokeStyle = p.dim;
    g.setLineDash([
      4,
      3
    ]);
    g.beginPath();
    g.moveTo(X(s.gateThr), y0);
    g.lineTo(X(s.gateThr), y0 + side);
    g.stroke();
    g.setLineDash([]);
  }
  g.lineWidth = Math.max(2, side * 0.03);
  g.strokeStyle = s.on ? p.accent : p.dim;
  g.beginPath();
  for (let i = 0; i <= 60; i++) {
    const x = lo + i / 60 * (hi - lo);
    const y = compOutDb(s, x);
    if (i) g.lineTo(X(x), Y(y));
    else g.moveTo(X(x), Y(y));
  }
  g.stroke();
  g.beginPath();
  g.arc(X(s.thr), Y(compOutDb(s, s.thr)), Math.max(3, side * 0.035), 0, Math.PI * 2);
  g.fillStyle = p.text;
  g.fill();
}
function drawPlotSlice(g, sl, cellW, cellH, p, alpha = 1) {
  g.save();
  g.beginPath();
  g.rect(0, 0, cellW, cellH);
  g.clip();
  g.translate(-sl.cx * cellW, -sl.cy * cellH);
  g.globalAlpha = alpha;
  const W = sl.cw * cellW, H = sl.ch * cellH;
  if (sl.spec.kind === "eq") drawEq(g, sl.spec, W, H, p);
  else drawDyn(g, sl.spec, W, H, p);
  g.restore();
}

// ui/shell/streamdeck/draw.ts
var STATE_TOKEN = {
  onair: "--omp-onair",
  preset: "--omp-preset",
  cue: "--omp-cue",
  off: "--omp-surface-raised",
  error: "--omp-error"
};
var FALLBACK = {
  "--omp-onair": "#e53935",
  "--omp-preset": "#43a047",
  "--omp-cue": "#fb8c00",
  "--omp-error": "#ef5350",
  "--omp-surface": "#0f1522",
  "--omp-surface-raised": "#172033",
  "--omp-bg": "#080c16",
  "--omp-text": "#eaf0fa",
  "--omp-text-dim": "#93a1ba",
  "--omp-accent-cyan": "#19d3f3"
};
function resolveColor(c) {
  if (!c.startsWith("--")) return c;
  const v = typeof document !== "undefined" ? getComputedStyle(document.documentElement).getPropertyValue(c).trim() : "";
  return v || FALLBACK[c] || "#000";
}
function wrap(g, text, maxW, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (g.measureText(next).width <= maxW || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let l = lines[maxLines - 1];
    while (l.length > 1 && g.measureText(`${l}\u2026`).width > maxW) l = l.slice(0, -1);
    lines[maxLines - 1] = `${l}\u2026`;
  }
  return lines.map((l) => {
    while (l.length > 1 && g.measureText(l).width > maxW) l = l.slice(0, -2) + "\u2026";
    return l;
  });
}
function wrapHard(g, text, maxW) {
  const lines = [];
  let cur = "";
  const push = () => {
    if (cur) lines.push(cur);
    cur = "";
  };
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${w}` : w;
    if (g.measureText(next).width <= maxW) {
      cur = next;
      continue;
    }
    push();
    if (g.measureText(w).width <= maxW) {
      cur = w;
      continue;
    }
    for (const ch of w) {
      if (g.measureText(cur + ch).width > maxW && cur) push();
      cur += ch;
    }
  }
  push();
  return lines;
}
function fitText(g, text, maxW, maxH, maxFs, minFs, weight) {
  let lines = [];
  let fs = maxFs;
  for (const noSplit of [
    true,
    false
  ]) {
    for (fs = maxFs; fs >= minFs; fs -= 1) {
      g.font = `${weight} ${fs}px sans-serif`;
      if (noSplit && text.split(/\s+/).some((w) => g.measureText(w).width > maxW)) continue;
      lines = wrapHard(g, text, maxW);
      if (lines.length * fs * 1.12 <= maxH) return {
        lines,
        fs
      };
    }
  }
  fs = minFs;
  g.font = `${weight} ${fs}px sans-serif`;
  lines = wrapHard(g, text, maxW);
  const n = Math.max(1, Math.floor(maxH / (fs * 1.12)));
  if (lines.length > n) {
    lines.length = n;
    let l = lines[n - 1];
    while (l.length > 1 && g.measureText(`${l}\u2026`).width > maxW) l = l.slice(0, -1);
    lines[n - 1] = `${l}\u2026`;
  }
  return {
    lines,
    fs
  };
}
async function toJpeg(c) {
  const b = await c.convertToBlob({
    type: "image/jpeg",
    quality: 0.92
  });
  return new Uint8Array(await b.arrayBuffer());
}
function palette() {
  return {
    bg: resolveColor("--omp-surface"),
    grid: "rgba(255,255,255,0.12)",
    dim: resolveColor("--omp-text-dim"),
    line: resolveColor("--omp-text"),
    accent: resolveColor("--omp-accent-cyan"),
    text: resolveColor("--omp-text")
  };
}
function drawKey(def, m) {
  const s = m.keySize;
  const c = new OffscreenCanvas(s, s);
  const g = c.getContext("2d");
  g.setTransform(...rotationMatrix(m.rotation, s, s));
  g.fillStyle = resolveColor("--omp-bg");
  g.fillRect(0, 0, s, s);
  if (!def) return c;
  if (def.plot) {
    g.fillStyle = resolveColor("--omp-surface");
    g.fillRect(0, 0, s, s);
    drawPlotSlice(g, def.plot, s, s, palette());
    return c;
  }
  const accent = def.color ? resolveColor(def.color) : def.state ? resolveColor(STATE_TOKEN[def.state]) : "";
  const lit = def.state === "onair" || def.state === "preset" || def.state === "cue" || def.state === "error";
  g.fillStyle = lit && accent ? accent : resolveColor("--omp-surface-raised");
  g.fillRect(2, 2, s - 4, s - 4);
  if (!lit && accent) {
    g.fillStyle = accent;
    g.fillRect(2, 2, s - 4, Math.max(4, Math.round(s * 0.06)));
  }
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = resolveColor("--omp-text");
  g.fillStyle = resolveColor("--omp-text");
  const maxW = s - 10;
  let top = 6;
  let bottom = s - 6;
  if (def.icon) {
    g.font = `${Math.round(s * 0.3)}px sans-serif`;
    g.fillText(def.icon, s / 2, top + s * 0.16);
    top += s * 0.3;
  }
  if (def.sub) {
    const sub = fitText(g, def.sub, maxW, s * 0.2, Math.round(s * 0.15), Math.round(s * 0.1), "");
    g.fillStyle = lit ? "rgba(255,255,255,0.85)" : resolveColor("--omp-text-dim");
    const lh = sub.fs * 1.12;
    sub.lines.forEach((l, i) => g.fillText(l, s / 2, bottom - (sub.lines.length - i - 0.5) * lh));
    bottom -= sub.lines.length * lh + 2;
  }
  if (def.label) {
    g.fillStyle = resolveColor("--omp-text");
    const lab = fitText(g, def.label, maxW, Math.max(s * 0.2, bottom - top), Math.round(s * (def.icon ? 0.19 : 0.24)), Math.round(s * 0.11), "bold");
    const lh = lab.fs * 1.12;
    const y0 = top + (bottom - top - lab.lines.length * lh) / 2 + lh / 2;
    lab.lines.forEach((l, i) => g.fillText(l, s / 2, y0 + i * lh));
  }
  if (def.dim) {
    g.fillStyle = "rgba(0,0,0,0.6)";
    g.fillRect(0, 0, s, s);
  }
  return c;
}
function drawDial(def, w, h, rotation = 0) {
  const [cw, ch] = rotatedSize(rotation, w, h);
  const c = new OffscreenCanvas(cw, ch);
  const g = c.getContext("2d");
  g.setTransform(...rotationMatrix(rotation, w, h));
  g.fillStyle = resolveColor("--omp-surface");
  g.fillRect(0, 0, w, h);
  if (!def) return c;
  if (def.plot) drawPlotSlice(g, def.plot, w, h, palette(), 0.6);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = resolveColor("--omp-text-dim");
  g.font = `${Math.round(h * 0.2)}px sans-serif`;
  g.fillText(wrap(g, def.label, w - 12, 1)[0] ?? "", w / 2, h * 0.2);
  g.fillStyle = resolveColor("--omp-text");
  g.font = `bold ${Math.round(h * 0.3)}px sans-serif`;
  g.fillText(wrap(g, def.value, w - 12, 1)[0] ?? "", w / 2, h * 0.52);
  if (def.fill !== void 0) {
    const f = Math.max(0, Math.min(1, def.fill));
    g.fillStyle = resolveColor("--omp-surface-raised");
    g.fillRect(12, h * 0.8, w - 24, h * 0.1);
    g.fillStyle = resolveColor("--omp-accent-cyan");
    g.fillRect(12, h * 0.8, (w - 24) * f, h * 0.1);
  }
  if (def.dim) {
    g.fillStyle = "rgba(0,0,0,0.6)";
    g.fillRect(0, 0, w, h);
  }
  return c;
}
var canvasRasterizer = {
  key: (d, m) => toJpeg(drawKey(d, m)),
  dial: (d, w, h, rot) => toJpeg(drawDial(d, w, h, rot))
};

// ui/shell/streamdeck/render-logic.ts
function fingerprint(def) {
  if (!def) return "-";
  const o = def;
  return JSON.stringify(Object.keys(o).sort().filter((k) => o[k] !== void 0).map((k) => [
    k,
    o[k]
  ]));
}
var DeckRenderer = class {
  target;
  raster;
  opts;
  #keys;
  #dials;
  #sentKeys;
  #sentDials;
  #dirty;
  #timer;
  #flushing;
  stats;
  constructor(target, raster, opts = {}) {
    this.target = target;
    this.raster = raster;
    this.opts = opts;
    this.#dirty = false;
    this.#timer = null;
    this.#flushing = null;
    this.stats = {
      keyImages: 0,
      stripImages: 0,
      flushes: 0
    };
    const n = keyCount(target.model);
    this.#keys = Array(n).fill(null);
    this.#dials = Array(target.model.dials).fill(null);
    this.#sentKeys = Array(n).fill("?");
    this.#sentDials = Array(target.model.dials).fill("?");
  }
  /** Setzt den gewünschten Zustand; fehlende Einträge = leer. */
  set(keys, dials = []) {
    for (let i = 0; i < this.#keys.length; i++) this.#keys[i] = keys[i] ?? null;
    for (let i = 0; i < this.#dials.length; i++) this.#dials[i] = dials[i] ?? null;
    this.#schedule();
  }
  /** Alles neu senden (z. B. nach Wiederverbinden). */
  invalidate() {
    this.#sentKeys.fill("?");
    this.#sentDials.fill("?");
    this.#schedule();
  }
  /** Wartet auf einen gerade laufenden Durchgang (Tests/Schließen). */
  async idle() {
    while (this.#flushing) await this.#flushing;
  }
  /** Sofort senden (ohne Debounce). */
  async flushNow() {
    this.#timer = null;
    while (this.#flushing) await this.#flushing;
    this.#flushing = this.#flush().finally(() => this.#flushing = null);
    await this.#flushing;
  }
  #schedule() {
    this.#dirty = true;
    if (this.#timer !== null) return;
    const set = this.opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#timer = set(() => {
      void this.flushNow();
    }, this.opts.debounceMs ?? 60);
  }
  async #flush() {
    this.stats.flushes++;
    this.#dirty = false;
    try {
      const model = this.target.model;
      const keyJobs = [];
      for (let i = 0; i < this.#keys.length; i++) {
        const fp = fingerprint(this.#keys[i]);
        if (fp !== this.#sentKeys[i]) keyJobs.push({
          i,
          fp,
          jpeg: this.raster.key(this.#keys[i], model)
        });
      }
      const strip2 = model.strip;
      const dialJobs = [];
      if (strip2 && this.#dials.length) {
        const w = strip2.w / this.#dials.length;
        for (let i = 0; i < this.#dials.length; i++) {
          const fp = fingerprint(this.#dials[i]);
          if (fp !== this.#sentDials[i]) dialJobs.push({
            i,
            fp,
            w,
            h: strip2.h,
            jpeg: this.raster.dial(this.#dials[i], w, strip2.h, model.rotation)
          });
        }
      }
      for (const j of [
        ...keyJobs,
        ...dialJobs
      ]) j.jpeg.catch(() => {
      });
      for (const j of keyJobs) {
        await this.target.setKeyImage(j.i, await j.jpeg);
        this.#sentKeys[j.i] = j.fp;
        this.stats.keyImages++;
      }
      for (const j of dialJobs) {
        await this.target.setStripImage(j.w * j.i, 0, j.w, j.h, await j.jpeg);
        this.#sentDials[j.i] = j.fp;
        this.stats.stripImages++;
      }
    } catch (e) {
      this.opts.onError?.(e);
      this.#dirty = true;
    }
    if (this.#dirty && this.#timer === null) this.#schedule();
  }
};

// ui/shell/streamdeck/broker.ts
var REFRESH_MS = 1500;
var DIAL_FLUSH_MS = 50;
var DeckBroker = class {
  #dev;
  #renderer;
  #tabs = /* @__PURE__ */ new Map();
  #active = null;
  #tabPage = 0;
  #composed = null;
  #dials = new DialCoalescer();
  #timers = [];
  #unsub;
  /** Gerät wählt einen Tab: Bildschirm soll folgen (Kachel nach vorn). */
  onFocusRequest = () => {
  };
  onError = (e) => console.warn("[streamdeck]", e);
  constructor(dev, raster = canvasRasterizer) {
    this.#dev = dev;
    this.#renderer = new DeckRenderer(dev, raster, {
      onError: (e) => this.onError(e)
    });
    this.#unsub = dev.onEvent((e) => this.#onEvent(e));
    this.#timers.push(globalThis.setInterval(() => this.#flushDials(), DIAL_FLUSH_MS));
    this.#timers.push(globalThis.setInterval(() => void this.#refresh(), REFRESH_MS));
    void dev.setBrightness(70).catch((e) => this.onError(e));
    this.relayout();
  }
  get active() {
    return this.#active;
  }
  get composed() {
    return this.#composed;
  }
  get model() {
    return this.#dev.model;
  }
  attach(id, label, el, nodeId) {
    this.detach(id);
    const tab = {
      info: {
        id,
        label
      },
      el,
      nodeId,
      adapter: null,
      page: 0,
      onRelayout: () => this.relayout()
    };
    el.addEventListener(RELAYOUT_EVENT, tab.onRelayout);
    this.#tabs.set(id, tab);
    this.relayout();
  }
  detach(id) {
    const t2 = this.#tabs.get(id);
    if (!t2) return;
    t2.el.removeEventListener(RELAYOUT_EVENT, t2.onRelayout);
    t2.adapter?.dispose?.();
    this.#tabs.delete(id);
    if (this.#active === id) this.#active = null;
    this.relayout();
  }
  /** Tab aktivieren (null = Home). `fromDevice`: Bildschirm soll folgen. */
  focus(id, fromDevice = false) {
    if (id !== null && !this.#tabs.has(id)) return;
    this.#active = id;
    if (id !== null) {
      const t2 = this.#tabs.get(id);
      t2.adapter ??= this.#resolveAdapter(t2);
    }
    if (fromDevice) this.onFocusRequest(id);
    this.relayout();
  }
  #resolveAdapter(t2) {
    const own = adapterFor(t2.el, t2.nodeId);
    if (own) {
      const w = own;
      if ("onChange" in w) w.onChange = () => this.relayout();
      if ("onError" in w) w.onError = (e) => this.onError(e);
      void Promise.resolve(own.refresh?.()).catch((e) => this.onError(e));
      return own;
    }
    const a = new AutoRasterAdapter(proxyIO(t2.nodeId));
    a.onChange = () => this.relayout();
    a.onError = (e) => this.onError(e);
    return a;
  }
  relayout() {
    const m = this.#dev.model;
    const tabs = [
      ...this.#tabs.values()
    ].map((t2) => t2.info);
    const act = this.#active ? this.#tabs.get(this.#active) : void 0;
    const content = act?.adapter ? act.adapter.getLayout({
      cols: m.cols,
      rows: m.rows - 1,
      dials: m.dials,
      page: act.page
    }) : null;
    this.#composed = composeLayout(m, tabs, this.#active, this.#tabPage, content, act?.page ?? 0);
    const c = this.#composed;
    if (act) act.page = Math.min(act.page, c.contentPages - 1);
    this.#renderer.set(c.keys, c.dials);
  }
  /** Sendet ausstehende Bilder sofort (Tests/Schließen). */
  flushNow() {
    return this.#renderer.flushNow();
  }
  #onEvent(e) {
    const c = this.#composed;
    const act = this.#active ? this.#tabs.get(this.#active) : void 0;
    if (e.kind === "key") {
      const p = c?.presses[e.index];
      if (!p) return;
      if (p.kind === "content") {
        act?.adapter?.onKey(p.row, p.col, e.down);
        return;
      }
      if (!e.down) return;
      if (p.kind === "home") this.focus(null, true);
      else if (p.kind === "tab") this.focus(p.id, true);
      else if (p.kind === "tabPage") {
        this.#tabPage = (this.#tabPage + 1) % (c?.tabPages ?? 1);
        this.relayout();
      } else if (p.kind === "contentPage" && act) {
        act.page = (act.page + 1) % (c?.contentPages ?? 1);
        this.relayout();
      }
    } else if (e.kind === "dialTurn") {
      this.#dials.add(e.index, e.delta);
    } else if (e.kind === "dialPress") {
      act?.adapter?.onDialPress?.(e.index, e.down);
    } else if (e.kind === "flick" && act && (c?.contentPages ?? 1) > 1) {
      const n = c.contentPages;
      act.page = (act.page + (e.x2 < e.x ? 1 : n - 1)) % n;
      this.relayout();
    }
  }
  #flushDials() {
    const act = this.#active ? this.#tabs.get(this.#active) : void 0;
    for (const [i, d] of this.#dials.take()) act?.adapter?.onDial?.(i, d);
  }
  #refreshing = false;
  async #refresh() {
    if (this.#refreshing) return;
    const act = this.#active ? this.#tabs.get(this.#active) : void 0;
    this.#refreshing = true;
    try {
      await Promise.race([
        Promise.resolve(act?.adapter?.refresh?.()),
        new Promise((res) => setTimeout(res, 8e3))
      ]);
    } catch (e) {
      this.onError(e);
    } finally {
      this.#refreshing = false;
    }
  }
  /** Beendet den Broker; das Gerät schließt der Aufrufer. */
  stop() {
    for (const t2 of this.#timers) clearInterval(t2);
    this.#unsub();
    for (const id of [
      ...this.#tabs.keys()
    ]) {
      const t2 = this.#tabs.get(id);
      t2.el.removeEventListener(RELAYOUT_EVENT, t2.onRelayout);
      t2.adapter?.dispose?.();
    }
    this.#tabs.clear();
  }
};

// ui/shell/streamdeck/protocol.ts
var OUTPUT_LEN = 1023;
var KEY_HEADER = 7;
var STRIP_HEADER = 15;
var CMD_KEY_IMAGE = 7;
var CMD_STRIP_PARTIAL = 12;
function u16(buf, off, v) {
  buf[off] = v & 255;
  buf[off + 1] = v >> 8 & 255;
}
function chunked(data, header, fill) {
  const payload = OUTPUT_LEN - header;
  const out = [];
  let off = 0;
  do {
    const part = data.subarray(off, off + payload);
    off += part.length;
    const buf = new Uint8Array(OUTPUT_LEN);
    fill(buf, off >= data.length, out.length, part.length);
    buf.set(part, header);
    out.push(buf);
  } while (off < data.length);
  return out;
}
function keyImageReports(key, jpeg) {
  return chunked(jpeg, KEY_HEADER, (b, last, chunk, len) => {
    b[0] = CMD_KEY_IMAGE;
    b[1] = key;
    b[2] = last ? 1 : 0;
    u16(b, 3, len);
    u16(b, 5, chunk);
  });
}
function stripImageReports(x, y, w, h, jpeg) {
  return chunked(jpeg, STRIP_HEADER, (b, last, chunk, len) => {
    b[0] = CMD_STRIP_PARTIAL;
    u16(b, 1, x);
    u16(b, 3, y);
    u16(b, 5, w);
    u16(b, 7, h);
    b[9] = last ? 1 : 0;
    u16(b, 10, chunk);
    u16(b, 12, len);
  });
}
function brightnessFeature(pct) {
  const b = new Uint8Array(31);
  b[0] = 8;
  b[1] = Math.max(0, Math.min(100, Math.round(pct)));
  return b;
}
function showLogoFeature() {
  const b = new Uint8Array(31);
  b[0] = 2;
  return b;
}
var rd16 = (d, o) => d[o] | d[o + 1] << 8;
var i8 = (v) => v > 127 ? v - 256 : v;
var InputDecoder = class {
  model;
  #keys;
  #dials;
  constructor(model) {
    this.model = model;
    this.#keys = Array(keyCount(model)).fill(false);
    this.#dials = Array(model.dials).fill(false);
  }
  decode(d) {
    const ev = [];
    const cmd = d[0];
    if (cmd === 0) {
      for (let i = 0; i < this.#keys.length; i++) {
        const down = d[3 + i] === 1;
        if (down !== this.#keys[i]) {
          this.#keys[i] = down;
          ev.push({
            kind: "key",
            index: i,
            down
          });
        }
      }
    } else if (cmd === 3 && this.model.dials > 0) {
      const type = d[3];
      for (let i = 0; i < this.model.dials; i++) {
        if (type === 1) {
          const delta = i8(d[4 + i]);
          if (delta !== 0) ev.push({
            kind: "dialTurn",
            index: i,
            delta
          });
        } else if (type === 0) {
          const down = d[4 + i] === 1;
          if (down !== this.#dials[i]) {
            this.#dials[i] = down;
            ev.push({
              kind: "dialPress",
              index: i,
              down
            });
          }
        }
      }
    } else if (cmd === 2 && this.model.strip) {
      const type = d[3];
      if (type === 1 || type === 2) {
        ev.push({
          kind: "touch",
          type: type === 1 ? "tap" : "press",
          x: rd16(d, 5),
          y: rd16(d, 7)
        });
      } else if (type === 3) {
        ev.push({
          kind: "flick",
          x: rd16(d, 5),
          y: rd16(d, 7),
          x2: rd16(d, 9),
          y2: rd16(d, 11)
        });
      }
    }
    return ev;
  }
};

// ui/shell/streamdeck/transport.ts
var DeckDevice = class _DeckDevice {
  model;
  #hid;
  #decoder;
  #listeners = /* @__PURE__ */ new Set();
  #onReport = (e) => {
    const d = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    for (const ev of this.#decoder.decode(d)) for (const l of this.#listeners) l(ev);
  };
  constructor(hid, model) {
    this.#hid = hid;
    this.model = model;
    this.#decoder = new InputDecoder(model);
  }
  /** Öffnet ein Gerät; wirft `Error(OpenError)` mit lesbarem Code in `message`. */
  static async open(hid) {
    const model = hid.vendorId === VENDOR_ID ? modelForPid(hid.productId) : void 0;
    if (!model) throw new Error("unsupported-model");
    try {
      if (!hid.opened) await hid.open();
    } catch {
      throw new Error("open-failed");
    }
    const dev = new _DeckDevice(hid, model);
    hid.addEventListener("inputreport", dev.#onReport);
    return dev;
  }
  /** Anzeigename des Geräts (Produktname des HID-Geräts, sonst das Modell). */
  get label() {
    return this.#hid.productName || this.model.name;
  }
  onEvent(cb) {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }
  async setKeyImage(key, jpeg) {
    for (const r of keyImageReports(key, jpeg)) await this.#hid.sendReport(2, r);
  }
  async setStripImage(x, y, w, h, jpeg) {
    if (!this.model.strip) return;
    for (const r of stripImageReports(x, y, w, h, jpeg)) await this.#hid.sendReport(2, r);
  }
  async setBrightness(pct) {
    await this.#hid.sendFeatureReport(3, brightnessFeature(pct));
  }
  /** Zeigt das Logo und schließt (Hersteller-Empfehlung statt „Reset“). */
  async close() {
    this.#hid.removeEventListener("inputreport", this.#onReport);
    this.#listeners.clear();
    try {
      await this.#hid.sendFeatureReport(3, showLogoFeature());
      await this.#hid.close();
    } catch {
    }
  }
};
async function connectKnown() {
  const hid = navigator.hid;
  if (!hid) return null;
  const known = (await hid.getDevices().catch(() => [])).find((d) => d.vendorId === VENDOR_ID && modelForPid(d.productId));
  return known ? openResult(known) : null;
}
async function openResult(h) {
  try {
    return {
      ok: true,
      device: await DeckDevice.open(h)
    };
  } catch (e) {
    return {
      ok: false,
      reason: e.message
    };
  }
}

// ui/shell/streamdeck/session.ts
var DeckSession = class {
  #reg = /* @__PURE__ */ new Map();
  #broker = null;
  #dev = null;
  #hotplug = false;
  #listeners = /* @__PURE__ */ new Set();
  #errListeners = /* @__PURE__ */ new Set();
  /** Die Konsole hängt hier ein: Gerät hat Tab gewählt → Kachel nach vorn. */
  focusRequest = () => {
  };
  get broker() {
    return this.#broker;
  }
  get device() {
    return this.#dev;
  }
  onChange(cb) {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }
  /** Fehler des Brokers/der Adapter (z. B. 403 beim Schalten) für die Anzeige. */
  onError(cb) {
    this.#errListeners.add(cb);
    return () => this.#errListeners.delete(cb);
  }
  #emit() {
    for (const l of this.#listeners) l();
  }
  registerTab(id, label, el, nodeId) {
    const short = label.replace(/^omp-/, "");
    this.#reg.set(id, {
      label: short,
      el,
      nodeId
    });
    this.#broker?.attach(id, short, el, nodeId);
  }
  unregisterTab(id) {
    this.#reg.delete(id);
    this.#broker?.detach(id);
  }
  /** Bildschirm hat eine Kachel nach vorn geholt → Gerät folgt. */
  focusFromScreen(id) {
    if (this.#broker?.active !== void 0 && this.#reg.has(id)) this.#broker?.focus(id);
  }
  setDevice(dev) {
    this.#broker?.stop();
    this.#broker = null;
    this.#dev = dev;
    if (dev) {
      const b = new DeckBroker(dev);
      b.onFocusRequest = (id) => this.focusRequest(id);
      b.onError = (e) => {
        console.warn("[streamdeck]", e);
        for (const l of this.#errListeners) l(e);
      };
      for (const [id, r] of this.#reg) b.attach(id, r.label, r.el, r.nodeId);
      this.#broker = b;
      this.#installHotplug();
    }
    this.#emit();
  }
  /** Broker beenden und Gerät schließen → Gerät zeigt wieder sein Logo (Logout, Seite schließen). */
  async releaseDevice() {
    const dev = this.#dev;
    if (!dev) return;
    this.setDevice(null);
    await dev.close();
  }
  #installHotplug() {
    if (this.#hotplug) return;
    const hid = navigator.hid;
    if (!hid) return;
    this.#hotplug = true;
    globalThis.addEventListener("pagehide", () => void this.releaseDevice());
    hid.addEventListener("disconnect", () => {
      if (this.#dev) this.setDevice(null);
    });
    hid.addEventListener("connect", async () => {
      if (this.#dev) return;
      const r = await connectKnown();
      if (r?.ok) this.setDevice(r.device);
    });
  }
};
var deckSession = new DeckSession();

// ui/modules/channel-desk/multichannel-logic.ts
function waitKindOf(w) {
  if (!w) return "";
  if (typeof w === "string") {
    try {
      return waitKindOf(JSON.parse(w));
    } catch {
      return w;
    }
  }
  return w.kind ?? "";
}
function summarize(v, fallbackName) {
  if (!v || v.connected === false) {
    return {
      name: v?.channelName || fallbackName,
      mode: "",
      onAir: "",
      nextLabel: "",
      remainingMs: null,
      progress: 0,
      waitKind: "",
      itemCount: v?.items?.length ?? 0,
      remainingTotalMs: 0,
      health: "offline"
    };
  }
  const items = v.items ?? [];
  const idx = items.findIndex((i) => i.id === v.currentItemId);
  const cur = idx >= 0 ? items[idx] : void 0;
  const dur = v.currentDurationMs || cur?.durationMs || 0;
  const pos = v.playheadPositionMs ?? 0;
  const remainingMs = cur && dur > 0 ? Math.max(0, dur - pos) : null;
  const next = idx >= 0 ? items[idx + 1] : v.cuedItemId ? items.find((i) => i.id === v.cuedItemId) : items[0];
  const waitKind = waitKindOf(v.operatorWait);
  let remainingTotalMs = remainingMs ?? 0;
  for (let i = idx + 1; i < items.length && idx >= 0; i++) remainingTotalMs += items[i].durationMs || 0;
  let health = "ok";
  if (!cur) health = "warn";
  else if (waitKind) health = "wait";
  else if (remainingMs !== null && remainingMs < 1e4 && !next) health = "warn";
  return {
    name: v.channelName || fallbackName,
    mode: v.mode ?? "",
    onAir: cur?.label ?? "",
    nextLabel: next?.label ?? "",
    remainingMs,
    progress: dur > 0 ? Math.min(1, pos / dur) : 0,
    waitKind,
    itemCount: items.length,
    remainingTotalMs,
    health
  };
}
function blockClass(it, currentItemId, cuedItemId) {
  if (!it) return "";
  const c = [];
  const ctl = it.eventType === "HOLD" || it.eventType === "JUMP";
  if (!ctl) {
    if (it.available === false) c.push("miss");
    else if (it.asset && it.readiness === "NOT_READY") c.push("bad");
  }
  if (it.id === currentItemId) c.push("onair");
  else if (it.id === cuedItemId) c.push("cued");
  if (it.startType === "fixtime") c.push("fix");
  if (it.senderId) c.push("live");
  if (ctl) c.push("ctl");
  return c.join(" ");
}
function buildBlocks(items, tl, playlistNowMs, currentItemId, pastMs, futureMs, cuedItemId) {
  const span = pastMs + futureMs;
  if (span <= 0) return [];
  const from = playlistNowMs - pastMs;
  const to = playlistNowMs + futureMs;
  const byId = new Map(items.map((i) => [
    i.id,
    i
  ]));
  const out = [];
  for (const e of tl) {
    if (e.endMs <= from || e.startMs >= to) continue;
    const s = Math.max(e.startMs, from);
    const f = Math.min(e.endMs, to);
    out.push({
      id: e.itemId,
      label: byId.get(e.itemId)?.label ?? "",
      leftPct: (s - from) / span * 100,
      widthPct: Math.max(0.4, (f - s) / span * 100),
      current: e.itemId === currentItemId,
      cls: blockClass(byId.get(e.itemId), currentItemId, cuedItemId)
    });
  }
  return out;
}
function nowOffsetPct(pastMs, futureMs) {
  const span = pastMs + futureMs;
  return span > 0 ? pastMs / span * 100 : 0;
}
function playlistNow(tl, currentItemId, playheadMs, cuedItemId) {
  const cur = currentItemId ? tl.find((x) => x.itemId === currentItemId) : void 0;
  if (cur) return cur.startMs + playheadMs;
  const cued = cuedItemId ? tl.find((x) => x.itemId === cuedItemId) : void 0;
  return (cued ?? tl[0])?.startMs ?? null;
}
var TIMELINE_PAST_SHARE = 0.06;
function fmtRemain(ms) {
  if (ms === null) return "\u2013:\u2013\u2013";
  const s = Math.max(0, Math.round(ms / 1e3));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const sec = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}
function gangCall(a) {
  switch (a) {
    case "hold":
      return {
        kind: "param",
        name: "mode",
        value: "hold"
      };
    case "auto":
      return {
        kind: "param",
        name: "mode",
        value: "auto"
      };
    default:
      return {
        kind: "method",
        name: a
      };
  }
}
function summarizeGang(results) {
  return {
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok)
  };
}
function pruneSelection(selected, existing) {
  const have = new Set(existing);
  return new Set([
    ...selected
  ].filter((s) => have.has(s)));
}
function stepChannel(ids, current2, delta) {
  if (ids.length === 0) return null;
  const i = current2 ? ids.indexOf(current2) : -1;
  if (i < 0) return ids[delta === 1 ? 0 : ids.length - 1];
  return ids[(i + delta + ids.length) % ids.length];
}
function nodeIdFromBundleUrl(url) {
  return url.replace(/\/+$/, "").split("/").pop() ?? "";
}
function axisTicks(nowEpochMs, pastMs, futureMs) {
  const span = pastMs + futureMs;
  if (span <= 0) return [];
  const stepMin = [
    1,
    2,
    5,
    10,
    15,
    30,
    60
  ].find((m) => span / (m * 6e4) <= 8) ?? 60;
  const step = stepMin * 6e4;
  const from = nowEpochMs - pastMs;
  const out = [];
  for (let t2 = Math.ceil(from / step) * step; t2 <= nowEpochMs + futureMs; t2 += step) {
    out.push({
      leftPct: (t2 - from) / span * 100,
      epochMs: t2
    });
  }
  return out;
}

// ui/modules/channel-desk/channel-desk.ts
var PARAMS = [
  "items",
  "currentItemId",
  "cuedItemId",
  "mode",
  "connected",
  "playheadPositionMs",
  "currentDurationMs",
  "channelName",
  "operatorWait"
];
var ACTIONS = [
  "next",
  "take",
  "nextLive",
  "hold",
  "auto"
];
var WINDOWS_MIN = [
  10,
  30,
  60
];
var POLL_MS = 1e3;
var TL_EVERY = 5;
var STYLE = `
omp-channel-desk{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--omp-bg);color:var(--omp-text);font-family:var(--omp-font)}
omp-channel-desk .cd-bar{display:flex;gap:6px;align-items:center;padding:6px;border-bottom:1px solid var(--omp-border);flex-shrink:0;overflow-x:auto}
omp-channel-desk .cd-tab{display:flex;gap:8px;align-items:center;border:1px solid transparent;border-radius:var(--omp-radius);padding:6px 12px;background:transparent;color:var(--omp-text-dim);font:inherit;font-size:var(--omp-font-size-sm);cursor:pointer;white-space:nowrap}
omp-channel-desk .cd-tab.active{background:var(--omp-surface-raised);color:var(--omp-text);border-color:var(--omp-border)}
omp-channel-desk .cd-tab .rem{font-variant-numeric:tabular-nums;opacity:.8;min-width:3.4em;text-align:right}
omp-channel-desk .cd-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;background:var(--omp-text-dim)}
omp-channel-desk .cd-dot.ok{background:var(--omp-success,#3ecf6e)}
omp-channel-desk .cd-dot.wait{background:var(--omp-warning,#f0b429)}
omp-channel-desk .cd-dot.warn{background:var(--omp-error,#ff5c5c)}
omp-channel-desk .cd-dot.offline{background:#666}
omp-channel-desk .cd-main{flex:1;min-height:0;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:12px}
omp-channel-desk .cd-edit{flex:1;min-height:0}
omp-channel-desk .cd-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
omp-channel-desk .cd-tools .grow{flex:1}
omp-channel-desk .cd-tools .sep{width:1px;align-self:stretch;background:var(--omp-border);margin:0 4px}
omp-channel-desk .cd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:12px;align-content:start}
omp-channel-desk .cd-card{display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--omp-border);border-radius:var(--omp-radius);background:var(--omp-surface)}
omp-channel-desk .cd-card.sel{border-color:var(--omp-accent,#4aa3ff);box-shadow:0 0 0 1px var(--omp-accent,#4aa3ff) inset}
omp-channel-desk .cd-head{display:flex;gap:8px;align-items:center}
omp-channel-desk .cd-name{font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
omp-channel-desk .cd-badge{font-size:var(--omp-font-size-sm);padding:1px 8px;border-radius:10px;border:1px solid var(--omp-border);color:var(--omp-text-dim)}
omp-channel-desk .cd-badge.hold,omp-channel-desk .cd-badge.wait{color:var(--omp-warning,#f0b429);border-color:var(--omp-warning,#f0b429)}
omp-channel-desk .cd-now{display:flex;gap:10px;align-items:baseline}
omp-channel-desk .cd-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:1.05em}
omp-channel-desk .cd-clock{font-size:1.8em;font-variant-numeric:tabular-nums;font-weight:600;min-width:3.6em;text-align:right}
omp-channel-desk .cd-prog{height:6px;border-radius:3px;background:var(--omp-surface-raised);overflow:hidden}
omp-channel-desk .cd-prog>i{display:block;height:100%;background:var(--omp-accent,#4aa3ff)}
omp-channel-desk .cd-next{min-height:1.3em;color:var(--omp-text-dim);font-size:var(--omp-font-size-sm);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
omp-channel-desk .cd-tl{position:relative;height:26px;border-radius:3px;background:var(--omp-surface-raised);overflow:hidden}
omp-channel-desk .cd-tl b{position:absolute;top:3px;bottom:3px;border-radius:2px;background:linear-gradient(#3a6f9a,#24506f);overflow:hidden;font-weight:400;font-size:11px;line-height:20px;padding:0 3px;box-sizing:border-box;white-space:nowrap;color:#fff;border:1px solid #000}
omp-channel-desk .cd-tl u{position:absolute;top:0;bottom:0;width:2px;background:#ff5c5c;text-decoration:none}
omp-channel-desk .cd-stats{display:flex;gap:14px;color:var(--omp-text-dim);font-size:var(--omp-font-size-sm);font-variant-numeric:tabular-nums}
omp-channel-desk .cd-all{display:flex;flex-direction:column;gap:3px;padding:10px;border:1px solid var(--omp-border);border-radius:var(--omp-radius);background:var(--omp-surface)}
omp-channel-desk .cd-all .row{display:flex;gap:8px;align-items:center}
omp-channel-desk .cd-all .lbl{width:130px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--omp-font-size-sm);display:flex;gap:6px;align-items:center}
omp-channel-desk .cd-all .lane{position:relative;flex:1;height:26px;border-radius:3px;background:var(--omp-surface-raised);overflow:hidden}
omp-channel-desk .cd-all .lane b{position:absolute;top:3px;bottom:3px;border-radius:2px;background:linear-gradient(#3a6f9a,#24506f);overflow:hidden;font-weight:400;font-size:11px;line-height:20px;padding:0 3px;box-sizing:border-box;white-space:nowrap;color:#fff;border:1px solid #000;cursor:pointer}
omp-channel-desk .cd-all .axis{position:relative;height:16px;flex:1;font-size:11px;color:var(--omp-text-dim);font-variant-numeric:tabular-nums}
omp-channel-desk .cd-all .axis span{position:absolute;transform:translateX(-50%);white-space:nowrap}
omp-channel-desk .cd-all .grid{position:absolute;top:0;bottom:0;width:1px;background:#ffffff14}
omp-channel-desk .cd-all .nowline{position:absolute;top:0;bottom:0;width:2px;background:#ff5c5c}
omp-channel-desk b.live{background:linear-gradient(#b3407a,#7d2455)!important}
omp-channel-desk b.ctl{background:linear-gradient(#555,#3a3a3a)!important}
omp-channel-desk b.fix{box-shadow:0 0 0 1px var(--omp-accent,#4aa3ff) inset}
omp-channel-desk b.cued{background:linear-gradient(#c79a1c,#8a6a0a)!important;color:#1a1100!important}
omp-channel-desk b.onair{background:linear-gradient(#35b862,#1c8a48)!important;color:#02150a!important}
omp-channel-desk b.miss{background:repeating-linear-gradient(135deg,#c42b2b 0 6px,#7a1414 6px 12px)!important;box-shadow:0 0 0 2px #ff4040;z-index:1}
omp-channel-desk b.bad{background:repeating-linear-gradient(135deg,#d98a14 0 6px,#7a4a08 6px 12px)!important;box-shadow:0 0 0 2px #ff9f1c;z-index:1}
omp-channel-desk .cd-empty{color:var(--omp-text-dim);padding:24px;text-align:center}
`;
var ChannelDesk = class extends HTMLElement {
  #entries = [];
  #channels = [];
  #isPlayout = /* @__PURE__ */ new Map();
  #selected = /* @__PURE__ */ new Set();
  #openKey = null;
  #winMin = 30;
  #combined = false;
  #allBox;
  #allBtn;
  #timer;
  #tick = 0;
  #polling = false;
  #bar;
  #main;
  #grid;
  #tools;
  #selInfo;
  #gangBtns = [];
  #editHost;
  #overviewTab;
  #keyHandler = (ev) => this.#onKey(ev);
  #loading = true;
  connectedCallback() {
    if (!document.getElementById("omp-channel-desk-style")) {
      const s = document.createElement("style");
      s.id = "omp-channel-desk-style";
      s.textContent = STYLE;
      document.head.append(s);
    }
    try {
      const w = Number(localStorage.getItem("omp-cd-window"));
      if (WINDOWS_MIN.includes(w)) this.#winMin = w;
      this.#combined = localStorage.getItem("omp-cd-combined") === "1";
    } catch {
    }
    this.#bar = document.createElement("div");
    this.#bar.className = "cd-bar";
    this.#main = document.createElement("div");
    this.#main.className = "cd-main";
    this.append(this.#bar, this.#main);
    this.#buildOverview();
    this.#renderAll();
    addEventListener("keydown", this.#keyHandler);
    this.#timer = setInterval(() => void this.#poll(), POLL_MS);
  }
  disconnectedCallback() {
    clearInterval(this.#timer);
    removeEventListener("keydown", this.#keyHandler);
    for (const c of this.#channels) deckSession.unregisterTab(c.key);
  }
  /** Setzt die Konsolen-Liste (aus /api/v1/me/consoles oder dem Node-Bestand); wiederholt aufrufbar. */
  async setEntries(entries) {
    this.#entries = entries;
    const probes = await Promise.all(entries.map(async (e) => {
      const id = `${e.nodeRoleId}|${e.uiBundleUrl}`;
      if (!this.#isPlayout.has(id)) {
        const r = await apiFetch(`${e.uiBundleUrl}/params/currentItemId`).catch(() => null);
        if (r && (r.ok || r.status === 404)) this.#isPlayout.set(id, r.ok);
        else return false;
      }
      return this.#isPlayout.get(id) === true;
    }));
    const wanted = entries.filter((_, i) => probes[i]);
    const old = new Map(this.#channels.map((c) => [
      c.key,
      c
    ]));
    this.#channels = wanted.map((e) => {
      const prev = old.get(e.nodeRoleId);
      if (prev && prev.entry.uiBundleUrl === e.uiBundleUrl) {
        prev.entry = e;
        return prev;
      }
      return this.#makeChannel(e);
    });
    this.#loading = false;
    this.#selected = pruneSelection(this.#selected, this.#channels.map((c) => c.key));
    if (this.#openKey && !this.#channels.some((c) => c.key === this.#openKey)) this.#openKey = null;
    this.#renderAll();
    void this.#poll();
  }
  /** Channels, die die Ansicht zeigt (für die Shell: gibt es überhaupt etwas zu übersichten?). */
  get channelCount() {
    return this.#channels.length;
  }
  #makeChannel(e) {
    const switchBtn = document.createElement("button");
    switchBtn.className = "cd-tab";
    switchBtn.addEventListener("click", () => this.#open(e.nodeRoleId));
    const ch = {
      key: e.nodeRoleId,
      entry: e,
      nodeId: nodeIdFromBundleUrl(e.uiBundleUrl),
      values: null,
      tl: [],
      tlKey: "",
      summary: summarize(null, e.nodeLabel),
      card: document.createElement("div"),
      switchBtn
    };
    this.#buildCard(ch);
    return ch;
  }
  // ---- Übersicht ------------------------------------------------------------------------------------------------
  #buildOverview() {
    this.#tools = document.createElement("div");
    this.#tools.className = "cd-tools";
    const title = document.createElement("strong");
    title.textContent = t("mc.title");
    const grow = document.createElement("span");
    grow.className = "grow";
    const win = document.createElement("select");
    win.title = t("mc.window");
    for (const m of WINDOWS_MIN) {
      const o = document.createElement("option");
      o.value = String(m);
      o.textContent = t("mc.winMin", {
        n: m
      });
      win.append(o);
    }
    win.value = String(this.#winMin);
    win.addEventListener("change", () => {
      this.#winMin = Number(win.value);
      try {
        localStorage.setItem("omp-cd-window", String(this.#winMin));
      } catch {
      }
      for (const c of this.#channels) this.#updateCard(c);
      this.#updateCombined();
    });
    const all = this.#btn(t("mc.selectAll"), () => {
      this.#selected = new Set(this.#channels.map((c) => c.key));
      this.#syncSelection();
    });
    const none = this.#btn(t("mc.selectNone"), () => {
      this.#selected.clear();
      this.#syncSelection();
    });
    this.#selInfo = document.createElement("span");
    this.#selInfo.style.color = "var(--omp-text-dim)";
    const sep = document.createElement("span");
    sep.className = "sep";
    const gangLabel = document.createElement("span");
    gangLabel.textContent = t("mc.gang");
    gangLabel.title = t("mc.gangHint");
    this.#gangBtns = ACTIONS.map((a) => {
      const b = this.#btn(t(`mc.act.${a}`), () => void this.#gang(a));
      b.title = t("mc.gangHint");
      return b;
    });
    this.#allBtn = this.#btn(t("mc.allTimeline"), () => {
      this.#combined = !this.#combined;
      try {
        localStorage.setItem("omp-cd-combined", this.#combined ? "1" : "0");
      } catch {
      }
      this.#renderAll();
    });
    this.#allBtn.title = t("mc.allTimelineTip");
    this.#allBox = document.createElement("div");
    this.#allBox.className = "cd-all";
    this.#tools.append(title, grow, win, this.#allBtn, all, none, this.#selInfo, sep, gangLabel, ...this.#gangBtns);
    this.#grid = document.createElement("div");
    this.#grid.className = "cd-grid";
  }
  #btn(text, on) {
    const b = document.createElement("button");
    b.textContent = text;
    b.addEventListener("click", on);
    return b;
  }
  #buildCard(ch) {
    const card = ch.card;
    card.className = "cd-card";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.role = "sel";
    cb.addEventListener("change", () => {
      if (cb.checked) this.#selected.add(ch.key);
      else this.#selected.delete(ch.key);
      this.#syncSelection();
    });
    const dot = document.createElement("span");
    dot.className = "cd-dot";
    dot.dataset.role = "dot";
    const name = document.createElement("span");
    name.className = "cd-name";
    name.dataset.role = "name";
    const badge = document.createElement("span");
    badge.className = "cd-badge";
    badge.dataset.role = "badge";
    const edit = this.#btn(t("mc.edit"), () => this.#open(ch.key));
    const head = document.createElement("div");
    head.className = "cd-head";
    head.append(cb, dot, name, badge, edit);
    const title = document.createElement("span");
    title.className = "cd-title";
    title.dataset.role = "title";
    const clock = document.createElement("span");
    clock.className = "cd-clock";
    clock.dataset.role = "clock";
    const now = document.createElement("div");
    now.className = "cd-now";
    now.append(title, clock);
    const prog = document.createElement("div");
    prog.className = "cd-prog";
    prog.innerHTML = "<i></i>";
    const next = document.createElement("div");
    next.className = "cd-next";
    next.dataset.role = "next";
    const tl = document.createElement("div");
    tl.className = "cd-tl";
    tl.dataset.role = "tl";
    tl.addEventListener("dblclick", () => this.#open(ch.key));
    const stats = document.createElement("div");
    stats.className = "cd-stats";
    stats.dataset.role = "stats";
    card.append(head, now, prog, next, tl, stats);
    this.#updateCard(ch);
  }
  #q(el, role) {
    return el.querySelector(`[data-role="${role}"]`);
  }
  #updateCard(ch) {
    const s = ch.summary;
    const c = ch.card;
    c.classList.toggle("sel", this.#selected.has(ch.key));
    this.#q(c, "sel").checked = this.#selected.has(ch.key);
    this.#q(c, "dot").className = `cd-dot ${s.health}`;
    this.#q(c, "dot").title = t(`mc.health.${s.health}`);
    this.#q(c, "name").textContent = s.name;
    const badge = this.#q(c, "badge");
    const waitText = s.waitKind ? t(`mc.wait.${s.waitKind}`) : "";
    badge.textContent = waitText || s.mode.toUpperCase();
    badge.className = `cd-badge ${s.waitKind ? "wait" : s.mode}`;
    badge.style.display = badge.textContent ? "" : "none";
    this.#q(c, "title").textContent = s.onAir || t("mc.nothing");
    this.#q(c, "clock").textContent = fmtRemain(s.remainingMs);
    c.querySelector(".cd-prog>i").style.width = `${Math.round(s.progress * 100)}%`;
    this.#q(c, "next").textContent = s.nextLabel ? `${t("mc.next")}: ${s.nextLabel}` : "";
    const v = ch.values;
    const tlEl = this.#q(c, "tl");
    const now = v ? playlistNow(ch.tl, v.currentItemId, v.playheadPositionMs ?? 0, v.cuedItemId) : null;
    if (v && now !== null) {
      const past = Math.round(this.#winMin * 6e4 * TIMELINE_PAST_SHARE);
      const future = this.#winMin * 6e4 - past;
      const blocks = buildBlocks(v.items ?? [], ch.tl, now, v.currentItemId, past, future, v.cuedItemId);
      tlEl.replaceChildren(...blocks.map((b) => {
        const el = document.createElement("b");
        el.style.left = `${b.leftPct}%`;
        el.style.width = `${b.widthPct}%`;
        el.textContent = b.label;
        el.title = b.label;
        el.className = b.cls;
        return el;
      }), Object.assign(document.createElement("u"), {
        style: `left:${nowOffsetPct(past, future)}%`
      }));
    } else {
      tlEl.replaceChildren();
    }
    const stats = this.#q(c, "stats");
    const ends = s.remainingTotalMs > 0 ? new Date(Date.now() + s.remainingTotalMs).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    }) : "";
    stats.replaceChildren(...[
      t("mc.stat.events", {
        n: s.itemCount
      }),
      s.remainingTotalMs > 0 ? t("mc.stat.rest", {
        t: fmtRemain(s.remainingTotalMs)
      }) : "",
      ends ? t("mc.stat.ends", {
        at: ends
      }) : ""
    ].filter(Boolean).map((x) => Object.assign(document.createElement("span"), {
      textContent: x
    })));
    ch.switchBtn.replaceChildren(Object.assign(document.createElement("span"), {
      className: `cd-dot ${s.health}`
    }), Object.assign(document.createElement("span"), {
      textContent: s.name
    }), Object.assign(document.createElement("span"), {
      className: "rem",
      textContent: s.onAir ? fmtRemain(s.remainingMs) : ""
    }));
    ch.switchBtn.title = `${s.name}${s.onAir ? ` \u2014 ${s.onAir}` : ""}`;
  }
  // Gesamt-Timeline: eine Spur je Channel auf gemeinsamer Wanduhr-Achse (jeder Channel ist relativ zu seiner eigenen
  // Sendeposition gezeichnet, „jetzt“ ist für alle dieselbe Linie — dadurch liegen gleichzeitige Events untereinander).
  #updateCombined() {
    if (!this.#combined || !this.#allBox.isConnected) return;
    const past = Math.round(this.#winMin * 6e4 * TIMELINE_PAST_SHARE);
    const future = this.#winMin * 6e4 - past;
    const nowPct = nowOffsetPct(past, future);
    const ticks = axisTicks(Date.now(), past, future);
    const mk = (cls, css = "", text = "") => Object.assign(document.createElement("div"), {
      className: cls,
      style: css,
      textContent: text
    });
    const axis = mk("axis");
    axis.append(...ticks.map((k) => Object.assign(document.createElement("span"), {
      style: `left:${k.leftPct}%`,
      textContent: new Date(k.epochMs).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      })
    })));
    const axisRow = mk("row");
    axisRow.append(mk("lbl"), axis);
    const rows = this.#channels.map((c) => {
      const lane = mk("lane");
      const v = c.values;
      const now = v ? playlistNow(c.tl, v.currentItemId, v.playheadPositionMs ?? 0, v.cuedItemId) : null;
      lane.append(...ticks.map((k) => mk("grid", `left:${k.leftPct}%`)));
      if (v && now !== null) {
        for (const b of buildBlocks(v.items ?? [], c.tl, now, v.currentItemId, past, future, v.cuedItemId)) {
          const el = Object.assign(document.createElement("b"), {
            textContent: b.label,
            title: b.label,
            className: b.cls
          });
          el.style.left = `${b.leftPct}%`;
          el.style.width = `${b.widthPct}%`;
          el.addEventListener("dblclick", () => this.#open(c.key));
          lane.append(el);
        }
      }
      lane.append(mk("nowline", `left:${nowPct}%`));
      const lbl = mk("lbl");
      lbl.append(mk(`cd-dot ${c.summary.health}`), Object.assign(document.createElement("span"), {
        textContent: c.summary.name
      }));
      lbl.title = c.summary.name;
      const row = mk("row");
      row.append(lbl, lane);
      return row;
    });
    this.#allBox.replaceChildren(axisRow, ...rows);
  }
  #syncSelection() {
    for (const c of this.#channels) {
      c.card.classList.toggle("sel", this.#selected.has(c.key));
      this.#q(c.card, "sel").checked = this.#selected.has(c.key);
    }
    this.#selInfo.textContent = this.#selected.size ? t("mc.selected", {
      n: this.#selected.size
    }) : "";
    for (const b of this.#gangBtns) b.disabled = this.#selected.size === 0;
  }
  // ---- Gruppen-Start --------------------------------------------------------------------------------------------
  async #gang(a) {
    const targets = this.#channels.filter((c) => this.#selected.has(c.key));
    if (targets.length === 0) return;
    const action = t(`mc.act.${a}`);
    if (targets.length > 1) {
      const ok = await confirmDialog(t("mc.confirm", {
        action,
        n: targets.length,
        names: targets.map((c) => c.summary.name).join(", ")
      }), {
        confirmLabel: action
      });
      if (!ok) return;
    }
    const call = gangCall(a);
    const results = await Promise.all(targets.map(async (c) => {
      try {
        const res = call.kind === "method" ? await apiFetch(`/api/v1/nodes/${c.nodeId}/methods/${call.name}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: "{}"
        }) : await apiFetch(`/api/v1/nodes/${c.nodeId}/params/${call.name}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            value: call.value
          })
        });
        if (res.ok) return {
          channel: c.summary.name,
          ok: true
        };
        return {
          channel: c.summary.name,
          ok: false,
          error: await res.text().catch(() => "") || `HTTP ${res.status}`
        };
      } catch (e) {
        return {
          channel: c.summary.name,
          ok: false,
          error: String(e)
        };
      }
    }));
    const sum = summarizeGang(results);
    if (sum.failed.length) showToast(t("mc.result.fail", {
      action,
      n: sum.failed.length,
      names: sum.failed.map((f) => `${f.channel} (${f.error})`).join(", ")
    }), {
      variant: "error"
    });
    else showToast(t("mc.result.ok", {
      action,
      n: sum.ok
    }), {
      variant: "info"
    });
    void this.#poll();
  }
  // ---- Wechsel / Bearbeiten -------------------------------------------------------------------------------------
  #open(key) {
    if (key === this.#openKey) return;
    this.#openKey = key;
    this.#renderAll();
  }
  #onKey(ev) {
    if (!ev.altKey || ev.ctrlKey || ev.metaKey || !this.isConnected) return;
    const ids = this.#channels.map((c) => c.key);
    if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
      ev.preventDefault();
      this.#open(stepChannel(ids, this.#openKey, ev.key === "ArrowRight" ? 1 : -1));
    } else if (ev.key === "0") {
      ev.preventDefault();
      this.#open(null);
    } else if (/^[1-9]$/.test(ev.key) && ids[Number(ev.key) - 1]) {
      ev.preventDefault();
      this.#open(ids[Number(ev.key) - 1]);
    }
  }
  #renderAll() {
    this.#overviewTab = document.createElement("button");
    this.#overviewTab.className = "cd-tab";
    this.#overviewTab.textContent = t("mc.overview");
    this.#overviewTab.title = t("mc.keys");
    this.#overviewTab.addEventListener("click", () => this.#open(null));
    this.#bar.replaceChildren(this.#overviewTab, ...this.#channels.map((c) => c.switchBtn));
    this.#bar.style.display = this.#channels.length > 0 ? "flex" : "none";
    this.#overviewTab.classList.toggle("active", this.#openKey === null);
    for (const c of this.#channels) c.switchBtn.classList.toggle("active", c.key === this.#openKey);
    if (this.#openKey === null) {
      for (const c of this.#channels) deckSession.unregisterTab(c.key);
      this.#editHost = void 0;
      if (this.#loading) {
        this.#main.replaceChildren(Object.assign(document.createElement("p"), {
          className: "cd-empty",
          textContent: t("mc.loading")
        }));
      } else if (this.#channels.length === 0) {
        this.#main.replaceChildren(Object.assign(document.createElement("p"), {
          className: "cd-empty",
          textContent: t("mc.empty")
        }));
      } else {
        this.#grid.replaceChildren(...this.#channels.map((c) => c.card));
        this.#main.replaceChildren(this.#tools, ...this.#combined ? [
          this.#allBox
        ] : [], this.#grid);
        this.#allBtn.classList.toggle("active", this.#combined);
        this.#allBtn.style.borderColor = this.#combined ? "var(--omp-accent,#4aa3ff)" : "";
        this.#syncSelection();
        this.#updateCombined();
      }
      return;
    }
    const ch = this.#channels.find((c) => c.key === this.#openKey);
    if (!ch) return;
    const host = document.createElement("div");
    host.className = "cd-edit";
    this.#editHost = host;
    this.#main.replaceChildren(host);
    void (async () => {
      const el = await mountUIBundleEl(host, ch.entry.uiBundleUrl);
      if (this.#editHost !== host) return;
      for (const c of this.#channels) if (c.key !== ch.key) deckSession.unregisterTab(c.key);
      if (el) deckSession.registerTab(ch.key, ch.entry.nodeLabel, el, ch.entry.uiBundleUrl.split("/").pop() ?? "");
      else host.replaceChildren(Object.assign(document.createElement("p"), {
        className: "cd-empty",
        textContent: t("mc.noBundle", {
          name: ch.entry.nodeLabel
        })
      }));
    })();
  }
  // ---- Abfrage --------------------------------------------------------------------------------------------------
  async #poll() {
    if (this.#polling || this.#channels.length === 0 || this.offsetParent === null) return;
    this.#polling = true;
    this.#tick++;
    try {
      await Promise.all(this.#channels.map((c) => this.#pollOne(c)));
    } finally {
      this.#polling = false;
    }
    for (const c of this.#channels) this.#updateCard(c);
    this.#updateCombined();
  }
  async #pollOne(c) {
    try {
      const pairs = await Promise.all(PARAMS.map(async (n) => {
        const r = await apiFetch(`/api/v1/nodes/${c.nodeId}/params/${n}`);
        return [
          n,
          r.ok ? (await r.json()).value : void 0
        ];
      }));
      const v = Object.fromEntries(pairs);
      c.values = pairs.every(([, x]) => x === void 0) ? {
        ...v,
        connected: false
      } : v;
      if (typeof v.operatorWait === "string") v.operatorWait = {
        kind: waitKindOf(v.operatorWait)
      };
      c.summary = summarize(c.values, c.entry.nodeLabel);
      const key = `${v.currentItemId ?? ""}|${v.items?.length ?? 0}`;
      if (key !== c.tlKey || this.#tick % TL_EVERY === 0) {
        const n = v.items?.length ?? 0;
        const r = n ? await apiFetch(`/api/v1/nodes/${c.nodeId}/timeline/window?fromIndex=0&count=${n}`) : null;
        c.tl = r && r.ok ? await r.json() : [];
        c.tlKey = key;
      }
    } catch {
      c.values = {
        connected: false
      };
      c.summary = summarize(c.values, c.entry.nodeLabel);
    }
  }
};
if (!customElements.get("omp-channel-desk")) {
  customElements.define("omp-channel-desk", ChannelDesk);
}

// ui/modules/channel-desk/panel.ts
var REFRESH_MS2 = 1e4;
var ChannelDeskPanel = class extends HTMLElement {
  #desk;
  #timer;
  #sig = "";
  connectedCallback() {
    this.style.cssText = "display:block;width:100%;height:100%;min-height:0;";
    this.#desk = document.createElement("omp-channel-desk");
    this.append(this.#desk);
    void this.#refresh();
    this.#timer = setInterval(() => void this.#refresh(), REFRESH_MS2);
  }
  disconnectedCallback() {
    clearInterval(this.#timer);
  }
  async #refresh() {
    try {
      const res = await apiFetch("/api/v1/me/consoles");
      if (!res.ok) return;
      const body = await res.json();
      const entries = body.consoles ?? [];
      const sig = entries.map((e) => `${e.nodeRoleId}|${e.uiBundleUrl}|${e.nodeLabel}`).join(";");
      if (sig === this.#sig) return;
      this.#sig = sig;
      await this.#desk?.setEntries(entries);
    } catch {
    }
  }
};
if (!customElements.get("omp-channel-desk")) customElements.define("omp-channel-desk", ChannelDesk);
if (!customElements.get("omp-channel-desk-panel")) customElements.define("omp-channel-desk-panel", ChannelDeskPanel);
export {
  ChannelDeskPanel
};
