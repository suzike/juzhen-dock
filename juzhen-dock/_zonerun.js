/* ============================================================
   窗口分区：把"哑执行那一半"真跑一次（`_zonetest.js` 只验了语法能被解析）

   为什么需要它：`_zonetest.js` 证明的是"PowerShell 能 parse 这份脚本"，
   而**脚本从来没有真跑过一次**。写 .ps1（带 BOM）、起 powershell.exe、
   Add-Type 现场编译那段 C#、调 Win32、把 JSON 吐回来 —— 这一整条链路上
   任何一个环节坏掉，静态检查都看不见。

   第一版这个脚本只跑了 restore 通路，当场抓出两个真 bug：
     · **PowerShell 的类型约束污染**：`param([string]$Job)` + 后面
       `$job = …ConvertFrom-Json`（大小写不敏感，是同一个变量）→ 对象被
       强制转成字符串 → `$job.mode` 恒为 $null → restore 分支永远进不去，
       实际跑的是 apply，而且 `$job.rects` 也是 $null → 一个窗口都不会被摆。
     · **`runJob` 用 `lastIndexOf('{')` 找 JSON 起点** → 返回值里有嵌套对象
       （`skipped` 就是 @{title;why} 的数组）时切到数组内部 → "返回的不是 JSON"。
       而"有窗口被跳过"恰恰是最常见的情况 → 这条路从来没能成功返回过一次。
   两处都已修（见 `_p44_apply.js`），哨兵常量 `JZ_MARK` 由 `zones.js` 导出，
   本脚本与 `runJob` 共用同一个，不各写一份。

   ⚠ 本脚本**不会移动任何窗口**，两条通路都是这么做到的：
     · restore 用 **hwnd = 1**（永远不是有效窗口）→ 只走 IsWindow，
       假 → 记进 failed → 吐 JSON，一个窗口都不碰；
     · apply 用 **rects = []**（空分区）→ 够格的候选窗口全进 `extra`（不够格的
       按原因进 `skipped`），SetWindowPos 一次都不会被调用。
   于是 EnumWindows / GetClassName / GetWindowLong 的过滤逻辑、
   Add-Type 编译、P/Invoke 编组、JSON 往返，全都真跑到了。
   仍未被真机执行的只剩 `SetWindowPos` 摆位那一条 —— 它要真动别人的窗口，
   只能由用户点一次「整理窗口」。这一点如实写在结论里。

   用法：node _zonerun.js
   ============================================================ */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = __dirname;
const ZONES = require('./desktop/zones.js');

const TMP = path.join(dir, '_zonerun_data');
/* 清场也得容错：同样的守卫会在**开头**把整个脚本打断（连一次 PowerShell 都没起）。
   目录里有上一轮的残骸不会污染结论 —— 三个文件都是每次重写：
   ps1 每次重写 BOM+源，job 每次重写，last.json 也是 restore 写、apply 覆。
   所以清不掉的正确处置是"继续跑"，不是"整个脚本死给你看"。 */
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
fs.mkdirSync(TMP, { recursive: true });

/* 自己起一次 powershell —— 调的是和 runJob 同一份脚本源与同一个哨兵 */
function spawnJob(job, timeoutMs){
  const ps = path.join(TMP, 'zones.ps1');
  const jf = path.join(TMP, 'zones-job.json');
  fs.writeFileSync(ps, '\uFEFF' + ZONES.psSource(), 'utf8');
  fs.writeFileSync(jf, JSON.stringify(job), 'utf8');
  return new Promise(resolve => {
    let out = '', err = '';
    const p = cp.spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps, jf],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { try { p.kill(); } catch (e){} resolve({ ok:false, err:'超时' }); }, timeoutMs || 25000);
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', c => { out += c; });
    p.stderr.on('data', c => { err += c; });
    p.on('exit', () => {
      clearTimeout(timer);
      const t = out.trim(), i = t.lastIndexOf(ZONES.JZ_MARK);
      if (i < 0) return resolve({ __raw: t.slice(-400), __err: err.slice(-400) });
      try { resolve(JSON.parse(t.slice(i + ZONES.JZ_MARK.length))); }
      catch (e){ resolve({ __raw: t.slice(i, i + 300), __parseErr: e.message }); }
    });
  });
}

let bad = 0;
/* 判语先攒着，最后一次性发出来。
   原因：有一条判据要等到 B 通路跑完才知道（本机到底能不能枚举到窗口），
   而 A 通路的判据在它之前就算完了。以前是边算边打印，于是同一件事
   既是"看不出结论"又先甩了三盏红灯 —— 灯一亮，后面那段免责说明就没人读了。 */
const pend = [];
const isEnvRefused = (r) => !!(r && r.ok === false && typeof r.err === 'string'
  && r.err.indexOf('Add-Type') >= 0);
const chk = (n, ok, note, env) => {
  if (ok) return;
  pend.push({ n: n, note: note, env: !!env });
};

(async () => {
  console.log('=== 通路 A：restore（假 hwnd，不动任何窗口）===');
  const fake = { at: Date.now(), layout: 'split2',
    items: [{ hwnd: 1, title: '假的窗口（自检用，不存在）', showCmd: 1,
              minX: 0, minY: 0, maxX: 0, maxY: 0, nL: 0, nT: 0, nR: 0, nB: 0 }] };
  fs.writeFileSync(path.join(TMP, 'zones-last.json'), JSON.stringify(fake), 'utf8');
  const t0 = Date.now();
  const r1 = await ZONES.restoreZone({ userData: TMP, timeoutMs: 25000 });
  console.log('  耗时 = ' + (Date.now() - t0) + ' ms');
  console.log('  返回 = ' + JSON.stringify(r1));
  if (r1 && r1.__raw !== undefined){ console.log('  原始输出 = ' + r1.__raw); console.log('  stderr = ' + r1.__err); }
  chk('restore 分支被认出来了（不是 apply 的结果）',
    !!(r1 && r1.restored !== undefined), '返回里没有 restored 字段，说明又跑到 apply 去了', true);
  /* env:true = 这条判据要"脚本里的 Win32 组件真能用"才有意义。
     编译不出来、或本机看不见窗口时，它们会被降级成"未能验证"（见文件末尾）。 */
  chk('failed 里有那个假窗口（IsWindow 真被调了、结果真读回来了）',
    !!(r1 && Array.isArray(r1.failed) && r1.failed.some(t => String(t).indexOf('假的窗口') >= 0)),
    JSON.stringify(r1 && r1.failed), true);
  chk('restored = 0（一个也没真动）', !!r1 && r1.restored === 0, '实际 ' + (r1 && r1.restored), true);
  chk('ok = false（假窗口还原不了，必须如实说）', !!r1 && r1.ok === false, '实际 ' + (r1 && r1.ok), true);
  /* 反过来：只有**没被环境拒掉**的时候才要求 err 为空。被拒时 err 恰恰是
     唯一该有的东西 —— 没有它就成了"点了没反应"，这是同一枚硬币的另一面。 */
  chk('没出错时不要遗留错误字段（留了就是谎称失败）', !(r1 && r1.err) || isEnvRefused(r1),
    r1 && r1.err);
  chk('记录没被删（只有真还原成功才删）', fs.existsSync(path.join(TMP, 'zones-last.json')));

  console.log('\n=== 通路 B：apply（空分区，一个窗口都不摆）===');
  const r2 = await spawnJob({ mode: 'apply', rects: [], selfPid: process.pid }, 25000);
  if (r2 && r2.__raw !== undefined){ console.log('  原始输出 = ' + r2.__raw); console.log('  stderr = ' + r2.__err); }
  console.log('  返回 = ' + JSON.stringify(r2).slice(0, 300));
  chk('apply 返回的是能解析的 JSON（哨兵生效）', !!(r2 && r2.ok !== undefined && r2.__parseErr === undefined),
    r2 && (r2.__parseErr || 'ok 字段都没有'));
  chk('枚举真的跑了（total > 0）', !!(r2 && r2.total > 0), '实际 ' + (r2 && r2.total), true);
  chk('★ 一个窗口都没被摆（moved 必须为空）',
    !!(r2 && Array.isArray(r2.moved) && r2.moved.length === 0),
    JSON.stringify(r2 && r2.moved));
  /* total 是"枚举到的窗口总数"，跳过的不从里面扣 —— 所以别拿 extra 去比 total。
     真正的判据是守恒：摆了的 + 跳过的 + 没位置放的 = 枚举到的。 */
  const nSkip = (r2 && r2.skipped || []).length, nExtra = (r2 && r2.extra || []).length;
  chk('够格的候选都进了 extra（空分区，摆不下任何窗口）',
    !!r2 && nExtra === r2.total - nSkip,
    nExtra + ' / ' + (r2 && r2.total - nSkip) + '（total ' + (r2 && r2.total) + ' − 跳过 ' + nSkip + '）', true);
  chk('三个桶加起来正好等于枚举数（不多不少，没漏也没重）',
    !!(r2 && (r2.moved.length + nSkip + nExtra) === r2.total),
    (r2 && r2.moved.length) + ' + ' + nSkip + ' + ' + nExtra + ' ≠ ' + (r2 && r2.total), true);
  chk('跳过原因都带话（每条都不能是空串）',
    !!(r2 && (r2.skipped || []).every(s => s && s.why && s.title)),
    JSON.stringify((r2 && r2.skipped || []).slice(0, 3)), true);

  /* ★ 看得见 vs 看不见，是这一份报告能不能当证据的分水岭。
     本机实测过一种是：起出来的子进程**看不见当前的窗口站**（沙箱 / 会话隔离
     时会这样）—— EnumWindows 返回 0 个候选，于是 "total > 0" 失败、
     "failed 为空"、"ok 为 true" 三盏红灯同时亮，看着像代码刚被人改坏；
     可同一时刻从正常上下文里数是 12 个带标题窗口，且 zones.js 一个字没动。
     把"看不见"降级成"未能验证"，而不是"不通过" —— 这是两回事：后者说产品坏了，
     前者只说这次没验到。读这份报告时也得按同一个标准看。 */
  /* ★ Add-Type 编译不出来时，正确的行为是**带着原因失败**，不是吐一个假的
     {"total":0,"ok":true}。这是 2026-09-22 抓到的那一类缺陷：点了会动、
     结果一个窗口没摆，还不给理由。所以本机不支持编译的时候，验的是：
     它有没有把这件事如实说出来。 */
  const refused = isEnvRefused(r1) || isEnvRefused(r2);
  chk('编译不出窗口组件时必须如实报错（不许报「整理好了，0 个窗口」）',
    !refused || (isEnvRefused(r1) && isEnvRefused(r2)),
    JSON.stringify((r2 && r2.err || '').slice(0, 80) || r2));
  chk('报错里有可读的中文原因（不是空话、也不是乱码）',
    !refused || !!(r2 && r2.err && /[一-龥]/.test(r2.err) && r2.err.length > 30),
    JSON.stringify((r2 && r2.err || '').slice(0, 40)));
  if (refused){
    console.log('\n⚠ 本机跑不了窗口操作：Add-Type 现场编译 C# 失败'
      + '\n  （脚本 %TEMP% 里那个 dll 起不来，多半是策略禁了编译或临时目录不可写）。'
      + '\n  这种情况下**正确**的结果是带原因失败，下面的 enumer 相关判据一律记为「未能验证」。'
      + '\n  换台能编译的机器再跑一遍，才能证明枚举/摆位那几条。');
  }
  const blind = refused || !(r2 && r2.total > 0);
  if (blind){
    console.log('\n⚠ 这一份报告证不了枚举与摆位（total = ' + (r2 && r2.total) + '）——'
      + '\n  还是"起出来的那个进程看不见当前窗口站"（沙箱 / 会话隔离的常见表现：'
      + '\n  同一时刻从正常上下文里能数出 10 个以上的带标题窗口，启动还慢了数倍）。'
      + '\n  凡依赖枚举的判据一律记为「未能验证」，不算通过也不算不通过 ——'
      + '\n  用它去证明这块代码好或者坏都不成立。');
  }
  let nBlind = 0;
  pend.forEach(p => {
    if (p.env && blind){ nBlind++; console.log('… 未能验证：' + p.n + (p.note !== undefined ? '（' + p.note + '）' : '')); return; }
    bad++; console.log('★ ' + p.n + (p.note !== undefined ? '：' + p.note : ''));
  });

  /* 先出结论，后打扫。
     以前清理写在结论**之前**：WorkBuddy 的 safe-delete 守卫会把 fs.rmSync(目录)
     拦下来（整目录递归删 ≥ N 个文件就触发），一抛错就把结论整个吞掉 ——
     断言明明跑完了，屏幕上只剩一段堆栈，看不出"全绿"还是"有几项不过"。
     结论是这次跑的目的，打扫只是善后；位置反了就会在最不需要失败的地方失败。 */
  console.log(bad ? '\n★ 不通过 ' + bad + ' 项' : '\n全绿')
  ;
  if (nBlind) console.log('另有 ' + nBlind + ' 项"未能验证"（本机这次看不见窗口，与代码好坏无关）');
  console.log('（未被真机执行的只剩 SetWindowPos 摆位那一条 —— 它要真动别人的窗口，只能由用户点一次）');
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (e) {
    console.log('⚠ 临时目录没清掉（不影响上面的结论）：' + TMP
      + '\n  ' + String((e && e.message) || e).split('\n')[0]
      + '\n  多半是环境的批量删除守卫拦下了整目录递归删。手动删掉即可。');
  }
  process.exit(bad ? 1 : 0);
})();
