import { assertEquals } from "jsr:@std/assert";
import { deviceHubAdapter, type HubIO } from "./device-hub.ts";
import { type Device, layoutHub } from "./device-hub-logic.ts";

const dev = (id: string, direction: string, offered: boolean, o: Partial<Device> = {}): Device => ({
  id, name: id.toUpperCase(), kind: "audio", direction, offered, present: true, status: "waiting", ...o,
});

Deno.test("Taste je Gerät: grün = EIN, grau = AUS, Fehler rot, abwesend gedimmt", () => {
  const l = layoutHub([dev("a", "input", true), dev("b", "output", false), dev("c", "input", true, { status: "error: busy" }), dev("d", "input", false, { present: false })], 8, 2, 0, 0);
  assertEquals(l.keys[0].slice(0, 5).map((k) => k?.label), ["NEU SUCHEN", "A", "B", "C", "D"]);
  assertEquals(l.keys[0].slice(1, 5).map((k) => k?.state), ["preset", "off", "error", "off"]);
  assertEquals(l.keys[0][1]?.sub, "Audio Ein · EIN");
  assertEquals(l.keys[0][2]?.sub, "Audio Aus · AUS");
  assertEquals(l.keys[0][4]?.dim, true);
  assertEquals(l.act[0][2], { t: "toggle", id: "b", on: true });
  assertEquals(l.act[0][1], { t: "toggle", id: "a", on: false });
});

Deno.test("mehr Geräte als Tasten: Seiten, letzte Taste bleibt für den Broker frei", () => {
  const ds = Array.from({ length: 10 }, (_, i) => dev(`g${i}`, "input", false));
  const p0 = layoutHub(ds, 4, 1, 4, 0);
  assertEquals(p0.pages, 4); // 11 Einträge, 3 je Seite
  assertEquals(p0.keys[0].map((k) => k?.label ?? null), ["NEU SUCHEN", "G0", "G1", null]);
  assertEquals(layoutHub(ds, 4, 1, 4, 3).keys[0].map((k) => k?.label ?? null), ["G8", "G9", null, null]);
  assertEquals(p0.dials!.map((d) => d?.label), ["Angeboten", "Eingänge", "Ausgänge", "Fehler"]);
});

Deno.test("Tastendruck ruft setOffered mit umgekehrtem Zustand, rescan ruft rescan", async () => {
  const calls: string[] = [];
  let offered = false;
  const io: HubIO = {
    getParam: () => Promise.resolve([{ id: "x", name: "X", kind: "video", direction: "input", offered, present: true, status: "idle" }]),
    call: (n, b) => {
      calls.push(`${n} ${JSON.stringify(b ?? {})}`);
      if (n === "setOffered") offered = (b as { on: boolean }).on;
      return Promise.resolve();
    },
  };
  const a = deviceHubAdapter(io);
  await a.refresh!();
  a.getLayout({ cols: 8, rows: 2, dials: 0, page: 0 });
  a.onKey(0, 1, true);
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(calls, ['setOffered {"id":"x","on":true}']);
  assertEquals(a.getLayout({ cols: 8, rows: 2, dials: 0, page: 0 }).keys[0][1]?.state, "preset");
  a.onKey(0, 0, true);
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(calls[1], "rescan {}");
});
