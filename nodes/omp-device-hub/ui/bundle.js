// Geräte-Hub-Panel (Kap. 34.4): erkannte lokale Video-/Audio-Geräte mit Schalter „im DMF/MXL anbieten“.
const T = (() => {
  const D = {
    de: {
      title: "Lokale Geräte", none: "Keine Video- oder Audio-Geräte erkannt.", rescan: "Neu suchen",
      offer: "Anbieten", offerOut: "Als Ausgang bereitstellen", video: "Video-Eingang", audio: "Audio-Eingang", audioOut: "Audio-Ausgang", waiting: "Wartet auf Verbindung", usb: "USB", pci: "PCI", other: "Lokal",
      off: "Aus", starting: "Startet …", flowing: "Sendet", absent: "Nicht angesteckt", error: "Fehler",
      hint: "Ein Eingang wird erst als MXL-Flow und NMOS-Sender angeboten, wenn er eingeschaltet ist; ein Ausgang erscheint dann als Empfänger in der Kreuzschiene und spielt, sobald eine Quelle verbunden ist. Die Auswahl bleibt über Neustarts erhalten.",
      ch: "Kanäle", failed: "Aktion fehlgeschlagen",
    },
    en: {
      title: "Local devices", none: "No video or audio devices detected.", rescan: "Rescan",
      offer: "Offer", offerOut: "Provide as output", video: "Video input", audio: "Audio input", audioOut: "Audio output", waiting: "Waiting for connection", usb: "USB", pci: "PCI", other: "Local",
      off: "Off", starting: "Starting …", flowing: "Live", absent: "Not plugged in", error: "Error",
      hint: "An input is only offered as an MXL flow and NMOS sender while it is switched on; an output then appears as a receiver in the crosspoint and plays once a source is connected. The selection persists across restarts.",
      ch: "channels", failed: "Action failed",
    },
  };
  const lang = document.documentElement.lang === "en" ? "en" : "de";
  return (k) => (D[lang] && D[lang][k]) ?? D.de[k] ?? k;
})();

// Reine Funktion: Kurzbeschreibung der Fähigkeiten eines Geräts.
function summarize(d) {
  if (d.kind === "video") {
    const m = [...(d.video_modes || [])].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    return m ? `${m.width}×${m.height}${m.max_fps ? ` @ ${Math.round(m.max_fps)}` : ""} ${m.format}` : "";
  }
  const ch = Math.max(0, ...(d.audio_modes || []).map((m) => m.channels));
  return ch ? `${ch} ${T("ch")}, 48 kHz` : "";
}
function statusKind(status) { return status.startsWith("error") ? "error" : status; }

class OmpDeviceHubPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; font-size: 12px; }
      .bar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
      h4 { margin: 0; font-size: 13px; flex: 1; }
      button { background: #222; color: #eee; border: 1px solid #555; border-radius: 3px; padding: 4px 8px; cursor: pointer; }
      .hint { opacity: .65; margin-bottom: 8px; }
      .dev { display: grid; grid-template-columns: auto 1fr auto; gap: 2px 10px; align-items: center; padding: 8px; margin-bottom: 6px; background: #1b1b1b; border: 1px solid #333; border-radius: 4px; }
      .dev[data-offered="1"] { border-color: #3a7; }
      .name { font-weight: bold; } .sub { opacity: .65; grid-column: 2; }
      .badge { padding: 2px 8px; border-radius: 10px; background: #333; font-size: 11px; }
      .badge.flowing { background: #1f6a3a; } .badge.error { background: #8a2a2a; } .badge.starting, .badge.absent, .badge.waiting { background: #6a5a1f; }
      .kind { font-size: 11px; opacity: .8; margin-right: 6px; }
      label.sw { display: flex; gap: 6px; align-items: center; cursor: pointer; }
      .empty { opacity: .65; padding: 12px 0; } .err { color: #e77; }
    `;
    const root = document.createElement("div");
    shadow.append(style, root);
    const title = document.createElement("h4"); title.textContent = T("title");
    const rescan = document.createElement("button"); rescan.textContent = T("rescan");
    const bar = document.createElement("div"); bar.className = "bar"; bar.append(title, rescan);
    const hint = document.createElement("div"); hint.className = "hint"; hint.textContent = T("hint");
    const msg = document.createElement("div"); msg.className = "err";
    const list = document.createElement("div");
    root.append(bar, hint, msg, list);

    const call = (method, body) => fetch(`/api/v1/nodes/${nodeId}/methods/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const rows = new Map();
    const makeRow = (d) => {
      const el = document.createElement("div"); el.className = "dev"; el.dataset.id = d.id;
      const sw = document.createElement("label"); sw.className = "sw";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.setAttribute("aria-label", T("offer"));
      const swText = document.createElement("span"); swText.textContent = d.direction === "output" ? T("offerOut") : T("offer");
      sw.append(cb, swText);
      const name = document.createElement("div"); name.className = "name";
      const kind = document.createElement("span"); kind.className = "kind";
      const nameText = document.createElement("span");
      name.append(kind, nameText);
      const badge = document.createElement("span"); badge.className = "badge";
      const sub = document.createElement("div"); sub.className = "sub";
      el.append(sw, name, badge, document.createElement("span"), sub);
      cb.addEventListener("change", async () => {
        cb.disabled = true;
        const res = await call("setOffered", { id: d.id, on: cb.checked });
        msg.textContent = res.ok ? "" : `${T("failed")}: ${(await res.json().catch(() => ({}))).error || res.statusText}`;
        cb.disabled = false;
        poll();
      });
      return { el, cb, kind, nameText, badge, sub };
    };
    const update = (r, d) => {
      r.el.dataset.offered = d.offered ? "1" : "0";
      if (document.activeElement !== r.cb && !r.cb.disabled) r.cb.checked = d.offered;
      const kindKey = d.kind === "audio" && d.direction === "output" ? "audioOut" : d.kind;
      r.kind.textContent = `${T(kindKey)} · ${T(d.transport)}`;
      r.nameText.textContent = d.name;
      const k = statusKind(d.status);
      r.badge.className = `badge ${k}`;
      r.badge.textContent = T(k);
      r.badge.title = d.status.startsWith("error") ? d.status : "";
      r.sub.textContent = [summarize(d), d.node].filter(Boolean).join(" · ");
      r.sub.title = d.id;
    };
    const render = (devices) => {
      if (!devices.length) {
        list.replaceChildren(Object.assign(document.createElement("div"), { className: "empty", textContent: T("none") }));
        rows.clear();
        return;
      }
      if (list.querySelector(".empty")) list.replaceChildren();
      const ids = new Set(devices.map((d) => d.id));
      for (const [id, r] of rows) if (!ids.has(id)) { r.el.remove(); rows.delete(id); }
      for (const d of devices) {
        let r = rows.get(d.id);
        if (!r) { r = makeRow(d); rows.set(d.id, r); }
        update(r, d);
        list.append(r.el); // hält die Reihenfolge (nach ID sortiert) ohne Neuaufbau
      }
    };
    const poll = async () => {
      try {
        const res = await fetch(`/api/v1/nodes/${nodeId}/params/devices`);
        if (res.ok) render((await res.json()).value || []);
      } catch { /* Verfügbarkeit zeigt die Shell */ }
    };
    rescan.addEventListener("click", async () => { await call("rescan"); setTimeout(poll, 1500); });
    poll();
    this._interval = setInterval(poll, 1500);
  }
  disconnectedCallback() { clearInterval(this._interval); }
}

if (!customElements.get("omp-device-hub-panel")) customElements.define("omp-device-hub-panel", OmpDeviceHubPanel);
