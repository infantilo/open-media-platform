// Bedienoberfläche des X/Y-Panels (Kapitel 38). Reine Logik: logic.js
// (`globalThis.OmpXyLogic`, davor im selben Bundle). Alles Schalten läuft über
// die Orchestrator-API (`POST /api/v1/graph/edges`), nie am Node vorbei.
//
// i18n (de/en): Sprache aus <html lang> (setzt die Shell), Fallback Deutsch.
const XY_T = (() => {
  const D = {
    de: {
      sources: "Quellen", sinks: "Ziele", home: "Home", up: "Eine Ebene hoch",
      unassigned: "Nicht zugewiesen", all: "Alle", video: "Video", audio: "Audio", data: "Daten",
      search: "Suchen (Name, Node, Tag) …", empty: "Nichts auf dieser Ebene.", offline: "offline",
      take: "Take", disconnect: "Trennen", clear: "Auswahl aufheben", autoTake: "Sofort schalten",
      noSource: "keine Quelle gewählt", noSink: "kein Ziel gewählt", from: "Quelle", to: "Ziel",
      routed: "{from} → {to} geschaltet", disconnected: "{to} getrennt",
      failed: "Schalten fehlgeschlagen: {detail}", incompatible: "Quelle und Ziel passen nicht zusammen (Medientyp).",
      pickSourceFirst: "Erst eine Quelle wählen.", selected: "gewählt", liveFrom: "von {from}", notRouted: "nicht geschaltet",
      bouquets: "Bouquets", tagRouting: "Tag-Schaltung", record: "Bouquet aufzeichnen",
      recording: "Aufzeichnung: {n} Schaltung(en)", saveBouquet: "Speichern", cancel: "Abbrechen", close: "Schließen",
      bouquetName: "Name des Bouquets", noBouquets: "Noch keine Bouquets.", run: "Schalten", delete: "Löschen",
      kindRoutes: "feste Schaltungen", kindTags: "per Tags", routesN: "{n} Schaltungen",
      ranBouquet: "{name}: {n} geschaltet", missingN: "{n} nicht auffindbar/nicht schaltbar: {list}",
      sourceNode: "Quell-Node", sinkNode: "Ziel-Node", fallbackOrder: "Rest nach Reihenfolge verbinden",
      preview: "Vorschau", noPairs: "Keine Paarung gefunden — Tags an Quelle und Ziel prüfen.",
      byTag: "Tag", byOrder: "Reihenfolge", unmatched: "Ohne Partner", saveAsBouquet: "Als Bouquet speichern",
      choose: "— wählen —", saved: "Bouquet gespeichert.", removed: "Bouquet gelöscht.",
      loadError: "Daten konnten nicht geladen werden.", needSelection: "Quell- und Ziel-Node wählen.",
    },
    en: {
      sources: "Sources", sinks: "Destinations", home: "Home", up: "Up one level",
      unassigned: "Unassigned", all: "All", video: "Video", audio: "Audio", data: "Data",
      search: "Search (name, node, tag) …", empty: "Nothing at this level.", offline: "offline",
      take: "Take", disconnect: "Disconnect", clear: "Clear selection", autoTake: "Switch immediately",
      noSource: "no source selected", noSink: "no destination selected", from: "Source", to: "Destination",
      routed: "{from} → {to} routed", disconnected: "{to} disconnected",
      failed: "Routing failed: {detail}", incompatible: "Source and destination do not match (media type).",
      pickSourceFirst: "Select a source first.", selected: "selected", liveFrom: "from {from}", notRouted: "not routed",
      bouquets: "Bouquets", tagRouting: "Tag routing", record: "Record bouquet",
      recording: "Recording: {n} route(s)", saveBouquet: "Save", cancel: "Cancel", close: "Close",
      bouquetName: "Bouquet name", noBouquets: "No bouquets yet.", run: "Route", delete: "Delete",
      kindRoutes: "fixed routes", kindTags: "by tags", routesN: "{n} routes",
      ranBouquet: "{name}: {n} routed", missingN: "{n} not found / not routable: {list}",
      sourceNode: "Source node", sinkNode: "Destination node", fallbackOrder: "Connect the rest in order",
      preview: "Preview", noPairs: "No pairing found — check the tags on source and destination.",
      byTag: "tag", byOrder: "order", unmatched: "Without partner", saveAsBouquet: "Save as bouquet",
      choose: "— choose —", saved: "Bouquet saved.", removed: "Bouquet deleted.",
      loadError: "Data could not be loaded.", needSelection: "Choose source and destination node.",
    },
  };
  const lang = document.documentElement.lang === "en" ? "en" : "de";
  return (k, p) => {
    let s = (D[lang] && D[lang][k]) ?? D.de[k] ?? k;
    if (p) for (const x in p) s = s.split("{" + x + "}").join(p[x]);
    return s;
  };
})();

const XY_CSS = `
:host { display: block; container-type: inline-size; font-family: var(--omp-font, system-ui, sans-serif);
  font-size: var(--omp-font-size-md, 13px); color: var(--omp-text, #eaf0fa); }
* { box-sizing: border-box; }
button { font: inherit; color: inherit; cursor: pointer; background: var(--omp-surface-raised, #172033);
  border: 1px solid var(--omp-border, #223049); border-radius: var(--omp-radius, 6px); padding: 6px 10px; min-height: 36px; }
button:hover:not(:disabled) { border-color: var(--omp-accent-cyan, #19d3f3); }
button:disabled { opacity: .45; cursor: default; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: none; box-shadow: var(--omp-focus-ring, 0 0 0 3px rgba(25,211,243,.2)); }
input[type=search], select { font: inherit; color: inherit; background: var(--omp-bg, #080c16); border: 1px solid var(--omp-border, #223049);
  border-radius: var(--omp-radius, 6px); padding: 6px 8px; min-height: 36px; width: 100%; }
.root { display: flex; flex-direction: column; gap: 8px; min-height: 320px; }
.top { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.top .grp { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.auto { display: flex; gap: 6px; align-items: center; min-height: 36px; }
.tabs { display: none; gap: 8px; }
.tabs button { flex: 1; min-height: 44px; }
.tabs button.on { border-color: var(--omp-accent-cyan, #19d3f3); background: var(--omp-surface, #0f1522); }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; align-items: start; }
.side { background: var(--omp-surface, #0f1522); border: 1px solid var(--omp-border, #223049); border-radius: var(--omp-radius, 6px);
  padding: 8px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.side h3 { margin: 0; font-size: var(--omp-font-size-lg, 15px); }
.nav { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.crumbs { color: var(--omp-text-dim, #93a1ba); font-size: var(--omp-font-size-sm, 12px); overflow-wrap: anywhere; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chips button { min-height: 30px; padding: 3px 9px; font-size: var(--omp-font-size-sm, 12px); }
.chips button.on { border-color: var(--omp-accent-cyan, #19d3f3); }
.list { display: flex; flex-direction: column; gap: 8px; max-height: 56vh; overflow: auto; padding-right: 2px; }
.folders { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.folder { text-align: left; min-height: 52px; display: flex; flex-direction: column; justify-content: center; }
.folder small { color: var(--omp-text-dim, #93a1ba); }
.folder.wf { border-left: 3px solid var(--omp-info, #2f8cff); }
.folder.grp { border-left: 3px solid var(--omp-accent-violet, #a45cff); }
.folder.unassigned { border-left: 3px solid var(--omp-text-disabled, #5f6368); }
.node > summary { cursor: pointer; padding: 4px 2px; color: var(--omp-text-dim, #93a1ba); font-weight: 600; }
.points { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; padding: 4px 0 6px; }
.pt { text-align: left; min-height: 48px; display: flex; flex-direction: column; justify-content: center; overflow: hidden; }
.pt .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pt small { color: var(--omp-text-dim, #93a1ba); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pt.video { border-left: 3px solid var(--omp-info, #2f8cff); }
.pt.audio { border-left: 3px solid var(--omp-preset, #43a047); }
.pt.data { border-left: 3px solid var(--omp-cue, #fb8c00); }
.pt small.from { color: var(--omp-text, #eaf0fa); font-weight: 600; }
.pt.sel { border-color: var(--omp-onair, #e53935); box-shadow: var(--omp-glow-onair, 0 0 6px 1px rgba(229,57,53,.6)); }
.pt.live { background: color-mix(in srgb, var(--omp-preset, #43a047) 16%, var(--omp-surface-raised, #172033)); }
.pt.dim { opacity: .35; }
.pt.off { opacity: .55; border-style: dashed; }
.empty { color: var(--omp-text-dim, #93a1ba); padding: 12px 4px; }
.bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; background: var(--omp-surface, #0f1522);
  border: 1px solid var(--omp-border, #223049); border-radius: var(--omp-radius, 6px); padding: 8px; position: sticky; bottom: 0; }
.bar .txt { flex: 1 1 220px; min-width: 0; overflow-wrap: anywhere; }
.bar .txt b { color: var(--omp-accent-cyan, #19d3f3); }
.bar button.go { border-color: var(--omp-onair, #e53935); min-width: 96px; font-weight: 700; }
.msg { min-height: 18px; font-size: var(--omp-font-size-sm, 12px); }
.msg.err { color: var(--omp-error, #ef5350); }
.rec { border-color: var(--omp-cue, #fb8c00); }
.rec .items { display: flex; flex-direction: column; gap: 4px; width: 100%; font-size: var(--omp-font-size-sm, 12px); }
.rec .row { display: flex; gap: 8px; align-items: center; }
.rec .row span { flex: 1; overflow-wrap: anywhere; }
.rec .row button { min-height: 26px; padding: 0 8px; }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 12px; }
.dlg { background: var(--omp-surface, #0f1522); border: 1px solid var(--omp-border, #223049); border-radius: var(--omp-radius, 6px);
  width: min(640px, 100%); max-height: 90vh; overflow: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.dlg h3 { margin: 0; }
.dlg .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dlg .row > * { flex: 1 1 160px; }
.dlg .row.btn > * { flex: 0 0 auto; }
.pairs { display: flex; flex-direction: column; gap: 4px; font-size: var(--omp-font-size-sm, 12px); }
.pairs div { padding: 4px 6px; border-radius: 4px; background: var(--omp-surface-raised, #172033); overflow-wrap: anywhere; }
.pairs .un { color: var(--omp-cue, #fb8c00); }
.bq { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 6px; border: 1px solid var(--omp-border, #223049); border-radius: 6px; }
.bq .nm { flex: 1 1 160px; }
.bq .nm small { display: block; color: var(--omp-text-dim, #93a1ba); }
@container (max-width: 760px) {
  .tabs { display: flex; }
  .cols { grid-template-columns: 1fr; }
  .side.hide { display: none; }
  .list { max-height: none; }
  button { min-height: 44px; }
  .chips button { min-height: 38px; }
  .points, .folders { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); }
  .pt { min-height: 56px; }
}
`;

function xyEl(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

class OmpXyPanel extends HTMLElement {
  connectedCallback() {
    if (this._started) { this._restart && this._restart(); return; }
    this._started = true;
    const L = globalThis.OmpXyLogic;
    const t = XY_T;
    const shadow = this.attachShadow({ mode: "open" });
    shadow.append(xyEl("style", { text: XY_CSS }));

    // ---- Zustand ----------------------------------------------------------
    const st = {
      sources: [], sinks: [], edges: [], nodes: [], groupTree: { groups: {} }, workflows: [], bouquets: [],
      model: L.buildModel({ nodes: [], groupTree: null, workflows: [] }),
      names: new Map(), // nodeId → Anzeigename ohne Instanz-Kurz-ID
      side: {
        src: { path: [], media: "", query: "" },
        dst: { path: [], media: "", query: "" },
      },
      selSrc: null, selDst: null,
      auto: localStorage.getItem("omp-xy-auto") !== "0",
      tab: "src",
      draft: null, // null = aus, sonst [{from,to}]
      modal: null,
      msg: "", msgErr: false, loaded: false,
    };
    let lastSig = "";

    const bySrc = () => new Map(st.sources.map((p) => [p.id, p]));
    const byDst = () => new Map(st.sinks.map((p) => [p.id, p]));

    // ---- API ----------------------------------------------------------------
    const jget = async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      return r.json();
    };
    const jgetOpt = async (url) => {
      try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; }
    };
    async function connect(from, to) {
      const r = await fetch("/api/v1/graph/edges", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: from.id, to: to.id }),
      });
      if (!r.ok) throw new Error((await r.text()).trim() || String(r.status));
    }
    async function disconnect(to) {
      const r = await fetch(`/api/v1/graph/edges/${encodeURIComponent(to.id)}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.text()).trim() || String(r.status));
    }
    async function loadBouquets() {
      const blob = await jgetOpt(`/api/v1/layouts/${L.BOUQUET_LAYOUT}`);
      return L.parseBouquets(blob);
    }
    async function mutateBouquets(fn) {
      const fresh = await loadBouquets(); // frisch lesen: andere Panels könnten gespeichert haben
      const next = fn(fresh);
      const r = await fetch(`/api/v1/layouts/${L.BOUQUET_LAYOUT}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, bouquets: next }),
      });
      if (!r.ok) throw new Error((await r.text()).trim() || String(r.status));
      st.bouquets = next;
    }

    async function refresh(full) {
      try {
        const [graph, sources, sinks] = await Promise.all([
          jget("/api/v1/graph"), jget("/api/v1/sources"), jget("/api/v1/sinks"),
        ]);
        let slow = null;
        if (full || !st.loaded) {
          const [layout, workflows, bouquets] = await Promise.all([
            jgetOpt("/api/v1/layouts/default"), jgetOpt("/api/v1/workflows"), loadBouquets(),
          ]);
          slow = { layout, workflows, bouquets };
        }
        const sig = JSON.stringify([graph, sources, sinks, slow]);
        if (sig === lastSig && st.loaded) return;
        lastSig = sig;
        st.nodes = graph.nodes || [];
        st.edges = graph.edges || [];
        st.sources = L.normSources(sources);
        st.sinks = L.normSinks(sinks);
        st.names = L.nodeNames([...st.sources, ...st.sinks]);
        if (slow) {
          st.groupTree = (slow.layout && slow.layout.groups) || { groups: {} };
          st.workflows = Array.isArray(slow.workflows) ? slow.workflows : [];
          st.bouquets = slow.bouquets;
        }
        st.model = L.buildModel({ nodes: st.nodes, groupTree: st.groupTree, workflows: st.workflows });
        // Auswahl verwerfen, wenn der Punkt verschwunden ist; Pfade auf gültige Ordner kürzen.
        if (st.selSrc && !bySrc().has(st.selSrc)) st.selSrc = null;
        if (st.selDst && !byDst().has(st.selDst)) st.selDst = null;
        for (const s of [st.side.src, st.side.dst]) {
          const ok = s.path.findIndex((f) => !st.model.folders.has(f));
          if (ok >= 0) s.path = s.path.slice(0, ok);
        }
        st.loaded = true;
        if (st.msg === t("loadError")) setMsg("");
        render();
      } catch (e) {
        if (!st.loaded) setMsg(t("loadError"), true);
      }
    }

    // ---- Aktionen ---------------------------------------------------------------
    function setMsg(text, err) {
      st.msg = text; st.msgErr = !!err;
      const m = shadow.getElementById("msg");
      if (m) { m.textContent = text; m.className = "msg" + (err ? " err" : ""); }
    }
    const nodeName = (p) => st.names.get(p.nodeId) ?? L.stripInstanceId(p.nodeLabel);
    const pointName = (p) => L.fullName(p, nodeName(p));

    async function doTake(from, to) {
      if (!L.compatible(from, to)) { setMsg(t("incompatible"), true); return; }
      if (st.draft) {
        if (!st.draft.some((d) => d.from.id === from.id && d.to.id === to.id)) st.draft.push({ from, to });
        st.selDst = null; render(); return;
      }
      try {
        await connect(from, to);
        setMsg(t("routed", { from: pointName(from), to: pointName(to) }));
        st.selDst = null;
        await refresh(false);
      } catch (e) { setMsg(t("failed", { detail: e.message }), true); }
    }
    async function doDisconnect(to) {
      try {
        await disconnect(to);
        setMsg(t("disconnected", { to: pointName(to) }));
        st.selDst = null;
        await refresh(false);
      } catch (e) { setMsg(t("failed", { detail: e.message }), true); }
    }
    /** Mehrere Schaltungen nacheinander; Fehler einzeln sammeln statt abzubrechen. */
    async function runRoutes(routes) {
      let ok = 0; const bad = [];
      for (const r of routes) {
        try { await connect(r.from, r.to); ok++; } catch (e) { bad.push(`${pointName(r.to)} (${e.message})`); }
      }
      await refresh(false);
      return { ok, bad };
    }

    function pick(kind, p) {
      if (kind === "src") {
        st.selSrc = st.selSrc === p.id ? null : p.id;
        if (st.selSrc) {
          const dst = byDst().get(st.selDst);
          if (dst && st.auto) { doTake(p, dst); return; }
          st.tab = "dst"; // Mobil: nach der Quellwahl gleich zu den Zielen
        }
      } else {
        st.selDst = st.selDst === p.id ? null : p.id;
        const src = bySrc().get(st.selSrc);
        if (st.selDst && src && st.auto) { doTake(src, p); return; }
        if (st.selDst && !src) setMsg(t("pickSourceFirst"));
      }
      render();
    }

    // ---- Rendering ------------------------------------------------------------------
    const root = xyEl("div", { class: "root" });
    shadow.append(root);

    function renderPoint(kind, p, routeOfSink, srcMap) {
      const sel = kind === "src" ? st.selSrc === p.id : st.selDst === p.id;
      const selSrcPt = bySrc().get(st.selSrc);
      let dim = false;
      if (kind === "dst" && selSrcPt) dim = !L.compatible(selSrcPt, p);
      let sub = nodeName(p);
      let live = false;
      let subTitle = "";
      if (kind === "dst") {
        const from = routeOfSink.get(p.id);
        if (from) {
          const s = srcMap.get(from);
          sub = "◄ " + (s ? pointName(s) : from.slice(0, 8));
          subTitle = t("liveFrom", { from: s ? pointName(s) : from });
          live = true;
        } else sub = t("notRouted");
      } else if (st.selDst) {
        const d = byDst().get(st.selDst);
        dim = !L.compatible(p, d);
      }
      return xyEl("button", {
        class: ["pt", p.mediaType, sel ? "sel" : "", live ? "live" : "", dim ? "dim" : "", p.online ? "" : "off"].filter(Boolean).join(" "),
        title: `${pointName(p)}${subTitle ? "\n" + subTitle : ""}${p.tags.length ? "\n" + p.tags.join(", ") : ""}${p.online ? "" : "\n" + t("offline")}`,
        "aria-pressed": sel ? "true" : "false",
        onclick: () => pick(kind, p),
      }, xyEl("span", { class: "n", text: L.shortLabel(p, nodeName(p)) }), xyEl("small", { class: live ? "from" : "", text: sub }));
    }

    function renderSide(kind) {
      const s = st.side[kind];
      const all = kind === "src" ? st.sources : st.sinks;
      const filtered = L.filterPoints(all, { media: s.media, query: "" });
      const lvl = L.levelContents(st.model, s.path, L.groupPointsByNode(filtered)); // Brotkrumen
      const routeOfSink = L.routeMap(st.edges);
      const srcMap = bySrc();
      const title = kind === "src" ? t("sources") : t("sinks");

      const crumbText = [t("home"), ...lvl.crumbs.map((c) => L.folderLabel({ kind: c.kind, label: c.label }, t))].join(" › ");
      const nav = xyEl("div", { class: "nav" },
        xyEl("button", { "aria-label": t("home"), title: t("home"), disabled: s.path.length === 0, onclick: () => { s.path = []; render(); } }, "⌂"),
        xyEl("button", { "aria-label": t("up"), title: t("up"), disabled: s.path.length === 0, onclick: () => { s.path = s.path.slice(0, -1); render(); } }, "↑"),
        xyEl("span", { class: "crumbs", text: crumbText }));

      const chips = xyEl("div", { class: "chips" },
        ...[["", "all"], ["video", "video"], ["audio", "audio"], ["data", "data"]].map(([m, key]) =>
          xyEl("button", { class: s.media === m ? "on" : "", onclick: () => { s.media = m; render(); } }, t(key))));

      const search = xyEl("input", { type: "search", placeholder: t("search"), value: s.query, "aria-label": t("search"), "data-side": kind });
      search.value = s.query;
      search.addEventListener("input", () => { s.query = search.value; renderList(); });

      const listHost = xyEl("div", { class: "list" });
      const renderList = () => {
        const f2 = L.filterPoints(all, { media: s.media, query: s.query });
        const l2 = L.levelContents(st.model, s.path, L.groupPointsByNode(f2));
        listHost.replaceChildren();
        if (l2.folders.length) {
          listHost.append(xyEl("div", { class: "folders" }, l2.folders.map((f) =>
            xyEl("button", { class: "folder " + (f.kind === "workflow" ? "wf" : f.kind === "group" ? "grp" : "unassigned"), onclick: () => { s.path = [...s.path, f.id]; render(); } },
              xyEl("span", { text: L.folderLabel(f, t) }), xyEl("small", { text: String(f.count) })))));
        }
        for (const n of l2.nodes) {
          const det = xyEl("details", { class: "node", open: n.points.length <= 8 || s.query.trim() ? true : null },
            xyEl("summary", { text: `${st.names.get(n.id) ?? L.stripInstanceId(n.label)} (${n.points.length})` }),
            xyEl("div", { class: "points" }, n.points.map((p) => renderPoint(kind, p, routeOfSink, srcMap))));
          listHost.append(det);
        }
        if (!l2.folders.length && !l2.nodes.length) listHost.append(xyEl("div", { class: "empty", text: t("empty") }));
      };
      renderList();
      return xyEl("section", { class: "side" + (st.tab === kind ? "" : " hide") }, xyEl("h3", { text: title }), nav, chips, search, listHost);
    }

    function renderBar() {
      const src = bySrc().get(st.selSrc);
      const dst = byDst().get(st.selDst);
      const connected = dst && L.routeMap(st.edges).has(dst.id);
      const txt = xyEl("div", { class: "txt" },
        xyEl("span", {}, t("from") + ": "), src ? xyEl("b", { text: pointName(src) }) : xyEl("i", { text: t("noSource") }),
        "  →  ",
        xyEl("span", {}, t("to") + ": "), dst ? xyEl("b", { text: pointName(dst) }) : xyEl("i", { text: t("noSink") }));
      return xyEl("div", { class: "bar" }, txt,
        xyEl("button", { class: "go", disabled: !(src && dst), onclick: () => doTake(src, dst) }, t("take")),
        xyEl("button", { disabled: !connected, onclick: () => doDisconnect(dst) }, t("disconnect")),
        xyEl("button", { disabled: !(src || dst), onclick: () => { st.selSrc = null; st.selDst = null; render(); }, title: t("clear") }, "✕"));
    }

    function renderDraft() {
      if (!st.draft) return null;
      const name = xyEl("input", { type: "search", placeholder: t("bouquetName"), "aria-label": t("bouquetName") });
      return xyEl("div", { class: "bar rec" },
        xyEl("div", { class: "txt" }, t("recording", { n: st.draft.length })),
        xyEl("div", { class: "items" }, st.draft.map((d, i) =>
          xyEl("div", { class: "row" }, xyEl("span", { text: `${pointName(d.from)} → ${pointName(d.to)}` }),
            xyEl("button", { "aria-label": t("delete"), onclick: () => { st.draft.splice(i, 1); render(); } }, "✕")))),
        name,
        xyEl("button", { disabled: !st.draft.length, onclick: async () => {
          const nm = name.value.trim();
          if (!nm) { name.focus(); return; }
          try {
            const b = L.routesBouquet(nm, st.draft);
            await mutateBouquets((list) => [...list, b]);
            st.draft = null; setMsg(t("saved")); render();
          } catch (e) { setMsg(t("failed", { detail: e.message }), true); }
        } }, t("saveBouquet")),
        xyEl("button", { onclick: () => { st.draft = null; render(); } }, t("cancel")));
    }

    function nodeOptions(points, selected) {
      const seen = new Map();
      for (const p of points) if (!seen.has(p.nodeId)) seen.set(p.nodeId, st.names.get(p.nodeId) ?? L.stripInstanceId(p.nodeLabel));
      const sel = xyEl("select", {}, xyEl("option", { value: "", text: t("choose") }),
        [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([id, label]) => xyEl("option", { value: id, text: label })));
      sel.value = selected || "";
      return sel;
    }

    function openTagDialog() {
      const srcPt = bySrc().get(st.selSrc);
      const dstPt = byDst().get(st.selDst);
      const d = { src: srcPt ? srcPt.nodeId : "", dst: dstPt ? dstPt.nodeId : "", fallback: false };
      st.modal = () => {
        const sSel = nodeOptions(st.sources, d.src);
        const kSel = nodeOptions(st.sinks, d.dst);
        const fb = xyEl("input", { type: "checkbox" }); fb.checked = d.fallback;
        const sNode = st.sources.find((p) => p.nodeId === d.src);
        const kNode = st.sinks.find((p) => p.nodeId === d.dst);
        let plan = null;
        if (sNode && kNode) {
          plan = L.planTagRoutes(st.sources.filter((p) => p.nodeId === d.src), st.sinks.filter((p) => p.nodeId === d.dst), { fallbackOrder: d.fallback });
        }
        const nm = xyEl("input", { type: "search", placeholder: t("bouquetName"), "aria-label": t("bouquetName") });
        const rerender = () => { st.modal && showModal(); };
        sSel.addEventListener("change", () => { d.src = sSel.value; rerender(); });
        kSel.addEventListener("change", () => { d.dst = kSel.value; rerender(); });
        fb.addEventListener("change", () => { d.fallback = fb.checked; rerender(); });
        const pairs = xyEl("div", { class: "pairs" });
        if (!plan) pairs.append(xyEl("div", { text: t("needSelection") }));
        else {
          if (!plan.routes.length) pairs.append(xyEl("div", { text: t("noPairs") }));
          for (const r of plan.routes) {
            pairs.append(xyEl("div", { text: `${r.from.label} → ${r.to.label}  (${r.reason === "tag" ? t("byTag") + ": " + r.tags.join(", ") : t("byOrder")})` }));
          }
          for (const u of plan.unmatched) pairs.append(xyEl("div", { class: "un", text: `${t("unmatched")}: ${u.label}` }));
        }
        return xyEl("div", { class: "dlg", role: "dialog", "aria-label": t("tagRouting") },
          xyEl("h3", { text: t("tagRouting") }),
          xyEl("div", { class: "row" }, xyEl("label", {}, t("sourceNode"), sSel), xyEl("label", {}, t("sinkNode"), kSel)),
          xyEl("label", { class: "auto" }, fb, t("fallbackOrder")),
          xyEl("div", {}, xyEl("b", { text: t("preview") }), pairs),
          xyEl("div", { class: "row" }, nm),
          xyEl("div", { class: "row btn" },
            xyEl("button", { class: "go", disabled: !(plan && plan.routes.length), onclick: async () => {
              const res = await runRoutes(plan.routes);
              st.modal = null; showModal();
              setMsg(res.bad.length ? t("failed", { detail: res.bad.join("; ") }) : t("ranBouquet", { name: t("tagRouting"), n: res.ok }), res.bad.length > 0);
            } }, t("run")),
            xyEl("button", { disabled: !(sNode && kNode), onclick: async () => {
              const name = nm.value.trim();
              if (!name) { nm.focus(); return; }
              try {
                const b = L.tagsBouquet(name, { id: d.src, label: sNode.nodeLabel }, { id: d.dst, label: kNode.nodeLabel }, d.fallback);
                await mutateBouquets((list) => [...list, b]);
                st.modal = null; showModal(); setMsg(t("saved"));
              } catch (e) { setMsg(t("failed", { detail: e.message }), true); }
            } }, t("saveAsBouquet")),
            xyEl("button", { onclick: () => { st.modal = null; showModal(); } }, t("close"))));
      };
      showModal();
    }

    function openBouquetDialog() {
      st.modal = () => {
        const list = xyEl("div", { class: "pairs" });
        if (!st.bouquets.length) list.append(xyEl("div", { text: t("noBouquets") }));
        for (const b of st.bouquets) {
          const detail = b.kind === "routes" ? `${t("kindRoutes")} · ${t("routesN", { n: (b.routes || []).length })}` : `${t("kindTags")} · ${b.source.nodeLabel} → ${b.sink.nodeLabel}`;
          list.append(xyEl("div", { class: "bq" },
            xyEl("div", { class: "nm" }, b.name, xyEl("small", { text: detail })),
            xyEl("button", { class: "go", onclick: async () => {
              const res = L.resolveBouquet(b, st.sources, st.sinks);
              const done = await runRoutes(res.routes);
              const miss = [...res.missing, ...done.bad];
              st.modal = null; showModal();
              setMsg(t("ranBouquet", { name: b.name, n: done.ok }) + (miss.length ? " — " + t("missingN", { n: miss.length, list: miss.join(", ") }) : ""), miss.length > 0);
            } }, t("run")),
            xyEl("button", { onclick: async () => {
              try { await mutateBouquets((l) => l.filter((x) => x.id !== b.id)); setMsg(t("removed")); showModal(); }
              catch (e) { setMsg(t("failed", { detail: e.message }), true); }
            } }, t("delete"))));
        }
        return xyEl("div", { class: "dlg", role: "dialog", "aria-label": t("bouquets") },
          xyEl("h3", { text: t("bouquets") }), list,
          xyEl("div", { class: "row btn" },
            xyEl("button", { onclick: () => { st.draft = []; st.modal = null; showModal(); render(); } }, t("record")),
            xyEl("button", { onclick: () => { st.modal = null; showModal(); } }, t("close"))));
      };
      showModal();
    }

    let modalHost = null;
    function showModal() {
      if (modalHost) { modalHost.remove(); modalHost = null; }
      if (!st.modal) return;
      modalHost = xyEl("div", { class: "modal", onclick: (e) => { if (e.target === modalHost) { st.modal = null; showModal(); } } }, st.modal());
      shadow.append(modalHost);
    }

    function render() {
      const active = shadow.activeElement;
      const keepFocus = active && active.tagName === "INPUT" && active.getAttribute("data-side") ? active.getAttribute("data-side") : null;
      const caret = keepFocus ? active.selectionStart : 0;
      const tabs = xyEl("div", { class: "tabs" },
        xyEl("button", { class: st.tab === "src" ? "on" : "", onclick: () => { st.tab = "src"; render(); } }, `${t("sources")}${st.selSrc ? " ✓" : ""}`),
        xyEl("button", { class: st.tab === "dst" ? "on" : "", onclick: () => { st.tab = "dst"; render(); } }, `${t("sinks")}${st.selDst ? " ✓" : ""}`));
      const auto = xyEl("label", { class: "auto" }, xyEl("input", { type: "checkbox", onchange: (e) => {
        st.auto = e.target.checked; localStorage.setItem("omp-xy-auto", st.auto ? "1" : "0");
      } }), t("autoTake"));
      auto.firstChild.checked = st.auto;
      const top = xyEl("div", { class: "top" },
        xyEl("div", { class: "grp" }, xyEl("button", { onclick: openBouquetDialog }, "▦ " + t("bouquets")), xyEl("button", { onclick: openTagDialog }, "# " + t("tagRouting"))),
        auto);
      const msg = xyEl("div", { id: "msg", class: "msg" + (st.msgErr ? " err" : ""), role: "status", "aria-live": "polite", text: st.msg });
      root.replaceChildren(top, tabs, xyEl("div", { class: "cols" }, renderSide("src"), renderSide("dst")), ...(st.draft ? [renderDraft()] : []), renderBar(), msg);
      if (keepFocus) {
        const inp = shadow.querySelector(`input[data-side="${keepFocus}"]`);
        if (inp) { inp.focus(); try { inp.setSelectionRange(caret, caret); } catch { /* egal */ } }
      }
    }

    render();
    this._restart = () => {
      clearInterval(this._poll);
      clearInterval(this._slow);
      this._poll = setInterval(() => refresh(false), 2000);
      this._slow = setInterval(() => refresh(true), 15000);
      refresh(true);
    };
    this._restart();
  }

  disconnectedCallback() {
    clearInterval(this._poll);
    clearInterval(this._slow);
  }
}

if (!customElements.get("omp-xy-panel")) {
  customElements.define("omp-xy-panel", OmpXyPanel);
}
