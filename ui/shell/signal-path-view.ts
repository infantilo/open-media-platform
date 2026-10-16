// <omp-signal-path-view> — "Signalweg"-Tab (Nutzerauftrag 2026-10-07):
// Quelle, Ziel und optional eine Node dazwischen wählen, dann die gesamte
// Kette der IST-Verbindungen sehen — Node für Node, mit Host, Format,
// Transport und der ersten Fehlerstelle. Reine Anzeige: nichts hier
// schaltet oder verbindet. Konsument von GET /api/v1/graph (Kanten =
// aktive IS-05-Verbindungen), GET /api/v1/instances (Host, Absturz) und
// GET /api/v1/hosts (Label). Pfadsuche/Diagnose: signal-path-logic.ts.
import { apiFetch, connectionMonitor } from "./connection.ts";
import { t } from "./i18n.ts";
import {
  diagnosePath,
  findPaths,
  firstError,
  formatName,
  type GraphData,
  formatMbps,
  type Hop,
  type Issue,
  linkNetNote,
  loopFeeder,
  type PathQuery,
  MAX_PATHS,
  type NodeContext,
  netDemandText,
  nodeOptions,
  senderOptions,
  targetOptions,
  transportName,
  withImplicitFeeds,
} from "./signal-path-logic.ts";

interface InstanceInfo {
  id: string;
  type?: string;
  hostId?: string;
  crashed?: boolean;
}

interface NetInfo {
  thresholdPercent: number;
  instances: Record<string, { hostKey: string; netRxMbps?: number; netTxMbps?: number; netEstimated?: boolean }>;
  hosts: Record<string, { label: string; linkMbps?: number; percent?: number; measured: boolean }>;
}

type ProblemList = NonNullable<NodeContext["problems"]>;

const NO_MONITOR_RETRY_MS = 30000;
const POLL_INTERVAL_MS = 5000;
const REFRESH_EVENT_TYPES = new Set(["edge.added", "edge.removed", "instance.crashed", "instance.restarted", "lost-events"]);

function esc(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

const COLOR = { error: "var(--omp-error)", warn: "var(--omp-cue)", ok: "var(--omp-preset)" };

class SignalPathView extends HTMLElement {
  #pollHandle: number | undefined;
  #graph: GraphData = { nodes: [], edges: [] };
  #instances = new Map<string, InstanceInfo>();
  #hostLabels = new Map<string, string>();
  #net: NetInfo | null = null;
  #problems = new Map<string, ProblemList>();
  #noMonitorTypes = new Map<string, number>(); // Typ → Zeitpunkt der letzten Fehlanzeige
  #from = "";
  #to = "";
  #via = "";
  #loaded = false;

  connectedCallback() {
    this.style.cssText =
      "display:block;background:var(--omp-surface);font-family:var(--omp-font);" +
      "font-size:var(--omp-font-size-sm);color:var(--omp-text);padding:var(--omp-space-3);" +
      "box-sizing:border-box;width:100%;height:100%;overflow-y:auto;";
    this.innerHTML = `
      <div class="omp-h1" style="margin-bottom:var(--omp-space-3);">${t("sp.title")}</div>
      <div style="color:var(--omp-text-dim);margin-bottom:var(--omp-space-3);">
        ${t("sp.intro")}
      </div>
      <div id="form" style="display:flex;flex-wrap:wrap;gap:var(--omp-space-3);align-items:flex-end;margin-bottom:var(--omp-space-4);">
        ${(["from", "to", "via"] as const).map((f) => `
        <label style="display:flex;flex-direction:column;gap:2px;">${t(f === "from" ? "sp.source" : f === "to" ? "sp.target" : "sp.via")}
          <span class="cb" data-f="${f}" style="position:relative;display:block;min-width:${f === "via" ? 220 : 260}px;">
            <input type="text" autocomplete="off" spellcheck="false" style="width:100%;box-sizing:border-box;padding-right:22px;">
            <span class="cb-x" title="${esc(t("sp.clear"))}" style="position:absolute;right:6px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--omp-text-dim);display:none;">×</span>
            <div class="cb-list" style="display:none;position:absolute;z-index:50;left:0;right:0;top:100%;max-height:320px;overflow-y:auto;background:var(--omp-surface);border:1px solid var(--omp-border, #888);box-shadow:0 4px 12px rgba(0,0,0,.35);"></div>
          </span>
        </label>`).join("")}
      </div>
      <div id="result"></div>`;
    this.addEventListener("input", this.#onInput);
    this.addEventListener("focusin", this.#onFocusIn);
    this.addEventListener("focusout", this.#onFocusOut);
    this.addEventListener("keydown", this.#onKey);
    this.addEventListener("mousedown", this.#onMouseDown);
    this.#poll();
    this.#pollHandle = window.setInterval(() => this.#poll(), POLL_INTERVAL_MS);
    connectionMonitor.addEventListener("sse-message", this.#onSseMessage);
  }

  disconnectedCallback() {
    this.removeEventListener("input", this.#onInput);
    this.removeEventListener("focusin", this.#onFocusIn);
    this.removeEventListener("focusout", this.#onFocusOut);
    this.removeEventListener("keydown", this.#onKey);
    this.removeEventListener("mousedown", this.#onMouseDown);
    if (this.#pollHandle !== undefined) window.clearInterval(this.#pollHandle);
    connectionMonitor.removeEventListener("sse-message", this.#onSseMessage);
  }

  // --- Such-Auswahl (Combobox): tippen filtert (alle Suchwörter müssen im Namen vorkommen) ---
  #opts: Record<string, { value: string; label: string }[]> = { from: [], to: [], via: [] };
  #active = -1;

  #cb(f: string) {
    const root = this.querySelector<HTMLElement>(`.cb[data-f="${f}"]`)!;
    return { root, input: root.querySelector("input")!, list: root.querySelector<HTMLElement>(".cb-list")!, x: root.querySelector<HTMLElement>(".cb-x")! };
  }
  #get(f: string): string {
    return f === "from" ? this.#from : f === "to" ? this.#to : this.#via;
  }
  #set(f: string, v: string) {
    if (f === "from") this.#from = v;
    else if (f === "to") this.#to = v;
    else this.#via = v;
  }
  #labelOf(f: string): string {
    const v = this.#get(f);
    return this.#opts[f].find((o) => o.value === v)?.label ?? "";
  }
  #syncInput(f: string) {
    const { input, x } = this.#cb(f);
    if (document.activeElement !== input) input.value = this.#labelOf(f);
    x.style.display = this.#get(f) ? "block" : "none";
  }
  #matches(f: string, query: string) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.#opts[f].filter((o) => {
      const l = o.label.toLowerCase();
      return words.every((w) => l.includes(w));
    });
  }
  #openList(f: string, query: string) {
    const { list } = this.#cb(f);
    const hits = this.#matches(f, query).slice(0, 200);
    this.#active = hits.length ? 0 : -1;
    list.innerHTML = hits.length
      ? hits.map((o, i) => `<div class="cb-item" data-v="${esc(o.value)}" style="padding:4px 8px;cursor:pointer;${i === 0 ? "background:var(--omp-hover, rgba(128,128,128,.3));" : ""}">${esc(o.label)}</div>`).join("")
      : `<div style="padding:4px 8px;color:var(--omp-text-dim);">${esc(t("sp.noMatch"))}</div>`;
    list.style.display = "block";
  }
  #closeList(f: string) {
    this.#cb(f).list.style.display = "none";
    this.#syncInput(f);
  }
  #highlight(f: string, delta: number) {
    const items = [...this.#cb(f).list.querySelectorAll<HTMLElement>(".cb-item")];
    if (!items.length) return;
    this.#active = (this.#active + delta + items.length) % items.length;
    items.forEach((el, i) => {
      el.style.background = i === this.#active ? "var(--omp-hover, rgba(128,128,128,.3))" : "";
      if (i === this.#active) el.scrollIntoView({ block: "nearest" });
    });
  }
  #pick(f: string, v: string) {
    this.#set(f, v);
    this.#cb(f).input.value = this.#labelOf(f); // vor blur, sonst deutet focusout das leere Feld als „löschen“
    this.#closeList(f);
    this.#cb(f).input.blur();
    this.#renderResult();
  }
  #field(ev: Event): string | null {
    return (ev.target as HTMLElement).closest<HTMLElement>(".cb")?.dataset.f ?? null;
  }
  #onInput = (ev: Event) => {
    const f = this.#field(ev);
    if (f) this.#openList(f, (ev.target as HTMLInputElement).value);
  };
  #onFocusIn = (ev: Event) => {
    const f = this.#field(ev);
    if (!f || (ev.target as HTMLElement).tagName !== "INPUT") return;
    (ev.target as HTMLInputElement).select();
    this.#openList(f, "");
  };
  #onFocusOut = (ev: Event) => {
    const f = this.#field(ev);
    if (!f) return;
    // Leeres Feld = Auswahl löschen; sonst zurück auf die gewählte Beschriftung.
    if (!(ev.target as HTMLInputElement).value.trim() && this.#get(f)) {
      this.#set(f, "");
      this.#renderResult();
    }
    this.#closeList(f);
  };
  #onKey = (ev: KeyboardEvent) => {
    const f = this.#field(ev);
    if (!f) return;
    const list = this.#cb(f).list;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (list.style.display === "none") this.#openList(f, "");
      else this.#highlight(f, ev.key === "ArrowDown" ? 1 : -1);
    } else if (ev.key === "Enter") {
      const el = list.querySelectorAll<HTMLElement>(".cb-item")[this.#active];
      if (el) this.#pick(f, el.dataset.v ?? "");
    } else if (ev.key === "Escape") {
      this.#cb(f).input.blur();
    }
  };
  #onMouseDown = (ev: MouseEvent) => {
    const el = ev.target as HTMLElement;
    const f = this.#field(ev);
    if (!f) return;
    if (el.classList.contains("cb-item")) {
      ev.preventDefault();
      this.#pick(f, el.dataset.v ?? "");
    } else if (el.classList.contains("cb-x")) {
      ev.preventDefault();
      this.#set(f, "");
      this.#cb(f).input.value = "";
      this.#syncInput(f);
      this.#renderResult();
    }
  };

  #onSseMessage = (ev: Event) => {
    try {
      const parsed = JSON.parse((ev as CustomEvent<string>).detail) as { type: string };
      if (REFRESH_EVENT_TYPES.has(parsed.type)) this.#poll();
    } catch {
      // kein JSON — ignorieren
    }
  };

  async #poll() {
    try {
      const [g, inst, hosts, net] = await Promise.all([
        apiFetch("/api/v1/graph"),
        apiFetch("/api/v1/instances"),
        apiFetch("/api/v1/hosts"),
        apiFetch("/api/v1/graph/network"),
      ]);
      this.#net = net.ok ? ((await net.json()) as NetInfo) : null;
      if (!g.ok) return;
      const graph = (await g.json()) as GraphData;
      this.#instances = new Map(((inst.ok ? await inst.json() : []) as InstanceInfo[]).map((i) => [i.id, i]));
      const [feeds, problems] = await Promise.all([this.#implicitFeeds(graph), this.#runtimeProblems(graph)]);
      this.#problems = problems;
      this.#graph = withImplicitFeeds(graph, feeds);
      this.#hostLabels = new Map(((hosts.ok ? await hosts.json() : []) as { id: string; label: string }[]).map((h) => [h.id, h.label]));
      this.#loaded = true;
      this.#renderForm();
      this.#renderResult();
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächster Poll holt es auf.
    }
  }

  /**
   * Switcher (`activeInput`) und Video-Mixer M/E (`crosspoint.programInput`, bei mehreren Ebenen `levelN.`-präfigiert)
   * haben keine IS-05-Kanten zu ihren Quellen — die geschaltete Quelle wird als virtueller Eingang ergänzt (withImplicitFeeds).
   */
  async #implicitFeeds(graph: GraphData): Promise<Map<string, string[]>> {
    const feeds = new Map<string, string[]>();
    const read = async (nodeId: string, param: string): Promise<string> => {
      try {
        const r = await apiFetch(`/api/v1/nodes/${nodeId}/params/${param}`);
        const v = r.ok ? ((await r.json()) as { value?: unknown }).value : undefined;
        return typeof v === "string" ? v : "";
      } catch {
        return ""; // Node nicht erreichbar — Kette endet dort wie bisher.
      }
    };
    await Promise.all(graph.nodes.map(async (n) => {
      const type = n.instanceId ? this.#instances.get(n.instanceId)?.type : undefined;
      let params: string[] = [];
      if (type === "omp-switcher") params = ["activeInput"];
      else if (type === "omp-video-mixer-me") {
        const pgm = n.outputs.length;
        params = pgm <= 1 ? ["crosspoint.programInput"] : n.outputs.map((_, i) => `level${i + 1}.crosspoint.programInput`);
      } else return;
      const ids = (await Promise.all(params.map((p) => read(n.id, p)))).filter(Boolean);
      if (ids.length) feeds.set(n.id, [...new Set(ids)]);
    }));
    return feeds;
  }

  /**
   * Laufzeit-Probleme aus dem BCP-008-Status der Nodes (`monitor.overallStatus` + Meldung): Handy-Gateway ohne
   * Sitzung/Bilder, Mischer mit nicht lesbaren Eingängen, Karten ohne Signal usw. Nodes ohne Monitor werden je Typ
   * erkannt und für 30 s nicht erneut abgefragt.
   */
  async #runtimeProblems(graph: GraphData): Promise<Map<string, ProblemList>> {
    const out = new Map<string, ProblemList>();
    const read = async (nodeId: string, param: string): Promise<unknown> => {
      try {
        const r = await apiFetch(`/api/v1/nodes/${nodeId}/params/${param}`);
        return r.ok ? ((await r.json()) as { value?: unknown }).value : undefined;
      } catch {
        return undefined;
      }
    };
    await Promise.all(graph.nodes.map(async (n) => {
      const inst = n.instanceId ? this.#instances.get(n.instanceId) : undefined;
      if (!inst || inst.crashed || (inst.type && Date.now() - (this.#noMonitorTypes.get(inst.type) ?? 0) < NO_MONITOR_RETRY_MS)) return;
      const status = await read(n.id, "monitor.overallStatus");
      if (typeof status !== "string") {
        if (inst.type) this.#noMonitorTypes.set(inst.type, Date.now()); // kurz nicht erreichbar (Neustart) darf nicht dauerhaft blind machen
        return;
      }
      if (status !== "Unhealthy" && status !== "PartiallyHealthy") return;
      // Die Gesamtmeldung ist oft leer — dann die Meldungen der schlechten Teilbereiche (Sitzung, Bild, Link …) nehmen.
      const texts: string[] = [];
      const overall = await read(n.id, "monitor.overallStatusMessage");
      if (typeof overall === "string" && overall) texts.push(overall);
      else {
        await Promise.all(["transmission", "connection", "essence", "stream", "link"].map(async (d) => {
          const st = await read(n.id, `monitor.${d}Status`);
          if (st === undefined || st === "Healthy" || st === "AllUp" || st === "Inactive" || st === "NotUsed") return;
          const m = await read(n.id, `monitor.${d}StatusMessage`);
          if (typeof m === "string" && m && !texts.includes(m)) texts.push(m);
        }));
      }
      out.set(n.id, [{
        severity: status === "Unhealthy" ? "error" : "warn",
        text: t("sp.issue.monitor", { node: n.label, text: texts.join("; ") || status }),
      }]);
    }));
    return out;
  }

  /** Optionen neu aufbauen, Auswahl behalten (solange sie noch existiert). */
  #renderForm() {
    this.#opts.from = senderOptions(this.#graph).map((o) => ({ value: o.id, label: o.label }));
    this.#opts.to = targetOptions(this.#graph);
    this.#opts.via = nodeOptions(this.#graph).map((o) => ({ value: o.id, label: o.label }));
    const ph = { from: "sp.chooseSource", to: "sp.chooseTarget", via: "sp.noVia" } as const;
    for (const f of ["from", "to", "via"] as const) {
      if (this.#get(f) && !this.#opts[f].some((o) => o.value === this.#get(f))) this.#set(f, "");
      this.#cb(f).input.placeholder = t(ph[f]);
      this.#syncInput(f);
    }
  }

  #ctx = (nodeId: string): NodeContext => {
    const node = this.#graph.nodes.find((n) => n.id === nodeId);
    const inst = node?.instanceId ? this.#instances.get(node.instanceId) : undefined;
    if (!inst) return {};
    const ctx: NodeContext = {
      problems: this.#problems.get(nodeId),
      hostKey: inst.hostId ?? "",
      hostLabel: inst.hostId ? this.#hostLabels.get(inst.hostId) || inst.hostId : t("sp.hostLocal"),
      crashed: inst.crashed,
    };
    const ni = this.#net?.instances[inst.id];
    if (ni) {
      ctx.netRxMbps = ni.netRxMbps;
      ctx.netTxMbps = ni.netTxMbps;
      ctx.netEstimated = ni.netEstimated;
      const h = this.#net!.hosts[ni.hostKey];
      if (h) ctx.hostNet = { measured: h.measured, linkMbps: h.linkMbps, percent: h.percent, thresholdPercent: this.#net!.thresholdPercent };
    }
    return ctx;
  };

  #renderResult() {
    const out = this.querySelector<HTMLElement>("#result")!;
    if (!this.#loaded) {
      out.innerHTML = `<div class="omp-empty">${t("sp.loading")}</div>`;
      return;
    }
    // Quelle UND/ODER Ziel genügt: nur Quelle zeigt alles, was von ihr ausgeht; nur Ziel alles, was dort ankommt.
    if (!this.#from && !this.#to) {
      out.innerHTML = `<div class="omp-empty">${t("sp.pick")}</div>`;
      return;
    }
    const q: PathQuery = { viaNodeId: this.#via || undefined };
    if (this.#from) q.fromSender = this.#from;
    if (this.#to.startsWith("rx:")) q.toReceiver = this.#to.slice(3);
    else if (this.#to.startsWith("node:")) q.toNodeId = this.#to.slice(5);
    const res = findPaths(this.#graph, q);
    if (res.paths.length === 0) {
      const key = this.#via ? "sp.noPathVia" : this.#from && this.#to ? "sp.noPath" : this.#from ? "sp.noDownstream" : "sp.noUpstream";
      out.innerHTML = `<div class="omp-empty">${t(key)}</div>`;
      return;
    }
    const blocks = res.paths.map((p, i) => this.#renderPath(p, i, res.paths.length));
    const more = res.truncated ? `<div style="color:var(--omp-text-dim);">${t("sp.truncated", { max: MAX_PATHS })}</div>` : "";
    out.innerHTML = blocks.join("") + more;
  }

  #renderPath(path: Hop[], index: number, total: number): string {
    const issues = diagnosePath(path, this.#ctx, loopFeeder(this.#graph, path));
    const err = firstError(issues);
    const nodes = [path[0].fromNode, ...path.map((h) => h.toNode)];
    const at = (pos: number): Issue[] => issues.filter((i) => i.position === pos);
    const border = (pos: number) => (at(pos).some((i) => i.severity === "error") ? COLOR.error : at(pos).length ? COLOR.warn : "var(--omp-border)");

    const parts: string[] = [];
    nodes.forEach((n, k) => {
      const c = this.#ctx(n.id);
      const inLabel = k > 0 ? path[k - 1].receiver.label : "";
      const outLabel = k < path.length ? path[k].sender.label : "";
      parts.push(`<div data-testid="sp-node" style="border:2px solid ${border(2 * k)};border-radius:var(--omp-radius);background:var(--omp-surface-raised);padding:var(--omp-space-2);min-width:150px;max-width:220px;">
        <div style="font-weight:600;">${esc(n.label)}</div>
        <div style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);">${c.hostLabel ? esc(t("sp.host", { host: c.hostLabel })) : t("sp.hostUnknown")} · ${n.health === "ok" ? t("sp.online") : t("sp.offline")}</div>
        ${netDemandText(c) ? `<div style="font-size:var(--omp-font-size-xs);">${esc(t("sp.net", { demand: netDemandText(c) }))}</div>` : ""}
        ${c.hostNet?.measured && c.hostNet.linkMbps && netDemandText(c) ? `<div style="color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);">${esc(t("sp.card", { percent: (c.hostNet.percent ?? 0).toFixed(0), link: formatMbps(c.hostNet.linkMbps) }))}</div>` : ""}
        ${inLabel ? `<div style="font-size:var(--omp-font-size-xs);">▶ ${esc(inLabel)}</div>` : ""}
        ${outLabel ? `<div style="font-size:var(--omp-font-size-xs);">${esc(outLabel)} ▶</div>` : ""}
        ${at(2 * k).map((i) => `<div style="color:${COLOR[i.severity]};font-size:var(--omp-font-size-xs);">${esc(i.text)}</div>`).join("")}
      </div>`);
      if (k < path.length) {
        const h = path[k];
        parts.push(`<div data-testid="sp-link" style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:110px;max-width:200px;color:${border(2 * k + 1) === "var(--omp-border)" ? "var(--omp-text-dim)" : border(2 * k + 1)};font-size:var(--omp-font-size-xs);text-align:center;">
          <div>${esc(formatName(h.sender.format))} · ${esc(transportName(h.sender.transport))}</div>
          <div style="font-size:18px;line-height:1;">⟶</div>
          ${linkNetNote(h, this.#ctx) ? `<div>${esc(linkNetNote(h, this.#ctx))}</div>` : ""}
          ${at(2 * k + 1).map((i) => `<div>${esc(i.text)}</div>`).join("")}
        </div>`);
      }
    });

    const verdict = err
      ? `<span style="color:${COLOR.error};">${esc(t("sp.verdict.error", { text: err.text }))}</span>`
      : issues.length
      ? `<span style="color:${COLOR.warn};">${t("sp.verdict.warn")}</span>`
      : `<span style="color:${COLOR.ok};">${t("sp.verdict.ok")}</span>`;
    const count = path.length === 1 ? t("sp.connections.one") : t("sp.connections.many", { n: path.length });
    return `<section style="margin-bottom:var(--omp-space-4);">
      <div style="margin-bottom:var(--omp-space-2);"><strong>${total > 1 ? t("sp.pathN", { n: index + 1, total }) : t("sp.path")}</strong> · ${count} · ${verdict}</div>
      <div style="display:flex;flex-wrap:wrap;align-items:stretch;gap:var(--omp-space-1);">${parts.join("")}</div>
    </section>`;
  }
}

customElements.define("omp-signal-path-view", SignalPathView);
