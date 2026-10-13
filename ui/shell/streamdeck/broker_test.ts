import { assertEquals } from "jsr:@std/assert";
import { modelForPid } from "./models.ts";
import { DeckBroker } from "./broker.ts";
import { DeckDevice } from "./transport.ts";
import { SimHid } from "./sim-device.ts";
import { type StreamDeckAdapter, RELAYOUT_EVENT } from "./adapter.ts";
import type { Rasterizer } from "./render-logic.ts";

const raster: Rasterizer = {
  key: (d) => Promise.resolve(new TextEncoder().encode(d?.label ?? "")),
  dial: (d) => Promise.resolve(new TextEncoder().encode(d?.value ?? "")),
};

function fakeAdapter(log: string[], pages = 1): StreamDeckAdapter & { label: string } {
  const a = {
    label: "A",
    getLayout: (ctx: { page: number }) => ({ keys: [[{ label: `${a.label}${ctx.page}` }, { label: "B" }]], pages, dials: [{ label: "d", value: "v" }] }),
    onKey: (r: number, c: number, d: boolean) => log.push(`key ${r},${c},${d}`),
    onDial: (i: number, d: number) => log.push(`dial ${i},${d}`),
  };
  return a;
}
function fakeEl(adapter: StreamDeckAdapter): HTMLElement {
  const el = new EventTarget() as unknown as HTMLElement & { streamDeck: StreamDeckAdapter };
  el.streamDeck = adapter;
  return el;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rig() {
  const hid = new SimHid(modelForPid(0x006c)!);
  const dev = await DeckDevice.open(hid);
  const imgs: string[] = [];
  hid.onImage = (i) => i.kind === "key" && imgs.push(`${i.index}:${new TextDecoder().decode(i.jpeg)}`);
  const b = new DeckBroker(dev, raster);
  return { hid, b, imgs, done: async () => { b.stop(); await dev.close(); } };
}

Deno.test("Broker: 3 Tabs in der Kopfzeile, Tastendruck wählt Tab, Inhalt erscheint, Eingaben nur an aktiven Tab", async () => {
  const { hid, b, imgs, done } = await rig();
  const l1: string[] = [], l2: string[] = [];
  const a1 = fakeAdapter(l1), a2 = fakeAdapter(l2);
  a2.label = "Z";
  b.attach("r1", "Mischer", fakeEl(a1), "n1");
  b.attach("r2", "Audio", fakeEl(a2), "n2");
  b.attach("r3", "Viewer", fakeEl(fakeAdapter([])), "n3");
  await b.flushNow();
  assertEquals(b.composed!.presses.slice(0, 5).map((p) => p.kind), ["home", "tab", "tab", "tab", "none"]);
  assertEquals(imgs.filter((s) => /^[0-3]:/.test(s)).map((s) => s.split(":")[1]), ["Home", "Mischer", "Audio", "Viewer"]);

  // Tab 2 (Taste 2) wählen
  let focused: unknown = "—";
  b.onFocusRequest = (id) => (focused = id);
  hid.pressKey(2, true); hid.pressKey(2, false);
  assertEquals([b.active, focused], ["r2", "r2"]);
  await b.flushNow();
  assertEquals(imgs.includes("8:Z0"), true); // Inhalt von a2 ab Zeile 1

  // Inhaltstaste (Zeile 1, Spalte 1 = Index 9) → nur a2
  hid.pressKey(9, true); hid.pressKey(9, false);
  assertEquals(l2, ["key 0,1,true", "key 0,1,false"]);
  assertEquals(l1, []);

  // Dial-Drehungen werden zusammengefasst (hier XL ohne Dials: Modell ignoriert) → kein Aufruf
  hid.turnDial(0, 1);
  await sleep(80);
  assertEquals(l2.length, 2);

  // Home
  hid.pressKey(0, true); hid.pressKey(0, false);
  assertEquals(b.active, null);
  await done();
});

Deno.test("Broker: Relayout-Ereignis des Elements baut neu auf; Inhaltsseite blättert", async () => {
  const { hid, b, imgs, done } = await rig();
  const a = fakeAdapter([], 3);
  const el = fakeEl(a);
  b.attach("r1", "M", el, "n1");
  b.focus("r1");
  await b.flushNow();
  assertEquals(b.composed!.presses[31], { kind: "contentPage" });
  hid.pressKey(31, true); hid.pressKey(31, false);
  await b.flushNow();
  assertEquals(imgs.includes("8:A1"), true);
  a.label = "Q";
  imgs.length = 0;
  el.dispatchEvent(new Event(RELAYOUT_EVENT));
  await b.flushNow();
  assertEquals(imgs, ["8:Q1"]); // nur die geänderte Taste
  await done();
});

Deno.test("Broker: Tab-Seiten blättern bei mehr Tabs als Tasten; detach des aktiven Tabs → Home", async () => {
  const { hid, b, done } = await rig();
  for (let i = 0; i < 10; i++) b.attach(`r${i}`, `T${i}`, fakeEl(fakeAdapter([])), `n${i}`);
  assertEquals(b.composed!.presses[7], { kind: "tabPage" });
  hid.pressKey(7, true); hid.pressKey(7, false);
  assertEquals(b.composed!.presses[1], { kind: "tab", id: "r6" });
  hid.pressKey(1, true); hid.pressKey(1, false);
  assertEquals(b.active, "r6");
  b.detach("r6");
  assertEquals(b.active, null);
  await done();
});

Deno.test("Broker „+“: Dial-Drehungen werden zusammengefasst und nur an den aktiven Adapter gegeben", async () => {
  const hid = new SimHid(modelForPid(0x0084)!);
  const dev = await DeckDevice.open(hid);
  const b = new DeckBroker(dev, raster);
  const l: string[] = [];
  b.attach("r1", "M", fakeEl(fakeAdapter(l)), "n1");
  b.focus("r1");
  hid.turnDial(0, 1); hid.turnDial(0, 2); hid.turnDial(1, -1);
  await sleep(90);
  assertEquals(l, ["dial 0,3", "dial 1,-1"]);
  hid.flick(700, 50, 100, 50);
  b.stop();
  await dev.close();
});
