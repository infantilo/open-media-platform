import { assertEquals } from "jsr:@std/assert@1";
import { formatFirmware, formatFirmwareLong } from "./version.ts";

Deno.test("formatFirmware: Release mit Commit wird gekürzt", () => {
  assertEquals(formatFirmware({ version: "2026.10.0", commit: "abc1234def567" }), "Firmware 2026.10.0 (abc1234)");
});

Deno.test("formatFirmware: ohne Stempel = Entwicklungsstand", () => {
  assertEquals(formatFirmware({ version: "dev" }), "Firmware Entwicklungsstand");
});

Deno.test("formatFirmware: fehlende Daten ergeben leeren Text statt 'undefined'", () => {
  assertEquals(formatFirmware(null), "");
  assertEquals(formatFirmware(undefined), "");
  assertEquals(formatFirmware({ version: "" }), "");
});

Deno.test("formatFirmwareLong: hängt den Bauzeitpunkt an", () => {
  assertEquals(
    formatFirmwareLong({ version: "2026.10.0", commit: "abc1234", builtAt: "2026-10-02T09:00:00Z" }),
    "Firmware 2026.10.0 (abc1234), gebaut 2026-10-02T09:00:00Z",
  );
  assertEquals(formatFirmwareLong({ version: "dev" }), "Firmware Entwicklungsstand");
});
