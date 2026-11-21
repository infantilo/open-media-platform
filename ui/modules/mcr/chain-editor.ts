// Editor der Verarbeitungskette (106.13g): dieselbe Maske für global, Event und Leitung. `read()` liefert `null` (erbt) oder die Liste.
import { t } from "../host.ts";
import { h, input, note, segmented, select } from "./mcr-dom.ts";
import { newStageId, paramText, parseParam, type Stage, type StageType, validateStages } from "./chain-logic.ts";

export interface ChainEditor {
  el: HTMLElement;
  /** null = erbt (nur wenn `canInherit`), sonst die Stufen; wirft bei ungültiger Eingabe. */
  read(): Stage[] | null;
}

export function chainEditor(initial: Stage[] | null | undefined, types: StageType[], opts: { canInherit: boolean; inheritHint?: string }): ChainEditor {
  let own = initial != null || !opts.canInherit;
  let list: Stage[] = (initial ?? []).map((s) => ({ ...s, params: { ...(s.params ?? {}) } }));
  const box = h("div", { class: "mcr-chain" });
  const body = h("div", { class: "mcr-chain-body" });

  const draw = () => {
    body.replaceChildren();
    if (!own) {
      body.append(note(opts.inheritHint ?? t("mcr.chain.inherit")));
      return;
    }
    list.forEach((s, i) => {
      const type = select(types.map((x) => ({ value: x.nodeType, label: x.label || x.nodeType })), s.nodeType);
      if (!types.some((x) => x.nodeType === s.nodeType)) type.append(h("option", { value: s.nodeType }, `${s.nodeType} (${t("mcr.chain.notAllowed")})`)), (type.value = s.nodeType);
      type.addEventListener("change", () => (s.nodeType = type.value));
      const where = segmented([{ value: "pre", label: t("mcr.chain.pre"), title: t("mcr.chain.preHint") }, { value: "post", label: t("mcr.chain.post"), title: t("mcr.chain.postHint") }], s.where, (v) => (s.where = v as "pre" | "post"));
      const on = h("input", { type: "checkbox", "aria-label": t("mcr.chain.enabled") }) as HTMLInputElement;
      on.checked = s.enabled !== false;
      on.addEventListener("change", () => (s.enabled = on.checked ? undefined : false));
      const label = input(s.label ?? "", { placeholder: t("mcr.chain.label") });
      label.addEventListener("input", () => (s.label = label.value || undefined));
      const mk = (txt: string, title: string, fn: () => void, dis = false) => {
        const b = h("button", { type: "button", class: "mcr-btn mcr-btn-sm mcr-btn-quiet", title, "aria-label": title }, txt) as HTMLButtonElement;
        b.disabled = dis;
        b.addEventListener("click", fn);
        return b;
      };
      const move = (d: number) => {
        [list[i], list[i + d]] = [list[i + d], list[i]];
        draw();
      };
      const head = h("div", { class: "mcr-chain-head" }, h("label", { class: "mcr-sw" }, on), type, where, mk("↑", t("mcr.chain.up"), () => move(-1), i === 0), mk("↓", t("mcr.chain.down"), () => move(1), i === list.length - 1), mk("✕", t("mcr.chain.remove"), () => {
        list.splice(i, 1);
        draw();
      }));
      const params = h("div", { class: "mcr-chain-params" });
      const entries = Object.entries(s.params ?? {});
      const drawParams = () => {
        params.replaceChildren(...entries.map(([k, v], j) => {
          const kn = input(k, { placeholder: t("mcr.chain.param") });
          const vn = input(paramText(v), { placeholder: t("mcr.chain.value") });
          const sync = () => {
            const p: Record<string, unknown> = {};
            for (const row of Array.from(params.querySelectorAll(".mcr-chain-prow"))) {
              const [a, b] = Array.from(row.querySelectorAll("input")) as HTMLInputElement[];
              if (a.value.trim()) p[a.value.trim()] = parseParam(b.value);
            }
            s.params = p;
          };
          kn.addEventListener("input", sync);
          vn.addEventListener("input", sync);
          const del = mk("✕", t("mcr.chain.remove"), () => {
            entries.splice(j, 1);
            sync();
            drawParams();
          });
          return h("div", { class: "mcr-chain-prow" }, kn, vn, del);
        }), mk(`+ ${t("mcr.chain.addParam")}`, t("mcr.chain.addParam"), () => {
          entries.push(["", ""]);
          drawParams();
        }));
      };
      drawParams();
      body.append(h("div", { class: "mcr-chain-stage", "data-off": String(s.enabled === false) }, head, label, params));
    });
    const add = h("button", { type: "button", class: "mcr-btn mcr-btn-sm" }, `+ ${t("mcr.chain.add")}`) as HTMLButtonElement;
    add.disabled = !types.length || list.length >= 8;
    add.addEventListener("click", () => {
      const nt = types[0]?.nodeType ?? "";
      list.push({ id: newStageId(nt, list.map((x) => x.id)), nodeType: nt, where: "pre", params: {} });
      draw();
    });
    body.append(h("div", { class: "mcr-quick" }, add), h("div", { class: "mcr-hint" }, list.length ? t("mcr.chain.order") : t("mcr.chain.empty")));
  };

  if (opts.canInherit) {
    const seg = segmented([{ value: "inherit", label: t("mcr.chain.modeInherit") }, { value: "own", label: t("mcr.chain.modeOwn") }], own ? "own" : "inherit", (v) => {
      own = v === "own";
      draw();
    });
    box.append(seg);
  }
  box.append(body);
  draw();
  return {
    el: box,
    read: () => {
      if (!own) return null;
      const bad = validateStages(list, types);
      if (bad) throw new Error(t(`mcr.chain.err.${bad}`));
      return list.map((s) => {
        const p = Object.fromEntries(Object.entries(s.params ?? {}).filter(([k]) => k.trim()));
        return { ...s, params: Object.keys(p).length ? p : undefined };
      });
    },
  };
}
