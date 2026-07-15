#!/usr/bin/env bash
# Erzeugt ein minimales, lizenzfreies OGraf-Test-Template (eigene
# Erstellung, keine Übernahme aus PIPELINE CONTROLLER — dessen ~45
# Templates haben eine ungeklärte Lizenzfrage, docs/END-GOAL-FEATURES.md
# §5.5 Punkt 4) unter OMP_OGRAF_TEMPLATES — Testmittel für K5-Teil-1
# (Kern-Node-Verifikation), analog make-test-media.sh für K2-Teil-1.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATES_DIR="${OMP_OGRAF_TEMPLATES:-$ROOT_DIR/data/ograf-templates}"
OUT_DIR="$TEMPLATES_DIR/hello-lower-third"

mkdir -p "$OUT_DIR"

cat > "$OUT_DIR/hello-lower-third.ograf.json" <<'EOF'
{
  "$schema": "https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json",
  "id": "hello-lower-third",
  "version": "1.0.0",
  "name": "Hello Lower Third",
  "description": "Minimales OMP-Test-Template (K5-Teil-1) - kein PIPELINE-CONTROLLER-Import.",
  "author": { "name": "OpenMediaPlatform" },
  "main": "hello-lower-third.js",
  "supportsRealTime": true,
  "supportsNonRealTime": false,
  "stepCount": 1,
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "title": { "type": "string", "title": "Title", "default": "Hello OMP" },
      "subtitle": { "type": "string", "title": "Subtitle", "default": "K5-Teil-1 Kern-Node" },
      "accentColor": {
        "type": "string",
        "title": "Accent Color",
        "default": "#4285f4",
        "gddType": "color-rrggbb",
        "pattern": "^#[0-9a-f]{6}$"
      }
    },
    "required": ["title"]
  },
  "renderRequirements": [
    { "resolution": { "width": { "ideal": 1280 }, "height": { "ideal": 720 } }, "frameRate": { "ideal": 25 } }
  ]
}
EOF

cat > "$OUT_DIR/hello-lower-third.js" <<'EOF'
// Minimales OGraf-v1-Template (K5-Teil-1 Testmittel, eigene Erstellung).
// Lifecycle exakt nach dem im K5-Teil-0-Spike verifizierten Vertrag
// (docs/decisions.md 2026-07-15): default-exportierte Klasse, von der
// Harness-Seite selbst per customElements.define() registriert.
const DEFAULTS = { title: "Hello OMP", subtitle: "", accentColor: "#4285f4" };

class HelloLowerThird extends HTMLElement {
  constructor() {
    super();
    this._state = { ...DEFAULTS };
    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { position: absolute; left: 60px; bottom: 80px; display: block; }
      .box {
        background: rgba(20, 24, 32, 0.85);
        color: #fff;
        font-family: sans-serif;
        padding: 16px 28px;
        border-left: 8px solid var(--accent, #4285f4);
        opacity: 0;
        transform: translateY(12px);
        transition: opacity 0.25s ease, transform 0.25s ease;
      }
      .box.visible { opacity: 1; transform: translateY(0); }
      h1 { margin: 0; font-size: 30px; }
      p { margin: 4px 0 0; font-size: 16px; opacity: 0.85; }
    `;
    this._box = document.createElement("div");
    this._box.className = "box";
    this._title = document.createElement("h1");
    this._subtitle = document.createElement("p");
    this._box.append(this._title, this._subtitle);
    root.append(style, this._box);
  }

  async load(params) {
    this._state = { ...DEFAULTS, ...(params?.data || {}) };
    this._applyState();
    return { statusCode: 200 };
  }

  async updateAction(params) {
    this._state = { ...this._state, ...(params?.data || {}) };
    this._applyState();
    return { statusCode: 200 };
  }

  async playAction() {
    this._box.classList.add("visible");
    return { statusCode: 200 };
  }

  async stopAction() {
    this._box.classList.remove("visible");
    return { statusCode: 200 };
  }

  async dispose() {
    return { statusCode: 200 };
  }

  _applyState() {
    this._title.textContent = this._state.title || "";
    this._subtitle.textContent = this._state.subtitle || "";
    this.style.setProperty("--accent", this._state.accentColor || DEFAULTS.accentColor);
  }
}

export default HelloLowerThird;
EOF

echo "Geschrieben: $OUT_DIR"
