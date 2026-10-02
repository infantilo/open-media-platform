// Admin → Einstellungen (Kapitel 29): Node-Optionen (Umgebungsvariablen) je Node-Typ und
// je Instanz sowie die Betriebswerte des Orchestrators — alles ohne Shell/Umgebungsvariablen.
// Explizites Speichern je Zeile (kein Schreiben bei jedem Tastendruck).

import { apiFetch } from "./connection.ts";
import {
  effectiveValue, groupOptions, hintFor, inputKind, isDirty, type OptionDef, type SystemItem,
} from "./settings-logic.ts";

interface InstanceRow {
  id: string;
  label: string;
  remote?: boolean;
  overrides: Record<string, string>;
  restartNeeded: boolean;
}
interface NodeTypeRow {
  type: string;
  label: string;
  options: OptionDef[];
  instances: InstanceRow[];
}
interface StartupEntry {
  key: string;
  label: string;
  value: string;
  secret?: boolean;
}

const BTN = "padding:3px 10px;font-size:var(--omp-font-size-sm);cursor:pointer;";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

class SettingsView extends HTMLElement {
  #types: NodeTypeRow[] = [];
  #system: { items: SystemItem[]; startup: StartupEntry[]; skipped: string[] } | null = null;
  #selectedType = "";
  #selectedInstance = ""; // "" = Typ-Standard bearbeiten
  #message = "";
  #error = "";
  #busy = false;
  // Nicht gespeicherte Eingaben bleiben beim Neuzeichnen erhalten: key → Text.
  #drafts = new Map<string, string>();
  // Instanz-ID → Host-ID (Remote-Instanzen), aus /api/v1/instances.
  #hostIds = new Map<string, string>();

  #loaded = false;

  connectedCallback() {
    this.style.cssText = "display:block;";
    // admin-view baut seinen Inhalt bei jedem Neuzeichnen neu auf und hängt dieselbe Instanz
    // wieder ein: nur beim ersten Mal laden, sonst nur zeichnen (Eingaben bleiben erhalten).
    if (this.#loaded) this.#render();
    else {
      this.#loaded = true;
      void this.#load();
    }
  }

  async #load() {
    try {
      const [n, s] = await Promise.all([apiFetch("/api/v1/admin/settings/nodes"), apiFetch("/api/v1/admin/settings/system")]);
      const inst = await apiFetch("/api/v1/instances");
      if (inst.ok) {
        this.#hostIds.clear();
        for (const i of (await inst.json()) as { id: string; hostId?: string }[]) if (i.hostId) this.#hostIds.set(i.id, i.hostId);
      }
      if (n.ok) this.#types = ((await n.json()) as { types: NodeTypeRow[] }).types ?? [];
      if (s.ok) this.#system = await s.json();
      if (!this.#types.some((t) => t.type === this.#selectedType)) {
        this.#selectedType = this.#types[0]?.type ?? "";
        this.#selectedInstance = "";
      }
    } catch {
      this.#error = "Einstellungen konnten nicht geladen werden.";
    }
    this.#render();
  }

  async #call(url: string, method: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    this.#busy = true;
    this.#error = "";
    this.#message = "";
    try {
      const res = await apiFetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        this.#error = (await res.text()).trim() || `Fehler ${res.status}`;
        return { ok: false, data: {} };
      }
      return { ok: true, data: (await res.json()) as Record<string, unknown> };
    } catch (err) {
      this.#error = `Anfrage fehlgeschlagen: ${err}`;
      return { ok: false, data: {} };
    } finally {
      this.#busy = false;
    }
  }

  async #saveNode(t: NodeTypeRow, o: OptionDef, value: string, instanceId: string, force = false) {
    const r = await this.#call(
      `/api/v1/admin/settings/nodes/${encodeURIComponent(t.type)}/${encodeURIComponent(o.key)}`,
      "PUT",
      { value, instanceId, force },
    );
    if (!r.ok && o.type === "path" && !instanceId && !force && /existiert nicht|nicht zugreifbar|Verzeichnis|Datei/.test(this.#error)) {
      // Pfad fehlt auf DIESEM Rechner (Orchestrator) — evtl. nur auf einem Remote-Host vorhanden.
      const msg = this.#error;
      if (confirm(`${msg}\n\nTrotzdem speichern (der Pfad existiert z. B. nur auf einem Remote-Host)?`)) {
        await this.#saveNode(t, o, value, instanceId, true);
        return;
      }
    }
    if (r.ok) {
      this.#drafts.delete(this.#draftKey(t, o, instanceId));
      const warn = (r.data.warning as string) || "";
      const restart = (r.data.restartNeeded as number) || 0;
      this.#message =
        `„${o.label}“ gespeichert.` + (warn ? ` Hinweis: ${warn}` : "") +
        (restart > 0 ? ` ${restart} laufende Instanz(en) brauchen einen Neustart (System-Update → „Veraltete Instanzen neu starten“, oder Instanz neu starten).` : "");
    }
    await this.#load();
  }

  async #saveSystem(item: SystemItem, value: string) {
    const r = await this.#call(`/api/v1/admin/settings/system/${encodeURIComponent(item.key)}`, "PUT", { value });
    if (r.ok) {
      this.#drafts.delete("sys|" + item.key);
      this.#message = `„${item.label}“ gespeichert — wirksam nach dem nächsten Neustart des Orchestrators.`;
    }
    await this.#load();
  }

  #draftKey(t: NodeTypeRow, o: OptionDef, instanceId: string) {
    return `${t.type}|${instanceId}|${o.key}`;
  }

  // ---- Rendering ---------------------------------------------------------

  #render() {
    const scroll = this.closest("[style*=overflow]")?.scrollTop ?? 0;
    this.replaceChildren();
    const head = el("div", "", "Einstellungen");
    head.className = "omp-h1";
    this.append(head);
    const intro = el(
      "div",
      "color:var(--omp-text-dim);margin:6px 0 12px;max-width:900px;",
      "Hier werden die bisher nur per Umgebungsvariable möglichen Einstellungen verwaltet. Änderungen an Node-Optionen gelten " +
        "für neu gestartete Instanzen (laufende zeigen „veraltet“ bis zum Neustart); Betriebswerte des Orchestrators gelten nach dessen Neustart. " +
        "Geheimnisse und Infrastruktur-Zugänge (JWT, TLS, Datenbank) sind bewusst nicht hier änderbar.",
    );
    this.append(intro);
    if (this.#error) this.append(el("div", "color:var(--omp-danger,#d33);margin-bottom:10px;white-space:pre-wrap;", this.#error));
    if (this.#message) this.append(el("div", "color:var(--omp-success,#4a4);margin-bottom:10px;white-space:pre-wrap;", this.#message));

    this.append(this.#renderNodes(), this.#renderSystem());
    const scroller = this.closest("[style*=overflow]");
    if (scroller) scroller.scrollTop = scroll;
  }

  #renderNodes(): HTMLElement {
    const sec = el("div", "margin-bottom:28px;");
    sec.append(el("div", "font-weight:600;font-size:15px;margin-bottom:8px;", "Node-Optionen"));
    if (this.#types.length === 0) {
      sec.append(el("div", "color:var(--omp-text-dim);", "Keine Node-Typen mit Optionen (deploy/node-options.json)."));
      return sec;
    }
    const bar = el("div", "display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px;");
    const typeSel = el("select", "padding:3px;");
    for (const t of this.#types) {
      const o = el("option", "", `${t.label} (${t.type})`);
      o.value = t.type;
      o.selected = t.type === this.#selectedType;
      typeSel.append(o);
    }
    typeSel.addEventListener("change", () => {
      this.#selectedType = typeSel.value;
      this.#selectedInstance = "";
      this.#render();
    });
    const t = this.#types.find((x) => x.type === this.#selectedType)!;
    const scopeSel = el("select", "padding:3px;");
    const all = el("option", "", "Alle Instanzen dieses Typs (Standard)");
    all.value = "";
    scopeSel.append(all);
    for (const i of t.instances) {
      const o = el("option", "", `Nur Instanz: ${i.label}${i.remote ? " (Remote-Host)" : ""}${i.restartNeeded ? " · Neustart nötig" : ""}`);
      o.value = i.id;
      o.selected = i.id === this.#selectedInstance;
      scopeSel.append(o);
    }
    scopeSel.addEventListener("change", () => {
      this.#selectedInstance = scopeSel.value;
      this.#render();
    });
    bar.append(el("span", "color:var(--omp-text-dim);", "Typ:"), typeSel, el("span", "color:var(--omp-text-dim);", "Gilt für:"), scopeSel);
    sec.append(bar);

    const pending = t.instances.filter((i) => i.restartNeeded);
    if (pending.length > 0) {
      sec.append(el("div", "margin-bottom:10px;padding:6px 10px;border:1px solid var(--omp-warn,#b8860b);border-radius:var(--omp-radius);",
        `Neustart nötig für: ${pending.map((p) => p.label).join(", ")} — die geänderten Werte gelten dort erst nach einem Neustart.`));
    }
    const inst = t.instances.find((i) => i.id === this.#selectedInstance);
    if (t.instances.some((i) => i.remote)) {
      sec.append(el("div", "color:var(--omp-text-dim);margin-bottom:8px;font-size:var(--omp-font-size-xs);",
        "Hinweis: Auf Remote-Hosts prüft der Host-Agent jeden Wert selbst gegen SEIN Schema (node-options.json neben seinem Katalog) und SEIN Dateisystem; " +
        "nicht dort deklarierte Variablen werden ignoriert. Pfade gelten dort — „Pfad prüfen“ fragt bei einer Remote-Instanz den Host."));
    }

    for (const [group, opts] of groupOptions(t.options)) {
      const box = el("div", "margin-bottom:14px;");
      box.append(el("div", "font-weight:600;margin-bottom:4px;color:var(--omp-text-dim);", group));
      for (const o of opts) box.append(this.#renderOption(t, o, inst));
      sec.append(box);
    }
    return sec;
  }

  #renderOption(t: NodeTypeRow, o: OptionDef, inst: InstanceRow | undefined): HTMLElement {
    const instanceId = inst?.id ?? "";
    const saved = inst ? inst.overrides[o.key] ?? "" : o.value ?? "";
    const dk = this.#draftKey(t, o, instanceId);
    const current = this.#drafts.get(dk) ?? saved;

    const row = el("div", "display:grid;grid-template-columns:200px minmax(220px,360px) auto;gap:8px 12px;align-items:start;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05);");
    const label = el("div", "padding-top:3px;");
    label.append(el("div", "", o.label), el("div", "font-size:10px;color:var(--omp-text-dim);font-family:monospace;", o.key));
    if (o.description) label.title = o.description;

    const field = el("div", "");
    let input: HTMLInputElement | HTMLSelectElement;
    if (inputKind(o) === "select") {
      const sel = el("select", "width:100%;padding:3px;");
      const none = el("option", "", `— Standard${o.default ? ` (${o.default})` : ""} —`);
      none.value = "";
      sel.append(none);
      for (const c of o.choices ?? []) {
        const op = el("option", "", c.label ?? c.value);
        op.value = c.value;
        sel.append(op);
      }
      sel.value = current;
      input = sel;
    } else {
      const inp = el("input", "width:100%;box-sizing:border-box;padding:3px 6px;");
      inp.type = inputKind(o) === "number" ? "number" : "text";
      if (inputKind(o) === "number") {
        if (o.min !== undefined) inp.min = String(o.min);
        if (o.max !== undefined) inp.max = String(o.max);
        if (o.type === "float") inp.step = "any";
      }
      inp.value = current;
  inp.placeholder = inst ? effectiveValue(o, undefined).value || "Standard" : o.default || o.placeholder || "Standard";
      input = inp;
    }
    field.append(input);
    const hint = el("div", "font-size:10px;color:var(--omp-text-dim);margin-top:2px;", hintFor(o));
    field.append(hint);
    if (inst && !saved) {
      const e = effectiveValue(o, undefined);
      field.append(el("div", "font-size:10px;color:var(--omp-text-dim);", `wirksam: ${e.value || "Standard des Nodes"} (${e.source === "type" ? "Typ-Wert" : e.source === "default" ? "Standard" : "Node"})`));
    }
    const check = el("div", "font-size:11px;margin-top:2px;");
    check.dataset.check = current;
    field.append(check);

    const actions = el("div", "display:flex;gap:6px;flex-wrap:wrap;");
    const save = el("button", BTN, "Speichern");
    save.className = "omp-btn-primary";
    const dirty = isDirty(current, saved);
    save.disabled = !dirty || this.#busy;
    const reset = el("button", BTN, "Zurücksetzen");
    reset.disabled = !saved || this.#busy;
    input.addEventListener("input", () => {
      this.#drafts.set(dk, input.value);
      save.disabled = !isDirty(input.value, saved) || this.#busy;
    });
    save.addEventListener("click", () => void this.#saveNode(t, o, input.value.trim(), instanceId));
    reset.addEventListener("click", () => void this.#saveNode(t, o, "", instanceId));
    actions.append(save, reset);
    if (o.type === "path") {
      const test = el("button", BTN, "Pfad prüfen");
      test.addEventListener("click", () => {
        const p = input.value.trim() || o.default || "";
        if (!p) { check.textContent = "Kein Pfad angegeben."; return; }
        void this.#checkPathInline(p, o.pathKind ?? "dir", check, inst?.remote ? this.#hostOf(inst.id) : "");
      });
      actions.append(test);
    }
    row.append(label, field, actions);
    return row;
  }

  #hostOf(instanceId: string): string {
    return this.#hostIds.get(instanceId) ?? "";
  }

  async #checkPathInline(path: string, kind: string, out: HTMLElement, hostId = "") {
    out.textContent = "Prüfe …";
    try {
      const res = await apiFetch("/api/v1/admin/settings/check-path", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, kind, hostId }),
      });
      if (!res.ok) {
        out.textContent = `✗ ${(await res.text()).trim()}`;
        out.style.color = "var(--omp-danger, #d33)";
        return;
      }
      const d = (await res.json()) as { readable?: boolean; message?: string };
      out.textContent = `${d.readable ? "✓" : "✗"} ${d.message ?? ""}`;
      out.style.color = d.readable ? "var(--omp-success, #4a4)" : "var(--omp-danger, #d33)";
    } catch {
      out.textContent = "Prüfung fehlgeschlagen.";
    }
  }

  #renderSystem(): HTMLElement {
    const sec = el("div", "margin-bottom:28px;");
    sec.append(el("div", "font-weight:600;font-size:15px;margin-bottom:8px;", "Orchestrator (Betriebswerte)"));
    const sys = this.#system;
    if (!sys) {
      sec.append(el("div", "color:var(--omp-text-dim);", "Wird geladen …"));
      return sec;
    }
    if (sys.skipped?.length) {
      sec.append(el("div", "margin-bottom:10px;color:var(--omp-warn,#b8860b);white-space:pre-wrap;",
        `Beim letzten Start wurden Überschreibungen verworfen:\n${sys.skipped.join("\n")}`));
    }
    for (const [group, items] of groupOptions(sys.items)) {
      const box = el("div", "margin-bottom:14px;");
      box.append(el("div", "font-weight:600;margin-bottom:4px;color:var(--omp-text-dim);", group));
      for (const it of items) box.append(this.#renderSystemItem(it));
      sec.append(box);
    }

    const det = el("details", "margin-top:10px;");
    det.append(el("summary", "cursor:pointer;color:var(--omp-text-dim);", "Start-Konfiguration (nur lesend, Geheimnisse maskiert)"));
    const table = el("table", "border-collapse:collapse;margin-top:6px;font-size:12px;");
    for (const e of sys.startup) {
      const tr = el("tr");
      tr.append(el("td", "padding:2px 14px 2px 0;", e.label), el("td", "padding:2px 14px 2px 0;font-family:monospace;color:var(--omp-text-dim);", e.key), el("td", "padding:2px 0;", e.value));
      table.append(tr);
    }
    det.append(table);
    sec.append(det);
    return sec;
  }

  #renderSystemItem(it: SystemItem): HTMLElement {
    const dk = "sys|" + it.key;
    const saved = it.override ?? "";
    const current = this.#drafts.get(dk) ?? saved;
    const row = el("div", "display:grid;grid-template-columns:200px minmax(220px,360px) auto;gap:8px 12px;align-items:start;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05);");
    const label = el("div", "padding-top:3px;");
    label.append(el("div", "", it.label), el("div", "font-size:10px;color:var(--omp-text-dim);font-family:monospace;", it.key));
    label.title = it.description;
    const field = el("div", "");
    const inp = el("input", "width:100%;box-sizing:border-box;padding:3px 6px;");
    inp.type = "number";
    inp.min = String(it.min);
    inp.max = String(it.max);
    if (!it.integer) inp.step = "any";
    inp.value = current;
    inp.placeholder = it.active;
    field.append(inp, el("div", "font-size:10px;color:var(--omp-text-dim);margin-top:2px;",
      `${it.description} Aktiv: ${it.active}${it.unit ? " " + it.unit : ""} · erlaubt ${it.min}–${it.max}`));
    if (it.pendingRestart) field.append(el("div", "font-size:11px;color:var(--omp-warn,#b8860b);", `gespeichert: ${it.override} — gilt erst nach Neustart des Orchestrators`));
    const actions = el("div", "display:flex;gap:6px;");
    const save = el("button", BTN, "Speichern");
    save.className = "omp-btn-primary";
    save.disabled = !isDirty(current, saved) || this.#busy;
    const reset = el("button", BTN, "Zurücksetzen");
    reset.disabled = !saved || this.#busy;
    inp.addEventListener("input", () => {
      this.#drafts.set(dk, inp.value);
      save.disabled = !isDirty(inp.value, saved) || this.#busy;
    });
    save.addEventListener("click", () => void this.#saveSystem(it, inp.value.trim()));
    reset.addEventListener("click", () => void this.#saveSystem(it, ""));
    actions.append(save, reset);
    row.append(label, field, actions);
    return row;
  }
}

customElements.define("omp-settings-view", SettingsView);
