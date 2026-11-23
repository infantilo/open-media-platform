import { assertEquals } from "jsr:@std/assert@1";
import { applyAcks, buildAlarms, isAlarmRefreshEvent } from "./alarms.ts";
import type { AlarmAck } from "./alarms.ts";

const NOW = Date.parse("2026-09-21T12:00:00Z");

function hostAlarm(receivedAt: string) {
  return buildAlarms([], [], [], [{ id: "h1", label: "Host A", metrics: { receivedAt } }])[0];
}

Deno.test("Host-Offline-Alarm: Key stabil, Fingerprint = letztes Lebenszeichen", () => {
  const a1 = hostAlarm("2026-09-21T10:00:00Z");
  const a2 = hostAlarm("2026-09-21T11:00:00Z");
  assertEquals(a1.key, "host:h1:offline");
  assertEquals(a1.key, a2.key);
  assertEquals(a1.fingerprint === a2.fingerprint, false);
});

Deno.test("Quittierung gilt bei gleichem Fingerprint, nicht nach Wiederauftreten", () => {
  const before = hostAlarm("2026-09-21T10:00:00Z");
  const ack: AlarmAck = {
    key: before.key,
    fingerprint: before.fingerprint,
    mode: "ack",
    username: "alice",
    createdAt: "2026-09-21T10:05:00Z",
  };
  assertEquals(applyAcks([before], [ack], NOW)[0].ack?.username, "alice");
  // Host kam zurück und fiel erneut aus → neuer Fingerprint → wieder laut.
  const again = hostAlarm("2026-09-21T11:30:00Z");
  assertEquals(applyAcks([again], [ack], NOW)[0].ack, undefined);
});

Deno.test("Abgelaufene Maskierung gilt nicht mehr", () => {
  const a = hostAlarm("2026-09-21T10:00:00Z");
  const mask: AlarmAck = {
    key: a.key,
    fingerprint: a.fingerprint,
    mode: "mask",
    username: "bob",
    createdAt: "2026-09-21T10:05:00Z",
    expiresAt: "2026-09-21T11:00:00Z",
  };
  assertEquals(applyAcks([a], [mask], NOW)[0].ack, undefined);
  assertEquals(applyAcks([a], [{ ...mask, expiresAt: "2026-09-21T13:00:00Z" }], NOW)[0].ack?.mode, "mask");
});

Deno.test("Eskalation warning→critical ändert den Fingerprint", () => {
  const never = buildAlarms([], [], [], [{ id: "h1", label: "Host A" }])[0];
  const lost = hostAlarm("2026-09-21T10:00:00Z");
  assertEquals(never.severity, "warning");
  assertEquals(never.fingerprint === lost.fingerprint, false);
});

Deno.test("Instanz-Absturz: neuer Crash (restartCount) ändert den Fingerprint", () => {
  const mk = (n: number) =>
    buildAlarms([{ id: "i1", type: "omp-source", label: "Src", crashed: true, crashMessage: "exit 1", restartCount: n }], [], [], [])[0];
  assertEquals(mk(1).key, "instance:i1:crashed");
  assertEquals(mk(1).fingerprint === mk(2).fingerprint, false);
});

Deno.test("Trend-Vorwarnung wird als eigener Alarm mit Restzeit gebaut", () => {
  const adv = { hostId: "h1", hostLabel: "Host A", reason: "cpu", cpuPercent: 72, memPercent: 30, instanceIds: ["i1"], suggestedHostId: "h2", suggestedHostLabel: "Host B", detectedAt: "2026-10-23T12:00:00Z", predicted: true, minutesToLimit: 25 };
  const a = buildAlarms([], [adv], [])[0];
  assertEquals(a.severity, "warning");
  assertEquals(a.detail.includes("25"), true);
  assertEquals(a.fingerprint.startsWith("predicted|"), true);
  const real = buildAlarms([], [{ ...adv, predicted: false }], [])[0];
  assertEquals(real.fingerprint.startsWith("predicted|"), false);
});

Deno.test("MCR-Alarme erscheinen als eigene Quelle mit Event und Leitung", () => {
  const mcr = [
    { id: "a1", eventId: "e1234567890", eventName: "Fußball A gegen B", lineName: "PGM", kind: "signal-black", severity: "error", text: "Schwarzbild seit 3 s", startedAt: "2026-11-23T12:00:00Z" },
    { id: "a2", eventId: "e9999999999", lineName: "Kam 2", kind: "signal-freeze", severity: "warning", text: "Standbild", startedAt: "2026-11-23T12:01:00Z" },
  ];
  const alarms = buildAlarms([], [], [], [], mcr);
  assertEquals(alarms.length, 2);
  const [black, freeze] = alarms; // kritisch zuerst
  assertEquals([black.key, black.severity, black.source], ["mcr:a1", "critical", "MCR"]);
  assertEquals(black.title, "Fußball A gegen B / PGM");
  assertEquals(black.detail, "black: Schwarzbild seit 3 s");
  assertEquals([freeze.severity, freeze.title], ["warning", "e9999999 / Kam 2"]); // ohne Namen: Anfang der Event-ID
  // Ein Wiederauftreten (neue Alarm-ID und Zeit) ist ein anderer Alarm und damit nicht durch eine alte Quittierung gedeckt.
  const again = buildAlarms([], [], [], [], [{ ...mcr[0], id: "a3", startedAt: "2026-11-23T12:30:00Z" }])[0];
  assertEquals(again.key === black.key || again.fingerprint === black.fingerprint, false);
  assertEquals(buildAlarms([], [], [], [], []).length, 0);
});

Deno.test("Aktualisierung nach Node-Alarmen (MCR-Signalalarme)", () => {
  assertEquals(isAlarmRefreshEvent("omp.alert.abc"), true);
  assertEquals(isAlarmRefreshEvent("instance.crashed"), true);
  assertEquals(isAlarmRefreshEvent("workflow.created"), false);
});
