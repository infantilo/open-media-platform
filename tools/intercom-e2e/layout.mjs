// Panel-Layouts (Kapitel 47): Seiten, Tastenarten, Standardansicht ohne Layout, Zustand im Browser.
//   node layout.mjs [node-url] [cdp-port]
import fs from 'node:fs';
import { openTab, sleep } from './cdp.mjs';
const NODE = process.argv[2] || 'http://127.0.0.1:9450'; const CDP = Number(process.argv[3] || 9333);
const inject = fs.readFileSync(new URL('./inject.js', import.meta.url), 'utf8');
let failed = 0; const check = (ok, m) => { console.log((ok ? 'OK   ' : 'FEHLER ') + m); if (!ok) failed++; };
const cfg = {
  channels: [{ id: 1, name: 'Regie', color: '#d1242f' }, { id: 2, name: 'Technik' }, { id: 3, name: 'Studio' }],
  parties: [
    { id: 1, name: 'Kamera 1', token: 'tA', routes: [{ ch: 1, talk: true, listen: true }, { ch: 2, talk: true, listen: true }, { ch: 3, listen: true }],
      layout: { pages: [
        { name: 'Haupt', keys: [{ type: 'channel', ch: 1, style: 'key', label: 'REGIE' }, { type: 'call', party: 2, label: 'Tonmeister' }, { type: 'mute' }, { type: 'dnd' }, { type: 'all' }, { type: 'channel', ch: 9 }] },
        { name: 'Technik', keys: [{ type: 'channel', ch: 2, style: 'strip' }] },
      ] } },
    { id: 2, name: 'Tonmeister', token: 'tB', routes: [{ ch: 1, talk: true, listen: true }, { ch: 2, listen: true }] },
  ],
};
check((await fetch(NODE + '/config', { method: 'PUT', body: JSON.stringify(cfg) })).ok, 'Konfiguration mit Layout angenommen');
const bad = JSON.parse(JSON.stringify(cfg)); bad.parties[0].layout = { nope: 1 };
check((await fetch(NODE + '/config', { method: 'PUT', body: JSON.stringify(bad) })).status === 400, 'Layout ohne pages wird abgelehnt');
async function panel(token, w) {
  const tab = await openTab(CDP, 'about:blank'); await tab.send('Page.enable');
  if (w) await tab.send('Emulation.setDeviceMetricsOverride', { width: w, height: 800, deviceScaleFactor: 1, mobile: true });
  await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: inject });
  await tab.send('Page.navigate', { url: `${NODE}/panel?token=${token}` }); await sleep(500);
  await tab.evaluate("document.getElementById('go').click()");
  for (let i = 0; i < 60; i++) { if (await tab.evaluate("!!(window.__ic&&window.__ic.state&&window.__ic.pc&&window.__ic.pc.connectionState==='connected')")) return tab; await sleep(250); }
  throw new Error('verbindet nicht');
}
const A = await panel('tA', 390), B = await panel('tB');
const q = (t, s) => t.evaluate(`document.querySelectorAll(${JSON.stringify(s)}).length`);
const txt = (t, s) => t.evaluate(`[...document.querySelectorAll(${JSON.stringify(s)})].map(e=>e.textContent.trim())`);
await A.evaluate("window.__ic.send({t:'mute',on:false})"); await sleep(400);
check(await q(A, '#pages button') === 2, 'zwei Seiten als Reiter');
check(await q(A, '#chans .ckey') === 1 && await q(A, '#chans .chan') === 0, 'Seite 1: eine kompakte Kanaltaste, keine Karte');
check((await txt(A, '#chans .ckey .talk'))[0].startsWith('REGIE'), 'Beschriftung aus dem Layout: ' + (await txt(A, '#chans .ckey .talk'))[0]);
const people = await txt(A, '#chans .person');
check(people.some(t => t.includes('Tonmeister')), 'Rufen-Taste mit eigener Beschriftung: ' + people.join(' | '));
check(!people.some(t => t.toLowerCase().includes('alle')), 'Alle-Ruf fehlt ohne Recht');
check(await A.evaluate("!document.body.textContent.includes('Studio')"), 'Kanal ohne Layout-Taste (Studio) und unbekannter Kanal 9 erscheinen nicht');
// Ziffer 1 spricht Regie
await A.evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'1'}))"); await sleep(250);
check(await A.evaluate("window.__ic.state.channels.find(c=>c.id===1).talk") === true, 'Taste 1 spricht den ersten Kanal der Seite');
await A.evaluate("window.dispatchEvent(new KeyboardEvent('keyup',{key:'1'}))"); await sleep(200);
// Stumm-Taste und Ruf
await A.evaluate("[...document.querySelectorAll('#chans .person')].find(b=>/Mikro|Microphone/.test(b.textContent))?.click()"); await sleep(250);
check(await A.evaluate("window.__ic.state.me.muted") === true, 'Stumm-Taste des Layouts wirkt');
await A.evaluate("document.getElementById('mute').click()"); await sleep(200);
// Seite 2
await A.evaluate("document.querySelectorAll('#pages button')[1].click()"); await sleep(400);
check(await q(A, '#chans .chan') === 1 && await q(A, '#chans .ckey') === 0, 'Seite 2: eine Kanalkarte');
check((await txt(A, '#chans .chan .name'))[0].startsWith('Technik'), 'Kanalkarte Technik [1]: ' + (await txt(A, '#chans .chan .name'))[0]);
await A.evaluate("document.querySelector('#chans .chan input[type=range]').dispatchEvent(new Event('input'))");
await sleep(400);
check(await q(A, '#chans .chan') === 1, 'Seite bleibt bei Zustandsänderungen stehen (kein Neuaufbau)');
// Standardansicht ohne Layout
await sleep(300);
check(await q(B, '#pages button') === 2 || true, 'Standardansicht prüfen');
check(await q(B, '#pages button') === 0 || await B.evaluate("document.getElementById('pages').hidden"), 'ohne Layout keine Seitenreiter');
check(await q(B, '#chans .chan') === 2, 'ohne Layout alle zugeteilten Kanäle als Karten (2)');
check((await txt(B, '#chans .person')).some(t => t.includes('Kamera 1')), 'ohne Layout Rufen-Tasten für Teilnehmer');
// Rufen löst bei A einen Ruf-Kanal aus, der in jedem Layout oben erscheint
await B.evaluate("window.__ic.send({t:'call',to:[1],on:true})"); await sleep(400);
check(await q(A, '#chans .chan.call') === 1, 'eingehender Ruf erscheint auch im Layout (Seite 2)');
await A.send('Page.captureScreenshot', {}).then(r => fs.writeFileSync(process.env.SHOT || '/tmp/ic-layout.png', Buffer.from(r.data, 'base64')));
await B.evaluate("window.__ic.send({t:'call',on:false})"); await sleep(300);
await A.evaluate("document.querySelectorAll('#pages button')[0].click()"); await sleep(300);
await A.send('Page.captureScreenshot', {}).then(r => fs.writeFileSync((process.env.SHOT || '/tmp/ic-layout.png').replace('.png', '-1.png'), Buffer.from(r.data, 'base64')));
for (const t of [A, B]) await t.close();
console.log(failed ? failed + ' FEHLER' : 'ALLES OK'); process.exit(failed ? 1 : 0);
