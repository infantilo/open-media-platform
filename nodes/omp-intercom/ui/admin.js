// ui/modules/host.ts
function host() {
  const h = globalThis.__omp;
  if (!h) throw new Error("Host-Schnittstelle der Shell fehlt (globalThis.__omp)");
  return h;
}
var t = (key, params) => host().t(key, params);
var addMessages = (lang, dict) => host().addMessages(lang, dict);
var apiFetch = (input, init) => host().apiFetch(input, init);
var showToast = (message) => host().showToast(message);
var dateLocale = () => host().dateLocale();
var confirmDialog = (message, opts) => host().confirmDialog(message, opts);
var directory = (force) => host().directory(force);

// ui/modules/intercom/messages.ts
var messages = {
  "de": {
    "icom.tab.assign": "Zuteilung",
    "icom.tab.parties": "Teilnehmer",
    "icom.tab.channels": "Kan\xE4le",
    "icom.tab.layouts": "Panel-Vorlagen",
    "icom.tab.guests": "G\xE4ste",
    "icom.m.party": "Teilnehmer",
    "icom.m.filterParty": "Teilnehmer suchen",
    "icom.m.filterPartyPh": "Name enth\xE4lt \u2026",
    "icom.m.filterChannel": "Kan\xE4le suchen",
    "icom.m.filterChannelPh": "Kanalname \u2026",
    "icom.m.allKinds": "Alle Arten",
    "icom.m.assigned": "Zuordnung",
    "icom.m.assignedAll": "Alle",
    "icom.m.assignedYes": "Mit Zuordnung",
    "icom.m.assignedNo": "Ohne Zuordnung",
    "icom.m.resetFilter": "Filter zur\xFCcksetzen",
    "icom.m.info": "{p0} von {p1} Teilnehmern \xB7 {p2} von {p3} Kan\xE4len sichtbar \xB7 {p4} Teilnehmer ohne jede Zuordnung",
    "icom.m.listCount": "{p0} von {p1}",
    "icom.m.selectAll": "Alle gefilterten Teilnehmer ausw\xE4hlen",
    "icom.m.selected": "{p0} ausgew\xE4hlt",
    "icom.m.rowTalk": "Diesen Teilnehmer in allen sichtbaren Kan\xE4len sprechen lassen",
    "icom.m.rowListen": "Diesen Teilnehmer in allen sichtbaren Kan\xE4len h\xF6ren lassen",
    "icom.m.rowClear": "Alle sichtbaren Zuordnungen dieses Teilnehmers entfernen",
    "icom.m.colTalk": "Alle {p0} gefilterten Teilnehmer in diesem Kanal sprechen lassen",
    "icom.m.colListen": "Alle {p0} gefilterten Teilnehmer in diesem Kanal h\xF6ren lassen",
    "icom.m.colClear": "Diesen Kanal bei allen {p0} gefilterten Teilnehmern entfernen",
    "icom.m.bulkConfirm": "{p0} Teilnehmer \xE4ndern?",
    "icom.m.changed": "{p0} Zuordnungen ge\xE4ndert.",
    "icom.m.copyFrom": "Zuordnung \xFCbernehmen von \u2026",
    "icom.m.copyFromHint": "Ersetzt die Zuordnungen der ausgew\xE4hlten Teilnehmer durch die des links gew\xE4hlten.",
    "icom.m.copyConfirm": "Die Zuordnungen von {p0} Teilnehmern durch die von \u201E{p1}\u201C ersetzen?",
    "icom.m.selTalkOn": "Auswahl: im Kanal sprechen lassen",
    "icom.m.selTalkOff": "Auswahl: Sprechen im Kanal entfernen",
    "icom.m.selListenOn": "Auswahl: im Kanal h\xF6ren lassen",
    "icom.m.selListenOff": "Auswahl: H\xF6ren im Kanal entfernen",
    "icom.m.delete": "Auswahl l\xF6schen",
    "icom.m.deleteConfirm": "{p0} Teilnehmer l\xF6schen?",
    "icom.m.clearSel": "Auswahl aufheben",
    "icom.m.duplicate": "Duplizieren",
    "icom.m.duplicateHint": "Neuer Teilnehmer mit denselben Zuordnungen und Rechten (ohne Nutzer)",
    "icom.m.bulkAdd": "Mehrere anlegen \u2026",
    "icom.m.bulkPrefix": "Name",
    "icom.m.bulkPrefixPh": "z. B. Kamera \u2192 Kamera 1, Kamera 2 \u2026",
    "icom.m.bulkCount": "Anzahl",
    "icom.m.bulkLike": "Zuordnung wie",
    "icom.m.bulkLikeNone": "(keine)",
    "icom.m.bulkCreate": "Anlegen",
    "icom.m.bulkNeedPrefix": "Ein Name f\xFCr die Nummerierung fehlt.",
    "icom.m.bulkCreated": "{p0} Teilnehmer angelegt.",
    "icom.assign.hint": "Wer darf in welchem Kanal sprechen (\u{1F3A4}) und mith\xF6ren (\u{1F3A7})? Ein Klick schaltet um. Ein Name f\xFChrt zu den Einstellungen des Teilnehmers. \xC4nderungen gelten nach \u201ESpeichern\u201C.",
    "icom.assign.needBoth": "Zum Zuteilen braucht es mindestens einen Kanal und einen Teilnehmer.",
    "icom.assign.toChannels": "Kan\xE4le anlegen",
    "icom.assign.toParties": "Teilnehmer anlegen",
    "icom.assign.openParty": "Einstellungen dieses Teilnehmers \xF6ffnen",
    "icom.party.section.link": "Anbindung",
    "icom.party.section.access": "Wer sitzt hier? (Zugang)",
    "icom.party.section.rights": "Besonderheiten",
    "icom.party.summary": "Zugeteilt: {p0}",
    "icom.party.summaryNone": "Noch keinem Kanal zugeteilt.",
    "icom.party.toAssign": "In der Zuteilung \xE4ndern",
    "icom.layout.advanced": "Panel-Layout (erweitert)",
    "icom.title": "Intercom",
    "icom.noNode": "Kein Intercom-Node l\xE4uft. Unter Instanzen den Typ \u201EIntercom\u201C starten.",
    "icom.save": "Speichern",
    "icom.discard": "Verwerfen",
    "icom.saved": "Gespeichert.",
    "icom.dirty": "Ungespeicherte \xC4nderungen",
    "icom.loadFailed": "Laden fehlgeschlagen ({p0})",
    "icom.saveFailed": "Speichern fehlgeschlagen: {p0}",
    "icom.status": "Betrieb",
    "icom.statusLine": "{p0} von {p1} Teilnehmern online \xB7 Takt: {p2} versp\xE4tet, l\xE4ngster Durchlauf {p3} ms",
    "icom.channels": "Kan\xE4le",
    "icom.channelsHint": "Ein Kanal ist eine gemeinsame Sprechleitung. Ein IFB-Kanal f\xFChrt Programmton, der ged\xE4mpft wird, sobald jemand hineinspricht.",
    "icom.channel.name": "Name",
    "icom.channel.color": "Farbe",
    "icom.channel.kind": "Art",
    "icom.channel.kind.party": "Partyline",
    "icom.channel.kind.ifb": "IFB (Programm + Unterbrechung)",
    "icom.channel.duck": "Programm d\xE4mpfen (dB)",
    "icom.channel.add": "+ Kanal",
    "icom.channel.remove": "Kanal l\xF6schen",
    "icom.channel.removeConfirm": "Kanal \u201E{p0}\u201C l\xF6schen? Er wird bei allen Teilnehmern entfernt.",
    "icom.noChannels": "Noch keine Kan\xE4le.",
    "icom.parties": "Teilnehmer",
    "icom.partiesHint": "Ein Teilnehmer ist eine Sprechstelle: eine Person am Panel, ein Rollenplatz (z. B. \u201EKamera 2\u201C, an dem sich jemand anmeldet) oder eine Programmquelle.",
    "icom.party.add": "+ Teilnehmer",
    "icom.party.remove": "Teilnehmer l\xF6schen",
    "icom.party.removeConfirm": "Teilnehmer \u201E{p0}\u201C l\xF6schen?",
    "icom.party.name": "Name",
    "icom.party.kind": "Art",
    "icom.party.kind.human": "Person",
    "icom.party.kind.seat": "Rollenplatz",
    "icom.party.kind.program": "Programmquelle",
    "icom.party.kind.port": "Anbindung (MXL/AES67)",
    "icom.party.priority": "Priorit\xE4t (0\u20139)",
    "icom.party.force": "Darf andere stumm schalten und Alle-Ruf ausl\xF6sen",
    "icom.party.onairLock": "Mikrofon gesperrt, solange On Air",
    "icom.party.open": "Jede Person mit Recht \u201EIntercom nutzen\u201C darf sich anmelden",
    "icom.party.users": "Personen (Benutzernamen, Komma)",
    "icom.party.groups": "Gruppen",
    "icom.party.rotate": "Neuer Zugangslink",
    "icom.party.rotateConfirm": "Neuen Zugangslink f\xFCr \u201E{p0}\u201C vergeben? Der alte Link wird ung\xFCltig.",
    "icom.party.rotated": "Neuer Zugangslink vergeben.",
    "icom.party.mxlIn": "Programmeingang Nr. (0 = keiner)",
    "icom.party.mxlOut": "Mix-Ausgang Nr. (0 = keiner)",
    "icom.party.mxlHint": "Eingang: im Flow-Editor am Receiver \u201EProgramm n\u201C des Intercom-Nodes verbinden. Ausgang: der Sender \u201EIntercom Mix n\u201C tr\xE4gt, was dieser Teilnehmer h\xF6rt (z. B. Studiolautsprecher).",
    "icom.layout": "Panel-Layout",
    "icom.layout.hint": "Bestimmt, welche Tasten das Panel zeigt und wie sie auf Seiten verteilt sind. Ohne Layout zeigt es alle zugeteilten Kan\xE4le der Reihe nach.",
    "icom.layout.mode.default": "Standard (alle Kan\xE4le der Reihe nach)",
    "icom.layout.mode.template": "Vorlage",
    "icom.layout.mode.own": "Eigenes Layout",
    "icom.layout.noTemplates": "Noch keine Vorlage angelegt",
    "icom.layout.fromAssignment": "Aus Zuteilung neu erzeugen",
    "icom.layout.fromAssignmentConfirm": "Das Layout von \u201E{p0}\u201C durch eine Standardanordnung aus den Kan\xE4len ersetzen?",
    "icom.layout.page": "Seite {p0}",
    "icom.layout.pageName": "Reitername (Seite {p0})",
    "icom.layout.pageLeft": "Seite nach vorn",
    "icom.layout.pageRight": "Seite nach hinten",
    "icom.layout.pageRemove": "Seite l\xF6schen",
    "icom.layout.addPage": "+ Seite",
    "icom.layout.addKey": "+ Taste",
    "icom.layout.emptyPage": "Noch keine Tasten.",
    "icom.layout.label": "Beschriftung (leer = Name)",
    "icom.layout.up": "Nach oben",
    "icom.layout.down": "Nach unten",
    "icom.layout.remove": "Taste entfernen",
    "icom.layout.styleStrip": "Karte (mit Reglern)",
    "icom.layout.styleKey": "Kompakte Taste",
    "icom.key.channel": "Kanal",
    "icom.key.call": "Teilnehmer rufen",
    "icom.key.all": "Alle rufen",
    "icom.key.reply": "Antworten",
    "icom.key.mute": "Mikrofon stumm",
    "icom.key.dnd": "Nicht st\xF6ren",
    "icom.templates": "Layout-Vorlagen",
    "icom.templatesHint": "Eine Vorlage ist ein Layout, das mehrere Teilnehmer teilen (z. B. \u201EKamera\u201C, \u201ERegie\u201C). \xC4nderungen wirken bei allen, die sie nutzen.",
    "icom.template.add": "+ Vorlage",
    "icom.template.name": "Name der Vorlage",
    "icom.template.remove": "Vorlage l\xF6schen",
    "icom.template.removeConfirm": "Vorlage \u201E{p0}\u201C l\xF6schen? Teilnehmer, die sie nutzen, zeigen danach die Standardansicht.",
    "icom.template.usedBy": "genutzt von {p0}",
    "icom.noTemplates": "Noch keine Vorlagen.",
    "icom.matrix": "Kan\xE4le dieses Teilnehmers",
    "icom.talk": "Sprechen",
    "icom.listen": "H\xF6ren",
    "icom.noParties": "Noch keine Teilnehmer.",
    "icom.guests": "G\xE4ste",
    "icom.guestsHint": "Ein Gast \xF6ffnet einen Link ohne Konto. Der Zugang endet von selbst.",
    "icom.guest.name": "Name des Gasts",
    "icom.guest.ttl": "G\xFCltig (Minuten)",
    "icom.guest.create": "Gast-Link erzeugen",
    "icom.guest.none": "Keine aktiven G\xE4ste.",
    "icom.guest.until": "bis {p0}",
    "icom.guest.copy": "Link kopieren",
    "icom.guest.copied": "Link kopiert.",
    "icom.guest.copyFailed": "Kopieren nicht m\xF6glich \u2014 Link von Hand markieren: {p0}",
    "icom.guest.delete": "Sperren",
    "icom.guest.createFailed": "Gast anlegen fehlgeschlagen: {p0}",
    "icom.guest.pickChannel": "Mindestens einen Kanal w\xE4hlen.",
    "icom.tile.title": "Intercom",
    "icom.tile.none": "F\xFCr Sie ist keine Sprechstelle eingerichtet. Bitte die Administration fragen.",
    "icom.tile.pick": "Sprechstelle",
    "icom.tile.newTab": "In neuem Tab \xF6ffnen",
    "icom.tile.certHint": "Zeigt das Panel nichts an, einmal \u201EIn neuem Tab \xF6ffnen\u201C und das Zertifikat best\xE4tigen.",
    "icom.tile.loadFailed": "Sprechstellen laden fehlgeschlagen ({p0})",
    "app.tab.intercom": "Intercom"
  },
  "en": {
    "icom.tab.assign": "Assignment",
    "icom.tab.parties": "Parties",
    "icom.tab.channels": "Channels",
    "icom.tab.layouts": "Panel templates",
    "icom.tab.guests": "Guests",
    "icom.m.party": "Party",
    "icom.m.filterParty": "Find parties",
    "icom.m.filterPartyPh": "Name contains \u2026",
    "icom.m.filterChannel": "Find channels",
    "icom.m.filterChannelPh": "Channel name \u2026",
    "icom.m.allKinds": "All kinds",
    "icom.m.assigned": "Assignment",
    "icom.m.assignedAll": "All",
    "icom.m.assignedYes": "With assignment",
    "icom.m.assignedNo": "Without assignment",
    "icom.m.resetFilter": "Reset filters",
    "icom.m.info": "{p0} of {p1} parties \xB7 {p2} of {p3} channels shown \xB7 {p4} parties without any assignment",
    "icom.m.listCount": "{p0} of {p1}",
    "icom.m.selectAll": "Select all filtered parties",
    "icom.m.selected": "{p0} selected",
    "icom.m.rowTalk": "Let this party talk in all visible channels",
    "icom.m.rowListen": "Let this party listen in all visible channels",
    "icom.m.rowClear": "Remove all visible assignments of this party",
    "icom.m.colTalk": "Let all {p0} filtered parties talk in this channel",
    "icom.m.colListen": "Let all {p0} filtered parties listen in this channel",
    "icom.m.colClear": "Remove this channel from all {p0} filtered parties",
    "icom.m.bulkConfirm": "Change {p0} parties?",
    "icom.m.changed": "{p0} assignments changed.",
    "icom.m.copyFrom": "Copy assignment from \u2026",
    "icom.m.copyFromHint": "Replaces the assignments of the selected parties with those of the party chosen on the left.",
    "icom.m.copyConfirm": 'Replace the assignments of {p0} parties with those of "{p1}"?',
    "icom.m.selTalkOn": "Selection: let talk in the channel",
    "icom.m.selTalkOff": "Selection: remove talking in the channel",
    "icom.m.selListenOn": "Selection: let listen in the channel",
    "icom.m.selListenOff": "Selection: remove listening in the channel",
    "icom.m.delete": "Delete selection",
    "icom.m.deleteConfirm": "Delete {p0} parties?",
    "icom.m.clearSel": "Clear selection",
    "icom.m.duplicate": "Duplicate",
    "icom.m.duplicateHint": "New party with the same assignments and rights (without users)",
    "icom.m.bulkAdd": "Create several \u2026",
    "icom.m.bulkPrefix": "Name",
    "icom.m.bulkPrefixPh": "e.g. Camera \u2192 Camera 1, Camera 2 \u2026",
    "icom.m.bulkCount": "Count",
    "icom.m.bulkLike": "Assign like",
    "icom.m.bulkLikeNone": "(none)",
    "icom.m.bulkCreate": "Create",
    "icom.m.bulkNeedPrefix": "A name for the numbering is missing.",
    "icom.m.bulkCreated": "{p0} parties created.",
    "icom.assign.hint": `Who may talk (\u{1F3A4}) and listen (\u{1F3A7}) in which channel? Click to toggle. A name opens that party's settings. Changes apply after "Save".`,
    "icom.assign.needBoth": "Assigning needs at least one channel and one party.",
    "icom.assign.toChannels": "Create channels",
    "icom.assign.toParties": "Create parties",
    "icom.assign.openParty": "Open this party's settings",
    "icom.party.section.link": "Connection",
    "icom.party.section.access": "Who sits here? (access)",
    "icom.party.section.rights": "Special rights",
    "icom.party.summary": "Assigned: {p0}",
    "icom.party.summaryNone": "Not assigned to any channel yet.",
    "icom.party.toAssign": "Change in Assignment",
    "icom.layout.advanced": "Panel layout (advanced)",
    "icom.title": "Intercom",
    "icom.noNode": 'No intercom node is running. Start the type "Intercom" under Instances.',
    "icom.save": "Save",
    "icom.discard": "Discard",
    "icom.saved": "Saved.",
    "icom.dirty": "Unsaved changes",
    "icom.loadFailed": "Loading failed ({p0})",
    "icom.saveFailed": "Saving failed: {p0}",
    "icom.status": "Operation",
    "icom.statusLine": "{p0} of {p1} parties online \xB7 clock: {p2} late, longest cycle {p3} ms",
    "icom.channels": "Channels",
    "icom.channelsHint": "A channel is a shared talk line. An IFB channel carries programme audio that is lowered as soon as someone speaks into it.",
    "icom.channel.name": "Name",
    "icom.channel.color": "Colour",
    "icom.channel.kind": "Type",
    "icom.channel.kind.party": "Party line",
    "icom.channel.kind.ifb": "IFB (programme + interrupt)",
    "icom.channel.duck": "Lower programme (dB)",
    "icom.channel.add": "+ Channel",
    "icom.channel.remove": "Delete channel",
    "icom.channel.removeConfirm": 'Delete channel "{p0}"? It is removed from all parties.',
    "icom.noChannels": "No channels yet.",
    "icom.parties": "Parties",
    "icom.partiesHint": 'A party is a station: a person at a panel, a seat (e.g. "Camera 2" that someone signs in to) or a programme source.',
    "icom.party.add": "+ Party",
    "icom.party.remove": "Delete party",
    "icom.party.removeConfirm": 'Delete party "{p0}"?',
    "icom.party.name": "Name",
    "icom.party.kind": "Type",
    "icom.party.kind.human": "Person",
    "icom.party.kind.seat": "Seat",
    "icom.party.kind.program": "Programme source",
    "icom.party.kind.port": "Link (MXL/AES67)",
    "icom.party.priority": "Priority (0\u20139)",
    "icom.party.force": "May mute others and trigger all-call",
    "icom.party.onairLock": "Microphone locked while on air",
    "icom.party.open": 'Anyone with the right "Use intercom" may sign in',
    "icom.party.users": "People (user names, comma)",
    "icom.party.groups": "Groups",
    "icom.party.rotate": "New access link",
    "icom.party.rotateConfirm": 'Issue a new access link for "{p0}"? The old link becomes invalid.',
    "icom.party.rotated": "New access link issued.",
    "icom.party.mxlIn": "Programme input no. (0 = none)",
    "icom.party.mxlOut": "Mix output no. (0 = none)",
    "icom.party.mxlHint": 'Input: connect in the flow editor at the receiver "Programme n" of the intercom node. Output: the sender "Intercom Mix n" carries what this party hears (e.g. studio loudspeaker).',
    "icom.layout": "Panel layout",
    "icom.layout.hint": "Decides which keys the panel shows and how they are spread over pages. Without a layout it shows all assigned channels in order.",
    "icom.layout.mode.default": "Default (all channels in order)",
    "icom.layout.mode.template": "Template",
    "icom.layout.mode.own": "Own layout",
    "icom.layout.noTemplates": "No template created yet",
    "icom.layout.fromAssignment": "Rebuild from assignment",
    "icom.layout.fromAssignmentConfirm": 'Replace the layout of "{p0}" with a default arrangement built from its channels?',
    "icom.layout.page": "Page {p0}",
    "icom.layout.pageName": "Tab name (page {p0})",
    "icom.layout.pageLeft": "Move page forward",
    "icom.layout.pageRight": "Move page back",
    "icom.layout.pageRemove": "Delete page",
    "icom.layout.addPage": "+ Page",
    "icom.layout.addKey": "+ Key",
    "icom.layout.emptyPage": "No keys yet.",
    "icom.layout.label": "Label (empty = name)",
    "icom.layout.up": "Move up",
    "icom.layout.down": "Move down",
    "icom.layout.remove": "Remove key",
    "icom.layout.styleStrip": "Card (with controls)",
    "icom.layout.styleKey": "Compact key",
    "icom.key.channel": "Channel",
    "icom.key.call": "Call party",
    "icom.key.all": "Call all",
    "icom.key.reply": "Reply",
    "icom.key.mute": "Microphone mute",
    "icom.key.dnd": "Do not disturb",
    "icom.templates": "Layout templates",
    "icom.templatesHint": 'A template is a layout shared by several parties (e.g. "Camera", "Control room"). Changes affect everyone who uses it.',
    "icom.template.add": "+ Template",
    "icom.template.name": "Template name",
    "icom.template.remove": "Delete template",
    "icom.template.removeConfirm": 'Delete template "{p0}"? Parties using it show the default view afterwards.',
    "icom.template.usedBy": "used by {p0}",
    "icom.noTemplates": "No templates yet.",
    "icom.matrix": "Channels of this party",
    "icom.talk": "Talk",
    "icom.listen": "Listen",
    "icom.noParties": "No parties yet.",
    "icom.guests": "Guests",
    "icom.guestsHint": "A guest opens a link without an account. The access ends by itself.",
    "icom.guest.name": "Guest name",
    "icom.guest.ttl": "Valid (minutes)",
    "icom.guest.create": "Create guest link",
    "icom.guest.none": "No active guests.",
    "icom.guest.until": "until {p0}",
    "icom.guest.copy": "Copy link",
    "icom.guest.copied": "Link copied.",
    "icom.guest.copyFailed": "Cannot copy \u2014 select the link by hand: {p0}",
    "icom.guest.delete": "Revoke",
    "icom.guest.createFailed": "Creating the guest failed: {p0}",
    "icom.guest.pickChannel": "Pick at least one channel.",
    "icom.tile.title": "Intercom",
    "icom.tile.none": "No station is set up for you. Please ask the administration.",
    "icom.tile.pick": "Station",
    "icom.tile.newTab": "Open in new tab",
    "icom.tile.certHint": "If the panel shows nothing, open it once in a new tab and accept the certificate.",
    "icom.tile.loadFailed": "Loading stations failed ({p0})",
    "app.tab.intercom": "Intercom"
  }
};

// ui/modules/intercom/register.ts
addMessages("de", messages.de);
addMessages("en", messages.en);

// ui/modules/intercom/intercom-logic.ts
var KEY_TYPES = [
  "channel",
  "call",
  "all",
  "reply",
  "mute",
  "dnd"
];
var MAX_PAGES = 8;
var MAX_KEYS = 48;
function clone(v) {
  return JSON.parse(JSON.stringify(v));
}
function nextId(items) {
  return items.reduce((m, x) => Math.max(m, x.id), 0) + 1;
}
function addChannel(cfg, name) {
  const ch = {
    id: nextId(cfg.channels),
    name,
    kind: "party"
  };
  cfg.channels.push(ch);
  return ch;
}
function removeChannel(cfg, id) {
  cfg.channels = cfg.channels.filter((c) => c.id !== id);
  for (const p of cfg.parties) p.routes = p.routes.filter((r) => r.ch !== id);
  pruneLayouts(cfg);
}
function addParty(cfg, name) {
  const p = {
    id: nextId(cfg.parties),
    name,
    kind: "human",
    routes: []
  };
  cfg.parties.push(p);
  return p;
}
function removeParty(cfg, id) {
  cfg.parties = cfg.parties.filter((p) => p.id !== id);
  pruneLayouts(cfg);
}
function getRoute(p, ch) {
  return p.routes.find((r) => r.ch === ch);
}
function setRoute(p, ch, field2, on) {
  let r = getRoute(p, ch);
  if (!r) {
    r = {
      ch,
      talk: false,
      listen: false
    };
    p.routes.push(r);
  }
  r[field2] = on;
  if (!r.talk && !r.listen) p.routes = p.routes.filter((x) => x.ch !== ch);
}
function splitList(text) {
  return text.split(",").map((s) => s.trim()).filter((s) => s !== "");
}
function newLayout() {
  return {
    pages: [
      {
        name: "",
        keys: []
      }
    ]
  };
}
function addPage(l) {
  if (l.pages.length >= MAX_PAGES) return null;
  const pg = {
    name: "",
    keys: []
  };
  l.pages.push(pg);
  return pg;
}
function removePage(l, i) {
  if (l.pages.length > 1) l.pages.splice(i, 1);
}
function movePage(l, i, delta) {
  const j = i + delta;
  if (j < 0 || j >= l.pages.length) return;
  [l.pages[i], l.pages[j]] = [
    l.pages[j],
    l.pages[i]
  ];
}
function addKey(l, page, type, target) {
  const pg = l.pages[page];
  if (!pg || pg.keys.length >= MAX_KEYS) return null;
  const k = {
    type
  };
  if (type === "channel") {
    k.ch = target;
    k.style = "strip";
  }
  if (type === "call") k.party = target;
  pg.keys.push(k);
  return k;
}
function moveKey(l, page, i, delta) {
  const keys = l.pages[page]?.keys;
  const j = i + delta;
  if (!keys || j < 0 || j >= keys.length) return;
  [keys[i], keys[j]] = [
    keys[j],
    keys[i]
  ];
}
function removeKey(l, page, i) {
  l.pages[page]?.keys.splice(i, 1);
}
function layoutFromAssignment(p, cfg) {
  const keys = [];
  for (const r of [
    ...p.routes
  ].sort((a, b) => a.ch - b.ch)) {
    if (cfg.channels.some((c) => c.id === r.ch)) keys.push({
      type: "channel",
      ch: r.ch,
      style: "strip"
    });
  }
  for (const o of cfg.parties) {
    if (o.id !== p.id && o.kind !== "program" && o.kind !== "port") keys.push({
      type: "call",
      party: o.id
    });
  }
  return {
    pages: [
      {
        name: "",
        keys: keys.slice(0, MAX_KEYS)
      }
    ]
  };
}
function keyCaption(k, cfg, typeLabel2) {
  if (k.label) return k.label;
  if (k.type === "channel") return cfg.channels.find((c) => c.id === k.ch)?.name || `#${k.ch ?? "?"}`;
  if (k.type === "call") return cfg.parties.find((p) => p.id === k.party)?.name || `#${k.party ?? "?"}`;
  return typeLabel2(k.type);
}
function layoutMode(p) {
  if (p.layout) return "own";
  return p.template ? "template" : "default";
}
function addTemplate(cfg, name) {
  cfg.templates ??= [];
  const t2 = {
    id: nextId(cfg.templates),
    name,
    layout: newLayout()
  };
  cfg.templates.push(t2);
  return t2;
}
function removeTemplate(cfg, id) {
  cfg.templates = (cfg.templates ?? []).filter((t2) => t2.id !== id);
  for (const p of cfg.parties) if (p.template === id) delete p.template;
}
function pruneLayouts(cfg) {
  const ch = new Set(cfg.channels.map((c) => c.id));
  const pa = new Set(cfg.parties.map((p) => p.id));
  const prune = (l) => {
    for (const pg of l?.pages ?? []) {
      pg.keys = pg.keys.filter((k) => k.type === "channel" ? ch.has(k.ch ?? -1) : k.type === "call" ? pa.has(k.party ?? -1) : true);
    }
  };
  for (const p of cfg.parties) {
    prune(p.layout);
    if (p.template && !(cfg.templates ?? []).some((t2) => t2.id === p.template)) delete p.template;
  }
  for (const t2 of cfg.templates ?? []) prune(t2.layout);
}
function cleanLayout(l) {
  if (!l) return void 0;
  const out = {
    pages: l.pages.map((pg, i) => ({
      name: pg.name.trim() || (l.pages.length > 1 ? String(i + 1) : ""),
      keys: pg.keys.map((k) => {
        const c = {
          type: k.type
        };
        if (k.type === "channel") {
          c.ch = k.ch;
          c.style = k.style === "key" ? "key" : "strip";
        }
        if (k.type === "call") c.party = k.party;
        if (k.label?.trim()) c.label = k.label.trim();
        return c;
      })
    }))
  };
  return out.pages.some((pg) => pg.keys.length > 0) ? out : void 0;
}
function cleanConfig(cfg) {
  const out = clone(cfg);
  out.channels = out.channels.map((c) => ({
    ...c,
    name: c.name.trim()
  }));
  out.parties = out.parties.map((p) => {
    const q = {
      ...p,
      name: p.name.trim(),
      routes: p.routes.filter((r) => r.talk || r.listen).sort((a, b) => a.ch - b.ch)
    };
    if (!q.users?.length) delete q.users;
    if (!q.groups?.length) delete q.groups;
    const lay = cleanLayout(q.layout);
    if (lay) q.layout = lay;
    else delete q.layout;
    if (!q.template) delete q.template;
    if (!q.mxl_in) delete q.mxl_in;
    if (!q.mxl_out) delete q.mxl_out;
    if (q.kind !== "program" && q.kind !== "port") {
      delete q.mxl_in;
      delete q.mxl_out;
    }
    return q;
  });
  const tpl = (out.templates ?? []).map((t2) => ({
    ...t2,
    name: t2.name.trim(),
    layout: cleanLayout(t2.layout) ?? newLayout()
  }));
  if (tpl.length) out.templates = tpl;
  else delete out.templates;
  delete out.guests;
  return out;
}
function localProblems(cfg) {
  const p = [];
  const seen = /* @__PURE__ */ new Set();
  for (const c of cfg.channels) {
    if (c.name.trim() === "") p.push(`#${c.id}`);
    const k = c.name.trim().toLowerCase();
    if (k && seen.has(k)) p.push(c.name);
    seen.add(k);
  }
  const tseen = /* @__PURE__ */ new Set();
  for (const t2 of cfg.templates ?? []) {
    if (t2.name.trim() === "") p.push(`#${t2.id}`);
    const k = t2.name.trim().toLowerCase();
    if (k && tseen.has(k)) p.push(t2.name);
    tseen.add(k);
  }
  const pseen = /* @__PURE__ */ new Set();
  for (const x of cfg.parties) {
    if (x.name.trim() === "") p.push(`#${x.id}`);
    const k = x.name.trim().toLowerCase();
    if (k && pseen.has(k)) p.push(x.name);
    pseen.add(k);
  }
  return p;
}
function guestRoutes(selected, talk) {
  return [
    ...selected
  ].sort((a, b) => a - b).map((ch) => ({
    ch,
    talk,
    listen: true
  }));
}
function sameConfig(a, b) {
  return JSON.stringify(cleanConfig(a)) === JSON.stringify(cleanConfig(b));
}

// ui/modules/intercom/intercom-layout-editor.ts
function el(tag, css = "", text = "") {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}
var DIM = "color:var(--omp-text-dim);";
var typeLabel = (t2) => t(`icom.key.${t2}`);
function small(text, onClick, title = "", disabled = false) {
  const b = el("button", "padding:1px 7px;", text);
  b.title = title;
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}
function layoutEditor(layout, cfg, changed, rebuild) {
  const root = el("div", "border:1px dashed var(--omp-border);border-radius:6px;padding:8px;margin-top:6px;");
  root.dataset.role = "layout-editor";
  layout.pages.forEach((pg, pi) => {
    const page = el("div", "border:1px solid var(--omp-border);border-radius:6px;padding:8px;margin-bottom:8px;");
    page.dataset.page = String(pi);
    const head = el("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px;");
    const name = el("input", "padding:3px 6px;width:150px;");
    name.placeholder = t("icom.layout.pageName", {
      p0: pi + 1
    });
    name.value = pg.name;
    name.addEventListener("input", () => {
      pg.name = name.value;
      changed();
    });
    head.append(el("strong", "", t("icom.layout.page", {
      p0: pi + 1
    })), name, small("\u25C0", () => {
      movePage(layout, pi, -1);
      rebuild();
    }, t("icom.layout.pageLeft"), pi === 0), small("\u25B6", () => {
      movePage(layout, pi, 1);
      rebuild();
    }, t("icom.layout.pageRight"), pi === layout.pages.length - 1), small("\u2715", () => {
      removePage(layout, pi);
      rebuild();
    }, t("icom.layout.pageRemove"), layout.pages.length < 2));
    page.append(head);
    const preview = el("div", "display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;");
    preview.dataset.role = "preview";
    for (const k of pg.keys) {
      const strip = k.type === "channel" && k.style !== "key";
      const chip = el("span", `border:1px solid var(--omp-border);border-radius:4px;padding:1px 6px;font-size:11px;${strip ? "width:100%;background:var(--omp-surface);" : ""}`, keyCaption(k, cfg, typeLabel));
      preview.append(chip);
    }
    if (pg.keys.length === 0) preview.append(el("span", "font-size:12px;" + DIM, t("icom.layout.emptyPage")));
    page.append(preview);
    pg.keys.forEach((k, ki) => page.append(keyRow(layout, pi, ki, k, cfg, changed, rebuild)));
    const add = el("div", "display:flex;gap:8px;align-items:center;margin-top:6px;");
    const type = el("select", "padding:3px 6px;");
    for (const ty of KEY_TYPES) {
      const o = el("option", "", typeLabel(ty));
      o.value = ty;
      type.append(o);
    }
    const addBtn = el("button", "padding:3px 10px;", t("icom.layout.addKey"));
    addBtn.disabled = pg.keys.length >= MAX_KEYS;
    addBtn.addEventListener("click", () => {
      const ty = type.value;
      const target = ty === "channel" ? cfg.channels[0]?.id : ty === "call" ? cfg.parties[0]?.id : void 0;
      addKey(layout, pi, ty, target);
      rebuild();
    });
    add.append(type, addBtn);
    page.append(add);
    root.append(page);
  });
  const addPageBtn = el("button", "padding:3px 10px;", t("icom.layout.addPage"));
  addPageBtn.disabled = layout.pages.length >= MAX_PAGES;
  addPageBtn.addEventListener("click", () => {
    addPage(layout);
    rebuild();
  });
  root.append(addPageBtn);
  return root;
}
function keyRow(layout, pi, ki, k, cfg, changed, rebuild) {
  const row = el("div", "display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:4px;");
  row.dataset.key = String(ki);
  const type = el("select", "padding:3px 6px;");
  for (const ty of KEY_TYPES) {
    const o = el("option", "", typeLabel(ty));
    o.value = ty;
    type.append(o);
  }
  type.value = k.type;
  type.addEventListener("change", () => {
    const ty = type.value;
    k.type = ty;
    delete k.ch;
    delete k.party;
    delete k.style;
    if (ty === "channel") {
      k.ch = cfg.channels[0]?.id;
      k.style = "strip";
    }
    if (ty === "call") k.party = cfg.parties[0]?.id;
    rebuild();
  });
  row.append(type);
  if (k.type === "channel" || k.type === "call") {
    const target = el("select", "padding:3px 6px;min-width:120px;");
    const list = k.type === "channel" ? cfg.channels.map((c) => ({
      id: c.id,
      name: c.name
    })) : cfg.parties.map((p) => ({
      id: p.id,
      name: p.name
    }));
    for (const x of list) {
      const o = el("option", "", x.name || `#${x.id}`);
      o.value = String(x.id);
      target.append(o);
    }
    target.value = String(k.type === "channel" ? k.ch : k.party);
    target.addEventListener("change", () => {
      if (k.type === "channel") k.ch = Number(target.value);
      else k.party = Number(target.value);
      rebuild();
    });
    row.append(target);
  }
  if (k.type === "channel") {
    const style = el("select", "padding:3px 6px;");
    for (const [v, key] of [
      [
        "strip",
        "icom.layout.styleStrip"
      ],
      [
        "key",
        "icom.layout.styleKey"
      ]
    ]) {
      const o = el("option", "", t(key));
      o.value = v;
      style.append(o);
    }
    style.value = k.style === "key" ? "key" : "strip";
    style.addEventListener("change", () => {
      k.style = style.value;
      rebuild();
    });
    row.append(style);
  }
  const label = el("input", "padding:3px 6px;width:170px;");
  label.placeholder = t("icom.layout.label");
  label.maxLength = 40;
  label.value = k.label ?? "";
  label.addEventListener("input", () => {
    k.label = label.value;
    changed();
  });
  row.append(label, small("\u25B2", () => {
    moveKey(layout, pi, ki, -1);
    rebuild();
  }, t("icom.layout.up"), ki === 0), small("\u25BC", () => {
    moveKey(layout, pi, ki, 1);
    rebuild();
  }, t("icom.layout.down"), ki === layout.pages[pi].keys.length - 1), small("\u2715", () => {
    removeKey(layout, pi, ki);
    rebuild();
  }, t("icom.layout.remove")));
  return row;
}

// ui/modules/intercom/intercom-scale.ts
function filterParties(parties, f) {
  const q = f.text.trim().toLowerCase();
  return parties.filter((p) => {
    if (q && !(p.name || `#${p.id}`).toLowerCase().includes(q)) return false;
    if (f.kind !== "all" && (p.kind ?? "human") !== f.kind) return false;
    if (f.assigned !== void 0 && p.routes.some((r) => r.talk || r.listen) !== f.assigned) return false;
    return true;
  });
}
function filterChannels(channels, text) {
  const q = text.trim().toLowerCase();
  return q ? channels.filter((c) => (c.name || `#${c.id}`).toLowerCase().includes(q)) : channels;
}
function visibleWindow(scrollTop, viewHeight, rowHeight, total, buffer = 4) {
  if (total <= 0 || rowHeight <= 0) return {
    start: 0,
    end: 0
  };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const count = Math.ceil(Math.max(0, viewHeight) / rowHeight);
  return {
    start: Math.max(0, first - buffer),
    end: Math.min(total, first + count + buffer)
  };
}
function setForParties(parties, ch, field2, on) {
  let n = 0;
  for (const p of parties) {
    if (!!getRoute(p, ch)?.[field2] === on) continue;
    setRoute(p, ch, field2, on);
    n++;
  }
  return n;
}
function setAllChannels(p, channels, field2, on) {
  for (const ch of channels) if (!!getRoute(p, ch)?.[field2] !== on) setRoute(p, ch, field2, on);
}
function copyRoutes(src, targets) {
  let n = 0;
  for (const t2 of targets) {
    if (t2.id === src.id) continue;
    t2.routes = src.routes.filter((r) => r.talk || r.listen).map((r) => ({
      ...r
    }));
    n++;
  }
  return n;
}
function nextNumber(cfg, prefix) {
  const lower = new Set(cfg.parties.map((p) => p.name.trim().toLowerCase()));
  let n = 1;
  while (lower.has(`${prefix} ${n}`.trim().toLowerCase())) n++;
  return n;
}
var MAX_BULK_ADD = 500;
function addParties(cfg, prefix, count, kind, like) {
  const n = Math.max(0, Math.min(MAX_BULK_ADD, Math.floor(count)));
  const pre = prefix.trim();
  const out = [];
  let num = nextNumber(cfg, pre);
  for (let i = 0; i < n; i++, num++) {
    while (cfg.parties.some((p2) => p2.name.trim().toLowerCase() === `${pre} ${num}`.trim().toLowerCase())) num++;
    const p = addParty(cfg, `${pre} ${num}`.trim());
    p.kind = kind;
    if (like) p.routes = like.routes.filter((r) => r.talk || r.listen).map((r) => ({
      ...r
    }));
    out.push(p);
  }
  return out;
}
function duplicateParty(cfg, id) {
  const src = cfg.parties.find((p2) => p2.id === id);
  if (!src) return null;
  const base = src.name.trim().replace(/\s+\d+$/, "");
  const [p] = addParties(cfg, base, 1, src.kind ?? "human", src);
  if (!p) return null;
  for (const k of [
    "priority",
    "force",
    "onair_lock",
    "open",
    "template",
    "mxl_in",
    "mxl_out"
  ]) {
    if (src[k] !== void 0) p[k] = src[k];
  }
  if (src.layout) p.layout = JSON.parse(JSON.stringify(src.layout));
  return p;
}
function removeParties(cfg, ids) {
  const before = cfg.parties.length;
  cfg.parties = cfg.parties.filter((p) => !ids.has(p.id));
  pruneLayouts(cfg);
  return before - cfg.parties.length;
}
function matrixStats(cfg) {
  let routes = 0;
  let unassigned = 0;
  for (const p of cfg.parties) {
    const n = p.routes.filter((r) => r.talk || r.listen).length;
    routes += n;
    if (n === 0) unassigned++;
  }
  return {
    parties: cfg.parties.length,
    channels: cfg.channels.length,
    unassigned,
    routes
  };
}

// ui/modules/intercom/intercom-matrix.ts
var ROW_H = 34;
var COL_W = 96;
var NAME_W = 210;
var TOOLS_W = 92;
var CHECK_W = 32;
var CONFIRM_ABOVE = 20;
function el2(tag, css = "", text = "") {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}
var DIM2 = "color:var(--omp-text-dim);";
function newMatrixState() {
  return {
    text: "",
    kind: "all",
    assigned: "all",
    channelText: "",
    selected: /* @__PURE__ */ new Set(),
    scrollTop: 0,
    scrollLeft: 0
  };
}
function matrixView(host2) {
  const st = host2.state;
  const root = el2("div");
  root.dataset.role = "matrix";
  let parties = [];
  let channels = [];
  const colTemplate = () => `${CHECK_W}px ${NAME_W}px ${TOOLS_W}px repeat(${channels.length},${COL_W}px)`;
  const totalWidth = () => CHECK_W + NAME_W + TOOLS_W + channels.length * COL_W;
  const toolbar = el2("div", "display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:8px;");
  const bulk = el2("div", "display:none;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;padding:6px 8px;border:1px solid var(--omp-accent-cyan,#19d3f3);border-radius:6px;");
  bulk.dataset.role = "bulk";
  const info = el2("div", `font-size:12px;margin-bottom:6px;${DIM2}`);
  info.dataset.role = "matrix-info";
  const scroller = el2("div", "background:var(--omp-surface,#111);overflow:auto;max-height:min(68vh,720px);border:1px solid var(--omp-border);border-radius:6px;position:relative;");
  scroller.dataset.role = "matrix-scroll";
  const sizer = el2("div", "position:relative;");
  const headRow = el2("div", "position:sticky;top:0;z-index:4;background:var(--omp-surface,#111);border-bottom:1px solid var(--omp-border);display:grid;align-items:stretch;");
  const body = el2("div", "position:relative;");
  sizer.append(headRow, body);
  scroller.append(sizer);
  const input = (value, placeholder, width, on) => {
    const i = el2("input", `padding:3px 6px;width:${width};`);
    i.value = value;
    i.placeholder = placeholder;
    i.addEventListener("input", () => on(i.value));
    return i;
  };
  const labelled = (label, c) => {
    const w = el2("label", "display:flex;flex-direction:column;gap:2px;");
    w.append(el2("span", "font-size:10px;letter-spacing:.06em;text-transform:uppercase;" + DIM2, label), c);
    return w;
  };
  const select = (opts, value, on) => {
    const s = el2("select", "padding:3px 6px;");
    for (const [v, text] of opts) {
      const o = el2("option", "", text);
      o.value = v;
      s.append(o);
    }
    s.value = value;
    s.addEventListener("change", () => on(s.value));
    return s;
  };
  const btn2 = (text, on, title = "") => {
    const b = el2("button", "padding:3px 10px;", text);
    if (title) b.title = title;
    b.addEventListener("click", on);
    return b;
  };
  function recompute() {
    const d = host2.draft();
    parties = filterParties(d.parties, {
      text: st.text,
      kind: st.kind,
      assigned: st.assigned === "all" ? void 0 : st.assigned === "yes"
    });
    channels = filterChannels(d.channels, st.channelText);
  }
  function paintCell(b, p, ch, f) {
    const on = !!getRoute(p, ch)?.[f];
    b.style.opacity = on ? "1" : "0.25";
    b.style.background = on ? "color-mix(in srgb,var(--omp-accent-cyan,#19d3f3) 28%,transparent)" : "";
    b.setAttribute("aria-pressed", String(on));
  }
  function rowEl(p, index) {
    const row = el2("div", `position:absolute;left:0;top:${index * ROW_H}px;height:${ROW_H}px;width:${totalWidth()}px;display:grid;grid-template-columns:${colTemplate()};align-items:center;border-bottom:1px solid color-mix(in srgb,var(--omp-border) 50%,transparent);`);
    row.dataset.row = String(p.id);
    const sticky = "position:sticky;left:0;z-index:2;background:var(--omp-surface,#111);height:100%;display:flex;align-items:center;";
    const check2 = el2("span", sticky + "justify-content:center;");
    const cb = el2("input");
    cb.type = "checkbox";
    cb.checked = st.selected.has(p.id);
    cb.dataset.act = "select";
    cb.setAttribute("aria-label", p.name || `#${p.id}`);
    check2.append(cb);
    const name = el2("span", `position:sticky;left:${CHECK_W}px;z-index:2;background:var(--omp-surface,#111);height:100%;display:flex;align-items:center;gap:6px;overflow:hidden;`);
    const dot = el2("span", "width:9px;height:9px;border-radius:50%;background:var(--omp-border);flex:none;");
    dot.dataset.partyDot = String(p.id);
    const nb = el2("button", "border:0;background:none;padding:0;cursor:pointer;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", p.name || `#${p.id}`);
    nb.dataset.act = "open";
    nb.title = t("icom.assign.openParty");
    name.append(dot, nb);
    const tools = el2("span", `position:sticky;left:${CHECK_W + NAME_W}px;z-index:2;background:var(--omp-surface,#111);height:100%;display:flex;align-items:center;gap:2px;border-right:1px solid var(--omp-border);`);
    for (const [act, text, title] of [
      [
        "row-talk",
        "\u{1F3A4}+",
        "icom.m.rowTalk"
      ],
      [
        "row-listen",
        "\u{1F3A7}+",
        "icom.m.rowListen"
      ],
      [
        "row-clear",
        "\u2205",
        "icom.m.rowClear"
      ]
    ]) {
      const b = el2("button", "padding:0 4px;font-size:11px;", text);
      b.dataset.act = act;
      b.title = t(title);
      tools.append(b);
    }
    row.append(check2, name, tools);
    for (const c of channels) {
      const cell = el2("span", "display:flex;gap:3px;justify-content:center;");
      for (const f of [
        "talk",
        "listen"
      ]) {
        const b = el2("button", "padding:2px 6px;min-width:34px;", f === "talk" ? "\u{1F3A4}" : "\u{1F3A7}");
        b.dataset.act = "cell";
        b.dataset.ch = String(c.id);
        b.dataset.f = f;
        b.title = `${p.name || `#${p.id}`} \xB7 ${c.name || `#${c.id}`} \xB7 ${t(f === "talk" ? "icom.talk" : "icom.listen")}`;
        paintCell(b, p, c.id, f);
        cell.append(b);
      }
      row.append(cell);
    }
    return row;
  }
  function renderHead() {
    headRow.style.gridTemplateColumns = colTemplate();
    headRow.style.width = `${totalWidth()}px`;
    headRow.replaceChildren();
    const all = el2("span", "position:sticky;left:0;z-index:5;background:var(--omp-surface,#111);display:flex;align-items:center;justify-content:center;");
    const cb = el2("input");
    cb.type = "checkbox";
    cb.title = t("icom.m.selectAll");
    cb.dataset.act = "select-all";
    cb.checked = parties.length > 0 && parties.every((p) => st.selected.has(p.id));
    all.append(cb);
    const nameH = el2("span", `position:sticky;left:${CHECK_W}px;z-index:5;background:var(--omp-surface,#111);padding:6px;font-size:11px;${DIM2}`, t("icom.m.party"));
    const toolsH = el2("span", `position:sticky;left:${CHECK_W + NAME_W}px;z-index:5;background:var(--omp-surface,#111);border-right:1px solid var(--omp-border);`);
    headRow.append(all, nameH, toolsH);
    for (const c of channels) {
      const h = el2("span", `display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px 2px;border-bottom:3px solid ${c.color || "#4c8dff"};min-width:0;`);
      h.append(el2("span", "font-size:12px;font-weight:600;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", c.name || `#${c.id}`));
      const tools = el2("span", "display:flex;gap:2px;");
      for (const [act, text, title] of [
        [
          "col-talk",
          "\u{1F3A4}+",
          "icom.m.colTalk"
        ],
        [
          "col-listen",
          "\u{1F3A7}+",
          "icom.m.colListen"
        ],
        [
          "col-clear",
          "\u2205",
          "icom.m.colClear"
        ]
      ]) {
        const b = el2("button", "padding:0 4px;font-size:11px;", text);
        b.dataset.act = act;
        b.dataset.ch = String(c.id);
        b.title = t(title, {
          p0: parties.length
        });
        tools.append(b);
      }
      h.append(tools);
      headRow.append(h);
    }
  }
  function renderRows() {
    st.scrollTop = scroller.scrollTop;
    st.scrollLeft = scroller.scrollLeft;
    body.style.height = `${parties.length * ROW_H}px`;
    body.style.width = `${totalWidth()}px`;
    const headH = headRow.offsetHeight || 50;
    const w = visibleWindow(Math.max(0, scroller.scrollTop), scroller.clientHeight || 600, ROW_H, parties.length, 6);
    void headH;
    const frag = document.createDocumentFragment();
    for (let i = w.start; i < w.end; i++) frag.append(rowEl(parties[i], i));
    body.replaceChildren(frag);
    host2.paintDots();
  }
  function renderInfo() {
    const s = matrixStats(host2.draft());
    info.textContent = t("icom.m.info", {
      p0: parties.length,
      p1: s.parties,
      p2: channels.length,
      p3: s.channels,
      p4: s.unassigned
    });
  }
  function renderBulk() {
    const n = st.selected.size;
    bulk.style.display = n ? "flex" : "none";
    bulk.replaceChildren();
    if (!n) return;
    const d = host2.draft();
    bulk.append(el2("strong", "", t("icom.m.selected", {
      p0: n
    })));
    const sel = () => d.parties.filter((p) => st.selected.has(p.id));
    const src = el2("select", "padding:3px 6px;max-width:200px;");
    for (const p of d.parties) {
      const o = el2("option", "", p.name || `#${p.id}`);
      o.value = String(p.id);
      src.append(o);
    }
    bulk.append(src, btn2(t("icom.m.copyFrom"), async () => {
      const from = d.parties.find((p) => p.id === Number(src.value));
      const targets = sel().filter((p) => p.id !== from?.id);
      if (!from || !targets.length) return;
      if (!await confirmDialog(t("icom.m.copyConfirm", {
        p0: targets.length,
        p1: from.name || `#${from.id}`
      }))) return;
      copyRoutes(from, targets);
      host2.changed();
      refresh(false);
    }, t("icom.m.copyFromHint")));
    const chSel = el2("select", "padding:3px 6px;max-width:160px;");
    for (const c of d.channels) {
      const o = el2("option", "", c.name || `#${c.id}`);
      o.value = String(c.id);
      chSel.append(o);
    }
    const apply = (f, on) => async () => {
      const ch = Number(chSel.value);
      if (!ch) return;
      const targets = sel();
      if (targets.length > CONFIRM_ABOVE && !await confirmDialog(t("icom.m.bulkConfirm", {
        p0: targets.length
      }))) return;
      setForParties(targets, ch, f, on);
      host2.changed();
      refresh(false);
    };
    bulk.append(chSel, btn2("\u{1F3A4}+", apply("talk", true), t("icom.m.selTalkOn")), btn2("\u{1F3A4}\u2212", apply("talk", false), t("icom.m.selTalkOff")), btn2("\u{1F3A7}+", apply("listen", true), t("icom.m.selListenOn")), btn2("\u{1F3A7}\u2212", apply("listen", false), t("icom.m.selListenOff")));
    bulk.append(btn2(t("icom.m.delete"), async () => {
      const ids = new Set(st.selected);
      if (!await confirmDialog(t("icom.m.deleteConfirm", {
        p0: ids.size
      }))) return;
      removeParties(d, ids);
      st.selected.clear();
      host2.changed();
      host2.rebuild();
    }), btn2(t("icom.m.clearSel"), () => {
      st.selected.clear();
      refresh(false);
    }));
  }
  function refresh(full) {
    if (full) {
      recompute();
      renderHead();
    }
    renderRows();
    renderInfo();
    renderBulk();
  }
  async function confirmMany(n) {
    return n <= CONFIRM_ABOVE || await confirmDialog(t("icom.m.bulkConfirm", {
      p0: n
    }));
  }
  scroller.addEventListener("scroll", () => {
    if (scroller.scrollTop !== st.scrollTop) requestAnimationFrame(renderRows);
    st.scrollTop = scroller.scrollTop;
    st.scrollLeft = scroller.scrollLeft;
  });
  sizer.addEventListener("click", (ev) => {
    const t2 = ev.target.closest("[data-act]");
    if (!t2) return;
    const d = host2.draft();
    const rowId = Number(t2.closest("[data-row]")?.dataset.row);
    const p = d.parties.find((x) => x.id === rowId);
    const ch = Number(t2.dataset.ch);
    switch (t2.dataset.act) {
      case "cell": {
        if (!p) return;
        const f = t2.dataset.f;
        setRoute(p, ch, f, !getRoute(p, ch)?.[f]);
        paintCell(t2, p, ch, f);
        host2.changed();
        renderInfo();
        break;
      }
      case "open":
        if (p) host2.openParty(p.id);
        break;
      case "select": {
        if (!p) return;
        if (t2.checked) st.selected.add(p.id);
        else st.selected.delete(p.id);
        renderBulk();
        renderHead();
        break;
      }
      case "select-all": {
        if (t2.checked) for (const x of parties) st.selected.add(x.id);
        else for (const x of parties) st.selected.delete(x.id);
        refresh(true);
        break;
      }
      case "row-talk":
      case "row-listen":
      case "row-clear": {
        if (!p) return;
        const ids = channels.map((c) => c.id);
        if (t2.dataset.act === "row-clear") {
          setAllChannels(p, ids, "talk", false);
          setAllChannels(p, ids, "listen", false);
        } else setAllChannels(p, ids, t2.dataset.act === "row-talk" ? "talk" : "listen", true);
        host2.changed();
        refresh(false);
        break;
      }
      case "col-talk":
      case "col-listen":
      case "col-clear": {
        const on = t2.dataset.act !== "col-clear";
        void (async () => {
          if (!await confirmMany(parties.length)) return;
          let n = 0;
          if (!on) {
            n += setForParties(parties, ch, "talk", false) + setForParties(parties, ch, "listen", false);
          } else n += setForParties(parties, ch, t2.dataset.act === "col-talk" ? "talk" : "listen", true);
          if (n) host2.changed();
          showToast(t("icom.m.changed", {
            p0: n
          }));
          refresh(false);
        })();
        break;
      }
    }
  });
  const reflow = () => {
    scroller.scrollTop = 0;
    refresh(true);
  };
  toolbar.append(labelled(t("icom.m.filterParty"), input(st.text, t("icom.m.filterPartyPh"), "200px", (v) => {
    st.text = v;
    reflow();
  })), labelled(t("icom.party.kind"), select([
    [
      "all",
      t("icom.m.allKinds")
    ],
    ...[
      "human",
      "seat",
      "program",
      "port"
    ].map((k) => [
      k,
      t(`icom.party.kind.${k}`)
    ])
  ], st.kind, (v) => {
    st.kind = v;
    reflow();
  })), labelled(t("icom.m.assigned"), select([
    [
      "all",
      t("icom.m.assignedAll")
    ],
    [
      "yes",
      t("icom.m.assignedYes")
    ],
    [
      "no",
      t("icom.m.assignedNo")
    ]
  ], st.assigned, (v) => {
    st.assigned = v;
    reflow();
  })), labelled(t("icom.m.filterChannel"), input(st.channelText, t("icom.m.filterChannelPh"), "160px", (v) => {
    st.channelText = v;
    refresh(true);
  })));
  const reset = btn2(t("icom.m.resetFilter"), () => {
    st.text = "";
    st.kind = "all";
    st.assigned = "all";
    st.channelText = "";
    host2.rebuild();
  });
  toolbar.append(reset);
  root.append(toolbar, bulk, info, scroller);
  recompute();
  renderHead();
  queueMicrotask(() => {
    scroller.scrollTop = st.scrollTop;
    scroller.scrollLeft = st.scrollLeft;
    refresh(false);
  });
  refresh(false);
  return root;
}

// ui/modules/intercom/intercom-admin.ts
function el3(tag, css = "", text = "") {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}
var DIM3 = "color:var(--omp-text-dim);";
var BOX = "border:1px solid var(--omp-border);border-radius:8px;padding:12px 14px;margin-bottom:16px;";
var H = "font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--omp-text-dim);margin:0 0 8px;";
function field(label, input, width = "") {
  const w = el3("label", `display:flex;flex-direction:column;gap:2px;${width ? `width:${width};` : ""}`);
  w.append(el3("span", "font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--omp-text-dim);", label), input);
  return w;
}
function textInput(value, onInput, width = "", placeholder = "") {
  const i = el3("input", `padding:3px 6px;${width ? `width:${width};` : ""}`);
  i.value = value;
  if (placeholder) i.placeholder = placeholder;
  i.addEventListener("input", () => onInput(i.value));
  return i;
}
function check(label, on, onChange) {
  const l = el3("label", "display:flex;gap:6px;align-items:center;font-size:13px;");
  const c = el3("input");
  c.type = "checkbox";
  c.checked = on;
  c.addEventListener("change", () => onChange(c.checked));
  l.append(c, el3("span", "", label));
  return l;
}
function btn(text, onClick, title = "") {
  const b = el3("button", "padding:3px 10px;", text);
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}
var TABS = [
  "assign",
  "parties",
  "channels",
  "layouts",
  "guests"
];
function loadTab() {
  try {
    const v = localStorage.getItem("omp-intercom-admin-tab");
    if (v && TABS.includes(v)) return v;
  } catch {
  }
  return "assign";
}
var IntercomAdmin = class extends HTMLElement {
  #saved = {
    channels: [],
    parties: []
  };
  #draft = {
    channels: [],
    parties: []
  };
  #guests = [];
  #status = null;
  #statusError = "";
  #error = "";
  #groups = [];
  #guestSel = /* @__PURE__ */ new Set();
  #guestTalk = true;
  #guestName = "";
  #guestTtl = 120;
  #timer = 0;
  #loaded = false;
  #tab = loadTab();
  #selParty = 0;
  #matrix = newMatrixState();
  // Teilnehmerliste: Filter und Sammelanlage
  #pText = "";
  #pKind = "all";
  #bulkPrefix = "";
  #bulkCount = 10;
  #bulkKind = "human";
  #bulkLike = 0;
  connectedCallback() {
    this.style.cssText = "display:block;";
    if (!this.#loaded) {
      this.#loaded = true;
      void this.#load();
    }
    this.#timer = setInterval(() => void this.#poll(), 2e3);
    void this.#poll();
    this.#render();
  }
  disconnectedCallback() {
    clearInterval(this.#timer);
  }
  async #load() {
    try {
      const [cfg, guests, dir] = await Promise.all([
        apiFetch("/api/v1/ext/intercom/config"),
        apiFetch("/api/v1/ext/intercom/guests"),
        directory()
      ]);
      if (!cfg.ok) throw new Error((await cfg.json().catch(() => ({}))).error ?? String(cfg.status));
      this.#saved = await cfg.json();
      this.#draft = clone(this.#saved);
      this.#guests = guests.ok ? await guests.json() : [];
      this.#groups = dir?.groups ?? [];
      this.#error = "";
    } catch (e) {
      this.#error = t("icom.loadFailed", {
        p0: e.message
      });
    }
    this.#render();
  }
  async #poll() {
    try {
      const r = await apiFetch("/api/v1/ext/intercom/status");
      if (!r.ok) throw new Error(String(r.status));
      this.#status = await r.json();
      this.#statusError = "";
    } catch {
      this.#status = null;
      this.#statusError = t("icom.noNode");
    }
    this.#renderStatus();
  }
  #dirty() {
    return !sameConfig(this.#draft, this.#saved);
  }
  async #save() {
    const problems = localProblems(this.#draft);
    if (problems.length) {
      this.#error = t("icom.saveFailed", {
        p0: problems.join(", ")
      });
      this.#render();
      return;
    }
    const res = await apiFetch("/api/v1/ext/intercom/config", {
      method: "PUT",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(cleanConfig(this.#draft))
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      this.#error = t("icom.saveFailed", {
        p0: body.problems?.join("; ") ?? body.error ?? String(res.status)
      });
      this.#render();
      return;
    }
    this.#saved = body;
    this.#draft = clone(body);
    this.#error = "";
    showToast(t("icom.saved"));
    this.#render();
  }
  #render() {
    this.replaceChildren();
    if (this.#error) this.append(el3("div", "color:var(--omp-error);margin-bottom:10px;", this.#error));
    const bar = el3("div", "display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap;");
    bar.dataset.role = "bar";
    const dirty = this.#dirty();
    const save = btn(t("icom.save"), () => void this.#save());
    save.disabled = !dirty;
    const discard = btn(t("icom.discard"), () => {
      this.#draft = clone(this.#saved);
      this.#error = "";
      this.#render();
    });
    discard.disabled = !dirty;
    bar.append(save, discard);
    if (dirty) bar.append(el3("span", "color:var(--omp-warning,#b58900);font-size:12px;", t("icom.dirty")));
    const st = el3("span", `margin-left:auto;font-size:12px;${DIM3}`);
    st.dataset.role = "status";
    bar.append(st);
    this.append(bar);
    const tabs = el3("div", "display:flex;gap:2px;border-bottom:1px solid var(--omp-border);margin-bottom:14px;flex-wrap:wrap;");
    tabs.dataset.role = "tabs";
    for (const k of TABS) {
      const on = k === this.#tab;
      const b = el3("button", `padding:7px 16px;border:0;border-bottom:2px solid ${on ? "var(--omp-accent-cyan,#19d3f3)" : "transparent"};border-radius:0;background:none;font-weight:${on ? 700 : 400};${on ? "" : DIM3}cursor:pointer;`, t(`icom.tab.${k}`));
      b.dataset.tab = k;
      b.addEventListener("click", () => this.#goto(k));
      tabs.append(b);
    }
    this.append(tabs);
    if (this.#tab === "assign") this.append(this.#assignTab());
    else if (this.#tab === "parties") this.append(this.#partiesBox());
    else if (this.#tab === "channels") this.append(this.#channelsBox());
    else if (this.#tab === "layouts") this.append(this.#templatesBox());
    else this.append(this.#guestsBox());
    this.#renderStatus();
  }
  #goto(k, party) {
    this.#tab = k;
    if (party !== void 0) this.#selParty = party;
    try {
      localStorage.setItem("omp-intercom-admin-tab", k);
    } catch {
    }
    this.#render();
  }
  /** Gesamttabelle Teilnehmer × Kanäle: je Zelle Sprechen (Mikrofon) und Hören (Kopfhörer) per Klick. */
  #assignTab() {
    const box = el3("div", BOX);
    box.dataset.role = "assign";
    box.append(el3("div", DIM3 + "font-size:12px;margin-bottom:10px;", t("icom.assign.hint")));
    const { channels, parties } = this.#draft;
    if (!channels.length || !parties.length) {
      const empty = el3("div", "padding:10px 0;");
      empty.append(el3("div", DIM3 + "margin-bottom:8px;", t("icom.assign.needBoth")));
      const row = el3("div", "display:flex;gap:8px;");
      if (!channels.length) row.append(btn(t("icom.assign.toChannels"), () => this.#goto("channels")));
      if (!parties.length) row.append(btn(t("icom.assign.toParties"), () => this.#goto("parties")));
      empty.append(row);
      box.append(empty);
      return box;
    }
    box.append(matrixView({
      draft: () => this.#draft,
      state: this.#matrix,
      changed: () => this.#touch(),
      rebuild: () => this.#render(),
      openParty: (id) => this.#goto("parties", id),
      paintDots: () => this.#paintDots()
    }));
    return box;
  }
  #renderStatus() {
    const line = this.querySelector("[data-role=status]");
    if (!line) return;
    if (!this.#status) {
      line.textContent = this.#statusError || "\u2026";
      line.style.color = "var(--omp-error)";
    } else {
      const online = this.#status.parties.filter((p) => p.online).length;
      line.style.color = "";
      line.textContent = t("icom.statusLine", {
        p0: online,
        p1: this.#status.parties.length,
        p2: this.#status.late_ticks,
        p3: (this.#status.max_tick_us / 1e3).toFixed(1)
      });
    }
    this.#paintDots();
  }
  #paintDots() {
    const byId = new Map((this.#status?.parties ?? []).map((x) => [
      x.id,
      x
    ]));
    for (const d of this.querySelectorAll("[data-party-dot]")) {
      const p = byId.get(Number(d.dataset.partyDot));
      d.style.background = p?.speaking ? "var(--omp-ok,#2da44e)" : p?.online ? "var(--omp-ok,#2da44e)" : "var(--omp-border)";
      d.style.boxShadow = p?.speaking ? "0 0 0 3px color-mix(in srgb,var(--omp-ok,#2da44e) 35%,transparent)" : "none";
    }
  }
  #channelsBox() {
    const box = el3("div", BOX);
    box.dataset.role = "channels";
    box.append(el3("h3", H, t("icom.channels")), el3("div", DIM3 + "font-size:12px;margin-bottom:8px;", t("icom.channelsHint")));
    if (this.#draft.channels.length === 0) box.append(el3("div", DIM3 + "padding:6px 0;", t("icom.noChannels")));
    for (const c of this.#draft.channels) {
      const row = el3("div", "display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:8px;");
      row.dataset.channel = String(c.id);
      const color = el3("input", "width:44px;height:28px;padding:0;");
      color.type = "color";
      color.value = c.color || "#4c8dff";
      color.addEventListener("input", () => {
        c.color = color.value;
        this.#touch();
      });
      const kind = el3("select", "padding:3px 6px;");
      for (const k of [
        "party",
        "ifb"
      ]) {
        const o = el3("option", "", t(`icom.channel.kind.${k}`));
        o.value = k;
        kind.append(o);
      }
      kind.value = c.kind ?? "party";
      kind.addEventListener("change", () => {
        c.kind = kind.value;
        if (c.kind === "ifb" && !c.duck_db) c.duck_db = 20;
        this.#render();
      });
      row.append(field(t("icom.channel.name"), textInput(c.name, (v) => {
        c.name = v;
        this.#touch();
      }, "180px")), field(t("icom.channel.color"), color), field(t("icom.channel.kind"), kind));
      if (c.kind === "ifb") {
        const duck = el3("input", "padding:3px 6px;width:70px;");
        duck.type = "number";
        duck.min = "0";
        duck.max = "60";
        duck.value = String(c.duck_db ?? 20);
        duck.addEventListener("input", () => {
          c.duck_db = Number(duck.value);
          this.#touch();
        });
        row.append(field(t("icom.channel.duck"), duck));
      }
      row.append(btn("\u2715", async () => {
        if (!await confirmDialog(t("icom.channel.removeConfirm", {
          p0: c.name || `#${c.id}`
        }))) return;
        removeChannel(this.#draft, c.id);
        this.#render();
      }, t("icom.channel.remove")));
      box.append(row);
    }
    box.append(btn(t("icom.channel.add"), () => {
      addChannel(this.#draft, "");
      this.#render();
    }));
    return box;
  }
  /** Nur die Speichern-/Verwerfen-Knöpfe nachziehen, ohne die Felder neu zu bauen (Fokus bleibt). */
  #touch() {
    const [save, discard] = this.querySelectorAll("[data-role=bar] > button");
    const d = this.#dirty();
    if (save) save.disabled = !d;
    if (discard) discard.disabled = !d;
  }
  #partiesBox() {
    const box = el3("div", BOX);
    box.dataset.role = "parties";
    box.append(el3("div", DIM3 + "font-size:12px;margin-bottom:10px;", t("icom.partiesHint")));
    const parties = this.#draft.parties;
    if (!parties.some((p) => p.id === this.#selParty)) this.#selParty = parties[0]?.id ?? 0;
    const bar = el3("div", "display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:8px;");
    const q = textInput(this.#pText, (v) => {
      this.#pText = v;
      fillList();
    }, "200px", t("icom.m.filterPartyPh"));
    const kindFilter = el3("select", "padding:3px 6px;");
    for (const [v, text] of [
      [
        "all",
        t("icom.m.allKinds")
      ],
      ...[
        "human",
        "seat",
        "program",
        "port"
      ].map((k) => [
        k,
        t(`icom.party.kind.${k}`)
      ])
    ]) {
      const o = el3("option", "", text);
      o.value = v;
      kindFilter.append(o);
    }
    kindFilter.value = this.#pKind;
    kindFilter.addEventListener("change", () => {
      this.#pKind = kindFilter.value;
      fillList();
    });
    const count = el3("span", "font-size:12px;" + DIM3);
    bar.append(field(t("icom.m.filterParty"), q), field(t("icom.party.kind"), kindFilter), count);
    box.append(bar);
    const cols = el3("div", "display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;");
    const left = el3("div", "display:flex;flex-direction:column;gap:6px;min-width:220px;flex:0 0 260px;");
    const list = el3("div", "display:flex;flex-direction:column;gap:2px;max-height:min(60vh,640px);overflow:auto;");
    list.dataset.role = "party-list";
    const fillList = () => {
      const shown = filterParties(parties, {
        text: this.#pText,
        kind: this.#pKind
      });
      count.textContent = t("icom.m.listCount", {
        p0: shown.length,
        p1: parties.length
      });
      list.replaceChildren();
      for (const p of shown) {
        const on = p.id === this.#selParty;
        const row = el3("button", `display:flex;gap:8px;align-items:center;text-align:left;padding:5px 10px;border-radius:6px;border:1px solid ${on ? "var(--omp-accent-cyan,#19d3f3)" : "transparent"};background:${on ? "color-mix(in srgb,var(--omp-accent-cyan,#19d3f3) 14%,transparent)" : "none"};cursor:pointer;flex:none;`);
        const dot = el3("span", "width:9px;height:9px;border-radius:50%;background:var(--omp-border);flex:none;");
        dot.dataset.partyDot = String(p.id);
        row.append(dot, el3("span", "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", p.name || `#${p.id}`), el3("span", "font-size:11px;" + DIM3, t(`icom.party.kind.${p.kind ?? "human"}`)));
        row.dataset.pick = String(p.id);
        row.addEventListener("click", () => {
          this.#selParty = p.id;
          this.#render();
        });
        list.append(row);
      }
      this.#paintDots();
    };
    fillList();
    left.append(list);
    left.append(btn(t("icom.party.add"), () => {
      this.#selParty = addParty(this.#draft, "").id;
      this.#pText = "";
      this.#render();
    }));
    const det = el3("details", "margin-top:6px;");
    det.append(el3("summary", "cursor:pointer;" + DIM3, t("icom.m.bulkAdd")));
    const form = el3("div", "display:flex;flex-direction:column;gap:6px;margin-top:6px;");
    const cnt = el3("input", "padding:3px 6px;width:80px;");
    cnt.type = "number";
    cnt.min = "1";
    cnt.max = String(MAX_BULK_ADD);
    cnt.value = String(this.#bulkCount);
    cnt.addEventListener("input", () => this.#bulkCount = Number(cnt.value));
    const kindSel = el3("select", "padding:3px 6px;");
    for (const k of [
      "human",
      "seat",
      "program",
      "port"
    ]) {
      const o = el3("option", "", t(`icom.party.kind.${k}`));
      o.value = k;
      kindSel.append(o);
    }
    kindSel.value = this.#bulkKind;
    kindSel.addEventListener("change", () => this.#bulkKind = kindSel.value);
    const like = el3("select", "padding:3px 6px;max-width:200px;");
    const none = el3("option", "", t("icom.m.bulkLikeNone"));
    none.value = "0";
    like.append(none);
    for (const p of parties) {
      const o = el3("option", "", p.name || `#${p.id}`);
      o.value = String(p.id);
      like.append(o);
    }
    like.value = String(this.#bulkLike);
    like.addEventListener("change", () => this.#bulkLike = Number(like.value));
    form.append(field(t("icom.m.bulkPrefix"), textInput(this.#bulkPrefix, (v) => this.#bulkPrefix = v, "180px", t("icom.m.bulkPrefixPh"))), el3("div", "display:flex;gap:8px;"), field(t("icom.m.bulkLike"), like));
    form.children[1].append(field(t("icom.m.bulkCount"), cnt), field(t("icom.party.kind"), kindSel));
    form.append(btn(t("icom.m.bulkCreate"), () => {
      if (!this.#bulkPrefix.trim()) {
        showToast(t("icom.m.bulkNeedPrefix"));
        return;
      }
      const made = addParties(this.#draft, this.#bulkPrefix, this.#bulkCount, this.#bulkKind, parties.find((p) => p.id === this.#bulkLike));
      if (made.length) this.#selParty = made[0].id;
      this.#pText = "";
      showToast(t("icom.m.bulkCreated", {
        p0: made.length
      }));
      this.#render();
    }));
    det.append(form);
    left.append(det);
    cols.append(left);
    const sel = parties.find((p) => p.id === this.#selParty);
    const detail = el3("div", "flex:1 1 380px;min-width:300px;");
    if (sel) detail.append(this.#partyCard(sel));
    else detail.append(el3("div", DIM3 + "padding:6px 0;", t("icom.noParties")));
    cols.append(detail);
    box.append(cols);
    return box;
  }
  #partyCard(p) {
    const card = el3("div", "border:1px solid var(--omp-border);border-radius:8px;padding:12px 14px;");
    card.dataset.party = String(p.id);
    const head = el3("div", "display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;");
    const dot = el3("span", "width:10px;height:10px;border-radius:50%;background:var(--omp-border);align-self:center;");
    dot.dataset.partyDot = String(p.id);
    const kind = el3("select", "padding:3px 6px;");
    for (const k of [
      "human",
      "seat",
      "program",
      "port"
    ]) {
      const o = el3("option", "", t(`icom.party.kind.${k}`));
      o.value = k;
      kind.append(o);
    }
    kind.value = p.kind ?? "human";
    kind.addEventListener("change", () => {
      p.kind = kind.value;
      this.#render();
    });
    const prio = el3("input", "padding:3px 6px;width:60px;");
    prio.type = "number";
    prio.min = "0";
    prio.max = "9";
    prio.value = String(p.priority ?? 0);
    prio.addEventListener("input", () => {
      p.priority = Number(prio.value);
      this.#touch();
    });
    head.append(dot, field(t("icom.party.name"), textInput(p.name, (v) => {
      p.name = v;
      this.#touch();
    }, "180px")), field(t("icom.party.kind"), kind), field(t("icom.party.priority"), prio));
    head.append(btn(t("icom.m.duplicate"), () => {
      const d = duplicateParty(this.#draft, p.id);
      if (d) this.#selParty = d.id;
      this.#render();
    }, t("icom.m.duplicateHint")), btn("\u2715", async () => {
      if (!await confirmDialog(t("icom.party.removeConfirm", {
        p0: p.name || `#${p.id}`
      }))) return;
      removeParty(this.#draft, p.id);
      this.#render();
    }, t("icom.party.remove")));
    card.append(head);
    const sec = (key) => el3("div", "font-size:11px;letter-spacing:.06em;text-transform:uppercase;margin:14px 0 4px;" + DIM3, t(key));
    const human = (p.kind ?? "human") === "human" || p.kind === "seat";
    if (p.kind === "program" || p.kind === "port") {
      const slot = (label, value, set) => {
        const i = el3("input", "padding:3px 6px;width:70px;");
        i.type = "number";
        i.min = "0";
        i.max = "16";
        i.value = String(value ?? 0);
        i.addEventListener("input", () => {
          set(Number(i.value));
          this.#touch();
        });
        return field(label, i);
      };
      const ports = el3("div", "display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;align-items:flex-end;");
      ports.append(slot(t("icom.party.mxlIn"), p.mxl_in, (n) => p.mxl_in = n), slot(t("icom.party.mxlOut"), p.mxl_out, (n) => p.mxl_out = n), el3("span", DIM3 + "font-size:12px;", t("icom.party.mxlHint")));
      card.append(sec("icom.party.section.link"), ports);
    }
    if (human) {
      const who = el3("div", "display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;align-items:flex-end;");
      who.append(field(t("icom.party.users"), textInput((p.users ?? []).join(", "), (v) => {
        p.users = splitList(v);
        this.#touch();
      }, "260px")));
      if (this.#groups.length) {
        const g = el3("select", "padding:3px 6px;min-width:160px;");
        g.multiple = true;
        g.size = Math.min(4, this.#groups.length);
        for (const x of this.#groups) {
          const o = el3("option", "", x.name);
          o.value = x.id;
          o.selected = (p.groups ?? []).includes(x.id);
          g.append(o);
        }
        g.addEventListener("change", () => {
          p.groups = [
            ...g.selectedOptions
          ].map((o) => o.value);
          this.#touch();
        });
        who.append(field(t("icom.party.groups"), g));
      }
      who.append(btn(t("icom.party.rotate"), async () => {
        if (!await confirmDialog(t("icom.party.rotateConfirm", {
          p0: p.name
        }))) return;
        const r = await apiFetch(`/api/v1/ext/intercom/parties/${p.id}/rotate-token`, {
          method: "POST"
        });
        showToast(r.ok ? t("icom.party.rotated") : t("icom.saveFailed", {
          p0: r.status
        }));
      }));
      card.append(sec("icom.party.section.access"), who);
    }
    const flags = el3("div", "display:flex;gap:16px;flex-wrap:wrap;margin-top:8px;");
    flags.append(check(t("icom.party.force"), !!p.force, (v) => {
      p.force = v;
      this.#touch();
    }), check(t("icom.party.onairLock"), !!p.onair_lock, (v) => {
      p.onair_lock = v;
      this.#touch();
    }));
    if (human) flags.append(check(t("icom.party.open"), !!p.open, (v) => {
      p.open = v;
      this.#touch();
    }));
    card.append(sec("icom.party.section.rights"), flags);
    const routes = this.#draft.channels.filter((c) => getRoute(p, c.id)?.talk || getRoute(p, c.id)?.listen);
    const sum = el3("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;");
    sum.dataset.role = "summary";
    sum.append(el3("span", routes.length ? "" : DIM3, routes.length ? t("icom.party.summary", {
      p0: routes.map((c) => `${c.name || `#${c.id}`} ${getRoute(p, c.id)?.talk ? "\u{1F3A4}" : ""}${getRoute(p, c.id)?.listen ? "\u{1F3A7}" : ""}`).join(" \xB7 ")
    }) : t("icom.party.summaryNone")), btn(t("icom.party.toAssign"), () => this.#goto("assign")));
    card.append(sec("icom.matrix"), sum);
    if (human) {
      const det = el3("details", "margin-top:14px;");
      det.open = p.layout !== void 0 || p.template !== void 0;
      det.append(el3("summary", "cursor:pointer;" + DIM3, t("icom.layout.advanced")), this.#layoutSection(p));
      card.append(det);
    }
    return card;
  }
  #layoutSection(p) {
    const box = el3("div", "margin-top:10px;");
    box.dataset.role = "layout";
    box.append(el3("div", "font-size:11px;letter-spacing:.05em;text-transform:uppercase;" + DIM3, t("icom.layout")), el3("div", "font-size:12px;" + DIM3, t("icom.layout.hint")));
    const row = el3("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px;");
    const mode = layoutMode(p);
    const sel = el3("select", "padding:3px 6px;");
    for (const m of [
      "default",
      "template",
      "own"
    ]) {
      const o = el3("option", "", t(`icom.layout.mode.${m}`));
      o.value = m;
      if (m === "template" && !(this.#draft.templates ?? []).length) {
        o.disabled = true;
        o.textContent += ` (${t("icom.layout.noTemplates")})`;
      }
      sel.append(o);
    }
    sel.value = mode;
    sel.addEventListener("change", () => {
      const m = sel.value;
      if (m === "default") {
        delete p.layout;
        delete p.template;
      } else if (m === "template") {
        delete p.layout;
        p.template = (this.#draft.templates ?? [])[0]?.id;
      } else {
        delete p.template;
        p.layout ??= layoutFromAssignment(p, this.#draft);
      }
      this.#render();
    });
    row.append(sel);
    if (mode === "template") {
      const ts = el3("select", "padding:3px 6px;");
      for (const t2 of this.#draft.templates ?? []) {
        const o = el3("option", "", t2.name || `#${t2.id}`);
        o.value = String(t2.id);
        ts.append(o);
      }
      ts.value = String(p.template);
      ts.addEventListener("change", () => {
        p.template = Number(ts.value);
        this.#touch();
      });
      row.append(ts);
    }
    if (mode === "own") {
      row.append(btn(t("icom.layout.fromAssignment"), async () => {
        if (!await confirmDialog(t("icom.layout.fromAssignmentConfirm", {
          p0: p.name
        }))) return;
        p.layout = layoutFromAssignment(p, this.#draft);
        this.#render();
      }));
    }
    box.append(row);
    if (mode === "own" && p.layout) box.append(layoutEditor(p.layout, this.#draft, () => this.#touch(), () => this.#render()));
    return box;
  }
  #templatesBox() {
    const box = el3("div", BOX);
    box.dataset.role = "templates";
    box.append(el3("h3", H, t("icom.templates")), el3("div", DIM3 + "font-size:12px;margin-bottom:8px;", t("icom.templatesHint")));
    const list = this.#draft.templates ?? [];
    if (list.length === 0) box.append(el3("div", DIM3 + "padding:6px 0;", t("icom.noTemplates")));
    for (const t2 of list) {
      const card = el3("div", "border:1px solid var(--omp-border);border-radius:6px;padding:10px;margin-bottom:10px;");
      card.dataset.template = String(t2.id);
      const head = el3("div", "display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;");
      const users = this.#draft.parties.filter((p) => p.template === t2.id && !p.layout).map((p) => p.name || `#${p.id}`);
      head.append(field(t("icom.template.name"), textInput(t2.name, (v) => {
        t2.name = v;
        this.#touch();
      }, "200px")));
      if (users.length) head.append(el3("span", DIM3 + "font-size:12px;", t("icom.template.usedBy", {
        p0: users.join(", ")
      })));
      head.append(btn("\u2715", async () => {
        if (!await confirmDialog(t("icom.template.removeConfirm", {
          p0: t2.name || `#${t2.id}`
        }))) return;
        removeTemplate(this.#draft, t2.id);
        this.#render();
      }, t("icom.template.remove")));
      card.append(head, layoutEditor(t2.layout, this.#draft, () => this.#touch(), () => this.#render()));
      box.append(card);
    }
    box.append(btn(t("icom.template.add"), () => {
      addTemplate(this.#draft, "");
      this.#render();
    }));
    return box;
  }
  #guestsBox() {
    const box = el3("div", BOX);
    box.dataset.role = "guests";
    box.append(el3("h3", H, t("icom.guests")), el3("div", DIM3 + "font-size:12px;margin-bottom:8px;", t("icom.guestsHint")));
    if (this.#guests.length === 0) box.append(el3("div", DIM3 + "padding:6px 0;", t("icom.guest.none")));
    const fmt = new Intl.DateTimeFormat(dateLocale(), {
      dateStyle: "short",
      timeStyle: "short"
    });
    for (const g of this.#guests) {
      const row = el3("div", "display:flex;gap:10px;align-items:center;margin-bottom:6px;flex-wrap:wrap;");
      row.dataset.guest = String(g.id);
      row.append(el3("strong", "", g.name), el3("span", DIM3 + "font-size:12px;", t("icom.guest.until", {
        p0: fmt.format(new Date(g.expires))
      })));
      row.append(btn(t("icom.guest.copy"), async () => {
        try {
          await navigator.clipboard.writeText(g.url ?? "");
          showToast(t("icom.guest.copied"));
        } catch {
          showToast(t("icom.guest.copyFailed", {
            p0: g.url ?? ""
          }));
        }
      }), btn(t("icom.guest.delete"), async () => {
        await apiFetch(`/api/v1/ext/intercom/guests/${g.id}`, {
          method: "DELETE"
        });
        await this.#load();
      }));
      box.append(row);
    }
    const form = el3("div", "display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-top:10px;border-top:1px solid var(--omp-border);padding-top:10px;");
    const ttl = el3("input", "padding:3px 6px;width:90px;");
    ttl.type = "number";
    ttl.min = "1";
    ttl.value = String(this.#guestTtl);
    ttl.addEventListener("input", () => this.#guestTtl = Number(ttl.value));
    form.append(field(t("icom.guest.name"), textInput(this.#guestName, (v) => this.#guestName = v, "180px")), field(t("icom.guest.ttl"), ttl));
    const chans = el3("div", "display:flex;gap:12px;flex-wrap:wrap;align-self:center;");
    for (const c of this.#saved.channels) {
      chans.append(check(c.name, this.#guestSel.has(c.id), (v) => v ? this.#guestSel.add(c.id) : this.#guestSel.delete(c.id)));
    }
    chans.append(check(t("icom.talk"), this.#guestTalk, (v) => this.#guestTalk = v));
    form.append(chans, btn(t("icom.guest.create"), async () => {
      if (this.#guestSel.size === 0) {
        showToast(t("icom.guest.pickChannel"));
        return;
      }
      const res = await apiFetch("/api/v1/ext/intercom/guests", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: this.#guestName,
          ttl_minutes: this.#guestTtl,
          routes: guestRoutes(this.#guestSel, this.#guestTalk)
        })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(t("icom.guest.createFailed", {
          p0: body.error ?? res.status
        }));
        return;
      }
      this.#guestName = "";
      await this.#load();
    }));
    box.append(form);
    return box;
  }
};
if (!customElements.get("omp-intercom-admin")) customElements.define("omp-intercom-admin", IntercomAdmin);

// ui/modules/intercom/intercom-tile.ts
function el4(tag, css = "", text = "") {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}
var IntercomTile = class extends HTMLElement {
  #panels = [];
  #current = 0;
  #error = "";
  #loaded = false;
  connectedCallback() {
    this.style.cssText = "display:block;";
    if (!this.#loaded) {
      this.#loaded = true;
      void this.#load();
    }
    this.#render();
  }
  async #load() {
    try {
      const r = await apiFetch("/api/v1/ext/intercom/panels");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? String(r.status));
      const body = await r.json();
      this.#panels = body.panels ?? [];
      this.#error = body.error ?? "";
    } catch (e) {
      this.#error = t("icom.tile.loadFailed", {
        p0: e.message
      });
    }
    this.#render();
  }
  #render() {
    this.replaceChildren();
    if (this.#error) this.append(el4("div", "color:var(--omp-error);margin-bottom:8px;", this.#error));
    if (!this.#loaded || this.#panels.length === 0 && !this.#error) {
      if (this.#loaded) this.append(el4("div", "color:var(--omp-text-dim);padding:12px 0;", t("icom.tile.none")));
      return;
    }
    if (this.#panels.length === 0) return;
    const p = this.#panels[Math.min(this.#current, this.#panels.length - 1)];
    const bar = el4("div", "display:flex;gap:12px;align-items:center;margin-bottom:8px;flex-wrap:wrap;");
    if (this.#panels.length > 1) {
      const sel = el4("select", "padding:3px 6px;");
      this.#panels.forEach((x, i) => {
        const o = el4("option", "", x.name);
        o.value = String(i);
        sel.append(o);
      });
      sel.value = String(this.#current);
      sel.addEventListener("change", () => {
        this.#current = Number(sel.value);
        this.#render();
      });
      bar.append(el4("span", "font-size:12px;color:var(--omp-text-dim);", t("icom.tile.pick")), sel);
    } else {
      bar.append(el4("strong", "", p.name));
    }
    const open = el4("a", "font-size:12px;", t("icom.tile.newTab"));
    open.href = p.url;
    open.target = "_blank";
    open.rel = "noopener";
    bar.append(open, el4("span", "font-size:11px;color:var(--omp-text-dim);", t("icom.tile.certHint")));
    this.append(bar);
    const frame = el4("iframe", "width:100%;max-width:980px;height:calc(100vh - 200px);min-height:420px;border:1px solid var(--omp-border);border-radius:8px;background:var(--omp-bg);");
    frame.setAttribute("allow", "microphone; autoplay");
    frame.src = p.url;
    frame.title = p.name;
    this.append(frame);
  }
};
if (!customElements.get("omp-intercom-tile")) customElements.define("omp-intercom-tile", IntercomTile);
