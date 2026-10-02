// Admin → Storage → „Lokale Speicherorte“ (Kapitel 29 Nachtrag B): benannte Verzeichnisse/Shares,
// die ein Host lokal eingehängt hat (NFS/SMB/Platte). Zeigt Erreichbarkeit, Platz und Verwendung;
// die Orte erscheinen in den Node-Einstellungen als Auswahl für Pfad-Optionen.

import { apiFetch } from "./connection.ts";
import { describeCheck, type LocationItem } from "./locations-logic.ts";
import { confirmDialog } from "../kit/omp-confirm.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

class LocationsView extends HTMLElement {
  #items: LocationItem[] = [];
  #hosts: { id: string; label: string }[] = [];
  #error = "";
  #message = "";
  #loaded = false;
  #form = { name: "", hostId: "", path: "", note: "" };

  connectedCallback() {
    this.style.cssText = "display:block;margin-top:24px;";
    if (this.#loaded) this.#render();
    else {
      this.#loaded = true;
      void this.#load();
    }
  }

  async #load() {
    try {
      const [l, h] = await Promise.all([apiFetch("/api/v1/admin/storage-locations"), apiFetch("/api/v1/hosts")]);
      if (l.ok) this.#items = ((await l.json()) as { locations: LocationItem[] }).locations ?? [];
      if (h.ok) this.#hosts = ((await h.json()) as { id: string; label: string }[]) ?? [];
    } catch {
      this.#error = "Speicherorte konnten nicht geladen werden.";
    }
    this.#render();
  }

  #hostName(id: string): string {
    return id ? this.#hosts.find((h) => h.id === id)?.label ?? id : "Orchestrator-Rechner";
  }

  async #create(force: boolean): Promise<void> {
    this.#error = "";
    this.#message = "";
    const res = await apiFetch("/api/v1/admin/storage-locations", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...this.#form, force }),
    });
    if (!res.ok) {
      const msg = (await res.text()).trim();
      if (!force && (res.status === 400 || res.status === 502) && /force/.test(msg)) {
        if (await confirmDialog(`${msg}\n\nTrotzdem anlegen?`, { confirmLabel: "Trotzdem anlegen" })) return this.#create(true);
      }
      this.#error = msg;
    } else {
      const d = (await res.json()) as { warning?: string };
      this.#message = `Speicherort angelegt.${d.warning ? ` Hinweis: ${d.warning}` : ""}`;
      this.#form = { name: "", hostId: this.#form.hostId, path: "", note: "" };
    }
    await this.#load();
  }

  async #setStatus(l: LocationItem) {
    const status = l.status === "active" ? "deprecated" : "active";
    const res = await apiFetch(`/api/v1/admin/storage-locations/${encodeURIComponent(l.id)}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: l.name, note: l.note ?? "", status }),
    });
    this.#error = res.ok ? "" : (await res.text()).trim();
    await this.#load();
  }

  async #delete(l: LocationItem) {
    if (!(await confirmDialog(`Speicherort „${l.name}“ entfernen? Die Dateien bleiben unberührt, nur der Eintrag verschwindet.`, { confirmLabel: "Entfernen" }))) return;
    const res = await apiFetch(`/api/v1/admin/storage-locations/${encodeURIComponent(l.id)}`, { method: "DELETE" });
    this.#error = res.ok ? "" : (await res.text()).trim();
    this.#message = res.ok ? `„${l.name}“ entfernt.` : "";
    await this.#load();
  }

  #render() {
    this.replaceChildren();
    const head = el("div", "font-weight:600;font-size:15px;margin-bottom:6px;", "Lokale Speicherorte");
    this.append(head, el("div", "color:var(--omp-text-dim);max-width:900px;margin-bottom:10px;",
      "Verzeichnisse oder Netzwerk-Shares, die ein Host lokal eingehängt hat (NFS/SMB/Platte — das Einhängen selbst geschieht am Betriebssystem, z. B. per /etc/fstab). " +
      "Hier bekommen sie einen Namen, werden auf Erreichbarkeit und Platz geprüft und erscheinen in Admin → Einstellungen als Auswahl für Pfad-Optionen (z. B. das Medienverzeichnis eines Players)."));
    if (this.#error) this.append(el("div", "color:var(--omp-danger,#d33);margin-bottom:8px;white-space:pre-wrap;", this.#error));
    if (this.#message) this.append(el("div", "color:var(--omp-success,#4a4);margin-bottom:8px;", this.#message));

    if (this.#items.length === 0) this.append(el("div", "color:var(--omp-text-dim);margin-bottom:10px;", "Noch keine Speicherorte angelegt."));
    else {
      const table = el("table", "border-collapse:collapse;font-size:12px;margin-bottom:12px;width:100%;max-width:1100px;");
      const hr = el("tr", "color:var(--omp-text-dim);text-align:left;");
      for (const t of ["Name", "Host", "Pfad", "Zustand", "Verwendung", ""]) hr.append(el("th", "padding:3px 10px 3px 0;", t));
      table.append(hr);
      for (const l of this.#items) {
        const c = describeCheck(l);
        const tr = el("tr", "border-top:1px solid rgba(255,255,255,0.06);");
        const name = el("td", "padding:4px 10px 4px 0;", l.name + (l.status === "deprecated" ? " (ausgelaufen)" : ""));
        if (l.note) name.title = l.note;
        const state = el("td", `padding:4px 10px 4px 0;color:${c.ok ? "var(--omp-success,#4a4)" : "var(--omp-danger,#d33)"};`, `${c.ok ? "✓" : "✗"} ${c.text}`);
        const use = el("td", "padding:4px 10px 4px 0;color:var(--omp-text-dim);", l.usage.length ? `${l.usage.length} Einstellung(en)` : "ungenutzt");
        if (l.usage.length) use.title = l.usage.map((u) => `${u.nodeType} → ${u.option}${u.instanceLabel ? ` (${u.instanceLabel})` : ""}: ${u.value}`).join("\n");
        const act = el("td", "padding:4px 0;white-space:nowrap;");
        const st = el("button", "padding:2px 8px;margin-right:6px;", l.status === "active" ? "Auslaufen lassen" : "Reaktivieren");
        st.addEventListener("click", () => void this.#setStatus(l));
        const del = el("button", "padding:2px 8px;", "Entfernen");
        del.className = "omp-btn-danger";
        del.addEventListener("click", () => void this.#delete(l));
        act.append(st, del);
        tr.append(name, el("td", "padding:4px 10px 4px 0;color:var(--omp-text-dim);", this.#hostName(l.hostId)), el("td", "padding:4px 10px 4px 0;font-family:monospace;", l.path), state, use, act);
        table.append(tr);
      }
      this.append(table);
    }

    const form = el("div", "display:flex;gap:8px;flex-wrap:wrap;align-items:end;");
    const field = (label: string, input: HTMLElement) => {
      const w = el("div", "display:flex;flex-direction:column;gap:2px;");
      w.append(el("span", "font-size:10px;color:var(--omp-text-dim);", label), input);
      return w;
    };
    const name = el("input", "padding:3px 6px;width:160px;");
    name.placeholder = "z. B. Archiv-Share";
    name.value = this.#form.name;
    name.addEventListener("input", () => (this.#form.name = name.value));
    const host = el("select", "padding:3px;");
    const local = el("option", "", "Orchestrator-Rechner");
    local.value = "";
    host.append(local);
    for (const h of this.#hosts) {
      const o = el("option", "", h.label);
      o.value = h.id;
      host.append(o);
    }
    host.value = this.#form.hostId;
    host.addEventListener("change", () => (this.#form.hostId = host.value));
    const path = el("input", "padding:3px 6px;width:260px;font-family:monospace;");
    path.placeholder = "/mnt/medien";
    path.value = this.#form.path;
    path.addEventListener("input", () => (this.#form.path = path.value));
    const note = el("input", "padding:3px 6px;width:200px;");
    note.placeholder = "Notiz (optional)";
    note.value = this.#form.note;
    note.addEventListener("input", () => (this.#form.note = note.value));
    const add = el("button", "padding:4px 12px;", "Prüfen und anlegen");
    add.className = "omp-btn-primary";
    add.addEventListener("click", () => void this.#create(false));
    form.append(field("Name", name), field("Host", host), field("Pfad", path), field("Notiz", note), add);
    this.append(form);
  }
}

customElements.define("omp-locations-view", LocationsView);
