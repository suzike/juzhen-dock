/* 9 套主题的可读性量测：主色/墨阶被当**字色**用时，对比度够不够。

   ⚠ 两个已经踩过的坑，都记在这里：
   ① 第一版把派生公式**抄进探针**（自己写一遍 tint(cb,.88)、darken(cb,.62)），
      于是改了 vars() 的系数后探针还报旧结论 —— 现在改成从真元素上读内联令牌。
   ② 第二版 rgbOf() 只认 `#hex`，而 --cb-tint 是 `rgba(255,255,255,.92)` 这种
      字符串，parseInt('rgba...',16) = NaN → 全被当成 #000000，
      于是"深色字压纸面"算出来只有 ~2:1，**9 套主题齐刷刷报错**。
      整齐划一的失败通常不是产品的问题，是探针的问题（技能第 51 条）。
      现在 rgbOf 同时认 hex 和 rgb()/rgba()，并按 alpha 做合成。 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = __dirname;
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let html = fs.readFileSync(path.join(dir, 'prototype.html'), 'utf8');
const probe = `
<script>
window.addEventListener('load', function(){
  setTimeout(async function(){
    var arr = [], bad = [];
    var pre = document.createElement('pre'); pre.id = 'probe-out';
    document.body.appendChild(pre);
    var o = { push: function(s){ arr.push(String(s)); pre.textContent = arr.join('\\n'); } };
    var wait = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
    var q = function(s){ return document.querySelector(s); };
    var rootVar = function(k){ return getComputedStyle(document.documentElement).getPropertyValue(k).trim(); };

    var lin = function(c){ c = c / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    /* 认 hex 也认 rgb()/rgba() —— 后者是 --cb-tint 的真实写法 */
    var parse = function(s){
      s = String(s).trim();
      var m = s.match(/^rgba?\\(([^)]+)\\)$/);
      if (m){
        var p = m[1].split(',').map(function(x){ return parseFloat(x); });
        return { c:[p[0]|0, p[1]|0, p[2]|0], a: p.length > 3 ? p[3] : 1 };
      }
      var h = s.charAt(0) === '#' ? s.slice(1) : s;
      if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
      var n = parseInt(h, 16);
      return { c:[(n>>16)&255, (n>>8)&255, n&255], a:1 };
    };
    var hx = function(c){ return '#' + c.map(function(v){ return Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0'); }).join(''); };
    /* fg 带 alpha → 合成到不透明 bg 上，得到"眼睛实际看到"的实色 */
    var mix = function(fg, bg){
      var f = parse(fg), b = parse(bg);
      return hx([0,1,2].map(function(i){ return f.c[i]*f.a + b.c[i]*(1-f.a); }));
    };
    var lum = function(s){ var c = parse(s).c; return 0.2126*lin(c[0]) + 0.7152*lin(c[1]) + 0.0722*lin(c[2]); };
    var ratio = function(a, b){
      var la = lum(a), lb = lum(b), hi = Math.max(la, lb), lo = Math.min(la, lb);
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
    };

    for (var i = 0; i < THEMES.length; i++){
      var t = THEMES[i];
      setTheme(t.id);
      await wait(40);
      if (state.query) exitSearch(false);
      switchPage('folders');
      await wait(90);
      var el = q('[style*="--cb:"]');
      if (!el){ o.push('[!] ' + t.id + ' 找不到带内联令牌的元素，本节作废'); continue; }
      var g = function(k){ return el.style.getPropertyValue(k).trim(); };
      var cb = g('--cb'), soft = g('--cb-soft'), cbInk = g('--cb-ink'), cbTint = g('--cb-tint');
      var paper = rootVar('--paper'), paper3 = rootVar('--paper-3'), ink3 = rootVar('--ink-3');

      /* 只列**真的会同时出现**的组合（每一条都能在 CSS 里找到出处）。
         图标/色条/边框不列 —— 它们是实色块、靠饱和度辨识，亮度对比度不是它们该用的判据。 */
      var rows = [
        ['字 --cb-ink 压淡彩底 --cb-soft（标签/编号）', ratio(cbInk, mix(soft, paper)), 4.5],
        ['字 --cb-ink 压卡身 --cb-tint（半透明白压纸）', ratio(cbInk, mix(cbTint, paper)), 4.5],
        ['说明文 --ink-3 压纸面',                        ratio(ink3, paper), 4.5],
        ['说明文 --ink-3 压纸-3（计数徽标/kind 片）',    ratio(ink3, paper3), 4.5],
        ['正文 --ink-1 压纸面',                          ratio(t.ink1, paper), 7],
        /* 参考项：主色本体，不设阈值 */
        ['参考：主色本体 --cb 压纸面',                   ratio(cb, paper), 0],
        ['参考：主色本体 --cb 压淡彩底',                 ratio(cb, mix(soft, paper)), 0]
      ];
      var line = [];
      rows.forEach(function(r){
        var okk = r[1] >= r[2];
        line.push((okk ? '· ' : '★ ') + r[0] + '=' + r[1]);
        if (!okk) bad.push(t.id + ' ' + r[0] + ' ' + r[1] + '<' + r[2]);
      });
      o.push(t.id.padEnd(9) + ' 主色 ' + cb + ' · 字色 --cb-ink ' + cbInk + ' · 墨3 ' + ink3);
      line.forEach(function(x){ o.push('   ' + x); });
    }
    o.push('');
    o.push('不达标项 = ' + (bad.length ? bad.join(' ｜ ') : '无'));
    o.push('（"参考"两条不设阈值：主色本体只用在图标/色条/选中底上，');
    o.push('  实色块靠饱和度辨识，不算字色对比度。）');
    pre.textContent = arr.join('\\n') + '\\n(END)';
  }, 1300);
});
</script>
</body>`;
html = html.replace('</body>', probe);
const f = path.join(dir, '_probe28.html');
fs.writeFileSync(f, html, 'utf8');

const out = cp.execFileSync(chrome, ['--headless=old','--disable-gpu','--hide-scrollbars',
  '--window-size=1200,900','--virtual-time-budget=90000','--dump-dom',
  'file:///' + f.replace(/\\/g,'/') + '#theme=sunny&page=folders&noOnboard=1'],
  { encoding:'utf8', maxBuffer:1<<28 });
const m = out.match(/<pre id="probe-out">([\s\S]*?)<\/pre>/);
const res = m ? m[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&') : 'PROBE 未执行';
fs.writeFileSync(path.join(dir, '_probe28.txt'), res, 'utf8');
console.log(res);
