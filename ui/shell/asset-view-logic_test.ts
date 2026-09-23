import { assertEquals } from "jsr:@std/assert@1";
import {
  type Asset,
  filterAssets,
  formatBitrate,
  formatBytes,
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
