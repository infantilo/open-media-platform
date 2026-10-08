// i18n (de/en): Sprache aus <html lang> (setzt die Shell, ui/shell/i18n.ts),
// Fallback Deutsch. Eigenes Mini-t(), weil Node-Bundles keine Shell-Imports nutzen.
const T = (() => {
  const D = {
    de: {
      "confirmFallback": "Hauptkanal wirklich auf Schwarzbild schalten?",
      "toBlack": "Auf Schwarzbild schalten",
      "mp.hold": "halten",
      "mp.skip": "überspringen",
      "mp.black": "Schwarz",
      "mp.stop": "Schwarz + Stopp",
      "mp.fallback": "Ersatzdatei",
      "mp.filler": "Standard-Filler",
      "mk.pattern": "Testmuster",
      "mk.file": "Datei",
      "mk.asset": "Asset (Bereitstellung)",
      "mk.image": "Standbild",
      "mk.live": "Live-Quelle",
      "mk.liveselect": "Live nach Tags",
      "mk.hold": "HOLD (anhalten)",
      "mk.jump": "JUMP (springen zu …)",
      "ct.graphic": "🎨 Grafik",
      "ct.logo": "🏷 Logo",
      "ct.branding": "📺 Channel-Branding",
      "ct.node": "⚙ Node-Befehl",
      "ct.trigger": "⚡ Trigger",
      "ct.audio": "🔊 Audio",
      "ct.voiceover": "🎙 Voiceover",
      "ct.webhook": "🌐 Webhook",
      "ct.channelTrigger": "📡 Channel-Trigger",
      "tm.start": "ab Start (Delay)",
      "tm.end": "vor Ende (Delay)",
      "tm.full": "gesamte Primary-Dauer",
      "tm.abs": "absolute Uhrzeit",
      "fp.warn": "Warnung",
      "fp.ignore": "ignorieren",
      "fp.retry": "wiederholen",
      "fp.block": "Primary blockieren",
      "fp.fallback": "Ersatz-Ziel",
      "noCall": "{method} fehlgeschlagen: {detail}",
      "notConnected": "nicht verbunden",
      "connected": "verbunden (Kanal {ch} live)",
      "channelLabel": "Channel: {name}",
      "noChannel": "kein Channel",
      "nextTitle": "Sofort zum nächsten Event (auch im Hold-Modus)",
      "liveTitle": "Zum nächsten Live-Event springen",
      "stopTitle": "Hauptkanal sofort auf Schwarzbild schalten (Playlist bleibt erhalten)",
      "mode": "Modus ",
      "sec.control": "Playlist Control",
      "sec.targets": "Ziele",
      "sec.playlist": "Playlist",
      "sec.carts": "Assets / Carts",
      "sec.trigger": "Channel-Trigger",
      "tgt.a": "Kanal A",
      "tgt.b": "Kanal B",
      "tgt.mixer": "Mixer",
      "tgt.gfx": "Grafik",
      "tgt.audio": "Audio-Mixer",
      "tgt.preflight": "Preflight-Vorlauf (min)",
      "tgt.filler": "Standard-Filler (Datei)",
      "sec.ads": "Werbeblöcke (SCTE)",
      "ad.enabled": "Werbeblöcke automatisch kennzeichnen",
      "ad.target": "SCTE-Node",
      "ad.preroll": "Vorlauf (ms)",
      "ad.hint": "Aus der Klassifikation der Events (Spot, Promo, Block-Anfang/-Ende) werden SCTE-35/-104-Marker abgeleitet: Out am Blockanfang mit Gesamtdauer, In am Ende, Rücknahme bei Abbruch.",
      "ad.open": "Block läuft",
      "ed.adClass": "Werbe-Klasse",
      "ed.adNone": "— keine —",
      "ed.adCommercial": "Spot (commercial)",
      "ed.adPromo": "Promo",
      "ed.adStart": "Block-Anfang",
      "ed.adEnd": "Block-Ende",
      "adBlockTip": "Werbeblock {n}/{total}{dur}",
      "choose": "— wählen —",
      "emptyList": "Noch keine Events — „＋“ links legt das erste an.",
      "noSource": "(keine Quelle)",
      "col.type": "Typ",
      "col.media": "Medium / Quelle",
      "col.mediaId": "Media-ID",
      "col.transition": "Transition",
      "col.start": "Start",
      "col.player": "Player",
      "col.status": "Status",
      "col.gap": "Gap / Overlap",
      "col.audio": "Audio",
      "col.child": "Child",
      "col.ready": "Bereitschaft",
      "col.title": "Titel",
      "col.dur": "Dauer",
      "col.time": "Zeit",
      "col.rem": "Rest",
      "manual": "manuell",
      "sequence": "Sequenz",
      "standard": "Standard",
      "unavailable": "nicht verfügbar",
      "audioTip": "Zuordnung: {label}",
      "silent": "still",
      "track": "Spur {tracks}",
      "mixedSuffix": " (gemischt)",
      "ruleSuffix": " · Ersatz „{rule}“",
      "st.played": "gespielt",
      "st.notReady": "nicht bereit",
      "st.missing": "fehlt",
      "st.planned": "geplant",
      "playerTip": "Voraussichtlicher Player (A/B wechselt je Event)",
      "seamless": "nahtlos",
      "gapTip": "Lücke zum Vorgänger: {s} s",
      "overlapTip": "Überlappung mit dem Vorgänger: {s} s",
      "search": "Suchen …",
      "columns": "Spalten",
      "newEvent": "Neues Event anlegen",
      "addMedia": "Medien aus der Bibliothek hinzufügen",
      "checkReady": "Bereitschaft der Asset-Events prüfen",
      "manageAssets": "Assets verwalten …",
      "tr.group": "Gruppe",
      "tr.channel": "Channel",
      "tr.all": "Alle erlaubten",
      "tr.targetPh": "Gruppe/Channel",
      "tr.itemPh": "Item-ID (JUMP)",
      "tr.atPh": "Zielzeit HH:MM:SS (optional)",
      "tr.lateNow": "verspätet: sofort",
      "tr.lateSkip": "verspätet: überspringen",
      "tr.lateResync": "verspätet: resync",
      "tr.lateQueue": "verspätet: einreihen",
      "tr.badTime": "Zielzeit ungültig (HH:MM[:SS] oder YYYY-MM-DD HH:MM[:SS], lokale Zeit)",
      "tr.allChannels": "alle erlaubten Channels",
      "tr.whoGroup": "Gruppe {name}",
      "tr.whoChannel": "Channel {name}",
      "tr.confirm": "Trigger {event} an {who} senden?",
      "tr.send": "Senden",
      "tr.none": "Noch keine Trigger.",
      "noAssetEvents": "Keine Asset-Events in der Playlist — Dateien/Live sind sofort verfügbar.",
      "readinessSummary": "{n} Asset-Events: {ready} bereit, {transfer} in Übertragung, {notReady} nicht bereit{bad}.",
      "readinessBad": " · {n} Events ohne verfügbare Quelle",
      "describe.hold": "HOLD: Sequenz hält an, bis der Operator weiterschaltet.",
      "describe.still": "Standbild: {file}",
      "describe.liveTags": "Live nach Tags: {tags} → {label}",
      "describe.noMatch": "keine passende Quelle",
      "describe.live": "Live: {id}",
      "describe.file": "Datei: {file}",
      "describe.pattern": "Testmuster: {pattern}",
      "removeOne": "{name} wirklich aus der Playlist entfernen?",
      "removeMany": "{n} Events wirklich entfernen ({names}{more})?",
      "remove": "Entfernen",
      "noReorderSearch": "Umsortieren geht nicht mit aktiver Suche — Suchfeld leeren.",
      "dragTitle": "Ziehen zum Umsortieren",
      "cueTake": "Cue + Take: dieses Event sofort senden",
      "editProps": "Eigenschaften bearbeiten",
      "removeEvent": "Event entfernen",
      "plannedAt": "Geplant: {from} – {to}{anchored}",
      "open": "offen",
      "anchored": " (feste Startzeit)",
      "fromStart": "Ab Listenbeginn: {rel}",
      "srcUnavailableTip": "Quelle nicht verfügbar — Take wird verweigert",
      "srcAvailableTip": "Quelle verfügbar",
      "assetTip": "Asset {id} — {ready}{st}{detail}\nBei Nichtverfügbarkeit: {onMissing}",
      "fixStart": "Fixzeit-Start",
      "manualStart": "Manueller Start",
      "transitionTitle": "{name}-Übergang",
      "kidsToggle": "Child Events ein-/ausklappen",
      "audioTitle": "Audio",
      "kidClickEdit": "Klicken zum Bearbeiten",
      "untilEnd": "bis Ende",
      "fullDuration": "gesamte Dauer",
      "close": "Schließen",
      "cancel": "Abbrechen",
      "save": "Speichern",
      "ed.new": "Neues Event",
      "ed.edit": "Event bearbeiten — {label}",
      "ed.create": "Anlegen",
      "ed.tab.content": "Inhalt",
      "ed.tab.timing": "Timing",
      "ed.tab.audio": "Audio",
      "ed.tab.kids": "Child Events ({n})",
      "ed.title": "Titel",
      "ed.type": "Typ",
      "ed.pattern": "Testmuster",
      "ed.file": "Datei",
      "ed.chooseFile": "— Datei wählen —",
      "ed.liveSource": "Live-Quelle",
      "ed.chooseSource": "— Quelle wählen —",
      "ed.reqTags": "Pflicht-Tags",
      "ed.resolvedTo": "Aufgelöst zu",
      "ed.pickTag": "+ bekanntes Tag …",
      "ed.tagHint": "Die Quelle wird über Tags gewählt (Tags einer Quelle setzt du in der Quellenverwaltung). Für eine bestimmte Quelle aus der Liste oben bei „Typ“ „Live-Quelle“ wählen.",
      "ed.tagsPh": "z. B. video.camera, role.program",
      "ed.preferred": "bevorzugt",
      "ed.optional": "optional",
      "ed.jumpTarget": "Sprungziel",
      "ed.chooseEvent": "— Event wählen —",
      "ed.assetId": "Asset-ID",
      "ed.assetIdPh": "Asset-ID aus dem OMP-Asset-System",
      "ed.ifMissing": "Wenn fehlt",
      "ed.fallbackFile": "Ersatzdatei",
      "ed.fallbackPh": "nur bei „Ersatzdatei“",
      "ed.durationMs": "Dauer (HH:MM:SS.FF)",
      "ed.durationHint": "Die Dauer wird vom Ziel-Player aus der Datei ermittelt.",
      "ed.onAirHint": "Dieses Event läuft gerade: Medium und Dauer sind gesperrt, Titel/Timing/Child Events sind änderbar.",
      "ed.note": "Notiz",
      "ed.notePh": "Operator-Notiz",
      "ed.iconColor": "Icon / Farbe",
      "ed.emoji": "Emoji",
      "ed.clearColor": "Farbe löschen",
      "ed.startTime": "Startzeit",
      "ed.startPh": "HH:MM:SS oder JJJJ-MM-TT HH:MM:SS (lokal)",
      "ed.start": "Start",
      "ed.startSeq": "⏭ Sequenz (nach dem Vorgänger)",
      "ed.startManual": "✋ Manuell (Cue + Take)",
      "ed.startFix": "⏰ Fixzeit (feste Uhrzeit)",
      "ed.ramp": "Rampe",
      "ed.rampPh": "Frames 1–250, leer = Mixer-Rate",
      "ed.transition": "Übergang",
      "ed.trMix": "⇄ Mix (Auto-Trans am Mixer)",
      "ed.trVfade": "◐◑ V-Fade (ausblenden auf Schwarz, dann aufblenden)",
      "ed.trFadecut": "◐✂ Fade-Cut (ausblenden auf Schwarz, dann hart)",
      "ed.trCutfade": "✂◑ Cut-Fade (hart auf Schwarz, dann aufblenden)",
      "ed.audioMapping": "Audio-Zuordnung",
      "ed.audioStd": "Standard (Player-Vorgabe)",
      "ed.audioMappingHint": "Welche Quellspuren in welche Ausgabegruppe gehen. Fehlt eine Spur, greifen die Ersatzregeln (Upmix, Downmix …). Ohne Wahl: MXF = Vorlage „Stereo“, sonst der Programmton der Quelle.",
      "ed.resolvedPlan": "Aufgelöster Plan",
      "ed.planLater": "Der aufgelöste Plan erscheint, sobald das Event gecued oder auf Sendung ist.",
      "ed.audioAfterCreate": "Die Audio-Wahl ist nach dem Anlegen verfügbar (sie hängt von den Capabilities der aufgelösten Live-Quelle ab).",
      "ed.audioLiveOnly": "Nur Live-Events mit bekannter Quelle bieten eine Audio-Wahl.",
      "ed.channelsN": "{n} Kanäle",
      "ed.audioFrom": "Audio von {source}",
      "ed.audioAuto": "Auto (Quell-Default)",
      "ed.default": " [Default]",
      "ed.currentChoice": "Aktuelle Wahl: {chosen} ({via})",
      "ed.deleteKid": "Child Event löschen",
      "ed.addKid": "＋ Child Event",
      "ed.kidsEmpty": "Child Events laufen parallel zum Event: Grafik ein-/ausblenden, Node-Befehle, Webhooks, Audio/Voiceover, Channel-Trigger.",
      "ed.runtime": "Laufzeit: {state}{error}{attempt}",
      "ed.attempt": " (Versuch {n})",
      "ed.templateId": "Template-ID",
      "ed.chooseTemplate": "— Vorlage wählen —",
      "ed.tplFields": "Felder der Vorlage „{name}“ ({n}); * = Pflichtfeld",
      "ed.noTemplates": "Keine Vorlagen vom Ziel-Grafikknoten gelesen (Ziel „Grafik“ prüfen) — ID von Hand eintragen.",
      "ed.dataJson": "Daten (JSON)",
      "ed.targetNode": "Ziel-Node",
      "ed.nodeLabelPh": "Node-Label",
      "ed.method": "Methode",
      "ed.paramsJson": "Parameter (JSON)",
      "ed.stopMethod": "Stopp-Methode",
      "ed.stopMethodPh": "optional, beim Ende",
      "ed.stopParams": "Stopp-Parameter",
      "ed.bodyJson": "Body (JSON)",
      "ed.event": "Event",
      "ed.target": "Ziel",
      "ed.name": "Name",
      "ed.itemId": "Item-ID",
      "ed.timingHdr": "Timing",
      "ed.mode": "Modus",
      "ed.clock": "Uhrzeit",
      "ed.beforeEnd": "Vor Ende (HH:MM:SS.FF)",
      "ed.delay": "Verzögerung (HH:MM:SS.FF)",
      "ed.zeroUntilEnd": "0 = bis zum Ende des Primary",
      "ed.onErrors": "Bei Fehlern",
      "ed.policy": "Richtlinie",
      "ed.retries": "Wiederholungen",
      "ed.pause": "Pause (ms)",
      "ed.fallbackTarget": "Ersatz-Ziel",
      "ed.required": "Pflicht",
      "ed.requiredHint": "nur sinnvoll mit „Primary blockieren“",
      "ed.badJson": "Child „{id}“: {key} ist kein gültiges JSON",
      "ed.badTime": "Child „{id}“: Uhrzeit ungültig",
      "ed.titleMissing": "Titel fehlt",
      "ed.badStart": "Startzeit ungültig (z. B. 14:30:00 oder 2026-10-03 06:00:00)",
      "ed.pickFile": "Datei wählen",
      "ed.pickImage": "Bilddatei wählen",
      "ed.pickLive": "Live-Quelle wählen",
      "ed.needTag": "Live nach Tags braucht mindestens einen Pflicht-Tag",
      "ed.pickJump": "Sprungziel wählen",
      "ed.assetMissing": "Asset-ID fehlt",
      "ed.createdNoProps": "Event angelegt, aber Eigenschaften nicht übernommen: {err}",
      "pick.none": "Keine Dateien in der Medienbibliothek des Ziel-Players.",
      "pick.title": "Medien hinzufügen",
      "pick.add": "Hinzufügen",
      "cart.onAir": "CART ON AIR: {label}",
      "cart.manual": " · manuell (RETURN)",
      "cart.iconPh": "Icon",
      "cart.titlePh": "Titel",
      "cart.msTitle": "ms, 0 = manuell (RETURN)",
      "cart.create": "＋ Anlegen",
      "cart.saved": "„{label}“ gespeichert",
      "cart.confirmRemove": "Cart „{label}“ wirklich entfernen?",
      "cart.none": "Noch keine Carts (Blackclip, Standby, …).",
      "cart.new": "Neuer Cart",
      "cart.manageTitle": "Assets / Carts verwalten",
      "fixCountdown": "⏰ {hms} „{label}“ in {t}",
      "planWarn.one": "⚠ 1 Plan-Warnung (Überlappung, Lücke oder unbestimmter Start — Details am ⚠ in der Zeitspalte)",
      "planWarn.many": "⚠ {n} Plan-Warnungen (Überlappung, Lücke oder unbestimmter Start — Details am ⚠ in der Zeitspalte)",
      "noTriggerYet": "Noch keine Trigger."
  },
    en: {
      "confirmFallback": "Really switch the main channel to black?",
      "toBlack": "Switch to black",
      "mp.hold": "hold",
      "mp.skip": "skip",
      "mp.black": "Black",
      "mp.stop": "Black + stop",
      "mp.fallback": "Fallback file",
      "mp.filler": "Default filler",
      "mk.pattern": "Test pattern",
      "mk.file": "File",
      "mk.asset": "Asset (provisioning)",
      "mk.image": "Still image",
      "mk.live": "Live source",
      "mk.liveselect": "Live by tags",
      "mk.hold": "HOLD (pause)",
      "mk.jump": "JUMP (go to …)",
      "ct.graphic": "🎨 Graphic",
      "ct.logo": "🏷 Logo",
      "ct.branding": "📺 Channel branding",
      "ct.node": "⚙ Node command",
      "ct.trigger": "⚡ Trigger",
      "ct.audio": "🔊 Audio",
      "ct.voiceover": "🎙 Voiceover",
      "ct.webhook": "🌐 Webhook",
      "ct.channelTrigger": "📡 Channel trigger",
      "tm.start": "from start (delay)",
      "tm.end": "before end (delay)",
      "tm.full": "entire primary duration",
      "tm.abs": "absolute time",
      "fp.warn": "Warning",
      "fp.ignore": "ignore",
      "fp.retry": "retry",
      "fp.block": "Block primary",
      "fp.fallback": "Fallback target",
      "noCall": "{method} failed: {detail}",
      "notConnected": "not connected",
      "connected": "connected (channel {ch} live)",
      "channelLabel": "Channel: {name}",
      "noChannel": "no channel",
      "nextTitle": "Go to the next event immediately (also in hold mode)",
      "liveTitle": "Jump to the next live event",
      "stopTitle": "Switch the main channel to black immediately (the playlist is kept)",
      "mode": "Mode ",
      "sec.control": "Playlist control",
      "sec.targets": "Targets",
      "sec.playlist": "Playlist",
      "sec.carts": "Assets / carts",
      "sec.trigger": "Channel trigger",
      "tgt.a": "Channel A",
      "tgt.b": "Channel B",
      "tgt.mixer": "Mixer",
      "tgt.gfx": "Graphics",
      "tgt.audio": "Audio mixer",
      "tgt.preflight": "Preflight lead time (min)",
      "tgt.filler": "Default filler (file)",
      "sec.ads": "Ad breaks (SCTE)",
      "ad.enabled": "Mark ad breaks automatically",
      "ad.target": "SCTE node",
      "ad.preroll": "Pre-roll (ms)",
      "ad.hint": "SCTE-35/-104 markers are derived from the event classification (spot, promo, block start/end): out at the block start with its total duration, in at the end, cancel on abort.",
      "ad.open": "Break running",
      "ed.adClass": "Ad class",
      "ed.adNone": "— none —",
      "ed.adCommercial": "Spot (commercial)",
      "ed.adPromo": "Promo",
      "ed.adStart": "Block start",
      "ed.adEnd": "Block end",
      "adBlockTip": "Ad break {n}/{total}{dur}",
      "choose": "— choose —",
      "emptyList": "No events yet — “＋” on the left creates the first one.",
      "noSource": "(no source)",
      "col.type": "Type",
      "col.media": "Media / source",
      "col.mediaId": "Media ID",
      "col.transition": "Transition",
      "col.start": "Start",
      "col.player": "Player",
      "col.status": "Status",
      "col.gap": "Gap / overlap",
      "col.audio": "Audio",
      "col.child": "Child",
      "col.ready": "Readiness",
      "col.title": "Title",
      "col.dur": "Duration",
      "col.time": "Time",
      "col.rem": "Remaining",
      "manual": "manual",
      "sequence": "Sequence",
      "standard": "Default",
      "unavailable": "unavailable",
      "audioTip": "Mapping: {label}",
      "silent": "silent",
      "track": "Track {tracks}",
      "mixedSuffix": " (mixed)",
      "ruleSuffix": " · fallback “{rule}”",
      "st.played": "played",
      "st.notReady": "not ready",
      "st.missing": "missing",
      "st.planned": "planned",
      "playerTip": "Expected player (A/B alternates per event)",
      "seamless": "seamless",
      "gapTip": "Gap to the previous event: {s} s",
      "overlapTip": "Overlap with the previous event: {s} s",
      "search": "Search …",
      "columns": "Columns",
      "newEvent": "Create a new event",
      "addMedia": "Add media from the library",
      "checkReady": "Check the readiness of the asset events",
      "manageAssets": "Manage assets …",
      "tr.group": "Group",
      "tr.channel": "Channel",
      "tr.all": "All permitted",
      "tr.targetPh": "Group/channel",
      "tr.itemPh": "Item ID (JUMP)",
      "tr.atPh": "Target time HH:MM:SS (optional)",
      "tr.lateNow": "late: immediately",
      "tr.lateSkip": "late: skip",
      "tr.lateResync": "late: resync",
      "tr.lateQueue": "late: queue",
      "tr.badTime": "Invalid target time (HH:MM[:SS] or YYYY-MM-DD HH:MM[:SS], local time)",
      "tr.allChannels": "all permitted channels",
      "tr.whoGroup": "group {name}",
      "tr.whoChannel": "channel {name}",
      "tr.confirm": "Send trigger {event} to {who}?",
      "tr.send": "Send",
      "tr.none": "No triggers yet.",
      "noAssetEvents": "No asset events in the playlist — files/live are available immediately.",
      "readinessSummary": "{n} asset events: {ready} ready, {transfer} transferring, {notReady} not ready{bad}.",
      "readinessBad": " · {n} events without an available source",
      "describe.hold": "HOLD: the sequence pauses until the operator continues.",
      "describe.still": "Still image: {file}",
      "describe.liveTags": "Live by tags: {tags} → {label}",
      "describe.noMatch": "no matching source",
      "describe.live": "Live: {id}",
      "describe.file": "File: {file}",
      "describe.pattern": "Test pattern: {pattern}",
      "removeOne": "Really remove {name} from the playlist?",
      "removeMany": "Really remove {n} events ({names}{more})?",
      "remove": "Remove",
      "noReorderSearch": "Reordering is not possible while a search is active — clear the search field.",
      "dragTitle": "Drag to reorder",
      "cueTake": "Cue + take: send this event immediately",
      "editProps": "Edit properties",
      "removeEvent": "Remove event",
      "plannedAt": "Planned: {from} – {to}{anchored}",
      "open": "open",
      "anchored": " (fixed start time)",
      "fromStart": "From list start: {rel}",
      "srcUnavailableTip": "Source unavailable — take is refused",
      "srcAvailableTip": "Source available",
      "assetTip": "Asset {id} — {ready}{st}{detail}\nIf unavailable: {onMissing}",
      "fixStart": "Fixed-time start",
      "manualStart": "Manual start",
      "transitionTitle": "{name} transition",
      "kidsToggle": "Expand/collapse child events",
      "audioTitle": "Audio",
      "kidClickEdit": "Click to edit",
      "untilEnd": "until end",
      "fullDuration": "entire duration",
      "close": "Close",
      "cancel": "Cancel",
      "save": "Save",
      "ed.new": "New event",
      "ed.edit": "Edit event — {label}",
      "ed.create": "Create",
      "ed.tab.content": "Content",
      "ed.tab.timing": "Timing",
      "ed.tab.audio": "Audio",
      "ed.tab.kids": "Child events ({n})",
      "ed.title": "Title",
      "ed.type": "Type",
      "ed.pattern": "Test pattern",
      "ed.file": "File",
      "ed.chooseFile": "— choose file —",
      "ed.liveSource": "Live source",
      "ed.chooseSource": "— choose source —",
      "ed.reqTags": "Required tags",
      "ed.resolvedTo": "Resolved to",
      "ed.pickTag": "+ known tag …",
      "ed.tagHint": "The source is chosen by tags (set a source's tags in the source management). To pick a specific source from a list, choose the type \"Live source\" above.",
      "ed.tagsPh": "e.g. video.camera, role.program",
      "ed.preferred": "preferred",
      "ed.optional": "optional",
      "ed.jumpTarget": "Jump target",
      "ed.chooseEvent": "— choose event —",
      "ed.assetId": "Asset ID",
      "ed.assetIdPh": "Asset ID from the OMP asset system",
      "ed.ifMissing": "If missing",
      "ed.fallbackFile": "Fallback file",
      "ed.fallbackPh": "only for “Fallback file”",
      "ed.durationMs": "Duration (HH:MM:SS.FF)",
      "ed.durationHint": "The duration is determined by the target player from the file.",
      "ed.onAirHint": "This event is on air: media and duration are locked; title, timing and child events can be changed.",
      "ed.note": "Note",
      "ed.notePh": "Operator note",
      "ed.iconColor": "Icon / colour",
      "ed.emoji": "Emoji",
      "ed.clearColor": "Clear colour",
      "ed.startTime": "Start time",
      "ed.startPh": "HH:MM:SS or YYYY-MM-DD HH:MM:SS (local)",
      "ed.start": "Start",
      "ed.startSeq": "⏭ Sequence (after the previous event)",
      "ed.startManual": "✋ Manual (cue + take)",
      "ed.startFix": "⏰ Fixed time (clock time)",
      "ed.ramp": "Ramp",
      "ed.rampPh": "Frames 1–250, empty = mixer rate",
      "ed.transition": "Transition",
      "ed.trMix": "⇄ Mix (auto-trans on the mixer)",
      "ed.trVfade": "◐◑ V-Fade (fade to black, then fade in)",
      "ed.trFadecut": "◐✂ Fade-cut (fade to black, then hard)",
      "ed.trCutfade": "✂◑ Cut-fade (hard to black, then fade in)",
      "ed.audioMapping": "Audio mapping",
      "ed.audioStd": "Default (player preset)",
      "ed.audioMappingHint": "Which source tracks go to which output group. If a track is missing, the fallback rules apply (upmix, downmix …). Without a choice: MXF = “Stereo” template, otherwise the programme sound of the source.",
      "ed.resolvedPlan": "Resolved plan",
      "ed.planLater": "The resolved plan appears as soon as the event is cued or on air.",
      "ed.audioAfterCreate": "The audio choice is available after creating the event (it depends on the capabilities of the resolved live source).",
      "ed.audioLiveOnly": "Only live events with a known source offer an audio choice.",
      "ed.channelsN": "{n} channels",
      "ed.audioFrom": "Audio from {source}",
      "ed.audioAuto": "Auto (source default)",
      "ed.default": " [default]",
      "ed.currentChoice": "Current choice: {chosen} ({via})",
      "ed.deleteKid": "Delete child event",
      "ed.addKid": "＋ Child event",
      "ed.kidsEmpty": "Child events run in parallel to the event: show/hide graphics, node commands, webhooks, audio/voiceover, channel triggers.",
      "ed.runtime": "Runtime: {state}{error}{attempt}",
      "ed.attempt": " (attempt {n})",
      "ed.templateId": "Template ID",
      "ed.chooseTemplate": "— choose template —",
      "ed.tplFields": "Fields of template \"{name}\" ({n}); * = required",
      "ed.noTemplates": "No templates read from the target graphics node (check the \"Graphics\" target) — enter the ID by hand.",
      "ed.dataJson": "Data (JSON)",
      "ed.targetNode": "Target node",
      "ed.nodeLabelPh": "Node label",
      "ed.method": "Method",
      "ed.paramsJson": "Parameters (JSON)",
      "ed.stopMethod": "Stop method",
      "ed.stopMethodPh": "optional, at the end",
      "ed.stopParams": "Stop parameters",
      "ed.bodyJson": "Body (JSON)",
      "ed.event": "Event",
      "ed.target": "Target",
      "ed.name": "Name",
      "ed.itemId": "Item ID",
      "ed.timingHdr": "Timing",
      "ed.mode": "Mode",
      "ed.clock": "Time of day",
      "ed.beforeEnd": "Before end (HH:MM:SS.FF)",
      "ed.delay": "Delay (HH:MM:SS.FF)",
      "ed.zeroUntilEnd": "0 = until the end of the primary",
      "ed.onErrors": "On errors",
      "ed.policy": "Policy",
      "ed.retries": "Retries",
      "ed.pause": "Pause (ms)",
      "ed.fallbackTarget": "Fallback target",
      "ed.required": "Required",
      "ed.requiredHint": "only useful with “Block primary”",
      "ed.badJson": "Child “{id}”: {key} is not valid JSON",
      "ed.badTime": "Child “{id}”: invalid time",
      "ed.titleMissing": "Title missing",
      "ed.badStart": "Invalid start time (e.g. 14:30:00 or 2026-10-03 06:00:00)",
      "ed.pickFile": "Choose a file",
      "ed.pickImage": "Choose an image file",
      "ed.pickLive": "Choose a live source",
      "ed.needTag": "Live by tags needs at least one required tag",
      "ed.pickJump": "Choose a jump target",
      "ed.assetMissing": "Asset ID missing",
      "ed.createdNoProps": "Event created, but properties were not applied: {err}",
      "pick.none": "No files in the media library of the target player.",
      "pick.title": "Add media",
      "pick.add": "Add",
      "cart.onAir": "CART ON AIR: {label}",
      "cart.manual": " · manual (RETURN)",
      "cart.iconPh": "Icon",
      "cart.titlePh": "Title",
      "cart.msTitle": "ms, 0 = manual (RETURN)",
      "cart.create": "＋ Create",
      "cart.saved": "“{label}” saved",
      "cart.confirmRemove": "Really remove cart “{label}”?",
      "cart.none": "No carts yet (black clip, standby, …).",
      "cart.new": "New cart",
      "cart.manageTitle": "Manage assets / carts",
      "fixCountdown": "⏰ {hms} “{label}” in {t}",
      "planWarn.one": "⚠ 1 plan warning (overlap, gap or undetermined start — details at the ⚠ in the time column)",
      "planWarn.many": "⚠ {n} plan warnings (overlap, gap or undetermined start — details at the ⚠ in the time column)",
      "noTriggerYet": "No triggers yet."
  },
  };
  const lang = document.documentElement.lang === "en" ? "en" : "de";
  return (k, p) => {
    let s = (D[lang] && D[lang][k]) ?? D.de[k] ?? k;
    if (p) for (const x in p) s = s.split("{" + x + "}").join(p[x]);
    return s;
  };
})();
const LOCALE = document.documentElement.lang === "en" ? "en-GB" : "de-DE";

// Node-UI-Bundle des Playout-Automation-Controllers (UMSETZUNG.md
// C14/C15, ARCHITECTURE.md §13.3/§7.4): Rundown-Liste mit Cue/Take wie
// omp-players Videoplayer-Panel (bundle-video.js, C12), zusätzlich
// Ziel-Player/-Mixer-Label (beschreibbare Parameter, main.rs) und ein
// Auto/Hold-Modeschalter samt Fortschrittsbalken für das on-air Item.
// Gleiche generische Node-Proxy-API wie alle anderen Nodes:
// /api/v1/nodes/<id>/params/<name>, /api/v1/nodes/<id>/methods/<name>.

// Vanille-Nachbau von `ui/kit/omp-confirm.ts`s `confirmDialog()` (UX-
// Audit 2026-08-07): dieses Bundle ist ein eigenständiges, nicht über
// den Shell-Build laufendes JS (`include_str!`, kein TS-Import möglich),
// aber `<omp-confirm>` selbst ist bereits global registriert, sobald die
// Shell lädt (`ui/kit/index.ts`s Moduldoku: "kann die Tags danach in
// seinem eigenen Shadow-DOM verwenden, ohne selbst zu importieren") —
// hier nur der Aufruf-Wrapper nachgebaut, damit auch dieses Bundle
// dasselbe modale Overlay statt des blockierenden `window.confirm()`
// nutzen kann. Vorher: der "■ Stop"-Button (schaltet den On-Air-Kanal
// sofort auf Schwarzbild) nutzte `window.confirm()`, Rundown-Item- und
// Cart-„Entfernen"-Buttons hatten GAR KEINE Bestätigung — ein
// versehentlicher Klick löschte ein Rundown-Item ohne jede Rückfrage.
function confirmDialog(message, confirmLabel) {
  if (!customElements.get("omp-confirm")) {
    // Fallback für einen (in der Praxis nicht vorkommenden) Stand-
    // alone-Aufruf dieses Bundles außerhalb der Shell.
    return Promise.resolve(window.confirm(message));
  }
  return new Promise((resolve) => {
    const el = document.createElement("omp-confirm");
    el.textContent = message;
    if (confirmLabel) el.setAttribute("confirm-label", confirmLabel);
    el.addEventListener(
      "resolve",
      (ev) => {
        resolve(ev.detail);
        el.remove();
      },
      { once: true },
    );
    document.body.appendChild(el);
  });
}

// Kapitel 27 / P2c: Startzeit-Eingabe. Akzeptiert "HH:MM[:SS]" (heute) oder
// "YYYY-MM-DD HH:MM[:SS]" in LOKALER Zeit und liefert den absoluten Zeitpunkt
// als ISO-8601-UTC-String (`…Z`) — der Node rechnet nur mit UTC (E5), die
// Zeitzone des Bedieners steckt damit in der Umrechnung hier, nicht im Node.
// `null` bei ungültiger Eingabe.
function parseStartInput(text, now = new Date()) {
  const m = /^(?:(\d{4})-(\d{2})-(\d{2})[ T])?(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec((text || "").trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  const date = y
    ? new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec || 0))
    : new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(h), Number(mi), Number(sec || 0));
  if (Number.isNaN(date.getTime()) || Number(h) > 23 || Number(mi) > 59 || Number(sec || 0) > 59) return null;
  return date.toISOString();
}

// ISO-UTC → "TT.MM. HH:MM:SS" lokal (nur Datum, wenn nicht heute).
function formatLocalStart(iso, now = new Date()) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hms = d.toLocaleTimeString(LOCALE);
  if (d.toDateString() === now.toDateString()) return hms;
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}. ${hms}`;
}


// ---------------------------------------------------------------------------
// Kleine DOM-Helfer
// ---------------------------------------------------------------------------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const TRANSITION_LABEL = { cut: "Cut", mix: "Mix", vfade: "V-Fade", fadecut: "Fade-Cut", cutfade: "Cut-Fade" };
const fmtMs = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const MISSING_POLICIES = [
  ["HOLD", T("mp.hold")], ["SKIP", T("mp.skip")], ["BLACK", T("mp.black")], ["STOP", T("mp.stop")],
  ["FALLBACK", T("mp.fallback")], ["DEFAULT_FILLER", T("mp.filler")],
];
const PATTERNS = ["smpte", "ball", "snow", "circular", "checkers-1", "solid-color"];
const TC_FPS = 25;
/** Millisekunden → "HH:MM:SS.FF" (volle Bilder, Rundung auf das Raster). */
function tcFormat(ms, fps) {
  const total = Math.max(0, Math.round((Number(ms) || 0) * fps / 1000));
  const ff = total % fps, secs = Math.floor(total / fps);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(secs / 3600))}:${p(Math.floor(secs / 60) % 60)}:${p(secs % 60)}.${p(ff)}`;
}
/** "HH:MM:SS.FF" (auch "MM:SS.FF" oder "SS.FF") → Millisekunden; null bei ungültiger Eingabe. */
function tcParse(str, fps) {
  const m = /^\s*(?:(?:(\d+):)?(\d+):)?(\d+)[.:;,](\d+)\s*$/.exec(str || "");
  if (!m) return null;
  const [h2, mi, se, fr] = [Number(m[1] || 0), Number(m[2] || 0), Number(m[3]), Number(m[4])];
  if (fr >= fps || (m[2] !== undefined && se >= 60) || (m[1] !== undefined && mi >= 60)) return null;
  return Math.round(((h2 * 3600 + mi * 60 + se) * fps + fr) * 1000 / fps);
}
const MEDIA_KINDS = [
  ["pattern", T("mk.pattern")], ["file", T("mk.file")], ["asset", T("mk.asset")], ["image", T("mk.image")],
  ["live", T("mk.live")], ["liveselect", T("mk.liveselect")], ["hold", T("mk.hold")], ["jump", T("mk.jump")],
];
const CHILD_TYPES = [
  ["GRAPHIC", T("ct.graphic")], ["LOGO", T("ct.logo")], ["CHANNEL_BRANDING", T("ct.branding")],
  ["NODE_COMMAND", T("ct.node")], ["TRIGGER", T("ct.trigger")], ["AUDIO", T("ct.audio")], ["VOICEOVER", T("ct.voiceover")],
  ["WEBHOOK", T("ct.webhook")], ["CHANNEL_TRIGGER", T("ct.channelTrigger")],
];
const CHILD_ICON = Object.fromEntries(CHILD_TYPES.map(([v, t]) => [v, t.split(" ")[0]]));
const TIMINGS = [
  ["RELATIVE_TO_START", T("tm.start")], ["RELATIVE_TO_END", T("tm.end")],
  ["FULL_PRIMARY", T("tm.full")], ["ABSOLUTE", T("tm.abs")],
];
const FAIL_POLICIES = [
  ["WARN", T("fp.warn")], ["IGNORE", T("fp.ignore")], ["RETRY", T("fp.retry")], ["BLOCK", T("fp.block")], ["FALLBACK", T("fp.fallback")],
];
const TRIGGER_EVENTS = ["NEXT", "NEXT_LIVE", "CUT", "JUMP", "HOLD", "RESUME"];

const STYLE = `
  :host { display: block; font-family: system-ui, sans-serif; color: var(--t, #e6e6e6); font-size: 12px;
    --bg: #1b1b1d; --bg2: #232326; --bg3: #2c2c30; --bd: #3a3a40; --mut: #8a8a92; --acc: #4a90d9;
    --ok: #3fae4b; --warn: #e0a030; --err: #e05050; outline: none; }
  * { box-sizing: border-box; }
  button, select, input, textarea { font: inherit; color: inherit; }
  input, select, textarea { background: var(--bg); border: 1px solid var(--bd); border-radius: 3px; padding: 4px 6px; }
  input[type=color] { padding: 0; width: 34px; height: 24px; }
  button { cursor: pointer; background: var(--bg3); border: 1px solid var(--bd); border-radius: 4px; padding: 4px 9px; }
  button:hover:not(:disabled) { border-color: var(--acc); }
  button:disabled { opacity: .4; cursor: default; }
  button.primary { background: #2a5a8f; border-color: var(--acc); }
  button.danger { color: #ff8a8a; border-color: #7a3030; }
  .head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
  .clock { font: bold 20px "SF Mono","Roboto Mono",monospace; font-variant-numeric: tabular-nums; }
  .chip { padding: 2px 8px; border-radius: 10px; background: var(--bg3); font-size: 11px; }
  .chip.ok { background: #1f5a28; } .chip.err { background: #7a1f1f; } .chip.onair { background: #1f5a28; font-weight: bold; }
  .chip.blue { background: #1f4d7a; }
  .info { color: var(--acc); font-variant-numeric: tabular-nums; margin-bottom: 4px; }
  .info.warn { color: var(--warn); }
  .banner { display: none; padding: 6px 10px; margin-bottom: 6px; border-radius: 4px; background: #7a1f1f; color: #fff; }
  .banner.show { display: block; }
  .banner.note { background: #1f4d7a; }
  /* Abschnitte */
  details.sec { border: 1px solid var(--bd); border-radius: 6px; margin-bottom: 8px; background: var(--bg2); }
  details.sec > summary { cursor: pointer; padding: 6px 10px; font-weight: 600; list-style: none; display: flex; gap: 8px; align-items: center; user-select: none; }
  details.sec > summary::before { content: "▸"; color: var(--mut); }
  details.sec[open] > summary::before { content: "▾"; }
  details.sec > .body { padding: 8px 10px 10px; border-top: 1px solid var(--bd); }
  .ctrl { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .take { background: #7a1f1f; border-color: #a33; font-weight: bold; font-size: 14px; padding: 8px 20px; }
  .progress { height: 4px; background: var(--bg3); border-radius: 2px; margin-top: 8px; overflow: hidden; }
  .progress .bar { height: 100%; background: var(--ok); width: 0; }
  .targets { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 6px 14px; }
  .targets label { display: flex; flex-direction: column; gap: 2px; color: var(--mut); }
  /* Playlist: linke Aktionsleiste + Liste */
  .pl-wrap { display: flex; gap: 8px; }
  .sidebar { display: flex; flex-direction: column; gap: 6px; }
  .sidebar button { width: 38px; height: 38px; font-size: 17px; padding: 0; }
  .pl-main { flex: 1; min-width: 0; }
  .pl-tools { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
  .pl-tools input[type=search] { flex: 1; }
  .cols-pop { position: absolute; right: 0; top: 30px; z-index: 5; background: var(--bg3); border: 1px solid var(--bd); border-radius: 6px; padding: 8px; display: none; flex-direction: column; gap: 4px; }
  .cols-pop.show { display: flex; }
  .cols-pop label { display: flex; gap: 6px; align-items: center; }
  .pl-cols { grid-template-columns: 16px 26px 22px minmax(0,1fr) 54px 108px 84px 40px 92px; }
  .hide-dur .c-dur, .hide-time .c-time, .hide-rem .c-rem { display: none; }
  .pl-main { min-width: 0; overflow-x: auto; }
  .pl-hdr, .pl-row { min-width: var(--minw, 0); }
  .pl-row .xc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--mut); }
  .pl-row .xc.st-onair { color: #ff6b6b; font-weight: 700; } .pl-row .xc.st-cued { color: #6bd36b; font-weight: 700; }
  .pl-row .xc.st-played { color: #777; } .pl-row .xc.st-bad { color: var(--warn); }
  .pl-row .xc.gap-neg { color: var(--warn); }
  .pl-hdr { display: grid; gap: 4px; padding: 2px 6px; font-size: 9px; color: var(--mut); text-transform: uppercase; letter-spacing: .05em; border-bottom: 1px solid var(--bd); }
  .pl-rowwrap { position: relative; }
  .pl-row { display: grid; gap: 4px; align-items: center; padding: 4px 6px; border-bottom: 1px solid #2a2a2e; border-left: 3px solid transparent; cursor: default; user-select: none; }
  .pl-row:hover { background: #2a2a30; }
  .pl-row.sel { background: #26384f; }
  .pl-row.onair { background: #17301c; border-left-color: var(--ok); }
  .pl-row.cued { background: #35290f; border-left-color: #d4a017; }
  .pl-row.fix { border-left-color: var(--acc); }
  .pl-row.adb { box-shadow: inset -3px 0 0 #c8501e; }
  .pl-row.adb-first { border-top: 1px solid #c8501e; } .pl-row.adb-last { border-bottom: 1px solid #c8501e; }
  .pl-row.adb-open { box-shadow: inset -3px 0 0 #ff7a3a, inset 0 0 0 1px #ff7a3a55; }
  .pl-row.manual { border-left-color: #d4a017; }
  .pl-row.dragging { opacity: .45; }
  .pl-row.skipped { opacity: .55; }
  .pl-row .drag { cursor: grab; color: var(--mut); text-align: center; touch-action: none; }
  .pl-row .num { color: var(--mut); text-align: right; font-variant-numeric: tabular-nums; }
  .pl-row .ico { text-align: center; }
  .pl-row .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 5px; }
  .pl-row .title .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: transparent; }
  .pl-row .title .chips { display: inline-flex; gap: 3px; }
  .pl-row .title .chip { font-size: 10px; padding: 0 5px; cursor: pointer; }
  .pl-row .dur, .pl-row .time { color: #aaa; font-variant-numeric: tabular-nums; }
  .pl-row .rem { display: flex; flex-direction: column; gap: 1px; }
  .pl-row .rem .txt { color: var(--ok); font-size: 9px; text-align: right; font-variant-numeric: tabular-nums; }
  .pl-row .rem .rbar { height: 3px; background: var(--bg3); border-radius: 2px; overflow: hidden; }
  .pl-row .rem .rbar span { display: block; height: 100%; background: var(--ok); width: 0; }
  .pl-row .av { text-align: center; color: var(--ok); }
  .pl-row .av.bad { color: var(--err); font-weight: bold; }
  .pl-row .acts { display: flex; gap: 3px; justify-content: flex-end; opacity: 0; }
  .pl-row:hover .acts, .pl-row.sel .acts { opacity: 1; }
  .pl-row .acts button { padding: 1px 6px; font-size: 11px; }
  .kids { margin: 0 0 2px 54px; border-left: 2px solid var(--bd); }
  .kid { display: flex; gap: 8px; align-items: center; padding: 2px 8px; color: #bbb; font-size: 11px; cursor: pointer; }
  .kid:hover { background: #2a2a30; }
  .kid .st { font-size: 10px; padding: 0 5px; border-radius: 8px; background: var(--bg3); }
  .kid .st.Failed { background: #7a1f1f; } .kid .st.Active, .kid .st.Fired { background: #1f5a28; } .kid .st.Armed { background: #1f4d7a; }
  .drop-line { position: absolute; left: 0; right: 0; height: 2px; background: var(--acc); pointer-events: none; z-index: 3; }
  .empty { color: var(--mut); padding: 14px; text-align: center; }
  /* Carts */
  .cart-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 6px; }
  .cart-btn { height: 54px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; border-radius: 6px; font-weight: 600; border: 1px solid var(--bd); }
  .cart-btn .ci { font-size: 18px; } .cart-btn .cl { font-size: 11px; max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cart-btn.firing { outline: 2px solid #ff5050; animation: pulse 1s infinite; }
  @keyframes pulse { 50% { opacity: .6; } }
  .cart-banner { display: none; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; border-radius: 4px; background: #7a1f1f; margin-bottom: 8px; }
  .cart-banner.show { display: flex; }
  /* Dialoge */
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 1000; display: flex; align-items: center; justify-content: center; }
  .modal { background: var(--bg2); border: 1px solid var(--bd); border-radius: 8px; width: min(760px, 96vw); max-height: 92vh; display: flex; flex-direction: column; box-shadow: 0 10px 40px rgba(0,0,0,.6); }
  .modal > header { padding: 10px 14px; font-weight: 600; font-size: 14px; border-bottom: 1px solid var(--bd); display: flex; justify-content: space-between; }
  .modal > .tabs { display: flex; gap: 2px; padding: 6px 10px 0; border-bottom: 1px solid var(--bd); }
  .modal > .tabs button { border-radius: 4px 4px 0 0; border-bottom: none; background: transparent; }
  .modal > .tabs button.act { background: var(--bg3); border-color: var(--acc); }
  .modal > .content { padding: 12px 14px; overflow: auto; flex: 1; min-height: 280px; }
  .modal > footer { padding: 10px 14px; border-top: 1px solid var(--bd); display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
  .modal > footer .err { color: #ff8a8a; margin-right: auto; }
  .form { display: grid; grid-template-columns: 130px 1fr; gap: 7px 10px; align-items: center; }
  .form > label { color: var(--mut); }
  .form .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .form input[type=text], .form input[type=number], .form select, .form textarea { width: 100%; }
  .form textarea { min-height: 54px; font-family: monospace; }
  .hint { color: var(--mut); font-size: 11px; grid-column: 1 / -1; }
  .kid-edit { display: grid; grid-template-columns: 210px 1fr; gap: 12px; }
  .kid-list { border: 1px solid var(--bd); border-radius: 4px; max-height: 340px; overflow: auto; }
  .kid-list .it { padding: 5px 8px; cursor: pointer; border-bottom: 1px solid #2a2a2e; display: flex; gap: 6px; align-items: center; }
  .kid-list .it.act { background: #26384f; }
  .kid-list .it .x { margin-left: auto; color: #ff8a8a; }
  .pick-list { max-height: 360px; overflow: auto; border: 1px solid var(--bd); border-radius: 4px; }
  .pick-list .it { padding: 5px 8px; cursor: pointer; border-bottom: 1px solid #2a2a2e; display: flex; gap: 8px; }
  .pick-list .it:hover { background: #2a2a30; }
  .pick-list .it.chk { background: #26384f; }
`;

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
class OmpPlayoutAutomationPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });
    this.tabIndex = 0;

    // ---- Zustand --------------------------------------------------------
    let items = [];
    let adBlocks = [];
    let assets = [];
    let childRuntime = [];
    let availableNodes = [];
    let mediaLibrary = [];
    let channelId = "";
    let currentItemId = "";
    let cuedItemId = "";
    let activeCartId = "";
    let audioMixerLabel = "";
    const selected = new Set();
    let lastClickedId = null;
    const expanded = new Set();
    let search = "";
    let dragging = false;
    let modalOpen = false;
    const prefs = (() => {
      try { return JSON.parse(localStorage.getItem("omp-pa-cols") || "{}"); } catch { return {}; }
    })();
    const savePrefs = () => { try { localStorage.setItem("omp-pa-cols", JSON.stringify(prefs)); } catch { /* ignorieren */ } };

    // ---- API ------------------------------------------------------------
    let bannerTimer = null;
    const banner = h("div", { class: "banner" });
    const showBanner = (text, note) => {
      banner.textContent = text;
      banner.className = `banner show${note ? " note" : ""}`;
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => banner.classList.remove("show"), 6000);
    };
    const call = (method, body) =>
      fetch(`/api/v1/nodes/${nodeId}/methods/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      }).then(async (res) => {
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          const msg = T("noCall", { method, detail: detail || res.status });
          showBanner(msg);
          const e = new Error(detail || String(res.status));
          e.shown = true;
          throw e;
        }
        return res;
      });
    // wie call(), aber Fehler als Text zurück (für Dialoge)
    const tryCall = async (method, body) => {
      const res = await fetch(`/api/v1/nodes/${nodeId}/methods/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
      });
      if (res.ok) return null;
      let t = await res.text().catch(() => "");
      try { const j = JSON.parse(t); t = j.error || j.message || t; } catch { /* Klartext */ }
      return t || `HTTP ${res.status}`;
    };
    const setParam = (name, value) =>
      fetch(`/api/v1/nodes/${nodeId}/params/${encodeURIComponent(name)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }),
      });
    const getParam = async (name) => {
      const res = await fetch(`/api/v1/nodes/${nodeId}/params/${encodeURIComponent(name)}`);
      if (!res.ok) return undefined;
      return (await res.json()).value;
    };
    const act = (method, body) => call(method, body).then(() => poll()).catch(() => {});

    // ---- Kopf -----------------------------------------------------------
    const clockEl = h("span", { class: "clock" });
    const modeChip = h("span", { class: "chip" });
    const connectedChip = h("span", { class: "chip" }, T("notConnected"));
    const persistChip = h("span", { class: "chip" }, T("channelLabel", { name: "…" }));
    const nextFixEl = h("div", { class: "info", style: "display:none" });
    const planWarnEl = h("div", { class: "info warn", style: "display:none" });
    const head = h("div", { class: "head" }, clockEl, modeChip, connectedChip, persistChip);

    // ---- Playlist Control ----------------------------------------------
    const takeBtn = h("button", { class: "take", onclick: () => act("take", {}) }, "TAKE");
    const nextBtn = h("button", { title: T("nextTitle"), onclick: () => act("next", {}) }, "▶▶ Next");
    const nextLiveBtn = h("button", { title: T("liveTitle"), onclick: () => act("nextLive", {}) }, "▶ Live");
    const stopBtn = h("button", {
      class: "danger", title: T("stopTitle"),
      onclick: async () => {
        if (await confirmDialog(T("confirmFallback"), T("toBlack"))) act("stop", {});
      },
    }, "■ Stop");
    const modeSelect = h("select", { onchange: () => setParam("mode", modeSelect.value) },
      h("option", { value: "auto" }, "Auto"), h("option", { value: "hold" }, "Hold"));
    const progressBar = h("div", { class: "bar" });
    const controlSec = h("details", { class: "sec", open: true },
      h("summary", {}, T("sec.control")),
      h("div", { class: "body" },
        h("div", { class: "ctrl" }, takeBtn, nextBtn, nextLiveBtn, stopBtn, h("span", { style: "flex:1" }), h("label", {}, T("mode"), modeSelect)),
        h("div", { class: "progress" }, progressBar)));

    // ---- Ziele ----------------------------------------------------------
    const mkTarget = (param) => {
      const sel = h("select", { onchange: () => setParam(param, sel.value) });
      return sel;
    };
    const selA = mkTarget("targetPlayerALabel");
    const selB = mkTarget("targetPlayerBLabel");
    const selMix = mkTarget("targetMixerLabel");
    const selGfx = mkTarget("targetGraphicsLabel");
    const selAud = mkTarget("targetAudioMixerLabel");
    const adEnabled = h("input", { type: "checkbox", id: "adEnabled", onchange: (e) => setParam("adBreakEnabled", e.target.checked) });
    const selAd = mkTarget("adBreakTarget");
    const adSec = h("details", { class: "sec" },
      h("summary", {}, T("sec.ads")),
      h("div", { class: "body targets" },
        h("label", { style: "flex-direction:row;align-items:center;gap:6px" }, adEnabled, T("ad.enabled")),
        h("label", {}, T("ad.target"), selAd),
        h("label", {}, T("ad.preroll"), h("input", { type: "number", min: "1000", max: "60000", step: "100", id: "adPreRoll", onchange: (e) => setParam("adBreakPreRollMs", Math.max(1000, Number(e.target.value) || 1000)) })),
        h("div", { class: "hint", style: "grid-column:1/-1" }, T("ad.hint"))));
    const targetsSec = h("details", { class: "sec" },
      h("summary", {}, T("sec.targets")),
      h("div", { class: "body targets" },
        h("label", {}, T("tgt.a"), selA), h("label", {}, T("tgt.b"), selB), h("label", {}, T("tgt.mixer"), selMix),
        h("label", {}, T("tgt.gfx"), selGfx), h("label", {}, T("tgt.audio"), selAud),
        h("label", {}, T("tgt.preflight"), h("input", { type: "number", min: "0", id: "preflightWin", onchange: (e) => setParam("preflightWindowMin", Number(e.target.value) || 0) })),
        h("label", {}, T("tgt.filler"), h("input", { type: "text", id: "defaultFiller", onchange: (e) => setParam("defaultFiller", e.target.value.trim()) }))));
    const fillTargets = (sel, labels, cur) => {
      const all = cur && !labels.includes(cur) ? [cur, ...labels] : labels;
      const key = JSON.stringify(all);
      if (sel.dataset.k !== key) {
        sel.dataset.k = key;
        sel.replaceChildren(h("option", { value: "" }, T("choose")), ...all.map((l) => h("option", { value: l }, l)));
      }
      if (shadow.activeElement !== sel) sel.value = cur || "";
    };

    // ---- Playlist -------------------------------------------------------
    const listEl = h("div", { class: "pl-list" });
    const emptyEl = h("div", { class: "empty" }, T("emptyList"));
    // Zusätzliche, wählbare Spalten (⚙): alle standardmäßig aus, Auswahl wird je Browser gemerkt.
    const baseName = (p) => String(p || "").split("/").pop();
    const mediaOf = (it) => {
      if (it.asset) return it.file ? baseName(it.file) : it.asset.assetId;
      if (it.sourceSelector) return it.resolvedLabel || T("noSource");
      if (it.senderId) return it.resolvedLabel || it.senderId;
      if (it.file) return baseName(it.file);
      if (it.eventType === "JUMP") return `→ ${items.find((x) => x.id === it.jumpTarget)?.label || it.jumpTarget}`;
      return it.pattern || "";
    };
    const mediaIdOf = (it) => (it.asset ? it.asset.assetId : it.senderId || (it.sourceSelector ? (it.sourceSelector.required || []).join(",") : "") || "");
    const fmtGap = (ms) => `${ms < 0 ? "−" : "+"}${(Math.abs(ms) / 1000).toFixed(1)}s`;
    const EXTRA_COLS = [
      { k: "type", t: T("col.type"), w: "62px", get: (it) => ({ text: it.eventType || "" }) },
      { k: "media", t: T("col.media"), w: "minmax(110px,1fr)", get: (it) => ({ text: mediaOf(it), tip: describe(it) }) },
      { k: "mediaid", t: T("col.mediaId"), w: "minmax(90px,.8fr)", get: (it) => ({ text: mediaIdOf(it), tip: mediaIdOf(it) }) },
      { k: "transition", t: T("col.transition"), w: "92px", get: (it) => ({ text: TRANSITION_LABEL[it.transition] ? `${TRANSITION_LABEL[it.transition]}${it.transition !== "cut" && it.transitionRateFrames ? ` ${it.transitionRateFrames}f` : ""}` : "Cut" }) },
      { k: "starttype", t: T("col.start"), w: "92px", get: (it) => ({ text: it.startType === "fixtime" ? `⏰ ${it.startAt ? formatLocalStart(it.startAt) : it.fixtimeHms || ""}` : it.startType === "manual" ? T("manual") : T("sequence") }) },
      { k: "player", t: T("col.player"), w: "52px", get: (it, i) => playerOf(it, i) },
      { k: "status", t: T("col.status"), w: "78px", get: (it, i) => statusOf(it, i) },
      { k: "gap", t: T("col.gap"), w: "84px", get: (it, i) => gapOf(i) },
      { k: "audio", t: T("col.audio"), w: "150px", get: (it) => {
        const plan = planOf(it);
        const rows = plan ? planRows(plan) : [];
        const warn = rows.some((r) => r.rule || r.failed || r.warnings.length);
        const base = it.audioMapping ? mappingLabel(it.audioMapping) : it.audio ? it.audio.resolution?.chosen || "—" : "";
        const tip = rows.length ? rows.map((r) => `${r.label}: ${r.text}${r.warnings.length ? `\n   ⚠ ${r.warnings.join("\n   ⚠ ")}` : ""}`).join("\n") : it.audioMapping ? T("audioTip", { label: mappingLabel(it.audioMapping) }) : "";
        return { text: (base || (rows.length ? T("standard") : "")) + (warn ? " ⚠" : ""), cls: warn ? "gap-neg" : "", tip };
      } },
      { k: "kids", t: T("col.child"), w: "46px", get: (it) => ({ text: (it.children || []).length ? String(it.children.length) : "" }) },
      { k: "ready", t: T("col.ready"), w: "92px", get: (it) => ({ text: it.asset ? (it.readiness || "UNKNOWN") : (it.available ?? true) ? "" : T("unavailable"), tip: it.readinessDetail || "" }) },
    ];
    let liveCh = "a";
    // Audio-Spiegel der Kanal-Player (Plan je Kanal, Zielgruppen, Zuordnungsvorlagen).
    let audioPlans = { a: null, b: null };
    let audioGroups = [];
    let audioMappings = [];
    const mappingLabel = (id) => (audioMappings.find((m) => m.id === id) || {}).label || id;
    // Plan des Players, der dieses Event gerade abspielt bzw. vorbereitet hat (sonst null: erst beim Cue aufgelöst).
    const planOf = (it) => {
      if (it.id === currentItemId) return audioPlans[liveCh];
      if (it.id === cuedItemId) return audioPlans[liveCh === "a" ? "b" : "a"];
      return null;
    };
    // Plan → lesbare Zeilen je Zielgruppe: aus welchen Quellspuren, per welcher Ersatzregel, oder still.
    const planRows = (plan) => (plan.groups || []).map((g) => {
      const tracks = new Set();
      g.matrix.forEach((row) => row.forEach((c, col) => { if (c) tracks.add(plan.src_channels[col].track); }));
      const label = (audioGroups.find((x) => x.id === g.group) || {}).label || g.group;
      const mixed = g.matrix.some((row) => row.filter((c) => c).length > 1 || row.some((c) => c && c !== 1));
      return {
        label,
        silent: g.silent,
        rule: g.rule,
        failed: g.failed,
        text: g.silent ? T("silent") : `${T("track", { tracks: [...tracks].sort((a, b) => a - b).join(", ") })}${mixed ? T("mixedSuffix") : ""}${g.rule ? T("ruleSuffix", { rule: g.rule }) : ""}`,
        warnings: g.warnings || [],
      };
    });
    const itemIndex = (id) => items.findIndex((x) => x.id === id);
    const statusOf = (it, i) => {
      const cur = itemIndex(currentItemId);
      if (it.id === currentItemId) return { text: "ON AIR", cls: "st-onair" };
      if (it.id === cuedItemId) return { text: "CUED", cls: "st-cued" };
      if (cur >= 0 && i < cur) return { text: T("st.played"), cls: "st-played" };
      if (it.asset && it.readiness === "NOT_READY") return { text: T("st.notReady"), cls: "st-bad" };
      if (!(it.available ?? true)) return { text: T("st.missing"), cls: "st-bad" };
      return { text: T("st.planned") };
    };
    // A/B wechseln je ladendem Event; Steuer-Events (HOLD/JUMP) laden nichts. Exakt nur für ON AIR/CUED, sonst abgeleitet (~).
    const playerOf = (it, i) => {
      if (it.eventType === "HOLD" || it.eventType === "JUMP") return { text: "" };
      const letter = (c) => c.toUpperCase();
      const other = (c) => (c === "a" ? "b" : "a");
      if (it.id === currentItemId) return { text: letter(liveCh) };
      if (it.id === cuedItemId) return { text: letter(other(liveCh)) };
      const cur = itemIndex(currentItemId);
      if (cur < 0) return { text: "" };
      const lo = Math.min(cur, i), hi = Math.max(cur, i);
      let hops = 0;
      for (let k = lo + 1; k <= hi; k++) if (items[k].eventType !== "HOLD" && items[k].eventType !== "JUMP") hops++;
      return { text: `~${letter(hops % 2 === 0 ? liveCh : other(liveCh))}`, tip: T("playerTip") };
    };
    const gapOf = (i) => {
      if (i === 0) return { text: "" };
      const a = planById.get(items[i - 1].id), b = planById.get(items[i].id);
      let gap = null;
      if (a && b && a.end && b.start) gap = Date.parse(b.start) - Date.parse(a.end);
      else {
        const ta = timeByIndex.get(i - 1), tb = timeByIndex.get(i);
        if (ta && tb) gap = tb.startMs - ta.endMs;
      }
      if (gap === null || Number.isNaN(gap)) return { text: "" };
      if (Math.abs(gap) < 50) return { text: "0", tip: T("seamless") };
      return gap > 0 ? { text: fmtGap(gap), tip: T("gapTip", { s: (gap / 1000).toFixed(1) }) } : { text: fmtGap(gap), cls: "gap-neg", tip: T("overlapTip", { s: (-gap / 1000).toFixed(1) }) };
    };
    const hdr = h("div", { class: "pl-hdr pl-cols" },
      ...[["", ""], ["#", ""], ["", ""], [T("col.title"), ""], [T("col.dur"), "c-dur"], [T("col.time"), "c-time"], [T("col.rem"), "c-rem"]].map(([t, c]) => h("span", { class: c }, t)),
      ...EXTRA_COLS.map((c) => h("span", { class: `c-${c.k}` }, c.t)),
      h("span", {}, ""), h("span", {}, ""));
    const searchInput = h("input", { type: "search", placeholder: T("search"), oninput: () => { search = searchInput.value.trim().toLowerCase(); renderList(); } });
    const colsPop = h("div", { class: "cols-pop" },
      ...[["dur", T("col.dur")], ["time", T("col.time")], ["rem", T("col.rem")]].map(([k, t]) =>
        h("label", {}, h("input", { type: "checkbox", checked: !prefs[`hide-${k}`], onchange: (e) => { prefs[`hide-${k}`] = !e.target.checked; savePrefs(); applyCols(); } }), t)),
      ...EXTRA_COLS.map((c) =>
        h("label", {}, h("input", { type: "checkbox", checked: !!prefs[`show-${c.k}`], onchange: (e) => { prefs[`show-${c.k}`] = e.target.checked; savePrefs(); applyCols(); renderList(); } }), c.t)));
    const colsBtn = h("button", { title: T("columns"), onclick: () => colsPop.classList.toggle("show") }, "⚙");
    const applyCols = () => {
      for (const k of ["dur", "time", "rem"]) plMain.classList.toggle(`hide-${k}`, !!prefs[`hide-${k}`]);
      for (const c of EXTRA_COLS) plMain.classList.toggle(`hide-${c.k}`, !prefs[`show-${c.k}`]);
      const parts = ["16px", "26px", "22px", "minmax(150px,1.4fr)"];
      if (!prefs["hide-dur"]) parts.push("54px");
      if (!prefs["hide-time"]) parts.push("108px");
      if (!prefs["hide-rem"]) parts.push("84px");
      for (const c of EXTRA_COLS) if (prefs[`show-${c.k}`]) parts.push(c.w);
      parts.push("40px", "92px");
      plMain.style.setProperty("--cols", parts.join(" "));
      // Mindestbreite der Tabelle: reicht der Platz nicht, scrollt sie waagerecht statt Spalten zu quetschen.
      const minw = parts.reduce((a, p) => a + (Number((/(\d+)px/.exec(p) || [0, 0])[1]) || 0), 0) + parts.length * 4 + 12;
      plMain.style.setProperty("--minw", `${minw}px`);
    };
    const sidebar = h("div", { class: "sidebar" },
      h("button", { class: "primary", title: T("newEvent"), onclick: () => openEditor(null) }, "＋"),
      h("button", { title: T("addMedia"), onclick: () => openMediaPicker() }, "📂"),
      h("button", { title: T("checkReady"), onclick: () => checkReadiness() }, "✓"));
    const plMain = h("div", { class: "pl-main" },
      h("div", { class: "pl-tools", style: "position:relative" }, searchInput, colsBtn, colsPop),
      hdr, listEl, emptyEl);
    const playlistSec = h("details", { class: "sec", open: true },
      h("summary", {}, T("sec.playlist")),
      h("div", { class: "body" }, h("div", { class: "pl-wrap" }, sidebar, plMain)));

    // ---- Assets / Carts --------------------------------------------------
    const cartBanner = h("div", { class: "cart-banner" });
    const cartBannerLabel = h("span");
    cartBanner.append(cartBannerLabel, h("button", { onclick: () => act("cart.return", {}) }, "RETURN"));
    const cartGrid = h("div", { class: "cart-grid" });
    const cartsSec = h("details", { class: "sec", open: true },
      h("summary", {}, T("sec.carts")),
      h("div", { class: "body" },
        cartBanner, cartGrid,
        h("div", { style: "margin-top:8px" }, h("button", { onclick: () => openCartManager() }, T("manageAssets")))));

    // ---- Channel-Trigger (unverändert in der Funktion) -------------------
    const mkSelect = (options) => h("select", {}, ...options.map(([v, t]) => h("option", { value: v }, t)));
    const trEvent = mkSelect(TRIGGER_EVENTS.map((e) => [e, e]));
    const trKind = mkSelect([["group", T("tr.group")], ["channel", T("tr.channel")], ["all", T("tr.all")]]);
    const trTarget = h("input", { type: "text", placeholder: T("tr.targetPh") });
    const trItem = h("input", { type: "text", placeholder: T("tr.itemPh") });
    const trLate = mkSelect([["EXECUTE_IMMEDIATELY", T("tr.lateNow")], ["SKIP", T("tr.lateSkip")], ["RESYNC", T("tr.lateResync")], ["QUEUE", T("tr.lateQueue")]]);
    const trAt = h("input", { type: "text", placeholder: T("tr.atPh"), style: "width:170px" });
    trKind.addEventListener("change", () => { trTarget.style.display = trKind.value === "all" ? "none" : ""; });
    const trSend = h("button", {
      onclick: async () => {
        const event = trEvent.value;
        const at = trAt.value.trim() ? parseStartInput(trAt.value) : "";
        if (trAt.value.trim() && !at) return showBanner(T("tr.badTime"));
        const who = trKind.value === "all" ? T("tr.allChannels") : T(trKind.value === "group" ? "tr.whoGroup" : "tr.whoChannel", { name: trTarget.value });
        if (!(await confirmDialog(T("tr.confirm", { event, who }), T("tr.send")))) return;
        act("sendTrigger", {
          event, targetKind: trKind.value, target: trTarget.value.trim(),
          argsJson: event === "JUMP" ? JSON.stringify({ itemId: trItem.value.trim() }) : "",
          targetTime: at || "", relativeOffsetMs: "0", latePolicy: trLate.value,
        });
      },
    }, T("tr.send"));
    const trLog = h("div", { style: "font:11px monospace;color:#bbb;max-height:140px;overflow:auto;margin-top:6px" }, T("tr.none"));
    const triggerSec = h("details", { class: "sec" },
      h("summary", {}, T("sec.trigger")),
      h("div", { class: "body" }, h("div", { class: "ctrl" }, trEvent, trKind, trTarget, trItem, trAt, trLate, trSend), trLog));

    shadow.append(h("style", {}, STYLE), head, nextFixEl, planWarnEl, banner, controlSec, playlistSec, cartsSec, triggerSec, adSec, targetsSec);
    plMain.style.setProperty("--cols", "");
    applyCols();
    // Spalten-Template an die Zeilen weitergeben
    const colStyle = h("style", {}, ".pl-cols, .pl-row { grid-template-columns: var(--cols); }");
    shadow.append(colStyle);
    shadow.append(h("style", {}, EXTRA_COLS.map((c) => `.hide-${c.k} .c-${c.k} { display: none; }`).join("\n")));

    // ---- Helfer ---------------------------------------------------------
    const srcIcon = (it) => {
      if (it.icon) return it.icon;
      if (it.eventType === "HOLD") return "⏸";
      if (it.eventType === "JUMP") return "↪";
      if (it.eventType === "IMAGE") return "🖼";
      if (it.asset) return "📦";
      if (it.sourceSelector) return "🏷";
      return it.senderId ? "📡" : it.file ? "📁" : "🎨";
    };
    const describe = (it) => {
      if (it.eventType === "HOLD") return T("describe.hold");
      if (it.eventType === "JUMP") {
        const t = items.find((x) => x.id === it.jumpTarget);
        return `JUMP → ${t ? t.label : it.jumpTarget}`;
      }
      if (it.asset) return `Asset ${it.asset.assetId}${it.file ? ` → ${it.file}` : ""}`;
      if (it.eventType === "IMAGE") return T("describe.still", { file: it.file });
      if (it.sourceSelector) return T("describe.liveTags", { tags: (it.sourceSelector.required || []).join(", "), label: it.resolvedLabel || T("describe.noMatch") });
      if (it.senderId) return T("describe.live", { id: it.senderId });
      if (it.file) return T("describe.file", { file: it.file });
      return T("describe.pattern", { pattern: it.pattern });
    };
    const checkReadiness = () => {
      const a = items.filter((i) => i.asset);
      if (a.length === 0) return showBanner(T("noAssetEvents"), true);
      const c = (f) => a.filter(f).length;
      const bad = items.filter((i) => !(i.available ?? true)).length;
      showBanner(T("readinessSummary", { n: a.length, ready: c((i) => i.readiness === "READY"), transfer: c((i) => i.readinessState === "TRANSFERRING"), notReady: c((i) => i.readiness === "NOT_READY" && i.readinessState !== "TRANSFERRING"), bad: bad ? T("readinessBad", { n: bad }) : "" }), true);
    };

    // ---- Liste rendern ---------------------------------------------------
    const rowEls = new Map(); // itemId -> { wrap, row, refs… }
    let dropLine = null;

    const removeItems = async (ids) => {
      const del = ids.filter((id) => id !== currentItemId);
      if (del.length === 0) return;
      const names = del.map((id) => items.find((i) => i.id === id)).filter(Boolean).map((i) => `„${i.label}“`);
      const msg = del.length === 1 ? T("removeOne", { name: names[0] }) : T("removeMany", { n: del.length, names: names.slice(0, 3).join(", "), more: names.length > 3 ? " …" : "" });
      if (!(await confirmDialog(msg, T("remove")))) return;
      for (const id of del) {
        try { await call("remove", { itemId: id }); selected.delete(id); } catch { break; }
      }
      poll();
    };

    const select = (id, ev) => {
      if (ev && (ev.ctrlKey || ev.metaKey)) {
        if (selected.has(id)) selected.delete(id); else selected.add(id);
      } else if (ev && ev.shiftKey && lastClickedId) {
        const a = items.findIndex((i) => i.id === lastClickedId);
        const b = items.findIndex((i) => i.id === id);
        selected.clear();
        for (let k = Math.min(a, b); k <= Math.max(a, b); k++) if (items[k]) selected.add(items[k].id);
      } else {
        selected.clear();
        selected.add(id);
      }
      lastClickedId = id;
      renderList();
    };

    // Drag&Drop-Reorder (Pointer-Events, funktioniert mit Maus und Finger): echte serverseitige
    // `moveItem`-Umsortierung — der Cursor (on-air/gecued) folgt dem Event, kein Schwarzbild.
    const startDrag = (itemId, ev, rowEl) => {
      if (search) return showBanner(T("noReorderSearch"), true);
      ev.preventDefault();
      dragging = true;
      const handle = ev.currentTarget;
      handle.setPointerCapture(ev.pointerId);
      rowEl.classList.add("dragging");
      let insertAt = null;
      const visible = () => items.filter((i) => rowEls.has(i.id)).map((i) => rowEls.get(i.id).wrap);
      const move = (e) => {
        const wraps = visible();
        let ins = wraps.length;
        let y = null;
        for (let k = 0; k < wraps.length; k++) {
          const r = wraps[k].querySelector(".pl-row").getBoundingClientRect();
          if (e.clientY < r.top + r.height / 2) { ins = k; break; }
        }
        insertAt = ins;
        const lr = listEl.getBoundingClientRect();
        if (ins < wraps.length) y = wraps[ins].querySelector(".pl-row").getBoundingClientRect().top - lr.top;
        else if (wraps.length) y = wraps[wraps.length - 1].getBoundingClientRect().bottom - lr.top;
        if (!dropLine) { dropLine = h("div", { class: "drop-line" }); listEl.style.position = "relative"; listEl.append(dropLine); }
        dropLine.style.top = `${y ?? 0}px`;
      };
      const end = (e) => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        rowEl.classList.remove("dragging");
        if (dropLine) { dropLine.remove(); dropLine = null; }
        dragging = false;
        if (e.type === "pointerup" && insertAt !== null) {
          const from = items.findIndex((i) => i.id === itemId);
          const to = insertAt > from ? insertAt - 1 : insertAt;
          if (from >= 0 && to !== from) {
            // lokal sofort umordnen (kein Flackern), der Poll bestätigt
            const [m] = items.splice(from, 1);
            items.splice(to, 0, m);
            renderList();
            act("moveItem", { itemId, toIndex: to });
            return;
          }
        }
        poll();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    };

    const makeRow = (it) => {
      const wrap = h("div", { class: "pl-rowwrap" });
      const row = h("div", { class: "pl-row pl-cols" });
      const refs = { wrap, row, it };
      refs.drag = h("span", { class: "drag", title: T("dragTitle"), onpointerdown: (e) => startDrag(refs.it.id, e, row) }, "⠿");
      refs.num = h("span", { class: "num" });
      refs.ico = h("span", { class: "ico" });
      refs.dot = h("span", { class: "dot" });
      refs.text = h("span", { class: "txt", style: "overflow:hidden;text-overflow:ellipsis" });
      refs.chips = h("span", { class: "chips" });
      refs.title = h("span", { class: "title" }, refs.dot, refs.text, refs.chips);
      refs.dur = h("span", { class: "dur c-dur" });
      refs.time = h("span", { class: "time c-time" });
      refs.remTxt = h("span", { class: "txt" });
      refs.remBar = h("span", {});
      refs.rem = h("span", { class: "rem c-rem" }, refs.remTxt, h("span", { class: "rbar" }, refs.remBar));
      refs.av = h("span", { class: "av" });
      refs.cueBtn = h("button", { title: T("cueTake"), onclick: async (e) => {
        e.stopPropagation();
        try { await call("cue", { itemId: refs.it.id }); await call("take", {}); } catch { /* Banner */ }
        poll();
      } }, "▶");
      refs.editBtn = h("button", { title: T("editProps"), onclick: (e) => { e.stopPropagation(); openEditor(refs.it); } }, "✎");
      refs.delBtn = h("button", { class: "danger", title: T("removeEvent"), onclick: (e) => { e.stopPropagation(); removeItems([refs.it.id]); } }, "✕");
      refs.acts = h("span", { class: "acts" }, refs.cueBtn, refs.editBtn, refs.delBtn);
      refs.xc = {};
      for (const c of EXTRA_COLS) refs.xc[c.k] = h("span", { class: `xc c-${c.k}` });
      row.append(refs.drag, refs.num, refs.ico, refs.title, refs.dur, refs.time, refs.rem, ...EXTRA_COLS.map((c) => refs.xc[c.k]), refs.av, refs.acts);
      row.addEventListener("click", (e) => select(refs.it.id, e));
      row.addEventListener("dblclick", () => openEditor(refs.it));
      refs.kids = h("div", { class: "kids" });
      wrap.append(row, refs.kids);
      return refs;
    };

    let planById = new Map();
    let timeByIndex = new Map();
    let playheadMs = 0;
    let durationMs = 0;

    const renderList = () => {
      if (dragging) return;
      const q = search;
      const ids = new Set(items.map((i) => i.id));
      for (const [id, r] of rowEls) if (!ids.has(id)) { r.wrap.remove(); rowEls.delete(id); }
      let shown = 0;
      items.forEach((it, i) => {
        let r = rowEls.get(it.id);
        if (!r) { r = makeRow(it); rowEls.set(it.id, r); }
        r.it = it;
        const match = !q || `${it.label} ${describe(it)} ${it.note || ""}`.toLowerCase().includes(q);
        r.wrap.style.display = match ? "" : "none";
        if (match) shown++;
        const isOn = it.id === currentItemId;
        const isCued = it.id === cuedItemId;
        r.row.className = `pl-row pl-cols${isOn ? " onair" : isCued ? " cued" : ""}${selected.has(it.id) ? " sel" : ""}` +
          `${it.startType === "fixtime" ? " fix" : it.startType === "manual" ? " manual" : ""}`;
        const blk = adBlocks.find((b) => b.ids.includes(it.id));
        if (blk) {
          const pos = blk.ids.indexOf(it.id);
          r.row.classList.add("adb");
          if (pos === 0) r.row.classList.add("adb-first");
          if (pos === blk.ids.length - 1) r.row.classList.add("adb-last");
          if (blk.open) r.row.classList.add("adb-open");
          r.row.dataset.ad = it.adClass || "";
        } else { r.row.classList.remove("adb", "adb-first", "adb-last", "adb-open"); delete r.row.dataset.ad; }
        r.num.textContent = String(i + 1);
        r.ico.textContent = srcIcon(it);
        r.dot.style.background = it.color || "transparent";
        r.text.textContent = it.label;
        r.title.title = describe(it) + (it.note ? `\n${it.note}` : "") +
          (blk ? "\n" + T("adBlockTip", { n: blk.ids.indexOf(it.id) + 1, total: blk.ids.length, dur: blk.durationMs ? ` · ${tcFormat(blk.durationMs, TC_FPS)}` : "" }) + (blk.open ? ` · ${T("ad.open")}` : "") : "");
        r.dur.textContent = it.eventType === "HOLD" || it.eventType === "JUMP" ? "" : tcFormat(it.durationMs, TC_FPS);
        const plan = planById.get(it.id);
        const t = timeByIndex.get(i);
        const rel = t ? `${fmtMs(t.startMs)}–${fmtMs(t.endMs)}` : "";
        const warn = plan && plan.warnings && plan.warnings.length > 0;
        r.time.textContent = ((plan && plan.start ? formatLocalStart(plan.start) : rel) || "") + (warn ? " ⚠" : "");
        r.time.style.color = warn ? "var(--warn)" : "";
        r.time.title = [
          plan && plan.start ? T("plannedAt", { from: formatLocalStart(plan.start), to: plan.end ? formatLocalStart(plan.end) : T("open"), anchored: plan.anchored ? T("anchored") : "" }) : "",
          rel ? T("fromStart", { rel }) : "",
          ...(warn ? plan.warnings.map((w) => `⚠ ${w}`) : []),
        ].filter(Boolean).join("\n");
        if (isOn && durationMs > 0) {
          r.remTxt.textContent = `-${tcFormat(Math.max(0, durationMs - playheadMs), TC_FPS)}`;
          r.remBar.style.width = `${Math.min(100, (100 * playheadMs) / durationMs)}%`;
        } else { r.remTxt.textContent = ""; r.remBar.style.width = "0"; }
        // Verfügbarkeit / Bereitschaft
        let avText = (it.available ?? true) ? "✓" : "✗";
        let avBad = !(it.available ?? true);
        let avTip = avBad ? T("srcUnavailableTip") : T("srcAvailableTip");
        if (it.asset) {
          const st = it.readinessState || "";
          const pct = it.readinessProgress > 0 ? ` ${Math.round(it.readinessProgress * 100)}%` : "";
          avText = it.readiness === "READY" ? "✓" : st === "TRANSFERRING" ? `⏳${pct}` : it.readiness === "NOT_READY" ? "✗" : "?";
          avBad = it.readiness === "NOT_READY" && st !== "TRANSFERRING";
          avTip = T("assetTip", { id: it.asset.assetId, ready: it.readiness || "UNKNOWN", st: st ? ` (${st}${pct})` : "", detail: it.readinessDetail ? `\n${it.readinessDetail}` : "", onMissing: it.onMissing || "HOLD" });
        }
        r.av.textContent = avText;
        r.av.className = `av${avBad ? " bad" : ""}`;
        r.av.title = avTip;
        for (const c of EXTRA_COLS) {
          if (!prefs[`show-${c.k}`]) continue;
          const v = c.get(it, i);
          const el = r.xc[c.k];
          el.textContent = v.text || "";
          el.title = v.tip || "";
          el.className = `xc c-${c.k}${v.cls ? ` ${v.cls}` : ""}`;
        }
        r.cueBtn.disabled = isOn;
        r.delBtn.disabled = isOn;
        // Chips: Start-Typ, Transition, Kinder, Audio
        const chips = [];
        if (it.startType === "fixtime") chips.push(h("span", { class: "chip blue", title: T("fixStart") }, `⏰ ${it.startAt ? formatLocalStart(it.startAt) : it.fixtimeHms || ""}`));
        if (it.startType === "manual") chips.push(h("span", { class: "chip", style: "background:#6b5210", title: T("manualStart") }, "✋"));
        if (it.transition && it.transition !== "cut") chips.push(h("span", { class: "chip", style: "background:#1f5a28", title: T("transitionTitle", { name: TRANSITION_LABEL[it.transition] || it.transition }) }, it.transition === "mix" ? "⇄" : it.transition === "fadecut" ? "◐✂" : "✂◑"));
        const nk = (it.children || []).length;
        if (nk > 0) {
          chips.push(h("span", {
            class: "chip", style: "background:#5a3585", title: T("kidsToggle"),
            onclick: (e) => { e.stopPropagation(); if (expanded.has(it.id)) expanded.delete(it.id); else expanded.add(it.id); renderList(); },
          }, `${expanded.has(it.id) ? "▾" : "▸"} ${nk}`));
        }
        if (it.audio) {
          const res = it.audio.resolution || {};
          chips.push(h("span", { class: "chip", style: res.warnings && res.warnings.length ? "background:#7a5a10" : "", title: T("audioTitle") }, `🔊 ${res.chosen || "—"}`));
        }
        r.chips.replaceChildren(...chips);
        // Kinder darunter
        const showKids = expanded.has(it.id) && nk > 0;
        const kidKey = showKids ? JSON.stringify([it.children, childRuntime.filter((c) => c.itemId === it.id).map((c) => [c.id, c.state])]) : "";
        if (r.kidKey !== kidKey) {
          r.kidKey = kidKey;
          r.kids.replaceChildren(...(showKids ? it.children.map((c, ci) => {
            const rt = childRuntime.find((x) => x.itemId === it.id && x.id === c.id);
            return h("div", { class: "kid", onclick: () => openEditor(it, "kids", ci), title: rt && rt.error ? rt.error : T("kidClickEdit") },
              CHILD_ICON[c.type] || "•", h("span", {}, c.templateId || c.target || c.url || c.type),
              h("span", { style: "color:var(--mut)" }, timingText(c)),
              rt ? h("span", { class: `st ${rt.state}` }, rt.state) : null);
          }) : []));
        }
        r.kids.style.display = showKids ? "" : "none";
      });
      // DOM-Reihenfolge nur bei Abweichung korrigieren (Verschieben mitten im Klick würde Klicks verschlucken)
      const wraps = items.map((i) => rowEls.get(i.id).wrap);
      const cur = [...listEl.children].filter((c) => c !== dropLine);
      if (wraps.length !== cur.length || wraps.some((w, k) => w !== cur[k])) wraps.forEach((w) => listEl.append(w));
      emptyEl.style.display = items.length === 0 ? "" : "none";
      hdr.style.display = items.length === 0 ? "none" : "";
    };

    const timingText = (c) => {
      const t = c.timing || (c.relativeTo === "END" ? "RELATIVE_TO_END" : "RELATIVE_TO_START");
      const d = c.durationMs ? tcFormat(c.durationMs, TC_FPS) : T("untilEnd");
      if (t === "ABSOLUTE") return `${c.atUtc ? formatLocalStart(c.atUtc) : "?"} · ${d}`;
      if (t === "FULL_PRIMARY") return T("fullDuration");
      return `${t === "RELATIVE_TO_END" ? "−" : "+"}${tcFormat(c.delayMs || 0, TC_FPS)} · ${d}`;
    };

    // Delete-Taste (Fokus im Panel, nicht in einem Eingabefeld)
    this.addEventListener("keydown", (e) => {
      if (modalOpen) return;
      const tag = (shadow.activeElement && shadow.activeElement.tagName) || "";
      if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selected.size > 0) {
        e.preventDefault();
        removeItems([...selected]);
      }
    });

    // ---- Dialog-Grundgerüst ----------------------------------------------
    const openModal = ({ title, tabs, render, onSave, saveLabel, onClose }) => {
      modalOpen = true;
      let tab = tabs ? tabs[0][0] : null;
      const errEl = h("span", { class: "err" });
      const content = h("div", { class: "content" });
      const tabBar = tabs ? h("div", { class: "tabs" }) : null;
      const close = () => { overlay.remove(); modalOpen = false; if (onClose) onClose(); poll(); };
      const draw = () => {
        if (tabBar) tabBar.replaceChildren(...tabs.map(([k, t]) => h("button", { class: k === tab ? "act" : "", onclick: () => { tab = k; draw(); } }, t)));
        content.replaceChildren(render(tab, { redraw: draw, setTab: (k) => { tab = k; draw(); }, setError: (t) => { errEl.textContent = t; } }));
      };
      const save = async () => {
        errEl.textContent = "";
        const err = await onSave();
        if (err) errEl.textContent = err; else close();
      };
      const modal = h("div", { class: "modal" },
        h("header", {}, title, h("button", { onclick: close }, "✕")),
        tabBar, content,
        h("footer", {}, errEl, h("button", { onclick: close }, onSave ? T("cancel") : T("close")), onSave ? h("button", { class: "primary", onclick: save }, saveLabel || T("save")) : null));
      const overlay = h("div", { class: "overlay", onmousedown: (e) => { if (e.target === overlay) close(); } }, modal);
      overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); e.stopPropagation(); });
      shadow.append(overlay);
      draw();
      return { close, redraw: draw };
    };

    // Formular-Helfer: Feld an ein Objekt binden
    // Dauer-/Zeiteingaben als Timecode HH:MM:SS.FF (Bildraster TC_FPS); intern bleibt es Millisekunden.
    const bindTc = (obj, key, attrs) => {
      const inp = h("input", { type: "text", placeholder: "HH:MM:SS.FF", inputmode: "numeric", maxlength: "14", style: "width:120px;font-variant-numeric:tabular-nums", ...attrs, value: tcFormat(obj[key] || 0, TC_FPS) });
      inp.addEventListener("input", () => {
        const ms = tcParse(inp.value, TC_FPS);
        if (ms === null) { inp.setAttribute("aria-invalid", "true"); inp.style.outline = "1px solid #e55"; return; }
        inp.removeAttribute("aria-invalid"); inp.style.outline = ""; obj[key] = ms;
      });
      inp.addEventListener("blur", () => { inp.value = tcFormat(obj[key] || 0, TC_FPS); inp.removeAttribute("aria-invalid"); inp.style.outline = ""; });
      return inp;
    };
    const bindText = (obj, key, attrs) => h("input", { type: "text", ...attrs, value: obj[key] ?? "", oninput: (e) => { obj[key] = e.target.value; } });
    const bindNum = (obj, key, attrs) => h("input", { type: "number", min: "0", ...attrs, value: obj[key] ?? 0, oninput: (e) => { obj[key] = Number(e.target.value) || 0; } });
    const bindSelect = (obj, key, options, onchange) => {
      const s = h("select", { onchange: (e) => { obj[key] = e.target.value; if (onchange) onchange(); } },
        ...options.map(([v, t]) => h("option", { value: v }, t)));
      s.value = obj[key] ?? options[0][0];
      return s;
    };
    const field = (label, ...ctrl) => [h("label", {}, label), h("div", { class: "row" }, ...ctrl)];

    const mediaKindOf = (it) => {
      if (!it) return "pattern";
      if (it.asset) return "asset";
      if (it.eventType === "HOLD") return "hold";
      if (it.eventType === "JUMP") return "jump";
      if (it.eventType === "IMAGE") return "image";
      if (it.sourceSelector) return "liveselect";
      if (it.senderId) return "live";
      if (it.file) return "file";
      return "pattern";
    };
    const mediaSig = (d) => JSON.stringify([d.kind, d.pattern, d.file, d.senderId, d.tags, d.pref, d.jumpTarget, d.assetId]);
    const splitTags = (t) => (t || "").split(",").map((x) => x.trim()).filter(Boolean);

    let availableSources = [];
    // Grafik-Vorlagen des Ziel-OGraf-Nodes (targetGraphicsLabel) für die Auswahl bei Grafik-Children.
    let gfxTemplates = [];
    let gfxLabel = "";
    let gfxAt = 0;
    const loadGfxTemplates = async () => {
      if (!gfxLabel || Date.now() - gfxAt < 10000) return;
      gfxAt = Date.now();
      try {
        const nodes = await fetch("/api/v1/nodes").then((r) => (r.ok ? r.json() : []));
        const g = nodes.find((n) => n.label === gfxLabel && n.online);
        if (!g) { gfxTemplates = []; return; }
        const res = await fetch(`/api/v1/nodes/${g.id}/params/templates`);
        if (res.ok) gfxTemplates = ((await res.json()).value || []).slice().sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));
      } catch { /* Auswahl bleibt leer, Texteingabe geht weiter */ }
    };
    // Bekannte Tags aller Videoquellen (Tag → Quellennamen) für die Auswahl im Tag-Typ.
    let tagCatalog = [];
    let tagCatalogAt = 0;
    const loadTagCatalog = async () => {
      if (Date.now() - tagCatalogAt < 10000) return;
      tagCatalogAt = Date.now();
      try {
        const res = await fetch("/api/v1/sources?mediaType=video");
        if (!res.ok) return;
        const by = new Map();
        for (const src of await res.json()) for (const t of src.tags || []) {
          const name = typeof t === "string" ? t : t.tag;
          if (!by.has(name)) by.set(name, []);
          by.get(name).push(src.label);
        }
        tagCatalog = [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      } catch { /* Auswahl bleibt leer, Texteingabe geht weiter */ }
    };

    // ---- Event-Editor ----------------------------------------------------
    const newKid = (n) => ({ id: `c${n}`, type: "GRAPHIC", timing: "RELATIVE_TO_START", delayMs: 0, durationMs: 0, templateId: "", failurePolicy: "WARN" });
    function openEditor(item, startTab, startKid) {
      const isNew = !item;
      const onAir = !!item && item.id === currentItemId;
      const d = {
        kind: mediaKindOf(item), label: item ? item.label : "", note: item?.note || "", adClass: item?.adClass || "", icon: item?.icon || "", color: item?.color || "",
        pattern: item?.pattern || "smpte", file: item?.file || "", senderId: item?.senderId || "",
        tags: item?.sourceSelector ? (item.sourceSelector.required || []).join(", ") : "", pref: item?.sourceSelector ? (item.sourceSelector.preferred || []).join(", ") : "",
        jumpTarget: item?.jumpTarget || "", assetId: item?.asset?.assetId || "", onMissing: item?.onMissing || "HOLD", fallbackFile: item?.fallbackFile || "",
        durationMs: item ? item.durationMs : 5000,
        startType: item?.startType || "sequence",
        startLocal: item?.startAt ? new Date(item.startAt).toLocaleString("sv-SE") : item?.fixtimeHms || "",
        transition: item?.transition || "cut", rateFrames: item?.transitionRateFrames ?? "",
        audioCap: item?.audio?.intent?.capability || "",
        audioMapping: item?.audioMapping || "",
      };
      const origSig = mediaSig(d);
      const origDur = d.durationMs;
      const kids = JSON.parse(JSON.stringify(item?.children || []));
      let kidIdx = Math.min(startKid ?? 0, kids.length - 1);

      const durationEditable = () => ["pattern", "image", "live", "liveselect"].includes(d.kind);

      const renderContent = (ctx) => {
        const f = h("div", { class: "form" });
        f.append(...field(T("ed.title"), bindText(d, "label", { placeholder: T("ed.title") })));
        f.append(...field(T("ed.type"), bindSelect(d, "kind", MEDIA_KINDS, ctx.redraw)));
        if (onAir) f.querySelectorAll("select").forEach((s) => { s.disabled = true; });
        const dis = onAir ? { disabled: "" } : {};
        switch (d.kind) {
          case "pattern": f.append(...field(T("ed.pattern"), bindSelect(d, "pattern", PATTERNS.map((p) => [p, p])))); break;
          case "file": case "image": {
            const files = d.file && !mediaLibrary.includes(d.file) ? [d.file, ...mediaLibrary] : mediaLibrary;
            f.append(...field(T("ed.file"), bindSelect(d, "file", [["", T("ed.chooseFile")], ...files.map((x) => [x, x])])));
            break;
          }
          case "live": {
            const known = availableSources.map((s) => [s.senderId, s.label]);
            if (d.senderId && !known.some(([id]) => id === d.senderId)) known.unshift([d.senderId, d.senderId]);
            f.append(...field(T("ed.liveSource"), bindSelect(d, "senderId", [["", T("ed.chooseSource")], ...known])));
            break;
          }
          case "liveselect":
            // Textfeld + Auswahl bekannter Tags: Auswahl hängt das Tag an die kommagetrennte Liste an.
            const tagRow = (key, ph) => {
              const inp = bindText(d, key, { placeholder: ph });
              const sel = h("select", { onchange: (e) => {
                const t = e.target.value;
                if (t && !splitTags(d[key]).includes(t)) d[key] = [...splitTags(d[key]), t].join(", ");
                inp.value = d[key];
                e.target.value = "";
              } }, h("option", { value: "" }, T("ed.pickTag")),
              ...tagCatalog.map(([t, names]) => h("option", { value: t }, `${t} (${names.join(", ")})`)));
              return [inp, sel];
            };
            f.append(...field(T("ed.reqTags"), ...tagRow("tags", T("ed.tagsPh"))));
            f.append(...field(T("ed.preferred"), ...tagRow("pref", T("ed.optional"))));
            f.append(...field(T("ed.resolvedTo"), h("span", { text: item?.resolvedLabel || T("noSource") })));
            f.append(h("div", { class: "hint", text: T("ed.tagHint") }));
            break;
          case "jump":
            f.append(...field(T("ed.jumpTarget"), bindSelect(d, "jumpTarget", [["", T("ed.chooseEvent")], ...items.filter((x) => x.eventType !== "JUMP" && x.id !== item?.id).map((x) => [x.id, `${items.indexOf(x) + 1}. ${x.label}`])])));
            break;
          case "asset":
            f.append(...field(T("ed.assetId"), bindText(d, "assetId", { placeholder: T("ed.assetIdPh") })));
            f.append(...field(T("ed.ifMissing"), bindSelect(d, "onMissing", MISSING_POLICIES)));
            f.append(...field(T("ed.fallbackFile"), bindText(d, "fallbackFile", { placeholder: T("ed.fallbackPh") })));
            break;
          default: break;
        }
        if (durationEditable()) f.append(...field(T("ed.durationMs"), bindTc(d, "durationMs", dis)));
        else if (d.kind === "file" || d.kind === "asset") f.append(h("div", { class: "hint" }, T("ed.durationHint")));
        if (onAir) f.append(h("div", { class: "hint" }, T("ed.onAirHint")));
        f.append(...field(T("ed.note"), bindText(d, "note", { placeholder: T("ed.notePh") })));
        f.append(...field(T("ed.adClass"), bindSelect(d, "adClass", [["", T("ed.adNone")], ["commercial", T("ed.adCommercial")], ["promo", T("ed.adPromo")], ["block_start", T("ed.adStart")], ["block_end", T("ed.adEnd")]])));
        const color = h("input", { type: "color", value: d.color || "#4a90d9", oninput: (e) => { d.color = e.target.value; } });
        f.append(...field(T("ed.iconColor"), bindText(d, "icon", { placeholder: T("ed.emoji"), style: "width:80px" }), color,
          h("button", { onclick: () => { d.color = ""; color.value = "#4a90d9"; } }, T("ed.clearColor"))));
        return f;
      };

      const renderTiming = () => {
        const f = h("div", { class: "form" });
        const startInput = bindText(d, "startLocal", { placeholder: T("ed.startPh") });
        const startRow = field(T("ed.startTime"), startInput);
        const sync = () => { startRow.forEach((e) => { e.style.display = d.startType === "fixtime" ? "" : "none"; }); };
        f.append(...field(T("ed.start"), bindSelect(d, "startType", [["sequence", T("ed.startSeq")], ["manual", T("ed.startManual")], ["fixtime", T("ed.startFix")]], sync)));
        f.append(...startRow);
        sync();
        const rate = bindText(d, "rateFrames", { placeholder: T("ed.rampPh") });
        const rateRow = field(T("ed.ramp"), rate);
        const syncT = () => { rateRow.forEach((e) => { e.style.display = d.transition && d.transition !== "cut" ? "" : "none"; }); };
        f.append(...field(T("ed.transition"), bindSelect(d, "transition", [["cut", "✂ Cut"], ["mix", T("ed.trMix")], ["vfade", T("ed.trVfade")], ["fadecut", T("ed.trFadecut")], ["cutfade", T("ed.trCutfade")]], syncT)));
        f.append(...rateRow);
        syncT();
        return f;
      };

      const renderAudio = () => {
        const f = h("div", { class: "form" });
        if (d.kind !== "hold" && d.kind !== "jump") {
          f.append(...field(T("ed.audioMapping"), bindSelect(d, "audioMapping", [["", T("ed.audioStd")], ...audioMappings.map((m) => [m.id, m.label || m.id])])));
          f.append(h("div", { class: "hint" }, T("ed.audioMappingHint")));
          const plan = item ? planOf(item) : null;
          if (plan) {
            const t = h("div", { class: "hint" });
            planRows(plan).forEach((r) => t.append(h("div", { style: r.failed ? "color:var(--err,#ff6b6b)" : r.rule ? "color:var(--warn)" : r.silent ? "color:var(--mut)" : "" }, `${r.label}: ${r.text}`)));
            plan.warnings.forEach((w) => t.append(h("div", { style: "color:var(--warn)" }, `⚠ ${w}`)));
            f.append(h("label", {}, T("ed.resolvedPlan")), t);
          } else f.append(h("div", { class: "hint" }, T("ed.planLater")));
        }
        const a = item?.audio;
        if (!a) {
          f.append(h("div", { class: "hint" }, isNew ? T("ed.audioAfterCreate") : T("ed.audioLiveOnly")));
          return f;
        }
        const layoutName = (l) => (typeof l === "string" ? l : l && l.other != null ? T("ed.channelsN", { n: l.other }) : "?");
        f.append(...field(T("ed.audioFrom", { source: a.source }), bindSelect(d, "audioCap", [["", T("ed.audioAuto")], ...(a.capabilities || []).map((c) => [c.id, `${c.id} (${layoutName(c.layout)})${c.isDefault ? T("ed.default") : ""}`])])));
        const res = a.resolution || {};
        f.append(h("div", { class: "hint" }, T("ed.currentChoice", { chosen: res.chosen || "—", via: res.via || "none" }), ...(res.warnings || []).map((w) => h("div", { style: "color:var(--warn)" }, `⚠ ${w}`))));
        return f;
      };

      const renderKids = (ctx) => {
        const list = h("div", { class: "kid-list" });
        kids.forEach((k, i) => list.append(h("div", { class: `it${i === kidIdx ? " act" : ""}`, onclick: () => { kidIdx = i; ctx.redraw(); } },
          CHILD_ICON[k.type] || "•", h("span", {}, k.templateId || k.target || k.url || k.type),
          h("span", { class: "x", title: T("ed.deleteKid"), onclick: (e) => { e.stopPropagation(); kids.splice(i, 1); kidIdx = Math.min(kidIdx, kids.length - 1); ctx.redraw(); } }, "✕"))));
        list.append(h("div", { class: "it", style: "color:var(--acc)", onclick: () => { kids.push(newKid(kids.length + 1)); kidIdx = kids.length - 1; ctx.redraw(); } }, T("ed.addKid")));
        const box = h("div", { class: "kid-edit" }, list, kids.length ? kidForm(kids[kidIdx], ctx) : h("div", { class: "empty" }, T("ed.kidsEmpty")));
        return box;
      };

      // Editor zur Vorlage: ein Feld je Eintrag in schema.properties, schreibt direkt in k.data.
      const templateForm = (k, tpl, ctx) => {
        const props = tpl.schema.properties;
        const req = new Set(tpl.schema.required || []);
        if (!k.data || typeof k.data !== "object" || Array.isArray(k.data)) k.data = {};
        for (const [n, p] of Object.entries(props)) if (k.data[n] === undefined && p && p.default !== undefined) k.data[n] = p.default;
        const box = h("div", { class: "form tpl-form" });
        box.append(h("div", { class: "hint", text: T("ed.tplFields", { name: tpl.label || tpl.id, n: Object.keys(props).length }) }));
        const set = (n, v) => { k.data[n] = v; };
        for (const [n, p] of Object.entries(props)) {
          const label = (p.title || n) + (req.has(n) ? " *" : "");
          const tip = p.description || "";
          let ctl;
          if (Array.isArray(p.enum)) {
            ctl = bindSelect(k.data, n, p.enum.map((e) => [String(e), String(e)]));
            ctl.addEventListener("change", () => { set(n, p.type === "integer" || p.type === "number" ? Number(ctl.value) : ctl.value); });
          } else if (p.type === "boolean") {
            ctl = h("input", { type: "checkbox", onchange: (e) => set(n, e.target.checked) });
            ctl.checked = !!k.data[n];
          } else if (p.type === "integer" || p.type === "number") {
            ctl = h("input", { type: "number", step: p.type === "integer" ? "1" : "any", oninput: (e) => { if (e.target.value !== "") set(n, Number(e.target.value)); } });
            if (p.minimum !== undefined) ctl.min = p.minimum;
            if (p.maximum !== undefined) ctl.max = p.maximum;
            ctl.value = k.data[n] ?? "";
          } else if (p.type === "array" || p.type === "object") {
            ctl = h("textarea", { oninput: (e) => { try { set(n, JSON.parse(e.target.value)); e.target.style.outline = ""; } catch { e.target.style.outline = "1px solid #e55"; } } });
            ctl.value = JSON.stringify(k.data[n] ?? (p.type === "array" ? [] : {}));
          } else {
            const isColor = /color/i.test(p.gddType || "") && /^#[0-9a-fA-F]{6}$/.test(String(k.data[n] ?? ""));
            ctl = h("input", { type: isColor ? "color" : "text", oninput: (e) => set(n, e.target.value) });
            if (p.maxLength) ctl.maxLength = p.maxLength;
            ctl.value = k.data[n] ?? "";
          }
          if (tip) ctl.title = tip;
          box.append(...field(label, ctl));
        }
        return box;
      };

      const kidForm = (k, ctx) => {
        const f = h("div", { class: "form" });
        const rt = item && childRuntime.find((x) => x.itemId === item.id && x.id === k.id);
        if (rt) f.append(h("div", { class: "hint" }, T("ed.runtime", { state: rt.state, error: rt.error ? ` — ${rt.error}` : "", attempt: rt.attempt > 1 ? T("ed.attempt", { n: rt.attempt }) : "" })));
        f.append(...field(T("ed.type"), bindSelect(k, "type", CHILD_TYPES, ctx.redraw)));
        const t = k.type;
        // Parameter/Daten als JSON-Text, beim Speichern geparst
        const jsonField = (label, key, ph) => {
          const ta = h("textarea", { placeholder: ph || "{}", oninput: (e) => { k[`_${key}Text`] = e.target.value; } });
          ta.value = k[`_${key}Text`] ?? (k[key] && Object.keys(k[key]).length ? JSON.stringify(k[key]) : "");
          return field(label, ta);
        };
        if (["GRAPHIC", "LOGO", "CHANNEL_BRANDING"].includes(t)) {
          if (gfxTemplates.length) {
            // Auswahl der Vorlagen des Ziel-OGraf-Nodes; eine unbekannte, schon gesetzte ID bleibt wählbar.
            const opts = gfxTemplates.map((g) => [g.id, g.label && g.label !== g.id ? `${g.label} (${g.id})` : g.id]);
            if (k.templateId && !gfxTemplates.some((g) => g.id === k.templateId)) opts.unshift([k.templateId, k.templateId]);
            f.append(...field(T("ed.templateId"), bindSelect(k, "templateId", [["", T("ed.chooseTemplate")], ...opts], () => {
              k.data = {}; // andere Vorlage = andere Felder; Vorgabewerte füllt das Formular
              delete k._dataText;
              ctx.redraw();
            })));
          } else {
            f.append(...field(T("ed.templateId"), bindText(k, "templateId")));
            f.append(h("div", { class: "hint", text: T("ed.noTemplates") }));
          }
          const tpl = gfxTemplates.find((x) => x.id === k.templateId);
          const props = tpl && tpl.schema && tpl.schema.properties;
          if (props && Object.keys(props).length) f.append(templateForm(k, tpl, ctx));
          else f.append(...jsonField(T("ed.dataJson"), "data", '{"name":"…"}'));
        } else if (["NODE_COMMAND", "TRIGGER", "AUDIO", "VOICEOVER"].includes(t)) {
          const lbl = bindText(k, "target", { list: "pa-nodes", placeholder: T("ed.nodeLabelPh") });
          f.append(...field(T("ed.targetNode"), lbl, h("datalist", { id: "pa-nodes" }, ...availableNodes.map((n) => h("option", { value: n })))));
          f.append(...field(T("ed.method"), bindText(k, "method")));
          f.append(...jsonField(T("ed.paramsJson"), "params"));
          f.append(...field(T("ed.stopMethod"), bindText(k, "stopMethod", { placeholder: T("ed.stopMethodPh") })));
          f.append(...jsonField(T("ed.stopParams"), "stopParams"));
        } else if (t === "WEBHOOK") {
          f.append(...field("URL", bindText(k, "url", { placeholder: "https://…" })));
          f.append(...jsonField(T("ed.bodyJson"), "params"));
        } else if (t === "CHANNEL_TRIGGER") {
          const p = (k.params = k.params && typeof k.params === "object" ? k.params : {});
          p.target = p.target || {};
          const tk = p.target.group !== undefined ? "group" : p.target.channel !== undefined ? "channel" : p.target.all ? "all" : "group";
          const state = { event: p.event || "NEXT_LIVE", kind: tk, name: p.target.group ?? p.target.channel ?? "", itemId: p.args?.itemId || "" };
          const apply = () => {
            const o = { event: state.event, target: state.kind === "all" ? { all: true } : { [state.kind]: state.name } };
            if (state.event === "JUMP") o.args = { itemId: state.itemId };
            k.params = o;
          };
          apply();
          f.append(...field(T("ed.event"), bindSelect(state, "event", TRIGGER_EVENTS.map((e) => [e, e]), () => { apply(); ctx.redraw(); })));
          f.append(...field(T("ed.target"), bindSelect(state, "kind", [["group", T("tr.group")], ["channel", T("tr.channel")], ["all", T("tr.all")]], () => { apply(); ctx.redraw(); })));
          if (state.kind !== "all") f.append(...field(T("ed.name"), h("input", { type: "text", value: state.name, oninput: (e) => { state.name = e.target.value; apply(); } })));
          if (state.event === "JUMP") f.append(...field(T("ed.itemId"), h("input", { type: "text", value: state.itemId, oninput: (e) => { state.itemId = e.target.value; apply(); } })));
        }
        f.append(h("div", { class: "hint", style: "border-top:1px solid var(--bd);padding-top:6px" }, T("ed.timingHdr")));
        f.append(...field(T("ed.mode"), bindSelect(k, "timing", TIMINGS, ctx.redraw)));
        if (k.timing === "ABSOLUTE") {
          const at = h("input", { type: "text", placeholder: T("ed.startPh"), value: k.atUtc ? new Date(k.atUtc).toLocaleString("sv-SE") : "", oninput: (e) => { k._atLocal = e.target.value; } });
          f.append(...field(T("ed.clock"), at));
        } else if (k.timing !== "FULL_PRIMARY") {
          f.append(...field(k.timing === "RELATIVE_TO_END" ? T("ed.beforeEnd") : T("ed.delay"), bindTc(k, "delayMs")));
        }
        if (k.timing !== "FULL_PRIMARY") f.append(...field(T("ed.durationMs"), bindTc(k, "durationMs", { title: T("ed.zeroUntilEnd") })));
        f.append(h("div", { class: "hint", style: "border-top:1px solid var(--bd);padding-top:6px" }, T("ed.onErrors")));
        f.append(...field(T("ed.policy"), bindSelect(k, "failurePolicy", FAIL_POLICIES, ctx.redraw)));
        if (k.failurePolicy === "RETRY") {
          f.append(...field(T("ed.retries"), bindNum(k, "retryCount")));
          f.append(...field(T("ed.pause"), bindNum(k, "retryDelayMs")));
        }
        if (k.failurePolicy === "FALLBACK") f.append(...field(T("ed.fallbackTarget"), bindText(k, "fallbackTarget", { placeholder: T("ed.nodeLabelPh") })));
        f.append(...field(T("ed.required"), h("input", { type: "checkbox", checked: !!k.required, onchange: (e) => { k.required = e.target.checked; } }), h("span", { style: "color:var(--mut)" }, T("ed.requiredHint"))));
        return f;
      };

      // Child → sauberes JSON für den Node
      const cleanKid = (k) => {
        const o = { ...k };
        for (const key of ["data", "params", "stopParams"]) {
          const txt = o[`_${key}Text`];
          if (txt !== undefined) {
            if (txt.trim() === "") delete o[key];
            else {
              try { o[key] = JSON.parse(txt); } catch { throw new Error(T("ed.badJson", { id: o.id, key })); }
            }
          }
          delete o[`_${key}Text`];
        }
        if (o._atLocal !== undefined) {
          const iso = parseStartInput(o._atLocal);
          if (!iso) throw new Error(T("ed.badTime", { id: o.id }));
          o.atUtc = iso;
        }
        delete o._atLocal;
        return o;
      };

      const buildPatch = () => {
        const p = { label: d.label.trim(), note: d.note, adClass: d.adClass || "", icon: d.icon.trim(), color: d.color, startType: d.startType, transition: d.transition };
        if (!p.label) throw new Error(T("ed.titleMissing"));
        if (d.startType === "fixtime") {
          const iso = parseStartInput(d.startLocal);
          if (!iso) throw new Error(T("ed.badStart"));
          p.startAt = iso;
        } else p.startAt = "";
        if (d.transition && d.transition !== "cut" && String(d.rateFrames).trim() !== "") p.transitionRateFrames = Number(d.rateFrames);
        p.children = kids.map(cleanKid);
        p.audioMapping = d.audioMapping || "";
        if (item?.audio && d.audioCap !== (item.audio.intent?.capability || "")) {
          const intent = { ...(item.audio.intent || {}) };
          if (d.audioCap) intent.capability = d.audioCap; else delete intent.capability;
          p.audio = intent;
        }
        if (d.kind === "asset") { p.onMissing = d.onMissing; p.fallbackFile = d.onMissing === "FALLBACK" ? d.fallbackFile.trim() : ""; }
        return p;
      };
      const mediaPatch = () => {
        switch (d.kind) {
          case "pattern": return { kind: "pattern", pattern: d.pattern };
          case "file": case "image": return { kind: d.kind, file: d.file };
          case "live": return { kind: "live", senderId: d.senderId };
          case "liveselect": return { kind: "liveselect", sourceSelector: { required: splitTags(d.tags), preferred: splitTags(d.pref) } };
          case "jump": return { kind: "jump", jumpTarget: d.jumpTarget };
          case "asset": return { kind: "asset", asset: { assetId: d.assetId.trim() } };
          default: return { kind: "hold" };
        }
      };
      const appendNew = async () => {
        const body = { label: d.label.trim() || "Event" };
        let method = "append";
        switch (d.kind) {
          case "pattern": body.pattern = d.pattern; body.toneFrequency = 0; body.durationMs = d.durationMs || 5000; break;
          case "file": if (!d.file) return T("ed.pickFile"); body.file = d.file; break;
          case "image": if (!d.file) return T("ed.pickImage"); body.file = d.file; body.eventType = "image"; body.durationMs = d.durationMs || 5000; break;
          case "live": if (!d.senderId) return T("ed.pickLive"); body.senderId = d.senderId; body.durationMs = d.durationMs || 5000; break;
          case "liveselect":
            if (splitTags(d.tags).length === 0) return T("ed.needTag");
            body.sourceSelectorJson = JSON.stringify({ required: splitTags(d.tags), preferred: splitTags(d.pref) });
            body.durationMs = d.durationMs || 5000;
            break;
          case "hold": body.eventType = "hold"; break;
          case "jump": if (!d.jumpTarget) return T("ed.pickJump"); body.eventType = "jump"; body.jumpTarget = d.jumpTarget; break;
          case "asset":
            if (!d.assetId.trim()) return T("ed.assetMissing");
            method = "appendAsset";
            Object.assign(body, { assetJson: JSON.stringify({ assetId: d.assetId.trim() }), onMissing: d.onMissing, fallbackFile: d.onMissing === "FALLBACK" ? d.fallbackFile.trim() : "", startType: "", durationMs: 0 });
            break;
          default: break;
        }
        return tryCall(method, body);
      };

      openModal({
        title: isNew ? T("ed.new") : T("ed.edit", { label: item.label }),
        tabs: [["content", T("ed.tab.content")], ["timing", T("ed.tab.timing")], ["audio", T("ed.tab.audio")], ["kids", T("ed.tab.kids", { n: kids.length })]],
        saveLabel: isNew ? T("ed.create") : T("save"),
        render: (tab, ctx) => (tab === "content" ? renderContent(ctx) : tab === "timing" ? renderTiming() : tab === "audio" ? renderAudio() : renderKids(ctx)),
        onSave: async () => {
          let patch;
          try { patch = buildPatch(); } catch (e) { return e.message; }
          if (isNew) {
            const before = items.length;
            const err = await appendNew();
            if (err) return err;
            const list = (await getParam("items")) || [];
            const created = list[list.length - 1];
            if (!created || list.length <= before) return null;
            delete patch.audio;
            const err2 = await tryCall("updateItem", { itemId: created.id, patchJson: JSON.stringify(patch) });
            return err2 ? T("ed.createdNoProps", { err: err2 }) : null;
          }
          if (!onAir) {
            if (mediaSig(d) !== origSig) patch.media = mediaPatch();
            if (durationEditable() && d.durationMs !== origDur) patch.durationMs = d.durationMs;
          }
          return tryCall("updateItem", { itemId: item.id, patchJson: JSON.stringify(patch) });
        },
      }).redraw();
      if (startTab) {
        // direkt auf den gewünschten Reiter springen
        const tabs = shadow.querySelectorAll(".modal > .tabs button");
        const idx = { content: 0, timing: 1, audio: 2, kids: 3 }[startTab] ?? 0;
        if (tabs[idx]) tabs[idx].click();
      }
    }

    // ---- Medien-Auswahl (📂) ---------------------------------------------
    function openMediaPicker() {
      const picked = new Set();
      let q = "";
      const listEl2 = h("div", { class: "pick-list" });
      const draw = () => {
        const files = mediaLibrary.filter((f) => f.toLowerCase().includes(q));
        listEl2.replaceChildren(...(files.length ? files.map((f) => h("div", {
          class: `it${picked.has(f) ? " chk" : ""}`,
          onclick: () => { if (picked.has(f)) picked.delete(f); else picked.add(f); draw(); },
        }, picked.has(f) ? "☑" : "☐", f)) : [h("div", { class: "empty" }, T("pick.none"))]));
      };
      draw();
      openModal({
        title: T("pick.title"),
        saveLabel: T("pick.add"),
        render: () => h("div", {}, h("input", { type: "search", placeholder: T("search"), style: "width:100%;margin-bottom:6px", oninput: (e) => { q = e.target.value.toLowerCase(); draw(); } }), listEl2),
        onSave: async () => {
          for (const f of [...picked]) {
            const err = await tryCall("append", { label: f.replace(/\.[^.]+$/, ""), file: f });
            if (err) return `${f}: ${err}`;
          }
          return null;
        },
      });
    }

    // ---- Carts: Raster + Verwaltung --------------------------------------
    const cartBtns = new Map();
    const renderCarts = () => {
      const ids = new Set(assets.map((a) => a.id));
      for (const [id, b] of cartBtns) if (!ids.has(id)) { b.remove(); cartBtns.delete(id); }
      const active = !!activeCartId;
      cartBanner.classList.toggle("show", active);
      if (active) cartBannerLabel.textContent = T("cart.onAir", { label: assets.find((a) => a.id === activeCartId)?.label || activeCartId });
      assets.forEach((a) => {
        let b = cartBtns.get(a.id);
        if (!b) {
          b = h("button", { class: "cart-btn", onclick: () => act("cart.fire", { assetId: b.dataset.id }) }, h("span", { class: "ci" }), h("span", { class: "cl" }));
          b.dataset.id = a.id;
          cartBtns.set(a.id, b);
          cartGrid.append(b);
        }
        b.children[0].textContent = a.icon || "▶";
        b.children[1].textContent = a.label;
        b.style.background = a.color || "";
        b.style.color = a.color ? "#fff" : "";
        b.title = `${a.pattern || ""}${a.durationMs > 0 ? ` · ${a.durationMs} ms` : T("cart.manual")}`;
        b.disabled = active;
        b.classList.toggle("firing", a.id === activeCartId);
      });
    };

    function openCartManager() {
      const rows = () => assets.map((a) => ({ id: a.id, label: a.label, pattern: a.pattern || "smpte", durationMs: a.durationMs || 0, icon: a.icon || "", color: a.color || "" }));
      let list = rows();
      let fresh = { label: "", pattern: "smpte", durationMs: 0, icon: "", color: "" };
      const box = h("div", {});
      const patch = (r) => JSON.stringify({ label: r.label, pattern: r.pattern, durationMs: r.durationMs, icon: r.icon, color: r.color });
      const draw = () => {
        const mk = (r, isNew) => {
          const color = h("input", { type: "color", value: r.color || "#4a90d9", oninput: (e) => { r.color = e.target.value; } });
          const row = h("div", { class: "row", style: "margin-bottom:6px" },
            bindText(r, "icon", { placeholder: T("cart.iconPh"), style: "width:54px" }), color,
            bindText(r, "label", { placeholder: T("cart.titlePh"), style: "width:150px" }),
            bindSelect(r, "pattern", PATTERNS.map((p) => [p, p])),
            bindNum(r, "durationMs", { style: "width:90px", title: T("cart.msTitle") }),
            isNew
              ? h("button", { class: "primary", onclick: async () => {
                  const err = await tryCall("cart.define", { label: r.label || "Cart", pattern: r.pattern, toneFrequency: 0, durationMs: r.durationMs });
                  if (err) return showBanner(err);
                  const a = (await getParam("assets")) || [];
                  const last = a[a.length - 1];
                  if (last && (r.icon || r.color)) await tryCall("cart.update", { assetId: last.id, patchJson: patch(r) });
                  assets = (await getParam("assets")) || [];
                  list = rows(); fresh = { label: "", pattern: "smpte", durationMs: 0, icon: "", color: "" }; draw(); renderCarts();
                } }, T("cart.create"))
              : [h("button", { onclick: async () => {
                  const err = await tryCall("cart.update", { assetId: r.id, patchJson: patch(r) });
                  showBanner(err || T("cart.saved", { label: r.label }), !err);
                  assets = (await getParam("assets")) || assets; renderCarts();
                } }, T("save")),
                h("button", { class: "danger", onclick: async () => {
                  if (!(await confirmDialog(T("cart.confirmRemove", { label: r.label }), T("remove")))) return;
                  const err = await tryCall("cart.remove", { assetId: r.id });
                  if (err) return showBanner(err);
                  assets = (await getParam("assets")) || []; list = rows(); draw(); renderCarts();
                } }, "✕")]);
          return row;
        };
        box.replaceChildren(
          ...(list.length ? list.map((r) => mk(r, false)) : [h("div", { class: "empty" }, T("cart.none"))]),
          h("div", { style: "border-top:1px solid var(--bd);margin:8px 0;padding-top:8px;color:var(--mut)" }, T("cart.new")),
          mk(fresh, true));
      };
      draw();
      openModal({ title: T("cart.manageTitle"), render: () => box });
    }

    // ---- Poll ------------------------------------------------------------
    const poll = async () => {
      clockEl.textContent = new Date().toLocaleTimeString(LOCALE);
      if (dragging) return;
      const names = ["items", "currentItemId", "cuedItemId", "mode", "connected", "playheadPositionMs", "currentDurationMs", "assets", "activeCartId",
        "availableNodes", "targetPlayerALabel", "targetPlayerBLabel", "targetMixerLabel", "targetGraphicsLabel", "targetAudioMixerLabel", "liveChannel", "mediaLibrary", "audioPlans", "audioGroups", "audioMappings",
        "availableSources", "channelName", "persistence", "schedule", "childEvents", "triggerLog", "channelId", "preflightWindowMin", "defaultFiller", "adBreakEnabled", "adBreakTarget", "adBreakPreRollMs", "adBlocks"];
      const v = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await getParam(n)])));
      if (dragging) return;
      items = v.items || [];
      assets = v.assets || [];
      childRuntime = v.childEvents || [];
      availableNodes = v.availableNodes || [];
      mediaLibrary = v.mediaLibrary || [];
      availableSources = v.availableSources || [];
      loadTagCatalog();
      gfxLabel = v.targetGraphicsLabel || "";
      loadGfxTemplates();
      channelId = v.channelId || "";
      audioPlans = (v.audioPlans && typeof v.audioPlans === "object") ? v.audioPlans : { a: null, b: null };
      audioGroups = Array.isArray(v.audioGroups) ? v.audioGroups : [];
      audioMappings = Array.isArray(v.audioMappings) ? v.audioMappings : [];
      currentItemId = v.currentItemId || "";
      cuedItemId = v.cuedItemId || "";
      activeCartId = v.activeCartId || "";
      durationMs = v.currentDurationMs || 0;
      playheadMs = v.playheadPositionMs || 0;
      for (const id of [...selected]) if (!items.some((i) => i.id === id)) selected.delete(id);

      // Trigger-Protokoll
      const log = Array.isArray(v.triggerLog) ? v.triggerLog : [];
      if (log.length) {
        trLog.replaceChildren(...log.map((e) => {
          const who = e.direction === "out" ? `→ ${e.target ? JSON.stringify(e.target) : ""}` : `← ${e.origin || "?"}`;
          return h("div", { style: ["denied", "failed", "rejected"].includes(e.status) ? "color:#ff8080" : "" },
            `${new Date(e.at).toLocaleTimeString()} ${e.direction === "out" ? "OUT" : "IN "} ${e.event} ${who} [${e.status}] ${e.detail || ""}`);
        }));
      }

      // Countdown zum nächsten Fixzeit-Event
      const nowMs = Date.now();
      const d0 = new Date();
      const nowSecs = d0.getHours() * 3600 + d0.getMinutes() * 60 + d0.getSeconds();
      const upcoming = items.filter((it) => it.startType === "fixtime" && (it.startAt || it.fixtimeHms)).map((it) => {
        if (it.startAt) return { label: it.label, hms: formatLocalStart(it.startAt), remain: Math.floor((Date.parse(it.startAt) - nowMs) / 1000) };
        const [hh, mm, ss] = it.fixtimeHms.split(":").map(Number);
        return { label: it.label, hms: it.fixtimeHms, remain: hh * 3600 + mm * 60 + ss - nowSecs };
      }).filter((f) => Number.isFinite(f.remain) && f.remain >= 0).sort((a, b) => a.remain - b.remain);
      if (upcoming.length) {
        const n = upcoming[0];
        const hh = Math.floor(n.remain / 3600), mm = Math.floor((n.remain % 3600) / 60), ss = n.remain % 60;
        nextFixEl.textContent = T("fixCountdown", { hms: n.hms, label: n.label, t: `${hh > 0 ? `${hh}:${String(mm).padStart(2, "0")}` : mm}:${String(ss).padStart(2, "0")}` });
        nextFixEl.style.display = "";
      } else nextFixEl.style.display = "none";

      // Plan + Zeitfenster
      const timeline = items.length ? await fetch(`/api/v1/nodes/${nodeId}/timeline/window?fromIndex=0&count=${items.length}`).then((r) => (r.ok ? r.json() : [])).catch(() => []) : [];
      timeByIndex = new Map(timeline.map((e) => [e.index, e]));
      planById = new Map(((v.schedule && v.schedule.entries) || []).map((e) => [e.id, e]));
      const nw = [...planById.values()].filter((e) => e.warnings && e.warnings.length).length;
      planWarnEl.textContent = nw === 1 ? T("planWarn.one") : T("planWarn.many", { n: nw });
      planWarnEl.style.display = nw ? "" : "none";

      // Kopf / Steuerung
      const onAir = !!currentItemId;
      modeChip.textContent = onAir ? "ON AIR" : "STANDBY";
      modeChip.className = `chip${onAir ? " onair" : ""}`;
      liveCh = v.liveChannel === "b" ? "b" : "a";
      connectedChip.textContent = v.connected ? T("connected", { ch: v.liveChannel === "b" ? "B" : "A" }) : T("notConnected");
      connectedChip.className = `chip${v.connected ? " ok" : " err"}`;
      const ptxt = v.persistence || "";
      persistChip.textContent = v.channelName ? T("channelLabel", { name: v.channelName }) : T("noChannel");
      persistChip.title = ptxt;
      persistChip.className = `chip${/fehlgeschlagen|Konflikt|nicht lesbar|nicht serialisierbar/.test(ptxt) ? " err" : v.channelName ? " blue" : ""}`;
      takeBtn.disabled = !cuedItemId;
      nextBtn.disabled = items.length === 0;
      const refIdx = items.findIndex((i) => i.id === (currentItemId || cuedItemId));
      const hasLive = items.some((i) => i.senderId);
      nextLiveBtn.style.display = hasLive ? "" : "none";
      nextLiveBtn.disabled = !items.slice(refIdx >= 0 ? refIdx + 1 : 0).some((i) => i.senderId);
      if (v.mode && shadow.activeElement !== modeSelect) modeSelect.value = v.mode;
      progressBar.style.width = durationMs > 0 ? `${Math.min(100, (100 * playheadMs) / durationMs)}%` : "0";

      fillTargets(selA, availableNodes, v.targetPlayerALabel);
      fillTargets(selB, availableNodes, v.targetPlayerBLabel);
      fillTargets(selMix, availableNodes, v.targetMixerLabel);
      fillTargets(selGfx, availableNodes, v.targetGraphicsLabel);
      fillTargets(selAud, availableNodes, v.targetAudioMixerLabel);
      adBlocks = Array.isArray(v.adBlocks) ? v.adBlocks : [];
      fillTargets(selAd, availableNodes.filter((l) => /scte/i.test(l) || l === v.adBreakTarget), v.adBreakTarget);
      const ae = shadow.getElementById("adEnabled");
      if (ae && shadow.activeElement !== ae && v.adBreakEnabled !== undefined) ae.checked = !!v.adBreakEnabled;
      const ap = shadow.getElementById("adPreRoll");
      if (ap && shadow.activeElement !== ap && v.adBreakPreRollMs !== undefined) ap.value = v.adBreakPreRollMs;
      const pw = shadow.getElementById("preflightWin");
      if (pw && shadow.activeElement !== pw && v.preflightWindowMin !== undefined) pw.value = v.preflightWindowMin;
      const df = shadow.getElementById("defaultFiller");
      if (df && shadow.activeElement !== df && v.defaultFiller !== undefined) df.value = v.defaultFiller;

      renderList();
      renderCarts();
    };

    poll();
    this._interval = setInterval(poll, 1000);
  }

  disconnectedCallback() {
    clearInterval(this._interval);
  }
}

if (!customElements.get("omp-playout-automation-panel")) {
  customElements.define("omp-playout-automation-panel", OmpPlayoutAutomationPanel);
}
