/* ============================================================
   真终端板块的运行期验证（2026-09-22 第四轮）
   ------------------------------------------------------------
   这一轮把 agentic-island 的**终端**搬了过来。要证明的不是"页面上
   有个终端样子"，而是四件事分开成立：

     ① 纯逻辑对：剥控制序列 / 取退出码 / 抓当前目录 / 折重复行 /
        认危险命令 / 引号转义 / 两段提示词的硬约束
     ② 三档状态对：还在探测 / 不可用（浏览器就在这里）/ 可用，
        且不可用时**没有**假输入框
     ③ 数据层对：标签落盘、profile 被规整、noSeed 集合不摆「恢复示例」、
        终端标签能被全局搜到、右键有菜单
     ④ 面板行为对：进终端页自动钉住、离开自动还原（这一条是用户明确要的）

   一个诚实的边界：探针跑在**无头 Chrome** 里，没有主进程也没有 PTY。
   所以"真起了 ConPTY 会话、vim 能跑"这件事在这里证不了 —— 那一层由
   desktop 侧的自检 + _termtest.js（普通 node 直测 term.js）负责。
   这里验的是"渲染侧在这些事实之上做对了什么"。
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
    var click = function(el){ if (el) el.dispatchEvent(new MouseEvent('click', { bubbles:true })); };
    var ok = function(cond, label, extra){
      o.push('  ' + (cond ? '[ok] ' : '[!!] ') + label + (extra ? '   ' + extra : ''));
      if (!cond) fails.push(label);
    };
    var goPage = function(id){ if (state.query) exitSearch(false); switchPage(id); };
    var ESC = String.fromCharCode(27), BEL = String.fromCharCode(7);

    try {
      /* ================= 一、纯逻辑 ================= */
      o.push('===== 一、纯逻辑（直接喂数据）=====');

      /* 1. 剥控制序列 */
      var dirty = ESC + '[?25h' + ESC + ']0;标题' + BEL + 'A' + String.fromCharCode(13) + 'B'
                + ESC + '[31m红' + ESC + '[0m' + String.fromCharCode(7);
      var clean = termStrip(dirty);
      ok(clean === 'AB红',
         'termStrip 剥掉 CSI / OSC / CR / 控制字符', JSON.stringify(clean));

      /* 2. 退出码取最后一个 OSC 633;D */
      var stream = 'foo' + ESC + ']633;D;0' + BEL + 'bar' + ESC + ']633;D;127' + BEL;
      ok(termExitCode(stream) === 127, 'termExitCode 取**最后**一个（不是第一个）',
         String(termExitCode(stream)));
      ok(termExitCode('没有任何标记') === null, 'termExitCode 无标记时返回 null 而不是 0');

      /* 3. 当前目录：取最后一个 PS 提示符 */
      var out3 = 'PS C:\\\\Users\\\\a> cd D:\\\\proj' + '\\r\\n' + 'PS D:\\\\proj> echo hi' + '\\r\\n'
               + 'hi' + '\\r\\n' + 'PS D:\\\\proj> ';
      ok(termCwdOf(out3) === 'D:\\\\proj', 'termCwdOf 取最后一个提示符（不被回显里的 PS 骗到）',
         JSON.stringify(termCwdOf(out3)));

      /* 4. 摘要折叠重复行，且不丢首尾 */
      var noisy = 'start\\nwarn x\\nwarn x\\nwarn x\\nwarn x\\nend\\n';
      var sum = termSummarize(noisy);
      ok(sum.text.indexOf('start') === 0 && sum.text.indexOf('end') > 0
         && sum.text.indexOf('重复 3 行') > 0,
         'termSummarize 折叠连续重复行并保留首尾', JSON.stringify(sum.text.slice(0, 80)));
      ok(sum.kept < sum.raw, 'termSummarize 折叠后行数确实减少',
         sum.raw + ' → ' + sum.kept);

      /* 5. 危险命令 */
      ok(termDangerous('Remove-Item -Recurse -Force C:\\\\tmp'),
         'termDangerous 认出 Remove-Item -Recurse -Force');
      ok(termDangerous('git push origin main --force'), 'termDangerous 认出 git push --force');
      ok(termDangerous('git reset --hard HEAD~3'), 'termDangerous 认出 git reset --hard');
      ok(!termDangerous('git status --short --branch'), 'termDangerous **不**误伤 git status');
      ok(!termDangerous('npm run build'), 'termDangerous **不**误伤 npm run build');
      ok(!termDangerous('Get-ChildItem -Force'), 'termDangerous **不**误伤 Get-ChildItem -Force');

      /* 6. 引号转义。路径里带单引号是最容易漏的一种（' 在 PS 里要写成 ''） */
      ok(termQuote("a'b") === "'a''b'", 'termQuote 把单引号翻倍', termQuote("a'b"));
      var cd = termCdCmd("C:\\\\it's\\\\dir");
      ok(cd.indexOf("''") > 0 && cd.indexOf('-LiteralPath') > 0,
         'termCdCmd 用 -LiteralPath 并转义', cd);

      /* 7. 两段提示词的硬约束 */
      var dp = termDiagPrompt({ shell:'Windows PowerShell', cwd:'D:\\\\p', exit:1, cmd:'npm test', out:'ERR' });
      ok(dp.indexOf('不') > 0 && dp.indexOf('自动执行') > 0,
         '诊断提示词写明"不自动执行"');
      ok(dp.indexOf('退出码：1') > 0, '诊断提示词带上退出码');
      ok(dp.indexOf('ERR') > 0, '诊断提示词带上输出');
      var hp = termHandoffPrompt({ cwd:'D:\\\\p', cmd:'npm test', out:'ERR' });
      ['当前目标','已完成','当前状态','下一步','关键命令'].forEach(function(k){
        ok(hp.indexOf(k) > 0, '交接提示词含固定结构项「' + k + '」');
      });
      ok(hp.indexOf('不要补充') > 0 || hp.indexOf('只写现场') > 0,
         '交接提示词禁止编造');

      /* ================= 二、页面与三档状态 ================= */
      o.push('');
      o.push('===== 二、页面与三档状态 =====');
      ok(typeof PAGE_MAP.term === 'object', 'PAGES 里有 term 板块');
      ok(!!q('.rbtn[data-page="term"]'), '侧栏有终端按钮');

      /* 浏览器默认态：avail.ok=false，必须如实说且**不给假入口** */
      goPage('term'); await wait(140);
      ok(has('.tz-panel.bad'), '浏览器里显示「不可用」而不是假装能用');
      ok(!has('#termMount .xterm'), '不可用时**没有** xterm 实例');
      ok(!!q('.tz-panel.bad .tz-why span') && q('.tz-panel.bad .tz-why span').textContent.indexOf('桌面版') >= 0,
         '不可用的原因里写明"需要桌面版"',
         (q('.tz-panel.bad .tz-why span') || {}).textContent ? q('.tz-panel.bad .tz-why span').textContent.slice(0, 40) + '…' : '');

      /* 强制"可用"，让标签栏 / 预设 / 状态条这些真实结构也能被验到 */
      var realAvail = TERM_UI.avail;
      TERM_UI.avail = { ok:true, shells:{ powershell:{found:true}, cmd:{found:true}, wsl:{found:true}, pwsh:{found:false} },
                        profiles:[ {id:'powershell',name:'Windows PowerShell'}, {id:'pwsh',name:'PowerShell 7 (pwsh)'},
                                   {id:'cmd',name:'命令提示符 (cmd)'}, {id:'wsl',name:'WSL'} ] };
      TOOL.terms.length = 0;
      renderPage('term', true); await wait(140);
      ok(has('#termTabs'), '可用时渲染出标签栏');
      ok(!!q('.tz-empty'), '空标签时给出空态提示而不是空白');
      ok(!!q('[data-act="term-new"]'), '空态下「新建」按钮在（有可见入口）');
      /* ---- 这一组对应用户本轮那条总原则 ----
         「每一个模块无关的东西显示的太多，导致主功能界面被挤压」。
         终端页原来五层往下叠：页头 / 16 键预设墙 / 终端(clamp 240-540px) /
         四个动作按钮 / 状态条 / 四行说明。现在只剩两层：标签栏 + 终端。
         撤掉的功能全部收进「更多」浮层与页头 ⓘ —— 所以下面既要验"没了"，
         也要验"还在"（见后面那两段）。 */
      ok(all('.tz-p').length === 0, '正文里不再有预设按钮墙（16 键收进「更多」）', all('.tz-p').length + ' 条');
      ok(all('.tz-pgroup').length === 0, '正文里不再有预设分组标签', all('.tz-pgroup').length + ' 组');
      ok(!has('.tz-acts'), '正文里不再有那排动作按钮（复制/摘要/AI/交接）');
      ok(!has('.tz-note'), '正文里不再有常驻的静态说明（搬进了页头 ⓘ）');
      ok(!has('#termFoot'), '正文里不再有状态条（Shell/目录/状态/退出码）');
      ok(!!q('.tz-main'), '终端本体还在');
      ok(!has('#termMount .xterm'), '浏览器里即使标成"可用"也不会凭空造出 xterm（没有资源）');

      /* "主功能不再被挤压"要能量出来，不是看着像。
         上一版终端高度写死 clamp(240px,44vh,540px)，而上下压着按钮墙/状态条 ——
         所以这里量的是**比例**：终端要占正文容器的一半以上。 */
      var tbody = q('#track .page[data-page="term"] .page-body');
      var tmain = q('.tz-main');
      ok(!!tbody && tbody.classList.contains('flexterm'),
         '终端页的正文容器挂上了 flexterm（否则 .tz-main 的 flex:1 一点用都没有）');
      var bh = tbody ? tbody.getBoundingClientRect().height : 0;
      var mh = tmain ? tmain.getBoundingClientRect().height : 0;
      ok(mh > 140, '终端拿到的实际高度大于它的 min-height（没被压扁）', Math.round(mh) + 'px');
      ok(bh > 0 && mh / bh > 0.55,
         '终端占了正文容器的 55% 以上（原来反过来：按钮墙 + 状态条把它夹在中间）',
         Math.round(mh) + '/' + Math.round(bh) + ' = ' + (bh ? (mh / bh).toFixed(2) : 'n/a'));
      ok(tbody && getComputedStyle(tbody).overflowY === 'hidden',
         '这一页的正文容器不再自己滚（xterm 的行高不能被页面级滚动顶掉）',
         tbody ? getComputedStyle(tbody).overflowY : '');

      /* 只该影响这一页 —— 其余 13 页的滚动行为一个字不能动 */
      var flexOther = all('#track .page .page-body.flexterm').filter(function(e){
        var pg = e.closest('.page');
        return !pg || pg.dataset.page !== 'term';
      });
      ok(flexOther.length === 0, 'flexterm 没有漏到别的页面上', flexOther.length + ' 个');

      /* 页头工具栏：不许渲染成一个空盒子。
         （"没有说明也没有新增"的页面就该一个按钮都不摆，摆一个空 tools 出来
           是排版 bug，而且点不着。） */
      var emptyTools = all('.phero-tools').filter(function(e){ return !e.querySelector('button'); });
      ok(emptyTools.length === 0, '页头工具栏没渲染成空盒子', emptyTools.length + ' 个空');

      /* ================= 三、数据层 ================= */
      o.push('');
      o.push('===== 三、数据层 =====');
      var col = COL_MAP.terms;
      ok(!!col, 'COLLECTIONS 里有 terms');
      ok(col.noSeed === true, 'terms 标了 noSeed');
      ok(col.seed().length === 0, 'terms 的 seed 是空数组（终端不摆假会话）');
      ok(col.page === 'term', 'terms 的清空/恢复会重画 term 页');

      /* fix 必须规整外部输入 */
      var bad = col.fix({ name:'', profile:'powershell7', cwd:123 });
      ok(bad.name === '终端', 'fix 给空名字兜底', bad.name);
      ok(bad.profile === 'powershell', 'fix 把非法 profile 归一（存档不能信）', bad.profile);
      ok(bad.cwd === '', 'fix 把非字符串 cwd 清成空', JSON.stringify(bad.cwd));
      ok(col.fix({ profile:'wsl' }).profile === 'wsl', 'fix 保留合法的 wsl');

      /* 新建标签 → 落盘 → 活动标签正确 */
      var before = LS.read(col.ls);
      var t1 = termAddTab(); await wait(120);
      ok(TOOL.terms.length === 1, 'termAddTab 加了一个标签', TOOL.terms.length + ' 个');
      ok(termActiveId() === t1.id, '新标签成为活动标签');
      var after = LS.read(col.ls);
      ok(Array.isArray(after) && after.length === 1 && after[0].id === t1.id,
         '标签已落盘（mark("terms") 真的写了）',
         Array.isArray(after) ? after.length + ' 条' : String(after));
      ok(!!q('.tz-tab.on b') && q('.tz-tab.on b').textContent === t1.name,
         '标签栏里这个标签被标成选中', (q('.tz-tab.on b') || {}).textContent || '');
      ok(!!q('.tz-tab .tz-x'), '标签上有可见的关闭按钮（不是只能右键）');
      /* 可见入口审计：站里的规矩是"凡有 ctxFor 菜单的 kind，每处元素都要有 .ctx-more"。
         终端是唯一一个"标签条 + 关按钮"都不带 ⋯ 就会变成纯右键的地方 ——
         改名字 / 换 Shell 全在菜单里，"只有右键 = 没有入口"。 */
      ok(!!q('.tz-tab .ctx-more'), '标签上有可见的 ⋯（改名字 / 换 Shell 不能只靠右键）');
      if (q('.tz-tab .ctx-more')){
        click(q('.tz-tab .ctx-more'));
        await wait(90);
        ok(q('#ctx').classList.contains('show'), '点标签的 ⋯ 真的把菜单弹出来了');
        ok(all('#ctx *').some(function(x){ return (x.textContent || '').indexOf('重命名') >= 0; }),
           '这个 ⋯ 弹出的菜单里有「重命名」');
        closeCtx(); await wait(50);
      }
      /* ================= 功能一条都没丢：只是换了入口 =================
         这是本轮最容易骗自己的地方：把按钮撤掉很容易，
         难的是"撤掉之后每一条功能都还在某个看得见的地方"。
         所以下面走真人路径把它们挨个点出来。 */
      /* 浏览器里没有真会话，cwd 是空的 —— 借一个来验"按条件出现"这条逻辑。
         （"打开当前目录"只在真知道目录时才该出现，摆一个点了不知道
           会发生什么的项，比不摆更糟。） */
      var mrec = termRec(t1.id);
      var mrecCwd0 = mrec ? mrec.cwd : undefined;
      if (mrec) mrec.cwd = 'E:/Agentic_Engineering/Workbuddy';

      var moreBtn = q('[data-act="term-more"]');
      ok(!!moreBtn, '标签栏右边有「更多」按钮（收进去的东西有可见入口，不是只剩右键）');
      if (moreBtn){
        click(moreBtn); await wait(150);
        var mp1 = all('.minip:not(.closing) .mp-opt');
        var l1 = mp1.map(function(b){ return b.textContent || ''; }).join(' | ');
        ok(mp1.length >= 5, '「更多」里至少 5 条动作', mp1.length + ' 条');
        ok(['常用命令','复制这个标签的全部输出','看输出摘要','AI 诊断','交接摘要']
             .every(function(t){ return l1.indexOf(t) >= 0; }),
           '复制 / 摘要 / AI 诊断 / 交接 / 常用命令 全在', l1.slice(0, 110));
        ok(l1.indexOf('结束全部会话') < 0,
           '只有一个标签时**不**摆「结束全部会话」（没东西可结束 —— 不摆一个点了没意义的破坏性动作）');
        ok(l1.indexOf('打开当前目录') >= 0,
           '状态条独有的"在资源管理器里打开"搬到了这里（知道 cwd 时才出现，我这里借了一个）');

        /* 二级：常用命令。每条都要带上"将要执行的命令原文" ——
           墙上那些按钮只有 title，鼠标悬停才看得见，等于跑之前看不见要跑什么。 */
        var presetOpt = mp1.filter(function(b){ return (b.textContent || '').indexOf('常用命令') >= 0; })[0];
        if (presetOpt){
          click(presetOpt); await wait(170);
          var mp2 = all('.minip:not(.closing) .mp-opt');
          ok(mp2.length === 16, '二级浮层里 16 条预设一条不少', mp2.length + ' 条');
          var descs = all('.minip:not(.closing) .mp-od').map(function(e){ return e.textContent || ''; });
          ok(descs.length === 16, '每条预设都看得见它将要执行的命令原文', descs.length + ' 条');
          ok(descs.some(function(c){ return c.indexOf('git status') === 0; }), '预设里含 git status');
          ok(descs.some(function(c){ return c.indexOf('Get-NetTCPConnection') >= 0; }), '预设里含监听端口查询');
          ok(descs.every(function(c){ return c.trim().length > 3; }), '每条都带真实命令文本，不是占位');
          ok(all('.minip:not(.closing) .mp-oi').length === 16, '每条也都有图标');
        } else { ok(false, '「更多」里找不到「常用命令…」这一条'); }

        /* 收尾：全都关掉，别把后面的断言带歪 */
        all('.minip:not(.closing) [data-r="0"]').forEach(function(b){ click(b); });
        await wait(360);
        ok(all('.minip:not(.closing)').length === 0, '浮层都能关干净（有"不做选择也能消失"的出路）');
      }
      if (mrec) mrec.cwd = mrecCwd0;

      /* 「结束全部会话」是条件项（只在真有多个标签时出现）—— 两个分支都验。
         这一条原来常驻在「新建」旁边：一个破坏性动作占着一个按钮位。
         撤掉它不等于删掉它，所以这里既验"一个标签时不该出现"，
         也验"两个标签时它还在"。假标签是探针自己加的，用完必须撤干净。 */
      TOOL.terms.push({ id:'zz2', name:'终端 2', profile:'powershell', cwd:'', exit:null });
      mark('terms'); termPaintTabs();
      click(q('[data-act="term-more"]')); await wait(150);
      var l2 = all('.minip:not(.closing) .mp-opt').map(function(b){ return b.textContent || ''; }).join(' | ');
      ok(l2.indexOf('结束全部会话') >= 0, '有两个标签时「结束全部会话」就出现了（条件项两个分支都对）');
      all('.minip:not(.closing) [data-r="0"]').forEach(function(b){ click(b); });
      await wait(360);
      TOOL.terms = TOOL.terms.filter(function(t){ return t.id !== 'zz2'; });
      mark('terms'); termPaintTabs();
      ok(TOOL.terms.length === 1, '探针自己加的那个假标签已撤掉，没污染后面的断言',
         TOOL.terms.length + ' 个');

      /* ===== 页头 ⓘ：说明搬走了，但一字没减 ===== */
      var infoBtn = q('[data-act="ph-info"]');
      ok(!!infoBtn, '终端页页头有 ⓘ 说明入口');
      if (infoBtn){
        click(infoBtn); await wait(170);
        var msgEl = q('.minip:not(.closing) .mp-msg');
        ok(!!msgEl, 'ⓘ 打开的是一个浮层（不占正文，但内容有地方看）');
        var itx = msgEl ? msgEl.textContent : '';
        ok(itx.indexOf('Ctrl+Shift+C') >= 0, 'ⓘ 里写了快捷键');
        ok(itx.indexOf('离开终端板块不会杀掉它') >= 0, 'ⓘ 里写了"离开板块不杀会话"');
        ok(itx.indexOf('进程不会') >= 0, 'ⓘ 里写了"标签留下、进程不留"');
        ok(itx.indexOf('pwsh') >= 0, '本机没有 pwsh 这件事照实说（只是从正文挪进了 ⓘ）');
        ok(itx.length > 120, 'ⓘ 里是完整说明，不是一句占位', itx.length + ' 字');
        ok(all('.minip:not(.closing) input, .minip:not(.closing) textarea').length === 0,
           'ⓘ 是只读的（没有输入框，不是伪装成说明的表单）');
        var infoOk = q('.minip:not(.closing) [data-r="1"]');
        ok(!!infoOk && (infoOk.textContent || '').indexOf('知道了') >= 0,
           'ⓘ 只有一个"知道了"', infoOk ? infoOk.textContent : '');
        var infoX = q('.minip:not(.closing) [data-r="0"]');
        if (infoX){ click(infoX); await wait(360); }
      }
      ok(all('.minip:not(.closing)').length === 0, 'ⓘ 关得掉');

      /* 右键菜单 */
      var menu = ctxFor('termtab', q('.tz-tab'));
      ok(Array.isArray(menu) && menu.length >= 5, 'ctxFor("termtab") 给出菜单项',
         (menu ? menu.length : 0) + ' 项');
      ok(menu.some(function(m){ return m.label && m.label.indexOf('重命名') >= 0; }),
         '菜单里有「重命名」');
      ok(menu.some(function(m){ return m.danger; }), '菜单里有危险项（结束并关闭）');
      /* 正文那排按钮撤掉之后，AI 诊断 / 交接必须靠这个入口活着 ——
         它们本来就是"针对某一个标签"的事，放标签菜单里比放页面底部更对。 */
      ok(menu.some(function(m){ return m.label && m.label.indexOf('AI 诊断') >= 0; })
         && menu.some(function(m){ return m.label && m.label.indexOf('交接摘要') >= 0; }),
         '菜单里补上了「AI 诊断 / 交接摘要」（撤掉的那排按钮在这里复活）',
         menu.map(function(m){ return m.label; }).join(' | ').slice(0, 110));

      /* 搜索能搜到 */
      t1.name = 'zztermhit';
      mark('terms');
      var g = searchGroups('zztermhit');
      var hit = g.some(function(gr){ return gr.rows.some(function(r){ return r.row.indexOf('termtab') >= 0; }); });
      ok(hit, '终端标签能被全局搜索搜到，且带 data-kind（搜到后能右键改删）');

      /* 设置页：noSeed 的集合不摆「恢复示例」 */
      goPage('settings'); await wait(160);
      var rows = all('.set-row');
      var termRow = rows.filter(function(r){
        return r.textContent.indexOf('终端标签') >= 0 && r.textContent.indexOf('清空') >= 0;
      })[0];
      ok(!!termRow, '设置页有「终端标签」这一行');
      if (termRow){
        ok(termRow.textContent.indexOf('恢复示例') < 0,
           '这一行**没有**「恢复示例」（终端没有出厂演示内容，不摆假按钮）');
        ok(termRow.textContent.indexOf('清空') >= 0, '这一行有「清空」');
      }
      /* colRestore 也必须在数据层挡住 */
      var n0 = TOOL.terms.length;
      colRestore(col);
      ok(TOOL.terms.length === n0, 'colRestore 对 noSeed 集合不动作（不把标签清空）',
         n0 + ' → ' + TOOL.terms.length);

      /* ---------- 三条收尾口径（都是真实会出事、不是理论问题） ----------
         ① 常驻容器必须找得回来：页面正文被清空后它先被摘出文档，
            那一刻 getElementById 返回 null。用 TERM_BOX 引用就不怕。 */
      var boxA = termBox();
      ok(boxA === termBox(), 'termBox 幂等（两次拿到同一个元素）');
      ok(boxA.id === 'termBox' && boxA.className === 'tz-box', 'termBox 的 id/class 没变');
      goPage('term'); await wait(140);
      ok(boxA.parentNode && boxA.parentNode.id === 'termMount',
         '在终端页时容器挂在 #termMount 里', boxA.parentNode ? boxA.parentNode.id : 'null');

      /* ② 清空正文（invalidatePage / refresh / 导入存档 走的都是这条）之后，
            容器必须被摘到兜底容器里、并且**还是同一个元素**。 */
      var paneMark = document.createElement('i');
      paneMark.className = 'probe-mark';
      boxA.appendChild(paneMark);
      invalidatePage('term');                       /* 这一句原来是"把终端弄白"的元凶 */
      ok(termBox() === boxA, '清空正文之后拿回来的还是同一个容器（没有新建空盒子）',
         termBox() === boxA ? '同一个' : '★ 换了个新的（老树丢了）');
      ok(!!boxA.querySelector('.probe-mark'),
         '清空正文之后容器里的内容还在（xterm 的 DOM 不会被当成垃圾清掉）');
      ok(boxA.parentNode && boxA.parentNode.id === 'termStash',
         '清空正文之后容器被摘进了兜底容器', boxA.parentNode ? boxA.parentNode.id : 'null');
      /* 再回终端页，它必须被挂回去 */
      TERM_UI.avail = { ok:true, shells:{ powershell:{found:true} },
                        profiles:[{id:'powershell',name:'Windows PowerShell'}] };
      renderPage('term', true); await wait(140);
      ok(boxA.parentNode && boxA.parentNode.id === 'termMount',
         '回到终端页时容器被挂回页面', boxA.parentNode ? boxA.parentNode.id : 'null');
      ok(!!q('#termMount .probe-mark'), '挂回去的是原来那棵树（不是重画的）');
      boxA.querySelector('.probe-mark').remove();

      /* ③ 批量换掉标签列表时必须收掉会话 —— 否则"列表空了、进程还在跑"。
            浏览器里没有真 PTY，但 JZ.pty 不存在的分支也要走通（不能因为
            不在桌面版就整个跳过收尾逻辑）。 */
      termAddTab(true); await wait(120);
      var idKeep = TOOL.terms[0].id;
      termAddTab(true); await wait(120);
      ok(TOOL.terms.length >= 2, '至少有两个标签可以试收尾', TOOL.terms.length + ' 个');
      var killCalls = [];
      var realPty = window.JZ && window.JZ.pty;
      var pane0 = termPane(TOOL.terms[0].id);
      /* 直接验纯逻辑：给一个"只有第 1 个标签"的列表，看第 2 个的实例有没有被丢掉 */
      var secondId = TOOL.terms[1].id;
      TERM_UI.pane[secondId] = TERM_UI.pane[secondId] || { term:null, el:document.createElement('i') };
      var paneBefore = Object.keys(TERM_UI.pane).length;
      COL_MAP.terms.set([TOOL.terms[0]]);
      var paneAfter = Object.keys(TERM_UI.pane).length;
      ok(!TERM_UI.pane[secondId], '被移出列表的标签，它的实例被丢掉了（不会留个看不见的画布）',
         paneBefore + ' → ' + paneAfter + ' 个实例');
      ok(TOOL.terms.length === 1, '列表确实被换成 1 条', TOOL.terms.length + ' 条');
      /* 清空全部 → 实例全收 */
      COL_MAP.terms.set([]);
      ok(Object.keys(TERM_UI.pane).length === 0, '清空标签列表时全部实例都被收掉',
         Object.keys(TERM_UI.pane).length + ' 个残留');
      ok(TOOL.terms.length === 0 && TERM_UI.active === '',
         '列表空了之后活动标签也不再悬空', JSON.stringify(TERM_UI.active));
      /* 收尾后仍要有可见入口，不能变成"删光了加不回来" */
      goPage('term'); await wait(140);
      ok(!!q('[data-act="term-new"]'), '标签被清空后，「新建」入口还在');

      /* ================= 四、面板钉住行为 ================= */
      o.push('');
      o.push('===== 四、进终端页自动钉住、离开自动还原 =====');
      /* 场景 A：用户原本没钉住。直接把运行时真相摆成"没钉住"再进终端页 ——
         不调 togglePin(false)，那会顺带写设置、弹吐司、重画设置页，
         把"进终端页自动钉住"这一步以外的副作用全混进来。 */
      state.pinned = false; TERM_UI.pinSaved = null;
      q('#panel').classList.remove('pinned');
      goPage('term'); await wait(160);
      ok(state.pinned === true, '进终端页 → 自动钉住', 'pinned=' + state.pinned);
      ok(q('#panel').classList.contains('pinned'), '面板 DOM 也标成钉住（不是只有内部变量）');
      goPage('folders'); await wait(160);
      ok(state.pinned === false, '离开终端页 → 自动还原成"没钉住"', 'pinned=' + state.pinned);
      ok(!q('#panel').classList.contains('pinned'), '面板 DOM 的钉住也去掉了');

      /* 场景 B：用户本来就是钉住的 —— 离开时不许把它关掉 */
      state.pinned = true; TERM_UI.pinSaved = null;
      q('#panel').classList.add('pinned');
      goPage('term'); await wait(140);
      ok(state.pinned === true, '用户已钉住时，进终端页保持钉住');
      goPage('links'); await wait(140);
      ok(state.pinned === true,
         '离开终端页**不**擅自取消用户自己的钉住（这一条错了就是"设置被悄悄改掉"）',
         'pinned=' + state.pinned);

      /* 收尾：还原成探针进来时的样子 */
      state.pinned = false; TERM_UI.pinSaved = null;
      q('#panel').classList.remove('pinned');
      q('#btnPin').classList.remove('on');

      /* ================= 五、无回归 =================
         走真实渲染路径（renderPage 会自己处理"渲染失败"包装、
         终端页的 termDetach/termMount 也一并被走到），而不是手搓 boxBy */
      o.push('');
      o.push('===== 五、' + PAGES.length + ' 个板块都能渲染 =====');
      var pageBad = [];
      for (var i = 0; i < PAGES.length; i++){
        var id = PAGES[i].id;
        try {
          invalidatePage(id);
          renderPage(id, true);
          var box = q('#track .page[data-page="' + id + '"] .page-body');
          if (!box) { pageBad.push(id + '(没有正文容器)'); continue; }
          var b = box.innerHTML;
          if (!b.trim()) pageBad.push(id + '(渲染成空)');
          else if (b.indexOf('渲染失败') >= 0) pageBad.push(id + '(渲染失败)');
        } catch (ex){ pageBad.push(id + '(' + ex.message + ')'); }
      }
      ok(pageBad.length === 0, '全部 ' + PAGES.length + ' 个板块构建无异常',
         pageBad.length ? pageBad.join(', ') : PAGES.length + ' 个都渲染成功');
      /* 终端板块走完之后，常驻容器必须回到页面里（不能被留在兜底容器里） */
      ok(q('#termMount #termBox') || q('#termStash #termBox'),
         '终端常驻容器没有丢（要么挂在页面里、要么在兜底容器里等着）',
         q('#termMount #termBox') ? '在页面里' : '在兜底容器里');
      /* 15 条可见入口审计的缩水版：每个页头「+」都得有对应按钮 */
      var headBad = [];
      Object.keys(HEAD_ACT).forEach(function(pg){
        if (!q('[data-act="' + HEAD_ACT[pg] + '"]')) {
          /* 该页没渲染过就跳过（head 按钮画在页头，页面渲染了才有） */
          var sec = q('#track .page[data-page="' + pg + '"] .page-body');
          if (sec && sec.innerHTML.trim() && sec.innerHTML.indexOf('渲染失败') < 0) headBad.push(pg + '→' + HEAD_ACT[pg]);
        }
      });
      ok(headBad.length === 0, '页头「+」都在（' + Object.keys(HEAD_ACT).length + ' 处）',
         headBad.length ? headBad.join(', ') : '全部可点');

      TERM_UI.avail = realAvail;

      o.push('');
      o.push('===== 六、结论 =====');
      o.push('  失败项 = ' + (fails.length ? fails.join(' ｜ ') : '无'));
      o.push('  运行期异常 = ' + (errs.length ? errs.join(' | ') : '无'));
      o.push('  说明：探针跑在无头 Chrome，没有主进程也没有 PTY，所以');
      o.push('        "真起了 ConPTY 会话、vim 能跑"不在这里证 ——');
      o.push('        那一层由 desktop 自检与 _termtest.js（node 直测 term.js）负责。');
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
const f = path.join(dir, '_probe29.html');
fs.writeFileSync(f, html, 'utf8');

const out = cp.execFileSync(chrome, ['--headless=old','--disable-gpu','--hide-scrollbars',
  '--window-size=1600,1000','--virtual-time-budget=240000','--dump-dom',
  'file:///' + f.replace(/\\/g,'/') + '#theme=sunny&page=folders&noOnboard=1'],
  { encoding:'utf8', maxBuffer:1<<28 });
const m = out.match(/<pre id="probe-out">([\s\S]*?)<\/pre>/);
const res = m ? m[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&') : 'PROBE 未执行';
fs.writeFileSync(path.join(dir, '_probe29.txt'), res, 'utf8');
console.log(res);
