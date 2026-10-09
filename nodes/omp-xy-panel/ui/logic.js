// Reine Logik des X/Y-Panels (Kapitel 38): Navigationsbaum aus Workflows,
// Gruppen und nicht zugewiesenen Nodes, Kompatibilität, tag-basierte Paarung,
// Bouquets. Kein DOM, kein fetch — wird in `uibundle.rs` vor `panel.js` in das
// Bundle gehängt und von `ui/xy-panel_test.ts` per `deno test` geprüft.
(() => {
  const ROOT = "";

  /** Quelle/Senke → einheitlicher Punkt. `kind` unterscheidet die Seite. */
  function normSources(list) {
    return (list || []).map((s) => ({
      kind: "source",
      id: s.senderId,
      label: s.label || s.senderId,
      nodeId: s.nodeId,
      nodeLabel: s.nodeLabel || s.nodeId,
      mediaType: s.mediaType || "",
      tags: (s.tags || []).map((t) => t.tag),
      online: s.online !== false,
    }));
  }
  function normSinks(list) {
    return (list || []).map((s) => ({
      kind: "sink",
      id: s.receiverId,
      label: s.label || s.receiverId,
      nodeId: s.nodeId,
      nodeLabel: s.nodeLabel || s.nodeId,
      mediaType: s.mediaType || "",
      tags: (s.tags || []).map((t) => t.tag),
      online: s.online !== false,
    }));
  }

  function groupPointsByNode(points) {
    const m = new Map();
    for (const p of points) {
      if (!m.has(p.nodeId)) m.set(p.nodeId, []);
      m.get(p.nodeId).push(p);
    }
    return m;
  }

  /** Alle Node-IDs unterhalb einer Gruppe (rekursiv, zyklensicher). */
  function flattenGroup(groups, groupId, seen = new Set()) {
    const g = groups[groupId];
    if (!g || seen.has(groupId)) return [];
    seen.add(groupId);
    const out = [...(g.nodeIds || [])];
    for (const c of g.groupIds || []) out.push(...flattenGroup(groups, c, seen));
    return out;
  }

  /**
   * Baut den Ordnerbaum. Ordner-IDs: `wf:<id>`, `grp:<id>`, `unassigned`.
   * Ein Workflow, den eine Gruppe per `workflowId` referenziert, übernimmt deren
   * Untergruppen und Nodes (die Gruppe erscheint dann nicht zusätzlich).
   */
  function buildModel({ nodes, groupTree, workflows }) {
    const groups = (groupTree && groupTree.groups) || {};
    const known = new Set((nodes || []).map((n) => n.id));
    const nodeLabel = new Map((nodes || []).map((n) => [n.id, n.label || n.id]));
    const folders = new Map();
    const rootIds = [];
    const assigned = new Set();

    const keep = (ids) => [...new Set(ids)].filter((id) => known.has(id));

    const groupByWf = new Map();
    for (const g of Object.values(groups)) if (g.workflowId) groupByWf.set(g.workflowId, g);
    const hiddenGroups = new Set();

    for (const wf of workflows || []) {
      const label = (wf.definition && wf.definition.title) || wf.name || wf.id;
      const wfNodes = Object.values(wf.runtime || {}).map((r) => r && r.nodeId).filter(Boolean);
      const linked = groupByWf.get(wf.id);
      let nodeIds = wfNodes;
      let folderIds = [];
      if (linked) {
        hiddenGroups.add(linked.id);
        nodeIds = [...(linked.nodeIds || []), ...wfNodes];
        folderIds = (linked.groupIds || []).filter((id) => groups[id]).map((id) => "grp:" + id);
      }
      nodeIds = keep(nodeIds);
      nodeIds.forEach((id) => assigned.add(id));
      folders.set("wf:" + wf.id, { id: "wf:" + wf.id, label, kind: "workflow", folderIds, nodeIds });
      rootIds.push("wf:" + wf.id);
    }

    for (const g of Object.values(groups)) {
      folders.set("grp:" + g.id, {
        id: "grp:" + g.id,
        label: g.label || g.id,
        kind: "group",
        folderIds: (g.groupIds || []).filter((id) => groups[id]).map((id) => "grp:" + id),
        nodeIds: keep(g.nodeIds || []),
      });
    }
    for (const g of Object.values(groups)) {
      for (const id of flattenGroup(groups, g.id)) if (known.has(id)) assigned.add(id);
      if (g.parentId === null || g.parentId === undefined) {
        if (!hiddenGroups.has(g.id)) rootIds.push("grp:" + g.id);
      }
    }

    const unassignedIds = [...known].filter((id) => !assigned.has(id));
    folders.set("unassigned", { id: "unassigned", label: "", kind: "unassigned", folderIds: [], nodeIds: unassignedIds });
    rootIds.push("unassigned");
    return { folders, rootIds, nodeLabel };
  }

  /** Nodes unterhalb eines Ordners (rekursiv), ohne Doppelte. */
  function folderNodeIds(model, folderId, seen = new Set()) {
    const f = model.folders.get(folderId);
    if (!f || seen.has(folderId)) return [];
    seen.add(folderId);
    const out = [...f.nodeIds];
    for (const c of f.folderIds) out.push(...folderNodeIds(model, c, seen));
    return [...new Set(out)];
  }

  /**
   * Inhalt einer Ebene. `path` = Liste von Ordner-IDs ab Home (leer = Home).
   * Ordner ohne passende Punkte werden ausgeblendet, `count` zählt Punkte
   * rekursiv; Nodes ohne Punkte erscheinen nicht.
   */
  function levelContents(model, path, pointsByNode) {
    const countOf = (fid) => folderNodeIds(model, fid).reduce((n, id) => n + (pointsByNode.get(id) || []).length, 0);
    const folderEntry = (fid) => {
      const f = model.folders.get(fid);
      return { id: fid, label: f.label, kind: f.kind, count: countOf(fid) };
    };
    const crumbs = path.map((fid) => ({ id: fid, label: (model.folders.get(fid) || {}).label || fid, kind: (model.folders.get(fid) || {}).kind }));
    if (path.length === 0) {
      return {
        crumbs,
        folders: model.rootIds.map(folderEntry).filter((f) => f.count > 0),
        nodes: [],
      };
    }
    const f = model.folders.get(path[path.length - 1]);
    if (!f) return { crumbs, folders: [], nodes: [] };
    return {
      crumbs,
      folders: f.folderIds.map(folderEntry).filter((e) => e.count > 0),
      nodes: f.nodeIds
        .filter((id) => (pointsByNode.get(id) || []).length > 0)
        .map((id) => ({ id, label: model.nodeLabel.get(id) || id, points: pointsByNode.get(id) })),
    };
  }

  /** Beschriftung eines Ordners (die Sammelgruppe heißt je Sprache anders). */
  function folderLabel(folder, t) {
    return folder.kind === "unassigned" ? t("unassigned") : folder.label;
  }

  function matchesQuery(p, q) {
    q = (q || "").trim().toLowerCase();
    if (!q) return true;
    return [p.label, p.nodeLabel, ...p.tags].some((s) => String(s).toLowerCase().includes(q));
  }

  function filterPoints(points, { media, query }) {
    return points.filter((p) => (!media || p.mediaType === media) && matchesQuery(p, query));
  }

  /** Format unbekannt (leer) gilt wie im Flow-Editor als kompatibel. */
  function compatible(source, sink) {
    if (!source || !sink) return false;
    if (!source.mediaType || !sink.mediaType) return true;
    return source.mediaType === sink.mediaType;
  }

  /** Receiver-ID → Sender-ID aus den Graph-Kanten. */
  function routeMap(edges) {
    const m = new Map();
    for (const e of edges || []) m.set(e.toReceiver, e.fromSender);
    return m;
  }

  /** Gemeinsame Tags ohne die allgemeinen `media.*`-Tags (die gelten für alles). */
  function sharedTags(a, b) {
    const set = new Set(b.tags);
    return a.tags.filter((t) => !t.startsWith("media.") && set.has(t));
  }

  /**
   * Tag-basierte Paarung: je Senke die Quelle gleichen Medientyps mit den
   * meisten gemeinsamen Tags (mindestens 1). Mit `fallbackOrder` werden
   * unpaarige Senken der Reihe nach mit noch unbenutzten Quellen gleichen
   * Medientyps verbunden. Offline-Quellen werden nie gewählt.
   */
  function planTagRoutes(sources, sinks, { fallbackOrder = false } = {}) {
    const routes = [];
    const unmatched = [];
    const used = new Set();
    const live = sources.filter((s) => s.online);
    for (const sink of sinks) {
      let best = null;
      let bestScore = 0;
      for (const s of live) {
        if (!s.mediaType || s.mediaType !== sink.mediaType) continue;
        const n = sharedTags(s, sink).length;
        if (n === 0) continue;
        if (!best || n > bestScore || (n === bestScore && used.has(best.id) && !used.has(s.id))) {
          best = s;
          bestScore = n;
        }
      }
      if (best && bestScore > 0) {
        used.add(best.id);
        routes.push({ from: best, to: sink, reason: "tag", tags: sharedTags(best, sink) });
      } else {
        unmatched.push(sink);
      }
    }
    if (!fallbackOrder) return { routes, unmatched };
    const stillUnmatched = [];
    for (const sink of unmatched) {
      const cand = live.find((s) => !used.has(s.id) && s.mediaType && s.mediaType === sink.mediaType);
      if (cand) {
        used.add(cand.id);
        routes.push({ from: cand, to: sink, reason: "order", tags: [] });
      } else stillUnmatched.push(sink);
    }
    return { routes, unmatched: stillUnmatched };
  }

  // ---- Bouquets --------------------------------------------------------------

  const BOUQUET_LAYOUT = "xy-bouquets";

  function refFor(p) {
    return { nodeId: p.nodeId, nodeLabel: p.nodeLabel, label: p.label };
  }

  /** IDs wechseln bei jedem Node-Neustart; stabil sind Node-ID/-Label + Portname. */
  function resolveRef(ref, points) {
    if (!ref) return null;
    return (
      points.find((p) => p.nodeId === ref.nodeId && p.label === ref.label) ||
      points.find((p) => p.nodeLabel === ref.nodeLabel && p.label === ref.label) ||
      null
    );
  }

  function describeRef(ref) {
    return `${ref.nodeLabel} · ${ref.label}`;
  }

  function parseBouquets(blob) {
    const list = blob && Array.isArray(blob.bouquets) ? blob.bouquets : [];
    return list.filter((b) => b && typeof b.id === "string" && typeof b.name === "string" && (b.kind === "routes" || b.kind === "tags"));
  }

  function newId() {
    return "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function routesBouquet(name, pairs) {
    return { id: newId(), name, kind: "routes", routes: pairs.map(({ from, to }) => ({ from: refFor(from), to: refFor(to) })) };
  }

  function tagsBouquet(name, sourceNode, sinkNode, fallbackOrder) {
    return { id: newId(), name, kind: "tags", source: { nodeId: sourceNode.id, nodeLabel: sourceNode.label }, sink: { nodeId: sinkNode.id, nodeLabel: sinkNode.label }, fallbackOrder: !!fallbackOrder };
  }

  /** Bouquet → konkrete Schaltliste gegen den aktuellen Katalog; nicht auffindbare Teile in `missing`. */
  function resolveBouquet(b, sources, sinks) {
    const routes = [];
    const missing = [];
    if (b.kind === "routes") {
      for (const r of b.routes || []) {
        const from = resolveRef(r.from, sources);
        const to = resolveRef(r.to, sinks);
        if (!from) missing.push(describeRef(r.from));
        else if (!to) missing.push(describeRef(r.to));
        else if (!compatible(from, to)) missing.push(describeRef(r.to));
        else routes.push({ from, to, reason: "bouquet", tags: [] });
      }
    } else {
      const src = sources.filter((s) => s.nodeId === b.source.nodeId || s.nodeLabel === b.source.nodeLabel);
      const snk = sinks.filter((s) => s.nodeId === b.sink.nodeId || s.nodeLabel === b.sink.nodeLabel);
      if (!src.length) missing.push(b.source.nodeLabel);
      if (!snk.length) missing.push(b.sink.nodeLabel);
      if (src.length && snk.length) {
        const plan = planTagRoutes(src, snk, { fallbackOrder: b.fallbackOrder });
        routes.push(...plan.routes);
        for (const u of plan.unmatched) missing.push(`${u.nodeLabel} · ${u.label}`);
      }
    }
    return { routes, missing };
  }

  globalThis.OmpXyLogic = {
    ROOT,
    BOUQUET_LAYOUT,
    normSources,
    normSinks,
    groupPointsByNode,
    flattenGroup,
    buildModel,
    folderNodeIds,
    levelContents,
    folderLabel,
    matchesQuery,
    filterPoints,
    compatible,
    routeMap,
    sharedTags,
    planTagRoutes,
    refFor,
    resolveRef,
    parseBouquets,
    routesBouquet,
    tagsBouquet,
    resolveBouquet,
  };
})();
