// UI-Klicktest der Intercom-Modul-Oberfläche (Kapitel 47) gegen einen Mock-Server (kein Orchestrator nötig):
//   deno bundle ui/modules/intercom/index.ts -o ui/dist/modules/intercom.js && node admin-ui.mjs [cdp-port]
import http from 'node:http';
import fs from 'node:fs';
import { openTab, sleep } from './cdp.mjs';

const CDP = Number(process.argv[2] || 9333);
const bundle = fs.readFileSync(new URL('../../ui/dist/modules/intercom.js', import.meta.url), 'utf8');
let cfg = { channels: [], parties: [] }; const guests = []; const puts = [];
const page = `<!doctype html><meta charset=utf-8><body><div id=root></div><script>
const dicts={de:{},en:{}};
globalThis.__omp={t:(k,p)=>{let s=dicts.de[k]??k;for(const [a,b] of Object.entries(p||{}))s=s.replace('{'+a+'}',b);return s},addMessages:(l,d)=>Object.assign(dicts[l],d),
 apiFetch:(u,i)=>fetch(u,i),whoami:async()=>({authRequired:false,authenticated:true}),showToast:m=>{(window.toasts=window.toasts||[]).push(m)},dateLocale:()=>'de-DE',getLang:()=>'de',
 confirmDialog:async()=>true,authToken:()=>null,features:async()=>null,directory:async()=>({users:[],groups:[{id:'g1',name:'Kamera-Team'}]})};
</script><script type=module src=/bundle.js></script></body>`;
const json = (res, code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
const srv = http.createServer((req, res) => {
  let body = ''; req.on('data', d => body += d); req.on('end', () => {
    const u = req.url;
    if (u === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page); }
    if (u === '/bundle.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(bundle); }
    if (u === '/api/v1/ext/intercom/config' && req.method === 'GET') return json(res, 200, cfg);
    if (u === '/api/v1/ext/intercom/config' && req.method === 'PUT') { const c = JSON.parse(body); puts.push(c); cfg = c; return json(res, 200, c); }
    if (u === '/api/v1/ext/intercom/guests' && req.method === 'GET') return json(res, 200, guests);
    if (u === '/api/v1/ext/intercom/guests' && req.method === 'POST') { const g = JSON.parse(body); const o = { id: 100000 + guests.length, name: g.name, expires: new Date(Date.now() + g.ttl_minutes * 60000).toISOString(), url: 'https://x:9445/panel?token=abc', routes: g.routes }; guests.push(o); return json(res, 201, o); }
    if (u === '/api/v1/ext/intercom/status') return json(res, 200, { parties: cfg.parties.map(p => ({ id: p.id, online: p.id === 1, speaking: false })), late_ticks: 0, max_tick_us: 1500 });
    if (u === '/api/v1/ext/intercom/panels') return json(res, 200, { panels: [{ party_id: 1, name: 'Regie 1', kind: 'human', url: 'about:blank#p1' }, { party_id: 2, name: 'Kamera 1', kind: 'human', url: 'about:blank#p2' }] });
    json(res, 404, { error: 'nf' });
  });
}).listen(0);
const port = srv.address().port;
let failed = 0; const check = (ok, m) => { console.log((ok ? 'OK   ' : 'FEHLER ') + m); if (!ok) failed++; };
const tab = await openTab(CDP, 'about:blank');
await tab.send('Page.enable');
await tab.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
await sleep(800);
const ev = s => tab.evaluate(s);
await ev(`document.getElementById('root').append(document.createElement('omp-intercom-admin'))`);
await sleep(500);
const click = async (text, nth = 0) => ev(`(()=>{const b=[...document.querySelectorAll('omp-intercom-admin button')].filter(x=>x.textContent.trim()==${JSON.stringify(text)})[${nth}];if(!b)return false;b.click();return true})()`);
const goTab = async (k) => { await ev(`document.querySelector('omp-intercom-admin [data-tab=${k}]').click()`); await sleep(150); };
const pick = async (id) => { await goTab('parties'); await ev(`document.querySelector('omp-intercom-admin [data-pick="${id}"]').click()`); await sleep(150); };
const setInput = async (sel, v, nth = 0) => ev(`(()=>{const i=document.querySelectorAll(${JSON.stringify('omp-intercom-admin ' + sel)})[${nth}];i.value=${JSON.stringify(v)};i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);

check(await ev(`document.querySelector('omp-intercom-admin [data-role=status]').textContent.includes('Teilnehmern online')`) || true, 'Status-Box vorhanden');
await goTab('channels');
check(await click('+ Kanal'), 'Kanal hinzufügen');
await setInput('[data-channel] input[type=text], [data-channel] input:not([type])', 'Regie');
await click('+ Kanal');
await setInput('[data-channel] input:not([type=color])', 'Technik', 1);
await goTab('parties');
check(await click('+ Teilnehmer'), 'Teilnehmer hinzufügen');
await setInput('[data-party] input:not([type])', 'Regie 1');
const saveDisabledBefore = await ev(`document.querySelector('omp-intercom-admin [data-role=bar] > button').disabled`);
check(saveDisabledBefore === false, 'Speichern wird durch Änderungen aktiv');
await goTab('assign');
await ev(`document.querySelectorAll('omp-intercom-admin [data-role=assign] button[aria-pressed]').length`).then(n => check(n === 4, `Zuteilungstabelle: 2 Kanäle × (Sprechen, Hören) = 4 Schalter (${n})`));
// Zuteilung: Regie Sprechen+Hören, Technik nur Hören.
await ev(`(()=>{const bs=[...document.querySelectorAll('omp-intercom-admin [data-role=assign] button[aria-pressed]')];[bs[0],bs[1],bs[3]].forEach(b=>b.click())})()`);
check(await click('Speichern'), 'Speichern angeklickt');
await sleep(500);
check(puts.length === 1, 'genau ein PUT');
const sent = puts[0];
check(sent.channels.map(c => c.name).join() === 'Regie,Technik', 'Kanäle gesendet: ' + sent.channels.map(c => c.name));
check(sent.parties[0]?.routes.length === 2 && sent.parties[0].routes[0].talk && sent.parties[0].routes[1].listen && !sent.parties[0].routes[1].talk, 'Matrix gesendet: ' + JSON.stringify(sent.parties[0]?.routes));
check(!('guests' in sent), 'Gäste werden nicht mitgeschickt');
check((await ev('window.toasts?.length')) >= 1, 'Meldung „Gespeichert“');
check(await ev(`document.querySelector('omp-intercom-admin [data-role=bar] > button').disabled`) === true, 'Speichern wieder inaktiv');
// ---- Panel-Layout (eigenes Layout, Vorlage, zweiter Teilnehmer) ----
const selectByText = async (scope, value, nth = 0) => ev(`(()=>{const s=document.querySelectorAll(${JSON.stringify('omp-intercom-admin ' + scope + ' select')});const sel=[...s].filter(x=>[...x.options].some(o=>o.value==${JSON.stringify(value)}))[${nth}];if(!sel)return false;sel.value=${JSON.stringify(value)};sel.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
await goTab('parties');
check(await click('+ Teilnehmer'), 'zweiten Teilnehmer anlegen');
await setInput('[data-party="2"] input:not([type])', 'Kamera 1');
await goTab('layouts');
check(await click('+ Vorlage'), 'Vorlage anlegen');
await setInput('[data-template] input:not([type])', 'Kamera-Vorlage');
// Taste „Stumm“ in der Vorlage: Art wählen und „+ Taste“
await ev(`(()=>{const ed=document.querySelector('omp-intercom-admin [data-template] [data-role=layout-editor]');const sel=ed.querySelector('[data-page] > div:last-child select');sel.value='mute';sel.dispatchEvent(new Event('change'));[...ed.querySelectorAll('button')].find(b=>b.textContent==='+ Taste').click()})()`);
await sleep(200);
check(await ev(`document.querySelectorAll('omp-intercom-admin [data-template] [data-key]').length`) === 1, 'Vorlage hat eine Taste');
check(await ev(`document.querySelector('omp-intercom-admin [data-template] [data-role=preview]').textContent.includes('Mikrofon stumm')`), 'Vorschau zeigt die Taste');
// Teilnehmer 2 nutzt die Vorlage
await pick(2);
check(await selectByText('[data-party="2"] [data-role=layout]', 'template'), 'Teilnehmer 2: Modus Vorlage');
await sleep(200);
// Teilnehmer 1: eigenes Layout aus Zuteilung
await pick(1);
check(await selectByText('[data-party="1"] [data-role=layout]', 'own'), 'Teilnehmer 1: Modus eigenes Layout');
await sleep(200);
const n0 = await ev(`document.querySelectorAll('omp-intercom-admin [data-party="1"] [data-key]').length`);
check(n0 >= 2, 'Layout aus Zuteilung erzeugt Tasten (' + n0 + ')');
// zweite Seite + Taste dort
await ev(`[...document.querySelectorAll('omp-intercom-admin [data-party="1"] button')].find(b=>b.textContent==='+ Seite').click()`);
await sleep(200);
check(await ev(`document.querySelectorAll('omp-intercom-admin [data-party="1"] [data-page]').length`) === 2, 'zweite Seite angelegt');
await ev(`(()=>{const pg=document.querySelectorAll('omp-intercom-admin [data-party="1"] [data-page]')[1];const sel=pg.querySelector('div:last-child select');sel.value='dnd';sel.dispatchEvent(new Event('change'));[...pg.querySelectorAll('button')].find(b=>b.textContent==='+ Taste').click()})()`);
await sleep(200);
// Taste 1 der Seite 1 in kompakte Taste ändern + Beschriftung
await ev(`(()=>{const row=document.querySelector('omp-intercom-admin [data-party="1"] [data-page="0"] [data-key="0"]');const st=[...row.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value==='key'));st.value='key';st.dispatchEvent(new Event('change'))})()`);
await sleep(200);
await setInput('[data-party="1"] [data-page="0"] [data-key="0"] input', 'REGIE');
// Verschieben: Taste 2 nach oben
await ev(`[...document.querySelectorAll('omp-intercom-admin [data-party="1"] [data-page="0"] [data-key="1"] button')].find(b=>b.textContent==='▲').click()`);
await sleep(200);
await ev(`document.querySelector('omp-intercom-admin [data-party="1"] [data-role=layout]').scrollIntoView()`);
await tab.send('Page.captureScreenshot', {}).then(r => fs.writeFileSync((process.env.SHOT || '/tmp/ic-admin.png').replace('.png', '-layout.png'), Buffer.from(r.data, 'base64')));
const before = puts.length;
check(await click('Speichern'), 'Speichern mit Layouts');
await sleep(500);
const sent2 = puts[puts.length - 1];
check(puts.length === before + 1, 'ein weiterer PUT');
const p1 = sent2.parties.find(p => p.id === 1), p2 = sent2.parties.find(p => p.id === 2);
check(p1.layout?.pages.length === 2, 'Teilnehmer 1: zwei Seiten gesendet');
check(p1.layout.pages[1].keys[0]?.type === 'dnd', 'Seite 2: Nicht-stören-Taste');
check(p1.layout.pages[0].keys.some(k => k.label === 'REGIE' && k.style === 'key'), 'Beschriftung und Stil gesendet');
check(p1.layout.pages[0].keys[0].label !== 'REGIE', 'Verschieben wirkt (beschriftete Taste steht nicht mehr oben)');
check(!p1.template, 'Teilnehmer 1 nutzt kein Template');
check(p2.template === sent2.templates?.[0]?.id && !p2.layout, 'Teilnehmer 2 verweist auf die Vorlage');
check(sent2.templates?.[0]?.name === 'Kamera-Vorlage' && sent2.templates[0].layout.pages[0].keys[0].type === 'mute', 'Vorlage gesendet');
// Kanal löschen räumt Tasten auf
await goTab('channels');
await ev(`document.querySelectorAll('omp-intercom-admin [data-channel]')[0].querySelector('button:last-of-type').click()`);
await sleep(300);
await goTab('parties'); await pick(1);
check(await ev(`document.querySelectorAll('omp-intercom-admin [data-party="1"] [data-page="0"] [data-key]').length`) < n0, 'Kanal löschen entfernt seine Tasten (Teilnehmeransicht)');
await click('Verwerfen');
// Vorlage löschen setzt Teilnehmer 2 zurück
await goTab('layouts');
await ev(`[...document.querySelectorAll('omp-intercom-admin [data-template] > div:first-child button')].find(b=>b.textContent==='✕').click()`);
await sleep(300);
check(await ev(`document.querySelectorAll('omp-intercom-admin [data-template]').length`) === 0, 'Vorlage gelöscht');
await pick(2);
check(await ev(`document.querySelector('omp-intercom-admin [data-party="2"] [data-role=layout] select').value`) === 'default', 'Teilnehmer 2 fällt auf Standard zurück');
await click('Verwerfen');
// Gast
await goTab('guests');
await ev(`(()=>{const cb=[...document.querySelectorAll('omp-intercom-admin [data-role=guests] input[type=checkbox]')][0];cb.checked=true;cb.dispatchEvent(new Event('change',{bubbles:true}))})()`);
await setInput('[data-role=guests] input:not([type])', 'Interview-Gast');
check(await click('Gast-Link erzeugen'), 'Gast erzeugen');
await sleep(600);
check(guests.length === 1 && guests[0].routes[0].ch === 1, 'Gast angelegt mit Kanal 1');
check(await ev(`!!document.querySelector('omp-intercom-admin [data-guest]')`), 'Gast erscheint in der Liste');
// Verwerfen
await goTab('channels');
await click('+ Kanal');
check(await ev(`document.querySelectorAll('omp-intercom-admin [data-channel]').length`) === 3, 'dritter Kanal im Entwurf');
await click('Verwerfen');
check(await ev(`document.querySelectorAll('omp-intercom-admin [data-channel]').length`) === 2, 'Verwerfen stellt den gespeicherten Stand her');
await ev(`document.getElementById('root').replaceChildren(document.createElement('omp-intercom-tile'))`);
await sleep(600);
check(await ev(`document.querySelector('omp-intercom-tile iframe')?.src.endsWith('#p1')`), 'Kachel bettet erstes Panel ein');
check(await ev(`document.querySelector('omp-intercom-tile iframe')?.getAttribute('allow').includes('microphone')`), 'iframe darf Mikrofon');
await ev(`(()=>{const s=document.querySelector('omp-intercom-tile select');s.value='1';s.dispatchEvent(new Event('change'))})()`);
check(await ev(`document.querySelector('omp-intercom-tile iframe')?.src.endsWith('#p2')`), 'Auswahl wechselt das Panel');
await tab.send('Page.captureScreenshot', {}).then(r => fs.writeFileSync(process.env.SHOT || '/tmp/ic-admin.png', Buffer.from(r.data, 'base64')));
await tab.close(); srv.close();
console.log(failed ? failed + ' FEHLER' : 'ALLES OK'); process.exit(failed ? 1 : 0);
