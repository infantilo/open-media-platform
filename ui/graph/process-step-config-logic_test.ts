import { assertEquals } from "jsr:@std/assert@1";
import type { DraftDefinition } from "./process-editor-logic.ts";
import {
  ancestorsOf,
  branchLabelsFor,
  buildConvertArgs,
  buildExtractAudioArgs,
  buildMultitrackArgs,
  buildProbeArgs,
  buildThumbnailArgs,
  ffOptionControlKind,
  type FFOption,
  flatStringObject,
  formatGoDuration,
  insertionText,
  missingConfig,
  optionEntriesToArgs,
  optionHelpText,
  parseGoDuration,
  parseRule,
  ruleToExpression,
  splitSeconds,
  toSeconds,
  triggerKinds,
  variableOptions,
} from "./process-step-config-logic.ts";

const def: DraftDefinition = {
  startStepId: "probe",
  steps: [
    { id: "probe", type: "script", next: ["check"] },
    { id: "check", type: "condition", branches: { true: "ok-path", false: "review" } },
    { id: "review", type: "approval", branches: { approved: "ok-path" } },
    { id: "ok-path", type: "service_call" },
    { id: "unrelated", type: "wait" },
  ],
};

Deno.test("ancestorsOf follows next+branches backwards, in graph order, excluding self and unrelated steps", () => {
  assertEquals(ancestorsOf(def, "ok-path"), ["probe", "check", "review"]);
  assertEquals(ancestorsOf(def, "probe"), []);
  assertEquals(ancestorsOf(def, "unrelated"), []);
});

Deno.test("variableOptions offers trigger input, upstream outputs (bracket syntax for non-identifier ids) and workflow meta", () => {
  const opts = variableOptions(def, "ok-path", [{ path: "assetId", label: "Asset-ID" }]);
  const paths = opts.map((o) => o.path);
  assertEquals(paths.includes("input.assetId"), true);
  assertEquals(paths.includes("outputs.probe.stdout"), true);
  assertEquals(paths.includes("outputs.review.decision"), true);
  assertEquals(paths.includes("workflow.executionId"), true);
  assertEquals(paths.some((p) => p.startsWith("outputs.unrelated")), false);
  const d2: DraftDefinition = { startStepId: "a-b", steps: [{ id: "a-b", type: "script", next: ["c"] }, { id: "c", type: "wait" }] };
  assertEquals(variableOptions(d2, "c", []).some((o) => o.path === 'outputs["a-b"].exitCode'), true);
  assertEquals(insertionText("input.x", "template"), "${input.x}");
  assertEquals(insertionText("input.x", "expression"), "input.x");
});

Deno.test("rule builder round-trips and quotes strings, leaves free expressions alone", () => {
  const e = ruleToExpression({ variable: "outputs.review.decision", op: "==", value: "approved" });
  assertEquals(e, 'outputs.review.decision == "approved"');
  assertEquals(parseRule(e), { variable: "outputs.review.decision", op: "==", value: "approved" });
  assertEquals(ruleToExpression({ variable: "outputs.probe.exitCode", op: ">=", value: "1" }), "outputs.probe.exitCode >= 1");
  assertEquals(parseRule("outputs.probe.exitCode >= 1"), { variable: "outputs.probe.exitCode", op: ">=", value: "1" });
  assertEquals(parseRule('input.title contains "News"'), { variable: "input.title", op: "contains", value: "News" });
  assertEquals(parseRule("a > 1 && b < 2"), null);
  assertEquals(parseRule("len(input.x) > 3"), null);
});

Deno.test("branchLabelsFor returns the labels the step really produces", () => {
  assertEquals(branchLabelsFor({ id: "c", type: "condition" }), ["true", "false"]);
  assertEquals(branchLabelsFor({ id: "c", type: "condition", config: { trueLabel: "ok", falseLabel: "nok" } }), ["ok", "nok"]);
  assertEquals(
    branchLabelsFor({ id: "b", type: "branch", config: { cases: [{ label: "hd" }, { label: "sd" }], defaultLabel: "other" } }),
    ["hd", "sd", "other"],
  );
  assertEquals(branchLabelsFor({ id: "a", type: "approval" }), ["approved", "rejected", "changes_requested"]);
  assertEquals(branchLabelsFor({ id: "w", type: "wait" }), []);
});

Deno.test("durations: seconds split/join and Go duration strings", () => {
  assertEquals(splitSeconds(120), { value: "2", unit: "m" });
  assertEquals(splitSeconds(90), { value: "90", unit: "s" });
  assertEquals(splitSeconds(7200), { value: "2", unit: "h" });
  assertEquals(toSeconds("1,5", "m"), 90);
  assertEquals(toSeconds("", "s"), undefined);
  assertEquals(toSeconds("x", "s"), null);
  assertEquals(parseGoDuration("1m30s"), 90);
  assertEquals(parseGoDuration("500ms"), null);
  assertEquals(formatGoDuration(90), "1m30s");
  assertEquals(formatGoDuration(3600), "1h");
});

Deno.test("flatStringObject only accepts flat string maps", () => {
  assertEquals(flatStringObject({ a: "1" }), [["a", "1"]]);
  assertEquals(flatStringObject(undefined), []);
  assertEquals(flatStringObject({ a: 1 }), null);
  assertEquals(flatStringObject([1]), null);
});

Deno.test("missingConfig mirrors the executors' required fields", () => {
  assertEquals(missingConfig({ id: "s", type: "service_call" }), "Adresse (URL) fehlt");
  assertEquals(missingConfig({ id: "s", type: "service_call", config: { url: "http://x" } }), null);
  assertEquals(missingConfig({ id: "m", type: "media_function", config: { instanceId: "i" } }), "Node/Funktion fehlt");
  assertEquals(missingConfig({ id: "p", type: "parallel" }), null);
});

Deno.test("triggerKinds maps asset events to subjects with a wildcard asset id", () => {
  const kinds = triggerKinds(["ready"], (s) => s.toUpperCase());
  const ready = kinds.find((k) => k.id === "asset.status.ready")!;
  assertEquals(ready.subject, "omp.asset.*.ready");
  assertEquals(ready.label, "Asset wechselt auf „READY“");
  assertEquals(kinds[0].subject, "omp.asset.*.created");
});

// ---- ffmpeg-Assistent (Kapitel 22, W2) ----------------------------------------------------------

Deno.test("ffOptionControlKind classifies AVOptions by type/choices", () => {
  const withChoices: FFOption = { name: "-preset", type: "int", flags: "", choices: [{ name: "fast" }] };
  assertEquals(ffOptionControlKind(withChoices), "select");

  const flagsType: FFOption = { name: "-flags", type: "flags", flags: "", choices: [{ name: "+global_header" }] };
  assertEquals(ffOptionControlKind(flagsType), "text"); // kombinierbar, kein exklusives <select>

  assertEquals(ffOptionControlKind({ name: "-b", type: "boolean", flags: "" }), "checkbox");
  assertEquals(ffOptionControlKind({ name: "-crf", type: "float", flags: "" }), "number");
  assertEquals(ffOptionControlKind({ name: "-preset", type: "string", flags: "" }), "text");
});

Deno.test("optionHelpText composes description/range/default, and lists choices only for flags-type options", () => {
  const opt: FFOption = { name: "-crf", type: "float", flags: "", description: "Quality", min: "-1", max: "51", default: "-1" };
  assertEquals(optionHelpText(opt), "Quality — Bereich: -1 bis 51 — Standard: -1");

  const flagsOpt: FFOption = { name: "-flags", type: "flags", flags: "", choices: [{ name: "a" }, { name: "b" }] };
  assertEquals(optionHelpText(flagsOpt), 'Mögliche Werte (kombinierbar mit "+", z. B. a+b): a, b');

  const selectOpt: FFOption = { name: "-preset", type: "int", flags: "", choices: [{ name: "fast" }] };
  assertEquals(optionHelpText(selectOpt), ""); // Choices erscheinen im <select>, nicht nochmal im Hilfetext
});

Deno.test("optionEntriesToArgs skips untouched (empty) fields — ffmpeg's own default applies", () => {
  assertEquals(optionEntriesToArgs({ "-crf": "23", "-preset": "" }), ["-crf", "23"]);
  assertEquals(optionEntriesToArgs({}), []);
});

Deno.test("buildConvertArgs orders -i before codec/options, format before the output path", () => {
  const args = buildConvertArgs({
    inputPath: "${input.path}",
    outputPath: "${input.outputPath}",
    format: "mp4",
    videoCodec: "libx264",
    videoOptions: { "-crf": "23", "-preset": "veryfast" },
    audioCodec: "aac",
    audioOptions: { "-b:a": "128k" },
  });
  assertEquals(args, [
    "-y",
    "-i",
    "${input.path}",
    "-c:v",
    "libx264",
    "-crf",
    "23",
    "-preset",
    "veryfast",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-f",
    "mp4",
    "${input.outputPath}",
  ]);
});

Deno.test("buildConvertArgs omits codec/format flags entirely when left unset (audio-only or container-inferred conversion)", () => {
  assertEquals(buildConvertArgs({ inputPath: "in.mov", outputPath: "out.mkv" }), ["-y", "-i", "in.mov", "out.mkv"]);
});

Deno.test("buildExtractAudioArgs always sends -vn and keeps the input/output order stable", () => {
  const args = buildExtractAudioArgs({ inputPath: "in.mp4", outputPath: "out.wav", audioCodec: "pcm_s24le", audioOptions: { "-ar": "48000" } });
  assertEquals(args, ["-y", "-i", "in.mp4", "-vn", "-c:a", "pcm_s24le", "-ar", "48000", "out.wav"]);
});

Deno.test("buildMultitrackArgs: das Nutzerbeispiel — mehrere separate Dateien, je eine Tonspur mit eigenem Codec/Titel/Sprache", () => {
  const args = buildMultitrackArgs({
    outputPath: "out.mxf",
    format: "mxf",
    tracks: [
      { inputPath: "de.wav", codec: "pcm_s16le", language: "deu", title: "Deutsch" },
      { inputPath: "en.wav", codec: "pcm_s16le", language: "eng", title: "English" },
    ],
  });
  assertEquals(args, [
    "-y",
    "-i",
    "de.wav",
    "-i",
    "en.wav",
    "-map",
    "0:a",
    "-map",
    "1:a",
    "-c:a:0",
    "pcm_s16le",
    "-metadata:s:a:0",
    "title=Deutsch",
    "-metadata:s:a:0",
    "language=deu",
    "-c:a:1",
    "pcm_s16le",
    "-metadata:s:a:1",
    "title=English",
    "-metadata:s:a:1",
    "language=eng",
    "-f",
    "mxf",
    "out.mxf",
  ]);
});

Deno.test("buildMultitrackArgs maps the video track from the first input when includeVideo is set, before the audio maps", () => {
  const args = buildMultitrackArgs({
    outputPath: "out.mkv",
    includeVideo: true,
    tracks: [{ inputPath: "a.mkv", codec: "aac" }, { inputPath: "b.wav", codec: "aac" }],
  });
  assertEquals(args.slice(0, 4), ["-y", "-i", "a.mkv", "-i"]);
  assertEquals(args.includes("-map"), true);
  const mapIdx = args.indexOf("-map");
  assertEquals(args.slice(mapIdx, mapIdx + 8), ["-map", "0:v", "-c:v", "copy", "-map", "0:a", "-map", "1:a"]);
});

Deno.test("buildProbeArgs matches the fixed ffprobe JSON invocation", () => {
  assertEquals(buildProbeArgs({ inputPath: "${input.path}" }), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "${input.path}"]);
});

Deno.test("buildThumbnailArgs scales by width, keeps aspect ratio via -2", () => {
  assertEquals(
    buildThumbnailArgs({ inputPath: "in.mp4", outputPath: "out.jpg", atTime: "00:00:05", widthPixels: 480 }),
    ["-y", "-ss", "00:00:05", "-i", "in.mp4", "-frames:v", "1", "-vf", "scale=480:-2", "out.jpg"],
  );
});

Deno.test("buildMultitrackArgs passes muxer-level options right before -f/output path", () => {
  const args = buildMultitrackArgs({
    outputPath: "out.mxf",
    format: "mxf",
    muxerOptions: { "-signal_standard": "bt601" },
    tracks: [{ inputPath: "a.wav" }],
  });
  assertEquals(args.slice(-5, -1), ["-signal_standard", "bt601", "-f", "mxf"]);
  assertEquals(args.at(-1), "out.mxf");
});
