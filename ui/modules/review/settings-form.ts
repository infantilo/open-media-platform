// Einstellungen des Eingangs als Formular (statt JSON): Freigabe, Segmentregeln, QC (Profile mit Schwellen), Proxy, Metadatenformular, Import.
// Das Formular arbeitet auf einer Kopie; unbekannte Felder bleiben erhalten. Der Server prüft zusätzlich.
import { confirmDialog, showToast, t as tt } from "../host.ts";
import { APPROVAL_MODES, type Cfg, FIELD_ORDERS, FIELD_TYPES, idFrom, joinList, moveItem, splitList, validateReviewConfig } from "./settings-logic.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

export interface ReviewSettingsOptions {
  config: Cfg;
  save: (c: Cfg) => Promise<{ ok: boolean; message: string }>;
}

interface NumOpts {
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  optional?: boolean; // leer = Feld entfällt (z. B. „nicht prüfen“)
  help?: string;
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

  // ---- Bausteine ----
  const field = (text: string, ctl: HTMLElement, help = "", wide = false): HTMLElement => {
    const w = el("label", `display:flex;flex-direction:column;gap:2px;${wide ? "grid-column:1/-1;" : ""}`);
    w.append(el("span", "font-size:11px;color:var(--omp-text-dim);", text));
    w.append(ctl);
    if (help) w.append(el("span", "font-size:10px;color:var(--omp-text-dim);", help));
    return w;
  };
  const num = (obj: Cfg, key: string, o2: NumOpts = {}): HTMLElement => {
    const wrap = el("span", "display:inline-flex;align-items:center;gap:4px;");
    const i = el("input") as HTMLInputElement;
    i.type = "number";
    i.style.width = "100%";
    if (o2.min !== undefined) i.min = String(o2.min);
    if (o2.max !== undefined) i.max = String(o2.max);
    i.step = String(o2.step ?? "any");
    i.value = obj[key] === undefined || obj[key] === null ? "" : String(obj[key]);
    i.addEventListener("input", () => {
      const t = i.value.trim().replace(",", ".");
      const n = Number(t);
      if (t === "" || !Number.isFinite(n)) {
        if (o2.optional) delete obj[key];
        else obj[key] = 0;
      } else obj[key] = n;
    });
    wrap.append(i);
    if (o2.suffix) wrap.append(el("span", "font-size:11px;color:var(--omp-text-dim);white-space:nowrap;", o2.suffix));
    return wrap;
  };
  const text = (obj: Cfg, key: string, ph = "", optional = false): HTMLInputElement => {
    const i = el("input") as HTMLInputElement;
    i.value = obj[key] ?? "";
    i.placeholder = ph;
    i.addEventListener("input", () => {
      if (optional && i.value === "") delete obj[key];
      else obj[key] = i.value;
    });
    return i;
  };
  const listInput = (obj: Cfg, key: string, ph = ""): HTMLInputElement => {
    const i = el("input") as HTMLInputElement;
    i.value = joinList(obj[key]);
    i.placeholder = ph;
    i.addEventListener("input", () => {
      const l = splitList(i.value);
      if (l.length) obj[key] = l;
      else delete obj[key];
    });
    return i;
  };
  const select = (obj: Cfg, key: string, opts: [string, string][]): HTMLSelectElement => {
    const s = el("select") as HTMLSelectElement;
    for (const [v, l] of opts) {
      const op = el("option", "", l);
      op.value = v;
      s.append(op);
    }
    s.value = obj[key] ?? "";
    s.addEventListener("change", () => {
      if (s.value === "" && key === "fieldOrder") delete obj[key];
      else obj[key] = s.value;
    });
    return s;
  };
  const check = (txt: string, obj: Cfg, key: string, help = ""): HTMLElement => {
    const w = el("div", "display:flex;flex-direction:column;");
    const l = el("label", "display:flex;align-items:center;gap:6px;font-size:12px;");
    const i = el("input") as HTMLInputElement;
    i.type = "checkbox";
    i.checked = !!obj[key];
    i.addEventListener("change", () => {
      if (i.checked) obj[key] = true;
      else if (key === "captions") delete obj[key];
      else obj[key] = false;
    });
    l.append(i, document.createTextNode(txt));
    w.append(l);
    if (help) w.append(el("span", "font-size:10px;color:var(--omp-text-dim);margin-left:22px;", help));
    return w;
  };
  const grid = (cols = 2): HTMLElement => el("div", `display:grid;grid-template-columns:repeat(${cols},1fr);gap:8px 14px;`);
  const section = (title: string, hint: string, open = false): { box: HTMLDetailsElement; content: HTMLElement } => {
    const box = el("details", "border:1px solid var(--omp-border);border-radius:6px;padding:6px 10px;") as HTMLDetailsElement;
    box.open = open;
    box.append(el("summary", "cursor:pointer;font-weight:600;", title));
    const content = el("div", "display:flex;flex-direction:column;gap:8px;margin-top:8px;");
    if (hint) content.append(el("div", "font-size:11px;color:var(--omp-text-dim);", hint));
    box.append(content);
    return { box, content };
  };
  const sub = (title: string): HTMLElement => el("div", "font-weight:600;font-size:12px;margin-top:4px;", title);

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
  const profBox = el("div", "display:flex;flex-direction:column;gap:8px;");

  const thresholdGroup = (title: string, obj: Cfg, rows: [string, string, NumOpts][]): HTMLElement => {
    const w = el("div", "display:flex;flex-direction:column;gap:4px;");
    w.append(el("div", "font-size:11px;font-weight:600;", title));
    const g = grid(3);
    for (const [key, label, opts] of rows) g.append(field(label, num(obj, key, opts)));
    w.append(g);
    return w;
  };
  const profileCard = (p: Cfg): HTMLElement => {
    p.black ??= {};
    p.freeze ??= {};
    p.silence ??= {};
    p.loudness ??= {};
    p.sync ??= {};
    p.expect ??= {};
    const card = el("details", "border:1px solid var(--omp-border);border-radius:6px;padding:6px 8px;") as HTMLDetailsElement;
    card.dataset.qcProfile = p.id;
    const sum = el("summary", "cursor:pointer;");
    sum.append(el("b", "", p.name || p.id), el("code", "margin-left:8px;font-size:11px;color:var(--omp-text-dim);", `${p.id}@${p.version ?? 1}`));
    const body = el("div", "display:flex;flex-direction:column;gap:10px;margin-top:8px;");
    const g0 = grid(3);
    g0.append(
      field(tt("rv.cfg.p.name"), text(p, "name")),
      field(tt("rv.cfg.p.version"), num(p, "version", { min: 1, step: 1 }), tt("rv.cfg.p.version.help")),
      field(tt("rv.cfg.p.timeout"), num(p, "timeoutSec", { min: 30, step: 10, suffix: "s" })),
    );
    body.append(g0);
    const s = "s";
    body.append(
      thresholdGroup(tt("rv.cfg.black"), p.black, [
        ["minDurationS", tt("rv.cfg.t.mindur"), { min: 0, suffix: s }],
        ["warnAboveS", tt("rv.cfg.t.warn"), { min: 0, suffix: s }],
        ["failAboveS", tt("rv.cfg.t.fail"), { min: 0, suffix: s }],
        ["ignoreHeadS", tt("rv.cfg.t.head"), { min: 0, suffix: s }],
        ["ignoreTailS", tt("rv.cfg.t.tail"), { min: 0, suffix: s }],
        ["pixTh", tt("rv.cfg.t.pix"), { min: 0, max: 1, step: 0.01 }],
      ]),
      thresholdGroup(tt("rv.cfg.freeze"), p.freeze, [
        ["noiseDb", tt("rv.cfg.t.noise"), { suffix: "dB" }],
        ["minDurationS", tt("rv.cfg.t.mindur"), { min: 0, suffix: s }],
        ["warnAboveS", tt("rv.cfg.t.warn"), { min: 0, suffix: s }],
        ["failAboveS", tt("rv.cfg.t.fail"), { min: 0, suffix: s }],
      ]),
      thresholdGroup(tt("rv.cfg.silence"), p.silence, [
        ["noiseDb", tt("rv.cfg.t.noise"), { suffix: "dB" }],
        ["minDurationS", tt("rv.cfg.t.mindur"), { min: 0, suffix: s }],
        ["warnAboveS", tt("rv.cfg.t.warn"), { min: 0, suffix: s }],
        ["failAboveS", tt("rv.cfg.t.fail"), { min: 0, suffix: s }],
      ]),
    );
    const lo = el("div", "display:flex;flex-direction:column;gap:4px;");
    lo.append(check(tt("rv.cfg.loud"), p.loudness, "enabled"));
    const lg = thresholdGroup(tt("rv.cfg.loud.limits"), p.loudness, [
      ["targetLufs", tt("rv.cfg.t.target"), { suffix: "LUFS" }],
      ["warnToleranceLu", tt("rv.cfg.t.warntol"), { min: 0, suffix: "LU" }],
      ["failToleranceLu", tt("rv.cfg.t.failtol"), { min: 0, suffix: "LU" }],
      ["maxTruePeakDbtp", tt("rv.cfg.t.truepeak"), { suffix: "dBTP" }],
      ["maxLra", tt("rv.cfg.t.lra"), { min: 0, suffix: "LU" }],
    ]);
    lo.append(lg);
    body.append(lo);
    const g1 = grid(3);
    g1.append(
      field(tt("rv.cfg.t.clip"), num(p, "clipPeakDb", { suffix: "dBFS" }), tt("rv.cfg.t.clip.help")),
      field(tt("rv.cfg.t.startoff"), num(p.sync, "maxStartOffsetMs", { min: 0, suffix: "ms" })),
      field(tt("rv.cfg.t.durmis"), num(p.sync, "maxDurationMismatchMs", { min: 0, suffix: "ms" })),
      field(tt("rv.cfg.t.maxaudio"), num(p, "maxAudioStreams", { min: 1, step: 1 }), tt("rv.cfg.t.maxaudio.help")),
    );
    body.append(g1);
    // Erwartungen an die Datei
    const ex = el("div", "display:flex;flex-direction:column;gap:4px;");
    ex.append(el("div", "font-size:11px;font-weight:600;", tt("rv.cfg.expect")), el("div", "font-size:10px;color:var(--omp-text-dim);", tt("rv.cfg.expect.help")));
    const ge = grid(3);
    ge.append(
      field(tt("rv.cfg.e.width"), num(p.expect, "width", { min: 0, step: 1, optional: true })),
      field(tt("rv.cfg.e.height"), num(p.expect, "height", { min: 0, step: 1, optional: true })),
      field(tt("rv.cfg.e.rate"), text(p.expect, "frameRate", "25/1", true)),
      field(tt("rv.cfg.e.order"), select(p.expect, "fieldOrder", FIELD_ORDERS.map((v) => [v, v === "" ? tt("rv.cfg.e.order.none") : tt("rv.cfg.e.order." + v)] as [string, string]))),
      field(tt("rv.cfg.e.codecs"), listInput(p.expect, "videoCodecs", "mpeg2video, h264"), tt("rv.cfg.e.codecs.help")),
      field(tt("rv.cfg.e.container"), text(p.expect, "container", "mxf", true), tt("rv.cfg.e.container.help")),
      field(tt("rv.cfg.e.tracks"), num(p.expect, "audioTracks", { min: 0, step: 1, optional: true })),
      field(tt("rv.cfg.e.rate.audio"), num(p.expect, "sampleRate", { min: 0, step: 1, optional: true, suffix: "Hz" })),
      field(tt("rv.cfg.e.bits"), num(p.expect, "minBitDepth", { min: 0, step: 1, optional: true, suffix: "bit" })),
    );
    ex.append(ge, check(tt("rv.cfg.e.captions"), p.expect, "captions"));
    body.append(ex);

    const row = el("div", "display:flex;gap:8px;");
    const dup = el("button", "", tt("rv.cfg.p.dup"));
    dup.addEventListener("click", () => {
      const id = idFrom(p.id, Object.keys(c.qcProfiles));
      c.qcProfiles[id] = { ...JSON.parse(JSON.stringify(p)), id, version: 1, name: `${p.name || p.id} (${tt("rv.cfg.p.copy")})` };
      renderProfiles();
    });
    const del = el("button", "", tt("rv.cfg.remove"));
    del.addEventListener("click", async () => {
      if (Object.keys(c.qcProfiles).length <= 1) {
        showToast(tt("rv.cfg.err.noprofile"));
        return;
      }
      if (!(await confirmDialog(tt("rv.cfg.p.remove.q", { p0: p.name || p.id })))) return;
      delete c.qcProfiles[p.id];
      renderProfiles();
    });
    row.append(dup, del);
    body.append(row);
    card.append(sum, body);
    return card;
  };
  const renderProfiles = () => {
    fillDefault();
    profBox.replaceChildren(...Object.values(c.qcProfiles).map((p) => profileCard(p as Cfg)));
  };
  renderProfiles();
  qc.content.append(profBox);

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
