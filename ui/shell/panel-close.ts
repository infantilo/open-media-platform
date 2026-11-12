// Schließen-Knopf oben im aufgeklappten Panel (bleibt beim Scrollen sichtbar); die Sitzung läuft weiter.
export function addPanelClose(panel: HTMLElement, closeLabel: string): void {
  const bar = document.createElement("div");
  bar.style.cssText = "position:sticky;top:0;z-index:1;display:flex;justify-content:flex-end;padding:2px 4px;background:var(--omp-surface);";
  const x = document.createElement("button");
  x.type = "button";
  x.textContent = "✕";
  x.title = closeLabel;
  x.setAttribute("aria-label", closeLabel);
  x.setAttribute("data-role", "panel-close");
  x.style.cssText = "cursor:pointer;padding:0 8px;line-height:1.4;border:1px solid var(--omp-border);border-radius:var(--omp-radius);background:var(--omp-surface-raised);color:var(--omp-text);";
  x.addEventListener("click", () => (panel.style.display = "none"));
  bar.appendChild(x);
  panel.prepend(bar);
}
