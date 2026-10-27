// Startdialog des Node-Katalogs: Name (optional), Zielhost, I/O-Port und die Einstellungen des Node-Typs, bevor die Instanz startet.
// Ersetzt die Eingabefelder in der Katalogkarte und die reine Sicherheitsabfrage. Der Dialog führt den Start selbst aus (`submit`) und
// bleibt bei einem Fehler offen, mit der Meldung des Orchestrators, damit nichts neu eingegeben werden muss.

import { apiFetch } from "../shell/connection.ts";
import { classify, type ErrorCode, helpBlock, loadErrorCodes } from "../shell/errorcodes.ts";
import { t } from "../shell/i18n.ts";
import { groupOptions, hintFor, inputKind, type OptionDef } from "../shell/settings-logic.ts";
import { buildStartBody, emptyMeaning, findPairs, type OptionPair, presetFor, RATES, RESOLUTIONS, type StartBody, type StartForm, valuesForPreset } from "./start-dialog-logic.ts";

export interface StartDialogEntry {
  type: string;
  label: string;
  version?: string;
  description?: string;
  expectedResources?: string;
}

export interface StartDialogHost {
  id: string;
  label: string;
  online: boolean;
  /** Tooltip (Zeit der letzten Telemetrie o. ä.). */
  title?: string;
}

export interface StartDialogOptions {
  entry: StartDialogEntry;
  hosts: StartDialogHost[];
  /** Nur DeckLink: Richtung des physischen Ports wählen. */
  ioPort: boolean;
  /** Zusatzzeile unter dem Host (z. B. Profil-Ampel); wird bei jeder Host-Wahl neu befüllt. */
  fillProfile?: (target: HTMLElement, hostId: string) => void;
  /** Führt den Start aus; Rückgabe = Fehlermeldung (Dialog bleibt offen) oder null (Dialog schließt). */
  submit: (body: StartBody) => Promise<string | null>;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

const DIM = "color:var(--omp-text-dim);";
const INPUT = "box-sizing:border-box;width:100%;padding:5px 8px;font:inherit;color:inherit;background:var(--omp-surface-raised,#2f3339);border:1px solid var(--omp-border,#3a3f45);border-radius:var(--omp-radius,6px);";

function labelled(label: string, control: HTMLElement, hint = ""): HTMLElement {
  const w = el("label", "display:flex;flex-direction:column;gap:3px;margin-bottom:10px;");
  w.append(el("span", "font-size:11px;letter-spacing:.05em;text-transform:uppercase;" + DIM, label), control);
  if (hint) w.append(el("span", "font-size:11px;" + DIM, hint));
  return w;
}

async function loadOptions(type: string): Promise<OptionDef[]> {
  try {
    const res = await apiFetch("/api/v1/admin/settings/nodes");
    if (!res.ok) return [];
    const body = (await res.json()) as { types?: { type: string; options?: OptionDef[] }[] };
    return body.types?.find((x) => x.type === type)?.options ?? [];
  } catch {
    return [];
  }
}

/** Öffnet den Dialog. Löst mit true auf, wenn gestartet wurde, mit false bei Abbruch. */
export function openStartDialog(opts: StartDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const form: StartForm = { name: "", hostId: "", ioDirection: opts.ioPort ? "in" : "", options: {} };

    const root = el("div", "position:fixed;inset:0;z-index:3000;display:flex;align-items:center;justify-content:center;font-family:var(--omp-font,system-ui,sans-serif);font-size:var(--omp-font-size-sm,12px);");
    root.setAttribute("data-role", "start-dialog");
    const backdrop = el("div", "position:absolute;inset:0;background:rgba(0,0,0,.5);");
    const dlg = el("div", "position:relative;display:flex;flex-direction:column;max-height:88vh;width:min(94vw,520px);background:var(--omp-surface,#24272b);color:var(--omp-text,#e8eaed);border:1px solid var(--omp-border,#3a3f45);border-radius:var(--omp-radius,6px);box-shadow:0 4px 16px rgba(0,0,0,.4);");
    dlg.setAttribute("role", "dialog");
    dlg.setAttribute("aria-modal", "true");

    const title = opts.entry.version ? `${opts.entry.label} (${opts.entry.version})` : opts.entry.label;
    const head = el("div", "padding:14px 16px 8px;");
    head.append(el("div", "font-size:15px;font-weight:600;", t("flow.sd.title", { p0: title })));
    if (opts.entry.description) head.append(el("div", "margin-top:4px;" + DIM, opts.entry.description));
    if (opts.entry.expectedResources) head.append(el("div", "font-style:italic;" + DIM, `~ ${opts.entry.expectedResources}`));

    const body = el("div", "padding:8px 16px;overflow:auto;");

    const nameInput = el("input", INPUT);
    nameInput.type = "text";
    nameInput.autocomplete = "off";
    nameInput.placeholder = t("flow.sd.namePh");
    nameInput.addEventListener("input", () => (form.name = nameInput.value));
    body.append(labelled(t("flow.sd.name"), nameInput, t("flow.sd.nameHint")));

    if (opts.hosts.length > 0) {
      const sel = el("select", INPUT);
      const local = el("option", "", t("flow.sd.local"));
      local.value = "";
      sel.append(local);
      for (const h of opts.hosts) {
        const o = el("option", h.online ? "" : "color:#e05252;", h.online ? `● ${h.label}` : t("flow.390d13", { p0: h.label }));
        o.value = h.id;
        if (h.title) o.title = h.title;
        sel.append(o);
      }
      const profile = el("div", "font-size:11px;margin-top:2px;");
      sel.addEventListener("change", () => {
        form.hostId = sel.value;
        profile.textContent = "";
        opts.fillProfile?.(profile, form.hostId);
      });
      body.append(labelled(t("flow.ada9a7"), sel), profile);
      opts.fillProfile?.(profile, "");
    } else if (opts.fillProfile) {
      const profile = el("div", "font-size:11px;margin:-6px 0 10px;");
      body.append(profile);
      opts.fillProfile(profile, "");
    }

    if (opts.ioPort) {
      const sel = el("select", INPUT);
      for (const [v, key] of [["in", "flow.sd.ioIn"], ["out", "flow.sd.ioOut"]] as const) {
        const o = el("option", "", t(key));
        o.value = v;
        sel.append(o);
      }
      sel.addEventListener("change", () => (form.ioDirection = sel.value as "in" | "out"));
      body.append(labelled(t("flow.sd.io"), sel, t("flow.3a4eae")));
    }

    // Einstellungen des Node-Typs (Schema aus node-options.json) — werden nachgeladen, der Dialog ist sofort bedienbar.
    const settings = el("div", "margin-top:4px;");
    body.append(settings);
    void loadOptions(opts.entry.type).then((defs) => {
      settings.replaceChildren();
      if (defs.length === 0) return;
      const box = el("details", "border-top:1px solid var(--omp-border,#3a3f45);padding-top:8px;");
      box.open = true;
      box.append(el("summary", "cursor:pointer;font-weight:600;margin-bottom:6px;", t("flow.sd.settings", { p0: defs.length })));
      box.append(el("div", "margin-bottom:8px;" + DIM, t("flow.sd.settingsHint")));
      // Auflösung und Bildrate als Auswahl: Breite/Höhe bzw. Zähler/Nenner stehen sonst als vier Zahlenfelder nebeneinander (Nutzerfund 2026-10-27).
      const pairs = findPairs(defs.map((d) => d.key));
      const pairOfFirst = new Map(pairs.map((p) => [p.first, p]));
      const pairSecond = new Set(pairs.map((p) => p.second));
      const defByKey = new Map(defs.map((d) => [d.key, d]));
      const pairRow = (pair: OptionPair): HTMLElement => {
        const d1 = defByKey.get(pair.first)!, d2 = defByKey.get(pair.second)!;
        const sel = el("select", INPUT);
        const std = el("option", "", t("flow.sd.presetDefault"));
        std.value = "";
        sel.append(std);
        (pair.kind === "resolution" ? RESOLUTIONS : RATES).forEach((r, i) => {
          const o = el("option", "", pair.kind === "resolution" ? r.label : t("flow.sd.fps", { p0: r.label }));
          o.value = String(i);
          sel.append(o);
        });
        const custom = el("option", "", t("flow.sd.presetCustom"));
        custom.value = "custom";
        sel.append(custom);
        const mk = (label: string, def: OptionDef): HTMLElement => {
          const i = el("input", INPUT);
          i.type = "number";
          if (def.min !== undefined) i.min = String(def.min);
          if (def.max !== undefined) i.max = String(def.max);
          i.addEventListener("input", () => {
            form.options[def.key] = i.value;
            sel.value = presetFor(pair.kind, form.options[pair.first] ?? "", form.options[pair.second] ?? "");
          });
          return labelled(label, i);
        };
        const l1 = pair.kind === "resolution" ? t("flow.sd.width") : t("flow.sd.rateNum");
        const l2 = pair.kind === "resolution" ? t("flow.sd.height") : t("flow.sd.rateDen");
        const f1 = mk(l1, d1), f2 = mk(l2, d2);
        const own = el("div", "display:none;gap:10px;");
        own.append(f1, f2);
        const apply = () => {
          const v = valuesForPreset(pair.kind, sel.value);
          if (v) {
            form.options[pair.first] = v[0];
            form.options[pair.second] = v[1];
            (f1.querySelector("input") as HTMLInputElement).value = v[0];
            (f2.querySelector("input") as HTMLInputElement).value = v[1];
          }
          own.style.display = sel.value === "custom" ? "flex" : "none";
        };
        sel.addEventListener("change", apply);
        const row = labelled(pair.kind === "resolution" ? t("flow.sd.resolution") : t("flow.sd.rate"), sel, pair.kind === "resolution" ? t("flow.sd.resolutionHint") : t("flow.sd.rateHint"));
        row.dataset.optionKey = pair.first;
        row.append(own);
        return row;
      };
      for (const [group, list] of groupOptions(defs)) {
        box.append(el("div", "margin:8px 0 4px;font-weight:600;" + DIM, group));
        for (const o of list) {
          if (pairSecond.has(o.key)) continue;
          const pair = pairOfFirst.get(o.key);
          if (pair) {
            box.append(pairRow(pair));
            continue;
          }
          let control: HTMLInputElement | HTMLSelectElement;
          const meaning = emptyMeaning(o);
          if (inputKind(o) === "select") {
            const s = el("select", INPUT);
            const std = el("option", "", meaning.text ? t("flow.sd.emptyIs", { p0: meaning.text }) : t("flow.sd.emptyDefault"));
            std.value = "";
            s.append(std);
            for (const c of o.choices ?? []) {
              const op = el("option", "", c.label ?? c.value);
              op.value = c.value;
              s.append(op);
            }
            control = s;
          } else {
            const i = el("input", INPUT);
            i.type = inputKind(o) === "number" ? "number" : "text";
            if (o.min !== undefined) i.min = String(o.min);
            if (o.max !== undefined) i.max = String(o.max);
            i.autocomplete = "off";
            i.placeholder = meaning.text ? t("flow.sd.emptyIs", { p0: meaning.text }) : o.placeholder || t("flow.sd.emptyDefault");
            control = i;
          }
          control.addEventListener("input", () => (form.options[o.key] = control.value));
          control.addEventListener("change", () => (form.options[o.key] = control.value));
          const row = labelled(o.label, control, [o.description, hintFor(o)].filter(Boolean).join(" · "));
          row.dataset.optionKey = o.key;
          box.append(row);
        }
      }
      settings.append(box);
    });

    const error = el("div", "padding:0 16px;color:var(--omp-error,#e55);white-space:pre-wrap;");
    error.setAttribute("role", "alert");
    // Fehlercode zur Meldung (Ursache und Lösungsschritte), sobald der Katalog da ist.
    const errorHelp = el("div", "padding:0 16px 6px;");
    let codes: ErrorCode[] = [];
    void loadErrorCodes().then((c) => (codes = c));
    const actions = el("div", "display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--omp-border,#3a3f45);");
    const btnCss = "cursor:pointer;font:inherit;padding:6px 14px;border-radius:var(--omp-radius,6px);border:1px solid var(--omp-border,#3a3f45);background:var(--omp-surface-raised,#2f3339);color:inherit;";
    const cancel = el("button", btnCss, t("kit.cancel"));
    cancel.type = "button";
    const ok = el("button", btnCss + "background:var(--omp-info,#4285f4);border-color:var(--omp-info,#4285f4);color:#fff;", t("flow.confirmStartLabel"));
    ok.type = "button";
    actions.append(cancel, ok);
    dlg.append(head, body, error, errorHelp, actions);
    root.append(backdrop, dlg);

    let busy = false;
    const close = (started: boolean) => {
      document.removeEventListener("keydown", onKey, true);
      root.remove();
      resolve(started);
    };
    const start = async () => {
      if (busy) return;
      busy = true;
      ok.disabled = true;
      error.textContent = "";
      errorHelp.replaceChildren();
      const msg = await opts.submit(buildStartBody(opts.entry.type, opts.entry.version, form));
      busy = false;
      ok.disabled = false;
      if (msg) {
        error.textContent = msg;
        const code = classify(codes, msg);
        if (code) errorHelp.append(el("div", `font-weight:600;color:var(--omp-text,#e8eaed);`, `${code.code} — ${code.title}`), helpBlock(code));
      } else close(true);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        close(false);
      } else if (ev.key === "Enter" && (ev.target as HTMLElement).tagName === "INPUT" && !(ev.target as HTMLInputElement).closest("details")) {
        void start();
      }
    };
    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("click", () => close(false));
    cancel.addEventListener("click", () => close(false));
    ok.addEventListener("click", () => void start());
    document.body.append(root);
    nameInput.focus();
  });
}
