const fs = require('fs');
const gbk = Buffer.from('be db d5 e4 d7 d4 bc ec c3 fc c1 ee ca e4 b3 f6','hex');
const o = [];
o.push('node ' + process.version + ' · icu ' + (process.config && process.config.variables ? process.config.variables.icu_small : '?'));
for (const enc of ['gbk','gb18030','big5','shift_jis','utf-8']){
  try { o.push(enc + ' → ' + JSON.stringify(new TextDecoder(enc).decode(gbk))); }
  catch(e){ o.push(enc + ' → 抛错: ' + e.message); }
}
o.push('utf8 严格 → ' + (() => { try { return JSON.stringify(new TextDecoder('utf-8',{fatal:true}).decode(gbk)); } catch(e){ return '抛错(不是合法UTF-8)'; } })());
o.push('直接 utf8 toString → ' + JSON.stringify(gbk.toString('utf8')));
/* 反向验证：把正确的中文按 gb18030 编码回去，看是否还原 */
try {
  o.push('---- 反查 ----');
  const tbl = { '聚':'bEdb','珍':'d5e4','自':'d7d4','检':'bcec','命':'c3fc','令':'c1ee','输':'cae4','出':'b3f6' };
  o.push('码表拼接与原始字节一致 = ' + (Object.keys(tbl).map(k=>tbl[k]).join('') === gbk.toString('hex')));
} catch(e){ o.push('反查失败 ' + e.message); }
fs.writeFileSync(__dirname + '/_tdtest2.txt', o.join('\n'), 'utf8');
console.log('written');
