import { assertEquals } from "jsr:@std/assert@1";
import { buildCatalog, type CatalogInput, mediaTypeFromFormat } from "./source-catalog.ts";

const graph = {
  nodes: [
    {
      id: "n1",
      label: "Cam",
      outputs: [
        { id: "s-v", label: "Cam Video", format: "urn:x-nmos:format:video", groupHint: "g:video" },
        { id: "s-a", label: "Cam Audio", format: "urn:x-nmos:format:audio" },
      ],
    },
    { id: "n2", label: "Play", outputs: [{ id: "s-p", label: "PGM", format: "urn:x-nmos:format:video" }] },
  ],
};
const workflows: NonNullable<CatalogInput["workflows"]> = [
  { id: "w1", name: "wf1", definition: { title: "Studio A" }, runtime: { cam: { nodeId: "n1" }, mon: { nodeId: "me" } } },
  { id: "w2", name: "Playout", runtime: { p: { nodeId: "n2" } } },
];

Deno.test("mediaTypeFromFormat", () => {
  assertEquals(mediaTypeFromFormat("urn:x-nmos:format:video"), "video");
  assertEquals(mediaTypeFromFormat("urn:x-nmos:format:audio"), "audio");
  assertEquals(mediaTypeFromFormat(undefined), undefined);
});

Deno.test("buildCatalog verknüpft Graph, Workflows und eigenen Workflow", () => {
  const r = buildCatalog({ graph, workflows, ownNodeId: "me" });
  assertEquals(r.currentWorkflowId, "w1");
  const v = r.entries.find((e) => e.id === "s-v")!;
  assertEquals(
    { m: v.mediaType, n: v.nodeName, w: v.workflowName, g: v.groupHint },
    { m: "video", n: "Cam", w: "Studio A", g: "g:video" },
  );
  assertEquals(r.entries.find((e) => e.id === "s-p")!.workflowName, "Playout");
});

Deno.test("senders-Liste schränkt ein, behält deren Label; unbekannte Sender bleiben ohne Metadaten", () => {
  const r = buildCatalog({
    graph,
    workflows,
    senders: [{ senderId: "s-a", label: "Ton" }, { senderId: "alt" }],
  });
  assertEquals(r.entries.map((e) => e.id), ["s-a", "alt"]);
  assertEquals(r.entries[0].label, "Ton");
  assertEquals(r.entries[1], { id: "alt", label: "alt" });
});

Deno.test("fehlende Graph-/Workflow-Daten degradieren ohne Fehler", () => {
  assertEquals(buildCatalog({ graph: null, workflows: null }), { entries: [], currentWorkflowId: null });
});

Deno.test("buildCatalog: exponierte Workflow-Ausgänge werden an den Sendern markiert (Kap. 88)", () => {
  const r = buildCatalog({
    graph: { nodes: [{ id: "n1", label: "Mixer", outputs: [{ id: "s1", label: "PGM", format: "urn:x-nmos:format:video" }, { id: "s2", label: "PGM Audio", format: "urn:x-nmos:format:audio" }, { id: "s3", label: "Aux", format: "urn:x-nmos:format:video" }] }] },
    workflows: [{ id: "wf", name: "Regie 1", runtime: { mixer: { nodeId: "n1" } } }],
    interfaces: [{ workflowId: "wf", outputs: [{ name: "PGM", label: "Programm", members: [{ portId: "s1", available: true }, { portId: "s2", available: true }, { portId: "s3", available: false }] }] }],
  });
  const byId = new Map(r.entries.map((e) => [e.id, e]));
  if (byId.get("s1")?.exposedAs?.[0]?.portLabel !== "Programm") throw new Error("s1 nicht markiert");
  if (!byId.get("s2")?.exposedAs) throw new Error("s2 nicht markiert");
  if (byId.get("s3")?.exposedAs) throw new Error("s3 nicht verfügbar, darf nicht markiert sein");
});
