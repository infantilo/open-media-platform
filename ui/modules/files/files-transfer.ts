// Dateien übertragen (Kapitel 86): Dialog „Kopieren/Verschieben nach …“ mit Vorschau und die Liste der Übertragungen mit Fortschritt.
import { apiFetch, showToast, t } from "../host.ts";
import { btn, DIM, el, hostLabel, INPUT, jsonOrThrow, openModal, pill, post, type Root, TD } from "./files-ui.ts";
import { canStartTransfer, commonParent, etaSeconds, fmtBytes, fmtDuration, joinPath, parentPath, percent, type TransferPlan } from "./files-logic.ts";

export interface TransferRow {
  id: string; mode: string; srcRoot: string; srcRootName?: string; dstRoot: string; dstRootName?: string; paths: string[]; dstDir: string;
  conflict: string; status: string; totalBytes: number; doneBytes: number; filesTotal: number; filesDone: number; filesSkipped: number;
  error?: string; items?: { rel: string; dstRel: string; status: string; error?: string }[]; createdBy: string; createdAt: string;
  startedAt?: string; finishedAt?: string; current?: string; bytesPerSec?: number;
}

export interface TransferDialogOpts {
  roots: Root[];
  srcRoot: Root;
  paths: string[];
  mode: "copy" | "move";
  /** vorgewählter Zielort und -ordner (Ziehen und Ablegen) */
  dstRootId?: string;
  dstDir?: string;
  canMove: boolean;
  canForce: boolean;
  /** nach erfolgreichem Start */
  onStarted: () => void;
}

interface DirEntry { name: string; isDir?: boolean }

async function listDirs(rootId: string, path: string): Promise<string[]> {
  try {
    const q = new URLSearchParams({ root: rootId, path, limit: "300" });
    const body = await jsonOrThrow<{ entries: DirEntry[] }>(await apiFetch(`/api/v1/files/list?${q}`));
    return (body.entries ?? []).filter((e) => e.isDir).map((e) => e.name).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

const statusColor = (s: string): string =>
  s === "blocked" || s === "error" ? "var(--omp-danger,#d44)" : s === "locked" || s === "confirm" || s === "conflict" ? "var(--omp-warn,#db3)" : "var(--omp-ok,#3a3)";

export function openTransferDialog(o: TransferDialogOpts): void {
  const writable = o.roots.filter((r) => !r.readOnly && r.reachable !== false);
  const st = {
    mode: o.mode,
    dstRoot: o.dstRootId && writable.some((r) => r.id === o.dstRootId) ? o.dstRootId : (writable.find((r) => r.id !== o.srcRoot.id) ?? writable[0])?.id ?? "",
    dstDir: o.dstDir ?? "",
    conflict: "rename",
    confirm: false, force: false, reason: "",
    plan: null as TransferPlan | null, error: "", busy: false,
    dirs: [] as string[],
  };
  if (!o.dstDir && st.dstRoot === o.srcRoot.id) st.dstDir = commonParent(o.paths);
  let seq = 0;
  openModal(t(o.mode === "copy" ? "filesv.tr.titleCopy" : "filesv.tr.titleMove"), (box, close) => {
    box.style.maxWidth = "720px";
    box.style.width = "min(720px, 94vw)";
    const draw = async (reload: boolean) => {
      if (reload) {
        const my = ++seq;
        st.dirs = st.dstRoot ? await listDirs(st.dstRoot, st.dstDir) : [];
        try {
          const plan = await jsonOrThrow<TransferPlan>(await post("/api/v1/files/transfer/preview", {
            mode: st.mode, srcRoot: o.srcRoot.id, paths: o.paths, dstRoot: st.dstRoot, dstDir: st.dstDir, conflict: st.conflict,
          }));
          if (my !== seq) return;
          st.plan = plan; st.error = "";
        } catch (e) { if (my !== seq) return; st.plan = null; st.error = (e as Error).message; }
      }
      box.replaceChildren(el("h3", "margin:0 0 10px;font-size:var(--omp-font-size-md);", t(st.mode === "copy" ? "filesv.tr.titleCopy" : "filesv.tr.titleMove")));
      box.append(el("div", DIM + "margin-bottom:8px;", t("filesv.tr.from", { p0: o.srcRoot.name, p1: o.paths.length })));

      // Art
      const modes = el("div", "display:flex;gap:14px;margin-bottom:10px;");
      for (const m of ["copy", "move"] as const) {
        const l = el("label", "display:flex;gap:6px;align-items:center;" + (m === "move" && !o.canMove ? "opacity:.5;" : "cursor:pointer;"));
        const r = el("input") as HTMLInputElement;
        r.type = "radio"; r.name = "tr-mode"; r.checked = st.mode === m; r.disabled = m === "move" && !o.canMove;
        r.addEventListener("change", () => { st.mode = m; st.confirm = st.force = false; void draw(true); });
        l.append(r, document.createTextNode(t(m === "copy" ? "filesv.tr.copy" : "filesv.tr.move")));
        if (m === "move" && !o.canMove) l.title = t("filesv.tr.noMoveRight");
        modes.append(l);
      }
      box.append(modes);

      // Ziel: Ort und Ordner
      box.append(el("div", "font-weight:600;font-size:12px;margin-bottom:3px;", t("filesv.tr.dstRoot")));
      const sel = el("select", INPUT + "width:100%;margin-bottom:8px;") as HTMLSelectElement;
      for (const r of writable) {
        const op = el("option") as HTMLOptionElement;
        op.value = r.id; op.textContent = `${r.name} — ${r.shared ? t("filesv.root.shared") : hostLabel(r.hostId)}${r.free !== undefined ? " · " + t("filesv.root.free", { p0: fmtBytes(r.free), p1: fmtBytes(r.total) }) : ""}`;
        sel.append(op);
      }
      sel.value = st.dstRoot;
      sel.addEventListener("change", () => { st.dstRoot = sel.value; st.dstDir = ""; st.confirm = st.force = false; void draw(true); });
      box.append(sel);

      box.append(el("div", "font-weight:600;font-size:12px;margin-bottom:3px;", t("filesv.tr.dstDir")));
      const nav = el("div", "display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-bottom:6px;");
      const dstRootName = writable.find((r) => r.id === st.dstRoot)?.name ?? "";
      nav.append(btn(dstRootName || "/", () => { st.dstDir = ""; void draw(true); }));
      let acc = "";
      for (const seg of st.dstDir.split("/").filter(Boolean)) { acc = acc ? `${acc}/${seg}` : seg; const p = acc; nav.append(el("span", DIM, "/"), btn(seg, () => { st.dstDir = p; void draw(true); })); }
      if (st.dstDir) nav.append(btn("↑", () => { st.dstDir = parentPath(st.dstDir); void draw(true); }));
      box.append(nav);
      if (st.dirs.length) {
        const chips = el("div", "display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;max-height:84px;overflow:auto;");
        for (const d of st.dirs) chips.append(btn("📁 " + d, () => { st.dstDir = joinPath(st.dstDir, d); void draw(true); }));
        box.append(chips);
      }
      const dirInput = el("input", INPUT + "width:100%;box-sizing:border-box;margin-bottom:10px;") as HTMLInputElement;
      dirInput.placeholder = t("filesv.tr.dirPlaceholder");
      dirInput.value = st.dstDir;
      dirInput.addEventListener("change", () => { st.dstDir = dirInput.value.trim().replace(/^\/+|\/+$/g, ""); void draw(true); });
      box.append(dirInput);

      // Vorschau
      const plan = st.plan;
      if (st.error) box.append(el("div", "color:var(--omp-danger,#d44);margin-bottom:8px;", st.error));
      if (plan) {
        const sum = el("div", "margin-bottom:8px;");
        if (plan.rename) sum.append(el("div", "", t("filesv.tr.renameNote")));
        sum.append(el("div", "", t("filesv.tr.summary", { p0: plan.files, p1: fmtBytes(plan.totalBytes) })));
        if (!plan.rename && plan.dstFree > 0) sum.append(el("div", DIM, t("filesv.tr.space", { p0: fmtBytes(plan.dstFree) })));
        if (plan.noSpace) sum.append(el("div", "color:var(--omp-danger,#d44);", t("filesv.tr.noSpace")));
        box.append(sum);
        if (plan.conflicts > 0) {
          box.append(el("div", "font-weight:600;font-size:12px;margin-bottom:3px;", t("filesv.tr.conflicts", { p0: plan.conflicts })));
          const cs = el("select", INPUT + "margin-bottom:8px;") as HTMLSelectElement;
          for (const c of ["rename", "skip", "overwrite"]) { const op = el("option") as HTMLOptionElement; op.value = c; op.textContent = t(`filesv.tr.conflict.${c}`); cs.append(op); }
          cs.value = st.conflict;
          cs.addEventListener("change", () => { st.conflict = cs.value; });
          box.append(cs);
        }
        const problems = plan.items.filter((i) => i.status !== "ok");
        if (problems.length) {
          const table = el("table", "border-collapse:collapse;width:100%;margin-bottom:8px;max-height:180px;display:block;overflow:auto;");
          for (const it of problems.slice(0, 60)) {
            const tr = el("tr");
            tr.append(el("td", TD + "word-break:break-all;", it.rel));
            const c2 = el("td", TD);
            c2.append(pill(t(`filesv.tr.status.${it.status}`), statusColor(it.status)));
            if (it.error) c2.append(el("div", DIM, it.error));
            tr.append(c2);
            table.append(tr);
          }
          box.append(table);
          if (problems.length > 60) box.append(el("div", DIM, t("filesv.tr.more", { p0: problems.length - 60 })));
        }
        if (plan.blocked) box.append(el("div", "color:var(--omp-danger,#d44);margin-bottom:8px;", t("filesv.tr.blocked")));
        if (plan.needsForce) {
          box.append(el("div", DIM + "margin-bottom:6px;", t("filesv.tr.forceNote")));
          if (!o.canForce) box.append(el("div", "color:var(--omp-danger,#d44);margin-bottom:6px;", t("filesv.del.noForceRight")));
          else {
            const l = el("label", "display:flex;gap:6px;align-items:center;margin-bottom:6px;");
            const c = el("input") as HTMLInputElement; c.type = "checkbox"; c.checked = st.force;
            c.addEventListener("change", () => { st.force = c.checked; void draw(false); });
            l.append(c, document.createTextNode(t("filesv.del.force")));
            const reason = el("input", INPUT + "width:100%;box-sizing:border-box;margin-bottom:8px;") as HTMLInputElement;
            reason.placeholder = t("filesv.del.reason"); reason.value = st.reason;
            reason.addEventListener("input", () => { st.reason = reason.value; run.disabled = !canStartTransfer(plan, st2()); });
            box.append(l, reason);
          }
        }
        if (plan.needsConfirm && !plan.needsForce) {
          const l = el("label", "display:flex;gap:6px;align-items:center;margin-bottom:8px;");
          const c = el("input") as HTMLInputElement; c.type = "checkbox"; c.checked = st.confirm;
          c.addEventListener("change", () => { st.confirm = c.checked; void draw(false); });
          l.append(c, document.createTextNode(t("filesv.del.confirm")));
          box.append(l);
        }
      }
      const st2 = () => ({ confirm: st.confirm, force: st.force, reason: st.reason, canForce: o.canForce });
      const foot = el("div", "display:flex;gap:8px;justify-content:flex-end;");
      const run = btn(t(st.mode === "copy" ? "filesv.tr.runCopy" : "filesv.tr.runMove"), async () => {
        run.disabled = true;
        const res = await post("/api/v1/files/transfer", {
          mode: st.mode, srcRoot: o.srcRoot.id, paths: o.paths, dstRoot: st.dstRoot, dstDir: st.dstDir, conflict: st.conflict,
          confirm: st.confirm, force: st.force, reason: st.reason,
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) { st.error = body.error ?? String(res.status); void draw(false); return; }
        showToast(t("filesv.tr.started"));
        close();
        o.onStarted();
      }, { role: "files-transfer-run", disabled: !canStartTransfer(plan, st2()) });
      foot.append(btn(t("filesv.del.cancel"), close), run);
      box.append(foot);
    };
    void draw(true);
  });
}

// ---- Liste der Übertragungen ----------------------------------------------------------------------------------

/** Baut die Ansicht „Übertragungen“; `onChange` wird nach Abbrechen aufgerufen (Aktualisieren). */
export function renderTransfers(rows: TransferRow[], opts: { canCancel: boolean; onCancel: (id: string) => void; open: Set<string>; rerender: () => void }): HTMLElement {
  const wrap = el("div");
  if (rows.length === 0) { wrap.append(el("div", DIM, t("filesv.tr.none"))); return wrap; }
  for (const r of rows) {
    const active = r.status === "running" || r.status === "queued";
    const card = el("div", "background:var(--omp-surface-raised);border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:10px 12px;margin-bottom:8px;");
    card.setAttribute("data-transfer-id", r.id);
    const head = el("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;");
    const color = r.status === "done" ? "var(--omp-ok,#3a3)" : r.status === "failed" || r.status === "interrupted" ? "var(--omp-danger,#d44)" : r.status === "running" ? "var(--omp-accent-cyan)" : "var(--omp-text-dim)";
    head.append(pill(t(`filesv.tr.state.${r.status}`), color), el("b", "", `${r.srcRootName ?? r.srcRoot} → ${r.dstRootName ?? r.dstRoot}${r.dstDir ? " / " + r.dstDir : ""}`), pill(t(r.mode === "copy" ? "filesv.tr.copy" : "filesv.tr.move"), "var(--omp-text-dim)"));
    const spacer = el("span", "flex:1;");
    head.append(spacer);
    if (active && opts.canCancel) head.append(btn(t("filesv.tr.cancel"), () => opts.onCancel(r.id), { danger: true, role: "files-transfer-cancel" }));
    card.append(head);
    const pct = percent(r.doneBytes, r.totalBytes);
    const track = el("div", "height:8px;background:var(--omp-bg);border:1px solid var(--omp-border);border-radius:4px;margin:8px 0 4px;overflow:hidden;");
    track.append(el("div", `height:100%;width:${r.status === "done" ? 100 : pct.toFixed(1)}%;background:${color};transition:width .4s;`));
    card.append(track);
    const eta = r.status === "running" ? etaSeconds(r.doneBytes, r.totalBytes, r.bytesPerSec ?? 0) : null;
    const bits = [
      `${fmtBytes(r.doneBytes)} / ${fmtBytes(r.totalBytes)}`,
      t("filesv.tr.files", { p0: r.filesDone, p1: r.filesTotal }),
    ];
    if (r.filesSkipped) bits.push(t("filesv.tr.skipped", { p0: r.filesSkipped }));
    if (r.status === "running" && r.bytesPerSec) bits.push(`${fmtBytes(r.bytesPerSec)}/s`);
    if (eta !== null) bits.push(t("filesv.tr.eta", { p0: fmtDuration(eta) }));
    if (r.startedAt && r.finishedAt) bits.push(fmtDuration((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000));
    bits.push(r.createdBy);
    card.append(el("div", DIM, bits.join(" · ")));
    if (r.status === "running" && r.current) card.append(el("div", DIM + "word-break:break-all;", "→ " + r.current));
    if (r.error) card.append(el("div", "color:var(--omp-danger,#d44);margin-top:4px;", r.error));
    const bad = (r.items ?? []).filter((i) => i.status === "error" || i.status === "skipped");
    if (bad.length) {
      const toggle = btn(opts.open.has(r.id) ? t("filesv.tr.hideDetails") : t("filesv.tr.showDetails", { p0: bad.length }), () => { if (opts.open.has(r.id)) opts.open.delete(r.id); else opts.open.add(r.id); opts.rerender(); });
      card.append(toggle);
      if (opts.open.has(r.id)) {
        const list = el("div", "margin-top:6px;max-height:160px;overflow:auto;");
        for (const i of bad) list.append(el("div", DIM + "word-break:break-all;", `${i.status === "error" ? "✕" : "↷"} ${i.rel}${i.error ? " — " + i.error : ""}`));
        card.append(list);
      }
    }
    wrap.append(card);
  }
  return wrap;
}
