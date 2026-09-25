/* 验证：从产物里抠 `act === 'xxx'` 的正则到底能不能用。
   probe18 把每个可见动作都报成"没有处理分支"，先确认是提取错了还是真漏了。 */
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/prototype.html', 'utf8');
const raw = html.match(/act === '([a-z-]+)'/g) || [];
console.log('匹配条数 =', raw.length);
console.log('前 5 条原始 =', JSON.stringify(raw.slice(0, 5)));
const names = [...new Set(raw.map(m => m.slice(10, -1)))];
console.log('slice 后前 5 =', JSON.stringify(names.slice(0, 5)));
console.log('总数 =', names.length);
['ctx-open','todo-new','folders-add','shot-add','go'].forEach(a => {
  console.log('  ' + a.padEnd(14) + ' 在列表里 = ' + (names.indexOf(a) >= 0));
});
fs.writeFileSync(__dirname + '/_actcheck.txt', [
  'matches=' + raw.length, 'names=' + names.length, names.join(' ')
].join('\n'), 'utf8');
