import { assertEquals } from "jsr:@std/assert@1";
import { applyAcks, buildAlarms } from "./alarms.ts";
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
