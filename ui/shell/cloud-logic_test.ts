import { assertEquals } from "jsr:@std/assert@1";
import { budgetBar, fmtMoney, policyFromForm, policyToForm, reservationPayload, type Policy } from "./cloud-logic.ts";

const base: Policy = {
  pool: "burst", mode: "off", upCpuPercent: 80, upMemPercent: 85, upAfterSec: 300, downCpuPercent: 30, downAfterSec: 600,
  cooldownSec: 600, maxAutoHosts: 1, dailyBudget: 0, monthlyBudget: 0,
};

Deno.test("policyToForm/policyFromForm: Roundtrip in Minuten, Budget 0 = leer", () => {
  const f = policyToForm(base);
  assertEquals(f.upAfterMin, "5");
  assertEquals(f.dailyBudget, "");
  const r = policyFromForm("burst", f);
  assertEquals(r.ok && r.policy, base);
});

Deno.test("policyFromForm: Komma als Dezimaltrenner, Budget gesetzt", () => {
  const f = { ...policyToForm(base), mode: "auto" as const, dailyBudget: "12,5", upAfterMin: "2,5" };
  const r = policyFromForm("burst", f);
  assertEquals(r.ok && r.policy.dailyBudget, 12.5);
  assertEquals(r.ok && r.policy.upAfterSec, 150);
});

Deno.test("policyFromForm: Fehler vor dem Absenden", () => {
  const f = policyToForm(base);
  assertEquals(policyFromForm("b", { ...f, upCpuPercent: "abc" }), { ok: false, error: "cloudv.err.number" });
  assertEquals(policyFromForm("b", { ...f, downCpuPercent: "90" }), { ok: false, error: "cloudv.err.hysteresis" });
  assertEquals(policyFromForm("b", { ...f, cooldownMin: "0.5" }), { ok: false, error: "cloudv.err.duration" });
  assertEquals(policyFromForm("b", { ...f, mode: "auto" }), { ok: false, error: "cloudv.err.budget" });
  assertEquals(policyFromForm("b", { ...f, mode: "suggest" }).ok, true);
  assertEquals(policyFromForm("b", { ...f, dailyBudget: "-3" }), { ok: false, error: "cloudv.err.number" });
});

Deno.test("budgetBar: ohne Deckel kein Balken, Überschreitung markiert, Werte begrenzt", () => {
  assertEquals(budgetBar(1, 2, 0), null);
  assertEquals(budgetBar(2, 5, 10), { spentPct: 20, projectedPct: 50, over: false });
  assertEquals(budgetBar(2, 15, 10), { spentPct: 20, projectedPct: 100, over: true });
});

Deno.test("fmtMoney: Währung und Nachkommastellen", () => {
  assertEquals(fmtMoney(1.5, "EUR", "en-US"), "€1.50");
  assertEquals(fmtMoney(0.004653, "EUR", "en-US"), "€0.0047");
  assertEquals(fmtMoney(1234.5, "USD", "en-US"), "$1,234.50");
});

Deno.test("reservationPayload: gültig und fehlerhaft", () => {
  const ok = reservationPayload("burst", "2", "2026-10-08T10:00", "2026-10-08T12:00");
  assertEquals(ok.ok && ok.body.hostCount, 2);
  assertEquals(reservationPayload("burst", "0", "2026-10-08T10:00", "2026-10-08T12:00"), { ok: false, error: "cloudv.err.count" });
  assertEquals(reservationPayload("burst", "1", "2026-10-08T12:00", "2026-10-08T10:00"), { ok: false, error: "cloudv.err.time" });
  assertEquals(reservationPayload("", "1", "2026-10-08T10:00", "2026-10-08T12:00"), { ok: false, error: "cloudv.err.count" });
});
