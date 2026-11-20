import { assertEquals } from "jsr:@std/assert@1";
import {
  type Asset,
  filterAssets,
  formatBitrate,
  formatBytes,
  hasTamsPlay,
  parseTamsUri,
  tamsPlayArgs,
  metadataToRows,
  parseOptionalNumber,
  representationSummary,
  rowsToMetadata,
} from "./asset-view-logic.ts";

Deno.test("metadata round-trip preserves non-string values and drops empty categories", () => {
  const meta = {
    descriptive: { title: "Clip", year: 2024, tags: ["a", "b"] },
    technical: { interlaced: false },
  };
  const rows = metadataToRows(meta);
  assertEquals(rows.descriptive.find((r) => r.key === "year"), { key: "year", value: "2024", json: true });
  assertEquals(rows.editorial, []);
  const back = rowsToMetadata(rows);
  assertEquals(back, { ok: true, metadata: meta });
});

Deno.test("new string rows stay strings even if they look numeric", () => {
  const rows = metadataToRows({});
  rows.descriptive.push({ key: "season", value: "2024", json: false });
  assertEquals(rowsToMetadata(rows), { ok: true, metadata: { descriptive: { season: "2024" } } });
});

Deno.test("rowsToMetadata skips blank rows, rejects nameless values, duplicates and invalid JSON", () => {
  const rows = metadataToRows({});
  rows.custom.push({ key: " ", value: " ", json: false });
  assertEquals(rowsToMetadata(rows), { ok: true, metadata: {} });

  rows.custom.push({ key: "", value: "x", json: false });
  assertEquals(rowsToMetadata(rows).ok, false);
  rows.custom.pop();

  rows.custom.push({ key: "a", value: "1", json: false }, { key: "a ", value: "2", json: false });
  const dup = rowsToMetadata(rows);
  assertEquals(dup.ok, false);
  if (!dup.ok) assertEquals(dup.error, 'Eigene Felder: Feld "a" doppelt');
  rows.custom.pop();

  rows.custom.push({ key: "n", value: "{broken", json: true });
  assertEquals(rowsToMetadata(rows).ok, false);
});

Deno.test("parseOptionalNumber: empty is unset, invalid/negative/non-integer rejected, comma accepted", () => {
  assertEquals(parseOptionalNumber(""), { ok: true, value: undefined });
  assertEquals(parseOptionalNumber("25"), { ok: true, value: 25 });
  assertEquals(parseOptionalNumber("29,97"), { ok: true, value: 29.97 });
  assertEquals(parseOptionalNumber("abc"), { ok: false });
  assertEquals(parseOptionalNumber("-1"), { ok: false });
  assertEquals(parseOptionalNumber("1.5", { integer: true }), { ok: false });
});

Deno.test("representationSummary lists only set fields", () => {
  assertEquals(
    representationSummary({
      id: "r",
      assetVersionId: "v",
      type: "master",
      storage: { provider: "filesystem", uri: "/m.mov" },
      codec: "prores",
      container: "mov",
      width: 1920,
      height: 1080,
      frameRate: 25,
      bitrate: 8_000_000,
      sizeBytes: 1_500_000_000,
      createdAt: "",
    }),
    "1920×1080 · 25 fps · prores/mov · 8 Mbit/s · 1.5 GB",
  );
  assertEquals(
    representationSummary({
      id: "r",
      assetVersionId: "v",
      type: "audio_stem",
      storage: { provider: "s3", uri: "s3://b/k.wav" },
      sampleRate: 48000,
      channels: 2,
      createdAt: "",
    }),
    "48 kHz · 2 ch",
  );
  assertEquals(formatBytes(999), "999 B");
  assertEquals(formatBitrate(128_000), "128 kbit/s");
});

Deno.test("filterAssets hides deleted by default, but shows them when filtering by that status", () => {
  const mk = (id: string, type: string, status: string, title: string): Asset => ({
    id,
    type,
    status,
    title,
    metadata: {},
    createdBy: "",
    updatedBy: "",
    rowVersion: 1,
    createdAt: "",
    updatedAt: "",
  });
  const list = [mk("1", "video", "ready", "Tagesschau"), mk("2", "audio", "deleted", "Jingle"), mk("3", "video", "ingesting", "Wetter")];
  const base = { query: "", type: "", status: "", showDeleted: false };
  assertEquals(filterAssets(list, base).map((a) => a.id), ["1", "3"]);
  assertEquals(filterAssets(list, { ...base, showDeleted: true }).map((a) => a.id), ["1", "2", "3"]);
  assertEquals(filterAssets(list, { ...base, status: "deleted" }).map((a) => a.id), ["2"]);
  assertEquals(filterAssets(list, { ...base, type: "video", query: "wet" }).map((a) => a.id), ["3"]);
});

Deno.test("coerceMetadata: Zahl/Ja-Nein/Mehrfachfeld nach Feldtyp, freie Schlüssel unverändert", async () => {
  const { coerceMetadata } = await import("./asset-view-logic.ts");
  const defs = [
    { id: "1", category: "custom", key: "anzahl", label: "Anzahl", dataType: "integer" },
    { id: "2", category: "custom", key: "live", label: "Live", dataType: "boolean" },
    { id: "3", category: "descriptive", key: "subject", label: "Schlagworte", dataType: "text", multiple: true },
  ] as const;
  const got = coerceMetadata(
    { custom: { anzahl: "3", live: "ja", frei: "7", kaputt: "x" }, descriptive: { subject: "Sport" } },
    [...defs],
  );
  assertEquals(got.custom, { anzahl: 3, live: true, frei: "7", kaputt: "x" });
  assertEquals(got.descriptive, { subject: ["Sport"] });
  const bad = coerceMetadata({ custom: { anzahl: "abc" } }, [...defs]);
  assertEquals(bad.custom, { anzahl: "abc" }); // unlesbar bleibt Text; das Backend meldet den Fehler
});

import { matchesFileState } from "./asset-view-logic.ts";

Deno.test("matchesFileState: Dateifilter (Kapitel 86)", () => {
  assertEquals(matchesFileState("", "missing"), true);
  assertEquals(matchesFileState(undefined, undefined), true);
  assertEquals(matchesFileState("problem", "missing"), true);
  assertEquals(matchesFileState("problem", "partial"), true);
  assertEquals(matchesFileState("problem", "unreachable"), true);
  assertEquals(matchesFileState("problem", "ok"), false);
  assertEquals(matchesFileState("ok", "ok"), true);
  assertEquals(matchesFileState("missing", "partial"), false);
  // ohne Angabe zum Asset (Modul aus / neu) gilt „nie geprüft“
  assertEquals(matchesFileState("unchecked", undefined), true);
  assertEquals(matchesFileState("ok", undefined), false);
});

Deno.test("TAMS-Verweise: URI lesen, Abspiel-Argumente bilden, Reader erkennen", () => {
  const F = "11111111-1111-4111-8111-111111111111";
  const G = "22222222-2222-4222-8222-222222222222";
  const uri = (f: string) => `tams://${f}?timerange=${encodeURIComponent("[1790000000:500_1790000060:0)")}`;
  assertEquals(parseTamsUri(uri(F)), { flowId: F, start: "1790000000:500", end: "1790000060:0" });
  assertEquals(parseTamsUri("tams://x?timerange=[1:0_2:0)"), null);
  assertEquals(parseTamsUri("file:///a.mxf"), null);
  assertEquals(parseTamsUri(`tams://${F}?timerange=%E0%A4%A`), null);
  const rep = (type: string, provider: string, u: string) => ({ id: "r", assetVersionId: "v", type, storage: { provider, uri: u }, createdAt: "" });
  assertEquals(tamsPlayArgs([rep("recorded", "filesystem", "/a.mxf")]), null);
  assertEquals(tamsPlayArgs([rep("tams-video", "tams", uri(F)), rep("tams-audio", "tams", uri(G))]), {
    videoFlow: F,
    audioFlow: G,
    start: "1790000000:500",
    end: "1790000060:0",
  });
  assertEquals(tamsPlayArgs([rep("tams-audio", "tams", uri(G))])?.videoFlow, "");
  assertEquals(hasTamsPlay({ methods: [{ name: "tams.stop" }, { name: "tams.play" }] }), true);
  assertEquals(hasTamsPlay({ methods: [] }), false);
  assertEquals(hasTamsPlay(null), false);
});
