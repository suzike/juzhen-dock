/* ============================================================
   端到端「用户走查」探针
   ------------------------------------------------------------
   用户原话：
     "每一个功能你都要基于真实的工程师或者用户去用这个功能，
      去真正的走一遍。就是每个功能你都要让它可编辑吧，
      你不可能说我放了一个没有入口，每个功能都要有可操作的入口，
      可编辑、可自定义。"

   所以这个探针不数入口个数（那是 _probe18 干的事），而是**真的动手做**：
   对 FORMS 里登记的每一个 kind，依次走
        打开页面 → 找到新增入口 → 填表提交 → 校验内存+落盘
        → 打开该条目的 ⋯ → 选"编辑" → 改一个字 → 保存 → 校验
        → ⋯ → 选"删除" → 确认 → 校验回到原样
   任何一步拿不到元素、或者数量/落盘没跟上，都如实记成缺口。

   另外盘一次"可自定义"：设置页每一行是什么、有没有缺项。
   ============================================================ */
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
      for (var i = 0; i < (tries || 120); i++){ if (fn()) return true; await wait(15); }
      return !!fn();
    };
    var q = function(s){ return document.querySelector(s); };
    var all = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };
    var has = function(s){ return !!document.querySelector(s); };
    var click = function(el, what){
      if (!el){ o.push('      [!] 找不到元素：' + (what || '(未说明)')); return false; }
      el.dispatchEvent(new MouseEvent('click', { bubbles:true })); return true;
    };
    var goPage = function(id){ if (state.query) exitSearch(false); switchPage(id); };
    var mpIn  = function(){ return all('.minip:not(.closing) .mp-in'); };
    var mpOk  = function(){ return q('.minip:not(.closing) [data-r="1"]'); };
    var mpShut = function(){ var b = q('.minip:not(.closing) [data-r="0"]'); if (b) b.click(); };
    var fireInput = function(el, v){ el.value = v; el.dispatchEvent(new Event('input', { bubbles:true })); };
    var lsOf = function(key){ try { var r = localStorage.getItem(key); return r == null ? null : JSON.parse(r); } catch(e){ return null; } };
    /* 落盘键必须问 COLLECTIONS 要，不能自己拼 'juzhen.' + key ——
       board 的键是历史遗留的 juzhen.board.v2，拼出来的名字根本不存在，
       于是"落盘一致"永远报 false。这种探针自己拼键名写出来的假警报，
       比不写还糟：它会让人去改一个本来就对的模块。 */
    var lskOf = function(kk){
      return (typeof COL_MAP !== 'undefined' && COL_MAP[kk] && COL_MAP[kk].ls) || ('juzhen.' + kk);
    };
    var sawMove = false;
    var closeCtx = function(){ if (has('#ctx.show')) { document.body.click(); } };
    /* 在已打开的 ⋯ 菜单里按关键词点一项 */
    var ctxPick = function(words){
      var its = all('#ctx.show .ctx-item');
      for (var i = 0; i < its.length; i++){
        var t = its[i].textContent;
        for (var j = 0; j < words.length; j++) if (t.indexOf(words[j]) >= 0){ its[i].click(); return t.trim(); }
      }
      return null;
    };
    var ctxList = function(){ return all('#ctx.show .ctx-item').map(function(e){ return e.textContent.trim(); }); };
    /* 页面里带某段文字的条目行 */
    var rowOf = function(txt){
      return all('[data-kind]').filter(function(r){
        return r.textContent.indexOf(txt) >= 0; })[0];
    };

    try {
      openPanel();
      o.push('===== 一、逐个功能：真实走一遍 新增 → 编辑 → 删除 =====');
      var kinds = Object.keys(FORMS);
      o.push('FORMS 登记的功能数 = ' + kinds.length + '：' + kinds.join(', '));
      var fails = [];

      for (var ki = 0; ki < kinds.length; ki++){
        var k = kinds[ki], F = FORMS[k];
        var list = F.list();
        var n0 = list.length;
        var sent = '走查-' + k + '-A';
        var sent2 = '走查-' + k + '-B';
        var ln = [];
        o.push('');
        o.push('--- [' + (ki + 1) + '/' + kinds.length + '] ' + k + '（' + F.label + ' · 页面 ' + F.page + ' · 当前 ' + n0 + ' 条）---');

        /* ① 打开页面 */
        goPage(F.page);
        await wait(60);

        /* ② 新增：按"这个 kind 自己的入口"找，不要按页面找。
           ask 页上住着两个集合（ask 与 askTpl），页头「+」只属于其中一个；
           直接拿 HEAD_ACT[page] 去点，就会拿 askTpl 的名字去点 ask 的按钮，
           然后报一句"askTpl 新增失败" —— 错的不是产品，是找法。
           顺序：分组头「+」（GROUP_ADD 里 kind → act，最精确）
               → 页头「+」（仅当这一页只有它一个集合，或动作名点明了这个 kind）
               → kind 拼出来的 act（如 board-new） */
        var samePage = Object.keys(FORMS).filter(function(x){ return FORMS[x].page === F.page; });
        var headAct = (typeof HEAD_ACT !== 'undefined') ? HEAD_ACT[F.page] : null;
        var cands = [];
        if (typeof GROUP_ADD !== 'undefined' && GROUP_ADD[k]) cands.push(GROUP_ADD[k]);
        if (headAct && (samePage.length === 1 || String(headAct).indexOf(k) >= 0
            || String(headAct).indexOf(F.coll) >= 0) && cands.indexOf(headAct) < 0) cands.push(headAct);
        if (cands.indexOf(k + '-new') < 0) cands.push(k + '-new');
        if (cands.indexOf('ask-tpl-new') < 0) cands.push('ask-tpl-new');
        var addBtn = null, usedAct = null;
        for (var ci2 = 0; ci2 < cands.length && !addBtn; ci2++){
          var bb = q('.page[data-page="' + F.page + '"] [data-act="' + cands[ci2] + '"]')
                || q('[data-act="' + cands[ci2] + '"]');
          if (bb){ addBtn = bb; usedAct = cands[ci2]; }
        }
        ln.push('新增入口 = ' + (addBtn ? ('data-act=' + usedAct) : '★ 没有')
          + (cands.length > 1 ? '（候选：' + cands.join(', ') + '）' : ''));
        if (addBtn){
          click(addBtn, '新增入口');
          var opened = await until(function(){ return mpIn().length > 0; }, 60);
          ln.push('表单弹出 = ' + opened + ' · 字段数 = ' + mpIn().length);
          /* 速记这一类没有表单：它的"新增"就是页顶那个输入框（Ctrl+Enter 存）。
             这也是合法的入口，不能因为"没弹表单"就当成缺口跳过 —— 那等于
             没走完这条路。所以照它的真实用法走一遍：填字、Ctrl+Enter、看落盘。 */
          if (!opened && q('#noteInput') && F.coll === 'notes'){
            var ni = q('#noteInput');
            ni.value = sent;
            ni.dispatchEvent(new Event('input', { bubbles:true }));
            ni.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', ctrlKey:true, bubbles:true }));
            var grewN = await until(function(){ return F.list().length === n0 + 1; }, 60);
            var sn = lsOf(lskOf(F.coll));
            ln.push('内联输入框新增（Ctrl+Enter）：条数 ' + n0 + ' → ' + F.list().length
              + ' = ' + grewN + ' · 吐司 = ' + JSON.stringify((q('#toastMsg') || {}).textContent || ''));
            ln.push('落盘 ' + lskOf(F.coll) + ' = ' + (sn === null ? '★ 没有这个键'
              : (Array.isArray(sn) ? sn.length + ' 条' : '不是数组'))
              + ' · 与内存一致 = ' + (Array.isArray(sn) && sn.length === F.list().length));
            if (!grewN) fails.push(k + ':内联新增没生效');
          }
          if (!opened && !(F.coll === 'notes' && q('#noteInput')))
            /* 不弹表单的 kind（新增是直接动作）—— 通用走查走到这里就断了。
               必须留下一行痕迹：不留的话它是**静默跳过**的，
               报告读起来和"走完了"一模一样，而 askSess 就是这么被漏掉的。 */
            ln.push('（新增入口是直接动作、不弹表单 → 通用走查到此为止；专项走查见「一·补」）');
          if (opened){
            var ins = mpIn();
            /* 第一个必填字段填哨兵；其余必填的也补一个像样的值 */
            var fs2 = F.fields(F.blank());
            for (var fi = 0; fi < ins.length && fi < fs2.length; fi++){
              if (fi === 0) { fireInput(ins[fi], sent); continue; }
              var fl = fs2[fi];
              if (fl.req === false) continue;
              var v = '';
              if (fl.k === 'path') v = 'E:\\\\Projects\\\\Thermal\\\\' + sent;
              else if (fl.k === 'url') v = 'https://example.com/' + encodeURIComponent(sent);
              else if (fl.k === 'text') v = sent + ' 的内容';
              else v = sent;
              fireInput(ins[fi], v);
            }
            click(mpOk(), '提交新增');
            var grew = await until(function(){ return F.list().length === n0 + 1; }, 60);
            ln.push('提交后条数 ' + n0 + ' → ' + F.list().length + ' = ' + grew
              + ' · 吐司 = ' + JSON.stringify((q('#toastMsg') || {}).textContent || ''));
            /* 落盘 */
            var saved = lsOf(lskOf(F.coll));
            var onDisk = Array.isArray(saved) && saved.length === F.list().length;
            ln.push('落盘 ' + lskOf(F.coll) + ' = ' + (saved === null ? '★ 没有这个键'
              : (Array.isArray(saved) ? saved.length + ' 条' : '不是数组')) + ' · 与内存一致 = ' + onDisk);
            if (!grew || !onDisk) fails.push(k + ':新增');

            /* ③ 编辑：找到刚加的条目 → ⋯ → 编辑 */
            var target = rowOf(sent);
            ln.push('新条目在页面里可见 = ' + !!target);
            var more = target && target.querySelector('.ctx-more');
            ln.push('该条目有 ⋯ 入口 = ' + !!more);
            if (more){
              click(more, '条目的 ⋯');
              await until(function(){ return has('#ctx.show'); }, 40);
              var menu = ctxList();
              ln.push('⋯ 菜单 = ' + menu.join(' / '));
              /* 上下移只活在 ⋯ 菜单里，不在静态 DOM 里。所以"排序能力"
                 的判据必须从**真的打开过的菜单**里取，不能去 document 里
                 querySelector('[data-act*=up]') —— 那必然扫不到，扫不到就说"无"。 */
              if (menu.join(' ').indexOf('上移') >= 0) sawMove = true;
              var picked = ctxPick(['改', '编辑']);
              if (!picked){ ln.push('★ 菜单里没有"编辑"'); fails.push(k + ':没有编辑项'); }
              else {
                await until(function(){ return mpIn().length > 0; }, 60);
                var e0 = F.list().length;
                var ins2 = mpIn();
                if (ins2.length){ fireInput(ins2[0], sent2); }
                click(mpOk(), '保存编辑');
                var edited = await until(function(){ return rowOf(sent2) !== undefined; }, 60);
                ln.push('改名后在页面里查到 = ' + !!edited
                  + ' · 条数 ' + e0 + ' → ' + F.list().length + '（编辑不应改变条数）');
                if (!edited) fails.push(k + ':编辑没生效');
              }
            } else fails.push(k + ':条目无 ⋯');

            /* ④ 删除：找回条目 → ⋯ → 删除 → 确认 */
            var cur = F.list().length;
            var t2 = rowOf(sent2) || rowOf(sent);
            var more2 = t2 && t2.querySelector('.ctx-more');
            if (more2){
              click(more2, '条目的 ⋯');
              await until(function(){ return has('#ctx.show'); }, 40);
              var del = ctxPick(['删除', '删掉', '移出', '移除']);
              ln.push('删除项 = ' + JSON.stringify(del));
              if (!del){ fails.push(k + ':没有删除项'); }
              else {
                await until(function(){ return has('.minip:not(.closing) [data-r="1"]'); }, 60);
                var confirmed = has('.minip:not(.closing)');
                click(mpOk(), '确认删除');
                var shrunk = await until(function(){ return F.list().length === cur - 1; }, 60);
                var s2 = lsOf(lskOf(F.coll));
                ln.push('确认框 = ' + confirmed + ' · 删除后 ' + cur + ' → ' + F.list().length
                  + ' = ' + shrunk + ' · 落盘 ' + (Array.isArray(s2) ? s2.length : '?') + ' 条');
                if (!shrunk) fails.push(k + ':删除没生效');
              }
            }
          }
        } else fails.push(k + ':没有新增入口');

        ln.forEach(function(s){ o.push('    ' + s); });
        closeCtx(); mpShut(); await wait(30);
      }

      /* ================= 一·补、不在 FORMS 里的可编辑对象 =================
         FORMS 只登记"走多字段表单"的那 11 类。场景是另一套：它走
         askText / askPick / askConfirm 三个小浮层，所以 FORMS 那套循环
         一个都覆盖不到它。但"每个功能都能改"这句话，不能只对 FORMS 里的
         东西成立 —— 场景也是一个功能。这一节把它也真的走一遍：
           新建场景 → 看到卡片 → ⋯ 改名字 → ⋯ 添加一个动作
           → 动作条上的 ⋯ 删掉这个动作 → ⋯ 删掉这个场景 */
      o.push('');
      o.push('===== 一·补、非表单类可编辑对象（场景）=====');
      try {
        var sc0 = TOOL.scenes.length;
        var SN = '走查-场景-A', SN2 = '走查-场景-B';
        var tx = function(){ return q('.minip:not(.closing) input.mp-in'); };
        var okBtn = function(){ return q('.minip:not(.closing) [data-r="1"]'); };
        goPage('scene');
        await wait(80);

        /* 新建 */
        var nw = q('[data-act="scene-new"]');
        o.push('  [1] 新建场景入口 = ' + (nw ? 'data-act=scene-new' : '★ 没有'));
        if (nw){
          click(nw, '新建场景');
          await until(function(){ return tx(); }, 60);
          if (tx()) fireInput(tx(), SN);
          click(okBtn(), '确定');
          var grewS = await until(function(){ return TOOL.scenes.length === sc0 + 1; }, 60);
          var scDisk = lsOf(lskOf('scenes'));
          o.push('      提交后场景数 ' + sc0 + ' → ' + TOOL.scenes.length + ' = ' + grewS
            + ' · 落盘 ' + lskOf('scenes') + ' = ' + (Array.isArray(scDisk) ? scDisk.length + ' 条' : '?'));
          if (!grewS) fails.push('scene:新建没生效');
        }

        var scardOf = function(nm, sels){
          return all(sels).filter(function(r){ return r.textContent.indexOf(nm) >= 0; })[0];
        };

        /* 卡片 + 改名 */
        var card = scardOf(SN, '[data-kind="sceneCard"]');
        o.push('  [2] 新场景卡片可见 = ' + !!card
          + ' · 卡片有 ⋯ = ' + !!(card && card.querySelector('.ctx-more')));
        if (card){
          click(card.querySelector('.ctx-more'), '场景卡 ⋯');
          await until(function(){ return has('#ctx.show'); }, 40);
          o.push('      卡片 ⋯ 菜单 = ' + ctxList().join(' / '));
          if (!ctxPick(['改名字'])) fails.push('scene:卡片没有改名');
          else {
            await until(function(){ return tx(); }, 60);
            if (tx()) fireInput(tx(), SN2);
            click(okBtn(), '确定');
            var ren = await until(function(){
              return TOOL.scenes.some(function(s){ return s.name === SN2; }); }, 60);
            o.push('      改名生效 = ' + ren + '（' + SN + ' → ' + SN2 + '）');
            if (!ren) fails.push('scene:改名没生效');
          }
        }

        /* 加一个动作 */
        var sObj = TOOL.scenes.filter(function(s){ return s.name === SN2; })[0];
        var na0 = sObj ? sObj.acts.length : -1;
        var c2 = scardOf(SN2, '[data-kind="sceneCard"]');
        if (c2){
          click(c2.querySelector('.ctx-more'), '场景卡 ⋯');
          await until(function(){ return has('#ctx.show'); }, 40);
          if (!ctxPick(['添加一个动作'])) fails.push('scene:卡片没有添加动作');
          else {
            var gotOpts = await until(function(){ return has('.minip:not(.closing) .mp-opt'); }, 60);
            var opts = all('.minip:not(.closing) .mp-opt');
            o.push('  [3] 添加动作 · 选类型浮层 = ' + gotOpts + ' · ' + opts.length + ' 项（'
              + opts.map(function(e){ return e.textContent.trim(); }).join(' / ') + '）');
            /* 选第三项（打开一个网址）—— 浏览器里它走 askText 那条路，
               folder/file 走系统对话框，探针里调不出来。 */
            click(opts[2], '打开一个网址');
            await until(function(){ return tx(); }, 60);
            if (tx()) fireInput(tx(), 'https://example.com/scene-walkthrough');
            click(okBtn(), '确定');
            var addA = await until(function(){ return sObj && sObj.acts.length === na0 + 1; }, 60);
            o.push('      动作 ' + na0 + ' → ' + (sObj ? sObj.acts.length : '?') + ' = ' + addA
              + ' · 落盘 ' + (Array.isArray(lsOf(lskOf('scenes'))) ? lsOf(lskOf('scenes')).length + ' 条' : '?'));
            if (!addA) fails.push('scene:动作新增没生效');
          }
        }

        /* 动作条：可见的 ⋯ + 单条执行 */
        var chip = all('[data-kind="sceneAct"]').filter(function(r){
          return r.getAttribute('data-sid') === (sObj || {}).id
            && r.textContent.indexOf('scene-walkthrough') >= 0; })[0];
        var chipAny = all('[data-kind="sceneAct"]').filter(function(r){
          return r.getAttribute('data-sid') === (sObj || {}).id; })[0];
        o.push('  [4] 动作条有 ⋯ 入口 = ' + !!(chip || chipAny)
          + (chipAny && chipAny.querySelector('.ctx-more') ? '（常态可见）' : '（★ 只有右键）')
          + ' · 动作条自己可点（只跑这一个）= '
          + ((chipAny || {}).dataset && (chipAny.dataset.act === 'scene-one') ? '是' : '否'));
        if (!(chipAny && chipAny.querySelector('.ctx-more'))) fails.push('sceneAct:没有可见 ⋯');

        /* 删掉这个动作 */
        var na1 = sObj ? sObj.acts.length : -1;
        var c3 = scardOf(SN2, '[data-kind="sceneCard"]');
        var chip2 = all('[data-kind="sceneAct"]').filter(function(r){
          return r.getAttribute('data-sid') === (sObj || {}).id
            && r.textContent.indexOf('scene-walkthrough') >= 0; })[0]
          || chipAny;
        if (chip2 && chip2.querySelector('.ctx-more')){
          click(chip2.querySelector('.ctx-more'), '动作条 ⋯');
          await until(function(){ return has('#ctx.show'); }, 40);
          o.push('      动作条 ⋯ 菜单 = ' + ctxList().join(' / '));
          if (!ctxPick(['删掉这个动作'])) fails.push('sceneAct:菜单里没有删除');
          else {
            var delA = await until(function(){ return sObj && sObj.acts.length === na1 - 1; }, 60);
            o.push('      删除动作 ' + na1 + ' → ' + (sObj ? sObj.acts.length : '?') + ' = ' + delA
              + ' · 落盘 ' + (Array.isArray(lsOf(lskOf('scenes'))) ? lsOf(lskOf('scenes')).length + ' 条' : '?'));
            if (!delA) fails.push('sceneAct:删除没生效');
          }
        }

        /* 删掉这个场景 */
        var sc1 = TOOL.scenes.length;
        var c4 = scardOf(SN2, '[data-kind="sceneCard"]');
        if (c4){
          click(c4.querySelector('.ctx-more'), '场景卡 ⋯');
          await until(function(){ return has('#ctx.show'); }, 40);
          if (!ctxPick(['删掉这个场景'])) fails.push('scene:卡片没有删除');
          else {
            await until(function(){ return has('.minip:not(.closing) [data-r="1"]'); }, 60);
            click(q('.minip:not(.closing) [data-r="1"]'), '确认删除');
            var delS = await until(function(){ return TOOL.scenes.length === sc1 - 1; }, 60);
            o.push('  [5] 删除场景 ' + sc1 + ' → ' + TOOL.scenes.length + ' = ' + delS
              + ' · 落盘 ' + (Array.isArray(lsOf(lskOf('scenes'))) ? lsOf(lskOf('scenes')).length + ' 条' : '?'));
            if (!delS) fails.push('scene:删除没生效');
          }
        }
      } catch (ex2){
        o.push('  [!] 场景走查抛错：' + ex2.message);
        fails.push('scene:走查中断');
      }
      closeCtx(); mpShut(); await wait(40);

      /* ================= 一·补、问答会话（askSess）专项走查 =================
         为什么单独一段：这一个 kind 的「新增」是直接动作（点一下就把新会话开出来），
         不弹表单，所以通用那段走不进来；而它不报缺口。
         通用走查 + 专项走查合起来才算把这一类走完。 */
      o.push('');
      o.push('===== 一·补、问答会话（askSess）专项走查 =====');
      try {
        goPage('ask');
        await wait(80);
        var ss0 = TOOL.askSess.length;
        var ssBtn = q('[data-act="ask-sess-new"]');
        o.push('  新增入口 = ' + (ssBtn ? '有（ask-sess-new，分组头 + 与会话条上各一处）' : '★ 没有'));
        if (!ssBtn) fails.push('askSess:没有新增入口');
        else {
          click(ssBtn, '新会话');
          await wait(80);
          var ssToast = String((q('#toastMsg') || {}).textContent || '');
          var ssGrew = TOOL.askSess.length === ss0 + 1;
          /* 「当前这段还空着就沿用它」是设计过的行为（连点三下不该攒出三段空会话），
             所以这里不能只认"条数 +1" —— 那不是缺口，是它该有的样子。 */
          var ssReuse = !ssGrew && ssToast.indexOf('还空着') >= 0;
          o.push('  条数 ' + ss0 + ' → ' + TOOL.askSess.length
            + (ssGrew ? '（新开一段）' : ssReuse ? '（当前这段还空着，按设计沿用）' : ' ★ 既没新增也没沿用')
            + ' · 吐司 = ' + JSON.stringify(ssToast));
          if (!ssGrew && !ssReuse) fails.push('askSess:新增没生效');

          var ssRow = q('.sess-row'), ssMore = ssRow && ssRow.querySelector('.ctx-more');
          o.push('  会话行有可见 ⋯ = ' + !!ssMore);
          if (!ssMore) fails.push('askSess:会话行没有 ⋯');
          else {
            click(ssMore, '会话行 ⋯');
            await until(function(){ return has('#ctx.show'); }, 40);
            o.push('  ⋯ 菜单 = ' + ctxList().join(' / '));
            if (!ctxPick(['重命名'])) fails.push('askSess:没有重命名项');
            else {
              await until(function(){ return mpIn().length > 0; }, 60);
              var ssIns = mpIn();
              o.push('  重命名表单 = ' + ssIns.length + ' 个字段');
              if (ssIns.length) fireInput(ssIns[0], '走查-会话-改名');
              click(mpOk(), '保存改名');
              var ssRen = await until(function(){
                return TOOL.askSess.some(function(s){ return s.title === '走查-会话-改名'; }); }, 60);
              var ssDisk = lsOf(lskOf('askSess'));
              o.push('  改名生效 = ' + ssRen + ' · 落盘 = '
                + (Array.isArray(ssDisk) ? ssDisk.length + ' 条' : '★ 不是数组'));
              if (!ssRen) fails.push('askSess:改名没生效');
            }
            var ssCur = TOOL.askSess.length;
            var ssRow2 = q('.sess-row'), ssMore2 = ssRow2 && ssRow2.querySelector('.ctx-more');
            if (ssMore2){
              click(ssMore2, '会话行 ⋯（删除）');
              await until(function(){ return has('#ctx.show'); }, 40);
              if (!ctxPick(['删掉'])) fails.push('askSess:没有删除项');
              else {
                await until(function(){ return has('.minip:not(.closing) [data-r="1"]'); }, 60);
                var ssWarn = String((q('.minip:not(.closing) .mp-msg') || {}).textContent || '');
                click(mpOk(), '确认删除');
                var ssShrunk = await until(function(){ return TOOL.askSess.length === ssCur - 1; }, 60);
                o.push('  确认框正文 = ' + JSON.stringify(ssWarn.slice(0, 60))
                  + ' · 删除后 ' + ssCur + ' → ' + TOOL.askSess.length + ' = ' + ssShrunk);
                if (!ssShrunk) fails.push('askSess:删除没生效');
              }
            }
          }
        }
      } catch (ex3){
        o.push('  [!] 会话走查抛错：' + ex3.message);
        fails.push('askSess:走查中断');
      }
      closeCtx(); mpShut(); await wait(40);
      /* ================= 二、可自定义盘点 ================= */
      o.push('');
      o.push('===== 二、可自定义（设置页逐行盘点）=====');
      goPage('settings');
      await wait(120);
      var rows = all('.set-row');
      o.push('设置页可调项 = ' + rows.length + ' 行');
      rows.forEach(function(r){
        var l = r.querySelector('.set-label');
        var h = r.querySelector('.set-hint');
        var c = r.querySelector('input,select,button,.switch');
        var dis = r.classList.contains('set-na') || (r.querySelector('.set-na'));
        o.push('    · ' + (l ? l.textContent : '(无标题)')
          + ' ｜ 控件=' + (c ? (c.tagName.toLowerCase() + (c.type ? ':' + c.type : '')) : '★无')
          + ' ｜ 未实现=' + (dis ? '是' : '否')
          + (h ? ' ｜ ' + h.textContent.slice(0, 42) : ''));
      });

      /* ================= 三、全局能力盘点 ================= */
      o.push('');
      o.push('===== 三、全局能力 =====');
      o.push('  THEMES 主题数 = ' + THEMES.length + '（' + THEMES.map(function(t){ return t.name; }).join(' / ') + '）');
      o.push('  每主题色相数 = ' + THEMES.map(function(t){ return t.hues.length; }).join(' / ')
        + ' ← 这只是主题里定义了几个色，不等于页面上真用了几种');
      o.push('  vars() 形参个数 = ' + (typeof vars === 'function' ? vars.length : '?')
        + ' ← 0 = 全局单色（条目/分组不再各自取色，配色已收敛）；>0 就是按条目染色，会花');
      o.push('  applyTheme 里第二~四强调色 = '
        + (typeof THEMES[0].hues !== 'undefined' ? '已改为 ink 系（不再借别家色相）' : '?'));
      o.push('  轻量/紧凑模式 = ' + ["侧栏仅图标", "边缘热区", "全屏屏蔽"].join(' / '));
      o.push('  条目排序能力：拖拽=' + (typeof sortable !== 'undefined' ? '有' : '无')
        + ' · 置顶=' + (all('[data-act*="pin"]').length ? '有' : '无')
        + ' · 上下文排序=' + (sawMove ? '有（⋯ 菜单里的「上移一位 / 下移一位」）' : '无')
        + ' · withMove=' + (typeof withMove === 'function' ? '已接线' : '未接线'));
      o.push('  分组重命名：' + (all('[data-act*="group"], [data-act*="rename"]').length ? '有' : '无（分组是派生的）'));

      /* ---------- 可见入口审计 ----------
         ctxFor 里登记了菜单的 kind，页面上每一处都必须有**看得见**的 ⋯。
         "只有右键 = 没有入口"是用户明确否掉过的做法，所以这条要能自动查，
         否则每加一个新板块都会重新犯一次。 */
      o.push('');
      o.push('  可见入口审计（有右键菜单的地方，都要有看得见的 ⋯）：');
      var KIND_MENU = ['folder','link','clip','recent','file','board','todo','note','shot','snip',
                       'sceneAct','sceneCard','ask','askTpl','askSess'];
      var cov = {};
      var pgIds = Object.keys(PAGE_MAP).filter(function(x){ return x !== 'settings'; });
      for (var pi = 0; pi < pgIds.length; pi++){
        goPage(pgIds[pi]);
        await wait(50);
        KIND_MENU.forEach(function(kk){
          all('[data-kind="' + kk + '"]').forEach(function(el){
            cov[kk] = cov[kk] || { n:0, more:0 };
            cov[kk].n++;
            if (el.querySelector('.ctx-more') || el.classList.contains('ctx-more')) cov[kk].more++;
          });
        });
      }
      var covBad = [];
      KIND_MENU.forEach(function(kk){
        var c = cov[kk];
        if (!c){ o.push('    · ' + kk + ' = 本次没在页面上遇到（跳过）'); return; }
        var good = c.more === c.n;
        o.push('    · ' + kk + ' = ' + c.n + ' 处 · 有可见 ⋯ 的 ' + c.more + ' 处'
          + (good ? ' ✓' : ' ★ ' + (c.n - c.more) + ' 处只能右键'));
        if (!good) covBad.push(kk + '(' + (c.n - c.more) + '处只能右键)');
      });
      if (covBad.length) fails.push('可见入口:' + covBad.join('/'));

      /* 搜索结果行也必须有 ⋯，而且点它不能把搜索态弄丢。
         注意行分两类：一类是"板块"（data-act="go"，纯跳转，没有东西可管理，
         本来就不该有 ⋯）；另一类带 data-kind，是真实记录，必须有 ⋯。
         所以判据是"带 data-kind 的行数 == 有 ⋯ 的行数"，不是"行数 == ⋯ 数"。 */
      var qEl = q('#q');
      if (qEl){
        var kw = (DATA.folders[0] || {}).name || 'a';
        qEl.value = String(kw).slice(0, 1);
        qEl.dispatchEvent(new Event('input', { bubbles:true }));
        await wait(120);
        var srowsAll = all('.sres .row');
        var srowsKind = srowsAll.filter(function(r){ return r.hasAttribute('data-kind'); });
        var srowsMore = srowsAll.filter(function(r){ return r.querySelector('.ctx-more'); });
        o.push('    搜索「' + String(kw).slice(0,1) + '」结果 = ' + srowsAll.length + ' 行'
          + '（带 data-kind 的 ' + srowsKind.length + ' 行 · 有可见 ⋯ 的 ' + srowsMore.length + ' 行）'
          + (srowsKind.length && srowsKind.length === srowsMore.length ? ' ✓' : ' ★ 对不上'));
        o.push('      分组 = ' + all('.sres .gcard-nm').map(function(e){ return e.textContent; }).join(' / '));
        if (!srowsKind.length) fails.push('搜索结果行:这次一条都没命中，判据空转');
        else if (srowsKind.length !== srowsMore.length) fails.push('搜索结果行:有记录行没有 ⋯');
        if (srowsMore.length){
          /* 注意点的是行**里面**那个 ⋯，不是行本身 —— 第一版这里写成了
             把 srowsMore[0]（一个 .row）丢进 click()，于是点的是"执行这一条"，
             搜索态被顶掉，探针报了个假缺口。探针自己也会写出假警报。 */
          click(srowsMore[0].querySelector('.ctx-more'), '搜索结果行的 ⋯');
          await until(function(){ return has('#ctx.show'); }, 40);
          o.push('      点 ⋯ 后：菜单弹出 = ' + has('#ctx.show')
            + ' · 仍在搜索态 = ' + !!state.query + '（不该被"执行这一条"顶掉）'
            + ' · 菜单 = ' + ctxList().join(' / '));
          if (!has('#ctx.show') || !state.query) fails.push('搜索结果行:⋯ 打不开菜单');
          closeCtx();
          await wait(40);
        }
        /* 顺带把"点行本身 = 执行这一条"也走一遍：搜索态下点第一行，
           应当退出搜索并把那条动作执行掉（这里是文件夹 → 打开提示）。 */
        var firstKindRow = srowsKind[0];
        if (firstKindRow){
          click(firstKindRow, '搜索结果行本身');
          await until(function(){ return !state.query; }, 60);
          o.push('      点行本身：退出搜索 = ' + !state.query
            + ' · 吐司 = ' + JSON.stringify((q('#toastMsg') || {}).textContent || ''));
          if (state.query) fails.push('搜索结果行:点行没有退出搜索');
        }
        exitSearch(true);
        await wait(60);
      }

      o.push('');
      o.push('===== 四、结论 =====');
      o.push('  走查缺口 = ' + (fails.length ? fails.join(' ｜ ') : '无'));
      o.push('  运行期异常 = ' + (errs.length ? errs.join(' | ') : '无'));
    } catch (ex){
      o.push('[!] 探针抛错：' + ex.message + ' @ ' + String(ex.stack || '').split('\\n')[1]);
    }
    done();
  }, 1400);
});
</script>
</body>`;
html = html.replace('</body>', probe);
const f = path.join(dir, '_probe23.html');
fs.writeFileSync(f, html, 'utf8');

const out = cp.execFileSync(chrome, ['--headless=old','--disable-gpu','--hide-scrollbars',
  '--window-size=1600,1000','--virtual-time-budget=180000','--dump-dom',
  'file:///' + f.replace(/\\/g,'/') + '#theme=sunny&page=today&noOnboard=1'],
  { encoding:'utf8', maxBuffer:1<<28 });
const m = out.match(/<pre id="probe-out">([\s\S]*?)<\/pre>/);
const res = m ? m[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&') : 'PROBE 未执行';
fs.writeFileSync(path.join(dir, '_probe23.txt'), res, 'utf8');
console.log(res);
