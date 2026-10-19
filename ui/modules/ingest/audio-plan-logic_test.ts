import { assertEquals } from "jsr:@std/assert";
import {
  addChannel, addInput, emptyPlan, identityPlan, moveChannel, planFromServer, planSummary, planToPayload, removeChannel, removeInput, setChannel, validatePlan,
} from "./audio-plan-logic.ts";

Deno.test("identityPlan: alle Kanäle der Hauptquelle, ohne Angabe Stereo", () => {
  assertEquals(identityPlan(4).channels.map((c) => [c.input, c.channel]), [[0, 0], [0, 1], [0, 2], [0, 3]]);
  assertEquals(identityPlan(0).channels.length, 2);
});

Deno.test("moveChannel vertauscht, Ränder bleiben stehen", () => {
  const p = identityPlan(3);
  assertEquals(moveChannel(p, 0, 1).channels.map((c) => c.channel), [1, 0, 2]);
  assertEquals(moveChannel(p, 0, -1), p);
  assertEquals(moveChannel(p, 2, 1), p);
});

Deno.test("addChannel/removeChannel/setChannel", () => {
  let p = addChannel(emptyPlan());
  assertEquals(p.channels, [{ input: null, channel: 0, gainDb: 0, label: "" }]);
  p = setChannel(p, 0, { input: 0, channel: 1, gainDb: -3 });
  assertEquals([p.channels[0].input, p.channels[0].channel, p.channels[0].gainDb], [0, 1, -3]);
  assertEquals(removeChannel(p, 0).channels.length, 0);
});

Deno.test("removeInput: Zeilen der entfernten Quelle werden still, spätere rücken nach", () => {
  let p = emptyPlan();
  p = addInput(addInput(p, { key: "a|", label: "A" }), { key: "b|", label: "B" });
  p = { ...p, channels: [{ input: 0, channel: 0, gainDb: 0, label: "" }, { input: 1, channel: 0, gainDb: 0, label: "" }, { input: 2, channel: 1, gainDb: 0, label: "" }] };
  const q = removeInput(p, 0); // Quelle 1 („A“) fällt weg
  assertEquals(q.inputs.map((i) => i.label), ["B"]);
  assertEquals(q.channels.map((c) => c.input), [0, null, 1]);
  assertEquals(q.channels[2].channel, 1);
});

Deno.test("addInput begrenzt auf 7 weitere Quellen", () => {
  let p = emptyPlan();
  for (let i = 0; i < 9; i++) p = addInput(p, { key: `s${i}|`, label: "" });
  assertEquals(p.inputs.length, 7);
});

Deno.test("validatePlan: leer, nur Stille, Kanalbereich, Grenzen je Format", () => {
  assertEquals(validatePlan(emptyPlan(), [2], ".mxf").map((x) => x.key), ["ing.ap.p.none"]);
  assertEquals(validatePlan(addChannel(emptyPlan()), [2], ".mxf").map((x) => x.key), ["ing.ap.p.allSilent"]);
  const p = { inputs: [], channels: [{ input: 0, channel: 2, gainDb: 0, label: "" }] };
  assertEquals(validatePlan(p, [2], ".mxf")[0], { key: "ing.ap.p.range", params: { n: 1, src: 1, cnt: 2 } });
  assertEquals(validatePlan(p, [0], ".mxf"), [], "unbekannte Kanalzahl: keine Fehlmeldung");
  const nine = { inputs: [], channels: Array.from({ length: 9 }, () => ({ input: 0, channel: 0, gainDb: 0, label: "" })) };
  assertEquals(validatePlan(nine, [2], ".mkv")[0].key, "ing.ap.p.tooMany");
  assertEquals(validatePlan(nine, [2], ".mxf"), []);
  assertEquals(validatePlan({ ...p, channels: [{ input: 0, channel: 0, gainDb: 99, label: "" }] }, [2], ".mxf")[0].key, "ing.ap.p.gain");
});

Deno.test("planToPayload / planFromServer: Rundlauf, Stille bleibt null", () => {
  const p = {
    inputs: [{ key: "mic|Main", label: "Sprecher" }],
    channels: [{ input: 0, channel: 1, gainDb: -3, label: " L " }, { input: 1, channel: 0, gainDb: 0, label: "" }, { input: null, channel: 0, gainDb: 0, label: "" }],
  };
  const payload = planToPayload(p)!;
  assertEquals(payload.inputs, [{ instanceId: "mic", senderLabel: "Main", label: "Sprecher" }]);
  assertEquals((payload.channels as { input: number | null; label?: string }[]).map((c) => [c.input, c.label]), [[0, "L"], [1, undefined], [null, undefined]]);
  const back = planFromServer(payload as never)!;
  assertEquals(back.inputs[0].key, "mic|Main");
  assertEquals(back.channels.map((c) => c.input), [0, 1, null]);
  assertEquals(planToPayload(null), undefined);
  assertEquals(planToPayload(emptyPlan()), undefined);
  assertEquals(planFromServer(undefined), null);
});

Deno.test("planSummary", () => {
  assertEquals(planSummary({ inputs: [{}], channels: [{}, {}, {}] }), { channels: 3, sources: 2 });
  assertEquals(planSummary({ channels: [] }), null);
});
