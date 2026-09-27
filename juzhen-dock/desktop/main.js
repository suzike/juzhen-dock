/* ============================================================
   聚珍 · Electron 主进程
   ------------------------------------------------------------
   窗口策略（关键）：不做"全屏透明窗口 + 鼠标穿透"那一套。
   全屏透明窗口在 Windows 上必须靠 setIgnoreMouseEvents 反复切换，
   一旦切错就把桌面点不动了。这里改成：

     收起态  →  win.hide()。窗口不存在，桌面完全不受影响。
     展开态  →  win.show()，窗口精确覆盖右侧面板那一条。

   边缘热区因此不能靠 DOM 事件，改用主进程轮询屏幕坐标
   （screen.getCursorScreenPoint，约 40ms 一次，开销可忽略）。
   这样"鼠标贴到屏幕右缘停留"这件事与窗口是否可见彻底解耦。
   ============================================================ */

const { app, BrowserWindow, screen, ipcMain, shell, clipboard, globalShortcut,
        dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');   /* spawn = 全屏探测常驻子进程；execFile = 场景里的命令动作 */
/* AI 请求拆到独立模块：它不依赖 electron，所以本地 node 就能跑（见 _aitest.js）。
   顺带一个坑：package.json 的 build.files 是白名单，新增的 .js 不登记进去，
   开发模式一切正常、打包之后才会 "Cannot find module" —— 构建期守则会核对
   这里每一个 require 都在白名单里。 */
const AI = require('./ai.js');
/* 真终端拆到 term.js：同一个理由（不依赖 electron、本地 node 能直跑，
   见 _termtest.js）。它 require 的 @lydell/node-pty 是**原生模块**，
   package.json 的 build.files 与 asarUnpack 都要单独登记，
   否则开发模式能起终端、打包之后一句 "Cannot find module" 就废了。 */
const TERM = require('./term.js');
/* 知识库同样拆成独立模块（不依赖 electron，见 _kbtest.js）。它要读 PDF / Word，
   所以还多两个纯 JS 依赖（pdf-parse / mammoth）—— 这两个也必须登记进
   package.json 的 build.files，否则打包后一加 PDF 就报 "Cannot find module"。 */
const KB = require('./kb.js');
const ZONES = require('./zones.js');   /* 窗口分区：把其它窗口摆进面板之外的剩余区域 */

/* 存档目录显式用英文名。productName 是「聚珍」，Electron 默认拿它当目录
   （AppData\Roaming\聚珍）—— 中文路径在 Windows 上用起来没问题，但一旦要接
   命令行工具、日志归集或者跨机同步，中文路径就是个随时会绊人的隐患。
   界面上的产品名不受影响。必须在 app ready 之前设。 */
/* 自检用独立的存档目录。原因很实在：单实例锁是按 userData 走的，
   而"用户正开着聚珍、这边想跑一遍自检"是常态 —— 共用一个目录时，
   自检会因为抢不到锁直接退出，表现成"自检什么都没生成"，完全看不出原因。
   分开之后两边能并存，自检也不会写进用户的真实存档。 */
app.setPath('userData', path.join(app.getPath('appData'),
  process.env.JZ_DIAG ? 'juzhen-dock-diag' : 'juzhen-dock'));

/* ---- 几何常量：必须与 _css.txt 里的 .panel 保持一致 ---- */
const PANEL_W  = 580;   // .panel width
const PANEL_PAD = 12;   // .panel top/bottom/right 偏移
/* 窗口比面板宽：面板右边留 12px，左边那 88px 是面板外投影（模糊 80px）
   的透明通道。窗口越宽，面板打开时被遮住的桌面越多，所以别贪心。 */
const WIN_W    = PANEL_W + PANEL_PAD + 88;   // 680
const HOT_W    = 12;    // .hotzone width
/* 鼠标贴边停留多久算"想唤出"。默认跟渲染侧的 state.delay 一致，
   实际值由渲染进程在启动和调滑杆时同步过来（见 panel:delay）。 */
let DWELL = 260;
const LEAVE_MS = 520;   // 鼠标离开面板多久后收起（自动唤出模式下）
const POLL_MS  = 40;

const HOT_ENABLED = true;   // 边缘热区总开关（设置页可后续接到这里）

let win = null;
let storeFile = '';

const S = {
  open: false,
  pinned: false,
  source: 'auto',      // 'auto' = 热区滑出（不抢焦点）| 'key' = 快捷键（抢焦点）
  hovering: false,     // 指针是否停留在面板矩形内
  dwellStart: 0,
  leaveStart: 0,
  lastDisplay: -1,
  hiding: false
};

/* 页面里冒出来的警告/错误攒在这里，自检时一并吐出。
   窗口应用的报错最容易"静默"——控制台没人看，界面照常显示。 */
const PAGE_ERRORS = [];

/* ============================================================
   贴图钉窗
   ------------------------------------------------------------
   「贴图钉屏」的本体：每条贴图记录对应一个独立的无边框置顶小窗。
   三个决定值得写下来：
   · 钉窗是独立 BrowserWindow，不是面板里的一层 —— 收起/关闭面板，
     钉着的参考图必须还留在桌面上，这是这个功能存在的理由；
   · 窗口几何（x/y/w/h）记在 userData/shots-pin.json，**不**进面板存档：
     窗口摆位归窗口管，记录内容（名称/透明度/图片来源）归存档管。
     混在一起就会出现"存档里躺着一扇打不开的窗"；
   · 透明度只有一份事实来源 —— 面板记录里的 op。钉窗上的滑杆改动
     推回面板落档，两边谁也不私藏：不然两根滑杆各改各的，
     下次钉回来透明度又变回去，用户只会觉得"这东西记不住"。
   ============================================================ */
const PINS = new Map();   // id -> { win, rec }

/* Windows 路径 → file:// URL。中文与空格交给 encodeURI；
   encodeURI 不会碰 # 和 ?（它们是保留字），所以要单独补编码。 */
function fileUrlOf(p){
  const u = String(p || '').replace(/\\/g, '/');
  return 'file:///' + encodeURI(u).replace(/#/g, '%23').replace(/\?/g, '%3F');
}
function shotGeomPath(){
  return path.join(app.getPath('userData'), 'shots-pin.json');
}
function shotGeomRead(){
  try {
    const d = JSON.parse(fs.readFileSync(shotGeomPath(), 'utf8'));
    return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
  } catch (e){ return {}; }
}
function shotGeomWriteAll(o){
  try { fs.writeFileSync(shotGeomPath(), JSON.stringify(o), 'utf8'); } catch (e){}
}
/* 存档是外部输入，不能信（跟渲染侧的 fix 同一条纪律）：
   字段缺省给默认，数值夹进合法区间，图片不在了就带着原因拒绝。 */
function shotSanitize(rec){
  const id = String((rec && rec.id) || '');
  if (!id) return { error: '这条记录缺 id，钉不了' };
  const src = String((rec && rec.src) || '');
  if (!src) return { error: '这条记录还没有图片，先选一张或从剪切板钉' };
  if (!fs.existsSync(src)) return { error: '图片文件已经不在了：' + src };
  const num = (v, d, lo, hi) => {
    v = Number(v);
    if (!isFinite(v)) return d;
    return Math.min(hi, Math.max(lo, Math.round(v)));
  };
  return { rec: {
    id: id,
    src: src,
    url: fileUrlOf(src),
    t: String((rec && rec.t) || '贴图').slice(0, 60),
    w: num(rec && rec.w, 560, 120, 4096),
    h: num(rec && rec.h, 360, 90, 4096),
    op: num(rec && rec.op, 100, 30, 100),
    /* 主题主色（R20）：钉窗控制条跟它换装。只收 #RRGGBB 形态，
       其余一律空串回落钉窗默认色 —— 这是外部输入，不能信。 */
    acc: /^#[0-9a-fA-F]{6}$/.test(String((rec && rec.acc) || '')) ? String(rec.acc) : ''
  } };
}

/* ============================================================
   存档文件
   ============================================================ */
function storePath(){
  if (!storeFile) storeFile = path.join(app.getPath('userData'), 'store.json');
  return storeFile;
}
function readStore(){
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch (e){ return null; }
}
function writeStore(data){
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, file: storePath() };
  } catch (e){ return { ok: false, error: String(e.message || e) }; }
}

/* ============================================================
   子进程输出的编码
   ============================================================
   Windows 上这条流没有"正确答案"，只有"猜得比默认准一点"：
   同一个 cmd.exe 管道，内置命令（echo/dir/set）恒按 OEM 代码页（中文机上是
   GBK）写字节，而 Node/git 这类外部程序多按 UTF-8 写。chcp 管不到内置命令
   （见 sys:runCmd 的注释），所以只能看字节本身长什么样来判。

   三条判据按可靠度排序：
   1) 出现 NUL 且绝大多数落在奇数位 → 是 UTF-16LE（cmd 带 /u，或 where.exe
      这类直接吐宽字符的工具）。判据要卡在"NUL 落在奇数位"上而不是"NUL 占比
      够高"：纯中文的一句话按 UTF-16LE 编码时**一个 0x00 都没有**（每个码元
      两字节都非零），按占比判会漏掉它。反过来，只要流里出现了成对的 NUL，
      就基本不可能是 GBK 或 UTF-8 —— 这两种编码的文本里永远不会有 0x00。
      所以"NUL 存在且在奇数位"就足够定性，不需要再猜占比。
      说明白边界：**纯中文、且完全不含 ASCII 的 UTF-16LE 输出**（现实中几乎
      不存在 —— 会吐宽字符的工具输出里总带着路径、盘符、空格）仍会被误判成
      GB18030。要彻底解决得识别 BOM，那是另一件事，不值得为这个缝写。
   2) 严格 UTF-8 解得开 → 就是 UTF-8。fatal:true 是这里的关键：宽容模式会把
      非法序列替换成 U+FFFD 但**不抛错**，那样 GBK 字节会被"悄悄解码成功"，
      判据就废了（实测 GBK 字节走宽容 UTF-8 得到一串 U+FFFD，且不抛）。
   3) 前面都不成立 → 按 GB18030 解（GBK 的超集，能覆盖中文机默认代码页）。

   已知限制，如实写在这里：一条命令如果**同时**输出 GBK 和 UTF-8（比如
   `echo 中文 & node x.js`），整条流会落到同一条分支，另一半必然花掉。
   想彻底解决得换 ConPTY 或让用户自己声明编码，不值得为这个场景背上依赖。 */
let _td2 = null;
function decodeOut(buf){
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  if (!b.length) return '';
  let nul = 0, oddNul = 0;
  for (let i = 0; i < b.length; i++) if (b[i] === 0){ nul++; if (i % 2 === 1) oddNul++; }
  if (nul >= 2 && b.length % 2 === 0 && oddNul >= nul * 0.8) return b.toString('utf16le');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
  catch (e){
    try {
      if (!_td2) _td2 = new TextDecoder('gb18030');
      return _td2.decode(b);
    } catch (e2){ return b.toString('utf8'); }
  }
}

/* ============================================================
   窗口
   ============================================================ */
function panelGeom(disp){
  const wa = disp.workArea;
  return {
    x: wa.x + wa.width - WIN_W,
    y: wa.y,
    width: WIN_W,
    height: wa.height,
    panelLeft: wa.x + wa.width - PANEL_PAD - PANEL_W,
    wa
  };
}

function createWindow(){
  const g = panelGeom(screen.getPrimaryDisplay());
  S.lastDisplay = screen.getPrimaryDisplay().id;

  win = new BrowserWindow({
    x: g.x, y: g.y, width: g.width, height: g.height,
    show: false,
    icon: path.join(__dirname, 'icon.png'),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      /* 窗口藏起来之后渲染进程还要继续干活（剪切板常驻监听就靠它）。
         默认的 backgroundThrottling 会把隐藏窗口的定时器降到 1 秒一次，
         虽然不至于停摆，但这种"藏起来就变慢"的行为不值得留。 */
      backgroundThrottling: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));

  /* 点击面板以外 → 窗口失焦 → 收起（常驻模式除外）。
     这一条同时兜住了"点桌面别处自动收起"的期待。
     两种唤出方式都要管：热区滑出的窗口一开始没有焦点，但用户点一下
     面板就拿到了，再点桌面照样应该收起。 */
  win.on('blur', () => {
    if (S.pinned || S.hiding) return;
    closePanel('blur');
  });

  win.on('closed', () => { win = null; });

  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) PAGE_ERRORS.push('[warn/err] ' + message + ' @' + line);
  });
  win.webContents.on('render-process-gone', (_e, d) => PAGE_ERRORS.push('[renderer 崩溃] ' + JSON.stringify(d)));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => PAGE_ERRORS.push('[载入失败] ' + code + ' ' + desc + ' ' + url));
}

/* 把窗口挪到当前鼠标所在显示器（多屏扩展时面板跟手） */
function followCursorDisplay(disp){
  if (!win || disp.id === S.lastDisplay) return;
  S.lastDisplay = disp.id;
  const g = panelGeom(disp);
  win.setBounds({ x: g.x, y: g.y, width: g.width, height: g.height });
}

function openPanel(source){
  if (!win) return;
  S.source = source;
  if (S.open){
    if (source === 'key') win.focus();
    return;
  }
  S.open = true; S.hiding = false;
  const { panelLeft, wa } = panelGeom(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
  S.panelLeft = panelLeft; S.wa = wa;

  if (source === 'key'){ win.show(); win.focus(); }   // 快捷键：抢焦点，搜索框能直接打字
  else { win.showInactive(); }                        // 热区：不抢焦点，不打断手头的输入
  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.webContents.send('jz:panel', { open: true, source, pinned: S.pinned });
}

function closePanel(reason){
  if (!win || !S.open || S.hiding) return;
  if (S.pinned && reason !== 'force') return;
  S.hiding = true; S.open = false;
  win.webContents.send('jz:panel', { open: false, source: S.source, reason });
  /* 等渲染进程播完收起动画再真正隐藏；渲染侧也会回一个 ack。
     这里留一道兜底，防止渲染卡住导致窗口挂在桌面上收不走。 */
  clearTimeout(S.hideTimer);
  S.hideTimer = setTimeout(() => { if (S.hiding) reallyHide(); }, 640);
}

function reallyHide(){
  S.hiding = false;
  if (win && !S.pinned){ win.hide(); }
}

/* ============================================================
   全屏探测（设置页的"全屏应用时屏蔽热区"）
   ------------------------------------------------------------
   Electron 没有"前台窗口是谁"这个 API，也不想为一个开关去引一个需要本地
   编译的原生模块。折中办法：起一个常驻的 PowerShell 子进程，直接用
   user32 / dwmapi 问系统，每 250ms 往 stdout 写一行 0/1。

   三个必须踩准的坑（每一个都是"面板再也唤不出来"级别的误判）：
     · 桌面本身（Progman / WorkerW）和任务栏的窗口铺满整屏，必须按窗口类排除。
     · 最大化窗口的 GetWindowRect 会往外多算一圈，要换成 DwmGetWindowAttribute
       的 EXTENDED_FRAME_BOUNDS 拿真实可视边界；并且跟"整块屏幕"比而不是跟
       "工作区"比 —— 最大化的窗口不含任务栏，只有全屏播放/游戏才盖住整块屏。
     · 没标题的隐藏辅助窗口一概不算。
   子进程起不来（组策略禁用 PowerShell 之类）时 FS.ok 一直是 false，
   设置页会如实写"探测不可用"，而不是继续假装这个开关生效。
   ============================================================ */
const FS = { ok: false, active: false, proc: null, buf: '', err: '' };
let FS_BLOCK = true;   /* 与渲染侧 state.settings.fsBlock 的默认值一致，起来后同步 */

function fsState(){ return { ok: FS.ok, active: FS.active, err: FS.err || '' }; }
function sendFs(){
  if (win && !win.isDestroyed()) win.webContents.send('jz:fs', fsState());
}

const PS_SRC = [
  /* 父进程 PID 由主进程传进来。子进程必须能自己发现"爸爸没了"——
     Electron 的 app.exit() 不触发 will-quit，进程被强杀更不会，
     那时候 stopFsWatcher() 根本没机会跑，剩下这个循环会对着一个已经
     关掉的管道空转到天荒地老。自己盯着比指望退出钩子可靠。 */
  'param([int]$parentPid)',
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public class JZfg {',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  '  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint f);',
  '  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);',
  '  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int sz);',
  '}',
  '"@',
  /* 这一句是整段脚本的前提，别删。
     powershell.exe 的宿主不声明 DPI 感知，于是 Windows 对它是"DPI 虚拟化"的：
     GetMonitorInfo 会返回缩放过后的尺寸（1.5x 屏上是 1707x1067），而
     DwmGetWindowAttribute 的 EXTENDED_FRAME_BOUNDS 不管调用方是谁一律返回
     物理像素（2561x1529）。这两个数被拿来相比，结果必然是随机的 ——
     实测就是"最大化窗口反而被判成全屏"。先把自己标成 DPI 感知。 */
  '[void][JZfg]::SetProcessDPIAware()',
  /* 桌面本身 / 任务栏 / Win11 的壳层窗口：都不是"用户在看的全屏应用" */
  "$skip = @('Progman','WorkerW','Shell_TrayWnd','Shell_SecondaryTrayWnd','Windows.UI.Core.CoreWindow','SysShadow','XamlExplorerHostIslandWindow')",
  '',
  /* 判定抽成一个函数，而不是揉在循环里。理由跟渲染侧把热区判定抽成纯函数
     一样：这样测试可以拿任意窗口句柄直接喂进来验证，不必复制一份逻辑。
     （第一版的教训就是——复制出来的判据跟真身不同步，测了等于没测。） */
  'function Get-JzFull($h) {',
  '  if ($h -eq [IntPtr]::Zero) { return 0 }',
  '  $sb = New-Object System.Text.StringBuilder 128',
  '  [void][JZfg]::GetClassName($h, $sb, 128)',
  '  if ($skip -contains $sb.ToString()) { return 0 }',
  '  if (-not [JZfg]::IsWindowVisible($h)) { return 0 }',
  /* 带标题栏的窗口一律不算全屏。光比尺寸会栽在两件事上：最大化的窗口
     尺寸正好等于工作区；而一旦把任务栏设成自动隐藏，工作区就等于整块屏幕 ——
     那时"窗口最大化"会被判成全屏，面板就再也唤不出来了。
     真正的全屏（F11、游戏的无边框全屏）都会把 WS_CAPTION 去掉。 */
  '  $st = [JZfg]::GetWindowLong($h, -16)',
  '  if (($st -band 0x00C00000) -eq 0x00C00000) { return 0 }',
  '  $r = [JZfg+RECT]::new()',
  /* DWM 的 EXTENDED_FRAME_BOUNDS 才是窗口真正的可视边界；
     最大化的窗口用 GetWindowRect 会往外多算一圈系统边框。 */
  '  $hr = [JZfg]::DwmGetWindowAttribute($h, 9, [ref]$r, 16)',
  '  if ($hr -ne 0) { [void][JZfg]::GetWindowRect($h, [ref]$r) }',
  '  $mon = [JZfg]::MonitorFromWindow($h, 2)',
  '  if ($mon -eq [IntPtr]::Zero) { return 0 }',
  '  $mi = [JZfg+MONITORINFO]::new(); $mi.cbSize = 40',
  '  $ok = [JZfg]::GetMonitorInfo($mon, [ref]$mi)',
  '  if (-not $ok) { return 0 }',
  /* 跟"整块屏幕"比，不是跟"工作区"比：全屏播放/游戏盖住整块屏，
     最大化的窗口不盖任务栏那一条。 */
  '  $mw = $mi.rcMonitor.R - $mi.rcMonitor.L',
  '  $mh = $mi.rcMonitor.B - $mi.rcMonitor.T',
  '  if (($mw -le 0) -or ($mh -le 0)) { return 0 }',
  '  $w = $r.R - $r.L; $ht = $r.B - $r.T',
  /* 32000 是窗口最小化时 Windows 塞进来的哨兵坐标值 */
  '  if (($w -lt 32000) -and ($ht -lt 32000) -and ($w -ge ($mw - 2)) -and ($ht -ge ($mh - 2))) { return 1 }',
  '  return 0',
  '}',
  '',
  '$out = [Console]::Out',
  '$tick = 0',
  'while ($true) {',
  '  $tick++',
  /* 每 10 秒确认一次父进程还在。管道写失败（父进程没了，读端关闭）也立刻退出，
     两条路任一条先到都行 —— 宁可多守一道，也不要留一个空转的进程在别人机器上。 */
  '  if (($tick % 40) -eq 0) {',
  '    if ($parentPid -gt 0) {',
  '      $alive = Get-Process -Id $parentPid -ErrorAction SilentlyContinue',
  '      if (-not $alive) { break }',
  '    }',
  '  }',
  '  try {',
  '    $out.WriteLine([string](Get-JzFull ([JZfg]::GetForegroundWindow())))',
  '    $out.Flush()',
  '  } catch { break }',
  '  Start-Sleep -Milliseconds 250',
  '}'
];

function startFsWatcher(){
  try {
    const ps = path.join(app.getPath('userData'), 'fs-watch.ps1');
    fs.mkdirSync(path.dirname(ps), { recursive: true });
    /* 必须带 BOM。Windows PowerShell 5.1 在没有 BOM 时按系统 ANSI 代码页
       （简中是 GBK）解码 .ps1，脚本里只要出现一个非 ASCII 字符就会解析崩掉。
       现在这份脚本是全 ASCII 的，但加 BOM 让"以后往里写中文注释"不会变成坑。 */
    fs.writeFileSync(ps, '\uFEFF' + PS_SRC.join('\r\n'), 'utf8');
    /* 写成 .ps1 再 -File 执行，比把多行脚本塞进 -Command 安全得多
       （Windows 的命令行引号规则会咬人）。-ExecutionPolicy Bypass 绕开
       用户机器的策略设置，windowsHide 避免闪一个黑框。 */
    const p = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps, String(process.pid)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    FS.proc = p;
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', c => {
      FS.buf += c;
      const lines = FS.buf.split(/\r?\n/);
      FS.buf = lines.pop();
      for (const ln of lines){
        const t = ln.trim();
        if (t !== '0' && t !== '1') continue;
        const wasOk = FS.ok, wasOn = FS.active;
        FS.ok = true; FS.active = (t === '1');
        /* 状态一变就推给界面。设置页要靠它把"正在确认…"换成真实结果 ——
           第一个读数通常要 1 秒左右才出来，界面早就建好了，
           光靠启动时问一次会把"探测其实在跑"误报成"不可用"。 */
        if (wasOk !== FS.ok || wasOn !== FS.active) sendFs();
      }
    });
    p.stderr.on('data', d => { FS.err = String(d).slice(0, 300); });
    p.on('error', e => { FS.ok = false; FS.active = false; FS.proc = null; FS.err = String(e.message || e); });
    p.on('exit', () => { FS.ok = false; FS.active = false; FS.proc = null; });
  } catch (e){ FS.ok = false; FS.active = false; FS.err = String(e.message || e); }
}
function stopFsWatcher(){
  if (FS.proc){ try { FS.proc.kill(); } catch (e){} FS.proc = null; }
  FS.ok = false; FS.active = false;
}

/* ============================================================
   鼠标轮询：热区 + 面板内判定
   ============================================================ */
/* 给定鼠标点与显示器，判定它落在哪儿。
   抽成纯函数是为了能被自检直接调用 —— 热区是这整个应用最核心的一条规则，
   但它依赖真实鼠标位置，而自检不能去移动用户的鼠标（那会真的动起来）。 */
function judge(pt, disp){
  const g = panelGeom(disp);
  const wa = g.wa;
  const right = wa.x + wa.width;
  return {
    g: g, wa: wa, right: right,
    /* 面板内：四周各放宽 28px。少了这个容差，鼠标贴着面板边缘抖一下
       就会被判成"已离开"，面板刚打开就自己收回去。 */
    inPanel: pt.x >= g.panelLeft - 28 && pt.x <= right &&
             pt.y >= wa.y + PANEL_PAD - 28 && pt.y <= wa.y + wa.height - PANEL_PAD + 28,
    /* 热区：屏幕右缘最外侧 HOT_W 像素，整条边都算，不限高度 */
    inHot: pt.x >= right - HOT_W
  };
}

function tick(){
  if (!win) return;
  const pt = screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint(pt);
  followCursorDisplay(disp);

  const j = judge(pt, disp);
  const inPanel = S.open && j.inPanel;

  /* 面板整体不透明区域：指针在这里时窗口才有存在感 */
  if (inPanel){
    S.hovering = true; S.leaveStart = 0;
  } else if (S.hovering){
    S.hovering = false; S.leaveStart = Date.now();
  }

  if (S.open){
    /* 自动唤出：鼠标离开面板一会儿就收起。
       快捷键唤出的不这样收 —— 用户可能是用键盘切过来的，
       鼠标正好在别处，按离开就收会显得很莫名其妙。 */
    if (!S.pinned && S.source === 'auto' && S.leaveStart && !inPanel
        && Date.now() - S.leaveStart > LEAVE_MS){
      closePanel('leave');
    }
    return;   // 已展开就不必再热区检测
  }

  if (S.hiding) return;
  if (!HOT_ENABLED){ S.dwellStart = 0; return; }

  /* 全屏屏蔽：前台是盖住整块屏的窗口（视频、游戏、投屏）时不做边缘唤出。
     只在"确认探测可用且确实全屏"时拦截 —— 探测不可用就放行，
     宁可不拦，也不要让面板再也唤不出来。 */
  if (FS_BLOCK && FS.ok && FS.active){ S.dwellStart = 0; return; }

  if (j.inHot){
    if (!S.dwellStart) S.dwellStart = Date.now();
    else if (Date.now() - S.dwellStart >= DWELL){
      S.dwellStart = 0;
      openPanel('auto');
    }
  } else S.dwellStart = 0;
}

/* ============================================================
   托盘
   ------------------------------------------------------------
   这个应用没有任务栏图标（skipTaskbar），窗口默认又是藏起来的 ——
   没有托盘就等于"看不见也退不掉"。托盘是它唯一的常驻形态。
   ============================================================ */
let tray = null;

function rebuildTray(){
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '唤出面板', click: () => openPanel('key') },
    { label: '贴住面板（常驻最上层）', type: 'checkbox', checked: S.pinned,
      click: m => pinFromTray(m.checked) },
    { type: 'separator' },
    { label: '打开存档目录', click: () => shell.openPath(app.getPath('userData')) },
    { label: '重新显示引导', click: () => openPanel('key') },
    { type: 'separator' },
    { label: '退出聚珍', click: () => { app.quitting = true; app.quit(); } }
  ]));
  tray.setToolTip('聚珍 · 桌面入口（Alt+Space 唤出）');
}
function createTray(){
  let img = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
  if (img.isEmpty()) img = nativeImage.createEmpty();
  tray = new Tray(img);
  rebuildTray();
  /* 左键点图标 = 开合面板，跟快捷键一个语义 */
  tray.on('click', () => { S.open ? closePanel('tray') : openPanel('key'); });
}
/* 托盘里改的贴住状态要推回界面，否则两边会各说各话 */
function pinFromTray(v){
  S.pinned = !!v;
  if (win && !win.isDestroyed()) win.webContents.send('jz:pin', S.pinned);
  rebuildTray();
}

/* ============================================================
   IPC
   ============================================================ */
/* 选一次路径。选目录和选文件只差 properties 一项，收成一处 ——
   两边的取消语义、返回值形状才不会走散。 */
async function pickDialog(mode){
  const dir = mode !== 'file';
  const r = await dialog.showOpenDialog(win, {
    title: dir ? '选择文件夹' : '选择文件',
    properties: [dir ? 'openDirectory' : 'openFile']
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  const p = r.filePaths[0];
  return { ok: true, path: p, name: path.basename(p), isDir: dir };
}

function bind(){
  /* 知识库的存储目录与"嵌入能力"都从外面注入 —— kb.js 因此不依赖 electron，
     能用普通 node 直接测（_kbtest.js 会自己造真 PDF / 真 docx 喂给它）。
     嵌入配置**按调用传进来**：它是用户在设置页填的、随时会改，
     在启动时固化一份就会变成"改了没生效"。 */
  let kbEmbedCfg = null;
  KB.initKb({
    dir: path.join(app.getPath('userData'), 'kb'),
    embed: async function (texts){
      if (!kbEmbedCfg) return { ok: false, error: '没有拿到嵌入模型配置（设置页「知识库」那张卡）' };
      return AI.embedOnce(Object.assign({}, kbEmbedCfg, { input: texts }));
    }
  });
  /* 每次调用前把这一轮的嵌入配置摆好。放在一个地方是为了避免
     "某个 handler 忘了设 cfg，于是用了上一个人的配置"。 */
  function kbCfgOf(req){
    kbEmbedCfg = (req && req.embed) || null;
    return kbEmbedCfg;
  }

  ipcMain.handle('store:read',   () => readStore());
  ipcMain.handle('store:write',  (_e, data) => writeStore(data));
  ipcMain.handle('store:path',   () => storePath());
  ipcMain.handle('store:clear',  () => {
    try { fs.unlinkSync(storePath()); return { ok: true }; }
    catch (e){ return { ok: !fs.existsSync(storePath()), error: String(e.message || e) }; }
  });

  ipcMain.handle('store:export', async (_e, data) => {
    const r = await dialog.showSaveDialog(win, {
      title: '导出聚珍存档',
      defaultPath: path.join(app.getPath('desktop'), '聚珍存档-' + stamp() + '.json'),
      filters: [{ name: 'JSON 存档', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    try { fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2), 'utf8'); return { ok: true, file: r.filePath }; }
    catch (e){ return { ok: false, error: String(e.message || e) }; }
  });

  ipcMain.handle('store:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '导入聚珍存档', properties: ['openFile'],
      filters: [{ name: 'JSON 存档', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    try {
      const raw = fs.readFileSync(r.filePaths[0], 'utf8');
      return { ok: true, data: JSON.parse(raw), file: r.filePaths[0] };
    } catch (e){ return { ok: false, error: '这个文件不是合法的聚珍存档' }; }
  });

  /* ---- 真实系统能力 ---- */
  ipcMain.handle('sys:openPath', async (_e, p) => {
    if (!p) return { ok: false, error: '路径为空' };
    const err = await shell.openPath(String(p));
    if (err) return { ok: false, error: err };
    return { ok: true };
  });
  ipcMain.handle('sys:openExternal', async (_e, url) => {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u) && !/^mailto:/i.test(u)) {
      /* 用户手打的 example.com 也要能用 */
      if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(u)) return shell.openExternal('https://' + u).then(() => ({ ok: true }), e => ({ ok: false, error: String(e.message || e) }));
      return { ok: false, error: '这不是一个网址' };
    }
    try { await shell.openExternal(u); return { ok: true }; }
    catch (e){ return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('sys:reveal', (_e, p) => {
    const s = String(p || '').trim();
    if (!s) return { ok: false, error: '路径为空' };
    /* 必须先自己查一遍存在性。shell.showItemInFolder 对不存在的路径
       **不报错也不返回错误字符串**（它是 void），Explorer 只会打开一个
       不相干的窗口 —— 于是界面会理直气壮地说"已定位"，而用户面前是
       一片迷惑。这类"假成功"比直接报错更伤信任，所以宁可先敲门。 */
    if (!fs.existsSync(s)) return { ok: false, error: '这个路径在本机不存在' };
    try { shell.showItemInFolder(s); return { ok: true }; }
    catch (e){ return { ok: false, error: String(e.message || e) }; }
  });
  /* 选目录和选文件是同一个对话框换一个 properties，收成一处。
     场景动作要能"换成我机器上真实存在的路径"，靠的就是这两条。 */
  ipcMain.handle('sys:pickFolder', () => pickDialog('folder'));
  ipcMain.handle('sys:pickFile',   () => pickDialog('file'));
  /* 场景里的目标路径大多是用户自己填的，而内置的演示场景写的是示意的目录，
     在真机上必然不存在。与其等用户点下去、再一个个报错，不如渲染时就问一遍：
     查不到的当场标出来，用户一眼就能看见"这个场景在本机跑不通，该改哪一条"。
     一次最多查 200 条，避免有人把上万条塞进来把主进程拖住。 */
  ipcMain.handle('sys:probe', (_e, list) => {
    const arr = Array.isArray(list) ? list.slice(0, 200) : [];
    return arr.map(p => {
      const s = String(p || '');
      if (!s) return { path: s, exists: false, isDir: false };
      try { const st = fs.statSync(s); return { path: s, exists: true, isDir: st.isDirectory() }; }
      catch (e){ return { path: s, exists: false, isDir: false }; }
    });
  });

  /* 场景里的命令动作 —— 整个应用唯一"用户自己配的东西会被真正执行"的地方，
     所以约束都写在明处：cwd 由渲染侧给（取场景里第一个存在的目录动作，这样
     run_hil.bat 这类相对命令才找得到），没给就落到存档目录；20 秒超时；
     输出截断后回给界面 —— 一条默默执行完什么也不说的命令，等于没执行。 */
  ipcMain.handle('sys:runCmd', (_e, cmd, cwd) => {
    const line = String(cmd || '').trim();
    if (!line) return Promise.resolve({ ok: false, error: '命令为空' });
    let dir = String(cwd || '');
    try { if (!dir || !fs.statSync(dir).isDirectory()) dir = app.getPath('userData'); }
    catch (e){ dir = app.getPath('userData'); }
    return new Promise(resolve => {
      /* 走 cmd.exe 而不是直接把命令当可执行文件：.bat、内置命令、参数里的引号
         都要靠 shell 解释。execFile 不拼接 shell 字符串，比 exec 少一层转义歧义。

         输出编码这一段踩过坑，写清楚免得又被"顺手优化"掉：
         一开始的前缀是 `chcp 65001>nul & `，理由是"中文 cmd 默认 GBK"。实测
         这个理由站不住 —— 三种调法（/d /s /c、/d /c、加不加 chcp）回来的字节
         一模一样，`echo 聚珍自检命令输出` 都是 be db d5 e4 …

             cmd.exe, ['/d','/s','/c','chcp 65001>nul & echo XXX']  → GBK 字节
             cmd.exe, ['/d','/s','/u','/c','echo XXX']               → UTF-16LE 字节

         也就是说 chcp 改的是"控制台代码页"，而这里 stdout 是**管道**，
         cmd 内置命令的 echo 根本不看它。既然切代码页对内置命令无效、对某些
         外部程序却有效，留着它反而制造"一半 GBK 一半 UTF-8"的混合流，害得
         只能挑一种解码。所以去掉 chcp，改成**拿原始字节自己判断**：
         大多数情况下整条流是一致的（要么 GBK，要么 UTF-8），少数混合流会在
         注释里如实说明限制。 */
      execFile('cmd.exe', ['/d', '/s', '/c', line],
        { cwd: dir, timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'buffer' },
        (err, stdout, stderr) => {
          const out = decodeOut(stdout).replace(/\s+$/, '').slice(-1200);
          const er  = decodeOut(stderr).replace(/\s+$/, '').slice(-1200);
          if (err) return resolve({ ok: false, error: String(err.message || err), killed: !!err.killed, code: err.code, out, err: er, cwd: dir });
          resolve({ ok: true, out, err: er, cwd: dir });
        });
    });
  });

  ipcMain.handle('sys:meta', () => ({
    platform: process.platform,
    electron: process.versions.electron,
    version: app.getVersion(),
    store: storePath(),
    /* 全屏探测到底有没有跑起来。设置页要如实告诉用户，
       不能让一个"看着开着、其实没生效"的开关留在界面上。 */
    fullscreen: { ok: FS.ok, active: FS.active, err: FS.err || '' }
  }));

  ipcMain.handle('clip:read', () => {
    const t = clipboard.readText();
    return { text: t || '', empty: !String(t || '').trim() };
  });
  ipcMain.handle('clip:write', (_e, text) => {
    try { clipboard.writeText(String(text == null ? '' : text)); return { ok: true }; }
    catch (e){ return { ok: false, error: String(e.message || e) }; }
  });

  /* ---- AI 速问：把请求发出去 ----
     为什么放在主进程而不是渲染进程直接 fetch：
       1. 渲染进程发请求要过 CORS。各家 API 对浏览器来源的放行策略不一致，
          在渲染侧直连会变成"有的人能用、有的人被拦"，很难解释。
          主进程是 Node 环境，没有同源策略这回事。
       2. 请求和 Key 都留在主进程这一侧发出去，页面自身的网络记录里
          不会出现带 Authorization 头的那一条。

     请求拼装与结果解析都在 ai.js 里 —— 那个文件不依赖 electron，所以能用
     _aitest.js 起一个本地 mock 服务把所有分支真跑一遍（401 / 404 /
     空 choices / 连不上 / 超时）。写在这里的话，这几条路就只能靠
     "开窗口点一下、用肉眼看" 来验证，等于没验证。 */
  /* 速问「停止」（R25）：主进程持有 controller——真正的 fetch 在这边，
     渲染侧的 AbortSignal 过不了 IPC，只能传 stopToken 由主进程查表。
     chatOnce 结束（无论成败/中止）都清表，不留悬挂引用。 */
  const ASK_STOP = new Map();
  ipcMain.handle('ai:chat', async (_e, req) => {
    const token = req && req.stopToken;
    if (!token) return AI.chatOnce(req);
    const ctl = new AbortController();
    ASK_STOP.set(token, ctl);
    try {
      return await AI.chatOnce(req, ctl.signal);
    } finally {
      ASK_STOP.delete(token);
    }
  });
  ipcMain.handle('ai:stop', (_e, req) => {
    const ctl = ASK_STOP.get(req && req.token);
    if (ctl) ctl.abort();
    return { ok: !!ctl };
  });

  /* ---- 知识库：接入、检索、维护 ----
     全部走 invoke，因为它们**都有结果**：加了多少块、跳过了几个、
     为什么跳过 —— 这些数字必须能回到界面上。做成 send 的话，
     界面就只能显示"已添加"，而"已添加"是个最容易说假话的词。 */
  ipcMain.handle('kb:state', async (_e, req) => {
    kbCfgOf(req);
    return { ok: true, sources: await KB.listSources(), stats: await KB.stats() };
  });
  /* 选文件夹 / 选文件都交给系统对话框。渲染进程拿不到真实路径，
     也不该拿 —— 让用户自己指，我们不去猜他要索引哪儿。 */
  ipcMain.handle('kb:addFolder', async (_e, req) => {
    const cfg = kbCfgOf(req);
    let dir = req && req.dir;
    if (!dir){
      const r = await dialog.showOpenDialog(win, { title: '选择要索引的文件夹', properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
      dir = r.filePaths[0];
    }
    const res = await KB.addFolder(dir, Date.now());
    return Object.assign({ dir: dir, embedReady: !!cfg }, res);
  });
  ipcMain.handle('kb:addFiles', async (_e, req) => {
    const cfg = kbCfgOf(req);
    let paths = req && req.paths;
    if (!Array.isArray(paths) || !paths.length){
      const r = await dialog.showOpenDialog(win, {
        title: '选择要索引的文件', properties: ['openFile', 'multiSelections'],
        filters: [{ name: '可索引的文件',
          extensions: ['md','markdown','txt','rst','csv','json','yaml','yml','log',
            'js','ts','py','java','c','cpp','h','cs','go','rs','sh','ps1',
            'a2l','dbc','arxml','html','xml','pdf','docx'] },
          { name: '全部文件', extensions: ['*'] }]
      });
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
      paths = r.filePaths;
    }
    const res = await KB.addFiles(paths, Date.now());
    return Object.assign({ paths: paths, embedReady: !!cfg }, res);
  });
  ipcMain.handle('kb:addUrl', async (_e, req) => {
    const cfg = kbCfgOf(req);
    const url = String((req && req.url) || '').trim();
    if (!url) return { ok: false, error: '没有填网址' };
    /* 抓取放在主进程：渲染进程直连会撞 CORS，而且各家站点对浏览器来源的
       放行策略不一致 —— 那会变成"有的人能存、有的人不能"这种没法解释的现象。 */
    const page = await KB.fetchUrlText(url);
    if (!page.ok) return { ok: false, error: page.error };
    const res = await KB.addUrl(page.url || url, page.title, page.text, Date.now());
    return Object.assign({ title: page.title, chars: page.text.length, embedReady: !!cfg }, res);
  });
  ipcMain.handle('kb:addText', async (_e, req) => {
    const cfg = kbCfgOf(req);
    const res = await KB.addText((req && req.title) || '一段文本', (req && req.text) || '',
      (req && req.key) || '', Date.now());
    return Object.assign({ embedReady: !!cfg }, res);
  });
  ipcMain.handle('kb:remove', (_e, req) => KB.removeSource((req && req.id) || ''));
  ipcMain.handle('kb:clear',  () => KB.clearAll());
  ipcMain.handle('kb:reindex', async (_e, req) => { kbCfgOf(req); return KB.reindex(); });
  ipcMain.handle('kb:search',  async (_e, req) => {
    kbCfgOf(req);
    return KB.search((req && req.query) || '', (req && req.k) || 8);
  });

  /* ---- 单独试一下嵌入模型 / 列一下可用模型 ----
     设置页那两颗按钮走这里。存在的意义：知识库能不能用，取决于
     "这个地址 + 这个模型名到底能不能产出向量"，而这件事只有真发一次请求才知道。
     不试的话，用户会在点了「加文件夹」之后拿到一堆失败，还得自己猜是哪一格填错了。 */
  ipcMain.handle('llm:embed', async (_e, req) => {
    const r = await AI.embedOnce(Object.assign({}, (req && req.cfg) || {}, { input: (req && req.input) || '连接测试' }));
    return r.ok ? { ok: true, dim: r.dim, model: r.model, count: r.vectors.length } : r;
  });
  ipcMain.handle('llm:models', async (_e, req) => AI.modelsOnce((req && req.cfg) || {}));

  /* ---------- 窗口分区 ----------
     把其它应用的窗口摆进"面板之外"的剩余区域。这一块在本轮之前，一直是
     设置页里那行灰色的「未接入」。

     三条约束（它要真的移动别的进程的窗口，一条都不能松）：
       1) 只有用户点了按钮才跑；跑之前把每个窗口的原位置记下来，可一键还原；
       2) 跳过任何"看起来不该动"的窗口，且**每条跳过都带原因**回到界面 ——
          静默跳过一个，用户会以为"分区没生效"，那比不动还糟；
       3) 出错就把原话带回去，不吞。

     面板在哪块屏：用**光标所在屏**，跟 panelGeom / followCursorDisplay
     保持一致。写死 getPrimaryDisplay() 的话，多屏用户会把别的屏上的窗口
     摆到自己屏上、还是摆在面板身后。 */
  const zonesArea = () => {
    const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    /* 面板的窗口固定贴屏幕右侧（见 panelGeom / createWindow），
       所以让出来的地方永远在左边。 */
    return ZONES.freeArea(disp.workArea, 'right', PANEL_W, PANEL_PAD);
  };
  const zoneLayoutOf = v => ['split2', 'split3', 'quad'].indexOf(v) >= 0 ? v : 'split2';

  ipcMain.handle('zones:state', (_e, req) => {
    const a = zonesArea();
    const layout = zoneLayoutOf(req && req.layout);
    const rec = ZONES.lastRecord({ userData: app.getPath('userData') });
    return {
      ok: true, area: a, layout, rects: ZONES.planZones(a, layout),
      canRestore: rec.has, lastAt: rec.at || null,
      lastCount: rec.count || 0, lastLayout: rec.layout || null
    };
  });
  ipcMain.handle('zones:apply', async (_e, req) => {
    return ZONES.applyZone({
      area: zonesArea(), layout: zoneLayoutOf(req && req.layout),
      selfPid: process.pid, userData: app.getPath('userData'), timeoutMs: 20000
    });
  });
  ipcMain.handle('zones:restore', async () => ZONES.restoreZone({
    userData: app.getPath('userData'), timeoutMs: 20000
  }));

  /* 拖进来的文件要存"实体副本"时走这条路：复制到 userData/files 下，
     返回副本的真实路径。暂存区因此可以同时表达两种意图 ——
     「引用式」记原文件在哪，「实体」则是别人删了原件也不影响的那份。
     同名文件加时间戳后缀，绝不覆盖。 */
  ipcMain.handle('store:copyIn', (_e, p) => {
    try {
      const src = String(p || '');
      if (!src) return { ok: false, error: '没有源路径' };
      if (!fs.existsSync(src)) return { ok: false, error: '源文件已经不在了' };
      const dir = path.join(app.getPath('userData'), 'files');
      fs.mkdirSync(dir, { recursive: true });
      let dst = path.join(dir, path.basename(src));
      if (fs.existsSync(dst)){
        const ext = path.extname(src), base = path.basename(src, ext);
        dst = path.join(dir, base + '-' + stamp() + ext);
      }
      fs.copyFileSync(src, dst);     /* 目录会在这里抛错，落到下面 catch */
      return { ok: true, path: dst, size: fs.statSync(dst).size };
    } catch (e){ return { ok: false, error: String(e.message || e) }; }
  });

  /* ---- 贴图钉窗 ---- */
  function shotPinCreate(rec){
    const old = PINS.get(rec.id);
    /* 已经钉着再点"钉住"：把现有的窗带到前面来，而不是再开一个一样的 */
    if (old && !old.win.isDestroyed()){
      if (old.win.isMinimized()) old.win.restore();
      old.win.show();
      old.win.focus();
      return { ok: true, existed: true };
    }
    const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const wa = disp.workArea;
    /* 上次的摆位还在就原样用（shots-pin.json）；没有就放在鼠标所在屏的
       偏右下区域 —— 面板固定贴屏幕右缘，钉窗再压上去就谁也看不见谁。 */
    const all = shotGeomRead();
    const geom = all[rec.id] || {};
    const w = Math.min(geom.w || rec.w, wa.width - 40);
    const h = Math.min(geom.h || rec.h, wa.height - 40);
    const x = (typeof geom.x === 'number') ? geom.x
      : Math.max(wa.x, wa.x + Math.round(wa.width * 0.55) - Math.round(w / 2));
    const y = (typeof geom.y === 'number') ? geom.y : wa.y + Math.round((wa.height - h) / 2);

    const pw = new BrowserWindow({
      x: x, y: y, width: w, height: h,
      show: false,
      frame: false,
      title: '贴图 · ' + rec.t,
      icon: path.join(__dirname, 'icon.png'),
      backgroundColor: '#161311',
      minWidth: 120, minHeight: 90,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false
      }
    });
    /* 'floating' 档：比普通窗口高，但不跟全屏视频抢 —— 参考图让位是本分 */
    pw.setAlwaysOnTop(true, 'floating');
    pw.loadFile(path.join(__dirname, 'app', 'pin.html'));
    PINS.set(rec.id, { win: pw, rec: rec });

    /* 记录在载入完成后推一次（pin.html 用 JZ.shot.onData 接）。
       不让 pin 页自己来问：一连开好几个钉窗时，谁先载入完谁先问，
       主进程还得靠 sender 反查；推是天然一对一的。 */
    pw.webContents.on('did-finish-load', () => {
      if (!pw.isDestroyed()) pw.webContents.send('jz:shotdata', rec);
    });

    /* 拖动/缩放落库要节流：move 事件一来就是一串，每次都写盘没意义。
       写的是 shots-pin.json（窗口的事），不是面板存档（记录的事）。 */
    let geomT = 0;
    const saveGeom = () => {
      clearTimeout(geomT);
      geomT = setTimeout(() => {
        if (pw.isDestroyed()) return;
        const b = pw.getBounds(), g = shotGeomRead();
        g[rec.id] = { x: b.x, y: b.y, w: b.width, h: b.height };
        shotGeomWriteAll(g);
      }, 420);
    };
    pw.on('move', saveGeom);
    pw.on('resize', saveGeom);

    pw.on('closed', () => {
      PINS.delete(rec.id);
      /* 用户在钉窗上点了 ✕（或 Alt+F4）—— 面板那边的"已钉"状态必须跟着掉，
         不然卡片还标着"已钉"，点"收起"却什么都没发生。 */
      if (win && !win.isDestroyed()) win.webContents.send('jz:shotclosed', { id: rec.id });
    });

    pw.showInactive();   /* 钉参考图不该抢走正在打字的那个窗口的焦点 */
    return { ok: true };
  }
  function shotUnpinId(id){
    const e = PINS.get(String(id || ''));
    if (!e) return { ok: true, gone: true };   /* 本来就没钉：收起一个不存在的窗不算错 */
    /* destroy() 不触发 closed 事件（那样会再推一次 jz:shotclosed），
       所以这里自己清干净 map。 */
    if (!e.win.isDestroyed()) e.win.destroy();
    PINS.delete(String(id));
    return { ok: true };
  }

  ipcMain.handle('shot:pin', (_e, req) => {
    const s = shotSanitize(req);
    if (s.error) return { ok: false, error: s.error };
    return shotPinCreate(s.rec);
  });
  ipcMain.handle('shot:unpin', (_e, req) => shotUnpinId(req && req.id));
  ipcMain.handle('shot:update', (_e, req) => {
    const id = String((req && req.id) || ''), patch = (req && req.patch) || {};
    const e = PINS.get(id);
    if (!e) return { ok: false, error: '这张图当前没有钉在桌面上' };
    if (typeof patch.op === 'number' && isFinite(patch.op)){
      const op = Math.min(100, Math.max(30, Math.round(patch.op)));
      e.rec.op = op;
      /* 回声只发给"另一头"：面板改的推给钉窗，钉窗改的推回面板落档。
         原样发回发起方除了打乒乓没有任何用处。 */
      const from = _e.sender;
      if (win && !win.isDestroyed() && from !== win.webContents)
        win.webContents.send('jz:shotop', { id: id, op: op });
      if (!e.win.isDestroyed() && from !== e.win.webContents)
        e.win.webContents.send('jz:shotop', { id: id, op: op });
    }
    /* 主题主色（R20）：换主题时面板会把新主色推给每一扇钉窗。
       校验同 sanitize —— 非法形态直接忽略，钉窗保留上一次的颜色。 */
    if (typeof patch.acc === 'string' && /^#[0-9a-fA-F]{6}$/.test(patch.acc)){
      e.rec.acc = patch.acc;
      if (!e.win.isDestroyed()) e.win.webContents.send('jz:shotacc', { id: id, acc: patch.acc });
    }
    return { ok: true };
  });
  /* 面板启动时问一次"现在桌面上钉着哪几张"，把卡片的"已钉"标对 */
  ipcMain.handle('shot:state', () => ({ ok: true, pins: [...PINS.keys()] }));
  /* 剪切板里的图落盘成 PNG 副本。Win+Shift+S 截完图就在剪切板里，
     这一枪是把"截图 → 钉住"接通的最短路径 —— 不用自己做区域选择。 */
  ipcMain.handle('shot:saveClip', () => {
    try {
      const img = clipboard.readImage();
      if (img.isEmpty()) return { ok: false, error: '剪切板里没有图片（先用 Win+Shift+S 截一张）' };
      const dir = path.join(app.getPath('userData'), 'files');
      fs.mkdirSync(dir, { recursive: true });
      const dst = path.join(dir, 'clip-' + stamp() + '.png');
      fs.writeFileSync(dst, img.toPNG());
      const sz = img.getSize();
      return { ok: true, path: dst, w: sz.width, h: sz.height };
    } catch (e){ return { ok: false, error: String(e.message || e) }; }
  });

  /* ---- 面板控制 ---- */
  /* 收起动画放完后渲染进程回来报到。这里无条件隐藏 —— 因为"由谁发起收起"
     有两条路：主进程（热区离开 / 失焦）和渲染进程（Esc / 收起按钮）。
     后者不会经过主进程的 closePanel，若还按 S.hiding 判断就永远藏不掉。 */
  ipcMain.on('panel:closed', () => { S.open = false; clearTimeout(S.hideTimer); reallyHide(); });
  /* 渲染进程就绪后主动问一次当前状态。窗口在 renderer 起来之前就可能已经
     show 过（热区唤出），那时候发的消息会丢，这里补一次。 */
  ipcMain.on('panel:ready', (e) => {
    e.reply('jz:panel', { open: S.open, source: S.source, pinned: S.pinned });
    /* 顺手补一次全屏探测状态。渲染侧是注册完回调才发 ready 的，
       这条不会像"启动即推"那样丢在页面还没起来的时候。 */
    e.reply('jz:fs', fsState());
  });
  /* 渲染侧改的贴住状态。值没变就直接返回，否则会和 pinFromTray 的"推回去"
     来回打乒乓（托盘改 → 推给界面 → 界面又发回来 → …）。 */
  ipcMain.on('panel:pin', (_e, v) => {
    const n = !!v;
    if (n === S.pinned) return;
    S.pinned = n;
    rebuildTray();
  });
  /* 设置页那根"热区时延"滑杆同步过来。夹在 100–1200 之间：
     太短会把"鼠标滑过屏幕右边"误判成唤出，太长用户会以为没反应。 */
  ipcMain.on('panel:delay', (_e, ms) => {
    const n = Math.round(Number(ms));
    if (isFinite(n) && n >= 100 && n <= 1200) DWELL = n;
  });
  /* "全屏应用时屏蔽热区"的开关。这个开关只活在主进程的热区判定里，
     渲染侧不需要知道它 —— 它只负责把用户的选择送过来。 */
  ipcMain.on('panel:fsblock', (_e, v) => { FS_BLOCK = !!v; });
  ipcMain.on('panel:hide',  () => { if (!S.pinned) closePanel('render'); });
  ipcMain.on('panel:quit',  () => app.quit());

  /* ----------------------------------------------------------------
     真终端（ConPTY）
     ----------------------------------------------------------------
     三条通道的用法是有讲究的：
       · pty:avail / pty:ensure 走 invoke —— 它们**有结果**，而"终端起没起来"
         必须让界面知道，不能发完就算（一个点了没反应的终端按钮是最糟的形态）。
       · 输入 / 改尺寸 / 杀会话走单向 send —— 它们每敲一个键就发一次，
         走 invoke 会积一堆没人看的 Promise。
       · 输出用 jz:pty 推回渲染侧，按 id 分流。

     为什么 sink 挂在这里而不是 createWindow 里：会话可能比窗口活得久
     （用户关掉面板、终端进程还在跑），窗口重建后 sink 不该变成悬空引用。 */
  TERM.setSink((id, data) => {
    if (win && !win.isDestroyed()) win.webContents.send('jz:pty', { id, data });
  });
  TERM.setExitSink((id, code) => {
    if (win && !win.isDestroyed()) win.webContents.send('jz:ptyexit', { id, code });
  });

  ipcMain.handle('pty:avail', () => {
    const a = TERM.available();
    return { ok: a.ok, why: a.why, shells: TERM.whichShells(), profiles: TERM.PROFILES.map(p => ({ id:p.id, name:p.name })) };
  });
  ipcMain.handle('pty:ensure', (_e, id, opts) => TERM.ensure(id, opts));
  ipcMain.on('pty:input',  (_e, id, data) => { TERM.input(id, data); });
  ipcMain.on('pty:resize', (_e, id, c, r)  => { TERM.resize(id, c, r); });
  ipcMain.on('pty:kill',   (_e, id)        => { TERM.kill(id); });
  ipcMain.on('pty:killall',()              => { TERM.killAll(); });

  /* 终端要能收到键盘输入，窗口就必须真的有焦点。
     热区唤出走的是 showInactive()（刻意不抢焦点，那是给"随手看一眼"用的），
     在这种状态下敲字一个字符都进不去 —— 所以进入终端板块时由渲染侧显式
     要一次焦点。这不是"顺手加的"，是终端可用性的必要条件。 */
  ipcMain.on('panel:focus', () => { if (win && !win.isDestroyed()) win.focus(); });
}

function stamp(){
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}

/* ============================================================
   生命周期
   ============================================================ */
const single = app.requestSingleInstanceLock();
if (!single){
  /* 已经有一个实例在跑（包括上次自检没退干净的那个）。
     这里必须留下痕迹 —— 静默退出会让 JZ_DIAG 看起来像"自检根本没执行"，
     而实际上只是没抢到锁。之前就是在这一点上白绕了一圈。 */
  if (process.env.JZ_DIAG){
    try {
      fs.writeFileSync(path.join(app.getPath('userData'), '_deskcheck.txt'),
        '自检未能运行：已有另一个实例持有单实例锁。\n'
        + '先退出正在运行的聚珍（托盘图标右键 → 退出），然后重跑。\n', 'utf8');
    } catch (e){}
  }
  app.quit();
} else {
  app.on('second-instance', () => openPanel('key'));

  app.whenReady().then(() => {
    createWindow();
    bind();
    createTray();
    startFsWatcher();

    globalShortcut.register('Alt+Space', () => {
      if (S.open) closePanel('key'); else openPanel('key');
    });
    /* 备用唤起键：有些输入法/系统会占用 Alt+Space */
    globalShortcut.register('Control+Alt+J', () => openPanel('key'));

    setInterval(tick, POLL_MS);

    /* 首次运行主动展开一次。
       否则用户双击 exe 之后看到的是"什么都没发生"—— 窗口是藏起来的，
       任务栏又没有图标。先让他看见这东西长什么样、在哪。
       之后启动就安安静静待在托盘里，只保留一个气泡提示。 */
    const welcomed = path.join(app.getPath('userData'), '.welcomed');
    setTimeout(() => {
      if (fs.existsSync(welcomed)){
        if (tray) tray.displayBalloon({ title: '聚珍已就绪', content: 'Alt+Space 唤出面板，或把鼠标贴到屏幕右边缘停留片刻。' });
        return;
      }
      openPanel('key');
      try { fs.mkdirSync(app.getPath('userData'), { recursive: true });
            fs.writeFileSync(welcomed, String(Date.now())); } catch (e){}
    }, 900);

    app.on('activate', () => { if (!win) createWindow(); });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll(); stopFsWatcher();
    /* 终端会话必须在退出前显式收掉。node-pty 起的是**子进程**，
       主进程退出不保证把子进程带走 —— 留下几个孤儿 powershell 在后台
       是用户完全看不见的泄漏，攒几十个之后机器就开始卡。 */
    try { TERM.killAll(); } catch (e){ /* 退出路径上不再抛 */ }
    /* 钉窗同样显式收掉。destroy() 不触发 closed，不会再往面板推消息。 */
    PINS.forEach(e => { try { if (!e.win.isDestroyed()) e.win.destroy(); } catch (err){} });
  });
  /* 有托盘常驻，窗口全关了（比如被系统回收）也不退出 —— 否则用户会
     莫名其妙丢失"贴到边缘就唤出"这个能力，却看不出发生了什么。 */
  app.on('window-all-closed', () => { if (app.quitting) app.quit(); });
}

/* ============================================================
   自检（JZ_DIAG=1）
   ------------------------------------------------------------
   这是个窗口应用，验证时看不见画面 —— "窗口到底建起来没有、
   桥通没通、存档落在哪"只能让程序自己说。正常运行不设这个环境
   变量，整段都不执行。
   ============================================================ */
function DIAG_RENDER(){
  const q = s => document.querySelector(s);
  const vis = el => el ? getComputedStyle(el).display : '(无此元素)';
  const o = [];
  o.push('  JZ 桥 = ' + (window.JZ ? 'ok' : '缺失！！'));
  o.push('  real-desktop = html:' + document.documentElement.classList.contains('real-desktop')
    + ' · body:' + document.body.classList.contains('real-desktop'));
  o.push('  DESK = ' + (typeof DESK !== 'undefined' ? DESK : '未定义！！'));
  o.push('  面板 open = ' + q('#panel').classList.contains('open')
    + ' · visibility = ' + getComputedStyle(q('#panel')).visibility);
  o.push('  侧栏 = ' + document.querySelectorAll('#rail .rbtn').length + ' 行'
    + ' · 其中带中文名 ' + document.querySelectorAll('#rail .rbtn .rt').length);
  o.push('  假桌面层 display = ' + vis(q('.desktop')) + ' · 假任务栏 = ' + vis(q('.dock'))
    + ' · 遮罩 = ' + vis(q('.scrim')) + ' · 分区 = ' + vis(q('.zones')));
  o.push('  视口 = ' + window.innerWidth + 'x' + window.innerHeight
    + ' · 面板实测 ' + Math.round(q('#panel').getBoundingClientRect().width) + 'px 宽');
  o.push('  当前板块 = ' + state.page + ' · 轨道位移 = '
    + (document.getElementById('track').style.transform || '(无)'));
  o.push('  面板内正文页 = ' + document.querySelectorAll('#track .page').length
    + ' 个 · 已渲染 = ' + document.querySelectorAll('#track .page-body[data-rendered]').length);
  o.push('  localStorage 键数 = ' + localStorage.length);
  return o.join('\n');
}

if (process.env.JZ_DIAG){
  /* 落盘位置在这里就算出来，并且**一开始就写一行**。
     这个差别在诊断上很要紧：如果连这行都没有，说明自检压根没走到这儿
     （最可能是单实例锁被别的进程占着），而不是跑到中途挂了 ——
     两种情况的表象都是"什么都没生成"，分不出来就只能瞎猜。 */
  const DIAG_FILE = path.join(app.getPath('userData'), '_deskcheck.txt');
  const diagWrite = txt => {
    try { fs.mkdirSync(app.getPath('userData'), { recursive: true });
          fs.writeFileSync(DIAG_FILE, txt, 'utf8'); } catch (e){}
  };
  diagWrite('自检已启动 · ' + new Date().toISOString() + '\n等待页面就绪…\n');

  app.whenReady().then(async () => {
    const o = [];
    /* 逐节落盘。原来是最后一次性写 —— 于是"跑到一半没了"的现场只剩第一行
       "等待页面就绪…"，看不出停在哪一节。这一轮真撞上过一次：改了终端页的
       挂载逻辑之后自检不再返回，磁盘上什么都没有，卡在哪儿只能靠猜。
       现在每次推入一个 `=== 某一节 ===` 就顺手刷一次盘：
       挂在哪，文件最后一行就是哪（末尾会写明"还在跑"）。
       只认节标题，不做节内刷盘 —— 那是每秒几十次的写盘，没必要。 */
    const push0 = o.push.bind(o);
    o.push = function (){
      const r = push0.apply(null, arguments);
      if (/^=== /.test(String(arguments[0] || ''))) diagWrite(o.join('\n') + '\n\n（已完成到此 · 自检还在跑）');
      return r;
    };
    await new Promise(r => setTimeout(r, 2800));   /* 等页面 boot 完（含一次 hydrate IPC） */
    try {
      const g = panelGeom(screen.getPrimaryDisplay());
      o.push('=== 主进程 ===');
      o.push('  显示器计数 = ' + screen.getAllDisplays().length + ' · 缩放 '
        + screen.getPrimaryDisplay().scaleFactor + 'x');
      screen.getAllDisplays().forEach(d => {
        o.push('    #' + d.id + ' 工作区 ' + JSON.stringify(d.workArea)
          + ' · 整屏 ' + JSON.stringify(d.bounds)
          + (d.id === screen.getPrimaryDisplay().id ? ' ←主' : ''));
      });
      o.push('  鼠标所在 = #' + screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id);
      o.push('  窗口 bounds = ' + JSON.stringify(win.getBounds()));
      o.push('  可见 = ' + win.isVisible() + ' · 置顶 = ' + win.isAlwaysOnTop()
        + ' · 可缩放 = ' + win.isResizable() + ' · 有边框 = ' + win.isMovable());
      o.push('  面板几何 = 左 ' + g.panelLeft + ' / 右留边 ' + PANEL_PAD
        + ' · 面板宽 ' + PANEL_W + ' · 窗口宽 ' + WIN_W);
      o.push('  面板矩形完整落在窗口内 = ' + (g.panelLeft >= g.x && WIN_W - PANEL_PAD >= PANEL_W));
      o.push('  存档文件 = ' + storePath() + ' · 已存在 = ' + fs.existsSync(storePath()));
      /* 全屏探测：自检时子进程已经跑了两秒多，正常应该已经有读数了。
         没有读数就说明这条链路在这个系统上不通，得让用户知道。 */
      o.push('  全屏探测 = ' + (FS.ok ? '运行中 · 当前全屏 ' + (FS.active ? '是' : '否')
        : '未取得读数（子进程可能被策略拦下）')
        + ' · 屏蔽开关 ' + (FS_BLOCK ? '开' : '关')
        + (FS.err ? ' · stderr: ' + FS.err.replace(/\s+/g, ' ').slice(0, 160) : ''));

      /* 热区判定：喂坐标给纯函数，看它落在哪一类。
         贴边唤出是整个应用最核心的规则，而它偏偏依赖真实鼠标位置 ——
         自检不能去移动用户的鼠标，所以只能这样测。 */
      o.push('=== 热区判定（喂坐标，非真移动鼠标）===');
      const D = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const w0 = D.workArea, rx = w0.x + w0.width, cy = w0.y + Math.round(w0.height / 2);
      [
        ['贴到最右缘 1px',     { x: rx - 1,  y: cy }],
        ['贴到最右缘 11px',    { x: rx - 11, y: cy }],
        ['右缘偏内 20px',      { x: rx - 20, y: cy }],
        ['面板正中',           { x: rx - PANEL_PAD - 290, y: cy }],
        ['面板左缘再外 20px',  { x: rx - PANEL_PAD - PANEL_W - 20, y: cy }],
        ['屏幕正中',           { x: w0.x + Math.round(w0.width / 2), y: cy }],
        ['贴边 + 最上',        { x: rx - 2,  y: w0.y + 1 }],
        ['贴边 + 最下',        { x: rx - 2,  y: w0.y + w0.height - 1 }]
      ].forEach(c => {
        const j = judge(c[1], D);
        o.push('  ' + c[0].padEnd(18) + '→ 热区 ' + (j.inHot ? 'Y' : '·')
          + ' · 面板内 ' + (j.inPanel ? 'Y' : '·'));
      });

      /* 窗口分区：**只验算法与桥，绝不真动窗口**。
         真跑一次整理会去 SetWindowPos 别人的窗口 —— 在用户没点任何按钮的
         情况下搬他的窗口，那件事只能由他自己点。所以这一段的边界是：
           ① planZones 在各种屏尺寸下的矩形（纯函数，喂假工作区）；
           ② 渲染侧 JZ.zones.state 走**真桥**（直接调 handler 只能证明主进程
              这段代码没坏，证明不了 preload 在 asar 里还把三个方法暴露着）；
           ③ 设置页那两个按钮真的建出来了、「还原窗口」在没记录时是禁用的。
         ③ 必须先切到设置页 —— 启动时停的是 folders，那一页根本没有这两个按钮。 */
      o.push('=== 窗口分区（只验算法与桥，不动窗口）===');
      try {
        [
          ['1920×1040', { x: 0, y: 0, width: 1920, height: 1040 }],
          ['1440×860',  { x: 0, y: 0, width: 1440, height: 860 }],
          ['1280×760',  { x: 0, y: 0, width: 1280, height: 760 }],
          ['1024×728',  { x: 0, y: 0, width: 1024, height: 728 }],
          ['副屏负坐标', { x: -1920, y: -200, width: 1920, height: 880 }]
        ].forEach(c => {
          const a = ZONES.freeArea(c[1], 'right', PANEL_W, PANEL_PAD);
          ['split2', 'split3', 'quad'].forEach(L => {
            const p = ZONES.planZones(a, L);
            const deg = p.length === 1 && p[0].degraded === true;
            o.push('  ' + c[0].padEnd(10) + ' ' + L.padEnd(7) + ' → ' + p.length + ' 块'
              + (deg ? ' · 退化' : '') + ' · ' + p.map(r => Math.round(r.w) + '×' + Math.round(r.h)
                + '@' + Math.round(r.x) + ',' + Math.round(r.y)).join(' | '));
          });
        });
        o.push('  真实工作区 freeArea = ' + JSON.stringify(ZONES.freeArea(D.workArea, 'right', PANEL_W, PANEL_PAD)));
        const rec = ZONES.lastRecord({ userData: app.getPath('userData') });
        o.push('  可还原记录 = ' + JSON.stringify(rec));
        const zs = await win.webContents.executeJavaScript(
          '(async () => { try { return JSON.stringify(await window.JZ.zones.state({ layout: "split3" })); }'
          + ' catch (e) { return "ERR " + (e && e.message); } })()');
        o.push('  渲染侧 JZ.zones.state("split3") = ' + String(zs).slice(0, 240));
        /* 这一行是参数形状的真判据。preload 曾经把渲染侧传进来的对象再包
           一层（{ layout: { layout:'split3' } }），主进程认不出来就静默
           退回 split2 —— 界面点"四分格"、窗口按"左右二分"摆，全程没有
           报错。只比"回执里有没有 layout"是看不出来的，必须比它的值。 */
        let zsBack = null;
        try { zsBack = (JSON.parse(String(zs)) || {}).layout; } catch (e){}
        o.push('  参数形状往返 = ' + (zsBack === 'split3'
          ? 'ok（请求 split3，回执 layout 也是 split3）'
          : '★ 不对！请求 split3，回执 layout = ' + JSON.stringify(zsBack) + ' —— 桥把参数包错了层'));
        /* 只有在**没有**可还原记录时才去点它：有记录时这一下会真的把用户的
           窗口搬回去，而自检不该动他的桌面。 */
        if (rec.has){
          o.push('  还原：跳过 —— 存档里有可还原记录，自检不替你点（那会真搬窗口）');
        } else {
          const zr = await win.webContents.executeJavaScript(
            '(async () => { try { return JSON.stringify(await window.JZ.zones.restore()); }'
            + ' catch (e) { return "ERR " + (e && e.message); } })()');
          o.push('  渲染侧 JZ.zones.restore()（无记录，应如实拒绝）= ' + String(zr).slice(0, 200));
        }
        await win.webContents.executeJavaScript('switchPage("settings")');
        await new Promise(r => setTimeout(r, 600));
        const zui = await win.webContents.executeJavaScript(
          '(function(){'
          + 'var a=document.getElementById("zoneApply"), r=document.getElementById("zoneRestore");'
          + 'return JSON.stringify({ 有整理按钮: !!a, 有还原按钮: !!r,'
          + ' 还原禁用: r ? r.disabled === true : null,'
          + ' 说明: (document.getElementById("zoneHint")||{}).textContent||"",'
          + ' 唤出边缘那一行: (function(){var s=document.querySelectorAll(".set-na");'
          + 'for(var i=0;i<s.length;i++){if(s[i].textContent.indexOf("固定右侧")>=0)return "已标为固定右侧";}'
          + 'return "没找到（可能还写着可换边）";})() });'
          + '})()');
        o.push('  设置页窗口分区控件 = ' + zui);
        await win.webContents.executeJavaScript('switchPage("folders")');
        await new Promise(r => setTimeout(r, 400));
      } catch (e){ o.push('  窗口分区自检出错: ' + (e && e.message)); }

      o.push('=== 渲染进程（收起态）===');
      o.push(await win.webContents.executeJavaScript('(' + DIAG_RENDER.toString() + ')()'));

      /* 真的唤出一次，确认面板能开、桥能双向通信 */
      win.showInactive();
      openPanel('key');
      await new Promise(r => setTimeout(r, 900));
      o.push('=== 渲染进程（唤出后）===');
      o.push(await win.webContents.executeJavaScript('(' + DIAG_RENDER.toString() + ')()'));

      /* 把窗口的真实渲染内容截下来。
         窗口是透明的，PNG 带 alpha —— 这正是要看的：面板之外必须全透明，
         不能糊上一层底色（那会把真实桌面挡住）。 */
      /* 截图期间把窗口按住不放。
         这个应用会**故意**在鼠标离开热区后自动收起（那是它的设计，不是 bug），
         而自检不移动用户的鼠标 —— 于是"光标恰好不在热区"时，截到一半窗口就被
         收走了：后面每张图都是同一张空白 PNG，**大小一模一样**（6469 B），
         看图看不出来，只有比大小才发现。这是自检自身的确定性要求。
         注意：这里改的是主进程侧那份 S.pinned 镜像，只影响"窗口会不会被收走"，
         不会去动渲染侧的设置（用户的钉住偏好）。 */
      const pinned0 = S.pinned;
      S.pinned = true;
      try {
        /* 先收起引导层：要验的是面板本身，不是首启引导卡 */
        await win.webContents.executeJavaScript(
          '(function(){var o=document.getElementById("onboard");if(o)o.classList.add("hide");return 1;})()');
        await new Promise(r => setTimeout(r, 620));

        const pic = await win.webContents.capturePage();
        const pf = path.join(app.getPath('userData'), '_deskpanel.png');
        fs.writeFileSync(pf, pic.toPNG());

        /* 读回来验像素。必须走 nativeImage 再取一次尺寸 —— 截图返回的是
           DIP 尺寸，而 bitmap 可能是物理像素（本机 1.5x 缩放），
           直接混用会把采样点算到图外去。 */
        const back = nativeImage.createFromPath(pf);
        const bs = back.getSize(), bb = back.toBitmap();
        const at = (x, y) => { const i = (y * bs.width + x) * 4;
          return 'rgba(' + bb[i + 2] + ',' + bb[i + 1] + ',' + bb[i] + ',' + bb[i + 3] + ')'; };
        const mpx = Math.max(0, bs.width - 300);
        o.push('=== 窗口截图 ===');
        o.push('  已存 ' + pf + ' · ' + bs.width + 'x' + bs.height
          + ' · ' + fs.statSync(pf).size + ' B');
        o.push('  左上角（窗口透明通道）= ' + at(5, 5) + '   ← alpha 必须是 0');
        o.push('  面板上方 5px（同上）  = ' + at(mpx, 5));
        o.push('  面板左缘外 30px（同上）= ' + at(Math.round(bs.width - 12 * (bs.width / 680) - 580 * (bs.width / 680) - 30), Math.round(bs.height / 2)));
        o.push('  面板正中（应有内容）  = ' + at(mpx, Math.round(bs.height / 2)));

        /* 逐页再截几张：真实窗口的尺寸（580 宽、非整屏）和浏览器里不一样，
           有些页在窄面板下才会暴露问题，光看首屏看不出来。 */
        const pages = ['folders', 'calc', 'settings', 'board', 'term'];
        for (const pg of pages){
          /* 万一还是被收走了（比如某个板块自己改了钉住态），这一步把它叫回来。
             没有这一句时，6372 B 的空白图会被当成"这一页就这样"收下。 */
          if (!win.isVisible()) openPanel('key');
          await win.webContents.executeJavaScript('switchPage("' + pg + '")');
          await new Promise(r => setTimeout(r, 700));
          const p2 = await win.webContents.capturePage();
          const f2 = path.join(app.getPath('userData'), '_desk_' + pg + '.png');
          fs.writeFileSync(f2, p2.toPNG());
          o.push('  ' + pg + ' → ' + f2 + ' (' + fs.statSync(f2).size + ' B)');
          /* 终端页在**窗口可见**的前提下单独量一次"画出来了没有"。
             前面那段（窗口还收着）判不了这件事：xterm 的 fit / 重绘挂在
             requestAnimationFrame 上，隐藏窗口会被 Chromium 停掉，
             于是"一屏 0 字符"—— 那是没机会画，不是画不出来。
             这里窗口一定可见，量到的才是真话：图看着空白，就得能指着它说
             "是没起会话"还是"起了但没画出来"。 */
          if (pg === 'term'){
            /* 先让终端里有一点真实输出，再截图。
               空终端 + 一个光标说明不了"这是真 ConPTY 会话"，而"真终端"
               恰好是这个板块唯一的卖点 —— README 要用这张图。走用户自己的
               入口 termRunCmd，不绕过它那里的危险命令确认那一层。 */
            /* 命令要**短输出**：终端面板只有 54 列，dir 那种宽输出会被硬折成
               每行三四个字符，截出来完全不能看（第一版就是这么废掉的）。 */
            const runRes = [];
            for (const c of ['git --version', 'node --version', 'Get-Location']){
              runRes.push(await win.webContents.executeJavaScript(
                '(function(){ try{ termRunCmd(' + JSON.stringify(c) + '); return "ok"; }'
                + ' catch(e){ return "err:" + e.message; } })()'));
              await new Promise(r => setTimeout(r, 450));
            }
            o.push('  终端里跑了 3 条命令 → ' + runRes.join(','));
            await new Promise(r => setTimeout(r, 1300));
            const pf = await win.webContents.capturePage();
            const ff = path.join(app.getPath('userData'), '_desk_term.png');
            fs.writeFileSync(ff, pf.toPNG());
            o.push('  等输出落定后重截 → ' + fs.statSync(ff).size + ' B');
            const paint = JSON.parse(await win.webContents.executeJavaScript(
              '(function(){ var pk = Object.keys(TERM_UI.pane); var p = pk.length ? TERM_UI.pane[pk[0]] : null;'
              + ' var xr = document.querySelector("#termMount .xterm-rows");'
              + ' var txt = xr ? (xr.textContent || "") : "";'
              + ' return JSON.stringify({ panes:pk.length,'
              + '  bufLen:p ? p.buf.length : -1, rows:p && p.term ? p.term.rows : -1,'
              + '  rowsChars:txt.replace(/\\s+/g," ").trim().length,'
              + '  hasPrompt:/PS [A-Za-z]:[\\\\/]/.test(txt),'
              + '  screen:xr ? (txt.replace(/\\s+/g," ").trim().slice(-60)) : "(无 .xterm-rows)" }); })()'));
            o.push('  终端页可见时 → ' + JSON.stringify(paint));
            /* 判定不在这里下 —— 0.5.0 便携版实测第一帧时提示符还没回（shell 刚起），
               rowsChars=0 / hasPrompt=false，判成「★ 否」，可第二帧里提示符清清楚楚。
               判定挪到第二帧之后，取两次读数里好的那次。 */
            /* 字在 DOM 里 ≠ 屏幕上看得见。截图里终端是一片纯色底、行文字却在
               textContent 里 —— 这种情况只有把**几何与颜色**摊开才判得清：
               要么是被裁掉了（框外/零高），要么是颜色和底色叠在一起了。
               光看"textContent 非空"会得出一个和眼睛相反的结论。 */
            const gly = JSON.parse(await win.webContents.executeJavaScript(
              '(function(){ var R = function(e){ if(!e) return "-"; var r = e.getBoundingClientRect();'
              + '  return Math.round(r.left)+","+Math.round(r.top)+" "+Math.round(r.width)+"x"+Math.round(r.height); };'
              + ' var xa = document.querySelector("#termMount .xterm");'
              + ' var xs = document.querySelector("#termMount .xterm-screen");'
              + ' var rows = document.querySelector("#termMount .xterm-rows");'
              + ' var r0 = rows && rows.firstElementChild;'
              + ' var s0 = r0 ? r0.querySelector("span") : null;'
              + ' var pane = document.querySelector("#termMount .tz-pane");'
              + ' var host = document.querySelector(".tz-host");'
              + ' var main = document.querySelector(".tz-main");'
              + ' var cs = function(e, k){ return e ? getComputedStyle(e)[k] : "-"; };'
              + ' return JSON.stringify({'
              + '  main:R(main), host:R(host), pane:R(pane), hostCls:(host||{}).className||"-", paneCls:(pane||{}).className||"-",'
              + '  xterm:R(xa), screen:R(xs), rows:R(rows), row0:R(r0), span0:R(s0),'
              + '  xtermBg:cs(xa,"backgroundColor"), xtermColor:cs(xa,"color"),'
              + '  rowsColor:cs(rows,"color"), spanColor:cs(s0,"color"), spanText:s0 ? s0.textContent : "-",'
              + '  xtermOverflow:cs(xa,"overflow"), hostOverflow:cs(host,"overflow"),'
              + '  paneDisplay:cs(pane,"display"), paneVisibility:cs(pane,"visibility"), paneOpacity:cs(pane,"opacity")'
              + ' }); })()'));
            o.push('  字形核查 → ' + JSON.stringify(gly));
            /* 再截一帧，隔 1.4 秒。
               DOM 说提示符在框内、颜色是深棕，可第一帧里终端区**一个深色像素
               都没有**（像素级数过）。这只有两种可能：终端那一层压根没被合成
               进 capturePage，或者第一帧是过期的。隔一会儿再截一帧就能分开：
               第二帧有墨 = 过期帧；还是没墨 = 这一层没被截进来。
               两种结论的处置完全不同，所以要把两帧都留下来比。 */
            await new Promise(r => setTimeout(r, 1400));
            const p2b = await win.webContents.capturePage();
            const f2b = path.join(app.getPath('userData'), '_desk_term2.png');
            fs.writeFileSync(f2b, p2b.toPNG());
            o.push('  终端第二帧（+1.4s）→ ' + f2b + ' (' + fs.statSync(f2b).size + ' B)');
            /* 判定取两次读数里**好的那次**：提示符从无到有是"时序慢一拍"，
               两帧都没有才是真的没画出来。第一帧在这里判过一次红（0.5.0 便携版
               实测），把它挪到这就是为了不再出一盏会自己灭掉的灯。 */
            const paint2 = JSON.parse(await win.webContents.executeJavaScript(
              '(function(){ var pk = Object.keys(TERM_UI.pane); var p = pk.length ? TERM_UI.pane[pk[0]] : null;'
              + ' var xr = document.querySelector("#termMount .xterm-rows");'
              + ' var txt = xr ? (xr.textContent || "") : "";'
              + ' return JSON.stringify({ panes:pk.length,'
              + '  rowsChars:txt.replace(/\\s+/g," ").trim().length,'
              + '  hasPrompt:/PS [A-Za-z]:[\\\\/]/.test(txt) }); })()'));
            const best = (paint.hasPrompt ? paint : (paint2.hasPrompt ? paint2 : paint));
            o.push('  第二帧读数 → ' + JSON.stringify(paint2));
            o.push('  判定 终端真的画到屏幕上了（窗口可见，两帧取好）= '
              + ((best.panes >= 1 && best.hasPrompt && best.rowsChars > 0) ? '是' : '★ 否'));
            o.push('  ⚠ 别用截图判断终端画没画出来：capturePage 偶尔抓不到 xterm 那一层'
              + '文字 —— 同一页两帧可以一帧一个深色像素都没有、一帧有一千多个'
              + '（像素级数过：_inkcheck.js）。要判"有没有画出来"，看 .xterm-rows 的'
              + 'textContent（上面的 hasPrompt / rowsChars），别盯图。');
          }
        }
        /* 终端页这一轮瘦了身，两个**新入口**必须亲眼看过再收工：
             ① 页头的 ⓘ —— 四行说明挪进去之后，浮层里读起来还像不像一句话；
             ② 标签栏的「更多」—— 撤掉的 16 键预设墙 + 4 个动作按钮全靠它，
                要看清每条预设是不是真的带着"将要执行的命令原文"。
           只读 DOM 只能证明"节点在"，证明不了"打开之后是能用的"。
           截完必须关掉浮层：后面那张搜索态是整窗截图，浮层留着会跑进去。 */
        await win.webContents.executeJavaScript('switchPage("term")');
        await new Promise(r => setTimeout(r, 700));
        await win.webContents.executeJavaScript(
          '(function(){var b=document.querySelector(\'[data-act="ph-info"]\'); if(b) b.click(); return 1;})()');
        await new Promise(r => setTimeout(r, 620));
        const pInfo = await win.webContents.capturePage();
        const fInfo = path.join(app.getPath('userData'), '_desk_term_info.png');
        fs.writeFileSync(fInfo, pInfo.toPNG());
        o.push('  终端 ⓘ 说明 → ' + fInfo + ' (' + fs.statSync(fInfo).size + ' B)');
        await win.webContents.executeJavaScript(
          '(function(){var m=document.querySelectorAll(".minip:not(.closing) [data-r=\\"0\\"]");'
          + ' if(m.length) m[m.length-1].click(); return 1;})()');
        await new Promise(r => setTimeout(r, 420));
        await win.webContents.executeJavaScript(
          '(function(){var b=document.querySelector(\'[data-act="term-more"]\'); if(b) b.click(); return 1;})()');
        await new Promise(r => setTimeout(r, 620));
        const pMore = await win.webContents.capturePage();
        const fMore = path.join(app.getPath('userData'), '_desk_term_more.png');
        fs.writeFileSync(fMore, pMore.toPNG());
        o.push('  终端「更多」→ ' + fMore + ' (' + fs.statSync(fMore).size + ' B)');
        /* 再往下一层：预设二级浮层（16 条 + 命令原文）。这一层是"墙变浮层"
           之后最容易做丢的地方 —— 命令原文没了就等于用户还是看不见要跑什么。 */
        await win.webContents.executeJavaScript(
          '(function(){var o=document.querySelectorAll(".minip:not(.closing) .mp-opt");'
          + ' for(var i=0;i<o.length;i++){ if(o[i].textContent.indexOf("常用命令")>=0){ o[i].click(); return 1; } }'
          + ' return 0;})()');
        await new Promise(r => setTimeout(r, 620));
        const pPre = await win.webContents.capturePage();
        const fPre = path.join(app.getPath('userData'), '_desk_term_presets.png');
        fs.writeFileSync(fPre, pPre.toPNG());
        o.push('  终端预设浮层 → ' + fPre + ' (' + fs.statSync(fPre).size + ' B)');
        await win.webContents.executeJavaScript(
          '(function(){var m=document.querySelectorAll(".minip:not(.closing) [data-r=\\"0\\"]");'
          + ' if(m.length) m[m.length-1].click(); return 1;})()');
        await new Promise(r => setTimeout(r, 420));
        /* AI 那张卡的模型名单：用户这次"连不上"的真正现场。
           滚到那一行再截 —— 默认视口只看得见卡片上半部分。 */
        await win.webContents.executeJavaScript('switchPage("settings")');
        await new Promise(r => setTimeout(r, 520));
        await win.webContents.executeJavaScript(
          '(function(){var r=document.querySelector("#aiModelChips");'
          + ' if(r&&r.scrollIntoView) r.scrollIntoView({block:"center"}); return 1;})()');
        await new Promise(r => setTimeout(r, 520));
        const pAi = await win.webContents.capturePage();
        const fAi = path.join(app.getPath('userData'), '_desk_ai_chips.png');
        fs.writeFileSync(fAi, pAi.toPNG());
        o.push('  模型名单那一行 → ' + fAi + ' (' + fs.statSync(fAi).size + ' B)');
        /* 搜索态也截一张（跨板块结果页在窄面板下的表现） */
        await win.webContents.executeJavaScript(
          '(function(){var q=document.getElementById("q");q.value="标定";q.dispatchEvent(new Event("input",{bubbles:true}));return 1;})()');
        await new Promise(r => setTimeout(r, 700));
        const p3 = await win.webContents.capturePage();
        const f3 = path.join(app.getPath('userData'), '_desk_search.png');
        fs.writeFileSync(f3, p3.toPNG());
        o.push('  搜索态 → ' + f3 + ' (' + fs.statSync(f3).size + ' B)');

        /* 「窗口编排」那一行在设置页偏下，默认视口看不到 —— 单独滚过去再截
           一张。不截的话，"这个功能到底有没有入口"就只能靠读 DOM 相信它
           存在，而这恰恰是用户抱怨过一次的那类问题（"这块我没有找到入口呢"）。
           ⚠ 上面刚把查询框填成"标定"，搜索态下 renderPage 出的是跨板块结果页
           而不是设置页 —— 不先清掉查询，截到的会是搜索结果（第一次就是）。 */
        await win.webContents.executeJavaScript(
          '(function(){var q=document.getElementById("q");q.value="";'
          + 'q.dispatchEvent(new Event("input",{bubbles:true}));return 1;})()');
        await new Promise(r => setTimeout(r, 420));
        await win.webContents.executeJavaScript('switchPage("settings")');
        await new Promise(r => setTimeout(r, 520));
        await win.webContents.executeJavaScript(
          '(function(){var a=document.getElementById("zoneApply");'
          + 'if(a&&a.scrollIntoView)a.scrollIntoView({block:"center"});return 1;})()');
        await new Promise(r => setTimeout(r, 520));
        const p4 = await win.webContents.capturePage();
        const f4 = path.join(app.getPath('userData'), '_desk_zones.png');
        fs.writeFileSync(f4, p4.toPNG());
        o.push('  窗口编排那一行 → ' + f4 + ' (' + fs.statSync(f4).size + ' B)');
      } catch (e){ o.push('截图失败: ' + (e && e.message)); }
      finally { S.pinned = pinned0; o.push('  截图期间钉住过窗口（已还原 · 原 S.pinned = ' + pinned0 + '）'); }

      /* 存档往返：真写一条进去，看它有没有落到 userData/store.json */
      const n = DATA_NOW();
      o.push('=== 存档往返 ===');
      o.push('  写入前 store.json 大小 = ' + (fs.existsSync(storePath()) ? fs.statSync(storePath()).size : 0));
      await win.webContents.executeJavaScript('(function(){ DATA.folders.unshift({name:"自检占位",path:"E:\\\\__jz_diag__"}); mark("folders"); return 1; })()');
      await new Promise(r => setTimeout(r, 1400));   /* 等 400ms 的 debounce 镜像 */
      const d = readStore();
      o.push('  写入后能读回 = ' + !!d + ' · 含自检占位 = '
        + !!(d && d.data && (d.data.folders || []).some(f => f.name === '自检占位')));
      o.push('  快照字节 = ' + (fs.existsSync(storePath()) ? fs.statSync(storePath()).size : 0));
      await win.webContents.executeJavaScript('(function(){ DATA.folders = DATA.folders.filter(f => f.name !== "自检占位"); mark("folders"); return 1; })()');
      await new Promise(r => setTimeout(r, 900));

      o.push('=== 剪切板常驻监听 ===');
      try {
        await win.webContents.executeJavaScript(
          '(function(){ state.settings.boardWatch = true; startClipWatch(); return 1; })()');
        const marker = '聚珍自检剪切板标记 ' + Date.now();
        clipboard.writeText(marker);
        await new Promise(r => setTimeout(r, 2800));
        const hit = await win.webContents.executeJavaScript(
          '(function(){ return DATA.board.filter(function(b){ return b.text.indexOf("聚珍自检剪切板标记") >= 0; }).length; })()');
        o.push('  写入系统剪贴板 = ' + JSON.stringify(marker));
        o.push('  2.8 秒后自动入库 = ' + (hit ? '是（' + hit + ' 条 · 监听链路通）' : '否！！没被记下来'));
        /* 清干净：别在用户的剪切板板块里留自检垃圾 */
        await win.webContents.executeJavaScript(
          '(function(){ DATA.board = DATA.board.filter(function(b){ return b.text.indexOf("聚珍自检剪切板标记") < 0; });'
          + ' state.settings.boardWatch = false; stopClipWatch(); mark("board"); return 1; })()');
        await new Promise(r => setTimeout(r, 700));
      } catch (e){ o.push('  剪切板监听自检失败: ' + (e && e.message)); }

      /* 拖入文件那条路的后端。直接打 IPC，验"真抄了一份出来、内容一致"，
         再验一次失败分支 —— 源文件不存在时必须如实报错，不能假装成功。 */
      o.push('=== 拖入文件 · 实体副本 ===');
      try {
        const tf = path.join(app.getPath('userData'), '_diag_src.txt');
        fs.writeFileSync(tf, '聚珍自检 · 实体副本内容 ' + Date.now(), 'utf8');
        const r = await win.webContents.executeJavaScript('window.JZ.copyIn(' + JSON.stringify(tf) + ')');
        const okCopy = !!(r && r.ok && r.path && fs.existsSync(r.path));
        const same = !!(okCopy && fs.readFileSync(r.path, 'utf8') === fs.readFileSync(tf, 'utf8'));
        o.push('  源文件 = ' + tf);
        o.push('  副本 = ' + (r && r.path ? r.path : '(失败: ' + (r && r.error) + ')'));
        o.push('  副本存在 = ' + okCopy + ' · 内容一致 = ' + same + ' · 大小 ' + (r && r.size) + ' B');
        const bad = await win.webContents.executeJavaScript('window.JZ.copyIn("E:\\\\__jz_not_here__\\\\nope.txt")');
        o.push('  源不存在时 → ok=' + !!(bad && bad.ok) + ' · error=' + (bad && bad.error));
        if (okCopy){ try { fs.unlinkSync(r.path); } catch (e){} }
        try { fs.unlinkSync(tf); } catch (e){}
      } catch (e){ o.push('  实体副本自检失败: ' + (e && e.message)); }

      /* 右键「粘贴到当前窗口」的底层通路。这个动作的承诺是"内容进系统剪贴板
         + 面板让开"，前半句可以在这里验死：写完读回来必须一字不差。 */
      o.push('=== 粘贴通路（pasteToFront）===');
      try {
        const mk = '聚珍自检·粘贴通路 ' + Date.now();
        clipboard.writeText('聚珍自检·占位');
        await win.webContents.executeJavaScript(
          '(function(){ pasteToFront(' + JSON.stringify(mk) + '); return 1; })()');
        await new Promise(r => setTimeout(r, 500));
        const got = clipboard.readText();
        o.push('  目标文本 = ' + JSON.stringify(mk));
        o.push('  剪贴板读回 = ' + (got === mk ? '一致' : '不一致！！ 实际 ' + JSON.stringify(got)));
        o.push('  面板已收起 = ' + !win.isVisible());
      } catch (e){ o.push('  粘贴通路自检失败: ' + (e && e.message)); }

      /* === 场景：两条新能力 + 编辑是否落盘 ===
         场景的 folder / file / link 三类走的是早就有的 openPath / openExternal，
         这里补测的是这一轮新加的东西：批量探测（卡片靠它把失效动作标出来）
         和命令执行。真正的"点场景"不在这里测 —— 那会真的弹出一堆资源管理器
         窗口，把自检变成一次骚扰。 */
      o.push('=== 场景：探测 / 命令 / 编辑落盘 ===');
      /* 正样本挑一个永远存在的路径：前面的实体副本用例会故意把那个临时源文件
         删掉（那是它要测的失败分支），拿它当"存在"只会得到一条误导性结论。 */
      const pYes = app.getPath('userData');
      const pNo  = path.join(app.getPath('userData'), '肯定不存在_zzz');
      const probeRes = await win.webContents.executeJavaScript(
        'JZ.probe([' + JSON.stringify(pYes) + ',' + JSON.stringify(pNo) + ',""])');
      o.push('  sys:probe → ' + (probeRes || []).map((r, i) =>
        ['存在的目录', '瞎编的路径', '空串'][i] + '=' + (r && r.exists ? '在' : '不在')
        + (r && r.exists ? '(是目录=' + r.isDir + ')' : '')).join(' · '));

      const cmdOK = await win.webContents.executeJavaScript(
        'JZ.runCmd("echo 聚珍自检命令输出" , "")');
      o.push('  sys:runCmd 正常命令 → ok=' + !!(cmdOK && cmdOK.ok)
        + ' · 输出 = "' + String((cmdOK && cmdOK.out) || '').trim().slice(0, 40) + '"'
        + ' · 工作目录 = ' + ((cmdOK && cmdOK.cwd) ? '已给' : '没给'));

      const cmdBad = await win.webContents.executeJavaScript(
        'JZ.runCmd("juzhen_no_such_cmd_zzz", "")');
      o.push('  sys:runCmd 不存在的命令 → 如实报错 = '
        + (cmdBad && !cmdBad.ok) + ' · error 非空 = ' + !!(cmdBad && cmdBad.error));

      /* 输出编码这件事不能只靠"跑一条命令看结果漂不漂亮"来判 —— 那要依赖
         本机的代码页和 PATH 上有没有某个程序。decodeOut 是纯函数，直接喂
         三种已知字节，判据就钉死了。三种字节都来自实测抓包：
         `echo 聚珍自检命令输出`（GBK，be db d5 e4 …）、同一句走 cmd /u
         （UTF-16LE）、Node 的 UTF-8 输出。
         第四路挑的是**现实里真的会遇到的宽字符输出**：where.exe 那种带盘符
         路径的。不拿"纯中文的 UTF-16LE"当用例，因为那条现实中不存在，而且
         按注释里写的边界它本来就不在该函数的承诺范围内 —— 拿它当用例只会
         让自检红在一个假问题上。 */
      const want = '聚珍自检命令输出';
      const wide = 'C:\\Windows\\System32\\where.exe';
      const probes = [
        ['GBK',      Buffer.from('bedbd5e4d7d4bcecc3fcc1eecae4b3f6', 'hex'), want],
        ['UTF-16LE', Buffer.from(wide, 'utf16le'), wide],
        ['UTF-8',    Buffer.from(want, 'utf8'), want]
      ];
      o.push('  decodeOut 三路字节 → ' + probes.map(([tag, buf, exp]) => {
        const got = decodeOut(buf);
        return tag + '=' + (got === exp ? '对' : '✗"' + got + '"');
      }).join(' · '));

      /* 场景编辑：加一个动作 → 内存变 → 等镜像去抖（400ms）→ 存档文件里真的有 */
      const sceneAdd = await win.webContents.executeJavaScript(
        '(function(){ var s = TOOL.scenes[0]; if (!s) return "没有场景";'
        + ' if (!Array.isArray(s.acts)) s.acts = []; var n = s.acts.length;'
        + ' s.acts.push({ k:"link", v:"https://example.com/diag", t:"自检加的动作" });'
        + ' mark("scenes"); return n + "→" + s.acts.length; })()');
      await new Promise(r => setTimeout(r, 900));
      let sceneStored = false, sceneReadBack = '';
      try {
        const sd = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
        /* 快照的形状是 {app, version, at, data:{folders:…, scenes:…}}，
           集合在 data 下面。第一版这里读的是 sd.scenes —— 永远 undefined，
           于是"存档里也有"恒为 false，看上去像落盘坏了，实际是自检读错了层。
           顺手把顶层键和 data 里的键都打出来，下次一眼能看出层级读对没有。 */
        const data = (sd && sd.data && typeof sd.data === 'object') ? sd.data : {};
        const sc = Array.isArray(data.scenes) ? data.scenes : [];
        sceneReadBack = sc.length + ' 个场景 · 顶层键[' + Object.keys(sd).join(',')
          + '] · data 键 ' + Object.keys(data).length + ' 个';
        sceneStored = JSON.stringify(sc).indexOf('自检加的动作') >= 0;
      } catch (e){ sceneReadBack = '读存档失败：' + e.message; }
      o.push('  场景加动作 → 动作数 ' + sceneAdd + ' · 存档里也有 = ' + sceneStored
        + '（' + sceneReadBack + '）');

      /* 失效动作标记：内置场景写的是示意路径，本机没有 → 卡片上应该标出来。
         探测走一次 IPC 才回来，所以轮询等它。
         进场景页之前必须清掉搜索词：renderPage 见到 state.query 非空会把
         **跨板块搜索结果**渲染进这个 body，拿到的就是 0 张卡片 0 个动作 ——
         第一版自检就是这么把自己骗过去的（前面截图那段留了个搜索态没收）。
         另外渲染是按需的，切完页等 .scard 真的出现再数。 */
      const goScene = await win.webContents.executeJavaScript(
        '(function(){ if (state.query) exitSearch(false); switchPage("scene");'
        + ' return "query=\\"" + (state.query || "") + "\\" page=" + state.page; })()');
      let sceneDom = '', sceneRaw = '';
      for (let i = 0; i < 30; i++){
        sceneDom = await win.webContents.executeJavaScript(
          '(function(){ return "场景 " + TOOL.scenes.length + " 个 · 卡片 "'
          + ' + document.querySelectorAll(".scard").length + " 张 · 动作 "'
          + ' + document.querySelectorAll(".sc-act").length + " 个 · 当前页 " + state.page'
          + ' + " · 搜索态 " + !!state.query; })()');
        if (String(sceneDom).indexOf('卡片 0 张') < 0) break;
        await new Promise(r => setTimeout(r, 150));
      }
      sceneRaw = await win.webContents.executeJavaScript(
        '(function(){ var b = document.querySelector(\'#track .page[data-page="scene"] .page-body\');'
        + ' return b ? b.innerHTML.replace(/\\s+/g," ").slice(0,160) : "(没有 body)"; })()');
      o.push('  进场景页 → ' + goScene);
      o.push('  场景页 DOM = ' + sceneDom);
      if (String(sceneDom).indexOf('卡片 0 张') >= 0) o.push('  ↑ 没渲染出卡片，body 开头是：' + sceneRaw);
      let missTex = '（探测没回来）';
      for (let i = 0; i < 24; i++){
        missTex = await win.webContents.executeJavaScript(
          'document.querySelectorAll(".sc-act.miss").length + "/" + document.querySelectorAll(".sc-act").length');
        if (String(missTex).split('/')[0] !== '0') break;
        await new Promise(r => setTimeout(r, 150));
      }
      o.push('  卡片上被标为「找不到」的动作 = ' + missTex);

      /* === 编辑入口 ===
         "增 / 改 / 删"是这一轮补的重点，而其中有一格是桌面版**专有**的：
         文件夹表单里路径那格右边的「选择…」（走系统目录对话框）。
         浏览器里渲染它等于摆一个点不动的按钮，所以刻意只在 DESK 下建。
         这里验两件事：DESK 下确实建出来了，以及它旁边的输入框被算子等宽。
         不去点它 —— 系统模态框会把自检卡死在无人值守的窗口里。 */
      o.push('=== 编辑入口 ===');
      try {
        const editForm = await win.webContents.executeJavaScript(
          '(function(){ if (state.query) exitSearch(false); switchPage("folders");'
          + ' if (!document.querySelector(".minip:not(.closing)")){'
          + '   var b = document.querySelector(\'[data-act="folder-new"]\');'
          + '   if (!b) return "没有「新增文件夹」按钮"; b.click(); }'
          + ' var p = document.querySelector(".minip:not(.closing)");'
          + ' if (!p) return "表单没弹出来";'
          + ' return "字段 " + p.querySelectorAll(".mp-in").length'
          + '   + " 个 · 「选择…」按钮 " + p.querySelectorAll(".mp-browse").length + " 个"'
          + '   + " · 路径格等宽 = " + !!p.querySelector(".mp-f.mono input.mp-in")'
          + '   + " · 标题 " + JSON.stringify(p.querySelector(".mp-t").textContent); })()');
        o.push('  文件夹新增表单 → ' + editForm);
        const dash = await win.webContents.executeJavaScript(
          '(function(){ switchPage("folders"); return "文件夹页 ⋯ 按钮 "'
          + ' + document.querySelectorAll(\'#track .page[data-page="folders"] .row .ctx-more\').length'
          + ' + " 个 / 行 " + document.querySelectorAll(\'#track .page[data-page="folders"] .row\').length + " 个"; })()');
        o.push('  ' + dash);
        /* 把这个浮层收掉，别让它出现在最后的重绘检查里 */
        await win.webContents.executeJavaScript(
          '(function(){ var p = document.querySelector(".minip:not(.closing)");'
          + ' if (p){ var c = p.querySelector(\'.mp-r [data-r="0"]\'); if (c) c.click(); } return 1; })()');
      } catch (e){ o.push('  编辑入口自检失败: ' + (e && e.message)); }

      /* === 每个板块都要有可操作的入口 ===
         用户明确要求："每一个功能板块都要可编辑的，你要给我可操作的入口"。
         这一轮补的：页头「+」与列表底部「新增」合并成同一条路（folders / links
         原来有两条行为不同的新增）；剪切板记录和贴图补上可见的 ⋯；暂存区页头
         「+」从一句 toast 变成真的调系统文件对话框。
         构建期那三条守卫扫的是**静态 HTML**，而页头「+」的动作名是 pageHead
         运行时才拼进 DOM 的，静态 HTML 里根本搜不到 —— 所以这里再在**渲染
         之后**逐个页面对一遍，补上那个盲区。 */
      o.push('=== 各板块可操作入口 ===');
      try {
        const entryAudit = await win.webContents.executeJavaScript(
          '(function(){'
          + ' if (state.query) exitSearch(false);'
          + ' var out = [];'
          + ' var ITEM = { today:".todo,.row[data-kind=recent]", folders:".row", links:".row",'
          + '   clip:".cclip", staging:".fcard", board:".bcard", scene:".scard", snip:".snip",'
          + '   note:".ncard", shot:".shot" };'
          + ' PAGES.forEach(function(p){'
          + '   if (!ITEM[p.id]) return;'
          + '   switchPage(p.id);'
          + '   var pg = document.querySelector(\'#track .page[data-page="\' + p.id + \'"]\');'
          + '   var body = pg && (pg.querySelector(".page-body") || pg);'
          + '   if (!body) return;'
          + '   var items = body.querySelectorAll(ITEM[p.id]).length;'
          + '   var more = body.querySelectorAll(".ctx-more").length;'
          + '   var acts = [].slice.call(body.querySelectorAll("[data-act]")).filter(function(e){'
          + '     var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });'
          + '   var add = acts.filter(function(e){ return /-(new|add|save|read|send)$/.test(e.dataset.act); });'
          + '   out.push(p.id + ":条目" + items + " ⋯" + more + " 增" + add.length'
          + '     + (items > 0 && more === 0 && add.length === 0 ? " ←缺口" : ""));'
          + ' });'
          + ' return out.join(" · "); })()');
        o.push('  ' + entryAudit);

        /* 页头「+」必须和列表底部那个走同一条路：都弹表单。
           这两处原来是两套逻辑（页头桌面版直接调选择框、浏览器里塞假数据），
           用户点到哪个全看运气。 */
        const headPlus = await win.webContents.executeJavaScript(
          '(function(){ if (state.query) exitSearch(false); switchPage("folders");'
          + ' var b = document.querySelector(\'.ph-act[data-act="folders-add"]\');'
          + ' if (!b) return "页头没有「+」按钮"; b.click();'
          + ' var p = document.querySelector(".minip:not(.closing)");'
          + ' if (!p) return "点了页头「+」但表单没出来";'
          + ' return "表单字段 " + p.querySelectorAll(".mp-in").length + " 个 · 标题 "'
          + '   + JSON.stringify(p.querySelector(".mp-t").textContent); })()');
        o.push('  页头「+」→ ' + headPlus);
        await win.webContents.executeJavaScript(
          '(function(){ var p = document.querySelector(".minip:not(.closing)");'
          + ' if (p){ var c = p.querySelector(\'.mp-r [data-r="0"]\'); if (c) c.click(); } return 1; })()');

        /* 剪切板记录与贴图：这一轮才补上可见 ⋯，两页都要数到 */
        const moreCount = await win.webContents.executeJavaScript(
          '(function(){ var r = {};'
          + ' switchPage("board");'
          + ' r.board = document.querySelectorAll(\'#track .page[data-page="board"] .bcard .ctx-more\').length'
          + '   + "/" + document.querySelectorAll(\'#track .page[data-page="board"] .bcard\').length;'
          + ' switchPage("shot");'
          + ' r.shot = document.querySelectorAll(\'#track .page[data-page="shot"] .shot .ctx-more\').length'
          + '   + "/" + document.querySelectorAll(\'#track .page[data-page="shot"] .shot\').length;'
          + ' return "board ⋯ " + r.board + " · shot ⋯ " + r.shot; })()');
        o.push('  ' + moreCount);
      } catch (e){ o.push('  板块入口自检失败: ' + (e && e.message)); }

      /* === 贴图钉窗 ===
         这轮新接的桥。判据不商量：真落一张 PNG、真发一次 shot:pin ——
         窗口建没建、桥通没通、state 记没记，只有真开一次才知道；
         然后真收掉，确认窗口数回到原样。反例同样要验：
         图片不存在的记录必须 ok:false 且带着原因，不许假装钉上了。 */
      o.push('=== 贴图钉窗 ===');
      try {
        const winsBefore = BrowserWindow.getAllWindows().length;
        const dir = path.join(app.getPath('userData'), 'files');
        fs.mkdirSync(dir, { recursive: true });
        const pngPath = path.join(dir, '_diag-pin.png');
        fs.writeFileSync(pngPath, nativeImage.createFromDataURL(
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR4nGP8z8Dwn4EIwESMolUAJZ4L/6ddC4cAAAAASUVORK5CYII=').toPNG());
        const pinRes = await win.webContents.executeJavaScript(
          'JZ.shot.pin({ id:"_diagpin", src:' + JSON.stringify(pngPath)
          + ', t:"自检贴图", w:320, h:200, op:80 }).then(r => JSON.stringify(r))');
        o.push('  shot:pin 真开一次 → ' + pinRes + (String(pinRes).indexOf('"ok":true') >= 0 ? ' ✓' : ' ✗'));
        await new Promise(r => setTimeout(r, 700));
        const winsPinned = BrowserWindow.getAllWindows().length;
        const pinWin = BrowserWindow.getAllWindows().find(w => w.getTitle().indexOf('自检贴图') >= 0);
        o.push('  钉窗建出来 → 窗口数 ' + winsBefore + '→' + winsPinned
          + ' · 标题命中 ' + (pinWin ? 'ok' : '✗ 没找到'));
        const stateRes = await win.webContents.executeJavaScript(
          'JZ.shot.state().then(r => JSON.stringify(r))');
        o.push('  shot:state → ' + stateRes
          + (String(stateRes).indexOf('_diagpin') >= 0 ? ' ✓ 记着这张' : ' ✗ 没记'));
        const unpinRes = await win.webContents.executeJavaScript(
          'JZ.shot.unpin("_diagpin").then(r => JSON.stringify(r))');
        await new Promise(r => setTimeout(r, 400));
        const winsAfter = BrowserWindow.getAllWindows().length;
        o.push('  shot:unpin → ' + unpinRes + ' · 窗口数回落 ' + winsAfter
          + (winsAfter === winsBefore ? ' ✓' : ' ✗'));
        const pinFake = await win.webContents.executeJavaScript(
          'JZ.shot.pin({ id:"_diagpin2", src:"C:\\\\juzhen_no_such_zzz\\\\nope.png" }).then(r => JSON.stringify(r))');
        o.push('  shot:pin 图片不存在 → ' + pinFake
          + (String(pinFake).indexOf('"ok":false') >= 0 && String(pinFake).indexOf('不在') >= 0
            ? ' ✓ 带原因拒绝' : ' ✗ 必须拒绝并说明'));
        try { fs.unlinkSync(pngPath); } catch (e){}
      } catch (e){ o.push('  贴图钉窗自检失败: ' + (e && e.message)); }

      /* === 预览按钮 & 最近使用 ===
         这一轮修的是"桥通了、但没接线"：预览面板上的「打开原文件 / 在文件夹中
         显示 / 用浏览器打开」三个处理分支原来只各弹一句 toast，而 preload 里
         sys:reveal / sys:openPath / sys:openExternal 早就通了。
         断言方式挑了个骗不过去的：让 pv-reveal 去定位一条**本机不存在**的种子
         路径 —— 真接线了会先过存在性预检，吐司是"没法定位：这个路径在本机不存在"；
         还是桩的话只回"在文件夹中显示 · 路径"，字面完全对不上。
         另外「最近使用」补了移除入口，验它真的改列表、且落了盘。 */
      o.push('=== 预览按钮 & 最近使用 ===');
      try {
        const realDir = app.getPath('userData');
        const revealReal = await win.webContents.executeJavaScript(
          'JZ.reveal(' + JSON.stringify(realDir) + ').then(r => JSON.stringify(r))');
        o.push('  JZ.reveal 真实存在的目录 → ' + revealReal);
        const fakePath = 'C:\\juzhen_no_such_zzz\\nope.txt';
        const revealFake = await win.webContents.executeJavaScript(
          'JZ.reveal(' + JSON.stringify(fakePath) + ').then(r => JSON.stringify(r))');
        o.push('  JZ.reveal 瞎编的路径 → ' + revealFake + '（必须 ok:false —— Explorer 对不存在的路径不报错，假成功最难查）');

        const pvRes = await win.webContents.executeJavaScript(
          '(function(){ if (state.query) exitSearch(false); switchPage("staging");'
          + ' var c = document.querySelector(\'#track .page[data-page="staging"] .fcard[data-kind="file"]\');'
          + ' if (!c) return "暂存区没有卡片可预览"; c.click();'
          + ' var b = document.querySelector(\'#pvBody [data-act="pv-reveal"]\');'
          + ' if (!b) return "预览面板里没有「在文件夹中显示」按钮";'
          + ' b.click(); return "已点 · 目标=" + b.dataset.path; })()');
        o.push('  pv-reveal 点击 → ' + pvRes);
        await new Promise(r => setTimeout(r, 800));
        const pvToast = await win.webContents.executeJavaScript('$("toastMsg").textContent');
        o.push('    吐司文案 = ' + JSON.stringify(pvToast)
          + (String(pvToast).indexOf('没法定位') >= 0 ? ' ✓ 真接线了' : ' ✗ 还是桩？'));

        /* 自检不许依赖"存档里恰好有数据"。
           「最近使用」是派生日志：上一轮自检跑完之后它可能是空的，而
           **空数组是合法状态**（用户主动清空过），fix() 不会补回演示数据 ——
           所以这条检查会从"验功能"悄悄退化成"今天存档里有没有东西"，
           报出来像功能坏了。自己先塞一条，才是可重复的检查。
           （与上面 folders 塞"自检占位"同一个道理。） */
        const recSeed = await win.webContents.executeJavaScript(
          '(function(){ TOOL.recent.unshift({ name:"自检占位-最近", path:"E:\\\\__jz_diag_recent__",'
          + ' at:Date.now(), kind:"file" }); mark("recent"); refresh(["today"]);'
          + ' return TOOL.recent.length; })()');
        o.push('  注入一条最近使用（自检自己造前置条件）→ ' + recSeed + ' 条');

        const recBefore = await win.webContents.executeJavaScript('TOOL.recent.length');
        const recRes = await win.webContents.executeJavaScript(
          '(function(){ var pv = $("pv");'
          + ' if (pv && pv.classList.contains("show")) $("pvClose").click();'
          + ' switchPage("today");'
          + ' var r = document.querySelector(\'#track .page[data-page="today"] .row[data-kind="recent"]\');'
          + ' if (!r) return "今日页没有「最近使用」的行";'
          + ' var m = r.querySelector(".ctx-more"); if (!m) return "那一行上没有 ⋯ 按钮";'
          + ' m.click(); return "菜单 " + document.querySelectorAll("#ctx.show .ctx-item").length + " 项 → "'
          + '   + [].slice.call(document.querySelectorAll("#ctx.show .ctx-item"))'
          + '       .map(function(e){ return e.textContent.trim(); }).join(" / "); })()');
        o.push('  最近使用的 ⋯ 菜单 → ' + recRes);
        const recDel = await win.webContents.executeJavaScript(
          '(function(){ var it = [].slice.call(document.querySelectorAll("#ctx.show .ctx-item"))'
          + '   .filter(function(e){ return e.textContent.indexOf("移除") >= 0; })[0];'
          + ' if (!it) return "菜单里没有移除项"; it.click(); return "已点移除"; })()');
        await new Promise(r => setTimeout(r, 700));
        const recAfter = await win.webContents.executeJavaScript('TOOL.recent.length');
        o.push('  移除 → ' + recDel + ' · 列表 ' + recBefore + ' → ' + recAfter + '（应收窄 1）');
        let recStored = '未查';
        try {
          const sd2 = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
          recStored = (sd2 && sd2.data && Array.isArray(sd2.data.recent))
            ? sd2.data.recent.length + ' 条' : '存档里没读到 recent';
        } catch (e){ recStored = '读存档失败：' + e.message; }
        o.push('    存档里的 recent = ' + recStored);
      } catch (e){ o.push('  预览按钮/最近使用自检失败: ' + (e && e.message)); }

      /* ================= AI 速问通路 =================
         打包后最容易断的一环：./ai.js 有没有被 electron-builder 打进 asar
         （files 白名单漏一条就会报 Cannot find module，而界面只在点发送时才炸）。
         这里起一个本地假服务端真发一次，把"模块加载 + 请求 + 取回答 + 失败原话"
         整条链路盖住；再问一次渲染侧，确认桥上有 aiChat 且 aiRequest 真走它。 */
      try {
        const http = require('http');
        o.push('=== AI 速问通路 ===');
        o.push('  ai.js 从包里加载 = ' + (AI && typeof AI.chatOnce === 'function' ? 'ok' : '✗ chatOnce 不是函数'));

        const srv = http.createServer((rq, rs) => {
          let b = '';
          rq.on('data', c => { b += c; });
          rq.on('end', () => {
            let j = {};
            try { j = JSON.parse(b); } catch (e){}
            if (String(rq.url).indexOf('/bad/') >= 0){
              rs.writeHead(401, { 'Content-Type': 'application/json' });
              return rs.end(JSON.stringify({ error: { message: '自检：Key 无效' } }));
            }
            const last = (j.messages || []).slice(-1)[0] || {};
            rs.writeHead(200, { 'Content-Type': 'application/json' });
            rs.end(JSON.stringify({
              choices: [{ message: { role: 'assistant',
                content: '自检回答·收到「' + String(last.content || '') + '」' } }],
              usage: { total_tokens: 7 }
            }));
          });
        });
        await new Promise(r => srv.listen(0, '127.0.0.1', r));
        const port = srv.address().port;
        const base = { apiKey: 'sk-diag', model: 'diag-model', temperature: 0.3, maxTokens: 64, timeoutMs: 5000 };

        const okR = await AI.chatOnce(Object.assign({}, base,
          { baseUrl: 'http://127.0.0.1:' + port + '/v1', prompt: '自检问题' }));
        o.push('  真发一次 → ok=' + okR.ok + ' · 回答=' + JSON.stringify(String(okR.text || '').slice(0, 60))
          + ' · 用量带回来了 = ' + !!(okR.usage));

        const badR = await AI.chatOnce(Object.assign({}, base,
          { baseUrl: 'http://127.0.0.1:' + port + '/bad/v1', prompt: '自检问题' }));
        o.push('  401 时 → ok=' + badR.ok + ' · status=' + badR.status + ' · 原话=' + JSON.stringify(badR.error)
          + '（必须 ok=false 且带服务端原话）');

        const nopeR = await AI.chatOnce(Object.assign({}, base, { baseUrl: 'not-a-url', prompt: 'x' }));
        o.push('  坏地址本地拦截 → ok=' + nopeR.ok + ' · ' + JSON.stringify(nopeR.error));
        srv.close();

        /* 渲染侧：桥上有 aiChat（DESK 下 aiRequest 才会走它，而不是浏览器直连） */
        const aiWired = await win.webContents.executeJavaScript(
          '(function(){ try { switchPage("ask"); } catch (e) {}'
          + ' return JSON.stringify({'
          + '   bridge: typeof (window.JZ && JZ.aiChat),'
          + '   desk: DESK,'
          + '   providers: (typeof AI_PROVIDERS !== "undefined" ? AI_PROVIDERS.length : -1),'
          + '   ready: aiReady().ok,'
          + '   strip: (document.querySelector(".ai-st .ai-tx") || {}).textContent || "(无)",'
          + '   chips: [].slice.call(document.querySelectorAll(".ai-chip"))'
          + '           .map(function(e){ return e.textContent; }) }); })()');
        o.push('  渲染侧 = ' + aiWired);
      } catch (e){ o.push('  AI 通路自检失败: ' + (e && e.message)); }

      /* ================= 知识库 =================
         kb.js 是这个项目里"接得最深"的一条链：从包内加载（files 白名单）、
         读 PDF / Word 的两个纯 JS 依赖、再经 IPC 调到嵌入模型。这三段任何
         一段断了，界面在"点加文件夹之后"之前都看不出异常 —— 所以这里把
         真索引跑一遍：临时目录里放真文件 → 起一个假 /embeddings 服务端 →
         走渲染侧的 JZ.kb.addFolder（同一座桥、同一条 IPC）→ 验块数、检索
         命中、跳过原因，最后清干净。
         自检用的是独立的 userData（见 app.setPath），所以这里的清空动的
         不是用户的真索引。 */
      o.push('=== 知识库 ===');
      let kbSrv = null, kbSrcDir = '';
      try {
        o.push('  kb.js 从包里加载 = '
          + (KB && typeof KB.addFolder === 'function' ? 'ok' : '✗ addFolder 不是函数'));

        /* 切块是整条链的地基。不拿"看起来差不多"当判据 —— 先钉两个能算出
           准确答案的纯函数，再拿一段构造出来的长文本看它的块数与块长分布。 */
        o.push('  cosine 自比 = ' + KB.cosine([1, 2, 3], [1, 2, 3]).toFixed(4)
          + ' · 正交 = ' + KB.cosine([1, 0], [0, 1]).toFixed(4) + '（应是 1 与 0）');
        const paras = [];
        for (let i = 0; i < 40; i++)
          paras.push('第 ' + (i + 1) + ' 节：' + '空调标定的环境舱要稳定在 25 摄氏度。'.repeat(12));
        const probeTxt = paras.join('\n\n');
        const probeChunks = KB.chunkText(probeTxt);
        let cMin = Infinity, cMax = 0;
        probeChunks.forEach(c => { cMin = Math.min(cMin, c.length); cMax = Math.max(cMax, c.length); });
        o.push('  chunkText ' + probeTxt.length + ' 字 / 40 段 → ' + probeChunks.length
          + ' 块 · 块长 ' + cMin + '~' + cMax + '（配置块长 ' + KB.LIMITS.CHUNK
          + ' · 重叠 ' + KB.LIMITS.OVERLAP + '）');

        const http = require('http');
        kbSrcDir = path.join(app.getPath('userData'), '_diag_kb_src');
        fs.mkdirSync(kbSrcDir, { recursive: true });
        fs.writeFileSync(path.join(kbSrcDir, '标定说明.md'),
          '# 标定说明\n\n' + '空调标定要在 25 度环境舱里做，先跑稳态再跑动态。\n'.repeat(30), 'utf8');
        fs.writeFileSync(path.join(kbSrcDir, '热舒适模型.py'),
          'def pmv(ta, tr, vel, rh, clo, met):\n    """PMV 计算入口，按 ISO 7730 拆四个子系统。"""\n    return 0.0\n\n'.repeat(24), 'utf8');
        /* 两个"不该被静默吃掉"的样本：
           ① 一个扩展名不在白名单里的文件（.dwg）。它的正确归宿是**根本不进
              待索引清单**（walk 按扩展名筛），所以它不该出现在跳过原因里 ——
              第一版自检在这里放的就是它，然后从"跳过原因 = {}"读出了
              "跳过机制没生效"这个错误结论。判据和样本必须对得上。
           ② 一个 .txt 里装着二进制。这个**会**进清单、也**必须**给出具体原因
              （内容是二进制或非 UTF-8），否则用户只会看到"加进来了但搜不到"。 */
        fs.writeFileSync(path.join(kbSrcDir, '图纸.dwg'), Buffer.from([0x41, 0x43, 0x31, 0x30]), 'utf8');
        const binTxt = Buffer.alloc(1200);
        for (let i = 0; i < binTxt.length; i++) binTxt[i] = (i % 2) ? 0x28 : 0xC3;
        fs.writeFileSync(path.join(kbSrcDir, '伪装成文本的二进制.txt'), binTxt);

        const KY = 8;   /* 假嵌入维度：够小、又能把不同文本区分开 */
        let eCalls = 0, eItems = 0;
        kbSrv = http.createServer((rq, rs) => {
          let b = '';
          rq.on('data', c => { b += c; });
          rq.on('end', () => {
            let j = {};
            try { j = JSON.parse(b); } catch (e){ /* 空体就按空体处理 */ }
            const inp = Array.isArray(j.input) ? j.input : [j.input];
            eCalls++; eItems += inp.length;
            const vec = t => {
              const v = new Array(KY).fill(0), s = String(t);
              for (let i = 0; i < s.length; i++) v[i % KY] += s.charCodeAt(i) % 97;
              const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
              return v.map(x => x / n);
            };
            rs.writeHead(200, { 'Content-Type': 'application/json' });
            rs.end(JSON.stringify({ model: j.model,
              data: inp.map((t, i) => ({ index: i, embedding: vec(t) })),
              usage: { total_tokens: 1 } }));
          });
        });
        await new Promise(r => kbSrv.listen(0, '127.0.0.1', r));
        const eBase = 'http://127.0.0.1:' + kbSrv.address().port + '/v1';
        const embCfg = { provider: 'custom', baseUrl: eBase, model: 'diag-embed', apiKey: 'sk-diag' };
        o.push('  假嵌入服务端 = ' + eBase + '（不联网，只验通路）');

        /* 没配嵌入模型时必须**如实拒绝**，而不是加进去一个没有向量的空壳 */
        const noCfg = await win.webContents.executeJavaScript(
          'JZ.kb.addFolder(null, ' + JSON.stringify(kbSrcDir) + ')');
        o.push('  不传嵌入配置 → ok=' + !!(noCfg && noCfg.ok) + '（必须 false）· 原话='
          + JSON.stringify(String((noCfg && noCfg.error) || '').slice(0, 60)));

        const addR = await win.webContents.executeJavaScript(
          'JZ.kb.addFolder(' + JSON.stringify(embCfg) + ',' + JSON.stringify(kbSrcDir) + ')');
        o.push('  走桥加文件夹 → ok=' + !!(addR && addR.ok)
          + ' · 入库块 ' + (addR && addR.added) + ' · 库内共 ' + (addR && addR.total)
          + ' · 丢弃 ' + (addR && addR.dropped)
          + ' · 跳过原因 ' + JSON.stringify((addR && addR.skipReasons) || {})
          + (addR && addR.error ? ' · error=' + addR.error : ''));
        o.push('  假嵌入服务端收到 ' + eCalls + ' 次请求 / ' + eItems + ' 条文本');

        const stR = await win.webContents.executeJavaScript('JZ.kb.state(null)');
        o.push('  kb:state → 来源 ' + ((stR && stR.sources) || []).length + ' 个'
          + ' · 统计 ' + JSON.stringify((stR && stR.stats) || null));

        const srR = await win.webContents.executeJavaScript(
          'JZ.kb.search(' + JSON.stringify(embCfg) + ', "空调标定 环境舱 25 度", 3)');
        o.push('  kb:search → ok=' + !!(srR && srR.ok)
          + ' · 命中 ' + ((srR && srR.hits) || []).length + ' 条'
          + (((srR && srR.hits) || [])[0] ? ' · 首条来自 ' + JSON.stringify(String(srR.hits[0].title)) : '')
          + (srR && srR.note ? ' · 提示=' + srR.note : '')
          + (srR && srR.error ? ' · error=' + srR.error : ''));

        /* 增量重扫：刚建完库再扫一次，**期间不该有任何嵌入请求** —— 若这里
           又嵌了一遍，说明增量判据（mtime 比对）失效，用户在几百兆资料上
           每点一次都白花钱。
           "重嵌 N 个文件"里可能含那些**读不出来、因而没有 mtime 记录**的文件
           （上面那个伪装成文本的二进制就是）：它每次都会被重读一遍，但不产生
           块、也就不产生费用。所以判据只认"嵌入请求 0 次"，不认 N=0。 */
        const beforeCalls = eCalls;
        const reR = await win.webContents.executeJavaScript(
          'JZ.kb.reindex(' + JSON.stringify(embCfg) + ')');
        o.push('  立刻重扫 → 重读文件 ' + (reR && reR.refetched) + ' 个 · 新增块 ' + (reR && reR.changed)
          + ' · 删 ' + (reR && reR.removed) + ' · 失败 ' + (reR && reR.failed)
          + ' · 期间嵌入请求 ' + (eCalls - beforeCalls) + ' 次（必须是 0）');

        const clR = await win.webContents.executeJavaScript('JZ.kb.clear()');
        const afterR = await win.webContents.executeJavaScript('JZ.kb.state(null)');
        o.push('  清空 → ok=' + !!(clR && clR.ok)
          + ' · 清完剩 ' + ((afterR && afterR.sources) || []).length + ' 个来源（应为 0）');
      } catch (e){
        o.push('  知识库自检失败: ' + (e && (e.stack || e.message)));
      } finally {
        try { if (kbSrv) kbSrv.close(); } catch (e){ /* 退出路径上不再抛 */ }
        try { if (kbSrcDir) fs.rmSync(kbSrcDir, { recursive: true, force: true }); } catch (e){ /* */ }
      }

      /* ================= 终端 =================
         这一轮把 node-pty 引进来了 —— 一个**原生模块**，也是打包风险最高的一类：
         `.node` 没被 asarUnpack 出来、或没进 files 白名单，开发模式一切正常、
         打包后一 spawn 就 "Cannot find module"，而界面只在用户点「新建终端」
         时才炸。所以这里真起一个会话、真敲一条命令、真读回显、再真收掉。
         走渲染侧的 JZ.pty 桥 —— 跟用户点按钮是同一条路。 */
      o.push('=== 终端 ===');
      try {
        o.push('  term.js 从包里加载 = '
          + (TERM && typeof TERM.ensure === 'function' ? 'ok' : '✗ ensure 不是函数'));
        const av = TERM.available();
        o.push('  pty 可用 = ' + av.ok + (av.why ? ' · ' + av.why : ''));
        const sh = typeof TERM.whichShells === 'function' ? TERM.whichShells() : null;
        if (sh) o.push('  本机 shell = ' + Object.keys(sh)
          .map(k => sh[k].name + (sh[k].found ? '✓' : '✗')).join(' · ')
          + ' · 配置登记 ' + TERM.PROFILES.length + ' 种');

        /* onData 在渲染侧收流。界面自己那份监听不动 —— 这里只是再加一个。 */
        await win.webContents.executeJavaScript(
          'window.__jzT = "";'
          + ' window.JZ.pty.onData(function(d){ if (d && d.id === "diag") window.__jzT += (d.data || ""); }); 1');
        const en = await win.webContents.executeJavaScript(
          'window.JZ.pty.ensure("diag", { profile:"powershell", cols:100, rows:24 })');
        o.push('  经桥起会话 → ' + JSON.stringify(en));
        await new Promise(r => setTimeout(r, 2000));   /* 等 shell 把 bootstrap 跑完 */

        const MARK = 'jz-diag-' + Date.now();
        await win.webContents.executeJavaScript(
          'window.JZ.pty.input("diag", "echo ' + MARK + '\\r")');
        let raw = '';
        for (let i = 0; i < 40; i++){
          raw = await win.webContents.executeJavaScript('window.__jzT');
          if (String(raw).indexOf(MARK) >= 0) break;
          await new Promise(r => setTimeout(r, 200));
        }
        /* 回显里混着 ANSI 颜色与 OSC 序列，比对前先剥掉，否则"看到了"会被
           转义符切成两半而判成没看到。 */
        const plain = String(raw)
          .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
          .replace(/\u001b\][^\u0007]*\u0007/g, '');
        o.push('  敲一条命令 → 回显里有标记 = ' + (plain.indexOf(MARK) >= 0)
          + ' · 共收 ' + String(raw).length + ' 字符'
          + ' · 带 OSC 633 退出码 = ' + (String(raw).indexOf('\u001b]633;D;') >= 0));
        if (plain.indexOf(MARK) < 0)
          o.push('  没看到标记，回显前 240 字 = ' + JSON.stringify(plain.slice(0, 240)));
        o.push('  会话表 = ' + JSON.stringify(TERM.list()));

        await win.webContents.executeJavaScript('window.JZ.pty.kill("diag")');
        await new Promise(r => setTimeout(r, 800));
        /* 收掉之后必须真的从表里消失 —— 否则用户关掉标签只是"看不见了"，
           powershell 还在后台跑；攒几十个之后机器开始卡，而用户完全看不见。 */
        const after = TERM.list();
        o.push('  收掉后会话表 = ' + JSON.stringify(after)
          + ' · 不残留 = ' + !after.some(x => x.id === 'diag'));
      } catch (e){
        o.push('  终端自检失败: ' + (e && (e.stack || e.message)));
      } finally {
        /* 只收自己起的那一个（id 固定是 diag）。
           原来这里是 TERM.killAll() —— 那会把**渲染侧那个真实会话**一起杀掉，
           于是同一份自检报告后面出现的所有终端读数都建立在"会话已退出"上
           （bufTail 里那句 `[会话已退出 code=-1073741510]` 就是这么来的）。
           自检自己的清理不该越过界。全局兜底收尾挪到整份自检的最后。 */
        try { TERM.kill('diag'); } catch (e){ /* 退出路径上不再抛 */ }
      }

      /* ============ 终端页：进页面就把会话起起来（重启路径） ============
         这一段必须跑在**任何其它块切进终端页之前** —— 它要验的正是"还没有
         任何人碰过终端页"这个初始状态，前面那些块只要切过一次，前提就没了。

         起因就是这一轮真抓到的那个 bug（_p47 修的）：标签列表**跟存档回来**、
         进程不回来（退出时被收掉），而"起会话"只有 termAddTab 一个发起方，
         它又只在"一个标签都没有"时才被叫到。于是重启之后打开终端页 =
         标签栏 + 一大块空白，非得手动点一下标签才出会话。
         判据不是"元素在不在"，而是**真起了会话、真有输出**：
         ① 有 pane；② 缓冲区里有字节；③ 屏幕元素有实际尺寸；
         ④ .xterm-rows 里真有字（画出来了，不只是收下了）；
         ⑤ 来回切板块不重复起会话（pane 数不变）。 */
      o.push('=== 终端页：进页面就把会话起起来（重启路径）===');
      try {
        const termState = '(function(){ var pk = Object.keys(TERM_UI.pane);'
          + ' var p = pk.length ? TERM_UI.pane[pk[0]] : null;'
          + ' var xr = document.querySelector("#termMount .xterm-rows");'
          + ' var m = document.querySelector(".tz-main");'
          + ' return JSON.stringify({'
          + '  panes:pk.length, paneId:pk[0]||"(无)",'
          + '  bufLen:p ? p.buf.length : -1,'
          + '  bufTail:p ? p.buf.replace(/\\s+/g," ").slice(-70) : "",'
          + '  rows:p && p.term ? p.term.rows : -1, cols:p && p.term ? p.term.cols : -1,'
          + '  screenH:p && p.term && p.term.element ? Math.round(p.term.element.getBoundingClientRect().height) : -1,'
          + '  mainH:m ? Math.round(m.getBoundingClientRect().height) : -1,'
          + '  rowsLines:xr ? xr.children.length : -1,'
          + '  rowsTail:xr ? (xr.textContent||"").replace(/\\s+/g," ").slice(-70) : "(无 .xterm-rows)",'
          /* 提示符画出来没有，要**整屏找**，不能只看尾 70 字：
             重启后新会话会 clear + 光标归位，提示符落在第 1 行，屏幕其余部分是
             空行 —— 于是"尾 70 字"里全是空白，明明画出来了却判成没画。
             （第一版就是这么判错的：判据错了会冤枉功能。） */
          + '  rowsHasPrompt:/PS [A-Za-z]:[\\\\/]/.test(xr ? (xr.textContent||"") : ""),'
          + '  rowsChars:xr ? (xr.textContent||"").replace(/\\s+/g," ").trim().length : -1'
          + ' }); })()';
        o.push('  开始时 = ' + await win.webContents.executeJavaScript(
          '(function(){ return JSON.stringify({ panes:Object.keys(TERM_UI.pane).length,'
          + ' 存档标签数:TOOL.terms.length, 当前板块:state.page, 组件已载:!!TERM_UI.loaded,'
          + ' 能力可用:!!(TERM_UI.avail && TERM_UI.avail.ok) }); })()'));
        /* 把状态**构造**成"重启之后"，而不是指望它刚好是这样：
           termDropPane 既摘渲染侧的 pane、也杀主进程那边的会话，正好等于
           "标签还在列表里、进程没了" —— 重启后的那个状态。
           （上一版没构造，结果上一次运行里会话还活着，测的是"已经有了"，
             等于没测到那个 bug。） */
        o.push('  构造重启态（摘 pane + 杀会话，标签留在列表里）= '
          + await win.webContents.executeJavaScript(
            '(function(){ var pk = Object.keys(TERM_UI.pane);'
            + ' pk.forEach(function(k){ termDropPane(k); });'
            + ' return JSON.stringify({ panes:Object.keys(TERM_UI.pane).length, 标签数:TOOL.terms.length }); })()'));
        await win.webContents.executeJavaScript('switchPage("folders")');
        await new Promise(r => setTimeout(r, 600));
        await win.webContents.executeJavaScript('switchPage("term")');
        await new Promise(r => setTimeout(r, 2600));
        const t1 = JSON.parse(await win.webContents.executeJavaScript(termState));
        o.push('  进页面后 = ' + JSON.stringify(t1));
        await win.webContents.executeJavaScript('switchPage("folders")');
        await new Promise(r => setTimeout(r, 700));
        await win.webContents.executeJavaScript('switchPage("term")');
        await new Promise(r => setTimeout(r, 1200));
        const t2 = JSON.parse(await win.webContents.executeJavaScript(termState));
        o.push('  切走再切回 = ' + JSON.stringify({ panes:t2.panes, bufLen:t2.bufLen }));
        o.push('  ↑ 期望：进页面后 panes ≥ 1（重启路径没人发起会话就是 0 —— 就是那个 bug）'
          + ' · bufLen 明显大于 0（真收到过 Shell 的输出）'
          + ' · rows/cols 都是正数且 screenH/mainH 有实际高度（xterm 量得出尺寸才会画）'
          + ' · rowsLines > 1（.xterm-rows 里有行）'
          + ' · 切走再切回 panes 不变（没有重复起会话）');
        /* 这一段**不判"画出来了没有"**：此刻窗口还是收起的，而 xterm 的
           fit / 重绘挂在 requestAnimationFrame 上，Chromium 对隐藏窗口会把它
           停掉 —— 于是一屏 0 字符。那是"没机会画"，不是"画不出来"。
           真正该问的是"窗口明明开着的时候，终端里有没有字"，那一条放在
           截图那一段（那里窗口一定是可见的）判，见 _desk_term.png 之后。 */
        o.push('  判定 进页面真起了会话 = '
          + ((t1.panes >= 1 && t1.bufLen > 0 && t1.rows > 0 && t1.cols > 0 && t1.rowsLines > 0) ? '是' : '★ 否')
          + ' · 来回切没有重复起会话 = ' + (t2.panes === t1.panes ? '是' : '★ 否（' + t1.panes + ' → ' + t2.panes + '）')
          + ' · 此刻 rowsChars = ' + t1.rowsChars + '（窗口还收着，rAF 被停，这里不判画没画）');
      } catch (e){ o.push('  终端页路径自检失败: ' + (e && (e.stack || e.message))); }

      /* ================= 只挂在 DESK 上的那几个控件 =================
         浏览器原型里它们永远不渲染 —— 也就永远没人会发现"没建出来"。
         这里逐个点名，包括那个一直没人调用的 JZ.quit 现在有没有调用方。 */
      o.push('=== 桌面版专有入口 ===');
      try {
        const deskOnly = await win.webContents.executeJavaScript(
          '(function(){ var o = {};'
          + ' if (state.query) exitSearch(false);'
          + ' switchPage("settings");'
          + ' var q = document.querySelector(\'[data-act="app-quit"]\');'
          + ' o.quit = !!q;'
          + ' o.quitShown = q ? (getComputedStyle(q).display !== "none") : "-";'
          + ' o.quitText = q ? q.textContent.trim() : "(没建出来)";'
          + ' switchPage("ask");'
          + ' o.kbActs = document.querySelectorAll(\'[data-act^="kb-"]\').length;'
          /* 判据必须是**那句话本身**，不能是"有没有 .kb-note" —— DESK 下底部
             那条统计说明用的也是 .kb-note，于是"没有 .kb-note"会永远为假。
             按元素存在与否去推文案，是这一轮又踩过一次的老坑。 */
          + ' var askBody = document.querySelector(\'#track .page[data-page="ask"] .page-body\');'
          + ' o.askPageText = askBody ? askBody.textContent : "";'
          + ' o.saysBrowserOnly = (o.askPageText.indexOf("知识库要桌面版") >= 0);'
          + ' o.kbSrcRows = document.querySelectorAll(".kb-src").length;'
          + ' delete o.askPageText;'
          + ' o.desk = DESK;'
          + ' o.quitOnBridge = typeof (window.JZ && JZ.quit);'
          + ' return JSON.stringify(o); })()');
        o.push('  ' + deskOnly);
        o.push('  ↑ kbActs 应是 5（还没有来源时不含「清空知识库」）· saysBrowserOnly 应是 false'
          + '（"知识库要桌面版"那句在 DESK 下不该出现）· quit 与 quitOnBridge 都要有');
      } catch (e){ o.push('  桌面专有入口自检失败: ' + (e && e.message)); }

      /* ============ 这一轮改动点名（模型名单 / 终端高度 / ⓘ / 更多） ============
         三件事都"只有真机才看得见"，浏览器侧的 _probe29 覆盖不到：
           ① 「拉取可用模型」按钮**只在 DESK 渲染** —— 浏览器原型里这个按钮
              压根不存在，所以"它没建出来"这件事在浏览器里永远看不出来；
           ② 终端页的高度是 flex 算出来的，只有真有版面引擎量了才算数。
              上一版写死 clamp(240px,44vh,540px)，用户说的"主功能界面被挤压"
              就是这么来的 —— 所以这里量的是**比例**，不是一个绝对像素；
           ③ 页头 ⓘ 与「更多」浮层是两个新入口，撤掉的四个动作按钮 + 一面
              预设墙全靠它们活着。终端页的页头**只剩 ⓘ 一个按钮**（原来那个 +
              与标签栏的「新建」是同一个动作，按"不摆重复入口"撤掉了）。 */
      o.push('=== 这一轮改动点名（模型名单 / 终端高度 / ⓘ / 更多）===');
      try {
        const round = await win.webContents.executeJavaScript(
          '(function(){ var o = {};'
          + ' if (state.query) exitSearch(false);'
          + ' switchPage("settings");'
          + ' var am = document.querySelector(\'[data-act="ai-models"]\');'
          + ' o.aiModels = !!am;'
          + ' o.aiModelsShown = am ? (getComputedStyle(am).display !== "none") : "-";'
          + ' o.provider = (state.settings.ai || {}).provider || "(未设)";'
          + ' var row = document.querySelector(".ai-mrow");'
          + ' o.chips = document.querySelectorAll(".ai-mchip").length;'
          + ' o.hint = !!document.querySelector(".ai-mhint");'
          + ' o.warn = !!document.querySelector(".ai-mwarn");'
          + ' switchPage("term");'
          + ' o.infoBtn = !!document.querySelector(\'[data-act="ph-info"]\');'
          + ' o.headBtns = document.querySelectorAll(\'#track .page[data-page="term"] .phero-tools button\').length;'
          + ' o.plusInHead = !!document.querySelector(\'#track .page[data-page="term"] .phero-tools [data-act="term-new"]\');'
          + ' o.newInBar = !!document.querySelector(\'.tz-bar [data-act="term-new"]\');'
          + ' o.flexterm = !!document.querySelector(\'#track .page[data-page="term"] .page-body.flexterm\');'
          + ' var m = document.querySelector(".tz-main");'
          + ' var b = document.querySelector(\'#track .page[data-page="term"] .page-body\');'
          + ' o.mainH = m ? Math.round(m.getBoundingClientRect().height) : -1;'
          + ' o.bodyH = b ? Math.round(b.getBoundingClientRect().height) : -1;'
          + ' o.ratio = (b && b.getBoundingClientRect().height)'
          + '   ? (m.getBoundingClientRect().height / b.getBoundingClientRect().height).toFixed(2) : "-";'
          + ' o.wall = document.querySelectorAll(\'.page[data-page="term"] .tz-p\').length;'
          + ' o.acts = !!document.querySelector(\'.page[data-page="term"] .tz-acts\');'
          + ' o.foot = !!document.querySelector("#termFoot");'
          + ' o.note = !!document.querySelector(\'.page[data-page="term"] .tz-note\');'
          + ' o.moreBtn = !!document.querySelector(\'[data-act="term-more"]\');'
          + ' o.xterm = document.querySelectorAll("#termMount .xterm").length;'
          + ' o.panes = Object.keys(TERM_UI.pane).length;'
          /* 终端**真的画出字来了吗**。
             起因：这一轮把 .tz-main 从写死高度改成 flex:1 之后截图，终端区是
             一整块空底色 —— 分不清是"还没打印"还是"fit 在布局定下来之前跑过、
             把行列算成 0 了"。截图看不出原因，所以这里把事实摊开：
             缓冲区里有多少字节、xterm 自己的 rows/cols、屏幕元素实际多高、
             .xterm-rows 里到底有没有字符。 */
          + ' var pk = Object.keys(TERM_UI.pane);'
          + ' var pp = pk.length ? TERM_UI.pane[pk[0]] : null;'
          + ' o.paneId = pk[0] || "(无)";'
          + ' o.bufLen = pp && pp.buf ? pp.buf.length : -1;'
          + ' o.bufTail = pp && pp.buf ? pp.buf.replace(/\\s+/g, " ").slice(-80) : "";'
          + ' o.rows = pp && pp.term ? pp.term.rows : -1;'
          + ' o.cols = pp && pp.term ? pp.term.cols : -1;'
          + ' o.screenH = pp && pp.term && pp.term.element'
          + '   ? Math.round(pp.term.element.getBoundingClientRect().height) : -1;'
          + ' o.screenW = pp && pp.term && pp.term.element'
          + '   ? Math.round(pp.term.element.getBoundingClientRect().width) : -1;'
          + ' var host = document.querySelector(".tz-host");'
          + ' o.hostH = host ? Math.round(host.getBoundingClientRect().height) : -1;'
          + ' var xr = document.querySelector("#termMount .xterm-rows");'
          + ' o.rowsLines = xr ? xr.children.length : -1;'
          + ' o.rowsTail = xr ? (xr.textContent || "").replace(/\\s+/g, " ").slice(-80) : "(无 .xterm-rows)";'
          + ' switchPage("folders");'
          + ' var other = document.querySelector(\'.page[data-page="folders"] .page-body\');'
          + ' o.otherFlex = !!(other && other.classList.contains("flexterm"));'
          + ' return JSON.stringify(o); })()');
        o.push('  ' + round);
        o.push('  ↑ 期望：aiModels/aiModelsShown 都 true · 名单行非空（chips ≥ 1 或 hint）'
          + ' · infoBtn true · headBtns 1 且 plusInHead false（页头那个 + 已撤）· newInBar true'
          + '（标签栏的「新建」才是入口，别两个都撤）'
          + ' · flexterm true 且 ratio > 0.55（主功能拿满剩余高度）'
          + ' · wall 0 · acts false · foot false · note false · moreBtn true'
          + ' · otherFlex false（flexterm 不许漏到别的页）');
        o.push('  ↑ 名单是**常驻**的：chips 0 只允许出现在"这家没有候选名单"时，'
          + '那时必须同时有 hint 那行字 —— 空行是 bug（用户就是因为名单不在手边才把两个名字敲成一个词）。');
      } catch (e){ o.push('  本轮改动点名自检失败: ' + (e && e.message)); }

      o.push('=== 运行期异常 ===');
      o.push(PAGE_ERRORS.length ? PAGE_ERRORS.join('\n  ') : '  无');
      /* 页内异常（比如某个 build 函数抛错）不会走 console-message，
         挂一个临时监听把之后发生的接住。 */
      await win.webContents.executeJavaScript(
        'window.__jzErr = []; window.addEventListener("error", e => window.__jzErr.push(String(e.message)));' +
        'window.addEventListener("unhandledrejection", e => window.__jzErr.push("reject: " + String(e.reason && e.reason.message || e.reason)));'
      );
      await win.webContents.executeJavaScript('(function(){ var o=[]; try{ refresh([state.page]); }catch(e){ o.push(String(e.message)); } window.__jzErr = window.__jzErr.concat(o); return 1; })()');
      await new Promise(r => setTimeout(r, 400));
      const pe = await win.webContents.executeJavaScript('(window.__jzErr || []).join(" | ") || "无"');
      o.push('  页内异常 = ' + pe);
    } catch (e){ o.push('自检抛错: ' + (e && (e.stack || e.message))); }
    /* 输出到 userData 而不是 __dirname：打包后代码在 app.asar 里，写不进去。
       放这里开发模式和便携版都能跑到同一份。 */
    /* 会话的全局兜底收尾放在整份自检的最后。
       终端那一段自己的清理只收它起的 diag 会话（中途 killAll 会把渲染侧
       那个真实会话一起带走，后面所有终端读数就都建立在"会话已退出"上了）。 */
    try { TERM.killAll(); } catch (e){ /* 退出路径上不再抛 */ }
    diagWrite(o.join('\n'));
    app.exit(0);
  });
}

/* 占位：主进程侧也要能从存档里数一数，用它验证 readStore 的形状 */
function DATA_NOW(){ return Date.now(); }
