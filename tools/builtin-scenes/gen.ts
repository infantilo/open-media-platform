// Erzeugt die Designer-Vorlagen (Leinwand-bearbeitbar) des Grafik-Nodes unter nodes/omp-ograf/builtin/omp-*/:
// scene.json + <id>.js (Laufzeit + Szene) + Manifest (Schema/Beschreibung bleiben aus der vorhandenen Manifest-Datei).
// Aufruf: deno run -A tools/builtin-scenes/gen.ts   — danach Version im Manifest erhöhen, wenn sich die Szene ändert.
import { applyScene, newScene } from "../../ui/modules/ograf-editor/scene.ts";
import type { Scene, SceneElement } from "../../ui/modules/ograf-editor/scene.ts";
import RUNTIME from "../../ui/modules/ograf-editor/runtime.js" with { type: "text" };

const ROOT = new URL("../../nodes/omp-ograf/builtin/", import.meta.url).pathname;
type Anim = { type: string; ms: number; delay: number };
const A = (type: string, ms = 500, delay = 0) => ({ type, ms, delay, ease: "ease-out" });
const OUT = { type: "fade", ms: 300, delay: 0, ease: "ease-in" };
const mk = (anim: Anim) => ({ in: A(anim.type, anim.ms, anim.delay), out: OUT });
let n = 0;
function rect(name: string, x: number, y: number, w: number, h: number, fill: string, anim: Anim, extra: Partial<SceneElement> = {}): SceneElement {
  return { id: `r${++n}`, kind: "rect", name, x, y, w, h, rotation: 0, opacity: 1, fill, radius: 0, stroke: "", strokeW: 0, anim: mk(anim), ...extra };
}
function text(name: string, x: number, y: number, w: number, h: number, t: string, size: number, color: string, anim: Anim, extra: Partial<SceneElement> = {}): SceneElement {
  return { id: `t${++n}`, kind: "text", name, x, y, w, h, rotation: 0, opacity: 1, text: t, font: "system-ui, sans-serif", size, weight: 700, color, align: "left", valign: "middle", lineHeight: 1.2, padding: 0, autofit: true, minSize: 16, anim: mk(anim), ...extra };
}

const S: Record<string, (s: Scene) => void> = {
  "omp-lower-third": (s) => {
    const a = { type: "fromLeft", ms: 600, delay: 0 };
    s.elements.push(
      rect("Hintergrund", 115, 770, 760, 150, "{{bgColor}}", a),
      rect("Akzent", 115, 770, 22, 150, "{{accentColor}}", a),
      text("Name", 165, 780, 690, 80, "{{name}}", 56, "{{textColor}}", { ...a, delay: 120 }, { weight: 800 }),
      text("Funktion", 165, 860, 690, 50, "{{role}}", 34, "{{textColor}}", { ...a, delay: 220 }, { weight: 500, opacity: 0.85 }),
    );
  },
  "omp-headline-bar": (s) => {
    const a = { type: "fromBottom", ms: 500, delay: 0 };
    s.elements.push(
      rect("Label-Fläche", 77, 890, 360, 100, "{{labelColor}}", a),
      rect("Text-Fläche", 437, 890, 1406, 100, "{{bgColor}}", a),
      text("Label", 77, 890, 360, 100, "{{label}}", 40, "#ffffff", { ...a, delay: 100 }, { align: "center", weight: 800 }),
      text("Schlagzeile", 477, 890, 1330, 100, "{{text}}", 46, "{{textColor}}", { ...a, delay: 150 }),
    );
  },
  "omp-title-card": (s) => {
    const f = { type: "fade", ms: 500, delay: 0 };
    s.elements.push(
      rect("Hintergrund", 0, 0, 1920, 1080, "{{bgColor}}", f),
      text("Titel", 115, 330, 1690, 250, "{{title}}", 124, "{{textColor}}", { ...f, delay: 150 }, { align: "center", weight: 800 }),
      rect("Linie", 833, 610, 254, 9, "{{accentColor}}", { ...f, delay: 250 }),
      text("Untertitel", 154, 650, 1612, 100, "{{subtitle}}", 50, "{{textColor}}", { ...f, delay: 350 }, { align: "center", weight: 500, opacity: 0.85 }),
    );
  },
  "omp-next-up": (s) => {
    const a = { type: "fromRight", ms: 600, delay: 0 };
    s.elements.push(
      rect("Label-Fläche", 980, 880, 190, 100, "{{accentColor}}", a),
      rect("Text-Fläche", 1170, 880, 673, 100, "{{bgColor}}", a),
      text("Label", 980, 880, 190, 100, "{{label}}", 32, "#ffffff", { ...a, delay: 100 }, { align: "center", weight: 800 }),
      text("Titel", 1200, 880, 440, 100, "{{title}}", 42, "{{textColor}}", { ...a, delay: 150 }),
      text("Uhrzeit", 1650, 880, 170, 100, "{{time}}", 38, "{{textColor}}", { ...a, delay: 200 }, { align: "right", weight: 500, opacity: 0.75 }),
    );
  },
  "omp-location-strap": (s) => {
    const a = { type: "fromLeft", ms: 450, delay: 0 };
    s.elements.push(
      rect("Kennung-Fläche", 77, 54, 190, 70, "{{tagColor}}", a),
      rect("Ort-Fläche", 267, 54, 640, 70, "{{bgColor}}", a),
      text("Kennung", 77, 54, 190, 70, "{{tag}}", 34, "#ffffff", { ...a, delay: 80 }, { align: "center", weight: 800 }),
      text("Ort", 297, 54, 400, 70, "{{place}}", 38, "{{textColor}}", { ...a, delay: 120 }),
      text("Zusatz", 700, 54, 190, 70, "{{extra}}", 30, "{{textColor}}", { ...a, delay: 160 }, { align: "right", weight: 500, opacity: 0.7 }),
    );
  },
  "omp-quote": (s) => {
    const a = { type: "fromBottom", ms: 500, delay: 0 };
    s.elements.push(
      rect("Hintergrund", 154, 700, 1612, 290, "{{bgColor}}", a, { opacity: 0.9 }),
      rect("Akzent", 154, 700, 14, 290, "{{accentColor}}", a),
      text("Zitat", 205, 720, 1530, 170, "{{text}}", 56, "{{textColor}}", { ...a, delay: 120 }, { weight: 600, valign: "top" }),
      text("Urheber", 205, 905, 1530, 60, "{{author}}", 32, "{{accentColor}}", { ...a, delay: 220 }),
    );
  },
  "omp-scoreboard": (s) => {
    const a = { type: "fromTop", ms: 500, delay: 0 };
    s.elements.push(
      rect("Hintergrund", 77, 54, 960, 96, "{{bgColor}}", a),
      rect("Farbe A", 77, 54, 18, 96, "{{colorA}}", a),
      rect("Farbe B", 1019, 54, 18, 96, "{{colorB}}", a),
      rect("Zeit-Fläche", 790, 54, 247, 96, "#000000", a),
      text("Team A", 110, 54, 230, 96, "{{teamA}}", 44, "{{textColor}}", { ...a, delay: 80 }, { weight: 800 }),
      text("Tore A", 340, 54, 100, 96, "{{scoreA}}", 56, "{{textColor}}", { ...a, delay: 120 }, { align: "center", weight: 800 }),
      text("Tore B", 450, 54, 100, 96, "{{scoreB}}", 56, "{{textColor}}", { ...a, delay: 120 }, { align: "center", weight: 800 }),
      text("Team B", 540, 54, 230, 96, "{{teamB}}", 44, "{{textColor}}", { ...a, delay: 160 }, { weight: 800, align: "right" }),
      text("Spielzeit", 800, 58, 227, 52, "{{time}}", 40, "#ffffff", { ...a, delay: 200 }, { align: "center" }),
      text("Abschnitt", 800, 108, 227, 36, "{{period}}", 26, "#ffffff", { ...a, delay: 200 }, { align: "center", weight: 500, opacity: 0.8 }),
    );
  },
};

for (const [id, build] of Object.entries(S)) {
  n = 0;
  const s = newScene();
  build(s);
  const mpath = `${ROOT}${id}/${id}.ograf.json`;
  const files = applyScene({ [`${id}.ograf.json`]: await Deno.readTextFile(mpath) }, id, s, RUNTIME);
  for (const [name, content] of Object.entries(files)) await Deno.writeTextFile(`${ROOT}${id}/${name}`, content);
  console.log(id, Object.keys(files).join(", "));
}
