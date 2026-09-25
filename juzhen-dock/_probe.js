/* 渲染探针：Chrome headless dump-dom -> 统计真实渲染出的结构 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const dir = __dirname;
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/* 准备探针页面（deep-link 会走 hash，所以直接用 prototype.html） */
const views = [
  ['folders',  '#theme=sunny&page=folders&noOnboard=1'],
  ['links',    '#theme=sunny&page=links&noOnboard=1'],
  ['clip',     '#theme=mint&page=clip&noOnboard=1'],
  ['staging',  '#theme=mint&page=staging&noOnboard=1'],
  ['board',    '#theme=berry&page=board&noOnboard=1'],
  ['settings', '#theme=berry&page=settings&noOnboard=1'],
  ['pinned',   '#theme=sunny&page=board&pin=1&noOnboard=1']
];

const fileUrl = 'file:///' + dir.replace(/\\/g, '/') + '/prototype.html';
const out = [];
const DOM = path.join(dir, '_dom_probe.html');

for (const [name, hash] of views) {
  let dom = '';
  try {
    dom = cp.execFileSync(chrome, [
      '--headless=old', '--disable-gpu', '--virtual-time-budget=2500',
      '--dump-dom', fileUrl + hash
    ], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
    fs.writeFileSync(DOM, dom, 'utf8');
  } catch (e) {
    out.push(name + ': DUMP FAILED -> ' + e.message);
    continue;
  }
  const pk = ['gcard', 'fcard', 'wcard', 'zone ', 'row', 'bcard', 'cgrid', 'dropzone', 'phero', 'rbtn on', 'rbtn'];
  const line = pk.map(k => k.trim() + '=' + (dom.split(k).length - 1)).join(' ');
  const page = (dom.match(/data-page="([a-z]+)"[^>]*class="[^"]*on|class="rbtn on"[^>]*data-page="([a-z]+)"/) || [])[0] || '-';
  const heroSvg = (dom.match(/phero-art/g) || []).length;
  const err = (dom.match(/<body[\s\S]{0,200}?undefined/g) || []).length;
  out.push('[' + name + '] ' + line + ' | pheroArt=' + heroSvg + ' | undef近body=' + err);
  /* 取一小段正文做人类可读确认 */
  const bodyStart = dom.indexOf('<div class="panel"');
  if (bodyStart > 0) {
    const seg = dom.slice(bodyStart, bodyStart + 1200).replace(/\s+/g, ' ');
    out.push('    head> ' + seg.slice(0, 700));
  }
}
fs.writeFileSync(path.join(dir, '_dom_probe.txt'), out.join('\n'), 'utf8');
console.log('done');
