// Grafische Audio-Routing-/Mix-/Verzögerungs-Matrix (UMSETZUNG.md
// Kapitel 23, Schritt 3) — funktionaler Modal-Baustein, gleiches Muster
// wie `filter-graph.ts::openFilterGraphEditor` (kein eigenes Custom
// Element, `.omp-modal`/`.omp-modal-overlay`-Klassen). Anders als der
// Filter-Graph-Editor kein SVG-Knoten/Kanten-Canvas — ein Kreuzschienen-
// Raster (Tabelle) ist für "welche Quellkanäle auf welche Ausgangsspur"
// die direktere, weniger technische Bedienoberfläche (Nutzerauftrag
// 2026-09-26: "sehr viel weiter und professioneller").
//
// Kompiliert über `audio-matrix-logic.ts::compileAudioMatrix` zu
// genau demselben `{filterComplex, outputLabels}`-Paar wie der
// Filter-Graph-Editor — beide sind austauschbare Bedienoberflächen für
// dieselben zwei Felder in `ConvertInput` (process-step-config.ts).
import type { AudioMatrixCell, AudioMatrixSource } from "./audio-matrix-logic.ts";
import { compileAudioMatrix } from "./audio-matrix-logic.ts";
import { showToast } from "../kit/omp-toast.ts";

function h<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

export function openAudioMatrixEditor(
  host: HTMLElement,
  primaryInputPath: string,
  initialAdditionalSources: string[],
  initialOutputCount: number,
  initialCells: AudioMatrixCell[],
  onApply: (additionalInputPaths: string[], filterComplex: string, outputLabels: string[], cells: AudioMatrixCell[], outputCount: number) => void,
) {
  // sources[0] ist IMMER die primäre Eingabedatei des Konvertieren-
  // Formulars (Index 0 in -filter_complex-Labels wie "0:a") —
  // additionalInputPaths[k] wird Index k+1, exakt wie
  // ConvertInput.additionalInputPaths bereits funktioniert.
  const sources: AudioMatrixSource[] = [
    { inputPath: primaryInputPath || "${input.path}", channelCount: 2, label: "Haupt-Eingabedatei" },
    ...initialAdditionalSources.map((p): AudioMatrixSource => ({ inputPath: p, channelCount: 2 })),
  ];
  let outputCount = Math.max(initialOutputCount, 1);
  const cells = new Map<string, AudioMatrixCell>();
  for (const c of initialCells) cells.set(`${c.sourceIndex}_${c.channelIndex}_${c.outputIndex}`, { ...c });

  const overlay = h("div");
  overlay.className = "omp-modal-overlay";
  overlay.style.cssText = "z-index:2200;";
  const panel = h("div", "width:94vw;height:88vh;max-width:1400px;display:flex;flex-direction:column;padding:0;overflow:hidden;");
  panel.className = "omp-modal";
  panel.setAttribute("data-role", "audio-matrix-editor");

  const toolbar = h("div", "display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--omp-border);flex-shrink:0;");
  const title = h("div", "font-weight:600;flex:1;", "Audio-Matrix bearbeiten");
  const cancelBtn = h("button", "", "Abbrechen");
  cancelBtn.type = "button";
  const applyBtn = h("button", "", "Übernehmen");
  applyBtn.type = "button";
  applyBtn.className = "omp-btn-primary";
  applyBtn.setAttribute("data-role", "audio-matrix-apply");
  toolbar.append(title, cancelBtn, applyBtn);

  const body = h("div", "flex:1;overflow:auto;padding:10px;box-sizing:border-box;");
  const help = h(
    "div",
    "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);margin-bottom:8px;",
    "Ordnet einzelne Quellkanäle (aus der Haupt-Eingabedatei oder zusätzlichen Dateien) beliebigen Ausgangsspuren zu — anteilig gemischt (%) und verzögert (ms). Eine Zelle mit Anteil 0 trägt nichts bei. Ausgangsspuren ohne jeden Beitrag werden nicht erzeugt.",
  );
  const sourcesSection = h("div", "");
  const outputControl = h("div", "display:flex;align-items:center;gap:8px;margin:10px 0;");
  const tableWrap = h("div", "overflow:auto;");
  body.append(help, sourcesSection, outputControl, tableWrap);

  panel.append(toolbar, body);
  overlay.appendChild(panel);

  function cellKey(sourceIndex: number, channelIndex: number, outputIndex: number): string {
    return `${sourceIndex}_${channelIndex}_${outputIndex}`;
  }

  function renderSources() {
    sourcesSection.replaceChildren();
    const heading = h("div", "font-weight:600;margin-bottom:4px;", "Quellen");
    sourcesSection.appendChild(heading);
    sources.forEach((src, i) => {
      const row = h("div", "display:flex;align-items:center;gap:6px;margin-bottom:4px;");
      const label = h("span", "min-width:140px;font-size:var(--omp-font-size-xs);", src.label ?? `Quelle ${i + 1}`);
      row.appendChild(label);
      if (i === 0) {
        const pathText = h("span", "flex:1;font-family:ui-monospace,monospace;font-size:var(--omp-font-size-xs);", src.inputPath);
        row.appendChild(pathText);
      } else {
        const pathInput = h("input", "flex:1;");
        pathInput.value = src.inputPath;
        pathInput.placeholder = "Pfad der zusätzlichen Quelldatei";
        pathInput.addEventListener("input", () => {
          src.inputPath = pathInput.value;
        });
        row.appendChild(pathInput);
      }
      const chLabel = h("span", "font-size:var(--omp-font-size-xs);", "Kanäle:");
      const chInput = h("input", "width:48px;");
      chInput.type = "number";
      chInput.min = "1";
      chInput.value = String(src.channelCount);
      chInput.addEventListener("input", () => {
        src.channelCount = Math.max(1, Number(chInput.value) || 1);
        renderTable();
      });
      row.append(chLabel, chInput);
      if (i > 0) {
        const rm = h("button", "", "✕");
        rm.type = "button";
        rm.addEventListener("click", () => {
          sources.splice(i, 1);
          // Zellen, die auf die entfernte (oder eine höhere) Quelle
          // zeigten, würden auf eine falsche Quelle verschieben —
          // sauberer: alle Zellen dieser Quelle löschen, höhere Indizes
          // um 1 nach unten verschieben.
          const next = new Map<string, AudioMatrixCell>();
          for (const c of cells.values()) {
            if (c.sourceIndex === i) continue;
            const newIdx = c.sourceIndex > i ? c.sourceIndex - 1 : c.sourceIndex;
            const moved = { ...c, sourceIndex: newIdx };
            next.set(cellKey(moved.sourceIndex, moved.channelIndex, moved.outputIndex), moved);
          }
          cells.clear();
          for (const [k, v] of next) cells.set(k, v);
          renderSources();
          renderTable();
        });
        row.appendChild(rm);
      }
      sourcesSection.appendChild(row);
    });
    const addBtn = h("button", "margin-top:4px;", "+ weitere Quelldatei");
    addBtn.type = "button";
    addBtn.addEventListener("click", () => {
      sources.push({ inputPath: "", channelCount: 2 });
      renderSources();
      renderTable();
    });
    sourcesSection.appendChild(addBtn);
  }

  function renderOutputControl() {
    outputControl.replaceChildren();
    outputControl.append(h("span", "font-weight:600;", "Ausgangsspuren:"));
    const countInput = h("input", "width:56px;");
    countInput.type = "number";
    countInput.min = "1";
    countInput.value = String(outputCount);
    countInput.addEventListener("input", () => {
      outputCount = Math.max(1, Number(countInput.value) || 1);
      renderTable();
    });
    outputControl.appendChild(countInput);
  }

  function renderTable() {
    tableWrap.replaceChildren();
    const table = h("table", "border-collapse:collapse;font-size:var(--omp-font-size-xs);");
    const thead = h("tr", "");
    thead.appendChild(h("th", "border:1px solid var(--omp-border);padding:4px;position:sticky;left:0;background:var(--omp-surface);", "Quellkanal \\ Ausgangsspur"));
    for (let o = 0; o < outputCount; o++) {
      thead.appendChild(h("th", "border:1px solid var(--omp-border);padding:4px;min-width:110px;", `Spur ${o + 1}`));
    }
    table.appendChild(thead);

    sources.forEach((src, srcIdx) => {
      for (let ch = 0; ch < src.channelCount; ch++) {
        const tr = h("tr", "");
        const rowLabel = h(
          "td",
          "border:1px solid var(--omp-border);padding:4px;font-weight:600;position:sticky;left:0;background:var(--omp-surface);white-space:nowrap;",
          `${src.label ?? `Quelle ${srcIdx + 1}`} · Kanal ${ch + 1}`,
        );
        tr.appendChild(rowLabel);
        for (let o = 0; o < outputCount; o++) {
          const key = cellKey(srcIdx, ch, o);
          const existing = cells.get(key);
          const td = h("td", "border:1px solid var(--omp-border);padding:3px;");
          const cellWrap = h("div", "display:flex;flex-direction:column;gap:2px;");
          const gainRow = h("div", "display:flex;align-items:center;gap:2px;");
          gainRow.append(h("span", "color:var(--omp-text-dim);", "%"));
          const gainInput = h("input", "width:52px;");
          gainInput.type = "number";
          gainInput.min = "0";
          gainInput.step = "1";
          gainInput.value = String(existing?.gainPercent ?? 0);
          gainRow.appendChild(gainInput);
          const delayRow = h("div", "display:flex;align-items:center;gap:2px;");
          delayRow.append(h("span", "color:var(--omp-text-dim);", "ms"));
          const delayInput = h("input", "width:52px;");
          delayInput.type = "number";
          delayInput.min = "0";
          delayInput.step = "1";
          delayInput.value = String(existing?.delayMs ?? 0);
          delayRow.appendChild(delayInput);
          const sync = () => {
            const gain = Math.max(0, Number(gainInput.value) || 0);
            const delay = Math.max(0, Number(delayInput.value) || 0);
            if (gain <= 0) {
              cells.delete(key);
              td.style.background = "";
            } else {
              cells.set(key, { sourceIndex: srcIdx, channelIndex: ch, outputIndex: o, gainPercent: gain, delayMs: delay });
              td.style.background = "color-mix(in srgb, var(--omp-info) 18%, transparent)";
            }
          };
          gainInput.addEventListener("input", sync);
          delayInput.addEventListener("input", sync);
          if (existing) td.style.background = "color-mix(in srgb, var(--omp-info) 18%, transparent)";
          cellWrap.append(gainRow, delayRow);
          td.appendChild(cellWrap);
          tr.appendChild(td);
        }
        table.appendChild(tr);
      }
    });
    tableWrap.appendChild(table);
  }

  renderSources();
  renderOutputControl();
  renderTable();

  cancelBtn.addEventListener("click", () => overlay.remove());
  applyBtn.addEventListener("click", () => {
    for (let i = 1; i < sources.length; i++) {
      if (!sources[i].inputPath.trim()) {
        showToast(`Quelle ${i + 1}: Pfad fehlt.`, { variant: "error" });
        return;
      }
    }
    const result = compileAudioMatrix({ sources, outputCount, cells: [...cells.values()] });
    if (result.outputLabels.length === 0) {
      showToast("Mindestens eine Zelle mit Anteil > 0 wird gebraucht.", { variant: "error" });
      return;
    }
    onApply(result.additionalInputPaths, result.filterComplex, result.outputLabels, [...cells.values()], outputCount);
    overlay.remove();
  });
  overlay.addEventListener("mousedown", (ev) => {
    if (ev.target === overlay) overlay.remove();
  });

  host.appendChild(overlay);
}
