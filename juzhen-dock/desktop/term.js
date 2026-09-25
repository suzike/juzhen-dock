/* ============================================================
   聚珍 · 真终端（ConPTY 会话管理）
   ------------------------------------------------------------
   为什么单独一个文件：和 ai.js 同一个理由 —— main.js 一开头就
   require('electron')，普通 node 进程跑不起来，于是"会话到底有没有真起来"
   就只能靠开窗口、点一下、用肉眼看。摘出来之后可以直接起 node 喂它。

   与 agentic-island（同为 Electron + node-pty）的实现取舍：
     · 保留"PowerShell prompt 包装 → OSC 633;D;<退出码>"这一手。它是**唯一**
       干净的退出码来源：PowerShell 的 $LASTEXITCODE 在交互会话里没有别的
       外部读法，而解析输出文本猜退出码只会在报错时骗人。
     · 保留"会话退出后保留元数据、下一次输入自动重启"——否则用户敲到一半
       命令把 shell 弄退了，再敲字会静默落到"默认 powershell + 主目录"，
       和刚才那个会话不是一回事，而界面看不出来。
     · 去掉 agentic-island 的 workspace 快照导入导出：那一套在聚珍里由
       存档（store.json）统一承担，再开一套文件格式只会让"备份"有两个入口。
   ============================================================ */

let pty = null, loadErr = '';
try {
  pty = require('@lydell/node-pty');
} catch (e) {
  loadErr = String((e && e.message) || e);
}

/* 可用性如实上报。加载失败不是"应该不会发生"——它是一等公民状态：
   界面要据此显示真实原因，而不是给一个点了没反应的按钮。 */
function available(){
  if (pty && typeof pty.spawn === 'function') return { ok: true, why: '' };
  return { ok: false, why: loadErr
    ? ('终端原生模块没加载起来：' + loadErr)
    : '终端原生模块没有导出 spawn' };
}

/* PowerShell 启动引导。三件事，顺序不能换：
   1) 把控制台输入/输出编码设成 UTF-8 —— 中文路径和中文回显才不会花；
   2) 存下原有 prompt；
   3) 换一个 prompt：先取上一条命令的成败，再用 OSC 633;D;<code> 把退出码
      写进输出流（BEL 结束，这是 VS Code / Windows Terminal 都在用的约定），
      最后才调用原 prompt。
   之所以要"先算码再画提示符"：$? 和 $LASTEXITCODE 在下一条命令执行后就没了。 */
const POWERSHELL_BOOTSTRAP =
  '[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();' +
  '$OutputEncoding=[Console]::OutputEncoding;' +
  '$global:__JZPrompt=(Get-Item Function:\\prompt -ErrorAction SilentlyContinue).ScriptBlock;' +
  'function global:prompt{' +
    '$__ok=$?;$__native=$global:LASTEXITCODE;' +
    '$__code=if($__ok){0}elseif($__native -is [int] -and $__native -ne 0){$__native}else{1};' +
    '[Console]::Write(([char]27)+"]633;D;$__code"+([char]7));' +
    'if($global:__JZPrompt){&$global:__JZPrompt}else{"PS $($executionContext.SessionState.Path.CurrentLocation)> "}' +
  '}';

/* 四种 shell。wsl 不加参数：加 -d 就得先知道用户装了哪个发行版，
   猜错会报一句让人困惑的错。让它自己选默认发行版。 */
const PROFILES = [
  { id:'powershell', name:'Windows PowerShell', file:'powershell.exe',
    args:['-NoLogo', '-NoExit', '-Command', POWERSHELL_BOOTSTRAP] },
  { id:'pwsh',       name:'PowerShell 7 (pwsh)', file:'pwsh.exe',
    args:['-NoLogo', '-NoExit', '-Command', POWERSHELL_BOOTSTRAP] },
  { id:'cmd',        name:'命令提示符 (cmd)', file:'cmd.exe', args:['/Q'] },
  { id:'wsl',        name:'WSL', file:'wsl.exe', args:[] }
];
const PROFILE_MAP = {};
PROFILES.forEach(p => { PROFILE_MAP[p.id] = p; });

function profileOf(id){ return PROFILE_MAP[id] || PROFILE_MAP.powershell; }

const MIN_COLS = 20, MIN_ROWS = 5, DEF_COLS = 100, DEF_ROWS = 28;
function normSize(cols, rows){
  const c = Number(cols), r = Number(rows);
  return {
    cols: Math.max(MIN_COLS, isFinite(c) ? Math.round(c) : DEF_COLS),
    rows: Math.max(MIN_ROWS, isFinite(r) ? Math.round(r) : DEF_ROWS)
  };
}

/* id → { p, cols, rows, meta }；meta 在会话退出后**故意保留** */
const S = new Map();
let sink = null, exitSink = null;

function setSink(fn){ sink = fn; }
function setExitSink(fn){ exitSink = fn; }
function emit(id, data){ try { if (sink) sink(id, data); } catch (e) { /* 界面没了，会话不该跟着崩 */ } }

function ensure(id, opts){
  const av = available();
  if (!av.ok) return { ok: false, error: av.why };

  const o = opts || {};
  const size = normSize(o.cols, o.rows);
  const key = String(id || '').trim() || 'term';
  const cur = S.get(key);
  if (cur && cur.p){
    resize(key, size.cols, size.rows);
    return { ok: true, cols: size.cols, rows: size.rows, reused: true };
  }

  const prof = profileOf(o.profile);
  const fs = require('fs');
  let cwd = String(o.cwd || '');
  try { if (!cwd || !fs.statSync(cwd).isDirectory()) cwd = require('os').homedir(); }
  catch (e){ cwd = require('os').homedir(); }

  let child;
  try {
    child = pty.spawn(prof.file, prof.args, {
      name: 'xterm-256color',
      cols: size.cols, rows: size.rows,
      cwd: cwd,
      /* PYTHONUTF8：Windows 上 Python 默认按 GBK 写 stdout，
         在 UTF-8 的终端里就是乱码。这一条是实测踩出来的。 */
      env: Object.assign({}, process.env, o.env || {}, { TERM: 'xterm-256color', PYTHONUTF8: '1' }),
      useConpty: true
    });
  } catch (e) {
    /* 起不来要说是哪个 shell 起不来 —— pwsh 没装是很常见的情况，
       报一句"终端启动失败"用户根本不知道去装什么。 */
    return { ok: false, error: prof.name + ' 起不来：' + String((e && e.message) || e) };
  }

  S.set(key, { p: child, cols: size.cols, rows: size.rows,
    meta: { profile: prof.id, cwd: cwd } });

  child.onData(d => emit(key, d));
  child.onExit(e => {
    const code = e && typeof e.exitCode === 'number' ? e.exitCode : null;
    if (S.get(key) && S.get(key).p === child) S.get(key).p = null;
    emit(key, '\r\n\x1b[90m[会话已退出' + (code === null ? '' : ' code=' + code)
      + '，敲任意键自动重开一个同配置的会话]\x1b[0m\r\n');
    try { if (exitSink) exitSink(key, code); } catch (err) { /* */ }
  });

  return { ok: true, cols: size.cols, rows: size.rows, reused: false };
}

function input(id, data){
  const key = String(id || '');
  const s = S.get(key);
  if (!s) return { ok: false, error: '这个标签还没有会话' };
  if (!s.p){
    /* 退出后重开：带上原来的 profile/cwd。 */
    const r = ensure(key, { cols: s.cols, rows: s.rows,
      profile: s.meta && s.meta.profile, cwd: s.meta && s.meta.cwd });
    if (!r.ok) return r;
  }
  const cur = S.get(key);
  try { cur.p.write(String(data == null ? '' : data)); return { ok: true }; }
  catch (e){ return { ok: false, error: String((e && e.message) || e) }; }
}

function resize(id, cols, rows){
  const s = S.get(String(id || ''));
  if (!s || !s.p) return { ok: false, error: '这个标签还没有会话' };
  const size = normSize(cols, rows);
  if (s.cols === size.cols && s.rows === size.rows) return { ok: true, same: true };
  try { s.p.resize(size.cols, size.rows); s.cols = size.cols; s.rows = size.rows; return { ok: true }; }
  catch (e){ return { ok: false, error: String((e && e.message) || e) }; }
}

function kill(id){
  const key = String(id || '');
  const s = S.get(key);
  if (!s) return { ok: true };
  try { if (s.p) s.p.kill(); } catch (e) { /* 已经死了就是我们要的结果 */ }
  S.delete(key);
  return { ok: true };
}

function killAll(){
  for (const k of Array.from(S.keys())) kill(k);
  return { ok: true };
}

function list(){
  return Array.from(S.keys()).map(k => ({ id: k, alive: !!(S.get(k) && S.get(k).p) }));
}

module.exports = {
  available: available, ensure: ensure, input: input, resize: resize,
  kill: kill, killAll: killAll, list: list,
  setSink: setSink, setExitSink: setExitSink,
  PROFILES: PROFILES, profileOf: profileOf, POWERSHELL_BOOTSTRAP: POWERSHELL_BOOTSTRAP,
  /* 下面几个是给自检用的：能把"装了哪些 shell"一次性问出来，
     界面才好如实标注"本机没有 pwsh"，而不是等用户点了才报错。 */
  whichShells: function(){
    const fs = require('fs'), path = require('path');
    const out = {};
    const roots = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    PROFILES.forEach(p => {
      out[p.id] = { name: p.name, file: p.file, found: false };
      for (const r of roots) {
        try { if (fs.existsSync(path.join(r, p.file))) { out[p.id].found = true; break; } }
        catch (e) { /* */ }
      }
    });
    /* System32 里必然有 powershell.exe / cmd.exe，但 PATH 被裁剪过时
       上面的扫法会漏，所以对这两个补一次绝对路径判断。 */
    const sys = process.env.SystemRoot || 'C:\\Windows';
    [['powershell','powershell.exe'], ['cmd','cmd.exe']].forEach(([id, f]) => {
      if (!out[id].found){ try { if (fs.existsSync(path.join(sys, 'System32', f))) out[id].found = true; } catch (e) { /* */ } }
    });
    return out;
  }
};
