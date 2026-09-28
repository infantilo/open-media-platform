import { assertEquals } from "jsr:@std/assert@1";
import type { DraftDefinition } from "./process-editor-logic.ts";
import {
  ancestorsOf,
  branchLabelsFor,
  buildConcatArgs,
  buildConvertArgs,
  buildExtractAudioArgs,
  buildHlsLadderArgs,
  buildLoudnormArgs,
  buildOverlayArgs,
  buildProbeArgs,
  buildRemuxCopyArgs,
  buildThumbnailArgs,
  ffOptionControlKind,
  type FFOption,
  flatStringObject,
  formatGoDuration,
  globalOptionEntryToFlagDef,
  insertionText,
  isFuzzyMatch,
  levenshteinDistance,
  missingConfig,
  optionEntriesToArgs,
  optionHelpText,
  optionRangeBounds,
  parseGoDuration,
  parseRule,
  ruleToExpression,
  searchEntries,
  splitSeconds,
  toSeconds,
  triggerKinds,
  validateArgValue,
  variableOptions,
  genericScriptTaskById,
  GENERIC_SCRIPT_TASKS,
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

// ---- Generisches Ausgabespur-Mapping (Kapitel 23, Schritt 2) --------------------------------------

Deno.test("buildConvertArgs: output tracks fully take over mapping, plain video/audio codec fields are ignored once present", () => {
  const args = buildConvertArgs({
    inputPath: "de.wav",
    outputPath: "out.mxf",
    videoCodec: "should-be-ignored",
    audioCodec: "should-also-be-ignored",
    additionalInputPaths: ["en.wav"],
    outputTracks: [
      { source: "0:a:0", mediaType: "audio", codec: "pcm_s16le", metadata: { title: "Deutsch", language: "deu" } },
      { source: "1:a:0", mediaType: "audio", codec: "pcm_s16le", metadata: { title: "English", language: "eng" } },
    ],
  });
  assertEquals(args, [
    "-y", "-i", "de.wav", "-i", "en.wav",
    "-map", "0:a:0", "-c:a:0", "pcm_s16le", "-metadata:s:a:0", "title=Deutsch", "-metadata:s:a:0", "language=deu",
    "-map", "1:a:0", "-c:a:1", "pcm_s16le", "-metadata:s:a:1", "title=English", "-metadata:s:a:1", "language=eng",
    "out.mxf",
  ]);
});

Deno.test("buildConvertArgs: per-media-type indices count independently (two audio + one video track → a:0/a:1/v:0)", () => {
  const args = buildConvertArgs({
    inputPath: "in.mp4",
    outputPath: "out.mkv",
    outputTracks: [
      { source: "0:a:0", mediaType: "audio", codec: "aac" },
      { source: "0:v:0", mediaType: "video", codec: "libx264" },
      { source: "1:a:0", mediaType: "audio", codec: "aac" },
    ],
  });
  assertEquals(args, [
    "-y", "-i", "in.mp4",
    "-map", "0:a:0", "-c:a:0", "aac",
    "-map", "0:v:0", "-c:v:0", "libx264",
    "-map", "1:a:0", "-c:a:1", "aac",
    "out.mkv",
  ]);
});

Deno.test("buildConvertArgs: a track's AVOptions get the same stream-specifier suffix as its codec flag", () => {
  const args = buildConvertArgs({
    inputPath: "in.mp4",
    outputPath: "out.mkv",
    outputTracks: [{ source: "0:a:0", mediaType: "audio", codec: "aac", options: { "-b": "192k" } }],
  });
  assertEquals(args.slice(-5, -1), ["-c:a:0", "aac", "-b:a:0", "192k"]);
});

Deno.test("buildConvertArgs: an output track can source from a filter-graph/audio-matrix label, and suppresses the automatic filterOutputLabels mapping", () => {
  const args = buildConvertArgs({
    inputPath: "in.wav",
    outputPath: "out.mkv",
    filterComplex: "[0:a]pan=mono|c0=c0[mxout0]",
    filterOutputLabels: ["mxout0"],
    outputTracks: [{ source: "[mxout0]", mediaType: "audio", codec: "aac" }],
  });
  assertEquals(args, ["-y", "-i", "in.wav", "-filter_complex", "[0:a]pan=mono|c0=c0[mxout0]", "-map", "[mxout0]", "-c:a:0", "aac", "out.mkv"]);
  // genau EIN "-map [mxout0]" — nicht zusätzlich das automatische aus filterOutputLabels
  assertEquals(args.filter((a) => a === "-map").length, 1);
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

// ---- Generische Aufgaben-Registry (Kapitel 25 R1) -------------------------------------------------
//
// Regressionstest: die generische Registry muss für dieselben Eingaben
// exakt dieselben Argumente liefern wie die zuvor bestehenden, jetzt
// entfernten bespoke Formulare (buildScriptWizardProbe/Thumbnail/
// ExtractAudio in process-step-config.ts) — die zugrundeliegenden
// build<X>Args-Funktionen selbst sind unverändert, hier wird nur die
// neue toArgs()-Verdrahtung (Feldnamen, Pflichtfeld-Prüfung) geprüft.

Deno.test("genericScriptTaskById: probe/thumbnail/extract_audio/loudnorm/remux_copy/hls_ladder are registered, convert/concat/overlay are not (still bespoke)", () => {
  assertEquals(GENERIC_SCRIPT_TASKS.map((t) => t.id).sort(), ["extract_audio", "hls_ladder", "loudnorm", "probe", "remux_copy", "thumbnail"]);
  assertEquals(genericScriptTaskById("convert"), undefined);
  assertEquals(genericScriptTaskById("concat"), undefined);
  assertEquals(genericScriptTaskById("overlay"), undefined);
});

Deno.test("generic 'probe' task: toArgs matches buildProbeArgs for the same input, errors when the file is missing", () => {
  const task = genericScriptTaskById("probe")!;
  assertEquals(task.command, "ffprobe");
  assertEquals(task.toArgs({ scalars: { inputPath: "${input.path}" }, pickers: {}, groups: {} }), {
    ok: true,
    args: buildProbeArgs({ inputPath: "${input.path}" }),
  });
  assertEquals(task.toArgs({ scalars: { inputPath: "" }, pickers: {}, groups: {} }), { ok: false, error: "Zu prüfende Datei fehlt." });
  assertEquals(task.toArgs({ scalars: { inputPath: "   " }, pickers: {}, groups: {} }), { ok: false, error: "Zu prüfende Datei fehlt." });
});

Deno.test("generic 'thumbnail' task: toArgs matches buildThumbnailArgs, validates width and required paths", () => {
  const task = genericScriptTaskById("thumbnail")!;
  assertEquals(task.command, "ffmpeg");
  assertEquals(
    task.toArgs({ scalars: { inputPath: "in.mp4", outputPath: "out.jpg", atTime: "00:00:05", widthPixels: "480" }, pickers: {}, groups: {} }),
    { ok: true, args: buildThumbnailArgs({ inputPath: "in.mp4", outputPath: "out.jpg", atTime: "00:00:05", widthPixels: 480 }) },
  );
  // Leeres Zeitfeld fällt auf denselben "00:00:05"-Standard zurück wie das
  // frühere bespoke Formular (textInput-Startwert war ebenfalls "00:00:05").
  assertEquals(
    task.toArgs({ scalars: { inputPath: "in.mp4", outputPath: "out.jpg", atTime: "", widthPixels: "480" }, pickers: {}, groups: {} }),
    { ok: true, args: buildThumbnailArgs({ inputPath: "in.mp4", outputPath: "out.jpg", atTime: "00:00:05", widthPixels: 480 }) },
  );
  assertEquals(task.toArgs({ scalars: { inputPath: "", outputPath: "out.jpg", atTime: "00:00:05", widthPixels: "480" }, pickers: {}, groups: {} }), {
    ok: false,
    error: "Eingabe- und Ausgabedatei sind Pflicht.",
  });
  assertEquals(task.toArgs({ scalars: { inputPath: "in.mp4", outputPath: "out.jpg", atTime: "00:00:05", widthPixels: "0" }, pickers: {}, groups: {} }), {
    ok: false,
    error: "Breite: keine gültige Zahl.",
  });
  assertEquals(task.toArgs({ scalars: { inputPath: "in.mp4", outputPath: "out.jpg", atTime: "00:00:05", widthPixels: "abc" }, pickers: {}, groups: {} }), {
    ok: false,
    error: "Breite: keine gültige Zahl.",
  });
});

Deno.test("generic 'extract_audio' task: toArgs matches buildExtractAudioArgs, works with and without a chosen codec", () => {
  const task = genericScriptTaskById("extract_audio")!;
  assertEquals(task.command, "ffmpeg");
  assertEquals(
    task.toArgs({ scalars: { inputPath: "in.mp4", outputPath: "out.wav" }, pickers: { audio: { codec: "pcm_s24le", options: { "-ar": "48000" } } }, groups: {} }),
    { ok: true, args: buildExtractAudioArgs({ inputPath: "in.mp4", outputPath: "out.wav", audioCodec: "pcm_s24le", audioOptions: { "-ar": "48000" } }) },
  );
  // Kein Picker-Eintrag (Nutzer hat den Codec nie geöffnet) verhält sich
  // wie ein leerer Codec — ffmpeg-Standard für die Dateiendung.
  assertEquals(
    task.toArgs({ scalars: { inputPath: "in.mp4", outputPath: "out.wav" }, pickers: {}, groups: {} }),
    { ok: true, args: buildExtractAudioArgs({ inputPath: "in.mp4", outputPath: "out.wav", audioCodec: undefined, audioOptions: {} }) },
  );
  assertEquals(task.toArgs({ scalars: { inputPath: "", outputPath: "out.wav" }, pickers: {}, groups: {} }), { ok: false, error: "Eingabe- und Ausgabedatei sind Pflicht." });
});

// ---- Radio/TV/Online-Vorlagen (Kapitel 25 R4) ------------------------------------------------------

Deno.test("buildLoudnormArgs: sets I/TP/LRA on the loudnorm filter, always copies video, omits -c:a when no codec chosen", () => {
  assertEquals(
    buildLoudnormArgs({ inputPath: "in.mp4", outputPath: "out.mp4", targetLufs: -23, truePeakDb: -2, loudnessRangeLu: 7 }),
    ["-y", "-i", "in.mp4", "-af", "loudnorm=I=-23:TP=-2:LRA=7", "-c:v", "copy", "out.mp4"],
  );
});

Deno.test("buildLoudnormArgs: an explicit audio codec + options land right after the loudnorm filter", () => {
  assertEquals(
    buildLoudnormArgs({ inputPath: "in.mp4", outputPath: "out.mp4", targetLufs: -16, truePeakDb: -1, loudnessRangeLu: 11, audioCodec: "aac", audioOptions: { "-b:a": "192k" } }),
    ["-y", "-i", "in.mp4", "-af", "loudnorm=I=-16:TP=-1:LRA=11", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "out.mp4"],
  );
});

Deno.test("generic 'loudnorm' task: toArgs matches buildLoudnormArgs, validates all three numeric fields", () => {
  const task = genericScriptTaskById("loudnorm")!;
  assertEquals(task.command, "ffmpeg");
  assertEquals(
    task.toArgs({ scalars: { inputPath: "in.mp4", outputPath: "out.mp4", targetLufs: "-23", truePeak: "-2", loudnessRange: "7" }, pickers: {}, groups: {} }),
    { ok: true, args: buildLoudnormArgs({ inputPath: "in.mp4", outputPath: "out.mp4", targetLufs: -23, truePeakDb: -2, loudnessRangeLu: 7 }) },
  );
  assertEquals(task.toArgs({ scalars: { inputPath: "", outputPath: "out.mp4", targetLufs: "-23", truePeak: "-2", loudnessRange: "7" }, pickers: {}, groups: {} }), {
    ok: false,
    error: "Eingabe- und Ausgabedatei sind Pflicht.",
  });
  assertEquals(task.toArgs({ scalars: { inputPath: "in.mp4", outputPath: "out.mp4", targetLufs: "abc", truePeak: "-2", loudnessRange: "7" }, pickers: {}, groups: {} }), {
    ok: false,
    error: "Ziel-Lautheit: keine gültige Zahl.",
  });
  assertEquals(task.toArgs({ scalars: { inputPath: "in.mp4", outputPath: "out.mp4", targetLufs: "-23", truePeak: "abc", loudnessRange: "7" }, pickers: {}, groups: {} }), {
    ok: false,
    error: "Maximaler True Peak: keine gültige Zahl.",
  });
  assertEquals(task.toArgs({ scalars: { inputPath: "in.mp4", outputPath: "out.mp4", targetLufs: "-23", truePeak: "-2", loudnessRange: "0" }, pickers: {}, groups: {} }), {
    ok: false,
    error: "Lautheits-Schwankungsbreite: keine gültige Zahl größer 0.",
  });
});

Deno.test("buildRemuxCopyArgs: stream-copies both, only adds -f when a container is forced", () => {
  assertEquals(buildRemuxCopyArgs({ inputPath: "in.ts", outputPath: "out.mp4" }), ["-y", "-i", "in.ts", "-c", "copy", "out.mp4"]);
  assertEquals(buildRemuxCopyArgs({ inputPath: "in.ts", outputPath: "out.dat", format: "mp4" }), ["-y", "-i", "in.ts", "-c", "copy", "-f", "mp4", "out.dat"]);
});

Deno.test("generic 'remux_copy' task: toArgs matches buildRemuxCopyArgs", () => {
  const task = genericScriptTaskById("remux_copy")!;
  assertEquals(task.command, "ffmpeg");
  assertEquals(
    task.toArgs({ scalars: { inputPath: "in.ts", outputPath: "out.mp4" }, pickers: { format: { format: "mp4", options: {} } }, groups: {} }),
    { ok: true, args: buildRemuxCopyArgs({ inputPath: "in.ts", outputPath: "out.mp4", format: "mp4" }) },
  );
  assertEquals(task.toArgs({ scalars: { inputPath: "", outputPath: "out.mp4" }, pickers: {}, groups: {} }), { ok: false, error: "Eingabe- und Ausgabedatei sind Pflicht." });
});

Deno.test("buildHlsLadderArgs: splits video once per rendition, scales+maps+bitrates each, builds var_stream_map/master playlist/segment pattern", () => {
  const args = buildHlsLadderArgs({
    inputPath: "in.mp4",
    outputDir: "out",
    segmentSeconds: 6,
    renditions: [
      { label: "1080p", width: 1920, height: 1080, videoBitrateKbps: 5000, audioBitrateKbps: 192 },
      { label: "480p", width: 854, height: 480, videoBitrateKbps: 1200, audioBitrateKbps: 96 },
    ],
  });
  assertEquals(args, [
    "-y",
    "-i",
    "in.mp4",
    "-filter_complex",
    "[0:v]split=2[v0][v1];[v0]scale=w=1920:h=1080[v0out];[v1]scale=w=854:h=480[v1out]",
    "-map",
    "[v0out]",
    "-c:v:0",
    "libx264",
    "-b:v:0",
    "5000k",
    "-map",
    "[v1out]",
    "-c:v:1",
    "libx264",
    "-b:v:1",
    "1200k",
    "-map",
    "0:a",
    "-c:a:0",
    "aac",
    "-b:a:0",
    "192k",
    "-map",
    "0:a",
    "-c:a:1",
    "aac",
    "-b:a:1",
    "96k",
    "-var_stream_map",
    "v:0,a:0,name:1080p v:1,a:1,name:480p",
    "-master_pl_name",
    "master.m3u8",
    "-f",
    "hls",
    "-hls_time",
    "6",
    "-hls_playlist_type",
    "vod",
    "-hls_segment_filename",
    "out/%v/seg_%03d.ts",
    "out/%v/stream.m3u8",
  ]);
});

Deno.test("generic 'hls_ladder' task: toArgs validates rendition count, name charset, uniqueness, and numeric fields", () => {
  const task = genericScriptTaskById("hls_ladder")!;
  assertEquals(task.command, "ffmpeg");

  const okValues = {
    scalars: { inputPath: "in.mp4", outputDir: "out", segmentSeconds: "6" },
    pickers: {},
    groups: {
      renditions: [
        { scalars: { label: "1080p", width: "1920", height: "1080", videoBitrateKbps: "5000", audioBitrateKbps: "192" }, pickers: {}, groups: {} },
        { scalars: { label: "480p", width: "854", height: "480", videoBitrateKbps: "1200", audioBitrateKbps: "96" }, pickers: {}, groups: {} },
      ],
    },
  };
  assertEquals(
    task.toArgs(okValues),
    {
      ok: true,
      args: buildHlsLadderArgs({
        inputPath: "in.mp4",
        outputDir: "out",
        segmentSeconds: 6,
        renditions: [
          { label: "1080p", width: 1920, height: 1080, videoBitrateKbps: 5000, audioBitrateKbps: 192 },
          { label: "480p", width: 854, height: 480, videoBitrateKbps: 1200, audioBitrateKbps: 96 },
        ],
      }),
    },
  );

  assertEquals(task.toArgs({ ...okValues, groups: { renditions: [] } }), { ok: false, error: "Mindestens eine Rendition ist nötig." });

  assertEquals(
    task.toArgs({ ...okValues, groups: { renditions: [{ scalars: { label: "1080 p!", width: "1920", height: "1080", videoBitrateKbps: "5000", audioBitrateKbps: "192" }, pickers: {}, groups: {} }] } }),
    { ok: false, error: '"1080 p!": Name darf nur Buchstaben, Zahlen und Bindestrich enthalten.' },
  );

  assertEquals(
    task.toArgs({
      ...okValues,
      groups: {
        renditions: [
          { scalars: { label: "a", width: "1920", height: "1080", videoBitrateKbps: "5000", audioBitrateKbps: "192" }, pickers: {}, groups: {} },
          { scalars: { label: "a", width: "854", height: "480", videoBitrateKbps: "1200", audioBitrateKbps: "96" }, pickers: {}, groups: {} },
        ],
      },
    }),
    { ok: false, error: "Rendition-Namen müssen eindeutig sein." },
  );

  assertEquals(
    task.toArgs({ ...okValues, groups: { renditions: [{ scalars: { label: "x", width: "0", height: "1080", videoBitrateKbps: "5000", audioBitrateKbps: "192" }, pickers: {}, groups: {} }] } }),
    { ok: false, error: '"x": Breite/Höhe müssen gültige Zahlen größer 0 sein.' },
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

Deno.test("buildConcatArgs: lossless mode uses the concat protocol + stream copy, ignores trim/codec fields entirely", () => {
  const args = buildConcatArgs({
    outputPath: "out.ts",
    lossless: true,
    videoCodec: "should-be-ignored",
    clips: [
      { inputPath: "a.ts", trimStart: "5" }, // trim silently ignored in lossless mode
      { inputPath: "b.ts" },
      { inputPath: "c.ts" },
    ],
  });
  assertEquals(args, ["-y", "-i", "concat:a.ts|b.ts|c.ts", "-c", "copy", "out.ts"]);
});

Deno.test("buildConcatArgs: lossless mode still honors an explicit forced container", () => {
  const args = buildConcatArgs({ outputPath: "out.ts", lossless: true, format: "mpegts", clips: [{ inputPath: "a.ts" }, { inputPath: "b.ts" }] });
  assertEquals(args, ["-y", "-i", "concat:a.ts|b.ts", "-c", "copy", "-f", "mpegts", "out.ts"]);
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

// ---- `-h full`: vollständiger globaler CLI-Flag-Import (Kapitel 23, Schritt 5) --------------------

Deno.test("globalOptionEntryToFlagDef: an argument placeholder means a value is expected, none means a value-less switch", () => {
  assertEquals(globalOptionEntryToFlagDef({ name: "-ss", arg: "time_off", description: "set the start time offset", section: "Per-file main options", hasArg: true }), {
    name: "-ss",
    type: "text",
    description: "set the start time offset",
  });
  assertEquals(globalOptionEntryToFlagDef({ name: "-shortest", description: "finish encoding within shortest input", section: "Advanced per-file options", hasArg: false }), {
    name: "-shortest",
    type: "boolean",
    description: "finish encoding within shortest input",
  });
});

Deno.test("validateArgValue: a flag unknown to the curated table is still checked once it's found via the full -h full import", () => {
  const overrides = [
    { name: "-vaapi_device", type: "text" as const, description: "set VAAPI hardware device" },
    { name: "-hide_banner", type: "boolean" as const, description: "do not show program banner" },
  ];
  assertEquals(validateArgValue("-vaapi_device", "/dev/dri/renderD128", undefined, overrides), { ok: true });
  assertEquals(validateArgValue("-hide_banner", "anything", undefined, overrides).ok, false);
  // Die kuratierte Tabelle gewinnt bei überlappenden Namen (bessere
  // Typisierung, z. B. echte Auswahllisten) — hier nur zur Absicherung,
  // dass ein Override eine kuratierte Definition NICHT verdrängt.
  const conflictingOverride = [{ name: "-loglevel", type: "text" as const, description: "irrelevant, sollte nie greifen" }];
  assertEquals(validateArgValue("-loglevel", "not-a-real-level", undefined, conflictingOverride).ok, false);
});

// ---- Parameter-Suche: Tippfehler-Toleranz (Kapitel 25 R5) ------------------------------------------

Deno.test("levenshteinDistance: identical strings are 0, single edits (insert/delete/substitute) are 1, a transposition is 2", () => {
  assertEquals(levenshteinDistance("crf", "crf"), 0);
  assertEquals(levenshteinDistance("crf", "crg"), 1); // Ersetzung
  assertEquals(levenshteinDistance("crf", "crrf"), 1); // Einfügung
  assertEquals(levenshteinDistance("crf", "cf"), 1); // Löschung
  assertEquals(levenshteinDistance("scale", "sacle"), 2); // vertauschte Buchstaben (plain Levenshtein: 2 Ersetzungen)
  assertEquals(levenshteinDistance("", "abc"), 3);
  assertEquals(levenshteinDistance("abc", ""), 3);
});

Deno.test("isFuzzyMatch: exact substrings always match; short queries (<=3 chars) get a tighter budget than longer ones", () => {
  assertEquals(isFuzzyMatch("crf", "libx264 -crf"), true); // echter Substring, kein Tippfehler nötig
  assertEquals(isFuzzyMatch("crg", "crf"), true); // 1 Ersetzung, Budget 1 für 3-stellige Anfrage
  assertEquals(isFuzzyMatch("cxg", "-crf"), false); // Distanz 3 (inkl. führendem "-") > Budget 1 für eine 3-stellige Anfrage
  assertEquals(isFuzzyMatch("sacle", "scale"), true); // Transposition, Distanz 2, Budget 2 ab 4 Zeichen
  assertEquals(isFuzzyMatch("logelvel", "loglevel"), true); // vertauschte Buchstaben, Distanz 2
  assertEquals(isFuzzyMatch("completely-different", "scale"), false);
  assertEquals(isFuzzyMatch("", "scale"), false);
});

Deno.test("searchEntries: exact substring hits (name or description) rank before fuzzy-only hits, both respect the limit", () => {
  const entries = [
    { name: "libx264", description: "H.264 / AVC encoder", value: 1 },
    { name: "libx265", description: "H.265 / HEVC encoder", value: 2 },
    { name: "libvpx", description: "VP8/VP9 encoder", value: 3 },
  ];
  // "libx264" ist ein exakter Substring-Treffer, "libx265" nur per
  // Tippfehler-Toleranz (Distanz 1) — Reihenfolge muss exakt vor fuzzy bleiben.
  const results = searchEntries("libx264", entries);
  assertEquals(results.map((r) => [r.entry.name, r.fuzzy]), [
    ["libx264", false],
    ["libx265", true],
  ]);
});

Deno.test("searchEntries: query matching only a description (not any name) still ranks as an exact (non-fuzzy) hit", () => {
  const entries = [{ name: "libx264", description: "H.264 / AVC encoder", value: 1 }];
  assertEquals(searchEntries("avc", entries), [{ entry: entries[0], fuzzy: false }]);
});

Deno.test("searchEntries: empty query returns no results, limit truncates the combined exact+fuzzy list", () => {
  const entries = [
    { name: "a", description: "", value: 1 },
    { name: "a1", description: "", value: 2 },
    { name: "a2", description: "", value: 3 },
  ];
  assertEquals(searchEntries("", entries), []);
  assertEquals(searchEntries("a", entries, 2).length, 2);
});
