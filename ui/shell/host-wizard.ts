// <omp-host-wizard> — geführter Ablauf "Neuen Host hinzufügen"
// (Nutzerauftrag 2026-08-27: "wie könnte aus unserem orchestrator aus
// ein neuer host eingerichtet werden oder [...] auf eine AWS ausgelagert
// werden, so dass es für den user so einfach und intuitiv wie möglich
// ist [...] sowas wie ein Wizard").
//
// Baut auf zwei bereits bestehenden, bisher UI-losen Backend-Bausteinen
// auf (kein neuer Endpunkt nötig): dem Bootstrap-Token-Flow
// (ARCHITECTURE.md §18.3, host_handlers.go: POST
// /api/v1/admin/hosts/bootstrap-tokens, POST /api/v1/hosts/register) und
// der bereits identischen Behandlung von Bare-Metal/VM/Cloud-Hosts durch
// denselben omp-host-agent (§18.8: "Host-Agent läuft identisch wie auf
// Bare-Metal — keine Sonderbehandlung"). Die "Zielumgebung"-Auswahl
// unten ist deshalb bewusst NUR Text-/Skript-Framing (ein anderes
// Provisionierungs-Snippet), keine unterschiedliche API-Anbindung.
//
// Bewusst NICHT gebaut (§18.9 Punkt 5, §10 Punkt 4 — "kein
// Cloud-SDK/Vendor-Lock im Kern"): kein automatisches Hochfahren einer
// EC2-Instanz durch den Orchestrator selbst. Der Wizard liefert ein
// fertiges, kopierbares Provisionierungs-Skript (Cloud-Init/User-Data
// für AWS, ein Shell-Einzeiler für Bare-Metal/VM) — das tatsächliche
// Anlegen der Maschine bleibt Sache des Betreibers/seines bevorzugten
// Provisioning-Wegs, wie ARCHITECTURE.md §18.3 Punkt 2 das offen lässt.
// Ebenso ehrlich: es gibt in diesem Projekt kein vorgefertigtes
// Installations-Artefakt für omp-host-agent (kein curl-Installer) — das
// Snippet geht davon aus, dass die Binary bereits auf dem Zielhost liegt
// (gebaut aus host-agent/ oder kopiert), s. Kommentar in #buildSnippet.
//
// Registrierungs-Erkennung (Schritt "waiting"): ein einmaliger Snapshot
// der zum Zeitpunkt der Token-Erzeugung bekannten Host-IDs plus Abgleich
// von Label — der Host-Agent liefert dem Orchestrator selbst keine
// Rückmeldung "welcher Wizard-Lauf hat mich erzeugt", also ist Label der
// einzige verfügbare Korrelations-Schlüssel. Bekannte Einschränkung:
// zwei gleichzeitig laufende Wizard-Sitzungen mit demselben Label würden
// sich gegenseitig verwirren — für einen von einem Admin geführten
// Onboarding-Schritt keine praxisrelevante Lücke, nicht weiter
// abgesichert.
import { apiFetch, connectionMonitor } from "./connection.ts";

interface HostCapabilities {
  os?: string;
  arch?: string;
  numCPU?: number;
}

interface HostEntry {
  id: string;
  label: string;
  hostname: string;
  registeredAt: string;
  capabilities?: HostCapabilities;
}

type WizardStep = "target" | "provision" | "waiting" | "done" | "error";
type TargetClass = "bare-metal" | "vm" | "cloud-aws";

interface TargetTile {
  id: TargetClass;
  title: string;
  hint: string;
}

// Reihenfolge/Wortlaut wie ARCHITECTURE.md §18.8s Klassen-Tabelle.
const TARGET_TILES: TargetTile[] = [
  { id: "bare-metal", title: "Bare-Metal", hint: "eigener/dedizierter Server (z. B. 2110/SDI-Karten)" },
  { id: "vm", title: "VM (lokaler Cluster)", hint: "virtuelle Maschine im eigenen Netz" },
  { id: "cloud-aws", title: "Cloud (AWS EC2)", hint: "Zusatzkapazität, kein PTP/Multicast (§6)" },
];

const WAIT_POLL_INTERVAL_MS = 2000;
const TICK_INTERVAL_MS = 1000;

function formatRemaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "abgelaufen";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

class HostWizard extends HTMLElement {
  #step: WizardStep = "target";
  #targetClass: TargetClass | null = null;
  #label = "";
  #provisionLoading = false;
  #token = "";
  #tokenExpiresAt = "";
  #orchestratorUrl = "";
  #registryUrl = "";
  #natsUrl = "";
  #knownHostIds = new Set<string>();
  #registeredHost: HostEntry | null = null;
  #errorMessage = "";
  #copyFeedback = false;
  #pollHandle: number | undefined;
  #tickHandle: number | undefined;
  #snippetEl: HTMLPreElement | null = null;

  connectedCallback() {
    this.style.cssText =
      "position:fixed;inset:0;z-index:1100;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(0,0,0,0.5);font-family:var(--omp-font);font-size:var(--omp-font-size-sm);color:var(--omp-text);";
    // Best-effort-Vorbelegung aus der Browser-Adresse, editierbar (s.
    // #renderProvisionStep) — der Orchestrator kennt seine eigene, von
    // außen erreichbare Adresse nicht (könnte hinter einem Reverse-Proxy
    // liegen), aber die Adresse, über die der Admin GERADE zugreift, ist
    // der plausibelste Default. Registry/NATS-Ports sind reine Vermutung
    // (Standard-Ports desselben Hosts) — nur ein Startpunkt.
    this.#orchestratorUrl = window.location.origin;
    this.#registryUrl = `${window.location.protocol}//${window.location.hostname}:8010`;
    this.#natsUrl = `nats://${window.location.hostname}:4222,nats://${window.location.hostname}:4223,nats://${window.location.hostname}:4224`;
    this.addEventListener("click", this.#onBackdropClick);
    document.addEventListener("keydown", this.#onKeyDown);
    connectionMonitor.addEventListener("sse-message", this.#onSseMessage);
    this.#render();
  }

  disconnectedCallback() {
    document.removeEventListener("keydown", this.#onKeyDown);
    connectionMonitor.removeEventListener("sse-message", this.#onSseMessage);
    this.#stopPoll();
    this.#stopTick();
  }

  #onBackdropClick = (ev: Event) => {
    if (ev.target === this) this.#close();
  };

  #onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") this.#close();
  };

  // Schließen ist an jeder Stelle sicher: ein bereits erzeugtes Token
  // bleibt bis zum Ablauf gültig, ein sich meldender Host erscheint
  // ohnehin über hosts-view.ts' eigenen "host.registered"-SSE-Handler in
  // der Hauptliste — der Wizard hat keinen Zustand, den ein Abbruch
  // beschädigen könnte.
  #close() {
    this.remove();
  }

  #onSseMessage = (ev: Event) => {
    if (this.#step !== "waiting") return;
    let parsed: { type: string };
    try {
      parsed = JSON.parse((ev as CustomEvent<string>).detail);
    } catch {
      return;
    }
    if (parsed.type === "host.registered") this.#pollForRegistration();
  };

  #startPoll() {
    if (this.#pollHandle !== undefined) return;
    this.#pollHandle = window.setInterval(() => this.#pollForRegistration(), WAIT_POLL_INTERVAL_MS);
  }

  #stopPoll() {
    if (this.#pollHandle === undefined) return;
    window.clearInterval(this.#pollHandle);
    this.#pollHandle = undefined;
  }

  #startTick() {
    if (this.#tickHandle !== undefined) return;
    this.#tickHandle = window.setInterval(() => this.#render(), TICK_INTERVAL_MS);
  }

  #stopTick() {
    if (this.#tickHandle === undefined) return;
    window.clearInterval(this.#tickHandle);
    this.#tickHandle = undefined;
  }

  async #pollForRegistration() {
    try {
      const res = await apiFetch("/api/v1/hosts");
      if (!res.ok) return;
      const all = (await res.json()) as HostEntry[];
      const match = all.find((h) => !this.#knownHostIds.has(h.id) && h.label === this.#label);
      if (match) {
        this.#registeredHost = match;
        this.#step = "done";
        this.#stopPoll();
        this.#stopTick();
        this.#render();
      }
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächster Poll holt es auf.
    }
  }

  // Schritt 1 → 2: Host-Snapshot (für die spätere "ist das MEIN neuer
  // Host"-Erkennung) und Token-Erzeugung parallel, weil beide vor dem
  // Rendern des Provisionierungs-Schritts feststehen müssen.
  async #proceedToToken() {
    this.#step = "provision";
    this.#provisionLoading = true;
    this.#errorMessage = "";
    this.#render();
    try {
      const [hostsRes, tokenRes] = await Promise.all([
        apiFetch("/api/v1/hosts"),
        apiFetch("/api/v1/admin/hosts/bootstrap-tokens", { method: "POST" }),
      ]);
      if (hostsRes.ok) {
        const existing = (await hostsRes.json()) as HostEntry[];
        this.#knownHostIds = new Set(existing.map((h) => h.id));
      }
      if (!tokenRes.ok) {
        this.#errorMessage =
          tokenRes.status === 403
            ? "Nur Admins können ein Bootstrap-Token erzeugen."
            : `Token-Erzeugung fehlgeschlagen (${tokenRes.status}).`;
        this.#step = "error";
        this.#render();
        return;
      }
      const body = (await tokenRes.json()) as { token: string; expiresAt: string };
      this.#token = body.token;
      this.#tokenExpiresAt = body.expiresAt;
      this.#provisionLoading = false;
      this.#render();
    } catch {
      this.#errorMessage = "Orchestrator nicht erreichbar.";
      this.#step = "error";
      this.#render();
    }
  }

  #startWaiting() {
    this.#step = "waiting";
    this.#render();
    this.#startPoll();
    this.#startTick();
    this.#pollForRegistration();
  }

  // buildSnippet: das kopierbare Provisionierungs-Skript. Bewusst KEIN
  // curl-Installer (kein solches Artefakt existiert, s. Datei-Kopf) —
  // stattdessen ein Hinweis, dass die Binary bereits vorhanden sein muss,
  // plus die vollständigen Env-Variablen aus host-agent/main.go.
  #buildSnippet(): string {
    const label = this.#label || "<Label>";
    const lines = {
      token: `OMP_HOST_AGENT_BOOTSTRAP_TOKEN="${this.#token}"`,
      label: `OMP_HOST_AGENT_LABEL="${label}"`,
      orch: `OMP_ORCHESTRATOR_URL="${this.#orchestratorUrl}"`,
      registry: `OMP_REGISTRY_URL="${this.#registryUrl}"`,
      nats: `OMP_NATS_URL="${this.#natsUrl}"`,
    };
    if (this.#targetClass === "cloud-aws") {
      return [
        "#!/bin/bash",
        "# EC2 User-Data. Setzt voraus, dass die omp-host-agent-Binary bereits",
        "# auf der Instanz liegt (eigenes AMI oder ein Build-Schritt davor —",
        "# dieses Projekt liefert kein vorgefertigtes Installations-Artefakt).",
        "# Agent-initiiertes Bootstrap (ARCHITECTURE.md §18.2/18.8): nur",
        "# ausgehende Verbindung nötig, keine eingehende Portöffnung in der",
        "# Security Group.",
        `export ${lines.token}`,
        `export ${lines.label}`,
        `export ${lines.orch}`,
        `export ${lines.registry}`,
        `export ${lines.nats}`,
        "/opt/omp/omp-host-agent",
      ].join("\n");
    }
    return [
      "# Voraussetzung: omp-host-agent-Binary auf diesem Host (gebaut aus",
      "# host-agent/ per `go build -o omp-host-agent .` oder von hier",
      "# kopiert: bin/omp-host-agent).",
      `${lines.token} \\`,
      `${lines.label} \\`,
      `${lines.orch} \\`,
      `${lines.registry} \\`,
      `${lines.nats} \\`,
      "./omp-host-agent",
    ].join("\n");
  }

  // Private Klassenfelder (#orchestratorUrl etc.) sind keine per
  // Computed-Key adressierbaren Objekt-Properties — dieser kleine
  // Switch ersetzt einen (in TS/JS nicht möglichen) dynamischen
  // this["#"+key]-Zugriff für die drei editierbaren URL-Felder oben.
  #getUrlField(key: "orchestratorUrl" | "registryUrl" | "natsUrl"): string {
    switch (key) {
      case "orchestratorUrl":
        return this.#orchestratorUrl;
      case "registryUrl":
        return this.#registryUrl;
      case "natsUrl":
        return this.#natsUrl;
    }
  }

  #setUrlField(key: "orchestratorUrl" | "registryUrl" | "natsUrl", value: string) {
    switch (key) {
      case "orchestratorUrl":
        this.#orchestratorUrl = value;
        break;
      case "registryUrl":
        this.#registryUrl = value;
        break;
      case "natsUrl":
        this.#natsUrl = value;
        break;
    }
  }

  #updateSnippetPreview() {
    if (this.#snippetEl) this.#snippetEl.textContent = this.#buildSnippet();
  }

  async #copySnippet() {
    const text = this.#buildSnippet();
    try {
      await navigator.clipboard.writeText(text);
      this.#copyFeedback = true;
      this.#render();
      window.setTimeout(() => {
        this.#copyFeedback = false;
        if (this.#step === "provision") this.#render();
      }, 1500);
    } catch {
      // Kein Clipboard-Zugriff (z. B. unsicherer Kontext) — das Snippet
      // steht als <pre> ohnehin sichtbar zum manuellen Markieren da.
    }
  }

  #render() {
    this.innerHTML = "";
    const dialog = document.createElement("div");
    dialog.className = "omp-card";
    dialog.style.cssText = "width:560px;max-width:90vw;max-height:85vh;overflow-y:auto;";

    const title = document.createElement("div");
    title.className = "omp-h1";
    title.style.cssText = "margin-bottom:var(--omp-space-3);";
    title.textContent =
      this.#step === "error"
        ? "Neuen Host hinzufügen — Fehler"
        : `Neuen Host hinzufügen (Schritt ${this.#stepNumber()}/4)`;
    dialog.appendChild(title);

    switch (this.#step) {
      case "target":
        dialog.appendChild(this.#renderTargetStep());
        break;
      case "provision":
        dialog.appendChild(this.#renderProvisionStep());
        break;
      case "waiting":
        dialog.appendChild(this.#renderWaitingStep());
        break;
      case "done":
        dialog.appendChild(this.#renderDoneStep());
        break;
      case "error":
        dialog.appendChild(this.#renderErrorStep());
        break;
    }

    this.appendChild(dialog);
  }

  #stepNumber(): number {
    switch (this.#step) {
      case "target":
        return 1;
      case "provision":
        return 2;
      case "waiting":
        return 3;
      case "done":
        return 4;
      default:
        return 1;
    }
  }

  #renderTargetStep(): HTMLElement {
    const wrap = document.createElement("div");

    const hint = document.createElement("div");
    hint.style.cssText = "color:var(--omp-text-dim);margin-bottom:var(--omp-space-3);";
    hint.textContent =
      "Wo läuft der neue Host? Der Host-Agent verhält sich in allen drei Fällen identisch — die Auswahl bestimmt nur das unten erzeugte Provisionierungs-Skript.";
    wrap.appendChild(hint);

    const tiles = document.createElement("div");
    tiles.style.cssText = "display:flex;gap:var(--omp-space-2);margin-bottom:var(--omp-space-4);flex-wrap:wrap;";
    for (const tile of TARGET_TILES) {
      const btn = document.createElement("button");
      btn.type = "button";
      const active = this.#targetClass === tile.id;
      btn.style.cssText =
        "flex:1;min-width:150px;text-align:left;padding:var(--omp-space-2);display:flex;flex-direction:column;gap:2px;" +
        (active ? "border-color:var(--omp-info);background:var(--omp-surface);" : "");
      const titleEl = document.createElement("div");
      titleEl.style.cssText = "font-weight:600;" + (active ? "color:var(--omp-info);" : "");
      titleEl.textContent = tile.title;
      const hintEl = document.createElement("div");
      hintEl.style.cssText = "font-size:var(--omp-font-size-xs);color:var(--omp-text-dim);";
      hintEl.textContent = tile.hint;
      btn.append(titleEl, hintEl);
      btn.addEventListener("click", () => {
        this.#targetClass = tile.id;
        this.#render();
        this.#focusLabelInput();
      });
      tiles.appendChild(btn);
    }
    wrap.appendChild(tiles);

    const labelWrap = document.createElement("div");
    labelWrap.style.cssText = "margin-bottom:var(--omp-space-4);";
    const labelText = document.createElement("label");
    labelText.style.cssText = "display:block;margin-bottom:4px;color:var(--omp-text-dim);";
    labelText.textContent = "Label für den neuen Host";
    const labelInput = document.createElement("input");
    labelInput.placeholder = "z. B. Regie-Host-C";
    labelInput.autocomplete = "off";
    labelInput.value = this.#label;
    labelInput.style.cssText = "width:100%;box-sizing:border-box;";
    labelInput.addEventListener("input", () => {
      this.#label = labelInput.value;
      nextBtn.disabled = !this.#canProceedFromTarget();
    });
    labelWrap.append(labelText, labelInput);
    wrap.appendChild(labelWrap);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:var(--omp-space-2);";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Abbrechen";
    cancelBtn.addEventListener("click", () => this.#close());
    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "omp-btn-primary";
    nextBtn.textContent = "Weiter";
    nextBtn.disabled = !this.#canProceedFromTarget();
    nextBtn.addEventListener("click", () => this.#proceedToToken());
    actions.append(cancelBtn, nextBtn);
    wrap.appendChild(actions);

    this.#labelInputRef = labelInput;
    return wrap;
  }

  #labelInputRef: HTMLInputElement | null = null;
  #focusLabelInput() {
    queueMicrotask(() => this.#labelInputRef?.focus());
  }

  #canProceedFromTarget(): boolean {
    return this.#targetClass !== null && this.#label.trim().length > 0;
  }

  #renderProvisionStep(): HTMLElement {
    const wrap = document.createElement("div");

    if (this.#provisionLoading) {
      const loading = document.createElement("div");
      loading.style.cssText = "color:var(--omp-text-dim);padding:var(--omp-space-4) 0;";
      loading.textContent = "Bootstrap-Token wird erzeugt …";
      wrap.appendChild(loading);
      return wrap;
    }

    const info = document.createElement("div");
    info.style.cssText = "color:var(--omp-text-dim);margin-bottom:var(--omp-space-3);";
    info.innerHTML = `Token erzeugt, gültig für <strong style="color:var(--omp-text);">${formatRemaining(this.#tokenExpiresAt)}</strong>. Prüfe die drei Adressen (vom Zielhost aus erreichbar, ggf. anpassen) und übertrage das Skript auf den neuen Host.`;
    wrap.appendChild(info);

    type UrlFieldKey = "orchestratorUrl" | "registryUrl" | "natsUrl";
    const fields: { key: UrlFieldKey; label: string }[] = [
      { key: "orchestratorUrl", label: "Orchestrator-URL" },
      { key: "registryUrl", label: "Registry-URL (vermutet)" },
      { key: "natsUrl", label: "NATS-URL (vermutet)" },
    ];
    const fieldsWrap = document.createElement("div");
    fieldsWrap.style.cssText = "display:flex;flex-direction:column;gap:var(--omp-space-2);margin-bottom:var(--omp-space-3);";
    for (const f of fields) {
      const row = document.createElement("div");
      const lbl = document.createElement("label");
      lbl.style.cssText = "display:block;margin-bottom:2px;color:var(--omp-text-dim);";
      lbl.textContent = f.label;
      const input = document.createElement("input");
      input.value = this.#getUrlField(f.key);
      input.style.cssText = "width:100%;box-sizing:border-box;font-family:var(--omp-font-mono);";
      input.addEventListener("input", () => {
        this.#setUrlField(f.key, input.value);
        this.#updateSnippetPreview();
      });
      row.append(lbl, input);
      fieldsWrap.appendChild(row);
    }
    wrap.appendChild(fieldsWrap);

    const pre = document.createElement("pre");
    pre.style.cssText =
      "background:var(--omp-bg);border:1px solid var(--omp-border);border-radius:var(--omp-radius);" +
      "padding:var(--omp-space-2);font-family:var(--omp-font-mono);font-size:var(--omp-font-size-xs);" +
      "white-space:pre-wrap;word-break:break-all;max-height:220px;overflow-y:auto;margin:0 0 var(--omp-space-3) 0;";
    pre.textContent = this.#buildSnippet();
    this.#snippetEl = pre;
    wrap.appendChild(pre);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:space-between;gap:var(--omp-space-2);align-items:center;";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.textContent = this.#copyFeedback ? "Kopiert!" : "Skript kopieren";
    copyBtn.addEventListener("click", () => this.#copySnippet());

    const rightActions = document.createElement("div");
    rightActions.style.cssText = "display:flex;gap:var(--omp-space-2);";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Abbrechen";
    cancelBtn.addEventListener("click", () => this.#close());
    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "omp-btn-primary";
    nextBtn.textContent = "Weiter — auf Anmeldung warten";
    nextBtn.addEventListener("click", () => this.#startWaiting());
    rightActions.append(cancelBtn, nextBtn);

    actions.append(copyBtn, rightActions);
    wrap.appendChild(actions);

    return wrap;
  }

  #renderWaitingStep(): HTMLElement {
    const wrap = document.createElement("div");
    const expired = formatRemaining(this.#tokenExpiresAt) === "abgelaufen";

    const status = document.createElement("div");
    status.style.cssText = "padding:var(--omp-space-3) 0;";
    if (expired) {
      status.innerHTML = `<strong style="color:var(--omp-cue);">Token abgelaufen</strong> — „${escapeHtml(this.#label)}" hat sich nicht gemeldet.`;
    } else {
      status.innerHTML = `Warte auf Anmeldung von „<strong>${escapeHtml(this.#label)}</strong>" … (Token läuft in ${formatRemaining(this.#tokenExpiresAt)} ab)`;
    }
    wrap.appendChild(status);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:var(--omp-space-2);margin-top:var(--omp-space-3);";
    if (expired) {
      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.className = "omp-btn-primary";
      retryBtn.textContent = "Neuen Token erzeugen";
      retryBtn.addEventListener("click", () => {
        this.#stopPoll();
        this.#stopTick();
        this.#proceedToToken();
      });
      actions.appendChild(retryBtn);
    }
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "Im Hintergrund weiterlaufen lassen";
    closeBtn.title = "Der Host erscheint bei Anmeldung ohnehin in der Hosts-Liste.";
    closeBtn.addEventListener("click", () => this.#close());
    actions.appendChild(closeBtn);
    wrap.appendChild(actions);

    return wrap;
  }

  #renderDoneStep(): HTMLElement {
    const wrap = document.createElement("div");
    const h = this.#registeredHost;

    const status = document.createElement("div");
    status.style.cssText = "padding:var(--omp-space-2) 0 var(--omp-space-3) 0;";
    status.innerHTML = `<strong style="color:var(--omp-preset);">Host registriert.</strong>`;
    wrap.appendChild(status);

    if (h) {
      const table = document.createElement("table");
      table.style.cssText = "border-collapse:collapse;margin-bottom:var(--omp-space-3);";
      const rows: [string, string][] = [
        ["Label", h.label],
        ["Hostname", h.hostname],
      ];
      if (h.capabilities?.os) rows.push(["OS", h.capabilities.os]);
      if (h.capabilities?.arch) rows.push(["Architektur", h.capabilities.arch]);
      if (h.capabilities?.numCPU) rows.push(["CPUs", String(h.capabilities.numCPU)]);
      for (const [k, v] of rows) {
        const tr = document.createElement("tr");
        const tdK = document.createElement("td");
        tdK.style.cssText = "padding:2px 8px 2px 0;color:var(--omp-text-dim);";
        tdK.textContent = k;
        const tdV = document.createElement("td");
        tdV.style.cssText = "padding:2px 0;";
        tdV.textContent = v;
        tr.append(tdK, tdV);
        table.appendChild(tr);
      }
      wrap.appendChild(table);
    }

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;";
    const doneBtn = document.createElement("button");
    doneBtn.type = "button";
    doneBtn.className = "omp-btn-primary";
    doneBtn.textContent = "Fertig";
    doneBtn.addEventListener("click", () => this.#close());
    actions.appendChild(doneBtn);
    wrap.appendChild(actions);

    return wrap;
  }

  #renderErrorStep(): HTMLElement {
    const wrap = document.createElement("div");
    const msg = document.createElement("div");
    msg.style.cssText = "color:var(--omp-error);padding:var(--omp-space-2) 0 var(--omp-space-3) 0;";
    msg.textContent = this.#errorMessage;
    wrap.appendChild(msg);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "Schließen";
    closeBtn.addEventListener("click", () => this.#close());
    actions.appendChild(closeBtn);
    wrap.appendChild(actions);

    return wrap;
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

if (!customElements.get("omp-host-wizard")) {
  customElements.define("omp-host-wizard", HostWizard);
}

// openHostWizard() — Aufrufer-Ergonomie analog confirmDialog()
// (ui/kit/omp-confirm.ts): Element erzeugen, an document.body hängen,
// der Wizard räumt sich beim Schließen selbst ab.
export function openHostWizard(): void {
  document.body.appendChild(document.createElement("omp-host-wizard"));
}
