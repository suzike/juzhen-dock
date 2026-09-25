/* 端到端：这一轮新统一/新接的几条路，逐个走完整条真交互链。
   [A] folders 页头「+」（folders-add）→ 表单 → 保存 → 数组+1、卡片出现
   [B] links  页头「+」（links-add）→ 同上
   [C] board  卡片 ⋯ → 菜单「编辑内容…」→ 表单 → 保存 → 文字真变了
   [D] shot   卡片 ⋯ → 菜单「改名…」→ 表单 → 保存 → 名字真变了
   [E] staging 页头「+」→ 浏览器里必须**如实说没有文件对话框**，
       而不是旧版那句"把文件拖进暂存区即可"（点着没反应的入口）。
   每步都同时查内存 / 落盘 / DOM 三处，只查一处不算数。 */
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
    var done = function(){ pre.textContent = arr.join('\\n') + '\\n(END)'; };
    var wait = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
    var until = async function(fn, tries){
      for (var i = 0; i < (tries || 200); i++){ if (fn()) return true; await wait(10); }
      return !!fn();
    };
    var q = function(s){ return document.querySelector(s); };
    var all = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };
    var click = function(el, what){
      if (!el){ o.push('    [!] click 拿到空元素：' + (what || '(未说明)')); return false; }
      el.dispatchEvent(new MouseEvent('click', { bubbles:true })); return true;
    };
    var goPage = function(id){ if (state.query) exitSearch(false); switchPage(id); };
    /* 填表单并提交：点开 → 等浮层 → 逐个输入框填值 → 点主按钮 */
    var fillAndSubmit = async function(openSel, vals){
      if (!click(q(openSel), openSel)) return false;
      if (!await until(function(){ return has('.minip:not(.closing) .mp-in'); }, 80)) return false;
      var ins = all('.minip:not(.closing) .mp-in');
      vals.forEach(function(v, i){ if (ins[i]) ins[i].value = v; });
      var ok = q('.minip:not(.closing) [data-r="1"]');
      if (!ok){ o.push('    [!] 表单没有主按钮'); return false; }
      click(ok);
      return true;
    };
    var has = function(s){ return !!document.querySelector(s); };
    var diskHas = function(key, needle){
      try {
        var raw = localStorage.getItem(key);
        return !!raw && raw.indexOf(needle) >= 0;
      } catch(e){ return false; }
    };

    try {
      openPanel();
      /* ---- A. folders 页头「+」 ---- */
      goPage('folders');
      var f0 = DATA.folders.length;
      var A = await fillAndSubmit('.ph-act[data-act="folders-add"]',
        ['探针页头文件夹', 'D:\\\\Probe21\\\\HeadFolder']);
      await until(function(){ return DATA.folders.length === f0 + 1; }, 60);
      var newF = DATA.folders[DATA.folders.length - 1] || {};
      o.push('[A] folders 页头「+」→ 表单弹出 = ' + A
        + ' · 数组 ' + f0 + '→' + DATA.folders.length
        + ' · 名称 = ' + JSON.stringify(newF.name)
        + ' · 落盘 = ' + diskHas('juzhen.folders', '探针页头文件夹')
        + ' · DOM 出现 = ' + all('.row[data-kind="folder"]').some(function(e){
            return e.querySelector('.nm') && e.querySelector('.nm').textContent === '探针页头文件夹'; }));

      /* ---- B. links 页头「+」 ---- */
      goPage('links');
      var l0 = DATA.links.length;
      var B = await fillAndSubmit('.ph-act[data-act="links-add"]',
        ['探针页头站点', 'https://probe21.example.com/head']);
      await until(function(){ return DATA.links.length === l0 + 1; }, 60);
      var newL = DATA.links[DATA.links.length - 1] || {};
      o.push('[B] links 页头「+」→ 表单弹出 = ' + B
        + ' · 数组 ' + l0 + '→' + DATA.links.length
        + ' · 名称 = ' + JSON.stringify(newL.name)
        + ' · host 派生 = ' + JSON.stringify(newL.host)
        + ' · 落盘 = ' + diskHas('juzhen.links', 'probe21.example.com'));

      /* ---- C. board 卡片 ⋯ → 编辑内容 ---- */
      goPage('board');
      var bCard = q('.bcard[data-kind="board"]');
      var bMore = bCard && bCard.querySelector('.ctx-more');
      o.push('[C] board 卡片上有 ⋯ = ' + !!bMore);
      var Cok = false, bNew = '';
      if (bMore){
        click(bMore, 'board 卡片的 ⋯');
        await until(function(){ return has('#ctx.show'); }, 40);
        var items = all('#ctx .ctx-item').map(function(e){ return e.textContent.trim(); });
        o.push('    菜单项 = ' + items.join(' / '));
        var editIt = all('#ctx .ctx-item').filter(function(e){
          return e.textContent.indexOf('编辑内容') >= 0; })[0];
        if (click(editIt, '菜单里的「编辑内容…」')){
          if (await until(function(){ return has('.minip:not(.closing) .mp-in'); }, 60)){
            var ta = q('.minip:not(.closing) .mp-in');
            bNew = '探针改过的剪切板内容 ' + Date.now();
            ta.value = bNew;
            click(q('.minip:not(.closing) [data-r="1"]'), '表单主按钮');
            await until(function(){
              return DATA.board.some(function(x){ return x.text === bNew; }); }, 60);
            Cok = DATA.board.some(function(x){ return x.text === bNew; });
          }
        }
      }
      o.push('    改完内存里有 = ' + Cok + ' · 落盘 = ' + diskHas('juzhen.board.v2', '探针改过的剪切板内容')
        + ' · 卡片文字也换了 = ' + all('.bcard .tx, .bcard .lnk, .bcard .crumb').some(function(e){
            return e.textContent.indexOf(bNew) >= 0; }));

      /* ---- D. shot 卡片 ⋯ → 改名 ---- */
      goPage('shot');
      var sCard = q('.shot[data-kind="shot"]');
      var sMore = sCard && sCard.querySelector('.ctx-more');
      o.push('[D] shot 卡片上有 ⋯ = ' + !!sMore);
      var Dok = false, sNew = '探针改过的贴图名';
      if (sMore){
        click(sMore, 'shot 卡片的 ⋯');
        await until(function(){ return has('#ctx.show'); }, 40);
        var renameIt = all('#ctx .ctx-item').filter(function(e){
          return e.textContent.indexOf('改名') >= 0; })[0];
        if (click(renameIt, '菜单里的「改名…」')){
          if (await until(function(){ return has('.minip:not(.closing) .mp-in'); }, 60)){
            q('.minip:not(.closing) .mp-in').value = sNew;
            click(q('.minip:not(.closing) [data-r="1"]'), '表单主按钮');
            await until(function(){
              return TOOL.shots.some(function(x){ return x.t === sNew; }); }, 60);
            Dok = TOOL.shots.some(function(x){ return x.t === sNew; });
          }
        }
      }
      o.push('    改完内存里有 = ' + Dok + ' · 落盘 = ' + diskHas('juzhen.shots', sNew)
        + ' · 卡片标题也换了 = ' + all('.shot .shot-t').some(function(e){
            return e.textContent === sNew; }));

      /* ---- E. staging 页头「+」在浏览器里的说法 ---- */
      goPage('staging');
      var st0 = DATA.staging.length;
      click(q('.ph-act[data-act="staging-add"]'), 'staging 页头「+」');
      await wait(400);
      var stToast = $('toastMsg').textContent;
      o.push('[E] staging 页头「+」在浏览器里 → 数组 ' + st0 + '→' + DATA.staging.length
        + ' · 吐司 = ' + JSON.stringify(stToast)
        + (stToast.indexOf('没有文件对话框') >= 0 ? ' ✓ 如实说明' : ' ✗ 说法不对劲'));

      o.push('[F] 运行期异常 = ' + (errs.length ? errs.join(' | ') : '无'));
    } catch (ex){
      o.push('[!] 探针抛错：' + ex.message + ' @ ' + String(ex.stack || '').split('\\n')[1]);
    }
    done();
  }, 1500);
});
</script>
</body>`;
html = html.replace('</body>', probe);
const f = path.join(dir, '_probe21.html');
fs.writeFileSync(f, html, 'utf8');

const out = cp.execFileSync(chrome, ['--headless=old','--disable-gpu','--hide-scrollbars',
  '--window-size=1600,1000','--virtual-time-budget=90000','--dump-dom',
  'file:///' + f.replace(/\\/g,'/') + '#theme=sunny&page=today&noOnboard=1'],
  { encoding:'utf8', maxBuffer:1<<28 });
const m = out.match(/<pre id="probe-out">([\s\S]*?)<\/pre>/);
const res = m ? m[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&') : 'PROBE 未执行';
fs.writeFileSync(path.join(dir, '_probe21.txt'), res, 'utf8');
console.log(res);
