import { assertEquals } from "jsr:@std/assert@1";
import {
  addMember, addPort, clearFeed, normalize, portNameOf, problems, removeMember, removePort, renamePort, renameRoleIn, setLabel,
} from "./workflow-interface-logic.ts";

Deno.test("portNameOf entfernt Node-Label und Instanz-ID wie der Orchestrator", () => {
  assertEquals(portNameOf("Mixer (3f2a1b9c) PGM", "Mixer (3f2a1b9c)"), "PGM");
  assertEquals(portNameOf("Mixer (3f2a1b9c) PGM Audio"), "PGM Audio");
  assertEquals(portNameOf("PGM"), "PGM");
});

Deno.test("addPort: Name Pflicht und je Seite eindeutig", () => {
  const a = addPort(undefined, "outputs", " PGM ")!;
  assertEquals(a.outputs?.[0].name, "PGM");
  assertEquals(addPort(a, "outputs", "PGM"), null);
  assertEquals(addPort(a, "outputs", "  "), null);
  assertEquals(addPort(a, "inputs", "PGM") !== null, true);
});

Deno.test("Mitglieder bündeln, Duplikate ignorieren, entfernen", () => {
  let i = addPort(undefined, "outputs", "PGM")!;
  i = addMember(i, "outputs", "PGM", { role: "mixer", port: "PGM" });
  i = addMember(i, "outputs", "PGM", { role: "mixer", port: "PGM Audio" });
  i = addMember(i, "outputs", "PGM", { role: "mixer", port: "PGM" });
  assertEquals(i.outputs![0].members.length, 2);
  i = removeMember(i, "outputs", "PGM", 0);
  assertEquals(i.outputs![0].members, [{ role: "mixer", port: "PGM Audio" }]);
});

Deno.test("renamePort / setLabel / removePort / normalize", () => {
  let i = addPort(undefined, "outputs", "A")!;
  i = addPort(i, "outputs", "B")!;
  assertEquals(renamePort(i, "outputs", "A", "B"), null);
  i = renamePort(i, "outputs", "A", "C")!;
  i = setLabel(i, "outputs", "C", "Programm");
  assertEquals(i.outputs![0], { name: "C", label: "Programm", members: [] });
  i = setLabel(i, "outputs", "C", "");
  assertEquals("label" in i.outputs![0], false);
  assertEquals(removePort(removePort(i, "outputs", "C"), "outputs", "B"), undefined);
  assertEquals(normalize({ outputs: [], inputs: [] }), undefined);
});

Deno.test("renameRoleIn: Rollen-Umbenennung folgt, Löschen entfernt Mitglieder und leere Ausgänge", () => {
  let i = addPort(undefined, "outputs", "PGM", [{ role: "mixer" }, { role: "src" }])!;
  i = addPort(i, "inputs", "In", [{ role: "src" }])!;
  assertEquals(renameRoleIn(i, "mixer", "m2")!.outputs![0].members[0].role, "m2");
  const gone = renameRoleIn(i, "src", null)!;
  assertEquals(gone.outputs![0].members, [{ role: "mixer" }]);
  assertEquals(gone.inputs, undefined);
});

Deno.test("problems meldet unbekannte Rollen und leere Ausgänge", () => {
  const i = addPort(addPort(undefined, "outputs", "A", [{ role: "x" }])!, "outputs", "B")!;
  assertEquals(problems(i, ["mixer"]), ["outputs:A:unknownRole:x", "outputs:B:noMembers"]);
});

Deno.test("clearFeed entfernt nur die Zuordnung, Mitglieder bleiben; Umbenennen behält sie", () => {
  let i = addPort(undefined, "inputs", "FQ1", [{ role: "mixer" }])!;
  i = { inputs: [{ ...i.inputs![0], feed: { workflowId: "w", output: "PGM" } }] };
  assertEquals(renamePort(i, "inputs", "FQ1", "FQ2")!.inputs![0].feed?.output, "PGM");
  const c = clearFeed(i, "FQ1");
  assertEquals(c.inputs![0], { name: "FQ1", members: [{ role: "mixer" }] });
});
