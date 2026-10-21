import fs from 'node:fs';
import { openTab, sleep } from './cdp.mjs';
const NODE='http://127.0.0.1:9450', CDP=9333, out=process.argv[2];
const inject = fs.readFileSync(new URL('./inject.js', import.meta.url), 'utf8');
const cfg={channels:[{id:1,name:'Regie',color:'#d1242f'},{id:2,name:'Technik',color:'#1f6feb'},{id:3,name:'IFB Moderator',kind:'ifb'}],
 parties:[{id:1,name:'Regie 1',token:'tA',force:true,routes:[{ch:1,talk:true,listen:true},{ch:2,talk:true,listen:true},{ch:3,talk:true}]},
 {id:2,name:'Kamera 1',token:'tB',routes:[{ch:1,talk:true,listen:true}]},{id:3,name:'Technik 1',token:'tC',routes:[{ch:2,talk:true,listen:true}]}]};
await fetch(NODE+'/config',{method:'PUT',body:JSON.stringify(cfg)});
async function panel(token,w,h){const tab=await openTab(CDP,'about:blank');await tab.send('Page.enable');if(w)await tab.send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:true});await tab.send('Page.addScriptToEvaluateOnNewDocument',{source:inject});await tab.send('Page.navigate',{url:`${NODE}/panel?token=${token}`});await sleep(500);await tab.evaluate("document.getElementById('go').click()");for(let i=0;i<40;i++){if(await tab.evaluate("!!(window.__ic&&window.__ic.state&&window.__ic.pc&&window.__ic.pc.connectionState==='connected')"))return tab;await sleep(250);}throw new Error('no');}
const B=await panel('tB'), C=await panel('tC');
const A=await panel('tA',390,860);
await A.evaluate("window.__ic.send({t:'talk',ch:2,on:true})");
await B.evaluate("window.__ic.send({t:'talk',ch:1,on:true})"); await B.evaluate('window.__tone(true)'); await sleep(900);
const r=await A.send('Page.captureScreenshot',{}); fs.writeFileSync(out,Buffer.from(r.data,'base64'));
for(const t of [A,B,C]) await t.close();
