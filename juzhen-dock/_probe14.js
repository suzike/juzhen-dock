/* 场景页渲染 + 动作缺失标记 的定点探针。
   起因：桌面自检里读场景页 DOM 得到"卡片 0 张"，需要分辨是
   （a）渲染真的坏了，还是（b）自检读得太早 / 读了别的 body。
   这里不接 IPC，probeScenes 走不通 —— 但卡片本身不依赖探测结果，
   所以卡片数必须 >0。 */
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
    window.addEventListener('error', function(e){ push('PAGE_ERROR: ' + e.message); });
    try {
      push('场景数据 = ' + (typeof TOOL !== 'undefined' ? TOOL.scenes.length : 'TOOL 未定义') + ' 个');
      push('sceneMiss 存在 = ' + (typeof sceneMiss));
      push('lastSceneRun 存在 = ' + (typeof lastSceneRun));
      refresh([state.page]);
      switchPage('scene');
      push('切页后 state.page = ' + state.page);
      var body = document.querySelector('#track .page[data-page="scene"] .page-body');
      push('page-body 找到 = ' + !!body);
      push('innerHTML 长度 = ' + (body ? body.innerHTML.length : -1));
      push('卡片 .scard = ' + document.querySelectorAll('.scard').length);
      push('动作 .sc-act = ' + document.querySelectorAll('.sc-act').length);
      push('page-body 是否在 track 内 = ' + !!(body && document.querySelector('#track').contains(body)));
      push('track 内 .page 数 = ' + document.querySelectorAll('#track .page').length);
      push('track 内所有 data-page = ' + Array.prototype.map.call(
        document.querySelectorAll('#track .page'), function(p){ return p.dataset.page; }).join(','));
      push('总 .scard（全文档）= ' + document.querySelectorAll('.scard').length);
      var b2 = document.querySelector('.page[data-page="scene"] .page-body');
      push('不带 #track 的选择器 innerHTML 长度 = ' + (b2 ? b2.innerHTML.length : -1));
      push('b2 是同一个吗 = ' + (b2 === body));
    } catch(e){ push('THROW: ' + (e && (e.stack || e.message))); }
    push('(END)');
  }, 400);
});
<\/script>`;

html = html.replace('</body>', probe + '</body>');
const tmp = path.join(dir, '_probe14.html');
fs.writeFileSync(tmp, html, 'utf8');

const out = cp.execFileSync(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=1280,900', '--virtual-time-budget=9000',
  '--user-data-dir=' + path.join(dir, '_chrome_tmp14'),
  '--dump-dom', 'file:///' + tmp.replace(/\\/g, '/')
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const m = out.match(/<pre id="probe-out">([\s\S]*?)<\/pre>/);
const txt = m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : '(未捕获到探针输出)';
fs.writeFileSync(path.join(dir, '_probe14.txt'), txt, 'utf8');
console.log(txt);
