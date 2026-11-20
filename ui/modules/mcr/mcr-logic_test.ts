import { assertEquals } from "jsr:@std/assert";
import { avLight, fmtMs, fmtVideo, inputLamp, lineMode, needsConfirm, nextStep, otherSteps, parseStages, relTime, scalePct, validateHouse, validateLine } from "./mcr-logic.ts";

const GRAPH = {
  planned: ["testing", "cancelled"],
  testing: ["planned", "live", "cancelled"],
  live: ["teardown"],
  teardown: ["done"],
  done: [],
  cancelled: [],
};

Deno.test("Hauptknopf ist der nächste Schritt vorwärts, der Rest sind Nebenschritte", () => {
  assertEquals(nextStep("planned", GRAPH), "testing");
  assertEquals(nextStep("testing", GRAPH), "live");
  assertEquals(nextStep("live", GRAPH), "teardown");
  assertEquals(nextStep("done", GRAPH), null);
  assertEquals(otherSteps("testing", GRAPH), ["planned", "cancelled"]);
  assertEquals(otherSteps("planned", GRAPH), ["cancelled"]);
});

Deno.test("Bestätigung bei allem, was auf Sendung wirkt oder abbaut", () => {
  assertEquals(needsConfirm("planned", "testing"), false);
  assertEquals(needsConfirm("testing", "planned"), false);
  assertEquals(needsConfirm("testing", "live"), true);
  assertEquals(needsConfirm("live", "teardown"), true);
  assertEquals(needsConfirm("planned", "cancelled"), true);
});

Deno.test("R-37-Ampel: je Stufe +5/−15 grün, am Ausgang +40/−60 gelb, sonst rot", () => {
  assertEquals(avLight(0), "ok");
  assertEquals(avLight(5), "ok");
  assertEquals(avLight(-15), "ok");
  assertEquals(avLight(6), "warn");
  assertEquals(avLight(-16), "warn");
  assertEquals(avLight(40), "warn");
  assertEquals(avLight(-60), "warn");
  assertEquals(avLight(41), "bad");
  assertEquals(avLight(-61), "bad");
  assertEquals(avLight(null), "none");
  assertEquals(avLight(NaN), "none");
});

Deno.test("Skala: Mitte, Grenzen und Begrenzung", () => {
  assertEquals(Math.round(scalePct(0)), 56);
  assertEquals(scalePct(-500), 0);
  assertEquals(scalePct(500), 100);
});

Deno.test("Formatierung von Millisekunden und Bildformaten", () => {
  assertEquals(fmtMs(80), "+80 ms");
  assertEquals(fmtMs(-86.5), "-86.5 ms");
  assertEquals(fmtMs(null), "–");
  assertEquals(fmtVideo({ height: 1080, rate: "25/1", scan: "interlaced_tff" }), "1080i50");
  assertEquals(fmtVideo({ height: 720, rate: { num: 50, den: 1 }, scan: "progressive" }), "720p50");
  assertEquals(fmtVideo({ height: 1080, rate: "30000/1001", scan: "progressive" }), "1080p29,97");
  assertEquals(fmtVideo(null), "–");
});

Deno.test("Stufen und Leitungszustand aus Node-Parametern", () => {
  assertEquals(parseStages('{"video":["scale","colorMatrix"],"audio":[]}'), { video: ["scale", "colorMatrix"], audio: [] });
  assertEquals(parseStages("kaputt"), { video: [], audio: [] });
  assertEquals(lineMode({ "normalize.state": "copy" }), "copy");
  assertEquals(lineMode({ "normalize.state": "convert" }), "convert");
  assertEquals(lineMode({}), "waiting");
  assertEquals(inputLamp({ "contrib.state": "playing" }), "copy");
  assertEquals(inputLamp({ "contrib.state": "reconnecting" }), "blocked");
  assertEquals(inputLamp({ "contrib.state": "error" }), "error");
});

Deno.test("Leitung prüfen: Adresse, Ports, Geheimnisse", () => {
  assertEquals(validateLine({ name: "PGM", kind: "srt", transport: { uri: "srt://:9000" } }), []);
  assertEquals(validateLine({ name: "", kind: "srt", transport: { uri: "srt://:9000" } }), ["name"]);
  assertEquals(validateLine({ name: "A", kind: "srt", transport: { uri: "http://x" } }), ["uri"]);
  assertEquals(validateLine({ name: "A", kind: "srt", transport: { uri: "srt://h:1?passphrase=geheim12345" } }), ["secret"]);
  assertEquals(validateLine({ name: "A", kind: "srt", transport: { uri: "srt://h:1", passphrase: "x" } }), ["secret"]);
  assertEquals(validateLine({ name: "A", kind: "st2110", transport: { videoPort: "6000" } }), ["ports"]);
  assertEquals(validateLine({ name: "A", kind: "mxl", transport: {} }), []);
});

Deno.test("Hausformat prüfen wie der Server", () => {
  assertEquals(validateHouse({ video: { width: 1920, height: 1080, rate: "25/1", scan: "interlaced_tff" }, audio: { sampleRate: 48000, channels: 16 } }), []);
  assertEquals(validateHouse({ video: { width: 0, height: 1080, rate: "25/1", scan: "progressive" } }), ["size"]);
  assertEquals(validateHouse({ video: { width: 1920, height: 1081, rate: "25/1", scan: "interlaced_tff" } }), ["interlaceHeight"]);
  assertEquals(validateHouse({ video: { width: 1920, height: 1080, rate: "0/1", scan: "progressive" } }), ["rate"]);
  assertEquals(validateHouse({ audio: { sampleRate: 100, channels: 2 } }), ["sampleRate"]);
});

Deno.test("Relative Zeit", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");
  assertEquals(relTime("2026-11-20T14:05:00Z", now), "in 2 h 05 min");
  assertEquals(relTime("2026-11-20T11:46:00Z", now), "seit 14 min");
  assertEquals(relTime(undefined, now), "");
});

Deno.test("validateLine: vorhandener Node ersetzt Adresse und Ports der Leitungsart", () => {
  const ex = { existing: { nodeId: "n-1", nodeLabel: "SRT Eingang" } };
  assertEquals(validateLine({ name: "A", kind: "srt", transport: ex }), []);
  assertEquals(validateLine({ name: "A", kind: "st2110", transport: ex }), []);
  assertEquals(validateLine({ name: "A", kind: "srt", transport: {} }), ["uri"]);
  assertEquals(validateLine({ name: "A", kind: "srt", transport: { existing: {} } }), ["uri"]);
});

Deno.test("validateLine: Tonspuren am vorhandenen Node beeinflussen die Prüfung nicht", () => {
  const tr = { existing: { nodeId: "n", audioTracks: [{ label: "DE", channels: [1, 2] }, { channels: [5] }] } };
  assertEquals(validateLine({ name: "A", kind: "mxl", transport: tr }), []);
});
