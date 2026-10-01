import WebSocket from 'ws';
import fs from 'fs';
export async function connect(port=9333){
  const list=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t=list.find(x=>x.type==='page'); const ws=new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r=>ws.on('open',r)); let id=0; const waits=new Map(); const listeners=[];
  ws.on('message',m=>{const d=JSON.parse(m); if(d.id&&waits.has(d.id)){waits.get(d.id)(d);waits.delete(d.id)} else listeners.forEach(f=>f(d))});
  const send=(method,params={})=>new Promise(r=>{const i=++id;waits.set(i,r);ws.send(JSON.stringify({id:i,method,params}))});
  const api={ws,send,
    async ev(expr){const r=await send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true}); if(r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description||r.result.exceptionDetails)); return r.result.result.value},
    async nav(url){await send('Page.enable'); const p=new Promise(res=>{const f=d=>{if(d.method==='Page.loadEventFired'){res()}};listeners.push(f)}); await send('Page.navigate',{url}); await p;},
    async viewport(w,h,mobile=false){await send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile}); await send('Emulation.setTouchEmulationEnabled',{enabled:mobile});},
    async shot(path){const r=await send('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(path,Buffer.from(r.result.data,'base64'));},
    sleep:(ms)=>new Promise(r=>setTimeout(r,ms)),
    mouse:async(type,x,y,extra={})=>send('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1,...extra}),
    close(){ws.close()}};
  return api;
}
