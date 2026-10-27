import { assertEquals } from "jsr:@std/assert";
import { bundleFileName, bundleUrl, type SelftestReport, splitChecks } from "./support-logic.ts";

Deno.test("splitChecks: Fehler vor Hinweisen, in Ordnung getrennt", () => {
  const r: SelftestReport = {
    generatedAt: "", level: "err", summary: "", errors: 1, warnings: 1,
    checks: [
      { id: "a", group: "g", level: "ok", title: "a" },
      { id: "b", group: "g", level: "warn", title: "b" },
      { id: "c", group: "g", level: "err", title: "c" },
    ],
  };
  const s = splitChecks(r);
  assertEquals(s.problems.map((c) => c.id), ["c", "b"]);
  assertEquals(s.fine.map((c) => c.id), ["a"]);
});

Deno.test("bundleUrl nimmt nur bekannte Zeiträume", () => {
  assertEquals(bundleUrl(30), "/api/v1/admin/support-bundle?minutes=30");
  assertEquals(bundleUrl(1440), "/api/v1/admin/support-bundle?minutes=1440");
  assertEquals(bundleUrl(7), "/api/v1/admin/support-bundle?minutes=120");
});

Deno.test("bundleFileName: Header oder Ersatzname", () => {
  assertEquals(bundleFileName('attachment; filename="omp-support-regie-20261027-120000.zip"', new Date()), "omp-support-regie-20261027-120000.zip");
  assertEquals(bundleFileName(null, new Date(2026, 9, 27, 8, 5)), "omp-support-20261027-0805.zip");
  assertEquals(bundleFileName('attachment; filename="../../x.sh"', new Date(2026, 9, 27, 8, 5)), "omp-support-20261027-0805.zip");
});
