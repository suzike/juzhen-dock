/* 定点探针：量「⋯」按钮到底有没有真的露出来。
   截图里看不真切（22px 圆圈 + 淡灰三点，缩到整页图里几乎消失），
   所以不靠肉眼——直接读几何、颜色和层叠关系。
   对照两组：文件夹页的 .row（上一轮加的）和今日页「最近使用」的 .row（这一轮加的）。
   判据：
     1) 尺寸非零（被压成 0 就是没排上）
     2) 落在卡片矩形内（溢出会被 overflow:hidden 裁掉）
     3) 没有被其它元素盖住（elementFromPoint 命中自己或自己的子节点） */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = __dirname;
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let html = fs.readFileSync(path.join(dir, 'prototype.html'), 'utf8');
const probe = `
<script>
window.addEventListener('load', function(){
  setTimeout(function(){
    var arr = [];
    var pre = document.createElement('pre'); pre.id = 'probe-out';
    document.body.appendChild(pre);
    var push = function(s){ arr.push(String(s)); pre.textContent = arr.join('\\n'); };
    var q = function(s){ return document.querySelector(s); };
    var all = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };
    var rect = function(e){ var r = e.getBoundingClientRect();
      return Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.left) + ',' + Math.round(r.top); };
    try {
      if (state.query) exitSearch(false);
      openPanel();
      /* 逐个页面看：切页 → 数 .row 与 .row .ctx-more → 量第一个按钮 */
      var pages = [
        ['folders', '[data-page="folders"] .row'],
        ['links',   '[data-page="links"] .row'],
        ['today',   '[data-page="today"] .row[data-kind="recent"]'],
        ['today-todo', '[data-page="today"] .todo'],
        ['staging', '[data-page="staging"] .fcard'],
        ['clip',    '[data-page="clip"] .ccard']
      ];
      pages.forEach(function(pair){
        switchPage(pair[0].split('-')[0]);
        var rows = all(pair[1]);
        if (!rows.length){ push(pair[1] + ' → 没有元素'); return; }
        var btns = all(pair[1] + ' .ctx-more');
        var r0 = rows[0], b0 = btns[0];
        if (!b0){ push(pair[1] + ' → row ' + rows.length + ' 个，但一个 ⋯ 都没有'); return; }
        var rb = r0.getBoundingClientRect(), bb = b0.getBoundingClientRect();
        var inside = bb.left >= rb.left - 1 && bb.right <= rb.right + 1
                  && bb.top >= rb.top - 1 && bb.bottom <= rb.bottom + 1;
        var cx = bb.left + bb.width / 2, cy = bb.top + bb.height / 2;
        var hit = document.elementFromPoint(cx, cy);
        var hitOk = !!hit && (hit === b0 || b0.contains(hit));
        var cs = getComputedStyle(b0);
        push(pair[1] + ' → 行 ' + rows.length + ' · 带 ⋯ ' + btns.length
          + ' · 首个 ⋯ ' + rect(b0) + ' · 行 ' + rect(r0)
          + ' · 在行内 = ' + inside + ' · 可点中 = ' + hitOk
          + ' · 透明 ' + cs.opacity + ' · 可见 ' + cs.visibility
          + ' · 色 ' + cs.color);
      });
      push('(END)');
    } catch (ex){ push('[!] 探针抛错：' + ex.message + ' @ ' + String(ex.stack || '').split('\\n')[1]); push('(END)'); }
  }, 1200);
});
</script>
</body>`;
html = html.replace('</body>', probe);
const f = path.join(dir, '_probe16.html');
fs.writeFileSync(f, html, 'utf8');

const out = cp.execFileSync(chrome, ['--headless=old', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1600,1000', '--virtual-time-budget=40000', '--dump-dom',
  'file:///' + f.replace(/\\/g, '/') + '#theme=sunny&page=folders&noOnboard=1'],
  { encoding: 'utf8', maxBuffer: 1 << 28 });
const m = out.match(/<pre id="probe-out">([\s\S]*?)<\/pre>/);
const res = m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : 'PROBE 未执行';
fs.writeFileSync(path.join(dir, '_probe16.txt'), res, 'utf8');
console.log(res);
