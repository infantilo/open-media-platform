// <omp-admin-view> — Administration-Tab (Kapitel 11 Teil 1,
// docs/END-GOAL-FEATURES.md §11.4): Nutzerverwaltung + Bootstrap-erster-
// Nutzer, Rollenbindungs-CRUD, Audit-Log — alles bereits vorhandene
// Backend-Endpunkte (D3 Teil 2), nur bisher ohne UI erreichbar. Nur
// gemountet, wenn app-shell.ts per whoami().isAdmin grünes Licht gibt
// (admin-Verb ODER Bootstrap-Modus, s. auth_handlers.go:handleWhoami) —
// dieser View selbst verlässt sich zusätzlich auf die serverseitige
// admin-only-Gate der Endpunkte, kein rein clientseitiges Vertrauen.
//
// Bewusst kein Poll-/SSE-Refresh für Nutzer/Bindungen (anders als
// hosts-view.ts/workflows-view.ts): ein offenes Formular würde bei
// jedem Rerender Fokus/Cursor verlieren. Stattdessen einmaliges Laden +
// gezieltes Neuladen nach jeder Mutation. Nur das rein lesende
// Audit-Log aktualisiert sich automatisch, das stört kein offenes
// Formular.
//
// SSE-first (S2, docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md): das
// Audit-Log reagiert auf "audit.appended" (neu, audit.go) statt alle
// paar Sekunden zu pollen. Poll bleibt nur als deutlich langsamerer
// Reconnect-/Fallback-Pfad (AUDIT_POLL_FALLBACK_INTERVAL_MS).
import { apiFetch, connectionMonitor } from "./connection.ts";
import { getToken, login } from "./auth.ts";

interface UserEntry {
  id: string;
  username: string;
  createdAt: string;
  isAdmin: boolean;
}

interface RoleBinding {
  id: string;
  subject: string;
  nodeId: string;
  verb: string;
}

interface AuditEntry {
  id: number;
  occurredAt: string;
  username: string;
  method: string;
  path: string;
  nodeId?: string;
  status: number;
}

interface NodeEntry {
  id: string;
  label: string;
  instanceId?: string;
}

const AUDIT_POLL_FALLBACK_INTERVAL_MS = 30000;
const AUDIT_REFRESH_EVENT_TYPES = new Set(["audit.appended", "lost-events"]);

const VERBS = ["view", "operate", "configure", "admin"] as const;

const VERB_LABEL: Record<string, string> = {
  view: "Ansehen",
  operate: "Bedienen",
  configure: "Konfigurieren",
  admin: "Administrieren",
};

class AdminView extends HTMLElement {
  #users: UserEntry[] = [];
  #bindings: RoleBinding[] = [];
  #audit: AuditEntry[] = [];
  #nodes: NodeEntry[] = [];
  #error = "";
  #showUserForm = false;
  #newUsername = "";
  #newPassword = "";
  #resetTarget: string | null = null;
  #resetPassword = "";
  #showBindingForm = false;
  #newSubject = "";
  #newNodeId = "*";
  #newVerb = "operate";
  #auditPollHandle: number | undefined;

  connectedCallback() {
    this.style.cssText =
      "display:block;background:var(--omp-surface);font-family:var(--omp-font);" +
      "font-size:var(--omp-font-size-sm);color:var(--omp-text);padding:var(--omp-space-3);" +
      "box-sizing:border-box;width:100%;height:100%;overflow-y:auto;";
    this.#render();
    this.#loadUsers();
    this.#loadBindings();
    this.#loadAudit();
    this.#loadNodes();
    this.#auditPollHandle = window.setInterval(() => this.#loadAudit(), AUDIT_POLL_FALLBACK_INTERVAL_MS);
    connectionMonitor.addEventListener("sse-message", this.#onSseMessage);
  }

  disconnectedCallback() {
    if (this.#auditPollHandle !== undefined) window.clearInterval(this.#auditPollHandle);
    connectionMonitor.removeEventListener("sse-message", this.#onSseMessage);
  }

  #onSseMessage = (ev: Event) => {
    let parsed: { type: string };
    try {
      parsed = JSON.parse((ev as CustomEvent<string>).detail);
    } catch {
      return;
    }
    if (AUDIT_REFRESH_EVENT_TYPES.has(parsed.type)) this.#loadAudit();
  };

  async #loadUsers() {
    try {
      const res = await apiFetch("/api/v1/auth/users");
      if (res.ok) {
        this.#users = await res.json();
        this.#render();
      }
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächstes gezieltes Neuladen holt es auf.
    }
  }

  async #loadBindings() {
    try {
      const res = await apiFetch("/api/v1/admin/role-bindings");
      if (res.ok) {
        this.#bindings = await res.json();
        this.#render();
      }
    } catch {
      // s.o.
    }
  }

  async #loadAudit() {
    try {
      const res = await apiFetch("/api/v1/admin/audit-log");
      if (res.ok) {
        this.#audit = await res.json();
        this.#render();
      }
    } catch {
      // s.o.
    }
  }

  async #loadNodes() {
    try {
      const res = await apiFetch("/api/v1/nodes");
      if (res.ok) {
        this.#nodes = await res.json();
        // Nur neu rendern, wenn die Node-Datalist tatsächlich gerade
        // sichtbar ist — sonst kein Grund, ein evtl. offenes
        // Nutzer-Formular anzufassen.
        if (this.#showBindingForm) this.#render();
      }
    } catch {
      // Node-Liste ist nur eine Eingabehilfe für das Bindungs-Formular,
      // kein Hard-Requirement.
    }
  }

  async #createUser() {
    if (!this.#newUsername || !this.#newPassword) return;
    const username = this.#newUsername;
    const password = this.#newPassword;
    const res = await apiFetch("/api/v1/auth/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      this.#error = `Nutzer anlegen fehlgeschlagen: ${await res.text()}`;
      this.#render();
      return;
    }
    this.#error = "";
    this.#newUsername = "";
    this.#newPassword = "";
    this.#showUserForm = false;

    // Bootstrap-Fall (Kapitel 11 Teil 1, §11.4): kein Token im Speicher
    // heißt, wir liefen bis eben im Bootstrap-Bypass (UserCount()==0,
    // s. auth_handlers.go:handleWhoami) — sonst hätte dieser admin-only
    // Aufruf selbst schon ein Token gebraucht. Der gerade angelegte
    // Nutzer bekam als allererster automatisch die Wildcard-admin-
    // Bindung (handleCreateUser), also gleich als er/sie einloggen und
    // neu laden — sonst bliebe die aktuelle Sitzung ohne Token stecken,
    // während UserCount ab jetzt eine echte Anmeldung verlangt, und jeder
    // weitere Admin-Aufruf in diesem Tab würde ins Leere laufen (401).
    if (!getToken()) {
      try {
        await login(username, password);
        location.reload();
        return;
      } catch {
        this.#error = "Nutzer angelegt, automatische Anmeldung fehlgeschlagen — bitte manuell anmelden.";
        this.#render();
        return;
      }
    }

    await this.#loadUsers();
  }

  async #deleteUser(username: string) {
    if (!confirm(`Nutzer "${username}" wirklich löschen?`)) return;
    const res = await apiFetch(`/api/v1/auth/users/${encodeURIComponent(username)}`, { method: "DELETE" });
    if (!res.ok) {
      this.#error = `Löschen fehlgeschlagen: ${await res.text()}`;
      this.#render();
      return;
    }
    this.#error = "";
    await this.#loadUsers();
  }

  async #submitPasswordReset(username: string) {
    if (!this.#resetPassword) return;
    const res = await apiFetch(`/api/v1/auth/users/${encodeURIComponent(username)}/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: this.#resetPassword }),
    });
    if (!res.ok) {
      this.#error = `Passwort-Reset fehlgeschlagen: ${await res.text()}`;
      this.#render();
      return;
    }
    this.#error = "";
    this.#resetTarget = null;
    this.#resetPassword = "";
    this.#render();
  }

  async #createBinding() {
    if (!this.#newSubject || !this.#newNodeId) return;
    const res = await apiFetch("/api/v1/admin/role-bindings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: this.#newSubject, nodeId: this.#newNodeId, verb: this.#newVerb }),
    });
    if (!res.ok) {
      this.#error = `Rollenbindung anlegen fehlgeschlagen: ${await res.text()}`;
      this.#render();
      return;
    }
    this.#error = "";
    this.#newSubject = "";
    this.#newNodeId = "*";
    this.#showBindingForm = false;
    await this.#loadBindings();
  }

  async #deleteBinding(id: string) {
    const res = await apiFetch(`/api/v1/admin/role-bindings/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      this.#error = `Löschen fehlgeschlagen: ${await res.text()}`;
      this.#render();
      return;
    }
    this.#error = "";
    await this.#loadBindings();
  }

  #render() {
    this.replaceChildren();

    const heading = document.createElement("div");
    heading.style.cssText = "font-weight:700;font-size:var(--omp-font-size-md);margin-bottom:var(--omp-space-3);";
    heading.textContent = "Administration";
    this.appendChild(heading);

    if (this.#error) {
      const err = document.createElement("div");
      err.style.cssText =
        "color:var(--omp-error);background:rgba(239,83,80,0.1);border:1px solid var(--omp-error);" +
        "border-radius:var(--omp-radius);padding:var(--omp-space-2);margin-bottom:var(--omp-space-3);white-space:pre-wrap;";
      err.textContent = this.#error;
      this.appendChild(err);
    }

    this.appendChild(this.#renderUsersSection());
    this.appendChild(this.#renderBindingsSection());
    this.appendChild(this.#renderAuditSection());
  }

  #renderUsersSection(): HTMLElement {
    const section = document.createElement("div");
    section.style.cssText = "margin-bottom:var(--omp-space-4);";

    const heading = document.createElement("div");
    heading.style.cssText =
      "font-weight:600;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;";
    const title = document.createElement("span");
    title.textContent = `Nutzer (${this.#users.length})`;
    const newBtn = document.createElement("button");
    newBtn.textContent = this.#showUserForm ? "Abbrechen" : "+ Neuer Nutzer";
    newBtn.style.cssText = "font-size:11px;cursor:pointer;";
    newBtn.addEventListener("click", () => {
      this.#showUserForm = !this.#showUserForm;
      this.#render();
    });
    heading.append(title, newBtn);
    section.appendChild(heading);

    if (this.#showUserForm) {
      section.appendChild(this.#renderUserForm());
    }

    if (this.#users.length === 0 && !this.#showUserForm) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--omp-text-dim);";
      empty.textContent = 'Noch kein Nutzer angelegt — mit "+ Neuer Nutzer" den ersten (Admin-)Nutzer anlegen.';
      section.appendChild(empty);
      return section;
    }

    if (this.#users.length > 0) {
      const table = document.createElement("table");
      table.style.cssText = "border-collapse:collapse;width:100%;";
      const thead = document.createElement("thead");
      thead.innerHTML = `<tr style="color:var(--omp-text-dim);text-align:left;">
        <th style="padding:2px 8px;">Nutzername</th>
        <th style="padding:2px 8px;">Angelegt</th>
        <th style="padding:2px 8px;">Rolle</th>
        <th style="padding:2px 8px;"></th>
      </tr>`;
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (const u of this.#users) {
        tbody.appendChild(this.#renderUserRow(u));
      }
      table.appendChild(tbody);
      section.appendChild(table);
    }

    return section;
  }

  #renderUserForm(): HTMLElement {
    const form = document.createElement("div");
    form.style.cssText =
      "border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:8px;" +
      "margin-bottom:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;";

    const userInput = document.createElement("input");
    userInput.placeholder = "Nutzername";
    userInput.autocomplete = "off";
    userInput.value = this.#newUsername;
    userInput.style.cssText = "flex:1;min-width:100px;";
    userInput.addEventListener("input", () => {
      this.#newUsername = userInput.value;
    });

    const passInput = document.createElement("input");
    passInput.type = "password";
    passInput.placeholder = "Passwort";
    passInput.autocomplete = "new-password";
    passInput.value = this.#newPassword;
    passInput.style.cssText = "flex:1;min-width:100px;";
    passInput.addEventListener("input", () => {
      this.#newPassword = passInput.value;
    });
    passInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") this.#createUser();
    });

    const createBtn = document.createElement("button");
    createBtn.textContent = "Anlegen";
    createBtn.style.cssText = "cursor:pointer;";
    createBtn.addEventListener("click", () => this.#createUser());

    form.append(userInput, passInput, createBtn);
    return form;
  }

  #renderUserRow(u: UserEntry): HTMLElement {
    const isResetting = this.#resetTarget === u.username;
    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    nameTd.style.cssText = "padding:2px 8px;";
    nameTd.textContent = u.username;
    tr.appendChild(nameTd);

    const createdTd = document.createElement("td");
    createdTd.style.cssText = "padding:2px 8px;color:var(--omp-text-dim);";
    createdTd.textContent = new Date(u.createdAt).toLocaleString();
    tr.appendChild(createdTd);

    const roleTd = document.createElement("td");
    roleTd.style.cssText = "padding:2px 8px;";
    if (u.isAdmin) {
      const badge = document.createElement("span");
      badge.textContent = "Admin";
      badge.style.cssText = "color:var(--omp-preset);font-size:var(--omp-font-size-xs);font-weight:600;";
      roleTd.appendChild(badge);
    } else {
      roleTd.textContent = "–";
    }
    tr.appendChild(roleTd);

    const actionsTd = document.createElement("td");
    actionsTd.style.cssText = "padding:2px 8px;text-align:right;white-space:nowrap;";

    if (isResetting) {
      const pwInput = document.createElement("input");
      pwInput.type = "password";
      pwInput.placeholder = "neues Passwort";
      pwInput.autocomplete = "new-password";
      pwInput.style.cssText = "font-size:11px;width:120px;";
      pwInput.value = this.#resetPassword;
      pwInput.addEventListener("input", () => {
        this.#resetPassword = pwInput.value;
      });
      pwInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") this.#submitPasswordReset(u.username);
      });

      const confirmBtn = document.createElement("button");
      confirmBtn.textContent = "OK";
      confirmBtn.style.cssText = "font-size:11px;cursor:pointer;";
      confirmBtn.addEventListener("click", () => this.#submitPasswordReset(u.username));

      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "×";
      cancelBtn.style.cssText = "cursor:pointer;";
      cancelBtn.addEventListener("click", () => {
        this.#resetTarget = null;
        this.#resetPassword = "";
        this.#render();
      });

      actionsTd.append(pwInput, confirmBtn, cancelBtn);
      tr.appendChild(actionsTd);
      queueMicrotask(() => pwInput.focus());
      return tr;
    }

    const resetBtn = document.createElement("button");
    resetBtn.textContent = "Passwort";
    resetBtn.style.cssText = "font-size:11px;cursor:pointer;margin-right:4px;";
    resetBtn.addEventListener("click", () => {
      this.#resetTarget = u.username;
      this.#resetPassword = "";
      this.#render();
    });

    const delBtn = document.createElement("button");
    delBtn.textContent = "Löschen";
    delBtn.style.cssText = "font-size:11px;cursor:pointer;";
    delBtn.addEventListener("click", () => this.#deleteUser(u.username));

    actionsTd.append(resetBtn, delBtn);
    tr.appendChild(actionsTd);
    return tr;
  }

  #renderBindingsSection(): HTMLElement {
    const section = document.createElement("div");
    section.style.cssText = "margin-bottom:var(--omp-space-4);";

    const heading = document.createElement("div");
    heading.style.cssText =
      "font-weight:600;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;";
    const title = document.createElement("span");
    title.textContent = `Rollenbindungen (${this.#bindings.length})`;
    const newBtn = document.createElement("button");
    newBtn.textContent = this.#showBindingForm ? "Abbrechen" : "+ Neue Bindung";
    newBtn.style.cssText = "font-size:11px;cursor:pointer;";
    newBtn.addEventListener("click", () => {
      this.#showBindingForm = !this.#showBindingForm;
      this.#render();
    });
    heading.append(title, newBtn);
    section.appendChild(heading);

    if (this.#showBindingForm) {
      section.appendChild(this.#renderBindingForm());
    }

    if (this.#bindings.length === 0 && !this.#showBindingForm) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--omp-text-dim);";
      empty.textContent = "Noch keine Rollenbindung angelegt.";
      section.appendChild(empty);
      return section;
    }

    if (this.#bindings.length > 0) {
      const table = document.createElement("table");
      table.style.cssText = "border-collapse:collapse;width:100%;";
      const thead = document.createElement("thead");
      thead.innerHTML = `<tr style="color:var(--omp-text-dim);text-align:left;">
        <th style="padding:2px 8px;">Nutzer</th>
        <th style="padding:2px 8px;">Node</th>
        <th style="padding:2px 8px;">Recht</th>
        <th style="padding:2px 8px;"></th>
      </tr>`;
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (const b of this.#bindings) {
        tbody.appendChild(this.#renderBindingRow(b));
      }
      table.appendChild(tbody);
      section.appendChild(table);
    }

    return section;
  }

  #renderBindingForm(): HTMLElement {
    const form = document.createElement("div");
    form.style.cssText =
      "border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:8px;" +
      "margin-bottom:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;";

    const subjectInput = document.createElement("input");
    subjectInput.placeholder = "Nutzername";
    subjectInput.value = this.#newSubject;
    subjectInput.style.cssText = "flex:1;min-width:100px;";
    subjectInput.addEventListener("input", () => {
      this.#newSubject = subjectInput.value;
    });

    const datalistId = "omp-admin-node-datalist";
    const nodeInput = document.createElement("input");
    nodeInput.placeholder = "Node-ID (* = alle Nodes)";
    nodeInput.value = this.#newNodeId;
    nodeInput.setAttribute("list", datalistId);
    nodeInput.style.cssText = "flex:1;min-width:160px;";
    nodeInput.addEventListener("input", () => {
      this.#newNodeId = nodeInput.value;
    });

    const datalist = document.createElement("datalist");
    datalist.id = datalistId;
    const anyOpt = document.createElement("option");
    anyOpt.value = "*";
    anyOpt.label = "Alle Nodes";
    datalist.appendChild(anyOpt);
    for (const n of this.#nodes) {
      const opt = document.createElement("option");
      opt.value = n.instanceId || n.id;
      opt.label = n.label;
      datalist.appendChild(opt);
    }

    const verbSelect = document.createElement("select");
    for (const v of VERBS) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = VERB_LABEL[v];
      if (v === this.#newVerb) opt.selected = true;
      verbSelect.appendChild(opt);
    }
    verbSelect.addEventListener("change", () => {
      this.#newVerb = verbSelect.value;
    });

    const createBtn = document.createElement("button");
    createBtn.textContent = "Anlegen";
    createBtn.style.cssText = "cursor:pointer;";
    createBtn.addEventListener("click", () => this.#createBinding());

    form.append(subjectInput, nodeInput, datalist, verbSelect, createBtn);
    return form;
  }

  #renderBindingRow(b: RoleBinding): HTMLElement {
    const tr = document.createElement("tr");

    const subjectTd = document.createElement("td");
    subjectTd.style.cssText = "padding:2px 8px;";
    subjectTd.textContent = b.subject;
    tr.appendChild(subjectTd);

    const nodeTd = document.createElement("td");
    nodeTd.style.cssText = "padding:2px 8px;color:var(--omp-text-dim);";
    nodeTd.textContent = b.nodeId === "*" ? "Alle Nodes" : this.#nodeLabel(b.nodeId);
    tr.appendChild(nodeTd);

    const verbTd = document.createElement("td");
    verbTd.style.cssText = "padding:2px 8px;";
    verbTd.textContent = VERB_LABEL[b.verb] ?? b.verb;
    tr.appendChild(verbTd);

    const actionsTd = document.createElement("td");
    actionsTd.style.cssText = "padding:2px 8px;text-align:right;";
    const delBtn = document.createElement("button");
    delBtn.textContent = "Löschen";
    delBtn.style.cssText = "font-size:11px;cursor:pointer;";
    delBtn.addEventListener("click", () => this.#deleteBinding(b.id));
    actionsTd.appendChild(delBtn);
    tr.appendChild(actionsTd);

    return tr;
  }

  #nodeLabel(nodeId: string): string {
    const n = this.#nodes.find((n) => n.instanceId === nodeId || n.id === nodeId);
    return n ? `${n.label} (${nodeId})` : nodeId;
  }

  #renderAuditSection(): HTMLElement {
    const section = document.createElement("div");

    const heading = document.createElement("div");
    heading.style.cssText = "font-weight:600;margin-bottom:6px;";
    heading.textContent = `Audit-Log (${this.#audit.length})`;
    section.appendChild(heading);

    if (this.#audit.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--omp-text-dim);";
      empty.textContent = "Noch keine protokollierten Aktionen.";
      section.appendChild(empty);
      return section;
    }

    const rows = this.#audit
      .map(
        (e) => `<tr>
        <td style="padding:2px 8px;color:var(--omp-text-dim);white-space:nowrap;">${escapeHtml(new Date(e.occurredAt).toLocaleString())}</td>
        <td style="padding:2px 8px;">${escapeHtml(e.username)}</td>
        <td style="padding:2px 8px;">${escapeHtml(e.method)}</td>
        <td style="padding:2px 8px;color:var(--omp-text-dim);word-break:break-all;">${escapeHtml(e.path)}</td>
        <td style="padding:2px 8px;color:${e.status >= 400 ? "var(--omp-error)" : "var(--omp-text)"};">${e.status}</td>
      </tr>`,
      )
      .join("");

    const table = document.createElement("table");
    table.style.cssText = "border-collapse:collapse;width:100%;";
    table.innerHTML = `<thead><tr style="color:var(--omp-text-dim);text-align:left;">
      <th style="padding:2px 8px;">Zeit</th>
      <th style="padding:2px 8px;">Nutzer</th>
      <th style="padding:2px 8px;">Methode</th>
      <th style="padding:2px 8px;">Pfad</th>
      <th style="padding:2px 8px;">Status</th>
    </tr></thead><tbody>${rows}</tbody>`;
    section.appendChild(table);

    return section;
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

customElements.define("omp-admin-view", AdminView);
