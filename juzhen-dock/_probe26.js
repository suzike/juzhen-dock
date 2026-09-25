/* 追查残留的蓝 / 琥珀色到底挂在哪个元素上。
   _probe24 的"全站合计"是各页 ≥3 次色的并集，而每页只打印前 6 个 ——
   蓝/琥珀被截在 6 名之外，看不到是谁。这里直接把"用了这两个色"的元素点出来。 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = __dirname;
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let html = fs.readFileSync(path.join(dir, 'prototype.html'), 'utf8');
const probe = `
<script>
window.addEventListener('load', function(){
  setTimeout(function(){
    var arr = [], pre = document.createElement('pre');
    pre.id = 'probe-out'; document.body.appendChild(pre);
    var o = function(s){ arr.push(String(s)); pre.textContent = arr.join('\\n'); };
    var all = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };
    var TARGET = { 'rgb(77, 139, 192)':'doc蓝', 'rgb(205, 146, 75)':'slide琥珀' };
    var desc = function(e){
      var chain = [], n = e;
      for (var i = 0; i < 4 && n && n !== document.body; i++){
        chain.unshift(n.tagName.toLowerCase()
          + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).join('.') : ''));
        n = n.parentElement;
      }
      return chain.join(' > ');
    };
    openPanel();
    PAGES.forEach(function(p){
      if (state.query) exitSearch(false);
      switchPage(p.id);
      var hits = {};
      all('.panel *').forEach(function(e){
        var cs = getComputedStyle(e);
        [cs.backgroundColor, cs.color, cs.borderTopColor, cs.fill].forEach(function(v){
          if (TARGET[v]) {
            var k = TARGET[v] + ' · ' + v;
            hits[k] = hits[k] || {};
            hits[k][desc(e)] = (hits[k][desc(e)] || 0) + 1;
          }
        });
      });
      var ks = Object.keys(hits);
      if (ks.length){
        o('--- 页面 ' + p.id + ' ---');
        ks.forEach(function(k){
          o('  ' + k + ' (' + Object.keys(hits[k]).length + ' 处)');
          Object.keys(hits[k]).slice(0, 4).forEach(function(d){ o('      ' + d); });
        });
      }
    });
    /* 顺带把 --a1..--a4 的运行时值抓出来（CSS 里那 4 个默认值还在不在生效） */
    var cs2 = getComputedStyle(document.documentElement);
    o('');
    o('运行时强调色: --a1=' + cs2.getPropertyValue('--a1').trim()
      + '  --a2=' + cs2.getPropertyValue('--a2').trim()
      + '  --a3=' + cs2.getPropertyValue('--a3').trim()
      + '  --a4=' + cs2.getPropertyValue('--a4').trim());
    o('（CSS 静态默认已同步成同一组：--a1:#c86b46 --a2:#b7b4b1 --a3:#e2b29f --a4:#d0cecc）');
    o('ACC[] 前四个 = ' + ACC.slice(0, 4).join(' '));
    pre.textContent = arr.join('\\n') + '\\n(END)';
  }, 1200);
});
</script>
</body>`;
html = html.replace('</body>', probe);
html = html.replace('</head>',
  '<style>*,*::before,*::after{transition:none !important;animation:none !important}</style></head>');
const f = path.join(dir, '_probe26.html');
fs.writeFileSync(f, html, 'utf8');
const out = cp.execFileSync(chrome, ['--headless=old','--disable-gpu','--hide-scrollbars',
  '--window-size=760,980','--virtual-time-budget=90000','--dump-dom',
  'file:///' + f.replace(/\\/g,'/') + '#theme=sunny&page=today&noOnboard=1'],
  { encoding:'utf8', maxBuffer:1<<28 });
const m = out.match(/<pre id="probe-out">([\s\S]*?)<\/pre>/);
const res = m ? m[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&') : 'PROBE 未执行';
fs.writeFileSync(path.join(dir, '_probe26.txt'), res, 'utf8');
console.log(res);
