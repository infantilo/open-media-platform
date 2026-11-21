// Formular für eine Leitung (Art, Adresse, abweichendes Hausformat, Rückweg). Wird für Events und Vorlagen benutzt; „Übernehmen“
// gibt die geprüfte Leitung zurück, nichts wird vorher gespeichert.
import { apiFetch, t } from "../host.ts";
import { field, h, input, modal, note, segmented, select } from "./mcr-dom.ts";
import { chainEditor } from "./chain-editor.ts";
import { type MonCfg, monitorEditor } from "./monitor-editor.ts";
import { type Stage, type StageType } from "./chain-logic.ts";
import { FORMAT_PRESETS, type HouseDraft, KINDS, type Kind, type LineDraft, validateHouse, validateLine } from "./mcr-logic.ts";

const num = (v: string): number => Number(v.trim());

function transportFields(kind: Kind, tr: Record<string, unknown>): { el: HTMLElement; read: () => Record<string, unknown> } {
  const s = (k: string) => (tr[k] === undefined ? "" : String(tr[k]));
  const wrap = h("div", { class: "mcr-form-grid" });
  const refs: Record<string, HTMLInputElement | HTMLSelectElement> = {};
  const add = (key: string, label: string, el: HTMLInputElement | HTMLSelectElement, hint = "", span = false) => {
    refs[key] = el;
    const f = field(label, el, hint);
    if (span) f.style.gridColumn = "1 / -1";
    wrap.append(f);
  };
  const modes = [{ value: "caller", label: t("mcr.mode.caller") }, { value: "listener", label: t("mcr.mode.listener") }, { value: "rendezvous", label: t("mcr.mode.rendezvous") }];
  if (kind === "srt") {
    add("uri", t("mcr.f.address"), input(s("uri") || "srt://:9000"), t("mcr.f.srtHint"), true);
    add("mode", t("mcr.f.mode"), select(modes, s("mode") || "listener"));
    add("latencyMs", t("mcr.f.latency"), input(s("latencyMs") || "200"));
    add("streamId", t("mcr.f.streamId"), input(s("streamId")));
    add("audioPids", t("mcr.f.audioPids"), input(s("audioPids")), t("mcr.f.audioPidsHint"));
    add("passphraseKey", t("mcr.f.passphraseKey"), input(s("passphraseKey")), t("mcr.f.passphraseKeyHint"), true);
  } else if (kind === "rist") {
    add("uri", t("mcr.f.address"), input(s("uri") || "rist://0.0.0.0:5004"), t("mcr.f.ristHint"), true);
    add("latencyMs", t("mcr.f.latency"), input(s("latencyMs") || "200"));
    add("audioPids", t("mcr.f.audioPids"), input(s("audioPids")), t("mcr.f.audioPidsHint"));
  } else if (kind === "st2110") {
    add("videoPort", t("mcr.f.videoPort"), input(s("videoPort") || "6000"));
    add("audioPort", t("mcr.f.audioPort"), input(s("audioPort") || "6002"));
    add("group", t("mcr.f.group"), input(s("group")), t("mcr.f.groupHint"));
    add("audioGroup", t("mcr.f.audioGroup"), input(s("audioGroup")));
    add("width", t("mcr.f.width"), input(s("width") || "1920"));
    add("height", t("mcr.f.height"), input(s("height") || "1080"));
    add("fpsNum", t("mcr.f.fpsNum"), input(s("fpsNum") || "25"));
    add("audioChannels", t("mcr.f.audioChannels"), input(s("audioChannels") || "2"));
  } else if (kind === "hls") {
    add("url", t("mcr.f.url"), input(s("url")), t("mcr.f.urlHint"), true);
    add("maxBitrateKbps", t("mcr.f.maxBitrate"), input(s("maxBitrateKbps")));
  } else {
    add("sourceNodeType", t("mcr.f.sourceType"), input(s("sourceNodeType")), t("mcr.f.sourceTypeHint"), true);
  }
  return {
    el: wrap,
    read: () => {
      const out: Record<string, unknown> = {};
      for (const [k, el] of Object.entries(refs)) {
        const v = el.value.trim();
        if (v === "") continue;
        out[k] = ["latencyMs", "maxBitrateKbps", "width", "height", "fpsNum", "audioChannels"].includes(k) ? num(v) : v;
      }
      return out;
    },
  };
}

function houseFields(h0: HouseDraft | null | undefined): { el: HTMLElement; read: () => HouseDraft } {
  const v = h0?.video;
  const a = h0?.audio;
  const preset = select([{ value: "", label: "—" }, ...FORMAT_PRESETS.map((p) => ({ value: p.id, label: p.id }))], "");
  const w = input(v?.width ?? "", { inputmode: "numeric" });
  const hh = input(v?.height ?? "", { inputmode: "numeric" });
  const rate = input(v?.rate ?? "", { placeholder: "25/1" });
  const scan = select([{ value: "progressive", label: t("mcr.scan.progressive") }, { value: "interlaced_tff", label: t("mcr.scan.tff") }, { value: "interlaced_bff", label: t("mcr.scan.bff") }], v?.scan ?? "progressive");
  const cs = select([{ value: "", label: t("mcr.f.keep") }, { value: "BT601", label: "BT.601" }, { value: "BT709", label: "BT.709" }, { value: "BT2020", label: "BT.2020" }], v?.colorspace ?? "");
  const tf = select([{ value: "", label: t("mcr.f.keep") }, { value: "SDR", label: "SDR" }, { value: "HLG", label: "HLG" }, { value: "PQ", label: "PQ" }], v?.transfer ?? "");
  const tp = select([{ value: "", label: t("mcr.f.default") }, { value: "warn", label: t("mcr.tp.warn") }, { value: "block", label: t("mcr.tp.block") }, { value: "map", label: t("mcr.tp.map") }], v?.transferPolicy ?? "");
  const sr = input(a?.sampleRate ?? "", { inputmode: "numeric", placeholder: "48000" });
  const ch = input(a?.channels ?? "", { inputmode: "numeric", placeholder: "16" });
  preset.addEventListener("change", () => {
    const p = FORMAT_PRESETS.find((x) => x.id === preset.value);
    if (!p) return;
    w.value = String(p.video.width);
    hh.value = String(p.video.height);
    rate.value = p.video.rate;
    scan.value = p.video.scan;
    cs.value = p.video.colorspace ?? "";
    tf.value = p.video.transfer ?? "";
  });
  const el = h("div", { class: "mcr-form" },
    h("div", { class: "mcr-form-grid" }, field(t("mcr.f.preset"), preset, t("mcr.f.presetHint"))),
    h("div", { class: "mcr-form-grid" }, field(t("mcr.f.width"), w), field(t("mcr.f.height"), hh), field(t("mcr.f.rate"), rate, t("mcr.f.rateHint")), field(t("mcr.f.scan"), scan)),
    h("div", { class: "mcr-form-grid" }, field(t("mcr.f.colorspace"), cs), field(t("mcr.f.transfer"), tf), field(t("mcr.f.transferPolicy"), tp, t("mcr.f.transferPolicyHint"))),
    h("div", { class: "mcr-form-grid" }, field(t("mcr.f.sampleRate"), sr), field(t("mcr.f.channels"), ch)));
  return {
    el,
    read: () => {
      const out: HouseDraft = {};
      if (w.value.trim() || hh.value.trim() || rate.value.trim()) {
        out.video = { width: num(w.value), height: num(hh.value), rate: rate.value.trim(), scan: scan.value };
        if (cs.value) out.video.colorspace = cs.value;
        if (tf.value) out.video.transfer = tf.value;
        if (tp.value) out.video.transferPolicy = tp.value;
      }
      if (sr.value.trim() || ch.value.trim()) out.audio = { sampleRate: num(sr.value), channels: num(ch.value) };
      return out;
    },
  };
}

export { houseFields };

/** Dialog zum Anlegen/Ändern einer Leitung. `others` = Namen/IDs der anderen Leitungen (Quelle für einen Rückweg). */
interface SrcSender { id: string; label: string; format: string; channel_count?: number }
interface Track { label: string; channels: number[] }
interface SrcNode { id: string; label: string; online: boolean; senders: SrcSender[] }

/** Laufende Nodes mit Sendern (Quellen für eine Leitung): dedizierte SRT-/2110-Nodes, Kameras, Player … */
export async function loadSourceNodes(): Promise<SrcNode[]> {
  try {
    const r = await apiFetch("/api/v1/nodes");
    if (!r.ok) return [];
    const all = (await r.json()) as SrcNode[];
    return all.filter((n) => n.online && Array.isArray(n.senders) && n.senders.length > 0).sort((a, b) => a.label.localeCompare(b.label));
  } catch {
    return [];
  }
}

/** Auswahl eines vorhandenen Nodes samt Bild- und Tonsender. `read()` liefert `transport.existing` oder null. */
function existingFields(initial: Record<string, unknown> | undefined): { el: HTMLElement; read: () => Record<string, unknown> | null } {
  // Bild, Ton und Daten aus verschiedenen Nodes (Matrix-Ansicht): hier nur anzeigen, unverändert lassen
  if (initial && !initial.nodeId && (initial.videoNodeId || initial.audioNodeId || initial.dataNodeId)) {
    const lbl = (k: string) => String(initial[`${k}NodeLabel`] || initial[`${k}NodeId`] || "–");
    return {
      el: h("div", { class: "mcr-form" }, note(t("mcr.src.split", { video: lbl("video"), audio: lbl("audio"), data: lbl("data") }))),
      read: () => ({ ...initial }),
    };
  }
  let nodes: SrcNode[] = [];
  const node = select([], "");
  const vid = select([], "");
  const aud = select([], "");
  const hint = h("div", { class: "mcr-hint" }, t("mcr.src.loading"));
  const fmtVideo = "urn:x-nmos:format:video";
  const fmtAudio = "urn:x-nmos:format:audio";
  const fill = (sel: HTMLSelectElement, senders: SrcSender[], wanted: string) => {
    sel.replaceChildren(new Option(t("mcr.src.auto"), ""), ...senders.map((s) => new Option(s.label, s.id)));
    sel.value = senders.some((s) => s.id === wanted) ? wanted : "";
  };
  const onNode = (v = "", a = "") => {
    const n = nodes.find((x) => x.id === node.value);
    fill(vid, (n?.senders ?? []).filter((s) => s.format === fmtVideo), v);
    fill(aud, (n?.senders ?? []).filter((s) => s.format === fmtAudio), a);
  };
  let tracks: Track[] = ((initial as { audioTracks?: Track[] } | undefined)?.audioTracks ?? []).map((x) => ({ label: x.label ?? "", channels: [...x.channels] }));
  const trackBox = h("div", { class: "mcr-tracks" });
  /** Kanalzahl des gewählten Ton-Flows (bei „automatisch“: des ersten Ton-Flows); 0 = unbekannt. */
  const channelCount = (): number => {
    const n = nodes.find((x) => x.id === node.value);
    const audio = (n?.senders ?? []).filter((s) => s.format === fmtAudio);
    const s = audio.find((x) => x.id === aud.value) ?? audio[0];
    return s?.channel_count ?? 0;
  };
  const drawTracks = () => {
    const nCh = channelCount() || Math.max(8, ...tracks.flatMap((x) => x.channels));
    const rows = tracks.map((tr, i) => {
      const label = input(tr.label, { placeholder: t("mcr.trk.name", { n: i + 1 }) });
      label.addEventListener("input", () => (tr.label = label.value));
      const chips = h("div", { class: "mcr-quick" });
      for (let c = 1; c <= nCh; c++) {
        const on = tr.channels.includes(c);
        const b = h("button", { type: "button", class: "mcr-chip", "aria-pressed": String(on), title: t("mcr.trk.channel", { n: c }) }, String(c));
        b.addEventListener("click", () => {
          tr.channels = tr.channels.includes(c) ? tr.channels.filter((x) => x !== c) : [...tr.channels, c].sort((a, b2) => a - b2);
          drawTracks();
        });
        chips.append(b);
      }
      const del = h("button", { type: "button", class: "mcr-btn mcr-btn-sm mcr-btn-quiet" }, "✕");
      del.addEventListener("click", () => {
        tracks.splice(i, 1);
        drawTracks();
      });
      return h("div", { class: "mcr-track" }, h("div", { class: "mcr-track-head" }, label, del), chips);
    });
    const pairs = h("button", { type: "button", class: "mcr-btn mcr-btn-sm" }, t("mcr.trk.pairs"));
    pairs.addEventListener("click", () => {
      const n = channelCount();
      tracks = [];
      for (let c = 1; c + 1 <= n; c += 2) tracks.push({ label: "", channels: [c, c + 1] });
      if (n % 2 === 1) tracks.push({ label: "", channels: [n] });
      drawTracks();
    });
    const add = h("button", { type: "button", class: "mcr-btn mcr-btn-sm" }, `+ ${t("mcr.trk.add")}`);
    add.addEventListener("click", () => {
      tracks.push({ label: "", channels: [] });
      drawTracks();
    });
    const used = tracks.reduce((a, x) => a + x.channels.length, 0);
    trackBox.replaceChildren(
      h("div", { class: "mcr-hint" }, tracks.length ? t("mcr.trk.summary", { n: used }) : t("mcr.trk.all", { n: channelCount() || "?" })),
      ...rows,
      h("div", { class: "mcr-quick" }, add, pairs),
    );
  };
  node.addEventListener("change", () => {
    onNode();
    drawTracks();
  });
  aud.addEventListener("change", drawTracks);
  void loadSourceNodes().then((list) => {
    nodes = list;
    const cur = initial as { nodeId?: string; nodeLabel?: string; videoSenderId?: string; audioSenderId?: string } | undefined;
    const opts = list.map((n) => new Option(n.label, n.id));
    if (cur?.nodeId && !list.some((n) => n.id === cur.nodeId)) opts.unshift(new Option(`${cur.nodeLabel || cur.nodeId} (${t("mcr.src.offline")})`, cur.nodeId));
    node.replaceChildren(new Option(t("mcr.src.choose"), ""), ...opts);
    node.value = cur?.nodeId ?? "";
    onNode(cur?.videoSenderId ?? "", cur?.audioSenderId ?? "");
    drawTracks();
    hint.textContent = list.length ? t("mcr.src.hint") : t("mcr.src.none");
  });
  const el = h("div", { class: "mcr-form" }, field(t("mcr.src.node"), node, undefined),
    h("div", { class: "mcr-form-grid" }, field(t("mcr.src.video"), vid), field(t("mcr.src.audio"), aud)),
    h("div", { class: "mcr-field" }, h("label", {}, t("mcr.trk.title")), trackBox), hint);
  return {
    el,
    read: () => {
      if (!node.value) return null;
      const n = nodes.find((x) => x.id === node.value);
      const out: Record<string, unknown> = { nodeId: node.value, nodeLabel: n?.label ?? (initial as { nodeLabel?: string } | undefined)?.nodeLabel ?? "" };
      if (vid.value) out.videoSenderId = vid.value;
      if (aud.value) out.audioSenderId = aud.value;
      const keep = tracks.filter((x) => x.channels.length > 0).map((x) => (x.label.trim() ? { label: x.label.trim(), channels: x.channels } : { channels: x.channels }));
      if (keep.length) out.audioTracks = keep;
      return out;
    },
  };
}

export function openLineForm(initial: LineDraft | null, others: { id: string; name: string }[], opts: { structureLocked?: boolean; stageTypes?: StageType[] } = {}): Promise<LineDraft | null> {
  const d: LineDraft = initial ?? { name: "", kind: "srt", transport: {} };
  let kind: Kind = d.kind;
  const body = h("div", { class: "mcr-form" });
  const name = input(d.name, { placeholder: t("mcr.f.namePlaceholder") });
  const kindSeg = segmented(KINDS.map((k) => ({ value: k, label: t(`mcr.kind.${k}`) })), kind, (v) => {
    kind = v as Kind;
    redrawTransport({});
    if (kind === "mxl") sourceMode = "existing";
    syncSource();
  });
  if (opts.structureLocked) kindSeg.querySelectorAll("button").forEach((b) => (b.disabled = true));
  const tpBox = h("div");
  let tf = transportFields(kind, d.transport);
  const redrawTransport = (tr: Record<string, unknown>) => {
    tf = transportFields(kind, tr);
    tpBox.replaceChildren(tf.el);
  };
  tpBox.append(tf.el);

  // Quelle: neu starten (Eingangs-Node der Leitungsart) oder vorhandenen Node verwenden
  const initEx = (d.transport as { existing?: Record<string, unknown> }).existing;
  let sourceMode: "new" | "existing" = initEx || d.kind === "mxl" ? "existing" : "new";
  const ex = existingFields(initEx);
  const srcSeg = segmented([{ value: "new", label: t("mcr.src.new") }, { value: "existing", label: t("mcr.src.existing") }], sourceMode, (v) => {
    sourceMode = v as "new" | "existing";
    syncSource();
  });
  const syncSource = () => {
    tpBox.style.display = sourceMode === "new" && kind !== "mxl" ? "" : "none";
    ex.el.style.display = sourceMode === "existing" || kind === "mxl" ? "" : "none";
    srcSeg.style.display = kind === "mxl" ? "none" : "";
  };

  // abweichendes Hausformat
  const ownHouse = h("input", { type: "checkbox" }) as HTMLInputElement;
  ownHouse.checked = !!d.houseFormat && Object.keys(d.houseFormat).length > 0;
  const hf = houseFields(d.houseFormat as HouseDraft | undefined);
  const hfBox = h("div", {}, hf.el);
  hfBox.style.display = ownHouse.checked ? "" : "none";
  ownHouse.addEventListener("change", () => (hfBox.style.display = ownHouse.checked ? "" : "none"));

  // Verarbeitungskette (erbt vom Event oder global, oder eigene)
  const chain = chainEditor(d.chain as Stage[] | null | undefined, opts.stageTypes ?? [], { canInherit: true, inheritHint: t("mcr.chain.lineHint") });

  // Überwachung (Profil/Abweichungen der Leitung) und Aufzeichnung
  const mon = monitorEditor(d.monitoring as MonCfg | null | undefined, { withReactions: false });
  const recCfg = (d.record ?? {}) as { house?: boolean; profileId?: string; dir?: string };
  const recOn = h("input", { type: "checkbox" }) as HTMLInputElement;
  recOn.checked = !!recCfg.house;
  const recProfile = input(recCfg.profileId ?? "", { placeholder: "tams" });
  const recDir = input(recCfg.dir ?? "", { placeholder: "mcr/event" });
  const recBox = h("div", { class: "mcr-form-grid" }, field(t("mcr.rec.profile"), recProfile), field(t("mcr.rec.dir"), recDir));
  const syncRec = () => (recBox.style.display = recOn.checked ? "" : "none");
  recOn.addEventListener("change", syncRec);
  syncRec();

  // Rückweg
  const rc = (d.intercom as any)?.return as Record<string, any> | undefined;
  const wantRet = h("input", { type: "checkbox" }) as HTMLInputElement;
  wantRet.checked = !!rc;
  const retMode = select([{ value: "mix", label: t("mcr.ret.mix") }, { value: "guest", label: t("mcr.ret.guest") }], rc?.mode ?? "mix");
  const retSrcType = select([{ value: "line", label: t("mcr.ret.srcLine") }, { value: "mixer", label: t("mcr.ret.srcMixer") }], rc?.source?.type ?? "line");
  const retLine = select(others.map((o) => ({ value: o.id, label: o.name })), rc?.source?.lineId ?? others[0]?.id ?? "");
  const retRole = input(rc?.source?.role ?? "");
  const retAux = input(rc?.source?.auxId ?? "");
  const retComment = input(rc?.source?.commentChannel ?? "");
  const retSender = input(rc?.source?.sender ?? "");
  const retUri = input(rc?.transport?.uri ?? "", { placeholder: "srt://host:port" });
  const lineRow = h("div", { class: "mcr-form-grid" }, field(t("mcr.ret.srcLine"), retLine, t("mcr.ret.srcLineHint")));
  const mixRow = h("div", { class: "mcr-form-grid" }, field(t("mcr.ret.role"), retRole), field(t("mcr.ret.aux"), retAux), field(t("mcr.ret.comment"), retComment, t("mcr.ret.commentHint")), field(t("mcr.ret.sender"), retSender));
  const retBox = h("div", { class: "mcr-form" }, h("div", { class: "mcr-form-grid" }, field(t("mcr.ret.mode"), retMode), field(t("mcr.ret.srcType"), retSrcType)), lineRow, mixRow, h("div", { class: "mcr-form-grid" }, field(t("mcr.ret.target"), retUri, t("mcr.ret.targetHint"))));
  const syncRet = () => {
    retBox.style.display = wantRet.checked ? "" : "none";
    lineRow.style.display = retSrcType.value === "line" ? "" : "none";
    mixRow.style.display = retSrcType.value === "mixer" ? "" : "none";
  };
  wantRet.addEventListener("change", syncRet);
  retSrcType.addEventListener("change", syncRet);
  syncRet();

  const sw = (cb: HTMLInputElement, text: string) => h("label", { class: "mcr-sw" }, cb, text);
  body.append(
    field(t("mcr.f.name"), name),
    field(t("mcr.f.kind"), kindSeg),
    h("div", { class: "mcr-fieldset" }, h("h3", {}, t("mcr.f.transport")), srcSeg, tpBox, ex.el),
    h("div", { class: "mcr-fieldset" }, sw(ownHouse, t("mcr.f.ownHouse")), hfBox),
    h("div", { class: "mcr-fieldset" }, h("h3", {}, t("mcr.chain.title")), chain.el),
    h("div", { class: "mcr-fieldset" }, h("h3", {}, t("mcr.mon.title")), mon.el),
    h("div", { class: "mcr-fieldset" }, h("h3", {}, t("mcr.rec.title")), h("label", { class: "mcr-sw" }, recOn, t("mcr.rec.house")), recBox, note(t("mcr.rec.hint"))),
    h("div", { class: "mcr-fieldset" }, sw(wantRet, t("mcr.f.wantReturn")), retBox),
  );

  syncSource();
  return modal<LineDraft>(initial ? t("mcr.line.edit") : t("mcr.line.add"), body, {
    save: t("mcr.apply"),
    wide: true,
    onSave: () => {
      let transport = tf.read();
      if (sourceMode === "existing" || kind === "mxl") {
        const picked = ex.read();
        if (!picked) throw new Error(t("mcr.err.line.source"));
        transport = { existing: picked };
      }
      const out: LineDraft = { ...d, name: name.value.trim(), kind, transport };
      const monitoring = mon.read();
      if (monitoring) out.monitoring = monitoring as Record<string, unknown>;
      else delete out.monitoring;
      if (recOn.checked) out.record = { house: true, profileId: recProfile.value.trim(), ...(recDir.value.trim() ? { dir: recDir.value.trim() } : {}) };
      else delete out.record;
      const chosen = chain.read();
      if (chosen === null) delete out.chain;
      else out.chain = chosen as unknown[];
      out.houseFormat = null;
      if (ownHouse.checked) {
        const hd = hf.read();
        const bad = validateHouse(hd);
        if (bad.length) throw new Error(bad.map((k) => t(`mcr.err.house.${k}`)).join("\n"));
        out.houseFormat = hd as Record<string, unknown>;
      }
      const intercom = { ...(d.intercom ?? {}) } as Record<string, any>;
      if (wantRet.checked) {
        const source = retSrcType.value === "line" ? { type: "line", lineId: retLine.value } : { type: "mixer", role: retRole.value.trim(), auxId: retAux.value.trim(), commentChannel: retComment.value.trim(), sender: retSender.value.trim() };
        const ret: Record<string, unknown> = { mode: retMode.value, source };
        if (retMode.value === "mix" && retUri.value.trim()) ret.transport = { uri: retUri.value.trim() };
        intercom.return = ret;
      } else delete intercom.return;
      out.intercom = intercom;
      const bad = validateLine(out);
      if (bad.length) throw new Error(bad.map((k) => t(`mcr.err.line.${k}`)).join("\n"));
      return out;
    },
  });
}
