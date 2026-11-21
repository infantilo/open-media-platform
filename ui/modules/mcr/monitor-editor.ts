// Editor der Überwachung (106.13d/e): Profil, Abweichungen und Reaktionsregeln. Gilt für Event (mit Regeln) und Leitung (nur Profil).
import { t } from "../host.ts";
import { field, h, input, note, select } from "./mcr-dom.ts";
import { parseParam, paramText } from "./chain-logic.ts";

export interface Reaction {
  id: string; name?: string; enabled?: boolean;
  trigger: { kinds?: string[]; minSeverity?: string; lines?: string[] };
  actions: string[]; gpio?: { target: string; pin: number };
  holdSeconds?: number; select?: string; fallback?: { mode?: string; lineId?: string };
}
export interface MonCfg { profile?: string; overrides?: Record<string, unknown>; reactions?: Reaction[] }

export const ACTIONS = ["border", "pip", "notice", "gpio"] as const;
const csv = (v: string): string[] | undefined => {
  const l = v.split(",").map((x) => x.trim()).filter(Boolean);
  return l.length ? l : undefined;
};

export function monitorEditor(initial: MonCfg | null | undefined, opts: { withReactions: boolean; lines?: { id: string; name: string }[] }): { el: HTMLElement; read: () => MonCfg | null } {
  const cfg: MonCfg = JSON.parse(JSON.stringify(initial ?? {}));
  const profile = input(cfg.profile ?? "", { placeholder: t("mcr.mon.profilePh") });
  const ov = input(Object.entries(cfg.overrides ?? {}).map(([k, v]) => `${k}=${paramText(v)}`).join(", "), { placeholder: "black.holdSeconds=5, freeze.enabled=false" });
  let rules: Reaction[] = cfg.reactions ?? [];
  const box = h("div", { class: "mcr-chain-body" });
  const drawRules = () => {
    box.replaceChildren(...rules.map((r, i) => {
      const name = input(r.name ?? r.id, { placeholder: t("mcr.mon.ruleName") });
      name.addEventListener("input", () => (r.name = name.value));
      const kinds = input((r.trigger.kinds ?? []).join(", "), { placeholder: "signal-black, signal" });
      kinds.addEventListener("input", () => (r.trigger.kinds = csv(kinds.value)));
      const sev = select([{ value: "", label: t("mcr.mon.anySev") }, ...["info", "warning", "error", "critical"].map((x) => ({ value: x, label: x }))], r.trigger.minSeverity ?? "");
      sev.addEventListener("change", () => (r.trigger.minSeverity = sev.value || undefined));
      const lines = input((r.trigger.lines ?? []).join(", "), { placeholder: t("mcr.mon.linesPh") });
      lines.addEventListener("input", () => (r.trigger.lines = csv(lines.value)));
      const acts = h("div", { class: "mcr-quick" }, ...ACTIONS.map((a) => {
        const b = h("button", { type: "button", class: "mcr-chip", "aria-pressed": String(r.actions.includes(a)) }, t(`mcr.mon.act.${a}`));
        b.addEventListener("click", () => {
          r.actions = r.actions.includes(a) ? r.actions.filter((x) => x !== a) : [...r.actions, a];
          drawRules();
        });
        return b;
      }));
      const hold = input(r.holdSeconds ?? 0, { type: "number", min: "0", max: "3600" });
      hold.addEventListener("input", () => (r.holdSeconds = Number(hold.value) || 0));
      const sel = select([{ value: "highest", label: t("mcr.mon.selHighest") }, { value: "latest", label: t("mcr.mon.selLatest") }], r.select ?? "highest");
      sel.addEventListener("change", () => (r.select = sel.value));
      const fbm = select([{ value: "empty", label: t("mcr.mon.fbEmpty") }, { value: "last", label: t("mcr.mon.fbLast") }, { value: "fixed", label: t("mcr.mon.fbFixed") }], r.fallback?.mode ?? "empty");
      const fbl = select([{ value: "", label: "–" }, ...(opts.lines ?? []).map((l) => ({ value: l.id, label: l.name }))], r.fallback?.lineId ?? "");
      const syncFb = () => {
        r.fallback = { mode: fbm.value, lineId: fbl.value || undefined };
        fbl.style.display = fbm.value === "fixed" ? "" : "none";
      };
      fbm.addEventListener("change", syncFb);
      fbl.addEventListener("change", syncFb);
      syncFb();
      const gt = input(r.gpio?.target ?? "", { placeholder: t("mcr.mon.gpioTarget") });
      const gp = input(r.gpio?.pin ?? "", { type: "number", min: "1", max: "64", placeholder: "Pin" });
      const syncG = () => (r.gpio = gt.value.trim() ? { target: gt.value.trim(), pin: Number(gp.value) || 0 } : undefined);
      gt.addEventListener("input", syncG);
      gp.addEventListener("input", syncG);
      const del = h("button", { type: "button", class: "mcr-btn mcr-btn-sm mcr-btn-quiet", "aria-label": t("mcr.chain.remove") }, "✕");
      del.addEventListener("click", () => {
        rules.splice(i, 1);
        drawRules();
      });
      const gpioRow = r.actions.includes("gpio") ? h("div", { class: "mcr-form-grid" }, field(t("mcr.mon.gpioTarget"), gt), field("Pin", gp)) : null;
      const pipRow = r.actions.includes("pip") ? h("div", { class: "mcr-form-grid" }, field(t("mcr.mon.select"), sel), field(t("mcr.mon.fallback"), h("div", { class: "mcr-quick" }, fbm, fbl))) : null;
      return h("div", { class: "mcr-chain-stage" }, h("div", { class: "mcr-chain-head" }, name, del),
        h("div", { class: "mcr-form-grid" }, field(t("mcr.mon.kinds"), kinds), field(t("mcr.mon.minSev"), sev)), field(t("mcr.mon.lines"), lines), field(t("mcr.mon.actions"), acts),
        h("div", { class: "mcr-form-grid" }, field(t("mcr.mon.hold"), hold)), pipRow, gpioRow);
    }));
    const add = h("button", { type: "button", class: "mcr-btn mcr-btn-sm" }, `+ ${t("mcr.mon.addRule")}`);
    add.addEventListener("click", () => {
      let n = 1;
      while (rules.some((r) => r.id === `regel-${n}`)) n++;
      rules.push({ id: `regel-${n}`, trigger: { kinds: ["signal"] }, actions: ["pip"], select: "highest", fallback: { mode: "empty" } });
      drawRules();
    });
    box.append(h("div", { class: "mcr-quick" }, add));
  };
  drawRules();
  const el = h("div", { class: "mcr-form" }, h("div", { class: "mcr-form-grid" }, field(t("mcr.mon.profile"), profile, t("mcr.mon.profileHint")), field(t("mcr.mon.overrides"), ov, t("mcr.mon.overridesHint"))),
    ...(opts.withReactions ? [h("h4", {}, t("mcr.mon.rules")), note(t("mcr.mon.rulesHint")), box] : []));
  return {
    el,
    read: () => {
      const out: MonCfg = {};
      if (profile.value.trim()) out.profile = profile.value.trim();
      const o: Record<string, unknown> = {};
      for (const part of ov.value.split(",")) {
        const [k, ...v] = part.split("=");
        if (k.trim() && v.length) o[k.trim()] = parseParam(v.join("="));
      }
      if (Object.keys(o).length) out.overrides = o;
      if (opts.withReactions && rules.length) out.reactions = rules.map((r) => ({ ...r, name: r.name === r.id ? undefined : r.name }));
      return Object.keys(out).length ? out : null;
    },
  };
}
