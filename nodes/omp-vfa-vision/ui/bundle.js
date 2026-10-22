// Anzeige der Gesichtserkennung (Kapitel 46): je Kamera, ob ein Bild kommt und wie viele
// Gesichter wo gesehen werden. Reine Diagnose — eingestellt wird alles in „Video folgt Audio“.
class OmpVfaVisionPanel extends HTMLElement {
  connectedCallback() {
    this.nodeId = this.getAttribute("node-id");
    const root = this.attachShadow({ mode: "open" });
    const de = (document.documentElement.lang || "de").startsWith("de");
    this.t = de
      ? { hint: "Die Kameras gibt „Video folgt Audio“ vor. Hier siehst du, was erkannt wird.", none: "Noch keine Kamera gemeldet. „Video folgt Audio“ starten und Kameras anlegen.", noimg: "kein Bild", faces: "Gesichter", size: "Größe", ok: "erkennt" }
      : { hint: "Cameras are provided by “Video follows audio”. This shows what is detected.", none: "No camera reported yet. Start “Video follows audio” and add cameras.", noimg: "no picture", faces: "faces", size: "size", ok: "detecting" };
    root.innerHTML = `<style>
      :host{display:block;font:13px/1.35 var(--omp-font,system-ui,sans-serif);color:var(--omp-text,#eaf0fa);padding:10px;background:var(--omp-bg,#080c16);--line:var(--omp-border,#223049);--ok:var(--omp-preset,#43a047);--bad:var(--omp-onair,#e53935)}
      .hint{color:var(--omp-text-dim,#93a1ba);margin:0 0 8px}.cam{border:1px solid var(--line);border-radius:8px;background:var(--omp-surface,#0f1522);padding:8px 10px;margin:6px 0}
      .head{display:flex;gap:8px;align-items:center}.dot{width:8px;height:8px;border-radius:50%;background:var(--bad)}.dot.ok{background:var(--ok);box-shadow:0 0 6px 1px #43a04799}
      .frame{position:relative;width:100%;max-width:320px;aspect-ratio:16/9;background:#000;border:1px solid var(--line);margin-top:6px;border-radius:4px}
      .f{position:absolute;border:2px solid var(--omp-accent-cyan,#19d3f3);border-radius:3px;box-sizing:border-box}.err{color:#ef5350;font-size:12px}
    </style><p class="hint">${this.t.hint}</p><div id="c"></div>`;
    this.box = root.getElementById("c");
    this.tick();
    this.timer = setInterval(() => this.tick(), 500);
  }
  disconnectedCallback() { clearInterval(this.timer); }
  async tick() {
    let st;
    try {
      let tok = null; try { tok = localStorage.getItem("omp-auth-token"); } catch {}
      const r = await fetch(`/api/v1/nodes/${this.nodeId}/params/status`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
      if (!r.ok) return;
      st = (await r.json()).value;
    } catch { return; }
    const cams = st.cameras || [];
    if (!cams.length) { this.box.innerHTML = `<p class="hint">${this.t.none}</p>`; return; }
    this.box.replaceChildren(...cams.map((c) => {
      const el = document.createElement("div"); el.className = "cam";
      const live = c.ok && c.ageMs < 2000;
      el.innerHTML = `<div class="head"><span class="dot ${live ? "ok" : ""}"></span><b></b><span>${live ? `${c.faces.length} ${this.t.faces}` : this.t.noimg}</span></div>${c.error ? `<div class="err"></div>` : ""}<div class="frame"></div>`;
      el.querySelector("b").textContent = c.id;
      if (c.error) el.querySelector(".err").textContent = c.error;
      const fr = el.querySelector(".frame");
      if (live) for (const f of c.faces) {
        const s = Math.max(f.size_percent, 4), d = document.createElement("div"); d.className = "f";
        Object.assign(d.style, { left: `${(f.center_x - s / 200) * 100}%`, width: `${s}%`, top: `${(f.center_y - (s / 200) * 16 / 9) * 100}%`, height: `${(s * 16) / 9}%` });
        d.title = `${f.size_percent} %`; fr.append(d);
      }
      return el;
    }));
  }
}
if (!customElements.get("omp-vfa-vision-panel")) customElements.define("omp-vfa-vision-panel", OmpVfaVisionPanel);
