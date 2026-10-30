import { assertEquals } from "jsr:@std/assert";
import { anyActive, clampPct, EMPTY_SUBTITLE_FORM, parseNames, subtitleBody } from "./subtitles-logic.ts";

Deno.test("Untertitel-Formular: Standard = automatische Sprecheranzahl", () => {
  assertEquals(subtitleBody(EMPTY_SUBTITLE_FORM), { track: 0, speakers: 0, style: "colon" });
});

Deno.test("Untertitel-Formular: ein Sprecher lässt Namen und Schreibweise weg", () => {
  assertEquals(subtitleBody({ ...EMPTY_SUBTITLE_FORM, speakers: "1", names: "A, B", language: " DE " }), { track: 0, speakers: 1, language: "de" });
});

Deno.test("Untertitel-Formular: Namen, Spur, Name", () => {
  assertEquals(subtitleBody({ name: " Probe ", track: "2", language: "", speakers: "2", names: "Alice\nBob; ", style: "bracket" }), {
    track: 2,
    speakers: 2,
    name: "Probe",
    names: ["Alice", "Bob"],
    style: "bracket",
  });
  assertEquals(parseNames(" , ;"), []);
});

Deno.test("Auftragsliste: aktiv und Prozentwerte", () => {
  assertEquals(anyActive([{ state: "done" } as never]), false);
  assertEquals(anyActive([{ state: "running" } as never]), true);
  assertEquals(clampPct(140), 100);
  assertEquals(clampPct(NaN), 0);
});
