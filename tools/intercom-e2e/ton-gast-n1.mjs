// Ton-Gast mit echtem Tonmischer-N-1-Bus (RC3-Hörmessung): zwei Ton-Gäste sprechen über den Intercom-Node in einen
// `omp-audio-mixer` (Kanal ch1/ch2 ← Mikrofon-Sender per setSource), je Gast ein N-1-Bus (Aux a1 schließt ch1 aus, a2 ch2),
// dessen MXL-Ausgang per IS-05 auf den Rückweg-Eingang des Gasts geht.
// Erwartung: Gast 1 spricht → Gast 2 hört den Ton (Pegel > 0,05), Gast 1 hört sich selbst NICHT (≈ 0); umgekehrt ebenso.
//   Vorbereitung (einmal): Mixer mit zwei Kanälen (addChannel ×2) und zwei Aux-Bussen (addAux ×2, setN1 exclude ch1/ch2).
//   OMP_NODE_API_TOKEN=<Token> node ton-gast-n1.mjs <gateway-url> <bearer-token> <mixer-node-uuid> [cdp-port]
import fs from 'node:fs';
import { openTab, sleep } from './cdp.mjs';

const GW = process.argv[2] || 'http://127.0.0.1:8000';
const TOK = process.argv[3];
const MIX = process.argv[4];
const CDP = Number(process.argv[5] || 9333);
const REG = process.env.OMP_REGISTRY_URL || 'http://127.0.0.1:8010';
const NT = process.env.OMP_NODE_API_TOKEN ? { 'x-omp-node-token': process.env.OMP_NODE_API_TOKEN } : {};
const inject = fs.readFileSync(new URL('./inject.js', import.meta.url), 'utf8');
let failed = 0; const check = (ok, m) => { console.log((ok ? 'OK   ' : 'FEHLER ') + m); if (!ok) failed++; };
const api = (p, o = {}) => fetch(GW + '/api/v1/ext/intercom' + p, { ...o, headers: { authorization: 'Bearer ' + TOK, 'content-type': 'application/json' } });
const mixer = (m, body) => fetch(`${GW}/api/v1/nodes/${MIX}/methods/${m}`, { method: 'POST', headers: { authorization: 'Bearer ' + TOK, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const senders = async () => (await fetch(REG + '/x-nmos/query/v1.3/senders')).json();

const guests = [];
const tabs = [];
try {
  for (const n of [1, 2]) {
    const res = await api('/guests', { method: 'POST', body: JSON.stringify({ name: 'N1-Gast ' + n, ttl_minutes: 20, audio: true }) });
    const g = await res.json();
    check(res.status === 201 && g.audio, `Ton-Gast ${n} angelegt: ` + JSON.stringify(g.audio));
    guests.push(g);
  }
  const node = new URL(guests[0].url).origin;
  const st = await (await fetch(node + '/status', { headers: NT })).json();
  await sleep(1500);
  const all = await senders();
  const rl = await (await fetch(node + '/x-nmos/connection/v1.2/single/receivers/', { headers: NT })).json();
  for (const [i, g] of guests.entries()) {
    const flow = st.mxl.outputs[g.audio.mic_out - 1].flow;
    const mic = all.find((s) => s.flow_id === flow);
    check(!!mic, `Gast ${i + 1}: Mikrofon-Sender gefunden`);
    const r = await mixer(`channel.ch${i + 1}.setSource`, { senderId: mic.id });
    check(r.ok, `Mixer ch${i + 1} ← Mikrofon Gast ${i + 1} (${r.status})`);
    const aux = all.find((s) => new RegExp(`Aux a${i + 1}$`).test(s.label));
    check(!!aux, `N-1-Bus a${i + 1}: Sender gefunden`);
    const rcv = rl[g.audio.ret_in - 1].replace(/\/$/, '');
    const p = await fetch(`${node}/x-nmos/connection/v1.2/single/receivers/${rcv}/staged`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...NT },
      body: JSON.stringify({ sender_id: aux.id, master_enable: true, activation: { mode: 'activate_immediate' } }) });
    check(p.ok, `IS-05: Rückweg Gast ${i + 1} ← N-1-Bus a${i + 1} (${p.status})`);
  }
  await sleep(2500);

  for (const g of guests) {
    const tab = await openTab(CDP, 'about:blank');
    await tab.send('Page.enable');
    await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: inject });
    await tab.send('Page.navigate', { url: `${new URL(g.url).origin}/panel?token=${new URL(g.url).searchParams.get('token')}` });
    await sleep(600);
    await tab.evaluate("document.getElementById('go').click()");
    for (let i = 0; i < 60 && !(await tab.evaluate("!!(window.__ic && window.__ic.pc && window.__ic.pc.connectionState === 'connected')")); i++) await sleep(250);
    tabs.push(tab);
  }
  const burst = async (who, ms) => {
    for (const t of tabs) await t.evaluate('window.__arm()');
    const g = guests[who];
    await tabs[who].evaluate(`window.__ic.send({t:'talk',ch:${g.audio.mic_channel},on:true})`); await sleep(100);
    await tabs[who].evaluate('window.__tone(true)'); await sleep(ms);
    await tabs[who].evaluate('window.__tone(false)'); await tabs[who].evaluate(`window.__ic.send({t:'talk',ch:${g.audio.mic_channel},on:false})`); await sleep(300);
    return Promise.all(tabs.map((t) => t.evaluate('window.__heard()')));
  };
  for (const who of [0, 1]) {
    const other = 1 - who;
    const h = await burst(who, 2000);
    console.log(`  Gast ${who + 1} spricht: Gast 1 hört ${h[0].maxRms.toFixed(4)}, Gast 2 hört ${h[1].maxRms.toFixed(4)}`);
    check(h[other].maxRms > 0.05, `Gast ${other + 1} hört Gast ${who + 1} über seinen N-1-Bus (Pegel ${h[other].maxRms.toFixed(3)})`);
    check(h[who].maxRms < 0.005, `Gast ${who + 1} hört sich selbst nicht (N-1, Pegel ${h[who].maxRms.toFixed(4)})`);
  }
} finally {
  for (const t of tabs) await t.close().catch(() => {});
  for (const g of guests) { const d = await api('/guests/' + g.id, { method: 'DELETE' }); check(d.ok, 'Gast widerrufen'); }
}
console.log(failed ? failed + ' FEHLER' : 'ALLES OK'); process.exit(failed ? 1 : 0);
