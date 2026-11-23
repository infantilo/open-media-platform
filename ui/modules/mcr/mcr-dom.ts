// DOM-Hilfen und Stil des MCR-Arbeitsplatzes. Ein Stylesheet für das ganze Modul (einmal in den Kopf der Seite gesetzt);
// Farben und Abstände kommen aus den Design-Tokens der Shell. Alle Größen sind fest, damit beim Eintreffen neuer Werte nichts springt.
import { t } from "../host.ts";

type Attrs = Record<string, string | number | boolean | undefined | ((e: Event) => void)>;

/** Baut ein Element: `h("div", {class: "x", onclick: fn}, "Text" | Node | [...])`. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") e.className = String(v);
    else if (v === true) e.setAttribute(k, "");
    else e.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(c));
  return e;
}

const STYLE_ID = "omp-mcr-style";

export function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.append(s);
}

/** Meldung unter einer Eingabe oder als Streifen. */
export const note = (text: string, kind: "info" | "warn" | "bad" = "info"): HTMLElement => h("div", { class: `mcr-note mcr-note-${kind}` }, text);

/** Modaler Dialog mit ausdrücklichem „Übernehmen“. Löst mit dem Rückgabewert von `onSave` (null = Abbruch) auf. */
export function modal<T>(title: string, body: HTMLElement, opts: { save?: string; onSave: () => T | null | Promise<T | null>; wide?: boolean; hint?: () => string[] }): Promise<T | null> {
  ensureStyle();
  return new Promise((resolve) => {
    const back = h("div", { class: "mcr-back" });
    const err = h("div", { class: "mcr-modal-err", "aria-live": "polite" });
    const save = h("button", { class: "mcr-btn mcr-btn-primary", type: "button" }, opts.save ?? t("mcr.save"));
    const cancel = h("button", { class: "mcr-btn", type: "button" }, t("mcr.cancel"));
    const box = h("div", { class: `mcr-modal${opts.wide ? " mcr-modal-wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title }, h("h2", {}, title), h("div", { class: "mcr-modal-body" }, body), err, h("div", { class: "mcr-modal-actions" }, cancel, save));
    back.append(box);
    const close = (v: T | null) => {
      document.removeEventListener("keydown", onKey);
      back.remove();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(null);
    };
    document.addEventListener("keydown", onKey);
    cancel.addEventListener("click", () => close(null));
    back.addEventListener("mousedown", (e) => {
      if (e.target === back) close(null);
    });
    save.addEventListener("click", async () => {
      err.textContent = "";
      save.disabled = true;
      try {
        const v = await opts.onSave();
        if (v !== null) close(v);
      } catch (e) {
        err.textContent = String((e as Error).message ?? e);
      } finally {
        save.disabled = false;
      }
    });
    document.body.append(back);
    (box.querySelector("input,select,textarea") as HTMLElement | null)?.focus();
  });
}

/** Beschriftetes Eingabefeld. */
export function field(label: string, input: HTMLElement, hint = ""): HTMLElement {
  const id = `mcr-f-${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  return h("div", { class: "mcr-field" }, h("label", { for: id }, label), input, hint ? h("div", { class: "mcr-hint" }, hint) : null);
}

export const input = (value: string | number | undefined, attrs: Attrs = {}): HTMLInputElement => {
  const i = h("input", { type: "text", ...attrs });
  i.value = value === undefined ? "" : String(value);
  return i;
};

/** Datum-und-Uhrzeit-Feld mit Auswahldialog des Browsers: ein Klick irgendwo ins Feld öffnet ihn, das Symbol ist auch auf dunklem Grund sichtbar. */
export function dateTime(value = ""): HTMLInputElement {
  const i = h("input", { type: "datetime-local", step: 60, class: "mcr-dt" });
  i.value = value;
  const open = () => {
    try {
      (i as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
    } catch { /* nur nach Nutzeraktion erlaubt; sonst bleibt die Tastatureingabe */ }
  };
  i.addEventListener("click", open);
  return i;
}

/** Lokale Zeit als Wert für `datetime-local` („2026-11-20T19:30“). */
export function toLocalValue(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/** Nächste volle Stunde (Vorbelegung für einen neuen Termin). */
export function nextFullHour(now = new Date()): Date {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

/** Schnellwahl unter einem Zeitfeld: „Jetzt“, „+1 h“, „Heute 20:00“ … */
export function quickTimes(target: HTMLInputElement, items: { label: string; at: () => Date }[]): HTMLElement {
  const row = h("div", { class: "mcr-quick" });
  for (const it of items) {
    const b = h("button", { type: "button", class: "mcr-chip" }, it.label);
    b.addEventListener("click", () => {
      target.value = toLocalValue(it.at());
      target.dispatchEvent(new Event("change", { bubbles: true }));
    });
    row.append(b);
  }
  return row;
}

export function select(options: { value: string; label: string }[], value: string, attrs: Attrs = {}): HTMLSelectElement {
  const s = h("select", attrs);
  for (const o of options) s.append(h("option", { value: o.value }, o.label));
  s.value = value;
  return s;
}

/** Umschalter aus nebeneinanderstehenden Knöpfen (genau einer aktiv). */
export function segmented(options: { value: string; label: string; title?: string }[], value: string, onChange: (v: string) => void): HTMLElement {
  const wrap = h("div", { class: "mcr-seg", role: "group" });
  const btns = options.map((o) => {
    const b = h("button", { type: "button", class: "mcr-seg-b", title: o.title, "aria-pressed": String(o.value === value) }, o.label);
    b.addEventListener("click", () => {
      for (const x of btns) x.setAttribute("aria-pressed", "false");
      b.setAttribute("aria-pressed", "true");
      onChange(o.value);
    });
    return b;
  });
  wrap.append(...btns);
  return wrap;
}

const CSS = `
.mcr { --mcr-ok: var(--omp-preset); --mcr-warn: var(--omp-cue); --mcr-bad: var(--omp-error); --mcr-line: var(--omp-border);
  --mcr-card: #101828; --mcr-card-hi: #14203a; display:grid; grid-template-rows:auto 1fr; height:100%; min-height:0; color:var(--omp-text);
  font-family:var(--omp-font); font-size:var(--omp-font-size-md); font-variant-numeric:tabular-nums; }
.mcr * { box-sizing:border-box; }
.mcr button { font:inherit; color:inherit; cursor:pointer; }
.mcr button:focus-visible, .mcr input:focus-visible, .mcr select:focus-visible { outline:none; box-shadow:var(--omp-focus-ring); border-color:var(--omp-accent-cyan); }
.mcr-tabs { display:flex; gap:4px; padding:0 16px; border-bottom:1px solid var(--mcr-line); background:var(--omp-surface); }
.mcr-tab { background:none; border:0; padding:12px 16px 11px; color:var(--omp-text-dim); border-bottom:2px solid transparent; font-size:var(--omp-font-size-lg); }
.mcr-tab:hover { color:var(--omp-text); }
.mcr-tab[aria-selected="true"] { color:var(--omp-text); border-image:var(--omp-accent-gradient) 1; border-bottom-width:2px; border-bottom-style:solid; }
.mcr-tab-spacer { flex:1; }
.mcr-clock { align-self:center; color:var(--omp-text-dim); font-size:var(--omp-font-size-sm); }
.mcr-body { min-height:0; overflow:hidden; }
.mcr-split { display:grid; grid-template-columns:320px minmax(0,1fr); height:100%; min-height:0; }
.mcr-rail { border-right:1px solid var(--mcr-line); background:var(--omp-surface); display:flex; flex-direction:column; min-height:0; }
.mcr-rail-head { padding:12px 12px 8px; display:flex; flex-direction:column; gap:10px; }
.mcr-chips { display:flex; flex-wrap:wrap; gap:6px; }
.mcr-chip { border:1px solid var(--mcr-line); background:transparent; border-radius:999px; padding:3px 10px; font-size:var(--omp-font-size-sm); color:var(--omp-text-dim); }
.mcr-adv { border:1px solid var(--mcr-line); border-radius:8px; padding:8px 12px; }
.mcr-adv summary { cursor:pointer; color:var(--omp-text-dim); }
.mcr-chip[data-custom] { color:var(--omp-warning,#e0a030); border-color:currentColor; cursor:default; }
.mcr-chip[aria-pressed="true"] { color:var(--omp-text); border-color:var(--omp-accent-cyan); background:rgba(25,211,243,.08); }
.mcr-rail-list { overflow:auto; padding:4px 10px 14px; display:flex; flex-direction:column; gap:8px; min-height:0; flex:1; }
.mcr-ev { position:relative; text-align:left; border:1px solid var(--mcr-line); background:var(--mcr-card); border-radius:8px; padding:10px 12px 10px 16px; height:76px; display:grid; grid-template-rows:auto auto; gap:2px; align-content:center; overflow:hidden; }
.mcr-ev::before { content:""; position:absolute; left:0; top:0; bottom:0; width:5px; background:var(--st,var(--omp-text-dim)); }
.mcr-ev:hover { background:var(--mcr-card-hi); }
.mcr-ev[aria-current="true"] { border-color:var(--omp-accent-cyan); background:var(--mcr-card-hi); box-shadow:0 0 0 1px rgba(25,211,243,.25); }
.mcr-ev-name { font-weight:600; font-size:var(--omp-font-size-lg); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.mcr-ev-sub { color:var(--omp-text-dim); font-size:var(--omp-font-size-sm); display:flex; gap:8px; align-items:center; white-space:nowrap; overflow:hidden; }
.mcr-pill { display:inline-flex; align-items:center; gap:6px; padding:1px 8px; border-radius:999px; font-size:var(--omp-font-size-xs); color:var(--st,var(--omp-text-dim)); border:1px solid color-mix(in srgb,var(--st,#888) 55%,transparent); background:color-mix(in srgb,var(--st,#888) 12%,transparent); }
.mcr-badge { margin-left:auto; min-width:18px; height:18px; padding:0 5px; border-radius:9px; background:var(--mcr-warn); color:#1b1200; font-size:var(--omp-font-size-xs); font-weight:700; display:inline-flex; align-items:center; justify-content:center; }
.mcr-main { overflow:auto; min-height:0; padding:18px 22px 40px; }
.mcr-empty { display:grid; place-items:center; height:100%; text-align:center; color:var(--omp-text-dim); gap:10px; padding:40px; }
.mcr-empty h3 { margin:0; color:var(--omp-text); font-size:20px; font-weight:600; }
.mcr-btn { background:var(--omp-surface-raised); border:1px solid var(--mcr-line); border-radius:6px; padding:6px 14px; min-height:32px; }
.mcr-btn:hover:not(:disabled) { border-color:var(--omp-accent-cyan); }
.mcr-btn:disabled { opacity:.45; cursor:default; }
.mcr-btn-primary { background:linear-gradient(90deg,#0f8fa6,#6b3fc2); border-color:transparent; font-weight:600; }
.mcr-btn-primary:hover:not(:disabled) { filter:brightness(1.12); border-color:transparent; }
.mcr-btn-live { background:var(--omp-onair); border-color:transparent; font-weight:700; }
.mcr-btn-quiet { background:transparent; }
.mcr-btn-sm { min-height:26px; padding:2px 10px; font-size:var(--omp-font-size-sm); }
.mcr-head { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:6px 24px; align-items:start; margin-bottom:16px; }
.mcr-title { margin:0; font-size:26px; font-weight:650; letter-spacing:-.01em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.mcr-meta { color:var(--omp-text-dim); display:flex; gap:14px; flex-wrap:wrap; align-items:center; min-height:22px; }
.mcr-actions { display:flex; gap:8px; align-items:center; justify-content:flex-end; flex-wrap:wrap; }
.mcr-steps { grid-column:1/-1; display:grid; grid-template-columns:repeat(5,1fr); gap:0; margin-top:10px; }
.mcr-step { position:relative; padding:8px 0 0; color:var(--omp-text-disabled); font-size:var(--omp-font-size-sm); text-align:left; }
.mcr-step::before { content:""; position:absolute; top:0; left:0; right:6px; height:4px; border-radius:2px; background:var(--omp-border); }
.mcr-step[data-s="past"]::before { background:color-mix(in srgb,var(--st) 45%,var(--omp-border)); }
.mcr-step[data-s="now"]::before { background:var(--st); box-shadow:0 0 8px var(--st); }
.mcr-step[data-s="now"] { color:var(--omp-text); font-weight:600; }
.mcr-step[data-s="past"] { color:var(--omp-text-dim); }
.mcr-warns { display:flex; flex-direction:column; gap:6px; margin-bottom:14px; }
.mcr-note { padding:8px 12px; border-radius:6px; border:1px solid var(--mcr-line); background:var(--mcr-card); color:var(--omp-text-dim); font-size:var(--omp-font-size-sm); }
.mcr-note-warn { border-color:color-mix(in srgb,var(--mcr-warn) 55%,transparent); background:color-mix(in srgb,var(--mcr-warn) 9%,transparent); color:var(--omp-text); }
.mcr-note-bad { border-color:color-mix(in srgb,var(--mcr-bad) 55%,transparent); background:color-mix(in srgb,var(--mcr-bad) 9%,transparent); color:var(--omp-text); }
.mcr-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(420px,1fr)); gap:14px; align-items:start; }
.mcr-card { background:var(--mcr-card); border:1px solid var(--mcr-line); border-radius:10px; padding:14px 16px 12px; display:grid; gap:12px; height:272px; grid-template-rows:28px 54px 76px 20px 26px; align-content:start; overflow:hidden; }
.mcr-card[data-mode="blocked"] { border-color:color-mix(in srgb,var(--mcr-warn) 60%,var(--mcr-line)); }
.mcr-card[data-mode="error"] { border-color:color-mix(in srgb,var(--mcr-bad) 70%,var(--mcr-line)); }
.mcr-card-head { display:flex; align-items:center; gap:10px; min-width:0; }
.mcr-lamp { width:12px; height:12px; border-radius:50%; background:var(--c,var(--omp-text-disabled)); box-shadow:0 0 0 3px color-mix(in srgb,var(--c,#555) 22%,transparent); flex:none; transition:background .2s; }
.mcr-card[data-mode="error"] .mcr-lamp, .mcr-card[data-mode="blocked"] .mcr-lamp { animation:omp-pulse 1.2s infinite; }
.mcr-card-name { font-size:17px; font-weight:650; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.mcr-kind { margin-left:auto; flex:none; font-size:var(--omp-font-size-xs); color:var(--omp-text-dim); border:1px solid var(--mcr-line); border-radius:4px; padding:1px 7px; }
.mcr-kebab { flex:none; background:none; border:0; color:var(--omp-text-dim); padding:2px 6px; border-radius:4px; }
.mcr-kebab:hover { background:var(--omp-surface-raised); color:var(--omp-text); }
.mcr-path { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:0; }
.mcr-node { border:1px solid var(--mcr-line); background:#0b1220; border-radius:8px; padding:6px 10px; display:grid; gap:1px; min-width:112px; height:52px; align-content:center; }
.mcr-node small { color:var(--omp-text-dim); font-size:var(--omp-font-size-xs); }
.mcr-node b { font-size:15px; font-weight:650; white-space:nowrap; }
.mcr-wire { position:relative; height:52px; display:flex; flex-wrap:wrap; gap:4px; align-content:center; justify-content:center; padding:0 10px; }
.mcr-wire::before { content:""; position:absolute; left:0; right:0; top:50%; height:2px; background:var(--wc,var(--omp-border)); z-index:0; }
.mcr-wire > * { position:relative; z-index:1; }
.mcr-stage { background:var(--omp-surface-raised); border:1px solid color-mix(in srgb,var(--omp-accent-cyan) 60%,transparent); color:var(--omp-accent-cyan); border-radius:999px; padding:1px 9px; font-size:var(--omp-font-size-xs); }
.mcr-pass { background:#0b1220; padding:0 8px; font-size:var(--omp-font-size-xs); color:var(--mcr-ok); }
.mcr-pass[data-k="blocked"] { color:var(--mcr-warn); } .mcr-pass[data-k="error"] { color:var(--mcr-bad); } .mcr-pass[data-k="waiting"] { color:var(--omp-text-disabled); }
.mcr-av { display:grid; grid-template-rows:auto 14px auto; gap:6px; }
.mcr-av-top { display:flex; align-items:baseline; gap:10px; min-width:0; }
.mcr-av-val { font-size:22px; font-weight:650; min-width:92px; }
.mcr-av-val[data-l="ok"] { color:var(--mcr-ok); } .mcr-av-val[data-l="warn"] { color:var(--mcr-warn); } .mcr-av-val[data-l="bad"] { color:var(--mcr-bad); } .mcr-av-val[data-l="none"] { color:var(--omp-text-disabled); }
.mcr-av-lbl { color:var(--omp-text-dim); font-size:var(--omp-font-size-sm); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.mcr-gauge { position:relative; height:14px; border-radius:7px; overflow:hidden; background:linear-gradient(90deg,
   rgba(239,83,80,.30) 0, rgba(239,83,80,.30) 0%, rgba(239,83,80,.30) 22.2%,
   rgba(251,140,0,.30) 22.2%, rgba(251,140,0,.30) 44.4%,
   rgba(67,160,71,.45) 44.4%, rgba(67,160,71,.45) 55.6%,
   rgba(251,140,0,.30) 55.6%, rgba(251,140,0,.30) 66.7%,
   rgba(239,83,80,.30) 66.7%); }
.mcr-gauge::after { content:""; position:absolute; left:55.56%; top:0; bottom:0; width:1px; background:rgba(255,255,255,.55); }
.mcr-needle { position:absolute; top:-2px; bottom:-2px; width:4px; margin-left:-2px; border-radius:2px; background:#fff; box-shadow:0 0 6px rgba(255,255,255,.8); left:50%; transition:left .35s ease; z-index:2; }
.mcr-needle[data-on="0"] { opacity:0; }
.mcr-av-bot { display:flex; gap:8px; align-items:center; min-width:0; }
.mcr-av-bot .mcr-seg { margin-left:auto; }
.mcr-stats { display:flex; gap:16px; color:var(--omp-text-dim); font-size:var(--omp-font-size-sm); white-space:nowrap; overflow:hidden; align-items:center; }
.mcr-stats b { color:var(--omp-text); font-weight:600; }
.mcr-foot { display:flex; gap:8px; align-items:center; min-width:0; flex-wrap:wrap; }
.mcr-ret { display:inline-flex; align-items:center; gap:6px; font-size:var(--omp-font-size-sm); color:var(--omp-text-dim); white-space:nowrap; }
.mcr-ret i { width:8px; height:8px; border-radius:50%; background:var(--c,var(--omp-text-disabled)); display:inline-block; }
.mcr-seg { display:inline-flex; border:1px solid var(--mcr-line); border-radius:6px; overflow:hidden; flex:none; }
.mcr-seg-b { background:transparent; border:0; padding:3px 10px; font-size:var(--omp-font-size-sm); color:var(--omp-text-dim); min-height:26px; }
.mcr-seg-b + .mcr-seg-b { border-left:1px solid var(--mcr-line); }
.mcr-seg-b[aria-pressed="true"] { background:rgba(25,211,243,.14); color:var(--omp-text); }
.mcr-add { border:2px dashed var(--mcr-line); border-radius:10px; background:transparent; color:var(--omp-text-dim); height:272px; display:grid; place-items:center; align-content:center; gap:6px; font-size:var(--omp-font-size-lg); }
.mcr-add:hover { border-color:var(--omp-accent-cyan); color:var(--omp-text); }
.mcr-add b { font-size:32px; font-weight:300; line-height:1; }
.mcr-page { padding:22px 28px 40px; overflow:auto; height:100%; }
.mcr-page h2 { margin:0 0 4px; font-size:22px; font-weight:650; }
.mcr-sub { color:var(--omp-text-dim); margin:0 0 18px; max-width:70ch; }
.mcr-tpl-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:14px; }
.mcr-tpl { background:var(--mcr-card); border:1px solid var(--mcr-line); border-radius:10px; padding:14px 16px; display:grid; gap:10px; height:196px; grid-template-rows:auto 1fr auto; overflow:hidden; }
.mcr-tpl h3 { margin:0; font-size:17px; font-weight:650; }
.mcr-tpl-lines { display:flex; flex-wrap:wrap; gap:6px; align-content:flex-start; overflow:hidden; }
.mcr-lchip { border:1px solid var(--mcr-line); border-radius:6px; padding:2px 8px; font-size:var(--omp-font-size-sm); background:#0b1220; }
.mcr-lchip em { font-style:normal; color:var(--omp-text-dim); margin-left:6px; font-size:var(--omp-font-size-xs); }
.mcr-form { display:grid; gap:14px; max-width:760px; }
.mcr-form-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; align-items:start; }
.mcr-fieldset { border:1px solid #2b3b5c; border-radius:10px; padding:14px 16px 16px; background:var(--mcr-card); display:grid; gap:12px; }
.mcr-fieldset h3 { margin:0; font-size:15px; font-weight:650; }
.mcr-field { display:grid; gap:4px; min-width:0; align-content:start; }
.mcr-field label { color:var(--omp-text-dim); font-size:var(--omp-font-size-sm); }
.mcr-field input, .mcr-field select, .mcr-field textarea { background:#0b1220; border:1px solid var(--mcr-line); color:var(--omp-text); border-radius:6px; padding:6px 9px; min-height:32px; font:inherit; width:100%; }
.mcr-hint { color:var(--omp-text-disabled); font-size:var(--omp-font-size-xs); }
.mcr-back { --mcr-line: var(--omp-border); --mcr-card: #101828; --mcr-card-hi: #14203a; --mcr-ok: var(--omp-preset); --mcr-warn: var(--omp-cue); --mcr-bad: var(--omp-error); }
.mcr-back *, .mcr-back *::before, .mcr-back *::after { box-sizing:border-box; }
.mcr-back button { font:inherit; cursor:pointer; }
.mcr-back button:focus-visible, .mcr-back input:focus-visible, .mcr-back select:focus-visible { outline:none; box-shadow:var(--omp-focus-ring); border-color:var(--omp-accent-cyan); }
.mcr-back { position:fixed; inset:0; z-index:2500; background:rgba(3,6,12,.66); display:grid; place-items:center; padding:20px; }
.mcr-modal { background:var(--omp-surface); border:1px solid var(--mcr-line); border-radius:12px; padding:20px 22px 16px; width:min(560px,100%); max-height:calc(100vh - 40px); display:flex; flex-direction:column; gap:14px; box-shadow:0 18px 60px rgba(0,0,0,.6); color:var(--omp-text); font-family:var(--omp-font); font-size:var(--omp-font-size-md); }
.mcr-modal-wide { width:min(760px,100%); }
.mcr-modal h2 { flex:none; margin:0; font-size:20px; font-weight:650; }
.mcr-modal-body { overflow-y:auto; overflow-x:hidden; display:grid; gap:14px; align-content:start; padding:2px 4px 2px 2px; flex:1 1 auto; min-height:0; }
.mcr-modal-err { flex:none; color:var(--omp-error); min-height:0; white-space:pre-wrap; font-size:var(--omp-font-size-sm); }
.mcr-modal-actions { display:flex; justify-content:flex-end; gap:8px; flex:none; }
.mcr-modal .mcr-btn, .mcr-modal .mcr-seg-b { color:var(--omp-text); font:inherit; }
.mcr-tracks { display:flex; flex-direction:column; gap:8px; }
.mcr-track { border:1px solid var(--omp-border); border-radius:10px; padding:8px 10px; display:flex; flex-direction:column; gap:6px; }
.mcr-track-head { display:flex; gap:8px; align-items:center; }
.mcr-track-head input { flex:1; min-width:0; }
.mcr-chip[aria-pressed=true] { border-color:var(--omp-accent-cyan); color:var(--omp-accent-cyan); }
.mcr-dt { color-scheme:dark; cursor:pointer; min-width:0; }
.mcr-dt::-webkit-calendar-picker-indicator { cursor:pointer; opacity:.85; padding:4px; }
.mcr-quick { display:flex; gap:6px; flex-wrap:wrap; margin-top:2px; }
.mcr-back select, .mcr-back input { color-scheme:dark; }
.mcr-sw { display:flex; align-items:center; gap:10px; color:var(--omp-text); }
.mcr-sw input { width:auto; min-height:0; }
@media (prefers-reduced-motion: reduce) { .mcr-needle, .mcr-lamp { transition:none; animation:none !important; } }
@media (max-width: 900px) { .mcr-split { grid-template-columns:1fr; grid-template-rows:auto 1fr; } .mcr-rail { border-right:0; border-bottom:1px solid var(--mcr-line); max-height:240px; } .mcr-grid { grid-template-columns:1fr; } }
.mcr-modal:has(.mcr-mx) { width:min(1180px,100%); }
.mcr-mx { display:flex; flex-direction:column; gap:10px; min-width:0; }
.mcr-mx-bar { display:flex; gap:14px; align-items:center; }
.mcr-mx-search { width:240px; flex:none; height:32px; padding:0 10px; background:var(--omp-surface-raised); border:1px solid var(--mcr-line); border-radius:6px; color:var(--omp-text); font:inherit; }
.mcr-mx-scroll { overflow:auto; height:min(56vh,560px); border:1px solid var(--mcr-line); border-radius:8px; background:var(--mcr-card); }
.mcr-mx-table { border-collapse:separate; border-spacing:0; width:max-content; min-width:100%; }
.mcr-mx-table th, .mcr-mx-table td { padding:0; border-bottom:1px solid color-mix(in srgb,var(--mcr-line) 60%,transparent); border-right:1px solid color-mix(in srgb,var(--mcr-line) 40%,transparent); text-align:center; }
.mcr-mx-table thead th { position:sticky; top:0; z-index:3; background:var(--omp-surface); }
.mcr-mx-corner, .mcr-mx-row, .mcr-mx-grow th { position:sticky; left:0; z-index:2; background:var(--omp-surface); text-align:left !important; }
.mcr-mx-table thead .mcr-mx-corner { z-index:4; width:240px; min-width:240px; padding:0 12px; color:var(--omp-text-dim); font-weight:500; height:76px; }
.mcr-mx-col { width:150px; min-width:150px; max-width:150px; height:76px; padding:4px 8px !important; }
.mcr-mx-col b { display:block; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.mcr-mx-col span { display:block; color:var(--omp-text-dim); font-size:var(--omp-font-size-xs); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.mcr-mx-grow th { background:var(--mcr-card-hi); z-index:2; }
.mcr-mx-group { display:flex; align-items:center; gap:8px; width:100%; height:32px; padding:0 12px; background:none; border:0; color:var(--omp-text); font:inherit; font-weight:600; text-align:left; }
.mcr-mx-group i { width:12px; font-style:normal; color:var(--omp-text-dim); }
.mcr-mx-group em { margin-left:auto; font-style:normal; font-weight:400; color:var(--omp-accent-cyan); font-size:var(--omp-font-size-xs); }
.mcr-mx-row { width:240px; min-width:240px; height:32px; padding:0 12px 0 28px !important; white-space:nowrap; font-weight:400; }
.mcr-mx-kind { display:inline-block; width:44px; color:var(--omp-text-dim); font-size:var(--omp-font-size-xs); text-transform:uppercase; letter-spacing:.04em; }
.mcr-mx-x { width:100%; height:32px; background:none; border:0; color:var(--omp-text); font-size:14px; line-height:1; }
.mcr-mx-x:hover { background:rgba(25,211,243,.10); }
.mcr-mx-x.on { background:rgba(25,211,243,.22); color:var(--omp-accent-cyan); }
.mcr-mx-x.aud.on { background:rgba(120,220,150,.2); color:var(--mcr-ok); }
.mcr-mx-x.dat.on { background:rgba(255,190,60,.2); color:var(--mcr-warn); }
.mcr-mx-x.other:not(.on):hover { background:rgba(255,190,60,.14); }
.mcr-wall { padding:16px; display:flex; flex-direction:column; gap:12px; height:100%; overflow:auto; box-sizing:border-box; }
.mcr-wall-head { color:var(--omp-text-dim); min-height:20px; }
.mcr-wall-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:12px; align-content:start; align-items:start; }
.mcr-wall-tile { --lv:var(--omp-text-disabled); background:var(--mcr-card); border:1px solid var(--mcr-line); border-left:5px solid var(--lv); border-radius:10px; padding:10px 12px; display:flex; flex-direction:column; gap:8px; min-width:0; }
.mcr-wall-tile.big { grid-column:span 2; border-color:var(--lv); box-shadow:0 0 0 1px color-mix(in srgb,var(--lv) 40%,transparent); }
.mcr-wall-tile header { display:flex; align-items:center; gap:8px; min-height:30px; }
.mcr-wall-tile header b { font-size:var(--omp-font-size-lg); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.mcr-wall-lamp { width:10px; height:10px; border-radius:50%; background:var(--lv); flex:none; }
.mcr-wall-sub { color:var(--omp-text-dim); font-size:var(--omp-font-size-sm); white-space:nowrap; }
.mcr-wall-spacer { flex:1; }
.mcr-wall-tile [aria-pressed="true"] { border-color:var(--omp-accent-cyan); color:var(--omp-accent-cyan); }
.mcr-wall-pic { position:relative; width:100%; background:#000; border-radius:6px; overflow:hidden; }
.mcr-wall-img { width:100%; height:100%; display:block; object-fit:contain; }
.mcr-wall-hot { position:absolute; background:transparent; border:2px solid transparent; border-radius:4px; cursor:pointer; padding:0; }
.mcr-wall-hot:hover { background:rgba(255,255,255,.08); border-color:var(--omp-accent-cyan); }
.mcr-wall-chips { display:flex; flex-wrap:wrap; gap:6px; min-height:26px; }
.mcr-wall-chip { display:inline-flex; align-items:center; gap:6px; max-width:100%; padding:3px 10px; border:1px solid var(--mcr-line); border-radius:999px; background:transparent; color:var(--omp-text); font:inherit; font-size:var(--omp-font-size-sm); }
.mcr-wall-chip:hover { border-color:var(--omp-accent-cyan); }
.mcr-wall-chip i { width:8px; height:8px; border-radius:50%; background:var(--omp-text-disabled); flex:none; }
.mcr-wall-chip[data-level="ok"] i { background:var(--omp-preset); }
.mcr-wall-chip[data-level="warn"] i { background:var(--omp-cue); }
.mcr-wall-chip[data-level="bad"] i { background:var(--omp-error); }
.mcr-wall-chip em { font-style:normal; color:var(--omp-error); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.mcr-chain { display:grid; gap:10px; }
.mcr-chain-body { display:grid; gap:10px; }
.mcr-chain-stage { border:1px solid var(--mcr-line); border-radius:8px; padding:8px 10px; display:grid; gap:8px; background:var(--mcr-card); }
.mcr-chain-stage[data-off="true"] { opacity:.55; }
.mcr-chain-head { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.mcr-chain-head select { flex:1 1 140px; min-width:0; }
.mcr-chain-params { display:grid; gap:6px; }
.mcr-chain-prow { display:grid; grid-template-columns:1fr 1.4fr auto; gap:6px; }
.mcr-alarm-table { width:100%; border-collapse:collapse; }
.mcr-alarm-table th, .mcr-alarm-table td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--mcr-line); white-space:nowrap; }
.mcr-alarm-table th { color:var(--omp-text-dim); font-weight:500; font-size:var(--omp-font-size-sm); }
.mcr-alarm-table tr[data-open="true"] td { color:var(--omp-error); }
.mcr-wall-pipbar { display:flex; align-items:center; gap:8px; color:var(--omp-text-dim); font-size:var(--omp-font-size-sm); }
.mcr-wall-pipbar b { color:var(--omp-text); }
.mcr-tl { border:1px solid var(--mcr-line); border-radius:8px; background:var(--mcr-card); padding:0 0 6px; overflow:hidden; }
.mcr-tl-axis { position:relative; height:24px; border-bottom:1px solid var(--mcr-line); color:var(--omp-text-dim); font-size:var(--omp-font-size-xs); }
.mcr-tl-tick { position:absolute; top:5px; transform:translateX(3px); white-space:nowrap; }
.mcr-tl-tick[data-major="true"] { color:var(--omp-text); font-weight:600; }
.mcr-tl-grid { position:relative; min-height:36px; }
.mcr-tl-gl { position:absolute; top:0; bottom:0; width:1px; background:color-mix(in srgb,var(--mcr-line) 60%,transparent); }
.mcr-tl-gl[data-major="true"] { background:var(--mcr-line); }
.mcr-tl-bar { position:absolute; height:30px; min-width:4px; padding:0 8px; border:1px solid color-mix(in srgb,var(--st) 70%,transparent); border-left:4px solid var(--st); border-radius:5px; background:color-mix(in srgb,var(--st) 20%,var(--mcr-card)); color:var(--omp-text); text-align:left; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:var(--omp-font-size-sm); }
.mcr-tl-bar:hover { background:color-mix(in srgb,var(--st) 32%,var(--mcr-card)); }
.mcr-tl-bar[data-over="true"] { box-shadow:0 0 0 1px var(--mcr-warn); }
.mcr-tl-bar[data-open="true"] { border-right-style:dashed; }
.mcr-tl-bar[data-cs="true"] { border-top-left-radius:0; border-bottom-left-radius:0; }
.mcr-tl-bar[data-ce="true"] { border-top-right-radius:0; border-bottom-right-radius:0; }
.mcr-tl-bar span { pointer-events:none; }
.mcr-tl-now { position:absolute; top:0; bottom:0; width:2px; background:var(--omp-onair); pointer-events:none; }
.mcr-tl-nodate { display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:10px 12px 4px; }
.mcr-members-row { display:grid; grid-template-columns:110px 1fr 200px auto; gap:6px; }
`;
