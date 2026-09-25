/* ============================================================
   给 README 拍一套配图（图文并茂）

   拍的是**产物本身**（prototype.html），不是另画一份示意图 ——
   示意图会跟真身走散，本项目已经栽过好几次。

   一张图回答一件事：
     01 今日概览   —— 首图，整体形态（侧栏 + 页头 + 正文）
     02 文件夹直达 —— 「按父目录自动归类」长什么样
     03 临时暂存   —— 引用式记录 / 点击即预览
     04 工程换算   —— 单位 · 湿空气 · PMV（本行的专业向示例）
     05 主题弹层   —— 9 套配色一眼看全
     06 全局搜索   —— 跨板块检索
     07 设置页     —— 触发方式与显示方式

   桌面版专有的（终端 / 窗口分区 / 贴图钉屏）在这里拍不出来，
   它们由 Electron 自检产出，另从 userData/juzhen-dock-diag 取。

   用法：node _shots21.js
   ============================================================ */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = __dirname;
const chrome = 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe';
const outDir = path.join(dir, '_shots21');
fs.mkdirSync(outDir, { recursive: true });
const base = fs.readFileSync(path.join(dir, 'prototype.html'), 'utf8');

/* 冻结动效：截图会撞上入场动画（滑出 .985→1、stagger 34ms），
   截到中途的话每张图的元素位置都不一样，看起来像没对齐。 */
const FREEZE = 'var st=document.createElement("style");'
  + 'st.textContent="*{transition:none!important;animation:none!important}";'
  + 'document.head.appendChild(st);';

/* 打开全局搜索并输入一个词。按 placeholder 找元素而不是记 id ——
   第一次写的时候记了个不存在的 #q，结果这张图拍出来是"今日概览"，
   看上去像搜索没结果，其实是压根没输入。找不到就明确报出来。 */
const driveSearch = '(function(){'
  + 'var q=[].slice.call(document.querySelectorAll("input")).filter(function(e){'
  + '  return (e.placeholder||"").indexOf("搜索")>=0; })[0];'
  + 'if(!q){ document.title="DRIVER-ERR 找不到搜索框"; return; }'
  + 'q.focus(); q.value="终端";'
  + 'q.dispatchEvent(new Event("input",{bubbles:true}));'
  + '})();';

/* 点右上角调色盘，展开主题弹层 */
const driveTheme = 'var b=document.getElementById("btnTheme"); if(b) b.click();';

const SHOTS = [
  { name: '01_today',    page: 'today',    theme: 'sunny', drive: '' },
  { name: '02_folders',  page: 'folders',  theme: 'sunny', drive: '' },
  { name: '03_staging',  page: 'staging',  theme: 'sunny', drive: '' },
  { name: '04_calc',     page: 'calc',     theme: 'sunny', drive: '' },
  { name: '05_themes',   page: 'settings', theme: 'sunny', drive: driveTheme },
  { name: '06_search',   page: 'today',    theme: 'sunny', drive: driveSearch },
  { name: '07_settings', page: 'settings', theme: 'sunny', drive: '' },
  /* 换一套主色再拍一次同一个页面：README 里用来说明「一套主题只变三样」 */
  { name: '08_theme_blue', page: 'folders', theme: 'blue', drive: '' }
];

SHOTS.forEach(s => {
  const src = path.join(dir, '_shots21_' + s.name + '.html');
  fs.writeFileSync(src, base.replace('</body>',
    '\n<script>window.addEventListener("load",function(){setTimeout(function(){try{'
    + FREEZE + 'openPanel();switchPage("' + s.page + '");' + s.drive
    + '}catch(e){document.title="DRIVER-ERR "+e.message}},900);});<\/script>\n</body>'), 'utf8');
  const f = path.join(outDir, s.name + '.png');
  try {
    cp.execFileSync(chrome, ['--headless=old', '--disable-gpu', '--hide-scrollbars',
      '--window-size=1600,1000', '--virtual-time-budget=3000', '--screenshot=' + f,
      'file:///' + src.replace(/\\/g, '/') + '#theme=' + s.theme + '&page=' + s.page + '&noOnboard=1'],
      { stdio: ['ignore', 'ignore', 'ignore'] });
  } finally {
    if (fs.existsSync(src)) fs.unlinkSync(src);
  }
  const sz = fs.existsSync(f) ? fs.statSync(f).size : 0;
  console.log(s.name.padEnd(16) + (sz ? Math.round(sz / 1024) + ' KB' : '★ 没生成'));
});
