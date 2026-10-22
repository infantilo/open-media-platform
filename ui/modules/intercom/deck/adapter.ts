// Stream-Deck-Adapter des Intercoms (Kapitel 47.10, ab Kapitel 49 Teil der Intercom-Oberfläche, nicht der Shell): holt den
// Zustand der eigenen Sprechstelle über die Vertragsrolle `deck.state` und schickt Tasten über `deck.command`. Gedrückt
// halten = sprechen (PTT) oder, im Rasten-Betrieb, umschalten. Die Shell kennt nur die Schnittstelle `streamDeck` eines
// Elements (shell/streamdeck/adapter.ts), nie dieses Produkt.

import type { AdapterLayout, LayoutContext, StreamDeckAdapter } from "../../../shell/streamdeck/adapter.ts";
import { type Cmd, type DeckState, layoutIntercom, type IntercomLayout, nudgedLevel } from "./logic.ts";

/** Zugriff auf die Rollen `deck.state` / `deck.command` des Intercom-Dienstes. */
export interface DeckIO {
  state(party: number): Promise<DeckState>;
  command(party: number, cmd: Cmd): Promise<void>;
}

export function intercomAdapter(io: DeckIO, getParty: () => number | null): StreamDeckAdapter & { onChange: () => void; onError: (e: unknown) => void } {
  let st: DeckState | null = null;
  let last: IntercomLayout | null = null;
  let latch = false;
  const a = {
    onChange: () => {},
    onError: (_e: unknown) => {},
    getLayout(ctx: LayoutContext): AdapterLayout {
      if (!st) return { keys: Array.from({ length: ctx.rows }, () => Array(ctx.cols).fill(null)) };
      last = layoutIntercom(st, ctx.cols, ctx.rows, ctx.dials, ctx.page, latch);
      return { keys: last.keys, dials: last.dials, pages: last.pages };
    },
    onKey(row: number, col: number, down: boolean) {
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
    onDial(i: number, delta: number) {
      const d = last?.dialAct[i];
      if (d) void send({ t: "level", ch: d.ch, v: nudgedLevel(d.level, delta) });
    },
    onDialPress(i: number, down: boolean) {
      const d = last?.dialAct[i];
      if (down && d) void send({ t: "listen", ch: d.ch, on: !d.listenOn });
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
    },
  };

  async function send(cmd: Cmd) {
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
