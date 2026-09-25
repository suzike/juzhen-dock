/* 全屏探测的独立验证。
   直接复用 main.js 里那份 PS_SRC（从源码文本里抠出来再 eval），
   目的是验"真东西"，而不是验一份手抄版本 —— 手抄的副本永远会跟源码走散。

   两件事必须同时成立：
     1. 平时（桌面/普通窗口在前台）必须报 0。报 1 就是灾难：热区被永久屏蔽，
        面板再也唤不出来。
     2. 真有一个盖满整屏的无边框窗口时，必须报 1。
   缺任何一条，这个功能都不能上。 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const dir = __dirname;
const tmp = path.join(require('os').tmpdir(), 'jz-fs-test');
fs.mkdirSync(tmp, { recursive: true });

/* ---- 1. 从 main.js 抠出 PS_SRC ---- */
const src = fs.readFileSync(path.join(dir, 'desktop', 'main.js'), 'utf8');
const m = src.match(/const PS_SRC = \[([\s\S]*?)\n\];/);
if (!m){ console.log('FAIL: 没找到 PS_SRC'); process.exit(1); }
const PS_SRC = eval('[' + m[1] + ']');
const watch = path.join(tmp, 'watch.ps1');
fs.writeFileSync(watch, PS_SRC.join('\r\n'), 'utf8');
console.log('PS_SRC 行数 = ' + PS_SRC.length);

/* ---- 2. 造一个铺满主屏的无边框窗口，保持 2.5 秒 ---- */
const form = path.join(tmp, 'form.ps1');
fs.writeFileSync(form, [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$f = New-Object System.Windows.Forms.Form',
  "$f.Text = 'JZ Fullscreen Probe'",
  "$f.FormBorderStyle = 'None'",
  '$f.Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
  '$f.TopMost = $true',
  '$f.Show()',
  '$f.Activate()',
  '$f.Focus()',
  'Start-Sleep -Milliseconds 2600',
  '$f.Close()'
].join('\r\n'), 'utf8');

/* ---- 3. 起 watcher，记录带时间戳的读数 ---- */
const t0 = Date.now();
const p = spawn('powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', watch],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
p.stdout.setEncoding('utf8');

const rows = [];       // {t, v}
let buf = '';
p.stdout.on('data', c => {
  buf += c;
  const ls = buf.split(/\r?\n/); buf = ls.pop();
  ls.forEach(ln => {
    const t = ln.trim();
    if (t === '0' || t === '1') rows.push({ t: Date.now() - t0, v: t });
  });
});
let err = '';
p.stderr.on('data', d => { err += d; });

setTimeout(() => {                       // 等 watcher 把 Add-Type 编译完、稳定报数
  console.log('基线读数（应全为 0）= ' + rows.map(r => r.v).join('') || '(无读数)');
  console.log('--- 打开全屏窗口 ---');
  spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', form],
    { windowsHide: true, stdio: 'ignore' });
}, 1800);

setTimeout(() => {
  try { p.kill(); } catch (e){}
  const seq = rows.map(r => r.v).join('');
  const ones = rows.filter(r => r.v === '1').length;
  const zeros = rows.filter(r => r.v === '0').length;
  console.log('=== 全部读数（时间 ms : 值）===');
  console.log(rows.map(r => r.t + ':' + r.v).join('  '));
  console.log('序列 = ' + seq);
  console.log('0 的个数 = ' + zeros + ' · 1 的个数 = ' + ones);
  /* 期望形状：先一串 0，中间一串 1，最后回到 0 */
  const first1 = seq.indexOf('1'), last1 = seq.lastIndexOf('1');
  const okBase = first1 > 0 && seq.slice(0, first1).indexOf('1') < 0;
  const okBack = last1 >= 0 && seq.slice(last1 + 1).indexOf('1') < 0;
  console.log('判定：');
  console.log('  平时报 0（无假阳性）= ' + (first1 > 0 ? '是（' + first1 + ' 个前导 0）' : '否！！'));
  console.log('  全屏时报 1         = ' + (ones > 0 ? '是（' + ones + ' 个读数）' : '否！！'));
  console.log('  关掉后回到 0       = ' + (okBack ? '是' : '否！！'));
  console.log('  前导全 0           = ' + (okBase ? '是' : '否！！'));
  if (err.trim()) console.log('stderr: ' + err.replace(/\s+/g, ' ').slice(0, 400));
}, 6200);
