import { assertEquals, assertThrows } from "jsr:@std/assert";
import { modelForPid, MODELS, rotatedSize, rotationMatrix, unrotationMatrix } from "./models.ts";
import {
  encodeDialPress,
  encodeDialTurn,
  encodeFlick,
  encodeKeyState,
  encodeTap,
  InputDecoder,
  keyImageReports,
  OutputAssembler,
  OUTPUT_LEN,
  stripImageReports,
  brightnessFeature,
} from "./protocol.ts";
import { DeckDevice } from "./transport.ts";
import { SimHid } from "./sim-device.ts";

const XL = modelForPid(0x006c)!;
const PLUS = modelForPid(0x0084)!;

function blob(n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 0xff);
}

Deno.test("Modelltabelle: Raster/Bildgröße je Modell", () => {
  assertEquals([XL.cols, XL.rows, XL.keySize, XL.rotation], [8, 4, 96, 180]);
  assertEquals([PLUS.cols, PLUS.rows, PLUS.keySize, PLUS.dials], [4, 2, 120, 4]);
  assertEquals(new Set(MODELS.map((m) => m.pid)).size, MODELS.length);
  assertEquals(modelForPid(0x0063), undefined); // Mini: nicht in v1
});

Deno.test("Tastenbild: Kopf, Chunk-Größen, letzter Chunk", () => {
  const img = blob(2500); // 1016 + 1016 + 468
  const r = keyImageReports(5, img);
  assertEquals(r.length, 3);
  for (const x of r) assertEquals(x.length, OUTPUT_LEN);
  assertEquals([...r[0].subarray(0, 7)], [0x07, 5, 0, 1016 & 255, 1016 >> 8, 0, 0]);
  assertEquals([...r[2].subarray(0, 7)], [0x07, 5, 1, 468 & 255, 468 >> 8, 2, 0]);
});

Deno.test("Tastenbild: Rundreise über Assembler, auch genau 1016 Byte und leer-nah", () => {
  for (const n of [1, 1016, 1017, 2032, 9000]) {
    const asm = new OutputAssembler();
    const img = blob(n);
    let got = null;
    for (const r of keyImageReports(31, img)) got = asm.feed(r) ?? got;
    assertEquals(got && got.kind === "key" && got.index, 31);
    assertEquals(got && got.jpeg, img, `n=${n}`);
  }
});

Deno.test("Streifenbild: Kopf + Rundreise (Dial-Segment 200×100)", () => {
  const img = blob(3000); // 1008·2 + 984
  const r = stripImageReports(400, 0, 200, 100, img);
  assertEquals(r.length, 3);
  assertEquals([...r[0].subarray(0, 15)], [0x0c, 400 & 255, 400 >> 8, 0, 0, 200, 0, 100, 0, 0, 0, 0, 1008 & 255, 1008 >> 8, 0]);
  assertEquals(r[2][9], 1);
  const asm = new OutputAssembler();
  let got = null;
  for (const x of r) got = asm.feed(x) ?? got;
  assertEquals(got && got.kind === "strip" && [got.x, got.y, got.w, got.h], [400, 0, 200, 100]);
  assertEquals(got && got.jpeg, img);
});

Deno.test("Assembler erkennt gestörte Chunk-Folge", () => {
  const r = keyImageReports(0, blob(2500));
  const asm = new OutputAssembler();
  asm.feed(r[0]);
  assertThrows(() => asm.feed(r[2]));
});

Deno.test("Helligkeit: Feature-Daten", () => {
  assertEquals([...brightnessFeature(70).subarray(0, 3)], [0x08, 70, 0]);
  assertEquals(brightnessFeature(250)[1], 100);
  assertEquals(brightnessFeature(-3)[1], 0);
});

Deno.test("Eingabe: Tasten als Flanken, nicht als Zustand", () => {
  const dec = new InputDecoder(XL);
  assertEquals(dec.decode(encodeKeyState(XL, new Set([3]))), [{ kind: "key", index: 3, down: true }]);
  assertEquals(dec.decode(encodeKeyState(XL, new Set([3]))), []); // unverändert
  assertEquals(dec.decode(encodeKeyState(XL, new Set([3, 9]))), [{ kind: "key", index: 9, down: true }]);
  assertEquals(dec.decode(encodeKeyState(XL, new Set())), [
    { kind: "key", index: 3, down: false },
    { kind: "key", index: 9, down: false },
  ]);
});

Deno.test("Eingabe „+“: Dial drehen (INT8 negativ), Dial drücken, Touch, Flick", () => {
  const dec = new InputDecoder(PLUS);
  assertEquals(dec.decode(encodeDialTurn(PLUS, 2, 3)), [{ kind: "dialTurn", index: 2, delta: 3 }]);
  assertEquals(dec.decode(encodeDialTurn(PLUS, 1, -2)), [{ kind: "dialTurn", index: 1, delta: -2 }]);
  assertEquals(dec.decode(encodeDialPress(PLUS, new Set([0]))), [{ kind: "dialPress", index: 0, down: true }]);
  assertEquals(dec.decode(encodeDialPress(PLUS, new Set())), [{ kind: "dialPress", index: 0, down: false }]);
  assertEquals(dec.decode(encodeTap("tap", 650, 40)), [{ kind: "touch", type: "tap", x: 650, y: 40 }]);
  assertEquals(dec.decode(encodeTap("press", 5, 99)), [{ kind: "touch", type: "press", x: 5, y: 99 }]);
  assertEquals(dec.decode(encodeFlick(700, 50, 100, 52)), [{ kind: "flick", x: 700, y: 50, x2: 100, y2: 52 }]);
});

Deno.test("Eingabe XL ignoriert Dial-/Touch-Reports (Modell ohne)", () => {
  const dec = new InputDecoder(XL);
  assertEquals(dec.decode(encodeTap("tap", 1, 1)), []);
});

Deno.test("DeckDevice über SimHid: Bild kommt an, Eingabe wird Ereignis, Logo beim Schließen", async () => {
  const hid = new SimHid(PLUS);
  const dev = await DeckDevice.open(hid);
  const imgs: string[] = [];
  hid.onImage = (i) => imgs.push(i.kind === "key" ? `k${i.index}:${i.jpeg.length}` : `s${i.x}:${i.jpeg.length}`);
  await dev.setKeyImage(7, blob(2200));
  await dev.setStripImage(600, 0, 200, 100, blob(1500));
  await dev.setBrightness(40);
  assertEquals(imgs, ["k7:2200", "s600:1500"]);
  assertEquals(hid.brightness, 40);
  const ev: unknown[] = [];
  dev.onEvent((e) => ev.push(e));
  hid.pressKey(2, true);
  hid.turnDial(3, -1);
  assertEquals(ev, [{ kind: "key", index: 2, down: true }, { kind: "dialTurn", index: 3, delta: -1 }]);
  await dev.close();
  assertEquals([hid.logoShown, hid.opened], [true, false]);
});

Deno.test("DeckDevice.open: unbekanntes Modell und fehlgeschlagenes Öffnen", async () => {
  const bad = new SimHid(XL);
  (bad as { productId: number }).productId = 0x0063;
  let msg = "";
  try { await DeckDevice.open(bad); } catch (e) { msg = (e as Error).message; }
  assertEquals(msg, "unsupported-model");
  const fail = new SimHid(XL);
  fail.open = () => Promise.reject(new Error("x"));
  try { await DeckDevice.open(fail); } catch (e) { msg = (e as Error).message; }
  assertEquals(msg, "open-failed");
});

Deno.test("Stream Deck + XL: 9×4 Tasten, 6 Dials, Drehung 90° gegen den Uhrzeigersinn", () => {
  const m = modelForPid(0x00c6)!;
  assertEquals([m.cols, m.rows, m.keySize, m.dials, m.rotation], [9, 4, 112, 6, 90]);
  assertEquals(m.strip, { w: 1200, h: 100 });
  // Logische Ecke oben links → unten links des hochgeladenen Bilds (CCW).
  const [a, b, c, d, e, f] = rotationMatrix(90, 112, 112);
  assertEquals([a * 0 + c * 0 + e, b * 0 + d * 0 + f], [0, 112]);
  assertEquals(rotatedSize(90, 200, 100), [100, 200]);
  // Rotation und Umkehrung heben sich auf (Punkt (30,10) im 200×100-Streifen).
  const [ra, rb, rc, rd, re, rf] = rotationMatrix(90, 200, 100);
  const [x, y] = [ra * 30 + rc * 10 + re, rb * 30 + rd * 10 + rf];
  const [ua, ub, uc, ud, ue, uf] = unrotationMatrix(90, 200, 100);
  assertEquals([ua * x + uc * y + ue, ub * x + ud * y + uf], [30, 10]);
});

Deno.test("Stream Deck + XL: Eingabe-Dekodierung (36 Tasten, 6 Dials)", () => {
  const m = modelForPid(0x00c6)!;
  const dec = new InputDecoder(m);
  const keys = new Set([35]);
  assertEquals(dec.decode(encodeKeyState(m, keys)).map((e) => e.kind), ["key"]);
  const turn = dec.decode(encodeDialTurn(m, 5, -3));
  assertEquals(turn[0], { kind: "dialTurn", index: 5, delta: -3 });
});
