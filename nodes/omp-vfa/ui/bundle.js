// Bedienoberfläche „Video folgt Audio“ (Kapitel 46): drei Schritte, ein großer Schalter.
// 1 Geräte wählen → 2 Personen anlegen und „Einrichten“ (Person spricht kurz, Kamera-
// Gesichter werden vorgeschlagen, ein Klick bestätigt) → 3 Schalter AN. Alles läuft über
// die Orchestrator-Proxy-API (Rechte und Audit gelten unverändert).
const T = (() => {
  const de = {
    title: "Video folgt Audio", on: "AN", off: "AUS", sub: "Die Kamera schaltet automatisch auf die Person, die gerade spricht.",
    live: "Auf Sendung", nobody: "Niemand spricht", silent: "Stille", speaking: "spricht",
    s1: "1  Geräte", videoMixer: "Bildmischer", audioMixer: "Tonmischer", choose: "— wählen —",
    cams: "Kameras", addCam: "Kamera hinzufügen", camName: "Name", wide: "Totale bei Stille", noWide: "keine (Bild bleibt)",
    s2: "2  Personen", addPerson: "+ Person", name: "Name der Person", mic: "Mikrofon", setup: "Einrichten", redo: "Neu einrichten",
    ready: "bereit", needSetup: "noch nicht eingerichtet", needMic: "Mikrofon wählen",
    learnTitle: "Bitte jetzt sprechen", learnHint: "{n} s – {name} spricht, die Kameras schauen zu.",
    pickTitle: "Welche Gesichter sind {name}?", pickHint: "Pro Kamera ist der wahrscheinlichste Treffer gewählt. Klicken Sie auf ein anderes Gesicht oder schalten Sie eine Kamera ab.",
    take: "Übernehmen", cancel: "Abbrechen", cutNow: "Test: jetzt schalten", remove: "Entfernen",
    advanced: "Feineinstellungen", speakDb: "Sprechschwelle (dBFS)", hold: "Reaktionszeit (ms)", minShot: "Mindestdauer eines Bildes (ms)", wideAfter: "Totale nach Stille (s)",
    noCamFace: "Kein Gesicht gesehen – ist die Kamera auf die Person gerichtet?", error: "Fehler", nodeNone: "Keine Geräte gefunden",
    hintStart: "Zum Starten: Bildmischer und Tonmischer wählen, Kameras und Personen anlegen.",
  };
  const en = {
    title: "Video follows audio", on: "ON", off: "OFF", sub: "The camera cuts automatically to the person who is speaking.",
    live: "On air", nobody: "Nobody speaking", silent: "Silence", speaking: "speaking",
    s1: "1  Devices", videoMixer: "Video mixer", audioMixer: "Audio mixer", choose: "— choose —",
    cams: "Cameras", addCam: "Add camera", camName: "Name", wide: "Wide shot on silence", noWide: "none (keep picture)",
    s2: "2  People", addPerson: "+ Person", name: "Person's name", mic: "Microphone", setup: "Set up", redo: "Set up again",
    ready: "ready", needSetup: "not set up yet", needMic: "choose a microphone",
    learnTitle: "Please speak now", learnHint: "{n} s – {name} speaks, the cameras are watching.",
    pickTitle: "Which faces are {name}?", pickHint: "The most likely match is selected per camera. Click another face or switch a camera off.",
    take: "Apply", cancel: "Cancel", cutNow: "Test: cut now", remove: "Remove",
    advanced: "Fine tuning", speakDb: "Speech threshold (dBFS)", hold: "Reaction time (ms)", minShot: "Minimum shot length (ms)", wideAfter: "Wide shot after silence (s)",
    noCamFace: "No face seen – is the camera pointing at the person?", error: "Error", nodeNone: "No devices found",
    hintStart: "To start: choose video and audio mixer, add cameras and people.",
  };
  return (k, p) => {
    const lang = (document.documentElement.lang || "de").slice(0, 2);
    let s = (lang === "en" ? en : de)[k] ?? de[k] ?? k;
    for (const [a, b] of Object.entries(p || {})) s = s.replace(`{${a}}`, b);
    return s;
  };
})();

const CSS = `
:host{display:block;font:13px/1.35 var(--omp-font,system-ui,sans-serif);color:var(--fg);--bg:var(--omp-bg,#080c16);--card:var(--omp-surface,#0f1522);--raised:var(--omp-surface-raised,#172033);--fg:var(--omp-text,#eaf0fa);--dim:var(--omp-text-dim,#93a1ba);--line:var(--omp-border,#223049);--acc:var(--omp-accent-cyan,#19d3f3);--ok:var(--omp-preset,#43a047);--air:var(--omp-onair,#e53935);--m1:#3d434b;--m2:#2b2f34;--m3:#1a1c1f;--hi:#565d66}
*{box-sizing:border-box}
.wrap{max-width:900px;margin:0 auto;padding:10px;background:var(--bg)}
.top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.master,button.b{border:1px solid #000;border-top-color:var(--hi);background:linear-gradient(180deg,var(--m1),var(--m2) 55%,var(--m3));color:var(--fg);cursor:pointer;box-shadow:0 2px 0 #000,0 3px 4px #0008,inset 0 1px 0 #ffffff1f;transition:transform .04s,box-shadow .04s}
.master{font-size:14px;font-weight:700;padding:0 18px;height:40px;border-radius:7px;min-width:150px}
.master:active,button.b:active:not(:disabled),.master[aria-pressed=true]{transform:translateY(2px);box-shadow:0 0 0 #000,inset 0 2px 5px #0009}
.master[aria-pressed=true]{background:linear-gradient(180deg,#2f7d32,var(--ok) 60%,#2f7d32);border-color:#000;color:#fff;box-shadow:0 0 8px 1px #43a04799,inset 0 2px 4px #0006}
.now{flex:1;min-width:200px}.now b{font-size:14px}.dim{color:var(--dim)}
.card{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:10px;margin-bottom:10px}
h2{font-size:11px;margin:0 0 8px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em;font-weight:600}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:6px 0}
label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--dim)}
select,input{font:inherit;padding:5px 8px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);min-width:150px;color-scheme:dark}
select:focus,input:focus{outline:none;border-color:var(--acc);box-shadow:var(--omp-focus-ring,0 0 0 3px #19d3f32e)}
button.b{font:inherit;font-weight:600;padding:0 12px;height:30px;border-radius:6px}
button.b:disabled{opacity:.4;cursor:default}
button.b.pri{background:linear-gradient(180deg,#3fe0fa,var(--acc) 60%,#12a9c4);color:#06101a}
button.b.x{color:#ef5350}
.person{border:1px solid var(--line);border-radius:8px;background:var(--raised);padding:8px;margin:6px 0;display:grid;gap:6px}
.person[data-speaking=true]{border-color:var(--air);box-shadow:0 0 0 2px var(--air)}
.meter{height:6px;border-radius:3px;background:var(--line);overflow:hidden;min-width:100px;flex:1}.meter i{display:block;height:100%;background:linear-gradient(90deg,var(--acc),#a45cff);width:0}
.chip{font-size:12px;padding:2px 9px;border-radius:12px;border:1px solid var(--line)}
.chip.ok{border-color:var(--ok);color:var(--ok)}.chip.warn{color:var(--dim)}
.camgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
.cam{position:relative;border:2px solid var(--line);border-radius:10px;overflow:hidden;background:#000;aspect-ratio:16/9}
.cam.onair{border-color:var(--air)}.cam.off{opacity:.45}
.cam img{width:100%;height:100%;object-fit:fill;display:block}
.cam .cap{position:absolute;left:0;right:0;bottom:0;padding:3px 8px;background:#000a;color:#fff;font-size:12px;display:flex;justify-content:space-between}
.face{position:absolute;border:2px solid #ffd33d;border-radius:4px;cursor:pointer;background:#ffd33d22}
.face.sel{border-color:var(--ok);background:#3fb95033;border-width:3px}
.overlay{position:fixed;inset:0;background:#000a;display:grid;place-items:center;z-index:9}
.dlg{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;max-width:760px;width:calc(100% - 32px);max-height:90vh;overflow:auto}
.big{font-size:44px;font-weight:700;text-align:center;margin:10px 0}
.toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--air);color:#fff;padding:8px 16px;border-radius:8px;z-index:10}
details summary{cursor:pointer;color:var(--dim)}
`;

class OmpVfaPanel extends HTMLElement {
  connectedCallback() {
    this.nodeId = this.getAttribute("node-id");
    this.root = this.attachShadow({ mode: "open" });
    this.cfg = null; this.status = null; this.nodes = []; this.channels = []; this.sel = {};
    this.timers = [];
    this.build();
    this.loadAll();
    this.timers.push(setInterval(() => this.poll(), 400));
    this.timers.push(setInterval(() => this.loadNodes(), 10000));
  }
  disconnectedCallback() { this.timers.forEach(clearInterval); this.previewStop = true; }

  hdr() {
    let t = null; try { t = localStorage.getItem("omp-auth-token"); } catch {}
    return t ? { Authorization: `Bearer ${t}` } : {};
  }
  async api(path, opt = {}) {
    const r = await fetch(`/api/v1/nodes/${this.nodeId}/${path}`, { ...opt, headers: { "Content-Type": "application/json", ...this.hdr(), ...(opt.headers || {}) } });
    if (!r.ok) throw new Error((await r.text()).trim() || `HTTP ${r.status}`);
    return r.json();
  }
  call(name, args) { return this.api(`methods/${name}`, { method: "POST", body: JSON.stringify(args || {}) }); }
  async save() { try { await this.call("setConfig", { json: JSON.stringify(this.cfg) }); } catch (e) { this.toast(e.message); } }
  toast(msg) {
    const d = document.createElement("div"); d.className = "toast"; d.textContent = `${T("error")}: ${msg}`;
    this.root.append(d); setTimeout(() => d.remove(), 4000);
  }
  async loadNodes() {
    try {
      const r = await fetch("/api/v1/nodes", { headers: this.hdr() });
      const nodes = (await r.json()).filter((n) => n.online && n.id !== this.nodeId);
      const sig = JSON.stringify(nodes.map((n) => [n.id, n.label]));
      this.nodes = nodes;
      if (sig === this.nodeSig) return; // nur neu zeichnen, wenn sich die Geräteliste ändert (sonst geht der Fokus verloren)
      this.nodeSig = sig;
    } catch { return; }
    this.renderDevices();
  }
  async loadChannels() {
    try { this.channels = (await this.api("params/channels")).value || []; } catch { this.channels = []; }
    this.renderPeople();
  }
  async loadAll() {
    await this.loadNodes();
    try { this.cfg = (await this.api("params/config")).value; } catch (e) { this.toast(e.message); return; }
    this.cfg.cameras ||= []; this.cfg.people ||= [];
    this.renderAll(); this.loadChannels();
  }

  build() {
    this.root.innerHTML = `<style>${CSS}</style><div class="wrap">
      <div class="top"><button class="master" id="master" aria-pressed="false"></button>
        <div class="now"><div id="now"></div><div class="dim" id="sub"></div></div></div>
      <div id="hint" class="card dim" hidden></div>
      <div class="card" id="devices"></div>
      <div class="card" id="people"></div>
      <div class="card"><details><summary id="advSum"></summary><div class="row" id="adv"></div></details></div>
      <div id="modal"></div></div>`;
    this.$ = (id) => this.root.getElementById ? this.root.getElementById(id) : this.root.querySelector("#" + id);
    this.$("master").addEventListener("click", () => { this.cfg.enabled = !this.cfg.enabled; this.save(); this.paintMaster(); });
    this.$("advSum").textContent = T("advanced");
    this.$("sub").textContent = T("sub");
  }
  renderAll() { this.paintMaster(); this.renderDevices(); this.renderPeople(); this.renderAdv(); }
  paintMaster() {
    const b = this.$("master"); if (!this.cfg) return;
    b.setAttribute("aria-pressed", String(!!this.cfg.enabled));
    b.textContent = `${T("title")}: ${this.cfg.enabled ? T("on") : T("off")}`;
    const ready = this.cfg.videoMixer && this.cfg.audioMixer && this.cfg.cameras.length && this.cfg.people.some((p) => p.shots?.length);
    this.$("hint").hidden = !!ready; this.$("hint").textContent = T("hintStart");
  }

  select(label, value, options, onChange, blank = T("choose")) {
    const l = document.createElement("label"); l.append(label);
    const s = document.createElement("select");
    for (const [v, t] of [["", blank], ...options]) { const o = document.createElement("option"); o.value = v; o.textContent = t; s.append(o); }
    s.value = value || ""; s.addEventListener("change", () => onChange(s.value)); l.append(s); return l;
  }
  input(label, value, onChange, type = "text") {
    const l = document.createElement("label"); l.append(label);
    const i = document.createElement("input"); i.type = type; i.value = value ?? "";
    i.addEventListener("change", () => onChange(type === "number" ? Number(i.value) : i.value)); l.append(i); return l;
  }
  btn(text, cls, fn) { const b = document.createElement("button"); b.className = `b ${cls || ""}`; b.textContent = text; b.addEventListener("click", fn); return b; }

  renderDevices() {
    if (!this.cfg) return;
    const box = this.$("devices"); const nodeOpts = this.nodes.map((n) => [n.id, n.label]);
    const keep = (id, label) => (id && !this.nodes.some((n) => n.id === id) ? [[id, `${label} (offline)`]] : []);
    box.replaceChildren();
    const h = document.createElement("h2"); h.textContent = T("s1"); box.append(h);
    const r1 = document.createElement("div"); r1.className = "row";
    r1.append(
      this.select(T("videoMixer"), this.cfg.videoMixer, [...nodeOpts, ...keep(this.cfg.videoMixer, T("videoMixer"))], (v) => { this.cfg.videoMixer = v; this.save(); this.paintMaster(); }),
      this.select(T("audioMixer"), this.cfg.audioMixer, [...nodeOpts, ...keep(this.cfg.audioMixer, T("audioMixer"))], (v) => { this.cfg.audioMixer = v; this.save().then(() => this.loadChannels()); this.paintMaster(); }),
    );
    box.append(r1);
    const ch = document.createElement("h2"); ch.textContent = T("cams"); ch.style.marginTop = "14px"; box.append(ch);
    const grid = document.createElement("div"); grid.className = "camgrid"; this.camGrid = grid; box.append(grid);
    this.cfg.cameras.forEach((c, i) => {
      const cell = document.createElement("div");
      const row = document.createElement("div"); row.className = "row";
      row.append(
        this.input(T("camName"), c.name, (v) => { c.name = v; this.save(); }),
        this.select("Node", c.nodeId, [...nodeOpts, ...keep(c.nodeId, c.name)], (v) => { c.nodeId = v; if (!c.name) c.name = this.nodes.find((n) => n.id === v)?.label || ""; this.save(); this.renderDevices(); }),
        this.btn("✕", "x", () => { this.cfg.cameras.splice(i, 1); this.cfg.people.forEach((p) => { p.shots = (p.shots || []).filter((s) => s.cameraId !== c.id); }); if (this.cfg.wideCamera === c.id) this.cfg.wideCamera = ""; this.save(); this.renderAll(); }),
      );
      cell.append(row); box.append(cell);
    });
    const add = this.btn(`+ ${T("addCam")}`, "", () => {
      let n = 1; while (this.cfg.cameras.some((c) => c.id === `cam-${n}`)) n++;
      this.cfg.cameras.push({ id: `cam-${n}`, name: `Kamera ${n}`, nodeId: "" }); this.save(); this.renderDevices();
    });
    const w = this.select(T("wide"), this.cfg.wideCamera, this.cfg.cameras.map((c) => [c.id, c.name || c.id]), (v) => { this.cfg.wideCamera = v; this.save(); }, T("noWide"));
    const r2 = document.createElement("div"); r2.className = "row"; r2.append(add, w); box.append(r2);
  }
  renderPeople() {
    if (!this.cfg) return;
    const box = this.$("people"); box.replaceChildren();
    const h = document.createElement("h2"); h.textContent = T("s2"); box.append(h);
    this.personEls = {};
    for (const p of this.cfg.people) {
      const el = document.createElement("div"); el.className = "person"; this.personEls[p.id] = el;
      const r = document.createElement("div"); r.className = "row";
      const chOpts = this.channels.map((c) => [c.id, c.label || c.id]);
      if (p.mic && !chOpts.some(([v]) => v === p.mic)) chOpts.push([p.mic, p.mic]);
      const meter = document.createElement("div"); meter.className = "meter"; meter.innerHTML = "<i></i>";
      r.append(
        this.input(T("name"), p.name, (v) => { p.name = v; this.save(); }),
        this.select(T("mic"), p.mic, chOpts, (v) => { p.mic = v; this.save(); this.renderPeople(); }),
        meter,
      );
      const r2 = document.createElement("div"); r2.className = "row";
      const shots = p.shots || [];
      const chip = document.createElement("span");
      if (!p.mic) { chip.className = "chip warn"; chip.textContent = T("needMic"); }
      else if (!shots.length) { chip.className = "chip warn"; chip.textContent = T("needSetup"); }
      else { chip.className = "chip ok"; chip.textContent = `✓ ${T("ready")}: ${shots.map((s) => this.camName(s.cameraId)).join(", ")}`; }
      r2.append(chip);
      const setup = this.btn(shots.length ? T("redo") : T("setup"), shots.length ? "" : "pri", () => this.startSetup(p));
      setup.disabled = !p.mic || !this.cfg.cameras.length;
      r2.append(setup, this.btn("✕", "x", () => { this.cfg.people = this.cfg.people.filter((x) => x !== p); this.save(); this.renderPeople(); this.paintMaster(); }));
      el.append(r, r2); box.append(el);
    }
    box.append(this.btn(T("addPerson"), "", () => {
      let n = 1; while (this.cfg.people.some((p) => p.id === `p-${n}`)) n++;
      this.cfg.people.push({ id: `p-${n}`, name: "", mic: "", shots: [] }); this.save(); this.renderPeople();
    }));
  }
  renderAdv() {
    const a = this.$("adv"); a.replaceChildren();
    const num = (label, key) => this.input(label, this.cfg[key], (v) => { this.cfg[key] = v; this.save(); }, "number");
    a.append(num(T("speakDb"), "speakDb"), num(T("hold"), "speakHoldMs"), num(T("minShot"), "minShotMs"), num(T("wideAfter"), "wideAfterSec"));
  }
  camName(id) { const c = this.cfg.cameras.find((x) => x.id === id); return c ? c.name || c.id : id; }

  // ───── Einrichtung ─────
  async startSetup(p) {
    try { await this.call("learnStart", { personId: p.id }); } catch (e) { this.toast(e.message); return; }
    this.setupPerson = p; this.choice = null;
    this.paintModal();
  }
  paintModal() {
    const m = this.$("modal"); const L = this.status?.learn;
    if (!this.setupPerson || !L || L.personId !== this.setupPerson.id) { m.replaceChildren(); this.modalKey = ""; return; }
    const name = this.setupPerson.name || "…";
    if (L.running) {
      const key = "run";
      if (this.modalKey !== key) {
        this.modalKey = key;
        const d = this.dlg(); d.innerHTML = `<h2>${T("learnTitle")}</h2><div class="big" id="cd"></div><p class="dim" id="lh"></p>`;
        d.append(this.btn(T("cancel"), "", () => { this.call("learnCancel"); this.setupPerson = null; this.paintModal(); }));
      }
      m.querySelector("#cd").textContent = L.secondsLeft; m.querySelector("#lh").textContent = T("learnHint", { n: L.secondsLeft, name });
      return;
    }
    if (this.modalKey === "pick") return;
    this.modalKey = "pick";
    const d = this.dlg();
    d.innerHTML = `<h2>${T("pickTitle", { name })}</h2><p class="dim">${L.message || T("pickHint")}</p>`;
    // Standardwahl: je Kamera der häufigste Treffer
    const best = {}; for (const c of L.candidates) if (!best[c.cameraId]) best[c.cameraId] = c;
    this.choice = { ...best };
    const grid = document.createElement("div"); grid.className = "camgrid";
    for (const cam of this.cfg.cameras) {
      const cands = L.candidates.filter((c) => c.cameraId === cam.id);
      const box = document.createElement("div"); box.className = "cam";
      const cap = document.createElement("div"); cap.className = "cap"; cap.innerHTML = `<span>${cam.name || cam.id}</span>`;
      const img = document.createElement("img"); img.dataset.node = cam.nodeId; img.alt = ""; box.append(img);
      this.watchPreview(img);
      const paint = () => { box.classList.toggle("off", !this.choice[cam.id]); faces.forEach((f) => f.el.classList.toggle("sel", this.choice[cam.id] === f.c)); };
      const faces = cands.map((c) => {
        const el = document.createElement("div"); el.className = "face";
        const sz = Math.max(c.sizePercent, 6);
        Object.assign(el.style, { left: `${(c.centerX - sz / 200) * 100}%`, width: `${sz}%`, top: `${(c.centerY - sz / 200 * 16 / 9) * 100}%`, height: `${sz * 16 / 9}%` });
        el.title = `${c.seenPct} %`;
        el.addEventListener("click", () => { this.choice[cam.id] = this.choice[cam.id] === c ? undefined : c; paint(); });
        box.append(el); return { el, c };
      });
      if (!cands.length) { const t = document.createElement("span"); t.textContent = T("noCamFace"); t.className = "dim"; cap.append(t); cap.lastChild.style.fontSize = "11px"; }
      box.append(cap); grid.append(box); paint();
    }
    d.append(grid);
    const row = document.createElement("div"); row.className = "row";
    row.append(this.btn(T("take"), "pri", async () => {
      const shots = Object.values(this.choice).filter(Boolean).map((c) => ({ cameraId: c.cameraId, centerX: c.centerX, sizePercent: c.sizePercent }));
      try { await this.call("confirmShots", { personId: this.setupPerson.id, shots: JSON.stringify(shots) }); } catch (e) { this.toast(e.message); return; }
      this.setupPerson.shots = shots; this.setupPerson = null; this.modalKey = ""; this.paintModal(); this.renderPeople(); this.paintMaster();
    }), this.btn(T("cancel"), "", () => { this.call("learnCancel"); this.setupPerson = null; this.modalKey = ""; this.paintModal(); }));
    d.append(row);
  }
  dlg() {
    const m = this.$("modal"); m.replaceChildren();
    const o = document.createElement("div"); o.className = "overlay"; const d = document.createElement("div"); d.className = "dlg"; o.append(d); m.append(o); return d;
  }

  // Vorschaubilder: als Blob holen (kein Flackern, Token-Header möglich).
  async watchPreview(img) {
    const node = img.dataset.node; if (!node) return;
    while (img.isConnected) {
      try {
        const r = await fetch(`/api/v1/nodes/${node}/stream/previewUrl?t=${Date.now()}`, { headers: this.hdr() });
        if (r.ok) { const u = URL.createObjectURL(await r.blob()); const old = img.src; img.src = u; if (old.startsWith("blob:")) URL.revokeObjectURL(old); }
      } catch {}
      await new Promise((res) => setTimeout(res, 600));
    }
  }

  async poll() {
    if (!this.cfg) return;
    try { this.status = (await this.api("params/status")).value; } catch { return; }
    const s = this.status;
    const cur = this.cfg.cameras.find((c) => c.id === s.current);
    const sp = (s.people || []).find((x) => x.speaking);
    const spName = sp ? this.cfg.people.find((p) => p.id === sp.id)?.name || "?" : "";
    this.$("now").innerHTML = `<b>${T("live")}: ${cur ? cur.name || cur.id : "—"}</b> · ${sp ? `${spName} ${T("speaking")}` : T("silent")}${s.error ? ` · <span style="color:var(--air)">${s.error}</span>` : ""}`;
    for (const ps of s.people || []) {
      const el = this.personEls?.[ps.id]; if (!el) continue;
      el.dataset.speaking = String(ps.speaking);
      const pct = Math.max(0, Math.min(100, ((ps.db + 70) / 70) * 100));
      const i = el.querySelector(".meter i"); if (i) i.style.width = `${pct}%`;
    }
    this.paintModal();
  }
}

if (!customElements.get("omp-vfa-panel")) customElements.define("omp-vfa-panel", OmpVfaPanel);
