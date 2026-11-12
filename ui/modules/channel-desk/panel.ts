// Bundle des Nodes `omp-channel-desk` (Kapitel 96): das Mehrkanal-Panel als Konsole eines Operators.
// Es zeigt genau die Playout-Channels, die der angemeldete Nutzer laut `/api/v1/me/consoles` bedienen darf
// (Rechte werden im Orchestrator aufgelöst, hier nur gelesen) und folgt Rollen, die kommen und gehen.
import { apiFetch } from "../../shell/connection.ts";
import { ChannelDesk } from "./channel-desk.ts";
import type { ConsoleEntry } from "../../shell/console-view.ts";
import type { AdapterLayout, LayoutContext, StreamDeckAdapter } from "../../shell/streamdeck/adapter.ts";
import { actionTargets, buildCells, layoutCells, needsConfirm, type DeckAct, type DeckGrid } from "./deck-logic.ts";
import type { GangAction } from "./multichannel-logic.ts";

const REFRESH_MS = 10_000;

export class ChannelDeskPanel extends HTMLElement {
  #desk?: ChannelDesk;
  #timer?: number;
  #sig = "";
  #deck?: StreamDeckAdapter & { onChange: () => void; onError: (e: unknown) => void };
  #grid: DeckGrid | null = null;
  #armed: { a: GangAction; until: number } | null = null;
  #openMode = false;

  connectedCallback() {
    this.style.cssText = "display:block;width:100%;height:100%;min-height:0;";
    this.#desk = document.createElement("omp-channel-desk") as ChannelDesk;
    this.#desk.onModelChange = () => this.#deck?.onChange();
    this.append(this.#desk);
    void this.#refresh();
    this.#timer = setInterval(() => void this.#refresh(), REFRESH_MS) as unknown as number;
  }

  /**
   * Stream-Deck-Belegung (Stufe 1 des Node-Tutorials): Übersicht mit Channel-Tasten und Gruppen-Start, in der
   * Channel-Ansicht Wechsel + Aktionen für den geöffneten Channel. Gruppen-Aktionen auf mehrere Channels verlangen
   * einen zweiten Druck, weil am Gerät kein Dialog möglich ist.
   */
  get streamDeck(): StreamDeckAdapter {
    if (this.#deck) return this.#deck;
    const desk = () => this.#desk;
    const armed = () => (this.#armed && Date.now() < this.#armed.until ? this.#armed.a : null);
    const deck = {
      onChange: () => {},
      onError: (_e: unknown) => {},
      getLayout: (ctx: LayoutContext): AdapterLayout => {
        const d = desk();
        if (!d) return { keys: Array.from({ length: ctx.rows }, () => Array(ctx.cols).fill(null)) };
        const input = d.deckInput(armed(), this.#openMode);
        const grid = layoutCells(buildCells(input, ctx.cols), ctx);
        this.#grid = grid;
        const a = input.attention;
        const dials = ctx.dials > 0
          ? [{ label: "Handlung", value: a ? `${a.channel} ${a.waiting ? "…" : Math.max(0, Math.round(a.inMs / 1000)) + " s"}` : "—", dim: !a }]
          : undefined;
        return { keys: grid.keys, dials, pages: grid.pages };
      },
      onKey: (row: number, col: number, down: boolean) => {
        const d = desk();
        const act: DeckAct | null | undefined = this.#grid?.acts[row]?.[col];
        if (!d || !down || !act) return;
        switch (act.t) {
          case "select": d.toggleSelect(act.key); break;
          case "open": this.#openMode = false; d.openChannel(act.key); break;
          case "back": d.openChannel(null); break;
          case "all": d.selectAll(); break;
          case "none": d.selectNone(); break;
          case "mode": this.#openMode = !this.#openMode; deck.onChange(); break;
          case "info": if (act.key) { this.#openMode = false; d.openChannel(act.key); } break;
          case "action": {
            const input = d.deckInput(armed(), this.#openMode);
            const targets = actionTargets(input);
            if (targets.length === 0) break;
            if (needsConfirm(targets.length, armed(), act.a)) {
              this.#armed = { a: act.a, until: Date.now() + 3000 };
              deck.onChange();
              setTimeout(() => deck.onChange(), 3100); // Vormerkung läuft ab → Taste zurücksetzen
              break;
            }
            this.#armed = null;
            d.runAction(act.a, targets, false).catch((e) => deck.onError(e)).finally(() => deck.onChange());
          }
        }
      },
      refresh: async () => { await desk()?.refreshNow(); },
    };
    this.#deck = deck;
    return deck;
  }

  disconnectedCallback() {
    clearInterval(this.#timer);
  }

  async #refresh() {
    try {
      const res = await apiFetch("/api/v1/me/consoles");
      if (!res.ok) return;
      const body = (await res.json()) as { consoles?: ConsoleEntry[] | null };
      const entries = body.consoles ?? []; // das Panel selbst ist kein Channel und fällt bei der Prüfung heraus
      const sig = entries.map((e) => `${e.nodeRoleId}|${e.uiBundleUrl}|${e.nodeLabel}`).join(";");
      if (sig === this.#sig) return;
      this.#sig = sig;
      await this.#desk?.setEntries(entries);
    } catch { /* nächster Versuch in 10 s */ }
  }

}

if (!customElements.get("omp-channel-desk")) customElements.define("omp-channel-desk", ChannelDesk);
if (!customElements.get("omp-channel-desk-panel")) customElements.define("omp-channel-desk-panel", ChannelDeskPanel);
