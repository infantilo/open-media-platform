// Klicktest des Segue-Editors (RB7.3) gegen einen laufenden omp-radio-automation (eigene Instanz, kein Orchestrator-Panel nötig):
// lädt das gebaute Element in eine Seite des Nodes, öffnet zwei Demo-Titel, zieht mit echter Maus Marken und prüft die Zahlen.
//   OMP_NODE_API_TOKEN=<Token> node editor.mjs <node-url> <demo-log.json> [cdp-port]
import fs from 'node:fs';
import { openTab, sleep } from '../intercom-e2e/cdp.mjs';

const NODE = process.argv[2];
const LOG = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const CDP = Number(process.argv[4] || 9334);
const NT = process.env.OMP_NODE_API_TOKEN;
const bundle = fs.readFileSync(new URL('../../nodes/omp-radio-automation/ui/segue-editor.js', import.meta.url), 'utf8');
let failed = 0; const check = (ok, m) => { console.log((ok ? 'OK   ' : 'FEHLER ') + m); if (!ok) failed++; };

const tab = await openTab(CDP, 'about:blank');
await tab.send('Page.enable');
await tab.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
await tab.send('Page.navigate', { url: NODE + '/x-nmos' });
await sleep(800);
await tab.evaluate(`(() => { const s = document.createElement('script'); s.type = 'module'; s.textContent = ${JSON.stringify(bundle)}; document.head.append(s); })()`);
await sleep(500);
const items = LOG.items.filter((i) => i.id === 'nachtfahrt' || i.id === 'strandgut');
items[1].transition = undefined; delete items[1].transition;
await tab.evaluate(`(() => {
  const ed = document.createElement('omp-segue-editor');
  ed.base = '';
  ed.fetcher = (u, i = {}) => fetch(u, { ...i, headers: { ...(i.headers || {}), 'x-omp-node-token': ${JSON.stringify(NT)} } });
  ed.style.cssText = 'width:1060px;margin:10px';
  document.body.style.background = '#0b0d10';
  document.body.append(ed);
  window.__ed = ed; window.__saved = null;
  ed.addEventListener('save', (e) => { window.__saved = e.detail; });
  ed.load(${JSON.stringify(items[0])}, ${JSON.stringify(items[1])});
})()`);
await sleep(3500);
const shot = async (name) => { const r = await tab.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(name, Buffer.from(r.data, 'base64')); };
await shot(process.env.SHOT_DIR + '/segue-1.png');
const pt = await tab.evaluate(`JSON.stringify(window.__ed.markerPoint('bStart'))`);
const start = JSON.parse(pt);
check(!!start, 'Marke „Einsatz B“ sichtbar: ' + pt);
const rect = JSON.parse(await tab.evaluate(`JSON.stringify(window.__ed.shadowRoot.querySelector('canvas').getBoundingClientRect())`));
const px = rect.left + start.x, py = rect.top + start.y;
// Einsatz B 40 Pixel nach links ziehen (früher einsetzen)
await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 });
for (let i = 1; i <= 8; i++) { await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px - i * 5, y: py, button: 'left' }); await sleep(30); }
await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px - 40, y: py, button: 'left', clickCount: 1 });
await sleep(600);
let v = JSON.parse(await tab.evaluate(`JSON.stringify(window.__ed.value)`));
const shift = v.b.transition?.startShiftMs;
check(typeof shift === 'number' && shift < -200, 'Ziehen setzt die Verschiebung des Einsatzes: ' + shift + ' ms');
const after = JSON.parse(await tab.evaluate(`JSON.stringify(window.__ed.markerPoint('bStart'))`));
check(after && after.x < start.x - 20, 'Marke folgt der Maus nach neuer Planung (x ' + Math.round(start.x) + ' → ' + Math.round(after.x) + ')');
const inField = await tab.evaluate(`window.__ed.shadowRoot.querySelector('.grid label:nth-child(2) input').value`);
check(Number(inField) === shift, 'Zahlenfeld zeigt denselben Wert: ' + inField);
await shot(process.env.SHOT_DIR + '/segue-2.png');
// Speichern
await tab.evaluate(`window.__ed.shadowRoot.getElementById('save').click()`);
await sleep(200);
const saved = JSON.parse(await tab.evaluate(`JSON.stringify(window.__saved)`));
check(saved && saved.changedB === true && saved.b.transition.startShiftMs === shift && saved.changedA === false, 'Speichern liefert beide Elemente mit Übergang');
check(saved.b.file === items[1].file && saved.a.file === items[0].file, 'Dateien unverändert');

// ---- Vorhören (RB7.4): dieselbe Planung als Offline-Mischung gerechnet, Zeiten und Pegel gegen den Plan ----
const items2 = JSON.parse(JSON.stringify(items));
items2[1].transition = { fadeOutMs: 2000, fadeInMs: 0, curveOut: 'linear', curveIn: 'linear', startShiftMs: 0 };
await tab.evaluate(`window.__ed.load(${JSON.stringify(items2[0])}, ${JSON.stringify(items2[1])})`);
await sleep(2500);
const planRes = await (await fetch(NODE + '/segue/plan', { method: 'POST', headers: { 'content-type': 'application/json', 'x-omp-node-token': NT }, body: JSON.stringify({ items: [{ ...items2[0], id: 'a' }, { ...items2[1], id: 'b' }] }) })).json();
const [pa, pb] = planRes.placed;
const segue = pa.startMs + (pa.stopAtMs - pa.offsetMs);
const stats = JSON.parse(await tab.evaluate(`(async () => {
  const A = await window.__ed.renderPreview('a');
  const B = await window.__ed.renderPreview('b');
  const rms = (x, t0, a, b) => { const i0 = Math.max(0, Math.round((a - t0) / 1000 * 48000)), i1 = Math.min(x.length, Math.round((b - t0) / 1000 * 48000)); let s = 0; for (let i = i0; i < i1; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, i1 - i0)); };
  const max = (x, t0, a, b) => { const i0 = Math.max(0, Math.round((a - t0) / 1000 * 48000)), i1 = Math.min(x.length, Math.round((b - t0) / 1000 * 48000)); let m = 0; for (let i = i0; i < i1; i++) m = Math.max(m, Math.abs(x[i])); return m; };
  const onset = (x, t0, from) => { for (let i = Math.round((from - t0) / 1000 * 48000); i < x.length; i++) if (Math.abs(x[i]) > 0.01) return t0 + i / 48 ; return null; };
  const seg = ${segue};
  return JSON.stringify({
    t0: A.t0,
    aBefore: rms(A.left, A.t0, seg - 1500, seg - 100),
    aMid: rms(A.left, A.t0, seg + 900, seg + 1100),
    aEnd: rms(A.left, A.t0, seg + 1850, seg + 1990),
    aAfter: max(A.left, A.t0, seg + 2100, seg + 4000),
    bBefore: max(B.left, B.t0, B.t0, ${pb.startMs} - 5),
    bOnset: onset(B.left, B.t0, ${pb.startMs} - 5),
  });
})()`));
console.log(JSON.stringify(stats));
check(stats.aBefore > 0.03, 'A vor dem Segue-Punkt hörbar (RMS ' + stats.aBefore.toFixed(3) + ')');
check(stats.aMid / stats.aBefore > 0.25 && stats.aMid / stats.aBefore < 0.75, 'A in der Mitte der linearen Blende ≈ halb (Verhältnis ' + (stats.aMid / stats.aBefore).toFixed(2) + ')');
check(stats.aEnd / stats.aBefore < 0.2, 'A am Ende der Blende fast still (Verhältnis ' + (stats.aEnd / stats.aBefore).toFixed(2) + ')');
check(stats.aAfter < 1e-4, 'A nach der Blende still (' + stats.aAfter + ')');
check(stats.bBefore < 1e-4, 'B vor seinem Einsatz still (' + stats.bBefore + ')');
check(stats.bOnset !== null && Math.abs(stats.bOnset - pb.startMs) <= 1, 'Einsatz von B gegen Plan ' + pb.startMs + ' ms: ' + (stats.bOnset && stats.bOnset.toFixed(2)) + ' ms (Abweichung ' + (stats.bOnset - pb.startMs).toFixed(2) + ')');
// ---- Sendequalität (RB7.5): Node-Mischung mit dem Mischer des Segue-Players gegen die Browser-Vorschau ----
const ver = JSON.parse(await tab.evaluate(`window.__ed.verifyBroadcast().then((r) => JSON.stringify(r))`));
check(ver && ver.deviationDb < -40, 'Sende-Mischer gleich Vorschau: Abweichung ' + (ver && ver.deviationDb.toFixed(1)) + ' dB, Spitze ' + (ver && ver.peak.toFixed(4)));
await tab.evaluate(`[...window.__ed.shadowRoot.querySelectorAll('button')].find(b => b.textContent === '■').click()`);
// echtes Abspielen (AudioContext): Schaltfläche löst es aus, Wiedergabekopf läuft, Stopp beendet es
await tab.evaluate(`[...window.__ed.shadowRoot.querySelectorAll('button')].find(b => b.textContent.includes('▶ ')).click()`);
await sleep(2500);
await shot(process.env.SHOT_DIR + '/segue-3.png');
const ctxState = await tab.evaluate(`window.__ed.shadowRoot.querySelector('.status').textContent`);
check(!/nicht möglich|unavailable/i.test(ctxState), 'Abspielen ohne Fehlermeldung (' + JSON.stringify(ctxState) + ')');
await tab.evaluate(`[...window.__ed.shadowRoot.querySelectorAll('button')].find(b => b.textContent === '■').click()`);
await tab.close();
console.log(failed ? failed + ' FEHLER' : 'ALLES OK'); process.exit(failed ? 1 : 0);
