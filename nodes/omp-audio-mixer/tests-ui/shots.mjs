import {connect} from './cdp.mjs';
const c=await connect();
const sizes=JSON.parse(process.argv[2]);
await c.viewport(sizes[0][1],sizes[0][2],sizes[0][3]||false);
await c.nav('http://127.0.0.1:18080/');
await c.ev(`localStorage.clear()`);
await c.nav('http://127.0.0.1:18080/');
await c.sleep(2500);
for(const [name,w,h,mobile,setup] of sizes){
  await c.viewport(w,h,mobile||false);
  if(setup) await c.ev(setup);
  await c.sleep(1200);
  await c.shot(`${process.env.SHOT_DIR||'/tmp'}/${name}.png`);
  const info=await c.ev(`(()=>{const a=document.querySelector('omp-audio-mixer-panel').app; return JSON.stringify({layout:a.layout,variant:a.channelsEl.dataset.variant,faders:a.channelsEl.dataset.faders,center:a.root.dataset.center,hscroll:document.documentElement.scrollWidth>innerWidth})})()`);
  console.log(name,info);
}
c.close();
