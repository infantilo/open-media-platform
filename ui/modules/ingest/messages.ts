// Texte des Moduls „Aufnahme“ (Kapitel 42). Deutsch und Englisch stehen je Schlüssel nebeneinander.
const TABLE: Record<string, [string, string]> = {
  "ing.unit.min": [
    "min",
    "min"
  ],
  "ing.cfg.remove": [
    "Entfernen",
    "Remove"
  ],
  "ing.cfg.general": [
    "Allgemein",
    "General"
  ],
  "ing.cfg.general.hint": [
    "Zeiten der Aufnahmeplanung und Speicherort.",
    "Timing of recording planning and storage location."
  ],
  "ing.cfg.lead": [
    "Vorwärmzeit",
    "Lead time"
  ],
  "ing.cfg.lead.help": [
    "So lange vor dem Beginn wird der Rekorder gestartet und verbunden.",
    "The recorder is started and connected this long before the start."
  ],
  "ing.cfg.dev": [
    "Ziel der Startabweichung",
    "Start deviation target"
  ],
  "ing.cfg.dev.help": [
    "Größere Abweichungen werden als Warnung gemeldet.",
    "Larger deviations are reported as a warning."
  ],
  "ing.cfg.horizon": [
    "Planungshorizont",
    "Planning horizon"
  ],
  "ing.cfg.horizon.help": [
    "So weit im Voraus werden Zeitpläne zu Aufträgen und reserviert.",
    "Schedules are turned into jobs and reserved this far ahead."
  ],
  "ing.cfg.media": [
    "Zielordner der Aufnahmen",
    "Recording folder"
  ],
  "ing.cfg.media.help": [
    "Ordner, in den der Rekorder schreibt.",
    "Folder the recorder writes to."
  ],
  "ing.cfg.policy": [
    "Standard-Richtlinien",
    "Default policies"
  ],
  "ing.cfg.policy.hint": [
    "Gelten für Zeitpläne, die nichts Eigenes festlegen.",
    "Apply to schedules that do not set their own."
  ],
  "ing.cfg.late": [
    "Wenn die Quelle fehlt",
    "If the source is missing"
  ],
  "ing.cfg.late.help": [
    "Verhalten zum geplanten Beginn.",
    "Behavior at the planned start."
  ],
  "ing.cfg.late.wait": [
    "Warten, Aufnahme endet zur geplanten Zeit",
    "Wait; recording ends at the planned time"
  ],
  "ing.cfg.late.delay": [
    "Begrenzt warten",
    "Wait for a limited time"
  ],
  "ing.cfg.late.fail": [
    "Sofort fehlschlagen",
    "Fail immediately"
  ],
  "ing.cfg.late.max": [
    "Längste Wartezeit",
    "Longest wait"
  ],
  "ing.cfg.retry.n": [
    "Versuche je Auftrag",
    "Attempts per job"
  ],
  "ing.cfg.retry.n.help": [
    "Inklusive des ersten Versuchs.",
    "Including the first attempt."
  ],
  "ing.cfg.retry.b": [
    "Pause zwischen Versuchen",
    "Pause between attempts"
  ],
  "ing.cfg.retry.r": [
    "Mindest-Restzeit für Neustart",
    "Minimum remaining time to restart"
  ],
  "ing.cfg.retry.r.help": [
    "Bleibt weniger Zeit, wird nach einem Abbruch nicht neu gestartet.",
    "With less time left, a restart after an abort is not attempted."
  ],
  "ing.cfg.rules": [
    "Zulassungsregeln",
    "Admission rules"
  ],
  "ing.cfg.rules.hint": [
    "Regeln, nach denen Aufträge angenommen oder abgelehnt werden.",
    "Rules deciding whether jobs are accepted or rejected."
  ],
  "ing.cfg.srclimit": [
    "Aufnahmen je Quelle gleichzeitig",
    "Simultaneous recordings per source"
  ],
  "ing.cfg.srclimit.help": [
    "Mehr gleichzeitige Aufnahmen derselben Quelle werden abgelehnt.",
    "More simultaneous recordings of the same source are rejected."
  ],
  "ing.cfg.resprio": [
    "Reserve ab Priorität",
    "Reserve from priority"
  ],
  "ing.cfg.resprio.help": [
    "Aufträge unterhalb dieser Priorität dürfen die Reserve nicht belegen.",
    "Jobs below this priority may not use the reserve."
  ],
  "ing.cfg.respct": [
    "Reserve je Ressource (Anteil, der nur wichtigen Aufträgen bleibt)",
    "Reserve per resource (share kept for important jobs only)"
  ],
  "ing.cfg.preempt": [
    "Verdrängung vorschlagen (laufende Aufnahmen werden nie automatisch unterbrochen)",
    "Suggest preemption (running recordings are never interrupted automatically)"
  ],
  "ing.cfg.budgets": [
    "Grenzen je Rechner",
    "Limits per machine"
  ],
  "ing.cfg.budgets.hint": [
    "Wie viel von jeder Ressource Aufnahmen höchstens belegen dürfen. Leer = keine eigene Grenze.",
    "How much of each resource recordings may use at most. Empty = no own limit."
  ],
  "ing.cfg.budget.default": [
    "Standard für alle Rechner",
    "Default for all machines"
  ],
  "ing.cfg.budget.hosts": [
    "Abweichungen je Rechner",
    "Per-machine overrides"
  ],
  "ing.cfg.budget.host": [
    "Rechner: {p0}",
    "Machine: {p0}"
  ],
  "ing.cfg.budget.add": [
    "Abweichung hinzufügen",
    "Add override"
  ],
  "ing.cfg.host.local": [
    "Dieser Rechner (lokal)",
    "This machine (local)"
  ],
  "ing.cfg.soft": [
    "Warnschwelle",
    "Warning threshold"
  ],
  "ing.cfg.soft.help": [
    "Ab diesem Anteil der Grenze erscheint eine Warnung.",
    "From this share of the limit a warning is shown."
  ],
  "ing.cfg.functions": [
    "Funktionen:",
    "Functions:"
  ],
  "ing.cfg.fn.recorder": [
    "Aufnehmen",
    "Record"
  ],
  "ing.cfg.fn.converter": [
    "Konvertieren",
    "Convert"
  ],
  "ing.cfg.profiles": [
    "Aufnahmeprofile",
    "Recording profiles"
  ],
  "ing.cfg.profiles.hint": [
    "Ein Profil legt Dateiformat, erwarteten Bedarf und eine optionale Nachbearbeitung fest.",
    "A profile sets file format, expected demand and an optional post-processing step."
  ],
  "ing.cfg.p.label": [
    "Bezeichnung",
    "Name"
  ],
  "ing.cfg.p.format": [
    "Dateiformat",
    "File format"
  ],
  "ing.cfg.p.format.help": [
    "MXF enthält H.264 und 24-Bit-PCM-Ton.",
    "MXF contains H.264 and 24-bit PCM audio."
  ],
  "ing.cfg.fmt.other": [
    "Andere Endung …",
    "Other extension …"
  ],
  "ing.cfg.p.demand": [
    "Erwarteter Bedarf je Aufnahme",
    "Expected demand per recording"
  ],
  "ing.cfg.p.auto": [
    "automatisch",
    "automatic"
  ],
  "ing.cfg.p.demand.help": [
    "Leere Felder: gemessene Werte früherer Aufnahmen, sonst vorsichtige Standardwerte.",
    "Empty fields: values measured from earlier recordings, otherwise cautious defaults."
  ],
  "ing.cfg.p.convert": [
    "Nach der Aufnahme konvertieren",
    "Convert after recording"
  ],
  "ing.cfg.c.ext": [
    "Endung der Ausgabe",
    "Output extension"
  ],
  "ing.cfg.c.args": [
    "ffmpeg-Argumente",
    "ffmpeg arguments"
  ],
  "ing.cfg.c.args.help": [
    "Zwischen Eingabe und Ausgabedatei; Leerzeichen trennen, Anführungszeichen gruppieren.",
    "Between input and output file; spaces separate, quotes group."
  ],
  "ing.cfg.p.add": [
    "Profil hinzufügen",
    "Add profile"
  ],
  "ing.cfg.p.new": [
    "Neues Profil",
    "New profile"
  ],
  "ing.cfg.p.remove.q": [
    "Profil „{p0}“ entfernen? Bestehende Zeitpläne mit diesem Profil werden danach abgelehnt.",
    "Remove profile “{p0}”? Existing schedules using it will be rejected afterwards."
  ],
  "ing.cfg.err.lead": [
    "Vorwärmzeit muss zwischen 0 und 3600 s liegen.",
    "Lead time must be between 0 and 3600 s."
  ],
  "ing.cfg.err.horizon": [
    "Planungshorizont muss zwischen 1 und 720 h liegen.",
    "Planning horizon must be between 1 and 720 h."
  ],
  "ing.cfg.err.noprofile": [
    "Mindestens ein Profil wird gebraucht.",
    "At least one profile is required."
  ],
  "ing.cfg.err.ext": [
    "Profil „{p0}“: Dateiendung ungültig (Punkt und 2–5 Zeichen, z. B. .mxf).",
    "Profile “{p0}”: invalid extension (dot plus 2–5 characters, e.g. .mxf)."
  ],
  "ing.cfg.err.convert": [
    "Profil „{p0}“: Nachbearbeitung braucht eine gültige Endung und Argumente.",
    "Profile “{p0}”: post-processing needs a valid extension and arguments."
  ],
  "ing.cfg.err.demand": [
    "Profil „{p0}“: Bedarf darf nicht negativ sein.",
    "Profile “{p0}”: demand must not be negative."
  ],
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
    "Einstellungen der Aufnahme: Formate (Profile), Grenzen je Rechner, Vorwärmzeit und Zulassungsregeln. Änderungen wirken auf neue Planungen; der Server prüft vor dem Speichern.",
    "Recording settings: formats (profiles), limits per machine, lead time and admission rules. Changes apply to new planning; the server validates before saving."
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
