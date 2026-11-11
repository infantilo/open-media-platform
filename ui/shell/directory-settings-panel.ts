// Wartung → Einstellungen → Active Directory (Nutzerauftrag 2026-11-11): Verbindung zum Windows-Verzeichnis.
// Explizites Speichern, wirkt sofort ohne Neustart; das Dienstkonto-Kennwort wird nie angezeigt.

import { t } from "./i18n.ts";
import { apiFetch } from "./connection.ts";

interface DirSettings {
  enabled: boolean;
  urls: string[];
  startTls: boolean;
  allowPlain: boolean;
  caPem: string;
  baseDn: string;
  bindDn: string;
  userFilter: string;
  userAttr: string;
  groupBaseDn: string;
  groupFilter: string;
  requiredGroup: string;
  timeoutS: number;
  hasPassword: boolean;
  source?: string;
  caFile?: string;
}

class DirectorySettingsPanel extends HTMLElement {
  #st: DirSettings | null = null;
  #active = false;
  #error = "";
  #msg = "";
  #pw = "";
  #loaded = false;

  connectedCallback() {
    this.style.cssText = "display:block;margin-bottom:28px;";
    if (this.#loaded) return;
    this.#loaded = true;
    void this.#load();
  }

  #apply(j: { enabled?: boolean; error?: string; settings: DirSettings }) {
    this.#active = !!j.enabled;
    this.#error = String(j.error ?? "");
    this.#st = j.settings;
  }

  async #load() {
    try {
      const res = await apiFetch("/api/v1/auth/directory");
      if (res.ok) this.#apply(await res.json());
      else this.#error = await res.text();
    } catch (e) {
      this.#error = String(e);
    }
    this.#render();
  }

  async #save() {
    if (!this.#st) return;
    const res = await apiFetch("/api/v1/auth/directory", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...this.#st, bindPassword: this.#pw }),
    });
    if (!res.ok) {
      this.#msg = t("adm.dir.saveFailed", { p0: await res.text() });
      this.#render();
      return;
    }
    this.#pw = "";
    this.#apply(await res.json());
    this.#msg = t("adm.dir.saved");
    this.#render();
  }

  async #test() {
    this.#msg = t("adm.dir.testing");
    this.#render();
    try {
      const res = await apiFetch("/api/v1/auth/directory/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...this.#st, bindPassword: this.#pw }),
      });
      if (!res.ok) this.#msg = t("adm.dir.notConfigured");
      else {
        const r = await res.json();
        this.#msg = r.ok ? t("adm.dir.testOk") : t("adm.dir.testFailed", { p0: String(r.error ?? "") });
      }
    } catch (e) {
      this.#msg = t("adm.dir.testFailed", { p0: String(e) });
    }
    this.#render();
  }

  #render() {
    this.replaceChildren();
    const head = document.createElement("div");
    head.className = "omp-h1";
    head.textContent = t("adm.dir.title");
    const state = document.createElement("div");
    state.style.cssText = "color:var(--omp-text-dim);margin:4px 0 10px;";
    state.textContent = this.#active ? t("adm.dir.enabled") : t("adm.dir.disabled");
    this.append(head, state);
    if (this.#error) {
      const err = document.createElement("div");
      err.style.cssText = "color:var(--omp-danger,#d33);margin-bottom:10px;white-space:pre-wrap;";
      err.textContent = t("adm.dir.loadError", { p0: this.#error });
      this.append(err);
    }
    if (this.#st) this.append(this.#renderForm());
  }

  #renderForm(): HTMLElement {
    const st = this.#st!;
    const form = document.createElement("div");
    form.setAttribute("data-role", "directory-settings");
    form.style.cssText = "display:grid;grid-template-columns:minmax(150px,220px) 1fr;gap:6px 10px;align-items:start;margin-bottom:var(--omp-space-3);max-width:820px;";
    const row = (label: string, el: HTMLElement, help?: string) => {
      const l = document.createElement("label");
      l.textContent = label;
      l.style.cssText = "padding-top:3px;";
      const wrap = document.createElement("div");
      wrap.appendChild(el);
      if (help) {
        const h = document.createElement("div");
        h.textContent = help;
        h.style.cssText = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-top:2px;";
        wrap.appendChild(h);
      }
      form.append(l, wrap);
    };
    const text = (get: () => string, set: (v: string) => void, ph = "") => {
      const i = document.createElement("input");
      i.value = get();
      i.placeholder = ph;
      i.autocomplete = "off";
      i.style.cssText = "width:100%;box-sizing:border-box;";
      i.addEventListener("input", () => set(i.value));
      return i;
    };
    const check = (get: () => boolean, set: (v: boolean) => void, label: string) => {
      const l = document.createElement("label");
      const c = document.createElement("input");
      c.type = "checkbox";
      c.checked = get();
      c.addEventListener("change", () => {
        set(c.checked);
        this.#render();
      });
      l.append(c, " " + label);
      return l;
    };
    const area = (get: () => string, set: (v: string) => void, rows: number, ph = "") => {
      const a = document.createElement("textarea");
      a.value = get();
      a.rows = rows;
      a.placeholder = ph;
      a.style.cssText = "width:100%;box-sizing:border-box;font-family:var(--omp-font-mono, monospace);font-size:11px;";
      a.addEventListener("input", () => set(a.value));
      return a;
    };
    row(t("adm.dir.f.enabled"), check(() => st.enabled, (v) => (st.enabled = v), t("adm.dir.f.enabledLabel")),
      st.source === "env" ? t("adm.dir.f.fromEnv") : undefined);
    row(t("adm.dir.f.urls"), area(() => st.urls.join("\n"), (v) => (st.urls = v.split("\n").map((x) => x.trim()).filter(Boolean)), 2, "ldaps://dc1.firma.de:636"),
      t("adm.dir.f.urlsHelp"));
    row(t("adm.dir.f.startTls"), check(() => st.startTls, (v) => (st.startTls = v), t("adm.dir.f.startTlsLabel")));
    row(t("adm.dir.f.allowPlain"), check(() => st.allowPlain, (v) => (st.allowPlain = v), t("adm.dir.f.allowPlainLabel")),
      st.allowPlain ? t("adm.dir.f.allowPlainWarn") : undefined);
    row(t("adm.dir.f.ca"), area(() => st.caPem, (v) => (st.caPem = v), 3, "-----BEGIN CERTIFICATE-----"),
      t("adm.dir.f.caHelp") + (st.caFile ? " " + t("adm.dir.f.caFile", { p0: st.caFile }) : ""));
    row(t("adm.dir.f.baseDn"), text(() => st.baseDn, (v) => (st.baseDn = v), "DC=firma,DC=de"));
    row(t("adm.dir.f.bindDn"), text(() => st.bindDn, (v) => (st.bindDn = v), "CN=omp-lesen,OU=Dienstkonten,DC=firma,DC=de"), t("adm.dir.f.bindDnHelp"));
    const pw = document.createElement("input");
    pw.type = "password";
    pw.autocomplete = "new-password";
    pw.value = this.#pw;
    pw.placeholder = st.hasPassword ? t("adm.dir.f.pwKeep") : "";
    pw.style.cssText = "width:100%;box-sizing:border-box;";
    pw.addEventListener("input", () => {
      this.#pw = pw.value;
    });
    row(t("adm.dir.f.pw"), pw, t("adm.dir.f.pwHelp"));
    row(t("adm.dir.f.userFilter"), text(() => st.userFilter, (v) => (st.userFilter = v), "(&(objectCategory=person)(objectClass=user)(|(sAMAccountName={user})(userPrincipalName={user})))"),
      t("adm.dir.f.userFilterHelp"));
    row(t("adm.dir.f.userAttr"), text(() => st.userAttr, (v) => (st.userAttr = v), "sAMAccountName"));
    row(t("adm.dir.f.groupBaseDn"), text(() => st.groupBaseDn, (v) => (st.groupBaseDn = v), t("adm.dir.f.sameAsBase")));
    row(t("adm.dir.f.groupFilter"), text(() => st.groupFilter, (v) => (st.groupFilter = v), "(&(objectClass=group)(member:1.2.840.113556.1.4.1941:={dn}))"),
      t("adm.dir.f.groupFilterHelp"));
    row(t("adm.dir.f.required"), text(() => st.requiredGroup, (v) => (st.requiredGroup = v), "OMP-Nutzer"), t("adm.dir.f.requiredHelp"));
    const to = document.createElement("input");
    to.type = "number";
    to.min = "1";
    to.max = "120";
    to.value = String(st.timeoutS || 8);
    to.style.cssText = "width:80px;";
    to.addEventListener("input", () => (st.timeoutS = Number(to.value) || 8));
    row(t("adm.dir.f.timeout"), to);

    const btns = document.createElement("div");
    btns.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;";
    const save = document.createElement("button");
    save.textContent = t("adm.b97d23");
    save.style.cssText = "cursor:pointer;";
    save.addEventListener("click", () => void this.#save());
    const test = document.createElement("button");
    test.textContent = t("adm.dir.test");
    test.style.cssText = "cursor:pointer;";
    test.addEventListener("click", () => void this.#test());
    const res = document.createElement("span");
    res.style.cssText = "font-size:var(--omp-font-size-xs);";
    res.textContent = this.#msg;
    btns.append(save, test, res);
    form.append(document.createElement("span"), btns);
    return form;
  }
}

customElements.define("omp-directory-settings", DirectorySettingsPanel);
