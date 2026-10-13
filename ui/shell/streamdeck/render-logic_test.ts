import { assertEquals } from "jsr:@std/assert";
import { modelForPid } from "./models.ts";
import { DeckRenderer, fingerprint, type KeyDef, type Rasterizer, type RenderTarget } from "./render-logic.ts";

const PLUS = modelForPid(0x0084)!;
const XL = modelForPid(0x006c)!;

function rig(model = XL, failAt = -1) {
  const sent: string[] = [];
  let n = 0;
  const target: RenderTarget = {
    model,
    setKeyImage: (i, j) => {
      if (n++ === failAt) return Promise.reject(new Error("usb"));
      sent.push(`k${i}:${new TextDecoder().decode(j)}`);
      return Promise.resolve();
    },
    setStripImage: (x, _y, w, _h, j) => {
      sent.push(`s${x}/${w}:${new TextDecoder().decode(j)}`);
      return Promise.resolve();
    },
  };
  const raster: Rasterizer = {
    key: (d) => Promise.resolve(new TextEncoder().encode(d?.label ?? "")),
    dial: (d) => Promise.resolve(new TextEncoder().encode(d?.value ?? "")),
  };
  const timers: (() => void)[] = [];
  const errs: unknown[] = [];
  const r = new DeckRenderer(target, raster, { setTimer: (fn) => (timers.push(fn), timers.length), onError: (e) => errs.push(e) });
  return { r, sent, timers, errs, tick: async () => { const f = timers.shift(); f?.(); await r.idle(); } };
}

Deno.test("fingerprint: Reihenfolge der Felder egal, undefined ignoriert", () => {
  assertEquals(fingerprint({ label: "A", state: "onair" }), fingerprint({ state: "onair", label: "A", sub: undefined }));
  assertEquals(fingerprint(null), "-");
  assertEquals(fingerprint({ label: "A" }) === fingerprint({ label: "B" }), false);
});

Deno.test("erster Flush sendet alle Tasten (auch leere), zweiter nichts", async () => {
  const { r, sent, tick } = rig();
  r.set([{ label: "PGM" }]);
  await tick();
  assertEquals(sent.length, 32);
  assertEquals(sent[0], "k0:PGM");
  r.set([{ label: "PGM" }]); // identisch
  await tick();
  assertEquals(sent.length, 32);
});

Deno.test("nur geänderte Tasten werden gesendet", async () => {
  const { r, sent, tick } = rig();
  const a: KeyDef[] = [{ label: "A" }, { label: "B" }];
  r.set(a);
  await tick();
  sent.length = 0;
  r.set([{ label: "A" }, { label: "B2", state: "onair" }]);
  await tick();
  assertEquals(sent, ["k1:B2"]);
});

Deno.test("Debounce: viele Änderungen → ein Zeitgeber, ein Durchgang", async () => {
  const { r, timers, tick } = rig();
  for (let i = 0; i < 20; i++) r.set([{ label: `x${i}` }]);
  assertEquals(timers.length, 1);
  await tick();
  assertEquals(r.stats.flushes, 1);
  assertEquals(r.stats.keyImages, 32);
});

Deno.test("Fehler beim Senden: Fingerprint nicht gemerkt, Wiederholung sendet nur den Rest", async () => {
  const { r, sent, errs, timers, tick } = rig(XL, 3);
  r.set([{ label: "a" }]);
  await tick(); // bricht bei der 4. Taste ab
  assertEquals(errs.length, 1);
  assertEquals(sent.length, 3);
  assertEquals(timers.length, 1); // erneuter Anstoß geplant
  await tick();
  assertEquals(sent.length, 32); // 3 alte + 29 restliche, keine Doppelten
  assertEquals(new Set(sent.map((s) => s.split(":")[0])).size, 32);
});

Deno.test("invalidate sendet alles neu", async () => {
  const { r, sent, tick } = rig();
  r.set([{ label: "a" }]);
  await tick();
  sent.length = 0;
  r.invalidate();
  await tick();
  assertEquals(sent.length, 32);
});

Deno.test("„+“: Streifen-Segmente je Dial, nur geänderte", async () => {
  const { r, sent, tick } = rig(PLUS);
  r.set([], [{ label: "L", value: "0 dB" }, { label: "M", value: "1" }]);
  await tick();
  assertEquals(sent.filter((s) => s.startsWith("s")), ["s0/200:0 dB", "s200/200:1", "s400/200:", "s600/200:"]);
  sent.length = 0;
  r.set([], [{ label: "L", value: "0 dB" }, { label: "M", value: "2" }]);
  await tick();
  assertEquals(sent.filter((s) => s.startsWith("s")), ["s200/200:2"]);
});

Deno.test("Änderung während des Sendens führt zu zweitem Durchgang", async () => {
  const { r, sent, timers, tick } = rig();
  r.set([{ label: "a" }]);
  const f = timers.shift()!;
  f(); // Flush läuft (async)
  r.set([{ label: "b" }]); // kommt währenddessen
  await r.idle();
  if (timers.length) await tick();
  assertEquals(sent.at(-1), "k0:b");
});
