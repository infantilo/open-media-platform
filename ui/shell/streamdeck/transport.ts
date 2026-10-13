// Transport (Kap. 40.2): `DeckDevice` spricht über die schmale Schnittstelle
// `HidLike` — echtes WebHID-`HIDDevice` und der Simulator erfüllen sie beide.

import { modelForPid, type DeckModel, VENDOR_ID } from "./models.ts";
import {
  brightnessFeature,
  type DeckEvent,
  InputDecoder,
  keyImageReports,
  showLogoFeature,
  stripImageReports,
} from "./protocol.ts";

/** Teilmenge von `HIDDevice`, die wir brauchen. */
export interface HidLike {
  productId: number;
  vendorId: number;
  productName?: string;
  opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(id: number, data: Uint8Array): Promise<void>;
  sendFeatureReport(id: number, data: Uint8Array): Promise<void>;
  addEventListener(type: "inputreport", cb: (e: { data: DataView }) => void): void;
  removeEventListener(type: "inputreport", cb: (e: { data: DataView }) => void): void;
}

export type OpenError = "unsupported-model" | "open-failed";

export class DeckDevice {
  readonly model: DeckModel;
  #hid: HidLike;
  #decoder: InputDecoder;
  #listeners = new Set<(e: DeckEvent) => void>();
  #onReport = (e: { data: DataView }) => {
    const d = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    for (const ev of this.#decoder.decode(d)) for (const l of this.#listeners) l(ev);
  };

  private constructor(hid: HidLike, model: DeckModel) {
    this.#hid = hid;
    this.model = model;
    this.#decoder = new InputDecoder(model);
  }

  /** Öffnet ein Gerät; wirft `Error(OpenError)` mit lesbarem Code in `message`. */
  static async open(hid: HidLike): Promise<DeckDevice> {
    const model = hid.vendorId === VENDOR_ID ? modelForPid(hid.productId) : undefined;
    if (!model) throw new Error("unsupported-model" satisfies OpenError);
    try {
      if (!hid.opened) await hid.open();
    } catch {
      throw new Error("open-failed" satisfies OpenError);
    }
    const dev = new DeckDevice(hid, model);
    hid.addEventListener("inputreport", dev.#onReport);
    return dev;
  }

  onEvent(cb: (e: DeckEvent) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  async setKeyImage(key: number, jpeg: Uint8Array): Promise<void> {
    for (const r of keyImageReports(key, jpeg)) await this.#hid.sendReport(0x02, r);
  }

  async setStripImage(x: number, y: number, w: number, h: number, jpeg: Uint8Array): Promise<void> {
    if (!this.model.strip) return;
    for (const r of stripImageReports(x, y, w, h, jpeg)) await this.#hid.sendReport(0x02, r);
  }

  async setBrightness(pct: number): Promise<void> {
    await this.#hid.sendFeatureReport(0x03, brightnessFeature(pct));
  }

  /** Zeigt das Logo und schließt (Hersteller-Empfehlung statt „Reset“). */
  async close(): Promise<void> {
    this.#hid.removeEventListener("inputreport", this.#onReport);
    this.#listeners.clear();
    try {
      await this.#hid.sendFeatureReport(0x03, showLogoFeature());
      await this.#hid.close();
    } catch { /* Gerät evtl. schon getrennt */ }
  }
}

// ── Verbindung (Browser) ────────────────────────────────────────────────────

export type ConnectResult =
  | { ok: true; device: DeckDevice }
  | { ok: false; reason: "no-webhid" | "insecure-context" | "denied" | OpenError };

type NavHid = {
  requestDevice(o: { filters: { vendorId: number }[] }): Promise<HidLike[]>;
  getDevices(): Promise<HidLike[]>;
};

export async function connectWithPrompt(): Promise<ConnectResult> {
  const hid = (navigator as unknown as { hid?: NavHid }).hid;
  if (!hid) return { ok: false, reason: globalThis.isSecureContext ? "no-webhid" : "insecure-context" };
  let devs: HidLike[];
  try {
    devs = await hid.requestDevice({ filters: [{ vendorId: VENDOR_ID }] });
  } catch {
    return { ok: false, reason: "denied" };
  }
  if (!devs.length) return { ok: false, reason: "denied" };
  return openResult(devs[0]);
}

/** Bereits freigegebenes Gerät ohne Dialog öffnen (Wiederverbinden). */
export async function connectKnown(): Promise<ConnectResult | null> {
  const hid = (navigator as unknown as { hid?: NavHid }).hid;
  if (!hid) return null;
  const known = (await hid.getDevices().catch(() => [])).find((d) => d.vendorId === VENDOR_ID && modelForPid(d.productId));
  return known ? openResult(known) : null;
}

async function openResult(h: HidLike): Promise<ConnectResult> {
  try {
    return { ok: true, device: await DeckDevice.open(h) };
  } catch (e) {
    return { ok: false, reason: (e as Error).message as OpenError };
  }
}
