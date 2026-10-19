// Texte des Moduls „Aufnahme“ (Kapitel 42). Deutsch und Englisch stehen je Schlüssel nebeneinander.
const TABLE: Record<string, [string, string]> = {
  "ing.title": [
    "Aufnahmen",
    "Recordings"
  ],
  "ing.loading": [
    "Lade …",
    "Loading …"
  ],
  "ing.new.schedule": [
    "Zeitplan",
    "Schedule"
  ],
  "ing.new.adhoc": [
    "Einzelaufnahme",
    "Single recording"
  ],
  "ing.edit.schedule": [
    "Zeitplan bearbeiten",
    "Edit schedule"
  ],
  "ing.window": [
    "Zeitfenster der Ansicht",
    "View window"
  ],
  "ing.settings": [
    "Einstellungen",
    "Settings"
  ],
  "ing.settings.hint": [
    "Konfiguration der Aufnahme als JSON: Profile (Bedarf, Format, Nachbearbeitung), Hostbudgets je Ressource, Vorwärmzeit, Zulassungsregeln. Der Server prüft vor dem Speichern.",
    "Recording configuration as JSON: profiles (demand, format, post-processing), host budgets per resource, lead time, admission rules. The server validates before saving."
  ],
  "ing.badjson": [
    "Kein gültiges JSON.",
    "Not valid JSON."
  ],
  "ing.save": [
    "Speichern",
    "Save"
  ],
  "ing.saved": [
    "Gespeichert.",
    "Saved."
  ],
  "ing.saved.blocked": [
    "Gespeichert — aber {p0} Auftrag/Aufträge nicht zugelassen (Gründe unter „Probleme“).",
    "Saved — but {p0} job(s) were not admitted (see “Problems” for the reasons)."
  ],
  "ing.close": [
    "Schließen",
    "Close"
  ],
  "ing.record": [
    "Aufnahme einplanen",
    "Schedule recording"
  ],
  "ing.err": [
    "Aktion fehlgeschlagen.",
    "Action failed."
  ],
  "ing.conflict": [
    "Der Zeitplan wurde inzwischen geändert — bitte neu laden.",
    "The schedule was changed in the meantime — please reload."
  ],
  "ing.predicted": [
    "VORHERGESAGT",
    "PREDICTED"
  ],
  "ing.actual": [
    "AKTUELL",
    "NOW"
  ],
  "ing.failed": [
    "FEHLGESCHLAGEN",
    "FAILED"
  ],
  "ing.kept": [
    "Aufnahme gesichert",
    "recording kept"
  ],
  "ing.noproblems": [
    "Keine Engpässe oder Fehler im Zeitraum.",
    "No shortages or failures in the window."
  ],
  "ing.waiting": [
    "wartet auf Quelle/Host",
    "waiting for source/host"
  ],
  "ing.earliest": [
    "Frühester möglicher Start: {p0}",
    "Earliest possible start: {p0}"
  ],
  "ing.jobs.n": [
    "{p0} Auftrag/Aufträge",
    "{p0} job(s)"
  ],
  "ing.preemptable": [
    "Nur ein Vorschlag: {p0} künftige Aufnahme(n) niedrigerer Priorität könnten weichen — nichts wird automatisch abgebrochen.",
    "Suggestion only: {p0} future lower-priority recording(s) could yield — nothing is cancelled automatically."
  ],
  "ing.timeline": [
    "Zeitleiste",
    "Timeline"
  ],
  "ing.lane.blocked": [
    "Nicht zugelassen",
    "Not admitted"
  ],
  "ing.lane.none": [
    "Ohne Host",
    "No host"
  ],
  "ing.none": [
    "Keine Aufträge im Zeitraum.",
    "No jobs in the window."
  ],
  "ing.capacity": [
    "Kapazität je Ressourcenart",
    "Capacity per resource type"
  ],
  "ing.capacity.hint": [
    "Jede Ressource hat ihre eigene Grenze — es gibt bewusst keine einzelne Gesamt-Auslastung. Balken = reservierte Nutzung, gestrichelt = Warnschwelle.",
    "Every resource has its own limit — there is deliberately no single overall utilization. Bars = reserved use, dashed = warning threshold."
  ],
  "ing.peak": [
    "Spitze",
    "peak"
  ],
  "ing.host.online": [
    "online",
    "online"
  ],
  "ing.host.offline": [
    "offline",
    "offline"
  ],
  "ing.res.recorder_slots": [
    "Rekorder",
    "Recorders"
  ],
  "ing.res.converter_slots": [
    "Konverter",
    "Converters"
  ],
  "ing.res.cpu_cores": [
    "CPU",
    "CPU"
  ],
  "ing.res.mem_mb": [
    "Arbeitsspeicher",
    "Memory"
  ],
  "ing.res.gpu_units": [
    "GPU",
    "GPU"
  ],
  "ing.res.disk_mbps": [
    "Schreibdurchsatz",
    "Disk throughput"
  ],
  "ing.res.disk_gb": [
    "Speicherplatz",
    "Disk space"
  ],
  "ing.res.net_mbps": [
    "Netz",
    "Network"
  ],
  "ing.res.mxl_shm_mb": [
    "MXL-Speicher",
    "MXL memory"
  ],
  "ing.jobs": [
    "Aufträge",
    "Jobs"
  ],
  "ing.f.all": [
    "Alle",
    "All"
  ],
  "ing.f.active": [
    "Laufend",
    "Running"
  ],
  "ing.f.upcoming": [
    "Bevorstehend",
    "Upcoming"
  ],
  "ing.f.problem": [
    "Probleme",
    "Problems"
  ],
  "ing.f.done": [
    "Erledigt",
    "Done"
  ],
  "ing.col.name": [
    "Name",
    "Name"
  ],
  "ing.col.when": [
    "Beginn",
    "Start"
  ],
  "ing.col.dur": [
    "Dauer",
    "Duration"
  ],
  "ing.col.source": [
    "Quelle",
    "Source"
  ],
  "ing.col.state": [
    "Zustand",
    "State"
  ],
  "ing.col.host": [
    "Host",
    "Host"
  ],
  "ing.col.dev": [
    "Startabw.",
    "Start dev."
  ],
  "ing.col.rule": [
    "Regel",
    "Rule"
  ],
  "ing.col.profile": [
    "Profil",
    "Profile"
  ],
  "ing.col.prio": [
    "Prio",
    "Prio"
  ],
  "ing.dst.shifted": [
    "Zeitumstellung: die geplante Uhrzeit existiert an diesem Tag nicht — Start zum ersten existierenden Zeitpunkt danach.",
    "Clock change: the planned wall time does not exist on this day — starts at the first existing time after it."
  ],
  "ing.dst.ambiguous": [
    "Zeitumstellung: die Uhrzeit kommt zweimal vor — die erste zählt.",
    "Clock change: the wall time occurs twice — the first one counts."
  ],
  "ing.abort": [
    "Abbrechen (laufend)",
    "Abort (running)"
  ],
  "ing.cancel": [
    "Absagen",
    "Cancel"
  ],
  "ing.abort.confirm": [
    "Die laufende Aufnahme „{p0}“ jetzt beenden? Die bisherige Aufnahme wird gesichert.",
    "Stop the running recording “{p0}” now? What has been recorded is kept."
  ],
  "ing.cancel.confirm": [
    "Auftrag „{p0}“ absagen?",
    "Cancel job “{p0}”?"
  ],
  "ing.cancelled": [
    "Erledigt.",
    "Done."
  ],
  "ing.schedules": [
    "Zeitpläne",
    "Schedules"
  ],
  "ing.schedules.none": [
    "Noch keine Zeitpläne. „＋ Zeitplan“ legt einen an.",
    "No schedules yet. “＋ Schedule” creates one."
  ],
  "ing.edit": [
    "Bearbeiten",
    "Edit"
  ],
  "ing.delete": [
    "Beenden",
    "End"
  ],
  "ing.delete.confirm": [
    "Zeitplan „{p0}“ beenden? Künftige Aufträge werden abgesagt, laufende Aufnahmen laufen aus.",
    "End schedule “{p0}”? Future jobs are cancelled; running recordings finish."
  ],
  "ing.deleted": [
    "Zeitplan beendet.",
    "Schedule ended."
  ],
  "ing.attempt": [
    "Versuch",
    "Attempt"
  ],
  "ing.file": [
    "Datei",
    "File"
  ],
  "ing.asset": [
    "Asset",
    "Asset"
  ],
  "ing.error": [
    "Fehler",
    "Error"
  ],
  "ing.history": [
    "Verlauf",
    "History"
  ],
  "ing.readmit": [
    "Neu bewerten",
    "Re-evaluate"
  ],
  "ing.admitted": [
    "Zugelassen.",
    "Admitted."
  ],
  "ing.stillblocked": [
    "Weiterhin nicht zugelassen.",
    "Still not admitted."
  ],
  "ing.open.asset": [
    "Im Eingang öffnen",
    "Open in Intake"
  ],
  "ing.freq.once": [
    "einmalig",
    "once"
  ],
  "ing.freq.daily": [
    "täglich",
    "daily"
  ],
  "ing.freq.weekly": [
    "wöchentlich",
    "weekly"
  ],
  "ing.freq.monthly": [
    "monatlich",
    "monthly"
  ],
  "ing.day.MO": [
    "Mo",
    "Mon"
  ],
  "ing.day.TU": [
    "Di",
    "Tue"
  ],
  "ing.day.WE": [
    "Mi",
    "Wed"
  ],
  "ing.day.TH": [
    "Do",
    "Thu"
  ],
  "ing.day.FR": [
    "Fr",
    "Fri"
  ],
  "ing.day.SA": [
    "Sa",
    "Sat"
  ],
  "ing.day.SU": [
    "So",
    "Sun"
  ],
  "ing.state.scheduled": [
    "Geplant",
    "Scheduled"
  ],
  "ing.state.blocked": [
    "Nicht zugelassen",
    "Not admitted"
  ],
  "ing.state.waiting_for_resources": [
    "Wartet auf Ressourcen",
    "Waiting for resources"
  ],
  "ing.state.starting": [
    "Startet",
    "Starting"
  ],
  "ing.state.recording": [
    "Nimmt auf",
    "Recording"
  ],
  "ing.state.finalizing": [
    "Sichert",
    "Finalizing"
  ],
  "ing.state.processing": [
    "Nachbearbeitung",
    "Processing"
  ],
  "ing.state.completed": [
    "Abgeschlossen",
    "Completed"
  ],
  "ing.state.failed": [
    "Fehlgeschlagen",
    "Failed"
  ],
  "ing.state.cancelled": [
    "Abgesagt",
    "Cancelled"
  ],
  "ing.stage.unknown": [
    "Unbekannte Stufe",
    "Unknown stage"
  ],
  "ing.stage.schedule": [
    "Planung",
    "Scheduling"
  ],
  "ing.stage.prepare": [
    "Vorbereitung",
    "Preparation"
  ],
  "ing.stage.source": [
    "Quelle",
    "Source"
  ],
  "ing.stage.start": [
    "Start",
    "Start"
  ],
  "ing.stage.recording": [
    "Aufnahme",
    "Recording"
  ],
  "ing.stage.finalize": [
    "Sicherung",
    "Finalizing"
  ],
  "ing.stage.processing": [
    "Nachbearbeitung",
    "Processing"
  ],
  "ing.v.ok": [
    "Zugelassen",
    "Admitted"
  ],
  "ing.v.source_conflict": [
    "Quellenkonflikt",
    "Source conflict"
  ],
  "ing.v.hard_shortage": [
    "Harter Ressourcenmangel",
    "Hard resource shortage"
  ],
  "ing.v.temporarily_occupied": [
    "Vorübergehend belegt",
    "Temporarily occupied"
  ],
  "ing.v.missing_function": [
    "Funktion fehlt",
    "Missing function"
  ],
  "ing.v.storage_insufficient": [
    "Speicher/Durchsatz reicht nicht",
    "Storage/throughput insufficient"
  ],
  "ing.v.soft_capacity_warning": [
    "Kapazitätswarnung",
    "Capacity warning"
  ],
  "ing.v.uncertain_estimate": [
    "Unsichere Schätzung",
    "Uncertain estimate"
  ],
  "ing.va.source_conflict": [
    "Anderen Zeitraum wählen oder das Quellenlimit erhöhen.",
    "Choose another time or raise the source limit."
  ],
  "ing.va.hard_shortage": [
    "Budget des Hosts erhöhen oder Aufträge verschieben.",
    "Raise the host budget or move jobs."
  ],
  "ing.va.temporarily_occupied": [
    "Später starten oder anderen Host wählen.",
    "Start later or choose another host."
  ],
  "ing.va.missing_function": [
    "Einen Host mit Rekorder online bringen.",
    "Bring a host with a recorder online."
  ],
  "ing.va.storage_insufficient": [
    "Platz schaffen oder anderes Ziel wählen.",
    "Free up space or choose another target."
  ],
  "ing.va.soft_capacity_warning": [
    "Zulassung ist möglich, aber knapp.",
    "Admission is possible but tight."
  ],
  "ing.va.uncertain_estimate": [
    "Bedarf im Profil messen lassen oder eintragen.",
    "Have the demand measured or enter it in the profile."
  ],
  "ing.check.incomplete": [
    "Quelle, Profil, Beginn und Dauer angeben — dann prüft der Server die Machbarkeit sofort.",
    "Enter source, profile, start and duration — the server then checks feasibility immediately."
  ],
  "ing.check.ok": [
    "Machbar auf Host {p0}",
    "Feasible on host {p0}"
  ],
  "ing.check.blocked": [
    "Nicht zulassbar",
    "Cannot be admitted"
  ],
  "ing.f.name": [
    "Name",
    "Name"
  ],
  "ing.f.source": [
    "Quelle",
    "Source"
  ],
  "ing.f.source.pick": [
    "— Quelle wählen —",
    "— choose a source —"
  ],
  "ing.f.source.all": [
    "Video + Audio",
    "video + audio"
  ],
  "ing.f.profile": [
    "Aufnahmeprofil",
    "Recording profile"
  ],
  "ing.f.tz": [
    "Zeitzone",
    "Time zone"
  ],
  "ing.f.tz.hint": [
    "IANA-Name, z. B. Europe/Berlin — Zeitumstellungen werden berücksichtigt",
    "IANA name, e.g. Europe/Berlin — clock changes are handled"
  ],
  "ing.f.start": [
    "Beginn (Ortszeit)",
    "Start (local time)"
  ],
  "ing.f.start.hint": [
    "Wanduhrzeit in der gewählten Zeitzone",
    "Wall-clock time in the chosen zone"
  ],
  "ing.f.duration": [
    "Dauer",
    "Duration"
  ],
  "ing.f.duration.hint": [
    "h:mm, z. B. 1:30",
    "h:mm, e.g. 1:30"
  ],
  "ing.f.priority": [
    "Priorität (0–9)",
    "Priority (0–9)"
  ],
  "ing.f.priority.hint": [
    "Höhere Priorität darf reservierte Kapazität nutzen",
    "Higher priority may use reserved capacity"
  ],
  "ing.f.freq": [
    "Wiederholung",
    "Repeat"
  ],
  "ing.f.interval": [
    "Alle … (Tage/Wochen/Monate)",
    "Every … (days/weeks/months)"
  ],
  "ing.f.byday": [
    "Wochentage",
    "Weekdays"
  ],
  "ing.f.until": [
    "Bis (inklusive)",
    "Until (inclusive)"
  ],
  "ing.f.count": [
    "Anzahl",
    "Count"
  ],
  "ing.f.count.hint": [
    "leer = unbegrenzt",
    "empty = unlimited"
  ],
  "ing.f.late": [
    "Wenn die Quelle fehlt",
    "If the source is missing"
  ],
  "ing.f.late.hint": [
    "Die Aufnahme endet immer zur geplanten Zeit",
    "The recording always ends at the planned time"
  ],
  "ing.late.wait": [
    "Warten, bis sie da ist",
    "Wait until it is there"
  ],
  "ing.late.delay": [
    "Begrenzt warten",
    "Wait for a limited time"
  ],
  "ing.late.fail": [
    "Sofort fehlschlagen",
    "Fail immediately"
  ],
  "ing.f.late.max": [
    "Höchstens warten (Minuten)",
    "Wait at most (minutes)"
  ],
  "ing.f.retry": [
    "Versuche bei Abbruch",
    "Attempts on failure"
  ],
  "ing.f.retry.hint": [
    "Nach einem Abbruch wird die Teilaufnahme gesichert und der Rest der Zeit neu aufgenommen",
    "After a failure the partial recording is kept and the remaining time is recorded again"
  ],
  "ing.f.host": [
    "Bevorzugter Host",
    "Preferred host"
  ],
  "ing.f.host.auto": [
    "automatisch",
    "automatic"
  ],
  "ing.f.dir": [
    "Zielordner",
    "Target folder"
  ],
  "ing.f.dir.hint": [
    "unter dem Medienverzeichnis",
    "below the media directory"
  ],
  "ing.f.template": [
    "Dateiname",
    "File name"
  ],
  "ing.f.template.hint": [
    "{name} {date} {time} {job}",
    "{name} {date} {time} {job}"
  ],
  "ing.f.desc": [
    "Beschreibung (Metadaten)",
    "Description (metadata)"
  ],
  "ing.p.name": [
    "Name fehlt",
    "Name is missing"
  ],
  "ing.p.source": [
    "Quelle wählen",
    "Choose a source"
  ],
  "ing.p.profile": [
    "Profil wählen",
    "Choose a profile"
  ],
  "ing.p.tz": [
    "Zeitzone fehlt",
    "Time zone is missing"
  ],
  "ing.p.start": [
    "Beginn ungültig",
    "Start is invalid"
  ],
  "ing.p.duration": [
    "Dauer ungültig (h:mm, höchstens 7 Tage)",
    "Duration invalid (h:mm, at most 7 days)"
  ],
  "ing.p.priority": [
    "Priorität muss 0–9 sein",
    "Priority must be 0–9"
  ],
  "ing.p.byday": [
    "Mindestens einen Wochentag wählen",
    "Choose at least one weekday"
  ],
  "ing.p.until": [
    "Enddatum ungültig",
    "End date invalid"
  ],
  "ing.p.count": [
    "Anzahl muss ≥ 1 sein",
    "Count must be ≥ 1"
  ]
};

export const messages: Record<"de" | "en", Record<string, string>> = {
  de: Object.fromEntries(Object.entries(TABLE).map(([k, v]) => [k, v[0]])),
  en: Object.fromEntries(Object.entries(TABLE).map(([k, v]) => [k, v[1]])),
};
