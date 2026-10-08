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
  type PathQuery,
  MAX_PATHS,
  type NodeContext,
  netDemandText,
  nodeOptions,
  senderOptions,
  targetOptions,
  transportName,
} from "./signal-path-logic.ts";

interface InstanceInfo {
  id: string;
  hostId?: string;
  crashed?: boolean;
}

interface NetInfo {
  thresholdPercent: number;
  instances: Record<string, { hostKey: string; netRxMbps?: number; netTxMbps?: number; netEstimated?: boolean }>;
  hosts: Record<string, { label: string; linkMbps?: number; percent?: number; measured: boolean }>;
}

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
        <label style="display:flex;flex-direction:column;gap:2px;">${t("sp.source")}<select id="from" style="min-width:260px;"></select></label>
        <label style="display:flex;flex-direction:column;gap:2px;">${t("sp.target")}<select id="to" style="min-width:260px;"></select></label>
        <label style="display:flex;flex-direction:column;gap:2px;">${t("sp.via")}<select id="via" style="min-width:220px;"></select></label>
      </div>
      <div id="result"></div>`;
    this.addEventListener("change", this.#onChange);
    this.#poll();
    this.#pollHandle = window.setInterval(() => this.#poll(), POLL_INTERVAL_MS);
    connectionMonitor.addEventListener("sse-message", this.#onSseMessage);
  }

  disconnectedCallback() {
    this.removeEventListener("change", this.#onChange);
    if (this.#pollHandle !== undefined) window.clearInterval(this.#pollHandle);
    connectionMonitor.removeEventListener("sse-message", this.#onSseMessage);
  }

  #onChange = (ev: Event) => {
    const t = ev.target as HTMLSelectElement;
    if (t.id === "from") this.#from = t.value;
    else if (t.id === "to") this.#to = t.value;
    else if (t.id === "via") this.#via = t.value;
    else return;
    this.#renderResult();
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
      this.#graph = (await g.json()) as GraphData;
      this.#instances = new Map(((inst.ok ? await inst.json() : []) as InstanceInfo[]).map((i) => [i.id, i]));
      this.#hostLabels = new Map(((hosts.ok ? await hosts.json() : []) as { id: string; label: string }[]).map((h) => [h.id, h.label]));
      this.#loaded = true;
      this.#renderForm();
      this.#renderResult();
    } catch {
      // Orchestrator kurzzeitig nicht erreichbar — nächster Poll holt es auf.
    }
  }

  /** Optionen neu aufbauen, Auswahl behalten (solange sie noch existiert). */
  #renderForm() {
    const fill = (id: string, current: string, opts: { value: string; label: string }[], empty: string) => {
      const sel = this.querySelector<HTMLSelectElement>(`#${id}`)!;
      const list = [{ value: "", label: empty }, ...opts];
      const sig = list.map((o) => o.value + "|" + o.label).join("\n");
      if (sel.dataset.sig !== sig) {
        sel.innerHTML = list.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("");
        sel.dataset.sig = sig;
      }
      const keep = list.some((o) => o.value === current) ? current : "";
      sel.value = keep;
      return keep;
    };
    this.#from = fill("from", this.#from, senderOptions(this.#graph).map((o) => ({ value: o.id, label: o.label })), t("sp.chooseSource"));
    this.#to = fill("to", this.#to, targetOptions(this.#graph), t("sp.chooseTarget"));
    this.#via = fill("via", this.#via, nodeOptions(this.#graph).map((o) => ({ value: o.id, label: o.label })), t("sp.noVia"));
  }

  #ctx = (nodeId: string): NodeContext => {
    const node = this.#graph.nodes.find((n) => n.id === nodeId);
    const inst = node?.instanceId ? this.#instances.get(node.instanceId) : undefined;
    if (!inst) return {};
    const ctx: NodeContext = {
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
    const issues = diagnosePath(path, this.#ctx);
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
