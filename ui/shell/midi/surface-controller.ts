// Verdrahtet Einheiten (McuUnit) mit der Pult-Logik: Ereignisse hinein, Zustand heraus. Takt von außen (`tick`), Uhr austauschbar.

import type { McuUnit } from "./mcu-unit.ts";
import type { SurfaceLogic } from "./surface-logic.ts";

export class SurfaceController {
  #offs: (() => void)[] = [];

  constructor(readonly units: McuUnit[], readonly logic: SurfaceLogic, private clock: () => number = () => performance.now()) {}

  start() {
    this.units.forEach((u, i) => {
      this.#offs.push(
        u.onEvent((ev) => {
          this.logic.onEvent(i, ev, this.clock());
          this.render();
        }),
        u.onHostMove((strip) => this.logic.noteHostMove(i, strip, this.clock())),
      );
      u.start();
    });
    this.render();
  }

  stop() {
    for (const o of this.#offs) o();
    this.#offs = [];
    for (const u of this.units) u.stop();
  }

  /** Alle Pulte neu beschreiben (z. B. nach Wiederverbinden). */
  resync() {
    for (const u of this.units) u.resync();
    this.render();
  }

  render() {
    const now = this.clock();
    this.units.forEach((u, i) => u.apply(this.logic.view(i, now)));
  }

  /** Regelmäßig rufen (≈ 20–50 ms): gedrosselte Befehle, Anzeige. */
  tick() {
    this.logic.flush(this.clock());
    this.render();
  }
}
