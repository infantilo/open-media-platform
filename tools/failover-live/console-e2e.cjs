// Browser-Test Kapitel 109: Operator-Konsole mit Mischer-Paar (Live-Standby) und Redundanz-Umschalter.
// Voraussetzung: laufender Orchestrator, Workflow aus workflow-Skript (Rollen src, p, s, sel) läuft, Operator-Konto mit "operate"-Bindung.
//   WF=<workflowId> [OPUSER=claude-test-operator OPPASS=...] [OUT=<Ordner für Bilder>] PUPPETEER_CORE=<Pfad> node console-e2e.cjs
// Prüft: Umschalter steht nach dem Start auf dem Hauptsignal; Bedienung am Primär-Panel wirkt (und wird auf den Standby gespiegelt);
// nach hartem Kill des Primär zeigt die Konsole weiter ein bedienbares Panel der Rolle p, dessen Befehle bei der übernommenen Instanz ankommen.
const puppeteer = require(process.env.PUPPETEER_CORE || 'puppeteer-core');
const fs = require('fs');
const B = process.env.BASE || 'http://localhost:8000';
const WF = process.env.WF, OUT = process.env.OUT || '.';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
async function api(method, path, body, tok) {
  const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
}
function pidOfInstance(id) {
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { if (fs.readFileSync(`/proc/${d}/environ`).toString().split('\0').includes('OMP_INSTANCE_ID=' + id)) return +d; } catch {}
  }
  return null;
}
(async () => {
  const adm = (await api('POST', '/api/v1/auth/login', { username: 'admin', password: 'adminpass123' })).token;
  let wf = await api('GET', `/api/v1/workflows/${WF}`, null, adm);
  const nodes = async () => Object.fromEntries((await api('GET', '/api/v1/nodes', null, adm)).map(n => [n.id, n]));
  let N = await nodes();
  const rt = wf.runtime;
  const state = async (role) => { const wfn = await api('GET', `/api/v1/workflows/${WF}`, null, adm); return (await api('GET', `/api/v1/nodes/${wfn.runtime[role].nodeId}/state`, null, adm)).state; };

  const b = await puppeteer.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: 'new', args: ['--no-sandbox'] });
  const p = await b.newPage(); await p.setViewport({ width: 1500, height: 1000 });
  p.on('requestfailed', r => { if (process.env.DEBUG_REQ) console.log('REQFAIL', r.url().slice(0, 110), r.failure() && r.failure().errorText); });
  p.on('response', r => { if (process.env.DEBUG_REQ && r.request().method() !== 'GET') console.log('POST', r.status(), r.url().replace(/\/nodes\/([0-9a-f]{6})[0-9a-f-]*/, '/nodes/$1…'), (r.request().postData() || '').slice(0, 80)); });
  const T0 = Date.now(); p.on('response', async r => { if (process.env.DEBUG_REQ && r.url().includes('/me/consoles')) { let n = '?'; try { n = (await r.json()).consoles.map(c => c.nodeLabel + ':' + c.nodeRoleId.slice(0, 4)).join(','); } catch {} console.log('me/consoles', ((Date.now() - T0) / 1000).toFixed(1) + 's', n); } });
  p.on('pageerror', e => console.log('PAGEERR', e.message));
  if (process.env.DEBUG_REQ) await p.evaluateOnNewDocument(() => { const E = window.EventSource; window.EventSource = function (u, o) { const es = new E(u, o); es.addEventListener('message', ev => { try { const t = JSON.parse(ev.data).type; if (!/^(metrics|host\.|node\.updated|health)/.test(t)) console.log('SSE', t); } catch {} }); return es; }; window.EventSource.prototype = E.prototype; });
  p.on('console', m => { if (process.env.DEBUG_REQ && m.text().startsWith('SSE')) console.log(((Date.now() - T0) / 1000).toFixed(1) + 's', m.text()); });
  await p.goto(B + '/'); await sleep(1500);
  await p.keyboard.type(process.env.OPUSER || 'claude-test-operator'); await p.keyboard.press('Tab'); await p.keyboard.type(process.env.OPPASS || 'claudeTest-op-2026!'); await p.keyboard.press('Enter'); await sleep(3000);
  await p.goto(`${B}/console/${WF}`); await sleep(4000);
  // tiefe Suche über Shadow-DOM
  const deep = (fnBody) => p.evaluate(`(()=>{const out=[];const f=(root)=>{for(const e of root.querySelectorAll('*')){ ${fnBody} if(e.shadowRoot)f(e.shadowRoot);}};f(document);return out;})()`);
  const panels = await deep(`if(e.tagName==='OMP-VIDEO-MIXER-ME-PANEL')out.push(1);`);
  ok(panels.length === 2, `zwei Mischer-Panels in der Konsole (${panels.length})`);
  const selText = () => p.evaluate(() => { const f = (root) => { for (const e of root.querySelectorAll('*')) { if (e.tagName === 'OMP-FAILOVER-PANEL') return e.shadowRoot ? e.shadowRoot.textContent : e.textContent; if (e.shadowRoot) { const r = f(e.shadowRoot); if (r) return r; } } return null; }; return f(document); });
  const selNode0 = (await nodes())[wf.runtime.sel.nodeId];
  let a0 = '';
  for (let i = 0; i < 40; i++) { a0 = (await api('GET', `/api/v1/nodes/${selNode0.id}/params/active`, null, adm)).value; if (a0 === 'main') break; await sleep(1000); }
  ok(a0 === 'main', `Umschalter steht (spätestens nach der automatischen Rückkehr) auf dem Hauptsignal (aktiv: ${a0})`);
  await p.screenshot({ path: OUT + '/c1-start.png' });

  // Klick im Primär-Panel (erstes Panel = Rolle p): Programmbus auf BLK
  const clickInPanel = (idx, text, nth = 0) => p.evaluate((idx, text, nth) => {
    const panels = []; const f = (root) => { for (const e of root.querySelectorAll('*')) { if (e.tagName === 'OMP-VIDEO-MIXER-ME-PANEL') panels.push(e); if (e.shadowRoot) f(e.shadowRoot); } }; f(document);
    const btns = []; const g = (root) => { for (const e of root.querySelectorAll('*')) { if (e.tagName === 'OMP-BUTTON' || e.tagName === 'BUTTON') btns.push(e); if (e.shadowRoot) g(e.shadowRoot); } };
    g(panels[idx].shadowRoot || panels[idx]);
    const m = btns.filter(x => (x.textContent || '').trim().toUpperCase() === text);
    if (!m[nth]) return false; (m[nth].shadowRoot?.querySelector('button') || m[nth]).click(); return true;
  }, idx, text, nth);
  // Panels bauen ihre Quellenliste erst nach der Erkennung auf: auf den Knopf warten statt sofort zu klicken
  const waitClick = async (idx, text, nth = 0, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await clickInPanel(idx, text, nth)) return true; await sleep(500); } return false; };
  const s0 = JSON.stringify(await state('p'));
  ok(await waitClick(0, 'SRC SENDER 1', 1), 'Klick Quelle auf dem Preset-Bus (PST) im Primär-Panel');
  await sleep(2000);
  const sp1 = await state('p'), ss1 = await state('s');
  ok(JSON.stringify(sp1) !== s0, 'Bedienung wirkt am Primär (Zustand geändert)');
  ok(JSON.stringify(sp1) === JSON.stringify(ss1), 'Standby hat denselben Zustand (Spiegelung über die Konsole)');

  // Primär hart beenden
  console.log('KILL', ((Date.now() - T0) / 1000).toFixed(1) + 's'); const killed = pidOfInstance(rt.p.instanceId); process.kill(killed, 'SIGKILL');
  const t0 = Date.now(); let promoted = false;
  while (Date.now() - t0 < 20000) { wf = await api('GET', `/api/v1/workflows/${WF}`, null, adm); if (wf.runtime.p.instanceId === rt.s.instanceId) { promoted = true; break; } await sleep(100); }
  ok(promoted, `Orchestrator übernimmt Rolle p auf den Standby (${Date.now() - t0} ms)`);
  await sleep(3000);
  await p.screenshot({ path: OUT + '/c2-nach-kill.png' });
  // Nach der Übernahme steckt der Orchestrator den Hauptsignal-Eingang des Umschalters auf den Standby um; der Umschalter darf dabei auf
  // dem Standby stehen (Notbetrieb) ODER auf „Hauptsignal“ (jetzt der Standby) — in beiden Fällen müssen beide Eingänge gesund sein und Bilder laufen.
  const selNode = (await nodes())[(await api('GET', `/api/v1/workflows/${WF}`, null, adm)).runtime.sel.nodeId];
  let src2 = [];
  for (let i = 0; i < 20; i++) { src2 = JSON.parse((await api('GET', `/api/v1/nodes/${selNode.id}/params/sources`, null, adm)).value); if (src2[0].state === 'gesund' && src2[1].state === 'gesund') break; await sleep(500); }
  ok(src2[0].state === 'gesund' && src2[1].state === 'gesund', `Umschalter: Hauptsignal und Notquelle 1 gesund (${src2[0].state}, ${src2[1].state})`);
  const o1 = JSON.parse((await api('GET', `/api/v1/nodes/${selNode.id}/params/videoOut`, null, adm)).value); await sleep(1000);
  const o2 = JSON.parse((await api('GET', `/api/v1/nodes/${selNode.id}/params/videoOut`, null, adm)).value);
  ok(o2.frames - o1.frames >= 20, `Umschalter-Ausgang läuft weiter (${o2.frames - o1.frames} Bilder/s)`);
  const dead = await p.evaluate(() => { let n = 0; const f = (root) => { for (const e of root.querySelectorAll('*')) { if (e.shadowRoot) { if (/Service unavailable|not responding/i.test(e.shadowRoot.textContent || '') && !e.shadowRoot.querySelector('*[class*=tile]')) n += 0; f(e.shadowRoot); } } }; f(document); return /Service unavailable|not responding/i.test(document.body.innerText) || (() => { let hit = false; const g = (root) => { for (const e of root.querySelectorAll('*')) { if (e.shadowRoot) { if (/Service unavailable|not responding/i.test(e.shadowRoot.textContent || '')) hit = true; g(e.shadowRoot); } } }; g(document); return hit; })(); });
  ok(!dead, 'keine Kachel meldet „Service unavailable“ (Konsole folgt der Übernahme)');
  const panels2 = await deep(`if(e.tagName==='OMP-VIDEO-MIXER-ME-PANEL')out.push(1);`);
  ok(panels2.length >= 1, `Mischer-Panel der Rolle p ist weiter da (${panels2.length})`);

  // Bedienung nach der Übernahme: Klick „BLK“ wieder auf Programm? erst eine andere Wahl, dann zurück — wirkt beim übernommenen Node
  const before = JSON.stringify(await state('p'));
  const clicked = await waitClick(0, 'BLK', 1);
  ok(clicked, 'Klick „BLK“ (Preset-Bus) im Panel nach der Übernahme');
  await sleep(2000);
  const after = JSON.stringify(await state('p'));
  if (after === before) { const cs = (await api('POST', '/api/v1/auth/login', { username: process.env.OPUSER || 'claude-test-operator', password: process.env.OPPASS || 'claudeTest-op-2026!' })).token; console.log('   Konsolen-Einträge:', JSON.stringify((await api('GET', '/api/v1/me/consoles', null, cs)).consoles.map(c => [c.nodeLabel, c.nodeRoleId.slice(0, 6)])), 'Runtime p:', (await api('GET', `/api/v1/workflows/${WF}`, null, adm)).runtime.p.instanceId.slice(0, 6), 'Zustand vorher/nachher:', JSON.stringify([ 'programSenderId','presetSenderId' ].map(k => [JSON.parse(before)[k], JSON.parse(after)[k]]))); }
  ok(after !== before, 'Bedienung nach der Übernahme erreicht den übernommenen Node (Zustand geändert)');
  await p.screenshot({ path: OUT + '/c3-bedient.png' });
  await b.close();
  console.log(fails ? `${fails} Prüfung(en) FEHLGESCHLAGEN` : 'alle Prüfungen bestanden');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
