import { assertEquals } from "jsr:@std/assert@1";
import { adminGroups, insertIndex, mainTabs, pickLabel, type ModuleInfo } from "./modules-logic.ts";

const tab = (id: string, extra: Record<string, unknown> = {}) => ({ id, placement: "main", label: { de: "Cloud", en: "Cloud EN" }, element: "x-" + id, bundle: "/b.js", ...extra });

Deno.test("mainTabs: nur gemountete Module, nur Placement main, ungültige Einträge übersprungen", () => {
  const mods: ModuleInfo[] = [
    { name: "cloud", state: "mounted", ui: [tab("cloud", { after: "hosts" }), tab("kaputt", { element: "" }), tab("admin-teil", { placement: "admin:playout" })] },
    { name: "off", state: "disabled", ui: [tab("x")] },
    { name: "bad", state: "failed", error: "x", ui: [tab("y")] },
    { name: "ohne-ui", state: "mounted" },
  ];
  const t = mainTabs(mods, "en");
  assertEquals(t.map((x) => x.id), ["mod:cloud:cloud"]);
  assertEquals(t[0].label, "Cloud EN");
  assertEquals(t[0].after, "hosts");
});

Deno.test("pickLabel: Sprache, dann Deutsch, dann ID", () => {
  assertEquals(pickLabel({ de: "A", en: "B" }, "en", "id"), "B");
  assertEquals(pickLabel({ de: "A" }, "en", "id"), "A");
  assertEquals(pickLabel({}, "en", "id"), "id");
  assertEquals(pickLabel(undefined, "de", "id"), "id");
});

Deno.test("insertIndex: hinter after, sonst vor Administration, sonst ans Ende", () => {
  const ids = ["flow", "workflows", "hosts", "instances", "admin"];
  assertEquals(insertIndex(ids, "hosts"), 3);
  assertEquals(insertIndex(ids, "gibtsnicht"), 4);
  assertEquals(insertIndex(ids, undefined), 4);
  assertEquals(insertIndex(["flow", "hosts"], undefined), 2);
});

Deno.test("adminGroups: nach Gruppe zusammengefasst, Beschriftung vom ersten Tab, nur gemountete Module", () => {
  const mods: ModuleInfo[] = [
    { name: "audio-rules", state: "mounted", ui: [tab("audio", { placement: "admin:playout", group: { de: "Playout", en: "Playout EN" }, label: { de: "Audio-Ausgabe", en: "Audio output" } })] },
    { name: "playout", state: "mounted", ui: [tab("channels", { placement: "admin:playout", label: { de: "Playout" } }), tab("main-tab")] },
    { name: "x", state: "disabled", ui: [tab("t", { placement: "admin:other" })] },
    { name: "y", state: "mounted", ui: [tab("t", { placement: "admin:" })] },
  ];
  const g = adminGroups(mods, "en");
  assertEquals(g.length, 1);
  assertEquals(g[0].id, "playout");
  assertEquals(g[0].label, "Playout EN");
  assertEquals(g[0].tabs.map((x) => x.id + "=" + x.label), ["mod:audio-rules:audio=Audio output", "mod:playout:channels=Playout"]);
});
