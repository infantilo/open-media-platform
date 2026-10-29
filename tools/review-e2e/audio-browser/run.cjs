const puppeteer = require(process.env.PUPPETEER_CORE || 'puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: 'new', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage();
  p.on('console', m => console.log('console:', m.text()));
  p.on('response', r => { if (r.status() >= 400) console.log('HTTP', r.status(), r.url()); }); p.on('pageerror', e => console.log('PAGEERROR', e.message));
  await p.goto('http://127.0.0.1:18765/index.html');
  await p.waitForFunction('window.ready');
  const R = async (code) => p.evaluate(code);
  const res = {};
  await R(`a.unlock()`);
  console.log('state running:', await R(`a.ready`));
  // Spur 1 stummschalten → nur Spur 0 hörbar (Stille bis 1 s)
  await R(`a.setTrack(1, {on:false})`);
  await R(`a.prefetch(0.5)`); await new Promise(r => setTimeout(r, 800));
  // 1) Vorwärts ab 0,3 s: erst Stille, ab 1,0 s Ton
  await R(`a.start(0.3, 1)`);
  res.fwd_silent = await R(`maxRms(500)`);          // Medienzeit ~0,36–0,86
  await new Promise(r => setTimeout(r, 300));
  res.fwd_tone = await R(`maxRms(400)`);            // Medienzeit > 1,2
  await R(`a.stop()`);
  await new Promise(r => setTimeout(r, 150));
  res.after_stop = await R(`maxRms(200)`);
  // 2) Rückwärts ab 3,0 s: Ton (Medienzeit 3→1) hörbar
  await R(`a.start(3.0, -1)`);
  await new Promise(r => setTimeout(r, 250));
  res.rev_tone = await R(`maxRms(500)`);
  await R(`a.stop()`);
  await new Promise(r => setTimeout(r, 150));
  // 3) Scrub-Stück bei 2,0 s: kurz hörbar, danach still
  await R(`a.grain(2.0)`); 
  res.grain = await R(`maxRms(120)`);
  await new Promise(r => setTimeout(r, 200));
  res.grain_after = await R(`maxRms(150)`);
  // 4) Scrub vor dem Toneinsatz (0,5 s): still
  await R(`a.grain(0.5)`); res.grain_silence = await R(`maxRms(150)`);
  // 5) Spurwahl: Spur 0 aus, Spur 1 an → Dauerton 300 Hz bei 0,5 s hörbar
  await R(`a.setTrack(0, {on:false}); a.setTrack(1, {on:true})`);
  await new Promise(r => setTimeout(r, 100));
  await R(`a.grain(0.5)`); res.track1_at_0_5 = await R(`maxRms(900)`);
  // 6) Blockwechsel: Wiedergabe über 10 s hinweg ab 9,5 s
  await R(`a.start(9.5, 1)`);
  await new Promise(r => setTimeout(r, 300));
  res.cross_block_before = await R(`maxRms(300)`);
  await new Promise(r => setTimeout(r, 400));
  res.cross_block_after = await R(`maxRms(300)`);
  await R(`a.stop()`);
  console.log(JSON.stringify(res, null, 1));
  console.log('fetched:', JSON.stringify(await R('urls')));
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
