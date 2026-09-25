/* 侧栏加宽后的连带影响探针：底部按钮是否溢出、正文宽度是否还够、首行是否被淡出遮罩吃掉 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = __dirname;
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let html = fs.readFileSync(path.join(dir, 'prototype.html'), 'utf8');
const probe = `
<script>
window.addEventListener('load', function(){
  var o = [];
  var q = function(s){ return document.querySelector(s); };
  var R = function(e){ return e ? e.getBoundingClientRect() : null; };
  setTimeout(function(){
    var side = q('.side'), rail = q('#rail'), btn = q('#btnRail');
    o.push('side 宽 = ' + Math.round(R(side).width) + ' px');
    o.push('btnRail 宽 = ' + Math.round(R(btn).width) + ' · 内容宽 = ' + btn.scrollWidth
      + (btn.scrollWidth > R(btn).width + 1 ? '  ← 文字被挤' : '  ← 未溢出'));
    o.push('btnRail 文字 = "' + btn.textContent.trim() + '" · em 行数 = '
      + (function(){ var em = btn.querySelector('em'); if(!em) return 'n/a';
          return Math.round(R(em).height / parseFloat(getComputedStyle(em).lineHeight || '14')); })()
      + ' · 按钮高 ' + Math.round(R(btn).height) + ' px');
    o.push('窗口 = ' + window.innerWidth + '×' + window.innerHeight);
    var first = q('#rail .rbtn'), last = q('#rail .rbtn:last-of-type');
    o.push('首行 top - rail top = ' + Math.round(R(first).top - R(rail).top) + ' px（淡出遮罩 18px，小于则是被吃掉）');
    o.push('末行 bottom 距 rail bottom = ' + Math.round(R(rail).bottom - R(last).bottom) + ' px');
    o.push('分组标题 5 个高度 = ' + Array.prototype.slice.call(document.querySelectorAll('#rail .rgroup'))
      .map(function(e){ return Math.round(R(e).height); }).join(' / '));
    var body = q('.page[data-page="folders"] .page-body');
    o.push('正文可用宽 = ' + Math.round(R(body).width) + ' px（3 列卡片需要 ≥ 380）');
    var g = q('.page[data-page="folders"] .gcard-b');
    o.push('文件夹分组卡列宽 = ' + (g ? getComputedStyle(g).gridTemplateColumns : 'n/a'));
    var hero = q('.page[data-page="folders"] .phero');
    o.push('页头宽 = ' + Math.round(R(hero).width) + ' px · 插画是否越界 = '
      + (function(){ var a = q('.page[data-page="folders"] .phero-art'); if(!a) return 'n/a';
          return R(a).right <= R(hero).right + 1 ? '否' : '是'; })());
    document.title = 'PROBE';
    /* 逐页检查页头：文字右边缘 vs 插画左边缘。
       侧栏从 86 → 124px，正文窄了 38px，页头文字有钻到插画下面的风险。 */
    o.push('');
    o.push('=== 页头文字 vs 插画（13 页） ===');
    PAGES.forEach(function(p){
      switchPage(p.id);
      var h = q('.page[data-page="' + p.id + '"] .phero');
      if (!h){ o.push(p.id + ': 无页头'); return; }
      var tx = h.querySelector('.phero-tx'), art = h.querySelector('.phero-art');
      if (!tx) { o.push(p.id + ': 无文字块'); return; }
      var t = tx.querySelector('.phero-t'), s = tx.querySelector('.phero-s');
      var pad = 15;
      var limit = art ? R(art).left : R(h).right - pad;
      var worst = Math.max(R(t) && t.offsetWidth ? R(t).right : 0, R(s) && s.offsetWidth ? R(s).right : 0);
      /* range 量文字真实占宽（块级元素会占满 flex 宽度，不能直接用 rect.width） */
      var tw = (function(el){ if(!el || !el.firstChild) return 0; var r = document.createRange();
        r.selectNodeContents(el); return Math.round(r.getBoundingClientRect().width); })(t);
      var sw = (function(el){ if(!el || !el.firstChild) return 0; var r = document.createRange();
        r.selectNodeContents(el); return Math.round(r.getBoundingClientRect().width); })(s);
      var textRight = R(tx).left + Math.max(tw, sw);
      o.push(p.id.padEnd(9) + ' 标题 ' + tw + ' / 副题 ' + sw + ' px · 文字右 ' + Math.round(textRight)
        + ' · 插画左 ' + Math.round(limit) + ' → ' + (textRight <= limit - 8 ? 'OK' : '重叠风险'));
      /* 页头工具栏 vs 插画（2026-09-22 加）。
         起因：.phero-art 是**绝对定位**（right:-4px，宽 168px），.phero-tools
         是它的普通兄弟节点、不吃 flex 空间 —— 所以页头按钮其实是**压在插画
         上面**的。文字那一侧有 .phero-tx 的 165px 内边距兜着（这正是"插画通道"
         的来历），按钮这一侧**没有任何东西兜**。
         本来只想在页头加一个 ⓘ，一量才发现这条从来没被测过：原来的 + 也一直
         压在插画右半边。所以这里把三个数都摊开，并给"按钮变多 / 文字变窄"
         各留一个醒目提示，下次再加页头控件时不用重新想一遍。
         三个数都不做硬断言 —— 插画右边留白多少是设计决定的，只有人眼看得了；
         但"按钮总宽"和"文字可用宽"一变，这条就会亮出来。 */
      var k = h.querySelector('.phero-tools');
      if (k){
        var kr = R(k), ar = art ? R(art) : null;
        o.push('           tools 宽 ' + Math.round(kr.width)
          + ' · 右侧离页头右 ' + Math.round(R(h).right - kr.right) + 'px'
          + ' · 左缘比插画左缘靠右 ' + (ar ? Math.round(kr.left - ar.left) : 'n/a') + 'px'
          + ' · 按钮 ' + k.querySelectorAll('button').length + ' 个'
          + (kr.width > 100 ? '  ← 页头按钮变多了，插画右半边被压，要人眼看一眼' : ''));
      } else {
        o.push('           tools: 无（这一页既没有说明也没有新增）');
      }
      o.push('           tx 文字可用宽 ' + Math.round(Math.max(tw, sw)) + ' / tx 盒宽 ' + Math.round(R(tx).width)
        + (Math.max(tw, sw) > R(tx).width - 165 + 1 ? '  ← 文字已经吃进 165px 通道' : ''));
      if (tw > 200 || sw > 200){
        var cs = getComputedStyle(tx), csub = s ? getComputedStyle(s) : null;
        o.push('           tx 宽 ' + Math.round(R(tx).width) + ' / clientW ' + tx.clientWidth
          + ' / paddingRight ' + cs.paddingRight + ' · sub 盒宽 ' + (s ? Math.round(R(s).width) : -1)
          + ' / scrollW ' + (s ? s.scrollWidth : -1) + ' / lineH ' + (csub ? csub.lineHeight : 'n/a')
          + ' / 高 ' + (s ? Math.round(R(s).height) : -1) + ' / whiteSpace ' + (csub ? csub.whiteSpace : 'n/a')
          + ' · tools 宽 ' + (function(){ var k = h.querySelector('.phero-tools'); return k ? Math.round(R(k).width) : 0; })()
          + ' / position ' + (function(){ var k = h.querySelector('.phero-tools'); return k ? getComputedStyle(k).position : 'none'; })());
      }
    });
    var pre = document.createElement('pre'); pre.id = 'probe-out'; pre.textContent = o.join('\\n');
    document.body.appendChild(pre);
  }, 900);
});
</script>
</body>`;
html = html.replace('</body>', probe);
/* 可选：临时覆盖侧栏宽度，用于对照"加宽前 / 加宽后" */
const sideW = process.argv[2];
if (sideW) html = html.replace('</head>', '<style>.side{width:' + sideW + 'px !important}</style></head>');
const f = path.join(dir, '_probe10.html');
fs.writeFileSync(f, html, 'utf8');

const out = cp.execFileSync(chrome, ['--headless=old','--disable-gpu','--hide-scrollbars','--window-size=1600,1000',
  '--virtual-time-budget=4000',
  '--dump-dom','file:///' + f.replace(/\\/g, '/') + '#theme=sunny&page=folders&noOnboard=1'],
  { encoding: 'utf8', maxBuffer: 1 << 28 });
const m = out.match(/<pre id="probe-out">([\s\S]*?)<\/pre>/);
const res = m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : 'PROBE 未执行';
fs.writeFileSync(path.join(dir, sideW ? '_probe10_side' + sideW + '.txt' : '_probe10.txt'), res, 'utf8');
console.log('ok');
