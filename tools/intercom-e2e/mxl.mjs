// MXL-Strecke (Kapitel 47.9): Panel P spricht → Kanal 1 → Teilnehmer „Anbindung“ (Mix-Ausgang 1 = MXL-Flow) →
// IS-05-Verbindung auf Programm-Eingang 1 → Teilnehmer „Programm“ spricht in Kanal 2 → Panel Q hört den Ton.
// Der Node muss mit LD_LIBRARY_PATH (deploy/dev/mxl.env) und eigener OMP_MXL_DOMAIN laufen.
//   node mxl.mjs [node-url] [cdp-port]
import fs from 'node:fs';
import { openTab, sleep } from './cdp.mjs';

const NODE = process.argv[2] || 'http://127.0.0.1:9450';
const CDP = Number(process.argv[3] || 9333);
const REG = process.env.OMP_REGISTRY_URL || 'http://127.0.0.1:8010';
const inject = fs.readFileSync(new URL('./inject.js', import.meta.url), 'utf8');
let failed = 0; const check = (ok, m) => { console.log((ok ? 'OK   ' : 'FEHLER ') + m); if (!ok) failed++; };

const cfg = {
  channels: [{ id: 1, name: 'Regie' }, { id: 2, name: 'Programm' }],
  parties: [
    { id: 1, name: 'P', token: 'tP', routes: [{ ch: 1, talk: true, listen: true }] },
    { id: 2, name: 'Q', token: 'tQ', routes: [{ ch: 2, listen: true }] },
    { id: 10, name: 'Lautsprecher', kind: 'port', mxl_out: 1, token: 'tL', routes: [{ ch: 1, listen: true }] },
    { id: 11, name: 'Programm 1', kind: 'program', mxl_in: 1, token: 'tG', routes: [{ ch: 2, talk: true }] },
  ],
};
check((await fetch(NODE + '/config', { method: 'PUT', body: JSON.stringify(cfg) })).ok, 'Konfiguration mit MXL-Anschlüssen angenommen');
const dup = { ...cfg, parties: [...cfg.parties, { id: 12, name: 'Doppelt', kind: 'program', mxl_in: 1, token: 'tD', routes: [] }] };
check((await fetch(NODE + '/config', { method: 'PUT', body: JSON.stringify(dup) })).status === 400, 'doppelter Programmeingang wird abgelehnt');
await fetch(NODE + '/config', { method: 'PUT', body: JSON.stringify(cfg) });

let st = await (await fetch(NODE + '/status')).json();
check(st.mxl && st.mxl.inputs.length >= 1 && st.mxl.outputs.length >= 1, 'Status meldet MXL-Ein-/Ausgänge: ' + JSON.stringify(st.mxl));
const flow = st.mxl.outputs[0].flow;

// Sender/Receiver in der Registry finden
await sleep(1500);
const senders = await (await fetch(REG + '/x-nmos/query/v1.3/senders')).json();
const sender = senders.find(s => s.flow_id === flow);
check(!!sender, 'Sender „Intercom Mix 1“ in der Registry (Flow ' + flow.slice(0, 8) + ')');
const rlist = await (await fetch(NODE + '/x-nmos/connection/v1.2/single/receivers/')).json();
check(rlist.length >= 1, 'IS-05-Receiver am Node: ' + rlist.length);

async function panel(token) {
  const tab = await openTab(CDP, 'about:blank');
  await tab.send('Page.enable');
  await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: inject });
  await tab.send('Page.navigate', { url: `${NODE}/panel?token=${token}` });
  await sleep(600);
  await tab.evaluate("document.getElementById('go').click()");
  for (let i = 0; i < 60; i++) {
    if (await tab.evaluate("!!(window.__ic && window.__ic.state && window.__ic.pc && window.__ic.pc.connectionState === 'connected')")) return tab;
    await sleep(250);
  }
  throw new Error('Panel ' + token + ' verbindet nicht');
}
const P = await panel('tP'), Q = await panel('tQ');
const burst = async (ms = 800) => {
  await Q.evaluate('window.__arm()');
  await P.evaluate("window.__ic.send({t:'talk',ch:1,on:true})"); await sleep(100);
  await P.evaluate('window.__tone(true)'); await sleep(ms);
  await P.evaluate('window.__tone(false)'); await P.evaluate("window.__ic.send({t:'talk',ch:1,on:false})"); await sleep(200);
  return Q.evaluate('window.__heard()');
};

let h = await burst();
check(h.heardAt === null, 'ohne IS-05-Verbindung hört Q nichts (Pegel ' + h.maxRms.toFixed(4) + ')');

const patch = await fetch(`${NODE}/x-nmos/connection/v1.2/single/receivers/${rlist[0].replace(/\/$/, '')}/staged`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sender_id: sender.id, master_enable: true, activation: { mode: 'activate_immediate' } }),
});
check(patch.ok, 'IS-05-PATCH Receiver 1 ← Intercom Mix 1 (' + patch.status + ')');
await sleep(2000);
st = await (await fetch(NODE + '/status')).json();
check(st.mxl.inputs[0].flow === flow, 'Programm-Eingang 1 hängt am Flow');
h = await burst(1500);
check(h.heardAt !== null && h.maxRms > 0.05, 'Q hört P über MXL-Schleife und Programm-Eingang (Pegel ' + h.maxRms.toFixed(3) + ')');
st = await (await fetch(NODE + '/status')).json();
check(st.mxl.inputs[0].flowing, 'Eingang meldet fließende Daten');

// trennen
await fetch(`${NODE}/x-nmos/connection/v1.2/single/receivers/${rlist[0].replace(/\/$/, '')}/staged`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ master_enable: false, activation: { mode: 'activate_immediate' } }) });
await sleep(1500);
h = await burst();
check(h.heardAt === null, 'nach dem Trennen wieder Stille (Pegel ' + h.maxRms.toFixed(4) + ')');
for (const t of [P, Q]) await t.close();
console.log(failed ? failed + ' FEHLER' : 'ALLES OK'); process.exit(failed ? 1 : 0);
