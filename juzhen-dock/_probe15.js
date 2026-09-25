/* 新增的"增 / 改 / 删"入口是否真的通了。
   这一轮补的是：文件夹、网址两页的可见入口（原先一个都没有），
   以及收藏箱 / 暂存区卡片上的 ⋯（原先只有右键）。
   判据必须是"真点 → 真填 → 真落盘 → 卡片真出现"，不能直接调
   editRecord 自证 —— 那只能证明函数在，证明不了入口接上了。 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = __dirname;
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let html = fs.readFileSync(path.join(dir, 'prototype.html'), 'utf8');
const probe = `
<script>
window.addEventListener('load', function(){
  setTimeout(async function(){
    var arr = [], errs = [];
    var pre = document.createElement('pre'); pre.id = 'probe-out';
    document.body.appendChild(pre);
    var o = { push: function(s){ arr.push(String(s)); pre.textContent = arr.join('\\n'); } };
    window.addEventListener('error', function(e){ errs.push(String(e.message)); });
    var wait = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
    var until = async function(fn, tries){
      for (var i = 0; i < (tries || 200); i++){ if (fn()) return true; await wait(10); }
      return !!fn();
    };
    var q = function(s){ return document.querySelector(s); };
    var all = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };
    var click = function(el){ el.dispatchEvent(new MouseEvent('click', { bubbles:true })); };
    var goPage = function(id){ if (state.query) exitSearch(false); switchPage(id); };
    var LSget = function(k){ try { return JSON.parse(localStorage.getItem(k)); } catch(e){ return null; } };
    /* 表单：挑那个正在场的浮层（退场中的带 .closing） */
    var liveForm = function(){ return q('.minip:not(.closing) .mp-in'); };
    /* 确认框 / 选择框没有输入框，用"有没有浮层"来判，
       不能拿 .mp-in 当通用判据 —— 会把确认框漏掉。 */
    var livePop = function(){ return q('.minip:not(.closing)'); };
    var fill = function(box, i, v){
      var els = box.querySelectorAll('.mp-in');
      els[i].value = v;
      els[i].dispatchEvent(new Event('input', { bubbles:true }));
    };
    var submit = function(box){
      var b = box.querySelector('.mp-r [data-r="1"]');
      click(b);
    };
    /* ⋯ → 菜单 → 点某一项（按文字找） */
    var menuClick = async function(text){
      var it = all('#ctx.show .ctx-item').filter(function(e){
        return e.textContent.indexOf(text) >= 0; })[0];
      if (!it) return false;
      click(it);
      await wait(60);
      return true;
    };
    try {
      /* ---- 1. 文件夹页：可见入口 + 新增真的落盘 ---- */
      goPage('folders');
      var rows = all('.row[data-kind="folder"]');
      o.push('[1] 文件夹页 · 行 ' + rows.length + ' 个 · 每行带 ⋯ 的 ' +
        rows.filter(function(r){ return !!r.querySelector('.ctx-more'); }).length + ' 个');
      var addBtn = q('[data-act="folder-new"]');
      o.push('[1] 「新增文件夹」按钮 = ' + !!addBtn);
      var n0 = DATA.folders.length;
      click(addBtn);
      var ok = await until(function(){ return !!liveForm(); }, 60);
      o.push('[1] 点开后出现表单 = ' + ok + ' · 字段数 ' +
        (ok ? q('.minip:not(.closing)').querySelectorAll('.mp-in').length : -1));
      var box = q('.minip:not(.closing)');
      fill(box, 0, '自检项目A');
      fill(box, 1, 'E:\\\\__jz_probe__\\\\ProjectA');
      submit(box);
      await wait(120);
      var n1 = DATA.folders.length;
      var domHas = all('.row[data-kind="folder"] .nm').some(function(e){ return e.textContent === '自检项目A'; });
      var disk = LSget('juzhen.folders.v1') || LSget('juzhen.folders');
      var inDisk = JSON.stringify(disk || []).indexOf('自检项目A') >= 0;
      o.push('[1] 新增 → 数组 ' + n0 + '→' + n1 + ' · 卡片出现 = ' + domHas + ' · 落盘 = ' + inDisk);

      /* ---- 2. 文件夹页：⋯ → 编辑 → 改名 ---- */
      var target = all('.row[data-kind="folder"]').filter(function(r){
        var nm = r.querySelector('.nm'); return nm && nm.textContent === '自检项目A'; })[0];
      click(target.querySelector('.ctx-more'));
      var menuUp = await until(function(){ return all('#ctx.show .ctx-item').length > 0; }, 40);
      o.push('[2] ⋯ 弹出菜单 = ' + menuUp + ' · 项 ' + all('#ctx.show .ctx-item').length +
        ' · 含「编辑」= ' + all('#ctx.show .ctx-item').some(function(e){ return e.textContent.indexOf('编辑') >= 0; }));
      await menuClick('编辑');
      var ok2 = await until(function(){ return !!liveForm(); }, 60);
      o.push('[2] 编辑表单出现 = ' + ok2 + ' · 名称已预填 = ' +
        (ok2 ? q('.minip:not(.closing)').querySelectorAll('.mp-in')[0].value : '(无)'));
      var box2 = q('.minip:not(.closing)');
      fill(box2, 0, '自检项目A改');
      submit(box2);
      await wait(120);
      var renamed = DATA.folders.filter(function(f){ return f.name === '自检项目A改'; }).length;
      o.push('[2] 改名生效 = ' + (renamed === 1) + ' · 卡片文字 = ' +
        all('.row[data-kind="folder"] .nm').map(function(e){ return e.textContent; })
          .filter(function(t){ return t.indexOf('自检项目A改') === 0; }).join(','));

      /* ---- 3. 文件夹页：⋯ → 删除（要过确认） ---- */
      var t2 = all('.row[data-kind="folder"]').filter(function(r){
        var nm = r.querySelector('.nm'); return nm && nm.textContent === '自检项目A改'; })[0];
      click(t2.querySelector('.ctx-more'));
      await until(function(){ return all('#ctx.show .ctx-item').length > 0; }, 40);
      await menuClick('移除');
      var ok3 = await until(function(){ return !!livePop(); }, 60);
      o.push('[3] 删除前弹确认 = ' + ok3 + ' · 标题 = ' +
        (ok3 ? JSON.stringify(q('.minip:not(.closing) .mp-t').textContent) : '(无)') +
        ' · 主按钮文字 = ' + (ok3 ? JSON.stringify(q('.minip:not(.closing) .mp-r [data-r="1"]').textContent) : '(无)'));
      var conf = q('.minip:not(.closing)');
      click(conf.querySelector('.mp-r [data-r="1"]'));
      await wait(160);
      o.push('[3] 删除后还在吗 = ' +
        DATA.folders.some(function(f){ return f.name === '自检项目A改'; }) +
        ' · 卡片还在吗 = ' + all('.row[data-kind="folder"] .nm').some(function(e){ return e.textContent === '自检项目A改'; }) +
        ' · 数组 ' + DATA.folders.length);

      /* ---- 4. 网址页 ---- */
      goPage('links');
      var lrows = all('.row[data-kind="link"]');
      o.push('[4] 网址页 · 行 ' + lrows.length + ' · 带 ⋯ ' +
        lrows.filter(function(r){ return !!r.querySelector('.ctx-more'); }).length +
        ' · 新增按钮 = ' + !!q('[data-act="link-new"]'));
      var ln0 = DATA.links.length;
      click(q('[data-act="link-new"]'));
      var ok4 = await until(function(){ return !!liveForm(); }, 60);
      var box4 = q('.minip:not(.closing)');
      fill(box4, 0, '自检站点');
      fill(box4, 1, 'https://example.com/probe');
      submit(box4);
      await wait(120);
      var newLink = DATA.links.filter(function(l){ return l.name === '自检站点'; })[0];
      /* host 是派生字段，改地址必须跟着重算 —— 否则卡片上挂旧域名 */
      o.push('[4] 新增网址 → ' + ln0 + '→' + DATA.links.length + ' · host 派生 = ' +
        JSON.stringify(newLink ? newLink.host : '(没找到)'));

      /* ---- 5. 收藏箱 / 暂存区 的 ⋯ ---- */
      goPage('clip');
      var cl = all('.cclip[data-kind="clip"]');
      o.push('[5] 收藏箱 · 卡 ' + cl.length + ' · 带 ⋯ ' +
        cl.filter(function(c){ return !!c.querySelector('.ctx-more'); }).length);
      goPage('staging');
      var fc = all('.fcard[data-kind="file"]');
      o.push('[5] 暂存区 · 卡 ' + fc.length + ' · 带 ⋯ ' +
        fc.filter(function(c){ return !!c.querySelector('.ctx-more'); }).length);

      /* ---- 6. 每页都要有"空列表也能加回来"的路 ----
         必须限定在当前页的 body 里数：已渲染过的页不会因为切走就被清空
         （renderPage 是按需的，切回来不重建），用全文档选择器会把
         历史上渲染过的几页累加起来，数出来的东西没有意义。 */
      var pages = ['folders','links','today','scene','snip','shot'];
      o.push('[6] 各页新增按钮 = ' + pages.map(function(p){
        goPage(p);
        var sec = q('#track .page[data-page="' + p + '"]');
        var b = sec ? Array.prototype.slice.call(
          sec.querySelectorAll('[data-act$="-new"], [data-act="shot-add"]')) : [];
        return p + ':' + (b.length ? b.map(function(x){ return x.dataset.act; }).join('/') : '无');
      }).join(' · '));
      o.push('[6] 当前页只有自己的按钮（切到 folders 后）= ' + (function(){
        goPage('folders');
        var sec = q('#track .page[data-page="folders"]');
        return sec.querySelectorAll('[data-act$="-new"]').length + ' 个';
      })());

      /* ---- 7. 全站 ⋯ 覆盖清点 ---- */
      var kinds = ['folder','link','clip','file','todo','note','snip','scene','shot'];
      o.push('[7] data-kind 清单 = ' + kinds.join(','));
      o.push('[7] 收尾后 localStorage 键 = ' + Object.keys(localStorage).sort().join(','));
    } catch(e){ o.push('THROW: ' + (e && (e.stack || e.message))); }
    if (errs.length) o.push('PAGE_ERRORS: ' + errs.join(' | '));
    o.push('(END)');
  }, 500);
});
<\/script>`;

html = html.replace('</body>', probe + '</body>');
const tmp = path.join(dir, '_probe15.html');
fs.writeFileSync(tmp, html, 'utf8');

const out = cp.execFileSync(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=1280,900', '--virtual-time-budget=90000',
  '--user-data-dir=' + path.join(dir, '_chrome_tmp15'),
  '--dump-dom', 'file:///' + tmp.replace(/\\/g, '/')
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const m = out.match(/<pre id="probe-out">([\s\S]*?)<\/pre>/);
const txt = m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"') : '(未捕获)';
fs.writeFileSync(path.join(dir, '_probe15.txt'), txt, 'utf8');
console.log(txt);
