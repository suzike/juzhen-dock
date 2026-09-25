/* ============================================================
   补丁 42 的量化验证：界面透明度

   看图只能看出"好像有变化"，这里把数字读出来：
     1. --card / --panel-bg / --paper-3 在三档（30/60/100）下的实际计算值；
     2. 真卡片元素（.fcard / .gcard / .qa 等）的 computed background-color
        是否真的跟着变 —— 这比"我改了 CSS"有力得多；
     3. 设置页顶部那段看起来像被裁坏的残影到底是什么元素。
     4. 上界 .94 的意义：100% 时面板底必须 < 1，否则所有面挤平。

   用法：node _probe30.js
   ============================================================ */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = __dirname;
const chrome = 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe';
const outDir = path.join(dir, '_shots18');
fs.mkdirSync(outDir, { recursive: true });
const base = fs.readFileSync(path.join(dir, 'prototype.html'), 'utf8');

/* 注意：DRIVER 必须是**函数表达式**（外面再包一层调用）。
   第一版把它当成语句块拼进 try 里，而它自己带一个 return ——
   展开后变成 "var r=function cssv(){…} … return JSON.stringify(o); return r;"
   后面的 return 够不着，函数还全丢在块里，于是每次都是 "cssv is not defined"。
   这种"拼出来的代码只在运行时才暴露结构错误"的坑，在这项目上已经不止一次。 */
const DRIVER = `function(){
function cssv(k){ return getComputedStyle(document.documentElement).getPropertyValue(k).trim(); }
function bgOf(sel){
  var el = document.querySelector(sel);
  return el ? getComputedStyle(el).backgroundColor : '(没有这个元素)';
}
var o = {};
o.card       = cssv('--card');
o.panelBg    = cssv('--panel-bg');
o.sideBg     = cssv('--side-bg');
o.surf       = cssv('--surf');
o.surf2      = cssv('--surf-2');
o.pop        = cssv('--pop');
o.paper3     = cssv('--paper-3');
o.blur       = cssv('--blur-panel');
o.meas = {};
document.querySelectorAll('.glass-demo,.gd-panel,.gd-card').forEach(function(el,i){
  o.meas['预览' + i] = getComputedStyle(el).backgroundColor;
});
return JSON.stringify(o);
}`;

const probe = v => '(function(){applyGlass(' + v + ');syncGlass(' + v + ');'
  + 'var r=(' + DRIVER + ')();return r;})()';

function run(page, expr, tag){
  const src = path.join(dir, '_probe30_' + tag + '.html');
  /* Chrome 无头没有"把变量带回来"的通道，所以把结果写进 <pre> 再 --dump-dom 读回来 */
  fs.writeFileSync(src, base.replace('</body>',
    '\n<script>window.addEventListener("load",function(){setTimeout(function(){'
    + 'var OUT;try{openPanel();'
    /* pinned 会在 localStorage 里被上一次探针留下来，于是每次截图顶上
       都多一条 pin-bar。它本身是对的（用户真开了盯住就该有），
       只是不该干扰这一轮的读数与对照图 —— 这里显式收掉。 */
    + 'var pb=document.querySelector(".pin-bar"); if(pb) pb.style.display="none";'
    + 'OUT=' + expr + ';}catch(e){OUT="ERR "+e.message}'
    + 'var d=document.createElement("pre");d.id="__probe";d.textContent=String(OUT);'
    + 'document.body.appendChild(d);},900);});<\/script>\n</body>'), 'utf8');
  const out = cp.execFileSync(chrome, ['--headless=old', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=2600', '--dump-dom',
    'file:///' + src.replace(/\\/g, '/') + '#theme=sunny&page=' + page + '&noOnboard=1'],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  fs.unlinkSync(src);
  const m = out.match(/<pre id="__probe">([\s\S]*?)<\/pre>/);
  return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '(没拿到)';
}

const lines = [];
lines.push('=== 界面透明度 · 三档实测（sunny 主题）===');
lines.push('');
[30, 60, 100].forEach(v => {
  const raw = run('settings', probe(v), 'g' + v);
  let o = null;
  try { o = JSON.parse(raw); } catch (e) { lines.push('glass=' + v + ' → 解析失败：' + raw.slice(0, 200)); return; }
  lines.push('--- glass = ' + v + '% ---');
  lines.push('  --panel-bg : ' + o.panelBg);
  lines.push('  --side-bg  : ' + o.sideBg);
  lines.push('  --surf     : ' + o.surf);
  lines.push('  --surf-2   : ' + o.surf2);
  lines.push('  --card     : ' + o.card);
  lines.push('  --pop      : ' + o.pop);
  lines.push('  --paper-3  : ' + o.paper3);
  lines.push('  --blur     : ' + o.blur);
  lines.push('  预览块实测 : ' + JSON.stringify(o.meas));
  lines.push('');
});

/* 真卡片元素是否跟着变（用卡片最多的两个页面） */
lines.push('=== 真卡片元素的 computed 背景色（60% vs 30%）===');
const pick = 'JSON.stringify({'
  + '"分组大卡 .gcard":bgOf(".gcard"),'
  + '"文件夹卡 .fcard":bgOf(".fcard"),'
  + '"暂存卡 .scard":bgOf(".scard"),'
  + '"设置行容器 .set-row自无底":bgOf(".set-row"),'
  + '"说明条 .note":bgOf(".note"),'
  + '"分段控件 .seg":bgOf(".seg")})';
[60, 30].forEach(v => {
  const raw = run('folders', '(function(){applyGlass(' + v + ');'
    + 'function bgOf(s){var el=document.querySelector(s);'
    + 'return el?getComputedStyle(el).backgroundColor:"(没有这个元素)";}'
    + 'return ' + pick + ';})()', 'e' + v);
  lines.push('glass=' + v + '% → ' + raw);
});
lines.push('');
lines.push('=== 覆盖面的量化：整页扫一遍"半透明白面"有多少种 alpha ===');
lines.push('（原 #fff 的卡片在 60% 下应该全部变成 .98 那一档；');
lines.push('  仍留在 1 的只应该是被排除的控件/标记）');
[[60, 'a60'], [30, 'a30']].forEach(([v, tag]) => {
  const raw = run('folders',
    '(function(){applyGlass(' + v + ');'
    + 'var tally={},ex=[];'
    + 'document.querySelectorAll(\'.page[data-page="folders"] *\').forEach(function(el){'
    + '  var bg=getComputedStyle(el).backgroundColor;'
    + '  var m=/^rgba?\\((\\d+), (\\d+), (\\d+)(?:, ([\\d.]+))?\\)$/.exec(bg);'
    + '  if(!m) return;'
    + '  if(!(m[1]==="255"&&m[2]==="255"&&m[3]==="255")) return;'
    + '  var a=m[4]===undefined?"1":m[4];'
    + '  tally[a]=(tally[a]||0)+1;'
    + '  if(ex.length<12 && a!=="1" && parseFloat(a)>=0.9){'
    + '    ex.push((el.className||el.tagName)+" → alpha " + a'
    + '      + " | inline=(" + (el.getAttribute("style")||"无") + ")"'
    + '      + " | " + String(el.outerHTML).replace(/\\s+/g," ").slice(0,110));'
    + '  }'
    + '});'
    + 'return "glass=' + v + '% 白色面 alpha 分布：" + JSON.stringify(tally)'
    + '  + "\\n  非纯白样例：" + ex.join(" | ");})()', tag);
  lines.push(raw);
});

lines.push('');
lines.push('=== 诊断：那两个"没跟着变"的按钮到底读到了什么 --card ===');
{
  const raw = run('folders',
    '(function(){applyGlass(30);'
    + 'var out=[];'
    + '["\.ph-act",\'.acts-row button\'].forEach(function(sel){'
    + '  var el=document.querySelector(sel);'
    + '  if(!el){ out.push(sel+" : 没有这个元素"); return; }'
    + '  out.push("选择器 " + sel + "  →  " + el.tagName + " class=" + (el.className||"(空)"));'
    + '  out.push("   computed background : " + getComputedStyle(el).backgroundColor);'
    + '  out.push("   transition-duration : " + getComputedStyle(el).transitionDuration'
    + '    + "   ← 有过渡的元素此刻读到的还是**起始值**，不是没吃到变量");'
    + '  out.push("   它的 --card        : " + getComputedStyle(el).getPropertyValue("--card"));'
    + '  var p=el.parentElement, chain=[], n=0;'
    + '  while(p && n<7){'
    + '    var cv=getComputedStyle(p).getPropertyValue("--card");'
    + '    chain.push((p.className||p.tagName)+"=" + (cv||"(无)"));'
    + '    p=p.parentElement; n++;'
    + '  }'
    + '  out.push("   父链上的 --card     : " + chain.join("  ↑  "));'
    + '});'
    + 'out.push("");'
    + 'out.push("html 内联 style 里的 --card : " + (document.documentElement.style.getPropertyValue("--card")||"(没设)"));'
    + 'out.push("html computed 的 --card     : " + getComputedStyle(document.documentElement).getPropertyValue("--card"));'
    + 'return out.join("\\n");})()', 'diag');
  lines.push(raw);
}

lines.push('');
lines.push('=== 模拟拖一次滑杆：过渡有没有被掐掉、松手有没有落盘 ===');
{
  const raw = run('folders',
    '(function(){'
    + 'var out=[];'
    + 'var r=document.querySelector(\'input[data-range="glass"]\');'
    + 'if(!r){return "没找到透明度滑杆";}'
    + 'var btn=document.querySelector(".ph-act");'
    + 'function cls(){return document.documentElement.className||"(无类)";}'
    + 'function bg(el){return getComputedStyle(el).backgroundColor;}'
    + 'out.push("起始：" + r.value + "% · html class=" + cls()'
    + '  + " · .ph-act 背景=" + bg(btn));'
    /* 逐像素发值：滑到 30 */
    + 'r.value=30;r.dispatchEvent(new Event("input",{bubbles:true}));'
    + 'out.push("input 到 30 之后：html class=" + cls()'
    + '  + " · .ph-act 背景=" + bg(btn) + "   ← 现在应当立刻是新值");'
    /* 松手 */
    + 'r.dispatchEvent(new Event("change",{bubbles:true}));'
    + 'out.push("松手 change 之后：html class=" + cls());'
    + 'try{'
    + '  var s=JSON.parse(localStorage.getItem("juzhen.settings.v2")||"{}");'
    + '  out.push("localStorage 里的 glass = " + (s.glass===undefined?"(没写!)":s.glass));'
    + '}catch(e){out.push("读存档失败 "+e.message);}'
    + 'return out.join("\\n");})()', 'drag');
  lines.push(raw);
}

lines.push('');
lines.push('=== 「界面透明度」这个入口在设置页里的位置 ===');
{
  const raw = run('settings',
    '(function(){'
    + 'var cards=[].slice.call(document.querySelectorAll(\'.page[data-page="settings"] .gcard\'));'
    + 'var idx=-1,nm="";'
    + 'cards.forEach(function(c,i){ var t=c.querySelector(".gcard-t,.gcard-h");'
    + '  if(c.textContent.indexOf("界面透明度")>=0){ idx=i; } });'
    + 'var gl=document.querySelector(".gcard .glass-demo");'
    + 'var sl=document.querySelector(\'.gcard input[data-range="glass"]\');'
    + 'var inCard = sl ? (sl.closest(".gcard")===gl.closest(".gcard")) : false;'
    + 'return "设置页共 " + cards.length + " 张卡；界面透明度是第 " + (idx+1) + " 张"'
    + '  + "（1 起数）· 预览块与滑杆在同一张卡里 = " + inCard'
    + '  + " · 滑杆 min/max/step = " + (sl?sl.min+"/"+sl.max+"/"+sl.step:"无")'
    + '  + " · 当前值 = " + (sl?sl.value:"无");})()', 'entry');
  lines.push(raw);
}

const f = path.join(dir, '_probe30.txt');
fs.writeFileSync(f, lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
console.log('\n已写入 _probe30.txt');
