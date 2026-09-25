/* 存档层 + 搜索排序 的行为探针。
   注意 --virtual-time-budget 要给足：每次 toast 都挂一个 2400ms 的定时器，
   这个探针里有十几次吐司，预算太小会把后半段的 FileReader 回调直接截断
   （表现为"导入没生效"——是探针被掐了，不是功能坏了）。
   存档这件事必须用"真交互写进去 → 走真实加载路径读回来"验证，
   直接调 colWrite/colLoad 互相印证是没有意义的自证。
   覆盖：8 个集合的新增是否落盘 / 重开是否读回 / 空数组与脏值的边界 /
        恢复默认 / 设置页数字与真实数组一致 / 搜索组内名称命中优先 /
        每组只列前 6 条时的提示 / 导出导入 JSON 往返。 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = __dirname;
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let html = fs.readFileSync(path.join(dir, 'prototype.html'), 'utf8');
const probe = `
<script>
window.addEventListener('load', function(){
  setTimeout(async function(){
    var arr = [], errs = [];
    /* 边跑边把结果写进 DOM，而不是憋到最后一次性输出。
       探针一旦卡在某个 await 上（等一个永远不成立的条件），一次性输出的
       做法会让 --dump-dom 拿到一个空格子，看起来像"探针根本没执行"——
       完全不知道卡在第几步。这个坑踩过一次，值得永久改掉。 */
    var pre = document.createElement('pre'); pre.id = 'probe-out';
    pre.textContent = '(running)';
    document.body.appendChild(pre);
    var o = { push: function(s){ arr.push(String(s)); pre.textContent = arr.join('\\n'); } };
    window.addEventListener('error', function(e){ errs.push(String(e.message)); });
    var done = function(){ pre.textContent = arr.join('\\n') + '\\n(END)'; };
    var wait = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
    /* 虚拟时间会把 setTimeout 直接快进，但 FileReader 的完成是真实异步任务，
       所以"睡 300ms 再看结果"会跑在回调之前 —— 必须轮询等条件成立。
       这一条踩过坑：表现为"导入没生效"，其实只是探针读得太早。 */
    var until = async function(fn, tries){
      for (var i = 0; i < (tries || 300); i++){ if (fn()) return true; await wait(10); }
      return !!fn();
    };
    try {
    var q = function(s){ return document.querySelector(s); };
    var all = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };
    var has = function(s){ return !!document.querySelector(s); };
    /* 空元素要当场喊出来。否则一个过期的选择器只会让后面某步静默失败，
       症状看起来像"功能坏了"，实际是探针自己没跟上界面改动 ——
       这一轮就栽在这上面：新增入口从"直接塞一条"改成"先弹表单"，
       探针还去点点不到的按钮，整份报告只剩第 0 步。 */
    var click = function(el, what){
      if (!el){ o.push('    [!] click 拿到空元素：' + (what || '(未说明选择器)')); return false; }
      el.dispatchEvent(new MouseEvent('click', { bubbles:true })); return true;
    };
    var type = function(v){ q('#q').value = v; q('#q').dispatchEvent(new Event('input', { bubbles:true })); };
    var key = function(k){ q('#q').dispatchEvent(new KeyboardEvent('keydown', { key:k, bubbles:true, cancelable:true })); };
    var LSget = function(k){ try { return JSON.parse(localStorage.getItem(k)); } catch(e){ return 'DIRTY'; } };
    /* 页面是按需渲染的：refresh 会把不在列表里的页 body 清空，
       所以每次读 DOM 之前都要先真正进一次那一页。 */
    var goPage = function(id){ if (state.query) exitSearch(false); switchPage(id); };
    var chips = function(){ return all('.col-chip').map(function(e){ return e.textContent.replace(/\\s+/g, ''); }); };
    var cardOf = function(name){
      var g = all('.sres .gcard').filter(function(c){
        var nm = c.querySelector('.gcard-nm'); return nm && nm.textContent === name; })[0];
      if (!g) return null;
      return { badge:parseInt((g.querySelector('.gcard-n') || {}).textContent || '0', 10),
               rows:Array.prototype.slice.call(g.querySelectorAll('.row .nm')).map(function(e){ return e.textContent; }) };
    };

    /* ---- 0. 先确认无头环境里 FileReader 到底能连续跑几次 ----
       这是给后面 importStore 的结论定性的：如果连续两次读都成功，
       而第二次 importStore 没生效，那就是我的代码问题，不是环境问题。 */
    var readOK = [];
    for (var k = 0; k < 3; k++){
      readOK.push(await new Promise(function(res){
        var fr = new FileReader();
        fr.onload = function(){ res('ok'); };
        fr.onerror = function(){ res('err'); };
        fr.readAsText(new File(['x' + k], 'a' + k + '.txt', { type:'text/plain' }));
      }));
    }
    o.push('[0] FileReader 连续三次 = ' + readOK.join(',') + '（应全为 ok，否则是环境限制）');

    /* 填表单的公共动作：点新增 → 等浮层 → 逐个 input 填值 → 点主按钮。
       新增入口在这一轮从"直接塞一条"改成了"先弹表单"（folder-new /
       link-new），探针必须跟着走完整条路，顺便也就把浮层验了一遍：
       浮层弹不出来、或主按钮接不上，这里会直接报出来。 */
    var fillForm = async function(openSel, vals){
      if (!click(q(openSel), openSel)) return false;
      if (!await until(function(){ return has('.minip:not(.closing) .mp-in'); }, 80)) return false;
      var ins = all('.minip:not(.closing) .mp-in');
      vals.forEach(function(v, i){ if (ins[i]) ins[i].value = v; });
      var okB = q('.minip:not(.closing) [data-r="1"]');
      if (!okB){ o.push('    [!] 表单里没有主按钮（[data-r="1"]）'); return false; }
      click(okB);
      return true;
    };

    /* ---- 1. 用真交互往每个集合里加一条 ---- */
    goPage('folders');
    var f0 = DATA.folders.length;
    await fillForm('[data-act="folder-new"]', ['探针项目', 'D:\\Probe13\\Folder']);

    goPage('links');
    var l0 = DATA.links.length;
    await fillForm('[data-act="link-new"]', ['探针站点', 'https://probe13.example.com/x']);

    goPage('clip');
    var c0 = DATA.clip.length;
    var ci = q('#clipInput'); ci.value = 'https://example.com/probe13';
    ci.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true, cancelable:true }));

    goPage('note');
    var n0 = TOOL.notes.length;
    q('#noteInput').value = '探针写入的速记_' + Date.now();
    click(q('[data-act="note-save"]'));

    goPage('shot');
    var s0 = TOOL.shots.length;
    click(q('[data-act="shot-add"]'));
    /* 钉贴图现在会先问一句名字（以前是直接塞一条"新贴图 N"）。
       表单是新东西，探针要跟着走完整条路 —— 顺便把编辑浮层也验一遍：
       如果浮层弹不出来、或者提交按钮接不上，这里就会卡住或数字不动。 */
    await until(function(){ return has('.minip:not(.closing) .mp-in'); });
    var sIn = q('.minip:not(.closing) .mp-in'), sOk = q('.minip:not(.closing) [data-r="1"]');
    var formOpened = !!(sIn && sOk);
    if (formOpened){ sIn.value = '探针登记的贴图'; sOk.click(); }
    await until(function(){ return TOOL.shots.length !== s0; });

    goPage('today');
    var t0 = TOOL.todos.filter(function(x){ return x.done; }).length;
    click(q('.page[data-page="today"] [data-act="todo-toggle"]'), '今日页的待办勾选');

    goPage('scene');
    var sc0 = state.scene;
    var other = TOOL.scenes.filter(function(s){ return s.id !== state.scene; })[0];
    click(q('[data-act="scene-go"][data-id="' + other.id + '"]'), '场景切换按钮');

    /* 拖入文件：暂存区唯一的入口，用真实 DragEvent + DataTransfer 模拟 */
    goPage('staging');
    var st0 = DATA.staging.length;
    try {
      var dt = new DataTransfer();
      dt.items.add(new File(['x'], 'probe13_拖入.txt', { type:'text/plain' }));
      q('#dropzone').dispatchEvent(new DragEvent('drop', { bubbles:true, cancelable:true, dataTransfer:dt }));
    } catch(e){ o.push('（构造拖放事件失败：' + e.message + '，暂存项按未验证计）'); }

    /* 剪切板：无头环境里读系统剪切板会被拒，走的就是那条兜底路径 */
    goPage('board');
    var b0 = DATA.board.length;
    click(q('[data-act="board-read"]'), '剪切板页的「读一次剪切板」');
    await wait(250);

    /* 设置：开关一次（设置只在被改动时才落盘，不改就不该有存档键） */
    var cm0 = state.settings.copyMode;
    setSetting('copyMode', !cm0);

    o.push('[1] 真交互新增：文件夹 ' + f0 + '→' + DATA.folders.length
      + ' · 网址 ' + l0 + '→' + DATA.links.length
      + ' · 收藏 ' + c0 + '→' + DATA.clip.length
      + ' · 速记 ' + n0 + '→' + TOOL.notes.length
      + ' · 贴图 ' + s0 + '→' + TOOL.shots.length
      + ' · 已勾选待办 ' + t0 + '→' + TOOL.todos.filter(function(x){ return x.done; }).length
      + ' · 暂存 ' + st0 + '→' + DATA.staging.length
      + ' · 剪切板 ' + b0 + '→' + DATA.board.length
      + ' · 场景 ' + sc0 + '→' + state.scene
      + ' · 设置 copyMode ' + cm0 + '→' + state.settings.copyMode);

    /* ---- 1b. 编辑通路：改一条已有内容 ----
       用户当面点出的最大问题就是"内容没法改"。这里走完整条真交互链：
       卡片上的「⋯」→ 菜单 → 点"编辑…" → 浮层填新值 → 保存 →
       内存变了 / 落了盘 / 界面重绘后显示的是新文字。
       任何一环断掉，这个用例都会红 —— 光看代码"函数都在"是不算数的。 */
    goPage('today');
    var moreBtn = q('.page[data-page="today"] [data-act="ctx-open"]');
    var menuItems = [], menuOpened = false;
    if (moreBtn){
      click(moreBtn);
      await until(function(){ return has('#ctx.show'); });
      menuItems = q('#ctx')._items || [];
      menuOpened = menuItems.length > 0;
      var editEl = all('#ctx .ctx-item').filter(function(e){
        return e.textContent.indexOf('编辑') >= 0; })[0];
      if (editEl) click(editEl);
    }
    await until(function(){ return has('.minip:not(.closing) .mp-in'); });
    var NEW_TODO = '探针改过的待办文字';
    /* 取最后一个"还在用"的浮层，不取第一个 —— 前一个浮层可能还在放淡出。 */
    var tWrap = all('.minip:not(.closing)').filter(function(w){ return w.querySelector('.mp-in'); }).pop();
    var tIn = tWrap && tWrap.querySelector('.mp-in');
    var formOpened = !!tIn;
    if (tIn){ tIn.value = NEW_TODO; tWrap.querySelector('[data-r="1"]').click(); }
    await until(function(){ return TOOL.todos[0].text === NEW_TODO; });
    var storedT = LSget('juzhen.todos') || [];
    goPage('today');
    var onCard = all('.todo .td-tx').some(function(e){ return e.textContent === NEW_TODO; });
    o.push('[1b] 卡片「⋯」→ 菜单弹出 = ' + menuOpened + '（' + menuItems.length + ' 项）'
      + ' · 菜单里有"编辑" = ' + (menuItems.some(function(it){ return it.label && it.label.indexOf('编辑') === 0; }))
      + ' · 编辑浮层弹出 = ' + formOpened
      + ' · 内存已改 = ' + (TOOL.todos[0].text === NEW_TODO)
      + ' · 已落盘 = ' + storedT.some(function(x){ return x.text === NEW_TODO; })
      + ' · 界面重绘后就是新文字 = ' + onCard);

    /* ---- 2. 每一项是否真的落到了 localStorage ---- */
    var keys = { folders:'juzhen.folders', links:'juzhen.links', clip:'juzhen.clip', staging:'juzhen.staging',
      board:'juzhen.board.v2', notes:'juzhen.notes', shots:'juzhen.shots', todos:'juzhen.todos',
      scene:'juzhen.scene', settings:'juzhen.settings.v2' };
    var miss = Object.keys(keys).filter(function(k){ return localStorage.getItem(keys[k]) == null; });
    o.push('[2] 缺失的存档键 = ' + (miss.length ? miss.join(', ') : '无')
      + ' · 十组数据序列化后共 ' + Object.keys(keys).reduce(function(a, k){
          return a + (localStorage.getItem(keys[k]) || '').length; }, 0) + ' 字符（localStorage 上限约 5MB）');

    /* ---- 3. 重开：把内存清成"新启动"的样子，再走真实加载路径 ---- */
    var snap = { f:DATA.folders.length, l:DATA.links.length, c:DATA.clip.length, s:DATA.staging.length,
                 b:DATA.board.length, n:TOOL.notes.length, p:TOOL.shots.length,
                 d:TOOL.todos.filter(function(x){ return x.done; }).length, sc:state.scene };
    DATA.folders = []; DATA.links = []; DATA.clip = []; DATA.staging = []; DATA.board = [];
    TOOL.notes = []; TOOL.shots = []; state.scene = 'hil';
    loadCollections();
    var back = { f:DATA.folders.length, l:DATA.links.length, c:DATA.clip.length, s:DATA.staging.length,
                 b:DATA.board.length, n:TOOL.notes.length, p:TOOL.shots.length,
                 d:TOOL.todos.filter(function(x){ return x.done; }).length, sc:state.scene };
    var same = Object.keys(snap).every(function(k){ return snap[k] === back[k]; });
    o.push('[3] 清空内存后重载存档 → 全部还原 = ' + same
      + ' · 文件夹 ' + back.f + '/' + snap.f + ' · 网址 ' + back.l + '/' + snap.l
      + ' · 收藏 ' + back.c + '/' + snap.c + ' · 暂存 ' + back.s + '/' + snap.s
      + ' · 剪切板 ' + back.b + '/' + snap.b + ' · 速记 ' + back.n + '/' + snap.n
      + ' · 贴图 ' + back.p + '/' + snap.p + ' · 待办勾选 ' + back.d + '/' + snap.d
      + ' · 场景 ' + back.sc + '/' + snap.sc);

    /* ---- 4. 边界：空数组是合法状态，不能被演示数据倒灌 ---- */
    LS.write('juzhen.shots', []);
    TOOL.shots = [{ id:'zzz', t:'脏数据' }];
    loadCollections();
    o.push('[4] 存档里是空数组（用户清空过贴图）→ 重载后仍为空 = ' + (TOOL.shots.length === 0)
      + '（实际 ' + TOOL.shots.length + ' 项）');

    /* ---- 5. 边界：脏存档不该把渲染打挂 ---- */
    localStorage.setItem('juzhen.folders', '{这不是 JSON');
    var keep = DATA.folders.length, threw = '';
    try { loadCollections(); } catch(e){ threw = e.message; }
    o.push('[5] 脏存档 → 未抛错 = ' + (!threw) + ' · 内存未被破坏 = ' + (DATA.folders.length === keep)
      + ' · 仍是数组 = ' + Array.isArray(DATA.folders));
    localStorage.setItem('juzhen.folders', JSON.stringify(DATA.folders));

    /* ---- 6. 设置页「数据与存储」卡片 ---- */
    goPage('settings');
    var counts = colCount();
    var c1 = chips();
    var chipOK = c1.length === counts.length && counts.every(function(x, i){
      return c1[i] === String(x.n) + x.c.label; });
    o.push('[6] 设置页卡片：胶囊 ' + c1.length + ' 个（应为 ' + counts.length + '）'
      + ' · 与内存实时值逐项一致 = ' + chipOK
      + ' · 明细行 "恢复默认" 按钮 = ' + all('[data-act="col-restore"]').length + ' 个'
      + ' · ' + c1.slice(0, 5).join(' / '));

    /* ---- 7. 恢复默认：面板按钮走真事件，数字要跟着变 ---- */
    var fBefore = DATA.folders.length;
    click(q('[data-act="col-restore"][data-col="folders"]'));
    var stored = LSget('juzhen.folders');
    goPage('settings');                       /* 上一行的 refresh 把这页 body 清空了 */
    var c2 = chips();
    o.push('[7] 点「文件夹 · 恢复默认」→ 内存 ' + fBefore + '→' + DATA.folders.length
      + ' · 已同步写回存档 = ' + (Array.isArray(stored) && stored.length === DATA.folders.length)
      + ' · 首条 = "' + (DATA.folders[0] || {}).name + '"'
      + ' · 卡片上的文件夹数字已跟着更新 = ' + (c2[0] === String(DATA.folders.length) + '文件夹'));

    /* ---- 8. 搜索：组内"名称命中"排在"次要字段命中"前面 ----
       用 A2L 验证：片段里 s7「生成 A2L 并校验地址」是名称命中，
       s4「标定量描述块」只在语言字段里有 A2L —— 后者必须排在后面。 */
    goPage('calc');
    type('A2L');
    var snip = cardOf('片段'), note = cardOf('速记');
    o.push('[8] 搜「A2L」→ 片段组顺序 = ' + (snip ? snip.rows.join(' | ') : '（无该组）')
      + ' · 名称命中的「生成 A2L 并校验地址」排第一 = ' + (snip ? snip.rows[0] === '生成 A2L 并校验地址' : false)
      + ' · 速记组首条也含 A2L = ' + (note ? note.rows[0].indexOf('A2L') >= 0 : false));

    /* ---- 9. 组头数字 = 命中总数，超出 6 条时要有提示 ---- */
    type('e');
    var groups = all('.sres .gcard').map(function(c){
      var n = parseInt((c.querySelector('.gcard-n') || {}).textContent || '0', 10);
      return { nm:c.querySelector('.gcard-nm').textContent, badge:n,
               rows:c.querySelectorAll('.row').length, more:!!c.querySelector('.more') };
    });
    var bad = groups.filter(function(g){ return g.badge < g.rows; });
    var moreBad = groups.filter(function(g){ return g.more !== (g.badge > g.rows); });
    var trunc = groups.filter(function(g){ return g.badge > g.rows; });
    o.push('[9] 搜「e」→ 分组 ' + groups.length + ' 个 · 组头数字小于列出条数的 = ' + bad.length
      + '（应为 0） · 提示与"是否有截断"不符的 = ' + moreBad.length + '（应为 0）'
      + ' · 被截断的组 = ' + trunc.length
      + (trunc.length ? '（如 ' + trunc[0].nm + '：列出 ' + trunc[0].rows + ' / 命中 ' + trunc[0].badge + '）' : ''));
    key('Escape');

    /* ---- 10. 导出：拦截 Blob 抓真实产物（不点下载） ---- */
    var captured = null;
    var realCreate = URL.createObjectURL, realClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = function(b){ captured = b; return 'blob:probe'; };
    HTMLAnchorElement.prototype.click = function(){};
    exportStore();
    URL.createObjectURL = realCreate; HTMLAnchorElement.prototype.click = realClick;
    var text = captured ? await captured.text() : '';
    var pack = null; try { pack = JSON.parse(text); } catch(e){}
    o.push('[10] 导出存档 → 抓到产物 = ' + !!captured + ' · 体积 = ' + text.length + ' 字符'
      + ' · 可解析 = ' + !!pack + ' · 含 ' + (pack ? Object.keys(pack.data).length : 0) + ' 组'
      + (pack ? '（' + Object.keys(pack.data).join(',') + '）' : ''));

    /* ---- 11. 先试一个坏存档：不能崩、也不能动到现有数据 ---- */
    var badThrew = '', fKeep = DATA.folders.length;
    try {
      importStore(new File(['{不是存档'], 'bad.json', { type:'application/json' }));
      await wait(400);
    } catch(e){ badThrew = e.message; }
    o.push('[11] 导入非法 JSON → 未抛错 = ' + (!badThrew)
      + ' · 现有数据未被改动 = ' + (DATA.folders.length === fKeep)
      + ' · 吐司 = "' + q('#toastMsg').textContent + '"');

    /* ---- 12. 导入：拿第 10 步的产物改一改再导回去 ---- */
    var edited = JSON.parse(text);
    edited.data.folders = [{ name:'导入进来的文件夹', path:'Z:\\\\Imported\\\\One' }];
    edited.data.notes = [{ id:'imp1', text:'导入进来的速记', at:'12:00', day:'今天', tag:'导入' }];
    edited.data.shots = [];
    importStore(new File([JSON.stringify(edited)], 'store.json', { type:'application/json' }));
    await until(function(){ return DATA.folders.length === 1; });
    var fStored = LSget('juzhen.folders');
    o.push('[12] 导入存档 → 文件夹 ' + DATA.folders.length + ' 条（"' + (DATA.folders[0] || {}).name + '"）'
      + ' · 速记 ' + TOOL.notes.length + ' 条（"' + (TOOL.notes[0] || {}).text + '"）'
      + ' · 贴图 ' + TOOL.shots.length + ' 条（存档里是空数组，应保持为空）'
      + ' · 已同步落盘 = ' + (Array.isArray(fStored) && fStored.length === DATA.folders.length));

    /* ---- 13. 「恢复演示数据」按钮：清空全部存档键（按钮本体还会 reload，
       这里只验清空这一半，reload 在无头里会把探针一起带走） ---- */
    dropAllStored();
    var left = Object.keys(keys).filter(function(k2){ return localStorage.getItem(keys[k2]) != null; });
    o.push('[13] 点「恢复演示数据」会清掉的存档键 → 残留 = ' + (left.length ? left.join(', ') : '无')
      + '（共 ' + Object.keys(keys).length + ' 个键）');

    o.push('[14] 运行期异常 = ' + (errs.length ? errs.join(' | ') : '无'));
    } catch (ex){ o.push('[!] 探针本身抛错：' + ex.message + ' @ ' + (ex.stack || '').split('\\n')[1]); }
    done();
  }, 1200);
});
</script>
</body>`;
html = html.replace('</body>', probe);
const f = path.join(dir, '_probe13.html');
fs.writeFileSync(f, html, 'utf8');

const out = cp.execFileSync(chrome, ['--headless=old','--disable-gpu','--hide-scrollbars','--window-size=1600,1000',
  '--virtual-time-budget=90000','--dump-dom','file:///' + f.replace(/\\/g, '/') + '#theme=sunny&page=folders&noOnboard=1'],
  { encoding: 'utf8', maxBuffer: 1 << 28 });
const m = out.match(/<pre id="probe-out">([\s\S]*?)<\/pre>/);
const res = m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : 'PROBE 未执行';
fs.writeFileSync(path.join(dir, '_probe13.txt'), res, 'utf8');
console.log('ok');
