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
const inField = await tab.evaluate(`window.__ed.shadowRoot.querySelectorAll('input')[1].value`);
check(Number(inField) === shift, 'Zahlenfeld zeigt denselben Wert: ' + inField);
await shot(process.env.SHOT_DIR + '/segue-2.png');
// Speichern
await tab.evaluate(`window.__ed.shadowRoot.querySelector('button.primary').click()`);
await sleep(200);
const saved = JSON.parse(await tab.evaluate(`JSON.stringify(window.__saved)`));
check(saved && saved.changedB === true && saved.b.transition.startShiftMs === shift && saved.changedA === false, 'Speichern liefert beide Elemente mit Übergang');
check(saved.b.file === items[1].file && saved.a.file === items[0].file, 'Dateien unverändert');
await tab.close();
console.log(failed ? failed + ' FEHLER' : 'ALLES OK'); process.exit(failed ? 1 : 0);
