import { assert, assertEquals } from "jsr:@std/assert";
import { dbToFader } from "./fader-law.ts";
import { type SessionDeps, MidiSession } from "./session.ts";
import { SimSurface } from "./sim-surface.ts";
import type { MixerIO } from "./audio-backend.ts";

function deps() {
  const calls: string[] = [];
  const mix = { channels: [{ id: "a", label: "A", gainDb: -10, mute: false, pfl: false }, { id: "b", label: "B", gainDb: 0, mute: false, pfl: false }], auxBuses: [{ id: "x", masterDb: -3 }] };
  const ios = new Map<string, MixerIO>();
  const d: SessionDeps = {
    ioFor: (id) => {
      let io = ios.get(id);
      if (!io) {
        io = { getParam: (n) => Promise.resolve(n === "mixState" ? mix : n === "channel.mic1.gain" ? 1 : null), call: (n, b) => { calls.push(`${id} ${n} ${JSON.stringify(b)}`); return Promise.resolve(); } };
        ios.set(id, io);
      }
      return io;
    },
    resolveNode: (l) => Promise.resolve(l === "Mischer 2" ? "n2" : null),
    setInterval: () => 0,
    clearInterval: () => {},
    now: () => 1000,
  };
  return { d, calls, mix };
}

Deno.test("Sitzung MCU: Start liest den Mischer, Pult zeigt die Werte, Bedienung geht als Methodenaufruf raus", async () => {
  const { d, calls } = deps();
  const s = new MidiSession(d);
  const sim = new SimSurface();
  await s.start({ mode: "mcu", ports: [sim], mixerNodeId: "n1", masterAux: "x" });
  assert(s.running);
  assertEquals(sim.faders[0], dbToFader(-10));
  assertEquals(sim.faders[8], dbToFader(-3), "Master-Fader folgt dem Aux-Bus");
  sim.press("mute1");
  assertEquals(calls.at(-1), 'n1 channel.a.setMute {"muted":true}');
  sim.drag(8, dbToFader(-20));
  assertEquals(calls.at(-1), 'n1 aux.x.setMaster {"db":-20}');
  s.stop();
  assert(!s.running);
});

Deno.test("Sitzung: Start ohne Anschluss meldet no-port; stop ist wiederholbar", async () => {
  const s = new MidiSession(deps().d);
  await s.start({ mode: "mcu", ports: [], mixerNodeId: "n1" });
  assertEquals(s.error, "no-port");
  assert(!s.running);
  s.stop();
  s.stop();
});

Deno.test("Sitzung Profil: Ziel-Node per Anzeigename, Rückfall auf den gewählten Mischer; unbekannter Node = Fehler", async () => {
  const { d, calls } = deps();
  const s = new MidiSession(d);
  const sim = new SimSurface();
  const listeners: ((b: number[]) => void)[] = [];
  sim.onData = (cb) => { listeners.push(cb); return () => {}; };
  await s.start({
    mode: "profile",
    ports: [sim],
    mixerNodeId: "n1",
    profile: { name: "t", controls: [
      { id: "m", in: { type: "note", num: 40 }, mode: "toggle", to: { node: "Mischer 2", method: "channel.a.setMute", arg: "muted" } },
      { id: "p", in: { type: "note", num: 41 }, to: { method: "x.go" } },
      { id: "u", in: { type: "note", num: 42 }, to: { node: "Gibt es nicht", method: "x" } },
    ] },
  });
  listeners.forEach((l) => l([0x90, 40, 127, 0x90, 41, 127, 0x90, 42, 127]));
  await s.runner!.idle();
  assertEquals([...calls].sort(), ["n1 x.go {}", 'n2 channel.a.setMute {"muted":true}']);
  assert(s.error.includes("nicht gefunden"));
  s.stop();
});
