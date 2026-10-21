// Intercom-E2E (Kapitel 47.1/47.3): drei Browser-Panels gegen einen laufenden omp-intercom.
//   node e2e.mjs [node-url] [cdp-port]
// Prüft: Mix-minus (Sprecher hört sich nicht), Kanalzuordnung (C hört Kanal 1 nicht), Zustand per Datenkanal,
// Stumm/Zwangs-Stumm, Ruf; misst Mund-zu-Ohr-Latenz (inkl. ca. 10–20 ms Browser-WebAudio an beiden Enden).
import fs from 'node:fs';
import { openTab, sleep } from './cdp.mjs';

const NODE = process.argv[2] || 'http://127.0.0.1:9450';
const CDP = Number(process.argv[3] || 9333);
const inject = fs.readFileSync(new URL('./inject.js', import.meta.url), 'utf8');

const config = {
  channels: [{ id: 1, name: 'Regie' }, { id: 2, name: 'Technik' }],
  parties: [
    { id: 1, name: 'Regie 1', token: 'tA', force: true, routes: [{ ch: 1, talk: true, listen: true }, { ch: 2, talk: true, listen: true }] },
    { id: 2, name: 'Kamera 1', token: 'tB', routes: [{ ch: 1, talk: true, listen: true }] },
    { id: 3, name: 'Technik 1', token: 'tC', routes: [{ ch: 2, talk: true, listen: true }] },
  ],
};
let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'OK   ' : 'FEHLER ') + msg); if (!ok) failed++; };

const put = await fetch(NODE + '/config', { method: 'PUT', body: JSON.stringify(config) });
check(put.ok, 'Konfiguration eingespielt (' + put.status + ')');
const noTok = await fetch(NODE + '/panel');
check(noTok.status === 401, 'Panel ohne Token wird abgelehnt (' + noTok.status + ')');
const badOffer = await fetch(NODE + '/offer?token=nope', { method: 'POST', body: 'x' });
check(badOffer.status === 401, 'Angebot mit falschem Token wird abgelehnt (' + badOffer.status + ')');

async function panel(token) {
  const tab = await openTab(CDP, 'about:blank');
  await tab.send('Page.enable');
  await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: inject });
  await tab.send('Page.navigate', { url: `${NODE}/panel?token=${token}` });
  await sleep(600);
  await tab.evaluate("document.getElementById('go').click()");
  for (let i = 0; i < 60; i++) {
    const ok = await tab.evaluate("!!(window.__ic && window.__ic.state && window.__ic.pc && window.__ic.pc.connectionState === 'connected')");
    if (ok) return tab;
    await sleep(250);
  }
  throw new Error('Panel ' + token + ' verbindet nicht: ' + await tab.evaluate("document.getElementById('err').textContent"));
}
let A = await panel('tA'), B = await panel('tB'), C = await panel('tC');
check(true, 'drei Panels verbunden');

const st = await A.evaluate('JSON.stringify(window.__ic.state)').then(JSON.parse);
check(st.me.name === 'Regie 1' && st.channels.length === 2, 'Zustand über Datenkanal: ' + st.channels.map(c => c.name).join(','));
check(st.parties.filter(p => p.online).length === 3, 'alle drei online');

const heard = async tab => tab.evaluate('window.__heard()');
async function burst(speaker, listeners, ch, ms = 700) {
  for (const t of [speaker, ...listeners]) await t.evaluate('window.__arm()');
  await speaker.evaluate(`window.__ic.send({t:'talk',ch:${ch},on:true})`);
  await sleep(80);
  const t0 = await speaker.evaluate('window.__tone(true)');
  await sleep(ms);
  await speaker.evaluate('window.__tone(false)');
  await speaker.evaluate(`window.__ic.send({t:'talk',ch:${ch},on:false})`);
  await sleep(150);
  const res = [];
  for (const t of [speaker, ...listeners]) res.push(await heard(t));
  return { t0, res };
}

// Mix-minus + Kanalzuordnung
let r = await burst(A, [B, C], 1);
check(r.res[1].heardAt !== null, 'B hört A auf Kanal 1 (Pegel ' + r.res[1].maxRms.toFixed(3) + ')');
check(r.res[0].heardAt === null, 'A hört sich nicht selbst (Pegel ' + r.res[0].maxRms.toFixed(4) + ')');
check(r.res[2].heardAt === null, 'C hört Kanal 1 nicht (Pegel ' + r.res[2].maxRms.toFixed(4) + ')');

// Stumm
await A.evaluate("window.__ic.send({t:'mute',on:true})"); await sleep(200);
r = await burst(A, [B], 1);
check(r.res[1].heardAt === null, 'stummer Sprecher wird nicht gehört');
await A.evaluate("window.__ic.send({t:'mute',on:false})"); await sleep(200);

// Zwangs-Stumm (A hat force-Recht) auf B
await A.evaluate("window.__ic.send({t:'force',party:2,on:true})"); await sleep(250);
const stB = JSON.parse(await B.evaluate('JSON.stringify(window.__ic.state)'));
check(stB.me.forced === true, 'B sieht Zwangs-Stumm im Zustand');
r = await burst(B, [A], 1);
check(r.res[1].heardAt === null, 'zwangs-stummer Teilnehmer wird nicht gehört');
await A.evaluate("window.__ic.send({t:'force',party:2,on:false})"); await sleep(250);

// Ruf A → C (C hört A sonst nicht, da Kanal 2 hat C, A auch: nutze B→C, die keinen gemeinsamen Kanal haben)
await B.evaluate("window.__arm()"); await C.evaluate("window.__arm()");
await B.evaluate("window.__ic.send({t:'call',to:[3],on:true})"); await sleep(120);
await B.evaluate('window.__tone(true)'); await sleep(600); await B.evaluate('window.__tone(false)');
await B.evaluate("window.__ic.send({t:'call',on:false})"); await sleep(150);
const hc = await heard(C);
check(hc.heardAt !== null, 'Direktruf B → C ohne gemeinsamen Kanal (Pegel ' + hc.maxRms.toFixed(3) + ')');
const stC = JSON.parse(await C.evaluate('JSON.stringify(window.__ic.state)'));
check(!stC.channels.some(c => c.kind === 'call'), 'Rufkanal nach Ende wieder weg');

// Tab schließen mit gehaltener Sprechtaste: Teilnehmer sofort offline, neue Sitzung ohne hängende Taste.
await B.evaluate("window.__ic.send({t:'talk',ch:1,on:true})"); await sleep(200);
await B.close(); await sleep(9500); // Herzschlag-Ablauf 8 s
const sb = (await (await fetch(NODE + '/status')).json()).parties.find(p => p.id === 2);
check(!sb.online, 'geschlossener Tab: Teilnehmer nach Herzschlag-Ablauf offline (Zustand ' + sb.state + ')');
B = await panel('tB');
const stB2 = JSON.parse(await B.evaluate('JSON.stringify(window.__ic.state)'));
check(stB2.channels.every(c => !c.talk), 'neue Sitzung startet ohne hängende Sprechtaste');

// Referenz: Browser-eigene Loopback-Strecke ohne Node (Anteil von WebAudio, Chromium-WebRTC und Messverfahren).
const refList = (await C.evaluate('window.__loopbackRef(10)')).sort((a, b) => a - b);
const refMed = refList[Math.floor(refList.length / 2)];
console.log('Referenz Browser-Loopback ohne Node (ms): ' + refList.map(v => v.toFixed(0)).join(' '));
// Latenz: Sprechtaste bleibt offen, vor jedem Burst Stille abwarten, damit nichts Altes erkannt wird.
const lat = [];
await A.evaluate("window.__ic.send({t:'talk',ch:1,on:true})"); await A.evaluate('window.__tone(true)'); await sleep(6000); // Browser-Jitterpuffer einschwingen lassen
for (let i = 0; i < 15; i++) {
  await A.evaluate('window.__tone(false)'); await sleep(450);
  await B.evaluate('window.__arm()');
  const t0 = await A.evaluate('window.__tone(true)');
  await sleep(350);
  const h = await heard(B);
  if (h.heardAt && h.heardAt > t0) lat.push(h.heardAt - t0);
}
await A.evaluate('window.__tone(false)');
await A.evaluate("window.__ic.send({t:'talk',ch:1,on:false})");
lat.sort((a, b) => a - b);
const med = lat[Math.floor(lat.length / 2)], max = lat[lat.length - 1];
console.log('Latenz Mund→Ohr (ms, inkl. Browser-WebAudio): ' + lat.map(v => v.toFixed(0)).join(' '));
const added = med - refMed;
// Unter Last (mehrere Chromium-Tabs auf einem Arbeitsrechner) schwankt der Wert stark (gemessen 16–140 ms). Harte Grenze nur gegen Ausreißer;
// die belastbare Zahl liefert eine Messung auf echter Hardware (docs/decisions.md 2026-10-21).
check(lat.length >= 10 && added < 200, `Median ${med?.toFixed(0)} ms, Max ${max?.toFixed(0)} ms; abzüglich Referenz ${refMed.toFixed(0)} ms: Node-Strecke ca. ${added.toFixed(0)} ms (Warnschwelle 200 ms, Ziel < 120 ms)`);

const jb = await B.evaluate(`(async()=>{const r=await window.__ic.pc.getStats();let o={};r.forEach(x=>{if(x.type==='inbound-rtp'&&x.kind==='audio')o.jitterBufferMs=1000*x.jitterBufferDelay/Math.max(1,x.jitterBufferEmittedCount);if(x.type==='candidate-pair'&&x.nominated)o.rttMs=1000*x.currentRoundTripTime});return o})()`);
console.log('Browser (Hörer): mittlerer Jitter-Puffer ' + jb.jitterBufferMs?.toFixed(1) + ' ms, RTT ' + jb.rttMs + ' ms');
const status = await (await fetch(NODE + '/status')).json();
console.log('Node: Eingangspuffer (ms) ' + status.parties.map(p => p.name + '=' + p.ring_ms.toFixed(1)).join(' '));
console.log('Takt: ' + status.ticks + ' Ticks, ' + status.late_ticks + ' verspätet, max ' + status.max_tick_us + ' µs');
check(status.late_ticks < 5, 'Takt stabil');
for (const t of [A, B, C]) await t.close();
console.log(failed ? `${failed} FEHLER` : 'ALLES OK');
process.exit(failed ? 1 : 0);
