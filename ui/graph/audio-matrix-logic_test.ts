import { assertEquals } from "jsr:@std/assert@1";
import { applyDownmixPreset, channelLabel, channelLayoutChannelCount, compileAudioMatrix, DOWNMIX_PRESETS, downmixPresetsForLayout } from "./audio-matrix-logic.ts";

Deno.test("compileAudioMatrix: a single cell extracts the channel, skips volume/adelay at defaults, terminates via anull", () => {
  const r = compileAudioMatrix({
    sources: [{ inputPath: "a.wav", channelCount: 2 }],
    outputCount: 1,
    cells: [{ sourceIndex: 0, channelIndex: 0, outputIndex: 0, gainPercent: 100, delayMs: 0 }],
  });
  assertEquals(r.filterComplex, "[0:a]pan=mono|c0=c0[ext0_0_0];[ext0_0_0]anull[mxout0]");
  assertEquals(r.outputLabels, ["mxout0"]);
  assertEquals(r.additionalInputPaths, []);
});

Deno.test("compileAudioMatrix: non-default gain adds a volume stage, a delay adds adelay, in that order", () => {
  const r = compileAudioMatrix({
    sources: [{ inputPath: "a.wav", channelCount: 2 }],
    outputCount: 1,
    cells: [{ sourceIndex: 0, channelIndex: 1, outputIndex: 0, gainPercent: 50, delayMs: 20 }],
  });
  assertEquals(r.filterComplex, "[0:a]pan=mono|c0=c1[ext0_1_0];[ext0_1_0]volume=0.5000[g0_1_0];[g0_1_0]adelay=20|all=1[d0_1_0];[d0_1_0]anull[mxout0]");
});

Deno.test("compileAudioMatrix: two cells feeding the same output are combined with amix, one label per source channel each", () => {
  const r = compileAudioMatrix({
    sources: [{ inputPath: "a.wav", channelCount: 1 }, { inputPath: "b.wav", channelCount: 1 }],
    outputCount: 1,
    cells: [
      { sourceIndex: 0, channelIndex: 0, outputIndex: 0, gainPercent: 100, delayMs: 0 },
      { sourceIndex: 1, channelIndex: 0, outputIndex: 0, gainPercent: 100, delayMs: 0 },
    ],
  });
  assertEquals(
    r.filterComplex,
    "[0:a]pan=mono|c0=c0[ext0_0_0];[1:a]pan=mono|c0=c0[ext1_0_0];[ext0_0_0][ext1_0_0]amix=inputs=2:duration=longest:dropout_transition=0[mxout0]",
  );
  assertEquals(r.additionalInputPaths, ["b.wav"]);
});

Deno.test("compileAudioMatrix: an output with no contributing cell is skipped entirely — no silent placeholder track", () => {
  const r = compileAudioMatrix({
    sources: [{ inputPath: "a.wav", channelCount: 2 }],
    outputCount: 3,
    cells: [{ sourceIndex: 0, channelIndex: 0, outputIndex: 1, gainPercent: 100, delayMs: 0 }],
  });
  assertEquals(r.outputLabels, ["mxout1"]);
});

Deno.test("compileAudioMatrix: a cell with gainPercent 0 (or below) is ignored, same as not routed", () => {
  const r = compileAudioMatrix({
    sources: [{ inputPath: "a.wav", channelCount: 2 }],
    outputCount: 1,
    cells: [{ sourceIndex: 0, channelIndex: 0, outputIndex: 0, gainPercent: 0, delayMs: 0 }],
  });
  assertEquals(r.filterComplex, "");
  assertEquals(r.outputLabels, []);
});

// ---- Kanal-Layout-Labels + Downmix-Vorlagen (Kapitel 25 R2) ------------------------------------

Deno.test("channelLabel: known layouts return real channel names, unknown index/custom falls back to 'Kanal N'", () => {
  assertEquals(channelLabel("stereo", 0), "L");
  assertEquals(channelLabel("stereo", 1), "R");
  assertEquals(channelLabel("5.1", 2), "C");
  assertEquals(channelLabel("5.1", 3), "LFE");
  assertEquals(channelLabel("5.1", 5), "Rs");
  assertEquals(channelLabel("custom", 0), "Kanal 1");
  assertEquals(channelLabel("stereo", 5), "Kanal 6"); // außerhalb des bekannten Layouts
});

Deno.test("channelLayoutChannelCount matches each layout's real channel count", () => {
  assertEquals(channelLayoutChannelCount("mono"), 1);
  assertEquals(channelLayoutChannelCount("stereo"), 2);
  assertEquals(channelLayoutChannelCount("5.1"), 6);
  assertEquals(channelLayoutChannelCount("7.1"), 8);
  assertEquals(channelLayoutChannelCount("custom"), 0);
});

Deno.test("downmixPresetsForLayout: only presets matching the given source layout are offered", () => {
  assertEquals(downmixPresetsForLayout("mono").map((p) => p.id), ["mono-to-stereo"]);
  assertEquals(downmixPresetsForLayout("stereo").map((p) => p.id), ["stereo-to-mono"]);
  assertEquals(downmixPresetsForLayout("5.1").map((p) => p.id), ["5.1-to-stereo"]);
  assertEquals(downmixPresetsForLayout("7.1"), []);
  assertEquals(downmixPresetsForLayout(undefined), []);
});

Deno.test("applyDownmixPreset: 5.1-to-stereo routes L/R at full gain and C/Ls/Rs at -3dB into the two outputs, offset by outputStart", () => {
  const preset = DOWNMIX_PRESETS.find((p) => p.id === "5.1-to-stereo")!;
  const cells = applyDownmixPreset(preset, 2, 3);
  assertEquals(cells, [
    { sourceIndex: 2, channelIndex: 0, outputIndex: 3, gainPercent: 100, delayMs: 0 },
    { sourceIndex: 2, channelIndex: 2, outputIndex: 3, gainPercent: 70.7, delayMs: 0 },
    { sourceIndex: 2, channelIndex: 4, outputIndex: 3, gainPercent: 70.7, delayMs: 0 },
    { sourceIndex: 2, channelIndex: 1, outputIndex: 4, gainPercent: 100, delayMs: 0 },
    { sourceIndex: 2, channelIndex: 2, outputIndex: 4, gainPercent: 70.7, delayMs: 0 },
    { sourceIndex: 2, channelIndex: 5, outputIndex: 4, gainPercent: 70.7, delayMs: 0 },
  ]);
});

Deno.test("applyDownmixPreset output feeds straight into compileAudioMatrix (presets produce compiler-valid cells)", () => {
  const preset = DOWNMIX_PRESETS.find((p) => p.id === "stereo-to-mono")!;
  const cells = applyDownmixPreset(preset, 0, 0);
  const r = compileAudioMatrix({ sources: [{ inputPath: "a.wav", channelCount: 2, layout: "stereo" }], outputCount: 1, cells });
  assertEquals(r.outputLabels, ["mxout0"]);
  assertEquals(r.filterComplex.includes("amix=inputs=2"), true);
});
