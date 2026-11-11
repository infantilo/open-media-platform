import { assert, assertEquals } from "jsr:@std/assert";
import { dbToFader, dbToPosition, faderToDb, positionToDb } from "./fader-law.ts";
import { BUTTON, NOTE } from "./mcu.ts";
import { McuUnit } from "./mcu-unit.ts";
import { SimSurface } from "./sim-surface.ts";
import { SurfaceController } from "./surface-controller.ts";
import { fmtDb, fmtPan, type MixerActions, type StripInfo, SurfaceLogic } from "./surface-logic.ts";

const ch = (n: number, over: Partial<StripInfo> = {}): StripInfo => ({ id: `c${n}`, label: `Mic ${n}`, gainDb: 0, mute: false, pfl: false, onAir: false, level: 0, pan: 0, ...over });

class FakeMixer implements MixerActions {
  calls: string[] = [];
  master?: (db: number) => void;
  setGain(id: string, db: number) { this.calls.push(`gain ${id} ${db}`); }
  setMute(id: string, m: boolean) { this.calls.push(`mute ${id} ${m}`); }
  setPfl(id: string, e: boolean) { this.calls.push(`pfl ${id} ${e}`); }
  setPan(id: string, p: number) { this.calls.push(`pan ${id} ${p}`); }
}

function rig(n: number, units = 1, withMaster = false) {
  const mixer = new FakeMixer();
  if (withMaster) mixer.master = (db) => mixer.calls.push(`master ${db}`);
  const m: MixerActions = withMaster ? Object.assign(mixer, { setMaster: mixer.master }) : mixer;
  const logic = new SurfaceLogic(m, { units: Array.from({ length: units }, (_, i) => ({ strips: 8, hasMaster: i === 0 })) });
  logic.setModel(Array.from({ length: n }, (_, i) => ch(i + 1)), withMaster ? { db: 0 } : null);
  const sims = Array.from({ length: units }, (_, i) => new SimSurface(`sim${i}`));
  let now = 1000;
  const ctl = new SurfaceController(sims.map((s) => new McuUnit(s)), logic, () => now);
  ctl.start();
  return { mixer, logic, sims, ctl, adv: (ms: number) => { now += ms; ctl.tick(); }, now: () => now };
}

Deno.test("Kennlinie: monoton, 0 dB bei 75 %, Umkehrung", () => {
  assertEquals(positionToDb(0.75), 0);
  assertEquals(positionToDb(0), -60);
  assertEquals(positionToDb(1), 12);
  let last = -1e9;
  for (let i = 0; i <= 200; i++) {
    const d = positionToDb(i / 200);
    assert(d >= last);
    last = d;
  }
  for (const db of [-60, -45.5, -20, -3, 0, 6, 12]) assert(Math.abs(positionToDb(dbToPosition(db)) - db) < 1e-9, String(db));
  assertEquals(dbToFader(0), 12287);
  assertEquals(faderToDb(16383), 12);
  assertEquals(faderToDb(0), -60);
});

Deno.test("Anzeigeformate", () => {
  assertEquals(fmtDb(-60), "-inf");
  assertEquals(fmtDb(3), "+3.0");
  assertEquals(fmtDb(0), "0.0");
  assertEquals(fmtDb(-3.25), "-3.3");
  assertEquals(fmtPan(0), "C");
  assertEquals(fmtPan(-0.5), "L50");
  assertEquals(fmtPan(1), "R100");
});

Deno.test("Start: Pult wird komplett beschrieben (Fader, LEDs, Anzeige, Bank)", () => {
  const { sims } = rig(10);
  const s = sims[0];
  assertEquals(s.faders.slice(0, 8), Array(8).fill(dbToFader(0)));
  assertEquals(s.leds.get(NOTE.mute), "off");
  assertEquals(s.text(0).slice(0, 14), "Mic 1  Mic 2  ");
  assertEquals(s.text(1).slice(0, 7), "0.0    ");
  assertEquals(String.fromCharCode(s.sevenSeg[11], s.sevenSeg[10]), "01");
});

Deno.test("Anmeldung: Pult fragt, Host antwortet mit dem Code, Einheit gilt als online", () => {
  const { sims, ctl } = rig(1);
  assert(ctl.units[0].online);
  const reply = sims[0].received.find((m) => m[5] === 0x02);
  assertEquals(reply?.slice(6), [0x53, 0x49, 0x4d, 0x30, 0x30, 0x30, 0x31, 5, 5, 123, 47, 0xf7]);
});

Deno.test("Fader ziehen: gedrosselt zum Mischer, letzter Wert kommt immer an; Loslassen sendet sofort", () => {
  const { mixer, sims, adv } = rig(3);
  const s = sims[0];
  s.drag(0, dbToFader(-10));
  s.drag(0, dbToFader(-12));
  s.drag(0, dbToFader(-14)); // innerhalb 50 ms: nur der erste ging raus
  assertEquals(mixer.calls, [`gain c1 ${faderToDb(dbToFader(-10))}`]);
  adv(60);
  assertEquals(mixer.calls.at(-1), `gain c1 ${faderToDb(dbToFader(-14))}`);
  s.drag(0, dbToFader(-20));
  s.release(0);
  assertEquals(mixer.calls.at(-1), `gain c1 ${faderToDb(dbToFader(-20))}`);
});

Deno.test("Fahrfader: Mischer-Änderung von außen fährt den Fader, nicht gegen den Finger", () => {
  const { logic, sims, adv } = rig(2);
  const s = sims[0];
  logic.setModel([ch(1, { gainDb: -20 }), ch(2)]);
  adv(10);
  assertEquals(s.faders[0], dbToFader(-20));
  s.touch(0, true);
  logic.setModel([ch(1, { gainDb: -5 }), ch(2)]);
  adv(10);
  assertEquals(s.faders[0], dbToFader(-20), "unter dem Finger bleibt er stehen");
  s.release(0);
  adv(10);
  assertEquals(s.faders[0], dbToFader(-5), "nach dem Loslassen fährt er zum Sollwert");
});

Deno.test("Gehaltener Wert: Anzeige springt nicht zurück, bis der Mischer bestätigt (oder 2 s)", () => {
  const { logic, sims, adv } = rig(1);
  const s = sims[0];
  s.drag(0, dbToFader(-30));
  s.release(0);
  logic.setModel([ch(1, { gainDb: 0 })]); // Mischer meldet noch den alten Wert
  adv(100);
  assertEquals(Math.abs(s.faders[0] - dbToFader(-30)) < 30, true);
  logic.setModel([ch(1, { gainDb: -30 })]);
  adv(10);
  logic.setModel([ch(1, { gainDb: -12 })]); // später verstellt jemand anders
  adv(10);
  assertEquals(s.faders[0], dbToFader(-12));
});

Deno.test("Tasten: Mute, Solo(PFL), Select, Rec-LED = onAir", () => {
  const { mixer, logic, sims, adv } = rig(4);
  const s = sims[0];
  s.press("mute2");
  assertEquals(mixer.calls.at(-1), "mute c2 true");
  assertEquals(s.leds.get(NOTE.mute + 1), "on");
  s.press("solo3");
  assertEquals(mixer.calls.at(-1), "pfl c3 true");
  s.press("select4");
  assertEquals(s.leds.get(NOTE.select + 3), "on");
  assertEquals(s.leds.get(NOTE.select), "off");
  logic.setModel([ch(1, { onAir: true }), ch(2, { mute: true }), ch(3, { pfl: true }), ch(4)]);
  adv(10);
  assertEquals(s.leds.get(NOTE.rec), "on");
  s.press("mute2");
  assertEquals(mixer.calls.at(-1), "mute c2 false");
});

Deno.test("Bank: 10 Kanäle, 8 Züge → Bank rechts zeigt 3 (geklemmt), links zurück; Kanal links/rechts ±1", () => {
  const { mixer, sims, logic } = rig(10);
  const s = sims[0];
  s.press("bankRight");
  assertEquals(logic.bank, 2);
  assertEquals(s.text(0).slice(0, 7), "Mic 3  ");
  assertEquals(s.text(0).slice(49, 56), "Mic 10 "); // Zug 8 = Kanal 10
  s.press("channelLeft");
  assertEquals(logic.bank, 1);
  s.press("bankLeft");
  assertEquals(logic.bank, 0);
  s.press("mute1");
  assertEquals(mixer.calls.at(-1), "mute c1 true");
});

Deno.test("Erweiterung: zweite Einheit zeigt Kanäle 9–16, eigene Bank-Taste springt um 16", () => {
  const { mixer, sims, logic } = rig(20, 2);
  assertEquals(sims[1].text(0).slice(0, 7), "Mic 9  ");
  sims[1].press("mute1");
  assertEquals(mixer.calls.at(-1), "mute c9 true");
  sims[0].press("bankRight");
  assertEquals(logic.bank, 4, "geklemmt: 20 − 16");
  assertEquals(sims[0].text(0).slice(0, 7), "Mic 5  ");
  assertEquals(sims[1].text(0).slice(0, 7), "Mic 13 ");
});

Deno.test("Master-Fader: nur mit Ziel; Strip 9 der Haupteinheit", () => {
  const a = rig(2, 1, true);
  a.sims[0].drag(8, dbToFader(-6));
  assertEquals(a.mixer.calls.at(-1), `master ${faderToDb(dbToFader(-6))}`);
  const b = rig(2, 1, false);
  b.sims[0].drag(8, dbToFader(-6));
  assertEquals(b.mixer.calls.length, 0);
});

Deno.test("Drehgeber: Pan ±5 % je Schritt, Druck = Mitte; Name/Wert schaltet die Anzeige um", () => {
  const { mixer, sims } = rig(2);
  const s = sims[0];
  s.turn(0, 2);
  assertEquals(mixer.calls.at(-1), "pan c1 0.1");
  s.turn(0, -5);
  assertEquals(mixer.calls.at(-1), "pan c1 -0.15");
  assertEquals(s.rings[0].value, 1 + Math.round(((-0.15 + 1) / 2) * 10));
  s.press("nameValue");
  assertEquals(s.text(1).slice(0, 7), "L15    ");
  s.press("vpotPush1");
  assertEquals(mixer.calls.at(-1), "pan c1 0");
  assertEquals(s.rings[0].led, true);
});

Deno.test("Pegel: Stufen 0…12, stumme Kanäle zeigen nichts", () => {
  const { logic, sims, adv } = rig(2);
  logic.setLevels({ c1: 1, c2: 0.5 });
  adv(10);
  assertEquals(sims[0].meters.slice(0, 2), [12, 6]);
  logic.setModel([ch(1, { mute: true, level: 1 }), ch(2)]);
  adv(10);
  assertEquals(sims[0].meters[0], 0);
});

Deno.test("Nur Änderungen werden gesendet (kein Dauerfeuer)", () => {
  const { sims, adv } = rig(2);
  const n = sims[0].received.length;
  adv(10);
  adv(10);
  assertEquals(sims[0].received.length, n);
});

Deno.test("Wiederverbinden: resync schreibt alles neu", () => {
  const { sims, ctl } = rig(2);
  sims[0].reset();
  ctl.resync();
  assertEquals(sims[0].faders[0], dbToFader(0));
  assertEquals(sims[0].text(0).slice(0, 7), "Mic 1  ");
});

Deno.test("Echo der eigenen Fahrt wird nicht als Bedienung gewertet, Berührung schon", () => {
  const { mixer, logic, sims, adv } = rig(1);
  logic.setModel([ch(1, { gainDb: -20 })]);
  adv(10);
  // echtes Pult würde die neue Stellung zurückmelden (ohne Berührung)
  sims[0].faders[0] = dbToFader(-20);
  mixer.calls.length = 0;
  (sims[0] as unknown as { drag(n: number, v: number): void }).drag(0, dbToFader(-20));
  assertEquals(mixer.calls.length, 1, "mit Berührung gilt es als Bedienung");
});

Deno.test("Tastenname-Konstanten stimmen mit der Noten-Tabelle", () => {
  assertEquals(BUTTON.bankLeft, 46);
  assertEquals(BUTTON.play, 94);
});
