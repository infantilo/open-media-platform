import { assertEquals } from "jsr:@std/assert";
import type { MidiPort } from "./midi-port.ts";
import { type Profile, ProfileEngine } from "./profile.ts";
import { ProfileRunner } from "./profile-runner.ts";
import golden from "../../../docs/midi/profile-golden.json" with { type: "json" };

class FakePort implements MidiPort {
  name = "Gerät";
  #l = new Set<(b: number[]) => void>();
  send() {}
  onData(cb: (b: number[]) => void) {
    this.#l.add(cb);
    return () => this.#l.delete(cb);
  }
  close() {}
  emit(...b: number[]) {
    for (const l of this.#l) l(b);
  }
}

function rig(values: Record<string, unknown> = {}, fail = false) {
  const calls: string[] = [];
  const port = new FakePort();
  const runner = new ProfileRunner(port, new ProfileEngine(golden.profile as Profile, "Mischer"), {
    call: (n, m, a) => {
      calls.push(`${n} ${m} ${JSON.stringify(a)}`);
      return fail ? Promise.reject(new Error("403")) : Promise.resolve();
    },
    read: (_n, p) => Promise.resolve(values[p]),
  });
  runner.start();
  return { calls, port, runner };
}

Deno.test("Regler → Methodenaufruf; zwei Nachrichten mit Laufstatus in einem Block", async () => {
  const { calls, port, runner } = rig();
  port.emit(0xb0, 7, 127, 7, 0);
  await runner.idle();
  assertEquals(calls, ['Mischer channel.mic1.setGain {"db":12}', 'Mischer channel.mic1.setGain {"db":-60}']);
});

Deno.test("Relativer Regler liest, ändert, schreibt (geklemmt)", async () => {
  const { calls, port, runner } = rig({ "channel.mic1.gain": 11.8 });
  port.emit(0xb0, 16, 66); // +2 × 0,5 = +1 → 12,8 → geklemmt 12
  await runner.idle();
  assertEquals(calls, ['Mischer channel.mic1.setGain {"db":12}']);
  const b = rig({ "channel.mic1.gain": "kein Wert" });
  b.port.emit(0xb0, 16, 66);
  await b.runner.idle();
  assertEquals(b.calls, []);
});

Deno.test("Lernen: nächste Bewegung wird gemeldet und nicht ausgeführt", async () => {
  const { calls, port, runner } = rig();
  let got: unknown = null;
  runner.learn((d) => (got = d));
  port.emit(0xb2, 7, 99);
  assertEquals(got, { type: "cc", channel: 3, num: 7, value: 99 });
  assertEquals(calls, []);
  port.emit(0xb0, 7, 127);
  await runner.idle();
  assertEquals(calls.length, 1);
  assertEquals(runner.last?.value, 127);
});

Deno.test("Fehler am Ziel werden gemeldet, nicht geworfen", async () => {
  const { port, runner } = rig({}, true);
  const errs: unknown[] = [];
  runner.onError = (e) => errs.push(e);
  port.emit(0xb0, 7, 127);
  await runner.idle();
  assertEquals(errs.length, 1);
});
