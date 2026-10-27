import { assertEquals } from "jsr:@std/assert";
import { bins, categoryOf, changesBefore, describeItem, problemsAt, timelineUrl, type TLItem, worstLevel } from "./timeline-logic.ts";
import { setLang, t } from "./i18n.ts";

setLang("de", false);

const T0 = Date.parse("2026-10-27T14:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
let n = 0;
function ev(kind: string, minute: number, o: Partial<TLItem> = {}): TLItem {
  return { id: `e${++n}`, at: at(minute), source: "event", kind, severity: "info", ...o };
}
const res = { node: () => undefined, workflow: (id: string) => (id === "w1" ? "Sendung" : undefined), process: () => undefined, instance: () => undefined, group: () => undefined };
const tr = (k: string) => (t(k as never) === k ? undefined : t(k as never));
const au = (k: string, p: Record<string, string>) => t(k as never, p);

Deno.test("categoryOf ordnet Störungen, Marker, Änderungen, Betrieb und Logs", () => {
  assertEquals(categoryOf(ev("instance.crashed", 0, { severity: "error" })), "fault");
  assertEquals(categoryOf(ev("host.silent", 0, { severity: "error" })), "fault");
  assertEquals(categoryOf(ev("marker", 0)), "marker");
  assertEquals(categoryOf(ev("instance.restarted", 0, { severity: "warn" })), "ops");
  assertEquals(categoryOf(ev("host.clock.lost", 0, { severity: "warn" })), "ops");
  assertEquals(categoryOf(ev("workflow.status", 0)), "change");
  assertEquals(categoryOf({ ...ev("audit", 0), source: "audit" }), "change");
  assertEquals(categoryOf({ ...ev("log", 0, { severity: "error" }), source: "log" }), "log");
  assertEquals(categoryOf(ev("unbekannt", 0, { severity: "error" })), "fault");
});

Deno.test("describeItem: Klartext für Betriebsereignisse, Audit-Sätze und Marker", () => {
  const crashed = describeItem(ev("instance.crashed", 0, { subject: "i1", data: { label: "Kamera 1", message: "x\nsignal: killed" } }), res, tr, au);
  assertEquals(crashed.key, "tl.k.instance.crashed");
  assertEquals(crashed.params?.label, "Kamera 1");
  assertEquals(crashed.params?.message, "signal: killed");
  const wf = describeItem(ev("workflow.failover", 0, { data: { workflowId: "w1", trigger: "crash-loop" } }), res, tr, au);
  assertEquals(wf.params?.workflow, "Sendung");
  assertEquals(describeItem(ev("marker", 0, { actor: "anna", data: { note: "" } }), res, tr, au).key, "tl.k.marker");
  assertEquals(describeItem(ev("marker", 0, { actor: "anna", data: { note: "Ton weg" } }), res, tr, au).key, "tl.k.marker.note");
  assertEquals(describeItem(ev("neu.unbekannt", 0), res, tr, au).key, "tl.k.other");
  const a = describeItem({ ...ev("audit", 0), source: "audit", actor: "anna", data: { method: "POST", path: "/api/v1/instances", status: 200 } }, res, tr, au);
  assertEquals(typeof a.text, "string");
  assertEquals((a.text ?? "").length > 0, true);
  const l = describeItem({ ...ev("log", 0), source: "log", data: { message: "boom" } }, res, tr, au);
  assertEquals(l.text, "boom");
});

Deno.test("bins verdichtet Zeilen, schlimmste Stufe je Abschnitt, außerhalb zählt nicht", () => {
  const items = [ev("a", 1), ev("b", 1, { severity: "warn" }), ev("c", 1, { severity: "error" }), ev("d", 9), ev("x", -5), ev("y", 11)];
  const b = bins(items, T0, T0 + 10 * 60_000, 10);
  assertEquals(b.length, 10);
  assertEquals([b[1].error, b[1].warn, b[1].info], [1, 1, 1]);
  assertEquals(worstLevel(b[1]), "error");
  assertEquals(worstLevel(b[9]), "info");
  assertEquals(worstLevel(b[5]), null);
  assertEquals(b.reduce((s, x) => s + x.error + x.warn + x.info, 0), 4);
});

Deno.test("problemsAt: Zustand zu einem Zeitpunkt aus den Wechseln nachgespielt", () => {
  const items = [
    ev("instance.crashed", 1, { subject: "i1", severity: "error", data: { label: "Q1" } }),
    ev("host.silent", 2, { subject: "h1", severity: "error" }),
    ev("host.clock.lost", 3, { subject: "h2", severity: "warn" }),
    ev("instance.restarted", 5, { subject: "i1" }),
    ev("host.resumed", 6, { subject: "h1" }),
    ev("node.notready", 7, { subject: "n1", severity: "error" }),
    { ...ev("audit", 4), source: "audit" as const },
  ];
  const keys = (m: number) => problemsAt(items, T0 + m * 60_000).map((p) => p.key);
  assertEquals(keys(0), []);
  assertEquals(keys(2.5), ["instance:i1", "host:h1"]);
  assertEquals(keys(4), ["instance:i1", "host:h1", "clock:h2"]);
  assertEquals(keys(5.5), ["host:h1", "clock:h2"]);
  assertEquals(keys(8), ["clock:h2", "media:n1"]);
  // Orchestrator-Neustart verwirft Medien/Host/Uhr, nicht abgestürzte Instanzen
  const withRestart = [...items, ev("orchestrator.started", 9)];
  assertEquals(problemsAt(withRestart, T0 + 10 * 60_000).map((p) => p.key), []);
  // Workflow-Fehler bleibt bis zum nächsten Zustand
  const wf = [ev("workflow.status", 1, { subject: "w1", severity: "error" }), ev("workflow.status", 4, { subject: "w1" })];
  assertEquals(problemsAt(wf, T0 + 2 * 60_000).map((p) => p.key), ["wf:w1"]);
  assertEquals(problemsAt(wf, T0 + 5 * 60_000), []);
});

Deno.test("changesBefore: Fenster davor, neueste zuerst", () => {
  const items = [ev("a", 1), ev("b", 4), ev("c", 6), ev("d", 10)];
  assertEquals(changesBefore(items, T0 + 6 * 60_000, 5 * 60_000).map((i) => i.kind), ["c", "b"]);
});

Deno.test("timelineUrl", () => {
  const u = timelineUrl(T0, T0 + 3_600_000, true);
  assertEquals(u.startsWith("/api/v1/timeline?since=2026-10-27T14%3A00%3A00.000Z"), true);
  assertEquals(u.includes("operate=1"), true);
  assertEquals(timelineUrl(T0, T0 + 1000, false).includes("operate"), false);
});
