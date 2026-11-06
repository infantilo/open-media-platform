// ───────────────────────────── Konsole 2 (neue Oberfläche) ─────────────────────────────
//
// Zweite, dichte Pult-Oberfläche im Stil eines Hardware-Mischers: oben Kopfzeile, darunter die
// Detailansicht des gewählten Kanals (Input · Dynamik · EQ-Graph · Aux/Routing), unten die Reihe der
// Kanalzüge mit vertikalen Fadern (`<input type="range">`), Mute/Solo und Pegelanzeigen.
//
// Die Datenschicht (mixState-Poll, SSE-Pegel, Kommandos, Dialoge) wird von `MixerApp` geerbt — nur
// Aufbau und Darstellung sind neu. Die klassische Oberfläche bleibt unverändert und ist per Umschalter
// (localStorage `omp-mixer-skin`) jederzeit erreichbar.

const T2 = (() => {
  const D = {
    de: { classic: "Klassisch", clr: "CLR SOLO", more: "Mehr…", compact: "Kompakt", tipCompact: "Kompakte Ansicht: nur Kanalzüge, Details über „Mehr…“", outs: "Ausgänge", afv: "AFV", glob: "Global", addCh: "+ Kanal", scene: "● Szene", noScene: "Keine Szenen", filters: "FILTER", input: "INPUT", dyn: "DYNAMIK", routing: "ROUTING", aux: "AUX / N-1", noCh: "Kein Kanal gewählt", master: "MASTER", trim: "TRIM", noMain: "Programm", phase: "Ø", lock: "gesperrt", pre: "PRE", post: "POST", none: "— keine —", tipClassic: "Zur klassischen Oberfläche wechseln", tipMore: "Weitere Kanaleinstellungen (Delay, Pan, AutoMix, Ducking, Automation)", eqHint: "Punkte ziehen: waagerecht Frequenz, senkrecht Gain · Mausrad: Güte (Q)", gr: "GR" },
    en: { classic: "Classic", clr: "CLR SOLO", more: "More…", compact: "Compact", tipCompact: "Compact view: channel strips only, details via “More…”", outs: "Outputs", afv: "AFV", glob: "Global", addCh: "+ Channel", scene: "● Scene", noScene: "No scenes", filters: "FILTERS", input: "INPUT", dyn: "DYNAMICS", routing: "ROUTING", aux: "AUX / N-1", noCh: "No channel selected", master: "MASTER", trim: "TRIM", noMain: "Programme", phase: "Ø", lock: "locked", pre: "PRE", post: "POST", none: "— none —", tipClassic: "Switch to the classic surface", tipMore: "More channel settings (delay, pan, automix, ducking, automation)", eqHint: "Drag points: horizontal = frequency, vertical = gain · wheel: Q", gr: "GR" },
  };
  const lang = document.documentElement.lang === "en" ? "en" : "de";
  return (k) => D[lang][k] ?? D.de[k] ?? k;
})();

const SKIN_KEY = "omp-mixer-skin";
const getSkin = () => {
  try {
    const q = new URLSearchParams(location.search).get("skin");
    if (q === "v2" || q === "classic") return q;
    return localStorage.getItem(SKIN_KEY) === "classic" ? "classic" : "v2";
  } catch { return "v2"; }
};
const setSkin = (s) => { try { localStorage.setItem(SKIN_KEY, s); } catch {} };

const C2_PALETTE = ["#c9a46a", "#3fb36b", "#1fa4e6", "#27e0f0", "#ff4f9a", "#b57bff", "#f5a524", "#8fd14f"];
const C2_FADER_MARKS = [[12, "+12"], [6, "+6"], [0, "0"], [-6, "−6"], [-10, "−10"], [-20, "−20"], [-30, "−30"], [-40, "−40"], [-50, "−50"], [-60, "−∞"]];

const CSS2 = `
.c2{--bg:#111;--panel:#1a1a1a;--panel2:#202020;--line:#2c2c2c;--line2:#3a3a3a;--txt:#d8dde2;--dim:#7d848c;
  --cyan:#27e0f0;--blue:#1fa4e6;--green:#25d366;--pink:#ff4f9a;--orange:#ff9f1c;--amber:#ffb000;--red:#ff4040;--violet:#b57bff;
  --mono:ui-monospace,"JetBrains Mono","SF Mono",Menlo,Consolas,monospace;
  display:flex;flex-direction:column;background:var(--bg);color:var(--txt);font:11px/1.2 var(--mono);height:max(var(--c2-min,622px),var(--c2-h,calc(100vh - 6px)));min-height:0;overflow:hidden;border:1px solid #000;position:relative;user-select:none}
:host{display:block;overflow:auto;max-height:100vh}
.c2[data-compact="1"]{--c2-min:346px}
.c2 :where(button){font:inherit;color:inherit;cursor:pointer}
.c2 .pst-sel{background:#1c1c1c;color:#e0e0e0;border:1px solid #444;border-radius:2px;font:11px var(--mono)}.c2 .pst-btn{background:linear-gradient(#444,#2a2a2a);color:#dcdcdc;border:1px solid #000;border-radius:2px}.c2 .pst-btn:hover{background:#4a4a4a}
.c2 *{box-sizing:border-box}
.c2 [hidden]{display:none!important}
/* Kopfzeile */
.c2-top{display:flex;align-items:stretch;gap:6px;padding:4px 6px;background:linear-gradient(#262626,#171717);border-bottom:1px solid #000;flex:0 0 auto;min-height:44px;flex-wrap:wrap}
.c2-plate{display:flex;align-items:center;gap:2px;background:linear-gradient(#5a4a30,#3d321f);border:1px solid #8a7345;border-radius:3px;padding:0 4px}
.c2-plate b{font:600 17px/1 system-ui,sans-serif;min-width:130px;max-width:240px;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#f0e2c0;padding:0 6px}
.c2-nav{width:22px;height:30px;border:0;background:transparent;color:#d9c79a}
.c2-btn{min-width:48px;padding:0 9px;border:1px solid var(--line2);border-radius:3px;background:linear-gradient(#3a3a3a,#262626);color:var(--txt);text-transform:uppercase;letter-spacing:.04em;font-size:10px}
.c2-btn:hover{background:linear-gradient(#444,#2d2d2d)}
.c2-btn[aria-pressed=true]{background:linear-gradient(#32b6c6,#168593);color:#001a1f;border-color:#46e6f6}
.c2-btn.warn[aria-pressed=true]{background:linear-gradient(#ff9f1c,#c46f00);color:#2a1500;border-color:#ffc060}
.c2-scenes{display:flex;gap:2px;align-items:stretch;flex:1 1 auto;min-width:0;overflow-x:auto;scrollbar-width:none}
.c2-scenes .c2-btn{min-width:72px;font-size:11px;background:linear-gradient(#4a4a4a,#2e2e2e)}
.c2-scenes .c2-btn[aria-pressed=true]{background:linear-gradient(#27d6ea,#0fa0b4);color:#001a1f}
.c2-sp{flex:1}
.c2-lim{display:flex;align-items:center;gap:4px;padding:0 6px;border:1px solid var(--line);border-radius:3px;background:#0d0d0d}
.c2-clock{font:600 14px/1 var(--mono);color:#e8e8e8;padding:0 8px;align-self:center;min-width:76px;text-align:right}
/* Detail */
.c2-detail{display:grid;grid-template-columns:140px minmax(250px,1.4fr) minmax(300px,2.4fr) minmax(190px,1fr) minmax(170px,.9fr);overflow-x:auto;gap:4px;padding:4px 6px;background:#0c0c0c;border-bottom:1px solid #000;flex:0 0 auto;height:clamp(222px,37vh,292px);min-height:0}
.c2-det-empty{grid-column:1/-1;display:flex;align-items:center;justify-content:center;color:var(--dim)}
.c2-sec{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:2px;padding:6px 6px 6px 22px;min-width:0;min-height:0;display:flex;flex-direction:column;gap:5px;overflow-x:hidden;overflow-y:auto;scrollbar-width:thin}
.c2-sec>.vl{position:absolute;left:1px;top:0;bottom:0;width:18px;display:flex;align-items:center;justify-content:center;writing-mode:vertical-rl;transform:rotate(180deg);font-weight:700;letter-spacing:.14em;color:#9aa3ad;font-size:10px;border-right:1px solid var(--line)}
.c2-chip{display:inline-flex;align-items:center;justify-content:center;height:20px;min-width:56px;padding:0 8px;border-radius:2px;border:1px solid #000;font-weight:700;font-size:11px;color:#06121c;background:#4a5560;letter-spacing:.03em}
.c2-chip[aria-pressed=true].gate{background:linear-gradient(#2db4ff,#1479b8)}
.c2-chip[aria-pressed=true].comp{background:linear-gradient(#ff8a2b,#cc5d00)}
.c2-chip[aria-pressed=true].eq{background:linear-gradient(#ffd23d,#d79b00)}
.c2-chip[aria-pressed=true].dyn{background:linear-gradient(#27e0f0,#0fa0b4)}
.c2-chip[aria-pressed=false]{color:#9aa3ad}
.c2-row{display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap}
.c2-in-src{width:100%;background:#0c0c0c;color:var(--cyan);border:1px solid var(--line2);height:22px;font:inherit;border-radius:2px}
.c2-tgl{height:22px;padding:0 8px;border:1px solid var(--line2);border-radius:2px;background:linear-gradient(#3a3a3a,#262626);font-weight:700}
.c2-tgl[aria-pressed=true]{background:linear-gradient(#32b6c6,#168593);color:#001a1f}
.c2-tgl.solo[aria-pressed=true]{background:linear-gradient(#ffd23d,#d79b00);color:#221700}
.c2-dyn{display:grid;grid-template-columns:1fr 1fr;gap:8px;align-content:start}
.c2-dcol{display:flex;flex-direction:column;gap:5px;align-items:flex-start;min-width:0}
.c2-knobs{display:flex;gap:6px;flex-wrap:wrap}
.c2-grv{width:9px;align-self:stretch;min-height:56px;background:#050505;border:1px solid #333;position:relative;overflow:hidden}
.c2-grv i{position:absolute;left:0;right:0;top:0;height:calc(var(--g,0)*100%);background:linear-gradient(#ff9f1c,#ff4040)}
.c2-grw{display:flex;gap:2px;align-items:stretch}
.c2-grw span{writing-mode:vertical-rl;font-size:9px;color:var(--dim)}
/* Knob / Zahlenfeld */
.kn{display:flex;flex-direction:column;align-items:center;gap:2px;width:58px;touch-action:none}
.kn-lab{font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em}
.kn-dial{position:relative;width:34px;height:34px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#4a4a4a,#1b1b1b 70%);border:1px solid #000;box-shadow:0 1px 0 #555 inset,0 2px 3px #000a;cursor:ns-resize}
.kn-arc{position:absolute;inset:-3px;border-radius:50%;background:conic-gradient(from -135deg,var(--kc,var(--cyan)) var(--a0,0deg),var(--kc,var(--cyan)) var(--a1,0deg),transparent var(--a1,0deg));-webkit-mask:radial-gradient(circle,transparent 58%,#000 60%);mask:radial-gradient(circle,transparent 58%,#000 60%);opacity:.9;pointer-events:none}
.kn-ind{position:absolute;left:50%;top:3px;width:2px;height:10px;margin-left:-1px;background:#f4f4f4;border-radius:1px;transform-origin:1px 14px;transform:rotate(var(--r,0deg))}
.kn-val,.nb{display:block;white-space:nowrap;min-width:42px;width:100%;padding:2px 4px;text-align:center;background:#06121c;color:var(--cyan);border:1px solid #1d3b52;border-radius:2px;font:600 11px var(--mono);cursor:ns-resize}

.kn:focus-visible .kn-dial,.nb:focus-visible,.st-range:focus-visible{outline:1px solid var(--cyan)}
.kn.dim .kn-val,.nb.dim{color:#6b7782}
/* EQ */
.c2-eq{display:flex;flex-direction:column;gap:4px;min-height:0}
.c2-eq-top{display:flex;align-items:center;gap:6px}
.c2-eq-top .hint{margin-left:auto;color:var(--dim);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.c2-eqcv{flex:1 1 auto;min-height:60px;width:100%;background:#0a0a0a;border:1px solid #333;touch-action:none;cursor:crosshair;display:block}
.c2-flt{display:grid;grid-template-columns:44px repeat(5,1fr);gap:2px 4px;align-items:center}
.c2-flt .rl{font-size:9px;color:var(--dim);text-align:right;padding-right:2px}
.c2-flt .bn{height:16px;border-radius:2px;background:#ffb000;color:#201400;font-weight:800;text-align:center;line-height:16px;font-size:10px}
.c2-flt .bn.hp{background:#8a949e}
.c2-flt .bn[data-sel="1"]{box-shadow:0 0 0 2px #fff}
/* Routing */
.c2-rt{display:grid;grid-template-columns:1fr;gap:2px;overflow:auto;min-height:0;align-content:start;scrollbar-width:thin}
.c2-rt-row{display:grid;grid-template-columns:78px 1fr 40px;gap:4px;align-items:center;height:20px}
.c2-rt-btn{height:18px;border:1px solid #000;border-radius:2px;background:#3a3f44;color:#a9b0b7;font:700 10px var(--mono);text-align:left;padding:0 5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.c2-rt-btn[aria-pressed=true]{background:linear-gradient(#35c46f,#1c8a48);color:#02150a}
.c2-rt-btn:disabled{opacity:.55;cursor:not-allowed}
.c2-rt-btn[data-kind=aux][aria-pressed=true]{background:linear-gradient(#ffb64d,#d77d00);color:#241300}
.c2-rt-btn[data-kind=n1][aria-pressed=true]{background:linear-gradient(#c79bff,#8b52d6);color:#16002c}
.c2-rt-val{font-size:10px;color:var(--cyan);text-align:right}
.c2-rt-row input[type=range]{width:100%;height:14px;margin:0;appearance:none;-webkit-appearance:none;background:transparent}
.c2-rt-row input[type=range]::-webkit-slider-runnable-track{height:5px;background:#050505;border:1px solid #333;border-radius:3px}
.c2-rt-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:9px;height:14px;margin-top:-6px;border-radius:2px;background:linear-gradient(90deg,#9a9a9a,#eee 45%,#8a8a8a);border:1px solid #000}
.c2-rt-row input[type=range]::-moz-range-track{height:5px;background:#050505;border:1px solid #333;border-radius:3px}
.c2-rt-row input[type=range]::-moz-range-thumb{width:8px;height:13px;border-radius:2px;background:#ddd;border:1px solid #000}
.c2-rt-row input[type=range]:disabled{opacity:.35}
.c2-rt-pp{grid-column:1/-1}
/* Kanalzüge */
.c2-board{display:flex;flex:1 1 auto;min-height:0;gap:0;background:#0c0c0c;padding:0 4px 4px}
.c2-strips{display:flex;flex:1 1 auto;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;gap:2px;padding:3px 2px 0}
.c2-sep{width:8px;flex:0 0 auto;background:repeating-linear-gradient(#222 0 3px,transparent 3px 6px)}
.c2-buses{display:flex;flex:0 0 auto;gap:2px;overflow-x:auto;max-width:34%;scrollbar-width:thin;padding:3px 2px 0}
.c2-master{display:flex;flex:0 0 auto;padding:3px 0 0 2px}
.st{--col:#1fa4e6;position:relative;flex:1 1 74px;min-width:68px;max-width:112px;display:flex;flex-direction:column;gap:3px;background:linear-gradient(#262626,#191919 18%,#141414);border:1px solid #060606;border-top:0;border-radius:0 0 2px 2px;padding:0 3px 3px;min-height:0}
.st[data-sel="1"]{box-shadow:0 0 0 1px #cfd6dc inset}
.st-tab{display:block;margin:0 -3px;height:24px;border:0;background:var(--col);color:#04131c;font:700 12px/1 system-ui,sans-serif;text-align:center;padding:0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-bottom:1px solid #000;text-shadow:0 1px 0 #fff4}
.st[data-sel="1"] .st-tab{filter:brightness(1.18)}
.st .kn{width:100%}
.st-knobwrap{height:50px;display:flex;align-items:center;justify-content:center}
.st-mute{height:22px;border:1px solid #000;border-radius:2px;background:linear-gradient(#444,#2a2a2a);color:#dcdcdc;font:700 11px var(--mono);letter-spacing:.04em;box-shadow:0 1px 0 #666 inset}
.st-mute[aria-pressed=true]{background:linear-gradient(#ff5a5a,#c01f1f);color:#fff}
.st[data-groupmuted="1"] .st-mute{box-shadow:0 0 0 1px var(--orange) inset}
.st-g{display:block;text-align:center;background:#06121c;color:var(--cyan);border:1px solid #1d3b52;border-radius:2px;font:700 12px var(--mono);padding:2px 0}
.st-pk{display:block;text-align:center;color:#8a9199;font:11px var(--mono);height:13px}
.st-flags{display:block;text-align:center;font-size:9px;height:11px;color:var(--amber);white-space:nowrap;overflow:hidden}
.st-fz{position:relative;flex:1 1 auto;min-height:100px;display:grid;grid-template-columns:9px 1fr 22px;gap:2px;--th:44px}
.st-meter{position:relative;margin:calc(var(--th)/2) 0;background:#050505;border:1px solid #2a2a2a}
.st-meter .meter{position:absolute;inset:0;width:auto;height:auto;background:transparent;border:0}
.st-meter .mfill{position:absolute;left:0;right:0;bottom:0;height:100%;background:linear-gradient(to top,#18b84a 0,#2fe06a 60%,#e8d41e 78%,#ff9a1a 90%,#ff3b3b 100%);clip-path:inset(calc((1 - var(--v,0))*100%) 0 0 0)}
.st-meter .mpeak{position:absolute;left:0;right:0;height:2px;bottom:calc(var(--p,0)*100%);background:#fff;opacity:.9}
.st-meter .meter[data-hot="1"]{box-shadow:0 0 0 1px #ff3b3b}
.st-range{position:relative;margin:0;padding:0;width:100%;height:100%;writing-mode:vertical-lr;direction:rtl;appearance:none;-webkit-appearance:none;background:transparent;cursor:pointer;touch-action:none}
.st-range::-webkit-slider-runnable-track{width:6px;background:#020202;border:1px solid #333;border-radius:3px;box-shadow:0 0 0 1px #000 inset}
.st-range::-moz-range-track{width:6px;background:#020202;border:1px solid #333;border-radius:3px}
.st-range::-webkit-slider-thumb{-webkit-appearance:none;width:30px;height:var(--th);margin-left:-13px;border-radius:3px;border:1px solid #000;background:
  linear-gradient(#000 0,#000 0) center/100% 2px no-repeat,
  linear-gradient(#f5f5f5 0,#f5f5f5 0) center/100% 3px no-repeat,
  repeating-linear-gradient(#bdbdbd 0 2px,#7c7c7c 2px 3px),
  linear-gradient(90deg,#6a6a6a,#d8d8d8 40%,#9c9c9c 60%,#5a5a5a);
  box-shadow:0 2px 4px #000c,0 1px 0 #fff6 inset}
.st-range::-moz-range-thumb{width:28px;height:var(--th);border-radius:3px;border:1px solid #000;background:linear-gradient(90deg,#6a6a6a,#d8d8d8 40%,#9c9c9c 60%,#5a5a5a)}
.st-range:active::-webkit-slider-thumb{filter:brightness(1.15)}
.st-scale{position:relative;margin:calc(var(--th)/2) 0;font-size:9px;color:#8a9199}
.st-scale i{position:absolute;right:0;transform:translateY(50%);font-style:normal;line-height:1;padding-left:2px;border-left:0}
.st-scale i::before{content:"";position:absolute;right:100%;top:50%;width:3px;height:1px;background:#555;margin-right:1px}
.st[data-nofader="1"] .st-range{display:none}
.st[data-nofader="1"] .st-fz{grid-template-columns:1fr 22px}
.st[data-nofader="1"] .st-meter{margin:calc(var(--th)/2) 6px}
.st-bot{display:flex;flex-direction:column;gap:3px;margin:0 -3px}
.st-num{height:15px;background:var(--col);color:#04131c;text-align:center;font:700 11px/15px var(--mono)}
.st-solo{height:22px;border:1px solid #000;border-radius:2px;background:linear-gradient(#444,#2a2a2a);color:#dcdcdc;font:700 11px var(--mono);letter-spacing:.04em;margin:0 3px;box-shadow:0 1px 0 #666 inset}
.st-solo[aria-pressed=true]{background:linear-gradient(#ffd23d,#d79b00);color:#221700}
.st-num::after{content:" ●";visibility:hidden}
.st[data-onair="1"] .st-num::after{visibility:visible;color:#c4001a}
.st[data-kind=bus],.st[data-kind=grp]{flex:0 0 78px}
.st[data-kind=master]{flex:0 0 96px;min-width:96px}
.st[data-muted="1"] .st-g{opacity:.5}
/* Drawer mit klassischem Center Control */
/* Kompakt: keine Detailansicht, schmale Züge ohne Pan/Peak/Status (Details über „Mehr…“) */
.c2[data-compact="1"] .c2-detail{display:none}
.c2[data-compact="1"] .st{flex:1 1 52px;min-width:46px;max-width:76px;gap:2px}
.c2[data-compact="1"] .st-knobwrap,.c2[data-compact="1"] .st-pk,.c2[data-compact="1"] .st-flags{display:none}
.c2[data-compact="1"] .st-tab{height:20px;font-size:10px}
.c2[data-compact="1"] .st-mute,.c2[data-compact="1"] .st-solo{height:18px;font-size:9px}
.c2[data-compact="1"] .st-g{font-size:10px;padding:1px 0}
.c2[data-compact="1"] .st-fz{grid-template-columns:7px 1fr 18px;min-height:90px;--th:34px}
.c2[data-compact="1"] .st-range::-webkit-slider-thumb{width:24px;margin-left:-10px}
.c2[data-compact="1"] .st-scale{font-size:8px}
.c2[data-compact="1"] .st[data-kind=bus],.c2[data-compact="1"] .st[data-kind=grp]{flex:0 0 58px}
.c2[data-compact="1"] .st[data-kind=master]{flex:0 0 70px;min-width:70px}
.c2[data-compact="1"] .c2-top{min-height:34px}
.c2-drawer{position:absolute;top:44px;right:0;bottom:0;width:min(460px,96%);background:var(--panel);border-left:2px solid var(--cyan);z-index:30;overflow:auto;box-shadow:-10px 0 30px #000c}
.c2-drawer .c2-dh{display:flex;align-items:center;padding:4px 8px;gap:8px;border-bottom:1px solid var(--line)}
.c2-drawer .c2-dh b{flex:1}
.c2 .modal .box{background:#1a1a1a;border:1px solid #444}
`;

// ───────────── Drehregler / Zahlenfeld ─────────────

/** Drehregler (Ziehen senkrecht, Mausrad, Pfeiltasten, Doppelklick = Standardwert) oder – mit `dial:false` – nur Zahlenfeld. */
class Knob {
  constructor({ label, min, max, def, scale = "lin", step = 0.1, fmt, get, set, dial = true, color, bipolar = false }) {
    Object.assign(this, { min, max, def, scale, step, fmt, set, get, dial, bipolar });
    this.value = def ?? min;
    this.drag = false;
    this.val = h("output", { class: dial ? "kn-val" : "nb", tabindex: "0", role: "slider", "aria-label": label || "", "aria-valuemin": String(min), "aria-valuemax": String(max) });
    if (dial) {
      this.arc = h("i", { class: "kn-arc" });
      this.ind = h("i", { class: "kn-ind" });
      this.dialEl = h("div", { class: "kn-dial" }, this.arc, this.ind);
      this.root = h("div", { class: "kn", title: label || "" }, label ? h("span", { class: "kn-lab", text: label }) : null, this.dialEl, this.val);
      if (color) this.root.style.setProperty("--kc", color);
    } else {
      this.root = this.val;
      this.dialEl = this.val;
    }
    const el = dial ? this.dialEl : this.val;
    el.addEventListener("pointerdown", (e) => this.#down(e));
    el.addEventListener("pointermove", (e) => this.#move(e));
    el.addEventListener("pointerup", (e) => this.#up(e));
    el.addEventListener("pointercancel", (e) => this.#up(e));
    el.addEventListener("wheel", (e) => { e.preventDefault(); this.#apply(this.#pos() + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.004 : 0.02)); }, { passive: false });
    el.addEventListener("dblclick", () => def !== undefined && this.#commit(def));
    this.val.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -1 : 0;
      if (d) { this.#apply(this.#pos() + d * (e.shiftKey ? 0.004 : 0.02)); e.preventDefault(); e.stopPropagation(); }
      else if (e.key === "Home" && def !== undefined) { this.#commit(def); e.preventDefault(); e.stopPropagation(); }
    });
    this.render();
  }
  #pos() {
    const v = clamp(this.value, this.min, this.max);
    return this.scale === "log" ? (Math.log(v) - Math.log(this.min)) / (Math.log(this.max) - Math.log(this.min)) : (v - this.min) / (this.max - this.min);
  }
  #val(p) {
    p = clamp(p, 0, 1);
    return this.scale === "log" ? Math.exp(Math.log(this.min) + p * (Math.log(this.max) - Math.log(this.min))) : this.min + p * (this.max - this.min);
  }
  #snap(v) {
    v = Math.round(v / this.step) * this.step;
    return clamp(Math.round(v * 1e6) / 1e6, this.min, this.max);
  }
  #apply(p) { this.#commit(this.#snap(this.#val(p))); }
  #commit(v) { this.value = v; this.render(); this.set?.(v); }
  #down(e) {
    if (e.button != null && e.button !== 0) return;
    this.drag = true;
    this.y0 = e.clientY;
    this.p0 = this.#pos();
    (this.dial ? this.dialEl : this.val).setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  #move(e) {
    if (!this.drag) return;
    this.#apply(this.p0 + ((this.y0 - e.clientY) / 160) * (e.shiftKey ? 0.2 : 1));
  }
  #up(e) {
    if (!this.drag) return;
    this.drag = false;
    try { (this.dial ? this.dialEl : this.val).releasePointerCapture(e.pointerId); } catch {}
  }
  setValue(v) {
    if (this.drag || v === undefined || v === null || Number.isNaN(v)) return;
    this.value = v;
    this.render();
  }
  render() {
    const p = this.#pos();
    this.val.textContent = this.fmt ? this.fmt(this.value) : this.value.toFixed(this.step < 1 ? 1 : 0);
    this.val.setAttribute("aria-valuenow", String(this.value));
    if (!this.dial) return;
    this.root.style.setProperty("--r", `${-135 + 270 * p}deg`);
    const a = 270 * p;
    if (this.bipolar) {
      const c = 135;
      this.root.style.setProperty("--a0", `${Math.min(a, c)}deg`);
      this.root.style.setProperty("--a1", `${Math.max(a, c)}deg`);
      // Bogen nur zwischen Mitte und Wert: unterer Anteil bleibt transparent über Maskierung via zwei Stopps
      this.arc.style.background = `conic-gradient(from -135deg, transparent ${Math.min(a, c)}deg, var(--kc,var(--cyan)) ${Math.min(a, c)}deg, var(--kc,var(--cyan)) ${Math.max(a, c)}deg, transparent ${Math.max(a, c)}deg)`;
    } else {
      this.root.style.setProperty("--a0", "0deg");
      this.root.style.setProperty("--a1", `${a}deg`);
    }
  }
}

const fmtDb = (v) => (v <= -59.5 ? "−∞" : fmtSigned(v));
const fmtHz = (v) => (v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + "k" : String(Math.round(v)));

// ───────────── Kanalzug ─────────────

/** Ein Zug: Namensfahne, Pan-Knopf, Mute, Gain-/Peak-Anzeige, Fader (range) + Pegel + Skala, Nummer, Solo. */
class StripV2 {
  /** cfg: { kind, label, num, color, noFader, noMeter, noSolo, knob, onSelect, onGain(db), onGainCommit(), onMute(), onSolo() } */
  constructor(app, cfg) {
    this.app = app;
    this.cfg = cfg;
    this.last = {};
    this.root = h("div", { class: "st", "data-kind": cfg.kind, role: "group" });
    this.root.style.setProperty("--col", cfg.color || "#1fa4e6");
    this.tab = h("button", { class: "st-tab", type: "button", title: "" });
    this.tab.addEventListener("click", () => cfg.onSelect?.());
    this.tab.addEventListener("dblclick", () => cfg.onOpen?.());
    this.knobWrap = h("div", { class: "st-knobwrap" });
    if (cfg.knob) { this.knob = new Knob(cfg.knob); this.knobWrap.append(this.knob.root); }
    this.mute = h("button", { class: "st-mute", type: "button", "aria-pressed": "false", text: "MUTE", onclick: () => cfg.onMute?.() });
    this.gBox = h("output", { class: "st-g", text: "0.0" });
    this.pk = h("output", { class: "st-pk", text: "−∞" });
    this.flags = h("span", { class: "st-flags" });
    this.meter = new Meter();
    this.meterBox = h("div", { class: "st-meter" }, this.meter.root);
    this.range = h("input", { class: "st-range", type: "range", min: "0", max: "1000", step: "1", value: "750", "aria-label": "Fader" });
    this.range.addEventListener("pointerdown", () => { this.dragging = true; });
    const end = () => { if (!this.dragging) return; this.dragging = false; cfg.onGainCommit?.(); };
    this.range.addEventListener("pointerup", end);
    this.range.addEventListener("pointercancel", end);
    this.range.addEventListener("change", () => cfg.onGainCommit?.());
    this.range.addEventListener("input", () => {
      let db = posToDb(Number(this.range.value) / 1000);
      if (Math.abs(db) < 0.4) db = 0;
      db = Math.round(db * 10) / 10;
      this.db = db;
      this.gBox.textContent = fmtDb(db);
      cfg.onGain?.(db);
    });
    this.range.addEventListener("dblclick", () => { this.setGain(0); cfg.onGain?.(0); cfg.onGainCommit?.(); });
    this.scale = h("div", { class: "st-scale" }, ...C2_FADER_MARKS.map(([db, t]) => { const i = h("i", { text: t }); i.style.bottom = dbToPos(db) * 100 + "%"; return i; }));
    this.fz = h("div", { class: "st-fz" }, this.meterBox, this.range, this.scale);
    this.num = h("div", { class: "st-num", text: cfg.num ?? "" });
    this.solo = h("button", { class: "st-solo", type: "button", "aria-pressed": "false", text: "SOLO", onclick: () => cfg.onSolo?.() });
    if (cfg.noFader) this.root.dataset.nofader = "1";
    if (cfg.noSolo) this.solo.style.visibility = "hidden";
    if (cfg.noMute) this.mute.style.visibility = "hidden";
    if (cfg.noKnob) this.knobWrap.style.display = "none";
    this.root.append(this.tab, this.knobWrap, this.mute, this.gBox, this.pk, this.flags, this.fz, h("div", { class: "st-bot" }, this.num, this.solo));
    this.setLabel(cfg.label);
  }
  setLabel(t) {
    if (this.last.label === t) return;
    this.last.label = t;
    this.tab.textContent = t;
    this.tab.title = t;
    this.root.setAttribute("aria-label", t);
  }
  setGain(db) {
    if (this.dragging) return;
    this.db = db;
    this.range.value = String(Math.round(dbToPos(db) * 1000));
    this.gBox.textContent = fmtDb(db);
    this.range.setAttribute("aria-valuetext", fmtDb(db) + " dB");
  }
  setLevel(rms, peak, now) {
    this.meter.set(rms, peak, now);
    const txt = this.meter.hold <= 0.005 ? "−∞" : fmtSigned(this.meter.hold * 60 - 60);
    if (this.last.pk !== txt) { this.last.pk = txt; this.pk.textContent = txt; }
  }
  set(key, val, fn) {
    if (this.last[key] === val) return;
    this.last[key] = val;
    fn(val);
  }
}

// ───────────── Anwendung ─────────────

class ConsoleApp extends MixerApp {
  build() {
    const style = h("style");
    style.textContent = CSS + CSS2;
    this.root = h("div", { class: "root c2", tabindex: "-1" });
    // Höhe = sichtbarer Bereich des Containers (Operator-Kachel oder Fenster) ab der Position der Oberfläche; die Fader füllen den Rest.
    // Unterhalb des Minimums (--c2-min = Platzbedarf des Inhalts, kompakt weniger) scrollt der Container, statt unten (SOLO) abzuschneiden.
    this.fitHeight = () => {
      if (!this.root.isConnected) return;
      const hostEl = this.root.getRootNode().host || this.root;
      let limit = window.innerHeight;
      let el = hostEl.parentElement || (hostEl.getRootNode() && hostEl.getRootNode().host) || null;
      this.fitBox = null;
      while (el && el !== document.body && el !== document.documentElement) {
        const cs = getComputedStyle(el);
        if (/(auto|scroll|hidden|clip)/.test(cs.overflowY) && el.clientHeight > 0) {
          limit = Math.min(limit, el.getBoundingClientRect().top + el.clientHeight - (parseFloat(cs.paddingBottom) || 0));
          this.fitBox = el;
          break;
        }
        const rn = el.parentElement ? null : el.getRootNode();
        el = el.parentElement || (rn && rn.host) || null;
      }
      const avail = Math.max(0, Math.floor(limit - hostEl.getBoundingClientRect().top - 2));
      if (this.root.dataset.avail !== String(avail)) { this.root.dataset.avail = String(avail); this.root.style.setProperty("--c2-h", avail + "px"); }
    };
    window.addEventListener("resize", this.fitHeight);
    if (typeof ResizeObserver !== "undefined") {
      this.fitRO = new ResizeObserver(() => this.fitHeight());
      queueMicrotask(() => { this.fitHeight(); if (this.fitBox) this.fitRO.observe(this.fitBox); });
    }
    for (const ms of [0, 200, 800, 2000]) setTimeout(() => { this.fitHeight(); if (this.fitBox && this.fitRO) this.fitRO.observe(this.fitBox); }, ms);
    this.fitTimer = setInterval(this.fitHeight, 1000);
    this.stripViews = new Map(); // Gruppen/Busse
    this.binds = [];
    this.liveBinds = [];

    // Kopfzeile
    this.nameEl = h("b", { text: "—" });
    this.plate = h("div", { class: "c2-plate" }, h("button", { class: "c2-nav", type: "button", text: "◀", "aria-label": "◀", onclick: () => this.step(-1) }), this.nameEl, h("button", { class: "c2-nav", type: "button", text: "▶", "aria-label": "▶", onclick: () => this.step(1) }));
    this.clrBtn = h("button", { class: "c2-btn", type: "button", text: T2("clr"), onclick: () => { for (const c of this.state.channels) if (c.pfl) this.togglePfl(c.id); } });
    this.sceneBar = h("div", { class: "c2-scenes", role: "group", "aria-label": "Szenen" });
    this.sceneSaveBtn = h("button", { class: "c2-btn", type: "button", text: T2("scene"), onclick: async () => { const n = await this.prompt(T("am5.b07796")); if (n && n.trim()) this.cmd("captureScene", { label: n.trim(), includeProcessing: false }).then(() => this.poll()); } });
    this.limBtn = h("button", { class: "c2-btn warn", type: "button", "aria-pressed": "false", text: "LIM", onclick: () => this.setLimiter({ enabled: !this.state.masterLimiter.enabled }) });
    this.limThr = new Knob({ dial: false, label: "Limiter-Schwelle", min: -60, max: 0, step: 0.5, def: -6, fmt: (v) => fmtSigned(v) + " dB", set: (v) => this.setLimiter({ thresholdDb: v }) });
    this.limThr.root.style.width = "64px";
    this.limGr = h("span", { class: "hint", text: "GR 0.0" });
    this.limBox = h("div", { class: "c2-lim" }, this.limBtn, this.limThr.root, this.limGr);
    this.clock = h("span", { class: "c2-clock" });
    const tb = (text, title, fn, extra) => h("button", { class: "c2-btn", type: "button", text, title, onclick: fn, ...(extra || {}) });
    this.moreBtn = tb(T2("more"), T2("tipMore"), () => this.toggleDrawer(), { "aria-pressed": "false" });
    this.compactBtn = tb(T2("compact"), T2("tipCompact"), () => { this.ui.compact = !this.ui.compact; this.saveUi(); this.applyCompact(); }, { "aria-pressed": "false" });
    this.top = h("header", { class: "c2-top" }, this.plate, this.clrBtn, this.sceneBar, this.sceneSaveBtn, h("span", { class: "c2-sp" }),
      tb(T2("addCh"), "", () => this.cmd("addChannel", { label: "" }).then(() => this.poll())),
      tb(T2("outs"), "", () => this.openOutputs()),
      tb(T2("afv"), "", () => this.openFollow()),
      tb(T2("glob"), "", () => this.openGlobal()),
      this.compactBtn, this.moreBtn, this.limBox, this.clock,
      tb(T2("classic"), T2("tipClassic"), () => swapSkin(this, "classic")));

    // Detail
    this.detail = h("section", { class: "c2-detail", "aria-label": "Kanaldetail" });
    this.buildDetail();

    // Zugreihe
    this.channelsEl = h("div", { class: "c2-strips", "aria-label": "Kanalzüge" });
    this.busesEl = h("div", { class: "c2-buses", "aria-label": "Gruppen und Ausgänge" });
    this.masterEl = h("div", { class: "c2-master" });
    this.master = new StripV2(this, { kind: "master", label: T2("master"), num: "LR", color: "#d8dde2", noFader: true, noMute: true, noSolo: true, noKnob: true });
    this.masterEl.append(this.master.root);
    this.board = h("div", { class: "c2-board" }, this.channelsEl, h("div", { class: "c2-sep" }), this.busesEl, h("div", { class: "c2-sep" }), this.masterEl);

    // Drawer: klassisches Center Control für die selteneren Einstellungen
    this.centerHost = h("aside", { class: "c2-center", "aria-label": T("am5.32bd9b") });
    this.drawer = h("div", { class: "c2-drawer", hidden: true }, h("div", { class: "c2-dh" }, h("b", { text: T2("more") }), h("button", { class: "c2-btn", type: "button", text: "✕", onclick: () => this.toggleDrawer(false) })), this.centerHost);
    this.live_ = h("div", { class: "sr", role: "status", "aria-live": "polite" });
    // Platzhalter, die geerbte Methoden erwarten
    this.outputsEl = h("div");
    this.groupsEl = h("div");
    this.ctHandle = h("button", { hidden: true });
    this.root.append(this.top, this.detail, this.board, this.drawer, this.live_);
    this.shadow.append(style, this.root);
    this.root.addEventListener("keydown", (e) => this.onKey(e));
    this.clockTimer = setInterval(() => { this.clock.textContent = new Date().toLocaleTimeString(LOCALE, { hour12: false }); }, 1000);
    this.clock.textContent = new Date().toLocaleTimeString(LOCALE, { hour12: false });
    this.refreshDetail();
    this.applyCompact();
    this.onWinResize = () => this.layoutNow();
    window.addEventListener("resize", this.onWinResize);
  }

  applyCompact() {
    const on = !!this.ui.compact;
    this.root.dataset.compact = on ? "1" : "0";
    this.layoutNow();
    this.compactBtn.setAttribute("aria-pressed", String(on));
    for (const fn of this.binds) try { fn(); } catch {}
  }

  destroy() {
    clearInterval(this.clockTimer); clearInterval(this.fitTimer); window.removeEventListener("resize", this.fitHeight); if (this.fitRO) this.fitRO.disconnect();
    window.removeEventListener("resize", this.onWinResize);
    super.destroy();
  }

  toggleDrawer(force) {
    const open = force ?? this.drawer.hidden;
    this.drawer.hidden = !open;
    this.moreBtn.setAttribute("aria-pressed", String(open));
    if (open) this.center.refresh();
  }

  // ───── Detailbereich ─────
  bind(fn) { this.binds.push(fn); }
  live2(fn) { this.liveBinds.push(fn); }
  section(label, ...kids) {
    return h("section", { class: "c2-sec" }, h("span", { class: "vl", text: label }), ...kids);
  }
  chip(label, cls, get, set) {
    const b = h("button", { class: "c2-chip " + cls, type: "button", "aria-pressed": "false", text: label, onclick: () => { const ch = this.cur(); if (ch) { set(ch, !get(ch)); this.refreshDetail(); } } });
    this.bind(() => { const ch = this.cur(); if (ch) b.setAttribute("aria-pressed", String(!!get(ch))); });
    return b;
  }
  tgl(label, cls, get, set, title) {
    const b = h("button", { class: "c2-tgl " + (cls || ""), type: "button", "aria-pressed": "false", text: label, title: title || label, onclick: () => { const ch = this.cur(); if (ch) { set(ch, !get(ch)); this.refreshDetail(); } } });
    this.bind(() => { const ch = this.cur(); if (ch) b.setAttribute("aria-pressed", String(!!get(ch))); });
    return b;
  }
  knob(cfg, get, set) {
    const k = new Knob({ ...cfg, set: (v) => { const ch = this.cur(); if (ch) set(ch, v); } });
    this.bind(() => { const ch = this.cur(); if (ch) k.setValue(get(ch)); });
    return k;
  }
  grBar(key) {
    const bar = h("i");
    const root = h("div", { class: "c2-grw", title: T2("gr") }, h("div", { class: "c2-grv" }, bar), h("span", { text: T2("gr") }));
    let last = -1;
    this.live2(() => {
      const l = this.live.get(this.ui.selected);
      const g = clamp(-(l ? l[key] || 0 : 0) / 24, 0, 1);
      if (Math.abs(g - last) < 0.01) return;
      last = g;
      bar.parentElement.style.setProperty("--g", g.toFixed(3));
      bar.style.setProperty("--g", g.toFixed(3));
    });
    return root;
  }

  buildDetail() {
    const app = this;
    this.binds = [];
    this.liveBinds = [];

    // INPUT
    const src = h("select", { class: "c2-in-src", "aria-label": T("am2.d3402e") });
    let srcKey = "";
    this.bind(() => {
      const ch = this.cur();
      if (!ch) return;
      const opts = [["", T2("none")], ...this.state.availableSources.map((s) => [s.senderId, shortLabel(s.label)])];
      const k = JSON.stringify(opts);
      if (k !== srcKey) { srcKey = k; src.replaceChildren(...opts.map(([v, t]) => h("option", { value: v, text: t }))); }
      src.value = ch.source || "";
    });
    src.addEventListener("change", () => { const ch = this.cur(); if (ch) { ch.source = src.value; this.sendCh(ch.id, "setSource", { senderId: src.value }); } });
    const trim = this.knob({ label: T2("trim"), min: -60, max: 12, step: 0.1, def: 0, color: "var(--cyan)", fmt: (v) => fmtDb(v) }, (ch) => ch.gainDb, (ch, v) => this.setGainLive(ch.id, v));
    const inSec = this.section(T2("input"),
      src,
      h("div", { class: "c2-row" }, this.tgl(T2("phase"), "", (ch) => ch.proc.phaseInvert, (ch, v) => { ch.proc.phaseInvert = v; this.sendCh(ch.id, "setPhase", { invert: v }); }, T("am2.5a8536")), this.tgl("PFL", "solo", (ch) => ch.pfl, (ch) => this.togglePfl(ch.id), T("am1.47a7ad"))),
      h("div", { class: "c2-row", style: "justify-content:center" }, trim.root));

    // DYNAMIK
    const sendGate = (ch) => this.sendCh(ch.id, "setGate", { enabled: ch.proc.gateEnabled, thresholdDb: ch.proc.gateThreshold, rangeDb: ch.proc.gateRange, ratio: ch.proc.gateRatio, attackMs: ch.proc.gateAttack, holdMs: ch.proc.gateHold, releaseMs: ch.proc.gateRelease, hysteresisDb: ch.proc.gateHysteresis }, "gate");
    const sendComp = (ch) => this.sendCh(ch.id, "setComp", { enabled: ch.proc.compEnabled, thresholdDb: ch.proc.compThreshold, ratio: ch.proc.compRatio, makeupDb: ch.proc.compMakeup, attackMs: ch.proc.compAttack, releaseMs: ch.proc.compRelease, kneeDb: ch.proc.compKnee, rms: ch.proc.compRms }, "comp");
    const pk = (label, key, min, max, step, def, unit, send, extra = {}) => this.knob({ label, min, max, step, def, fmt: (v) => (unit === ":1" ? v.toFixed(1) + ":1" : fmtSigned(v, step < 1 ? 1 : 0).replace("+", "") + (unit ? " " + unit : "")), ...extra }, (ch) => ch.proc[key], (ch, v) => { ch.proc[key] = v; send(ch); });
    const gateCol = h("div", { class: "c2-dcol" }, this.chip("GATE", "gate", (ch) => ch.proc.gateEnabled, (ch, v) => { ch.proc.gateEnabled = v; sendGate(ch); }),
      h("div", { class: "c2-knobs" }, pk("Thr", "gateThreshold", -90, 0, 0.5, -55, "dB", sendGate).root, pk("Range", "gateRange", -90, 0, 1, -30, "dB", sendGate).root, pk("Atk", "gateAttack", 0.1, 200, 0.1, 5, "ms", sendGate, { scale: "log" }).root, pk("Rel", "gateRelease", 5, 4000, 5, 300, "ms", sendGate, { scale: "log" }).root, this.grBar("gateGr")));
    const compCol = h("div", { class: "c2-dcol" }, this.chip("COMP", "comp", (ch) => ch.proc.compEnabled, (ch, v) => { ch.proc.compEnabled = v; sendComp(ch); }),
      h("div", { class: "c2-knobs" }, ...[pk("Thr", "compThreshold", -60, 0, 0.5, -20, "dB", sendComp, { color: "var(--orange)" }), pk("Ratio", "compRatio", 1, 20, 0.1, 2, ":1", sendComp, { color: "var(--orange)" }), pk("Gain", "compMakeup", 0, 24, 0.5, 0, "dB", sendComp, { color: "var(--orange)" }), pk("Atk", "compAttack", 0.1, 200, 0.1, 15, "ms", sendComp, { scale: "log", color: "var(--orange)" }), pk("Rel", "compRelease", 5, 2000, 1, 150, "ms", sendComp, { scale: "log", color: "var(--orange)" })].map((k) => k.root), this.grBar("compGr")));
    const dynSec = this.section(T2("dyn"), presetBar(this, "dyn"), h("div", { class: "c2-dyn" }, gateCol, compCol));

    // EQ
    const eqSec = this.section("EQ", this.buildEq());

    // AUX / ROUTING
    this.rtHost = h("div", { class: "c2-rt" });
    this.rtHost2 = h("div", { class: "c2-rt" });
    const auxSec = this.section(T2("aux"), this.rtHost);
    const rtSec = this.section(T2("routing"), this.rtHost2);
    this.rtSig = "";
    this.bind(() => this.renderRoutes());

    this.detailEmpty = h("div", { class: "c2-det-empty", text: T2("noCh") });
    this.detailParts = [inSec, dynSec, eqSec, auxSec, rtSec];
    this.detail.replaceChildren(this.detailEmpty, ...this.detailParts);
  }

  buildEq() {
    const wrap = h("div", { class: "c2-eq" });
    const canvas = h("canvas", { class: "c2-eqcv", "aria-label": T2("eqHint") });
    const top = h("div", { class: "c2-eq-top" }, this.chip("EQ", "eq", (ch) => !ch.proc.eqBypass, (ch, v) => { ch.proc.eqBypass = !v; this.sendCh(ch.id, "setEqBypass", { bypass: !v }); }), presetBar(this, "eq"), h("span", { class: "hint", text: T2("eqHint") }));
    const sendBand = (ch, b) => this.sendCh(ch.id, "setEqBand", { band: b.key, freq: ch.proc[b.freq], width: ch.proc[b.width] }, "f" + b.key);
    const sendGain = (ch, b) => this.sendCh(ch.id, "setEqGain", { band: b.key, gainDb: ch.proc[b.gain] }, "g" + b.key);
    const sendHp = (ch) => this.sendCh(ch.id, "setEqHp", { enabled: ch.proc.eqHpEnabled, freq: ch.proc.eqHpFreq }, "hp");
    const q = (ch, b) => ch.proc[b.freq] / Math.max(ch.proc[b.width], 1);

    // Tabelle F / G / Q je Band + Hochpass
    const flt = h("div", { class: "c2-flt" });
    const hpBtn = h("button", { class: "bn hp", type: "button", text: "HP", title: T("am2.db3c8f"), onclick: () => { const ch = this.cur(); if (ch) { ch.proc.eqHpEnabled = !ch.proc.eqHpEnabled; sendHp(ch); this.refreshDetail(); } } });
    this.bind(() => { const ch = this.cur(); if (ch) hpBtn.style.opacity = ch.proc.eqHpEnabled ? "1" : ".45"; });
    const nums = (label, cells) => { flt.append(h("span", { class: "rl", text: label }), ...cells); };
    flt.append(h("span"), hpBtn, ...EQ_BANDS.map((b, i) => h("span", { class: "bn", text: String(i + 1), "data-b": b.key })));
    this.eqBn = [...flt.querySelectorAll(".bn[data-b]")];
    const hpF = this.knob({ dial: false, label: "HP Hz", min: 20, max: 500, step: 1, def: 80, scale: "log", fmt: (v) => fmtHz(v) }, (ch) => ch.proc.eqHpFreq, (ch, v) => { ch.proc.eqHpFreq = v; sendHp(ch); draw(); });
    nums("F", [hpF.root, ...EQ_BANDS.map((b) => this.knob({ dial: false, label: b.name + " Hz", min: 20, max: 20000, step: 1, def: b.defF, scale: "log", fmt: fmtHz }, (ch) => ch.proc[b.freq], (ch, v) => { const qq = q(ch, b); ch.proc[b.freq] = v; ch.proc[b.width] = v / qq; sendBand(ch, b); draw(); }).root)]);
    nums("G", [h("span"), ...EQ_BANDS.map((b) => this.knob({ dial: false, label: b.name + " dB", min: -24, max: 12, step: 0.5, def: 0, fmt: (v) => fmtSigned(v) }, (ch) => ch.proc[b.gain], (ch, v) => { ch.proc[b.gain] = v; sendGain(ch, b); draw(); }).root)]);
    nums("Q", [h("span"), ...EQ_BANDS.map((b) => this.knob({ dial: false, label: b.name + " Q", min: 0.1, max: 20, step: 0.1, def: 1, scale: "log", fmt: (v) => v.toFixed(1) }, (ch) => q(ch, b), (ch, v) => { ch.proc[b.width] = ch.proc[b.freq] / v; sendBand(ch, b); draw(); }).root)]);

    const draw = () => {
      const ch = this.cur();
      if (!ch) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, hgt = canvas.clientHeight;
      if (!w || !hgt) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr); }
      const c = canvas.getContext("2d");
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, hgt);
      const X = (f) => (Math.log10(f / 20) / 3) * w;
      const Y = (db) => hgt / 2 - (db / 18) * (hgt / 2 - 8);
      c.font = "9px ui-monospace,monospace";
      c.lineWidth = 1;
      for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) { c.strokeStyle = "#232323"; c.beginPath(); c.moveTo(Math.round(X(f)) + 0.5, 0); c.lineTo(Math.round(X(f)) + 0.5, hgt); c.stroke(); c.fillStyle = "#5d646b"; c.fillText(fmtHz(f), X(f) + 2, hgt - 3); }
      for (const d of [-12, -6, 0, 6, 12]) { c.strokeStyle = d === 0 ? "#3d3d3d" : "#232323"; c.beginPath(); c.moveTo(0, Math.round(Y(d)) + 0.5); c.lineTo(w, Math.round(Y(d)) + 0.5); c.stroke(); c.fillStyle = "#5d646b"; c.fillText(String(d), 2, Y(d) - 2); }
      const P = ch.proc;
      const on = !P.eqBypass;
      const resp = (f) => {
        let db = 0;
        if (P.eqHpEnabled) db += biquadMagDb("hp", P.eqHpFreq, Math.SQRT1_2, 0, f);
        for (const b of EQ_BANDS) if (Math.abs(P[b.gain]) > 0.01) db += biquadMagDb(b.kind, P[b.freq], P[b.freq] / Math.max(P[b.width], 1), P[b.gain], f);
        return db;
      };
      const curve = new Path2D();
      for (let i = 0; i <= 200; i++) { const f = 20 * Math.pow(1000, i / 200); const y = Y(clamp(resp(f), -18, 18)); i ? curve.lineTo(X(f), y) : curve.moveTo(X(f), y); }
      c.strokeStyle = on ? "#ffb000" : "#666";
      c.lineWidth = 2;
      c.stroke(curve);
      c.lineWidth = 1;
      this.eqHandles = EQ_BANDS.map((b, i) => ({ b, i, x: X(P[b.freq]), y: Y(P[b.gain]) }));
      if (P.eqHpEnabled) this.eqHandles.push({ hp: true, i: -1, x: X(P.eqHpFreq), y: Y(0) });
      for (const hd of this.eqHandles) {
        const sel = hd.b && hd.b === this.eqDrag;
        c.beginPath();
        c.arc(hd.x, hd.y, hd.hp ? 6 : 9, 0, 7);
        c.fillStyle = hd.hp ? "#222" : on ? (sel ? "#fff" : "#ffb000") : "#777";
        c.fill();
        c.strokeStyle = hd.hp ? "#9aa3ad" : "#241600";
        c.stroke();
        c.fillStyle = hd.hp ? "#9aa3ad" : "#201400";
        c.font = "bold 10px ui-monospace,monospace";
        c.textAlign = "center";
        c.fillText(hd.hp ? "H" : String(hd.i + 1), hd.x, hd.y + 3.5);
        c.textAlign = "left";
      }
      for (const bn of this.eqBn) bn.dataset.sel = this.eqDrag && this.eqDrag.key === bn.dataset.b ? "1" : "0";
    };
    this.bind(draw);
    new ResizeObserver(() => draw()).observe(canvas);
    const toFg = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }; };
    canvas.addEventListener("pointerdown", (e) => {
      const p = toFg(e);
      let best = null, bd = 22;
      for (const hd of this.eqHandles || []) { const d = Math.hypot(hd.x - p.x, hd.y - p.y); if (d < bd) { bd = d; best = hd; } }
      if (!best) return;
      this.eqDrag = best.hp ? null : best.b;
      this.eqDragHp = !!best.hp;
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.eqDrag && !this.eqDragHp) return;
      const ch = this.cur();
      if (!ch) return;
      const p = toFg(e);
      const f = clamp(Math.round(20 * Math.pow(1000, clamp(p.x / p.w, 0, 1))), 20, 20000);
      if (this.eqDragHp) { ch.proc.eqHpFreq = clamp(f, 20, 500); sendHp(ch); this.refreshDetail(); return; }
      const b = this.eqDrag;
      const g = clamp(Math.round(((p.h / 2 - p.y) / (p.h / 2 - 8)) * 18 * 2) / 2, -24, 12);
      const qq = q(ch, b);
      ch.proc[b.freq] = f; ch.proc[b.width] = f / qq; ch.proc[b.gain] = g;
      sendGain(ch, b);
      sendBand(ch, b);
      this.refreshDetail();
    });
    const end = () => { this.eqDrag = null; this.eqDragHp = false; draw(); };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("wheel", (e) => {
      const ch = this.cur();
      if (!ch) return;
      const p = toFg(e);
      let best = null, bd = 22;
      for (const hd of this.eqHandles || []) if (hd.b) { const d = Math.hypot(hd.x - p.x, hd.y - p.y); if (d < bd) { bd = d; best = hd; } }
      if (!best) return;
      e.preventDefault();
      const b = best.b;
      const nq = clamp(q(ch, b) * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.1, 20);
      ch.proc[b.width] = ch.proc[b.freq] / nq;
      sendBand(ch, b);
      this.refreshDetail();
    }, { passive: false });
    wrap.append(top, canvas, flt);
    return wrap;
  }

  /** Aux-/Routing-Listen des gewählten Kanals (Programm + Ausgänge; Aux/N-1 getrennt von Gruppen-Bussen). */
  renderRoutes() {
    const ch = this.cur();
    if (!ch) return;
    const buses = [...this.state.auxBuses].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
    const sig = JSON.stringify([ch.id, buses.map((b) => [b.id, b.label, b.kind])]);
    if (sig !== this.rtSig) {
      this.rtSig = sig;
      this.rtRows = new Map();
      const mkRow = (name, kind, onToggle, onLevel, onPre) => {
        const btn = h("button", { class: "c2-rt-btn", type: "button", "data-kind": kind, "aria-pressed": "false", text: name, title: name, onclick: onToggle });
        const rng = onLevel ? h("input", { type: "range", min: "-60", max: "12", step: "0.5", value: "0", "aria-label": name }) : h("span");
        const val = h("span", { class: "c2-rt-val" });
        if (onLevel) {
          rng.addEventListener("input", () => onLevel(Number(rng.value)));
          rng.addEventListener("dblclick", () => { rng.value = "0"; onLevel(0); });
        }
        const root = h("div", { class: "c2-rt-row" }, btn, rng, val);
        return { root, btn, rng, val };
      };
      const aux = [], grp = [];
      const pgm = mkRow(T2("noMain"), "program", () => { const c = this.cur(); if (!c) return; c.mainRoute = !c.mainRoute; this.sendCh(c.id, "setMainRoute", { routed: c.mainRoute }); this.refreshDetail(); });
      this.rtRows.set("pgm", pgm);
      grp.push(pgm.root);
      for (const bus of buses) {
        const lbl = bus.label.length > 11 ? bus.label.slice(0, 10) + "…" : bus.label;
        const sd = () => this.cur()?.sends.find((x) => x.auxId === bus.id);
        const row = mkRow(lbl, bus.kind, () => { const s = sd(); if (!s || s.locked) return; this.setSend(bus.id, { enabled: !s.enabled }); }, (v) => { const s = sd(); if (s && !s.locked) this.setSend(bus.id, { levelDb: v }, false); });
        row.btn.title = bus.label + " (" + outputKind(bus) + ")";
        this.rtRows.set(bus.id, row);
        (bus.kind === "group" ? grp : aux).push(row.root);
      }
      this.rtHost.replaceChildren(...aux);
      this.rtHost2.replaceChildren(...grp);
    }
    const pgm = this.rtRows.get("pgm");
    pgm.btn.setAttribute("aria-pressed", String(!!ch.mainRoute));
    pgm.val.textContent = "";
    for (const bus of buses) {
      const row = this.rtRows.get(bus.id);
      const s = ch.sends.find((x) => x.auxId === bus.id);
      if (!row || !s) continue;
      row.btn.setAttribute("aria-pressed", String(!!s.enabled));
      row.btn.disabled = !!s.locked;
      row.rng.disabled = !!s.locked;
      if (document.activeElement !== row.rng && this.shadow.activeElement !== row.rng) row.rng.value = String(s.levelDb ?? 0);
      row.val.textContent = fmtSigned(s.levelDb ?? 0);
    }
  }
  setSend(auxId, patch) {
    const ch = this.cur();
    if (!ch) return;
    const s = ch.sends.find((x) => x.auxId === auxId);
    if (!s || s.locked) return;
    Object.assign(s, patch);
    this.sendCh(ch.id, "setSend", { auxId, ...patch }, "send" + auxId);
    this.refreshDetail();
  }

  refreshDetail() {
    const ch = this.cur();
    this.detailEmpty.hidden = !!ch;
    for (const p of this.detailParts) p.hidden = !ch;
    this.nameEl.textContent = ch ? ch.label : "—";
    if (!ch) return;
    for (const fn of this.binds) fn();
  }

  // ───── Überschriebene Darstellungs-Hooks ─────
  applyUiToToolbar() {}
  layoutNow() {
    this.width = this.host.clientWidth || this.width || 1000;
    this.root.dataset.layout = "c2";
    // Höhe = sichtbarer Bereich des Containers (Kachel/Fenster), s. fitHeight; Minimum und Kompaktwert kommen aus dem CSS (--c2-min).
    if (this.fitHeight) this.fitHeight();
  }
  applyLayoutVars() {}
  centerIsOpen() { return !this.drawer.hidden; }
  closeCenter() { this.toggleDrawer(false); }
  updateMasterUi() {
    const l = this.state.masterLimiter;
    this.limBtn.setAttribute("aria-pressed", String(!!l.enabled));
    this.limThr.setValue(l.thresholdDb);
  }
  renderGroups() {}
  renderOutputs() {
    // Gruppen-Fader + Ausgänge (Busse) als Züge rechts neben den Kanälen
    const st = this.state;
    const buses = [...st.auxBuses].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
    const sig = JSON.stringify([st.groups.map((g) => g.id), buses.map((b) => b.id)]);
    const want = new Set([...st.groups.map((g) => "g" + g.id), ...buses.map((b) => "b" + b.id)]);
    for (const [k, v] of this.stripViews) if (!want.has(k)) { v.root.remove(); this.stripViews.delete(k); }
    let i = 0;
    for (const g of st.groups) {
      const k = "g" + g.id;
      if (!this.stripViews.has(k)) {
        const sv = new StripV2(this, {
          kind: "grp", label: g.label, num: "G" + (++i), color: "#b57bff", noSolo: true, noKnob: true, noMeter: true,
          onGain: (db) => { const x = this.state.groups.find((y) => y.id === g.id); if (x) x.gainDb = db; this.touchedAt = performance.now(); this.sendNow(`group.${g.id}.setGain`, { db }, "gg" + g.id); },
          onGainCommit: () => this.setGainCommit(),
          onMute: () => { const x = this.state.groups.find((y) => y.id === g.id); if (x) this.cmd(`group.${g.id}.setMute`, { muted: !x.mute }).then(() => this.poll()); },
          onSelect: () => { const f = this.state.channels.find((c) => c.group === g.id); if (f) this.select(f.id); },
        });
        sv.meterBox.style.opacity = ".25";
        this.stripViews.set(k, sv);
      }
      const sv = this.stripViews.get(k);
      sv.setLabel(g.label);
      sv.setGain(g.gainDb ?? 0);
      sv.mute.setAttribute("aria-pressed", String(!!g.mute));
    }
    const kc = { group: "#27c3b0", aux: "#f5a524", n1: "#b57bff" };
    let n = 0;
    for (const a of buses) {
      const k = "b" + a.id;
      n++;
      if (!this.stripViews.has(k)) {
        const sv = new StripV2(this, {
          kind: "bus", label: a.label, num: "B" + n, color: kc[a.kind] || "#f5a524", noSolo: true, noKnob: true,
          onGain: (db) => { const x = this.state.auxBuses.find((y) => y.id === a.id); if (x) x.masterDb = db; this.touchedAt = performance.now(); this.sendNow(`aux.${a.id}.setMaster`, { db }, "am" + a.id); },
          onGainCommit: () => this.setGainCommit(),
          onMute: () => { const x = this.state.auxBuses.find((y) => y.id === a.id); if (x) this.cmd(`aux.${a.id}.setMaster`, { muted: !x.mute }).then(() => this.poll()); },
          onSelect: () => this.openOutputs(),
        });
        this.stripViews.set(k, sv);
      }
      const sv = this.stripViews.get(k);
      sv.setLabel(a.label);
      sv.num.textContent = outputKind(a).slice(0, 8);
      sv.setGain(a.masterDb ?? 0);
      sv.mute.setAttribute("aria-pressed", String(!!a.mute));
      sv.root.dataset.muted = a.mute ? "1" : "0";
    }
    if (this.busSig !== sig) {
      this.busSig = sig;
      this.busesEl.replaceChildren(...st.groups.map((g) => this.stripViews.get("g" + g.id).root), ...buses.map((b) => this.stripViews.get("b" + b.id).root));
      this.busesEl.hidden = !this.busesEl.children.length;
      this.board.querySelectorAll(".c2-sep")[1].hidden = this.busesEl.hidden;
    }
  }
  renderScenes() {
    const key = JSON.stringify([this.state.scenes, this.state.audioContext.activeScene]);
    if (key === this.sceneKey) return;
    this.sceneKey = key;
    this.sceneBar.replaceChildren(...this.state.scenes.map((s) => h("button", { class: "c2-btn", type: "button", text: s.label, "aria-pressed": String(this.state.audioContext.activeScene === s.id), title: T("am5.c44e5c"), onclick: () => this.cmd("activateScene", { sceneId: s.id }).then(() => this.poll()) })));
  }

  afterState() {
    const ids = this.state.channels.map((c) => c.id);
    if (!this.ui.selected || !ids.includes(this.ui.selected)) this.ui.selected = ids[0] || "";
    const sig = JSON.stringify([this.state.channels.map((c) => [c.id, c.group, c.source]), this.state.groups.map((g) => [g.id, g.label])]);
    if (sig !== this.lastSig) { this.lastSig = sig; this.renderChannels(); } else this.updateChannels();
    this.renderScenes();
    this.renderOutputs();
    if (this.outputs && this.outputs.isOpen) this.outputs.render();
    if (this.follow && this.follow.isOpen) this.follow.render();
    if (this.global && this.global.isOpen) this.global.refresh();
    this.updateMasterUi();
    this.presetBars = (this.presetBars || []).filter((b) => b.root.isConnected || performance.now() - b.born < 3000);
    for (const b of this.presetBars) b.render();
    if (!this.drawer.hidden) this.center.refresh();
    this.refreshDetail();
  }

  colorOf(ch) {
    const gi = this.state.groups.findIndex((g) => g.id === ch.group);
    if (gi >= 0) return C2_PALETTE[gi % C2_PALETTE.length];
    const key = ch.source || ch.id;
    let hsh = 0;
    for (const c of String(key)) hsh = (hsh * 31 + c.charCodeAt(0)) >>> 0;
    return C2_PALETTE[2 + (hsh % (C2_PALETTE.length - 2))];
  }
  mkStrip(ch) {
    const id = ch.id;
    return new StripV2(this, {
      kind: "ch", label: ch.label, num: "", color: this.colorOf(ch),
      knob: { label: "", min: -1, max: 1, step: 0.01, def: 0, bipolar: true, fmt: (v) => (Math.abs(v) < 0.005 ? "C" : v < 0 ? "L" + Math.round(-v * 100) : "R" + Math.round(v * 100)), set: (v) => { const c = this.state.channels.find((x) => x.id === id); if (c) { c.proc.pan = Math.abs(v) < 0.03 ? 0 : v; this.sendCh(id, "setPan", { pan: c.proc.pan }, "pan"); } } },
      onSelect: () => this.select(id),
      onOpen: () => { this.select(id); this.toggleDrawer(true); },
      onGain: (db) => this.setGainLive(id, db),
      onGainCommit: () => this.setGainCommit(),
      onMute: () => this.toggleMute(id),
      onSolo: () => this.togglePfl(id),
    });
  }
  renderChannels() {
    const st = this.state;
    const ids = new Set(st.channels.map((c) => c.id));
    for (const [id, v] of this.views) if (!ids.has(id)) { v.root.remove(); this.views.delete(id); }
    for (const ch of st.channels) if (!this.views.has(ch.id)) this.views.set(ch.id, this.mkStrip(ch));
    this.channelsEl.replaceChildren(...st.channels.map((c) => this.views.get(c.id).root));
    this.updateChannels();
  }
  updateChannel(ch) {
    const v = this.views.get(ch.id);
    if (!v) return;
    const live = this.live.get(ch.id);
    const ctx = this.ctxFor(ch);
    const idx = this.state.channels.indexOf(ch);
    v.setLabel(ch.label);
    v.tab.style.removeProperty("background");
    v.root.style.setProperty("--col", this.colorOf(ch));
    v.setGain(ch.gainDb);
    v.num.textContent = String(idx + 1);
    const muted = ch.mute || ctx.groupMuted;
    v.set("mute", muted, (m) => { v.mute.setAttribute("aria-pressed", String(m)); v.root.dataset.muted = m ? "1" : "0"; });
    v.set("gm", ctx.groupMuted, (m) => { v.root.dataset.groupmuted = m ? "1" : "0"; });
    v.set("pfl", !!ch.pfl, (m) => v.solo.setAttribute("aria-pressed", String(m)));
    v.set("sel", ctx.selected, (m) => { v.root.dataset.sel = m ? "1" : "0"; });
    v.set("air", live && live.onAir ? 1 : 0, (m) => { v.root.dataset.onair = String(m); });
    v.knob?.setValue(ch.proc.pan);
    const fl = [];
    if (ch.manual) fl.push("MAN");
    else if (ctx.autoMixActive) fl.push("AUTO" + (live ? " " + fmtSigned(live.autoDb || 0, 0) : ""));
    if (live && live.duckDb < -0.3) fl.push("DUCK");
    if (ch.follow && ch.follow.mode && ch.follow.mode !== "off") fl.push(live && live.afv === false ? "AFV○" : "AFV●");
    v.set("flags", fl.join(" "), (t) => { v.flags.textContent = t; });
  }
  select(id, opts = {}) {
    this.ui.selected = id;
    this.saveUi();
    this.updateChannels();
    this.refreshDetail();
    if (!this.drawer.hidden) this.center.refresh();
    if (opts.open) this.toggleDrawer(true);
    const ch = this.state.channels.find((c) => c.id === id);
    if (ch) this.announce(T("am5.faaa33", { p0: ch.label }));
  }
  step(dir) {
    const ids = this.state.channels.map((c) => c.id);
    if (!ids.length) return;
    const i = ids.indexOf(this.ui.selected);
    this.select(ids[(i + dir + ids.length) % ids.length]);
    this.views.get(this.ui.selected)?.root.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  tick(now) {
    this.raf = requestAnimationFrame((t) => this.tick(t));
    if (now - (this.lastTick || 0) < 33) return;
    this.lastTick = now;
    for (const [id, v] of this.views) {
      const l = this.live.get(id);
      if (!l) continue;
      v.setLevel(l.rms || 0, l.peak || 0, now);
      const sig = (l.onAir ? 1 : 0) + "|" + (l.afv === false ? 0 : 1) + "|" + Math.round((l.autoDb || 0)) + "|" + Math.round((l.duckDb || 0) * 10);
      if (v.liveSig !== sig) {
        if (v.liveSig !== undefined && String(v.liveSig).charAt(0) !== sig.charAt(0)) this.pollSoon(); // Stummzustand sofort nachladen (s. 30-panel.js)
        v.liveSig = sig;
        const ch = this.state.channels.find((c) => c.id === id);
        if (ch) this.updateChannel(ch);
      }
    }
    for (const [k, v] of this.stripViews) {
      if (!k.startsWith("b")) continue;
      const l = this.live.get("aux-" + k.slice(1));
      if (l) v.setLevel(l.rms || 0, l.peak || 0, now);
    }
    this.master.setLevel(this.masterLive.rms || 0, this.masterLive.peak || 0, now);
    const gr = "GR " + fmtSigned(this.masterLive.gr || 0);
    if (this.limGr.textContent !== gr) this.limGr.textContent = gr;
    for (const fn of this.liveBinds) fn(now);
    if (!this.drawer.hidden) this.center.tickLive(now);
  }
}

/** Oberfläche im selben Element wechseln (nur Darstellung; Audio-State bleibt unberührt). */
function swapSkin(app, skin) {
  setSkin(skin);
  const host = app.host, id = app.nodeId;
  app.destroy();
  app.shadow.replaceChildren();
  host.app = skin === "v2" ? new ConsoleApp(host, id) : new MixerApp(host, id);
}

class OmpAudioMixerPanel extends HTMLElement {
  connectedCallback() {
    this.app = getSkin() === "v2" ? new ConsoleApp(this, this.getAttribute("node-id")) : new MixerApp(this, this.getAttribute("node-id"));
  }
  disconnectedCallback() {
    this.app?.destroy();
  }
}

if (!customElements.get("omp-audio-mixer-panel")) {
  customElements.define("omp-audio-mixer-panel", OmpAudioMixerPanel);
}
