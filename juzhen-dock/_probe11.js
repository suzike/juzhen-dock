/* 全板块横向溢出体检：正文变窄 38px 后，逐页找出被撑破或文字被裁的元素。
   判定口径：
   1) page-body 自身 scrollWidth > clientWidth → 页面级横向溢出
   2) 任意后代的 rect.right 超出 page-body 右边界（排除刻意出血/绝对定位装饰）
   3) 元素 scrollWidth > clientWidth 且 nowrap → 文字被裁 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = __dirname;
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let html = fs.readFileSync(path.join(dir, 'prototype.html'), 'utf8');
const probe = `
<script>
window.addEventListener('load', function(){
  setTimeout(function(){
    var out = [];
    var q = function(s){ return document.querySelector(s); };
    PAGES.forEach(function(p){
      switchPage(p.id);
      var body = q('.page[data-page="' + p.id + '"] .page-body');
      if (!body){ out.push(p.id + ': 无正文容器'); return; }
      var bb = body.getBoundingClientRect();
      var line = p.id.padEnd(9) + ' 正文宽 ' + Math.round(bb.width);
      var over = [];
      Array.prototype.slice.call(body.querySelectorAll('*')).forEach(function(el){
        var r = el.getBoundingClientRect();
        if (!r.width && !r.height) return;
        var cs = getComputedStyle(el);
        if (cs.position === 'absolute' || cs.position === 'fixed') return;  // 装饰性出血另行判断
        if (r.right > bb.right + 1.5){
          over.push(el.className || el.tagName).toString();
        }
      });
      /* 去重后最多列 4 个 */
      var uniq = [];
      over.forEach(function(c){ if (uniq.indexOf(c) < 0) uniq.push(c); });
      line += ' · 溢出元素 ' + over.length + (over.length ? ' → ' + uniq.slice(0,4).join(' | ') : '');
      if (body.scrollWidth > body.clientWidth + 1) line += ' · [页面级溢出 ' + body.scrollWidth + '>' + body.clientWidth + ']';
      out.push(line);

      /* 文字被裁：nowrap 且内容超宽 */
      var cut = [];
      Array.prototype.slice.call(body.querySelectorAll('*')).forEach(function(el){
        if (el.children.length) return;
        var cs = getComputedStyle(el);
        if (cs.whiteSpace.indexOf('nowrap') < 0) return;
        if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0){
          cut.push((el.className || el.tagName) + ':' + (el.textContent || '').slice(0, 14) + ' (' + el.scrollWidth + '>' + el.clientWidth + ')');
        }
      });
      if (cut.length) out.push('          文字被裁 ' + cut.length + ' 处 → ' + cut.slice(0,4).join(' | '));
    });
    var pre = document.createElement('pre'); pre.id = 'probe-out'; pre.textContent = out.join('\\n');
    document.body.appendChild(pre);
  }, 1100);
});
</script>
</body>`;
html = html.replace('</body>', probe);
const f = path.join(dir, '_probe11.html');
fs.writeFileSync(f, html, 'utf8');

const out = cp.execFileSync(chrome, ['--headless=old','--disable-gpu','--hide-scrollbars','--window-size=1600,1000',
  '--virtual-time-budget=5000','--dump-dom','file:///' + f.replace(/\\/g, '/') + '#theme=sunny&noOnboard=1'],
  { encoding: 'utf8', maxBuffer: 1 << 28 });
const m = out.match(/<pre id="probe-out">([\s\S]*?)<\/pre>/);
const res = m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : 'PROBE 未执行';
fs.writeFileSync(path.join(dir, '_probe11.txt'), res, 'utf8');
console.log('ok');
