import { assertEquals } from "jsr:@std/assert";
import { canSaveProfile, cloneProfile, describeExpect, describeLoudness, newProfileId, type QcProfile } from "./qc-profiles-logic.ts";

const words = { tracks: "tracks", none: "none", captions: "captions" };

Deno.test("Kennung aus dem Namen: Umlaute und Sonderzeichen, kollisionsfrei, höchstens 40 Zeichen", () => {
  assertEquals(newProfileId("Kurzbeitrag Wetter", []), "kurzbeitrag-wetter");
  assertEquals(newProfileId("Übertragung 1080i/25", []), "ubertragung-1080i-25");
  assertEquals(newProfileId("Wetter", ["wetter"]), "wetter-2");
  assertEquals(newProfileId("Wetter", ["wetter", "wetter-2"]), "wetter-3");
  assertEquals(newProfileId("!!!", []), "profil"); // ohne verwertbare Zeichen: Rückfall (nie leer)
  assertEquals(newProfileId("x".repeat(100), []).length <= 40, true);
});

Deno.test("Kopie bekommt eigene Kennung, Namen und Version 1, die Vorlage bleibt unverändert", () => {
  const src = { id: "broadcast-default", version: 4, name: "Broadcast", black: { failAboveS: 10 } } as unknown as QcProfile;
  const c = cloneProfile(src, "Broadcast kurz", ["broadcast-default"]);
  assertEquals([c.id, c.version, c.name], ["broadcast-kurz", 1, "Broadcast kurz"]);
  c.black.failAboveS = 3;
  assertEquals(src.black.failAboveS, 10);
});

Deno.test("Kurzfassung der Erwartungen", () => {
  assertEquals(describeExpect({ expect: {} } as unknown as QcProfile, words), "none");
  const p = { expect: { width: 1920, height: 1080, frameRate: "25/1", fieldOrder: "tt", container: "mxf", audioTracks: 8, captions: true } } as unknown as QcProfile;
  assertEquals(describeExpect(p, words), "1920×1080 · 25/1 · tt · mxf · ≥ 8 tracks · captions");
});

Deno.test("Kurzfassung der Lautheit", () => {
  assertEquals(describeLoudness({ loudness: { enabled: false } } as unknown as QcProfile), "");
  assertEquals(describeLoudness({ loudness: { enabled: true, targetLufs: -23, warnToleranceLu: 1, failToleranceLu: 3, maxTruePeakDbtp: -1 } } as unknown as QcProfile), "−23 LUFS ±1/±3 LU, ≤ −1 dBTP");
});

Deno.test("Speichern nur mit Name und (bei neu) gültiger Kennung", () => {
  assertEquals(canSaveProfile("", "x", true), "name");
  assertEquals(canSaveProfile("A", "Gross", true), "id");
  assertEquals(canSaveProfile("A", "gross", true), null);
  assertEquals(canSaveProfile("A", "kaputt id", false), null); // bestehende Kennung wird nie geprüft/geändert
});
