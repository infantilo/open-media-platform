// Texte des Moduls „Eingang / Review“ (Kapitel 43) — gehören dem Modul, nicht dem Kern-Wörterbuch.
// Deutsch und Englisch stehen je Schlüssel nebeneinander in der Tabelle unten und werden daraus abgeleitet.
const TABLE: Record<string, [string, string]> = {
  "rv.f.tasks": [
    "Meine Aufgaben",
    "My tasks"
  ],
  "rv.col.assigned": [
    "Zugewiesen / Frist",
    "Assigned / due"
  ],
  "rv.group": [
    "Gruppe",
    "group"
  ],
  "rv.assignedTo": [
    "Zugewiesen: {p0}",
    "Assigned to: {p0}"
  ],
  "rv.due": [
    "Frist {p0}",
    "due {p0}"
  ],
  "rv.act.assign": [
    "Zuweisen …",
    "Assign …"
  ],
  "rv.assign.title": [
    "Prüfaufgabe zuweisen",
    "Assign review task"
  ],
  "rv.assign.hint": [
    "Wer die Datei prüfen soll. Eine Person, eine Gruppe oder beides; eine Gruppenaufgabe kann jedes Mitglied übernehmen. Alles leer hebt die Zuweisung auf.",
    "Who should check the file. A person, a group or both; any member can take a group task. Leaving everything empty removes the assignment."
  ],
  "rv.assign.user": [
    "Person",
    "Person"
  ],
  "rv.assign.nobody": [
    "— niemand —",
    "— nobody —"
  ],
  "rv.assign.group": [
    "Gruppe",
    "Group"
  ],
  "rv.assign.nogroup": [
    "— keine Gruppe —",
    "— no group —"
  ],
  "rv.assign.due": [
    "Frist",
    "Due"
  ],
  "rv.cfg.approval": [
    "Freigabe und Prüfung",
    "Approval and review"
  ],
  "rv.cfg.approval.hint": [
    "Wer eine Datei freigeben darf und wann sie geprüft werden darf.",
    "Who may approve a file and when it may be reviewed."
  ],
  "rv.cfg.mode": [
    "Freigabemodus",
    "Approval mode"
  ],
  "rv.cfg.mode.help": [
    "Gilt für neue Einreichungen.",
    "Applies to new submissions."
  ],
  "rv.cfg.mode.none": [
    "Keine Freigabe (Einreichen genügt)",
    "No approval (submitting is enough)"
  ],
  "rv.cfg.mode.single": [
    "Eine Freigabe",
    "Single approval"
  ],
  "rv.cfg.mode.dual": [
    "Zwei Personen (Vier-Augen-Prinzip)",
    "Two people (four-eyes)"
  ],
  "rv.cfg.selfapprove": [
    "Einreicher darf selbst freigeben",
    "Submitter may approve their own work"
  ],
  "rv.cfg.selfapprove.help": [
    "Nur relevant beim Vier-Augen-Prinzip.",
    "Only relevant with four-eyes approval."
  ],
  "rv.cfg.review.running": [
    "Prüfung schon während der QC erlauben",
    "Allow review while QC is still running"
  ],
  "rv.cfg.review.fail": [
    "Prüfung erlauben, wenn die QC nicht ausführbar war",
    "Allow review when QC could not run"
  ],
  "rv.cfg.review.fail.help": [
    "Die Datei gilt dann als ungeprüft, nicht als fehlerfrei.",
    "The file then counts as unchecked, not as free of defects."
  ],
  "rv.cfg.segments": [
    "Segmentregeln",
    "Segment rules"
  ],
  "rv.cfg.segments.hint": [
    "Regeln für die Schnittliste (Conform).",
    "Rules for the conform segment list."
  ],
  "rv.cfg.minseg": [
    "Kürzestes Segment",
    "Shortest segment"
  ],
  "rv.cfg.frames": [
    "Bilder",
    "frames"
  ],
  "rv.cfg.overlap": [
    "Überlappende Segmente erlauben",
    "Allow overlapping segments"
  ],
  "rv.cfg.gaps": [
    "Lücken zwischen Segmenten erlauben",
    "Allow gaps between segments"
  ],
  "rv.qp.title": [
    "QC-Profile",
    "QC profiles"
  ],
  "rv.qp.intro": [
    "Ein QC-Profil legt fest, wie streng die Eingangsprüfung ist: Schwellen für Schwarzbild, Standbild, Stille und Lautheit sowie die Erwartungen an die Datei (Format, Bildrate, Tonspuren …). Das Standardprofil gilt für jede neue Prüfung; für einzelne Dateien lässt sich ein anderes wählen. Ändern sich die Regeln eines Profils, steigt seine Version automatisch — jeder Befund trägt „Profil@Version“ und bleibt so einem Regelstand zuordenbar.",
    "A QC profile defines how strict the intake check is: thresholds for black, freeze, silence and loudness plus the expectations on the file (format, frame rate, audio tracks …). The default profile applies to every new check; another one can be chosen per file. When a profile's rules change its version rises automatically — every finding carries “profile@version” and stays traceable to a rule set."
  ],
  "rv.qp.new": [
    "Neues Profil",
    "New profile"
  ],
  "rv.qp.new.hint": [
    "Beginnt mit den Werten des mitgelieferten Rundfunkprofils (broadcast-default)",
    "Starts with the values of the shipped broadcast profile (broadcast-default)"
  ],
  "rv.qp.newname": [
    "Neues Profil",
    "New profile"
  ],
  "rv.qp.default": [
    "Standard",
    "Default"
  ],
  "rv.qp.edit": [
    "Bearbeiten",
    "Edit"
  ],
  "rv.qp.makedefault": [
    "Zum Standard machen",
    "Make default"
  ],
  "rv.qp.defaultset": [
    "„{p0}“ ist jetzt das Standardprofil",
    "“{p0}” is now the default profile"
  ],
  "rv.qp.del.default": [
    "Das Standardprofil lässt sich nicht löschen — zuerst ein anderes zum Standard machen",
    "The default profile cannot be deleted — make another one the default first"
  ],
  "rv.qp.tracks": [
    "Tonspuren",
    "audio tracks"
  ],
  "rv.qp.captions": [
    "Untertitel",
    "captions"
  ],
  "rv.qp.noexpect": [
    "keine Erwartungen an das Format",
    "no format expectations"
  ],
  "rv.qp.loud": [
    "Lautheit",
    "Loudness"
  ],
  "rv.qp.noloud": [
    "Lautheit nicht geprüft",
    "loudness not checked"
  ],
  "rv.qp.editor.new": [
    "Neues QC-Profil",
    "New QC profile"
  ],
  "rv.qp.editor.edit": [
    "QC-Profil „{p0}“ bearbeiten",
    "Edit QC profile “{p0}”"
  ],
  "rv.qp.id": [
    "Kennung",
    "ID"
  ],
  "rv.qp.id.new": [
    "Kleinbuchstaben, Ziffern, Bindestrich; folgt dem Namen, bis Sie sie ändern",
    "lowercase letters, digits, hyphen; follows the name until you change it"
  ],
  "rv.qp.id.fixed": [
    "lässt sich nicht ändern (steht in bestehenden Prüfberichten)",
    "cannot be changed (it appears in existing reports)"
  ],
  "rv.qp.versionnote": [
    "Ändern Sie Schwellen oder Erwartungen, erhöht der Server die Version selbst; bei reiner Umbenennung bleibt sie.",
    "If you change thresholds or expectations the server raises the version itself; a plain rename keeps it."
  ],
  "rv.qp.err.name": [
    "Bitte einen Namen eingeben.",
    "Please enter a name."
  ],
  "rv.qp.err.id": [
    "Die Kennung darf nur Kleinbuchstaben, Ziffern und Bindestrich enthalten (höchstens 40 Zeichen).",
    "The ID may only contain lowercase letters, digits and hyphens (at most 40 characters)."
  ],
  "rv.qp.err.idtaken": [
    "Es gibt schon ein Profil mit der Kennung „{p0}“.",
    "A profile with the ID “{p0}” already exists."
  ],
  "rv.qp.created": [
    "Profil „{p0}“ angelegt",
    "Profile “{p0}” created"
  ],
  "rv.qp.saved": [
    "Profil „{p0}“ gespeichert (Version {p1})",
    "Profile “{p0}” saved (version {p1})"
  ],
  "rv.cfg.qc.profiles.moved": [
    "Die QC-Profile selbst (Schwellen, Erwartungen, anlegen, kopieren, löschen) bearbeiten Sie unter Administration → Plattform → QC-Profile.",
    "The QC profiles themselves (thresholds, expectations, create, copy, delete) are edited under Administration → Platform → QC profiles."
  ],
  "rv.cfg.qc": [
    "Qualitätskontrolle (QC)",
    "Quality control (QC)"
  ],
  "rv.cfg.qc.hint": [
    "Automatische Prüfung jeder Datei mit festen, nachvollziehbaren Schwellen.",
    "Automatic check of every file against fixed, traceable thresholds."
  ],
  "rv.cfg.qc.default": [
    "Standardprofil",
    "Default profile"
  ],
  "rv.cfg.qc.workers": [
    "Gleichzeitige Prüfungen",
    "Simultaneous checks"
  ],
  "rv.cfg.qc.workers.help": [
    "1–4; jede belegt CPU.",
    "1–4; each uses CPU."
  ],
  "rv.cfg.qc.auto": [
    "Neue Dateien automatisch prüfen",
    "Check new files automatically"
  ],
  "rv.cfg.qc.auto.help": [
    "Sonst startet die QC nur auf Anforderung.",
    "Otherwise QC only starts on request."
  ],
  "rv.cfg.qc.profiles": [
    "QC-Profile",
    "QC profiles"
  ],
  "rv.cfg.p.name": [
    "Bezeichnung",
    "Name"
  ],
  "rv.cfg.p.version": [
    "Version",
    "Version"
  ],
  "rv.cfg.p.version.help": [
    "Erhöhen, wenn Schwellen geändert werden — Befunde nennen die Version.",
    "Increase when thresholds change — findings cite the version."
  ],
  "rv.cfg.p.timeout": [
    "Zeitlimit je Prüfung",
    "Time limit per check"
  ],
  "rv.cfg.p.dup": [
    "Duplizieren",
    "Duplicate"
  ],
  "rv.cfg.p.copy": [
    "Kopie",
    "copy"
  ],
  "rv.cfg.p.remove.q": [
    "QC-Profil „{p0}“ entfernen?",
    "Remove QC profile “{p0}”?"
  ],
  "rv.cfg.black": [
    "Schwarzbild",
    "Black frames"
  ],
  "rv.cfg.freeze": [
    "Standbild",
    "Frozen picture"
  ],
  "rv.cfg.silence": [
    "Stille",
    "Silence"
  ],
  "rv.cfg.t.mindur": [
    "Mindestdauer",
    "Minimum duration"
  ],
  "rv.cfg.t.warn": [
    "Warnung ab",
    "Warn above"
  ],
  "rv.cfg.t.fail": [
    "Fehler ab",
    "Fail above"
  ],
  "rv.cfg.t.head": [
    "Anfang ignorieren",
    "Ignore at start"
  ],
  "rv.cfg.t.tail": [
    "Ende ignorieren",
    "Ignore at end"
  ],
  "rv.cfg.t.pix": [
    "Schwarzpegel",
    "Black level"
  ],
  "rv.cfg.t.noise": [
    "Schwelle",
    "Threshold"
  ],
  "rv.cfg.loud": [
    "Lautheit prüfen (EBU R128)",
    "Check loudness (EBU R128)"
  ],
  "rv.cfg.loud.limits": [
    "Lautheit",
    "Loudness"
  ],
  "rv.cfg.t.target": [
    "Zielwert",
    "Target"
  ],
  "rv.cfg.t.warntol": [
    "Warnung ab Abweichung",
    "Warn at deviation"
  ],
  "rv.cfg.t.failtol": [
    "Fehler ab Abweichung",
    "Fail at deviation"
  ],
  "rv.cfg.t.truepeak": [
    "Höchster True Peak",
    "Maximum true peak"
  ],
  "rv.cfg.t.lra": [
    "Höchster Lautheitsumfang",
    "Maximum loudness range"
  ],
  "rv.cfg.t.clip": [
    "Übersteuerung ab",
    "Clipping from"
  ],
  "rv.cfg.t.clip.help": [
    "Sample-Spitze ab diesem Pegel = Verdacht.",
    "Sample peak from this level = suspected."
  ],
  "rv.cfg.t.startoff": [
    "Höchster Startversatz Bild/Ton",
    "Maximum A/V start offset"
  ],
  "rv.cfg.t.durmis": [
    "Höchste Längendifferenz Bild/Ton",
    "Maximum A/V length mismatch"
  ],
  "rv.cfg.t.maxaudio": [
    "Höchstzahl analysierter Tonspuren",
    "Maximum analyzed audio tracks"
  ],
  "rv.cfg.t.maxaudio.help": [
    "Begrenzt Analysezeit bei vielen Spuren.",
    "Limits analysis time with many tracks."
  ],
  "rv.cfg.expect": [
    "Erwartungen an die Datei",
    "Expectations for the file"
  ],
  "rv.cfg.expect.help": [
    "Leere Felder werden nicht geprüft.",
    "Empty fields are not checked."
  ],
  "rv.cfg.e.width": [
    "Breite",
    "Width"
  ],
  "rv.cfg.e.height": [
    "Höhe",
    "Height"
  ],
  "rv.cfg.e.rate": [
    "Bildrate",
    "Frame rate"
  ],
  "rv.cfg.e.order": [
    "Halbbilder",
    "Field order"
  ],
  "rv.cfg.e.order.none": [
    "nicht prüfen",
    "do not check"
  ],
  "rv.cfg.e.order.progressive": [
    "Vollbilder",
    "Progressive"
  ],
  "rv.cfg.e.order.tt": [
    "Interlaced, oberes Halbbild zuerst",
    "Interlaced, top field first"
  ],
  "rv.cfg.e.order.bb": [
    "Interlaced, unteres Halbbild zuerst",
    "Interlaced, bottom field first"
  ],
  "rv.cfg.e.order.any": [
    "Beliebig interlaced",
    "Any interlaced"
  ],
  "rv.cfg.e.codecs": [
    "Erlaubte Videocodecs",
    "Allowed video codecs"
  ],
  "rv.cfg.e.codecs.help": [
    "Kommagetrennt, z. B. mpeg2video, h264.",
    "Comma separated, e.g. mpeg2video, h264."
  ],
  "rv.cfg.e.container": [
    "Container enthält",
    "Container contains"
  ],
  "rv.cfg.e.container.help": [
    "Teil des Formatnamens, z. B. mxf.",
    "Part of the format name, e.g. mxf."
  ],
  "rv.cfg.e.tracks": [
    "Mindestzahl Tonspuren",
    "Minimum audio tracks"
  ],
  "rv.cfg.e.rate.audio": [
    "Abtastrate",
    "Sample rate"
  ],
  "rv.cfg.e.bits": [
    "Mindest-Bittiefe",
    "Minimum bit depth"
  ],
  "rv.cfg.e.captions": [
    "Untertitel-/Datenstrom erwartet",
    "Caption/data stream expected"
  ],
  "rv.cfg.proxy": [
    "Prüfkopie (Proxy)",
    "Review proxy"
  ],
  "rv.cfg.proxy.hint": [
    "Kleine Kopie für den Player; die Originaldatei bleibt unverändert.",
    "Small copy for the player; the original file stays unchanged."
  ],
  "rv.cfg.proxy.height": [
    "Bildhöhe",
    "Picture height"
  ],
  "rv.cfg.proxy.crf": [
    "Qualität (CRF)",
    "Quality (CRF)"
  ],
  "rv.cfg.proxy.crf.help": [
    "Kleiner = besser und größer; 10–40.",
    "Lower = better and larger; 10–40."
  ],
  "rv.cfg.proxy.audio": [
    "Höchstzahl Tonspuren",
    "Maximum audio tracks"
  ],
  "rv.cfg.meta": [
    "Metadatenformular",
    "Metadata form"
  ],
  "rv.cfg.meta.hint": [
    "Felder, die bei der Prüfung ausgefüllt werden. Die Reihenfolge entspricht dem Formular.",
    "Fields filled in during review. The order matches the form."
  ],
  "rv.cfg.f.label": [
    "Bezeichnung",
    "Label"
  ],
  "rv.cfg.f.type": [
    "Feldtyp",
    "Field type"
  ],
  "rv.cfg.f.max": [
    "Höchstlänge / -anzahl",
    "Maximum length / count"
  ],
  "rv.cfg.f.max.help": [
    "Zeichen bzw. Anzahl Schlagworte.",
    "Characters or number of tags."
  ],
  "rv.cfg.f.values": [
    "Erlaubte Werte",
    "Allowed values"
  ],
  "rv.cfg.f.values.help": [
    "Kommagetrennt.",
    "Comma separated."
  ],
  "rv.cfg.f.required": [
    "Pflichtfeld",
    "Required"
  ],
  "rv.cfg.f.segment": [
    "Gilt je Segment statt je Datei",
    "Applies per segment instead of per file"
  ],
  "rv.cfg.f.add": [
    "Feld hinzufügen",
    "Add field"
  ],
  "rv.cfg.f.new": [
    "Neues Feld",
    "New field"
  ],
  "rv.cfg.f.remove.q": [
    "Feld „{p0}“ entfernen?",
    "Remove field “{p0}”?"
  ],
  "rv.cfg.ft.text": [
    "Text",
    "Text"
  ],
  "rv.cfg.ft.longtext": [
    "Langer Text",
    "Long text"
  ],
  "rv.cfg.ft.select": [
    "Auswahl",
    "Single choice"
  ],
  "rv.cfg.ft.multiselect": [
    "Mehrfachauswahl",
    "Multiple choice"
  ],
  "rv.cfg.ft.tags": [
    "Schlagworte",
    "Tags"
  ],
  "rv.cfg.ft.date": [
    "Datum",
    "Date"
  ],
  "rv.cfg.ft.number": [
    "Zahl",
    "Number"
  ],
  "rv.cfg.import": [
    "Import",
    "Import"
  ],
  "rv.cfg.import.hint": [
    "Dateien aus einem Ordner direkt in den Eingang übernehmen.",
    "Take files from a folder directly into intake."
  ],
  "rv.cfg.import.dir": [
    "Importordner",
    "Import folder"
  ],
  "rv.cfg.import.dir.help": [
    "Leer = Import abgeschaltet.",
    "Empty = import disabled."
  ],
  "rv.cfg.remove": [
    "Entfernen",
    "Remove"
  ],
  "rv.cfg.err.mode": [
    "Freigabemodus ungültig.",
    "Invalid approval mode."
  ],
  "rv.cfg.err.noprofile": [
    "Mindestens ein QC-Profil wird gebraucht.",
    "At least one QC profile is required."
  ],
  "rv.cfg.err.default": [
    "Das Standardprofil existiert nicht.",
    "The default profile does not exist."
  ],
  "rv.cfg.err.rate": [
    "QC-Profil „{p0}“: Bildrate muss wie 25/1 oder 25 aussehen.",
    "QC profile “{p0}”: frame rate must look like 25/1 or 25."
  ],
  "rv.cfg.err.fieldid": [
    "Metadatenfeld „{p0}“ hat keine eindeutige Kennung.",
    "Metadata field “{p0}” has no unique id."
  ],
  "rv.cfg.err.values": [
    "Metadatenfeld „{p0}“: Auswahlfeld braucht erlaubte Werte.",
    "Metadata field “{p0}”: choice field needs allowed values."
  ],
  "rv.title": [
    "File Eingangskontrolle",
    "File intake control"
  ],
  "rv.search": [
    "Suchen (Datei, Titel, ID) …",
    "Search (file, title, ID) …"
  ],
  "rv.refresh": [
    "Aktualisieren",
    "Refresh"
  ],
  "rv.empty": [
    "Keine Einträge in dieser Ansicht.",
    "No items in this view."
  ],
  "rv.open": [
    "Öffnen",
    "Open"
  ],
  "rv.back": [
    "Liste",
    "List"
  ],
  "rv.cancel": [
    "Abbrechen",
    "Cancel"
  ],
  "rv.save": [
    "Speichern",
    "Save"
  ],
  "rv.saved": [
    "Gespeichert.",
    "Saved."
  ],
  "rv.discard": [
    "Verwerfen",
    "Discard"
  ],
  "rv.frames": [
    "Bilder",
    "frames"
  ],
  "rv.settings": [
    "Einstellungen",
    "Settings"
  ],
  "rv.settings.hint": [
    "Einstellungen des Eingangs: Freigabe, Segmentregeln, QC-Profile mit Schwellen, Prüfkopie, Metadatenformular und Importordner. Änderungen gelten für neue Prüfungen; der Server prüft vor dem Speichern.",
    "Intake settings: approval, segment rules, QC profiles with thresholds, review proxy, metadata form and import folder. Changes apply to new checks; the server validates before saving."
  ],
  "rv.f.todo": [
    "Zu prüfen (frei)",
    "To review (unassigned)"
  ],
  "rv.f.all": [
    "Alle",
    "All"
  ],
  "rv.f.mine": [
    "Meine",
    "Mine"
  ],
  "rv.f.qc": [
    "QC wartet / läuft / fehlgeschlagen",
    "QC pending / running / failed"
  ],
  "rv.f.busy": [
    "In Bearbeitung",
    "In progress"
  ],
  "rv.f.approval": [
    "Zur Freigabe",
    "Awaiting approval"
  ],
  "rv.f.done": [
    "Freigegeben",
    "Approved"
  ],
  "rv.f.archived": [
    "Archiviert",
    "Archived"
  ],
  "rv.col.file": [
    "Datei",
    "File"
  ],
  "rv.col.state": [
    "Zustand",
    "State"
  ],
  "rv.col.qc": [
    "QC",
    "QC"
  ],
  "rv.col.assignee": [
    "Bearbeiter",
    "Assignee"
  ],
  "rv.col.duration": [
    "Dauer",
    "Duration"
  ],
  "rv.col.format": [
    "Format",
    "Format"
  ],
  "rv.col.size": [
    "Größe",
    "Size"
  ],
  "rv.col.received": [
    "Eingang",
    "Received"
  ],
  "rv.state.awaiting_qc": [
    "Wartet auf QC",
    "Awaiting QC"
  ],
  "rv.state.qc_running": [
    "QC läuft",
    "QC running"
  ],
  "rv.state.qc_failed_to_run": [
    "QC nicht ausführbar",
    "QC could not run"
  ],
  "rv.state.awaiting_review": [
    "Wartet auf Prüfung",
    "Awaiting review"
  ],
  "rv.state.in_review": [
    "In Prüfung",
    "In review"
  ],
  "rv.state.conforming": [
    "Conform in Arbeit",
    "Conforming"
  ],
  "rv.state.ready_for_approval": [
    "Zur Freigabe",
    "Ready for approval"
  ],
  "rv.state.approved": [
    "Freigegeben",
    "Approved"
  ],
  "rv.state.rejected": [
    "Abgelehnt / Nacharbeit",
    "Rejected / rework"
  ],
  "rv.state.archived": [
    "Archiviert",
    "Archived"
  ],
  "rv.assignee": [
    "Bearbeiter: {p0}",
    "Assignee: {p0}"
  ],
  "rv.unassigned": [
    "nicht übernommen",
    "unassigned"
  ],
  "rv.act.claim": [
    "Übernehmen",
    "Claim"
  ],
  "rv.act.release": [
    "Zurückgeben",
    "Release"
  ],
  "rv.act.save": [
    "Entwurf speichern",
    "Save draft"
  ],
  "rv.act.submit": [
    "Einreichen",
    "Submit"
  ],
  "rv.act.approve": [
    "Freigeben",
    "Approve"
  ],
  "rv.act.reject": [
    "Ablehnen",
    "Reject"
  ],
  "rv.act.withdraw": [
    "Zurückziehen",
    "Withdraw"
  ],
  "rv.act.revise": [
    "Neue Revision",
    "New revision"
  ],
  "rv.act.archive": [
    "Archivieren",
    "Archive"
  ],
  "rv.act.unarchive": [
    "Aus Archiv holen",
    "Unarchive"
  ],
  "rv.act.reassign": [
    "Neu zuweisen …",
    "Reassign …"
  ],
  "rv.act.forcerelease": [
    "Zwangsfreigabe",
    "Force release"
  ],
  "rv.claimed": [
    "Übernommen.",
    "Claimed."
  ],
  "rv.released": [
    "Zurückgegeben.",
    "Released."
  ],
  "rv.submitted": [
    "Eingereicht.",
    "Submitted."
  ],
  "rv.approved": [
    "Freigegeben.",
    "Approved."
  ],
  "rv.rejected": [
    "Abgelehnt.",
    "Rejected."
  ],
  "rv.reject.title": [
    "Ablehnen",
    "Reject"
  ],
  "rv.reject.reason": [
    "Begründung (Pflicht)",
    "Reason (required)"
  ],
  "rv.reassign.title": [
    "Neu zuweisen",
    "Reassign"
  ],
  "rv.reassign.to": [
    "Benutzername der neuen Bearbeiterin / des neuen Bearbeiters",
    "Username of the new assignee"
  ],
  "rv.err.generic": [
    "Aktion fehlgeschlagen.",
    "Action failed."
  ],
  "rv.err.claimed": [
    "Das Asset wurde inzwischen von jemand anderem übernommen.",
    "Someone else has claimed this asset in the meantime."
  ],
  "rv.unsaved": [
    "Es gibt ungespeicherte Änderungen. Wirklich verwerfen?",
    "There are unsaved changes. Discard them?"
  ],
  "rv.unsaved.release": [
    "Ungespeicherte Änderungen gehen beim Zurückgeben verloren. Fortfahren?",
    "Unsaved changes are lost when releasing. Continue?"
  ],
  "rv.conflict.remote": [
    "Der Stand wurde von jemand anderem geändert. Beim Speichern wirst du gefragt, wie es weitergeht.",
    "Someone else changed this item. You will be asked how to proceed when saving."
  ],
  "rv.conflict.revision": [
    "Konflikt: Der Stand wurde zwischenzeitlich geändert.",
    "Conflict: the item was changed in the meantime."
  ],
  "rv.conflict.source": [
    "Die Quelldatei hat sich seit dem Entwurf geändert (neue Analyse läuft).",
    "The source file changed since the draft was made (a new analysis is queued)."
  ],
  "rv.conflict.reload": [
    "Aktuellen Stand laden (meine Änderungen verwerfen)",
    "Load current state (discard my changes)"
  ],
  "rv.conflict.keep": [
    "Meine Änderungen trotzdem speichern (überschreibt)",
    "Save my changes anyway (overwrites)"
  ],
  "rv.conflict.keep.source": [
    "Trotz geänderter Quelle speichern",
    "Save despite changed source"
  ],
  "rv.tab.qc": [
    "QC-Bericht",
    "QC report"
  ],
  "rv.tab.review": [
    "Review & Conform",
    "Review & conform"
  ],
  "rv.tab.compare": [
    "Aufnahme-Vergleich",
    "Recording comparison"
  ],
  "rv.cmp.hint": [
    "Vergleicht die Aufnahme eines Events (zweiter Eintrag im Eingang) mit diesem Original: Dauer, Bildrate, Auflösung, Codec, Ton und Bildqualität (SSIM auf einer Stichprobe).",
    "Compares the recording of an event (second intake entry) with this original: duration, frame rate, resolution, codec, audio and picture quality (SSIM on a sample)."
  ],
  "rv.cmp.choose": [
    "— Aufnahme wählen —",
    "— choose recording —"
  ],
  "rv.cmp.recorded": [
    "Aufnahme",
    "Recording"
  ],
  "rv.cmp.offset": [
    "Vorlauf der Aufnahme (s)",
    "Recording lead-in (s)"
  ],
  "rv.cmp.offsetHint": [
    "Beginn des Originals innerhalb der Aufnahme",
    "where the original starts inside the recording"
  ],
  "rv.cmp.tol": [
    "Dauer-Toleranz (ms)",
    "Duration tolerance (ms)"
  ],
  "rv.cmp.tolHint": [
    "leer = ein Bild",
    "empty = one frame"
  ],
  "rv.cmp.ssim": [
    "Mindest-SSIM",
    "Minimum SSIM"
  ],
  "rv.cmp.sample": [
    "Stichprobe (s)",
    "Sample (s)"
  ],
  "rv.cmp.skip": [
    "Bildqualität nicht messen",
    "Skip picture quality"
  ],
  "rv.cmp.run": [
    "Vergleichen",
    "Compare"
  ],
  "rv.cmp.running": [
    "Vergleich läuft …",
    "Comparing …"
  ],
  "rv.cmp.needRecorded": [
    "Bitte zuerst die Aufnahme wählen.",
    "Please choose the recording first."
  ],
  "rv.cmp.overall.pass": [
    "✓ Aufnahme entspricht dem Original",
    "✓ Recording matches the original"
  ],
  "rv.cmp.overall.warning": [
    "⚠ Aufnahme weicht in Hinweisen ab",
    "⚠ Recording differs in notes"
  ],
  "rv.cmp.overall.fail": [
    "✗ Aufnahme weicht vom Original ab",
    "✗ Recording differs from the original"
  ],
  "rv.cmp.auto": [
    "Vorlauf automatisch bestimmen",
    "Detect lead-in automatically"
  ],
  "rv.cmp.autoHint": [
    "aus den Bildern; bei nicht eindeutigem Bild gilt der Wert unten",
    "from the pictures; if ambiguous the value below applies"
  ],
  "rv.cmp.usedAuto": [
    "Verwendeter Vorlauf: {p0} s (aus den Bildern bestimmt)",
    "Lead-in used: {p0} s (detected from the pictures)"
  ],
  "rv.cmp.usedManual": [
    "Verwendeter Vorlauf: {p0} s (vorgegeben)",
    "Lead-in used: {p0} s (given)"
  ],
  "rv.tab.history": [
    "Verlauf",
    "History"
  ],
  "rv.notimeline": [
    "Die Zeitachse der Datei ist noch unbekannt (Analyse läuft oder Datei nicht lesbar).",
    "The file's timeline is not known yet (analysis pending or file unreadable)."
  ],
  "rv.readonly.other": [
    "Nur Ansicht — in Bearbeitung durch {p0}.",
    "Read-only — being edited by {p0}."
  ],
  "rv.readonly.claim": [
    "Nur Ansicht — zum Bearbeiten das Asset übernehmen.",
    "Read-only — claim the asset to edit."
  ],
  "rv.proxy.building": [
    "Review-Proxy wird erzeugt … (die Originaldatei bleibt unverändert)",
    "Review proxy is being created … (the original file stays untouched)"
  ],
  "rv.proxy.waiting": [
    "Wartet auf einen freien Platz in der Warteschlange …",
    "Waiting for a free slot in the queue …"
  ],
  "rv.proxy.progress": [
    "{p0} % erzeugt",
    "{p0} % created"
  ],
  "rv.proxy.failed": [
    "Review-Proxy konnte nicht erzeugt werden",
    "Review proxy could not be created"
  ],
  "rv.proxy.retry": [
    "Erneut versuchen",
    "Retry"
  ],
  "rv.player.proxy": [
    "PROXY",
    "PROXY"
  ],
  "rv.player.proxy.hint": [
    "Review-Proxy ({p0}) — nicht die Originaldatei. Bild n des Proxys entspricht Bild n der Quelle.",
    "Review proxy ({p0}) — not the original file. Proxy frame n equals source frame n."
  ],
  "rv.player.frameinfo": [
    "Bild {p0} / {p1} · {p2} fps",
    "Frame {p0} / {p1} · {p2} fps"
  ],
  "rv.player.start": [
    "Zum Anfang (Pos1)",
    "To start (Home)"
  ],
  "rv.player.end": [
    "Zum Ende (Ende)",
    "To end (End)"
  ],
  "rv.player.back1": [
    "Ein Bild zurück (←)",
    "One frame back (←)"
  ],
  "rv.player.fwd1": [
    "Ein Bild vor (→)",
    "One frame forward (→)"
  ],
  "rv.player.play": [
    "Wiedergabe / Pause (Leertaste)",
    "Play / pause (Space)"
  ],
  "rv.player.stop": [
    "Stopp: anhalten und zum Startpunkt der Wiedergabe zurück",
    "Stop: pause and return to where playback started"
  ],
  "rv.player.goto": [
    "Zum Timecode springen",
    "Go to timecode"
  ],
  "rv.player.goto.hint": [
    "Timecode HH:MM:SS:FF eingeben, Enter (Taste G)",
    "Enter timecode HH:MM:SS:FF, Enter (key G)"
  ],
  "rv.player.badtc": [
    "Ungültiger Timecode oder außerhalb der Datei",
    "Invalid timecode or outside the file"
  ],
  "rv.player.jog": [
    "Jog",
    "Jog"
  ],
  "rv.player.jog.hint": [
    "Jog: Ziehen = Einzelbilder (ca. 7 px je Bild). Mausrad über dem Bild: ±1 Bild (Umschalt ±10).",
    "Jog: drag for single frames (about 7 px per frame). Mouse wheel over the picture: ±1 frame (Shift ±10)."
  ],
  "rv.audio": [
    "Ton",
    "Audio"
  ],
  "rv.audio.track.hint": [
    "Tonspur {p0} hören/stumm (Taste {p0})",
    "Listen to / mute audio track {p0} (key {p0})"
  ],
  "rv.audio.solo.hint": [
    "Tonspur {p0} solo (Umschalt+{p0})",
    "Solo audio track {p0} (Shift+{p0})"
  ],
  "rv.audio.volume": [
    "Lautstärke",
    "Volume"
  ],
  "rv.audio.hint": [
    "Ton folgt Jog, Einzelbild und Shuttle (−4× … +4×); bei höherem Tempo stumm.",
    "Audio follows jog, single frame and shuttle (−4× … +4×); muted at higher speeds."
  ],
  "rv.player.shuttle": [
    "Shuttle",
    "Shuttle"
  ],
  "rv.player.shuttle.hint": [
    "Shuttle: Geschwindigkeit −8× … +8× (loslassen = Stopp). Tasten J/K/L. Rückwärts über Einzelbild-Seeks: nicht jedes Bild wird angezeigt.",
    "Shuttle: speed −8× … +8× (release = stop). Keys J/K/L. Reverse uses single-frame seeks: not every frame is shown."
  ],
  "rv.player.markin": [
    "In-Marke setzen (I)",
    "Set mark in (I)"
  ],
  "rv.player.markout": [
    "Out-Marke setzen (O) — Out ist exklusiv: das aktuelle Bild ist das letzte enthaltene",
    "Set mark out (O) — out is exclusive: the current frame is the last one included"
  ],
  "rv.player.gotoin": [
    "Zur In-Marke (Alt+I)",
    "Go to mark in (Alt+I)"
  ],
  "rv.player.gotoout": [
    "Zum letzten Bild vor Out (Alt+O)",
    "Go to last frame before out (Alt+O)"
  ],
  "rv.player.clearmarks": [
    "Marken löschen",
    "Clear marks"
  ],
  "rv.player.addsegment": [
    "Segment",
    "Segment"
  ],
  "rv.player.addsegment.hint": [
    "Segment aus In/Out-Marken anlegen (N)",
    "Create a segment from the in/out marks (N)"
  ],
  "rv.player.previewrange": [
    "Vorschau",
    "Preview"
  ],
  "rv.player.previewrange.hint": [
    "Bereich abspielen",
    "Play the range"
  ],
  "rv.player.needmarks": [
    "Bitte erst In und Out markieren.",
    "Please set in and out marks first."
  ],
  "rv.player.error": [
    "Der Proxy konnte nicht abgespielt werden.",
    "The proxy could not be played."
  ],
  "rv.zoom": [
    "Zoom",
    "Zoom"
  ],
  "rv.zoom.in": [
    "Hineinzoomen (um den Spielkopf) — oder Mausrad auf der Zeitleiste",
    "Zoom in (around the playhead) — or mouse wheel on the timeline"
  ],
  "rv.zoom.out": [
    "Herauszoomen",
    "Zoom out"
  ],
  "rv.zoom.fit": [
    "Ganze Länge zeigen",
    "Show the whole length"
  ],
  "rv.zoom.marks": [
    "Auf die Marken I–O zoomen (ohne Marken: um den Spielkopf)",
    "Zoom to the I–O marks (without marks: around the playhead)"
  ],
  "rv.zoom.overview": [
    "Übersicht: ziehen verschiebt den gezeigten Ausschnitt (Umschalt + Mausrad auf der Zeitleiste verschiebt ebenfalls)",
    "Overview: drag to move the visible section (Shift + mouse wheel on the timeline also pans)"
  ],
  "rv.player.keys": [
    "Tasten: ←/→ ±1 Bild (Umschalt ±10, Strg ±1 s) · Leertaste Wiedergabe · J/K/L Shuttle · I/O Marken (Alt: hinspringen) · [ ] Segmentgrenzen · G Timecode · N Segment · Mausrad auf der Zeitleiste: Zoom (Umschalt: verschieben)",
    "Keys: ←/→ ±1 frame (Shift ±10, Ctrl ±1 s) · Space play · J/K/L shuttle · I/O marks (Alt: jump) · [ ] segment boundaries · G timecode · N segment · mouse wheel on the timeline: zoom (Shift: pan)"
  ],
  "rv.in.hint": [
    "In (inklusiv): erstes enthaltenes Bild",
    "In (inclusive): first included frame"
  ],
  "rv.out.hint": [
    "Out (exklusiv): erstes Bild NACH dem Segment",
    "Out (exclusive): first frame AFTER the segment"
  ],
  "rv.out.excl": [
    "Out (exkl.)",
    "Out (excl.)"
  ],
  "rv.usable.title": [
    "Nutzbarer Bereich",
    "Usable range"
  ],
  "rv.usable.whole": [
    "ganze Datei",
    "whole file"
  ],
  "rv.usable.clear": [
    "Bereich aufheben",
    "Remove range"
  ],
  "rv.usable.frommarks": [
    "aus Marken",
    "from marks"
  ],
  "rv.usable.frommarks.hint": [
    "In/Out-Marken des Players übernehmen",
    "Take the player's in/out marks"
  ],
  "rv.seg.title": [
    "Segmente ({p0})",
    "Segments ({p0})"
  ],
  "rv.seg.add": [
    "Segment",
    "Segment"
  ],
  "rv.seg.add.hint": [
    "Neues Segment aus den Marken (sonst ab aktuellem Bild)",
    "New segment from the marks (otherwise from the current frame)"
  ],
  "rv.seg.none": [
    "Noch keine Segmente. Im Player In/Out markieren und „＋ Segment“ wählen.",
    "No segments yet. Mark in/out in the player and choose “＋ Segment”."
  ],
  "rv.seg.n": [
    "Segment {p0}",
    "Segment {p0}"
  ],
  "rv.seg.count": [
    "Segmente",
    "segments"
  ],
  "rv.seg.desc": [
    "Beschreibung des Segments",
    "Segment description"
  ],
  "rv.seg.setin": [
    "In = aktuelles Bild",
    "In = current frame"
  ],
  "rv.seg.setout": [
    "Out = aktuelles Bild + 1 (aktuelles Bild bleibt enthalten)",
    "Out = current frame + 1 (current frame stays included)"
  ],
  "rv.seg.up": [
    "Nach oben",
    "Move up"
  ],
  "rv.seg.down": [
    "Nach unten",
    "Move down"
  ],
  "rv.seg.delete": [
    "Segment löschen",
    "Delete segment"
  ],
  "rv.seg.err.notimeline": [
    "Zeitachse unbekannt",
    "Timeline unknown"
  ],
  "rv.seg.err.range.int": [
    "In/Out müssen ganze Bildnummern sein",
    "In/out must be whole frame numbers"
  ],
  "rv.seg.err.range.before": [
    "In liegt vor dem Dateianfang",
    "In is before the start of the file"
  ],
  "rv.seg.err.range.after": [
    "Out liegt hinter dem Dateiende",
    "Out is past the end of the file"
  ],
  "rv.seg.err.range.short": [
    "Bereich ist kürzer als {min} Bild(er)",
    "Range is shorter than {min} frame(s)"
  ],
  "rv.seg.err.usable.range.int": [
    "Nutzbarer Bereich: ganze Bildnummern erforderlich",
    "Usable range: whole frame numbers required"
  ],
  "rv.seg.err.usable.range.before": [
    "Nutzbarer Bereich beginnt vor der Datei",
    "Usable range starts before the file"
  ],
  "rv.seg.err.usable.range.after": [
    "Nutzbarer Bereich endet nach der Datei",
    "Usable range ends after the file"
  ],
  "rv.seg.err.usable.range.short": [
    "Nutzbarer Bereich ist zu kurz",
    "Usable range is too short"
  ],
  "rv.seg.err.outside": [
    "liegt außerhalb des nutzbaren Bereichs",
    "lies outside the usable range"
  ],
  "rv.seg.err.overlap": [
    "überlappt Segment {a} (Überlappung ist nicht erlaubt)",
    "overlaps segment {a} (overlap is not allowed)"
  ],
  "rv.seg.err.gap": [
    "Lücke zu Segment {a} (Lücken sind nicht erlaubt)",
    "gap to segment {a} (gaps are not allowed)"
  ],
  "rv.meta.title": [
    "Metadaten",
    "Metadata"
  ],
  "rv.meta.hint": [
    "Redaktionelle Metadaten des Assets. Sie gelten als Entwurf und werden mit der Freigabe ins Asset übernommen.",
    "Editorial metadata of the asset. They are a draft until approval, then written to the asset."
  ],
  "rv.meta.tags.hint": [
    "durch Komma trennen",
    "separate with commas"
  ],
  "rv.qc.overall.pass": [
    "Bestanden",
    "Passed"
  ],
  "rv.qc.overall.warning": [
    "Warnungen",
    "Warnings"
  ],
  "rv.qc.overall.fail": [
    "Fehler",
    "Failed"
  ],
  "rv.qc.overall.incomplete": [
    "Unvollständig",
    "Incomplete"
  ],
  "rv.qc.status.pass": [
    "Bestanden",
    "Pass"
  ],
  "rv.qc.status.warning": [
    "Warnung",
    "Warning"
  ],
  "rv.qc.status.fail": [
    "Fehler",
    "Fail"
  ],
  "rv.qc.status.not_evaluated": [
    "Nicht ausgewertet",
    "Not evaluated"
  ],
  "rv.qc.sev.critical": [
    "kritisch",
    "critical"
  ],
  "rv.qc.sev.major": [
    "schwer",
    "major"
  ],
  "rv.qc.sev.minor": [
    "leicht",
    "minor"
  ],
  "rv.qc.sev.info": [
    "Info",
    "info"
  ],
  "rv.qc.cat.container": [
    "Container",
    "Container"
  ],
  "rv.qc.cat.video": [
    "Video",
    "Video"
  ],
  "rv.qc.cat.audio": [
    "Audio",
    "Audio"
  ],
  "rv.qc.cat.sync": [
    "A/V-Sync",
    "A/V sync"
  ],
  "rv.qc.cat.content": [
    "Inhalt",
    "Content"
  ],
  "rv.qc.cat.delivery": [
    "Anlieferprofil",
    "Delivery profile"
  ],
  "rv.qc.counts": [
    "{p0} Fehler · {p1} Warnungen · {p2} bestanden · {p3} nicht ausgewertet",
    "{p0} failed · {p1} warnings · {p2} passed · {p3} not evaluated"
  ],
  "rv.qc.noreport": [
    "Noch kein QC-Bericht.",
    "No QC report yet."
  ],
  "rv.qc.queued": [
    "QC wartet auf einen freien Arbeiter …",
    "QC is waiting for a free worker …"
  ],
  "rv.qc.running": [
    "QC läuft: {p0} ({p1} %)",
    "QC running: {p0} ({p1} %)"
  ],
  "rv.qc.execfailed": [
    "QC konnte nicht ausgeführt werden",
    "QC could not be executed"
  ],
  "rv.qc.execfailed.hint": [
    "Das ist eine Aussage über die Analyse, nicht über die Datei: es liegt kein Prüfergebnis vor. Nach Behebung der Ursache „QC wiederholen“.",
    "This is about the analysis, not the file: there is no verdict. Fix the cause, then “Re-run QC”."
  ],
  "rv.qc.stale": [
    "Dieser Bericht gehört zu einer früheren Version der Quelldatei.",
    "This report belongs to an earlier version of the source file."
  ],
  "rv.qc.incomplete.hint": [
    "Die Analyse ist unvollständig: mindestens eine Prüfung konnte nicht ausgewertet werden (siehe „nicht ausgewertet“).",
    "The analysis is incomplete: at least one check could not be evaluated (see “not evaluated”)."
  ],
  "rv.qc.history": [
    "Berichte",
    "Reports"
  ],
  "rv.qc.profile": [
    "QC-Profil",
    "QC profile"
  ],
  "rv.qc.rerun": [
    "QC wiederholen",
    "Re-run QC"
  ],
  "rv.qc.requested": [
    "QC eingeplant.",
    "QC queued."
  ],
  "rv.qc.export.json": [
    "Export JSON",
    "Export JSON"
  ],
  "rv.qc.export.csv": [
    "Export CSV",
    "Export CSV"
  ],
  "rv.qc.f.category": [
    "Kategorie",
    "Category"
  ],
  "rv.qc.f.status": [
    "Ergebnis",
    "Result"
  ],
  "rv.qc.f.severity": [
    "Schwere",
    "Severity"
  ],
  "rv.qc.f.search": [
    "Befunde durchsuchen …",
    "Search findings …"
  ],
  "rv.qc.f.issues": [
    "nur Probleme",
    "issues only"
  ],
  "rv.qc.shown": [
    "{p0} von {p1} Befunden",
    "{p0} of {p1} findings"
  ],
  "rv.qc.goto": [
    "Im Player zu dieser Stelle springen",
    "Jump to this position in the player"
  ],
  "rv.qc.measured": [
    "Gemessen",
    "Measured"
  ],
  "rv.qc.threshold": [
    "Grenzwert",
    "Threshold"
  ],
  "rv.qc.tool": [
    "Werkzeug",
    "Tool"
  ],
  "rv.qc.severity": [
    "Schwere",
    "Severity"
  ],
  "rv.qc.ruleset": [
    "Regelsatz",
    "Ruleset"
  ],
  "rv.qc.at": [
    "Analysiert",
    "Analyzed"
  ],
  "rv.qc.range": [
    "Bereich",
    "Range"
  ],
  "rv.qc.streams": [
    "Technische Stream-Metadaten",
    "Technical stream metadata"
  ],
  "rv.hist.title": [
    "Verlauf",
    "History"
  ],
  "rv.hist.revisions": [
    "Conform-Revisionen",
    "Conform revisions"
  ],
  "rv.conform.draft": [
    "Entwurf",
    "draft"
  ],
  "rv.conform.submitted": [
    "eingereicht",
    "submitted"
  ],
  "rv.conform.approved": [
    "freigegeben",
    "approved"
  ],
  "rv.conform.rejected": [
    "abgelehnt",
    "rejected"
  ],
  "rv.conform.withdrawn": [
    "zurückgezogen",
    "withdrawn"
  ],
  "rv.hist.a.registered": [
    "Registriert",
    "Registered"
  ],
  "rv.hist.a.qc_requested": [
    "QC angefordert",
    "QC requested"
  ],
  "rv.hist.a.qc_started": [
    "QC gestartet",
    "QC started"
  ],
  "rv.hist.a.qc_done": [
    "QC abgeschlossen",
    "QC finished"
  ],
  "rv.hist.a.qc_execution_failed": [
    "QC nicht ausführbar",
    "QC could not run"
  ],
  "rv.hist.a.source_changed": [
    "Quelldatei geändert",
    "Source file changed"
  ],
  "rv.hist.a.claimed": [
    "Übernommen",
    "Claimed"
  ],
  "rv.hist.a.released": [
    "Zurückgegeben",
    "Released"
  ],
  "rv.hist.a.reassigned": [
    "Neu zugewiesen",
    "Reassigned"
  ],
  "rv.hist.a.conform_saved": [
    "Entwurf gespeichert",
    "Draft saved"
  ],
  "rv.hist.a.submitted": [
    "Eingereicht",
    "Submitted"
  ],
  "rv.hist.a.submitted_auto_approved": [
    "Eingereicht (ohne Freigabestufe)",
    "Submitted (no approval step)"
  ],
  "rv.hist.a.approved": [
    "Freigegeben",
    "Approved"
  ],
  "rv.hist.a.rejected": [
    "Abgelehnt",
    "Rejected"
  ],
  "rv.hist.a.withdrawn": [
    "Zurückgezogen",
    "Withdrawn"
  ],
  "rv.hist.a.revision_started": [
    "Neue Revision begonnen",
    "New revision started"
  ],
  "rv.hist.a.archived": [
    "Archiviert",
    "Archived"
  ],
  "rv.hist.a.unarchived": [
    "Aus Archiv geholt",
    "Unarchived"
  ],
  "rv.import": [
    "Datei importieren",
    "Import file"
  ],
  "rv.import.title": [
    "Titel (optional)",
    "Title (optional)"
  ],
  "rv.import.do": [
    "Importieren",
    "Import"
  ],
  "rv.import.done": [
    "Importiert — die QC läuft.",
    "Imported — QC is running."
  ],
  "rv.import.disabled": [
    "Der Import ist nicht eingerichtet (Einstellung importDir).",
    "Import is not configured (setting importDir)."
  ],
  "rv.import.nofiles": [
    "Im Importverzeichnis liegen keine Mediendateien.",
    "There are no media files in the import directory."
  ],
  "rv.tab.subtitles": [
    "Untertitel",
    "Subtitles"
  ],
  "rv.sub.hint": [
    "Erzeugt aus dem Ton dieser Datei eine SRT-Untertiteldatei (Auto-Untertitel-Node, optional mit Sprechererkennung). Das Ergebnis hängt als Darstellung am Asset, lässt sich herunterladen und als Kind-Event SUBTITLE in der Playout-Automation abspielen; ein Auto-Untertitel-Node am Ausgang pausiert dann die Live-Untertitelung.",
    "Creates an SRT subtitle file from this file's audio (auto-subtitle node, optionally with speaker detection). The result is attached to the asset as a representation, can be downloaded and played as a SUBTITLE child event in playout automation; an auto-subtitle node on the output then pauses live captioning."
  ],
  "rv.sub.nonode": [
    "Kein Datei-Node läuft — „Auto-Untertitel“ mit Aufgabe „file“ starten (Option OMP_ASR_ROLE=file). Live-Nodes nehmen keine Dateiaufträge an, damit die Live-Untertitelung nicht gestört wird.",
    "No file node is running — start “Auto subtitles” with task “file” (option OMP_ASR_ROLE=file). Live nodes take no file jobs so live subtitling is never disturbed."
  ],
  "rv.sub.nodiar": [
    "Die Sprechererkennung ist am Node nicht eingerichtet (tools/asr-engine/install-diarization.sh) — es wird ohne Sprecher erzeugt.",
    "Speaker detection is not set up on the node (tools/asr-engine/install-diarization.sh) — generating without speakers."
  ],
  "rv.sub.dir": [
    "Ablage für die Playout-Automation: {p0}",
    "Location for playout automation: {p0}"
  ],
  "rv.sub.name": [
    "Name",
    "Name"
  ],
  "rv.sub.name.hint": [
    "leer = Dateiname",
    "empty = file name"
  ],
  "rv.sub.track": [
    "Tonspur",
    "Audio track"
  ],
  "rv.sub.track.hint": [
    "0 = erste",
    "0 = first"
  ],
  "rv.sub.lang": [
    "Sprache",
    "Language"
  ],
  "rv.sub.lang.hint": [
    "Code, leer = automatisch",
    "code, empty = auto"
  ],
  "rv.sub.speakers": [
    "Sprecher",
    "Speakers"
  ],
  "rv.sub.sp.auto": [
    "automatisch erkennen",
    "detect automatically"
  ],
  "rv.sub.sp.one": [
    "1 (ohne Namen)",
    "1 (no names)"
  ],
  "rv.sub.names": [
    "Namen",
    "Names"
  ],
  "rv.sub.names.hint": [
    "in Reihenfolge des ersten Auftretens, durch Komma getrennt",
    "in order of first appearance, comma-separated"
  ],
  "rv.sub.style": [
    "Schreibweise",
    "Label style"
  ],
  "rv.sub.start": [
    "SRT erzeugen",
    "Generate SRT"
  ],
  "rv.sub.err": [
    "Untertitel-Auftrag fehlgeschlagen.",
    "Subtitle job failed."
  ],
  "rv.sub.none": [
    "Noch keine Untertitel für diese Datei.",
    "No subtitles for this file yet."
  ],
  "rv.sub.state.running": [
    "läuft",
    "running"
  ],
  "rv.sub.state.done": [
    "fertig",
    "done"
  ],
  "rv.sub.state.failed": [
    "fehlgeschlagen",
    "failed"
  ],
  "rv.sub.state.canceled": [
    "abgebrochen",
    "canceled"
  ],
  "rv.sub.result": [
    "{p0} Untertitel, {p1} Sprecher, {p2} s",
    "{p0} cues, {p1} speakers, {p2} s"
  ],
  "rv.sub.playout": [
    "Spur für Kind-Event SUBTITLE: {p0}",
    "Track for SUBTITLE child event: {p0}"
  ],
  "rv.sub.cancel": [
    "Abbrechen",
    "Cancel"
  ],
  "rv.sub.download": [
    "SRT herunterladen",
    "Download SRT"
  ],
  "rv.sub.delete": [
    "Löschen",
    "Delete"
  ],
  "rv.sub.delete.q": [
    "Untertitel „{p0}“ löschen? Die Kopie für die Playout-Automation wird entfernt.",
    "Delete subtitle “{p0}”? The copy for playout automation is removed."
  ]
};

export const messages: Record<"de" | "en", Record<string, string>> = {
  de: Object.fromEntries(Object.entries(TABLE).map(([k, v]) => [k, v[0]])),
  en: Object.fromEntries(Object.entries(TABLE).map(([k, v]) => [k, v[1]])),
};
