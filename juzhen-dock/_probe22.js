/* 端到端：这一轮针对用户三点抱怨的改动，逐个走完整条真交互链。
   用户原话：
     "每一个功能都有好多问题。而且AI速问，AI从哪？我用哪个AI啊？API怎么设置啊？
      也没有写。好多文件夹里边，你都有好多示例，那示例里边我也删不掉。而且就拿
      那个文件夹这个来说，那文件夹有分组，那我每一个分组里边我都没法往里分组
      里边加。有好多这种问题。"

   [A] 速问页状态条：服务商 / 模型 / Key 三样都在，且缺哪样就说哪样
   [B] 设置页「AI 模型」卡：六个字段齐全；换服务商 → 地址与模型名跟着换；
       填上 Key → 状态条当场变"已接通"
   [C] 未配好就提问：不下发、不改历史，并把原因说出来（不假装发了）
   [D] 请求失败的文案：必须**承认分不清**是跨域还是网络/地址问题
   [E] 常用问法：每条都有 ⋯，能删，且删完落盘（原来是一张只读常量表）
   [F] 历史问答：每条有 ⋯，能删，且落盘（原来既不能删也不落盘）
   [G] 演示问答可一键清掉，且只清演示、保留自己问的
   [H] 文件夹分组头「+」：预填该组父目录 + 表单里写明归类规则
   [I] 加进指定分组：落对了要说落对了，落到别组要**如实说落错了**
   [J] 收藏箱分组头「+」：预填平台名，保存后真的进那一组
   [K] 数据与存储：每栏有「清空」；清空要确认；清完落盘成 []
   [L] 「恢复示例」不再是点了就执行的破坏性动作，必须先确认
   [M] 落盘：asks / askTpl 两个键进了 localStorage
   [N] 运行期异常
   每步都同时查 内存 / 落盘 / DOM 三处，只查一处不算数。 */
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
    var has = function(s){ return !!document.querySelector(s); };
    var click = function(el, what){
      if (!el){ o.push('    [!] click 拿到空元素：' + (what || '(未说明)')); return false; }
      el.dispatchEvent(new MouseEvent('click', { bubbles:true })); return true;
    };
    var goPage = function(id){ if (state.query) exitSearch(false); switchPage(id); };
    var mpIn = function(){ return all('.minip:not(.closing) .mp-in'); };
    var mpOk = function(){ return q('.minip:not(.closing) [data-r="1"]'); };
    var readLs = function(key){
      try { var r = localStorage.getItem(key); return r == null ? null : JSON.parse(r); }
      catch(e){ return null; }
    };
    var diskHas = function(key, needle){
      try { var raw = localStorage.getItem(key); return !!raw && raw.indexOf(needle) >= 0; }
      catch(e){ return false; }
    };
    /* 找到某个分组卡（按 .gcard-nm 的文字），返回它的元素 */
    var gcardOf = function(name){
      return all('.gcard').filter(function(g){
        var nm = g.querySelector('.gcard-nm');
        return nm && nm.textContent.trim() === name;
      })[0];
    };
    var fillAndSubmit = async function(openEl, vals){
      if (!click(openEl, '分组「+」')) return false;
      if (!await until(function(){ return mpIn().length > 0; }, 80)) return false;
      var ins = mpIn();
      vals.forEach(function(v, i){ if (ins[i] && v !== null) ins[i].value = v; });
      click(mpOk(), '表单主按钮');
      return true;
    };
    var fireInput = function(el, v){
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles:true }));
    };

    try {
      openPanel();

      /* ================= A. 速问状态条 ================= */
      goPage('ask');
      var strip = q('.ai-st');
      o.push('[A] 速问状态条存在 = ' + !!strip
        + ' · 类名 = ' + (strip ? strip.className : '-'));
      o.push('    文案 = ' + JSON.stringify(strip ? strip.querySelector('.ai-tx').textContent : '')
        + ' · 有「去设置」= ' + !!(strip && strip.querySelector('[data-act="go"]')));
      o.push('    三个胶囊 = ' + all('.ai-chip').map(function(e){ return e.textContent; }).join(' | '));
      /* 默认预设：地址和模型名是有的，Key 没填 → 状态条必须只说"缺 Key" */
      var ready0 = aiReady();
      o.push('    未配 Key 时 aiReady = ' + ready0.ok + ' · 原因 = ' + JSON.stringify(ready0.why || ''));

      /* ================= B. 设置页 AI 模型卡 ================= */
      goPage('settings');
      var aiCard = all('.gcard').filter(function(g){
        var nm = g.querySelector('.gcard-nm'); return nm && nm.textContent.trim() === 'AI 模型'; })[0];
      o.push('[B] 设置页有「AI 模型」卡 = ' + !!aiCard);
      var fields = (aiCard ? Array.prototype.slice.call(aiCard.querySelectorAll('[data-ai]')) : [])
        .map(function(e){ return e.dataset.ai; });
      o.push('    字段 = ' + fields.join(','));
      var keyBtn = aiCard && aiCard.querySelector('[data-act="ai-keypage"]');
      o.push('    「去申请 Key」= ' + !!keyBtn
        + ' · 指向 = ' + JSON.stringify(keyBtn ? keyBtn.dataset.url : '')
        + ' · 「测试连接」= ' + !!(aiCard && aiCard.querySelector('[data-act="ai-test"]')));
      /* 换服务商：地址与模型名必须跟着预设走 */
      var sel = aiCard && aiCard.querySelector('[data-ai="provider"]');
      var before = aiCfg().baseUrl + ' | ' + aiCfg().model;
      if (sel){
        sel.value = 'ollama';
        sel.dispatchEvent(new Event('change', { bubbles:true }));
        await wait(120);
      }
      o.push('    换到本地 Ollama：' + JSON.stringify(before)
        + ' → ' + JSON.stringify(aiCfg().baseUrl + ' | ' + aiCfg().model)
        + ' · 现在 aiReady = ' + aiReady().ok + '（本地服务不需要 Key）');
      /* 换回 deepseek 并填 Key */
      var sel2 = q('.gcard [data-ai="provider"]');
      if (sel2){
        sel2.value = 'deepseek';
        sel2.dispatchEvent(new Event('change', { bubbles:true }));
        await wait(120);
      }
      var keyIn = q('.gcard [data-ai="apiKey"]');
      if (keyIn){ fireInput(keyIn, 'sk-probe22-fake-key-0001'); }
      await wait(80);
      o.push('    填上 Key 后：aiReady = ' + aiReady().ok
        + ' · 状态条 = ' + JSON.stringify((q('.ai-st .ai-tx') || {}).textContent || '')
        + ' · 落盘 = ' + diskHas('juzhen.settings.v2', 'sk-probe22-fake-key-0001'));

      /* ================= C. 未配好就不下发 ================= */
      goPage('ask');
      /* 先把 Key 清掉，制造"没配好"的状态 */
      var n0 = TOOL.asks.length;
      state.settings.ai.keys.deepseek = '';
      var box = q('#askInput');
      box.value = '探针：这条不该被发出去';
      click(q('.ask-go'), '发送');
      await wait(500);
      o.push('[C] 未填 Key 就提问 → 历史条数 ' + n0 + '→' + TOOL.asks.length
        + '（应为不变）· 吐司 = ' + JSON.stringify($('toastMsg').textContent)
        + ' · 输入框还留着问题 = ' + JSON.stringify(box.value || q('#askInput').value));
      var n1 = TOOL.asks.length;
      /* 再把 Key 填回来，但指向一个必然连不上的本地端口，走失败分支 */
      state.settings.ai.keys.deepseek = 'sk-x';
      state.settings.ai.baseUrl = 'http://127.0.0.1:9/v1';
      state.settings.ai.model = 'probe-model';
      var box2 = q('#askInput');
      box2.value = '探针：这条路必须失败';
      click(q('.ask-go'), '发送');
      await until(function(){
        var a = TOOL.asks[0];
        return a && a.state !== 'run';
      }, 300);
      await wait(120);
      var rec = TOOL.asks[0] || {};
      o.push('[C2] 连不上时的记录：state = ' + rec.state
        + ' · 历史条数 ' + n1 + '→' + TOOL.asks.length + '（应 +1）');
      o.push('    文案 = ' + JSON.stringify(String(rec.a || '').slice(0, 120)));
      /* ---- D: 失败文案必须承认分不清跨域与网络 ---- */
      var msg = String(rec.a || '');
      o.push('[D] 失败文案承认"分不清"= '
        + (msg.indexOf('跨域') >= 0 && (msg.indexOf('网络') >= 0 || msg.indexOf('地址写错') >= 0))
        + ' · 不谎报具体原因 = ' + (msg.indexOf('一定是') < 0));

      /* ================= E. 常用问法可删 ================= */
      goPage('ask');
      var t0 = TOOL.askTpl.length;
      var tMore = all('.ask-tpl .ctx-more')[0];
      o.push('[E] 常用问法每条都有 ⋯ = ' + (all('.ask-tpl').length === all('.ask-tpl .ctx-more').length)
        + '（' + all('.ask-tpl').length + ' 条）');
      if (click(tMore, '问法的 ⋯')){
        await until(function(){ return has('#ctx.show'); }, 40);
        var its = all('#ctx .ctx-item').map(function(e){ return e.textContent.trim(); });
        o.push('    菜单 = ' + its.join(' / '));
        var del = all('#ctx .ctx-item').filter(function(e){
          return e.textContent.indexOf('删掉这条问法') >= 0; })[0];
        if (click(del, '删掉这条问法')){
          await until(function(){ return has('.minip:not(.closing) [data-r="1"]'); }, 60);
          click(q('.minip:not(.closing) [data-r="1"]'), '确认删除');
          await until(function(){ return TOOL.askTpl.length === t0 - 1; }, 60);
        }
      }
      o.push('    删除后 ' + t0 + '→' + TOOL.askTpl.length
        + ' · 落盘条数 = ' + (readLs('juzhen.askTpl') || []).length
        + ' · DOM 条数 = ' + all('.ask-tpl').length);

      /* ================= F. 历史问答可删 ================= */
      var h0 = TOOL.asks.length;
      var hMore = all('.qa .ctx-more')[0];
      o.push('[F] 历史问答每条都有 ⋯ = ' + (all('.qa').length === all('.qa .ctx-more').length)
        + '（' + all('.qa').length + ' 条）');
      if (click(hMore, '问答的 ⋯')){
        await until(function(){ return has('#ctx.show'); }, 40);
        var its2 = all('#ctx .ctx-item').map(function(e){ return e.textContent.trim(); });
        o.push('    菜单 = ' + its2.join(' / '));
        var del2 = all('#ctx .ctx-item').filter(function(e){
          return e.textContent.indexOf('删除这条问答') >= 0; })[0];
        if (click(del2, '删除这条问答')){
          await until(function(){ return has('.minip:not(.closing) [data-r="1"]'); }, 60);
          click(q('.minip:not(.closing) [data-r="1"]'), '确认删除');
          await until(function(){ return TOOL.asks.length === h0 - 1; }, 60);
        }
      }
      o.push('    删除后 ' + h0 + '→' + TOOL.asks.length
        + ' · 落盘条数 = ' + (readLs('juzhen.asks') || []).length
        + ' · DOM 条数 = ' + all('.qa').length);

      /* ================= G. 演示问答可一键清掉 ================= */
      var demoBefore = TOOL.asks.filter(function(a){ return a.state === 'demo'; }).length;
      var mineBefore = TOOL.asks.filter(function(a){ return a.state !== 'demo'; }).length;
      var demoBtn = q('[data-act="ask-clear-demo"]');
      o.push('[G] 「清掉演示问答」按钮 = ' + !!demoBtn
        + ' · 演示 ' + demoBefore + ' 条 · 非演示 ' + mineBefore + ' 条');
      if (demoBtn){
        click(demoBtn, '清掉演示');
        await until(function(){ return has('.minip:not(.closing) [data-r="1"]'); }, 60);
        click(q('.minip:not(.closing) [data-r="1"]'), '确认清掉');
        await until(function(){
          return TOOL.asks.filter(function(a){ return a.state === 'demo'; }).length === 0; }, 60);
      }
      o.push('    清完：演示 ' + TOOL.asks.filter(function(a){ return a.state === 'demo'; }).length
        + ' 条 · 非演示 ' + TOOL.asks.filter(function(a){ return a.state !== 'demo'; }).length
        + ' 条（自己问的应保留）');

      /* ================= H/I. 文件夹分组头「+」 ================= */
      goPage('folders');
      var tg = gcardOf('Thermal');
      o.push('[H] 「Thermal」分组头有「+」= ' + !!(tg && tg.querySelector('.gcard-add')));
      var f0 = DATA.folders.length;
      var addBtn = tg && tg.querySelector('.gcard-add');
      if (addBtn){
        click(addBtn, 'Thermal 组的 +');
        await until(function(){ return mpIn().length > 0; }, 60);
        var ins = mpIn();
        o.push('    表单预填：名称 = ' + JSON.stringify(ins[0].value)
          + ' · 路径 = ' + JSON.stringify(ins[1] ? ins[1].value : '')
          + ' · 有归类说明 = ' + has('.minip:not(.closing) .mp-hint'));
        o.push('    说明文字 = ' + JSON.stringify(
          (q('.minip:not(.closing) .mp-hint') || {}).textContent || ''));
        ins[0].value = '探针组内新增';
        ins[1].value = 'E:/Projects/Thermal/ProbeNew';
        click(mpOk(), '添加');
        await until(function(){ return DATA.folders.length === f0 + 1; }, 60);
        o.push('[I] 落对该组时吐司 = ' + JSON.stringify($('toastMsg').textContent)
          + ' · 数组 ' + f0 + '→' + DATA.folders.length
          + ' · 落盘 = ' + diskHas('juzhen.folders', 'ProbeNew'));
      }
      /* 故意填一个落别组的路径 */
      var tg2 = gcardOf('Thermal');
      var f1 = DATA.folders.length;
      if (tg2 && tg2.querySelector('.gcard-add')){
        click(tg2.querySelector('.gcard-add'), 'Thermal 组的 +');
        await until(function(){ return mpIn().length > 0; }, 60);
        var ins2 = mpIn();
        ins2[0].value = '探针落错组';
        ins2[1].value = 'D:/Elsewhere/ProbeMiss';
        click(mpOk(), '添加');
        await until(function(){ return DATA.folders.length === f1 + 1; }, 60);
        o.push('    落错组时吐司 = ' + JSON.stringify($('toastMsg').textContent)
          + '（应明确说没落在你点的那一组）');
      }
      var domF = all('.row[data-kind="folder"] .nm').map(function(e){ return e.textContent; });
      o.push('    DOM 里能看到两条 = '
        + domF.indexOf('探针组内新增') + ' / ' + domF.indexOf('探针落错组'));

      /* ================= J. 收藏箱分组头「+」 ================= */
      goPage('clip');
      var cg = gcardOf('GitHub');
      o.push('[J] 「GitHub」分组头有「+」= ' + !!(cg && cg.querySelector('.gcard-add')));
      var c0 = DATA.clip.length;
      if (cg && cg.querySelector('.gcard-add')){
        click(cg.querySelector('.gcard-add'), 'GitHub 组的 +');
        await until(function(){ return mpIn().length > 0; }, 60);
        var ci = mpIn();
        o.push('    预填标题 = ' + JSON.stringify(ci[0].value)
          + ' · 说明 = ' + JSON.stringify((q('.minip:not(.closing) .mp-hint') || {}).textContent || ''));
        ci[1].value = 'https://github.com/probe22/repo';
        click(mpOk(), '添加');
        await until(function(){ return DATA.clip.length === c0 + 1; }, 60);
      }
      var added = DATA.clip[DATA.clip.length - 1] || {};
      o.push('    新增后 ' + c0 + '→' + DATA.clip.length
        + ' · 标题 = ' + JSON.stringify(added.name)
        + ' · 平台标识 = ' + JSON.stringify(added.pid)
        + ' · 吐司 = ' + JSON.stringify($('toastMsg').textContent));

      /* ================= K. 每栏「清空」 ================= */
      goPage('settings');
      var clearBtns = all('[data-act="col-clear"]');
      var restoreBtns = all('[data-act="col-restore"]');
      o.push('[K] 设置页「清空」按钮 = ' + clearBtns.length + ' 个 · 「恢复示例」按钮 = ' + restoreBtns.length + ' 个');
      var notesRow = all('.set-row').filter(function(r){
        var l = r.querySelector('.set-label'); return l && l.textContent === '速记'; })[0];
      var nB = notesRow && notesRow.querySelector('[data-act="col-clear"]');
      var n0s = TOOL.notes.length;
      if (nB){
        click(nB, '速记的清空');
        await until(function(){ return has('.minip:not(.closing) [data-r="1"]'); }, 60);
        var title = (q('.minip:not(.closing) .mp-t') || {}).textContent || '';
        var msg = (q('.minip:not(.closing) .mp-msg') || {}).textContent || '';
        o.push('    确认框标题 = ' + JSON.stringify(title) + ' · 说明含"不会自动备份"= ' + (msg.indexOf('不会自动备份') >= 0));
        click(q('.minip:not(.closing) [data-r="1"]'), '确认清空');
        await until(function(){ return TOOL.notes.length === 0; }, 60);
      }
      var notesRowAfter = all('.set-row').filter(function(r){
        var l = r.querySelector('.set-label'); return l && l.textContent === '速记'; })[0];
      o.push('    速记 ' + n0s + '→' + TOOL.notes.length
        + ' · 落盘 = ' + JSON.stringify(readLs('juzhen.notes'))
        + ' · 设置行还在（说明设置页没被清空）= ' + !!notesRowAfter
        + ' · 行内计数 = ' + JSON.stringify(notesRowAfter
            ? notesRowAfter.querySelector('.set-hint').textContent : '-'));

      /* ================= L. 「恢复示例」必须先确认 ================= */
      var rB = (function(){ var row = all('.set-row').filter(function(r){
        var l = r.querySelector('.set-label'); return l && l.textContent === '速记'; })[0];
        return row && row.querySelector('[data-act="col-restore"]'); })();
      if (rB){
        click(rB, '速记的恢复示例');
        await until(function(){ return has('.minip:not(.closing) [data-r="1"]'); }, 60);
        var okBtn = q('.minip:not(.closing) [data-r="1"]');
        o.push('[L] 「恢复示例」弹出确认 = ' + has('.minip:not(.closing)')
          + ' · 按钮 = ' + JSON.stringify(okBtn ? okBtn.textContent : '')
          + ' · 没确认前速记仍是 ' + TOOL.notes.length + ' 条');
        click(q('.minip:not(.closing) [data-r="0"]'), '取消');
        await wait(200);
        o.push('    取消后速记仍为 ' + TOOL.notes.length + ' 条（应还是 0）');
      }
      o.push('[L2] 底部「清空全部内容」按钮 = ' + !!q('[data-act="reset-content"]'));

      /* ================= M. 落盘检查 ================= */
      o.push('[M] localStorage 键存在：asks = ' + (readLs('juzhen.asks') !== null)
        + ' · askTpl = ' + (readLs('juzhen.askTpl') !== null)
        + ' · 集合总数 = ' + COLLECTIONS.length);

      o.push('[N] 运行期异常 = ' + (errs.length ? errs.join(' | ') : '无'));
    } catch (ex){
      o.push('[!] 探针抛错：' + ex.message + ' @ ' + String(ex.stack || '').split('\\n')[1]);
    }
    done();
  }, 1500);
});
</script>
</body>`;
html = html.replace('</body>', probe);
const f = path.join(dir, '_probe22.html');
fs.writeFileSync(f, html, 'utf8');

const out = cp.execFileSync(chrome, ['--headless=old','--disable-gpu','--hide-scrollbars',
  '--window-size=1600,1000','--virtual-time-budget=120000','--dump-dom',
  'file:///' + f.replace(/\\/g,'/') + '#theme=sunny&page=today&noOnboard=1'],
  { encoding:'utf8', maxBuffer:1<<28 });
const m = out.match(/<pre id="probe-out">([\s\S]*?)<\/pre>/);
const res = m ? m[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&') : 'PROBE 未执行';
fs.writeFileSync(path.join(dir, '_probe22.txt'), res, 'utf8');
console.log(res);
