// Node-Diagnose an der Kachel (UMSETZUNG.md Kap. 72.7): „Was ist mit diesem Node los?“ in einem Fenster — Ampel mit „Was tun?“,
// Prozess und Medien, die Pipeline als Bild (wo stockt der Fluss?), Ereignisse und Meldungen dieses einen Nodes.
import { apiFetch } from "../shell/connection.ts";
import { freezeNow } from "../shell/freeze.ts";
import { codeBadge, type ErrorCode, helpDetails, loadErrorCodes, lookup } from "../shell/errorcodes.ts";
import { t } from "../shell/i18n.ts";
import { describeItem, type TLItem } from "../shell/timeline-logic.ts";
import { boxLevel, formatBytes, layoutPipeline, type NdCheck, type NdLevel, type NdPipeline, splitFindings } from "./node-diagnose-logic.ts";

interface Diagnosis {
  level: NdLevel;
  summary: string;
  node: { id: string; label: string; known: boolean; online: boolean; type?: string; hostId?: string; version?: string };
  instance?: { id: string; pid: number; restartCount?: number; cpuPercent?: number; rssBytes?: number; hostId?: string };
  process?: { Threads: number; OpenFDs: number; FDLimit: number; RSSBytes: number };
  media?: { Ready: boolean; EverReady: boolean; VideoFPS?: { Last: number; Avg: number } };
  findings: NdCheck[];
  timeline: TLItem[];
  logs: { occurredAt: string; level: string; message: string }[];
  pipelines?: { pipelines: NdPipeline[] };
  pipelinesNote?: string;
}

const COLOR: Record<NdLevel, string> = { err: "var(--omp-error,#e05252)", warn: "#e0a020", ok: "var(--omp-ok,#3fb950)" };
const DIM = "color:var(--omp-text-dim,#9aa0a6);";
const REFRESH_MS = 8000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const tryT = (key: string): string | undefined => {
  const v = t(key as never);
  return v === key ? undefined : v;
};
const none = { node: () => undefined, workflow: () => undefined, process: () => undefined, instance: () => undefined, group: () => undefined };

function section(title: string): { box: HTMLElement; body: HTMLElement } {
  const box = el("div", "margin:0 0 14px;");
  box.append(el("div", "font-weight:600;margin-bottom:6px;", title));
  const body = el("div");
  box.append(body);
  return { box, body };
}

function drawPipeline(p: NdPipeline): HTMLElement {
  const wrap = el("div", "margin-bottom:12px;");
  const l = layoutPipeline(p);
  const head = el("div", "margin-bottom:4px;");
  head.append(el("strong", "", p.name), el("span", `margin-left:8px;color:${p.state === "Playing" ? COLOR.ok : COLOR.warn};`, p.state));
  wrap.append(head);
  if (p.error) {
    wrap.append(el("div", `color:${COLOR.err};`, p.error));
    return wrap;
  }
  if (l.boxes.length === 0) {
    wrap.append(el("div", DIM, t("nd.pipeline.empty")));
    return wrap;
  }
  const W = 150, H = 46, GX = 46, GY = 14;
  const svg = svgEl("svg", { width: l.ranks * (W + GX) - GX + 4, height: l.rows * (H + GY) - GY + 4, role: "img" });
  svg.setAttribute("aria-label", p.name);
  const pos = new Map(l.boxes.map((b) => [b.name, { x: 2 + b.rank * (W + GX), y: 2 + b.row * (H + GY) }]));
  for (const e of l.edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const line = svgEl("path", { d: `M${a.x + W},${a.y + H / 2} C${a.x + W + GX / 2},${a.y + H / 2} ${b.x - GX / 2},${b.y + H / 2} ${b.x},${b.y + H / 2}`, fill: "none", stroke: "#8a9099", "stroke-width": 1.5 });
    if (e.caps) {
      const title = svgEl("title");
      title.textContent = e.caps;
      line.append(title);
    }
    svg.append(line);
  }
  for (const b of l.boxes) {
    const at = pos.get(b.name)!;
    const lv = boxLevel(b, p.state);
    const g = svgEl("g", { transform: `translate(${at.x},${at.y})` });
    g.append(svgEl("rect", { width: W, height: H, rx: 6, fill: "#2a2f35", stroke: COLOR[lv], "stroke-width": lv === "ok" ? 1 : 2.5 }));
    const name = svgEl("text", { x: 8, y: 17, fill: "#e8eaed", "font-size": 12, "font-weight": 600 });
    name.textContent = b.name.length > 20 ? b.name.slice(0, 19) + "…" : b.name;
    const sub = svgEl("text", { x: 8, y: 32, fill: "#9aa0a6", "font-size": 10.5 });
    sub.textContent = `${b.factory}${b.children ? ` · ${t("nd.pipeline.inside", { n: b.children })}` : ""} · ${b.state}`;
    g.append(name, sub);
    if (b.fill !== null) {
      g.append(svgEl("rect", { x: 8, y: H - 8, width: W - 16, height: 4, fill: "#454b53", rx: 2 }));
      g.append(svgEl("rect", { x: 8, y: H - 8, width: Math.max(2, (W - 16) * b.fill), height: 4, fill: b.fill >= 1 ? COLOR.warn : "#19d3f3", rx: 2 }));
    }
    const title = svgEl("title");
    title.textContent = `${b.name} (${b.factory}) — ${b.state}${b.fill !== null ? ` — ${t("nd.pipeline.fill", { p: Math.round(b.fill * 100) })}` : ""}`;
    g.append(title);
    svg.append(g);
  }
  const scroll = el("div", "overflow-x:auto;padding:4px 0;");
  scroll.setAttribute("data-pipe", p.name);
  scroll.append(svg);
  wrap.append(scroll);
  return wrap;
}

/** Öffnet die Diagnose zu einem Node (NMOS-Node-ID). Ein zweiter Aufruf ersetzt das offene Fenster. */
export function openNodeDiagnosis(nodeId: string, label: string): void {
  document.querySelector('[data-role="node-diagnosis"]')?.remove();
  const root = el("div", "position:fixed;inset:0;z-index:3000;display:flex;align-items:center;justify-content:center;font-family:var(--omp-font,system-ui,sans-serif);font-size:var(--omp-font-size-sm,12px);");
  root.setAttribute("data-role", "node-diagnosis");
  const backdrop = el("div", "position:absolute;inset:0;background:rgba(0,0,0,.5);");
  const dlg = el("div", "position:relative;display:flex;flex-direction:column;max-height:90vh;width:min(96vw,860px);background:var(--omp-surface,#24272b);color:var(--omp-text,#e8eaed);border:1px solid var(--omp-border,#3a3f45);border-radius:var(--omp-radius,6px);box-shadow:0 4px 16px rgba(0,0,0,.4);");
  dlg.setAttribute("role", "dialog");
  dlg.setAttribute("aria-modal", "true");

  const head = el("div", "display:flex;gap:12px;align-items:center;padding:14px 16px 8px;");
  const lamp = el("div", "width:34px;height:34px;border-radius:50%;flex:none;background:var(--omp-text-dim,#888);");
  const titles = el("div", "flex:1;min-width:0;");
  const title = el("div", "font-size:15px;font-weight:600;", t("nd.title", { node: label }));
  const summary = el("div", DIM, t("nd.loading"));
  titles.append(title, summary);
  const again = el("button", "", t("nd.refresh"));
  again.className = "omp-btn";
  const close = el("button", "", t("nd.close"));
  close.className = "omp-btn";
  const freezeBtn = el("button", "", t("fr.node"));
  freezeBtn.className = "omp-btn";
  freezeBtn.title = t("fr.node.title");
  freezeBtn.addEventListener("click", async () => {
    freezeBtn.disabled = true;
    await freezeNow(10, "", [nodeId]);
    window.setTimeout(() => (freezeBtn.disabled = false), 3000);
  });
  head.append(lamp, titles, freezeBtn, again, close);
  const body = el("div", "padding:8px 16px 16px;overflow:auto;");
  dlg.append(head, body);
  root.append(backdrop, dlg);
  document.body.append(root);

  let timer: number | undefined;
  let seq = 0;
  let lastKey = "";
  let codes: ErrorCode[] = [];
  let lastDiagnosis: Diagnosis | null = null;
  void loadErrorCodes().then((c) => {
    codes = c;
    if (lastDiagnosis && root.isConnected) render(lastDiagnosis);
  });
  const shut = () => {
    window.clearInterval(timer);
    document.removeEventListener("keydown", onKey);
    root.remove();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") shut();
  };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", shut);
  close.addEventListener("click", shut);

  const render = (d: Diagnosis) => {
    lastDiagnosis = d;
    lamp.style.background = COLOR[d.level];
    summary.textContent = d.summary;
    title.textContent = t("nd.title", { node: d.node.label || label });
    // Ansicht merken: ein Neuaufbau darf weder die Scrollstellung (Pipeline waagerecht, Fenster senkrecht) noch aufgeklappte
    // Bereiche zurücksetzen.
    const top = body.scrollTop;
    const pipeScroll = new Map<string, number>();
    for (const e of body.querySelectorAll<HTMLElement>("[data-pipe]")) pipeScroll.set(e.dataset.pipe ?? "", e.scrollLeft);
    const opened = new Set<string>();
    for (const e of body.querySelectorAll<HTMLDetailsElement>("details[data-keep]")) if (e.open) opened.add(e.dataset.keep ?? "");
    body.replaceChildren();
    queueMicrotask(() => {
      for (const e of body.querySelectorAll<HTMLElement>("[data-pipe]")) e.scrollLeft = pipeScroll.get(e.dataset.pipe ?? "") ?? 0;
      for (const e of body.querySelectorAll<HTMLDetailsElement>("details[data-keep]")) e.open = opened.has(e.dataset.keep ?? "");
      body.scrollTop = top;
    });
    const meta = [d.node.type, d.node.version, d.instance?.hostId ? t("nd.remoteHost") : t("nd.localHost")].filter(Boolean).join(" · ");
    if (meta) body.append(el("div", DIM + "margin-bottom:10px;", meta));

    // Befunde
    const { problems, fine } = splitFindings(d.findings);
    const f = section(t("nd.findings"));
    if (problems.length === 0) f.body.append(el("div", DIM, t("nd.findings.none")));
    for (const c of problems) {
      const card = el("div", `border:1px solid var(--omp-border,#3a3f45);border-left:4px solid ${COLOR[c.level]};border-radius:6px;padding:8px 10px;margin-bottom:6px;background:var(--omp-surface-raised,#2f3339);`);
      const code = lookup(codes, c.code);
      const titleRow = el("div", "display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;");
      if (code) titleRow.append(codeBadge(code));
      titleRow.append(el("span", "font-weight:600;", c.title));
      card.append(titleRow);
      if (c.detail) card.append(el("div", DIM + "margin-top:2px;word-break:break-word;", c.detail));
      if (c.fix) {
        const fix = el("div", "margin-top:5px;");
        fix.append(el("strong", "", t("nd.whatToDo") + " "), document.createTextNode(c.fix));
        card.append(fix);
      }
      if (code) card.append(helpDetails(code));
      f.body.append(card);
    }
    if (fine.length > 0) {
      const det = el("details", "margin-top:4px;");
      det.setAttribute("data-keep", "fine");
      det.append(el("summary", "cursor:pointer;" + DIM, t("nd.fine", { n: fine.length })));
      for (const c of fine) det.append(el("div", "margin-top:3px;", `✔ ${c.title}${c.detail ? ` — ${c.detail}` : ""}`));
      f.body.append(det);
    }
    body.append(f.box);

    // Prozess und Medien
    const facts: [string, string][] = [];
    if (d.instance) {
      facts.push([t("nd.f.restarts"), String(d.instance.restartCount ?? 0)]);
      if (d.instance.cpuPercent !== undefined) facts.push([t("nd.f.cpu"), `${d.instance.cpuPercent.toFixed(0)} %`]);
      if (d.instance.rssBytes !== undefined) facts.push([t("nd.f.ram"), formatBytes(d.instance.rssBytes)]);
    }
    if (d.process) {
      facts.push([t("nd.f.threads"), String(d.process.Threads)], [t("nd.f.files"), `${d.process.OpenFDs}${d.process.FDLimit ? ` / ${d.process.FDLimit}` : ""}`]);
      if (!d.instance?.rssBytes) facts.push([t("nd.f.ram"), formatBytes(d.process.RSSBytes)]);
    }
    if (d.media) {
      facts.push([t("nd.f.media"), d.media.Ready ? t("nd.f.ready") : t("nd.f.notReady")]);
      if (d.media.VideoFPS) facts.push([t("nd.f.fps"), `${d.media.VideoFPS.Last.toFixed(1)} (Ø ${d.media.VideoFPS.Avg.toFixed(1)})`]);
    }
    if (facts.length > 0) {
      const s = section(t("nd.facts"));
      const grid = el("div", "display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;");
      for (const [k, v] of facts) {
        const cell = el("div", "border:1px solid var(--omp-border,#3a3f45);border-radius:6px;padding:6px 8px;");
        cell.append(el("div", DIM + "font-size:11px;", k), el("div", "font-weight:600;", v));
        grid.append(cell);
      }
      s.body.append(grid);
      body.append(s.box);
    }

    // Pipeline
    const pl = section(t("nd.pipeline"));
    const pipes = d.pipelines?.pipelines ?? [];
    if (pipes.length > 0) {
      pl.body.append(el("div", DIM + "margin-bottom:6px;", t("nd.pipeline.hint")));
      for (const p of pipes) pl.body.append(drawPipeline(p));
    } else {
      pl.body.append(el("div", DIM, tryT(`nd.pipeline.note.${d.pipelinesNote ?? "unavailable"}`) ?? t("nd.pipeline.note.unavailable")));
    }
    body.append(pl.box);

    // Ereignisse
    const ev = section(t("nd.events"));
    if (d.timeline.length === 0) ev.body.append(el("div", DIM, t("nd.events.none")));
    for (const i of d.timeline.slice(0, 20)) {
      const x = describeItem(i, none, tryT, (k, p) => t(k as never, p));
      const row = el("div", "display:flex;gap:8px;align-items:baseline;padding:2px 0;");
      row.append(el("span", DIM + "min-width:64px;", clock(i.at)), el("span", "min-width:16px;", x.icon), el("span", "flex:1;word-break:break-word;", x.text ?? (x.key ? t(x.key as never, x.params) : i.kind)));
      ev.body.append(row);
    }
    body.append(ev.box);

    // Meldungen
    const lg = section(t("nd.logs"));
    if (d.logs.length === 0) lg.body.append(el("div", DIM, t("nd.logs.none")));
    for (const e of d.logs.slice(0, 25)) {
      const row = el("div", "display:flex;gap:8px;align-items:baseline;padding:2px 0;");
      row.append(el("span", DIM + "min-width:64px;", clock(e.occurredAt)), el("span", `min-width:44px;color:${e.level === "error" ? COLOR.err : COLOR.warn};`, e.level), el("span", "flex:1;word-break:break-word;", e.message));
      lg.body.append(row);
    }
    body.append(lg.box);
    body.append(el("div", DIM + "font-size:11px;", t("nd.footer")));
  };

  const load = async () => {
    const mine = ++seq;
    try {
      const res = await apiFetch(`/api/v1/nodes/${encodeURIComponent(nodeId)}/diagnosis`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as Diagnosis & { generatedAt?: string };
      if (mine !== seq || !root.isConnected) return;
      // Nur neu zeichnen, wenn sich etwas geändert hat (der Zeitstempel zählt nicht): kein Flackern, nichts springt.
      const { generatedAt: _ignored, ...rest } = d;
      const key = JSON.stringify(rest);
      if (key === lastKey) return;
      lastKey = key;
      render(d);
    } catch (e) {
      if (mine !== seq || !root.isConnected) return;
      lamp.style.background = "var(--omp-text-dim,#888)";
      summary.textContent = t("nd.failed", { error: String((e as Error).message ?? e) });
    }
  };
  again.addEventListener("click", () => void load());
  void load();
  timer = window.setInterval(() => void load(), REFRESH_MS);
}
