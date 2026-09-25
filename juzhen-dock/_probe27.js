/* ============================================================
   三个改动的运行期验证（2026-09-22 第二轮）
   ------------------------------------------------------------
   ① 面板不透明度可调
   ② 右键菜单能取消 —— 用户报的 bug：
        "我右键了一下，但我不想操作了，右键的东西一直在那悬着"
      原来只有 Esc / 点菜单项 / 滚动三条出路，且 closeCtx() 挂在
      closePanel() 里那条被 pinned 提前 return 掉的分支后面。
   ③ 9 套主题（含 6 套传统配色）与色阶补齐

   每条都给判据，不只是"跑了一遍没报错"。
   ============================================================ */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = __dirname;
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let html = fs.readFileSync(path.join(dir, 'prototype.html'), 'utf8');
const probe = `
<script>
window.addEventListener('load', function(){
  setTimeout(async function(){
    var arr = [], errs = [], fails = [];
    var pre = document.createElement('pre'); pre.id = 'probe-out';
    document.body.appendChild(pre);
    var o = { push: function(s){ arr.push(String(s)); pre.textContent = arr.join('\\n'); } };
    window.addEventListener('error', function(e){ errs.push(String(e.message)); });
    var done = function(){ pre.textContent = arr.join('\\n') + '\\n(END)'; };
    var wait = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
    var q = function(s){ return document.querySelector(s); };
    var all = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };
    var has = function(s){ return !!document.querySelector(s); };
    var cs = function(k){ return getComputedStyle(document.documentElement).getPropertyValue(k).trim(); };
    var click = function(el){ if (el) el.dispatchEvent(new MouseEvent('click', { bubbles:true })); };
    /* mousedown 要真的派发 —— 收起菜单靠的就是它；用 .click() 试不出来
       （那正是原来漏掉一整个事件类型的原因）。 */
    var mdown = function(el){ if (el) el.dispatchEvent(new MouseEvent('mousedown', { bubbles:true })); };
    var leave = function(el){ if (el) el.dispatchEvent(new MouseEvent('mouseleave', { bubbles:false })); };
    var fireInput = function(el, v){ el.value = v; el.dispatchEvent(new Event('input', { bubbles:true })); };
    var alphaOf = function(v){
      var m = /rgba?\\(([^)]+)\\)/.exec(v); if (!m) return null;
      var p = m[1].split(','); return p.length > 3 ? +p[3].trim() : 1;
    };
    var ctxOpen = function(){ return has('#ctx.show'); };
    var openMenu = function(){
      var m = q('.row[data-kind="folder"] .ctx-more') || q('[data-kind] .ctx-more');
      if (!m){ o.push('  [!] 找不到任何一个 ⋯，菜单相关断言全部作废'); return false; }
      click(m); return ctxOpen();
    };
    var ok = function(cond, label, extra){
      o.push('  ' + (cond ? '[ok] ' : '[!!] ') + label + (extra ? '   ' + extra : ''));
      if (!cond) fails.push(label);
    };
    var goPage = function(id){ if (state.query) exitSearch(false); switchPage(id); };

    try {
      /* ================= 一、面板不透明度 ================= */
      o.push('===== 一、面板不透明度可调 =====');
      ok(state.settings.glass === 60, '默认值 = 60（= 原来写死的那一档，老存档观感不变）',
         'glass=' + state.settings.glass);

      /* 先回设置页，两根滑杆都要在 */
      goPage('settings'); await wait(120);
      var s1 = all('[data-range="glass"]');
      ok(s1.length >= 1, '设置页有不透明度滑杆', s1.length + ' 根');

      var slider = q('.set-row [data-range="glass"]') || s1[0];
      var delayBefore = state.delay, delaySlider = q('[data-range="delay"]');

      var cases = [
        { v:30, panel:.30, surf:.26, blur:56 },
        { v:60, panel:.60, surf:.56, blur:42 },
        { v:100, panel:1,  surf:.96, blur:24 }
      ];
      cases.forEach(function(c){
        fireInput(slider, c.v);
        var panelA = alphaOf(cs('--panel-bg')), surfA = alphaOf(cs('--surf'));
        var blur = cs('--blur-panel');
        var good = Math.abs(panelA - c.panel) < .011 && Math.abs(surfA - c.surf) < .011
                && blur === c.blur + 'px';
        ok(good, '拖到 ' + c.v + '% → 面板底 alpha / 常规面 alpha / 模糊 三者一起动',
           '底=' + panelA + '（期望 ' + c.panel + '）· 面=' + surfA + '（期望 ' + c.surf
           + '）· 模糊=' + blur + '（期望 ' + c.blur + 'px）');
      });

      /* 拖透明度绝不能顺手改掉别的设置 ——
         原来那段处理里无条件写 state.delay，是因为当时全站只有一根滑杆。 */
      ok(state.delay === delayBefore, '拖不透明度没有连带改掉「热区停留时延」',
         'delay 仍为 ' + state.delay);
      /* 这条查的是"滑杆能不能如实表示当前值"。
         min=120 step=30 时 250 不在格点上，浏览器会吸附成 240 ——
         设置页就此显示 240、实际却生效 250。探针第一次跑就是这么抓出来的。 */
      ok(!!delaySlider && +delaySlider.value === state.delay,
         '时延滑杆能如实表示当前值（step 落在格点上）',
         'state.delay=' + state.delay + ' · 滑杆读回=' + (delaySlider ? delaySlider.value : 'n/a'));

      /* 两根滑杆（设置页 + 主题弹层）必须同步 */
      fireInput(slider, 45);
      var other = q('.tpop [data-range="glass"]');
      var lbl = all('.glass-val').map(function(x){ return x.textContent; }).join(' / ');
      ok(!!other && +other.value === 45 && lbl.indexOf('45%') >= 0,
         '主题弹层里那根滑杆与设置页同步', '另一根=' + (other ? other.value : 'n/a') + ' · 值标签=' + lbl);

      /* 滑杆要能落盘：重启之后得还在。
         键名**必须问被测代码要**（LS_SET），不能自己拼 —— 这个项目的键是
         juzhen.settings.v2，探针第一版拼的 'juzhen.settings' 根本不存在，
         于是报了个"没落盘"的假警报。 */
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem(LS_SET)); } catch(e){}
      ok(!!saved && saved.glass === 45, '选择写进存档（下次启动还在）',
         '键 ' + LS_SET + ' 里的 glass=' + (saved ? saved.glass : 'n/a'));
      fireInput(slider, 60);   /* 还原 */

      /* ================= 二、右键菜单能取消 ================= */
      o.push('');
      o.push('===== 二、右键菜单的每一条出路 =====');
      goPage('folders'); await wait(150);

      var opened = openMenu();
      ok(opened, '① 点 ⋯ 能开菜单', '菜单项 = ' + all('#ctx .ctx-item').map(function(x){ return x.textContent.trim(); }).join(' / '));

      /* —— 用户报的那一条：点空白处 —— */
      mdown(q('.page') || q('#panel'));
      await wait(30);
      ok(!ctxOpen(), '② 点面板空白处 → 收起');

      openMenu();
      mdown(q('#panel'));
      await wait(30);
      ok(!ctxOpen(), '③ 点面板本身 → 收起');

      /* 同一个 ⋯ 再点一下 = 收起（不该"点了没反应"） */
      var again = openMenu();
      var mEl = q('.row[data-kind="folder"] .ctx-more') || q('[data-kind] .ctx-more');
      mdown(mEl);
      var survived = ctxOpen();          /* 豁免：这一个要自己管开关 */
      click(mEl);
      await wait(30);
      ok(again && survived && !ctxOpen(),
         '④ 同一个 ⋯ 再点一下 → 收起', '按下时仍开着=' + survived + ' · 抬起后=' + ctxOpen());

      openMenu();
      document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }));
      await wait(30);
      ok(!ctxOpen(), '⑤ Esc → 收起');

      openMenu();
      window.dispatchEvent(new Event('blur'));
      await wait(30);
      ok(!ctxOpen(), '⑥ 窗口失焦（Alt+Tab 切走）→ 收起');

      openMenu();
      q('#panel').dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true }));
      await wait(30);
      ok(!ctxOpen(), '⑦ 在面板别处再右键一次 → 旧的先收起');

      /* —— 鼠标移走 —— */
      openMenu();
      leave(q('#panel'));
      leave(q('#ctx'));
      await wait(420);
      ok(!ctxOpen(), '⑧ 鼠标离开面板 → 收起（留 320ms 缓冲，够划向菜单项）');

      /* —— 钉住态：这是原来最彻底的死路 —— */
      var pinKeep = state.pinned;
      state.pinned = true;
      openMenu();
      mdown(q('#panel'));
      await wait(30);
      ok(!ctxOpen(), '⑨ 已「盯住」时点空白 → 仍能收起（原来 closePanel 在这里提前 return）');

      openMenu();
      click(q('#scrim'));
      await wait(30);
      ok(!ctxOpen(), '⑩ 已「盯住」时点遮罩 → 仍能收起（走 closePanel 那条路）');
      state.pinned = pinKeep;

      /* 菜单还能正常用完 */
      openMenu();
      var items = all('#ctx .ctx-item');
      ok(items.length > 0, '⑪ 菜单项仍在（收起逻辑没有把功能一起做掉）', items.length + ' 项');
      click(items[items.length - 1]);   /* 最后一项是危险操作 → 会弹确认 */
      await wait(60);
      var cfm = q('.minip:not(.closing) [data-r="0"]');
      ok(!ctxOpen() && !!cfm, '⑫ 点菜单项 → 菜单关掉且动作真的开始了（弹出了确认框）');
      if (cfm) cfm.click();
      await wait(80);

      /* ================= 三、主题 ================= */
      o.push('');
      o.push('===== 三、主题：9 套 / 每套 9 位色阶 =====');
      ok(THEMES.length === 9, '主题套数', THEMES.length + ' 套：' + THEMES.map(function(t){ return t.name; }).join(' · '));

      var badLen = THEMES.filter(function(t){ return t.hues.length !== 9; }).map(function(t){ return t.id; });
      ok(badLen.length === 0, '每套色阶都补齐到 9 位（有 4 处在按槽位取色，留空会取到 undefined）',
         badLen.length ? badLen.join(',') : '全部 9/9');

      var badSlot = [];
      THEMES.forEach(function(t){
        for (var i = 0; i < 9; i++){
          if (!/^#[0-9a-f]{6}$/i.test(t.hues[i])) badSlot.push(t.id + '[' + i + ']');
        }
      });
      ok(badSlot.length === 0, '9 位全是合法色值', badSlot.length ? badSlot.join(',') : 'ok');

      /* 每套都能真的切过去，并且主色真的换掉了。
         注意 --cb 是 vars() **按元素**写进内联 style 的，documentElement
         上根本没有这个变量 —— 第一版在 documentElement 上读 --cb，
         读到空串，于是 9 套全被误报成"主色不一致"。
         这里一处读 :root 的 --a1、一处读真正带内联令牌的元素。 */
      var switchBad = [];
      for (var i = 0; i < THEMES.length; i++){
        var t = THEMES[i];
        setTheme(t.id);
        await wait(30);
        goPage('folders'); await wait(70);
        var cbEl = q('[style*="--cb:"]');
        var cb = cbEl ? cbEl.style.getPropertyValue('--cb').trim().toLowerCase() : '';
        var a1 = cs('--a1').toLowerCase();
        var want = t.hues[0].toLowerCase();
        if (a1 !== want || cb !== want) switchBad.push(t.id + '(a1=' + a1 + ' cb=' + cb + ')');
      }
      ok(switchBad.length === 0, '逐套切换后主色与主题定义一致',
         switchBad.length ? switchBad.join(' ｜ ') : THEMES.map(function(t){ return t.id + '=' + t.hues[0]; }).join(' · '));

      /* 换主题必须让页面重绘（颜色是以内联 --cb 令牌写进每一页的） */
      setTheme('blue'); await wait(60);
      goPage('folders'); await wait(120);
      var cbNow = (q('.gcard[style*="--cb"]') || {}).getAttribute
        ? q('.gcard[style*="--cb"]').getAttribute('style') : '';
      ok(cbNow.indexOf('#177cb0') >= 0, '切主题后当前页重建，内联令牌跟着换',
         cbNow ? cbNow.slice(0, 60) + '…' : '(没有内联令牌)');

      /* 9 套主题的「主色」都必须是各自独立的一个色，不是同一套换个名字 */
      var uniq = {}, dup = [];
      THEMES.forEach(function(t){ if (uniq[t.hues[0]]) dup.push(t.id); uniq[t.hues[0]] = 1; });
      ok(dup.length === 0, '9 套主色互不重复', dup.length ? dup.join(',') : Object.keys(uniq).length + ' 个不同色值');

      setTheme('sunny');

      o.push('');
      o.push('===== 四、结论 =====');
      o.push('  失败项 = ' + (fails.length ? fails.join(' ｜ ') : '无'));
      o.push('  运行期异常 = ' + (errs.length ? errs.join(' | ') : '无'));
      o.push('  说明：「鼠标移走」那条是在无头环境用合成 mouseleave 验的，');
      o.push('        :hover 恒为 false，所以它验的是"计时器会到点、到点会关"，');
      o.push('        真机上手还在面板上时 :hover 为 true、不会误关 —— 这一层没法在无头里证。');
    } catch (ex){
      o.push('[!] 探针抛错：' + ex.message + ' @ ' + String(ex.stack || '').split('\\n')[1]);
      fails.push('探针抛错');
    }
    done();
  }, 1400);
});
</script>
</body>`;
html = html.replace('</body>', probe);
const f = path.join(dir, '_probe27.html');
fs.writeFileSync(f, html, 'utf8');

const out = cp.execFileSync(chrome, ['--headless=old','--disable-gpu','--hide-scrollbars',
  '--window-size=1600,1000','--virtual-time-budget=180000','--dump-dom',
  'file:///' + f.replace(/\\/g,'/') + '#theme=sunny&page=folders&noOnboard=1'],
  { encoding:'utf8', maxBuffer:1<<28 });
const m = out.match(/<pre id="probe-out">([\s\S]*?)<\/pre>/);
const res = m ? m[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&') : 'PROBE 未执行';
fs.writeFileSync(path.join(dir, '_probe27.txt'), res, 'utf8');
console.log(res);
