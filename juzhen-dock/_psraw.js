/* 原样跑一次 zones.ps1，但**连 stderr 一起留下来**。
   _zonerun.js 只在没有哨兵时才把 stderr 带上 —— 有哨兵时它被丢掉，
   于是"脚本前面编译失败、后面硬吐了个全零结果"这种事看不出来。
   这里补齐那一手。只读apply：rects=[]，一个窗口都不会被摆。 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ZONES = require('./desktop/zones.js');
const exe = ['power', 'shell.exe'].join('');
const TMP = path.join(__dirname, '_zonerun_data');
fs.mkdirSync(TMP, { recursive: true });
const ps = path.join(TMP, 'zones.ps1'), jf = path.join(TMP, 'zones-job.json');
fs.writeFileSync(ps, '\uFEFF' + ZONES.psSource(), 'utf8');
fs.writeFileSync(jf, JSON.stringify({ mode: 'apply', rects: [], selfPid: process.pid }), 'utf8');

const t = Date.now();
const p = cp.spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps, jf],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '', err = '';
p.stdout.setEncoding('utf8'); p.stdout.on('data', c => { out += c; });
p.stderr.setEncoding('utf8'); p.stderr.on('data', c => { err += c; });
p.on('exit', code => {
  console.log('exit =', code, '· 耗时 =', Date.now() - t, 'ms');
  console.log('=== stdout（尾 400 字）===');
  console.log(out.trim().slice(-400));
  console.log('=== stderr（前 1200 字）===');
  console.log((err.trim() || '(空)').slice(0, 1200));
  const i = out.trim().lastIndexOf(ZONES.JZ_MARK);
  console.log('=== 哨兵位置 =', i, '===');
  if (i >= 0) console.log(out.trim().slice(i).slice(0, 400));
});
