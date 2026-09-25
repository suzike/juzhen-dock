/* 配色量化：逐页统计"可见元素上实际用到的背景色/文字色"有多少种。
   用户的判断标准是"看着花不花"，肉眼容易吵；这里给一个可比的数字：
   一屏里出现次数 ≥3 的不同色值有几种。

   ⚠ 但**"几种"本身不是判据**。上一版把它当门槛（"≤8 种"），那是个软启发：
   那一个主色会以 3 个明度档出现、中性墨色也会以好几档出现，数字天然就大，
   于是这个数字既不会因为"加了一个花花绿绿的色块"而明显变大，也不会因为
   "收敛干净了"而掉下去 —— 拿它当红绿线，等于给自己一个恒绿或恒红的灯。
   真正要看的是**有没有装饰性的外来色相**：饱和度够高、色相又明显偏离主题主色的
   那些。所以下面按 HSL 把每种颜色分类，把"偏离主色"的单独点出来让人逐个确认
   语义用途；中性色与同一色相的明暗档不参与。 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = __dirname;
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let html = fs.readFileSync(path.join(dir, 'prototype.html'), 'utf8');
const probe = `
<script>
window.addEventListener('load', function(){
  setTimeout(function(){
    var o = [], pre = document.createElement('pre'); pre.id = 'probe-out';
    document.body.appendChild(pre); o.push = function(s){ pre.textContent += String(s) + '\\n'; };
    var all = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };
    var vis = function(e){
      var r = e.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      var cs = getComputedStyle(e);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > .05;
    };
    try { openPanel(); } catch(e){}
    var pages = PAGES.map(function(p){ return p.id; });

    var TOTAL = {};
    pages.forEach(function(id){
      try { if (state.query) exitSearch(false); switchPage(id); } catch(e){}
      var boxes = {}, texts = {};
      all('.panel *').forEach(function(e){
        if (!vis(e)) return;
        var cs = getComputedStyle(e);
        var bg = cs.backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') boxes[bg] = (boxes[bg]||0)+1;
        var fg = cs.color;
        if (fg && e.textContent && e.textContent.trim()) texts[fg] = (texts[fg]||0)+1;
      });
      var bgTop = Object.keys(boxes).filter(function(k){ return boxes[k] >= 3; })
        .sort(function(a,b){ return boxes[b]-boxes[a]; });
      var fgTop = Object.keys(texts).filter(function(k){ return texts[k] >= 3; })
        .sort(function(a,b){ return texts[b]-texts[a]; });
      bgTop.forEach(function(k){ TOTAL[k] = true; });
      o.push(id.padEnd(9) + ' 背景色(≥3次) ' + bgTop.length + ' 种 · 文字色(≥3次) ' + fgTop.length + ' 种');
      o.push('          背景 ' + bgTop.slice(0,6).map(function(k){ return k.replace(/\\s/g,''); }).join('  '));
      o.push('          文字 ' + fgTop.slice(0,5).map(function(k){ return k.replace(/\\s/g,''); }).join('  '));
    });
    o.push('');
    o.push('=== 全站合计：出现≥3次的背景色 = ' + Object.keys(TOTAL).length + ' 种 ===');
    o.push(Object.keys(TOTAL).join('\\n'));

    /* 把"偏离主色的色相"单独点出来。判据是"有没有装饰性外来色相"，
       不是"总数小于几" —— 见文件头那段说明。 */
    function hueOf(c){
      var r = 0, g = 0, b = 0, m = String(c).match(/rgba?\\(([^)]+)\\)/);
      if (m){ var p = m[1].split(','); r = +p[0]; g = +p[1]; b = +p[2]; }
      else {
        var h = String(c).replace('#', '');
        if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
        r = parseInt(h.slice(0,2),16)||0; g = parseInt(h.slice(2,4),16)||0; b = parseInt(h.slice(4,6),16)||0;
      }
      r /= 255; g /= 255; b /= 255;
      var mx = Math.max(r,g,b), mn = Math.min(r,g,b), d = mx - mn;
      var hue = 0;
      if (d > 0.0001){
        if (mx === r) hue = 60 * (((g - b) / d) % 6);
        else if (mx === g) hue = 60 * ((b - r) / d + 2);
        else hue = 60 * ((r - g) / d + 4);
      }
      if (hue < 0) hue += 360;
      return { hue: Math.round(hue), sat: Math.round((mx ? d / mx : 0) * 100) };
    }
    /* 主色从哪读？documentElement 上读 --cb 读不到（applyTheme 把它写在别处），
       上一版因此退化成「主色 = 黑(0°,0%)」，于是所有暖色都被算成"偏离主色 27~42°"
       —— 一堆假警报。改成**从真元素读**：主色一定出现在分组图标/选中项图标上。
       读不到就如实说读不到，不拿 #000 硬凑一个"主色"。 */
    var mainEl = document.querySelector('.gcard-ico') || document.querySelector('.rbtn.on .ri');
    var mainSrc = mainEl ? String(getComputedStyle(mainEl).color || '') : '';
    var mainHue = mainSrc ? hueOf(mainSrc) : null;

    /* 判据是"有没有**冷色相**"。整套配色是暖色系（暖纸面 + 暖墨 + 一个暖主色），
       暖色系内部的明暗档差异本来就不算"花"；真正不该出现的是绿/青/蓝/紫这类
       跟主题不同族的色相。用暖冷分界（色相 90°–300° 算冷）比"离主色多少度"
       稳得多 —— 后者在主色偏暖时会把相邻的暖黄也算成外来。 */
    var cool = [], warmN = 0, neutralN = 0;
    Object.keys(TOTAL).forEach(function(k){
      var h = hueOf(k);
      if (h.sat < 12){ neutralN++; return; }
      if (h.hue > 90 && h.hue < 300) cool.push(k + '  →  色相 ' + h.hue + '° · 饱和 ' + h.sat + '%');
      else warmN++;
    });
    o.push('');
    o.push('=== 色相分类：中性 ' + neutralN + ' · 暖色系 ' + warmN + ' · 冷色相 ' + cool.length + ' ===');
    o.push('主色（读自 ' + (mainEl ? mainEl.className : '(没找到元素)') + '）= '
      + (mainSrc || '(没读到)')
      + (mainHue ? '  →  色相 ' + mainHue.hue + '° · 饱和 ' + mainHue.sat + '%'
                 : '  ← 主色没读到，上面的分类只看冷暖'));
    o.push(cool.length ? cool.join('\\n') : '（没有冷色相）');
    o.push('冷色相一旦出现就是外来色，必须能说出它的语义用途；说不出用途的才是"花"。');

    /* 关键元素的实测色（确认收敛真的落到了渲染上） */
    try { if (state.query) exitSearch(false); switchPage('folders'); } catch(e){}
    var gi = document.querySelector('.gcard-ico'), gc = document.querySelector('.gcard');
    var ri = document.querySelector('.rbtn .ri'), ron = document.querySelector('.rbtn.on .ri');
    var ic = document.querySelector('.row .ic');
    o.push('');
    o.push('=== 关键元素实测 ===');
    var dump = function(name, e, props){
      if (!e) { o.push(name + ' = (没有)'); return; }
      var cs = getComputedStyle(e);
      o.push(name + ' = ' + props.map(function(p){ return p + ':' + String(cs[p]).replace(/\\s/g,''); }).join(' '));
    };
    dump('.gcard 卡身', gc, ['backgroundColor']);
    dump('.gcard-ico', gi, ['backgroundColor','color']);
    dump('.rbtn 常态图标', ri, ['color']);
    dump('.rbtn.on 选中图标', ron, ['color']);
    dump('.row 条目图标', ic, ['backgroundColor','color']);
  }, 1200);
});
</script>
</body>`;
html = html.replace('</body>', probe);
html = html.replace('</head>',
  '<style>*,*::before,*::after{transition:none !important;animation:none !important}</style></head>');
const f = path.join(dir, '_probe24.html');
fs.writeFileSync(f, html, 'utf8');
const out = cp.execFileSync(chrome, ['--headless=old','--disable-gpu','--hide-scrollbars',
  '--window-size=760,980','--virtual-time-budget=90000','--dump-dom',
  'file:///' + f.replace(/\\/g,'/') + '#theme=sunny&page=today&noOnboard=1'],
  { encoding:'utf8', maxBuffer:1<<28 });
const m = out.match(/<pre id="probe-out">([\s\S]*?)<\/pre>/);
const res = m ? m[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&') : 'PROBE 未执行';
fs.writeFileSync(path.join(dir, '_probe24.txt'), res, 'utf8');
console.log(res);
