const puppeteer=require(process.env.PUPPETEER_CORE||'puppeteer-core');
const SP=(process.env.REVIEW_E2E_OUT||'.')+'/';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0; const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m); if(!c)fails++;};
async function until(fn,ms=30000,step=300){const t=Date.now();while(Date.now()-t<ms){try{const v=await fn();if(v)return v;}catch(e){}await sleep(step);}return null;}
(async()=>{
 const b=await puppeteer.launch({executablePath:process.env.CHROMIUM||'/usr/bin/chromium',headless:'new',args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
 const p=await b.newPage(); await p.setViewport({width:1500,height:1000});
 p.on('pageerror',e=>console.log('PAGEERR',e.message)); p.on('console',m=>{if(m.type()==='error')console.log('CONSOLE',m.text().slice(0,200))});
 await p.goto(''+(process.env.OMP_URL||'http://127.0.0.1:18000')+'/'); await sleep(2500);
 // Tab „Eingang“
 const clicked=await p.evaluate(()=>{const f=(root)=>{for(const e of root.querySelectorAll('*')){if(e.shadowRoot){const r=f(e.shadowRoot);if(r)return r;} if((e.tagName==='BUTTON'||e.tagName==='A'||e.getAttribute('role')==='tab')&&/^(Eingang|Intake)$/.test(e.textContent.trim())){e.click();return true;}}return false;};return f(document);});
 ok(clicked,'Tab Eingang vorhanden und geklickt'); await sleep(1500);
 const view=()=>p.evaluateHandle(()=>document.querySelector('omp-review-view'));
 const q=(sel)=>p.evaluate((s)=>{const v=document.querySelector('omp-review-view');return v?!!v.querySelector(s):false;},sel);
 const click=(sel,text)=>p.evaluate((s,t)=>{const v=document.querySelector('omp-review-view');const els=[...v.querySelectorAll(s)];const e=t?els.find(x=>x.textContent.includes(t)):els[0];if(!e)return false;e.click();return true;},sel,text);
 ok(await q('[data-role=filter]'),'Arbeitsliste gerendert');
 // Import
 ok(await click('[data-role=import]'),'Import-Dialog öffnen'); await sleep(500);
 const sel=await p.$('[data-role=import-file]'); ok(!!sel,'Dateiliste im Import-Dialog');
 await p.evaluate(()=>document.querySelector('[data-role=import-ok]').click()); await sleep(1500);
 // QC abwarten
 await p.evaluate(()=>{const s=document.querySelector('omp-review-view [data-role=filter]');s.value='all';s.dispatchEvent(new Event('change'));});
 const row=await until(async()=>p.evaluate(()=>{const r=document.querySelector('omp-review-view tr[data-asset]');return r&&/Wartet auf Prüfung|Awaiting review/.test(r.textContent)?r.dataset.asset:null;}),60000,1000);
 ok(!!row,'Asset erscheint, QC fertig → „Wartet auf Prüfung“ ('+row+')');
 await p.screenshot({path:SP+'e1-queue.png'});
 // öffnen
 await p.evaluate(()=>document.querySelector('omp-review-view [data-role=open]').click()); await sleep(1500);
 const head=await p.evaluate(()=>document.querySelector('omp-review-view [data-role=detail-head]').textContent);
 ok(/burn_demo/.test(head),'Detail geöffnet');
 // QC-Tab
 ok(await until(()=>q('[data-role=qc-overall]'),15000),'QC-Gesamtstatus sichtbar');
 const nfind=await p.evaluate(()=>document.querySelectorAll('omp-review-view [data-role=qc-findings] [data-check]').length);
 ok(nfind>10,'QC-Befunde gelistet ('+nfind+')');
 const hasFail=await p.evaluate(()=>[...document.querySelectorAll('omp-review-view [data-role=qc-findings] [data-check]')].some(r=>r.dataset.check==='container.timecode'));
 ok(hasFail,'Befund container.timecode vorhanden');
 // Filter: Kategorie audio
 await p.evaluate(()=>{const s=document.querySelector('omp-review-view [data-role=qc-panel] select');});
 await p.evaluate(()=>{const v=document.querySelector('omp-review-view');const sels=[...v.querySelectorAll('[data-role=qc-panel] select')];const cat=sels.find(s=>[...s.options].some(o=>o.value==='audio'));cat.value='audio';cat.dispatchEvent(new Event('change'));});
 const onlyAudio=await p.evaluate(()=>[...document.querySelectorAll('omp-review-view [data-role=qc-findings] [data-check]')].every(r=>/^(audio|sync|content|delivery|media|container|video)/.test(r.dataset.check)) && [...document.querySelectorAll('omp-review-view [data-role=qc-findings] [data-check]')].every(r=>r.dataset.check.startsWith('audio')));
 ok(onlyAudio,'Kategorie-Filter wirkt (nur audio.*)');
 await p.evaluate(()=>{const v=document.querySelector('omp-review-view');const sels=[...v.querySelectorAll('[data-role=qc-panel] select')];const cat=sels.find(s=>[...s.options].some(o=>o.value==='audio'));cat.value='';cat.dispatchEvent(new Event('change'));});
 // Befund aufklappen
 await p.evaluate(()=>{const r=document.querySelector('omp-review-view [data-check="audio.format"] div');r.click();});
 await sleep(200);
 ok(await p.evaluate(()=>/Werkzeug|Tool/.test(document.querySelector('omp-review-view [data-check="audio.format"]').textContent)),'Befund aufklappbar (Werkzeug/Version)');
 await p.screenshot({path:SP+'e2-qc.png'});
 // Übernehmen
 ok(await click('[data-role=claim]'),'Übernehmen'); await sleep(1500);
 ok(await p.evaluate(()=>/In Prüfung|In review/.test(document.querySelector('[data-role=state]').textContent)),'Zustand „In Prüfung“');
 // Review-Tab
 await p.evaluate(()=>document.querySelector('omp-review-view [data-tab=review]').click());
 const ready=await until(()=>q('[data-role=review-player] video'),60000,1000); ok(!!ready,'Player erscheint (Proxy erzeugt+verifiziert)');
 await sleep(1500);
 // Burn-in aus dem Videoelement lesen
 const readBits=()=>p.evaluate(()=>{const v=document.querySelector('omp-review-view [data-role=review-player] video');const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;const x=c.getContext('2d');x.drawImage(v,0,0);const sc=v.videoWidth/640;let n=0;for(let k=0;k<8;k++){const d=x.getImageData(Math.round((16+40*k+16)*sc),Math.round(32*sc),1,1).data;if((d[0]+d[1]+d[2])/3>128)n|=1<<k;}return n;});
 const state=()=>p.evaluate(()=>{const pl=document.querySelector('omp-review-view [data-role=review-player]');return {presented:+pl.dataset.presentedFrame,tc:pl.querySelector('[data-role=timecode]').textContent};});
 const key=async k=>{await p.keyboard.press(k);await sleep(350);};
 // Fokus auf Player
 await p.evaluate(()=>document.querySelector('omp-review-view [data-role=review-player]').focus());
 let s=await state(); ok(s.tc==='01:00:00:00','Startposition 01:00:00:00 ('+s.tc+')');
 for(let i=1;i<=5;i++){await key('ArrowRight');}
 s=await state(); let bits=await readBits(); ok(s.presented===5&&bits===5&&s.tc==='01:00:00:05',`5× → Bild 5 (angezeigt ${s.presented}, Burn-in ${bits}, ${s.tc})`);
 await key('ArrowLeft'); await key('ArrowLeft'); s=await state(); bits=await readBits(); ok(s.presented===3&&bits===3,`2× zurück → Bild 3 (Burn-in ${bits})`);
 // Shift+Pfeil = 10
 await p.keyboard.down('Shift'); await p.keyboard.press('ArrowRight'); await p.keyboard.up('Shift'); await sleep(400);
 bits=await readBits(); s=await state(); ok(bits===13&&s.presented===13,`Umschalt+→ = +10 → Bild 13 (Burn-in ${bits})`);
 // Go-to-Timecode
 await p.evaluate(()=>{const i=document.querySelector('omp-review-view [data-role=review-player] input');i.value='01:00:02:07';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));}); await sleep(600);
 bits=await readBits(); s=await state(); ok(bits===57&&s.tc==='01:00:02:07',`Timecode 01:00:02:07 → Bild 57 (Burn-in ${bits}, ${s.tc})`);
 // Stichprobe vieler Bilder: Sprung + Burn-in
 let allOk=true; const probe=[0,1,11,12,13,24,25,26,49,50,73,98,99];
 for(const n of probe){const tc='01:00:'+String(Math.floor(n/25)).padStart(2,'0')+':'+String(n%25).padStart(2,'0');
  await p.evaluate((tc)=>{const i=document.querySelector('omp-review-view [data-role=review-player] input');i.value=tc;i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));},tc); await sleep(350);
  const bb=await readBits(); const st=await state(); if(bb!==n||st.presented!==n){allOk=false;console.log('  mismatch',n,bb,st.presented);}}
 ok(allOk,'Seek auf 13 Stichprobenbilder: angezeigtes Bild == Ziel (inkl. GOP-Grenzen)');
 // Mausrad / Jog
 await p.evaluate(()=>{const i=document.querySelector('omp-review-view [data-role=review-player] input');i.value='01:00:01:00';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));}); await sleep(400);
 const jog=await p.$('omp-review-view [data-role=jog]'); const jb=await jog.boundingBox();
 await p.mouse.move(jb.x+20,jb.y+10); await p.mouse.down(); await p.mouse.move(jb.x+20+7*6,jb.y+10,{steps:6}); await p.mouse.up(); await sleep(500);
 bits=await readBits(); ok(bits===31,`Jog 6 Bilder vor → Bild 31 (Burn-in ${bits})`);
 // Marken + Segment
 await p.evaluate(()=>{const i=document.querySelector('omp-review-view [data-role=review-player] input');i.value='01:00:00:10';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));}); await sleep(400);
 await p.evaluate(()=>document.querySelector('omp-review-view [data-role=review-player]').focus()); await key('i');
 await p.evaluate(()=>{const i=document.querySelector('omp-review-view [data-role=review-player] input');i.value='01:00:01:14';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));}); await sleep(400);
 await p.evaluate(()=>document.querySelector('omp-review-view [data-role=review-player]').focus()); await key('o'); await key('n');
 const seg=await p.evaluate(()=>{const s=document.querySelector('omp-review-view [data-role=segment]');return s?{inv:s.querySelector('[data-role=seg-in]').value,out:s.querySelector('[data-role=seg-out]').value}:null;});
 ok(seg&&seg.inv==='01:00:00:10'&&seg.out==='01:00:01:15',`Segment aus Marken: In ${seg&&seg.inv} / Out(exkl.) ${seg&&seg.out} — Out = letztes Bild+1`);
 // Vorschau des Bereichs → stoppt am letzten Bild (39-1... Bild 38 = 01:00:01:13)
 await p.evaluate(()=>[...document.querySelectorAll('omp-review-view [data-role=review-player] button')].find(x=>x.title.includes('Bereich abspielen')||x.title.includes('Play the range')).click()); await sleep(2500);
 s=await state(); ok(s.presented===39,`Bereichsvorschau endet auf letztem Bild des Segments (Bild ${s.presented}, erwartet 39)`);
 // Shuttle vorwärts 2× (L,L) und K
 await p.evaluate(()=>document.querySelector('omp-review-view [data-role=review-player]').focus());
 await p.evaluate(()=>{const i=document.querySelector('omp-review-view [data-role=review-player] input');i.value='01:00:00:00';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));}); await sleep(400);
 await p.evaluate(()=>document.querySelector('omp-review-view [data-role=review-player]').focus());
 await p.keyboard.press('l'); await p.keyboard.press('l'); await sleep(1000); await p.keyboard.press('k'); await sleep(500);
 s=await state(); ok(s.presented>=30&&s.presented<=70,`Shuttle L L (2×) ~1 s → Bild ${s.presented} (erwartet ≈ 50)`);
 // Rückwärts-Shuttle (J J J: erst bremsen, dann −1×)
 await p.evaluate(()=>{const i=document.querySelector('omp-review-view [data-role=review-player] input');i.value='01:00:03:00';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));}); await sleep(500);
 await p.evaluate(()=>document.querySelector('omp-review-view [data-role=review-player]').focus());
 await p.keyboard.press('j'); await sleep(1000); await p.keyboard.press('k'); await sleep(600);
 s=await state(); bits=await readBits(); ok(s.presented<75&&s.presented>=40&&bits===s.presented,`Rückwärts-Shuttle −1× ~1 s → Bild ${s.presented} (Burn-in ${bits}; Start 75)`);
 // Grenzen
 await key('Home'); await key('ArrowLeft'); s=await state(); ok(s.presented===0,'Anfang: ← bleibt bei Bild 0');
 await key('End'); await key('ArrowRight'); s=await state(); ok(s.presented===99,'Ende: → bleibt auf letztem Bild 99');
 await p.screenshot({path:SP+'e3-review.png'});
 // Metadaten + Speichern
 await p.evaluate(()=>{const i=document.querySelector('omp-review-view [data-meta=title]');i.value='Testsendung E2E';i.dispatchEvent(new Event('input',{bubbles:true}));});
 await p.evaluate(()=>{const i=document.querySelector('omp-review-view [data-meta=keywords]');i.value='a, b ,c';i.dispatchEvent(new Event('input',{bubbles:true}));});
 ok(await click('[data-role=save]'),'Speichern'); await sleep(1500);
 const saved=await p.evaluate(async()=>{const r=await fetch('/api/v1/review/items/'+document.querySelector('omp-review-view tr')?.dataset?.asset);return 0;});
 // Einreichen
 ok(await click('[data-role=submit]'),'Einreichen'); await sleep(2000);
 ok(await p.evaluate(()=>/Zur Freigabe|Ready for approval/.test(document.querySelector('[data-role=state]').textContent)),'Zustand „Zur Freigabe“');
 ok(await q('[data-role=approve]'),'Freigeben-Taste (Konfigurationsrecht vorhanden)');
 await click('[data-role=approve]'); await sleep(2000);
 ok(await p.evaluate(()=>/Freigegeben|Approved/.test(document.querySelector('[data-role=state]').textContent)),'Zustand „Freigegeben“');
 await p.screenshot({path:SP+'e4-approved.png'});
 console.log(fails?`\n${fails} FEHLER`:'\nALLES OK'); 
 await b.close(); process.exit(fails?1:0);
})().catch(e=>{console.error('E2E-Abbruch',e);process.exit(2);});
