import { assertEquals } from "jsr:@std/assert";
import {
  type AudioRulesDoc, channelNames, cleanDoc, hasBitExact, monoTracks, moveItem, parseSourceText, parseTags, setBitExact, slug, sourceText, specSummary,
  toggleTrack, trackRowCount, uniqueId, chainParam, setChainParam, type SourceSpec, planRows, simulatedSource, type AudioPlan,
} from "./audio-rules-logic.ts";

Deno.test("Kanalnamen: Standard je Layout, eigene Namen gewinnen", () => {
  assertEquals(channelNames("5.1", undefined), ["L", "R", "C", "LFE", "Ls", "Rs"]);
  assertEquals(channelNames("stereo", []), ["L", "R"]);
  assertEquals(channelNames("custom", ["A", "B", "C"]), ["A", "B", "C"]);
});

Deno.test("Tags und Quelltext lassen sich lesen und zurückschreiben", () => {
  assertEquals(parseTags("role:pt,  lang:de bitexact"), ["role:pt", "lang:de", "bitexact"]);
  assertEquals(parseSourceText("1, 2"), { tracks: [1, 2] });
  assertEquals(parseSourceText("role:pt AND layout:stereo"), { select: "role:pt AND layout:stereo" });
  assertEquals(parseSourceText("  "), undefined);
  assertEquals(sourceText({ tracks: [3, 0] }), "3, 0");
  assertEquals(sourceText({ select: "role:ad" }), "role:ad");
});

Deno.test("bit-exakt-Tag ein-/ausschalten", () => {
  assertEquals(setBitExact(["role:x"], true), ["role:x", "bitexact"]);
  assertEquals(setBitExact(["BitExact", "role:x"], false), ["role:x"]);
  assertEquals(hasBitExact(["x", "bitexact"]), true);
});

Deno.test("Matrix-Klick: eine Spur je Kanal, erneuter Klick leert", () => {
  let s = toggleTrack(undefined, 0, 3, 2);
  assertEquals(s.tracks, [3, 0]);
  s = toggleTrack(s, 1, 4, 2);
  assertEquals(s.tracks, [3, 4]);
  s = toggleTrack(s, 0, 5, 2);
  assertEquals(s.tracks, [5, 4]);
  s = toggleTrack(s, 0, 5, 2);
  assertEquals(s.tracks, [0, 4]);
  // Wechsel von Tag-Auswahl auf Spurliste verwirft `select`, behält `via`.
  assertEquals(toggleTrack({ select: "x", via: "upmix51" }, 0, 1, 1), { tracks: [1], via: "upmix51" });
});

Deno.test("Spurzeilen: Schema, Mindestwert und genutzte Spuren", () => {
  assertEquals(trackRowCount(0, undefined), 8);
  assertEquals(trackRowCount(16, undefined), 16);
  assertEquals(trackRowCount(4, { id: "m", groups: { a: { tracks: [1, 12] } } }), 12);
});

Deno.test("IDs: Kurzname, eindeutig, mit Umlauten", () => {
  assertEquals(slug("Hörfilm / AD"), "horfilm-ad");
  assertEquals(uniqueId("Stereo", ["stereo"]), "stereo-2");
  assertEquals(uniqueId("Stereo", ["stereo", "stereo-2"]), "stereo-3");
  assertEquals(uniqueId("###", []), "neu");
});

Deno.test("Umsortieren bleibt in den Grenzen", () => {
  assertEquals(moveItem([1, 2, 3], 0, -1), [1, 2, 3]);
  assertEquals(moveItem([1, 2, 3], 0, 1), [2, 1, 3]);
  assertEquals(moveItem([1, 2, 3], 2, 1), [1, 2, 3]);
});

Deno.test("Zusammenfassung einer Quellvorgabe", () => {
  assertEquals(specSummary({ tracks: [1, 0] }), "Spur 1, –");
  assertEquals(specSummary({ select: "role:pt", via: "upmix51" }), "role:pt · Upmix Stereo → 5.1");
  assertEquals(specSummary(undefined), "—");
  assertEquals(monoTracks(2), [{ n: 1, layout: "mono", tags: ["pos:1"] }, { n: 2, layout: "mono", tags: ["pos:2"] }]);
});

Deno.test("cleanDoc entfernt Leerfelder, die der Server ablehnt", () => {
  const doc: AudioRulesDoc = {
    outputProfile: { groups: [{ id: "pt", label: "", layout: "stereo", tags: [], default: { select: "" } }] },
    trackSchemas: [{ id: "s", match: { format: "mxf", tracks: 0, path: "" }, tracks: [{ n: 1, layout: "", tags: [] }] }],
    mappings: [{ id: "m", groups: { pt: { tracks: [1, 2] } } }],
    ruleSet: { rules: [{ id: "", group: "pt", when: { missing: "", has: "a" }, then: [{ use: { select: "x", via: "" } }, { silence: true, warn: "" }] }] },
  };
  const c = cleanDoc(doc);
  assertEquals(c.outputProfile.groups[0], { id: "pt", label: "pt", layout: "stereo" });
  assertEquals(c.trackSchemas[0], { id: "s", match: { format: "mxf" }, tracks: [{ n: 1, layout: "mono" }] });
  assertEquals(c.ruleSet.rules[0], { group: "pt", when: { has: "a" }, then: [{ use: { select: "x" } }, { silence: true }] });
});

Deno.test("Gain/Delay: setzen, lesen, mit 0 oder leer entfernen", () => {
  const spec: SourceSpec = { select: "role:pt" };
  setChainParam(spec, "gain", "db", -3);
  setChainParam(spec, "delay", "ms", 40);
  assertEquals(chainParam(spec, "gain", "db"), -3);
  assertEquals(chainParam(spec, "delay", "ms"), 40);
  setChainParam(spec, "gain", "db", -6);
  assertEquals(spec.chain?.length, 2);
  assertEquals(chainParam(spec, "gain", "db"), -6);
  setChainParam(spec, "gain", "db", 0);
  setChainParam(spec, "delay", "ms", undefined);
  assertEquals(spec.chain, undefined);
});

Deno.test("Plan-Zeilen: Spuren, Mischung, Ersatzregel, still", () => {
  const plan: AudioPlan = {
    src_channels: [{ track: 1, name: "L" }, { track: 1, name: "R" }],
    ok: true, warnings: [],
    groups: [
      { group: "pt", matrix: [[1, 0], [0, 1]], silent: false, failed: false, warnings: [] },
      { group: "s51", matrix: [[1, 0], [0, 1], [0.5, 0.5]], silent: false, failed: false, rule: "51-aus-stereo", warnings: [] },
      { group: "ad", matrix: [[0, 0], [0, 0]], silent: true, failed: false, warnings: [] },
    ],
  };
  const rows = planRows(plan, (id) => id.toUpperCase());
  assertEquals(rows.map((r) => r.text), ["Spur 1", "Spur 1 (gemischt/umgerechnet) · Ersatz per Regel „51-aus-stereo“", "still"]);
  assertEquals(rows.map((r) => r.tone), ["ok", "rule", "silent"]);
});

Deno.test("Testquellen: Live-Varianten und N Mono-Spuren", () => {
  assertEquals(simulatedSource("live-51", 0).tracks[0].layout, "5.1");
  assertEquals(simulatedSource("mono-n", 4).tracks.length, 4);
  assertEquals(simulatedSource("schema", 0, { id: "s", match: {}, tracks: [{ n: 1 }] }).tracks.length, 1);
  assertEquals(simulatedSource("live-stereo", 0).kind, "live");
});
