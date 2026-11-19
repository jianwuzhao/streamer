import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const destination=resolve(process.argv[2]||join(root,'artifacts/face-rigs'));
mkdirSync(destination,{recursive:true});
const names={xiaxia:'夏夏',lubai:'沈露白',guyu:'谷雨',beila:'贝拉'};
const models=Object.entries(names).map(([id,name])=>({id,name,
  model:JSON.parse(readFileSync(join(root,'data/models/eciyuan-'+id+'/face-rig.json'),'utf8')),
  image:'data:image/png;base64,'+readFileSync(join(root,'data/models/eciyuan-'+id+'/portrait-frame.png')).toString('base64'),
  audio:'data:audio/wav;base64,'+readFileSync(join(root,'data/role-voices/references/'+id+'.wav')).toString('base64'),
}));
const safeScript=s=>s.replace(/<\/script/gi,'<\\/script');
const core=readFileSync(join(root,'client/client.js'),'utf8').split('window.__ModuleLoader__.load(')[0];
const pixi=readFileSync(join(root,'client/vendor/pixi.min.js'),'utf8');
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>四角色面部模型验收</title>
<style>*{box-sizing:border-box}body{margin:0;padding:30px;background:#10191d;color:#e9f0ed;font:15px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}header{max-width:1500px;margin:auto}h1{font-size:28px;margin:0 0 8px}p{color:#acc0bb;margin:6px 0 18px}.controls{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}button{background:#233a38;color:#ecf6f2;border:1px solid #4c6862;border-radius:8px;padding:9px 15px;cursor:pointer;font:inherit}button:focus-visible{outline:3px solid #b7e2cd}button:hover{background:#35524c}button[aria-pressed=true]{background:#c1e4cf;color:#10231e}.grid{max-width:1500px;margin:24px auto;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}article{background:#1c2a2b;border:1px solid #334945;border-radius:16px;overflow:hidden}canvas{display:block;width:100%;aspect-ratio:3/4}article footer{padding:14px}h2{font-size:19px;margin:0}small{color:#b6c8c0}.sliders{display:flex;flex-wrap:wrap;gap:20px}label{display:grid;gap:4px}input{accent-color:#b9dfc9}.status{min-height:24px;color:#e1d1a1} @media(max-width:1000px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}</style>
<header><h1>四角色 · 完整面部网格</h1><p>保留原图纹理与现有外貌。下颌、脸颊、眉眼及口唇联动，牙齿、舌头为补建口腔几何。适用于固定机位的 2.5D 形象。</p><div class="controls" id="presets"></div><div class="sliders"><label>张嘴<input id="jaw" type="range" min="0" max="1" step="0.01" value="0"></label><label>左眼闭合<input id="blinkL" type="range" min="0" max="1" step="0.01" value="0"></label><label>右眼闭合<input id="blinkR" type="range" min="0" max="1" step="0.01" value="0"></label><label>嘴角<input id="smile" type="range" min="-0.35" max="0.35" step="0.01" value="0"></label></div><p class="status" id="status">中性状态 · 可分别检查五官和口型；本页不会连接直播间。</p></header><main class="grid" id="cards"></main>
<script>${safeScript(pixi)}</script><script>${safeScript(core)}</script><script>
const data=${JSON.stringify(models)};
let controls={},automatic=false,playback=null;const renderers=[];
const status=document.getElementById('status');
const presets={'中性':{},'张口 A':{jawOpen:.85},'圆唇 O':{jawOpen:.6,mouthRound:1},'微笑':{smile:.35,browLeft:.2,browRight:.2},'闭眼':{blinkLeft:1,blinkRight:1},'倾听':{browLeft:.2,browRight:.12},'连续演示':null};
function stop(){if(playback){try{playback.source.stop()}catch{}playback.context.close();playback=null}}
for(const [name,preset] of Object.entries(presets)){const button=document.createElement('button');button.textContent=name;button.setAttribute('aria-pressed',name==='中性');button.onclick=()=>{stop();automatic=preset===null;controls={...(preset||{})};for(const b of document.querySelectorAll('#presets button'))b.setAttribute('aria-pressed',String(b===button));status.textContent=name+' · 模型参数预览';syncSliders()};document.getElementById('presets').append(button)}
const sliderKeys={jaw:'jawOpen',blinkL:'blinkLeft',blinkR:'blinkRight',smile:'smile'};
function syncSliders(){for(const[id,key]of Object.entries(sliderKeys))document.getElementById(id).value=controls[key]||0}
for(const[id,key]of Object.entries(sliderKeys))document.getElementById(id).oninput=e=>{stop();automatic=false;controls[key]=Number(e.target.value);status.textContent='手动检查 · '+key;for(const b of document.querySelectorAll('#presets button'))b.setAttribute('aria-pressed','false')};
Promise.all(data.map(async record=>{
 const image=new Image();image.src=record.image;await image.decode();
 const face=createFaceRigRenderer(PIXI,record.model,image),canvas=document.createElement('canvas');canvas.width=480;canvas.height=640;
 const article=document.createElement('article'),foot=document.createElement('footer');article.append(canvas,foot);document.getElementById('cards').append(article);
 const heading=document.createElement('h2');heading.textContent=record.name;foot.append(heading);
 const small=document.createElement('small');small.textContent=record.model.points.length/2+' 顶点 · '+record.model.indices.length/3+' 三角面 · 15 个控制部位';foot.append(small);
 const button=document.createElement('button');button.textContent='用角色录音试听';button.style='display:block;margin-top:10px';foot.append(button);
 button.onclick=async()=>{stop();automatic=false;const context=new AudioContext();await context.resume();const bytes=await(await fetch(record.audio)).arrayBuffer();const buffer=await context.decodeAudioData(bytes);const source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);playback={context,source,buffer,start:context.currentTime,id:record.id};source.start();source.onended=()=>{if(playback?.source===source){stop();status.textContent='试听结束'}};status.textContent=record.name+' · 现有录音驱动，非直播同步验收'};
 const [x,y,r,b]=record.model.rect,fw=r-x,cx=(x+r)/2,cy=(y+b)/2;
 renderers.push({record,image,face,canvas,context:canvas.getContext('2d'),motion:createAvatarMotion(),scale:480/(fw*1.25),cx,cy});
})).then(()=>{window.__faceReady=true});
function draw(now){requestAnimationFrame(draw);for(const item of renderers){let current={...controls};if(automatic){const pose=item.motion(now,{listening:true,speaking:Math.floor(now/3500)%2===1,level:(Math.sin(now/130)+1)*.35,emotion:.2});current={...faceMouthControls(pose.opening,pose.form),blinkLeft:pose.blinkLeft,blinkRight:pose.blinkRight,smile:pose.expression,browLeft:pose.expression,gazeX:pose.gaze};}if(playback&&playback.id===item.record.id){const time=avatarPlaybackTime(playback.context,performance.now())-playback.start;const sample=avatarPcmFeatures(playback.buffer.getChannelData(0),playback.buffer.sampleRate,time);const pose=item.motion(now,{speaking:true,...sample});current={...faceMouthControls(pose.opening,pose.form),blinkLeft:pose.blinkLeft,blinkRight:pose.blinkRight};}item.face.update(current);const ctx=item.context;ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,480,640);ctx.setTransform(item.scale,0,0,item.scale,240-item.cx*item.scale,320-item.cy*item.scale);ctx.drawImage(item.image,0,0);item.face.draw(ctx);}}
requestAnimationFrame(draw);window.__faceInspect={data,renderers,setControls:value=>{stop();automatic=false;controls=value;syncSliders();status.textContent='指定表情参数 · 本地预览';for(const b of document.querySelectorAll('#presets button'))b.setAttribute('aria-pressed','false')}};
</script></html>`;
writeFileSync(join(destination,'index.html'),html);
console.log(join(destination,'index.html'));
