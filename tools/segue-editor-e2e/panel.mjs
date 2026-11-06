// Klicktest des Radio-Panels mit Segue-Editor (RB7.3/RB7.5): lädt das Panel-Bundle des Nodes in eine Seite auf dem Ursprung des Nodes
// (Aufrufe an `/api/v1/nodes/<id>/…` werden auf den Node umgeleitet, wie es der Orchestrator-Proxy täte), importiert das Demo-Log,
// prüft den Reiter „Übergänge“, öffnet den Editor per Doppelklick auf die Zeitzelle und per Knopf, übernimmt eine Änderung.
//   OMP_NODE_API_TOKEN=<Token> node panel.mjs <node-url> <demo-log.json> [cdp-port]
import fs from 'node:fs';
import { openTab, sleep } from '../intercom-e2e/cdp.mjs';

const NODE = process.argv[2];
const LOG = fs.readFileSync(process.argv[3], 'utf8');
const CDP = Number(process.argv[4] || 9334);
const NT = process.env.OMP_NODE_API_TOKEN;
const ui = (f) => fs.readFileSync(new URL('../../nodes/omp-radio-automation/ui/' + f, import.meta.url), 'utf8');
let failed = 0; const check = (ok, m) => { console.log((ok ? 'OK   ' : 'FEHLER ') + m); if (!ok) failed++; };

const tab = await openTab(CDP, 'about:blank');
await tab.send('Page.enable');
await tab.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });
await tab.send('Page.navigate', { url: NODE + '/x-nmos' });
await sleep(800);
const shot = async (n) => fs.writeFileSync(process.env.SHOT_DIR + '/' + n, Buffer.from((await tab.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
await tab.evaluate(`(() => {
  const real = window.fetch.bind(window);
  window.fetch = (u, i = {}) => {
    const m = typeof u === 'string' && u.match(/^\\/api\\/v1\\/nodes\\/N1\\/(.*)$/);
    if (m) return real('/' + m[1], { ...i, headers: { ...(i.headers || {}), 'x-omp-node-token': ${JSON.stringify(NT)} } });
    if (typeof u === 'string' && u.startsWith('/api/v1/')) return Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    return real(u, i);
  };
  for (const src of [${JSON.stringify(ui('segue-editor.js'))}, ${JSON.stringify(ui('bundle.js'))}]) { const s = document.createElement('script'); s.type = 'module'; s.textContent = src; document.head.append(s); }
  document.body.style.background = '#0b0d10';
})()`);
await sleep(600);
await tab.evaluate(`(() => { const p = document.createElement('omp-radio-automation-panel'); p.setAttribute('node-id', 'N1'); document.body.append(p); window.__p = p; })()`);
await sleep(2500);
const sr = `window.__p.shadowRoot`;
const clickText = (sel, re) => tab.evaluate(`(() => { const b = [...${sr}.querySelectorAll('${sel}')].find((e) => /${re}/i.test(e.textContent)); if (!b) return false; b.click(); return true; })()`);
check(await clickText('button', 'Playlist'), 'Reiter „Playlist“ gewählt');
check(await clickText('button', 'JSON einfügen|Paste JSON'), 'JSON-Feld geöffnet');
await tab.evaluate(`(() => { const t = ${sr}.querySelector('textarea'); t.value = ${JSON.stringify(LOG)}; })()`);
check(await clickText('button', '^(Übernehmen|Apply)$'), 'Demo-Log übernommen');
await sleep(500);
const nrows = await tab.evaluate(`${sr}.querySelectorAll('tr[draggable="true"]').length`);
check(nrows === 8, 'Playlist zeigt 8 Zeilen: ' + nrows);
// Doppelklick auf die Zeitzelle von Zeile 4 (Strandgut) → Editor
await tab.evaluate(`${sr}.querySelectorAll('tr[draggable="true"]')[3].querySelector('td.tcol').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
await sleep(3500);
await shot('panel-1.png');
const ed = await tab.evaluate(`!!${sr}.querySelector('omp-segue-editor')`);
check(ed, 'Doppelklick auf die Zeit öffnet den Segue-Editor');
const loaded = await tab.evaluate(`(() => { const e = ${sr}.querySelector('omp-segue-editor'); return e && e.value ? e.value.a.title + ' → ' + e.value.b.title + ' | shift ' + (e.value.b.transition && e.value.b.transition.startShiftMs) : null; })()`);
check(loaded === 'Nachtfahrt → Strandgut | shift -500', 'Editor zeigt Nachtfahrt → Strandgut mit dem Demo-Übergang: ' + loaded);
// Fadeout-Feld ändern und übernehmen
await tab.evaluate(`(() => { const e = ${sr}.querySelector('omp-segue-editor'); const i = e.shadowRoot.querySelector('.grid label:nth-child(3) input'); i.value = '1000'; i.dispatchEvent(new Event('change')); })()`);
await sleep(600);
await tab.evaluate(`${sr}.querySelector('omp-segue-editor').shadowRoot.getElementById('save').click()`);
await sleep(400);
check(!(await tab.evaluate(`!!${sr}.querySelector('omp-segue-editor')`)), 'Übernehmen schließt den Dialog');
// Reiter Übergänge
check(await clickText('button', 'Übergänge|Transitions'), 'Reiter „Übergänge“ gewählt');
await sleep(300);
const trows = JSON.parse(await tab.evaluate(`JSON.stringify([...${sr}.querySelectorAll('.pane:not([style*="none"]) tbody tr')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim()))`));
check(trows.length === 7, '7 Übergänge gelistet: ' + trows.length);
check(trows.some((t) => /Nachtfahrt\s*→\s*Strandgut/.test(t) && /aus 1\.0 s/.test(t) && /Einsatz -0\.5 s/.test(t)), 'Übergang Nachtfahrt → Strandgut mit „aus 1.0 s · Einsatz -0.5 s“: ' + JSON.stringify(trows[2]));
await shot('panel-2.png');
// Der Knopf „Bearbeiten“ öffnet denselben Editor
await tab.evaluate(`[...${sr}.querySelectorAll('.pane:not([style*="none"]) tbody tr')][0].querySelector('button').click()`);
await sleep(2500);
check(await tab.evaluate(`!!${sr}.querySelector('omp-segue-editor')`), 'Knopf „Bearbeiten“ öffnet den Editor');
await tab.close();
console.log(failed ? failed + ' FEHLER' : 'ALLES OK'); process.exit(failed ? 1 : 0);
