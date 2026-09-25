/* ============================================================
   补丁 42 的验证：界面透明度是不是真的管住了**所有面**

   用户的原话是「透明度可调，指的是所有的，只要是这个软件所有的界面，
   包括里边的那个卡片模块都是可调的」。所以这里不能只验"滑杆能拖"，
   要逐个面把 alpha 读出来比一遍。

   为什么不能靠肉眼看截图：桌面底是浅奶油色，纸面本身也近白 ——
   30% 和 100% 两档在截图上差别很淡，"看着差不多"完全可能是真的没动。
   只有把 getComputedStyle 里的 alpha 读出来，才知道哪个面没跟上。

   判据：
     · 8 个面在 30→100 之间**都要变**（只要有一个不变，它就是写死的）；
     · 每个面随 GLASS 单调不减（允许被 clamp 到 1 之后持平）；
     · 100% 时 --panel-bg 恰好 .94 —— 这是**上界**，不是笔误：
       Math.min(1, …) 会在 g=1 时把"卡片 +.38 / 抬升 +.32"压平成同一个 1.0，
       材质就散成一张白纸了；
     · 100% 时 --card 必须**大于** --panel-bg（档差还在）；
     · 越透 → 模糊越大（越透越要靠模糊挡住底下的窗口）；
     · 真元素（.gcard）的 computed backgroundColor 也要跟着变 ——
       变量改了但没人用它，是这一轮要防的那种"算出来没人用"。

   用法：node _probe32.js
   ============================================================ */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = __dirname;
const chrome = 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe';
const base = fs.readFileSync(path.join(dir, 'prototype.html'), 'utf8');

const DRIVER = `function(){
var o = {};
var FACES = ['--panel-bg','--side-bg','--surf','--surf-2','--surf-solid','--card','--pop','--paper-3'];
function alphaOf(v){
  var m = String(v||'').match(/rgba?\\(([^)]+)\\)/);
  if (!m) return null;
  var p = m[1].split(',').map(function(x){ return parseFloat(x); });
  return p.length >= 4 ? p[3] : 1;
}
function snap(g){
  try { applyGlass(g); } catch(e){ return { __err: String(e.message) }; }
  var cs = getComputedStyle(document.documentElement), r = {};
  FACES.forEach(function(f){ r[f] = alphaOf(cs.getPropertyValue(f)); });
  r['--blur-panel'] = cs.getPropertyValue('--blur-panel').trim();
  return r;
}
o.faces = FACES;
o.s30 = snap(30); o.s60 = snap(60); o.s100 = snap(100);

/* 真元素也要跟着变（不是只改了变量没人用） */
var gc = document.querySelector('.gcard');
function domAlpha(el, g){
  if (!el) return null;
  applyGlass(g);
  return alphaOf(getComputedStyle(el).backgroundColor);
}
o.gcard30 = domAlpha(gc, 30);
o.gcard100 = domAlpha(gc, 100);

/* 回默认，别把 100 的状态留给后面的检查 */
try { applyGlass(60); } catch(e){}

o.默认glass = state.settings.glass;
o.卡片标题在 = (function(){
  var c = [].slice.call(document.querySelectorAll('.gcard'))
    .filter(function(x){ return x.textContent.indexOf('界面透明度') >= 0; });
  return c.length;
})();

var r = document.querySelector('[data-range="glass"]');
o.滑杆 = r ? { min:r.getAttribute('min'), max:r.getAttribute('max'),
               step:r.getAttribute('step'), value:r.value } : null;

/* 走用户那条路：设值 + 派发 input（applyGlass 挂在 input 上） */
try {
  r.value = 100; r.dispatchEvent(new Event('input', { bubbles:true }));
} catch(e){ o.滑杆驱动错误 = String(e.message); }
o.拖到100后面板底 = alphaOf(getComputedStyle(document.documentElement).getPropertyValue('--panel-bg'));
o.拖到100后数值显示 = (function(){ var v=document.querySelector('.glass-val'); return v?v.textContent.trim():null; })();

/* 预览块 */
o.预览块 = !!document.querySelector('.glass-demo');
o.预览里面有面板底与卡片 = !!document.querySelector('.glass-demo .gd-panel .gd-card');
o.预览说明 = (function(){ var e=document.querySelector('.glass-demo-cap'); return e?e.textContent.trim().slice(0,40):null; })();

/* 主题弹层里那个第二入口 */
try { var b=document.getElementById('btnTheme'); if(b) b.click(); } catch(e){}
o.弹层里有透明度行 = !!document.querySelector('.tpop-glass input[type=range]');
o.弹层里透明度文案 = (function(){ var e=document.querySelector('.tpop-glass'); return e?e.textContent.replace(/\\s+/g,' ').trim().slice(0,30):null; })();
return JSON.stringify(o);
}`;

function run(){
  const src = path.join(dir, '_probe32_drv.html');
  fs.writeFileSync(src, base.replace('</body>',
    '\n<script>window.addEventListener("load",function(){setTimeout(function(){'
    + 'var r;try{openPanel();switchPage("settings");'
    + 'var out=(' + DRIVER + ')();r=out;}catch(e){r="ERR "+e.message}'
    + 'var p=document.createElement("pre");p.id="__probe";p.textContent=r;document.body.appendChild(p);'
    + '},1100);});<\/script>\n</body>'), 'utf8');
  const html = cp.execFileSync(chrome, ['--headless=old', '--disable-gpu', '--dump-dom',
    '--window-size=900,1180', '--virtual-time-budget=4000',
    'file:///' + src.replace(/\\/g, '/') + '#page=settings&noOnboard=1'],
    { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  fs.unlinkSync(src);
  const m = html.match(/<pre id="__probe">([\s\S]*?)<\/pre>/);
  if (!m) return { __missing: true };
  const s = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  try { return JSON.parse(s); } catch (e){ return { __raw: s }; }
}

const r = run();
if (r.__missing){ console.log('★ 没读到结果 —— 驱动脚本没跑完'); process.exit(1); }
if (r.__raw !== undefined){ console.log('驱动返回的不是 JSON：' + r.__raw); process.exit(1); }

let bad = 0;
const chk = (n, ok, note) => { if (!ok){ bad++; console.log('★ ' + n + (note !== undefined ? '：' + note : '')); } };
const F = r.faces;
const a30 = r.s30, a60 = r.s60, a100 = r.s100;

console.log('===== 8 个面的 alpha（30% / 60% / 100%）=====');
F.forEach(f => {
  console.log('  ' + f.padEnd(14) + a30[f] + ' → ' + a60[f] + ' → ' + a100[f]);
});
console.log('  --blur-panel  ' + a30['--blur-panel'] + ' → ' + a60['--blur-panel'] + ' → ' + a100['--blur-panel']);

console.log('\n===== 判据 =====');
F.forEach(f => {
  const v = [a30[f], a60[f], a100[f]];
  chk(f + ' 会变（不是写死的）', v[0] !== v[2], JSON.stringify(v));
  chk(f + ' 单调不减', v[0] <= v[1] && v[1] <= v[2], JSON.stringify(v));
});
chk('100% 时 --panel-bg 恰好 .94（上界，防止档差被压平）', a100['--panel-bg'] === 0.94, a100['--panel-bg']);
chk('30% 时 --panel-bg 恰好 .30', a30['--panel-bg'] === 0.30, a30['--panel-bg']);
chk('60%（默认）时 --panel-bg 恰好 .60', a60['--panel-bg'] === 0.60, a60['--panel-bg']);
chk('100% 时卡片比面板底更实（档差还在，材质没散）',
  a100['--card'] > a100['--panel-bg'], '--card ' + a100['--card'] + ' vs --panel-bg ' + a100['--panel-bg']);
chk('越透模糊越大', parseFloat(a30['--blur-panel']) > parseFloat(a100['--blur-panel']),
  a30['--blur-panel'] + ' vs ' + a100['--blur-panel']);

chk('真元素 .gcard 的背景也跟着变（变量没白算）',
  r.gcard30 !== null && r.gcard100 !== null && r.gcard30 !== r.gcard100,
  r.gcard30 + ' → ' + r.gcard100);
chk('默认档位是 60', r.默认glass === 60, r.默认glass);
chk('设置页里有一张叫「界面透明度」的卡', r.卡片标题在 === 1, '找到 ' + r.卡片标题在 + ' 张');
chk('滑杆 min/max/step = 30/100/5',
  r.滑杆 && r.滑杆.min === '30' && r.滑杆.max === '100' && r.滑杆.step === '5',
  JSON.stringify(r.滑杆));
chk('拖到 100 后 --panel-bg 变 .94（input 这条路真的接上了）', r.拖到100后面板底 === 0.94, r.拖到100后面板底);
chk('数值显示同步成 100%', String(r.拖到100后数值显示) === '100%', r.拖到100后数值显示);
chk('预览块在（用户说"找不到入口"，预览是最直接的说明）', r.预览块 === true);
chk('预览块里同时有面板底和卡片两层', r.预览里面有面板底与卡片 === true);
chk('预览块带说明文字', !!r.预览说明, r.预览说明);
chk('主题弹层里也有一个透明度入口（第二处，更容易撞见）',
  r.弹层里有透明度行 === true, r.弹层里透明度文案);

console.log(bad ? '\n★ 不通过 ' + bad + ' 项' : '\n全绿（' + (F.length * 2 + 12) + ' 项）');
process.exit(bad ? 1 : 0);
