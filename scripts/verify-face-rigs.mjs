import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { hash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFaceRig } from '../src/avatar/face-rig.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const {deformFaceRig}=runInNewContext(readFileSync(join(root,'client/client.js'),'utf8')+';({deformFaceRig})',{window:{__ModuleLoader__:{load(){}}}});
const report=[];
for(const role of ['xiaxia','lubai','guyu','beila']) {
  const dir=join(root,'data/models/eciyuan-'+role);
  const m=validateFaceRig(JSON.parse(readFileSync(join(dir,'face-rig.json'),'utf8')),hash('sha256',readFileSync(join(dir,'portrait-frame.png'))));
  const neutral=deformFaceRig(m,{});
  for(let i=0;i<neutral.length;i++)assert.ok(Math.abs(neutral[i]-m.points[i])<.0001,role+' neutral changed');
  const area=(p,a,b,c)=>(p[b*2]-p[a*2])*(p[c*2+1]-p[a*2+1])-(p[b*2+1]-p[a*2+1])*(p[c*2]-p[a*2]);
  const base=[];for(let i=0;i<m.indices.length;i+=3)base.push(area(m.points,...m.indices.slice(i,i+3)));
  let combinations=0,folds=0;
  for(const polarity of [1,-1])for(let mask=0;mask<128;mask++) {
    const controls=Object.fromEntries(Object.keys(m.targets).map((name,i)=>[name,(mask>>i&1)*(name==='smile'||name.startsWith('brow')?polarity:1)]));
    const p=deformFaceRig(m,controls);combinations++;
    for(let i=0;i<m.indices.length;i+=3)if(area(p,...m.indices.slice(i,i+3))*base[i/3]<-1e-7)folds++;
  }
  report.push({role,vertices:m.points.length/2,triangles:m.indices.length/3,combinations,folds});
}
console.log(JSON.stringify(report,null,2));
if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(report,null,2));
assert.ok(report.every(r=>r.folds===0),'One or more facial expressions inverted skin triangles');
