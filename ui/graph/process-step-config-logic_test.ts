import { assertEquals } from "jsr:@std/assert@1";
import type { DraftDefinition } from "./process-editor-logic.ts";
import {
  ancestorsOf,
  branchLabelsFor,
  buildConcatArgs,
  buildConvertArgs,
  buildExtractAudioArgs,
  buildOverlayArgs,
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
  optionRangeBounds,
  parseGoDuration,
  parseRule,
  ruleToExpression,
  splitSeconds,
  toSeconds,
  triggerKinds,
  validateArgValue,
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
  assertEquals(ffOptionControlKind({ name: "-crf", type: "float", flags: "" }), "number"); // keine Grenzen bekannt
  assertEquals(ffOptionControlKind({ name: "-preset", type: "string", flags: "" }), "text");
});

Deno.test("ffOptionControlKind/optionRangeBounds: numeric options with BOTH bounds known become a slider (Kapitel 23, Schritt 1)", () => {
  const bounded: FFOption = { name: "-crf", type: "float", flags: "", min: "-1", max: "51" };
  assertEquals(ffOptionControlKind(bounded), "range");
  assertEquals(optionRangeBounds(bounded), { min: -1, max: 51, step: 0.52 });

  const intBounded: FFOption = { name: "-qp", type: "int", flags: "", min: "0", max: "63" };
  assertEquals(optionRangeBounds(intBounded), { min: 0, max: 63, step: 1 });

  // Nur EINE Grenze reicht nicht — ein Regler ohne Ober- oder Untergrenze
  // wäre nicht sinnvoll begrenzbar, bleibt Freitext.
  assertEquals(ffOptionControlKind({ name: "-x", type: "int", flags: "", min: "0" }), "number");
  assertEquals(ffOptionControlKind({ name: "-x", type: "int", flags: "", max: "10" }), "number");
  assertEquals(optionRangeBounds({ name: "-x", type: "int", flags: "", min: "0" }), null);

  // Wahlmöglichkeiten (choices) gehen vor — auch ein numerischer Typ mit
  // festen Werten bleibt <select>, kein Regler.
  assertEquals(ffOptionControlKind({ name: "-preset", type: "int", flags: "", min: "0", max: "9", choices: [{ name: "fast" }] }), "select");
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

Deno.test("buildConvertArgs inserts -filter_complex + one -map per output label right after -i, before codec flags", () => {
  const args = buildConvertArgs({
    inputPath: "in.mp4",
    outputPath: "out.mp4",
    videoCodec: "libx264",
    filterComplex: "[0:v]scale=w=640[s0]",
    filterOutputLabels: ["s0"],
  });
  assertEquals(args, ["-y", "-i", "in.mp4", "-filter_complex", "[0:v]scale=w=640[s0]", "-map", "[s0]", "-c:v", "libx264", "out.mp4"]);
});

Deno.test("buildConvertArgs: additional inputs (for multi-source filter graphs like amix) become their own -i, before -filter_complex", () => {
  const args = buildConvertArgs({
    inputPath: "0.wav",
    outputPath: "out.wav",
    additionalInputPaths: ["1.wav", "2.wav"],
    filterComplex: "[0:a][1:a][2:a]amix=inputs=3[s0]",
    filterOutputLabels: ["s0"],
  });
  assertEquals(args, [
    "-y", "-i", "0.wav", "-i", "1.wav", "-i", "2.wav",
    "-filter_complex", "[0:a][1:a][2:a]amix=inputs=3[s0]", "-map", "[s0]",
    "out.wav",
  ]);
});

Deno.test("buildConvertArgs omits codec/format flags entirely when left unset (audio-only or container-inferred conversion)", () => {
  assertEquals(buildConvertArgs({ inputPath: "in.mov", outputPath: "out.mkv" }), ["-y", "-i", "in.mov", "out.mkv"]);
});

Deno.test("buildExtractAudioArgs always sends -vn and keeps the input/output order stable", () => {
  const args = buildExtractAudioArgs({ inputPath: "in.mp4", outputPath: "out.wav", audioCodec: "pcm_s24le", audioOptions: { "-ar": "48000" } });
  assertEquals(args, ["-y", "-i", "in.mp4", "-vn", "-c:a", "pcm_s24le", "-ar", "48000", "out.wav"]);
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

// ---- Clips aneinanderhängen (Kapitel 23, Schritt 2) -----------------------------------------------

Deno.test("buildConcatArgs: trims only the clips that have trim points, always resets pts, joins via the concat filter", () => {
  const args = buildConcatArgs({
    outputPath: "out.mp4",
    clips: [{ inputPath: "a.mp4" }, { inputPath: "b.mp4", trimStart: "5", trimEnd: "10" }],
  });
  assertEquals(args, [
    "-y", "-i", "a.mp4", "-i", "b.mp4",
    "-filter_complex",
    "[0:v]setpts=PTS-STARTPTS[v0];[0:a]asetpts=PTS-STARTPTS[a0];" +
      "[1:v]trim=start=5:end=10,setpts=PTS-STARTPTS[v1];[1:a]atrim=start=5:end=10,asetpts=PTS-STARTPTS[a1];" +
      "[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]",
    "-map", "[outv]", "-map", "[outa]",
    "out.mp4",
  ]);
});

Deno.test("buildConcatArgs: codec/format options land after the map flags, before the output path", () => {
  const args = buildConcatArgs({
    outputPath: "out.mkv",
    format: "matroska",
    videoCodec: "libx264",
    audioCodec: "aac",
    clips: [{ inputPath: "a.mp4" }, { inputPath: "b.mp4" }, { inputPath: "c.mp4" }],
  });
  assertEquals(args.slice(-7), ["-c:v", "libx264", "-c:a", "aac", "-f", "matroska", "out.mkv"]);
});

// ---- Zeitgesteuerte Overlays (Kapitel 23, Schritt 4) ----------------------------------------------

Deno.test("buildOverlayArgs: a text event escapes colons for drawtext and applies the timeline enable expression", () => {
  const args = buildOverlayArgs({
    inputPath: "in.mp4",
    outputPath: "out.mp4",
    events: [{ kind: "text", text: "Hallo:Welt", startSeconds: 1, endSeconds: 5 }],
  });
  assertEquals(args, [
    "-y", "-i", "in.mp4",
    "-filter_complex",
    "[0:v]drawtext=text='Hallo\\:Welt':x=(w-text_w)/2:y=h-text_h-20:enable='between(t,1,5)'[v0]",
    "-map", "[v0]", "-map", "0:a?",
    "out.mp4",
  ]);
});

Deno.test("buildOverlayArgs: an image event becomes its own -i input, chained after any preceding event", () => {
  const args = buildOverlayArgs({
    inputPath: "in.mp4",
    outputPath: "out.mp4",
    events: [
      { kind: "text", text: "Intro", startSeconds: 0, endSeconds: 2 },
      { kind: "image", imagePath: "logo.png", startSeconds: 0, endSeconds: 9999, x: "10", y: "10" },
    ],
  });
  assertEquals(args.slice(0, 5), ["-y", "-i", "in.mp4", "-i", "logo.png"]);
  const fc = args[args.indexOf("-filter_complex") + 1];
  assertEquals(fc.includes("[v0][1:v]overlay=x=10:y=10:enable='between(t,0,9999)'[v1]"), true);
  assertEquals(args.slice(-5), ["-map", "[v1]", "-map", "0:a?", "out.mp4"]);
});

// ---- Pro-Modus: globale Flags + Validierung (Kapitel 23, Schritt 5) -------------------------------

Deno.test("validateArgValue: known global flags are checked by type, unknown flags pass through untouched", () => {
  assertEquals(validateArgValue("-y", ""), { ok: true });
  assertEquals(validateArgValue("-y", "true").ok, false); // -y nimmt keinen Wert
  assertEquals(validateArgValue("-loglevel", "debug"), { ok: true });
  assertEquals(validateArgValue("-loglevel", "bogus").ok, false);
  assertEquals(validateArgValue("-ar", "48000"), { ok: true });
  assertEquals(validateArgValue("-ar", "abc").ok, false);
  assertEquals(validateArgValue("-ss", "00:01:23.5"), { ok: true });
  assertEquals(validateArgValue("-ss", "5"), { ok: true });
  assertEquals(validateArgValue("-ss", "abc").ok, false);
  assertEquals(validateArgValue("-some-unknown-flag", "anything"), { ok: true });
});

Deno.test("validateArgValue: a dynamically looked-up AVOption (from the parameter explorer) is checked against its own type/range/choices", () => {
  const dyn = new Map<string, FFOption>([
    ["-crf", { name: "-crf", type: "float", flags: "", min: "-1", max: "51" }],
    ["-preset", { name: "-preset", type: "string", flags: "", choices: [{ name: "fast" }, { name: "slow" }] }],
  ]);
  assertEquals(validateArgValue("-crf", "30", dyn), { ok: true });
  assertEquals(validateArgValue("-crf", "999", dyn).ok, false);
  assertEquals(validateArgValue("-preset", "fast", dyn), { ok: true });
  assertEquals(validateArgValue("-preset", "ludicrous", dyn).ok, false);
});
