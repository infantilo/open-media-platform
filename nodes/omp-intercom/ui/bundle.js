// ui/modules/intercom/deck/logic.ts
function itemsFor(s, latch) {
  const items = [];
  const me = s.me;
  items.push({
    key: {
      label: me.forced ? "Gesperrt" : me.muted ? "Stumm" : "Mikro",
      sub: me.forced ? "On Air" : void 0,
      state: me.forced || me.muted ? "error" : "off",
      dim: me.forced
    },
    press: me.forced ? {} : {
      down: {
        t: "mute",
        on: !me.muted
      }
    }
  });
  items.push({
    key: {
      label: "Nicht st\xF6ren",
      state: me.dnd ? "preset" : "off"
    },
    press: {
      down: {
        t: "dnd",
        on: !me.dnd
      }
    }
  });
  items.push({
    key: {
      label: "Rasten",
      sub: latch ? "an" : "Halten",
      state: latch ? "preset" : "off"
    },
    press: {
      toggleLatch: true
    }
  });
  if (me.force) {
    items.push({
      key: {
        label: "Alle rufen",
        state: "off"
      },
      press: {
        down: {
          t: "call",
          to: "all",
          on: true
        },
        up: {
          t: "call",
          on: false
        }
      }
    });
  }
  for (const c of s.channels) {
    const others = c.speakers.filter((id) => id !== me.id);
    const sub = others.length ? s.parties.find((p) => p.id === others[0])?.name ?? "\u2026" : c.talk_allowed ? "Sprechen" : "nur H\xF6ren";
    items.push({
      key: {
        label: c.name,
        sub,
        state: c.talk ? "onair" : others.length ? "cue" : "off",
        dim: !c.talk_allowed || me.forced
      },
      press: !c.talk_allowed || me.forced ? {} : latch ? {
        down: {
          t: "talk",
          ch: c.id,
          on: !c.talk
        }
      } : {
        down: {
          t: "talk",
          ch: c.id,
          on: true
        },
        up: {
          t: "talk",
          ch: c.id,
          on: false
        }
      }
    });
  }
  for (const p of s.parties) {
    if (p.id === me.id) continue;
    items.push({
      key: {
        label: p.name,
        sub: p.dnd ? "nicht st\xF6ren" : p.online ? "rufen" : "offline",
        state: p.speaking ? "cue" : "off",
        dim: !p.online || me.forced
      },
      press: !p.online || me.forced ? {} : {
        down: {
          t: "call",
          to: [
            p.id
          ],
          on: true
        },
        up: {
          t: "call",
          on: false
        }
      }
    });
  }
  for (const c of s.channels.filter((x) => x.listen)) {
    items.push({
      key: {
        label: `H\xF6ren ${c.name}`,
        sub: `${Math.round(c.level * 100)} %`,
        state: c.listen_on ? "preset" : "off"
      },
      press: {
        down: {
          t: "listen",
          ch: c.id,
          on: !c.listen_on
        }
      }
    });
  }
  return items;
}
function layoutIntercom(s, cols, rows, dialCount, page, latch) {
  const size = Math.max(1, cols * rows);
  const items = itemsFor(s, latch);
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  const keys = Array.from({
    length: rows
  }, () => Array(cols).fill(null));
  const act = Array.from({
    length: rows
  }, () => Array(cols).fill(null));
  items.slice(p * size, (p + 1) * size).forEach((it, i) => {
    keys[Math.floor(i / cols)][i % cols] = it.key;
    act[Math.floor(i / cols)][i % cols] = it.press;
  });
  const dials = [];
  const dialAct = [];
  s.channels.filter((c) => c.listen).slice(0, dialCount).forEach((c) => {
    dials.push({
      label: c.name,
      value: `${Math.round(c.level * 100)} %`,
      fill: Math.min(1, c.level / 2)
    });
    dialAct.push({
      ch: c.id,
      level: c.level,
      listenOn: c.listen_on
    });
  });
  return {
    keys,
    act,
    dials,
    dialAct,
    pages
  };
}
function nudgedLevel(level, delta) {
  return Math.round(Math.min(2, Math.max(0, level + delta * 0.04)) * 100) / 100;
}

// ui/modules/intercom/deck/adapter.ts
function intercomAdapter(io, getParty) {
  let st = null;
  let last = null;
  let latch = false;
  const a = {
    onChange: () => {
    },
    onError: (_e) => {
    },
    getLayout(ctx) {
      if (!st) return {
        keys: Array.from({
          length: ctx.rows
        }, () => Array(ctx.cols).fill(null))
      };
      last = layoutIntercom(st, ctx.cols, ctx.rows, ctx.dials, ctx.page, latch);
      return {
        keys: last.keys,
        dials: last.dials,
        pages: last.pages
      };
    },
    onKey(row, col, down) {
      const p = last?.act[row]?.[col];
      if (!p) return;
      if (down && p.toggleLatch) {
        latch = !latch;
        a.onChange();
        return;
      }
      const cmd = down ? p.down : p.up;
      if (cmd) void send(cmd);
    },
    onDial(i, delta) {
      const d = last?.dialAct[i];
      if (d) void send({
        t: "level",
        ch: d.ch,
        v: nudgedLevel(d.level, delta)
      });
    },
    onDialPress(i, down) {
      const d = last?.dialAct[i];
      if (down && d) void send({
        t: "listen",
        ch: d.ch,
        on: !d.listenOn
      });
    },
    async refresh() {
      const party = getParty();
      if (party == null) return;
      try {
        st = await io.state(party);
        a.onChange();
      } catch (e) {
        a.onError(e);
      }
    }
  };
  async function send(cmd) {
    const party = getParty();
    if (party == null) return;
    try {
      await io.command(party, cmd);
      await a.refresh();
    } catch (e) {
      a.onError(e);
    }
  }
  return a;
}

// ui/modules/intercom/panel.ts
var L = (document.documentElement.lang || "de").startsWith("en") ? "en" : "de";
var D = {
  de: {
    pick: "Sprechstelle",
    newTab: "In neuem Tab \xF6ffnen",
    none: "F\xFCr Sie ist keine Sprechstelle eingerichtet (Administration \u2192 Produktion \u2192 Intercom).",
    err: "Sprechstellen laden fehlgeschlagen",
    cert: "Zeigt das Panel nichts an: einmal \u201EIn neuem Tab \xF6ffnen\u201C und das Zertifikat best\xE4tigen.",
    online: "online",
    noService: "Kein Intercom-Dienst gefunden."
  },
  en: {
    pick: "Station",
    newTab: "Open in new tab",
    none: "No station is set up for you (Administration \u2192 Production \u2192 Intercom).",
    err: "Loading stations failed",
    cert: "If the panel shows nothing: open it once in a new tab and accept the certificate.",
    online: "online",
    noService: "No intercom service found."
  }
}[L];
function headers() {
  let tok = null;
  try {
    tok = localStorage.getItem("omp-auth-token");
  } catch {
  }
  return tok ? {
    Authorization: `Bearer ${tok}`
  } : {};
}
async function findIntercom() {
  const r = await fetch("/api/v1/ext", {
    headers: headers()
  });
  if (!r.ok) throw new Error(String(r.status));
  const all = (await r.json()).filter((s) => s.kind === "intercom");
  return all.find((s) => s.live) ?? all[0] ?? null;
}
async function call(svc, role, params = {}, body) {
  const rt = svc.roles?.[role];
  if (!rt) throw new Error(`Rolle ${role} nicht verf\xFCgbar`);
  let path = rt.path;
  for (const [k, v] of Object.entries(params)) path = path.replace(`{${k}}`, encodeURIComponent(String(v)));
  const init = {
    method: rt.method,
    headers: {
      ...headers(),
      ...body !== void 0 ? {
        "content-type": "application/json"
      } : {}
    }
  };
  if (body !== void 0) init.body = JSON.stringify(body);
  return await fetch(`/api/v1/ext/${svc.name}${path}`, init);
}
var OmpIntercomPanel = class extends HTMLElement {
  deckParty = null;
  #svc = null;
  #panels = [];
  #current = 0;
  #timer;
  #error = "";
  #deck = null;
  /** Adapter fürs Stream Deck (Schnittstelle `streamDeck`, shell/streamdeck/adapter.ts). */
  get streamDeck() {
    this.#deck ??= intercomAdapter(this.#deckIO(), () => this.deckParty);
    return this.#deck;
  }
  #deckIO() {
    return {
      state: async (party) => {
        const svc = this.#svc ?? (this.#svc = await findIntercom());
        if (!svc) throw new Error(D.noService);
        const r = await call(svc, "deck.state", {
          party
        });
        if (!r.ok) throw new Error(String(r.status));
        return await r.json();
      },
      command: async (party, cmd) => {
        const svc = this.#svc ?? (this.#svc = await findIntercom());
        if (!svc) throw new Error(D.noService);
        const r = await call(svc, "deck.command", {
          party
        }, cmd);
        if (!r.ok) throw new Error(String(r.status));
      }
    };
  }
  connectedCallback() {
    this.style.cssText = "display:block;padding:8px;font:13px system-ui,sans-serif;";
    void this.#load();
    this.#timer = setInterval(() => void this.#status(), 3e3);
  }
  disconnectedCallback() {
    clearInterval(this.#timer);
  }
  async #load() {
    try {
      this.#svc = await findIntercom();
      if (!this.#svc) throw new Error(D.noService);
      const r = await call(this.#svc, "panels");
      if (!r.ok) throw new Error(String(r.status));
      this.#panels = (await r.json()).panels ?? [];
      this.#error = "";
    } catch (e) {
      this.#error = `${D.err} (${e.message})`;
    }
    let saved = NaN;
    try {
      saved = Number(sessionStorage.getItem("omp-intercom-party") ?? "");
    } catch {
    }
    const idx = this.#panels.findIndex((p) => p.party_id === saved);
    this.#current = idx >= 0 ? idx : 0;
    this.#render();
  }
  async #status() {
    const el = this.querySelector("[data-status]");
    if (!el || !this.#svc) return;
    try {
      const r = await call(this.#svc, "status");
      if (!r.ok) return;
      const st = await r.json();
      el.textContent = `${(st.parties ?? []).filter((p) => p.online).length} ${D.online}`;
    } catch {
    }
  }
  #render() {
    this.replaceChildren();
    if (this.#error) {
      const e = document.createElement("div");
      e.style.color = "var(--omp-error,#e57373)";
      e.textContent = this.#error;
      this.append(e);
    }
    if (!this.#panels.length) {
      this.deckParty = null;
      if (!this.#error) {
        const n = document.createElement("div");
        n.style.opacity = "0.7";
        n.textContent = D.none;
        this.append(n);
      }
      return;
    }
    const p = this.#panels[Math.min(this.#current, this.#panels.length - 1)];
    this.deckParty = p.party_id;
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px;";
    if (this.#panels.length > 1) {
      const lab = document.createElement("span");
      lab.textContent = D.pick;
      const sel = document.createElement("select");
      this.#panels.forEach((x, i) => sel.add(new Option(x.name, String(i))));
      sel.value = String(this.#current);
      sel.onchange = () => {
        this.#current = Number(sel.value);
        try {
          sessionStorage.setItem("omp-intercom-party", String(this.#panels[this.#current].party_id));
        } catch {
        }
        this.#render();
      };
      bar.append(lab, sel);
    } else {
      const s = document.createElement("strong");
      s.textContent = p.name;
      bar.append(s);
    }
    const a = document.createElement("a");
    a.href = p.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = D.newTab;
    const st = document.createElement("span");
    st.dataset.status = "1";
    st.style.opacity = "0.7";
    const hint = document.createElement("span");
    hint.style.cssText = "opacity:.6;font-size:11px;";
    hint.textContent = D.cert;
    bar.append(a, st, hint);
    const f = document.createElement("iframe");
    f.src = p.url;
    f.title = p.name;
    f.setAttribute("allow", "microphone; autoplay");
    f.style.cssText = "width:100%;max-width:980px;height:calc(100% - 40px);min-height:420px;border:1px solid var(--omp-border,#223049);border-radius:8px;background:var(--omp-bg,#080c16);";
    this.append(bar, f);
    void this.#status();
  }
};
if (!customElements.get("omp-intercom-panel")) customElements.define("omp-intercom-panel", OmpIntercomPanel);
export {
  findIntercom
};
