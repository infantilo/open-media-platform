import { assertEquals } from "jsr:@std/assert";
import { applyLiveMessage, AudioMixerBackend, parseMixState } from "./audio-backend.ts";

const doc = {
  channels: [
    { id: "a", label: "Mic 1", gainDb: -3, mute: false, pfl: true, proc: { pan: -0.5 } },
    { id: "b", gainDb: 0, mute: true },
  ],
  auxBuses: [{ id: "x", label: "Studio", masterDb: -6 }],
};

Deno.test("mixState → Pult-Modell (auch als String)", () => {
  const live = new Map([["a", { level: 0.4, onAir: true }]]);
  for (const raw of [doc, JSON.stringify(doc)]) {
    const p = parseMixState(raw, live);
    assertEquals(p.channels[0].raw?.id, "a", "ganzer Mischer-Eintrag bleibt für Tasten-LEDs erhalten");
    assertEquals({ ...p.channels[0], raw: undefined }, { id: "a", label: "Mic 1", gainDb: -3, mute: false, pfl: true, onAir: true, level: 0.4, pan: -0.5, raw: undefined });
    assertEquals({ ...p.channels[1], raw: undefined }, { id: "b", label: "b", gainDb: 0, mute: true, pfl: false, onAir: false, level: 0, pan: null, raw: undefined });
    assertEquals(p.aux, [{ id: "x", label: "Studio", masterDb: -6 }]);
  }
  assertEquals(parseMixState(null).channels, []);
});

Deno.test("Live-Meldungen: Pegel (peak) und On-Air (dsp), Master ignoriert", () => {
  const live = new Map<string, { level: number; onAir: boolean }>();
  assertEquals(applyLiveMessage(live, { channelId: "a", rms: 0.1, peak: 0.7 }), "a");
  assertEquals(applyLiveMessage(live, { type: "dsp", channelId: "a", onAir: true }), "a");
  assertEquals(live.get("a"), { level: 0.7, onAir: true });
  assertEquals(applyLiveMessage(live, { channelId: null, peak: 1 }), null);
  assertEquals(applyLiveMessage(live, { channelId: "a", peak: 7 }), "a");
  assertEquals(live.get("a")?.level, 1);
});

Deno.test("Rückgrat: Befehle gehen als channel.<id>.set*, Master nur mit Ziel; Fehler werden gemeldet", async () => {
  const calls: string[] = [];
  const be = new AudioMixerBackend({ getParam: () => Promise.resolve(doc), call: (n, b) => { calls.push(`${n} ${JSON.stringify(b)}`); return n.includes("Pan") ? Promise.reject(new Error("403")) : Promise.resolve(); } });
  be.setGain("a", -4.5);
  be.setMute("a", true);
  be.setPfl("b", false);
  assertEquals(be.setMaster, undefined);
  be.setMasterTarget("x");
  be.setMaster!(-1);
  const errs: unknown[] = [];
  be.errors.push((e) => errs.push(e));
  be.setPan("a", 0.2);
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(calls, ['channel.a.setGain {"db":-4.5}', 'channel.a.setMute {"muted":true}', 'channel.b.setPfl {"enabled":false}', 'aux.x.setMaster {"db":-1}', 'channel.a.setPan {"pan":0.2}']);
  assertEquals(errs.length, 1);
  be.setMasterTarget("x");
  assertEquals((await be.refresh()).master, { db: -6 });
});
