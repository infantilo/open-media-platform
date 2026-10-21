import fs from 'node:fs';
import { openTab, sleep } from './cdp.mjs';
const NODE='http://127.0.0.1:9450', CDP=9333;
const inject = fs.readFileSync(new URL('./inject.js', import.meta.url), 'utf8');
const tab=await openTab(CDP,'about:blank');await tab.send('Page.enable');await tab.send('Page.addScriptToEvaluateOnNewDocument',{source:inject});await tab.send('Page.navigate',{url:`${NODE}/panel?token=tA`});await sleep(600);await tab.evaluate("document.getElementById('go').click()");await sleep(2500);
console.log(await tab.evaluate("window.__ic.pc.remoteDescription.sdp"));
console.log(await tab.evaluate("window.__ic.pc.localDescription.sdp.split('\\n').filter(l=>/^(m=|a=(sendrecv|sendonly|recvonly|mid|rtpmap))/.test(l)).join('\\n')"));
await tab.close();
