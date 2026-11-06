// Ton-Gast (RC3): Gast spricht → Mikrofonkanal → Anbindung (Mix-Ausgang = MXL-Flow) → IS-05 auf den Programmeingang
// des Rückwegs → Gast hört den Ton über den Rückweg. Beweist beide Strecken des Ton-Gasts (Mikro raus, Rückweg rein);
// die Schleife ersetzt hier den Mischer (im Betrieb liefert dessen N-1-Bus den Rückweg und schließt den Gast aus).
//   OMP_NODE_API_TOKEN=<Token der Intercom-Instanz> node ton-gast.mjs <gateway-url> <bearer-token> [cdp-port]
import fs from 'node:fs';
import { openTab, sleep } from './cdp.mjs';

const GW = process.argv[2] || 'http://127.0.0.1:8000';
const TOK = process.argv[3];
const CDP = Number(process.argv[4] || 9333);
const REG = process.env.OMP_REGISTRY_URL || 'http://127.0.0.1:8010';
const NT = process.env.OMP_NODE_API_TOKEN ? { 'x-omp-node-token': process.env.OMP_NODE_API_TOKEN } : {};
const inject = fs.readFileSync(new URL('./inject.js', import.meta.url), 'utf8');
let failed = 0; const check = (ok, m) => { console.log((ok ? 'OK   ' : 'FEHLER ') + m); if (!ok) failed++; };
const api = (p, o = {}) => fetch(GW + '/api/v1/ext/intercom' + p, { ...o, headers: { authorization: 'Bearer ' + TOK, 'content-type': 'application/json' } });

const res = await api('/guests', { method: 'POST', body: JSON.stringify({ name: 'E2E-Gast', ttl_minutes: 20, audio: true }) });
const g = await res.json();
check(res.status === 201 && g.audio, 'Ton-Gast angelegt: ' + JSON.stringify(g.audio));
const u = new URL(g.url); const NODE = u.origin; const token = u.searchParams.get('token');
try {
  const st = await (await fetch(NODE + '/status', { headers: NT })).json();
  const flow = st.mxl.outputs[g.audio.mic_out - 1].flow;
  await sleep(1500);
  const sender = (await (await fetch(REG + '/x-nmos/query/v1.3/senders')).json()).find(s => s.flow_id === flow);
  check(!!sender, 'Mikrofon-Sender „Intercom Mix ' + g.audio.mic_out + '“ in der Registry');
  const rl = (await (await fetch(NODE + '/x-nmos/connection/v1.2/single/receivers/', { headers: NT })).json());
  const rcv = rl[g.audio.ret_in - 1].replace(/\/$/, '');

  const tab = await openTab(CDP, 'about:blank');
  await tab.send('Page.enable');
  await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: inject });
  await tab.send('Page.navigate', { url: `${NODE}/panel?token=${token}` });
  await sleep(600);
  await tab.evaluate("document.getElementById('go').click()");
  for (let i = 0; i < 60 && !(await tab.evaluate("!!(window.__ic && window.__ic.pc && window.__ic.pc.connectionState === 'connected')")); i++) await sleep(250);
  const burst = async (ms) => {
    await tab.evaluate('window.__arm()');
    await tab.evaluate(`window.__ic.send({t:'talk',ch:${g.audio.mic_channel},on:true})`); await sleep(100);
    await tab.evaluate('window.__tone(true)'); await sleep(ms);
    await tab.evaluate('window.__tone(false)'); await tab.evaluate(`window.__ic.send({t:'talk',ch:${g.audio.mic_channel},on:false})`); await sleep(200);
    return tab.evaluate('window.__heard()');
  };
  let h = await burst(800);
  check(h.heardAt === null, 'ohne IS-05-Verbindung hört der Gast nichts (Pegel ' + h.maxRms.toFixed(4) + ')');
  const patch = await fetch(`${NODE}/x-nmos/connection/v1.2/single/receivers/${rcv}/staged`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...NT },
    body: JSON.stringify({ sender_id: sender.id, master_enable: true, activation: { mode: 'activate_immediate' } }) });
  check(patch.ok, 'IS-05: Rückweg-Eingang ← Mikrofon-Sender (' + patch.status + ')');
  await sleep(2000);
  h = await burst(1500);
  check(h.heardAt !== null && h.maxRms > 0.05, 'Mikrofon erreicht den MXL-Ausgang und kommt über den Rückweg zurück (Pegel ' + h.maxRms.toFixed(3) + ')');
  await fetch(`${NODE}/x-nmos/connection/v1.2/single/receivers/${rcv}/staged`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...NT }, body: JSON.stringify({ master_enable: false, activation: { mode: 'activate_immediate' } }) });
  await tab.close();
} finally {
  const d = await api('/guests/' + g.id, { method: 'DELETE' });
  check(d.ok, 'Gast widerrufen');
}
console.log(failed ? failed + ' FEHLER' : 'ALLES OK'); process.exit(failed ? 1 : 0);
