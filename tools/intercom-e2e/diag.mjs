import fs from 'node:fs';
import { openTab, sleep } from './cdp.mjs';
const NODE='http://127.0.0.1:9450', CDP=9333;
const inject = fs.readFileSync(new URL('./inject.js', import.meta.url), 'utf8');
async function panel(token){const tab=await openTab(CDP,'about:blank');await tab.send('Page.enable');await tab.send('Page.addScriptToEvaluateOnNewDocument',{source:inject});await tab.send('Page.navigate',{url:`${NODE}/panel?token=${token}`});await sleep(600);await tab.evaluate("document.getElementById('go').click()");for(let i=0;i<40;i++){if(await tab.evaluate("!!(window.__ic&&window.__ic.state&&window.__ic.pc&&window.__ic.pc.connectionState==='connected')"))return tab;await sleep(250);}throw new Error('no');}
const A=await panel('tA'),B=await panel('tB');
await A.evaluate("window.__ic.send({t:'talk',ch:1,on:true})");await A.evaluate('window.__tone(true)');await sleep(1500);
console.log(JSON.stringify(await (await fetch(NODE+'/status')).json(),null,1));
for (const [n,t] of [['A',A],['B',B]]) {
  const s = await t.evaluate(`(async()=>{const r=await window.__ic.pc.getStats();const o=[];r.forEach(x=>{if(x.type==='inbound-rtp'||x.type==='outbound-rtp')o.push({type:x.type,kind:x.kind,packets:x.packetsReceived??x.packetsSent,bytes:x.bytesReceived??x.bytesSent,energy:x.totalAudioEnergy})});return o})()`);
  console.log(n, JSON.stringify(s));
}
await A.close();await B.close();
