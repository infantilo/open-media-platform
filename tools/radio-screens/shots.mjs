// Screenshots der Radio-Bedienfelder für README/Handbuch (Radio-Automation mit allen Reitern und Segue-Editor, Studio-Logik, GPIO).
// Mountet die Panel-Bundles der Nodes in eine Seite auf dem Ursprung des jeweiligen Nodes (Aufrufe an `/api/v1/nodes/<id>/…` gehen direkt
// an den Node, wie es der Orchestrator-Proxy täte; Rest-API-Aufrufe der Panels beantwortet ein kleiner Schein).
//   ORCH_TOKEN=<Bearer-Token> OMP_NODE_API_TOKEN=<Token> SHOT_DIR=<Ordner> node shots.mjs <automation-url> <studio-logic-url> <gpio-url> <demo-log.json> [cdp-port]
// Orchestrator-Aufrufe (Sendungen, Knotenliste): ORCH_URL, ORCH_TOKEN. Der Browser muss mit --remote-debugging-port laufen. Das Demo-Log erzeugt tools/radio-demo/make-demo.py.
import fs from 'node:fs';
import { openTab, sleep } from '../intercom-e2e/cdp.mjs';

const [AUTO, STUDIO, GPIO, LOGFILE] = process.argv.slice(2, 6);
const CDP = Number(process.argv[6] || 9334);
const NT = process.env.OMP_NODE_API_TOKEN;
const OUT = process.env.SHOT_DIR;
const LOG = fs.readFileSync(LOGFILE, 'utf8');
const ui = (node, f) => fs.readFileSync(new URL(`../../nodes/${node}/ui/${f}`, import.meta.url), 'utf8');
const ORCH = process.env.ORCH_URL || 'http://127.0.0.1:8000';
const ORCH_TOKEN = process.env.ORCH_TOKEN;
const W = Number(process.env.SHOT_W || 1500), H = Number(process.env.SHOT_H || 1100);

async function mount(url, tag, files) {
  const tab = await openTab(CDP, 'about:blank');
  await tab.send('Page.enable');
  await tab.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  // Aufrufe an /api/v1/nodes und /api/v1/radio beantwortet der echte Orchestrator (mit dem Token des Skripts), alles andere der Node selbst
  await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/v1/radio*' }, { urlPattern: '*/api/v1/nodes' }] });
  tab.on(async (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const q = m.params.request;
    const path = new URL(q.url).pathname + new URL(q.url).search;
    try {
      const r = await fetch(ORCH + path, { method: q.method, headers: { Authorization: 'Bearer ' + ORCH_TOKEN, 'content-type': 'application/json' }, body: ['GET', 'HEAD'].includes(q.method) ? undefined : q.postData });
      const body = Buffer.from(await r.arrayBuffer()).toString('base64');
      await tab.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: r.status, responseHeaders: [{ name: 'content-type', value: r.headers.get('content-type') || 'application/json' }], body });
    } catch (e) { await tab.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'Failed' }).catch(() => {}); }
  });
  await tab.send('Page.navigate', { url: url + '/x-nmos' });
  await sleep(800);
  await tab.evaluate(`(() => {
    const real = window.fetch.bind(window);
    window.fetch = (u, i = {}) => {
      const m = typeof u === 'string' && u.match(/^\\/api\\/v1\\/nodes\\/N1\\/(.*)$/);
      if (m) return real('/' + m[1], { ...i, headers: { ...(i.headers || {}), 'x-omp-node-token': ${JSON.stringify(NT)} } });
      if (typeof u === 'string' && (u.startsWith('/api/v1/nodes') || u.startsWith('/api/v1/radio'))) return real(u, i); // geht über den Browser an den Orchestrator (s. Fetch.requestPaused)
      if (typeof u === 'string' && u.startsWith('/api/v1/')) return Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
      return real(u, i);
    };
    for (const src of ${JSON.stringify(files)}) { const s = document.createElement('script'); s.type = 'module'; s.textContent = src; document.head.append(s); }
    document.documentElement.lang = 'de';
    document.body.textContent = ''; document.body.style.cssText = 'background:#0b0d10;margin:0;padding:8px';
  })()`);
  await sleep(600);
  await tab.evaluate(`(() => { const p = document.createElement('${tag}'); p.setAttribute('node-id', 'N1'); document.body.append(p); window.__p = p; })()`);
  await sleep(2500);
  const shot = async (name, full = false) => {
    // auf den Inhalt zuschneiden (Panel + Rand), höchstens Fensterhöhe
    const bottom = await tab.evaluate(`Math.ceil(window.__p.getBoundingClientRect().bottom) + 8`);
    const r = await tab.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: full ? H : Math.min(H, Math.max(300, bottom)), scale: 1 } });
    fs.writeFileSync(`${OUT}/${name}`, Buffer.from(r.data, 'base64'));
    console.log('Bild', name);
  };
  const sr = 'window.__p.shadowRoot';
  const click = (sel, re) => tab.evaluate(`(() => { const b = [...${sr}.querySelectorAll('${sel}')].find((e) => /${re}/i.test(e.textContent)); if (!b) return false; b.click(); return true; })()`);
  return { tab, shot, click, sr };
}

// ── Radio-Automation ──
{
  const { tab, shot, click, sr } = await mount(AUTO, 'omp-radio-automation-panel', [ui('omp-radio-automation', 'segue-editor.js'), ui('omp-radio-automation', 'bundle.js')]);
  const pick = (sel, re) => tab.evaluate(`(() => { const s = [...${sr}.querySelectorAll('${sel}')].find((x) => [...x.options].some((o) => /${re}/.test(o.textContent))); if (!s) return false; s.value = [...s.options].find((o) => /${re}/.test(o.textContent)).value; s.dispatchEvent(new Event('change')); return true; })()`);
  // Planung: Wochenplan und Sendung
  await click('button', '^Planung');
  await sleep(1500);
  await shot('radio-planung-woche.png');
  await pick('select', 'Abendmagazin');
  await sleep(1500);
  await tab.evaluate(`${sr}.querySelector('details:nth-of-type(2)')?.scrollIntoView()`);
  await shot('radio-planung.png');
  // Sendung auf Sendung laden, Log an den Segue-Player-Node übergeben (Reiter Playlist → „Log laden“), Ziel wählen → Sendebetrieb
  await click('button', '^Auf Sendung laden');
  await sleep(2500);
  await click('button', '^Playlist');
  await sleep(800);
  await click('button', '^Log laden');
  await sleep(2000);
  await pick('select', 'Segue-Player');
  await sleep(1500);
  await click('button', '^Sendebetrieb');
  await sleep(2500);
  await shot('radio-sendebetrieb.png');
  await click('button', '^Playlist');
  await sleep(1200);
  await shot('radio-playlist.png');
  await click('button', '^Übergänge');
  await sleep(1200);
  await shot('radio-uebergaenge.png');
  await tab.evaluate(`[...${sr}.querySelectorAll('.pane:not([style*="none"]) tbody tr')][7].querySelector('button').click()`);
  await sleep(3500);
  await shot('radio-segue-editor.png', true);
  await tab.evaluate(`[...${sr}.querySelector('omp-segue-editor').shadowRoot.querySelectorAll('button')].find((b) => /Abbrechen/.test(b.textContent)).click()`);
  await sleep(500);
  for (const [re, name] of [['^Moderation', 'radio-moderation.png'], ['^Protokoll', 'radio-protokoll.png']]) {
    await click('button', re);
    await sleep(1500);
    await shot(name);
  }
  await tab.close();
}
// ── Studio-Logik, GPIO ──
for (const [url, tag, node, name] of [[STUDIO, 'omp-studio-logic-panel', 'omp-studio-logic', 'radio-studio-logik.png'], [GPIO, 'omp-gpio-panel', 'omp-gpio', 'radio-gpio.png']]) {
  const { tab, shot, sr } = await mount(url, tag, [ui(node, 'bundle.js')]);
  await sleep(1000);
  // Studio-Logik: Regeln aufklappen
  if (tag === 'omp-studio-logic-panel') { await tab.evaluate(`[...${sr}.querySelectorAll('summary')].find((e) => /Regeln/.test(e.textContent))?.click()`); await sleep(800); }
  await shot(name);
  await tab.close();
}
process.exit(0);
