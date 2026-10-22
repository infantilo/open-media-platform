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

// ui/modules/intercom/intercom-admin.ts
function el2(tag, css = "", text = "") {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}
var DIM2 = "color:var(--omp-text-dim);";
var BOX = "border:1px solid var(--omp-border);border-radius:8px;padding:12px 14px;margin-bottom:16px;";
var H = "font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--omp-text-dim);margin:0 0 8px;";
function field(label, input, width = "") {
  const w = el2("label", `display:flex;flex-direction:column;gap:2px;${width ? `width:${width};` : ""}`);
  w.append(el2("span", "font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--omp-text-dim);", label), input);
  return w;
}
function textInput(value, onInput, width = "", placeholder = "") {
  const i = el2("input", `padding:3px 6px;${width ? `width:${width};` : ""}`);
  i.value = value;
  if (placeholder) i.placeholder = placeholder;
  i.addEventListener("input", () => onInput(i.value));
  return i;
}
function check(label, on, onChange) {
  const l = el2("label", "display:flex;gap:6px;align-items:center;font-size:13px;");
  const c = el2("input");
  c.type = "checkbox";
  c.checked = on;
  c.addEventListener("change", () => onChange(c.checked));
  l.append(c, el2("span", "", label));
  return l;
}
function btn(text, onClick, title = "") {
  const b = el2("button", "padding:3px 10px;", text);
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
    if (this.#error) this.append(el2("div", "color:var(--omp-error);margin-bottom:10px;", this.#error));
    const bar = el2("div", "display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap;");
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
    if (dirty) bar.append(el2("span", "color:var(--omp-warning,#b58900);font-size:12px;", t("icom.dirty")));
    const st = el2("span", `margin-left:auto;font-size:12px;${DIM2}`);
    st.dataset.role = "status";
    bar.append(st);
    this.append(bar);
    const tabs = el2("div", "display:flex;gap:2px;border-bottom:1px solid var(--omp-border);margin-bottom:14px;flex-wrap:wrap;");
    tabs.dataset.role = "tabs";
    for (const k of TABS) {
      const on = k === this.#tab;
      const b = el2("button", `padding:7px 16px;border:0;border-bottom:2px solid ${on ? "var(--omp-accent-cyan,#19d3f3)" : "transparent"};border-radius:0;background:none;font-weight:${on ? 700 : 400};${on ? "" : DIM2}cursor:pointer;`, t(`icom.tab.${k}`));
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
    const box = el2("div", BOX);
    box.dataset.role = "assign";
    box.append(el2("div", DIM2 + "font-size:12px;margin-bottom:10px;", t("icom.assign.hint")));
    const { channels, parties } = this.#draft;
    if (!channels.length || !parties.length) {
      const empty = el2("div", "padding:10px 0;");
      empty.append(el2("div", DIM2 + "margin-bottom:8px;", t("icom.assign.needBoth")));
      const row = el2("div", "display:flex;gap:8px;");
      if (!channels.length) row.append(btn(t("icom.assign.toChannels"), () => this.#goto("channels")));
      if (!parties.length) row.append(btn(t("icom.assign.toParties"), () => this.#goto("parties")));
      empty.append(row);
      box.append(empty);
      return box;
    }
    const wrap = el2("div", "overflow-x:auto;");
    const grid = el2("div", `display:grid;grid-template-columns:minmax(150px,max-content) repeat(${channels.length},minmax(84px,1fr));gap:4px;align-items:center;`);
    grid.append(el2("span"));
    for (const c of channels) {
      const h = el2("span", `font-size:12px;font-weight:600;text-align:center;padding:4px 6px;border-radius:4px;border-bottom:3px solid ${c.color || "#4c8dff"};`, c.name || `#${c.id}`);
      grid.append(h);
    }
    const toggle = (p, ch, f) => {
      const b = el2("button", "padding:3px 8px;min-width:34px;");
      const paint = () => {
        const on = !!getRoute(p, ch)?.[f];
        b.textContent = f === "talk" ? "\u{1F3A4}" : "\u{1F3A7}";
        b.style.opacity = on ? "1" : "0.28";
        b.style.background = on ? "color-mix(in srgb,var(--omp-accent-cyan,#19d3f3) 28%,transparent)" : "";
        b.setAttribute("aria-pressed", String(on));
      };
      b.title = t(f === "talk" ? "icom.talk" : "icom.listen");
      b.addEventListener("click", () => {
        setRoute(p, ch, f, !getRoute(p, ch)?.[f]);
        paint();
        this.#touch();
      });
      paint();
      return b;
    };
    for (const p of parties) {
      const name = el2("button", "text-align:left;border:0;background:none;padding:4px 2px;cursor:pointer;display:flex;gap:8px;align-items:center;");
      const dot = el2("span", "width:9px;height:9px;border-radius:50%;background:var(--omp-border);flex:none;");
      dot.dataset.partyDot = String(p.id);
      name.append(dot, el2("span", "", p.name || `#${p.id}`));
      name.title = t("icom.assign.openParty");
      name.addEventListener("click", () => this.#goto("parties", p.id));
      grid.append(name);
      for (const c of channels) {
        const cell = el2("span", "display:flex;gap:4px;justify-content:center;");
        cell.append(toggle(p, c.id, "talk"), toggle(p, c.id, "listen"));
        grid.append(cell);
      }
    }
    wrap.append(grid);
    box.append(wrap);
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
    for (const d of this.querySelectorAll("[data-party-dot]")) {
      const p = this.#status?.parties.find((x) => x.id === Number(d.dataset.partyDot));
      d.style.background = p?.speaking ? "var(--omp-ok,#2da44e)" : p?.online ? "var(--omp-ok,#2da44e)" : "var(--omp-border)";
      d.style.boxShadow = p?.speaking ? "0 0 0 3px color-mix(in srgb,var(--omp-ok,#2da44e) 35%,transparent)" : "none";
    }
  }
  #channelsBox() {
    const box = el2("div", BOX);
    box.dataset.role = "channels";
    box.append(el2("h3", H, t("icom.channels")), el2("div", DIM2 + "font-size:12px;margin-bottom:8px;", t("icom.channelsHint")));
    if (this.#draft.channels.length === 0) box.append(el2("div", DIM2 + "padding:6px 0;", t("icom.noChannels")));
    for (const c of this.#draft.channels) {
      const row = el2("div", "display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:8px;");
      row.dataset.channel = String(c.id);
      const color = el2("input", "width:44px;height:28px;padding:0;");
      color.type = "color";
      color.value = c.color || "#4c8dff";
      color.addEventListener("input", () => {
        c.color = color.value;
        this.#touch();
      });
      const kind = el2("select", "padding:3px 6px;");
      for (const k of [
        "party",
        "ifb"
      ]) {
        const o = el2("option", "", t(`icom.channel.kind.${k}`));
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
        const duck = el2("input", "padding:3px 6px;width:70px;");
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
    const box = el2("div", BOX);
    box.dataset.role = "parties";
    box.append(el2("div", DIM2 + "font-size:12px;margin-bottom:10px;", t("icom.partiesHint")));
    const parties = this.#draft.parties;
    if (!parties.some((p) => p.id === this.#selParty)) this.#selParty = parties[0]?.id ?? 0;
    const cols = el2("div", "display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;");
    const list = el2("div", "display:flex;flex-direction:column;gap:2px;min-width:200px;flex:0 0 220px;");
    for (const p of parties) {
      const on = p.id === this.#selParty;
      const row = el2("button", `display:flex;gap:8px;align-items:center;text-align:left;padding:7px 10px;border-radius:6px;border:1px solid ${on ? "var(--omp-accent-cyan,#19d3f3)" : "transparent"};background:${on ? "color-mix(in srgb,var(--omp-accent-cyan,#19d3f3) 14%,transparent)" : "none"};cursor:pointer;`);
      const dot = el2("span", "width:9px;height:9px;border-radius:50%;background:var(--omp-border);flex:none;");
      dot.dataset.partyDot = String(p.id);
      row.append(dot, el2("span", "flex:1;", p.name || `#${p.id}`), el2("span", "font-size:11px;" + DIM2, t(`icom.party.kind.${p.kind ?? "human"}`)));
      row.dataset.pick = String(p.id);
      row.addEventListener("click", () => {
        this.#selParty = p.id;
        this.#render();
      });
      list.append(row);
    }
    list.append(btn(t("icom.party.add"), () => {
      this.#selParty = addParty(this.#draft, "").id;
      this.#render();
    }));
    cols.append(list);
    const sel = parties.find((p) => p.id === this.#selParty);
    const detail = el2("div", "flex:1 1 380px;min-width:300px;");
    if (sel) detail.append(this.#partyCard(sel));
    else detail.append(el2("div", DIM2 + "padding:6px 0;", t("icom.noParties")));
    cols.append(detail);
    box.append(cols);
    return box;
  }
  #partyCard(p) {
    const card = el2("div", "border:1px solid var(--omp-border);border-radius:8px;padding:12px 14px;");
    card.dataset.party = String(p.id);
    const head = el2("div", "display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;");
    const dot = el2("span", "width:10px;height:10px;border-radius:50%;background:var(--omp-border);align-self:center;");
    dot.dataset.partyDot = String(p.id);
    const kind = el2("select", "padding:3px 6px;");
    for (const k of [
      "human",
      "seat",
      "program",
      "port"
    ]) {
      const o = el2("option", "", t(`icom.party.kind.${k}`));
      o.value = k;
      kind.append(o);
    }
    kind.value = p.kind ?? "human";
    kind.addEventListener("change", () => {
      p.kind = kind.value;
      this.#render();
    });
    const prio = el2("input", "padding:3px 6px;width:60px;");
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
    head.append(btn("\u2715", async () => {
      if (!await confirmDialog(t("icom.party.removeConfirm", {
        p0: p.name || `#${p.id}`
      }))) return;
      removeParty(this.#draft, p.id);
      this.#render();
    }, t("icom.party.remove")));
    card.append(head);
    const sec = (key) => el2("div", "font-size:11px;letter-spacing:.06em;text-transform:uppercase;margin:14px 0 4px;" + DIM2, t(key));
    const human = (p.kind ?? "human") === "human" || p.kind === "seat";
    if (p.kind === "program" || p.kind === "port") {
      const slot = (label, value, set) => {
        const i = el2("input", "padding:3px 6px;width:70px;");
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
      const ports = el2("div", "display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;align-items:flex-end;");
      ports.append(slot(t("icom.party.mxlIn"), p.mxl_in, (n) => p.mxl_in = n), slot(t("icom.party.mxlOut"), p.mxl_out, (n) => p.mxl_out = n), el2("span", DIM2 + "font-size:12px;", t("icom.party.mxlHint")));
      card.append(sec("icom.party.section.link"), ports);
    }
    if (human) {
      const who = el2("div", "display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;align-items:flex-end;");
      who.append(field(t("icom.party.users"), textInput((p.users ?? []).join(", "), (v) => {
        p.users = splitList(v);
        this.#touch();
      }, "260px")));
      if (this.#groups.length) {
        const g = el2("select", "padding:3px 6px;min-width:160px;");
        g.multiple = true;
        g.size = Math.min(4, this.#groups.length);
        for (const x of this.#groups) {
          const o = el2("option", "", x.name);
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
    const flags = el2("div", "display:flex;gap:16px;flex-wrap:wrap;margin-top:8px;");
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
    const sum = el2("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;");
    sum.dataset.role = "summary";
    sum.append(el2("span", routes.length ? "" : DIM2, routes.length ? t("icom.party.summary", {
      p0: routes.map((c) => `${c.name || `#${c.id}`} ${getRoute(p, c.id)?.talk ? "\u{1F3A4}" : ""}${getRoute(p, c.id)?.listen ? "\u{1F3A7}" : ""}`).join(" \xB7 ")
    }) : t("icom.party.summaryNone")), btn(t("icom.party.toAssign"), () => this.#goto("assign")));
    card.append(sec("icom.matrix"), sum);
    if (human) {
      const det = el2("details", "margin-top:14px;");
      det.open = p.layout !== void 0 || p.template !== void 0;
      det.append(el2("summary", "cursor:pointer;" + DIM2, t("icom.layout.advanced")), this.#layoutSection(p));
      card.append(det);
    }
    return card;
  }
  #layoutSection(p) {
    const box = el2("div", "margin-top:10px;");
    box.dataset.role = "layout";
    box.append(el2("div", "font-size:11px;letter-spacing:.05em;text-transform:uppercase;" + DIM2, t("icom.layout")), el2("div", "font-size:12px;" + DIM2, t("icom.layout.hint")));
    const row = el2("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px;");
    const mode = layoutMode(p);
    const sel = el2("select", "padding:3px 6px;");
    for (const m of [
      "default",
      "template",
      "own"
    ]) {
      const o = el2("option", "", t(`icom.layout.mode.${m}`));
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
      const ts = el2("select", "padding:3px 6px;");
      for (const t2 of this.#draft.templates ?? []) {
        const o = el2("option", "", t2.name || `#${t2.id}`);
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
    const box = el2("div", BOX);
    box.dataset.role = "templates";
    box.append(el2("h3", H, t("icom.templates")), el2("div", DIM2 + "font-size:12px;margin-bottom:8px;", t("icom.templatesHint")));
    const list = this.#draft.templates ?? [];
    if (list.length === 0) box.append(el2("div", DIM2 + "padding:6px 0;", t("icom.noTemplates")));
    for (const t2 of list) {
      const card = el2("div", "border:1px solid var(--omp-border);border-radius:6px;padding:10px;margin-bottom:10px;");
      card.dataset.template = String(t2.id);
      const head = el2("div", "display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;");
      const users = this.#draft.parties.filter((p) => p.template === t2.id && !p.layout).map((p) => p.name || `#${p.id}`);
      head.append(field(t("icom.template.name"), textInput(t2.name, (v) => {
        t2.name = v;
        this.#touch();
      }, "200px")));
      if (users.length) head.append(el2("span", DIM2 + "font-size:12px;", t("icom.template.usedBy", {
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
    const box = el2("div", BOX);
    box.dataset.role = "guests";
    box.append(el2("h3", H, t("icom.guests")), el2("div", DIM2 + "font-size:12px;margin-bottom:8px;", t("icom.guestsHint")));
    if (this.#guests.length === 0) box.append(el2("div", DIM2 + "padding:6px 0;", t("icom.guest.none")));
    const fmt = new Intl.DateTimeFormat(dateLocale(), {
      dateStyle: "short",
      timeStyle: "short"
    });
    for (const g of this.#guests) {
      const row = el2("div", "display:flex;gap:10px;align-items:center;margin-bottom:6px;flex-wrap:wrap;");
      row.dataset.guest = String(g.id);
      row.append(el2("strong", "", g.name), el2("span", DIM2 + "font-size:12px;", t("icom.guest.until", {
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
    const form = el2("div", "display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-top:10px;border-top:1px solid var(--omp-border);padding-top:10px;");
    const ttl = el2("input", "padding:3px 6px;width:90px;");
    ttl.type = "number";
    ttl.min = "1";
    ttl.value = String(this.#guestTtl);
    ttl.addEventListener("input", () => this.#guestTtl = Number(ttl.value));
    form.append(field(t("icom.guest.name"), textInput(this.#guestName, (v) => this.#guestName = v, "180px")), field(t("icom.guest.ttl"), ttl));
    const chans = el2("div", "display:flex;gap:12px;flex-wrap:wrap;align-self:center;");
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
function el3(tag, css = "", text = "") {
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
    if (this.#error) this.append(el3("div", "color:var(--omp-error);margin-bottom:8px;", this.#error));
    if (!this.#loaded || this.#panels.length === 0 && !this.#error) {
      if (this.#loaded) this.append(el3("div", "color:var(--omp-text-dim);padding:12px 0;", t("icom.tile.none")));
      return;
    }
    if (this.#panels.length === 0) return;
    const p = this.#panels[Math.min(this.#current, this.#panels.length - 1)];
    const bar = el3("div", "display:flex;gap:12px;align-items:center;margin-bottom:8px;flex-wrap:wrap;");
    if (this.#panels.length > 1) {
      const sel = el3("select", "padding:3px 6px;");
      this.#panels.forEach((x, i) => {
        const o = el3("option", "", x.name);
        o.value = String(i);
        sel.append(o);
      });
      sel.value = String(this.#current);
      sel.addEventListener("change", () => {
        this.#current = Number(sel.value);
        this.#render();
      });
      bar.append(el3("span", "font-size:12px;color:var(--omp-text-dim);", t("icom.tile.pick")), sel);
    } else {
      bar.append(el3("strong", "", p.name));
    }
    const open = el3("a", "font-size:12px;", t("icom.tile.newTab"));
    open.href = p.url;
    open.target = "_blank";
    open.rel = "noopener";
    bar.append(open, el3("span", "font-size:11px;color:var(--omp-text-dim);", t("icom.tile.certHint")));
    this.append(bar);
    const frame = el3("iframe", "width:100%;max-width:980px;height:calc(100vh - 200px);min-height:420px;border:1px solid var(--omp-border);border-radius:8px;background:var(--omp-bg);");
    frame.setAttribute("allow", "microphone; autoplay");
    frame.src = p.url;
    frame.title = p.name;
    this.append(frame);
  }
};
if (!customElements.get("omp-intercom-tile")) customElements.define("omp-intercom-tile", IntercomTile);
