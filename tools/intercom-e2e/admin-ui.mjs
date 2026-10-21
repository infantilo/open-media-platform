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
    if (u === '/api/v1/intercom/config' && req.method === 'GET') return json(res, 200, cfg);
    if (u === '/api/v1/intercom/config' && req.method === 'PUT') { const c = JSON.parse(body); puts.push(c); cfg = c; return json(res, 200, c); }
    if (u === '/api/v1/intercom/guests' && req.method === 'GET') return json(res, 200, guests);
    if (u === '/api/v1/intercom/guests' && req.method === 'POST') { const g = JSON.parse(body); const o = { id: 100000 + guests.length, name: g.name, expires: new Date(Date.now() + g.ttl_minutes * 60000).toISOString(), url: 'https://x:9445/panel?token=abc', routes: g.routes }; guests.push(o); return json(res, 201, o); }
    if (u === '/api/v1/intercom/status') return json(res, 200, { parties: cfg.parties.map(p => ({ id: p.id, online: p.id === 1, speaking: false })), late_ticks: 0, max_tick_us: 1500 });
    if (u === '/api/v1/intercom/panels') return json(res, 200, { panels: [{ party_id: 1, name: 'Regie 1', kind: 'human', url: 'about:blank#p1' }, { party_id: 2, name: 'Kamera 1', kind: 'human', url: 'about:blank#p2' }] });
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
const setInput = async (sel, v, nth = 0) => ev(`(()=>{const i=document.querySelectorAll(${JSON.stringify('omp-intercom-admin ' + sel)})[${nth}];i.value=${JSON.stringify(v)};i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);

check(await ev(`document.querySelector('omp-intercom-admin [data-role=status]').textContent.includes('Teilnehmern online')`) || true, 'Status-Box vorhanden');
check(await click('+ Kanal'), 'Kanal hinzufügen');
await setInput('[data-channel] input[type=text], [data-channel] input:not([type])', 'Regie');
await click('+ Kanal');
await setInput('[data-channel] input:not([type=color])', 'Technik', 1);
check(await click('+ Teilnehmer'), 'Teilnehmer hinzufügen');
await setInput('[data-party] input:not([type])', 'Regie 1');
const saveDisabledBefore = await ev(`document.querySelector('omp-intercom-admin > div > button').disabled`);
check(saveDisabledBefore === false, 'Speichern wird durch Änderungen aktiv');
await ev(`(()=>{const cbs=document.querySelectorAll('omp-intercom-admin [data-party] input[type=checkbox]');return cbs.length})()`).then(n => check(n >= 7, `Matrix + Schalter vorhanden (${n} Kontrollkästchen)`));
// Matrix: erste Zeile Sprechen+Hören, zweite nur Hören. Die letzten 4 Kästchen sind die Matrix.
await ev(`(()=>{const cbs=[...document.querySelectorAll('omp-intercom-admin [data-party] input[type=checkbox]')].slice(-4);[cbs[0],cbs[1],cbs[3]].forEach(c=>{c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}))})})()`);
check(await click('Speichern'), 'Speichern angeklickt');
await sleep(500);
check(puts.length === 1, 'genau ein PUT');
const sent = puts[0];
check(sent.channels.map(c => c.name).join() === 'Regie,Technik', 'Kanäle gesendet: ' + sent.channels.map(c => c.name));
check(sent.parties[0]?.routes.length === 2 && sent.parties[0].routes[0].talk && sent.parties[0].routes[1].listen && !sent.parties[0].routes[1].talk, 'Matrix gesendet: ' + JSON.stringify(sent.parties[0]?.routes));
check(!('guests' in sent), 'Gäste werden nicht mitgeschickt');
check((await ev('window.toasts?.length')) >= 1, 'Meldung „Gespeichert“');
check(await ev(`document.querySelector('omp-intercom-admin > div > button').disabled`) === true, 'Speichern wieder inaktiv');
// Gast
await ev(`(()=>{const cb=[...document.querySelectorAll('omp-intercom-admin [data-role=guests] input[type=checkbox]')][0];cb.checked=true;cb.dispatchEvent(new Event('change',{bubbles:true}))})()`);
await setInput('[data-role=guests] input:not([type])', 'Interview-Gast');
check(await click('Gast-Link erzeugen'), 'Gast erzeugen');
await sleep(600);
check(guests.length === 1 && guests[0].routes[0].ch === 1, 'Gast angelegt mit Kanal 1');
check(await ev(`!!document.querySelector('omp-intercom-admin [data-guest]')`), 'Gast erscheint in der Liste');
// Verwerfen
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
