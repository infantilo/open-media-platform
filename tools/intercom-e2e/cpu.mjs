// Kurzer CPU-Messlauf des Nodes: N Panels, einer spricht, ca. 10 s. Misst nur den Node-Prozess (/proc), nicht Chromium.
//   node cpu.mjs <node-pid> [panels=4] [node-url] [cdp-port]
import fs from 'node:fs';
import { openTab, sleep } from './cdp.mjs';
const PID = process.argv[2]; const N = Number(process.argv[3] || 4);
const NODE = process.argv[4] || 'http://127.0.0.1:9450'; const CDP = Number(process.argv[5] || 9333);
const inject = fs.readFileSync(new URL('./inject.js', import.meta.url), 'utf8');
const parties = Array.from({ length: N }, (_, i) => ({ id: i + 1, name: 'P' + (i + 1), token: 't' + (i + 1), routes: [{ ch: 1, talk: true, listen: true }] }));
await fetch(NODE + '/config', { method: 'PUT', body: JSON.stringify({ channels: [{ id: 1, name: 'K' }], parties }) });
const cpu = () => { const f = fs.readFileSync(`/proc/${PID}/stat`, 'utf8').split(') ')[1].split(' '); return (Number(f[11]) + Number(f[12])) / 100; };
const tabs = [];
for (const p of parties) {
  const tab = await openTab(CDP, 'about:blank'); await tab.send('Page.enable');
  await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: inject });
  await tab.send('Page.navigate', { url: `${NODE}/panel?token=${p.token}` }); await sleep(500);
  await tab.evaluate("document.getElementById('go').click()");
  for (let i = 0; i < 60; i++) { if (await tab.evaluate("!!(window.__ic&&window.__ic.pc&&window.__ic.pc.connectionState==='connected')")) break; await sleep(250); }
  tabs.push(tab);
}
await tabs[0].evaluate("window.__ic.send({t:'talk',ch:1,on:true})"); await tabs[0].evaluate('window.__tone(true)');
await sleep(3000);
const t0 = Date.now(), c0 = cpu(); await sleep(10000); const c1 = cpu(), t1 = Date.now();
const st = await (await fetch(NODE + '/status')).json();
console.log(`${N} Panels, einer spricht: Node-CPU ${(100 * (c1 - c0) / ((t1 - t0) / 1000)).toFixed(1)} % eines Kerns; max. Durchlauf ${st.max_tick_us} µs, verspätet ${st.late_ticks}`);
for (const t of tabs) await t.close();
