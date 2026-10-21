// Minimaler CDP-Helfer (Muster aus den anderen e2e-Skripten): ein Browser, mehrere Tabs.
import { createRequire } from 'node:module';
const require = createRequire('/home/infantilo/node_modules/');
const WebSocket = require('ws');

export async function openTab(port, url) {
  const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const t = await r.json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(res => ws.on('open', res));
  let id = 0; const waiting = new Map(); const listeners = [];
  ws.on('message', d => { const m = JSON.parse(d); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else listeners.forEach(f => f(m)); });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; waiting.set(i, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  return { id: t.id, send, evaluate, close: async () => { ws.close(); await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`); }, on: f => listeners.push(f) };
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
