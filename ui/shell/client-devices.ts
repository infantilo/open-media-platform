// Meldet dem Orchestrator, welche Bedien-Geräte dieser Browser gerade nutzt (MIDI-Pult, Stream Deck) — für die Admin-Ansicht
// „Verbundene Clients“. Gemeldet wird bei jeder Änderung und nach jedem Neuaufbau des Ereignis-Stroms (der Server kennt die
// Geräte einer Verbindung nur, solange sie besteht).
import { apiFetch, connectionMonitor } from "./connection.ts";
import { clientId } from "./client-id.ts";
import { midiSession } from "./midi/instance.ts";
import { deckSession } from "./streamdeck/session.ts";

interface Dev {
  name: string;
  simulated?: boolean;
}

export function collectDevices(): { midi: Dev[]; streamDeck: Dev[] } {
  const midi: Dev[] = midiSession.running
    ? midiSession.ports.map((p) => ({ name: p.name, simulated: /^Simulator/i.test(p.name) }))
    : [];
  const d = deckSession.device;
  const streamDeck: Dev[] = d ? [{ name: d.label.replace(/\s*\(Simulator\)\s*$/i, ""), simulated: /Simulator/i.test(d.label) }] : [];
  return { midi, streamDeck };
}

let timer: ReturnType<typeof setTimeout> | undefined;
let lastSent = "";

function send(force: boolean) {
  const body = JSON.stringify({ cid: clientId(), ...collectDevices() });
  if (!force && body === lastSent) return;
  lastSent = body;
  void apiFetch("/api/v1/clients/devices", { method: "PUT", headers: { "content-type": "application/json" }, body }).catch(() => {});
}

function schedule(force = false) {
  clearTimeout(timer);
  timer = setTimeout(() => send(force), 500);
}

let started = false;
export function startDeviceReporting() {
  if (started) return;
  started = true;
  midiSession.onChange(() => schedule());
  deckSession.onChange(() => schedule());
  connectionMonitor.addEventListener("statechange", () => {
    if (connectionMonitor.state === "connected") schedule(true);
  });
}
