const fs = require('fs');
const o = [];
const cp = s => Array.from(s).map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase()).join(' ');
const one = new Uint8Array([0xbe, 0xdb]);
for (const enc of ['gbk','gb18030','gb2312']){
  try { const s = new TextDecoder(enc).decode(one); o.push(enc + ' 解 [BE DB] → ' + JSON.stringify(s) + ' · ' + cp(s)); }
  catch(e){ o.push(enc + ' → 抛错 ' + e.message); }
}
/* 用 Buffer 的兼容路径试试 */
o.push('---- 反向：中文编成什么字节 ----');
const encTest = (enc) => { try {
  const b = new (require('util').TextEncoder)('utf-8').encode('聚');
  return enc + ' 的 TextEncoder 只支持 utf-8（忽略）';
} catch(e){ return enc + ' → ' + e.message; } };
o.push(encTest('gbk'));
/* 关键：Node 是否真的装了 GBK 解码器 —— 用一轮往返判断 */
o.push('---- 判断是否小 ICU ----');
o.push('process.config.variables.icu_small = ' + (process.config && process.config.variables && process.config.variables.icu_small));
o.push('hasFullICU 探测 = ' + (() => { try { new TextDecoder('gbk').decode(new Uint8Array([0xc4,0xe3])); return '未抛错（有 gbk）'; } catch(e){ return '抛错 → ' + e.message; } })());
fs.writeFileSync(__dirname + '/_tdtest3.txt', o.join('\n'), 'utf8');
console.log('written');
