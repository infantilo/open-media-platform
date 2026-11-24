import { assertEquals } from "jsr:@std/assert@1";
import { addPort, clickCell, clearOutput, combineAll, gainText, kindOf, monoToAll, normalize, removePort, routeStraight, sameConfig, setChannelCount, setGain, splitInput, validate, validSymbol, type MatrixConfig } from "./matrix-logic.ts";

const base = (): MatrixConfig => normalize({ inputs: [{ id: "a", name: "A", channels: ["L", "R", "C"] }, { id: "b", name: "B", channels: ["Komm"] }], outputs: [{ id: "o", name: "O", channels: ["1", "2"] }], routes: [] });

Deno.test("normalize liest Texte und Objekte, Rundreise bleibt gleich", () => {
  const c = normalize(JSON.stringify({ inputs: [{ id: "a", name: "A", channels: ["x", { label: "Links", symbol: "L" }] }], outputs: [], routes: [{ out: "o", ch: 1, in: "a", inCh: 2, gainDb: 0 }] }));
  assertEquals(c.inputs[0].channels, [{ label: "x" }, { label: "Links", symbol: "L" }]);
  assertEquals(c.routes[0].gainDb, undefined);
  assertEquals(sameConfig(c, normalize(JSON.stringify(c))), true);
  assertEquals(normalize("kein json"), { inputs: [], outputs: [], routes: [] });
});

Deno.test("Symbole nach TR-03", () => {
  for (const s of ["L", "LFE", "NSC001", "NSC128", "U01", "U64"]) assertEquals(validSymbol(s), true, s);
  for (const s of ["l", "NSC129", "NSC1", "U00", "U65", "X", ""]) assertEquals(validSymbol(s), false, s);
});

Deno.test("Klick: exklusiv ersetzt, zweiter Klick löscht, Zusatz summiert", () => {
  let c = base();
  c = clickCell(c, "o", 1, "a", 1);
  assertEquals(kindOf(c, "o", 1), "copy");
  c = clickCell(c, "o", 1, "a", 2); // ersetzt
  assertEquals(c.routes.map((r) => r.inCh), [2]);
  c = clickCell(c, "o", 1, "b", 1, true); // zusätzlich
  assertEquals(kindOf(c, "o", 1), "mix");
  c = clickCell(c, "o", 1, "b", 1, true); // zusätzliche Quelle wieder weg
  assertEquals(kindOf(c, "o", 1), "copy");
  c = clickCell(c, "o", 1, "a", 2); // einzige Quelle → entfernt
  assertEquals(kindOf(c, "o", 1), "none");
});

Deno.test("Gain macht aus Kopie Mischen; 0 dB zurück zur Kopie; Grenzen", () => {
  let c = clickCell(base(), "o", 1, "a", 1);
  c = setGain(c, "o", 1, "a", 1, -6);
  assertEquals(kindOf(c, "o", 1), "mix");
  c = setGain(c, "o", 1, "a", 1, 99);
  assertEquals(c.routes[0].gainDb, 24);
  c = setGain(c, "o", 1, "a", 1, 0);
  assertEquals(kindOf(c, "o", 1), "copy");
  assertEquals(gainText(-6), "−6");
  assertEquals(gainText(3), "+3");
  assertEquals(gainText(undefined), "");
});

Deno.test("Ports anlegen, umbenennen-eindeutig, Kanalzahl, löschen entfernt Kreuzpunkte", () => {
  let c = addPort(base(), "out", 8, "PGM 8");
  assertEquals(c.outputs[1].channels.length, 8);
  c = addPort(c, "out", 1, "PGM 8"); // Name belegt → neuer Standardname
  assertEquals(c.outputs[2].name, "Output 1");
  assertEquals(new Set(c.outputs.map((p) => p.id)).size, 3);
  c = clickCell(c, "out2", 5, "a", 1);
  c = setChannelCount(c, "out", "out2", 4); // Kanal 5 fällt weg
  assertEquals(c.routes.length, 0);
  c = clickCell(c, "o", 2, "b", 1);
  c = removePort(c, "in", "b");
  assertEquals(c.routes.length, 0);
  assertEquals(validate(c), null);
});

Deno.test("Schnellaktionen: 1:1, Mono auf alle, Teilen, Zusammensetzen", () => {
  let c = routeStraight(base(), "a", "o");
  assertEquals(c.routes.map((r) => [r.ch, r.inCh]), [[1, 1], [2, 2]]);
  c = monoToAll(c, "b", 1, "o");
  assertEquals(c.routes.map((r) => [r.out, r.ch, r.in]), [["o", 1, "b"], ["o", 2, "b"]]);
  assertEquals(clearOutput(c, "o").routes.length, 0);

  const s = splitInput(base(), "a", 1);
  assertEquals(s.outputs.map((p) => p.name), ["O", "L", "R", "C"]);
  assertEquals(s.routes.length, 3);
  assertEquals(validate(s), null);
  const p = splitInput(base(), "a", 2);
  assertEquals(p.outputs.map((x) => x.channels.length), [2, 2, 1]);
  assertEquals(validate(p), null);

  const all = combineAll(base(), "Alle");
  const o = all.outputs[all.outputs.length - 1];
  assertEquals(o.channels.map((x) => x.label), ["L", "R", "C", "Komm"]);
  assertEquals(all.routes.filter((r) => r.out === o.id).map((r) => `${r.in}${r.inCh}`), ["a1", "a2", "a3", "b1"]);
  assertEquals(validate(all), null);
});

Deno.test("validate spiegelt die Regeln des Nodes", () => {
  const c = base();
  assertEquals(validate(c), null);
  assertEquals(validate({ ...c, routes: [{ out: "x", ch: 1, in: "a", inCh: 1 }] })?.includes("Ausgang"), true);
  assertEquals(validate({ ...c, routes: [{ out: "o", ch: 3, in: "a", inCh: 1 }] })?.includes("Kanal 3"), true);
  assertEquals(validate({ ...c, routes: [{ out: "o", ch: 1, in: "a", inCh: 1 }, { out: "o", ch: 1, in: "a", inCh: 1 }] }), "Kreuzpunkt doppelt");
  const dup = { ...c, outputs: [...c.outputs, { id: "p", name: "O", channels: [{ label: "1" }] }] };
  assertEquals(validate(dup)?.includes("Name"), true);
  const badSym = clone2(c);
  badSym.outputs[0].channels[0].symbol = "Q";
  assertEquals(validate(badSym)?.includes("TR-03"), true);
  let many = base();
  for (let i = 0; i < 40; i++) many = addPort(many, "out", 1);
  assertEquals(many.outputs.length, 32);
});

function clone2(c: MatrixConfig): MatrixConfig {
  return JSON.parse(JSON.stringify(c));
}
