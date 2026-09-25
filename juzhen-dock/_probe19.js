/* 追查 folders-add / links-add / note-add / ask-add 这四个 data-act
   到底由哪段代码渲染出来 —— 静态 HTML 和各 builder 里都没有，
   但运行时 DOM 里确实存在。打印它的外层链和 outerHTML 开头。 */
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
    var all = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };
    try {
      openPanel();
      ['folders-add','links-add','note-add','ask-add'].forEach(function(a){
        var els = all('[data-act="' + a + '"]');
        push('== ' + a + ' → ' + els.length + ' 个');
        els.slice(0,3).forEach(function(e){
          var chain = [];
          var n = e;
          while (n && n !== document.body){
            chain.unshift(n.tagName.toLowerCase()
              + (n.id ? '#' + n.id : '')
              + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).join('.') : '')
              + (n.dataset && n.dataset.page ? '[page=' + n.dataset.page + ']' : ''));
            n = n.parentElement;
          }
          push('   链: ' + chain.slice(-7).join(' > '));
          push('   尺寸: ' + Math.round(e.getBoundingClientRect().width) + 'x'
            + Math.round(e.getBoundingClientRect().height)
            + ' · 文本: ' + JSON.stringify((e.textContent || '').trim().slice(0, 24)));
        });
      });
      /* 顺带确认它们是否在某个 <template> 或隐藏容器里 */
      var t = all('template').length;
      push('template 元素 ' + t + ' 个');
      push('(END)');
    } catch (ex){ push('[!] ' + ex.message); push('(END)'); }
  }, 1200);
});
</script>
</body>`;
html = html.replace('</body>', probe);
const f = path.join(dir, '_probe19.html');
fs.writeFileSync(f, html, 'utf8');
const out = cp.execFileSync(chrome, ['--headless=old','--disable-gpu','--hide-scrollbars',
  '--window-size=1600,1000','--virtual-time-budget=30000','--dump-dom',
  'file:///' + f.replace(/\\/g,'/') + '#theme=sunny&page=today&noOnboard=1'],
  { encoding:'utf8', maxBuffer:1<<28 });
const m = out.match(/<pre id="probe-out">([\s\S]*?)<\/pre>/);
const res = m ? m[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&') : 'PROBE 未执行';
fs.writeFileSync(path.join(dir, '_probe19.txt'), res, 'utf8');
console.log(res);
