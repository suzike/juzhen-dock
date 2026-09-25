/* 定点：今日页「今日待办」卡片标题栏右侧那个 ⋯ 到底是什么？
   如果是按钮却没处理分支，就是"假入口"——比缺按钮更糟。
   顺带把今天的待办卡标题栏结构原样打出来。 */
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
    try {
      if (state.query) exitSearch(false);
      switchPage('today');
      var heads = [].slice.call(document.querySelectorAll('#track .page[data-page="today"] .gcard'));
      heads.forEach(function(g){
        var nm = g.querySelector('.gcard-nm').textContent;
        var h = g.querySelector('.gcard-h');
        var btns = [].slice.call(h.querySelectorAll('button, [data-act]'));
        push('卡片「' + nm + '」· 标题栏子元素 ' + h.children.length
          + ' 个 · 可点元素 ' + btns.length + ' 个'
          + (btns.length ? ' → ' + btns.map(function(b){
              return (b.dataset.act || b.className) + '(' + b.textContent.trim().slice(0,6) + ')'; }).join(', ') : ''));
        push('   标题栏 HTML = ' + h.innerHTML.replace(/\\s+/g, ' ').slice(0, 300));
      });
      push('(END)');
    } catch (ex){ push('[!] ' + ex.message); push('(END)'); }
  }, 1200);
});
</script>
</body>`;
html = html.replace('</body>', probe);
const f = path.join(dir, '_probe17.html');
fs.writeFileSync(f, html, 'utf8');
const out = cp.execFileSync(chrome, ['--headless=old','--disable-gpu','--hide-scrollbars',
  '--window-size=1600,1000','--virtual-time-budget=30000','--dump-dom',
  'file:///' + f.replace(/\\/g, '/') + '#theme=sunny&page=today&noOnboard=1'],
  { encoding:'utf8', maxBuffer:1<<28 });
const m = out.match(/<pre id="probe-out">([\s\S]*?)<\/pre>/);
const res = m ? m[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&') : 'PROBE 未执行';
fs.writeFileSync(path.join(dir, '_probe17.txt'), res, 'utf8');
console.log(res);
