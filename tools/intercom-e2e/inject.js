// Ersetzt das Mikrofon durch einen steuerbaren Ton und misst am Hörer den ersten Ton (gleiche Browseruhr).
(() => {
  const ac = new AudioContext({ latencyHint: 'interactive' });
  const osc = ac.createOscillator(); osc.frequency.value = 700;
  const g = ac.createGain(); g.gain.value = 0;
  const dest = ac.createMediaStreamDestination();
  osc.connect(g).connect(dest); osc.start();
  navigator.mediaDevices.getUserMedia = async () => { await ac.resume(); return dest.stream; };
  const now = () => performance.timeOrigin + performance.now();
  window.__dest = dest;
  window.__tone = on => { g.gain.value = on ? 0.5 : 0; return now(); };
  let an = null, buf = null, heardAt = null, maxRms = 0, armedAt = 0, ctxIn = null;
  window.__arm = () => { heardAt = null; maxRms = 0; armedAt = now(); };
  window.__heard = () => ({ heardAt, maxRms });
  setInterval(() => {
    const out = document.getElementById('out');
    if (out && out.srcObject && !an) {
      ctxIn = new AudioContext(); ctxIn.resume();
      const src = ctxIn.createMediaStreamSource(out.srcObject);
      an = ctxIn.createAnalyser(); an.fftSize = 512; buf = new Float32Array(an.fftSize);
      src.connect(an);
    }
    if (!an) return;
    an.getFloatTimeDomainData(buf);
    let s = 0; for (const v of buf) s += v * v; const rms = Math.sqrt(s / buf.length);
    if (rms > maxRms) maxRms = rms;
    if (heardAt === null && rms > 0.03 && armedAt) heardAt = now();
  }, 2);
})();

// Referenz ohne Node: derselbe Ton über eine lokale Loopback-Verbindung zweier PeerConnections im Tab.
window.__loopbackRef = async (n = 10) => {
  const now = () => performance.timeOrigin + performance.now();
  const a = new RTCPeerConnection(), b = new RTCPeerConnection();
  a.onicecandidate = e => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = e => e.candidate && a.addIceCandidate(e.candidate);
  window.__dest.stream.getAudioTracks().forEach(t => a.addTrack(t, window.__dest.stream));
  const remote = new Promise(res => { b.ontrack = e => res(e.streams[0]); });
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  const stream = await remote;
  const el = new Audio(); el.srcObject = stream; el.play().catch(() => {});
  const ctx = new AudioContext(); await ctx.resume();
  const an = ctx.createAnalyser(); an.fftSize = 512; ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize);
  const rms = () => { an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; return Math.sqrt(s / buf.length); };
  window.__tone(true); await new Promise(r => setTimeout(r, 6000)); // einschwingen
  const out = [];
  for (let i = 0; i < n; i++) {
    window.__tone(false); await new Promise(r => setTimeout(r, 450));
    const t0 = window.__tone(true);
    let t = null;
    await new Promise(res => { const iv = setInterval(() => { if (rms() > 0.03) { t = now(); clearInterval(iv); res(); } else if (now() - t0 > 600) { clearInterval(iv); res(); } }, 2); });
    if (t) out.push(t - t0);
  }
  window.__tone(false); a.close(); b.close(); ctx.close();
  return out;
};
