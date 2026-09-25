/* 矛盾点：静态 HTML 里没有 data-act="folders-add"，但运行到 folders 页后
   DOM 里确实出现了。必须弄清是谁渲染的 —— 如果它是运行时生成的，
   那构建期守卫（只扫静态 HTML）就有盲区，这个盲区本身就是要修的东西。
   做法：进 folders 页，把带这个 act 的元素 outerHTML + 祖先链原样打出来。 */
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
    var allIn = function(root, s){ return Array.prototype.slice.call(root.querySelectorAll(s)); };
    try {
      openPanel();
      if (state.query) exitSearch(false);
      ['folders','links','note','ask'].forEach(function(pg){
        switchPage(pg);
        var want = pg === 'folders' ? 'folders-add' : pg === 'links' ? 'links-add'
                 : pg === 'note' ? 'note-add' : 'ask-add';
        var page = document.querySelector('#track .page[data-page="' + pg + '"]');
        var els = page ? allIn(page, '[data-act="' + want + '"]') : [];
        push('== ' + pg + ' 页里 data-act="' + want + '" → ' + els.length + ' 个');
        els.slice(0, 2).forEach(function(e){
          var chain = [], n = e;
          while (n && n !== document.body){
            chain.unshift(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '')
              + (typeof n.className === 'string' && n.className.trim()
                 ? '.' + n.className.trim().split(/\\s+/).join('.') : ''));
            n = n.parentElement;
          }
          push('   链: ' + chain.join(' > '));
          push('   HTML: ' + e.outerHTML.slice(0, 220));
        });
        /* 同页所有 data-act 的原始值，看看有没有 undefined / 空 */
        var acts = page ? allIn(page, '[data-act]').map(function(e){ return e.getAttribute('data-act'); }) : [];
        push('   同页 data-act 原始值: ' + JSON.stringify(acts));
      });
      push('(END)');
    } catch (ex){ push('[!] ' + ex.message + ' @ ' + String(ex.stack || '').split('\\n')[1]); push('(END)'); }
  }, 1200);
});
</script>
</body>`;
html = html.replace('</body>', probe);
const f = path.join(dir, '_probe20.html');
fs.writeFileSync(f, html, 'utf8');
const out = cp.execFileSync(chrome, ['--headless=old','--disable-gpu','--hide-scrollbars',
  '--window-size=1600,1000','--virtual-time-budget=30000','--dump-dom',
  'file:///' + f.replace(/\\/g,'/') + '#theme=sunny&page=today&noOnboard=1'],
  { encoding:'utf8', maxBuffer:1<<28 });
const m = out.match(/<pre id="probe-out">([\s\S]*?)<\/pre>/);
const res = m ? m[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&') : 'PROBE 未执行';
fs.writeFileSync(path.join(dir, '_probe20.txt'), res, 'utf8');
console.log(res);
