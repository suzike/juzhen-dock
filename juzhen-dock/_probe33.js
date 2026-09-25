/* ============================================================
   补丁 45 的验证：模型名那一格，从"手抄"改成"点选"

   要验的不是"我加了几个函数"，而是**用户那次故障会不会被拦住**：
   复刻他的存档（model = 'deepseek-chatdeepseek-flash'），然后问三件事：

     1. 打开设置页，界面上有没有**当场**说出"这个名字不在名单里"？
        —— 这是唯一能在按下发送之前拦住 400 的东西。
     2. 点一下候选里的名字，模型名会不会被**替换**？
        —— 必须是替换。用户那次的事故就是"在末尾接着敲"，只要追加这条路
        还在，迟早还有人这么敲。
     3. 名单是不是"常驻"的（而不是弹一次窗就没了）？

   走真路：click() 会冒泡到 #panel 上的委托处理器，和真人点击同一条路径。
   （这一条在这个项目里栽过：.click() 之外的假派发测不出问题。）

   用法：node _probe33.js
   ============================================================ */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = __dirname;
const chrome = 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe';
const base = fs.readFileSync(path.join(dir, 'prototype.html'), 'utf8');

const DRIVER = `function(){
var o = {};
var BAD = 'deepseek-chatdeepseek-flash';

/* ---- 复刻用户那次坏存档 ----
   ⚠ 这里必须显式 renderPage('settings', true)，不能只 switchPage：
   包装脚本进来时已经停在设置页了，switchPage 会**早退**（页面没变就不重画），
   于是读到的还是"改之前那一屏" —— 第一版就栽在这儿：候选数对、选中数却是 1、
   状态条里显示的是初始值，五条判据全是假红，看着像功能坏了。 */
var a = state.settings.ai;
a.provider = 'deepseek';
a.model = BAD;
a.baseUrl = 'https://api.deepseek.com';
a.keys = a.keys || {}; a.keys.deepseek = 'sk-test-not-a-real-key';
a.lists = {};
saveSettings();
renderPage('settings', true);

/* 把内部状态原样带出来：判据红了的时候，要能分清"功能没做对"和"探针读错了"。 */
o.__ai = JSON.parse(JSON.stringify(state.settings.ai));
o.__choices = aiModelChoices('deepseek');

function chips(){ return [].slice.call(document.querySelectorAll('.ai-mchip')); }
function warn(){ var w = document.querySelector('.ai-mwarn'); return w ? w.textContent.replace(/\\s+/g,' ').trim() : null; }
function strip(){ var e = document.querySelector('.ai-st .ai-tx'); return e ? e.textContent.replace(/\\s+/g,' ').trim() : null; }

o.候选名 = chips().map(function(b){ return b.dataset.m; });
o.候选来源 = [].slice.call(document.querySelectorAll('.ai-mchip i')).map(function(x){ return x.textContent; });
o.选中数 = document.querySelectorAll('.ai-mchip.on').length;
o.告警 = warn();
o.告警含那个坏名字 = !!(o.告警 && o.告警.indexOf(BAD) >= 0);
o.状态条 = strip();
o.状态条含告警 = !!(o.状态条 && o.状态条.indexOf('不在已知名单里') >= 0);

/* ---- 点一下候选（走真人那条路）---- */
var btn = document.querySelector('.ai-mchip[data-m="deepseek-flash"]');
o.找到候选按钮 = !!btn;
if (btn) btn.click();
o.点后模型名 = state.settings.ai.model;
o.点后输入框值 = (document.querySelector('[data-ai="model"]') || {}).value;
o.点后告警 = warn();
o.点后选中数 = document.querySelectorAll('.ai-mchip.on').length;
o.点后状态条 = strip();
o.点后落盘 = (function(){
  /* 键名直接引用页面里的常量，不抄一遍 —— 抄错了这条判据会假红，
     而假红会让人去改一个本来就对的地方。 */
  try { var raw = JSON.parse(localStorage.getItem(LS_SET) || '{}');
        return (raw.ai || {}).model || null; } catch(e){ return 'ERR ' + e.message; }
})();

/* ---- 再点另一个（换名字也要换得干净）---- */
var b2 = document.querySelector('.ai-mchip[data-m="deepseek-v4-pro"]');
if (b2) b2.click();
o.换后模型名 = state.settings.ai.model;
o.换后输入框值 = (document.querySelector('[data-ai="model"]') || {}).value;

/* ---- 名单常驻：拉取过的名字存在设置里，切页回来还在 ---- */
a.lists = { deepseek: ['deepseek-flash','deepseek-v4-pro','deepseek-some-future-one'] };
saveSettings();
renderPage('settings', true);
o.缓存后候选名 = chips().map(function(b){ return b.dataset.m; });
o.缓存后来源 = [].slice.call(document.querySelectorAll('.ai-mchip i')).map(function(x){ return x.textContent; });

/* ---- 去重：缓存里重复了同样的名字，不能出现两遍 ---- */
a.lists = { deepseek: ['deepseek-flash','deepseek-flash','deepseek-v4-pro'] };
saveSettings(); renderPage('settings', true);
o.去重后候选数 = chips().length;

/* ---- 修好之后，状态条不该再有⚠ ---- */
o.修好后状态条 = strip();
o.修好后还有告警 = !!(o.修好后状态条 && o.修好后状态条.indexOf('⚠') >= 0);

/* ---- 模型名那一行的说明里不能再写死返回码 ---- */
o.模型行文案 = (function(){
  var r = [].slice.call(document.querySelectorAll('.set-row')).filter(function(x){
    return x.textContent.indexOf('模型名') === 0 || /^模型名/.test(x.textContent.trim()); });
  return r.length ? r[0].textContent.replace(/\\s+/g,' ').trim().slice(0,60) : null;
})();
o.文案里写死了404 = !!(o.模型行文案 && o.模型行文案.indexOf('填错会返回 404') >= 0);

return JSON.stringify(o);
}`;

function run(){
  const src = path.join(dir, '_probe33_drv.html');
  fs.writeFileSync(src, base.replace('</body>',
    '\n<script>window.addEventListener("load",function(){setTimeout(function(){'
    + 'var r;try{openPanel();switchPage("settings");'
    + 'var out=(' + DRIVER + ')();r=out;}catch(e){r="ERR "+e.message}'
    + 'var p=document.createElement("pre");p.id="__probe";p.textContent=r;document.body.appendChild(p);'
    + '},1100);});<\/script>\n</body>'), 'utf8');
  const html = cp.execFileSync(chrome, ['--headless=old', '--disable-gpu', '--dump-dom',
    '--window-size=900,1400', '--virtual-time-budget=4000',
    'file:///' + src.replace(/\\/g, '/') + '#page=settings&noOnboard=1'],
    { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  fs.unlinkSync(src);
  const m = html.match(/<pre id="__probe">([\s\S]*?)<\/pre>/);
  if (!m) return { __missing: true };
  const s = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  try { return JSON.parse(s); } catch (e){ return { __raw: s }; }
}

const r = run();
if (r.__missing){ console.log('★ 没读到结果 —— 驱动脚本没跑完'); process.exit(1); }
if (r.__raw !== undefined){ console.log('驱动返回的不是 JSON：' + r.__raw); process.exit(1); }

let bad = 0;
const chk = (n, ok, note) => { if (!ok){ bad++; console.log('★ ' + n + (note !== undefined ? '：' + note : '')); } else console.log('  ok · ' + n); };

console.log('===== 复刻用户那次坏存档后，界面说了什么 =====');
console.log('  内部 ai    = ' + JSON.stringify(r.__ai));
console.log('  aiModelChoices = ' + JSON.stringify(r.__choices));
console.log('  候选名     = ' + JSON.stringify(r.候选名));
console.log('  候选来源   = ' + JSON.stringify(r.候选来源));
console.log('  告警       = ' + JSON.stringify(r.告警));
console.log('  状态条     = ' + JSON.stringify(r.状态条));
console.log('  模型行文案 = ' + JSON.stringify(r.模型行文案));

console.log('\n===== 判据 =====');
chk('DeepSeek 开了预设候选名单，两处可见', r.候选名 && r.候选名.length === 2, JSON.stringify(r.候选名));
chk('候选就是实测可用的两个名字',
  JSON.stringify(r.候选名) === JSON.stringify(['deepseek-flash','deepseek-v4-pro']), JSON.stringify(r.候选名));
chk('名字标了来源（预设 / 服务商）', r.候选来源 && r.候选来源.every(x => x === '预设' || x === '服务商'), JSON.stringify(r.候选来源));
chk('★ 坏名字当场被点名（这是能在发送前拦住 400 的那条）',
  !!r.告警含那个坏名字, JSON.stringify(r.告警));
chk('★ 状态条也说了（不用进设置页就能看见）', r.状态条含告警 === true, JSON.stringify(r.状态条));
chk('坏名字不在候选里，所以一个都没选中', r.选中数 === 0, r.选中数);
chk('模型行的文案不再写死返回码', r.文案里写死了404 === false, JSON.stringify(r.模型行文案));

console.log('\n===== 点一下即填（走真人那条 click 路）=====');
console.log('  点后模型名 = ' + JSON.stringify(r.点后模型名) + ' · 输入框 = ' + JSON.stringify(r.点后输入框值));
console.log('  点后状态条 = ' + JSON.stringify(r.点后状态条));
chk('找到候选按钮并点得动', r.找到候选按钮 === true);
chk('★ 模型名被**替换**成点的那个（不是追加）', r.点后模型名 === 'deepseek-flash', r.点后模型名);
chk('★ 输入框里的值也被换掉（用户看得见）', r.点后输入框值 === 'deepseek-flash', r.点后输入框值);
chk('点完告警消失', r.点后告警 === null, JSON.stringify(r.点后告警));
chk('点完那一个被标成选中', r.点后选中数 === 1, r.点后选中数);
chk('点完状态条里没有⚠了', !!(r.点后状态条 && r.点后状态条.indexOf('⚠') < 0), JSON.stringify(r.点后状态条));
chk('点完落了盘（不是只改了内存）', r.点后落盘 === 'deepseek-flash', r.点后落盘);

chk('换一个名字也换得干净', r.换后模型名 === 'deepseek-v4-pro' && r.换后输入框值 === 'deepseek-v4-pro',
  r.换后模型名 + ' / ' + r.换后输入框值);

console.log('\n===== 名单常驻 + 去重 =====');
chk('★ 拉取过的名单留在设置里，切走再回来还在',
  r.缓存后候选名 && r.缓存后候选名.length === 3 && r.缓存后候选名.indexOf('deepseek-some-future-one') >= 0,
  JSON.stringify(r.缓存后候选名));
chk('缓存来的名字标成「服务商」',
  r.缓存后来源 && r.缓存后来源.filter(x => x === '服务商').length === 3, JSON.stringify(r.缓存后来源));
chk('同一个名字出现两次也只显示一个', r.去重后候选数 === 2, r.去重后候选数);
chk('修好之后状态条里不再有⚠', r.修好后还有告警 === false, JSON.stringify(r.修好后状态条));

console.log(bad ? '\n★ 不通过 ' + bad + ' 项' : '\n全绿（19 项）');
process.exit(bad ? 1 : 0);
