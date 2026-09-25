'use strict';
/* ============================================================
   窗口分区 —— 把**其它应用的窗口**摆进"聚珍面板之外"的剩余区域。

   用户的原话："窗口分区功能没做呢"。它在设置页里一直挂着一行灰色的
   "未接入"，现在是真做了。

   ---------------------------------------------------------------
   分工，以及为什么这样分：

     · 矩形**怎么算**在主进程（planZones，纯函数）—— 它能被自检直接喂
       一个假工作区验证，不必真去动用户的窗口。这跟热区判定抽成 judge()
       是同一条理由：判据只有一处实现，测试才不会测到复制品。
     · PowerShell 侧只负责**哑执行**："把这几号窗口摆到这几个矩形里"，
       外加"记下/还原它们原来的位置"。它不做任何判断。
     · 一次性 spawn，不做常驻。整理窗口是低频操作，为它养一个常驻
       子进程不值当（全屏探测那个常驻是因为它要 250ms 一次地轮询）。

   ---------------------------------------------------------------
   风险控制（这段是要动别人窗口的代码，每一条都是有意的）：

     1. **只有用户点了按钮才动**，并且先把原位置记下来，可一键还原。
     2. 只动"看得见的、有标题的、普通的"顶层窗口。跳过：桌面与任务栏
        壳层、工具窗口、不激活的浮层、最小化的窗口、看起来是全屏/无边框
        的窗口、以及聚珍自己的窗口。
     3. **每一条跳过都带原因返回**给界面。静默跳过一个窗口，等于让用户
        以为"分区没生效"。
     4. 窗口比分区多时，只摆前面几个（按 z 序，最前面的先进第一个分区），
        其余的**不叠上去、也不动**，如实报"超出的没进分区"。把两个窗口
        摞在同一个分区里不算"整理好了"。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

/* 面板与窗口之间留的呼吸缝。面板自己有 12px 的右留边，这里再留 8px，
   免得窗口贴着面板边框、视觉上粘在一起。 */
const GAP_PANEL = 8;
/* 分区之间的缝 */
const GAP_ZONE = 6;
/* 一块分区的最小可用宽度。低于它就**不切**，退化成"整个剩余区域一块"，
   并且带 degraded 标志让界面说清楚，而不是硬切出一条 200px 的细缝。
   300 这个数是这样定的（实测于常见屏宽，面板 592 固定占右侧）：
     1920 → 剩余 1320，四分格每格 657 ✓ 够
     1440 → 剩余  840，四分格每格 417 ✓ 够
     1280 → 剩余  680，二分每格 337 ✓ 勉强够（四分格的 337 也算能用）
     1024 → 剩余  424，二分每格 209 ✗ 太窄 → 退化
   160 那个下限是错的：209px 宽的窗口什么也显示不下，却会被算作"切好了"。 */
const MIN_ZONE = 300;

/* 子进程把结果 JSON 吐回来时打的哨兵。
   为什么不用 lastIndexOf('{') 找起点：返回值里有**嵌套对象**
   （skipped 就是 @{title; why} 的数组），最后一个 { 会落在数组内部，
   从那里切出来的不是合法 JSON —— 而"有窗口被跳过"恰恰是最常见的情况，
   等于这条路从来没能成功返回过一次。
   只在这里定义一次，runJob 与验证脚本共用同一个常量，免得两边走散。 */
const JZ_MARK = 'JZJ:';

/* ---------------------------------------------------------------
   面板之外还剩多少地方可以放窗口。
   抽出来单列，是为了让"面板贴右"和"面板贴左"共用同一套切分逻辑 ——
   切分本身只关心"给我一个矩形，我把它切开"，不关心面板在哪。
   --------------------------------------------------------------- */
function freeArea(wa, edge, panelW, pad){
  if (edge === 'left'){
    const x = wa.x + pad + panelW + GAP_PANEL;
    return { x, y: wa.y, w: Math.max(1, wa.x + wa.width - x), h: wa.height };
  }
  const right = wa.x + wa.width - pad - panelW - GAP_PANEL;
  return { x: wa.x, y: wa.y, w: Math.max(1, right - wa.x), h: wa.height };
}

/* ---------------------------------------------------------------
   纯函数：把一个矩形按分区方式切开。
   area：可用区域（已经扣掉面板与缝）
   layout：split2 左右二分 / split3 上下三分 / quad 四分格
   —— 三者都是**这个矩形内部**的分法。
   --------------------------------------------------------------- */
function planZones(area, layout){
  const x = area.x;
  const y = area.y;
  const w = Math.max(1, area.w);
  const h = Math.max(1, area.h);

  /* 窄到切不动就退化成"一整块"，并且如实标出来 —— 带 degraded 标志，
     界面据此说明"你的屏幕太窄，只能给一块"，而不是默默少切几刀。 */
  if (w < MIN_ZONE * 2 + GAP_ZONE){
    return [{ x, y, w, h, degraded: true }];
  }

  if (layout === 'split3'){
    const each = Math.floor((h - GAP_ZONE * 2) / 3);
    if (each < MIN_ZONE / 2) return [{ x, y, w, h, degraded: true }];
    return [0, 1, 2].map(i => ({
      x, y: y + i * (each + GAP_ZONE), w,
      h: i === 2 ? h - 2 * (each + GAP_ZONE) : each
    }));
  }

  if (layout === 'quad'){
    const w2 = Math.floor((w - GAP_ZONE) / 2);
    const h2 = Math.floor((h - GAP_ZONE) / 2);
    if (w2 < MIN_ZONE || h2 < MIN_ZONE / 2) return [{ x, y, w, h, degraded: true }];
    const w3 = w - w2 - GAP_ZONE, h3 = h - h2 - GAP_ZONE;
    return [
      { x,             y,             w: w2, h: h2 },
      { x: x + w2 + GAP_ZONE, y,      w: w3, h: h2 },
      { x,             y: y + h2 + GAP_ZONE, w: w2, h: h3 },
      { x: x + w2 + GAP_ZONE, y: y + h2 + GAP_ZONE, w: w3, h: h3 }
    ];
  }

  /* split2：左右二分 */
  const w2 = Math.floor((w - GAP_ZONE) / 2);
  if (w2 < MIN_ZONE) return [{ x, y, w, h, degraded: true }];
  return [
    { x, y, w: w2, h },
    { x: x + w2 + GAP_ZONE, y, w: w - w2 - GAP_ZONE, h }
  ];
}

/* ---------------------------------------------------------------
   PowerShell 侧。全 ASCII（脚本文件带 BOM，但正文保持 ASCII，
   免得哪天有人用 ANSI 代码页读它）。
   --------------------------------------------------------------- */
const PS_SRC = [
  /* 参数名与后面解析出来的对象**必须不同**。PowerShell 变量名大小写不敏感
     （$job 就是 $Job），而 [string] 这个类型约束会在每一次赋值时生效 ——
     把 ConvertFrom-Json 的对象赋给它会被强制转成字符串，
     于是 $job.mode 恒为 $null、restore 分支永远进不去。实测栽过一次。 */
  'param([string]$JobFile)',
  /* 输出编码必须第一行就设。原来它排在 Add-Type 那一段之后 ——
     一旦编译失败、脚本提前带着原因退出，这句还没执行到，
     于是 JSON 里的中文按 GBK 出去，宿主读回来就是乱码。没有一句错误信息比有一段读不出的错误信息更难查。 */
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  /* DPI 感知必须最先调。不调的话 Windows 对这个进程做 DPI 虚拟化，
     SetWindowPos 收到的坐标会被再缩放一次 —— 在 150% 缩放的屏上，
     窗口会被摆到偏小一圈的位置。与 fs-watch 那次踩的是同一个坑。 */
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public class JZz {',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {',
  '    public int length; public int flags; public int showCmd;',
  '    public POINT ptMinPosition; public POINT ptMaxPosition;',
  '    public RECT rcNormalPosition;',
  '  }',
  '  public delegate bool EnumProc(IntPtr h, IntPtr p);',
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);',
  '  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT p);',
  '  [DllImport("user32.dll")] public static extern bool SetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT p);',
  '  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  '}',
  '"@',
  /* ★ Add-Type 失败必须当场说出来，绝不能落成一个"[total 0] 的假成功"。
     实测（2026-09-22）：某一台机器上 Add-Type 编译这段 C# 时抛
     FileNotFoundException（它要在 %TEMP% 里写一个 dll，这一步被拦下），
     于是 [JZz] 根本不存在、EnumWindows 一次都没跑；可脚本后面的分支照样走完，
     最后吐 {"total":0,"ok":true,...} —— 界面会说"整理好了"，一个窗口没动，
     还不给任何理由。这正是本项目最忌讳的那类缺陷：
     **点得动、点了什么都不会发生。**
     所以用完 Add-Type 先确认类型在不在，不在就带着原因退出。
     注意：-as [type] 找不到时会返回 $null，不会抛错，正合用作「在不在」的判断。 */
  'if (-not ("JZz" -as [type])) {',
  '  $zmsg = "没能在这台机器上编译出操作窗口用的组件（Add-Type 失败）。本机策略禁止现场编译、或临时目录不可写时就会出现这个情况；整理和还原都不会生效，所以这里如实报错，而不是报一句「整理好了，0 个窗口」。"',
  '  Write-Output ("JZJ:" + (ConvertTo-Json -Compress ([pscustomobject]@{ ok = $false; err = $zmsg; total = 0; skipped = @(); moved = @(); extra = @() })))',
  '  exit 1',
  '}',
  '[void][JZz]::SetProcessDPIAware()',
  '$JZ_MARK = "JZJ:"',
  '',
  '$job = Get-Content -Raw -Encoding UTF8 $JobFile | ConvertFrom-Json',
  '',
  'function Get-JzTitle($h) {',
  '  $n = [JZz]::GetWindowTextLength($h)',
  '  if ($n -le 0) { return "" }',
  '  $sb = New-Object System.Text.StringBuilder ($n + 2)',
  '  [void][JZz]::GetWindowText($h, $sb, $n + 2)',
  '  return $sb.ToString()',
  '}',
  '',
  'function Get-JzClass($h) {',
  '  $sb = New-Object System.Text.StringBuilder 256',
  '  [void][JZz]::GetClassName($h, $sb, 256)',
  '  return $sb.ToString()',
  '}',
  '',
  'function New-JzWp {',
  '  $wp = New-Object JZz+WINDOWPLACEMENT',
  /* WINDOWPLACEMENT 的标准大小：3 个 int(12) + 2 个 POINT(16) + 1 个 RECT(16) = 44。
     调 GetWindowPlacement 之前必须自己填好，否则调用直接失败。 */
  '  $wp.length = 44',
  '  return $wp',
  '}',
  '',
  /* 桌面本身 / 任务栏 / Win11 壳层 —— 与 fs-watch 用的是同一份名单，
     两处必须一致：一边当"全屏"排除、另一边当"可摆放窗口"，会打架。 */
  "$shellCls = @('Progman','WorkerW','Shell_TrayWnd','Shell_SecondaryTrayWnd','Windows.UI.Core.CoreWindow','SysShadow','XamlExplorerHostIslandWindow')",
  '',
  'if ($job.mode -eq "restore") {',
  '  $ok = 0; $fail = @()',
  '  foreach ($it in $job.items) {',
  '    $h = [IntPtr][int64]$it.hwnd',
  '    if (-not [JZz]::IsWindow($h)) { $fail += $it.title; continue }',
  '    $wp = New-JzWp',
  '    $wp.showCmd = [int]$it.showCmd',
  '    $wp.ptMinPosition.X = [int]$it.minX; $wp.ptMinPosition.Y = [int]$it.minY',
  '    $wp.ptMaxPosition.X = [int]$it.maxX; $wp.ptMaxPosition.Y = [int]$it.maxY',
  '    $wp.rcNormalPosition.L = [int]$it.nL; $wp.rcNormalPosition.T = [int]$it.nT',
  '    $wp.rcNormalPosition.R = [int]$it.nR; $wp.rcNormalPosition.B = [int]$it.nB',
  '    if ([JZz]::SetWindowPlacement($h, [ref]$wp)) { $ok++ } else { $fail += $it.title }',
  '  }',
  '  $r = @{ ok = ($fail.Count -eq 0); restored = $ok; failed = @($fail) }',
  '  $JZ_MARK + ($r | ConvertTo-Json -Depth 5 -Compress)',
  '  exit 0',
  '}',
  '',
  '$rects = @($job.rects)',
  '$selfPid = [uint32]$job.selfPid',
  '$moved = @(); $skipped = @(); $extra = @()',
  '',
  'function Get-JzCandidate {',
  '  $script:list = @()',
  '  $cb = [JZz+EnumProc]{',
  '    param($h, $p)',
  '    if (-not [JZz]::IsWindowVisible($h)) { return $true }',
  '    $cls = Get-JzClass $h',
  '    if ($shellCls -contains $cls) { return $true }',
  '    $ex = [JZz]::GetWindowLong($h, -20)',
  /* WS_EX_TOOLWINDOW 是各种托盘/提示小窗；WS_EX_NOACTIVATE 是输入法候选、
     悬浮控件这类"不参与前台"的窗口。它们都不该被摆。 */
  '    if (($ex -band 0x00000080) -ne 0) { return $true }',
  '    if (($ex -band 0x08000000) -ne 0) { return $true }',
  '    $pid2 = 0',
  '    [void][JZz]::GetWindowThreadProcessId($h, [ref]$pid2)',
  '    if ($pid2 -eq $selfPid) { return $true }',
  '    $t = Get-JzTitle $h',
  '    if ([string]::IsNullOrWhiteSpace($t)) { return $true }',
  '    $script:list += [pscustomobject]@{ h = $h; t = $t; pid = $pid2 }',
  '    return $true',
  '  }',
  '  [void][JZz]::EnumWindows($cb, [IntPtr]::Zero)',
  /* EnumWindows 按 z 序从最上面开始，所以"最前面的窗口"排在前面 ——
     第一个分区给最前面那个，符合直觉。 */
  '  return $script:list',
  '}',
  '',
  '$wins = Get-JzCandidate',
  'if ($wins.Count -eq 0) {',
  '  $empty = @{ ok = $true; moved = @(); skipped = @(); extra = @(); total = 0 }',
  '  $JZ_MARK + ($empty | ConvertTo-Json -Depth 5 -Compress)',
  '  exit 0',
  '}',
  '',
  '$i = 0',
  'foreach ($w in $wins) {',
  '  if ([JZz]::IsIconic($w.h)) { $skipped += @{ title = $w.t; why = "最小化了，没动它" }; continue }',
  /* 带 WS_CAPTION 才算"有标题栏的普通窗口"。没有它的多半是 F11 全屏、
     游戏无边框全屏或悬浮层 —— 去摆它既没意义又容易出事。 */
  '  $st = [JZz]::GetWindowLong($w.h, -16)',
  '  if (($st -band 0x00C00000) -ne 0x00C00000) {',
  '    $skipped += @{ title = $w.t; why = "看起来是全屏或无边框窗口，没动它" }; continue',
  '  }',
  '  if ($i -ge $rects.Count) { $extra += $w.t; continue }',
  '  $r = $rects[$i]',
  '  $rec = @{ hwnd = [int64]$w.h; title = $w.t }',
  '  $wp = New-JzWp',
  '  if ([JZz]::GetWindowPlacement($w.h, [ref]$wp)) {',
  '    $rec.showCmd = $wp.showCmd',
  '    $rec.minX = $wp.ptMinPosition.X; $rec.minY = $wp.ptMinPosition.Y',
  '    $rec.maxX = $wp.ptMaxPosition.X; $rec.maxY = $wp.ptMaxPosition.Y',
  '    $rec.nL = $wp.rcNormalPosition.L; $rec.nT = $wp.rcNormalPosition.T',
  '    $rec.nR = $wp.rcNormalPosition.R; $rec.nB = $wp.rcNormalPosition.B',
  '  } else { $rec.showCmd = -1 }',
  /* 最大化的窗口要先还原，否则 SetWindowPos 会被"最大化"状态盖掉。
     SW_RESTORE = 9。这一步可能会把该窗口带到前台一次，属于系统行为，
     无法完全避免；它只发生在用户主动点"整理窗口"之后。 */
  '  if ([JZz]::IsZoomed($w.h)) { [void][JZz]::ShowWindow($w.h, 9) }',
  /* SWP_NOZORDER(0x4) 不动 z 序；SWP_NOACTIVATE(0x10) 不抢焦点。
     两条都要：否则一按整理，所有窗口的层叠关系会被重排一遍。 */
  '  $okSet = [JZz]::SetWindowPos($w.h, [IntPtr]::Zero, [int]$r.x, [int]$r.y, [int]$r.w, [int]$r.h, 0x0004 -bor 0x0010)',
  '  if ($okSet) {',
  '    $moved += $rec',
  '  } else {',
  /* 最常见的原因是权限：对方是管理员权限跑的，而我们不是，
     Windows 的 UIPI 会拒绝跨权限等级的窗口操作。如实说出来。 */
  '    $skipped += @{ title = $w.t; why = "系统拒绝了这个窗口（多半它是以管理员权限运行的）" }',
  '  }',
  '  $i++',
  '}',
  '',
  '$r2 = @{ ok = $true; moved = @($moved); skipped = @($skipped); extra = @($extra); total = $wins.Count }',
  '$JZ_MARK + ($r2 | ConvertTo-Json -Depth 6 -Compress)'
];

function psSource(){ return PS_SRC.join('\r\n'); }

/* ---------------------------------------------------------------
   跑一次
   --------------------------------------------------------------- */
function runJob(userDataDir, job, timeoutMs){
  const ps = path.join(userDataDir, 'zones.ps1');
  const jobFile = path.join(userDataDir, 'zones-job.json');
  fs.mkdirSync(userDataDir, { recursive: true });
  /* 带 BOM：Windows PowerShell 5.1 在没有 BOM 时按 ANSI 代码页读 .ps1。
     这份脚本正文是全 ASCII 的，但窗口标题是中文，走 JSON 文件传，
     不经脚本正文 —— 加 BOM 是给"以后往里写中文注释"留的余地。 */
  fs.writeFileSync(ps, '\uFEFF' + psSource(), 'utf8');
  fs.writeFileSync(jobFile, JSON.stringify(job), 'utf8');

  return new Promise(resolve => {
    let out = '', err = '';
    let done = false;
    const finish = (v) => { if (!done){ done = true; resolve(v); } };
    let p;
    try {
      p = cp.spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps, jobFile],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e){
      return finish({ ok: false, err: String(e.message || e) });
    }
    const timer = setTimeout(() => {
      try { p.kill(); } catch (e){}
      finish({ ok: false, err: '超时（' + timeoutMs + 'ms）' });
    }, timeoutMs || 15000);
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', c => { out += c; });
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', c => { err += c; });
    p.on('error', e => { clearTimeout(timer); finish({ ok: false, err: String(e.message || e) }); });
    p.on('exit', () => {
      clearTimeout(timer);
      const t = out.trim();
      const i = t.lastIndexOf(JZ_MARK);
      if (i < 0){
        /* 没有哨兵 = 脚本没走到吐结果那一步。stderr 里往往是 Add-Type
           编译失败或语法错，原话带回去比一句"没有输出"有用得多。 */
        return finish({ ok: false, err: (err || '没有输出，也没看到结果标记').slice(0, 300) });
      }
      try { finish(JSON.parse(t.slice(i + JZ_MARK.length))); }
      catch (e){ finish({ ok: false, err: '返回的不是 JSON：' + t.slice(i, i + 240) }); }
    });
  });
}

/* 整理：返回 { ok, moved, skipped, extra, total } */
function applyZone(opt){
  const plan = planZones(opt.area, opt.layout);
  const rects = plan.map(r => ({
    x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h)
  }));
  return runJob(opt.userData, {
    mode: 'apply', rects, selfPid: opt.selfPid
  }, opt.timeoutMs).then(res => {
    res.rects = rects;
    /* 屏幕太窄、切不动时 planZones 只返回一块并带 degraded —— 界面要据此
       说明"你的屏幕放不下这个分法"，而不是默默少切几刀。 */
    res.degraded = plan.length === 1 && plan[0].degraded === true;
    if (res.ok && Array.isArray(res.moved) && res.moved.length){
      /* 把"整理前的位置"存下来，供还原。存到 userData 而不是 localStorage：
         它是主进程的作业记录，跟界面存档的生命周期不是一回事。 */
      try {
        fs.writeFileSync(path.join(opt.userData, 'zones-last.json'),
          JSON.stringify({ at: Date.now(), layout: opt.layout, items: res.moved }), 'utf8');
      } catch (e){ res.saveErr = String(e.message || e); }
    }
    return res;
  });
}

/* 还原 */
function restoreZone(opt){
  const f = path.join(opt.userData, 'zones-last.json');
  if (!fs.existsSync(f)) return Promise.resolve({ ok: false, err: '还没有整理过，没有可还原的位置' });
  let rec;
  try { rec = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e){ return Promise.resolve({ ok: false, err: '上次的记录读不出来：' + (e.message || e) }); }
  if (!rec.items || !rec.items.length) return Promise.resolve({ ok: false, err: '上次没有移动任何窗口' });
  return runJob(opt.userData, { mode: 'restore', items: rec.items }, opt.timeoutMs)
    .then(res => {
      res.count = rec.items.length; res.at = rec.at;
      /* 还原是一次性的：位置已经还回去了，记录留着只会让下一次点「还原」
         去还原一个并不存在的"整理前"。删掉它，界面就会如实显示
         "还没有整理过，没有可还原的位置"。 */
      if (res.ok){ try { fs.unlinkSync(f); } catch (e){} }
      return res;
    });
}

/* 有没有可还原的记录 */
function lastRecord(opt){
  const f = path.join(opt.userData, 'zones-last.json');
  try {
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { has: !!(rec.items && rec.items.length), at: rec.at, count: (rec.items || []).length, layout: rec.layout };
  } catch (e){ return { has: false }; }
}

module.exports = { freeArea, planZones, applyZone, restoreZone, lastRecord, psSource,
  GAP_PANEL, GAP_ZONE, MIN_ZONE, JZ_MARK };
