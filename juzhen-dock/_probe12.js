/* 全局搜索的行为探针：真事件驱动，不用"读回自己写的值"那种自证式断言。
   覆盖：在原本不支持搜索的板块里打字 / 结果结构 / ↑↓ 选择 / Enter 执行 /
        点击结果 / 切换板块后是否残留搜索态 / 清空后退回 / 全程无异常。 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = __dirname;
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let html = fs.readFileSync(path.join(dir, 'prototype.html'), 'utf8');
const probe = `
<script>
window.addEventListener('load', function(){
  setTimeout(function(){
    var o = [], errs = [], deferred = false;
    window.addEventListener('error', function(e){ errs.push(String(e.message)); });
    var done = function(){
      var pre = document.createElement('pre'); pre.id = 'probe-out'; pre.textContent = o.join('\\n');
      document.body.appendChild(pre);
    };
    try {    var q = function(s){ return document.querySelector(s); };
    var all = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };
    var has = function(s){ return !!document.querySelector(s); };
    var bodyOf = function(){ return q('.page[data-page="' + state.page + '"] .page-body'); };
    var type = function(v){
      q('#q').value = v;
      q('#q').dispatchEvent(new Event('input', { bubbles:true }));
    };
    var click = function(el){ el.dispatchEvent(new MouseEvent('click', { bubbles:true })); };
    var key = function(k){
      q('#q').dispatchEvent(new KeyboardEvent('keydown', { key:k, bubbles:true, cancelable:true }));
    };

    /* 1. 在一个"旧版完全不支持搜索"的板块里打字（换算页） */
    switchPage('calc');
    type('标定');
    o.push('[1] 在换算页输入「标定」→ 正文出现搜索结果 = ' + has('.sres')
      + ' · 结果条数 = ' + all('.sres .row').length
      + ' · 来源分组 = ' + all('.sres .gcard').length
      + ' · 页脚 = "' + (q('#foot').textContent.match(/全板块搜索命中[^ ]* \\d+ 项/) || ['(无)'])[0] + '"');

    /* 2. 每个来源分组只列前 6 条，且带动作标签 */
    var tg = all('.sres .row .tg').map(function(e){ return e.textContent; });
    o.push('[2] 动作标签（去重）= ' + Array.from(new Set(tg)).join(' / ')
      + ' · 缺标签的行 = ' + all('.sres .row').filter(function(r){ return !r.querySelector('.tg'); }).length);

    /* 3. ↑↓ 选择 */
    key('ArrowDown'); key('ArrowDown');
    var selRows = all('.sres .row.sel');
    o.push('[3] 连按两次 ↓ → 选中行 = ' + selRows.length + (selRows.length ? ' （第 ' + (all('.sres .row').indexOf(selRows[0]) + 1) + ' 条）' : ''));
    key('ArrowUp');
    o.push('    再按 ↑ → 选中序号 = ' + (all('.sres .row').indexOf(q('.sres .row.sel')) + 1));

    /* 4. Enter 执行选中的那一条（把鼠标态/键盘态打通） */
    var before = all('.sres .row').length;
    key('Enter');
    o.push('[4] Enter 执行 → 结果页已退出 = ' + (!has('.sres')) + ' · 搜索框已清空 = ' + (q('#q').value === '')
      + ' · 当前页正文节点 = ' + bodyOf().children.length + ' · 吐司 = "' + q('#toastMsg').textContent + '"');

    /* 5. 点击"板块"型结果：应跳到那个板块并清空搜索 */
    switchPage('folders');
    type('换算');
    var goRow = all('.sres .row').filter(function(r){ return r.dataset.act === 'go'; })[0];
    var target = goRow ? goRow.dataset.id : '';
    if (goRow) click(goRow);
    o.push('[5] 点搜索里的板块条目「' + target + '」→ 当前板块 = ' + state.page + ' （应为 ' + target + '）'
      + ' · 搜索态已退出 = ' + (!state.query) + ' · 侧栏高亮 = '
      + (q('.rbtn.on') ? q('.rbtn.on').dataset.page : '无'));

    /* 6. 点击数据条目：预览层应打开 */
    switchPage('clip');
    type('PMV');
    var dataRow = all('.sres .row').filter(function(r){ return r.dataset.kind; })[0];
    var kind = dataRow ? dataRow.dataset.kind : '';
    if (dataRow) click(dataRow);
    o.push('[6] 点搜索里的数据条目（kind=' + kind + '）→ 预览层打开 = ' + (has('#pv.open') || state.pvOpen)
      + ' · 搜索态已退出 = ' + (!state.query));
    closePreview();

    /* 7. 搜索态下切板块：回来时不能残留旧的结果页（这是最容易漏的一个坑） */
    switchPage('folders');
    type('A2L');
    var had = has('.sres');
    click(q('.rbtn[data-page="board"]'));
    var leftQuery = state.query;
    var boardOK = has('.page[data-page="board"] .bcard') || has('.page[data-page="board"] .bd-empty');
    switchPage('folders');
    o.push('[7] 搜索后直接点侧栏切板块 → 搜索已清空 = ' + (!leftQuery)
      + ' · 目标页正常渲染 = ' + boardOK
      + ' · 切回文件夹页是否残留结果页 = ' + has('.page[data-page="folders"] .sres') + '（应为 false）'
      + ' · 文件夹页正常 = ' + has('.page[data-page="folders"] .gcard'));

    /* 8. Esc 清空；空结果提示 */
    switchPage('calc');
    type('zzzz不存在的词');
    var emptyOK = has('.page[data-page="calc"] .empty-hint');
    key('Escape');
    o.push('[8] 无命中 → 显示空状态 = ' + emptyOK + ' · Esc 清空后回到换算式页 = '
      + (!has('.sres')) + ' · 输入框值 = "' + q('#q').value + '"');

    /* 9. 搜索不改变数据、不影响计数 */
    var before9 = DATA.folders.length;
    type('标定');
    var railN = all('.rbtn .rn').map(function(e){ return e.textContent; }).join(',');
    key('Escape');
    o.push('[9] 搜索前后数据条数不变 = ' + (DATA.folders.length === before9)
      + ' · 侧栏计数（搜索态）= [' + railN + ']');

    o.push('[10] 运行期异常 = ' + (errs.length ? errs.join(' | ') : '无'));

    /* 11. 结果页自身布局：不横向溢出、动作标签不被挤没、名称列还有足够宽度 */
    switchPage('calc');
    type('标定');
    var pb = bodyOf(), pr = pb.getBoundingClientRect();
    var over = all('.sres *').filter(function(el){
      if (getComputedStyle(el).position === 'absolute') return false;
      return el.getBoundingClientRect().right > pr.right + 1.5;
    });
    var tgW = all('.sres .row .tg').map(function(e){ return Math.round(e.getBoundingClientRect().width); });
    var nmW = all('.sres .row .nm').map(function(e){ return Math.round(e.getBoundingClientRect().width); });
    var cut = all('.sres .row .nm').filter(function(e){ return e.scrollWidth > e.clientWidth + 2; }).length;
    o.push('[11] 结果页溢出元素 = ' + over.length + '（应为 0） · 正文宽 = ' + Math.round(pr.width)
      + ' · 名称列宽 = ' + Math.min.apply(null, nmW) + '~' + Math.max.apply(null, nmW)
      + ' · 名称被省略号截断 = ' + cut + ' / ' + nmW.length
      + ' · 标签宽 = ' + Math.min.apply(null, tgW) + '~' + Math.max.apply(null, tgW));
    key('Escape');

    /* 12. 被截断的名称是否补上了 title（这一步要等 rAF 量完再查，所以延后） */
    switchPage('today');
    deferred = true;
    setTimeout(function(){
      var c2 = all('.page[data-page="today"] .nm').filter(function(e){ return e.scrollWidth > e.clientWidth + 1; });
      var withT = c2.filter(function(e){ return e.title; });
      o.push('[12] 今日页被截断的名称 = ' + c2.length + ' 个 · 已补悬停提示 = ' + withT.length
        + (withT.length ? '（例："' + withT[0].title.slice(0, 18) + '"）' : '（应为全部）'));
      done();
    }, 400);
    } catch (ex){ o.push('[!] 探针本身抛错：' + ex.message + ' @ ' + (ex.stack || '').split('\\n')[1]); }
    if (!deferred) done();
  }, 1500);
});
</script>
</body>`;
html = html.replace('</body>', probe);
const f = path.join(dir, '_probe12.html');
fs.writeFileSync(f, html, 'utf8');

const out = cp.execFileSync(chrome, ['--headless=old','--disable-gpu','--hide-scrollbars','--window-size=1600,1000',
  '--virtual-time-budget=8000','--dump-dom','file:///' + f.replace(/\\/g, '/') + '#theme=sunny&page=folders&noOnboard=1'],
  { encoding: 'utf8', maxBuffer: 1 << 28 });
const m = out.match(/<pre id="probe-out">([\s\S]*?)<\/pre>/);
const res = m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : 'PROBE 未执行';
fs.writeFileSync(path.join(dir, '_probe12.txt'), res, 'utf8');
console.log('ok');
