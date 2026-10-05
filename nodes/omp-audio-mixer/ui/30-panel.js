// ───────────────────────────── Panel (Custom Element) ─────────────────────────────

const PRESETS = [
  ["auto", "Auto"],
  ["desktop", "Desktop"],
  ["compact", "Compact"],
  ["dense", "Dicht"],
  ["grid", "Grid"],
  ["touch", "Touch"],
];
const DEFAULT_UI = { preset: "auto", mode: "mix", showFaders: null, columns: 0, meterSize: "m", selected: "", centerTab: "in", centerOpen: false, collapsed: {} };

const emptyState = () => ({ channels: [], groups: [], duckRules: [], auxBuses: [], auxFree: 0, scenes: [], contextRules: [], audioContext: { activeSources: [], activeScene: "" }, availableSources: [], availableNodes: [], masterLimiter: { enabled: false, thresholdDb: -6, ratio: 10, makeupDb: 0 } });

const CSS = `
:host{display:block;font-family:var(--omp-font,system-ui,sans-serif);color:var(--c-text);
  --c-bg:var(--omp-bg,#101214);--c-surface:var(--omp-surface,#1a1d21);--c-surface2:#22262b;--c-border:var(--omp-border,#2e3338);
  --c-text:var(--omp-text,#e8eaed);--c-dim:var(--omp-text-dim,#9aa0a6);--c-accent:var(--omp-accent,#4aa3ff);
  --c-air:#2fbf71;--c-mute:#e5484d;--c-auto:#4aa3ff;--c-duck:#b57bff;--c-manual:#f5a524;
  --thumb:16px;--hit:34px;font-size:13px}
@media (pointer:coarse){:host{--thumb:26px;--hit:48px;font-size:14px}}
*{box-sizing:border-box}
[hidden]{display:none!important}
button,select,input{font:inherit;color:inherit}
button{cursor:pointer}
:focus-visible{outline:2px solid var(--c-accent);outline-offset:2px}
.root{background:var(--c-bg);border:1px solid var(--c-border);border-radius:8px;display:flex;flex-direction:column;min-height:320px;position:relative}
/* Toolbar */
.toolbar{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--c-border);background:var(--c-surface)}
.tgrp{display:flex;gap:2px;align-items:center;flex-wrap:wrap}
.tgrp>.lbl{color:var(--c-dim);font-size:11px;margin-right:4px;text-transform:uppercase}
.tb{min-height:var(--hit);min-width:var(--hit);padding:0 12px;border:1px solid var(--c-border);background:var(--c-surface2);border-radius:6px}
.tb[aria-pressed=true]{background:var(--c-accent);color:#04121f;border-color:var(--c-accent);font-weight:600}
.tb.mode[aria-pressed=true]{background:var(--c-text);color:var(--c-bg)}
.tsel{min-height:var(--hit);background:var(--c-surface2);border:1px solid var(--c-border);border-radius:6px;padding:0 6px}
.spacer{flex:1}
.scenebar{display:flex;gap:4px;flex-wrap:wrap}
.scenebar .tb[aria-pressed=true]{background:var(--c-air);border-color:var(--c-air);color:#03140a}
.master{display:flex;align-items:center;gap:8px}
.master .mm{width:160px;height:12px;position:relative}
.master details{position:relative}
.master summary{list-style:none;cursor:pointer}
.master .pop{position:absolute;right:0;top:calc(100% + 4px);z-index:30;background:var(--c-surface);border:1px solid var(--c-border);border-radius:8px;padding:10px;width:260px;box-shadow:0 8px 24px #0008}
/* Body / Layout */
.body{display:grid;gap:0;min-height:0;flex:1}
.root[data-layout=side] .body{grid-template-columns:minmax(0,1fr) minmax(340px,430px)}
.root[data-layout=stacked] .body,.root[data-layout=sheet] .body{grid-template-columns:minmax(0,1fr)}
.channels{overflow:auto;padding:10px;min-height:220px;max-height:calc(100vh - 140px);overscroll-behavior:contain}
.root[data-layout=stacked] .channels{max-height:60vh}
.center{border-left:1px solid var(--c-border);background:var(--c-surface);overflow:auto;max-height:calc(100vh - 140px)}
.root[data-layout=stacked] .center{border-left:0;border-top:1px solid var(--c-border);max-height:none}
.root[data-layout=sheet] .center{position:fixed;left:0;right:0;bottom:0;max-height:72vh;z-index:40;border-top:2px solid var(--c-accent);border-left:0;border-radius:14px 14px 0 0;box-shadow:0 -8px 30px #000a;transform:translateY(0)}
.root[data-center=closed] .center{display:none}
.center-inner{padding:8px 10px 14px}
.chead2{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.ctitle{flex:1;font-weight:700;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav{min-width:var(--hit);min-height:var(--hit);border:1px solid var(--c-border);background:var(--c-surface2);border-radius:6px}
.tabs{display:flex;gap:4px;overflow-x:auto;padding-bottom:6px;scrollbar-width:thin;-webkit-overflow-scrolling:touch}
.tab{flex:0 0 auto;min-height:var(--hit);padding:0 12px;border:1px solid var(--c-border);background:var(--c-surface2);border-radius:6px;font-size:12px;font-weight:600}
.tab[aria-selected=true]{background:var(--c-accent);color:#04121f;border-color:var(--c-accent)}
.empty{color:var(--c-dim);padding:20px}
.csec{margin:10px 0;padding:10px;border:1px solid var(--c-border);border-radius:8px;background:var(--c-bg)}
.csec h3{margin:0 0 8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--c-dim)}
.cgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px 14px;align-items:end}
.band{min-width:0}.band h4{margin:0 0 6px;font-size:11px;color:var(--c-dim)}
.bands{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.hint{color:var(--c-dim);font-size:12px;margin:6px 0 0}
.hint.status[data-err="1"]{color:var(--c-mute)}
.rows{display:flex;flex-direction:column;gap:6px}
.row{display:flex;gap:6px 10px;align-items:center;flex-wrap:wrap}
.row .rname{flex:1 1 120px;font-weight:600}
.row .slider{flex:1 1 180px}
.row[data-locked="1"]{opacity:.6}
.arrow{color:var(--c-dim)}
.card{border:1px solid var(--c-border);border-radius:8px;padding:8px;margin-bottom:8px;background:var(--c-surface)}
/* Controls */
.tog{min-height:var(--hit);min-width:var(--hit);padding:0 12px;border:1px solid var(--c-border);background:var(--c-surface2);border-radius:6px;font-weight:600}
.tog[aria-pressed=true]{background:var(--c-accent);color:#04121f;border-color:var(--c-accent)}
.tog.danger{border-color:#7a2a2d;color:#ff9a9d}
.tog:disabled{opacity:.45;cursor:not-allowed}
.tog.wide{width:100%;text-align:left}
.seg{display:flex;gap:2px;flex-wrap:wrap}
.field{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--c-dim)}
.sel-input,.text-input{min-height:var(--hit);background:var(--c-surface2);border:1px solid var(--c-border);border-radius:6px;padding:0 8px;color:var(--c-text);min-width:0}
.text-input{flex:1 1 160px}
.picker{border:1px solid var(--c-border);border-radius:6px;margin:6px 0;padding:2px 8px}
.picker summary{min-height:var(--hit);display:flex;align-items:center;cursor:pointer}
.checks{display:flex;flex-wrap:wrap;gap:4px 12px;padding:4px 0 8px}
.chk{display:flex;align-items:center;gap:6px;min-height:28px}
.chk input{width:18px;height:18px}
.slider{display:flex;flex-direction:column;gap:2px;min-width:0}
.shead{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--c-dim)}
.sval{color:var(--c-text);font-variant-numeric:tabular-nums}
.srange{position:relative;height:var(--hit);touch-action:none;cursor:pointer}
.srange::before{content:"";position:absolute;left:0;right:0;top:50%;height:4px;margin-top:-2px;background:var(--c-border);border-radius:2px}
.sfill{position:absolute;top:50%;height:4px;margin-top:-2px;background:var(--c-accent);border-radius:2px}
.sthumb{position:absolute;top:50%;width:var(--thumb);height:var(--thumb);margin-top:calc(var(--thumb)/-2);background:var(--c-text);border-radius:50%;box-shadow:0 1px 4px #0008}
.srange.drag .sthumb{background:var(--c-accent)}
.eqplot{width:100%;height:220px;display:block;background:var(--c-surface);border-radius:6px;touch-action:none;--c-text:#e8eaed}
.grm{display:flex;align-items:center;gap:8px}
.grl{width:80px;color:var(--c-dim);font-size:11px}
.grbar{flex:1;height:14px;background:var(--c-border);border-radius:3px;position:relative;overflow:hidden}
.grfill{position:absolute;right:0;top:0;bottom:0;width:calc(var(--g,0)*100%);background:var(--c-manual)}
.grval{width:70px;text-align:right;font-variant-numeric:tabular-nums}
.livebig{display:block;margin-top:8px;font-weight:700;font-variant-numeric:tabular-nums}
.scene-go{flex:1 1 140px;min-height:calc(var(--hit) + 6px)}
.scene-go[aria-pressed=true]{background:var(--c-air);border-color:var(--c-air);color:#03140a}
/* Gruppen */
.group{margin-bottom:12px}
.ghead{display:flex;align-items:center;gap:8px;margin:0 0 6px;padding:2px 4px;border-bottom:1px solid var(--c-border)}
.ghead .gname{font-weight:700;background:none;border:0;text-align:left;padding:4px 2px;min-height:var(--hit)}
.ghead .gcnt{color:var(--c-dim);font-size:11px;flex:1}
.gtoggle{min-width:var(--hit);min-height:var(--hit);background:none;border:0;font-size:14px}
.gmute{min-height:var(--hit);padding:0 10px;border:1px solid var(--c-border);background:var(--c-surface2);border-radius:6px}
.gmute[aria-pressed=true]{background:var(--c-mute);color:#fff;border-color:var(--c-mute)}
.gbody{display:flex;gap:8px;flex-wrap:wrap;align-items:stretch}
/* Kanal */
.ch{position:relative;border:1px solid var(--c-border);border-radius:8px;background:var(--c-surface);padding:6px;display:grid;gap:5px;min-width:0}
.ch[data-selected="1"]{border-color:var(--c-accent);box-shadow:0 0 0 2px var(--c-accent) inset}
.ch[data-onair="1"]{border-top:3px solid var(--c-air)}
.ch[data-muted="1"]{background:repeating-linear-gradient(135deg,var(--c-surface) 0 8px,#1f1416 8px 16px)}
.chead{display:flex;align-items:center;gap:6px;min-width:0}
.sig{flex:0 0 8px;width:8px;height:8px;border-radius:50%;background:var(--c-border)}
.sig[data-on="1"]{background:var(--c-air)}
.name{flex:1;min-width:0;min-height:var(--hit);background:none;border:0;text-align:left;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 2px}
.name[aria-pressed=true]{color:var(--c-accent)}
.badges{display:flex;flex-wrap:wrap;gap:3px;min-height:18px}
.b{font-size:10px;font-weight:700;line-height:1;padding:3px 5px;border-radius:3px;border:1px solid var(--c-border);white-space:nowrap;font-variant-numeric:tabular-nums}
.b.onair[data-state=air]{background:var(--c-air);color:#03140a;border-color:var(--c-air)}
.b.onair[data-state=muted]{background:var(--c-mute);color:#fff;border-color:var(--c-mute)}
.b.onair[data-state=off]{color:var(--c-dim);border-style:dashed}
.b.auto{border-color:var(--c-auto);color:var(--c-auto);border-radius:10px}
.b.duck{border-color:var(--c-duck);color:var(--c-duck);border-style:double;border-width:3px}
.b.manual{background:var(--c-manual);color:#201300;border-color:var(--c-manual)}
.b.media{border-color:var(--c-dim);color:var(--c-dim)}
.b.pfl{background:var(--c-accent);color:#04121f;border-color:var(--c-accent)}
.meterwrap{position:relative}
.meter{position:relative;background:#0b0d0f;border-radius:3px;overflow:hidden;--v:0;--p:0}
.mfill{position:absolute;inset:0;clip-path:inset(calc((1 - var(--v,0))*100%) 0 0 0);background:linear-gradient(to top,#2fbf71 0 70%,#e6c229 70% 90%,#e5484d 90%)}
.mpeak{position:absolute;background:#fff;opacity:.85}
.meter[data-hot="1"]{box-shadow:0 0 0 1px var(--c-mute)}
.fader{position:relative;user-select:none;-webkit-user-select:none}
/* Scroll und Fader dürfen sich nicht ins Gehege kommen: der Fader nimmt nur Gesten in SEINER Achse, die andere Achse scrollt weiter die Kanalliste. */
.fader[aria-orientation=vertical]{touch-action:pan-x}
.fader[aria-orientation=horizontal]{touch-action:pan-y}
.ftrack{position:absolute;background:var(--c-border);border-radius:2px}
.fzero{position:absolute;background:var(--c-dim)}
.fthumb{position:absolute;width:var(--thumb);height:var(--thumb);background:var(--c-text);border-radius:4px;box-shadow:0 1px 5px #000a}
.fader.drag .fthumb{background:var(--c-accent)}
.fader.fine .fthumb{outline:2px dashed var(--c-manual)}
.fread{position:absolute;font-size:11px;font-variant-numeric:tabular-nums;color:var(--c-dim);white-space:nowrap}
.btns{display:flex;gap:4px}
.btns .tog{flex:1;min-width:0;padding:0 2px;font-size:11px}
.tog.mute[aria-pressed=true]{background:var(--c-mute);color:#fff;border-color:var(--c-mute)}
.tog.solo[aria-pressed=true]{background:var(--c-accent);color:#04121f}
.tog .l{display:none}
/* ───── Varianten ───── */
/* full: vertikaler Kanalzug (Meter + Fader) */
.channels[data-variant=full] .ch,.channels[data-variant=compact] .ch{width:var(--strip-w,112px);grid-template-columns:var(--meter-w,16px) 1fr;grid-template-areas:"head head" "badges badges" "meter fader" "btns btns";grid-template-rows:auto auto var(--strip-h,300px) auto}
.channels[data-variant=compact] .ch{width:var(--strip-w,96px)}
.channels[data-variant=full] .ch>.chead,.channels[data-variant=compact] .ch>.chead{grid-area:head}
.channels[data-variant=full] .ch>.badges,.channels[data-variant=compact] .ch>.badges{grid-area:badges}
.channels[data-variant=full] .ch>.meterwrap,.channels[data-variant=compact] .ch>.meterwrap{grid-area:meter;display:flex}
.channels[data-variant=full] .ch>.fader{grid-area:fader}
.channels[data-variant=full] .ch>.btns,.channels[data-variant=compact] .ch>.btns{grid-area:btns}
.channels[data-variant=full] .meter,.channels[data-variant=compact] .meter,.channels[data-variant=gridf] .meter{width:100%;height:100%}
.channels[data-variant=full] .mfill,.channels[data-variant=compact] .mfill,.channels[data-variant=gridf] .mfill{clip-path:inset(calc((1 - var(--v))*100%) 0 0 0)}
.channels[data-variant=full] .mpeak,.channels[data-variant=compact] .mpeak,.channels[data-variant=gridf] .mpeak{left:0;right:0;height:2px;bottom:calc(var(--p)*100%)}
.channels[data-faders="1"] .fader{min-height:100px;margin-left:4px}
.channels[data-variant=full] .ftrack,.channels[data-variant=gridf] .ftrack{left:50%;top:6px;bottom:6px;width:4px;margin-left:-2px}
.channels[data-variant=full] .fzero,.channels[data-variant=gridf] .fzero{left:calc(50% - 10px);width:20px;height:1px}
.channels[data-variant=full] .fread,.channels[data-variant=gridf] .fread{left:0;right:0;top:-2px;text-align:center}
.channels[data-faders="0"] .fader{display:none}
.channels[data-variant=compact] .ch,.channels[data-faders="0"][data-variant=full] .ch{grid-template-columns:1fr}
.channels[data-faders="0"][data-variant=full] .ch,.channels[data-variant=compact] .ch{grid-template-areas:"head" "badges" "meter" "btns";grid-template-rows:auto auto var(--strip-h,300px) auto}
.channels[data-faders="0"][data-variant=full] .ch>.meterwrap,.channels[data-variant=compact] .ch>.meterwrap{justify-content:center}
.channels[data-faders="0"][data-variant=full] .meter,.channels[data-variant=compact] .meter{width:36px}
/* dense: nur Name/On-Air/Mute/Select/Auto + dünner Aktivitätsbalken */
.channels[data-variant=dense] .ch{width:var(--cell-w,150px);grid-template-columns:1fr auto;grid-template-areas:"head head" "badges badges" "meter meter" "btns btns";padding:4px}
.channels[data-variant=dense] .ch>.chead{grid-area:head}.channels[data-variant=dense] .ch>.badges{grid-area:badges}.channels[data-variant=dense] .ch>.meterwrap{grid-area:meter}.channels[data-variant=dense] .ch>.btns{grid-area:btns}
.channels[data-variant=dense] .fader{display:none}
/* grid / grid + fader / touch */
.channels[data-variant=grid] .gbody,.channels[data-variant=gridf] .gbody,.channels[data-variant=dense] .gbody,.channels[data-variant=touch] .gbody,.channels[data-variant=touchf] .gbody{display:grid;grid-template-columns:repeat(var(--cols,auto-fill),minmax(var(--cell-min,128px),1fr))}
.channels[data-variant=grid] .ch,.channels[data-variant=gridf] .ch,.channels[data-variant=touch] .ch,.channels[data-variant=touchf] .ch,.channels[data-variant=dense] .ch{width:auto}
.channels[data-variant=grid] .ch,.channels[data-variant=touch] .ch,.channels[data-variant=touchf][data-faders="0"] .ch{grid-template-columns:1fr;grid-template-areas:"head" "badges" "meter" "btns"}
.channels[data-variant=dense] .gbody{--cell-min:128px}
.channels[data-variant=grid] .meterwrap,.channels[data-variant=touch] .meterwrap,.channels[data-variant=dense] .meterwrap{height:var(--hbar,14px)}
.channels[data-variant=grid] .meter,.channels[data-variant=touch] .meter,.channels[data-variant=dense] .meter,.channels[data-variant=touchf] .meter{width:100%;height:100%}
.channels[data-variant=grid] .mfill,.channels[data-variant=touch] .mfill,.channels[data-variant=dense] .mfill,.channels[data-variant=touchf] .mfill{clip-path:inset(0 calc((1 - var(--v))*100%) 0 0);background:linear-gradient(to right,#2fbf71 0 70%,#e6c229 70% 90%,#e5484d 90%)}
.channels[data-variant=grid] .mpeak,.channels[data-variant=touch] .mpeak,.channels[data-variant=dense] .mpeak,.channels[data-variant=touchf] .mpeak{top:0;bottom:0;width:2px;left:calc(var(--p)*100%)}
.channels[data-variant=gridf] .ch{grid-template-columns:var(--meter-w,14px) 1fr;grid-template-areas:"head head" "badges badges" "meter fader" "btns btns";grid-template-rows:auto auto var(--strip-h,200px) auto}
.channels[data-variant=gridf] .ch>.chead{grid-area:head}.channels[data-variant=gridf] .ch>.badges{grid-area:badges}.channels[data-variant=gridf] .ch>.meterwrap{grid-area:meter;display:flex}.channels[data-variant=gridf] .ch>.fader{grid-area:fader}.channels[data-variant=gridf] .ch>.btns{grid-area:btns}
.channels[data-variant=gridf][data-faders="0"] .ch{grid-template-columns:1fr;grid-template-areas:"head" "badges" "meter" "btns";grid-template-rows:auto auto auto auto}
.channels[data-variant=gridf][data-faders="0"] .meterwrap{height:14px}
.channels[data-variant=gridf][data-faders="0"] .meter{width:100%;height:100%}
.channels[data-variant=gridf][data-faders="0"] .mfill{clip-path:inset(0 calc((1 - var(--v))*100%) 0 0);background:linear-gradient(to right,#2fbf71 0 70%,#e6c229 70% 90%,#e5484d 90%)}
.channels[data-variant=gridf][data-faders="0"] .mpeak{top:0;bottom:0;width:2px;left:calc(var(--p)*100%);height:auto}
/* touch: große Ziele, horizontaler Fader */
.channels[data-variant=touch] .ch,.channels[data-variant=touchf] .ch{--hit:52px;--thumb:34px;padding:8px}
.channels[data-variant=touch] .name,.channels[data-variant=touchf] .name{font-size:15px}
.channels[data-variant=touch] .tog .s,.channels[data-variant=touchf] .tog .s{display:none}
.channels[data-variant=touch] .tog .l,.channels[data-variant=touchf] .tog .l{display:inline}
.channels[data-variant=touchf] .ch{grid-template-columns:1fr;grid-template-areas:"head" "badges" "meter" "fader" "btns";grid-template-rows:auto auto auto 64px auto}
.channels[data-variant=touchf] .ch>.chead{grid-area:head}.channels[data-variant=touchf] .ch>.badges{grid-area:badges}.channels[data-variant=touchf] .ch>.meterwrap{grid-area:meter;height:16px}.channels[data-variant=touchf] .ch>.fader{grid-area:fader}.channels[data-variant=touchf] .ch>.btns{grid-area:btns}
.channels[data-variant=touchf] .ftrack{top:50%;left:6px;right:6px;height:6px;margin-top:-3px}
.channels[data-variant=touchf] .fzero{top:calc(50% - 12px);height:24px;width:1px}
.channels[data-variant=touchf] .fread{right:6px;top:2px}
.channels[data-variant=touchf] .fader{min-height:64px}
.channels[data-variant=touchf] .fthumb{width:var(--thumb);height:44px;top:calc(50% - 22px)!important}
.channels[data-meter=s]{--strip-h:220px;--hbar:10px}
.channels[data-meter=l]{--strip-h:400px;--hbar:20px}
.channels[data-meter=m]{--strip-h:300px;--hbar:14px}
.channels[data-variant=gridf][data-meter=s]{--strip-h:160px}.channels[data-variant=gridf][data-meter=m]{--strip-h:220px}.channels[data-variant=gridf][data-meter=l]{--strip-h:300px}
/* Dialog + Live-Region */
.modal{position:fixed;inset:0;background:#000a;display:flex;align-items:center;justify-content:center;z-index:100}
.modal .box{background:var(--c-surface);border:1px solid var(--c-border);border-radius:10px;padding:18px;max-width:360px}
.modal .acts{display:flex;gap:8px;margin-top:14px;justify-content:flex-end}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.toastbar{padding:6px 12px;color:var(--c-dim);font-size:12px}
.root[data-layout=sheet] .toolbar .tgrp.opt{display:none}
.presetsel{display:none}
.root[data-layout=sheet] .presetbtns{display:none}
.root[data-layout=sheet] .presetsel{display:block}
.root[data-layout=sheet] .master .limit{display:none}
.root[data-layout=sheet] .toolbar{gap:6px 8px}
@media (max-height:520px){
  .toolbar{padding:4px 8px;gap:4px 8px}
  .tb,.tsel{min-height:36px}
  .tgrp.opt{display:none}
  .presetbtns{display:none}
  .presetsel{display:block}
  .channels,.center{max-height:calc(100vh - 56px)}
  .master .limit{display:none}
}
.cthandle{display:none;position:fixed;left:0;right:0;bottom:0;z-index:35;min-height:52px;border:0;border-top:2px solid var(--c-accent);background:var(--c-surface);font-weight:700;font-size:14px}
.root[data-layout=sheet][data-center=closed] .cthandle[data-has="1"]{display:block}
.root[data-layout=sheet][data-center=closed] .channels{padding-bottom:70px}
.root[data-layout=sheet] .channels{max-height:none;padding-bottom:90px}
`;

class MixerApp {
  constructor(host, nodeId) {
    this.host = host;
    this.nodeId = nodeId;
    this.shadow = host.attachShadow({ mode: "open" });
    this.state = emptyState();
    this.live = new Map();
    this.masterLive = { rms: 0, peak: 0, gr: 0 };
    this.views = new Map();
    this.nodes = [];
    this.touchedAt = 0;
    this.pending = new Map();
    this.flushTimer = null;
    this.width = 0;
    this.layout = "side";
    this.ui = this.loadUi();
    this.lastSig = "";
    this.build();
    this.center = new CenterControl(this);
    this.centerHost.append(this.center.root);
    this.center.tabId = this.ui.centerTab || "in";
    this.center.mount();
    this.applyUiToToolbar();
    this.layoutNow();
    this.poll();
    this.loadNodes();
    this.timers = [setInterval(() => this.poll(), 1500), setInterval(() => this.loadNodes(), 15000)];
    this.openStream();
    this.raf = requestAnimationFrame((t) => this.tick(t));
    this.ro = new ResizeObserver(() => this.layoutNow());
    this.ro.observe(host);
    window.addEventListener("orientationchange", () => this.layoutNow());
  }

  destroy() {
    for (const t of this.timers) clearInterval(t);
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.source?.close();
  }

  // ───── UI-Präferenzen (nur Darstellung) ─────
  get storageKey() {
    return "omp-mixer-ui:" + this.nodeId;
  }
  loadUi() {
    try {
      return { ...DEFAULT_UI, ...JSON.parse(localStorage.getItem(this.storageKey) || "{}") };
    } catch {
      return { ...DEFAULT_UI };
    }
  }
  saveUi() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.ui));
    } catch {}
  }

  // ───── Aufbau ─────
  build() {
    const style = h("style");
    style.textContent = CSS;
    this.root = h("div", { class: "root", tabindex: "-1" });
    // Toolbar
    this.presetSel = h("select", { class: "tsel presetsel", "aria-label": "Ansicht" }, ...PRESETS.map(([id, label]) => h("option", { value: id, text: "Ansicht: " + label })));
    this.presetSel.addEventListener("change", () => this.setPreset(this.presetSel.value));
    const presetBtns = PRESETS.map(([id, label]) => h("button", { class: "tb", type: "button", "data-preset": id, "aria-pressed": "false", text: label, onclick: () => this.setPreset(id) }));
    this.presetBtns = presetBtns;
    this.modeBtns = [["operate", "Operate"], ["mix", "Mix"]].map(([id, label]) => h("button", { class: "tb mode", type: "button", "data-mode": id, "aria-pressed": "false", text: label, title: id === "operate" ? "Betrieb: Übersicht, Fader ausgeblendet" : "Mischen: Fader + Center Control", onclick: () => this.setMode(id) }));
    this.faderBtn = h("button", { class: "tb", type: "button", "aria-pressed": "true", text: "Fader", title: "Fader ein-/ausblenden (nur Darstellung, Pegel bleiben erhalten)", onclick: () => this.toggleFaders() });
    this.colSel = h("select", { class: "tsel", "aria-label": "Spalten" }, h("option", { value: "0", text: "Spalten: auto" }), ...[1, 2, 3, 4, 5, 6, 8, 10].map((n) => h("option", { value: String(n), text: n + " Spalten" })));
    this.colSel.addEventListener("change", () => { this.ui.columns = Number(this.colSel.value); this.saveUi(); this.applyLayoutVars(); });
    this.meterSel = h("select", { class: "tsel", "aria-label": "Metergröße" }, ...[["s", "Meter klein"], ["m", "Meter mittel"], ["l", "Meter groß"]].map(([v, t]) => h("option", { value: v, text: t })));
    this.meterSel.addEventListener("change", () => { this.ui.meterSize = this.meterSel.value; this.saveUi(); this.applyLayoutVars(); });
    this.sceneBar = h("div", { class: "scenebar", role: "group", "aria-label": "Szenen" });
    this.addBtn = h("button", { class: "tb", type: "button", text: "+ Kanal", onclick: () => this.cmd("addChannel", { label: "" }).then(() => this.poll()) });
    this.groupBtn = h("button", { class: "tb", type: "button", text: "Ausgabegruppen", title: "Pro Ausgabegruppe (Admin → Audio-Ausgabe) einen Kanal anlegen, der automatisch die passende Quelle (Tag role.<Gruppe>) übernimmt", onclick: () => this.syncGroupChannels() });
    this.masterMeter = new Meter();
    this.masterMeter.root.className = "meter mm";
    this.masterMeter.root.style.cssText = "width:160px;height:12px";
    this.limBtn = h("button", { class: "tb", type: "button", "aria-pressed": "false", text: "Limiter", onclick: () => this.setLimiter({ enabled: !this.state.masterLimiter.enabled }) });
    const pop = h("div", { class: "pop" });
    this.limSliders = [];
    for (const [label, key, min, max, step, unit] of [["Threshold", "thresholdDb", -60, 0, 0.5, "dB"], ["Ratio", "ratio", 1, 20, 0.5, ":1"], ["Makeup", "makeupDb", 0, 24, 0.5, "dB"]]) {
      const s = new Slider({ label, min, max, step, unit, def: key === "ratio" ? 10 : key === "thresholdDb" ? -6 : 0, onInput: (v) => this.setLimiter({ [key]: v }) });
      this.limSliders.push([key, s]);
      pop.append(s.root);
    }
    this.limGr = h("div", { class: "hint", text: "GR 0.0 dB" });
    pop.append(this.limGr);
    this.limBtn.classList.add("limit");
    const limDetails = h("details", { class: "limit" }, h("summary", { class: "tb", text: "⚙ Limiter", title: "Master-Limiter einstellen" }), pop);
    const master = h("div", { class: "master" }, h("span", { class: "lbl", text: "Master" }), this.masterMeter.root, limDetails, this.limBtn);
    this.toolbar = h("header", { class: "toolbar" },
      h("div", { class: "tgrp presetbtns", role: "group", "aria-label": "Darstellung" }, h("span", { class: "lbl", text: "Ansicht" }), ...presetBtns),
      this.presetSel,
      h("div", { class: "tgrp", role: "group", "aria-label": "Betriebsart" }, ...this.modeBtns),
      h("div", { class: "tgrp opt" }, this.faderBtn, this.colSel, this.meterSel),
      this.sceneBar,
      h("span", { class: "spacer" }),
      master, this.groupBtn, this.addBtn);
    this.channelsEl = h("section", { class: "channels", "aria-label": "Kanäle" });
    this.centerHost = h("aside", { class: "center", "aria-label": "Center Control" });
    this.live_ = h("div", { class: "sr", role: "status", "aria-live": "polite" });
    this.body = h("div", { class: "body" }, this.channelsEl, this.centerHost);
    this.ctHandle = h("button", { class: "cthandle", type: "button", onclick: () => { this.ui.centerOpen = true; this.saveUi(); this.layoutNow(); } });
    this.root.append(this.toolbar, this.body, this.ctHandle, this.live_);
    this.shadow.append(style, this.root);
    this.root.addEventListener("keydown", (e) => this.onKey(e));
    this.channelsEl.addEventListener("scroll", () => {}, { passive: true });
  }

  applyUiToToolbar() {
    for (const b of this.presetBtns) b.setAttribute("aria-pressed", String(b.dataset.preset === this.ui.preset));
    for (const b of this.modeBtns) b.setAttribute("aria-pressed", String(b.dataset.mode === this.ui.mode));
    this.colSel.value = String(this.ui.columns);
    this.meterSel.value = this.ui.meterSize;
    this.faderBtn.setAttribute("aria-pressed", String(this.effectiveFaders()));
    this.presetSel.value = this.ui.preset;
  }
  setPreset(id) {
    this.ui.preset = id;
    this.ui.showFaders = null; // Preset-Standard
    this.saveUi();
    this.applyUiToToolbar();
    this.layoutNow(true);
  }
  setMode(m) {
    this.ui.mode = m;
    if (m === "operate") this.ui.centerOpen = false;
    this.saveUi();
    this.applyUiToToolbar();
    this.layoutNow(true);
  }
  toggleFaders() {
    this.ui.showFaders = !this.effectiveFaders();
    this.saveUi();
    this.applyUiToToolbar();
    this.layoutNow(true);
  }

  // ───── Layout (Responsive) ─────
  resolveVariant() {
    const w = this.width || this.host.clientWidth || 1000;
    const n = this.state.channels.length;
    const coarse = matchMedia("(pointer: coarse)").matches;
    let p = this.ui.preset;
    if (p === "auto") {
      if (w < 560) p = "grid";
      else if (coarse && w < 1300) p = "touch";
      else if (n > 16) p = "grid";
      else p = w < 900 ? "compact" : "desktop";
      if (this.ui.mode === "operate" && (p === "desktop" || p === "compact")) p = n > 10 ? "grid" : "compact";
    }
    return p === "desktop" ? "full" : p;
  }
  effectiveFaders() {
    if (this.ui.showFaders !== null && this.ui.showFaders !== undefined) return !!this.ui.showFaders;
    const v = this.resolveVariant();
    if (this.ui.mode === "operate") return false;
    return v === "full" || v === "touch";
  }
  layoutNow(force) {
    const w = this.host.clientWidth || this.width || 1000;
    const hgt = window.innerHeight;
    const landscape = window.innerWidth > window.innerHeight;
    this.width = w;
    let layout = "stacked";
    if (w >= 940 || (w >= 720 && landscape && hgt < 760)) layout = "side";
    else if (w < 600) layout = "sheet";
    // Auf kleinen Geräten im Querformat (z. B. Handy): Kanäle | Center Control nebeneinander.
    if (landscape && w >= 560 && w < 940 && window.innerHeight < 520) layout = "side";
    this.layout = layout;
    this.root.dataset.layout = layout;
    this.root.dataset.mode = this.ui.mode;
    const open = layout === "side" ? this.ui.mode === "mix" || this.ui.centerOpen : this.ui.centerOpen || (layout === "stacked" && this.ui.mode === "mix");
    this.root.dataset.center = open && this.state.channels.length ? "open" : "closed";
    this.applyLayoutVars();
    if (force || this.variantKey !== this.variantSig()) this.renderChannels(true);
  }
  variantSig() {
    return this.resolveVariant() + "|" + this.effectiveFaders() + "|" + this.ui.columns + "|" + this.ui.meterSize;
  }
  applyLayoutVars() {
    let v = this.resolveVariant();
    const faders = this.effectiveFaders();
    // "Grid + Fader" und "Touch + Fader" sind eigene Layouts derselben Kanallogik.
    if (v === "grid" && faders) v = "gridf";
    if (v === "touch" && faders) v = "touchf";
    this.channelsEl.dataset.variant = v;
    this.channelsEl.dataset.faders = faders ? "1" : "0";
    this.channelsEl.dataset.meter = this.ui.meterSize;
    const cols = this.ui.columns;
    this.channelsEl.style.setProperty("--cols", cols > 0 ? String(cols) : "auto-fill");
    // Mindestbreite je Zelle: lieber Spalten reduzieren, als Elemente zu verkleinern.
    const min = { grid: 128, gridf: 150, touch: 170, touchf: 190, dense: 128 }[v] || 128;
    this.channelsEl.style.setProperty("--cell-min", min + "px");
    this.variantKey = this.variantSig();
    this.centerHost.dataset.layout = this.layout;
    for (const view of this.views.values()) view.fader.setOrientation(v === "touchf" ? "horizontal" : "vertical");
    this.faderBtn?.setAttribute("aria-pressed", String(faders));
    const sel = this.cur();
    this.ctHandle.dataset.has = sel ? "1" : "0";
    this.ctHandle.textContent = sel ? `▲ ${sel.label} — Center Control` : "";
    this.root.dataset.center = (() => {
      const open = this.layout === "side" ? this.ui.mode === "mix" || this.ui.centerOpen : this.ui.centerOpen || (this.layout === "stacked" && this.ui.mode === "mix");
      return open && this.state.channels.length ? "open" : "closed";
    })();
  }

  // ───── Zustand ─────
  async poll() {
    try {
      const res = await fetch(`/api/v1/nodes/${this.nodeId}/params/mixState`);
      if (!res.ok) return;
      const doc = (await res.json()).value;
      if (!doc) return;
      // Während der Bedienung (und kurz danach) lokale Werte nicht überschreiben.
      if (performance.now() - this.touchedAt < 1500 && this.state.channels.length === doc.channels.length) return;
      this.state = { ...emptyState(), ...doc };
      this.afterState();
    } catch {}
  }
  afterState() {
    if (!this.autoGroupsTried && this.state.channels.length === 0 && this.state.groups.length === 0) {
      this.autoGroupsTried = true;
      this.syncGroupChannels();
    }
    const ids = this.state.channels.map((c) => c.id);
    if (!this.ui.selected || !ids.includes(this.ui.selected)) {
      this.ui.selected = ids[0] || "";
    }
    const sig = JSON.stringify([this.state.channels.map((c) => [c.id, c.group]), this.state.groups.map((g) => [g.id, g.label]), this.ui.collapsed]);
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.renderChannels(true);
    } else this.updateChannels();
    this.renderScenes();
    this.updateMasterUi();
    this.center.refresh();
    this.layoutNow();
  }
  // Je Ausgabegruppe der Audio-Regeln ein Kanal mit Tag-Erwartung (z. B. role.pt); vorhandene werden übersprungen.
  async syncGroupChannels() {
    let groups = [];
    try {
      const res = await fetch("/api/v1/audio-rules");
      if (res.ok) groups = ((await res.json()).outputProfile || {}).groups || [];
    } catch {}
    for (const g of groups) {
      const tags = (g.tags || []).map((t) => String(t).replace(":", "."));
      if (!tags.length) continue;
      const known = new Set(this.state.channels.map((c) => c.label));
      if (known.has(g.label)) continue;
      await this.cmd("addChannel", { label: g.label });
      await this.poll();
      const ch = this.state.channels.find((c) => c.label === g.label);
      if (ch) await this.cmd("setRouting", { channelId: ch.id, ruleJson: JSON.stringify({ required: tags }) });
    }
    await this.poll();
  }
  async loadNodes() {
    try {
      const res = await fetch("/api/v1/nodes");
      if (res.ok) this.nodes = (await res.json()).filter((n) => n.id !== this.nodeId).map((n) => ({ id: n.id, label: n.label }));
    } catch {}
  }
  cur() {
    return this.state.channels.find((c) => c.id === this.ui.selected) || null;
  }
  ctxFor(ch) {
    const g = this.state.groups.find((x) => x.id === ch.group);
    return { selected: ch.id === this.ui.selected, groupMuted: !!(g && g.mute), autoMixActive: !!(g && g.autoMixEnabled && ch.autoMix.enabled) };
  }

  // ───── Kommandos (Node-Methoden) ─────
  async cmd(method, args) {
    try {
      const res = await fetch(`/api/v1/nodes/${this.nodeId}/methods/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args || {}) });
      return res.ok;
    } catch {
      return false;
    }
  }
  /** Gedrosselt: pro Schlüssel gewinnt der letzte Wert (Regler-Ziehen erzeugt keine Anfragenflut). */
  sendNow(method, args, key, mutate) {
    mutate?.();
    this.touchedAt = performance.now();
    return new Promise((resolve) => {
      const prev = this.pending.get(key);
      this.pending.set(key, { method, args, resolvers: [...(prev ? prev.resolvers : []), resolve] });
      if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 50);
    });
  }
  sendCh(id, method, args, key) {
    return this.sendNow(`channel.${id}.${method}`, args, `${id}.${key || method}`);
  }
  async flush() {
    this.flushTimer = null;
    const items = [...this.pending.values()];
    this.pending.clear();
    await Promise.all(items.map(async (it) => { await this.cmd(it.method, it.args); it.resolvers.forEach((r) => r(true)); }));
    this.touchedAt = performance.now();
  }
  setGainLive(id, db) {
    const ch = this.state.channels.find((c) => c.id === id);
    if (ch) ch.gainDb = db;
    this.touchedAt = performance.now();
    this.sendCh(id, "setGain", { db }, "gain");
    if (id === this.ui.selected) this.center.refresh();
  }
  setGainCommit() {
    clearTimeout(this.flushTimer);
    this.flush();
  }
  toggleMute(id) {
    const ch = this.state.channels.find((c) => c.id === id);
    if (!ch) return;
    ch.mute = !ch.mute;
    this.sendCh(id, "setMute", { muted: ch.mute });
    this.updateChannel(ch);
    this.announce(`${ch.label} ${ch.mute ? "stumm" : "entstummt"}`);
  }
  togglePfl(id) {
    const ch = this.state.channels.find((c) => c.id === id);
    if (!ch) return;
    ch.pfl = !ch.pfl;
    this.sendCh(id, "setPfl", { enabled: ch.pfl });
    this.updateChannel(ch);
    this.center.refresh();
  }
  setLimiter(patch) {
    const l = Object.assign(this.state.masterLimiter, patch);
    this.sendNow("setMasterLimiter", { enabled: l.enabled, thresholdDb: l.thresholdDb, ratio: l.ratio, makeupDb: l.makeupDb }, "limiter");
    this.updateMasterUi();
  }
  confirm(message) {
    return new Promise((resolve) => {
      const done = (v) => { m.remove(); resolve(v); };
      const m = h("div", { class: "modal", role: "alertdialog", "aria-modal": "true", "aria-label": message },
        h("div", { class: "box" }, h("p", { text: message }), h("div", { class: "acts" }, h("button", { class: "tog", type: "button", text: "Abbrechen", onclick: () => done(false) }), h("button", { class: "tog danger", type: "button", text: "OK", onclick: () => done(true) }))));
      this.shadow.append(m);
      m.querySelector("button").focus();
    });
  }
  announce(text) {
    this.live_.textContent = "";
    setTimeout(() => (this.live_.textContent = text), 30);
  }

  // ───── Auswahl / Navigation ─────
  select(id, { open = false, focus = false } = {}) {
    this.ui.selected = id;
    if (open) this.ui.centerOpen = true;
    this.saveUi();
    this.updateChannels();
    this.center.refresh();
    this.layoutNow();
    if (focus) this.center.tabBar.querySelector("[aria-selected=true]")?.focus();
    const ch = this.state.channels.find((c) => c.id === id);
    if (ch) this.announce(`Kanal ${ch.label} ausgewählt`);
  }
  step(dir) {
    const ids = this.state.channels.map((c) => c.id);
    if (!ids.length) return;
    const i = ids.indexOf(this.ui.selected);
    this.select(ids[(i + dir + ids.length) % ids.length], { open: this.ui.centerOpen });
    this.views.get(this.ui.selected)?.root.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  closeCenter() {
    this.ui.centerOpen = false;
    this.saveUi();
    this.layoutNow();
  }
  onKey(e) {
    const t = e.composedPath()[0];
    if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const sel = this.cur();
    switch (e.key) {
      case "ArrowRight": case "ArrowDown": if (t && t.getAttribute && t.getAttribute("role") === "slider") return; this.step(1); break;
      case "ArrowLeft": case "ArrowUp": if (t && t.getAttribute && t.getAttribute("role") === "slider") return; this.step(-1); break;
      case "m": case "M": if (sel) this.toggleMute(sel.id); break;
      case "s": case "S": if (sel) this.togglePfl(sel.id); break;
      case "Enter": if (t && t.classList && t.classList.contains("name")) this.select(this.ui.selected, { open: true }); return;
      case "Escape": if (this.ui.centerOpen) this.closeCenter(); break;
      default: return;
    }
    e.preventDefault();
  }

  // ───── Rendering der Kanäle ─────
  renderChannels() {
    const st = this.state;
    const byGroup = new Map();
    for (const g of st.groups) byGroup.set(g.id, []);
    const loose = [];
    for (const ch of st.channels) (byGroup.has(ch.group) ? byGroup.get(ch.group) : loose).push(ch);
    const ids = new Set(st.channels.map((c) => c.id));
    for (const [id, v] of this.views) if (!ids.has(id)) { v.root.remove(); this.views.delete(id); }
    for (const ch of st.channels) if (!this.views.has(ch.id)) this.views.set(ch.id, new ChannelView(this, ch.id));
    const sections = [];
    const mk = (id, label, members, group) => {
      const collapsed = !!this.ui.collapsed[id];
      const body = h("div", { class: "gbody" }, collapsed ? null : members.map((c) => this.views.get(c.id).root));
      if (collapsed) for (const c of members) this.views.get(c.id).root.remove();
      let head = null;
      if (group || st.groups.length) {
        const tog = h("button", { class: "gtoggle", type: "button", "aria-expanded": String(!collapsed), "aria-label": (collapsed ? "Ausklappen " : "Einklappen ") + label, text: collapsed ? "▸" : "▾", onclick: () => { this.ui.collapsed[id] = !collapsed; this.saveUi(); this.lastSig = ""; this.renderChannels(); } });
        const name = h("button", { class: "gname", type: "button", text: label, title: "Gruppe: Details", onclick: () => { const f = members[0]; if (f) { this.ui.centerTab = "auto"; this.center.setTab("auto"); this.select(f.id, { open: true }); } } });
        const cnt = h("span", { class: "gcnt", text: `${members.length} Kanäle${group && group.autoMixEnabled ? " · AutoMix" : ""}` });
        head = h("div", { class: "ghead" }, tog, name, cnt);
        if (group) {
          head.append(h("button", { class: "gmute", type: "button", "aria-pressed": String(!!group.mute), text: "Gruppe stumm", onclick: () => { group.mute = !group.mute; this.cmd(`group.${group.id}.setMute`, { muted: group.mute }).then(() => this.poll()); this.updateChannels(); this.renderChannels(); } }));
        }
      }
      sections.push(h("div", { class: "group", "data-group": id }, head, body));
    };
    for (const g of st.groups) { const m = byGroup.get(g.id); if (m.length || true) mk(g.id, g.label, m, g); }
    if (loose.length) mk("_loose", st.groups.length ? "Ohne Gruppe" : "Kanäle", loose, null);
    if (!st.channels.length) sections.push(h("p", { class: "empty", text: 'Keine Kanäle — „+ Kanal“ zum Hinzufügen.' }));
    this.channelsEl.replaceChildren(...sections);
    this.applyLayoutVars();
    this.updateChannels();
  }
  updateChannels() {
    for (const ch of this.state.channels) this.updateChannel(ch);
  }
  updateChannel(ch) {
    const v = this.views.get(ch.id);
    if (v) v.update(ch, this.live.get(ch.id), this.ctxFor(ch));
  }
  renderScenes() {
    const key = JSON.stringify([this.state.scenes, this.state.audioContext.activeScene]);
    if (key === this.sceneKey) return;
    this.sceneKey = key;
    this.sceneBar.replaceChildren(...this.state.scenes.map((s) => h("button", { class: "tb", type: "button", text: s.label, "aria-pressed": String(this.state.audioContext.activeScene === s.id), title: "Szene aktivieren", onclick: () => this.cmd("activateScene", { sceneId: s.id }).then(() => { this.announce(`Szene ${s.label} aktiviert`); this.poll(); }) })));
  }
  updateMasterUi() {
    const l = this.state.masterLimiter;
    this.limBtn.setAttribute("aria-pressed", String(!!l.enabled));
    for (const [key, s] of this.limSliders) s.setValue(l[key]);
  }

  // ───── Live-Werte (SSE) ─────
  openStream() {
    const token = (() => { try { return localStorage.getItem("omp-auth-token"); } catch { return null; } })();
    const url = token ? `/api/v1/nodes/${this.nodeId}/stream/levelsUrl?access_token=${encodeURIComponent(token)}` : `/api/v1/nodes/${this.nodeId}/stream/levelsUrl`;
    this.source = new EventSource(url);
    this.source.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "dsp") {
        if (m.channelId == null) { this.masterLive.gr = m.compGr; return; }
        const l = this.live.get(m.channelId) || { rms: 0, peak: 0 };
        Object.assign(l, { compGr: m.compGr, gateGr: m.gateGr, autoDb: m.autoDb, duckDb: m.duckDb, onAir: m.onAir, dspAt: performance.now() });
        this.live.set(m.channelId, l);
        return;
      }
      if (m.channelId == null) { this.masterLive.rms = m.rms; this.masterLive.peak = m.peak; return; }
      const l = this.live.get(m.channelId) || { autoDb: 0, duckDb: 0, onAir: false, compGr: 0, gateGr: 0 };
      l.rms = m.rms; l.peak = m.peak;
      this.live.set(m.channelId, l);
    };
  }
  tick(now) {
    this.raf = requestAnimationFrame((t) => this.tick(t));
    if (now - (this.lastTick || 0) < 33) return; // ≈30 fps
    this.lastTick = now;
    for (const [id, v] of this.views) {
      const l = this.live.get(id);
      if (!l) continue;
      v.setLevel(l.rms || 0, l.peak || 0, now);
      const sig = (l.onAir ? 1 : 0) + "|" + Math.round((l.autoDb || 0) * 10) + "|" + Math.round((l.duckDb || 0) * 10);
      if (v.liveSig !== sig) {
        v.liveSig = sig;
        const ch = this.state.channels.find((c) => c.id === id);
        if (ch) v.update(ch, l, this.ctxFor(ch));
      }
    }
    this.masterMeter.set(this.masterLive.rms || 0, this.masterLive.peak || 0, now);
    const gr = "GR " + fmtSigned(this.masterLive.gr || 0) + " dB";
    if (this.limGr.textContent !== gr) this.limGr.textContent = gr;
    this.center.tickLive(now);
  }
}

class OmpAudioMixerPanel extends HTMLElement {
  connectedCallback() {
    this.app = new MixerApp(this, this.getAttribute("node-id"));
  }
  disconnectedCallback() {
    this.app?.destroy();
  }
}

if (!customElements.get("omp-audio-mixer-panel")) {
  customElements.define("omp-audio-mixer-panel", OmpAudioMixerPanel);
}
