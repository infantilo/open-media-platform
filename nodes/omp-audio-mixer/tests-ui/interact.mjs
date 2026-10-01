import {connect} from './cdp.mjs';
const c=await connect();
const NODE=process.env.MIXER_NODE||'http://127.0.0.1:9791';
const param=async(n)=>(await (await fetch(`${NODE}/params/${n}`)).json()).value;
const ch=async(id,p)=>(await (await fetch(`${NODE}/params/channel.${id}.${p}`)).json()).value;
const A=`document.querySelector('omp-audio-mixer-panel').app`;
const rect=async(sel,inRoot=true)=>JSON.parse(await c.ev(`(()=>{const e=${A}.shadow.querySelector(${JSON.stringify(sel)}); if(!e) return 'null'; const r=e.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height})})()`));
let fails=0; const ok=(name,cond,extra='')=>{console.log((cond?'PASS ':'FAIL ')+name+(extra?'  '+extra:'')); if(!cond) fails++;};
await c.viewport(1500,900,false); await c.nav('http://127.0.0.1:18080/'); await c.ev(`localStorage.clear()`); await c.nav('http://127.0.0.1:18080/'); await c.sleep(2500);

// ---- Audio-State-Schnappschuss (ohne Live-Werte) vor Layoutwechseln
const snap=async()=>{const s=await param('mixState'); return JSON.stringify(s.channels.map(x=>[x.id,x.gainDb,x.mute,x.proc,x.group,x.sends,x.mainRoute]))};
const before=await snap();

// 1) Mute per Mausklick (Host = ch1)
const m=await rect(`.ch[data-id=ch1] .mute`);
await c.mouse('mouseMoved',m.x+m.w/2,m.y+m.h/2); await c.mouse('mousePressed',m.x+m.w/2,m.y+m.h/2); await c.mouse('mouseReleased',m.x+m.w/2,m.y+m.h/2);
await c.sleep(500); ok('Mute-Klick → Node mute=true', (await ch('ch1','mute'))===true);
const air=await c.ev(`${A}.shadow.querySelector('.ch[data-id=ch1] .b.onair').textContent`);
await c.sleep(600); ok('Kanal zeigt MUTED statt ON AIR (Text)', (await c.ev(`${A}.shadow.querySelector('.ch[data-id=ch1] .b.onair').textContent`))==='MUTED');
await c.mouse('mousePressed',m.x+m.w/2,m.y+m.h/2); await c.mouse('mouseReleased',m.x+m.w/2,m.y+m.h/2); await c.sleep(500);
ok('Mute-Klick zurück → mute=false', (await ch('ch1','mute'))===false);

// 2) Fader per Maus ziehen (Gast 3 = ch4), von 0 dB nach unten
const f=await rect(`.ch[data-id=ch4] .fader`); const tr=await rect(`.ch[data-id=ch4] .ftrack`);
const cx=tr.x+tr.w/2; const y0=tr.y+tr.h*(1-0.75); const y1=tr.y+tr.h*(1-0.35);
await c.mouse('mouseMoved',cx,y0); await c.mouse('mousePressed',cx,y0);
for(let i=1;i<=8;i++) await c.mouse('mouseMoved',cx,y0+(y1-y0)*i/8,{buttons:1});
await c.mouse('mouseReleased',cx,y1); await c.sleep(600);
const g4=await ch('ch4','gain'); ok('Fader-Drag → Node-Gain ≈ −20 dB', Math.abs(g4+20)<3, 'gain='+g4);
// Doppelklick = 0 dB
await c.mouse('mousePressed',cx,y1); await c.mouse('mouseReleased',cx,y1); await c.mouse('mousePressed',cx,y1,{clickCount:2}); await c.mouse('mouseReleased',cx,y1,{clickCount:2}); await c.sleep(600);
ok('Doppelklick auf Fader → 0 dB', Math.abs(await ch('ch4','gain'))<0.2, 'gain='+await ch('ch4','gain'));

// 3) Select + Center-Tab + EQ-Handle ziehen
await c.ev(`${A}.select('ch2',{open:true})`); await c.sleep(300);
ok('Auswahl öffnet Center für Gast 1', (await c.ev(`${A}.center.title.textContent`))==='Gast 1');
await c.ev(`${A}.center.setTab('eq')`); await c.sleep(500);
const cv=await rect('canvas.eqplot'); ok('EQ-Canvas sichtbar', cv && cv.w>100, JSON.stringify(cv));
await c.ev(`${A}.cur().proc.eqMidFreq`);
const hx=cv.x+cv.w*(Math.log10(1000/20)/3), hy=cv.y+cv.h/2;
await c.mouse('mouseMoved',hx,hy); await c.mouse('mousePressed',hx,hy);
for(let i=1;i<=6;i++) await c.mouse('mouseMoved',hx+30*i/6,hy-40*i/6,{buttons:1});
await c.mouse('mouseReleased',hx+30,hy-40); await c.sleep(700);
const eg=await ch('ch2','eqMid'), ef=await ch('ch2','eqMidFreq'); ok('EQ-Handle ziehen → Gain>0 und Freq geändert (live am Node)', eg>2 && ef>1000, `gain=${eg} freq=${ef}`);
// HP-Toggle
await c.ev(`${A}.shadow.querySelectorAll('.csec .tog.wide')[1].click()`); await c.sleep(500);
ok('HP-Toggle → eqHpEnabled=true', (await ch('ch2','eqHpEnabled'))===true);

// 4) Comp-Slider per Maus
await c.ev(`${A}.center.setTab('comp')`); await c.sleep(400);
const s0=await rect('.srange');
await c.mouse('mouseMoved',s0.x+5,s0.y+s0.h/2);
const sl=JSON.parse(await c.ev(`JSON.stringify([...${A}.shadow.querySelectorAll('.cbody .slider')].map(e=>{const r=e.querySelector('.srange').getBoundingClientRect();return {l:e.querySelector('label').textContent,x:r.x,y:r.y,w:r.width,h:r.height}}))`));
const thr=sl.find(x=>x.l==='Threshold');
await c.mouse('mousePressed',thr.x+thr.w*0.5,thr.y+thr.h/2); await c.mouse('mouseReleased',thr.x+thr.w*0.5,thr.y+thr.h/2); await c.sleep(600);
ok('Comp-Threshold-Slider (Mitte) → ≈ −30 dB', Math.abs(await ch('ch2','compThreshold')+30)<2.5, 'thr='+await ch('ch2','compThreshold'));
await c.ev(`${A}.shadow.querySelector('.cbody .tog.wide').click()`); await c.sleep(500);
ok('Kompressor aktiv-Toggle → compEnabled=true', (await ch('ch2','compEnabled'))===true);

// 5) Tastatur: Pfeil rechts wählt nächsten Kanal, M mutet
await c.ev(`${A}.root.focus()`); 
await c.ev(`${A}.root.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,composed:true}))`); await c.sleep(200);
ok('Pfeil rechts → nächster Kanal (Gast 2)', (await c.ev(`${A}.ui.selected`))==='ch3');
await c.ev(`${A}.root.dispatchEvent(new KeyboardEvent('keydown',{key:'m',bubbles:true,composed:true}))`); await c.sleep(500);
ok('Taste M → Gast 2 stumm', (await ch('ch3','mute'))===true);
await c.ev(`${A}.root.dispatchEvent(new KeyboardEvent('keydown',{key:'m',bubbles:true,composed:true}))`); await c.sleep(500);

// 6) Layoutwechsel verändern den Audio-State nicht
for(const p of ['compact','dense','grid','touch','desktop','auto']){ await c.ev(`${A}.setPreset('${p}')`); await c.sleep(150); }
await c.ev(`${A}.toggleFaders()`); await c.ev(`${A}.toggleFaders()`); await c.ev(`${A}.setMode('operate')`); await c.ev(`${A}.setMode('mix')`);
await c.viewport(390,844,true); await c.sleep(300); await c.viewport(844,390,true); await c.sleep(300); await c.viewport(1500,900,false); await c.sleep(300);
// zuerst die oben bewusst gesetzten Änderungen zurücknehmen (gain ch4 =0 schon; ch2 EQ/Comp)
const after=await snap();
const strip=(s)=>JSON.parse(s).filter(x=>!['ch2'].includes(x[0]));
ok('Layout-/Präferenzwechsel: Audio-State (alle anderen Kanäle) unverändert', JSON.stringify(strip(before))===JSON.stringify(strip(after)));
// Fader ausgeblendet → Wert bleibt (Gast 1 hat −7.3 dB)
await c.ev(`${A}.setPreset('grid')`); await c.ev(`${A}.ui.showFaders=false; ${A}.layoutNow(true)`); await c.sleep(200);
const hidden=await c.ev(`getComputedStyle(${A}.shadow.querySelector('.ch[data-id=ch2] .fader')).display`);
await c.ev(`${A}.ui.showFaders=true; ${A}.layoutNow(true)`); await c.sleep(300);
ok('Fader unsichtbar (display none) aber im DOM; danach exakt −7.3 dB', hidden==='none' && (await c.ev(`${A}.shadow.querySelector('.ch[data-id=ch2] .fader').getAttribute('aria-valuenow')`))==='-7.3', 'hidden='+hidden);

// 7) Gruppe stumm (UI-Button) + Szene aktivieren (Toolbar)
const gb=await rect('.gmute'); 
await c.mouse('mousePressed',gb.x+5,gb.y+5); await c.mouse('mouseReleased',gb.x+5,gb.y+5); await c.sleep(700);
const gs=await param('groups'); ok('Gruppe-stumm-Klick → Node-Gruppe muted', gs[0].mute===true);
await c.mouse('mousePressed',gb.x+5,gb.y+5); await c.mouse('mouseReleased',gb.x+5,gb.y+5); await c.sleep(700);
await c.ev(`${A}.shadow.querySelector('.scenebar .tb').click()`); await c.sleep(700);
ok('Szenen-Button aktiviert Szene (Kontext zeigt aktive Szene)', (await param('audioContext')).activeScene==='s'+(await param('scenes'))[0].id.slice(1));
console.log(fails?`\n${fails} FAILED`:'\nALL PASSED'); c.close();
