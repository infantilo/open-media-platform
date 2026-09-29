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
