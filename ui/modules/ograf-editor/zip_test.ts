import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { base64ToBytes, bytesToBase64, bytesToFiles, crc32, filesToBytes, makeZip, readZip } from "./zip.ts";

const enc = (s: string) => new TextEncoder().encode(s);

Deno.test("crc32 kennt den Standardwert", () => {
  assertEquals(crc32(enc("123456789")), 0xcbf43926);
});

Deno.test("Base64 rund herum, auch große Daten", () => {
  const big = new Uint8Array(100000).map((_, i) => i % 251);
  assertEquals(base64ToBytes(bytesToBase64(big)), big);
});

Deno.test("ZIP: schreiben und lesen (gespeichert)", async () => {
  const files = { "a.ograf.json": '{"id":"a"}', "a.js": "export default class {}", "logo.png": "base64:iVBORw==" };
  const zip = makeZip(filesToBytes(files));
  const r = await readZip(zip);
  assertEquals(r.skipped, []);
  assertEquals(bytesToFiles(r.files), files);
});

Deno.test("ZIP: Oberordner wird entfernt, tiefe/versteckte/fremde Dateien werden gemeldet", async () => {
  const zip = makeZip({
    "pkg/x.ograf.json": enc("{}"), "pkg/x.js": enc("1"), "pkg/img/a.png": enc("x"), "pkg/.DS_Store": enc("x"), "pkg/run.exe": enc("x"),
  });
  const r = await readZip(zip);
  assertEquals(Object.keys(r.files).sort(), ["x.js", "x.ograf.json"]);
  assertEquals(r.skipped.sort(), ["pkg/.DS_Store", "pkg/img/a.png", "pkg/run.exe"]);
});

Deno.test("ZIP: Deflate-Einträge werden gelesen", async () => {
  const text = enc("hallo ".repeat(500));
  const cs = new CompressionStream("deflate-raw");
  const w = cs.writable.getWriter();
  void w.write(text).then(() => w.close());
  const packed = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  // Archiv von Hand: ein Eintrag Methode 8
  const name = enc("t.txt");
  const u16 = (v: number) => [v & 255, (v >> 8) & 255];
  const u32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  const crc = crc32(text);
  const local = [...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0), ...u32(crc), ...u32(packed.length), ...u32(text.length), ...u16(name.length), ...u16(0), ...name, ...packed];
  const cd = [...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0), ...u32(crc), ...u32(packed.length), ...u32(text.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...name];
  const eocd = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(1), ...u16(1), ...u32(cd.length), ...u32(local.length), ...u16(0)];
  const r = await readZip(new Uint8Array([...local, ...cd, ...eocd]));
  assertEquals(new TextDecoder().decode(r.files["t.txt"]), "hallo ".repeat(500));
});

Deno.test("ZIP: Unsinn und beschädigte Archive werden abgewiesen", async () => {
  await assertRejects(() => readZip(enc("kein zip")), Error, "kein ZIP");
  const zip = makeZip({ "a.txt": enc("abc") });
  const bad = new Uint8Array(zip);
  bad[35] ^= 0xff; // Nutzdaten verändern
  await assertRejects(() => readZip(bad), Error, "Prüfsumme");
});
