import { assert, assertEquals } from "jsr:@std/assert";
import { messages } from "./messages.ts";

Deno.test("de und en haben dieselben Schlüssel", () => {
  assertEquals(Object.keys(messages.de).sort(), Object.keys(messages.en).sort());
});

Deno.test("alle im Quelltext benutzten Schlüssel stehen in beiden Sprachen", async () => {
  // Das Projekt startet `deno test ui/` ohne Dateirechte: dann überspringen (mit --allow-read läuft die Prüfung).
  if ((await Deno.permissions.query({ name: "read" })).state !== "granted") return;
  const used = new Set<string>();
  for (const f of ["mcr-view.ts", "line-form.ts", "mcr-dom.ts", "timeline-view.ts", "alarm-view.ts"]) {
    const src = await Deno.readTextFile(new URL(f, import.meta.url));
    for (const m of src.matchAll(/\bt\(\s*"(mcr\.[A-Za-z0-9_.]*[A-Za-z0-9_])"/g)) used.add(m[1]);
  }
  const missing = [...used].filter((k) => !(k in messages.de) || !(k in messages.en));
  assertEquals(missing, []);
  assert(used.size > 100);
});

Deno.test("dynamisch gebildete Schlüssel sind vollständig", () => {
  const need: string[] = [];
  for (const s of ["planned", "testing", "live", "teardown", "done", "cancelled"]) need.push(`mcr.state.${s}`, `mcr.confirm.${s}`);
  for (const k of ["srt", "rist", "st2110", "hls", "mxl"]) need.push(`mcr.kind.${k}`);
  for (const s of ["deinterlace", "frameRate", "scale", "colorMatrix", "transferMap", "interlace", "pixelFormat", "channelMap", "resample"]) need.push(`mcr.stage.${s}`);
  for (const m of ["copy", "convert", "blocked", "error", "waiting", "idle"]) need.push(`mcr.pass.${m}`);
  for (const k of ["name", "uri", "url", "ports", "secret"]) need.push(`mcr.err.line.${k}`);
  for (const k of ["size", "scan", "interlaceHeight", "rate", "sampleRate", "channels"]) need.push(`mcr.err.house.${k}`);
  for (const k of ["mix", "guest"]) need.push(`mcr.ret.${k}`);
  assertEquals(need.filter((k) => !(k in messages.de) || !(k in messages.en)), []);
});
