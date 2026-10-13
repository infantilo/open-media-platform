// Virtuelles Gerät (Kap. 40.2): erfüllt `HidLike`, setzt die gesendeten
// Chunks wieder zu Bildern zusammen und nimmt Eingaben der Simulator-Seite
// als echte Input-Reports entgegen. Gleicher Protokollpfad wie am Gerät.

import type { DeckModel } from "./models.ts";
import { keyCount } from "./models.ts";
import {
  encodeDialPress,
  encodeDialTurn,
  encodeFlick,
  encodeKeyState,
  encodeTap,
  type OutputImage,
  OutputAssembler,
} from "./protocol.ts";
import type { HidLike } from "./transport.ts";
import { VENDOR_ID } from "./models.ts";

export class SimHid implements HidLike {
  readonly vendorId = VENDOR_ID;
  readonly productId: number;
  readonly productName: string;
  opened = false;
  brightness = 100;
  logoShown = false;
  /** Von der Seite gesetzt: neues Bild angekommen. */
  onImage: (img: OutputImage) => void = () => {};
  /** Protokollfehler (z. B. gestörte Chunk-Folge). */
  onError: (e: Error) => void = () => {};
  #asm = new OutputAssembler();
  #cbs = new Set<(e: { data: DataView }) => void>();
  #keys = new Set<number>();
  #dials = new Set<number>();

  constructor(readonly model: DeckModel) {
    this.productId = model.pid;
    this.productName = `${model.name} (Simulator)`;
  }

  open(): Promise<void> {
    this.opened = true;
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.opened = false;
    return Promise.resolve();
  }
  sendReport(id: number, data: Uint8Array): Promise<void> {
    if (id !== 0x02) return Promise.resolve();
    try {
      const img = this.#asm.feed(data);
      if (img) this.onImage(img);
      this.logoShown = false;
    } catch (e) {
      this.onError(e as Error);
    }
    return Promise.resolve();
  }
  sendFeatureReport(id: number, data: Uint8Array): Promise<void> {
    if (id === 0x03 && data[0] === 0x08) this.brightness = data[1];
    if (id === 0x03 && data[0] === 0x02) this.logoShown = true;
    return Promise.resolve();
  }
  addEventListener(_t: "inputreport", cb: (e: { data: DataView }) => void) {
    this.#cbs.add(cb);
  }
  removeEventListener(_t: "inputreport", cb: (e: { data: DataView }) => void) {
    this.#cbs.delete(cb);
  }

  #emit(d: Uint8Array) {
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    for (const cb of this.#cbs) cb({ data: dv });
  }

  // Eingaben der Seite
  pressKey(i: number, down: boolean) {
    if (down) this.#keys.add(i);
    else this.#keys.delete(i);
    this.#emit(encodeKeyState(this.model, this.#keys));
  }
  turnDial(i: number, delta: number) {
    if (this.model.dials) this.#emit(encodeDialTurn(this.model, i, delta));
  }
  pressDial(i: number, down: boolean) {
    if (!this.model.dials) return;
    if (down) this.#dials.add(i);
    else this.#dials.delete(i);
    this.#emit(encodeDialPress(this.model, this.#dials));
  }
  touch(type: "tap" | "press", x: number, y: number) {
    if (this.model.strip) this.#emit(encodeTap(type, x, y));
  }
  flick(x: number, y: number, x2: number, y2: number) {
    if (this.model.strip) this.#emit(encodeFlick(x, y, x2, y2));
  }
  get keyCount() {
    return keyCount(this.model);
  }
}
