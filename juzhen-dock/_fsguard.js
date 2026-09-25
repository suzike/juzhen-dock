/* 验证"父进程没了就自己退出"这道保险真的有效。
   做法：用 main.js 里那份 PS_SRC 原样跑起来，但传一个不存在的父进程 PID。
   脚本应该在约 10 秒内（每 40 拍 × 250ms 检查一次）自己 break 掉。
   这道保险不是锦上添花：Electron 的 app.exit() 不触发 will-quit，
   进程被强杀更不会 —— 没有它，异常退出会在用户机器上留一个空转到天荒地老的进程。 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const dir = __dirname;
const tmp = path.join(require('os').tmpdir(), 'jz-fs-guard');
fs.mkdirSync(tmp, { recursive: true });

const src = fs.readFileSync(path.join(dir, 'desktop', 'main.js'), 'utf8');
const m = src.match(/const PS_SRC = \[([\s\S]*?)\n\];/);
if (!m){ console.log('FAIL: 没找到 PS_SRC'); process.exit(1); }
const PS_SRC = eval('[' + m[1] + ']');
const ps = path.join(tmp, 'watch.ps1');
fs.writeFileSync(ps, '\uFEFF' + PS_SRC.join('\r\n'), 'utf8');

const FAKE_PID = '999998';           // 基本不可能存在的 PID
const t0 = Date.now();
const p = spawn('powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps, FAKE_PID],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

let readings = 0, buf = '', stderr = '';
p.stdout.setEncoding('utf8');
p.stdout.on('data', c => {
  buf += c;
  const ls = buf.split(/\r?\n/); buf = ls.pop();
  readings += ls.filter(l => l.trim() === '0' || l.trim() === '1').length;
});
p.stderr.on('data', c => { stderr += c; });

const timer = setTimeout(() => {
  console.log('FAIL: 20 秒还没退出 —— 孤儿会一直空转');
  try { p.kill(); } catch (e){}
  process.exit(1);
}, 20000);

p.on('exit', code => {
  clearTimeout(timer);
  const dt = Date.now() - t0;
  console.log('已退出 · 用时 ' + dt + ' ms · 退出码 ' + code + ' · 期间产出读数 ' + readings + ' 个');
  console.log('判定：' + (dt < 16000
    ? '通过 —— 父进程不存在时脚本会自己收工'
    : '可疑 —— 用时偏长，检查检查间隔'));
  if (stderr.trim()) console.log('stderr: ' + stderr.replace(/\s+/g, ' ').slice(0, 300));
});
