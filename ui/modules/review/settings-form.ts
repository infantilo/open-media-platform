// Einstellungen des Eingangs als Formular (statt JSON): Freigabe, Segmentregeln, QC (Profile mit Schwellen), Proxy, Metadatenformular, Import.
// Das Formular arbeitet auf einer Kopie; unbekannte Felder bleiben erhalten. Der Server prüft zusätzlich.
import { confirmDialog, t as tt } from "../host.ts";
import { check, el, field, grid, listInput, num, section, select, sub, text } from "./form-kit.ts";
import { APPROVAL_MODES, type Cfg, FIELD_TYPES, idFrom, moveItem, validateReviewConfig } from "./settings-logic.ts";


export interface ReviewSettingsOptions {
  config: Cfg;
  save: (c: Cfg) => Promise<{ ok: boolean; message: string }>;
}

export function openReviewSettingsForm(o: ReviewSettingsOptions): void {
  const c: Cfg = JSON.parse(JSON.stringify(o.config));
  c.qcProfiles ??= {};
  c.metadataFields ??= [];

  const overlay = el("div");
  overlay.className = "omp-modal-overlay";
  overlay.style.zIndex = "3000";
  const m = el("div", "max-width:860px;max-height:92vh;overflow:auto;");
  m.className = "omp-modal";
  m.dataset.role = "review-settings";
  const h1 = el("div", "margin-bottom:4px;", tt("rv.settings"));
  h1.className = "omp-h1";
  const err = el("div", "color:var(--omp-error);font-size:12px;white-space:pre-line;min-height:16px;");

  // ---- Freigabe ----
  const apr = section(tt("rv.cfg.approval"), tt("rv.cfg.approval.hint"), true);
  const ga = grid();
  ga.append(
    field(tt("rv.cfg.mode"), select(c, "approvalMode", APPROVAL_MODES.map((v) => [v, tt("rv.cfg.mode." + v)] as [string, string])), tt("rv.cfg.mode.help")),
  );
  apr.content.append(ga, check(tt("rv.cfg.selfapprove"), c, "allowSelfApproval", tt("rv.cfg.selfapprove.help")));
  apr.content.append(check(tt("rv.cfg.review.running"), c, "allowReviewWhileQcRunning"), check(tt("rv.cfg.review.fail"), c, "allowReviewAfterQcExecFail", tt("rv.cfg.review.fail.help")));

  // ---- Segmente ----
  const seg = section(tt("rv.cfg.segments"), tt("rv.cfg.segments.hint"));
  const gs = grid();
  gs.append(field(tt("rv.cfg.minseg"), num(c, "minSegmentFrames", { min: 1, step: 1, suffix: tt("rv.cfg.frames") })));
  seg.content.append(gs, check(tt("rv.cfg.overlap"), c, "allowOverlap"), check(tt("rv.cfg.gaps"), c, "allowGaps"));

  // ---- QC ----
  const qc = section(tt("rv.cfg.qc"), tt("rv.cfg.qc.hint"), true);
  const defSel = el("select") as HTMLSelectElement;
  const fillDefault = () => {
    defSel.replaceChildren();
    for (const p of Object.values(c.qcProfiles) as Cfg[]) {
      const op = el("option", "", p.name || p.id);
      op.value = p.id;
      defSel.append(op);
    }
    defSel.value = c.defaultQcProfile in c.qcProfiles ? c.defaultQcProfile : Object.keys(c.qcProfiles)[0] ?? "";
    c.defaultQcProfile = defSel.value;
  };
  defSel.addEventListener("change", () => (c.defaultQcProfile = defSel.value));
  const gq = grid(3);
  gq.append(
    field(tt("rv.cfg.qc.default"), defSel),
    field(tt("rv.cfg.qc.workers"), num(c, "qcWorkers", { min: 1, max: 4, step: 1 }), tt("rv.cfg.qc.workers.help")),
  );
  qc.content.append(gq, check(tt("rv.cfg.qc.auto"), c, "autoQc", tt("rv.cfg.qc.auto.help")), sub(tt("rv.cfg.qc.profiles")));
  const profHint = el("div", "font-size:12px;color:var(--omp-text-dim);");
  profHint.dataset.role = "qc-profiles-moved";
  profHint.textContent = tt("rv.cfg.qc.profiles.moved");
  const renderProfiles = () => fillDefault();
  renderProfiles();
  qc.content.append(profHint);

  // ---- Proxy ----
  const prx = section(tt("rv.cfg.proxy"), tt("rv.cfg.proxy.hint"));
  const gp = grid(3);
  gp.append(
    field(tt("rv.cfg.proxy.height"), num(c, "proxyHeight", { min: 120, step: 1, suffix: "px" })),
    field(tt("rv.cfg.proxy.crf"), num(c, "proxyCrf", { min: 10, max: 40, step: 1 }), tt("rv.cfg.proxy.crf.help")),
    field(tt("rv.cfg.proxy.audio"), num(c, "proxyMaxAudioTracks", { min: 1, step: 1 })),
  );
  prx.content.append(gp);

  // ---- Metadatenformular ----
  const meta = section(tt("rv.cfg.meta"), tt("rv.cfg.meta.hint"));
  const metaBox = el("div", "display:flex;flex-direction:column;gap:8px;");
  const renderMeta = () => {
    metaBox.replaceChildren();
    (c.metadataFields as Cfg[]).forEach((f, i) => {
      const card = el("div", "border:1px solid var(--omp-border);border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:6px;");
      card.dataset.metaField = f.id;
      const g = grid(3);
      const typeSel = select(f, "type", FIELD_TYPES.map((v) => [v, tt("rv.cfg.ft." + v)] as [string, string]));
      const valuesF = field(tt("rv.cfg.f.values"), listInput(f, "values", "a, b, c"), tt("rv.cfg.f.values.help"), true);
      const maxF = field(tt("rv.cfg.f.max"), num(f, "max", { min: 0, step: 1, optional: true }), tt("rv.cfg.f.max.help"));
      const sync = () => {
        valuesF.style.display = f.type === "select" || f.type === "multiselect" ? "" : "none";
        maxF.style.display = f.type === "text" || f.type === "longtext" || f.type === "tags" ? "" : "none";
      };
      typeSel.addEventListener("change", sync);
      g.append(field(tt("rv.cfg.f.label"), text(f, "label")), field(tt("rv.cfg.f.type"), typeSel), maxF);
      sync();
      const flags = el("div", "display:flex;gap:16px;align-items:center;flex-wrap:wrap;");
      flags.append(check(tt("rv.cfg.f.required"), f, "required"), check(tt("rv.cfg.f.segment"), f, "segment"));
      const row = el("div", "display:flex;gap:6px;align-items:center;");
      row.append(el("code", "font-size:11px;color:var(--omp-text-dim);margin-right:auto;", f.id));
      const up = el("button", "", "↑");
      const down = el("button", "", "↓");
      const del = el("button", "", tt("rv.cfg.remove"));
      up.disabled = i === 0;
      down.disabled = i === c.metadataFields.length - 1;
      up.addEventListener("click", () => {
        c.metadataFields = moveItem(c.metadataFields, i, -1);
        renderMeta();
      });
      down.addEventListener("click", () => {
        c.metadataFields = moveItem(c.metadataFields, i, 1);
        renderMeta();
      });
      del.addEventListener("click", async () => {
        if (!(await confirmDialog(tt("rv.cfg.f.remove.q", { p0: f.label || f.id })))) return;
        c.metadataFields.splice(i, 1);
        renderMeta();
      });
      row.append(up, down, del);
      card.append(g, valuesF, flags, row);
      metaBox.append(card);
    });
  };
  renderMeta();
  const addField = el("button", "align-self:flex-start;", "+ " + tt("rv.cfg.f.add"));
  addField.addEventListener("click", () => {
    const label = tt("rv.cfg.f.new");
    const id = idFrom(label, (c.metadataFields as Cfg[]).map((f) => f.id));
    c.metadataFields.push({ id, label, type: "text" });
    renderMeta();
  });
  meta.content.append(metaBox, addField);

  // ---- Import ----
  const imp = section(tt("rv.cfg.import"), tt("rv.cfg.import.hint"));
  const gi = grid();
  gi.append(field(tt("rv.cfg.import.dir"), text(c, "importDir", "data/media"), tt("rv.cfg.import.dir.help"), true));
  imp.content.append(gi);

  // ---- Fuß ----
  const row = el("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:4px;");
  const cancel = el("button", "", tt("rv.cancel"));
  const save = el("button", "", tt("rv.save"));
  save.className = "omp-btn-primary";
  save.dataset.role = "settings-save";
  cancel.addEventListener("click", () => overlay.remove());
  save.addEventListener("click", async () => {
    const problems = validateReviewConfig(c);
    if (problems.length) {
      err.textContent = problems.map((p) => tt(p.key, { p0: p.p0 ?? "" })).join("\n");
      return;
    }
    err.textContent = "";
    save.disabled = true;
    const r = await o.save(c);
    save.disabled = false;
    if (!r.ok) {
      err.textContent = r.message;
      return;
    }
    overlay.remove();
  });
  row.append(cancel, save);
  const body = el("div", "display:flex;flex-direction:column;gap:10px;");
  body.append(apr.box, seg.box, qc.box, prx.box, meta.box, imp.box);
  m.append(h1, el("div", "font-size:12px;color:var(--omp-text-dim);margin-bottom:8px;", tt("rv.settings.hint")), body, err, row);
  overlay.addEventListener("keydown", (e) => e.key === "Escape" && overlay.remove());
  overlay.append(m);
  document.body.append(overlay);
}
