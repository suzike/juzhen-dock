/* _probe35.js —— 深色残留探针（R12 新增，永久保留）
   深色主题最怕"暗处一块白"：白底多半是 CSS 里写死的老颜色，肉眼逐页找
   不现实。本探针在曜夜主题下逐页扫描 #panel 内所有元素的**计算背景色**，
   把"不透明且亮度偏高"的元素记下来 —— 亮度阈值 0.72、α≥0.45
   （≤.35 的白色 sheen 高光是有意保留的，不算残留）。
   判据进 DOM：body[data-lightblocks]，Node 侧 dump-dom 后解析。
   用法：node _probe35.js   → PASS / FAIL + 明细 */
const cp = require('child_process');
const fs = require('fs'), path = require('path');
const dir = __dirname;
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const base = fs.readFileSync(path.join(dir, 'prototype.html'), 'utf8');

const SCAN = `
var LIGHT = [];
function lum(c){
  var m = c.match(/rgba?\\\\(([\\\\d.]+),\\\\s*([\\\\d.]+),\\\\s*([\\\\d.]+)(?:,\\\\s*([\\\\d.]+))?\\\\)/);
  if (!m) return -1;
  var a = m[4] === undefined ? 1 : parseFloat(m[4]);
  if (a < 0.45) return -1;
  return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255;
}
PAGES.forEach(function (p){
  switchPage(p.id);
  var root = document.querySelector('#panel');
  [].slice.call(root.querySelectorAll('*')).forEach(function (el){
    var bg = getComputedStyle(el).backgroundColor;
    var L = lum(bg);
    if (L > 0.72 && LIGHT.length < 24){
      var cls = (el.className && el.className.toString) ? el.className.toString().split(' ')[0] : el.tagName;
      LIGHT.push(p.id + ' <' + cls + '> ' + bg);
    }
  });
});
document.body.setAttribute('data-lightblocks', LIGHT.join(' | '));
document.body.setAttribute('data-lb-done', '1');
`;

const src = path.join(dir, '_probe35_page.html');
fs.writeFileSync(src, base.replace('</body>',
  '\n<script>window.addEventListener("load",function(){setTimeout(function(){try{'
  + 'var st=document.createElement("style");st.textContent="*{transition:none!important;animation:none!important}";'
  + 'document.head.appendChild(st);openPanel();' + SCAN
  + '}catch(e){document.body.setAttribute("data-lb-err", e.message);}},900);});<\/script>\n</body>'), 'utf8');

const dom = cp.execFileSync(chrome, ['--headless=old', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1600,1000', '--virtual-time-budget=9000', '--dump-dom',
  'file:///' + src.replace(/\\/g, '/') + '#theme=obsidian&page=today&noOnboard=1'],
  { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
fs.unlinkSync(src);

const err = dom.match(/data-lb-err="([^"]*)"/);
if (err){ console.log('PROBE35: 探针自身出错 → ' + err[1]); process.exit(1); }
const hit = dom.match(/data-lightblocks="([^"]*)"/);
if (!hit){ console.log('PROBE35: 没拿到扫描结果（驱动没跑？）'); process.exit(1); }
if (!hit[1]){
  console.log('PROBE35: PASS —— 曜夜全 14 页无亮块残留');
  process.exit(0);
}
console.log('PROBE35: FAIL —— 发现 ' + hit[1].split(' | ').length + ' 处亮块：');
hit[1].split(' | ').forEach(x => console.log('  ✗ ' + x));
process.exit(1);
