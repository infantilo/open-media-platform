// Reine Logik des Audit-Log-Panels (audit-panel.ts): übersetzt die rohen
// Protokollzeilen (Methode + Pfad + Status) in lesbare Sätze, ordnet sie
// Kategorien zu und baut die Server-Filter. GENERIERT aus der Routentabelle
// der API — neue Routen ohne Eintrag erscheinen als "Änderung: <Pfad>".
import type { I18nKey } from "./i18n.ts";

export interface AuditRow {
  id: number;
  occurredAt: string;
  username: string;
  method: string;
  path: string;
  nodeId?: string;
  status: number;
}

export type CategoryId = "login" | "users" | "rights" | "workflows" | "instances" | "graph" | "layout" | "operate" | "processes" | "media" | "system";

export interface Category {
  id: CategoryId;
  icon: string;
  // SQL-LIKE-Muster für Pfade dieser Kategorie.
  likes: string[];
}

export const CATEGORIES: Category[] = [
  { id: "login", icon: "🔑", likes: ["/api/v1/auth/login"] },
  { id: "users", icon: "👤", likes: ["/api/v1/auth/users%", "/api/v1/organizations%"] },
  { id: "rights", icon: "🛡", likes: ["/api/v1/admin/role-bindings%", "/api/v1/groups%"] },
  { id: "workflows", icon: "🗂", likes: ["/api/v1/workflows%", "/api/v1/placement/%"] },
  { id: "instances", icon: "▣", likes: ["/api/v1/instances%", "/api/v1/admin/hosts%", "/api/v1/hosts/%", "/api/v1/cluster/%", "/api/v1/catalog%"] },
  { id: "graph", icon: "🔗", likes: ["/api/v1/graph/%", "/api/v1/snapshots%", "/api/v1/sources/%", "/api/v1/sinks/%", "/api/v1/nodes/%/layouts%", "/api/v1/nodes/%/invites"] },
  { id: "layout", icon: "🖼", likes: ["/api/v1/layouts/%"] },
  { id: "operate", icon: "🎛", likes: ["/api/v1/nodes/%/methods/%", "/api/v1/nodes/%/params/%", "/api/v1/nodes/%/state", "/api/v1/nodes/%/plugins/%"] },
  { id: "processes", icon: "⚙", likes: ["/api/v1/process-%", "/api/v1/human-tasks%"] },
  { id: "media", icon: "🎞", likes: ["/api/v1/playout/%", "/api/v1/assets%", "/api/v1/storage-backends%", "/api/v1/admin/storage-locations%"] },
  { id: "system", icon: "🔧", likes: ["/api/v1/admin/backup%", "/api/v1/admin/restore", "/api/v1/admin/updates%", "/api/v1/admin/settings%", "/api/v1/admin/node-versions%", "/api/v1/alarms%"] },
] as Category[];

// Standardansicht: ohne Bedienung (tausende Fader-/Schnitt-Zeilen) und ohne
// das automatische Speichern des Ansichts-Layouts.
export const DEFAULT_CATEGORIES: CategoryId[] = CATEGORIES.map((c) => c.id).filter((id) => id !== "operate" && id !== "layout");

// [Methode, Pfad-Regex, Kategorie, i18n-Schlüssel, Zielarten je Capture-Gruppe]
// Zielarten: n Node, w Workflow, p Prozess, i Instanz, g Gruppe, s Text, x ID (gekürzt), m Node-Methode
type Route = [string, RegExp, CategoryId, string, string];
const ROUTES: Route[] = [
  ["POST", /^\/api\/v1\/auth\/login$/, "login", "aud.a.login", ""],
  ["POST", /^\/api\/v1\/auth\/users$/, "users", "aud.a.userCreate", ""],
  ["DELETE", /^\/api\/v1\/auth\/users\/([^\/]+)$/, "users", "aud.a.userDelete", "s"],
  ["PUT", /^\/api\/v1\/auth\/users\/([^\/]+)\/password$/, "users", "aud.a.userPw", "s"],
  ["PUT", /^\/api\/v1\/auth\/users\/([^\/]+)\/org$/, "users", "aud.a.userOrg", "s"],
  ["POST", /^\/api\/v1\/auth\/users\/([^\/]+)\/revoke-sessions$/, "users", "aud.a.userRevoke", "s"],
  ["POST", /^\/api\/v1\/organizations$/, "users", "aud.a.orgCreate", ""],
  ["DELETE", /^\/api\/v1\/organizations\/([^\/]+)$/, "users", "aud.a.orgDelete", "x"],
  ["POST", /^\/api\/v1\/admin\/role-bindings$/, "rights", "aud.a.bindCreate", ""],
  ["DELETE", /^\/api\/v1\/admin\/role-bindings\/([^\/]+)$/, "rights", "aud.a.bindDelete", "x"],
  ["POST", /^\/api\/v1\/groups$/, "rights", "aud.a.groupCreate", ""],
  ["PUT", /^\/api\/v1\/groups\/([^\/]+)$/, "rights", "aud.a.groupUpdate", "g"],
  ["DELETE", /^\/api\/v1\/groups\/([^\/]+)$/, "rights", "aud.a.groupDelete", "g"],
  ["POST", /^\/api\/v1\/groups\/([^\/]+)\/members$/, "rights", "aud.a.groupAdd", "g"],
  ["DELETE", /^\/api\/v1\/groups\/([^\/]+)\/members\/([^\/]+)$/, "rights", "aud.a.groupRemove", "gs"],
  ["POST", /^\/api\/v1\/workflows$/, "workflows", "aud.a.wfCreate", ""],
  ["POST", /^\/api\/v1\/workflows\/import$/, "workflows", "aud.a.wfImport", ""],
  ["PUT", /^\/api\/v1\/workflows\/([^\/]+)$/, "workflows", "aud.a.wfSave", "w"],
  ["DELETE", /^\/api\/v1\/workflows\/([^\/]+)$/, "workflows", "aud.a.wfDelete", "w"],
  ["POST", /^\/api\/v1\/workflows\/([^\/]+)\/start$/, "workflows", "aud.a.wfStart", "w"],
  ["POST", /^\/api\/v1\/workflows\/([^\/]+)\/stop$/, "workflows", "aud.a.wfStop", "w"],
  ["POST", /^\/api\/v1\/workflows\/([^\/]+)\/pause$/, "workflows", "aud.a.wfPause", "w"],
  ["POST", /^\/api\/v1\/workflows\/([^\/]+)\/roles\/([^\/]+)\/restart$/, "workflows", "aud.a.wfRoleRestart", "ws"],
  ["POST", /^\/api\/v1\/workflows\/([^\/]+)\/roles\/([^\/]+)\/migrate$/, "workflows", "aud.a.wfRoleMigrate", "ws"],
  ["POST", /^\/api\/v1\/placement\/migrations\/([^\/]+)\/([^\/]+)\/confirm$/, "workflows", "aud.a.migConfirm", "ws"],
  ["POST", /^\/api\/v1\/placement\/migrations\/([^\/]+)\/([^\/]+)\/cancel$/, "workflows", "aud.a.migCancel", "ws"],
  ["POST", /^\/api\/v1\/instances$/, "instances", "aud.a.instStart", ""],
  ["DELETE", /^\/api\/v1\/instances\/([^\/]+)$/, "instances", "aud.a.instStop", "i"],
  ["PATCH", /^\/api\/v1\/instances\/([^\/]+)$/, "instances", "aud.a.instEdit", "i"],
  ["POST", /^\/api\/v1\/instances\/([^\/]+)\/restart$/, "instances", "aud.a.instRestart", "i"],
  ["POST", /^\/api\/v1\/instances\/([^\/]+)\/migrate$/, "instances", "aud.a.instMigrate", "i"],
  ["POST", /^\/api\/v1\/instances\/([^\/]+)\/service-token$/, "instances", "aud.a.instToken", "i"],
  ["DELETE", /^\/api\/v1\/admin\/hosts\/([^\/]+)$/, "instances", "aud.a.hostDelete", "x"],
  ["POST", /^\/api\/v1\/admin\/hosts\/([^\/]+)\/maintenance$/, "instances", "aud.a.hostMaint", "x"],
  ["DELETE", /^\/api\/v1\/admin\/hosts\/([^\/]+)\/maintenance$/, "instances", "aud.a.hostMaintEnd", "x"],
  ["POST", /^\/api\/v1\/admin\/hosts\/bootstrap-tokens$/, "instances", "aud.a.hostToken", ""],
  ["POST", /^\/api\/v1\/hosts\/register$/, "instances", "aud.a.hostRegister", ""],
  ["POST", /^\/api\/v1\/cluster\/join$/, "instances", "aud.a.clusterJoin", ""],
  ["DELETE", /^\/api\/v1\/cluster\/members\/([^\/]+)$/, "instances", "aud.a.clusterLeave", "x"],
  ["POST", /^\/api\/v1\/catalog$/, "instances", "aud.a.catImport", ""],
  ["DELETE", /^\/api\/v1\/catalog\/([^\/]+)$/, "instances", "aud.a.catDelete", "s"],
  ["POST", /^\/api\/v1\/graph\/edges$/, "graph", "aud.a.edgeCreate", ""],
  ["DELETE", /^\/api\/v1\/graph\/edges\/([^\/]+)$/, "graph", "aud.a.edgeDelete", ""],
  ["PUT", /^\/api\/v1\/layouts\/([^\/]+)$/, "layout", "aud.a.layoutSave", "s"],
  ["POST", /^\/api\/v1\/snapshots$/, "graph", "aud.a.snapSave", ""],
  ["POST", /^\/api\/v1\/snapshots\/([^\/]+)\/apply$/, "graph", "aud.a.snapApply", ""],
  ["PUT", /^\/api\/v1\/sources\/([^\/]+)\/tags$/, "graph", "aud.a.srcTags", ""],
  ["PUT", /^\/api\/v1\/sinks\/([^\/]+)\/tags$/, "graph", "aud.a.sinkTags", ""],
  ["POST", /^\/api\/v1\/nodes\/([^\/]+)\/layouts$/, "graph", "aud.a.nodeLayoutSave", "n"],
  ["POST", /^\/api\/v1\/nodes\/([^\/]+)\/layouts\/([^\/]+)\/apply$/, "graph", "aud.a.nodeLayoutApply", "ns"],
  ["DELETE", /^\/api\/v1\/nodes\/([^\/]+)\/layouts\/([^\/]+)$/, "graph", "aud.a.nodeLayoutDelete", "ns"],
  ["POST", /^\/api\/v1\/nodes\/([^\/]+)\/invites$/, "graph", "aud.a.inviteCreate", "n"],
  ["DELETE", /^\/api\/v1\/nodes\/([^\/]+)\/invites$/, "graph", "aud.a.inviteDelete", "n"],
  ["PATCH", /^\/api\/v1\/nodes\/([^\/]+)\/params\/([^\/]+)$/, "operate", "aud.a.nodeParam", "ns"],
  ["POST", /^\/api\/v1\/nodes\/([^\/]+)\/state$/, "operate", "aud.a.nodeState", "n"],
  ["PATCH", /^\/api\/v1\/nodes\/([^\/]+)\/plugins\/([^\/]+)$/, "operate", "aud.a.nodePlugin", "ns"],
  ["POST", /^\/api\/v1\/nodes\/([^\/]+)\/methods\/([^\/]+)$/, "operate", "aud.a.nodeMethod", "nm"],
  ["POST", /^\/api\/v1\/process-definitions$/, "processes", "aud.a.procCreate", ""],
  ["PUT", /^\/api\/v1\/process-definitions\/([^\/]+)$/, "processes", "aud.a.procSave", "p"],
  ["DELETE", /^\/api\/v1\/process-definitions\/([^\/]+)$/, "processes", "aud.a.procDelete", "p"],
  ["POST", /^\/api\/v1\/process-definitions\/([^\/]+)\/versions$/, "processes", "aud.a.procVersion", "p"],
  ["POST", /^\/api\/v1\/process-versions\/([^\/]+)\/publish$/, "processes", "aud.a.procPublish", ""],
  ["POST", /^\/api\/v1\/process-versions\/([^\/]+)\/deprecate$/, "processes", "aud.a.procDeprecate", ""],
  ["POST", /^\/api\/v1\/process-versions\/([^\/]+)\/archive$/, "processes", "aud.a.procArchive", ""],
  ["POST", /^\/api\/v1\/process-executions$/, "processes", "aud.a.procStart", ""],
  ["POST", /^\/api\/v1\/process-executions\/([^\/]+)\/cancel$/, "processes", "aud.a.procCancel", ""],
  ["POST", /^\/api\/v1\/process-executions\/([^\/]+)\/pause$/, "processes", "aud.a.procPause", ""],
  ["POST", /^\/api\/v1\/process-executions\/([^\/]+)\/resume$/, "processes", "aud.a.procResume", ""],
  ["POST", /^\/api\/v1\/human-tasks\/([^\/]+)\/assign$/, "processes", "aud.a.taskAssign", ""],
  ["POST", /^\/api\/v1\/human-tasks\/([^\/]+)\/complete$/, "processes", "aud.a.taskDone", ""],
  ["POST", /^\/api\/v1\/playout\/channels$/, "media", "aud.a.chCreate", ""],
  ["DELETE", /^\/api\/v1\/playout\/channels\/([^\/]+)$/, "media", "aud.a.chDelete", ""],
  ["POST", /^\/api\/v1\/assets$/, "media", "aud.a.assetCreate", ""],
  ["PUT", /^\/api\/v1\/assets\/([^\/]+)\/metadata$/, "media", "aud.a.assetMeta", ""],
  ["POST", /^\/api\/v1\/assets\/([^\/]+)\/status$/, "media", "aud.a.assetStatus", ""],
  ["POST", /^\/api\/v1\/storage-backends$/, "media", "aud.a.storeCreate", ""],
  ["PUT", /^\/api\/v1\/storage-backends\/([^\/]+)$/, "media", "aud.a.storeEdit", ""],
  ["DELETE", /^\/api\/v1\/storage-backends\/([^\/]+)$/, "media", "aud.a.storeDelete", ""],
  ["POST", /^\/api\/v1\/admin\/storage-locations$/, "media", "aud.a.locCreate", ""],
  ["PUT", /^\/api\/v1\/admin\/storage-locations\/([^\/]+)$/, "media", "aud.a.locEdit", ""],
  ["DELETE", /^\/api\/v1\/admin\/storage-locations\/([^\/]+)$/, "media", "aud.a.locDelete", ""],
  ["POST", /^\/api\/v1\/admin\/backup$/, "system", "aud.a.backup", ""],
  ["POST", /^\/api\/v1\/admin\/restore$/, "system", "aud.a.restore", ""],
  ["POST", /^\/api\/v1\/admin\/updates\/upload$/, "system", "aud.a.updUpload", ""],
  ["POST", /^\/api\/v1\/admin\/updates\/([^\/]+)\/apply$/, "system", "aud.a.updApply", ""],
  ["POST", /^\/api\/v1\/admin\/updates\/([^\/]+)\/distribute$/, "system", "aud.a.updDist", ""],
  ["POST", /^\/api\/v1\/admin\/updates\/restart-outdated$/, "system", "aud.a.updRestart", ""],
  ["DELETE", /^\/api\/v1\/admin\/updates\/([^\/]+)$/, "system", "aud.a.updDelete", ""],
  ["PUT", /^\/api\/v1\/admin\/settings\/system\/([^\/]+)$/, "system", "aud.a.setSys", "s"],
  ["PUT", /^\/api\/v1\/admin\/settings\/nodes\/([^\/]+)\/([^\/]+)$/, "system", "aud.a.setNode", "ss"],
  ["POST", /^\/api\/v1\/admin\/node-versions\/([^\/]+)\/rollout$/, "system", "aud.a.verRollout", "s"],
  ["PUT", /^\/api\/v1\/admin\/node-versions\/([^\/]+)\/productive$/, "system", "aud.a.verProd", "s"],
  ["PUT", /^\/api\/v1\/alarms\/acks$/, "system", "aud.a.alarmAck", ""],
  ["DELETE", /^\/api\/v1\/alarms\/acks$/, "system", "aud.a.alarmUnack", ""],
];

export const NODE_METHOD_KEYS = {"aud.m.crosspoint.take": 1, "aud.m.crosspoint.cut": 1, "aud.m.crosspoint.autoTrans": 1, "aud.m.crosspoint.select": 1, "aud.m.crosspoint.setTransitionPosition": 1, "aud.m.crosspoint.setTransType": 1, "aud.m.crosspoint.setTransRate": 1, "aud.m.crosspoint.pin": 1, "aud.m.take": 1, "aud.m.select": 1, "aud.m.selectSource": 1, "aud.m.load": 1, "aud.m.cue": 1, "aud.m.play": 1, "aud.m.playAt": 1, "aud.m.stop": 1, "aud.m.seek": 1, "aud.m.append": 1, "aud.m.updateItem": 1, "aud.m.show": 1, "aud.m.hide": 1, "aud.m.addChannel": 1, "aud.m.addAux": 1, "aud.m.record.start": 1, "aud.m.record.stop": 1, "aud.m.keyer.setEnabled": 1, "aud.m.pip.setEnabled": 1, "aud.m.pip.applyPreset": 1, "aud.m.setRouting": 1, "aud.m.setVideoContext": 1, "aud.m.setSourceContext": 1, "aud.m.clearSourceContext": 1, "aud.m.setChildren": 1, "aud.m.setOffered": 1, "aud.m.setTransition": 1};
export const CHANNEL_WHAT_KEYS = {"aud.cw.setGain": 1, "aud.cw.setPan": 1, "aud.cw.setMute": 1, "aud.cw.setEqGain": 1, "aud.cw.setEqBand": 1, "aud.cw.setSource": 1, "aud.cw.setFollow": 1, "aud.cw.setPfl": 1, "aud.cw.setSend": 1};

export interface Resolvers {
  node(id: string): string | undefined;
  workflow(id: string): string | undefined;
  process(id: string): string | undefined;
  instance(id: string): string | undefined;
  group(id: string): string | undefined;
}

export interface Described {
  category: CategoryId | "other";
  key: I18nKey | "";
  params: Record<string, string>;
  raw: string;
}

const short = (id: string) => (id.length > 12 ? id.slice(0, 8) + "…" : id);

export function categoryOfPath(path: string): CategoryId | "other" {
  for (const c of CATEGORIES) {
    for (const like of c.likes) {
      const re = new RegExp("^" + like.split("%").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
      if (re.test(path)) return c.id;
    }
  }
  return "other";
}

export function describe(
  e: Pick<AuditRow, "method" | "path" | "nodeId">,
  r: Resolvers,
  tr: (key: string) => string | undefined,
): Described {
  for (const [method, re, cat, key, kinds] of ROUTES) {
    if (method !== e.method) continue;
    const m = re.exec(e.path);
    if (!m) continue;
    const params: Record<string, string> = {};
    for (let i = 0; i < kinds.length; i++) {
      const v = decodeURIComponent(m[i + 1] ?? "");
      const kind = kinds[i];
      let out: string | undefined;
      if (kind === "n") out = r.node(v) ?? (e.nodeId ? r.instance(e.nodeId) : undefined);
      else if (kind === "w") out = r.workflow(v);
      else if (kind === "p") out = r.process(v);
      else if (kind === "i") out = r.instance(v) ?? r.node(v);
      else if (kind === "g") out = r.group(v);
      else if (kind === "s") out = v;
      else if (kind === "m") {
        const ch = /^channel\.([^.]+)\.(\w+)$/.exec(v);
        const direct = tr("aud.m." + v);
        if (direct) out = direct;
        else if (ch) {
          const what = tr("aud.cw." + ch[2]) ?? ch[2];
          out = ch[1] + ": " + what;
        } else out = v;
      }
      params["p" + i] = out ?? short(v);
    }
    return { category: cat, key: key as I18nKey, params, raw: `${e.method} ${e.path}` };
  }
  return { category: categoryOfPath(e.path), key: "", params: {}, raw: `${e.method} ${e.path}` };
}

// Ergebnis in Worten: [Text-Schlüssel, ok?].
export function outcome(status: number): { key: string; ok: boolean } {
  if (status < 400) return { key: "aud.res.ok", ok: true };
  const known = [400, 401, 403, 404, 409, 422, 429];
  return { key: known.includes(status) ? `aud.res.${status}` : status >= 500 ? "aud.res.5xx" : "aud.res.other", ok: false };
}

export type RangeId = "1h" | "24h" | "7d" | "30d" | "all";
export function rangeSince(range: RangeId, now = new Date()): string | undefined {
  const h = { "1h": 1, "24h": 24, "7d": 168, "30d": 720, all: 0 }[range];
  return h ? new Date(now.getTime() - h * 3600_000).toISOString() : undefined;
}

// Query-String für GET /api/v1/admin/audit-log.
export function buildQuery(o: {
  limit: number;
  before?: number;
  user?: string;
  result?: "ok" | "failed" | "";
  range: RangeId;
  categories: Set<CategoryId>;
  terms: string[];
}): string {
  const p = new URLSearchParams();
  p.set("limit", String(o.limit));
  if (o.before) p.set("before", String(o.before));
  if (o.user) p.set("user", o.user);
  if (o.result) p.set("result", o.result);
  const since = rangeSince(o.range);
  if (since) p.set("since", since);
  const terms = o.terms.filter(Boolean);
  if (terms.length) p.set("terms", terms.join("\x1f"));
  const exclude = CATEGORIES.filter((c) => !o.categories.has(c.id)).flatMap((c) => c.likes);
  if (exclude.length) p.set("exclude", exclude.join("\x1f"));
  return p.toString();
}

// Suchbegriffe: der getippte Text plus die IDs aller Nodes/Workflows/
// Prozesse/Gruppen, deren NAME ihn enthält (Pfade enthalten nur IDs).
export function searchTerms(
  text: string,
  named: { id: string; name: string }[],
): string[] {
  const q = text.trim();
  if (!q) return [];
  const low = q.toLowerCase();
  const ids = named.filter((n) => n.name.toLowerCase().includes(low)).map((n) => n.id);
  return [q, ...ids.slice(0, 50)];
}
