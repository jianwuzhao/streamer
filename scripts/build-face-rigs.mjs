import { execFileSync } from 'node:child_process';
import { hash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
const root=fileURLToPath(new URL('../',import.meta.url));
const temp=mkdtempSync(join(tmpdir(),'dafeiyu-face-build-'));
let browser;
try {
  const executable=join(temp,'landmarks');
  execFileSync('xcrun',['swiftc','-O','-module-cache-path',join(temp,'cache'),join(root,'scripts/extract-face-landmarks.swift'),'-o',executable]);
  browser=await chromium.launch({executablePath:process.env.DAFEIYU_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const page=await browser.newPage();
  await page.goto('about:blank');
  await page.evaluate(()=>{window.__ModuleLoader__={load(){}}});
  await page.addScriptTag({path:join(root,'client/vendor/pixi.min.js')});
  await page.addScriptTag({path:join(root,'client/client.js')});
  const staged=[];
  for(const role of ['xiaxia','lubai','guyu','beila']) {
    const folder=join(root,'data/models/eciyuan-'+role), image=join(folder,'portrait-frame.png');
    const output=join(temp,role+'.json');
    execFileSync(executable,[image,output]);
    const source=JSON.parse(readFileSync(output,'utf8'));
    source.sourceSha256=hash('sha256',readFileSync(image));
    const model=await page.evaluate(source=>createFaceRigModel(source,PIXI.utils.earcut),source);
    if(!model.points.length||!model.indices.length||model.indices.some(i=>i<0||i>=model.points.length/2)) throw new Error(role+' mesh invalid');
    const folds=await page.evaluate(m=>{
      const area=(p,a,b,c)=>(p[b*2]-p[a*2])*(p[c*2+1]-p[a*2+1])-(p[b*2+1]-p[a*2+1])*(p[c*2]-p[a*2]);
      let folds=0;
      for(const polarity of [1,-1])for(let mask=0;mask<128;mask++) {
        const controls=Object.fromEntries(Object.keys(m.targets).map((k,i)=>[k,(mask>>i&1)*(k==='smile'||k.startsWith('brow')?polarity:1)]));
        const points=deformFaceRig(m,controls);
        for(let i=0;i<m.indices.length;i+=3){const ids=m.indices.slice(i,i+3);if(area(points,...ids)*area(m.points,...ids)<-1e-7)folds++;}
      }
      return folds;
    },model);
    if(folds)throw new Error(role+': '+folds+' inverted triangles; keeping installed models unchanged');
    writeFileSync(output,JSON.stringify(model)); staged.push({output,target:join(folder,'face-rig.json')});
    console.log(role+': '+model.points.length/2+' vertices, '+model.indices.length/3+' triangles, '+model.parts.length+' parts');
  }
  // Publish only after every identity has been constructed successfully.
  for(const {output,target} of staged) { writeFileSync(target+'.pending',readFileSync(output)); renameSync(target+'.pending',target); }
} finally { await browser?.close(); rmSync(temp,{recursive:true,force:true}); }
