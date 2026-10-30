// Formular für ein QC-Profil (Schwellen, Lautheit, Erwartungen an die Datei). Schreibt direkt in `p` (Arbeitskopie des Aufrufers).
import { t as tt } from "../host.ts";
import { check, el, field, grid, listInput, num, type NumOpts, select, text } from "./form-kit.ts";
import { type Cfg, FIELD_ORDERS } from "./settings-logic.ts";

const thresholdGroup = (title: string, obj: Cfg, rows: [string, string, NumOpts][]): HTMLElement => {
  const w = el("div", "display:flex;flex-direction:column;gap:4px;");
  w.append(el("div", "font-size:11px;font-weight:600;", title));
  const g = grid(3);
  for (const [key, label, opts] of rows) g.append(field(label, num(obj, key, opts)));
  w.append(g);
  return w;
};

export function buildProfileEditor(p: Cfg): HTMLElement {
  p.black ??= {};
  p.freeze ??= {};
  p.silence ??= {};
  p.loudness ??= {};
  p.sync ??= {};
  p.expect ??= {};
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

  return body;
}
