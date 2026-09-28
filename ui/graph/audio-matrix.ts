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
import type { AudioMatrixCell, AudioMatrixSource, ChannelLayoutId } from "./audio-matrix-logic.ts";
import { applyDownmixPreset, CHANNEL_LAYOUTS, channelLabel, channelLayoutChannelCount, compileAudioMatrix, downmixPresetsForLayout } from "./audio-matrix-logic.ts";
import { showToast } from "../kit/omp-toast.ts";

// dB-Anzeige neben dem Prozent-Regler (Kapitel 25 R2) — reine
// Konvertierung fürs Auge, `gainPercent` bleibt der einzige gespeicherte/
// kompilierte Wert (compileAudioMatrix unverändert, s. audio-matrix-logic.ts).
function gainPercentToDbLabel(gainPercent: number): string {
  if (gainPercent <= 0) return "aus";
  return `${(20 * Math.log10(gainPercent / 100)).toFixed(1)} dB`;
}

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
    { inputPath: primaryInputPath || "${input.path}", channelCount: 2, layout: "stereo", label: "Haupt-Eingabedatei" },
    ...initialAdditionalSources.map((p): AudioMatrixSource => ({ inputPath: p, channelCount: 2, layout: "stereo" })),
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
      const layoutLabel = h("span", "font-size:var(--omp-font-size-xs);", "Kanal-Layout:");
      const layoutSelect = h("select", "");
      for (const def of CHANNEL_LAYOUTS) layoutSelect.appendChild(new Option(def.label, def.id));
      layoutSelect.value = src.layout ?? "custom";
      const chInput = h("input", "width:48px;");
      chInput.type = "number";
      chInput.min = "1";
      chInput.value = String(src.channelCount);
      chInput.style.display = (src.layout ?? "custom") === "custom" ? "" : "none";
      layoutSelect.addEventListener("change", () => {
        const id = layoutSelect.value as ChannelLayoutId;
        src.layout = id;
        if (id !== "custom") src.channelCount = channelLayoutChannelCount(id);
        chInput.value = String(src.channelCount);
        chInput.style.display = id === "custom" ? "" : "none";
        renderSources(); // Downmix-Vorlagen-Knöpfe hängen vom Layout ab
        renderTable();
      });
      chInput.addEventListener("input", () => {
        src.channelCount = Math.max(1, Number(chInput.value) || 1);
        renderTable();
      });
      row.append(layoutLabel, layoutSelect, chInput);
      for (const preset of downmixPresetsForLayout(src.layout)) {
        const presetBtn = h("button", "font-size:var(--omp-font-size-xs);", `↓ ${preset.label}`);
        presetBtn.type = "button";
        presetBtn.title = preset.help;
        presetBtn.addEventListener("click", () => {
          for (const cell of applyDownmixPreset(preset, i, 0)) {
            cells.set(cellKey(cell.sourceIndex, cell.channelIndex, cell.outputIndex), cell);
          }
          outputCount = Math.max(outputCount, preset.outputCount);
          showToast(`"${preset.label}" angewendet (Ausgangsspur 1${preset.outputCount > 1 ? `–${preset.outputCount}` : ""}).`, { variant: "info" });
          renderOutputControl();
          renderTable();
        });
        row.appendChild(presetBtn);
      }
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

  // Downmixer-Dialog für eine einzelne Zelle (Kapitel 25 R2, Nutzerauftrag
  // "sowas wie audiomatix.jpeg brauchen wir wieder" — dort öffnet ein
  // Klick auf eine Kreuzschienen-Zelle einen "Downmixer"-Dialog mit
  // Gain-Regler statt Dauer-Anzeige aller Zellwerte im Raster). Ersetzt
  // die bisherigen, immer sichtbaren Doppel-Zahlenfelder je Zelle — bei
  // vielen Quellen/Ausgängen wurde das Raster sonst unübersichtlich dicht.
  // Ändert NICHTS an compileAudioMatrix: `gainPercent`/`delayMs` bleiben
  // exakt dieselben gespeicherten Werte, die dB-Anzeige ist nur Zucker.
  function openCellDialog(srcIdx: number, ch: number, o: number) {
    const key = cellKey(srcIdx, ch, o);
    const existing = cells.get(key);
    const src = sources[srcIdx];
    const chLabel = channelLabel(src.layout ?? "custom", ch);

    const dlgOverlay = h("div");
    dlgOverlay.className = "omp-modal-overlay";
    dlgOverlay.style.cssText = "z-index:2300;";
    const dlg = h("div", "width:300px;padding:14px;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;");
    dlg.className = "omp-modal";

    dlg.appendChild(h("div", "font-weight:600;font-size:var(--omp-font-size-md);", "Downmixer"));
    dlg.appendChild(h("div", "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);", `${src.label ?? `Quelle ${srcIdx + 1}`} · ${chLabel} → Spur ${o + 1}`));

    const gainReadout = h("div", "font-weight:600;text-align:center;font-size:var(--omp-font-size-lg);");
    const dbReadout = h("div", "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);text-align:center;");
    const gainSlider = h("input", "width:100%;");
    gainSlider.type = "range";
    gainSlider.min = "0";
    gainSlider.max = "200";
    gainSlider.step = "1";
    const gainNumberRow = h("div", "display:flex;align-items:center;gap:4px;justify-content:center;");
    const gainNumber = h("input", "width:64px;text-align:right;");
    gainNumber.type = "number";
    gainNumber.min = "0";
    gainNumber.step = "1";
    gainNumberRow.append(gainNumber, h("span", "color:var(--omp-text-dim);", "%"));

    const setGainDisplays = (v: number) => {
      gainReadout.textContent = `${v}%`;
      dbReadout.textContent = gainPercentToDbLabel(v);
    };
    const startGain = existing?.gainPercent ?? 100;
    gainSlider.value = String(Math.min(200, startGain));
    gainNumber.value = String(startGain);
    setGainDisplays(startGain);
    gainSlider.addEventListener("input", () => {
      gainNumber.value = gainSlider.value;
      setGainDisplays(Number(gainSlider.value));
    });
    gainNumber.addEventListener("input", () => {
      const v = Math.max(0, Number(gainNumber.value) || 0);
      gainSlider.value = String(Math.min(200, v));
      setGainDisplays(v);
    });

    const delayRow = h("div", "display:flex;align-items:center;gap:6px;");
    delayRow.append(h("span", "flex:1;", "Verzögerung:"));
    const delayInput = h("input", "width:64px;text-align:right;");
    delayInput.type = "number";
    delayInput.min = "0";
    delayInput.step = "1";
    delayInput.value = String(existing?.delayMs ?? 0);
    delayRow.append(delayInput, h("span", "color:var(--omp-text-dim);", "ms"));

    const btnRow = h("div", "display:flex;justify-content:flex-end;gap:6px;margin-top:4px;");
    const removeBtn = h("button", "margin-right:auto;", "Entfernen");
    removeBtn.type = "button";
    removeBtn.style.display = existing ? "" : "none";
    const dlgCancelBtn = h("button", "", "Abbrechen");
    dlgCancelBtn.type = "button";
    const dlgApplyBtn = h("button", "", "Übernehmen");
    dlgApplyBtn.type = "button";
    dlgApplyBtn.className = "omp-btn-primary";
    removeBtn.addEventListener("click", () => {
      cells.delete(key);
      dlgOverlay.remove();
      renderTable();
    });
    dlgCancelBtn.addEventListener("click", () => dlgOverlay.remove());
    dlgApplyBtn.addEventListener("click", () => {
      const gain = Math.max(0, Number(gainNumber.value) || 0);
      const delay = Math.max(0, Number(delayInput.value) || 0);
      if (gain <= 0) cells.delete(key);
      else cells.set(key, { sourceIndex: srcIdx, channelIndex: ch, outputIndex: o, gainPercent: gain, delayMs: delay });
      dlgOverlay.remove();
      renderTable();
    });
    btnRow.append(removeBtn, dlgCancelBtn, dlgApplyBtn);

    dlg.append(gainReadout, gainSlider, gainNumberRow, dbReadout, delayRow, btnRow);
    dlgOverlay.appendChild(dlg);
    dlgOverlay.addEventListener("mousedown", (ev) => {
      if (ev.target === dlgOverlay) dlgOverlay.remove();
    });
    host.appendChild(dlgOverlay);
    gainNumber.focus();
  }

  function renderTable() {
    tableWrap.replaceChildren();
    const table = h("table", "border-collapse:collapse;font-size:var(--omp-font-size-xs);");
    const thead = h("tr", "");
    thead.appendChild(h("th", "border:1px solid var(--omp-border);padding:4px;position:sticky;left:0;background:var(--omp-surface);", "Quellkanal \\ Ausgangsspur"));
    for (let o = 0; o < outputCount; o++) {
      thead.appendChild(h("th", "border:1px solid var(--omp-border);padding:4px;min-width:80px;", `Spur ${o + 1}`));
    }
    table.appendChild(thead);

    sources.forEach((src, srcIdx) => {
      for (let ch = 0; ch < src.channelCount; ch++) {
        const tr = h("tr", "");
        const rowLabel = h(
          "td",
          "border:1px solid var(--omp-border);padding:4px;font-weight:600;position:sticky;left:0;background:var(--omp-surface);white-space:nowrap;",
          `${src.label ?? `Quelle ${srcIdx + 1}`} · ${channelLabel(src.layout ?? "custom", ch)}`,
        );
        tr.appendChild(rowLabel);
        for (let o = 0; o < outputCount; o++) {
          const key = cellKey(srcIdx, ch, o);
          const existing = cells.get(key);
          const td = h("td", "border:1px solid var(--omp-border);padding:0;text-align:center;");
          const cellBtn = h(
            "button",
            "width:100%;height:32px;border:none;background:transparent;cursor:pointer;color:inherit;font:inherit;",
            existing ? `${existing.gainPercent}%${existing.delayMs > 0 ? ` +${existing.delayMs}ms` : ""}` : "+",
          );
          cellBtn.type = "button";
          cellBtn.title = existing ? "Klicken zum Bearbeiten" : "Klicken zum Routen";
          if (existing) {
            td.style.background = "color-mix(in srgb, var(--omp-info) 18%, transparent)";
          } else {
            cellBtn.style.color = "var(--omp-text-dim)";
          }
          cellBtn.addEventListener("click", () => openCellDialog(srcIdx, ch, o));
          td.appendChild(cellBtn);
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
