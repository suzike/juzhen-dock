/* 全屏判定的直接验证（第三版）。
   取 PS_SRC 里"声明块 + $skip + Get-JzFull()"这一整段原样搬过来用，
   然后拿几个真实窗口句柄喂进去。测的就是上线要跑的那份逻辑本身。

   四个用例：
     A 当前前台窗口          → 期望 0（普通窗口不该触发屏蔽）
     B 最大化窗口            → 期望 0（只盖工作区，含任务栏那一条）
     C 无边框铺满整屏的窗口  → 期望 1（真全屏）
     D 关掉之后的前台        → 期望 0（回到桌面不能继续屏蔽）
   B 和 C 是这次的重点：第一版在这两个上都判错，
   原因是 DPI 虚拟化让两个坐标系混在一起比了。 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const dir = __dirname;
const tmp = path.join(require('os').tmpdir(), 'jz-fs-test3');
fs.mkdirSync(tmp, { recursive: true });

const src = fs.readFileSync(path.join(dir, 'desktop', 'main.js'), 'utf8');
const m = src.match(/const PS_SRC = \[([\s\S]*?)\n\];/);
if (!m){ console.log('FAIL: 没找到 PS_SRC'); process.exit(1); }
const PS_SRC = eval('[' + m[1] + ']');

/* 声明块 + 判定函数 = 到 '$out = [Console]::Out' 之前为止 */
const cut = PS_SRC.findIndex(l => l === '$out = [Console]::Out');
if (cut < 0){ console.log('FAIL: 没找到循环起点'); process.exit(1); }
const core = PS_SRC.slice(0, cut).join('\r\n');
console.log('复用 main.js 的 ' + cut + ' 行（声明块 + $skip + Get-JzFull）');

const probe = path.join(tmp, 'probe.ps1');
const body = [
  'Add-Type -AssemblyName System.Windows.Forms',
  'function Show-Diag($h, $label) {',
  '  $sb = New-Object System.Text.StringBuilder 128',
  '  [void][JZfg]::GetClassName($h, $sb, 128)',
  '  $r = [JZfg+RECT]::new()',
  '  $hr = [JZfg]::DwmGetWindowAttribute($h, 9, [ref]$r, 16)',
  '  $byDwm = ($hr -eq 0)',
  '  if (-not $byDwm) { [void][JZfg]::GetWindowRect($h, [ref]$r) }',
  '  $mi = [JZfg+MONITORINFO]::new(); $mi.cbSize = 40',
  '  [void][JZfg]::GetMonitorInfo([JZfg]::MonitorFromWindow($h, 2), [ref]$mi)',
  '  $mw = $mi.rcMonitor.R - $mi.rcMonitor.L; $mh = $mi.rcMonitor.B - $mi.rcMonitor.T',
  '  $aw = $mi.rcWork.R - $mi.rcWork.L; $ah = $mi.rcWork.B - $mi.rcWork.T',
  '  $w = $r.R - $r.L; $ht = $r.B - $r.T',
  '  $st = [JZfg]::GetWindowLong($h, -16)',
  "  Write-Output ('    [' + \$label + '] cls=' + \$sb.ToString() + ' caption=' + \$(if((\$st -band 0x00C00000) -eq 0x00C00000){'yes'}else{'no'}) + ' bounds=' + \$w + 'x' + \$ht + ' via=' + \$(if(\$byDwm){'DWM'}else{'GWR'}) + ' monitor=' + \$mw + 'x' + \$mh + ' work=' + \$aw + 'x' + \$ah)",
  '}',
  'Write-Output ("    [dpi] SetProcessDPIAware -> " + [JZfg]::SetProcessDPIAware())',
  'Write-Output ("    [dpi] already aware(二次调用返回 False 表示已生效) = " + [JZfg]::SetProcessDPIAware())',
  "$res = @()",
  'Write-Output "=== A / foreground now (expect 0) ==="',
  '$hA = [JZfg]::GetForegroundWindow()',
  'Show-Diag $hA "A"',
  "$res += 'A=' + (Get-JzFull \$hA)",
  '',
  'Write-Output "=== B / maximized form (expect 0) ==="',
  '$a = New-Object System.Windows.Forms.Form',
  "$a.Text = 'JZ Maximized'",
  '$a.WindowState = "Maximized"',
  '$a.Show(); $a.Activate()',
  'Start-Sleep -Milliseconds 900',
  'Show-Diag $a.Handle "B"',
  "$res += 'B=' + (Get-JzFull \$a.Handle)",
  '$a.Close(); Start-Sleep -Milliseconds 400',
  '',
  'Write-Output "=== C / borderless full-screen form (expect 1) ==="',
  '$b = New-Object System.Windows.Forms.Form',
  "$b.Text = 'JZ Fullscreen'",
  "$b.FormBorderStyle = 'None'",
  '$b.Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
  '$b.TopMost = $true',
  '$b.Show(); $b.Activate()',
  'Start-Sleep -Milliseconds 900',
  'Show-Diag $b.Handle "C"',
  "$res += 'C=' + (Get-JzFull \$b.Handle)",
  "$res += 'C-foreground=' + (Get-JzFull ([JZfg]::GetForegroundWindow()))",
  '$b.Close(); Start-Sleep -Milliseconds 600',
  '',
  'Write-Output "=== D / foreground after close (expect 0) ==="',
  '$hD = [JZfg]::GetForegroundWindow()',
  'Show-Diag $hD "D"',
  "$res += 'D=' + (Get-JzFull \$hD)",
  '',
  'Write-Output "=== RESULT ==="',
  'Write-Output ($res -join "  ")'
];
/* BOM 必须有：PowerShell 5.1 无 BOM 时按 GBK 解码 .ps1 */
fs.writeFileSync(probe, '\uFEFF' + core + '\r\n' + body.join('\r\n'), 'utf8');

const p = spawn('powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
p.stdout.setEncoding('utf8');
let out = '', err = '';
p.stdout.on('data', c => { out += c; });
p.stderr.on('data', c => { err += c; });
p.on('exit', () => {
  console.log(out.replace(/\r/g, '').trim());
  if (err.trim()) console.log('--- stderr ---\n' + err.replace(/\r/g, '').trim().slice(0, 1000));
});
