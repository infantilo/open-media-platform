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
      "tm.before": "vor Start (Vorlauf)", "tm.after": "nach Ende (überlebt den Wechsel)",
      "ed.beforeStart": "Vor Start (HH:MM:SS.FF)", "ed.afterEnd": "Nach Ende (HH:MM:SS.FF)",
      "ed.endAfter": "nach dem Ende des Primary", "ed.endAfterEnd": "Abstand nach Primary-Ende (HH:MM:SS.FF)",
      "ed.beforeStartHint": "Braucht einen berechenbaren Take: automatischer Übergang nach einem Event mit fester Dauer oder ein Fix-Event. Bei manuellem Take entfällt das Child mit Meldung.",
      "ed.afterEndHint": "Läuft über den Wechsel zum nächsten Event hinaus (braucht eine Dauer oder ein Ende); STOP beendet es.",
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
      "sec.targets": "Ziele", "sec.audio": "Audio-Ausgabe (dieser Channel)", "ar.needChannel": "Die Audio-Ausgabe (Ausgabegruppen, Spurschemata, Zuordnungsvorlagen, Ersatzregeln) wird je Channel gespeichert. Bitte zuerst oben einen Channel verknüpfen.", "ar.hint": "Gilt für die Player und Mischer dieses Channels: Workflow-Rollen und alle Ziele dieser Automation (Player A/B, Audio-Mixer) bekommen es automatisch, sobald sie (neu) gestartet werden. Andere Player bleiben standalone (Plattform-Standard) — oder wählen den Channel mit OMP_AUDIO_RULES_CHANNEL.", "ar.loadFail": "Editor konnte nicht geladen werden: {e}", "sec.channel": "Channel (Speicherung)", "ch.notLinked": "Diese Instanz ist mit keinem Channel direkt verknüpft.", "ch.wfWarn": "⚠⚠ ACHTUNG ⚠⚠\n\nChannel „{name}“ gehört zu einem WORKFLOW. Wird der Workflow gestartet oder läuft er, schreiben ZWEI Automationen in denselben Channel: die Playlist wird gegenseitig überschrieben, Events können doppelt oder gar nicht laufen — auch auf Sendung.\n\nNur verknüpfen, wenn der Workflow gestoppt ist und bleibt.", "ch.roleWarn": "⚠⚠ ACHTUNG ⚠⚠\n\nDiese Instanz ist über eine WORKFLOW-ROLLE bereits mit einem Channel verbunden. Ein zweiter Channel „{name}“ vermischt Playlist und Zustand; nach dem nächsten Workflow-Start kann die Zuordnung unklar sein.\n\nNur fortfahren, wenn du genau weißt, was du tust.", "ch.wfWarnGo": "Ich habe verstanden …", "ch.wfWarn2": "LETZTE WARNUNG: „{name}“ wirklich trotz Workflow verknüpfen? Das kann die laufende Sendung stören und ist nur durch „Lösen“ rückgängig zu machen.", "ch.wfWarnGo2": "JA, TROTZDEM VERKNÜPFEN", "ch.none": "— kein Channel —", "ch.link": "Verknüpfen", "ch.unlink": "Lösen", "ch.new": "Neuen Channel anlegen", "ch.newPh": "Name des neuen Channels", "ch.linked": "Mit Channel „{name}“ verknüpft.", "ch.unlinked": "Channel gelöst.", "ch.status": "Status: {p}", "ch.hint": "Ein Channel speichert Playlist und Einstellungen beim Orchestrator und überlebt Neustarts, Umzüge und Ausfälle. Ohne Channel sichert sich die Instanz nur lokal in einer Datei.", "ch.here": " (diese Instanz)", "ch.other": " (an andere Instanz gebunden)", "ch.role": " (an Workflow-Rolle gebunden)", "ch.takeover": "Channel „{name}“ ist schon an eine andere Instanz/Rolle gebunden. Trotzdem hierher umbinden?", "ch.overwrite": "Hat der Channel schon gespeicherten Inhalt, ersetzt der aktuelle Inhalt dieser Automation ihn.", "ch.viaRole": "Dieser Channel hängt an einer Workflow-Rolle und wird im Workflow gelöst.", "ch.noId": "Instanz-ID unbekannt (keine Orchestrator-Anbindung).", "ch.err": "Fehler: {e}",
      "sec.playlist": "Playlist",
      "sec.carts": "Assets / Carts",
      "sec.trigger": "Channel-Trigger",
      "tab.live": "Sendung",
      "tab.carts": "Carts",
      "tab.auto": "Trigger & Werbung",
      "tab.config": "Konfiguration",
      "sec.foreign": "Fremdliste / Mitlauf",
      "fo.import": "Liste importieren …",
      "fo.rescan": "Jetzt prüfen",
      "fo.takeover": "Havarie ziehen …",
      "fo.takeoverAsk": "Die Schattenliste ab dem Event nach „{title}“ in die Playlist übernehmen? Die aktuelle Playlist wird ersetzt.",
      "fo.takeoverGo": "Übernehmen",
      "fo.off": "Mitlauf ist aus. Ordner und Kanalkennung eintragen und aktivieren:",
      "fo.dir": "Ordner (Watchfolder)",
      "fo.key": "Kanalkennung (z. B. 5000)",
      "fo.enable": "Speichern & aktivieren",
      "fo.disable": "Ausschalten",
      "fo.waiting": "Wartet auf eine vollständige Datei in {dir}",
      "fo.file": "Datei",
      "fo.age": "Alter",
      "fo.stale": "⚠ VERALTET — Fremdsystem liefert keine neuen Listen",
      "fo.fresh": "aktuell",
      "fo.onair": "Läuft laut Liste",
      "fo.events": "Events",
      "fo.changes": "Letzte Änderung",
      "fo.rejected": "Übersprungen",
      "fo.approx": "Angenähert",
      "fo.dropped": "Nicht übernommen",
      "fo.none": "keines",
      "fo.pick": "Sendeliste wählen (.mpl)",
      "fo.preview": "Vorschau des Imports",
      "fo.items": "{n} Sendeevents",
      "fo.skippedDone": "{n} bereits gelaufen (ausgelassen)",
      "fo.append": "Anhängen",
      "fo.replace": "Playlist ersetzen",
      "fo.cancel": "Abbrechen",
      "fo.done": "{n} Events übernommen",
      "fo.errors": "{n} Fehler: {first}",
      "tgt.release": "Sendefreigabe verlangen (QC grün oder manuell freigegeben)",
      "ed.release": "Sendefreigabe",
      "ed.releaseDefault": "wie Channel",
      "ed.releaseYes": "verlangt",
      "ed.releaseNo": "nicht verlangt",
      "av.releaseTip": "Freigabe verlangt — {state}",
      "tgt.a": "Kanal A",
      "tgt.b": "Kanal B",
      "tgt.mixer": "Mixer",
      "tgt.gfx": "Grafik",
      "tgt.audio": "Audio-Mixer",
      "tgt.mixAuto": "Mischer automatisch einrichten, sobald verbunden",
      "tgt.mixSetup": "Mischer jetzt einrichten",
      "tgt.mixSetupTip": "Legt im Audiomischer für jeden Player und jedes Programm des Channels einen Kanal (mit Ton folgt Bild) an und heftet die Player im Bildmischer an",
      "tgt.mixHint": "Fügt nur hinzu, was fehlt: vorhandene Kanäle und angeheftete Quellen bleiben unverändert, nichts wird gelöscht.",
      "tgt.preflight": "Preflight-Vorlauf (min)",
      "tgt.filler": "Standard-Filler (Datei)",
      "idle.label": "Idle-Quelle (wenn die Liste nicht läuft)", "idle.choose": "— wählen —", "idle.black": "Schwarz", "idle.live": "Live-Quelle", "idle.file": "Datei", "idle.image": "Standbild", "idle.pattern": "Testmuster",
      "idle.hint": "Wird bei Stop und am Playlist-Ende geschaltet (statt Schwarz bzw. stehendem letzten Bild).",
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
      "col.resize": "Spaltenbreite ziehen (Doppelklick: Standard)",
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
      "startNow": "Jetzt starten (Cue + Take) — auch Fix-/Manuell-Event, überschreibt den Startzeitpunkt",
      "startNowNone": "Zuerst ein Event anklicken",
      "copyEv": "Kopieren (Strg+C)", "cutEv": "Ausschneiden (Strg+X)", "pasteEv": "Einfügen nach der Auswahl (Strg+V)", "delEv": "Löschen (Entf)",
      "clipCopied": "{n} Event(s) kopiert", "clipCut": "{n} Event(s) ausgeschnitten — mit Einfügen verschieben", "clipEmpty": "Zwischenablage leer", "cutOnAir": "Das laufende Event kann nicht ausgeschnitten werden",
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
      "ed.end": "Ende", "ed.endSeq": "⏭ Weiter nach Plan", "ed.endHold": "⏸ HOLD (Manual Hold: nach Ablauf anhalten, Operator schaltet mit Next weiter)",
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
      "ed.audioAfterCreate": "Die Audio-Wahl hängt von der aufgelösten Live-Quelle ab: nach „Anlegen“ öffnet sich der Editor direkt auf dieser Seite.",
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
      "kv.text": "Text", "kv.number": "Zahl", "kv.bool": "Ja/Nein", "kv.list": "Liste", "kv.object": "Gruppe",
      "kv.type": "Typ", "kv.remove": "Entfernen", "kv.addItem": "＋ Eintrag", "kv.addField": "＋ Feld", "kv.name": "Name", "kv.field": "Feld",
      "kv.suggest": "Vorschläge:", "ed.dataFields": "Daten", "ed.paramFields": "Parameter", "ed.bodyFields": "Inhalt (Felder)",
      "ed.methodHint": "Methoden und Argumente stammen vom Ziel-Node; freie Eingabe bleibt möglich.",
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
      "ed.endMode": "Ende", "ed.endDur": "nach Dauer", "ed.endPrimary": "am Ende des Primary", "ed.endBefore": "vor dem Ende des Primary", "ed.endBeforeEnd": "Abstand vor Primary-Ende (HH:MM:SS.FF)",
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
      "ed.pickLive": "Live-Quelle wählen", "ed.noMedia": "Keine Dateien verfügbar — die Dateiliste stammt vom Ziel-Player A (Reiter Konfiguration → Ziele prüfen).", "ed.noSources": "Keine Live-Quellen verfügbar — Ziel-Player A im Reiter Konfiguration prüfen.", "ed.noAssets": "Keine Assets gefunden — die ID kann auch von Hand eingegeben werden.", "pick.noHit": "Kein Treffer", "pick.more": "… {n} weitere — Suchbegriff eingrenzen", "ed.liveNoSourceHint": "Ohne Quelle wird das Event als „Quelle fehlt“ angelegt (Zähler „Event ohne Quelle“) — die Quelle kann später gewählt werden.",
      "ed.needTag": "Live nach Tags braucht mindestens einen Pflicht-Tag",
      "ed.pickJump": "Sprungziel wählen",
      "ed.assetMissing": "Asset-ID fehlt",
      "ed.createdNoProps": "Event angelegt, aber Eigenschaften nicht übernommen: {err}",
      "pick.none": "Keine Dateien in der Medienbibliothek des Ziel-Players.",
      "pick.title": "Medien hinzufügen",
      "pick.add": "Hinzufügen",
      "cart.onAir": "CART ON AIR: {label}",
      "cart.manual": " · manuell (RETURN)",
      "cart.next": "NÄCHSTES",
      "cart.iconPh": "Icon",
      "cart.titlePh": "Titel",
      "cart.msTitle": "ms, 0 = manuell (RETURN)",
      "cart.create": "＋ Anlegen",
      "cart.saved": "„{label}“ gespeichert",
      "cart.confirmRemove": "Cart „{label}“ wirklich entfernen?",
      "cart.none": "Noch keine Carts (Blackclip, Standby, …).",
      "cart.new": "Neuer Cart",
      "cart.manageTitle": "Assets / Carts verwalten",
      "cart.edit": "Cart bearbeiten: {label}", "cart.newTitle": "Neuer Cart", "cart.newBtn": "＋ Neuer Cart", "cart.create2": "Cart anlegen",
      "cart.durationHint": "0 = kein automatisches Ende (RETURN beendet den Cart).",
      "cart.tab.block": "Block ({n})", "cart.blockHint": "Ein Block spielt nach diesem Cart automatisch weitere Carts der Reihe nach, jedes mit seinen eigenen Children. Jeder Schritt braucht eine Dauer, sonst bleibt der Block dort stehen, bis RETURN gedrückt wird.",
      "cart.blockEmpty": "Kein Folge-Cart — dieses Cart läuft allein.", "cart.blockAdd": "— Cart hinzufügen —", "cart.blockNoDur": "⚠ „{label}“ hat keine Dauer: der Block bleibt dort stehen.",
      "cart.blockUp": "nach oben", "cart.blockDown": "nach unten", "cart.blockRemove": "entfernen", "cart.src": "Quelle", "cart.children": "{n} Children", "cart.blockN": "Block mit {n} weiteren",
      "cart.noSource": "Quelle fehlt", "cart.pickIcon": "Symbol wählen …", "cart.manager.edit": "Bearbeiten",
      "ic.title": "Symbol wählen", "ic.none": "Kein Symbol", "ic.custom": "Eigenes Zeichen", "ic.use": "Übernehmen", "ic.playback": "Wiedergabe", "ic.onair": "Sendung", "ic.audio": "Ton", "ic.notice": "Hinweis", "ic.misc": "Sonstiges",
      "fixCountdown": "⏰ {hms} „{label}“ in {t}",
      "cntLive": "Nächstes Live-Event", "cntMan": "Nächstes manuelles Event", "waitHold": "HOLD: wartet auf Next", "waitMan": "{label} startet manuell", "waitEnd": "Manual Hold nach „{label}“", "waitCued": "{label} wartet auf Take/Next", "cntFix": "Nächstes Fix-Event", "cntMiss": "Nächstes Event ohne Quelle", "cntShow": "Zähler anzeigen:", "badMiss": "QUELLE FEHLT", "badErr": "FEHLERHAFT", "badKid": "CHILD-FEHLER", "tlBtn": "Timeline", "tlTip": "Zeitleiste mit Child Events ein-/ausblenden", "tlNow": "jetzt", "tlEmpty": "Keine Events in der Playlist.", "tlWin": "Fenster",
      "cntIn": "{label} in {t}",
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
      "tm.before": "before start (lead-in)", "tm.after": "after end (survives the change)",
      "ed.beforeStart": "Before start (HH:MM:SS.FF)", "ed.afterEnd": "After end (HH:MM:SS.FF)",
      "ed.endAfter": "after the end of the primary", "ed.endAfterEnd": "Distance after primary end (HH:MM:SS.FF)",
      "ed.beforeStartHint": "Needs a predictable take: automatic transition after an event with a fixed duration, or a fixed-time event. With a manual take the child is skipped with a notice.",
      "ed.afterEndHint": "Runs past the change to the next event (needs a duration or an end); STOP ends it.",
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
      "sec.targets": "Targets", "sec.audio": "Audio output (this channel)", "ar.needChannel": "Audio output (output groups, track schemas, mapping templates, fallback rules) is stored per channel. Please link a channel above first.", "ar.hint": "Applies to the players and mixers of this channel: workflow roles and all targets of this automation (player A/B, audio mixer) get it automatically once they are (re)started. Other players stay standalone (platform default) — or choose the channel with OMP_AUDIO_RULES_CHANNEL.", "ar.loadFail": "Editor could not be loaded: {e}", "sec.channel": "Channel (storage)", "ch.notLinked": "This instance is not directly linked to any channel.", "ch.wfWarn": "⚠⚠ WARNING ⚠⚠\n\nChannel “{name}” belongs to a WORKFLOW. If the workflow is started or running, TWO automations write to the same channel: the playlist is overwritten back and forth, events may run twice or not at all — also on air.\n\nOnly link if the workflow is stopped and stays stopped.", "ch.roleWarn": "⚠⚠ WARNING ⚠⚠\n\nThis instance is already connected to a channel through a WORKFLOW ROLE. A second channel “{name}” mixes playlist and state; after the next workflow start the assignment may be unclear.\n\nOnly continue if you know exactly what you are doing.", "ch.wfWarnGo": "I understand …", "ch.wfWarn2": "FINAL WARNING: really link “{name}” despite the workflow? This can disturb the running broadcast and is only undone by “Unlink”.", "ch.wfWarnGo2": "YES, LINK ANYWAY", "ch.none": "— no channel —", "ch.link": "Link", "ch.unlink": "Unlink", "ch.new": "Create new channel", "ch.newPh": "Name of the new channel", "ch.linked": "Linked to channel “{name}”.", "ch.unlinked": "Channel unlinked.", "ch.status": "Status: {p}", "ch.hint": "A channel stores playlist and settings at the orchestrator and survives restarts, moves and failures. Without a channel the instance only keeps a local file.", "ch.here": " (this instance)", "ch.other": " (bound to another instance)", "ch.role": " (bound to a workflow role)", "ch.takeover": "Channel “{name}” is already bound to another instance/role. Rebind it here anyway?", "ch.overwrite": "If the channel already has stored content, the current content of this automation replaces it.", "ch.viaRole": "This channel is bound to a workflow role and must be unlinked in the workflow.", "ch.noId": "Instance ID unknown (no orchestrator connection).", "ch.err": "Error: {e}",
      "sec.playlist": "Playlist",
      "sec.carts": "Assets / carts",
      "sec.trigger": "Channel trigger",
      "tab.live": "On air",
      "tab.carts": "Carts",
      "tab.auto": "Triggers & ads",
      "tab.config": "Configuration",
      "sec.foreign": "Foreign list / follow",
      "fo.import": "Import list …",
      "fo.rescan": "Check now",
      "fo.takeover": "Take over …",
      "fo.takeoverAsk": "Copy the shadow list from the event after “{title}” into the playlist? The current playlist is replaced.",
      "fo.takeoverGo": "Take over",
      "fo.off": "Follow mode is off. Enter folder and channel key and enable:",
      "fo.dir": "Folder (watch folder)",
      "fo.key": "Channel key (e.g. 5000)",
      "fo.enable": "Save & enable",
      "fo.disable": "Disable",
      "fo.waiting": "Waiting for a complete file in {dir}",
      "fo.file": "File",
      "fo.age": "Age",
      "fo.stale": "⚠ STALE — the other system delivers no new lists",
      "fo.fresh": "current",
      "fo.onair": "On air per list",
      "fo.events": "Events",
      "fo.changes": "Last change",
      "fo.rejected": "Skipped",
      "fo.approx": "Approximated",
      "fo.dropped": "Not imported",
      "fo.none": "none",
      "fo.pick": "Choose playlist (.mpl)",
      "fo.preview": "Import preview",
      "fo.items": "{n} playout events",
      "fo.skippedDone": "{n} already played (left out)",
      "fo.append": "Append",
      "fo.replace": "Replace playlist",
      "fo.cancel": "Cancel",
      "fo.done": "{n} events imported",
      "fo.errors": "{n} errors: {first}",
      "tgt.release": "Require release (QC green or released manually)",
      "ed.release": "Release for air",
      "ed.releaseDefault": "as channel",
      "ed.releaseYes": "required",
      "ed.releaseNo": "not required",
      "av.releaseTip": "Release required — {state}",
      "tgt.a": "Channel A",
      "tgt.b": "Channel B",
      "tgt.mixer": "Mixer",
      "tgt.gfx": "Graphics",
      "tgt.audio": "Audio mixer",
      "tgt.mixAuto": "Set up mixers automatically once connected",
      "tgt.mixSetup": "Set up mixers now",
      "tgt.mixSetupTip": "Creates an audio mixer channel (with audio follows video) for every player and every programme of the channel and pins the players on the video mixer",
      "tgt.mixHint": "Only adds what is missing: existing channels and pinned sources stay as they are, nothing is deleted.",
      "tgt.preflight": "Preflight lead time (min)",
      "tgt.filler": "Default filler (file)",
      "idle.label": "Idle source (when the list is not running)", "idle.choose": "— choose —", "idle.black": "Black", "idle.live": "Live source", "idle.file": "File", "idle.image": "Still image", "idle.pattern": "Test pattern",
      "idle.hint": "Switched on Stop and at the end of the playlist (instead of black / the frozen last picture).",
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
      "col.resize": "Drag to resize (double-click: default)",
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
      "startNow": "Start now (cue + take) — also fixed-time/manual events, overrides the start time",
      "startNowNone": "Click an event first",
      "copyEv": "Copy (Ctrl+C)", "cutEv": "Cut (Ctrl+X)", "pasteEv": "Paste after the selection (Ctrl+V)", "delEv": "Delete (Del)",
      "clipCopied": "{n} event(s) copied", "clipCut": "{n} event(s) cut — paste moves them", "clipEmpty": "Clipboard empty", "cutOnAir": "The running event cannot be cut",
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
      "ed.end": "End", "ed.endSeq": "⏭ Continue as planned", "ed.endHold": "⏸ HOLD (manual hold: stop after the event, operator continues with Next)",
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
      "ed.audioAfterCreate": "The audio choice depends on the resolved live source: after “Create” the editor reopens directly on this page.",
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
      "kv.text": "Text", "kv.number": "Number", "kv.bool": "Yes/No", "kv.list": "List", "kv.object": "Group",
      "kv.type": "Type", "kv.remove": "Remove", "kv.addItem": "＋ Item", "kv.addField": "＋ Field", "kv.name": "Name", "kv.field": "Field",
      "kv.suggest": "Suggestions:", "ed.dataFields": "Data", "ed.paramFields": "Parameters", "ed.bodyFields": "Content (fields)",
      "ed.methodHint": "Methods and arguments come from the target node; free input stays possible.",
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
      "ed.endMode": "End", "ed.endDur": "after duration", "ed.endPrimary": "at the end of the primary", "ed.endBefore": "before the end of the primary", "ed.endBeforeEnd": "Distance before primary end (HH:MM:SS.FF)",
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
      "ed.pickLive": "Choose a live source", "ed.noMedia": "No files available — the file list comes from target player A (Configuration tab → check targets).", "ed.noSources": "No live sources available — check target player A in the Configuration tab.", "ed.noAssets": "No assets found — you can also type the ID by hand.", "pick.noHit": "No match", "pick.more": "… {n} more — narrow the search", "ed.liveNoSourceHint": "Without a source the event is created as “source missing” (counter “event without source”) — the source can be chosen later.",
      "ed.needTag": "Live by tags needs at least one required tag",
      "ed.pickJump": "Choose a jump target",
      "ed.assetMissing": "Asset ID missing",
      "ed.createdNoProps": "Event created, but properties were not applied: {err}",
      "pick.none": "No files in the media library of the target player.",
      "pick.title": "Add media",
      "pick.add": "Add",
      "cart.onAir": "CART ON AIR: {label}",
      "cart.manual": " · manual (RETURN)",
      "cart.next": "NEXT",
      "cart.iconPh": "Icon",
      "cart.titlePh": "Title",
      "cart.msTitle": "ms, 0 = manual (RETURN)",
      "cart.create": "＋ Create",
      "cart.saved": "“{label}” saved",
      "cart.confirmRemove": "Really remove cart “{label}”?",
      "cart.none": "No carts yet (black clip, standby, …).",
      "cart.new": "New cart",
      "cart.manageTitle": "Manage assets / carts",
      "cart.edit": "Edit cart: {label}", "cart.newTitle": "New cart", "cart.newBtn": "＋ New cart", "cart.create2": "Create cart",
      "cart.durationHint": "0 = no automatic end (RETURN ends the cart).",
      "cart.tab.block": "Block ({n})", "cart.blockHint": "A block plays further carts one after another after this cart, each with its own children. Every step needs a duration, otherwise the block stops there until RETURN is pressed.",
      "cart.blockEmpty": "No follow-up cart — this cart runs alone.", "cart.blockAdd": "— add cart —", "cart.blockNoDur": "⚠ “{label}” has no duration: the block stops there.",
      "cart.blockUp": "up", "cart.blockDown": "down", "cart.blockRemove": "remove", "cart.src": "Source", "cart.children": "{n} children", "cart.blockN": "block with {n} more",
      "cart.noSource": "source missing", "cart.pickIcon": "Choose symbol …", "cart.manager.edit": "Edit",
      "ic.title": "Choose symbol", "ic.none": "No symbol", "ic.custom": "Custom character", "ic.use": "Apply", "ic.playback": "Playback", "ic.onair": "On air", "ic.audio": "Audio", "ic.notice": "Notice", "ic.misc": "Other",
      "fixCountdown": "⏰ {hms} “{label}” in {t}",
      "cntLive": "Next live event", "cntMan": "Next manual event", "waitHold": "HOLD: waiting for Next", "waitMan": "{label} starts manually", "waitEnd": "Manual hold after “{label}”", "waitCued": "{label} waits for Take/Next", "cntFix": "Next fixed event", "cntMiss": "Next event without source", "cntShow": "Show counters:", "badMiss": "SOURCE MISSING", "badErr": "FAULTY", "badKid": "CHILD FAILED", "tlBtn": "Timeline", "tlTip": "Show/hide timeline with child events", "tlNow": "now", "tlEmpty": "No events in the playlist.", "tlWin": "Window",
      "cntIn": "{label} in {t}",
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
    return Promise.resolve(false); // nie window.confirm
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
// Strukturierte Werte-Editoren (statt JSON-Text): Felder mit Name/Typ/Wert, Listen, verschachtelte Objekte.
// Sie schreiben direkt in das übergebene Objekt/Array und kennen JSON nur als Datenformat, nie als Eingabe.
// ---------------------------------------------------------------------------
const KV_KINDS = ["text", "number", "bool", "list", "object"];
function kvKindOf(v) {
  if (Array.isArray(v)) return "list";
  if (v !== null && typeof v === "object") return "object";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "bool";
  return "text";
}
function kvDefault(kind) {
  return kind === "number" ? 0 : kind === "bool" ? false : kind === "list" ? [] : kind === "object" ? {} : "";
}
/** Wert beim Typwechsel sinnvoll mitnehmen (z. B. Text "12" → Zahl 12), sonst Standardwert. */
function kvConvert(v, kind) {
  if (kind === "number") { const n = Number(v); return v !== "" && v !== null && v !== undefined && Number.isFinite(n) ? n : 0; }
  if (kind === "bool") return v === true || v === "true";
  if (kind === "text") return v === null || v === undefined || typeof v === "object" ? "" : String(v);
  return kvDefault(kind);
}
function kvKindLabel(kind) { return T(`kv.${kind}`); }

/** Editor für EINEN Wert `holder[key]` passend zu seinem Typ; `onChange` meldet jede Änderung. */
function kvValueEditor(holder, key, onChange, opts = {}) {
  const kind = opts.kind || kvKindOf(holder[key]);
  const changed = () => { if (onChange) onChange(); };
  if (kind === "number") {
    return h("input", { type: "number", step: "any", value: holder[key] ?? 0, oninput: (e) => { if (e.target.value !== "") { holder[key] = Number(e.target.value); changed(); } } });
  }
  if (kind === "bool") {
    const c = h("input", { type: "checkbox", onchange: (e) => { holder[key] = e.target.checked; changed(); } });
    c.checked = !!holder[key];
    return c;
  }
  if (kind === "list") {
    if (!Array.isArray(holder[key])) holder[key] = [];
    return kvListEditor(holder[key], changed, opts);
  }
  if (kind === "object") {
    if (holder[key] === null || typeof holder[key] !== "object" || Array.isArray(holder[key])) holder[key] = {};
    return kvObjectEditor(holder[key], changed, opts);
  }
  return h("input", { type: "text", value: holder[key] ?? "", oninput: (e) => { holder[key] = e.target.value; changed(); } });
}

/** Liste: eine Zeile je Eintrag (mit Typwahl) und „＋ Eintrag“. */
function kvListEditor(arr, onChange, opts = {}) {
  const box = h("div", { class: "kv-list" });
  const draw = () => {
    box.replaceChildren();
    arr.forEach((_, i) => {
      const row = h("div", { class: "kv-row" });
      const kindSel = h("select", { title: T("kv.type"), onchange: (e) => { arr[i] = kvConvert(arr[i], e.target.value); if (onChange) onChange(); draw(); } },
        ...KV_KINDS.map((k) => h("option", { value: k, ...(k === kvKindOf(arr[i]) ? { selected: "" } : {}) }, kvKindLabel(k))));
      row.append(kindSel, h("div", { class: "kv-val" }, kvValueEditor(arr, i, onChange, opts)),
        h("button", { type: "button", class: "kv-x", title: T("kv.remove"), onclick: () => { arr.splice(i, 1); if (onChange) onChange(); draw(); } }, "✕"));
      box.append(row);
    });
    box.append(h("button", { type: "button", class: "kv-add", onclick: () => { arr.push(opts.itemKind ? kvDefault(opts.itemKind) : ""); if (onChange) onChange(); draw(); } }, T("kv.addItem")));
  };
  draw();
  return box;
}

/** Objekt: eine Zeile je Feld (Name, Typ, Wert, ✕) und „＋ Feld“; `opts.suggest` = [{name, kind}] als Vorschläge zum Anklicken. */
function kvObjectEditor(obj, onChange, opts = {}) {
  const box = h("div", { class: "kv-obj" });
  const draw = () => {
    box.replaceChildren();
    const sug = (opts.suggest || []).filter((x) => !(x.name in obj));
    if (sug.length) {
      box.append(h("div", { class: "kv-sug" }, h("span", { class: "hint" }, T("kv.suggest")),
        ...sug.map((x) => h("button", { type: "button", class: "kv-chip", title: kvKindLabel(x.kind || "text"), onclick: () => { obj[x.name] = kvDefault(x.kind || "text"); if (onChange) onChange(); draw(); } }, `＋ ${x.name}`))));
    }
    for (const name of Object.keys(obj)) {
      const row = h("div", { class: "kv-row" });
      const nameIn = h("input", { type: "text", class: "kv-name", placeholder: T("kv.name"), value: name, onchange: (e) => {
        const nn = e.target.value.trim();
        if (!nn || nn === name || nn in obj) { e.target.value = name; return; }
        const next = {};
        for (const k of Object.keys(obj)) next[k === name ? nn : k] = obj[k];
        for (const k of Object.keys(obj)) delete obj[k];
        Object.assign(obj, next);
        if (onChange) onChange();
        draw();
      } });
      const kindSel = h("select", { title: T("kv.type"), onchange: (e) => { obj[name] = kvConvert(obj[name], e.target.value); if (onChange) onChange(); draw(); } },
        ...KV_KINDS.map((k) => h("option", { value: k, ...(k === kvKindOf(obj[name]) ? { selected: "" } : {}) }, kvKindLabel(k))));
      row.append(nameIn, kindSel, h("div", { class: "kv-val" }, kvValueEditor(obj, name, onChange, opts)),
        h("button", { type: "button", class: "kv-x", title: T("kv.remove"), onclick: () => { delete obj[name]; if (onChange) onChange(); draw(); } }, "✕"));
      box.append(row);
    }
    box.append(h("button", { type: "button", class: "kv-add", onclick: () => {
      let n = 1;
      while (`${T("kv.field")}${n}` in obj) n++;
      obj[`${T("kv.field")}${n}`] = "";
      if (onChange) onChange();
      draw();
    } }, T("kv.addField")));
  };
  draw();
  return box;
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
  ["BEFORE_START", T("tm.before")], ["AFTER_END", T("tm.after")],
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
  .ptabs { display: flex; gap: 2px; border-bottom: 1px solid var(--bd); margin: 6px 0 8px; }
  .ptab { background: transparent; border: 1px solid transparent; border-bottom: none; border-radius: 6px 6px 0 0; padding: 6px 16px; font-weight: 600; color: var(--mut); cursor: pointer; }
  .ptab:hover { color: var(--fg, inherit); }
  .ptab.act { background: var(--bg2); border-color: var(--bd); color: var(--fg, inherit); box-shadow: 0 2px 0 var(--acc) inset; }
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
  .rz { position: absolute; right: -3px; top: 0; bottom: 0; width: 7px; cursor: col-resize; z-index: 2; }
  .rz:hover { background: var(--acc); opacity: .5; }
  .pl-cols { grid-template-columns: 16px 26px 22px minmax(0,1fr) 54px 108px 84px 40px 92px; }
  .hide-dur .c-dur, .hide-time .c-time, .hide-rem .c-rem { display: none; }
  .pl-main { min-width: 0; overflow-x: auto; }
  .pl-hdr, .pl-row { min-width: var(--minw, 0); }
  .pl-hdr { overflow-y: scroll; overflow-x: hidden; scrollbar-width: thin; scrollbar-color: transparent transparent; }
  .pl-hdr::-webkit-scrollbar { width: 8px; } .pl-hdr::-webkit-scrollbar-thumb, .pl-hdr::-webkit-scrollbar-track { background: transparent; }
  .sidebar .sep { height: 1px; background: var(--bd); margin: 2px 4px; }
  .sidebar button.go { background: #1f5a28; border-color: #2f8a3c; }
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
  .pl-row { touch-action: pan-y; }
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
  .pl-row .acts { display: flex; gap: 3px; justify-content: flex-end; opacity: .85; }
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
  @keyframes nextblink { 50% { background: #c8860a; border-color: #ffcf5a; color: #000; } }
  button.blink { animation: nextblink 0.9s steps(1, end) infinite; font-weight: bold; }
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
  .crow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .form input[type=text], .form input[type=number], .form select, .form textarea { width: 100%; }
  .form textarea { min-height: 54px; font-family: monospace; }
  .kv-obj, .kv-list { display: flex; flex-direction: column; gap: 4px; width: 100%; }
  .kv-row { display: grid; grid-template-columns: minmax(70px, 1fr) 84px minmax(90px, 2fr) 24px; gap: 4px; align-items: start; }
  .kv-list > .kv-row { grid-template-columns: 84px minmax(90px, 1fr) 24px; }
  .kv-row .kv-val { min-width: 0; padding-left: 0; }
  .kv-row .kv-val .kv-obj, .kv-row .kv-val .kv-list { border-left: 2px solid var(--bd); padding-left: 6px; }
  .kv-x, .kv-add, .kv-chip { cursor: pointer; background: var(--bg3, transparent); border: 1px solid var(--bd); border-radius: 3px; }
  .kv-add { align-self: flex-start; color: var(--acc); padding: 2px 8px; }
  .kv-chip { padding: 1px 6px; font-size: 11px; margin: 0 3px 3px 0; }
  .kv-sug { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; }
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
  /* Timeline */
  .tl { margin-bottom: 8px; background: #0c0c0c; border: 1px solid #000; border-radius: 2px; padding: 4px 6px 6px; }
  .tl-axis { position: relative; height: 14px; border-bottom: 1px solid var(--bd); font-size: 9px; color: var(--mut); }
  .tl-axis span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
  .tl-axis span:first-child { transform: none; } .tl-axis span:last-child { transform: translateX(-100%); }
  .tl-body { position: relative; padding-top: 4px; min-height: 88px; }
  .tl-lane, .tl-klane { position: relative; height: 24px; margin-bottom: 3px; }
  .tl-klane { height: 16px; margin-bottom: 2px; }
  .tl-ev, .tl-kid { position: absolute; top: 0; bottom: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; cursor: pointer; border: 1px solid #000; border-radius: 2px; }
  .tl-ev { background: linear-gradient(#3a6f9a, #24506f); color: #fff; font: 700 11px/22px system-ui, sans-serif; padding: 0 5px; }
  .tl-ev.live { background: linear-gradient(#b3407a, #7d2455); }
  .tl-ev.ctl { background: linear-gradient(#555, #3a3a3a); }
  .tl-ev.fix { box-shadow: 0 0 0 1px var(--acc) inset; }
  .tl-ev.cued { background: linear-gradient(#c79a1c, #8a6a0a); color: #1a1100; }
  .tl-ev.onair { background: linear-gradient(#35b862, #1c8a48); color: #02150a; }
  .tl-kid { background: linear-gradient(#7c52b0, #5a3585); color: #f2e8ff; font: 10px/14px system-ui, sans-serif; padding: 0 4px; }
  .tl-kid.Fired, .tl-kid.Active { background: linear-gradient(#35b862, #1c8a48); color: #02150a; }
  .tl-kid.Failed { background: linear-gradient(#e05050, #a02020); }
  .tl-kid.Completed, .tl-kid.Cancelled { opacity: .5; }
  .tl-ev:hover, .tl-kid:hover { filter: brightness(1.2); }
  .tl-ev span, .tl-kid span { pointer-events: none; }
  .tl-now { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: #ff4040; pointer-events: none; box-shadow: 0 0 4px #ff4040; }
  .chip.empty { opacity: .45; }
  .combo { flex: 1; min-width: 0; width: 100%; }
  .combo > input { width: 100%; }
  .combo-list { max-height: 220px; overflow: auto; margin-top: 2px; background: #06121c; border: 1px solid #1d3b52; border-radius: 2px; scrollbar-width: thin; }
  .combo-list .it { padding: 4px 8px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-bottom: 1px solid #0d2233; }
  .combo-list .it:hover { background: #0e3340; } .combo-list .it.cur { color: #fff; background: #0e4a63; } .combo-list .it.none { color: var(--mut); font-style: italic; }
  .chip.prob { background: #ff4040; color: #fff; font-weight: 800; letter-spacing: .04em; animation: probblink 1.6s ease-in-out infinite; }
  .chip.prob.bad { background: #ff9f1c; color: #1a0f00; }
  @keyframes probblink { 50% { opacity: .55; } }
  .pl-row.miss:not(.onair) { background: repeating-linear-gradient(135deg, #4a1414 0 8px, #331010 8px 16px); border-left: 5px solid #ff4040; box-shadow: inset 0 0 0 1px #ff404077; }
  .pl-row.bad:not(.onair) { background: repeating-linear-gradient(135deg, #46300c 0 8px, #33240a 8px 16px); border-left: 5px solid #ff9f1c; box-shadow: inset 0 0 0 1px #ff9f1c77; }
  .pl-row.miss .title .txt { color: #ff9a9a; font-weight: 700; } .pl-row.bad .title .txt { color: #ffc46b; font-weight: 700; }
  .tl-ev.miss, .tl-ev.bad { background: repeating-linear-gradient(135deg, #c42b2b 0 6px, #7a1414 6px 12px); color: #fff; box-shadow: 0 0 0 2px #ff4040; z-index: 1; }
  .tl-ev.bad { background: repeating-linear-gradient(135deg, #d98a14 0 6px, #7a4a08 6px 12px); box-shadow: 0 0 0 2px #ff9f1c; }
  .tl-kid.Failed { box-shadow: 0 0 0 2px #ff4040; font-weight: 800; }
  .pl-list { overflow-y: scroll; overflow-x: hidden; scrollbar-width: thin; }
  .pl-list::-webkit-scrollbar { width: 8px; }
  .cnt-row { position: relative; display: grid; gap: 6px; height: 24px; margin-bottom: 6px; align-items: stretch; }
  .cnt-row .chip { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 20px; padding: 2px 8px; min-width: 0; }
  .cnt-gear { padding: 0; height: 24px; }
  .cnt-pop { display: none; position: absolute; right: 0; top: 28px; z-index: 6; background: var(--bg3); border: 1px solid var(--bd); border-radius: 2px; padding: 8px; flex-direction: column; gap: 4px; box-shadow: 0 6px 20px #000a; }
  .cnt-pop.show { display: flex; }
  .cnt-pop label { display: flex; gap: 6px; align-items: center; white-space: nowrap; }
  /* ───── Konsole-2-Optik (wie Audio-/Videomischer) ───── */
  :host { --bg: #111; --bg2: #1a1a1a; --bg3: #262626; --bd: #2c2c2c; --mut: #7d848c; --acc: #27e0f0; --ok: #25d366; --warn: #ffb000; --err: #ff4040;
    font: 11px/1.25 ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace; background: #111; padding: 6px; }
  input, select, textarea { background: #06121c; color: var(--acc); border-color: #1d3b52; border-radius: 2px; }
  button { background: linear-gradient(#3a3a3a, #262626); border: 1px solid #060606; border-radius: 2px; text-transform: uppercase; letter-spacing: .03em; font-weight: 700; font-size: 10px;
    box-shadow: 0 1px 0 rgba(255,255,255,.12) inset, 0 1px 2px rgba(0,0,0,.5); }
  button:hover:not(:disabled) { background: linear-gradient(#444, #2d2d2d); border-color: #060606; }
  button.on, button.primary { background: linear-gradient(#32b6c6, #168593); color: #001a1f; border-color: #46e6f6; }
  button.danger { background: linear-gradient(#3a2a2a, #261a1a); }
  .take { background: linear-gradient(#ff5a5a, #c01f1f); border-color: #000; color: #fff; }
  .head { padding: 4px 6px; background: linear-gradient(#262626, #171717); border: 1px solid #000; border-radius: 2px; }
  .clock { color: #e8e8e8; }
  .chip { border-radius: 2px; background: #2c2c2c; text-transform: uppercase; letter-spacing: .03em; font-size: 10px; font-weight: 700; }
  .chip.blue { background: #0e4a63; color: var(--acc); } .chip.ok { background: #136b36; } .chip.onair { background: #25d366; color: #02150a; }
  .nextfix, .info { font-weight: 700; }
  .ptabs { border-bottom-color: #000; }
  .ptab { border-radius: 2px 2px 0 0; text-transform: uppercase; letter-spacing: .06em; font-size: 10px; }
  .ptab.act { background: linear-gradient(#32b6c6, #168593); color: #001a1f; box-shadow: none; border-color: #46e6f6; }
  details.sec { border-radius: 2px; border-color: #000; background: var(--bg2); }
  details.sec > summary { background: #202020; text-transform: uppercase; letter-spacing: .12em; font-size: 10px; color: #9aa3ad; }
  .pl-hdr { background: #202020; }
  .pl-row { border-bottom-color: #222; }
  .pl-row.sel { background: #0e3340; } .pl-row.onair { background: #0f2a1a; } .pl-row.cued { background: #2e2408; }
  .modal { border-radius: 2px; background: #1a1a1a; border-color: #444; }
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
    let activeCartRemaining = 0;
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
    // Zähler bis zum nächsten Live-/Fix-/Quelle-fehlt-Event; jeder einzeln abschaltbar (nur in diesem Browser gemerkt).
    const CNT_KINDS = ["live", "fix", "miss", "man"];
    const cntOn = (() => { try { return { live: true, fix: true, miss: true, man: true, ...JSON.parse(localStorage.getItem("omp-pa-counters") || "{}") }; } catch { return { live: true, fix: true, miss: true, man: true }; } })();
    const cntEls = Object.fromEntries(CNT_KINDS.map((k) => [k, h("span", { class: "chip blue", style: cntOn[k] ? "" : "display:none" })]));
    // Feste Zeile: Höhe konstant, jeder angehakte Zähler hat einen gleich breiten Platz (Text wird gekürzt statt zu schieben);
    // die Auswahl liegt in einem Popover (⚙) und verschiebt nichts. Die Spaltenzahl ändert sich nur durch Umschalten durch den Nutzer.
    const cntCols = () => { const n = CNT_KINDS.filter((k) => cntOn[k]).length; return `repeat(${Math.max(n, 1)}, minmax(0, 1fr)) 26px`; };
    const cntPop = h("div", { class: "cnt-pop" },
      h("div", { style: "opacity:.7;font-size:10px;margin-bottom:2px" }, T("cntShow")),
      ...CNT_KINDS.map((k) => h("label", {},
        h("input", { type: "checkbox", checked: cntOn[k], onchange: (e) => {
          cntOn[k] = e.target.checked;
          try { localStorage.setItem("omp-pa-counters", JSON.stringify(cntOn)); } catch { /* ignorieren */ }
          cntEls[k].style.display = cntOn[k] ? "" : "none";
          nextFixEl.style.gridTemplateColumns = cntCols();
        } }),
        ` ${T("cnt" + k[0].toUpperCase() + k.slice(1))}`)));
    const cntBtn = h("button", { class: "cnt-gear", title: T("cntShow"), onclick: () => cntPop.classList.toggle("show") }, "⚙");
    const nextFixEl = h("div", { class: "cnt-row", style: `grid-template-columns:${cntCols()}` },
      ...CNT_KINDS.map((k) => cntEls[k]), cntBtn, cntPop);
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
    // Idle-Quelle: Art + Wert, als „art:wert“ im Parameter idleSource.
    const idleKind = h("select", { id: "idleKind" }, ...[["", T("idle.black")], ["live", T("idle.live")], ["file", T("idle.file")], ["image", T("idle.image")], ["pattern", T("idle.pattern")]].map(([v, t]) => h("option", { value: v }, t)));
    const IMG_RE = /\.(png|jpe?g|bmp|gif|tiff?|webp|svg)$/i;
    const idleVal = h("select", { id: "idleVal", style: "flex:1;min-width:0" });
    const idleSend = () => setParam("idleSource", idleKind.value && idleVal.value ? `${idleKind.value}:${idleVal.value}` : "");
    // Auswahlliste je Art: nur passende Medien (Videos bzw. Bilder), bekannte Live-Quellen, Testmuster-Namen.
    const idleFill = (cur = idleVal.value) => {
      const k = idleKind.value;
      idleVal.style.display = k ? "" : "none";
      let opts = [];
      if (k === "live") opts = availableSources.map((s) => [s.label || s.senderId, s.label || s.senderId]);
      if (k === "live") { const byId = availableSources.find((s) => s.senderId === cur); if (byId) cur = byId.label || cur; }
      else if (k === "file") opts = mediaLibrary.filter((f) => !IMG_RE.test(f)).map((f) => [f, f]);
      else if (k === "image") opts = mediaLibrary.filter((f) => IMG_RE.test(f)).map((f) => [f, f]);
      else if (k === "pattern") opts = PATTERNS.map((p) => [p, p]);
      if (cur && !opts.some(([v]) => v === cur)) opts.unshift([cur, cur]);
      const empty = k && opts.length === 0 ? [["", k === "live" ? T("ed.noSources") : T("ed.noMedia")]] : [["", T("idle.choose")]];
      idleVal.replaceChildren(...[...empty, ...opts].map(([v, t]) => h("option", { value: v }, t)));
      idleVal.value = cur || "";
    };
    idleKind.addEventListener("change", () => { idleFill(""); if (!idleKind.value) idleSend(); });
    idleVal.addEventListener("change", idleSend);
    const idleBox = h("label", {}, T("idle.label"), h("div", { style: "display:flex;gap:6px" }, idleKind, idleVal));
    const targetsSec = h("details", { class: "sec" },
      h("summary", {}, T("sec.targets")),
      h("div", { class: "body targets" },
        h("label", {}, T("tgt.a"), selA), h("label", {}, T("tgt.b"), selB), h("label", {}, T("tgt.mixer"), selMix),
        h("label", {}, T("tgt.gfx"), selGfx), h("label", {}, T("tgt.audio"), selAud),
        h("label", {}, T("tgt.preflight"), h("input", { type: "number", min: "0", id: "preflightWin", onchange: (e) => setParam("preflightWindowMin", Number(e.target.value) || 0) })),
        h("label", {}, T("tgt.filler"), h("input", { type: "text", id: "defaultFiller", onchange: (e) => setParam("defaultFiller", e.target.value.trim()) })),
        idleBox,
        h("div", { class: "hint", style: "grid-column:1/-1" }, T("idle.hint")),
        h("label", { style: "flex-direction:row;align-items:center;gap:6px;grid-column:1/-1" }, h("input", { type: "checkbox", id: "requireRelease", onchange: (e) => setParam("requireRelease", e.target.checked) }), T("tgt.release")),
        h("div", { style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap;grid-column:1/-1" },
          h("label", { style: "flex-direction:row;align-items:center;gap:6px" }, h("input", { type: "checkbox", id: "mixerAutoSetup", onchange: (e) => setParam("mixerAutoSetup", e.target.checked) }), T("tgt.mixAuto")),
          h("button", { title: T("tgt.mixSetupTip"), onclick: () => act("setupMixers", {}) }, T("tgt.mixSetup"))),
        h("div", { class: "hint", style: "grid-column:1/-1" }, T("tgt.mixHint"))));
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
    // Problem-Zustand eines Events: "miss" (Quelle/Datei fehlt), "bad" (nicht bereit, Plan-Warnung, fehlgeschlagenes Child) oder "".
    const problemOf = (it) => {
      if (it.eventType === "HOLD" || it.eventType === "JUMP") return null;
      if (!(it.available ?? true)) return { kind: "miss", text: T("badMiss") };
      if (it.asset && it.readiness === "NOT_READY") return { kind: "bad", text: T("badErr"), tip: it.readinessDetail || "" };
      const w = planById.get(it.id)?.warnings;
      if (w && w.length) return { kind: "bad", text: T("badErr"), tip: w.join("\n") };
      if (childRuntime.some((c) => c.itemId === it.id && c.state === "Failed")) return { kind: "bad", text: T("badKid"), tip: childRuntime.find((c) => c.itemId === it.id && c.state === "Failed").error || "" };
      return null;
    };
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
      ...[["", ""], ["#", ""], ["", ""], [T("col.title"), ""], [T("col.dur"), "c-dur"], [T("col.time"), "c-time"], [T("col.rem"), "c-rem"]].map(([t, c]) => {
        const span = h("span", { class: c, style: c ? "position:relative" : "" }, t);
        if (c) span.append(resizeHandle(c.slice(2)));
        return span;
      }),
      ...EXTRA_COLS.map((c) => h("span", { class: `c-${c.k}` }, c.t)),
      h("span", {}, ""), h("span", {}, ""));
    const searchInput = h("input", { type: "search", placeholder: T("search"), oninput: () => { search = searchInput.value.trim().toLowerCase(); renderList(); } });
    const colsPop = h("div", { class: "cols-pop" },
      ...[["dur", T("col.dur")], ["time", T("col.time")], ["rem", T("col.rem")]].map(([k, t]) =>
        h("label", {}, h("input", { type: "checkbox", checked: !prefs[`hide-${k}`], onchange: (e) => { prefs[`hide-${k}`] = !e.target.checked; savePrefs(); applyCols(); } }), t)),
      ...EXTRA_COLS.map((c) =>
        h("label", {}, h("input", { type: "checkbox", checked: !!prefs[`show-${c.k}`], onchange: (e) => { prefs[`show-${c.k}`] = e.target.checked; savePrefs(); applyCols(); renderList(); } }), c.t)));
    const colsBtn = h("button", { title: T("columns"), onclick: () => colsPop.classList.toggle("show") }, "⚙");
    // Spaltenbreite per Maus ziehen (je Browser gemerkt); Doppelklick auf den Griff = Standardbreite.
    const COL_DEFAULT = { dur: 82, time: 116, rem: 96 };
    function resizeHandle(k) {
      const g = h("span", { class: "rz", title: T("col.resize") });
      g.addEventListener("dblclick", (e) => { e.stopPropagation(); delete prefs[`w-${k}`]; savePrefs(); applyCols(); });
      g.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const x0 = e.clientX, w0 = prefs[`w-${k}`] || COL_DEFAULT[k];
        g.setPointerCapture(e.pointerId);
        const move = (ev) => { prefs[`w-${k}`] = Math.max(36, Math.min(320, Math.round(w0 + ev.clientX - x0))); applyCols(); };
        const up = () => { g.removeEventListener("pointermove", move); g.removeEventListener("pointerup", up); savePrefs(); };
        g.addEventListener("pointermove", move);
        g.addEventListener("pointerup", up);
      });
      return g;
    }
    const applyCols = () => {
      for (const k of ["dur", "time", "rem"]) plMain.classList.toggle(`hide-${k}`, !!prefs[`hide-${k}`]);
      for (const c of EXTRA_COLS) plMain.classList.toggle(`hide-${c.k}`, !prefs[`show-${c.k}`]);
      const parts = ["16px", "26px", "22px", "minmax(150px,1.4fr)"];
      if (!prefs["hide-dur"]) parts.push(`${prefs["w-dur"] || COL_DEFAULT.dur}px`);
      if (!prefs["hide-time"]) parts.push(`${prefs["w-time"] || COL_DEFAULT.time}px`);
      if (!prefs["hide-rem"]) parts.push(`${prefs["w-rem"] || COL_DEFAULT.rem}px`);
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
      h("button", { title: T("checkReady"), onclick: () => checkReadiness() }, "✓"),
      h("div", { class: "sep" }),
      h("button", { class: "go", title: T("startNow"), onclick: () => startNow() }, "▶"),
      h("button", { title: T("copyEv"), onclick: () => copySel(false) }, "⎘"),
      h("button", { title: T("cutEv"), onclick: () => copySel(true) }, "✂"),
      h("button", { title: T("pasteEv"), onclick: () => pasteSel() }, "📋"),
      h("button", { class: "danger", title: T("delEv"), onclick: () => removeItems(orderedSel()) }, "🗑"));
    // Optionale Timeline (je Browser gemerkt): Events als Blöcke auf einer Zeitachse, darunter ihre Child Events.
    let tlOn = false, tlWinMin = 15;
    try { tlOn = localStorage.getItem("omp-pa-timeline") === "1"; tlWinMin = Number(localStorage.getItem("omp-pa-timeline-win")) || 15; } catch { /* Standard */ }
    const tlEl = h("div", { class: "tl", style: tlOn ? "" : "display:none" });
    const tlWinSel = h("select", { title: T("tlWin"), style: tlOn ? "" : "display:none", onchange: () => { tlWinMin = Number(tlWinSel.value); try { localStorage.setItem("omp-pa-timeline-win", String(tlWinMin)); } catch { /* egal */ } renderTimeline(); } },
      ...[5, 15, 30, 60, 120].map((m) => h("option", { value: String(m) }, `${m} min`)));
    tlWinSel.value = String(tlWinMin);
    const tlBtn = h("button", { title: T("tlTip"), class: tlOn ? "on" : "", onclick: () => {
      tlOn = !tlOn;
      try { localStorage.setItem("omp-pa-timeline", tlOn ? "1" : "0"); } catch { /* egal */ }
      tlBtn.classList.toggle("on", tlOn); tlEl.style.display = tlOn ? "" : "none"; tlWinSel.style.display = tlOn ? "" : "none";
      renderTimeline();
    } }, `▤ ${T("tlBtn")}`);
    const plMain = h("div", { class: "pl-main" },
      h("div", { class: "pl-tools", style: "position:relative" }, searchInput, tlBtn, tlWinSel, colsBtn, colsPop),
      tlEl, hdr, listEl, emptyEl);
    const playlistSec = h("details", { class: "sec", open: true },
      h("summary", {}, T("sec.playlist")),
      h("div", { class: "body" }, h("div", { class: "pl-wrap" }, sidebar, plMain)));

    // ---- Assets / Carts --------------------------------------------------
    const cartBanner = h("div", { class: "cart-banner" });
    const cartBannerLabel = h("span");
    const cartNextBtn = h("button", { onclick: () => act("cart.next", {}) }, T("cart.next"));
    cartBanner.append(cartBannerLabel, cartNextBtn, h("button", { onclick: () => act("cart.return", {}) }, "RETURN"));
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

    // ---- Fremdliste / Mitlauf (Kapitel 74) --------------------------------
    const pluginCall = async (pluginId, patch) => {
      const list = await fetch(`/api/v1/nodes/${nodeId}/plugins`).then((r) => (r.ok ? r.json() : []));
      const cur = (Array.isArray(list) ? list : list.plugins || []).find((p) => p.id === pluginId);
      const body = { ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}), config: { ...(cur?.config || {}), ...(patch.config || {}) } };
      return fetch(`/api/v1/nodes/${nodeId}/plugins/${pluginId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    };
    const fmtAge = (ms) => (ms === null || ms === undefined ? "?" : ms < 90000 ? `${Math.round(ms / 1000)} s` : ms < 5400000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} h`);
    const groupList = (title, g) => h("div", { class: "hint" }, `${title}: ${g?.count ? g.count : T("fo.none")}`,
      ...(g?.groups || []).slice(0, 6).map((x) => h("div", { style: "margin-left:10px" }, `${x.count}× ${x.reason}`)));
    const foBody = h("div", { class: "body" });
    const foreignSec = h("details", { class: "sec" }, h("summary", {}, T("sec.foreign")), foBody);
    let foKey = "";
    function renderForeign(st) {
      if (!st || !Array.isArray(st.adapters)) return;
      const key = JSON.stringify(st);
      if (key === foKey || foBody.contains(shadow.activeElement)) return;
      foKey = key;
      const kids = [];
      for (const a of st.adapters) {
        const row = h("div", { style: "border-bottom:1px solid var(--bd);padding:6px 0" });
        row.append(h("div", { style: "font-weight:600" }, a.label, " ", h("span", { class: "chip" }, a.enabled ? "an" : "aus")));
        if (!a.enabled) {
          const dir = h("input", { type: "text", placeholder: T("fo.dir"), value: a.watchDir || "", style: "flex:1;min-width:200px" });
          const ck = h("input", { type: "text", placeholder: T("fo.key"), value: a.channelKey || "", style: "width:150px" });
          row.append(h("div", { class: "hint" }, T("fo.off")), h("div", { class: "ctrl" }, dir, ck, h("button", {
            onclick: async () => { await pluginCall(a.pluginId, { enabled: true, config: { watchDir: dir.value.trim(), channelKey: ck.value.trim() } }); foKey = ""; poll(); },
          }, T("fo.enable"))));
        } else if (!a.file) {
          row.append(h("div", { class: "hint" }, a.error || T("fo.waiting", { dir: a.watchDir || "?" })));
          for (const r of a.rejected || []) row.append(h("div", { class: "hint", style: "margin-left:10px" }, `${T("fo.rejected")}: ${r}`));
        } else {
          row.append(
            h("div", { class: "hint" }, `${T("fo.file")}: ${a.file} · ${a.channel || ""} · ${T("fo.age")} ${fmtAge(a.ageMs)} · `,
              h("b", { style: a.stale ? "color:#f66" : "color:#7c7" }, a.stale ? T("fo.stale") : T("fo.fresh"))),
            h("div", { class: "hint" }, `${T("fo.onair")}: ${a.onAir ? a.onAir.title : "?"} · ${T("fo.events")}: ${a.events} · ${T("fo.changes")}: +${a.diff.added} −${a.diff.removed} ~${a.diff.changed}`),
            ...(a.error ? [h("div", { class: "hint", style: "color:#f66" }, a.error)] : []),
            ...(a.rejected || []).map((r) => h("div", { class: "hint", style: "margin-left:10px" }, `${T("fo.rejected")}: ${r}`)),
            groupList(T("fo.approx"), a.report?.approximated), groupList(T("fo.dropped"), a.report?.dropped));
        }
        if (a.enabled) {
          row.append(h("div", { class: "ctrl", style: "margin-top:6px" },
            h("button", { onclick: () => act("foreign.rescan", {}) }, T("fo.rescan")),
            a.file ? h("button", { class: "danger", onclick: async () => {
              if (!(await confirmDialog(T("fo.takeoverAsk", { title: a.onAir ? a.onAir.title : "?" }), T("fo.takeoverGo")))) return;
              const err = await tryCall("foreign.takeover", { adapter: a.id });
              showBanner(err || T("fo.done", { n: "✓" }), !err);
              poll();
            } }, T("fo.takeover")) : null,
            h("button", { onclick: async () => { await pluginCall(a.pluginId, { enabled: false }); foKey = ""; poll(); } }, T("fo.disable"))));
        }
        kids.push(row);
      }
      const pick = h("input", { type: "file", accept: ".mpl,.xml,text/xml", style: "display:none", onchange: async (e) => {
        const f = e.target.files[0];
        e.target.value = "";
        if (f) openImport(await f.text());
      } });
      kids.push(h("div", { class: "ctrl", style: "margin-top:6px" }, pick, h("button", { onclick: () => pick.click() }, T("fo.import"))));
      foBody.replaceChildren(...kids);
    }
    async function openImport(text) {
      const err = await tryCall("foreign.import", { text, mode: "preview" });
      if (err) { showBanner(err); return; }
      const rep = (await getParam("foreignStatus"))?.import || {};
      const close = () => ov.remove();
      const run = async (mode) => {
        const e2 = await tryCall("foreign.import", { text, mode });
        close();
        const r2 = (await getParam("foreignStatus"))?.import || {};
        showBanner(e2 || (r2.errors?.length ? T("fo.errors", { n: r2.errors.length, first: r2.errors[0] }) : T("fo.done", { n: r2.applied ?? 0 })), !e2 && !r2.errors?.length);
        poll();
      };
      const ov = h("div", { class: "overlay" }, h("div", { class: "modal", style: "width:min(620px,96vw)" },
        h("header", {}, T("fo.preview"), h("span", {}, `${rep.channel || ""} · ${rep.format || ""}`)),
        h("div", { class: "content", style: "min-height:120px" },
          h("div", {}, T("fo.items", { n: rep.items ?? 0 }), " · ", T("fo.skippedDone", { n: rep.skippedDone ?? 0 })),
          groupList(T("fo.approx"), rep.approximated), groupList(T("fo.dropped"), rep.dropped),
          ...(rep.warnings || []).slice(0, 5).map((w) => h("div", { class: "hint" }, w))),
        h("footer", {}, h("button", { onclick: close }, T("fo.cancel")),
          h("button", { onclick: () => run("append") }, T("fo.append")),
          h("button", { class: "danger", onclick: () => run("replace") }, T("fo.replace")))));
      shadow.append(ov);
    }

    // ---- Channel verknüpfen --------------------------------------------------
    let chList = [], chAt = 0, myInstance = "", chCurrentId = "";
    const chSel = h("select", {});
    const chStatusEl = h("div", { class: "hint", style: "grid-column:1/-1" });
    const chNewName = h("input", { type: "text", placeholder: T("ch.newPh") });
    const putChannel = async (c, patch) => {
      const body = { name: c.name, timezone: c.timezone, group: c.group || "", instanceId: c.instanceId || "", workflowId: c.workflowId || "", role: c.role || "", config: c.config || {}, ...patch };
      const res = await fetch(`/api/v1/playout/channels/${encodeURIComponent(c.id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.text().catch(() => "")) || `HTTP ${res.status}`);
    };
    const loadChannels = async (force) => {
      if (!force && Date.now() - chAt < 8000) return;
      chAt = Date.now();
      try {
        const res = await fetch("/api/v1/playout/channels");
        if (res.ok) chList = await res.json();
      } catch { /* Liste bleibt */ }
      const mine = chList.find((c) => myInstance && c.instanceId === myInstance);
      const cur = mine ? mine.id : chCurrentId;
      const opts = [["", T("ch.none")], ...chList.map((c) => [c.id, c.name + (c.id === cur ? T("ch.here") : c.workflowId ? T("ch.role") : c.instanceId ? T("ch.other") : "")])];
      const key = JSON.stringify(opts) + cur;
      if (chSel.dataset.k !== key) {
        chSel.dataset.k = key;
        chSel.replaceChildren(...opts.map(([v, t]) => h("option", { value: v }, t)));
        if (shadow.activeElement !== chSel) chSel.value = cur || "";
      }
    };
    const chDo = async (fn) => {
      try { await fn(); } catch (e) { showBanner(T("ch.err", { e: e.message })); }
      await loadChannels(true);
      poll();
    };
    const linkTo = async (c) => {
      if (!myInstance) { showBanner(T("ch.noId")); return; }
      const mine0 = chList.find((x) => x.instanceId === myInstance);
      // Instanz hängt bereits über eine Workflow-Rolle an einem Channel (gefunden, aber nicht direkt gebunden).
      const viaRole = chCurrentId && !mine0 && chCurrentId !== c.id;
      if (c.workflowId || viaRole) {
        // Extreme Warnung, zweistufig: zwei Schreiber auf demselben Channel zerstören Playlist und Sendeablauf.
        if (!(await confirmDialog(T(c.workflowId ? "ch.wfWarn" : "ch.roleWarn", { name: c.name }), T("ch.wfWarnGo")))) return;
        if (!(await confirmDialog(T("ch.wfWarn2", { name: c.name }), T("ch.wfWarnGo2")))) return;
      } else if (c.instanceId && c.instanceId !== myInstance) {
        if (!(await confirmDialog(T("ch.takeover", { name: c.name }), T("ch.link")))) return;
      }
      // Höchstens ein Channel je Instanz: einen bisherigen zuerst lösen.
      const old = chList.find((x) => x.instanceId === myInstance && x.id !== c.id);
      if (old) await putChannel(old, { instanceId: "" });
      await putChannel(c, { instanceId: myInstance });
      showBanner(T("ch.linked", { name: c.name }), true);
    };
    const channelSec = h("details", { class: "sec", open: true },
      h("summary", {}, T("sec.channel")),
      h("div", { class: "body targets" },
        h("label", {}, T("sec.channel"), chSel),
        h("div", { class: "ctrl", style: "align-self:end" },
          h("button", { class: "primary", onclick: () => chDo(async () => {
            const c = chList.find((x) => x.id === chSel.value);
            if (!c) throw new Error(T("ch.none"));
            await linkTo(c);
          }) }, T("ch.link")),
          h("button", { onclick: () => chDo(async () => {
            if (!myInstance) throw new Error(T("ch.noId"));
            const c = chList.find((x) => x.instanceId === myInstance);
            if (!c) { showBanner(chCurrentId ? T("ch.viaRole") : T("ch.notLinked")); return; }
            await putChannel(c, { instanceId: "" });
            showBanner(T("ch.unlinked"), true);
          }) }, T("ch.unlink"))),
        h("label", {}, T("ch.new"), chNewName),
        h("div", { class: "ctrl", style: "align-self:end" },
          h("button", { onclick: () => chDo(async () => {
            const name = chNewName.value.trim();
            if (!name) throw new Error(T("ch.newPh"));
            const res = await fetch("/api/v1/playout/channels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, group: "", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" }) });
            if (!res.ok) throw new Error((await res.text().catch(() => "")) || `HTTP ${res.status}`);
            chNewName.value = "";
            await loadChannels(true);
            const created = chList.find((x) => x.name === name);
            if (created) await linkTo(created);
          }) }, "＋")),
        chStatusEl,
        h("div", { class: "hint", style: "grid-column:1/-1" }, T("ch.hint")),
        h("div", { class: "hint", style: "grid-column:1/-1" }, T("ch.overwrite"))));

    // ---- Audio-Ausgabe dieses Channels (Audio-Regeln je Channel) ---------------------------------------------
    // Derselbe Editor wie Admin → Playout → Audio-Ausgabe, aber für das Dokument DIESES Channels; ohne eigenes Dokument gilt
    // der Plattform-Standard. Der Editor liegt im Modul-Bundle der Shell und wird erst beim Aufklappen geladen.
    let arEl = null, arChannel = "", arLoading = false;
    const arBody = h("div", { class: "body" }, h("div", { class: "hint" }, T("ar.needChannel")));
    const audioSec = h("details", { class: "sec" },
      h("summary", {}, T("sec.audio")),
      arBody);
    const ensureAudioEditor = async () => {
      if (!audioSec.open || arLoading) return;
      if (!chCurrentId) {
        if (arEl) { arEl.remove(); arEl = null; arChannel = ""; }
        arBody.replaceChildren(h("div", { class: "hint" }, T("ar.needChannel")));
        return;
      }
      if (arEl && arChannel === chCurrentId) return;
      if (arEl) { arChannel = chCurrentId; arEl.setAttribute("channel-id", chCurrentId); return; }
      arLoading = true;
      try {
        if (!customElements.get("omp-audio-rules")) await import("/dist/modules/audio-rules.js");
        arEl = document.createElement("omp-audio-rules");
        arEl.setAttribute("channel-id", chCurrentId);
        arChannel = chCurrentId;
        arBody.replaceChildren(h("div", { class: "hint", style: "margin-bottom:6px" }, T("ar.hint")), arEl);
      } catch (e) {
        arBody.replaceChildren(h("div", { class: "hint" }, T("ar.loadFail", { e: String(e && e.message || e) })));
      }
      arLoading = false;
    };
    audioSec.addEventListener("toggle", ensureAudioEditor);

    // ---- Reiter: Sendung (Steuerung + Playlist) steht vorne, Einrichtung getrennt --------------------------
    const TABS = [
      ["live", T("tab.live"), [controlSec, playlistSec]],
      ["carts", T("tab.carts"), [cartsSec]],
      ["auto", T("tab.auto"), [triggerSec, adSec]],
      ["config", T("tab.config"), [channelSec, targetsSec, audioSec, foreignSec]],
    ];
    for (const [, , secs] of TABS) for (const sec of secs) if (sec !== audioSec) sec.open = true; // Audio-Editor erst auf Wunsch laden
    let activeTab = "live";
    try { activeTab = localStorage.getItem("omp-pa-tab") || "live"; } catch { /* ohne Speicher: Standard */ }
    if (!TABS.some(([k]) => k === activeTab)) activeTab = "live";
    const panes = TABS.map(([k, , secs]) => h("div", { class: "tabpane", "data-tab": k }, ...secs));
    const tabBar = h("div", { class: "ptabs", role: "tablist" }, ...TABS.map(([k, label]) =>
      h("button", { class: "ptab", role: "tab", "data-tab": k, onclick: () => showTab(k) }, label)));
    const showTab = (k) => {
      activeTab = k;
      try { localStorage.setItem("omp-pa-tab", k); } catch { /* ignorieren */ }
      tabBar.querySelectorAll(".ptab").forEach((b) => { const on = b.dataset.tab === k; b.classList.toggle("act", on); b.setAttribute("aria-selected", String(on)); });
      panes.forEach((p) => { p.style.display = p.dataset.tab === k ? "" : "none"; });
    };
    shadow.append(h("style", {}, STYLE), head, nextFixEl, planWarnEl, banner, tabBar, ...panes);
    showTab(activeTab);
    persistChip.style.cursor = "pointer";
    persistChip.addEventListener("click", () => showTab("config"));
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
      if (it.sourceSelector) return isPlaceholderSel(it.sourceSelector) ? "📡" : "🏷";
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
      if (isPlaceholderSel(it.sourceSelector)) return T("noSource");
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
    let suppressClickUntil = 0;

    // Zwischenablage (Kopieren = Kopien auf dem Server, Ausschneiden = beim Einfügen verschieben).
    let clip = { ids: [], cut: false };
    const orderedSel = () => items.filter((i) => selected.has(i.id)).map((i) => i.id);
    const startNow = async () => {
      const id = orderedSel()[0];
      if (!id) return showBanner(T("startNowNone"), true);
      try { await call("cue", { itemId: id }); await call("take", {}); } catch { /* Banner */ }
      poll();
    };
    const copySel = (cut) => {
      const ids = orderedSel();
      if (!ids.length) return;
      if (cut && ids.includes(currentItemId)) return showBanner(T("cutOnAir"), true);
      clip = { ids, cut: !!cut };
      showBanner(T(cut ? "clipCut" : "clipCopied", { n: ids.length }), true);
    };
    const pasteSel = async () => {
      if (!clip.ids.length) return showBanner(T("clipEmpty"), true);
      const sel = orderedSel();
      let at = sel.length ? items.findIndex((i) => i.id === sel[sel.length - 1]) + 1 : items.length;
      try {
        if (clip.cut) {
          const ids = clip.ids.filter((id) => items.some((i) => i.id === id));
          for (const id of ids) {
            const from = items.findIndex((i) => i.id === id);
            if (from < 0) continue;
            const to = at > from ? at - 1 : at;
            await call("moveItem", { itemId: id, toIndex: to });
            const [m] = items.splice(from, 1); items.splice(to, 0, m);
            if (from >= at) at++;
          }
          clip = { ids: [], cut: false };
        } else {
          await call("duplicateItems", { itemIdsJson: JSON.stringify(clip.ids), toIndex: at });
        }
      } catch { /* Banner */ }
      poll();
    };

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
      try { if (!this.hasAttribute("tabindex")) this.tabIndex = 0; this.focus({ preventScroll: true }); } catch { /* egal */ }
      renderList();
    };

    // Drag&Drop-Reorder (Pointer-Events, funktioniert mit Maus und Finger): echte serverseitige
    // `moveItem`-Umsortierung — der Cursor (on-air/gecued) folgt dem Event, kein Schwarzbild.
    const startDrag = (itemId, ev, rowEl, handle = ev.currentTarget) => {
      if (search) return showBanner(T("noReorderSearch"), true);
      ev.preventDefault();
      dragging = true;
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
        dropLine.style.top = `${(y ?? 0) + listEl.scrollTop}px`;
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
      row.addEventListener("click", (e) => { if (Date.now() < suppressClickUntil) return; select(refs.it.id, e); });
      // Ziehen an der ganzen Zeile (nach 5 px Bewegung); Klick/Doppelklick/Schaltflächen bleiben unberührt.
      row.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest("button,input,select,.chip,.drag")) return;
        const x0 = e.clientX, y0 = e.clientY, pid = e.pointerId;
        const probe = (m) => {
          if (Math.abs(m.clientX - x0) + Math.abs(m.clientY - y0) < 5) return;
          row.removeEventListener("pointermove", probe);
          suppressClickUntil = Date.now() + 400;
          startDrag(refs.it.id, { preventDefault() {}, pointerId: pid }, row, row);
        };
        const stop = () => { row.removeEventListener("pointermove", probe); row.removeEventListener("pointerup", stop); row.removeEventListener("pointercancel", stop); };
        row.addEventListener("pointermove", probe);
        row.addEventListener("pointerup", stop);
        row.addEventListener("pointercancel", stop);
      });
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
        const prob = problemOf(it);
        if (prob) r.row.classList.add(prob.kind);
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
        if (it.releaseRequired && it.release) {
          const blocked = it.release.blocked;
          if (blocked) { avText = "🔒"; avBad = true; avTip = T("av.releaseTip", { state: blocked }); }
          else avTip += `\n${T("av.releaseTip", { state: it.release.reason || "✓" })}`;
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
        if (prob) chips.push(h("span", { class: `chip prob ${prob.kind}`, title: prob.tip || prob.text }, `⚠ ${prob.text}`));
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

    // Zeitfenster eines Child Events relativ zum Beginn seines Primary (ms) oder null (ABSOLUTE: nicht auf der Primary-Achse).
    const childSpan = (c, dur, horizon) => {
      const t = c.timing || (c.relativeTo === "END" ? "RELATIVE_TO_END" : "RELATIVE_TO_START");
      if (t === "ABSOLUTE") return null;
      const end = dur > 0 ? dur : horizon;
      let a = 0;
      if (t === "RELATIVE_TO_START") a = c.delayMs || 0;
      else if (t === "RELATIVE_TO_END") a = Math.max(0, (dur > 0 ? dur : end) - (c.delayMs || 0));
      else if (t === "BEFORE_START") a = -(c.delayMs || 0);
      else if (t === "AFTER_END") a = (dur > 0 ? dur : end) + (c.delayMs || 0);
      const b = t === "FULL_PRIMARY" ? end : c.endAfterEndMs != null && dur > 0 ? dur + c.endAfterEndMs : c.endBeforeEndMs != null && dur > 0 ? Math.max(a + 1, dur - c.endBeforeEndMs) : !c.durationMs ? end : t === "AFTER_END" || t === "BEFORE_START" ? a + c.durationMs : Math.min(end, a + c.durationMs);
      return [a, Math.max(b, a + 1)];
    };
    const renderTimeline = () => {
      if (!tlOn) return;
      const W = tlWinMin * 60000;
      const ent = items.map((it, i) => ({ it, i, e: timeByIndex.get(i) })).filter((x) => x.e);
      if (!ent.length) { tlEl.replaceChildren(h("div", { class: "empty" }, T("tlEmpty"))); return; }
      const cur = ent.find((x) => x.it.id === currentItemId);
      const ref = cur ? cur.e.startMs + playheadMs : (ent.find((x) => x.it.id === cuedItemId) || ent[0]).e.startMs;
      const t0 = ref - W * 0.06, t1 = t0 + W;
      const pct = (ms) => `${((ms - t0) / W) * 100}%`;
      const clip = (a, b) => { const x = Math.max(a, t0), y = Math.min(b, t1); return y > x ? [x, y] : null; };
      const axis = h("div", { class: "tl-axis" });
      const step = W / 6;
      for (let k = 0; k <= 6; k++) {
        const ms = t0 + step * k;
        const rel = Math.round((ms - ref) / 1000);
        axis.append(h("span", { style: `left:${(k / 6) * 100}%` }, rel === 0 ? T("tlNow") : `${rel < 0 ? "−" : "+"}${fmtRemainTl(Math.abs(rel))}`));
      }
      const lane = h("div", { class: "tl-lane" });
      const kidRows = [];
      for (const { it, i, e } of ent) {
        const sp = clip(e.startMs, e.durationMs > 0 ? e.endMs : t1);
        if (!sp) continue;
        const prob = problemOf(it);
        const cls = `tl-ev${prob ? ` ${prob.kind}` : ""}${it.id === currentItemId ? " onair" : it.id === cuedItemId ? " cued" : ""}${it.startType === "fixtime" ? " fix" : ""}${it.senderId ? " live" : ""}${it.eventType === "HOLD" || it.eventType === "JUMP" ? " ctl" : ""}`;
        lane.append(h("div", { class: cls, style: `left:${pct(sp[0])};width:max(3px,calc(${pct(sp[1])} - ${pct(sp[0])}))`, title: `${prob ? `⚠ ${prob.text}${prob.tip ? ` — ${prob.tip}` : ""}\n` : ""}${it.label} · ${tcFormat(it.durationMs, TC_FPS)}`, onclick: (ev) => select(it.id, ev), ondblclick: () => openEditor(it) },
          h("span", {}, prob ? `⚠ ${it.label}` : it.label)));
        // Child Events: Lanes so vergeben, dass sich überlappende Balken nicht verdecken.
        (it.children || []).forEach((c, ci) => {
          const span = childSpan(c, e.durationMs, Math.max(0, t1 - e.startMs));
          if (!span) return;
          const s2 = clip(e.startMs + span[0], e.startMs + span[1]);
          if (!s2) return;
          let r = kidRows.findIndex((row) => row.every(([a, b]) => s2[1] <= a || s2[0] >= b));
          if (r < 0) { r = kidRows.length; kidRows.push([]); }
          kidRows[r].push(s2);
          const rt = childRuntime.find((x) => x.itemId === it.id && x.id === c.id);
          (kidRows[r].els ||= []).push(h("div", { class: `tl-kid ${rt ? rt.state : ""}`, style: `left:${pct(s2[0])};width:max(3px,calc(${pct(s2[1])} - ${pct(s2[0])}))`, title: `${c.templateId || c.target || c.url || c.type} · ${timingText(c)}`, onclick: () => openEditor(it, "kids", ci) },
            h("span", {}, `${CHILD_ICON[c.type] || "•"} ${c.templateId || c.target || c.url || c.type}`)));
        });
      }
      const nowX = h("div", { class: "tl-now", style: `left:${pct(ref)}` });
      const kidLanes = kidRows.map((row) => h("div", { class: "tl-klane" }, ...(row.els || [])));
      tlEl.replaceChildren(axis, h("div", { class: "tl-body" }, lane, ...kidLanes, nowX));
    };
    const fmtRemainTl = (sec) => { const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60; return `${hh > 0 ? `${hh}:${String(mm).padStart(2, "0")}` : mm}:${String(ss).padStart(2, "0")}`; };

    // Playlist-Raster nimmt die verfügbare Resthöhe des Fensters ein (scrollt intern, Kopfzeile bleibt stehen).
    const fitList = () => {
      if (activeTab !== "live" || !listEl.isConnected) return;
      const top = listEl.getBoundingClientRect().top;
      if (!top) return;
      const h2 = Math.max(220, Math.floor(window.innerHeight - top - 18));
      if (listEl.dataset.h !== String(h2)) { listEl.dataset.h = String(h2); listEl.style.height = `${h2}px`; }
    };
    window.addEventListener("resize", fitList);
    this._fit = fitList;
    const timingText = (c) => {
      const t = c.timing || (c.relativeTo === "END" ? "RELATIVE_TO_END" : "RELATIVE_TO_START");
      const d = c.endAfterEndMs != null ? `+${tcFormat(c.endAfterEndMs, TC_FPS)} ${T("ed.endAfter")}` : c.endBeforeEndMs != null ? `−${tcFormat(c.endBeforeEndMs, TC_FPS)} ${T("ed.endBefore")}` : c.durationMs ? tcFormat(c.durationMs, TC_FPS) : T("untilEnd");
      if (t === "ABSOLUTE") return `${c.atUtc ? formatLocalStart(c.atUtc) : "?"} · ${d}`;
      if (t === "FULL_PRIMARY") return T("fullDuration");
      return `${t === "RELATIVE_TO_END" || t === "BEFORE_START" ? "−" : "+"}${tcFormat(c.delayMs || 0, TC_FPS)}${t === "BEFORE_START" ? " ⟵" : t === "AFTER_END" ? " ⟶" : ""} · ${d}`;
    };

    // Delete-Taste (Fokus im Panel, nicht in einem Eingabefeld)
    this.addEventListener("keydown", (e) => {
      if (modalOpen) return;
      const tag = (shadow.activeElement && shadow.activeElement.tagName) || "";
      if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return;
      if ((e.ctrlKey || e.metaKey) && ["c", "x", "v"].includes(e.key.toLowerCase())) {
        e.preventDefault();
        const k = e.key.toLowerCase();
        if (k === "v") pasteSel(); else copySel(k === "x");
        return;
      }
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
    // Auswahlfeld mit Suche: Tippen filtert die Liste (Teiltreffer in Name und Wert), Klick wählt. `free`: freie Eingabe gilt als Wert (z. B. Asset-ID).
    const combo = (obj, key, getOptions, { placeholder = "", empty = "", free = false, noneLabel = "" } = {}) => {
      const labelOf = (v) => { const o = getOptions().find(([x]) => x === v); return o ? o[1] : v || ""; };
      const inp = h("input", { type: "text", placeholder, value: labelOf(obj[key] || ""), autocomplete: "off" });
      const list = h("div", { class: "combo-list", style: "display:none" });
      let q = "";
      const draw = () => {
        const all = getOptions();
        const hits = all.filter(([v, t]) => !q || `${t} ${v}`.toLowerCase().includes(q));
        const rows = [];
        if (noneLabel && !q) rows.push(h("div", { class: "it none", onmousedown: (e) => { e.preventDefault(); pick(""); } }, noneLabel));
        for (const [v, t] of hits.slice(0, 300)) rows.push(h("div", { class: `it${v === obj[key] ? " cur" : ""}`, title: v, onmousedown: (e) => { e.preventDefault(); pick(v); } }, t));
        if (hits.length > 300) rows.push(h("div", { class: "hint", style: "padding:3px 8px" }, T("pick.more", { n: hits.length - 300 })));
        if (!hits.length) rows.push(h("div", { class: "hint", style: "padding:6px 8px" }, all.length ? T("pick.noHit") : empty || T("pick.none")));
        list.replaceChildren(...rows);
      };
      const open = () => { draw(); list.style.display = ""; };
      const close = () => { list.style.display = "none"; };
      const pick = (v) => { obj[key] = v; inp.value = labelOf(v); close(); inp.dispatchEvent(new Event("combo-change")); };
      inp.addEventListener("focus", () => { q = ""; inp.select(); open(); });
      inp.addEventListener("input", () => { q = inp.value.toLowerCase(); if (free) obj[key] = inp.value.trim(); open(); });
      inp.addEventListener("blur", () => { close(); if (!free) inp.value = labelOf(obj[key] || ""); });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); const first = getOptions().find(([v, t]) => !q || `${t} ${v}`.toLowerCase().includes(q)); if (first && !free) pick(first[0]); else close(); }
        else if (e.key === "Escape") { close(); inp.blur(); }
      });
      inp.addEventListener("combo-refresh", () => { if (list.style.display === "") draw(); if (document.activeElement !== inp && shadow.activeElement !== inp) inp.value = labelOf(obj[key] || ""); });
      return h("div", { class: "combo" }, inp, list);
    };
    // Asset-Katalog des Orchestrators (für die Asset-Suche im Editor), kurz zwischengespeichert.
    let assetCatalog = [], assetCatalogAt = 0;
    const loadAssetCatalog = async () => {
      if (Date.now() - assetCatalogAt < 15000) return;
      assetCatalogAt = Date.now();
      try {
        const res = await fetch("/api/v1/assets");
        if (!res.ok) return;
        assetCatalog = (await res.json()).map((a) => [a.id, `${a.title || a.id}${a.type ? ` · ${a.type}` : ""} · ${String(a.id).slice(0, 8)}`]).sort((x, y) => x[1].localeCompare(y[1]));
      } catch { /* Eingabe der ID von Hand bleibt möglich */ }
    };
    const field = (label, ...ctrl) => [h("label", {}, label), h("div", { class: "row" }, ...ctrl)];

    // Live-Event ohne gewählte Quelle: Platzhalter (Selektor „exakte ID leer“ löst nie auf) → zählt als „Event ohne Quelle“, Quelle später im Editor wählbar.
    const isPlaceholderSel = (sel) => sel && sel.exactId === "";
    const mediaKindOf = (it) => {
      if (!it) return "pattern";
      if (it.asset) return "asset";
      if (it.eventType === "HOLD") return "hold";
      if (it.eventType === "JUMP") return "jump";
      if (it.eventType === "IMAGE") return "image";
      if (it.sourceSelector) return isPlaceholderSel(it.sourceSelector) ? "live" : "liveselect";
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

    // ---- Symbol-Auswahl --------------------------------------------------
    const ICON_SETS = () => [
      [T("ic.playback"), ["▶", "⏸", "⏹", "⏭", "⏺", "🔁", "⏩", "⏪"]],
      [T("ic.onair"), ["📺", "🎬", "🎥", "📡", "🔴", "⚫", "⬛", "⚪", "🟢", "🟡"]],
      [T("ic.audio"), ["🎵", "🎶", "🔊", "🔇", "🎤", "📢", "🔔", "🎧"]],
      [T("ic.notice"), ["⚠", "❗", "⏱", "⏰", "⌛", "☕", "🌙", "🚧", "🛑"]],
      [T("ic.misc"), ["★", "♥", "✓", "✕", "🏁", "🎯", "📰", "⚽", "🎭", "🎁", "🏆", "💬"]],
    ];
    function openIconPicker(current, onPick) {
      let m = null;
      const pick = (ic) => { onPick(ic); if (m) m.close(); };
      const custom = h("input", { type: "text", maxlength: "4", style: "width:70px", placeholder: T("ic.custom"), value: current && !ICON_SETS().some(([, l]) => l.includes(current)) ? current : "" });
      m = openModal({
        title: T("ic.title"),
        render: () => h("div", {},
          ...ICON_SETS().map(([title, list]) => h("div", { style: "margin-bottom:8px" },
            h("div", { style: "color:var(--mut);font-size:11px;margin-bottom:3px" }, title),
            h("div", { style: "display:flex;flex-wrap:wrap;gap:4px" }, ...list.map((ic) => h("button", { style: `font-size:20px;width:42px;height:38px;${ic === current ? "outline:2px solid var(--acc)" : ""}`, onclick: () => pick(ic) }, ic))))),
          h("div", { class: "crow" }, custom, h("button", { onclick: () => { if (custom.value.trim()) pick(custom.value.trim()); } }, T("ic.use")),
            h("button", { onclick: () => pick("") }, T("ic.none")))),
      });
    }
    // Symbolfeld mit Auswahlknopf: Textfeld (freies Zeichen) + Dialog
    const iconField = (obj, key) => {
      const inp = bindText(obj, key, { placeholder: T("ed.emoji"), style: "width:80px" });
      const btn = h("button", { title: T("cart.pickIcon"), onclick: () => openIconPicker(obj[key], (ic) => { obj[key] = ic; inp.value = ic; btn.textContent = ic || "☺"; }) }, obj[key] || "☺");
      inp.addEventListener("input", () => { btn.textContent = obj[key] || "☺"; });
      return [inp, btn];
    };

    // ---- Event-Editor ----------------------------------------------------
    const newKid = (n) => ({ id: `c${n}`, type: "GRAPHIC", timing: "RELATIVE_TO_START", delayMs: 0, durationMs: 0, templateId: "", failurePolicy: "WARN" });
    function openEditor(item, startTab, startKid, opts = {}) {
      const cart = !!opts.cart;
      const isNew = !item;
      const onAir = !!item && item.id === currentItemId;
      const d = {
        kind: mediaKindOf(item), label: item ? item.label : "", note: item?.note || "", adClass: item?.adClass || "", icon: item?.icon || "", color: item?.color || "",
        pattern: item?.pattern || "smpte", file: item?.file || "", senderId: item?.senderId || "",
        tags: item?.sourceSelector ? (item.sourceSelector.required || []).join(", ") : "", pref: item?.sourceSelector ? (item.sourceSelector.preferred || []).join(", ") : "",
        jumpTarget: item?.jumpTarget || "", assetId: item?.asset?.assetId || "", onMissing: item?.onMissing || "HOLD", fallbackFile: item?.fallbackFile || "",
        requireRelease: item?.requireRelease === true ? "true" : item?.requireRelease === false ? "false" : "",
        durationMs: item ? item.durationMs : cart ? 0 : 5000,
        startType: item?.startType || "sequence", endType: item?.endType || "sequence",
        startLocal: item?.startAt ? new Date(item.startAt).toLocaleString("sv-SE") : item?.fixtimeHms || "",
        transition: item?.transition || "cut", rateFrames: item?.transitionRateFrames ?? "",
        audioCap: item?.audio?.intent?.capability || "",
        audioMapping: item?.audioMapping || "",
      };
      const origSig = mediaSig(d);
      const origDur = d.durationMs;
      const kids = JSON.parse(JSON.stringify(item?.children || []));
      let kidIdx = Math.min(startKid ?? 0, kids.length - 1);

      const durationEditable = () => (cart ? true : ["pattern", "image", "live", "liveselect"].includes(d.kind));
      const block = [...(item?.follow || [])];
      const kindOptions = cart ? MEDIA_KINDS.filter(([k]) => ["pattern", "file", "image", "live", "liveselect"].includes(k)) : MEDIA_KINDS;

      const renderContent = (ctx) => {
        const f = h("div", { class: "form" });
        f.append(...field(T("ed.title"), bindText(d, "label", { placeholder: T("ed.title") })));
        f.append(...field(T("ed.type"), bindSelect(d, "kind", kindOptions, ctx.redraw)));
        if (onAir) f.querySelectorAll("select").forEach((s) => { s.disabled = true; });
        const dis = onAir ? { disabled: "" } : {};
        switch (d.kind) {
          case "pattern": f.append(...field(T("ed.pattern"), bindSelect(d, "pattern", PATTERNS.map((p) => [p, p])))); break;
          case "file": case "image": {
            const files = d.file && !mediaLibrary.includes(d.file) ? [d.file, ...mediaLibrary] : mediaLibrary;
            f.append(...field(T("ed.file"), combo(d, "file", () => files.map((x) => [x, x]), { placeholder: T("ed.chooseFile"), empty: T("ed.noMedia"), noneLabel: T("ed.chooseFile") })));
            if (d.kind === "file") f.append(...field(T("ed.release"), bindSelect(d, "requireRelease", [["", T("ed.releaseDefault")], ["true", T("ed.releaseYes")], ["false", T("ed.releaseNo")]])));
            break;
          }
          case "live": {
            const known = availableSources.map((s) => [s.senderId, s.label]);
            if (d.senderId && !known.some(([id]) => id === d.senderId)) known.unshift([d.senderId, d.senderId]);
            f.append(...field(T("ed.liveSource"), combo(d, "senderId", () => known, { placeholder: T("ed.chooseSource"), empty: T("ed.noSources"), noneLabel: T("ed.chooseSource") })));
            if (!d.senderId) f.append(h("div", { class: "hint" }, T("ed.liveNoSourceHint")));
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
            {
              const ac = combo(d, "assetId", () => assetCatalog, { placeholder: T("ed.assetIdPh"), empty: T("ed.noAssets"), free: true });
              f.append(...field(T("ed.assetId"), ac));
              loadAssetCatalog().then(() => ac.querySelector("input").dispatchEvent(new Event("combo-refresh")));
            }
            f.append(...field(T("ed.ifMissing"), bindSelect(d, "onMissing", MISSING_POLICIES)));
            f.append(...field(T("ed.fallbackFile"), combo(d, "fallbackFile", () => mediaLibrary.map((x) => [x, x]), { placeholder: T("ed.fallbackPh"), empty: T("ed.noMedia"), free: true })));
            break;
          default: break;
        }
        if (durationEditable()) f.append(...field(T("ed.durationMs"), bindTc(d, "durationMs", dis)));
        else if (d.kind === "file" || d.kind === "asset") f.append(h("div", { class: "hint" }, T("ed.durationHint")));
        if (cart) f.append(h("div", { class: "hint" }, T("cart.durationHint")));
        if (onAir) f.append(h("div", { class: "hint" }, T("ed.onAirHint")));
        f.append(...field(T("ed.note"), bindText(d, "note", { placeholder: T("ed.notePh") })));
        if (!cart) f.append(...field(T("ed.adClass"), bindSelect(d, "adClass", [["", T("ed.adNone")], ["commercial", T("ed.adCommercial")], ["promo", T("ed.adPromo")], ["block_start", T("ed.adStart")], ["block_end", T("ed.adEnd")]])));
        const color = h("input", { type: "color", value: d.color || "#4a90d9", oninput: (e) => { d.color = e.target.value; } });
        f.append(...field(T("ed.iconColor"), ...iconField(d, "icon"), color,
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
        if (!cart && d.kind !== "hold" && d.kind !== "jump") f.append(...field(T("ed.end"), bindSelect(d, "endType", [["sequence", T("ed.endSeq")], ["manual", T("ed.endHold")]])));
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
          const plan = item && !cart ? planOf(item) : null;
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

      const renderBlock = (ctx) => {
        const f = h("div", {});
        f.append(h("div", { class: "hint" }, T("cart.blockHint")));
        const nameOf = (id) => (assets.find((a) => a.id === id) || {}).label || id;
        if (!block.length) f.append(h("div", { class: "empty" }, T("cart.blockEmpty")));
        block.forEach((id, i) => f.append(h("div", { class: "crow", style: "margin-bottom:4px" },
          h("span", { style: "min-width:24px" }, `${i + 1}.`), h("span", { style: "flex:1;min-width:160px" }, nameOf(id)),
          h("button", { title: T("cart.blockUp"), disabled: i === 0 ? "" : null, onclick: () => { [block[i - 1], block[i]] = [block[i], block[i - 1]]; ctx.redraw(); } }, "↑"),
          h("button", { title: T("cart.blockDown"), disabled: i === block.length - 1 ? "" : null, onclick: () => { [block[i + 1], block[i]] = [block[i], block[i + 1]]; ctx.redraw(); } }, "↓"),
          h("button", { class: "danger", title: T("cart.blockRemove"), onclick: () => { block.splice(i, 1); ctx.redraw(); } }, "✕"))));
        const others = assets.filter((a) => a.id !== item?.id && !block.includes(a.id));
        const add = h("select", { onchange: (e) => { if (e.target.value) { block.push(e.target.value); ctx.redraw(); } } },
          h("option", { value: "" }, T("cart.blockAdd")), ...others.map((a) => h("option", { value: a.id }, a.label)));
        f.append(h("div", { class: "crow", style: "margin-top:8px" }, add));
        const steps = [d.durationMs, ...block.map((id) => (assets.find((a) => a.id === id) || {}).durationMs || 0)];
        const names = [d.label || (item?.label ?? ""), ...block.map(nameOf)];
        steps.forEach((dur, i) => { if (i < steps.length - 1 && !dur) f.append(h("div", { class: "hint", style: "color:var(--warn)" }, T("cart.blockNoDur", { label: names[i] }))); });
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

      // Editor zur Vorlage: ein Feld je Eintrag in schema.properties, schreibt direkt in k.data. Listen und verschachtelte
      // Objekte werden rekursiv nach dem Schema aufgebaut (ohne Schema: allgemeine Feld-/Listen-Editoren) — nie als JSON-Text.
      const schemaDefault = (p) => {
        if (!p) return "";
        if (p.default !== undefined) return JSON.parse(JSON.stringify(p.default));
        if (p.type === "object") {
          const o = {};
          for (const [n, q] of Object.entries(p.properties || {})) if (q && q.default !== undefined) o[n] = schemaDefault(q);
          return o;
        }
        return p.type === "array" ? [] : p.type === "boolean" ? false : p.type === "integer" || p.type === "number" ? 0 : "";
      };
      const schemaControl = (p, holder, n, onChange) => {
        p = p || {};
        const changed = () => { if (onChange) onChange(); };
        let ctl;
        if (Array.isArray(p.enum)) {
          ctl = bindSelect(holder, n, p.enum.map((e) => [String(e), String(e)]));
          ctl.addEventListener("change", () => { holder[n] = p.type === "integer" || p.type === "number" ? Number(ctl.value) : ctl.value; changed(); });
        } else if (p.type === "boolean") {
          ctl = h("input", { type: "checkbox", onchange: (e) => { holder[n] = e.target.checked; changed(); } });
          ctl.checked = !!holder[n];
        } else if (p.type === "integer" || p.type === "number") {
          ctl = h("input", { type: "number", step: p.type === "integer" ? "1" : "any", oninput: (e) => { if (e.target.value !== "") { holder[n] = Number(e.target.value); changed(); } } });
          if (p.minimum !== undefined) ctl.min = p.minimum;
          if (p.maximum !== undefined) ctl.max = p.maximum;
          ctl.value = holder[n] ?? "";
        } else if (p.type === "object") {
          if (!holder[n] || typeof holder[n] !== "object" || Array.isArray(holder[n])) holder[n] = {};
          ctl = p.properties ? schemaObject(p, holder[n], changed) : kvObjectEditor(holder[n], changed);
        } else if (p.type === "array") {
          if (!Array.isArray(holder[n])) holder[n] = [];
          ctl = schemaList(p.items || {}, holder[n], changed);
        } else {
          const isColor = /color/i.test(p.gddType || "") && /^#[0-9a-fA-F]{6}$/.test(String(holder[n] ?? ""));
          ctl = h("input", { type: isColor ? "color" : "text", oninput: (e) => { holder[n] = e.target.value; changed(); } });
          if (p.maxLength) ctl.maxLength = p.maxLength;
          ctl.value = holder[n] ?? "";
        }
        if (p.description) ctl.title = p.description;
        return ctl;
      };
      const schemaObject = (p, obj, onChange) => {
        const req = new Set(p.required || []);
        const box = h("div", { class: "kv-obj" });
        for (const [n, q] of Object.entries(p.properties || {})) {
          if (obj[n] === undefined && q && q.default !== undefined) obj[n] = schemaDefault(q);
          box.append(h("div", { class: "kv-sub" }, h("label", { class: "hint" }, (q && q.title || n) + (req.has(n) ? " *" : "")), schemaControl(q, obj, n, onChange)));
        }
        return box;
      };
      const schemaList = (itemSchema, arr, onChange) => {
        const box = h("div", { class: "kv-list" });
        const draw = () => {
          box.replaceChildren();
          arr.forEach((_, i) => {
            box.append(h("div", { class: "kv-row", style: "grid-template-columns:minmax(90px,1fr) 24px" }, h("div", { class: "kv-val" }, schemaControl(itemSchema, arr, i, onChange)),
              h("button", { type: "button", class: "kv-x", title: T("kv.remove"), onclick: () => { arr.splice(i, 1); if (onChange) onChange(); draw(); } }, "✕")));
          });
          box.append(h("button", { type: "button", class: "kv-add", onclick: () => { arr.push(schemaDefault(itemSchema)); if (onChange) onChange(); draw(); } }, T("kv.addItem")));
        };
        draw();
        return box;
      };
      const templateForm = (k, tpl, ctx) => {
        const props = tpl.schema.properties;
        const req = new Set(tpl.schema.required || []);
        if (!k.data || typeof k.data !== "object" || Array.isArray(k.data)) k.data = {};
        for (const [n, p] of Object.entries(props)) if (k.data[n] === undefined && p && p.default !== undefined) k.data[n] = schemaDefault(p);
        const box = h("div", { class: "form tpl-form" });
        box.append(h("div", { class: "hint", text: T("ed.tplFields", { name: tpl.label || tpl.id, n: Object.keys(props).length }) }));
        for (const [n, p] of Object.entries(props)) {
          box.append(...field((p.title || n) + (req.has(n) ? " *" : ""), schemaControl(p, k.data, n)));
        }
        return box;
      };

      // Beschreibung (Methoden mit Argumenten) des Ziel-Nodes, einmal je Label geladen; bis dahin ohne Vorschläge.
      const descCache = {};
      let nodeIndex = null;
      const loadDescriptor = (label, ctx) => {
        if (label in descCache) return descCache[label];
        descCache[label] = null;
        (async () => {
          try {
            if (!nodeIndex) nodeIndex = await fetch("/api/v1/nodes").then((r) => (r.ok ? r.json() : []));
            const n = nodeIndex.find((x) => x.label === label);
            if (!n) return;
            const r = await fetch(`/api/v1/nodes/${n.id}/descriptor`);
            if (r.ok) { descCache[label] = await r.json(); if (ctx && ctx.redraw) ctx.redraw(); }
          } catch { /* ohne Vorschläge weiter */ }
        })();
        return null;
      };
      const kidForm = (k, ctx) => {
        const f = h("div", { class: "form" });
        const rt = item && childRuntime.find((x) => x.itemId === item.id && x.id === k.id);
        if (rt) f.append(h("div", { class: "hint" }, T("ed.runtime", { state: rt.state, error: rt.error ? ` — ${rt.error}` : "", attempt: rt.attempt > 1 ? T("ed.attempt", { n: rt.attempt }) : "" })));
        f.append(...field(T("ed.type"), bindSelect(k, "type", CHILD_TYPES, ctx.redraw)));
        const t = k.type;
        // Daten/Parameter als strukturierte Felder (Name, Typ, Wert) direkt im Child; `suggest` = Argumente der gewählten Methode.
        const objField = (label, key, suggest) => {
          if (!k[key] || typeof k[key] !== "object" || Array.isArray(k[key])) k[key] = {};
          return field(label, kvObjectEditor(k[key], null, { suggest }));
        };
        const methodArgs = (label, m) => {
          const d = label && descCache[label];
          const spec = d && (d.methods || []).find((x) => x.name === m);
          return spec ? (spec.args || []).map((a) => ({ name: a.name, kind: a.type === "number" ? "number" : a.type === "boolean" ? "bool" : "text" })) : [];
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
          else f.append(...objField(T("ed.dataFields"), "data"));
        } else if (["NODE_COMMAND", "TRIGGER", "AUDIO", "VOICEOVER"].includes(t)) {
          const lbl = bindText(k, "target", { list: "pa-nodes", placeholder: T("ed.nodeLabelPh") });
          lbl.addEventListener("change", () => ctx.redraw()); // Beschreibung des neuen Ziels laden → Methoden/Argumente vorschlagen
          f.append(...field(T("ed.targetNode"), lbl, h("datalist", { id: "pa-nodes" }, ...availableNodes.map((n) => h("option", { value: n })))));
          const d = k.target ? loadDescriptor(k.target, ctx) : null;
          const names = d ? (d.methods || []).map((m) => m.name) : [];
          const methodIn = bindText(k, "method", { list: "pa-methods" });
          methodIn.addEventListener("change", () => ctx.redraw());
          f.append(...field(T("ed.method"), methodIn, h("datalist", { id: "pa-methods" }, ...names.map((n) => h("option", { value: n })))));
          if (names.length) f.append(h("div", { class: "hint" }, T("ed.methodHint")));
          // Native Voiceover-Absicht (ohne Methode): bekannte Felder zum Anklicken
          const voSuggest = t === "VOICEOVER" && !k.method
            ? [{ name: "channel", kind: "text" }, { name: "gainDb", kind: "number" }, { name: "fadeInMs", kind: "number" }, { name: "fadeOutMs", kind: "number" }, { name: "priority", kind: "number" }, { name: "duck", kind: "object" }]
            : methodArgs(k.target, k.method);
          f.append(...objField(T("ed.paramFields"), "params", voSuggest));
          const stopIn = bindText(k, "stopMethod", { list: "pa-methods", placeholder: T("ed.stopMethodPh") });
          stopIn.addEventListener("change", () => ctx.redraw());
          f.append(...field(T("ed.stopMethod"), stopIn));
          if (k.stopMethod) f.append(...objField(T("ed.stopParams"), "stopParams", methodArgs(k.target, k.stopMethod)));
        } else if (t === "WEBHOOK") {
          f.append(...field("URL", bindText(k, "url", { placeholder: "https://…" })));
          f.append(...objField(T("ed.bodyFields"), "params"));
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
          f.append(...field(k.timing === "RELATIVE_TO_END" ? T("ed.beforeEnd") : k.timing === "BEFORE_START" ? T("ed.beforeStart") : k.timing === "AFTER_END" ? T("ed.afterEnd") : T("ed.delay"), bindTc(k, "delayMs")));
          if (k.timing === "BEFORE_START") f.append(h("div", { class: "hint" }, T("ed.beforeStartHint")));
          if (k.timing === "AFTER_END") f.append(h("div", { class: "hint" }, T("ed.afterEndHint")));
        }
        if (k.timing !== "FULL_PRIMARY") {
          // Ende: feste Dauer | bis Primary-Ende | X vor Primary-Ende
          const em = k.endAfterEndMs != null ? "after" : k.endBeforeEndMs != null ? "before" : k.durationMs > 0 ? "dur" : "end";
          const emSel = h("select", { onchange: (e) => {
            const v = e.target.value;
            delete k.endBeforeEndMs; delete k.endAfterEndMs;
            if (v === "before") { k.endBeforeEndMs = 0; k.durationMs = 0; }
            else if (v === "after") { k.endAfterEndMs = 0; k.durationMs = 0; }
            else if (v === "end") k.durationMs = 0;
            ctx.redraw();
          } }, h("option", { value: "dur" }, T("ed.endDur")), h("option", { value: "end" }, T("ed.endPrimary")), h("option", { value: "before" }, T("ed.endBefore")), h("option", { value: "after" }, T("ed.endAfter")));
          emSel.value = em;
          f.append(...field(T("ed.endMode"), emSel));
          if (em === "dur") f.append(...field(T("ed.durationMs"), bindTc(k, "durationMs")));
          if (em === "before") f.append(...field(T("ed.endBeforeEnd"), bindTc(k, "endBeforeEndMs")));
          if (em === "after") f.append(...field(T("ed.endAfterEnd"), bindTc(k, "endAfterEndMs")));
        }
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
          delete o[`_${key}Text`];
          if (o[key] && typeof o[key] === "object" && !Array.isArray(o[key]) && Object.keys(o[key]).length === 0) delete o[key];
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
        const p = { label: d.label.trim(), note: d.note, adClass: d.adClass || "", icon: d.icon.trim(), color: d.color, startType: d.startType, endType: d.endType === "manual" ? "manual" : "", transition: d.transition };
        if (!p.label) throw new Error(T("ed.titleMissing"));
        if (d.startType === "fixtime") {
          const iso = parseStartInput(d.startLocal);
          if (!iso) throw new Error(T("ed.badStart"));
          p.startAt = iso;
        } else p.startAt = "";
        if (d.transition && d.transition !== "cut" && String(d.rateFrames).trim() !== "") p.transitionRateFrames = Number(d.rateFrames);
        p.children = kids.map(cleanKid);
        p.audioMapping = d.audioMapping || "";
        if (cart) {
          delete p.startType; delete p.endType; delete p.startAt; delete p.transition; delete p.adClass; delete p.transitionRateFrames;
          p.follow = block;
        }
        if (item?.audio && d.audioCap !== (item.audio.intent?.capability || "")) {
          const intent = { ...(item.audio.intent || {}) };
          if (d.audioCap) intent.capability = d.audioCap; else delete intent.capability;
          p.audio = intent;
        }
        if (d.kind === "file" && d.requireRelease !== (item?.requireRelease === true ? "true" : item?.requireRelease === false ? "false" : "")) {
          p.requireRelease = d.requireRelease === "" ? null : d.requireRelease === "true";
        }
        if (d.kind === "asset") { p.onMissing = d.onMissing; p.fallbackFile = d.onMissing === "FALLBACK" ? d.fallbackFile.trim() : ""; }
        return p;
      };
      const mediaPatch = () => {
        switch (d.kind) {
          case "pattern": return { kind: "pattern", pattern: d.pattern };
          case "file": case "image": return { kind: d.kind, file: d.file };
          case "live": return d.senderId ? { kind: "live", senderId: d.senderId } : { kind: "liveselect", sourceSelector: { exactId: "" } };
          case "liveselect": return { kind: "liveselect", sourceSelector: { required: splitTags(d.tags), preferred: splitTags(d.pref) } };
          case "jump": return { kind: "jump", jumpTarget: d.jumpTarget };
          case "asset": return { kind: "asset", asset: { assetId: d.assetId.trim() } };
          default: return { kind: "hold" };
        }
      };
      const appendNew = async () => {
        const body = { label: d.label.trim() || (cart ? "Cart" : "Event") };
        let method = cart ? "cart.define" : "append";
        switch (d.kind) {
          case "pattern": body.pattern = d.pattern; body.toneFrequency = 0; body.durationMs = cart ? d.durationMs : d.durationMs || 5000; break;
          case "file": if (!d.file) return T("ed.pickFile"); body.file = d.file; if (cart) body.durationMs = d.durationMs; break;
          case "image": if (!d.file) return T("ed.pickImage"); body.file = d.file; body.eventType = "image"; body.durationMs = cart ? d.durationMs : d.durationMs || 5000; break;
          case "live":
            if (d.senderId) body.senderId = d.senderId;
            else body.sourceSelectorJson = JSON.stringify({ exactId: "" });
            body.durationMs = cart ? d.durationMs : d.durationMs || 5000;
            break;
          case "liveselect":
            if (splitTags(d.tags).length === 0) return T("ed.needTag");
            body.sourceSelectorJson = JSON.stringify({ required: splitTags(d.tags), preferred: splitTags(d.pref) });
            body.durationMs = cart ? d.durationMs : d.durationMs || 5000;
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
        title: cart ? (isNew ? T("cart.newTitle") : T("cart.edit", { label: item.label })) : isNew ? T("ed.new") : T("ed.edit", { label: item.label }),
        tabs: cart
          ? [["content", T("ed.tab.content")], ["audio", T("ed.tab.audio")], ["kids", T("ed.tab.kids", { n: kids.length })], ["block", T("cart.tab.block", { n: block.length })]]
          : [["content", T("ed.tab.content")], ["timing", T("ed.tab.timing")], ["audio", T("ed.tab.audio")], ["kids", T("ed.tab.kids", { n: kids.length })]],
        saveLabel: isNew ? (cart ? T("cart.create2") : T("ed.create")) : T("save"),
        onClose: opts.onDone,
        render: (tab, ctx) => (tab === "content" ? renderContent(ctx) : tab === "timing" ? renderTiming() : tab === "audio" ? renderAudio() : tab === "block" ? renderBlock(ctx) : renderKids(ctx)),
        onSave: async () => {
          let patch;
          try { patch = buildPatch(); } catch (e) { return e.message; }
          if (cart) {
            if (isNew) {
              const err = await appendNew();
              if (err) return err;
              assets = (await getParam("assets")) || [];
              const created = assets[assets.length - 1];
              if (!created) return null;
              delete patch.audio;
              const err2 = await tryCall("cart.update", { assetId: created.id, patchJson: JSON.stringify(patch) });
              assets = (await getParam("assets")) || assets;
              renderCarts();
              return err2 ? T("ed.createdNoProps", { err: err2 }) : null;
            }
            if (mediaSig(d) !== origSig) patch.media = mediaPatch();
            if (d.durationMs !== origDur) patch.durationMs = d.durationMs;
            const err = await tryCall("cart.update", { assetId: item.id, patchJson: JSON.stringify(patch) });
            assets = (await getParam("assets")) || assets;
            renderCarts();
            return err;
          }
          if (isNew) {
            const before = items.length;
            const err = await appendNew();
            if (err) return err;
            const list = (await getParam("items")) || [];
            const created = list[list.length - 1];
            if (!created || list.length <= before) return null;
            delete patch.audio;
            const err2 = await tryCall("updateItem", { itemId: created.id, patchJson: JSON.stringify(patch) });
            if (!err2 && (d.kind === "liveselect" || (d.kind === "live" && d.senderId))) {
              // Die Audio-Wahl hängt von der aufgelösten Quelle ab: Editor direkt auf der Audio-Seite des neuen Events wieder öffnen.
              setTimeout(async () => {
                const fresh = ((await getParam("items")) || []).find((x) => x.id === created.id);
                if (fresh) openEditor(fresh, "audio");
              }, 500);
            }
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
      cartNextBtn.style.display = activeCartRemaining > 0 ? "" : "none";
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
        b.title = cartSummary(a);
        b.disabled = active;
        b.classList.toggle("firing", a.id === activeCartId);
      });
    };

    const cartSource = (a) => {
      const kind = mediaKindOf(a);
      const kindName = (MEDIA_KINDS.find(([k]) => k === kind) || [kind, kind])[1];
      const detail = kind === "file" || kind === "image" ? baseName(a.file)
        : kind === "live" ? ((availableSources.find((x) => x.senderId === a.senderId) || {}).label || a.senderId || "")
        : kind === "liveselect" ? (a.sourceSelector?.required || []).join(", ")
        : a.pattern || "";
      return detail ? `${kindName}: ${detail}` : kindName;
    };
    const cartSummary = (a) => [
      cartSource(a),
      a.durationMs > 0 ? `${a.durationMs} ms` : T("cart.manual").replace(/^ · /, ""),
      (a.children || []).length ? T("cart.children", { n: a.children.length }) : "",
      (a.follow || []).length ? T("cart.blockN", { n: a.follow.length }) : "",
    ].filter(Boolean).join(" · ");

    function openCartManager() {
      const box = h("div", {});
      const draw = () => {
        const rows = assets.map((a) => h("div", { class: "crow", style: "margin-bottom:6px" },
          h("span", { class: "cart-btn", style: `width:46px;height:34px;background:${a.color || ""};color:${a.color ? "#fff" : ""}` }, h("span", { class: "ci" }, a.icon || "▶")),
          h("div", { style: "flex:1;min-width:0" }, h("div", { style: "font-weight:600" }, a.label), h("div", { class: "hint", style: "margin:0" }, cartSummary(a))),
          h("button", { onclick: () => openEditor(a, "content", 0, { cart: true, onDone: refresh }) }, T("cart.manager.edit")),
          h("button", { class: "danger", onclick: async () => {
            if (!(await confirmDialog(T("cart.confirmRemove", { label: a.label }), T("remove")))) return;
            const err = await tryCall("cart.remove", { assetId: a.id });
            if (err) return showBanner(err);
            await refresh();
          } }, "✕")));
        box.replaceChildren(...(rows.length ? rows : [h("div", { class: "empty" }, T("cart.none"))]),
          h("div", { style: "border-top:1px solid var(--bd);margin:8px 0;padding-top:8px" }, h("button", { class: "primary", onclick: () => openEditor(null, "content", 0, { cart: true, onDone: refresh }) }, T("cart.newBtn"))));
      };
      const refresh = async () => { assets = (await getParam("assets")) || assets; draw(); renderCarts(); };
      draw();
      openModal({ title: T("cart.manageTitle"), render: () => box });
    }

    // ---- Poll ------------------------------------------------------------
    const poll = async () => {
      clockEl.textContent = new Date().toLocaleTimeString(LOCALE);
      if (dragging) return;
      const names = ["items", "currentItemId", "cuedItemId", "mode", "connected", "playheadPositionMs", "currentDurationMs", "assets", "activeCartId", "activeCartRemaining",
        "availableNodes", "targetPlayerALabel", "targetPlayerBLabel", "targetMixerLabel", "targetGraphicsLabel", "targetAudioMixerLabel", "liveChannel", "mediaLibrary", "audioPlans", "audioGroups", "audioMappings",
        "availableSources", "channelName", "instanceId", "persistence", "schedule", "childEvents", "triggerLog", "channelId", "preflightWindowMin", "defaultFiller", "idleSource", "requireRelease", "mixerAutoSetup", "foreignStatus", "adBreakEnabled", "adBreakTarget", "adBreakPreRollMs", "adBlocks", "operatorWait"];
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
      activeCartRemaining = Number(v.activeCartRemaining) || 0;
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

      // Zähler: nächstes Fix-Event (Uhrzeit), nächstes Live-Event und nächstes Event ohne Quelle (Playlist-Abstand ab Sendeposition)
      const fmtRemain = (sec) => {
        const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
        return `${hh > 0 ? `${hh}:${String(mm).padStart(2, "0")}` : mm}:${String(ss).padStart(2, "0")}`;
      };
      const nowMs = Date.now();
      const d0 = new Date();
      const nowSecs = d0.getHours() * 3600 + d0.getMinutes() * 60 + d0.getSeconds();
      const upcoming = items.filter((it) => it.startType === "fixtime" && (it.startAt || it.fixtimeHms)).map((it) => {
        if (it.startAt) return { label: it.label, hms: formatLocalStart(it.startAt), remain: Math.floor((Date.parse(it.startAt) - nowMs) / 1000) };
        const [hh, mm, ss] = it.fixtimeHms.split(":").map(Number);
        return { label: it.label, hms: it.fixtimeHms, remain: hh * 3600 + mm * 60 + ss - nowSecs };
      }).filter((f) => Number.isFinite(f.remain) && f.remain >= 0).sort((a, b) => a.remain - b.remain);
      // Angehakte Zähler bleiben sichtbar, auch wenn es kein passendes Event gibt (dann „Label: —“, abgedunkelt).
      const cntLabel = (k) => T("cnt" + k[0].toUpperCase() + k.slice(1));
      const show = (k, text) => {
        cntEls[k].textContent = text || `${cntLabel(k)}: —`;
        cntEls[k].classList.toggle("empty", !text);
        cntEls[k].style.display = cntOn[k] ? "" : "none";
      };
      show("fix", upcoming.length ? T("fixCountdown", { hms: upcoming[0].hms, label: upcoming[0].label, t: fmtRemain(upcoming[0].remain) }) : "");

      // Plan + Zeitfenster
      const timeline = items.length ? await fetch(`/api/v1/nodes/${nodeId}/timeline/window?fromIndex=0&count=${items.length}`).then((r) => (r.ok ? r.json() : [])).catch(() => []) : [];
      timeByIndex = new Map(timeline.map((e) => [e.index, e]));
      // Playlist-Abstand: Beginn des Ziel-Events minus aktuelle Sendeposition (nur bei laufendem Event bekannt)
      const curIdx = items.findIndex((i) => i.id === currentItemId);
      const tl = timeByIndex;
      const remainTo = (pred) => {
        if (curIdx < 0 || !tl.get(curIdx)) return "";
        for (let i = curIdx + 1; i < items.length; i++) {
          if (!pred(items[i]) || !tl.get(i)) continue;
          const ms = tl.get(i).startMs - (tl.get(curIdx).startMs + playheadMs);
          return ms >= 0 ? T("cntIn", { label: `${items[i].label}`, t: fmtRemain(Math.floor(ms / 1000)) }) : "";
        }
        return "";
      };
      show("live", remainTo((it) => !!it.senderId) && `● ${remainTo((it) => !!it.senderId)}`);
      show("miss", remainTo((it) => !(it.available ?? true)) && `⚠ ${remainTo((it) => !(it.available ?? true))}`);

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
      myInstance = v.instanceId || "";
      chCurrentId = v.channelId || "";
      ensureAudioEditor();
      chStatusEl.textContent = T("ch.status", { p: ptxt || "—" });
      loadChannels(false);
      persistChip.className = `chip${/fehlgeschlagen|Konflikt|nicht lesbar|nicht serialisierbar/.test(ptxt) ? " err" : v.channelName ? " blue" : ""}`;
      takeBtn.disabled = !cuedItemId;
      nextBtn.disabled = items.length === 0;
      const ow = v.operatorWait && v.operatorWait.kind ? v.operatorWait : null;
      nextBtn.classList.toggle("blink", !!ow);
      const owItem = ow && items.find((i) => i.id === ow.itemId);
      const owLabel = owItem ? owItem.label : "";
      const owText = !ow ? "" : ow.kind === "hold" ? T("waitHold") : ow.kind === "manualStart" ? T("waitMan", { label: owLabel }) : ow.kind === "endHold" ? T("waitEnd", { label: owLabel }) : T("waitCued", { label: owLabel });
      const owRem = ow && Number.isFinite(ow.remainingMs) ? ` · ${fmtRemain(Math.ceil(ow.remainingMs / 1000))}` : "";
      nextBtn.title = ow ? `${T("nextTitle")}\n${owText}${owRem}` : T("nextTitle");
      // Wartet gerade nichts: Abstand bis zum nächsten manuell startenden Event (bzw. HOLD) der Playlist.
      const manIn = owText ? "" : remainTo((it) => it.startType === "manual" || it.eventType === "HOLD");
      cntEls.man.textContent = owText ? owText + owRem : manIn ? `✋ ${manIn}` : `${T("cntMan")}: —`;
      cntEls.man.classList.toggle("empty", !owText && !manIn);
      cntEls.man.style.display = cntOn.man ? "" : "none";
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
      const mas = shadow.getElementById("mixerAutoSetup");
      if (mas && shadow.activeElement !== mas && v.mixerAutoSetup !== undefined) mas.checked = !!v.mixerAutoSetup;
      const rr = shadow.getElementById("requireRelease");
      if (rr && shadow.activeElement !== rr && v.requireRelease !== undefined) rr.checked = !!v.requireRelease;
      renderForeign(v.foreignStatus);
      if (v.idleSource !== undefined && shadow.activeElement !== idleKind && shadow.activeElement !== idleVal) {
        const [k, ...r] = String(v.idleSource || "").split(":");
        idleKind.value = ["live", "file", "image", "pattern"].includes(k) ? k : "";
        idleFill(idleKind.value ? r.join(":") : "");
      }
      const df = shadow.getElementById("defaultFiller");
      if (df && shadow.activeElement !== df && v.defaultFiller !== undefined) df.value = v.defaultFiller;

      renderList();
      renderTimeline();
      fitList();
      renderCarts();
    };

    poll();
    this._interval = setInterval(poll, 1000);
  }

  disconnectedCallback() {
    clearInterval(this._interval);
    if (this._fit) window.removeEventListener("resize", this._fit);
  }
}

if (!customElements.get("omp-playout-automation-panel")) {
  customElements.define("omp-playout-automation-panel", OmpPlayoutAutomationPanel);
}
