/* 全站盘点：13 个板块，逐个报「可见的增/改/删入口」。
   判据只看**可见的** `data-act` 控件（按钮/输入框都算），右键菜单不算 ——
   用户的诉求就是"要给我可操作的入口"，藏在右键里的等于没有。
   每页报三项：条目数 · 可见操作控件清单 · 带 ⋯ 的条目数。 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = __dirname;
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let html = fs.readFileSync(path.join(dir, 'prototype.html'), 'utf8');
/* 运行时对应物：构建期守卫扫的是静态 HTML，而页头「+」的动作是 pageHead
   运行时才拼出来的，静态 HTML 里搜不到。所以还要在**渲染之后**逐个对：
   把产物里所有 `act === 'xxx'` 分支名抠出来，跟每页实际可见的 data-act 比。
   对不上就是"按钮在、逻辑不在"——正是用户抱怨的那类东西。 */
const handled = [...new Set([...html.matchAll(/act === '([a-z-]+)'/g)].map(m => m[1]))];
handled.push('pin-off');   /* 挂着自己的 addEventListener，不走 handleAct */
const probe = `
<script>
window.addEventListener('load', function(){
  setTimeout(function(){
    var arr = [];
    var pre = document.createElement('pre'); pre.id = 'probe-out';
    document.body.appendChild(pre);
    var push = function(s){ arr.push(String(s)); pre.textContent = arr.join('\\n'); };
    var HANDLED = ${JSON.stringify(handled)};
    var all = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };
    /* 上一版的坑：写成 all(sel, body)，而 querySelectorAll 会忽略第二个参数，
       于是每一页报的都是**全文档并集**，页数越多列表越长 —— 看着像"别的页
       也有这些控件"，还凭空多出四个只存在于处理分支里的旧动作名。
       必须自己接一个真正限定作用域的版本。 */
    var allIn = function(root, s){ return Array.prototype.slice.call(root.querySelectorAll(s)); };
    try {
      openPanel();
      if (state.query) exitSearch(false);
      /* 每页的"条目"选择器：用来算"有多少样东西可改" */
      var ITEM = {
        today:'.todo,.row[data-kind="recent"]', folders:'.row', links:'.row',
        clip:'.cclip', staging:'.fcard', board:'.bcard', scene:'.scard',
        snip:'.snip', calc:'.conv,.psy,.pmv', note:'.ncard', shot:'.shot',
        ask:'.ask-tpl,.qa', settings:'.set-row,.set-card'
      };
      /* 这些按钮算"新增入口" */
      var ADD = /-(new|add|save|read|send)$/;
      PAGES.forEach(function(p){
        switchPage(p.id);
        var pg = document.querySelector('#track .page[data-page="' + p.id + '"]');
        var body = pg && (pg.querySelector('.page-body') || pg);
        if (!body){ push(p.id.padEnd(9) + ' → 没有 body 节点'); return; }
        var items = allIn(body, ITEM[p.id] || '.nothing').length;
        var btns = allIn(body, '[data-act]').filter(function(e){
          var r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0; });
        var acts = btns.map(function(e){ return e.dataset.act; });
        var uniq = acts.filter(function(a, i){ return acts.indexOf(a) === i; });
        var adds = uniq.filter(function(a){ return ADD.test(a); });
        var dead = uniq.filter(function(a){ return HANDLED.indexOf(a) < 0; });
        var more = allIn(body, '.ctx-more').length;
        var inp = allIn(body, 'input,textarea,select').filter(function(e){
          var r = e.getBoundingClientRect(); return r.width > 0; }).length;
        push(p.id.padEnd(9) + ' 条目 ' + String(items).padStart(2)
          + ' · ⋯ ' + String(more).padStart(2)
          + ' · 可输入 ' + String(inp).padStart(2)
          + ' · 可见动作 ' + String(uniq.length).padStart(2)
          + (adds.length ? ' · 增:' + adds.join(',') : ' · **没有新增入口**')
          + (dead.length ? ' · **没有处理分支:' + dead.join(',') + '**' : ''));
        if (uniq.length) push('          ' + uniq.join('  '));
      });
      /* 汇总：全站一遍，有没有哪个页面的条目连一个可操作入口都没有 */
      push('---- 汇总 ----');
      var bad = [];
      PAGES.forEach(function(p){
        switchPage(p.id);
        var pg = document.querySelector('#track .page[data-page="' + p.id + '"]');
        var body = pg && (pg.querySelector('.page-body') || pg);
        if (!body) return;
        var items = allIn(body, ITEM[p.id] || '.nothing').length;
        var acts = allIn(body, '[data-act]').filter(function(e){
          var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        var more = allIn(body, '.ctx-more').length;
        var inp = allIn(body, 'input,textarea,select').filter(function(e){
          var r = e.getBoundingClientRect(); return r.width > 0; }).length;
        if (items > 0 && more === 0 && acts.length === 0 && inp === 0) bad.push(p.id);
      });
      push('有条目却完全没有任何可操作入口的页 = ' + (bad.length ? bad.join(', ') : '无'));
      push('(END)');
    } catch (ex){ push('[!] ' + ex.message + ' @ ' + String(ex.stack || '').split('\\n')[1]); push('(END)'); }
  }, 1500);
});
</script>
</body>`;
html = html.replace('</body>', probe);
const f = path.join(dir, '_probe18.html');
fs.writeFileSync(f, html, 'utf8');

const out = cp.execFileSync(chrome, ['--headless=old','--disable-gpu','--hide-scrollbars',
  '--window-size=1600,1000','--virtual-time-budget=60000','--dump-dom',
  'file:///' + f.replace(/\\/g, '/') + '#theme=sunny&page=today&noOnboard=1'],
  { encoding:'utf8', maxBuffer:1<<28 });
const m = out.match(/<pre id="probe-out">([\s\S]*?)<\/pre>/);
const res = m ? m[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&') : 'PROBE 未执行';
fs.writeFileSync(path.join(dir, '_probe18.txt'), res, 'utf8');
console.log(res);
