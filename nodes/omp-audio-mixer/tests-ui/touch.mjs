import {connect} from './cdp.mjs';
const c=await connect();
const NODE=process.env.MIXER_NODE||'http://127.0.0.1:9791';
const ch=async(id,p)=>(await (await fetch(`${NODE}/params/channel.${id}.${p}`)).json()).value;
const A=`document.querySelector('omp-audio-mixer-panel').app`;
const rect=async(sel)=>JSON.parse(await c.ev(`(()=>{const e=${A}.shadow.querySelector(${JSON.stringify(sel)}); if(!e) return 'null'; const r=e.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height})})()`));
let fails=0; const ok=(n,cond,x='')=>{console.log((cond?'PASS ':'FAIL ')+n+(x?'  '+x:'')); if(!cond) fails++;};
const touch=async(type,pts)=>c.send('Input.dispatchTouchEvent',{type,touchPoints:pts.map((p,i)=>({x:p[0],y:p[1],id:i}))});
await c.viewport(1180,820,true); await c.nav('http://127.0.0.1:18080/'); await c.ev(`localStorage.clear()`); await c.nav('http://127.0.0.1:18080/'); await c.sleep(2500);
await c.ev(`${A}.setPreset('touch')`); await c.sleep(500);
console.log('variant', await c.ev(`${A}.channelsEl.dataset.variant`), 'faders', await c.ev(`${A}.channelsEl.dataset.faders`));
// Touch-Ziele groß genug (≥44px)
const mute=await rect('.ch[data-id=ch1] .mute'); ok('Mute-Touch-Ziel ≥ 44 px', mute.h>=44&&mute.w>=44, `${Math.round(mute.w)}x${Math.round(mute.h)}`);
const selb=await rect('.ch[data-id=ch1] .sel'); ok('Select-Touch-Ziel ≥ 44 px', selb.h>=44&&selb.w>=44, `${Math.round(selb.w)}x${Math.round(selb.h)}`);
const tabs=await c.ev(`${A}.center.setTab('eq'), 1`); const tb=await rect('.tab'); ok('Center-Tab-Touch-Ziel ≥ 44 px', tb.h>=44, `${Math.round(tb.h)}px`);
// Tap auf Mute
await touch('touchStart',[[mute.x+mute.w/2,mute.y+mute.h/2]]); await touch('touchEnd',[]); await c.sleep(600);
ok('Tap auf MUTE → Node mute=true', (await ch('ch1','mute'))===true);
await touch('touchStart',[[mute.x+mute.w/2,mute.y+mute.h/2]]); await touch('touchEnd',[]); await c.sleep(500);
// horizontaler Fader (touchf): Wisch nach links auf dem Fader
await c.ev(`${A}.channelsEl.scrollTop=0`);
const tr=await rect('.ch[data-id=ch2] .ftrack'); const y=tr.y+tr.h/2;
const g0=await ch('ch2','gain');
await touch('touchStart',[[tr.x+tr.w*0.75,y]]);
for(let i=1;i<=8;i++) await touch('touchMove',[[tr.x+tr.w*(0.75-0.3*i/8),y]]);
await touch('touchEnd',[]); await c.sleep(700);
const g1=await ch('ch2','gain'); ok('Horizontaler Touch-Wisch bewegt den Fader', g1<g0-5, `gain ${g0} → ${g1}`);
// vertikaler Wisch auf einem Fader scrollt die Liste, ändert den Fader NICHT
const before=await ch('ch3','gain'); const sc0=await c.ev(`${A}.channelsEl.scrollTop`);
const tr3=await rect('.ch[data-id=ch3] .ftrack'); const x3=tr3.x+tr3.w/2;
await touch('touchStart',[[x3,tr3.y+tr3.h/2]]);
for(let i=1;i<=10;i++) await touch('touchMove',[[x3,tr3.y+tr3.h/2-30*i]]);
await touch('touchEnd',[]); await c.sleep(600);
const sc1=await c.ev(`${A}.channelsEl.scrollTop`);
ok('Vertikaler Wisch über dem Fader ändert den Gain nicht', (await ch('ch3','gain'))===before, `gain=${await ch('ch3','gain')}`);
console.log('scrollTop',sc0,'→',sc1,'(Liste scrollbar:', await c.ev(`${A}.channelsEl.scrollHeight>${A}.channelsEl.clientHeight`),')');
// Vertikaler Wisch auf Kanalfläche (Name/Badges) scrollt
await c.ev(`${A}.channelsEl.scrollTop=0`); await c.sleep(200);
const nm=await rect('.ch[data-id=ch4] .badges'); const sc2=await c.ev(`${A}.channelsEl.scrollTop`);
await touch('touchStart',[[nm.x+nm.w/2,nm.y+nm.h/2]]); for(let i=1;i<=10;i++) await touch('touchMove',[[nm.x+nm.w/2,nm.y+nm.h/2-30*i]]); await touch('touchEnd',[]); await c.sleep(500);
const sc3=await c.ev(`${A}.channelsEl.scrollTop`); ok('Vertikaler Wisch auf Kanalfläche scrollt die Liste', sc3>sc2, `${sc2} → ${sc3}`);
// Long-Press auf Name öffnet Center Control (Touch)
await c.ev(`${A}.ui.centerOpen=false; ${A}.layoutNow()`);
const nb=await rect('.ch[data-id=ch5] .name'); await touch('touchStart',[[nb.x+10,nb.y+nb.h/2]]); await c.sleep(750); await touch('touchEnd',[]); await c.sleep(300);
ok('Langes Drücken auf Kanalname öffnet Center Control', (await c.ev(`${A}.ui.selected`))==='ch5' && (await c.ev(`${A}.ui.centerOpen`))===true);
// Reset
await c.ev(`${A}.cmd('channel.ch1.setMute',{muted:false})`);
console.log(fails?`\n${fails} FAILED`:'\nALL PASSED'); c.close();
