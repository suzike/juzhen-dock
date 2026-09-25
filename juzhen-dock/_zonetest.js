/* ============================================================
   窗口分区 · 纯函数单元测试

   动别人的窗口这件事没法在自检里"真跑一遍"（那会真的挪走你正在看的
   窗口），所以判据必须落在**能测的那一半**上：可用区域怎么算、矩形怎么切。
   两个都是纯函数，这里拿真实的屏宽喂进去，验六件事：
     1. freeArea：面板贴右 / 贴左，剩余区域算得对不对
     2. 块数对不对（split2 / split3 / quad）
     3. 不重叠、不越界、不压到面板
     4. 窄屏要退化成一块并带 degraded 标志（而不是切出一条 209px 的细缝）
     5. 边界：零宽 / 负坐标副屏 / 极矮屏，不能算出 NaN 或负数
     6. PowerShell 那半段能被 PowerShell 真的解析（Node 看不见它，
        它只是一串拼起来的字符串 —— 拼错引号要到用户点按钮才炸）

   用法：node _zonetest.js
   ============================================================ */
const Z = require('./desktop/zones.js');

let bad = 0, n = 0;
function ok(cond, what, extra){
  n++;
  if (cond) console.log('  ✓ ' + what);
  else { bad++; console.log('  ✗ ' + what + (extra ? '   → ' + extra : '')); }
}

const PANEL_W = 580, PAD = 12;
const area = (wa, edge) => Z.freeArea(wa, edge, PANEL_W, PAD);

/* ---------- 通用不变量 ---------- */
function checkInvariants(zones, a, label){
  const allFinite = zones.every(z => [z.x, z.y, z.w, z.h].every(v => Number.isFinite(v)));
  ok(allFinite, label + '：坐标都是有限数', JSON.stringify(zones));
  ok(zones.every(z => z.w > 0 && z.h > 0), label + '：每个分区都有正面积', JSON.stringify(zones));
  const inside = zones.every(z =>
    z.x >= a.x && z.y >= a.y && z.x + z.w <= a.x + a.w + 1 && z.y + z.h <= a.y + a.h + 1);
  ok(inside, label + '：都在可用区域内（不越界）', zones.map(z => JSON.stringify(z)).join(' '));
  let overlap = null;
  for (let i = 0; i < zones.length; i++) for (let j = i + 1; j < zones.length; j++){
    const p = zones[i], q = zones[j];
    if (p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h) overlap = i + ' 与 ' + j;
  }
  ok(!overlap, label + '：分区互不重叠', overlap || '');
}

console.log('=== 一、freeArea：面板贴右 / 贴左，剩余区域算得对不对 ===');
{
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const R = area(wa, 'right');
  ok(R.x === 0 && R.y === 0, '贴右：剩余区域从工作区左上角起', JSON.stringify(R));
  ok(R.w === 1920 - PAD - PANEL_W - Z.GAP_PANEL, '贴右：宽度 = 工作区 − 留边 − 面板 − 缝',
    R.w + ' 应为 ' + (1920 - PAD - PANEL_W - Z.GAP_PANEL));
  ok(R.x + R.w + Z.GAP_PANEL + PANEL_W + PAD === wa.width,
    '贴右：分区右边界 + 缝 + 面板 + 留边 正好等于屏宽', JSON.stringify(R));
  const L = area(wa, 'left');
  ok(L.x === PAD + PANEL_W + Z.GAP_PANEL, '贴左：剩余区域从面板右侧起（含缝）', JSON.stringify(L));
  ok(L.w === 1920 - L.x, '贴左：宽度 = 屏宽 − 起点', JSON.stringify(L));
  ok(L.y === wa.y && L.h === wa.height, '贴左：纵向铺满工作区', JSON.stringify(L));
}

console.log('');
console.log('=== 二、1920×1040 工作区，三种分法 ===');
const WA = { x: 0, y: 0, width: 1920, height: 1040 };
const A = area(WA, 'right');
['split2', 'split3', 'quad'].forEach(layout => {
  const z = Z.planZones(A, layout);
  const want = layout === 'split3' ? 3 : (layout === 'quad' ? 4 : 2);
  ok(z.length === want, layout + '：切出 ' + want + ' 块（实际 ' + z.length + '）', JSON.stringify(z));
  ok(!z.some(r => r.degraded), layout + '：没有退化');
  checkInvariants(z, A, layout);
});

console.log('');
console.log('=== 三、块的实际尺寸（贴出来好对照）===');
['split2', 'split3', 'quad'].forEach(layout => {
  const z = Z.planZones(A, layout);
  console.log('  ' + layout.padEnd(7) + '：' + z.map(r => r.w + '×' + r.h + '@' + r.x + ',' + r.y).join('  |  '));
});

console.log('');
console.log('=== 四、窄屏：切不动就该退化成一块，并且明确标出来 ===');
{
  const cases = [
    [1920, 'split2', false, '1920 屏：二分可用'],
    [1440, 'split2', false, '1440 屏：二分可用'],
    [1440, 'quad',   false, '1440 屏：四分格可用'],
    [1280, 'split2', false, '1280 屏：二分勉强可用'],
    [1280, 'quad',   false, '1280 屏：四分格勉强可用'],
    [1024, 'split2', true,  '1024 屏：二分太窄 → 退化'],
    [1024, 'quad',   true,  '1024 屏：四分格太窄 → 退化']
  ];
  cases.forEach(([wid, layout, wantDeg, label]) => {
    const wa = { x: 0, y: 0, width: wid, height: 768 };
    const a = area(wa, 'right');
    const z = Z.planZones(a, layout);
    const deg = z.length === 1 && z[0].degraded === true;
    ok(deg === wantDeg, label + '（可用区 ' + a.w + 'px，切出 ' + z.length + ' 块）',
      JSON.stringify(z));
    checkInvariants(z, a, label);
  });
}

console.log('');
console.log('=== 五、边界：不能算出 NaN / 负数 / 越界 ===');
{
  const cases = [
    [{ x: 0, y: 0, width: 400, height: 300 }, 'split2', '极窄工作区'],
    [{ x: 0, y: 0, width: 1920, height: 200 }, 'split3', '极矮工作区（三分）'],
    [{ x: 0, y: 0, width: 1920, height: 120 }, 'split3', '矮到三分放不下'],
    [{ x: -1728, y: -1440, width: 1728, height: 1080 }, 'quad', '副屏在负坐标'],
    [{ x: 0, y: 0, width: 600, height: 1040 }, 'split2', '面板吃掉大半屏']
  ];
  cases.forEach(([wa, layout, label]) => {
    const a = area(wa, 'right');
    const z = Z.planZones(a, layout);
    const finite = z.every(r => [r.x, r.y, r.w, r.h].every(v => Number.isFinite(v)));
    const pos = z.every(r => r.w > 0 && r.h > 0);
    ok(finite && pos, label + '：仍然给出有限、有面积的矩形', JSON.stringify(z));
  });
}

console.log('');
console.log('=== 六、副屏（负坐标）也要正确 ===');
{
  const wa3 = { x: -1728, y: -1440, width: 1728, height: 1080 };
  const a3 = area(wa3, 'right');
  const z = Z.planZones(a3, 'split2');
  ok(z.length === 2, '副屏上能正常二分', JSON.stringify(z));
  checkInvariants(z, a3, '副屏');
}

console.log('');
console.log('=== 七、PowerShell 脚本本身要被 PowerShell 认下来 ===');
{
  const fs = require('fs'), path = require('path'), cp = require('child_process');
  const tmp = path.join(__dirname, '_zones_check.ps1');
  let parseOut = '', spawned = false;
  try {
    fs.writeFileSync(tmp, '\uFEFF' + Z.psSource(), 'utf8');
    const script = '$e=$null;'
      + '[void][System.Management.Automation.Language.Parser]::ParseFile('
      + "'" + tmp.replace(/\\/g, '\\\\') + "',[ref]$null,[ref]$e);"
      + 'if($e -and $e.Count){ $e | ForEach-Object { "ERR " + $_.Message + " @line " + $_.Extent.StartLineNumber } }'
      + 'else { "PARSE OK" }';
    parseOut = cp.execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 60000, windowsHide: true });
    spawned = true;
  } catch (e){
    parseOut = String((e.stdout || '') + (e.stderr || '') + (e.message || ''));
  }
  try { fs.unlinkSync(tmp); } catch (e){}
  if (!spawned){
    /* 起不来 PowerShell 就如实说"没验成"，绝不把它记成通过 ——
       这正是本项目最忌讳的那种"整齐划一的安静成功"。 */
    console.log('  ⚠ 没能启动 PowerShell，这一节没验成：' + parseOut.slice(0, 200));
    console.log('    （不算失败，但也不要当成通过）');
  } else {
    const t = String(parseOut).trim();
    ok(/PARSE OK/.test(t), 'PowerShell 能解析整段脚本', t.slice(0, 500));
  }
}

console.log('');
console.log(bad ? '★ 失败项 = ' + bad + ' / ' + n : '失败项 = 无（共 ' + n + ' 项断言）');
process.exit(bad ? 1 : 0);
