/* ============================================================
   补丁 43 的验证：窗口分区（渲染侧）

   看图能看出"有没有入口"，这里把**判据**读出来。要回答五件事：
     1. 设置页真有「分区方式」分段控件，而且它真的驱动 renderZones
        （以前全库没有任何逻辑读 pinLayout —— 那三个选项是假的）；
     2. 浏览器侧**不能有**「整理窗口 / 还原窗口」按钮：那要接管系统窗口
        编排，浏览器里做不到。有按钮 = 点了什么都不会发生 = 本项目明令禁止；
     3. 浏览器侧那两行必须是**如实说明**（naTag），不是功能说明；
     4. 「唤出边缘」在浏览器里仍是真控件（桌面版才固定右侧）；
     5. 点「四分格」之后分区演示真的变成 4 块（不是只改了 state 数字）。

   用法：node _probe31.js
   ============================================================ */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = __dirname;
const chrome = 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe';
const base = fs.readFileSync(path.join(dir, 'prototype.html'), 'utf8');

const DRIVER = `function(){
function txt(sel){ var e=document.querySelector(sel); return e?e.textContent.trim():null; }
function has(sel){ return !!document.querySelector(sel); }
var o = {};

/* 1. 两行都在？ */
o.有分区方式 = has('[data-seg="pinLayout"]');
o.有窗口编排行 = (function(){
  var r=[].slice.call(document.querySelectorAll('.set-row'));
  for(var i=0;i<r.length;i++){ if(r[i].textContent.indexOf('窗口编排')>=0) return true; }
  return false;
})();
o.分区方式选项 = (function(){
  var b=document.querySelectorAll('[data-seg="pinLayout"] button');
  return [].map.call(b,function(x){return x.getAttribute('data-val')+(x.className.indexOf('on')>=0?'*':'')});
})();

/* 2. 浏览器里**不该**有真按钮。
   ⚠ 不要用 outerHTML.indexOf('data-act="zone-') 去查 —— outerHTML 把
   <script> 的**源码**也串进来了，而源码里当然写着 data-act="zone-apply"。
   第一版就是这么写的，于是它恒为 true（一条恒红的灯）。要查就查真正的
   元素：选择器只认 DOM 节点，不认文本。 */
o.有整理按钮 = has('#zoneApply');
o.有还原按钮 = has('#zoneRestore');
o.DOM里zone动作元素数 = document.querySelectorAll('[data-act^="zone-"]').length;

/* 3. 如实说明 */
o.窗户编排那行的灰标签 = (function(){
  var r=[].slice.call(document.querySelectorAll('.set-row'));
  for(var i=0;i<r.length;i++){
    if(r[i].textContent.indexOf('窗口编排')>=0){
      var n=r[i].querySelector('.set-na');
      return n ? n.textContent.trim() : '(没有灰标签)';
    }
  }
  return '(没找到这一行)';
})();

/* 4. 唤出边缘仍然是真控件 */
o.唤出边缘选项 = (function(){
  var d=document.querySelector('[data-seg="edge"]');
  if(!d) return '(没有这个控件)';
  return [].map.call(d.querySelectorAll('button'),function(x){return x.getAttribute('data-val')});
})();

/* 5. 点「四分格」→ 演示真的变 4 块 */
try{ window.togglePin(true); }catch(e){ o.togglePin错误 = String(e.message); }
o.点之前块数 = document.querySelectorAll('#zones .zone').length;
try{ document.querySelector('[data-seg="pinLayout"] button[data-val="quad"]').click(); }catch(e){ o.点击错误 = String(e.message); }
o.点之后pinLayout = state.settings.pinLayout;
o.点之后块数 = document.querySelectorAll('#zones .zone').length;
o.点之后自由区分块 = document.querySelectorAll('#zones .free .zone').length;
o.分区说明 = txt('#pinLayout');
return JSON.stringify(o);
}`;

function run(tag, seed){
  const src = path.join(dir, '_probe31_' + tag + '.html');
  fs.writeFileSync(src, base.replace('</body>',
    '\n<script>window.addEventListener("load",function(){setTimeout(function(){'
    + 'var r;try{openPanel();' + (seed || '') + 'switchPage("settings");'
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

const r = run('main');

console.log('===== 浏览器原型（非桌面版）的分区两行 =====');
if (r.__missing){ console.log('★ 没读到结果 —— 驱动脚本没跑完（查 --virtual-time-budget 或异常）'); process.exit(1); }
if (r.__raw !== undefined){ console.log('驱动返回的不是 JSON：' + r.__raw); process.exit(1); }
Object.keys(r).forEach(k => console.log('  ' + k + ' = ' + JSON.stringify(r[k])));

let bad = 0;
const chk = (name, ok, note) => { if (!ok){ bad++; console.log('★ ' + name + (note ? '：' + note : '')); } };

console.log('\n===== 判据 =====');
chk('分区方式在', r.有分区方式 === true);
chk('窗口编排行在', r.有窗口编排行 === true);
chk('分区方式三个选项齐', Array.isArray(r.分区方式选项) && r.分区方式选项.length === 3
  && r.分区方式选项.indexOf('split3*') >= 0, JSON.stringify(r.分区方式选项));
chk('浏览器里没有「整理窗口」按钮（否则就是假按钮）', r.有整理按钮 === false);
chk('浏览器里没有「还原窗口」按钮', r.有还原按钮 === false);
chk('DOM 里没有 data-act="zone-*" 的元素', r.DOM里zone动作元素数 === 0, '实际 ' + r.DOM里zone动作元素数);
chk('「窗口编排」那一行是如实说明', String(r.窗户编排那行的灰标签).indexOf('浏览器') >= 0, r.窗户编排那行的灰标签);
chk('「唤出边缘」在浏览器里仍是真控件（两个选项）',
  Array.isArray(r.唤出边缘选项) && r.唤出边缘选项.length === 2, JSON.stringify(r.唤出边缘选项));

/* 第五组：点一下四分格，演示要真的变成 4 块。
   注意点之前是 1（host）+ 2（split3 的两块）= 3。 */
chk('默认 split3 → #zones 里 3 个块', r.点之前块数 === 3, '实际 ' + r.点之前块数);
chk('点「四分格」后 state 变了', r.点之后pinLayout === 'quad', '实际 ' + r.点之后pinLayout);
chk('点「四分格」后演示真的变 4 块（1 host + 4）', r.点之后块数 === 5, '实际 ' + r.点之后块数);
chk('四个都在自由区里', r.点之后自由区分块 === 4, '实际 ' + r.点之后自由区分块);
chk('分区说明跟着改了口径', String(r.分区说明).indexOf('四分格') >= 0, r.分区说明);

console.log(bad ? '\n★ 不通过 ' + bad + ' 项' : '\n全绿');
process.exit(bad ? 1 : 0);
