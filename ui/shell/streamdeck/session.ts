// Sitzung (Kap. 40.4): Tab-Register der Konsole (unabhängig vom Gerät) +
// optionaler Broker, sobald ein Gerät verbunden ist. Das Gerät hält die
// Shell, ein Tab (ENTWURF §2). Wiederverbinden über navigator.hid.

import { DeckBroker } from "./broker.ts";
import { connectKnown, type DeckDevice } from "./transport.ts";

interface Reg {
  label: string;
  el: HTMLElement;
  nodeId: string;
}

class DeckSession {
  #reg = new Map<string, Reg>();
  #broker: DeckBroker | null = null;
  #dev: DeckDevice | null = null;
  #hotplug = false;
  #listeners = new Set<() => void>();
  /** Die Konsole hängt hier ein: Gerät hat Tab gewählt → Kachel nach vorn. */
  focusRequest: (id: string | null) => void = () => {};

  get broker() {
    return this.#broker;
  }
  get device() {
    return this.#dev;
  }
  onChange(cb: () => void) {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }
  #emit() {
    for (const l of this.#listeners) l();
  }

  registerTab(id: string, label: string, el: HTMLElement, nodeId: string) {
    const short = label.replace(/^omp-/, ""); // Tasten sind klein
    this.#reg.set(id, { label: short, el, nodeId });
    this.#broker?.attach(id, short, el, nodeId);
  }
  unregisterTab(id: string) {
    this.#reg.delete(id);
    this.#broker?.detach(id);
  }
  /** Bildschirm hat eine Kachel nach vorn geholt → Gerät folgt. */
  focusFromScreen(id: string) {
    if (this.#broker?.active !== undefined && this.#reg.has(id)) this.#broker?.focus(id);
  }

  setDevice(dev: DeckDevice | null) {
    this.#broker?.stop();
    this.#broker = null;
    this.#dev = dev;
    if (dev) {
      const b = new DeckBroker(dev);
      b.onFocusRequest = (id) => this.focusRequest(id);
      for (const [id, r] of this.#reg) b.attach(id, r.label, r.el, r.nodeId);
      this.#broker = b;
      this.#installHotplug();
    }
    this.#emit();
  }

  #installHotplug() {
    if (this.#hotplug) return;
    const hid = (navigator as unknown as { hid?: EventTarget }).hid;
    if (!hid) return;
    this.#hotplug = true;
    hid.addEventListener("disconnect", () => {
      if (this.#dev) this.setDevice(null);
    });
    hid.addEventListener("connect", async () => {
      if (this.#dev) return;
      const r = await connectKnown();
      if (r?.ok) this.setDevice(r.device);
    });
  }
}

export const deckSession = new DeckSession();
