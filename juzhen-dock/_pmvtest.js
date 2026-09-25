/* PMV/PPD 与湿空气算法的正确性验证
   对照组：ISO 7730 附录 D 的参考算例，以及 ASHRAE 手册的湿空气表值。 */
const fs = require('fs'), path = require('path'), dir = __dirname;
const read = f => fs.readFileSync(path.join(dir, f), 'utf8');

/* 抠出 _tools.txt 里的 PSY / pmvSolve / pmvWord，单独求值 */
const src = read('_tools.txt');
const start = src.indexOf('const PSY = {');
const end   = src.indexOf('/* ================================================================\n   单位换算表');
const code  = src.slice(start, end) + '\nmodule.exports = { PSY, pmvSolve, pmvWord };';
const M = { exports: {} };
new Function('module', code)(M);
const { PSY, pmvSolve, pmvWord } = M.exports;

const out = [];
const ok = (label, got, want, tol) => {
  const d = Math.abs(got - want);
  out.push((d <= tol ? '  [通过] ' : '  [偏差] ') + label
    + ' = ' + (typeof got === 'number' ? got.toFixed(3) : got)
    + ' · 参考 ' + want + ' · 差 ' + d.toFixed(4) + (d <= tol ? '' : '  ← 超差'));
};

out.push('=== 湿空气（Magnus，101.325 kPa） ===');
/* ASHRAE：25℃ 饱和水汽压 3.169 kPa；30℃ 4.246 kPa */
ok('es(25℃) 饱和水汽压 kPa', PSY.es(25), 3.169, 0.02);
ok('es(30℃) 饱和水汽压 kPa', PSY.es(30), 4.246, 0.03);
/* 25℃ / 50%RH：露点约 13.9℃，含湿量约 9.9 g/kg，比焓约 50.3 kJ/kg */
ok('露点 td(25℃,50%)', PSY.td(25, 50), 13.85, 0.4);
ok('含湿量 d(25℃,50%) g/kg', PSY.d(25, 50) * 1000, 9.88, 0.25);
ok('比焓 h(25℃,50%) kJ/kg', PSY.h(25, 50), 50.3, 0.8);
/* 0℃ 露点校验：0℃ 饱和时 rh=100% → 露点应回 0 */
ok('td(0℃,100%) 应回 0', PSY.td(0, 100), 0, 0.01);

out.push('');
out.push('=== PMV / PPD（ISO 7730 附录 D 参考算例） ===');
/* 算例：ta=tr=22℃, vel=0.1, rh=60%, met=1.2, clo=0.5 → PMV≈-0.75, PPD≈17% */
let r = pmvSolve(22, 22, 0.1, 60, 1.2, 0.5);
out.push('  算例输入：ta=tr=22℃  vel=0.1 m/s  rh=60%  met=1.2  clo=0.5');
ok('PMV',  r.pmv, -0.75, 0.12);
ok('PPD %', r.ppd, 17, 4);
ok('tcl 服装表面温度 ℃', r.tcl, 28.6, 1.2);

out.push('');
out.push('=== 中性温度（PMV = 0 的解） ===');
/* 比"某个固定温度下 PMV 应该等于几"更可靠的检验：
   直接解出中性温度，看它是否落在工程经验区间。
   参考：1.0 met / 0.5 clo / 0.15 m/s 的中性温度约 26 ℃（ASHRAE 55 图 5.3.1） */
function neutralT(clo, met, vel, rh){
  let lo = 5, hi = 45;
  for (let i = 0; i < 60; i++){
    const mid = (lo + hi) / 2;
    if (pmvSolve(mid, mid, vel, rh, met, clo).pmv < 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
[[0.5, 1.0, 26.0], [1.0, 1.0, 22.5], [0.5, 1.2, 24.0]].forEach(c => {
  const tn = neutralT(c[0], c[1], 0.15, 50);
  out.push('  clo=' + c[0] + ' met=' + c[1] + ' → 中性温度 ' + tn.toFixed(1)
    + ' ℃ · 经验约 ' + c[2] + ' ℃' + (Math.abs(tn - c[2]) <= 2 ? '  [通过]' : '  [偏差] 超 2℃'));
});
r = pmvSolve(25, 25, 0.15, 50, 1.0, 0.5);
out.push('  25℃/0.5clo/1.0met 的 PMV = ' + r.pmv.toFixed(3) + ' · ' + pmvWord(r.pmv)
  + ' · PPD ' + r.ppd.toFixed(1) + '%');

out.push('');
out.push('=== 单调性（模型不能反着走） ===');
const base = pmvSolve(24, 24, 0.15, 50, 1.0, 0.5).pmv;
const hotter = pmvSolve(28, 28, 0.15, 50, 1.0, 0.5).pmv;
const colder = pmvSolve(20, 20, 0.15, 50, 1.0, 0.5).pmv;
out.push('  24℃ PMV = ' + base.toFixed(3));
out.push('  28℃ PMV = ' + hotter.toFixed(3) + (hotter > base ? '  [通过] 升温→更热' : '  [错误] 反了'));
out.push('  20℃ PMV = ' + colder.toFixed(3) + (colder < base ? '  [通过] 降温→更冷' : '  [错误] 反了'));
const windy = pmvSolve(28, 28, 1.0, 50, 1.0, 0.5).pmv;
out.push('  28℃+1m/s PMV = ' + windy.toFixed(3) + (windy < hotter ? '  [通过] 吹风→更凉' : '  [错误] 反了'));

out.push('');
out.push('=== 边界 / 鲁棒性 ===');
[[35, 35, 0.1, 90, 2.0, 0.1], [-5, -5, 0.1, 30, 1.0, 2.0], [45, 60, 2, 20, 1.0, 0.5]].forEach(a => {
  const x = pmvSolve.apply(null, a);
  const finite = [x.pmv, x.ppd, x.tcl, x.hc].every(isFinite);
  out.push('  输入 [' + a.join(', ') + '] → PMV ' + x.pmv.toFixed(2)
    + ' · PPD ' + x.ppd.toFixed(1) + '% · tcl ' + x.tcl.toFixed(1)
    + (finite ? '  [通过] 全为有限值' : '  [错误] 出现 NaN/Infinity'));
});

fs.writeFileSync(path.join(dir, '_pmvtest.txt'), out.join('\n'), 'utf8');
console.log('ok');
