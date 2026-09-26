/* _probe34.js —— 运行时冒烟探针（R5 轮新增，永久保留）
   起因：R5 轮一个顶层 const 引用了后置声明，27 条构建守卫全是静态检查
   没接住，应用加载即崩而构建全绿。守卫管语法与接线，"页面到底渲染出
   来没有"只有真开一次才知道 —— 这就是本探针的职责。
   判据（全部可执行，不看截图）：
     1) 无头 Chrome dump-dom 成功；
     2) 页面骨架齐全（#track、#q、#qHist）；
     3) 正文真的渲染了卡片（gcard ≥ 1）；
     4) DOM 里没有 "undefined · "（眉标合成对象漏字段的信号）；
     5) 无 "before initialization"（TDZ 崩溃的标志文案，出现即整页没起来）。
   用法：node _probe34.js   → 输出 PASS / FAIL 一行 + 细目。 */
const cp = require('child_process');
const path = require('path');
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function dump(hash){
  const url = 'file:///' + path.resolve(__dirname, 'prototype.html').replace(/\\/g, '/') + '#' + hash;
  return cp.execFileSync(chrome, ['--headless=old', '--disable-gpu',
    '--virtual-time-budget=3500', '--dump-dom', url],
    { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
}

const checks = [];
function chk(name, ok, detail){ checks.push((ok ? '✓ ' : '✗ ') + name + (detail ? ' · ' + detail : '')); return ok; }

const home = dump('theme=sunny&page=today&noOnboard=1&pin=1');
const homeClean = home.replace(/<script[\s\S]*?<\/script>/g, '');
let ok = true;
ok = chk('骨架 #track/#q/#qHist',
  home.indexOf('id="track"') >= 0 && home.indexOf('id="q"') >= 0 && home.indexOf('id="qHist"') >= 0) && ok;
ok = chk('正文渲染 gcard ≥ 1', (homeClean.match(/class="gcard/g) || []).length >= 1,
  '实际 ' + (homeClean.match(/class="gcard/g) || []).length) && ok;
ok = chk('无 undefined · 眉标', homeClean.indexOf('undefined · ') < 0) && ok;
ok = chk('无 TDZ 崩溃文案', home.indexOf('before initialization') < 0) && ok;

const search = dump('theme=sunny&page=today&noOnboard=1&pin=1&q=PMV');
/* 剥掉脚本块再查：源码注释里会出现"undefined · 00"这样的字样（讲修复
   来历的注释），不剥的话查的是源码不是渲染结果 —— 探针自己先踩了这个坑。 */
const searchClean = search.replace(/<script[\s\S]*?<\/script>/g, '');
ok = chk('搜索页渲染（q=PMV 命中 ≥ 1 行）', (searchClean.match(/class="row"/g) || []).length >= 1,
  '实际 ' + (searchClean.match(/class="row"/g) || []).length) && ok;
ok = chk('搜索眉标 = 全局搜索（非 undefined）', searchClean.indexOf('undefined · ') < 0
  && searchClean.indexOf('全局搜索') >= 0) && ok;

console.log(checks.join('\n'));
console.log(ok ? 'SMOKE: PASS' : 'SMOKE: FAIL');
process.exit(ok ? 0 : 1);
