import { assertEquals } from "jsr:@std/assert";
import { accessLink, bundleFileName, formatSize, freezeUrl, bundleUrl, type SelftestReport, type SupportGrant, sortGrants, splitChecks } from "./support-logic.ts";

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

Deno.test("accessLink: Token hinter dem # und kodiert", () => {
  assertEquals(accessLink("http://x:8000", "ompsup_abc.d-e_f"), "http://x:8000/#support=ompsup_abc.d-e_f");
  assertEquals(accessLink("http://x", "a b/c"), "http://x/#support=a%20b%2Fc");
});

Deno.test("sortGrants: aktive zuerst nach Ablauf, dann die übrigen neueste zuerst", () => {
  const g = (id: string, status: SupportGrant["status"], createdAt: string, expiresAt: string): SupportGrant => ({ id, createdBy: "a", createdAt, expiresAt, status, useCount: 0 });
  const out = sortGrants([
    g("alt", "expired", "2026-10-01T10:00:00Z", "2026-10-01T11:00:00Z"),
    g("spaet", "active", "2026-10-27T10:00:00Z", "2026-10-27T20:00:00Z"),
    g("neu-widerrufen", "revoked", "2026-10-26T10:00:00Z", "2026-10-26T20:00:00Z"),
    g("bald", "active", "2026-10-27T11:00:00Z", "2026-10-27T12:00:00Z"),
  ]);
  assertEquals(out.map((x) => x.id), ["bald", "spaet", "neu-widerrufen", "alt"]);
});

Deno.test("formatSize und freezeUrl", () => {
  assertEquals(formatSize(100), "1 KB");
  assertEquals(formatSize(2048), "2 KB");
  assertEquals(formatSize(3 * (1 << 20)), "3.0 MB");
  assertEquals(freezeUrl("ab12"), "/api/v1/freezes/ab12/download");
  assertEquals(freezeUrl("a/b"), "/api/v1/freezes/a%2Fb/download");
});
