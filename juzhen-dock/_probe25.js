/* 定点排查：搜索结果行尾的 ⋯ 点下去之后到底发生了什么。
   只做一件事 —— 把 exitSearch 的调用栈抓出来，看是谁把搜索态弄没的。 */
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
    var q = function(s){ return document.querySelector(s); };
    var all = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };
    var trace = [];
    /* 抓住 exitSearch 的调用栈 */
    var realExit = window.exitSearch;
    try {
      Object.defineProperty(window, 'exitSearch', { value: function(){
        trace.push(new Error('exitSearch 被调用').stack.split('\\n').slice(1, 5).join(' | '));
        return realExit.apply(this, arguments);
      }, writable:true, configurable:true });
    } catch (e){ o('包装 exitSearch 失败: ' + e.message); }

    openPanel();
    switchPage('today');
    var qEl = q('#q');
    qEl.value = '热';
    qEl.dispatchEvent(new Event('input', { bubbles:true }));

    setTimeout(function(){
      var mores = all('.sres .row .ctx-more');
      o('搜索结果行数 = ' + all('.sres .row').length + ' · 行内 ⋯ 数 = ' + mores.length);
      if (!mores.length){ o('没有 ⋯，结束'); pre.textContent = arr.join('\\n') + '\\n(END)'; return; }
      var b = mores[0];
      o('第一个 ⋯ 的 dataset.act = ' + JSON.stringify(b.dataset.act));
      o('它的最近 [data-act] 祖先 = ' + (function(){
        var a = b.closest('[data-act]');
        return a ? a.tagName + '.' + a.className + ' act=' + a.dataset.act : '(无)';
      })());
      o('它的最近 [data-kind] 祖先 = ' + (function(){
        var a = b.closest('[data-kind]');
        return a ? a.tagName + '.' + a.className + ' kind=' + a.dataset.kind : '(无)';
      })());
      o('点之前 state.query = ' + JSON.stringify(state.query));
      trace.length = 0;
      b.dispatchEvent(new MouseEvent('click', { bubbles:true }));
      o('点之后 state.query = ' + JSON.stringify(state.query));
      o('#ctx 的 class = ' + JSON.stringify(q('#ctx') ? q('#ctx').className : '(无 #ctx)'));
      o('#ctx 里条目数 = ' + all('#ctx .ctx-item').length);
      o('菜单内容 = ' + all('#ctx .ctx-item').map(function(e){ return e.textContent.trim(); }).join(' / '));
      o('exitSearch 调用栈（' + trace.length + ' 次）:');
      trace.forEach(function(t, i){ o('  [' + (i + 1) + '] ' + t); });
      /* 再单点一次"行本身"，确认它才是"执行这一条"的那条路 */
      trace.length = 0;
      var r0 = all('.sres .row').filter(function(r){ return r.querySelector('.ctx-more'); })[0];
      if (r0){ r0.dispatchEvent(new MouseEvent('click', { bubbles:true })); }
      o('点行本身之后 state.query = ' + JSON.stringify(state.query)
        + ' · 吐司 = ' + JSON.stringify((q('#toastMsg') || {}).textContent || ''));
      o('  行本身导致的 exitSearch 次数 = ' + trace.length);
      pre.textContent = arr.join('\\n') + '\\n(END)';
    }, 300);
  }, 1400);
});
</script>
</body>`;
html = html.replace('</body>', probe);
const f = path.join(dir, '_probe25.html');
fs.writeFileSync(f, html, 'utf8');

const out = cp.execFileSync(chrome, ['--headless=old','--disable-gpu','--hide-scrollbars',
  '--window-size=1600,1000','--virtual-time-budget=60000','--dump-dom',
  'file:///' + f.replace(/\\/g,'/') + '#theme=sunny&page=today&noOnboard=1'],
  { encoding:'utf8', maxBuffer:1<<28 });
const m = out.match(/<pre id="probe-out">([\s\S]*?)<\/pre>/);
const res = m ? m[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&') : 'PROBE 未执行';
fs.writeFileSync(path.join(dir, '_probe25.txt'), res, 'utf8');
console.log(res);
