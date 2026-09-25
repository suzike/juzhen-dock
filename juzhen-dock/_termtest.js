/* ============================================================
   真终端的后端直测（普通 node，不开 Electron、不开窗口）
   ------------------------------------------------------------
   这一层验的是浏览器探针**到不了**的东西：真的起没起 ConPTY 会话、
   退出码到底有没有从 PowerShell 的 prompt 里流出来、会话退出后再敲键
   会不会按原配置重开。

   为什么必须能这么测：main.js 一开头就 require('electron')，
   普通 node 跑不起来 —— 于是"会话有没有真起来"只能靠开窗口、点一下、
   用肉眼看，而那种验证每次都要人重复一遍、也进不了回归。
   所以 term.js 被刻意写成纯 Node 模块（不 require electron），
   这个文件就是它的测试入口。

   跑法：node _termtest.js   （结论同时写 _termtest.txt）
   ============================================================ */
const fs = require('fs'), path = require('path');

const TERM = require('./desktop/term.js');

const out = [], fails = [];
const p = s => { out.push(s); console.log(s); };
const ok = (cond, label, extra) => {
  out.push('  ' + (cond ? '[ok] ' : '[!!] ') + label + (extra !== undefined ? '   ' + extra : ''));
  console.log('  ' + (cond ? '[ok] ' : '[!!] ') + label + (extra !== undefined ? '   ' + extra : ''));
  if (!cond) fails.push(label);
};
const wait = ms => new Promise(r => setTimeout(r, ms));

/* 每个标签的输出累积起来（onData 是流式的，断言要靠"累积后包含什么"） */
const BUF = {};
TERM.setSink((id, d) => { BUF[id] = (BUF[id] || '') + d; });
const EXITS = [];
TERM.setExitSink((id, code) => { EXITS.push({ id, code }); });

/* 轮询等条件成立。**不能用 sleep 等异步回调** —— PTY 的输出时机不受我们控制，
   固定 sleep 要么不够、要么把整个测试拖长。 */
async function until(fn, ms, label){
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 12000)){
    let v = false;
    try { v = fn(); } catch (e) { /* 还没就绪 */ }
    if (v) return true;
    await wait(80);
  }
  p('      （等超时：' + label + '）');
  return false;
}
const has = (id, s) => (BUF[id] || '').indexOf(s) >= 0;
const after = (id, from, s) => (BUF[id] || '').slice(from).indexOf(s) >= 0;

(async function main(){
  p('===== 一、能力探测 =====');
  const av = TERM.available();
  ok(av.ok, '原生模块加载成功（@lydell/node-pty）', av.ok ? 'ok' : av.why);
  if (!av.ok){ p('  模块不可用，后面没法测，直接收尾。'); return finish(); }

  const shells = TERM.whichShells();
  ok(!!shells.powershell && shells.powershell.found === true, '本机存在 powershell.exe',
     JSON.stringify(shells.powershell));
  ok(shells.cmd && typeof shells.cmd.found === 'boolean', 'cmd 的探测结果是个布尔（不是"未知"）',
     'cmd.found=' + (shells.cmd || {}).found);
  p('  本机 shell 一览：' + Object.keys(shells).map(k => k + '=' + (shells[k].found ? '有' : '无')).join(' · '));
  ok(TERM.PROFILES.length === 4, '四种 shell 都登记了', TERM.PROFILES.map(x => x.id).join('/'));
  ok(TERM.profileOf('不存在的shell').id === 'powershell',
     '认不出的 profile 回落成 powershell（存档是外部输入，不能信）');
  ok(TERM.POWERSHELL_BOOTSTRAP.indexOf('633;D;') > 0,
     'PowerShell 引导里确实在往输出流写 OSC 633;D（退出码的唯一干净来源）');

  p('');
  p('===== 二、起一个真会话 =====');
  const id = 'test-' + Date.now();
  const r1 = TERM.ensure(id, { cols: 100, rows: 28 });
  ok(r1.ok, 'ensure 起会话成功', r1.ok ? ('cols=' + r1.cols + ' rows=' + r1.rows) : r1.error);
  ok(r1.reused === false, '是新建而不是复用');
  const r2 = TERM.ensure(id, { cols: 100, rows: 28 });
  ok(r2.ok && r2.reused === true, '再 ensure 一次是复用同一个会话（不会每次点都开一个进程）');

  const gotPrompt = await until(() => has(id, 'PS ') || has(id, '> '), 15000, '等 PowerShell 首个提示符');
  ok(gotPrompt, '会话真的活起来了（收到真实输出）',
     JSON.stringify((BUF[id] || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').slice(0, 70)));
  const alive1 = TERM.list().find(x => x.id === id);
  ok(!!alive1 && alive1.alive === true, 'list() 里这个标签是 alive');

  p('');
  p('===== 三、输入 / 输出 / 中文 =====');
  let mark = (BUF[id] || '').length;
  TERM.input(id, 'echo SPIKE_OK_1234\r');
  ok(await until(() => after(id, mark, 'SPIKE_OK_1234'), 12000, '等回显'), '命令的输出真的回到了数据流里');
  /* 中文路径与中文回显是本机的真实痛点（GBK vs UTF-8）。
     只测 ASCII 的话，"中文乱码"这个最容易出的问题会被漏掉。 */
  mark = (BUF[id] || '').length;
  TERM.input(id, 'echo 中文回显测试\r');
  ok(await until(() => after(id, mark, '中文回显测试'), 12000, '等中文回显'),
     '中文回显不乱码（UTF-8 引导生效）');

  p('');
  p('===== 四、退出码：只认 OSC 633;D =====');
  mark = (BUF[id] || '').length;
  TERM.input(id, 'cmd /c "exit 0"\r');
  ok(await until(() => after(id, mark, '\x1b]633;D;0\x07'), 12000, '等 633;D;0'),
     '成功命令发的是 633;D;0');
  mark = (BUF[id] || '').length;
  TERM.input(id, 'cmd /c "exit 7"\r');
  ok(await until(() => after(id, mark, '\x1b]633;D;7\x07'), 12000, '等 633;D;7'),
     '失败命令发的是**真实**退出码 7（不是笼统的 1）');
  mark = (BUF[id] || '').length;
  TERM.input(id, 'Get-Item Z:\\这个盘不存在\r');
  const gotErr = await until(() => (BUF[id] || '').slice(mark).indexOf('633;D;') >= 0, 12000, '等 PowerShell 报错的退出码');
  ok(gotErr, 'PowerShell 自己的报错也会给出退出码（非 native 命令那条分支）');

  p('');
  p('===== 五、当前目录能被抓到 =====');
  mark = (BUF[id] || '').length;
  TERM.input(id, "Set-Location -LiteralPath 'C:\\Windows'\r");
  ok(await until(() => /PS C:\\Windows>/.test((BUF[id] || '').slice(mark)), 12000, '等 PS C:\\Windows>'),
     '换目录之后的提示符带上了新路径（渲染侧就是靠这个抓 cwd）');

  p('');
  p('===== 六、resize =====');
  const rz = TERM.resize(id, 132, 40);
  ok(rz.ok, 'resize 到 132x40 成功', JSON.stringify(rz));
  const rz2 = TERM.resize(id, 132, 40);
  ok(rz2.ok && rz2.same === true, '同尺寸再 resize 会跳过（不做无谓的 ConPTY 调用）');
  const rz3 = TERM.resize(id, 1, 1);
  ok(rz3.ok, '故意给个荒唐的 1x1 也被夹到下限（不会把终端搞成一行）');
  TERM.resize(id, 100, 28);

  p('');
  p('===== 七、会话退出 → 再敲键按原配置重开 =====');
  TERM.input(id, 'exit\r');
  ok(await until(() => EXITS.some(e => e.id === id), 12000, '等 onExit'),
     '会话退出会通知渲染侧（界面才能标"已退出"）');
  ok(await until(() => has(id, '会话已退出'), 6000, '等退出提示'),
     '退出时往数据流里补一句人话（不是静默断掉）');
  const alive2 = TERM.list().find(x => x.id === id);
  ok(!!alive2 && alive2.alive === false, 'list() 里这个标签变成 not alive');
  mark = (BUF[id] || '').length;
  const back = TERM.input(id, 'echo RESTARTED_OK\r');
  ok(back.ok, '对着已退出的标签敲键会自动重开', JSON.stringify(back));
  ok(await until(() => after(id, mark, 'RESTARTED_OK'), 15000, '等重开后的回显'),
     '重开的会话能用（不是"按键没反应"）');

  p('');
  p('===== 八、出错路径要诚实 =====');
  const bad = TERM.input('从来没有过的标签', 'x');
  ok(bad.ok === false && !!bad.error, '对不存在的标签输入 → 明确报错，而不是静默吞掉',
     JSON.stringify(bad));
  const badRz = TERM.resize('从来没有过的标签', 80, 24);
  ok(badRz.ok === false, '对不存在的标签 resize → 明确报错');
  const badCwd = TERM.ensure('test-badcwd', { cwd: 'Z:\\这个目录不存在', profile:'powershell' });
  ok(badCwd.ok, '给一个不存在的 cwd 也能起（回落到主目录），不是直接失败', JSON.stringify(badCwd));
  TERM.kill('test-badcwd');
  const badProf = TERM.ensure('test-badprof', { profile:'zsh-不存在' });
  ok(badProf.ok, '认不出的 profile 也能起（回落 powershell）');

  p('');
  p('===== 九、收尾：不能留孤儿进程 =====');
  const before = TERM.list().length;
  TERM.killAll();
  const left = TERM.list().length;
  ok(left === 0, 'killAll 之后一个会话都不剩（' + before + ' → ' + left + '）',
     '残留 ' + left + ' 个');
  const killAgain = TERM.kill(id);
  ok(killAgain.ok, '对已经不在的标签再 kill 一次也不报错（幂等）');

  finish();
})().catch(e => {
  p('[!] 测试自身抛错：' + (e && e.message));
  out.push('  失败项 = ' + (fails.concat(['测试自身抛错']).join(' ｜ ')));
  try { TERM.killAll(); } catch (err) { /* */ }
  fs.writeFileSync(path.join(__dirname, '_termtest.txt'), out.join('\n') + '\n', 'utf8');
  process.exit(1);
});

function finish(){
  p('');
  p('===== 结论 =====');
  p('  失败项 = ' + (fails.length ? fails.join(' ｜ ') : '无'));
  p('  说明：这里测的 term.js 是**纯 Node 模块**，所以这些结论与 Electron 无关；');
  p('        "Electron 主进程里挂得对不对"由 _ptyspike.js 与桌面自检负责。');
  fs.writeFileSync(path.join(__dirname, '_termtest.txt'), out.join('\n') + '\n', 'utf8');
  process.exit(fails.length ? 1 : 0);
}
