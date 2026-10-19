import { assertEquals } from "jsr:@std/assert@1";
import type { Timeline } from "./timecode.ts";
import {
  addSegment, clampFrame, filterFindings, type Finding, keyAction, measuredRows, moveSegment, NO_FILTER, nextBoundary, removeSegment, type Segment, shuttleFrame,
  shuttleStep, stateBadge, toServerSegments, updateSegment, validateSegments,
} from "./review-logic.ts";

const tl: Timeline = { rate: { num: 25, den: 1 }, durationFrames: 200, startFrames: 0, dropFrame: false };
const pol = { allowOverlap: true, allowGaps: true, minSegmentFrames: 1 };
const seg = (id: string, i: number, o: number): Segment => ({ id, label: id, in: i, out: o });

Deno.test("Segmente: Hinzufügen, Löschen, Umsortieren, Umbenennen; temporäre IDs gehen leer zum Server", () => {
  let s: Segment[] = [];
  s = addSegment(s, 0, 50);
  s = addSegment(s, 50, 200);
  assertEquals(s.length, 2);
  const [a, b] = s;
  s = moveSegment(s, b.id, -1);
  assertEquals(s.map((x) => x.id), [b.id, a.id]);
  assertEquals(moveSegment(s, b.id, -1), s); // Rand: keine Änderung
  s = updateSegment(s, a.id, { label: "Teaser" });
  assertEquals(s.find((x) => x.id === a.id)?.label, "Teaser");
  assertEquals(toServerSegments(s).every((x) => x.id === ""), true);
  assertEquals(toServerSegments([seg("abc", 0, 5)])[0].id, "abc");
  assertEquals(removeSegment(s, a.id).length, 1);
});

Deno.test("Segment-Validierung: Out exklusiv, Überlappung/Lücken nach Richtlinie, nutzbarer Bereich", () => {
  assertEquals(validateSegments([seg("a", 0, 200)], tl, pol), []); // ganze Datei
  assertEquals(validateSegments([seg("a", 0, 201)], tl, pol)[0].key, "range.after");
  assertEquals(validateSegments([seg("a", 10, 10)], tl, pol)[0].key, "range.short");
  const strict = { allowOverlap: false, allowGaps: false, minSegmentFrames: 5 };
  assertEquals(validateSegments([seg("a", 0, 60), seg("b", 50, 100)], tl, strict).map((p) => p.key), ["overlap"]);
  assertEquals(validateSegments([seg("a", 0, 50), seg("b", 60, 100)], tl, strict).map((p) => p.key), ["gap"]);
  assertEquals(validateSegments([seg("a", 0, 50), seg("b", 50, 100)], tl, strict), []); // lückenlos & ohne Überlappung
  assertEquals(validateSegments([seg("a", 0, 50)], tl, pol, { in: 10, out: 40 })[0].key, "outside");
  assertEquals(validateSegments([], undefined, pol)[0].key, "notimeline");
});

Deno.test("Segmentgrenzen: nächste/vorige Grenze", () => {
  const s = [seg("a", 10, 50), seg("b", 50, 120)];
  assertEquals(nextBoundary(s, 0, 1), 10);
  assertEquals(nextBoundary(s, 10, 1), 50);
  assertEquals(nextBoundary(s, 50, 1), 120);
  assertEquals(nextBoundary(s, 120, 1), null);
  assertEquals(nextBoundary(s, 50, -1), 10);
  assertEquals(nextBoundary(s, 10, -1), null);
});

Deno.test("Shuttle: J/K/L wie am Schnittplatz, Gegenrichtung bremst zuerst", () => {
  let v = 0;
  v = shuttleStep(v, "L");
  assertEquals(v, 1);
  v = shuttleStep(v, "L");
  assertEquals(v, 2);
  v = shuttleStep(v, "L");
  v = shuttleStep(v, "L");
  assertEquals(v, 8);
  assertEquals(shuttleStep(v, "L"), 8); // Obergrenze
  assertEquals(shuttleStep(8, "J"), 4); // bremst
  assertEquals(shuttleStep(1, "J"), 0.5);
  assertEquals(shuttleStep(0.5, "J"), 0);
  assertEquals(shuttleStep(0, "J"), -1);
  assertEquals(shuttleStep(-8, "J"), -8);
  assertEquals(shuttleStep(-1, "L"), -0.5);
  assertEquals(shuttleStep(-0.5, "L"), 0);
  assertEquals(shuttleFrame(100, -1, 1000, 25), 75);
  assertEquals(shuttleFrame(100, 2, 500, 25), 125);
});

Deno.test("Tastaturbelegung: Schritte, Marken, Sprünge; Cmd/Strg-Kombinationen des Browsers bleiben unberührt", () => {
  assertEquals(keyAction({ key: "ArrowLeft" }, 25), { kind: "step", frames: -1 });
  assertEquals(keyAction({ key: "ArrowRight", shiftKey: true }, 25), { kind: "step", frames: 10 });
  assertEquals(keyAction({ key: "ArrowRight", ctrlKey: true }, 25), { kind: "step", frames: 25 });
  assertEquals(keyAction({ key: "ArrowRight", ctrlKey: true }, 30000 / 1001), { kind: "step", frames: 30 });
  assertEquals(keyAction({ key: "i" }, 25), { kind: "markIn" });
  assertEquals(keyAction({ key: "o", altKey: true }, 25), { kind: "gotoOut" });
  assertEquals(keyAction({ key: "l" }, 25), { kind: "shuttle", key: "L" });
  assertEquals(keyAction({ key: "l", ctrlKey: true }, 25), null);
  assertEquals(keyAction({ key: "r", metaKey: true }, 25), null);
  assertEquals(keyAction({ key: "x" }, 25), null);
  assertEquals(keyAction({ key: "]" }, 25), { kind: "boundary", dir: 1 });
});

Deno.test("clampFrame: Grenzen [0, Dauer-1]", () => {
  assertEquals(clampFrame(-5, tl), 0);
  assertEquals(clampFrame(999, tl), 199);
  assertEquals(clampFrame(10.4, tl), 10);
});

Deno.test("Befund-Filter: Kategorie, Status, Text, nur Probleme; schlechteste zuerst", () => {
  const f = (checkId: string, category: string, status: string, startFrame?: number): Finding => ({
    checkId, category, status, severity: "info", message: checkId + " text", tool: "t", toolVersion: "1", analyzedAt: "", ruleset: "r", startFrame,
  });
  const all = [f("a", "video", "pass"), f("b", "audio", "fail", 30), f("c", "audio", "warning", 10), f("d", "audio", "fail", 5)];
  assertEquals(filterFindings(all, NO_FILTER).map((x) => x.checkId), ["d", "b", "c", "a"]);
  assertEquals(filterFindings(all, { ...NO_FILTER, category: "audio", onlyIssues: true }).map((x) => x.checkId), ["d", "b", "c"]);
  assertEquals(filterFindings(all, { ...NO_FILTER, q: "A TEXT" }).map((x) => x.checkId), ["a"]);
  assertEquals(filterFindings(all, { ...NO_FILTER, status: "warning" }).map((x) => x.checkId), ["c"]);
});

Deno.test("Messwerte gegen Grenzwerte; Zustandsfarben", () => {
  const rows = measuredRows({ checkId: "x", category: "audio", status: "fail", severity: "major", message: "", tool: "", toolVersion: "", analyzedAt: "", ruleset: "", measured: { integratedLufs: -19.2, incomplete: true }, threshold: { targetLufs: -23 } });
  assertEquals(rows.map((r) => r.key).sort(), ["integratedLufs", "targetLufs"]);
  assertEquals(rows.find((r) => r.key === "targetLufs")?.measured, "—");
  assertEquals(stateBadge("qc_failed_to_run").includes("error"), true);
  assertEquals(stateBadge("awaiting_review").includes("cue"), true);
});

import { idFrom, joinList, moveItem, splitList, validateReviewConfig } from "./settings-logic.ts";

Deno.test("Eingangs-Einstellungen: Listen, IDs, Reihenfolge", () => {
  assertEquals(splitList("a, b\n c ,,"), ["a", "b", "c"]);
  assertEquals(joinList(["x", "y"]), "x, y");
  assertEquals(idFrom("Schlagworte Über", ["schlagworte-uber"]), "schlagworte-uber-2");
  assertEquals(moveItem([1, 2, 3], 0, 1), [2, 1, 3]);
  assertEquals(moveItem([1, 2, 3], 0, -1), [1, 2, 3]);
});

Deno.test("Eingangs-Einstellungen: Prüfung", () => {
  const ok = { approvalMode: "single", defaultQcProfile: "a", qcProfiles: { a: { id: "a", expect: { frameRate: "25/1" } } }, metadataFields: [{ id: "t", type: "text" }] };
  assertEquals(validateReviewConfig(ok), []);
  const bad = { approvalMode: "x", defaultQcProfile: "z", qcProfiles: { a: { id: "a", name: "A", expect: { frameRate: "abc" } } }, metadataFields: [{ id: "t", type: "select", values: [] }, { id: "t", type: "text" }] };
  assertEquals(validateReviewConfig(bad).map((x) => x.key), ["rv.cfg.err.mode", "rv.cfg.err.default", "rv.cfg.err.rate", "rv.cfg.err.values", "rv.cfg.err.fieldid"]);
});

Deno.test("assignmentLabel / isOverdue / datetime-local", async () => {
  const { assignmentLabel, isOverdue, isoToLocalInput, localInputToIso } = await import("./review-logic.ts");
  assertEquals(assignmentLabel({ assignedTo: "anna", assignedGroup: "nacht" }, "Gruppe"), "anna · Gruppe nacht");
  assertEquals(assignmentLabel({}, "Gruppe"), "");
  assertEquals(isOverdue("2026-10-19T10:00:00Z", Date.parse("2026-10-19T11:00:00Z")), true);
  assertEquals(isOverdue(undefined, 0), false);
  assertEquals(localInputToIso(""), undefined);
  assertEquals(localInputToIso("kaputt"), undefined);
  const iso = localInputToIso("2026-10-19T13:30");
  assertEquals(isoToLocalInput(iso), "2026-10-19T13:30");
});

Deno.test("assignmentLabel zeigt Gruppennamen statt IDs", async () => {
  const { assignmentLabel } = await import("./review-logic.ts");
  assertEquals(assignmentLabel({ assignedGroup: "g1" }, "Gruppe", () => "Nachtschicht"), "Gruppe Nachtschicht");
});
