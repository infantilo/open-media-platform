import { assertEquals } from "jsr:@std/assert@1";
import { compileAudioMatrix } from "./audio-matrix-logic.ts";

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
