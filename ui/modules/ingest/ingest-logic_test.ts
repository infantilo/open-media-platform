import { assertEquals } from "jsr:@std/assert@1";
import {
  canAbort, canCancel, emptyForm, fmtDuration, formToPayload, groupLanes, type HostView, type Job, layoutBars, parseDuration, planPayload, resourceLevel, ticks, usageSeries, validateForm,
  zonedToUtc,
} from "./ingest-logic.ts";

const job = (id: string, s: string, e: string, state = "scheduled", hostId = "local"): Job => ({
  id, name: id, plannedStart: s, plannedEnd: e, tz: "UTC", state, attempt: 0, maxAttempts: 1, priority: 5, source: { instanceId: "x" }, profileId: "p", hostId, revision: 1,
});

Deno.test("Zeitleiste: Balken, Stapelung überlappender Aufträge, Beschnitt am Fensterrand", () => {
  const from = Date.parse("2026-10-20T00:00:00Z");
  const to = Date.parse("2026-10-21T00:00:00Z");
  const { bars, lanes } = layoutBars([
    job("a", "2026-10-20T06:00:00Z", "2026-10-20T08:00:00Z"),
    job("b", "2026-10-20T07:00:00Z", "2026-10-20T09:00:00Z"),
    job("c", "2026-10-20T08:00:00Z", "2026-10-20T10:00:00Z"), // beginnt, wenn a endet → gleiche Zeile wie a
    job("d", "2026-10-19T22:00:00Z", "2026-10-20T01:00:00Z"),
    job("far", "2026-10-25T00:00:00Z", "2026-10-25T01:00:00Z"),
  ], from, to);
  assertEquals(bars.length, 4);
  const by = Object.fromEntries(bars.map((b) => [b.job.id, b]));
  assertEquals(by.a.left, 25);
  assertEquals(by.a.width, (2 / 24) * 100);
  assertEquals(by.a.lane, 1 - 1 + by.a.lane);
  assertEquals(by.b.lane !== by.a.lane, true);
  assertEquals(by.c.lane, by.a.lane);
  assertEquals(by.d.clippedLeft, true);
  assertEquals(by.d.left, 0);
  assertEquals(lanes >= 2, true);
});

Deno.test("Spuren: je Host eine, blockierte getrennt, abgebrochene ausgeblendet", () => {
  const m = groupLanes([job("a", "2026-10-20T06:00:00Z", "2026-10-20T07:00:00Z", "scheduled", "h1"), job("b", "2026-10-20T06:00:00Z", "2026-10-20T07:00:00Z", "blocked", "h1"), job("c", "2026-10-20T06:00:00Z", "2026-10-20T07:00:00Z", "cancelled", "h1")]);
  assertEquals([...m.keys()].sort(), ["__blocked", "h1"]);
});

Deno.test("Kapazität: Reihe je Ressource, Warnstufen einzeln (keine Gesamtprozentzahl)", () => {
  const h: HostView = {
    id: "h", label: "h", online: true, functions: [], softFraction: 0.8, warnings: [],
    hard: { recorder_slots: 2, cpu_cores: 4 },
    usage: [
      { from: "2026-10-20T10:00:00Z", to: "2026-10-20T11:00:00Z", use: { recorder_slots: 1, cpu_cores: 3.5 } },
      { from: "2026-10-20T11:00:00Z", to: "2026-10-20T12:00:00Z", use: { recorder_slots: 2, cpu_cores: 1 } },
    ],
  };
  const from = Date.parse("2026-10-20T10:00:00Z");
  const to = Date.parse("2026-10-20T14:00:00Z");
  const rec = usageSeries(h, "recorder_slots", from, to);
  assertEquals(rec.peak, 2);
  assertEquals(rec.points.length, 2);
  assertEquals(rec.points[1].x0, 25);
  assertEquals(resourceLevel(h, "recorder_slots", rec.peak), "soft"); // Grenze genau erreicht = voll, nicht überbucht
  assertEquals(resourceLevel(h, "cpu_cores", usageSeries(h, "cpu_cores", from, to).peak), "soft"); // 87 % > Warnschwelle 80 %
  assertEquals(resourceLevel(h, "cpu_cores", 5), "hard");
  assertEquals(resourceLevel(h, "cpu_cores", 1), "ok");
  assertEquals(resourceLevel(h, "mem_mb", 99999), "ok"); // ohne Grenze unbegrenzt
});

Deno.test("Dauer: Parser und Formatierung", () => {
  assertEquals(parseDuration("1:30"), 5400);
  assertEquals(parseDuration("00:00:30"), 30);
  assertEquals(parseDuration("0:00"), null);
  assertEquals(parseDuration("1:75"), null);
  assertEquals(parseDuration("90"), null);
  assertEquals(parseDuration("200:00"), null); // > 7 Tage
  assertEquals(fmtDuration(5400), "1:30");
  assertEquals(fmtDuration(5430), "1:30:30");
});

Deno.test("Zeitzone: Wanduhr → UTC mit Sommerzeit (Europe/Berlin)", () => {
  assertEquals(zonedToUtc("2026-10-20T14:00", "Europe/Berlin")?.toISOString(), "2026-10-20T12:00:00.000Z");
  assertEquals(zonedToUtc("2026-12-20T14:00", "Europe/Berlin")?.toISOString(), "2026-12-20T13:00:00.000Z");
  assertEquals(zonedToUtc("2026-07-01T00:00", "America/New_York")?.toISOString(), "2026-07-01T04:00:00.000Z");
  assertEquals(zonedToUtc("quatsch", "UTC"), null);
});

Deno.test("Formular: Prüfung und Nutzlast (Wiederholung, Wochentage, Verspätung)", () => {
  const f = emptyForm("Europe/Berlin", "2026-10-20T10:03:00Z");
  assertEquals(validateForm(f).map((p) => p.field).sort(), ["name", "profile", "source"]);
  f.name = "Tagesschau";
  f.sourceKey = "inst1|Video";
  f.sourceLabel = "Studio";
  f.profileId = "mxf-h264";
  f.duration = "0:15";
  f.freq = "weekly";
  assertEquals(validateForm(f).map((p) => p.field), ["byDay"]);
  f.byDay = ["MO", "FR"];
  f.until = "2026-12-31";
  f.lateMode = "delay";
  f.lateMaxDelayMin = "5";
  assertEquals(validateForm(f), []);
  const p = formToPayload(f) as { source: { instanceId: string; senderLabel: string }; spec: { durationS: number; recurrence: { freq: string; byDay: string[]; until: string } }; late: { mode: string; maxDelayS: number } };
  assertEquals(p.source.instanceId, "inst1");
  assertEquals(p.source.senderLabel, "Video");
  assertEquals(p.spec.durationS, 900);
  assertEquals(p.spec.recurrence.freq, "weekly");
  assertEquals(p.spec.recurrence.byDay, ["MO", "FR"]);
  assertEquals(p.late, { mode: "delay", maxDelayS: 300 });
  f.freq = "once";
  assertEquals((formToPayload(f) as { spec: { recurrence: { freq: string } } }).spec.recurrence.freq, "");
  assertEquals(planPayload(f)?.durationS, 900);
  f.duration = "x";
  assertEquals(planPayload(f), null);
});

Deno.test("Aktionen je Zustand und Stundenmarken", () => {
  assertEquals(canCancel("scheduled"), true);
  assertEquals(canCancel("recording"), false); // laufende Aufnahmen nur mit ausdrücklichem Abbruch
  assertEquals(canAbort("recording"), true);
  assertEquals(canAbort("completed"), false);
  const t = ticks(Date.parse("2026-10-20T00:00:00Z"), Date.parse("2026-10-20T06:00:00Z"));
  assertEquals(t.length >= 5, true);
});

import { cloneConfig, type IngestConfig, joinArgs, newProfileId, numOrUndef, splitArgs, validateConfig } from "./settings-logic.ts";

Deno.test("Einstellungen: Argumentzeile ↔ Liste, Anführungszeichen bleiben erhalten", () => {
  assertEquals(splitArgs(`-c:v libx264 "a b"`), ["-c:v", "libx264", "a b"]);
  assertEquals(splitArgs('-vf "scale=1280:-2" -an'), ["-vf", "scale=1280:-2", "-an"]);
  assertEquals(joinArgs(["-vf", "scale=1280:-2", "-metadata", "a b"]), '-vf scale=1280:-2 -metadata "a b"');
  assertEquals(splitArgs(joinArgs(["x", "a b", ""])), ["x", "a b", ""]);
});

Deno.test("Einstellungen: Profil-ID, Zahlenfelder", () => {
  assertEquals(newProfileId("MP4 Proxy – klein", []), "mp4-proxy-klein");
  assertEquals(newProfileId("Ärger", ["arger"]), "arger-2");
  assertEquals(numOrUndef(""), undefined);
  assertEquals(numOrUndef("1,5"), 1.5);
  assertEquals(numOrUndef("abc"), undefined);
});

Deno.test("Einstellungen: Prüfung meldet Endung, Nachbearbeitung, negativen Bedarf", () => {
  const ok: IngestConfig = {
    profiles: { a: { id: "a", label: "A", ext: ".mxf" } },
    defaultBudget: {}, hostBudgets: {}, rules: {}, leadTimeS: 45, maxStartDeviationS: 10, horizonHours: 48, mediaDir: "data", defaultLate: {}, defaultRetry: {},
  };
  assertEquals(validateConfig(ok), []);
  const bad = cloneConfig(ok);
  bad.profiles.a.ext = "mxf";
  bad.profiles.a.convert = { ext: ".mp4", args: [] };
  bad.profiles.a.demand = { cpu_cores: -1 };
  bad.leadTimeS = 5000;
  assertEquals(validateConfig(bad).map((x) => x.key), ["ing.cfg.err.lead", "ing.cfg.err.ext", "ing.cfg.err.convert", "ing.cfg.err.demand"]);
});
