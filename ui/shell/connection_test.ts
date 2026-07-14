// Deckt den Live-Test-Fund aus K1-Teil-1 ab (s. Kommentar bei
// DEGRADED_RECOVERY_PROBE_INTERVAL_MS in connection.ts): ein einzelner
// veralteter Fetch-Fehlschlag darf den ConnectionMonitor nicht dauerhaft
// auf "degraded" einfrieren. Jeder Testfall importiert das Modul über
// einen eindeutigen Query-String neu (Deno cacht ESM-Module pro
// Specifier inkl. Query) — sonst würde der modulweite Singleton
// `connectionMonitor` Zustand zwischen den Testfällen mitschleppen.
import { assertEquals } from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";

Deno.test("degraded state auto-heals via a background /healthz probe once connectivity returns", async () => {
  const time = new FakeTime();
  const originalFetch = globalThis.fetch;
  let failNext = true;
  globalThis.fetch = (() =>
    Promise.resolve(new Response(null, { status: failNext ? 500 : 200 }))) as typeof fetch;

  try {
    const { connectionMonitor, apiFetch } = await import("./connection.ts?case=degraded-heal");
    assertEquals(connectionMonitor.state, "connected");

    const res = await apiFetch("/api/v1/whatever");
    assertEquals(res.status, 500);
    assertEquals(connectionMonitor.state, "degraded");

    // Der Recovery-Probe ist jetzt für +3s geplant — die nächste
    // (simulierte) Anfrage soll wieder gelingen.
    failNext = false;
    await time.tickAsync(3000);
    assertEquals(connectionMonitor.state, "connected");
  } finally {
    globalThis.fetch = originalFetch;
    time.restore();
  }
});

Deno.test("degraded state keeps retrying every 3s until connectivity actually returns", async () => {
  const time = new FakeTime();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return Promise.resolve(new Response(null, { status: calls >= 3 ? 200 : 500 }));
  }) as typeof fetch;

  try {
    const { connectionMonitor, apiFetch } = await import("./connection.ts?case=degraded-retry");
    await apiFetch("/api/v1/whatever"); // Aufruf 1: schlägt fehl -> degraded
    assertEquals(connectionMonitor.state, "degraded");

    await time.tickAsync(3000); // Probe-Aufruf 2: schlägt noch fehl
    assertEquals(connectionMonitor.state, "degraded");

    await time.tickAsync(3000); // Probe-Aufruf 3: gelingt
    assertEquals(connectionMonitor.state, "connected");
  } finally {
    globalThis.fetch = originalFetch;
    time.restore();
  }
});

Deno.test("a 4xx response does not count as a connectivity problem", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response(null, { status: 404 }))) as typeof fetch;

  try {
    const { connectionMonitor, apiFetch } = await import("./connection.ts?case=four-oh-four");
    await apiFetch("/api/v1/whatever");
    assertEquals(connectionMonitor.state, "connected");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
