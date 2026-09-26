const fs = require('fs');
const path = require('path');
const dir = __dirname;
const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
const has = f => fs.existsSync(path.join(dir, f));

let html = read('prototype.html');
const log = [];

/* ---------- 1. CSS ---------- */
if (has('_css.txt')){
  const css = read('_css.txt');
  const o = html.indexOf('<style>'), c = html.indexOf('</style>', o);
  if (o < 0 || c < 0){ log.push('style tag not found'); }
  else {
    html = html.slice(0, o + '<style>'.length) + '\n' + css + '\n' + html.slice(c);
    log.push('css inlined: ' + css.split('\n').length + ' lines');
  }
} else log.push('css: _css.txt not found, kept inline');

/* ---------- 2. JS ----------
   片段顺序就是要紧的事：_term.txt 放在 _js_c.txt **之前**。
   _js_c.txt 末尾是启动序列（applyTheme / loadCollections / switchPage），
   而终端的初始化代码里读的是 _term.txt 里那几个 const（TERM_UI / TERM_PRESETS）。
   const 不像 function 声明那样提升 —— 顺序反了就是一片 TDZ 报错。 */
const partFiles = ['_js_a.txt', '_icons.txt', '_illus.txt', '_js_b.txt', '_tools.txt', '_term.txt', '_js_c.txt'].filter(has);
const js = partFiles.map(read).join('\n');
log.push('js parts: ' + partFiles.join(' + '));

const open = html.indexOf('<script>');
const close = html.lastIndexOf('</script>');
if (open < 0 || close < 0){ log.push('script tag not found'); }
else {
  html = html.slice(0, open + '<script>'.length) + '\n' + js + '\n' + html.slice(close);
}
fs.writeFileSync(path.join(dir, 'prototype.html'), html, 'utf8');

/* 桌面版（Electron）吃同一份产物：省掉"改完原型还要记得拷一份过去"
   这个必然会踩的坑。同一个文件在浏览器里是原型、在 Electron 里是
   真实桌面模式 —— 靠 window.JZ 是否存在分流，不维护两份。 */
try {
  const appDir = path.join(dir, 'desktop', 'app');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'index.html'), html, 'utf8');
  log.push('desktop app synced: desktop/app/index.html');
} catch (e){ log.push('desktop app sync FAILED: ' + e.message); }

/* ---------- 3. 终端渲染组件（xterm）----------
   为什么不内联进 prototype.html：xterm 的 UMD 产物 478KB，而浏览器原型里
   一行都用不上（那边没有 PTY）。内联进去会让单文件原型从 470KB 涨到接近 1MB，
   换来的只是"原型也带着一个永远跑不起来的终端"。
   所以改成：拷进 desktop/app/vendor/，由页面在**桌面版且进了终端板块时**
   才动态加载。桌面版能被 file:// 直接读到，打包后 aar/asar 内也读得到。

   这一步失败必须**报出来**，不能静默跳过 —— 漏拷的后果是打包出来的 exe
   里终端一片空白，而开发模式（node_modules 就在旁边）一切正常。 */
const vendored = [];
const VENDOR_SRC = [
  ['@xterm/xterm/lib/xterm.js',        'xterm.js'],
  ['@xterm/xterm/css/xterm.css',       'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js','addon-fit.js']
];
try {
  const vDir = path.join(dir, 'desktop', 'app', 'vendor');
  fs.mkdirSync(vDir, { recursive: true });
  VENDOR_SRC.forEach(([rel, name]) => {
    const from = path.join(dir, 'desktop', 'node_modules', rel);
    if (!fs.existsSync(from)){ vendored.push(name + '(源缺失)'); return; }
    fs.copyFileSync(from, path.join(vDir, name));
    vendored.push(name);
  });
  log.push('xterm vendor: ' + vendored.join(' + '));
} catch (e){ log.push('xterm vendor FAILED: ' + e.message); }
/* 三个文件都在才算过：少一个的表现各不相同（js 缺 → 终端空白；
   css 缺 → 光标和选中全是黑色方块；addon 缺 → 尺寸永远不跟随面板） */
const VENDOR_NEED = ['xterm.js', 'xterm.css', 'addon-fit.js'];
const vendorMissing = VENDOR_NEED.filter(n => !has('desktop/app/vendor/' + n));
log.push('xterm vendor 完整: ' + (vendorMissing.length ? '★ 缺 ' + vendorMissing.join(', ') : 'ok（3/3）'));

log.push('written bytes: ' + Buffer.byteLength(html, 'utf8'));
log.push('"$$" occurrences: ' + (html.match(/\$\$/g) || []).length);
let syntaxErr = '';
try { new Function(js); log.push('SYNTAX: OK'); }
catch (e) { syntaxErr = e.message; log.push('SYNTAX: FAIL -> ' + e.message); }

const fns = ['applyTheme','colorFor','fileKind','extOf','fmtSize','buildFolders','buildLinks','buildClip','buildStaging','buildBoard','buildSettings',
  'buildToday','buildScene','buildSnip','buildCalc','buildNote','buildShot','buildAsk','calcUpdate','pmvSolve','numField','resCell','statCell','convGroup',
  'segCtl','swCtl','row','naTag','fsBlockHint','renderSheet','renderDoc','renderSlide','renderMd','renderImg','showPreview','closePreview','openFilePreview','openClipPreview','openBoardPreview','renderRail','renderShell','renderPage','updateFoot','refresh','switchPage','saveBoard','loadBoard',
  'addBoardEntry','addClip','saveSettings','loadSettings','applySettings','setSetting','setTheme','openPanel','closePanel','togglePanel',
  'renderThemePop','closeThemePop','openCtx','closeCtx','ctxFor','doCopy','handleAct','readClipboard','handleOpen','demoFor','openReal','pasteToFront',
  'injectStaticIcons','deepLink','folderGroup','parentOf','linkGroup','linkGroupHint','parseUrl','boardType','codeLang','linkHost','crumb','pick',
  'visibleClips','visibleBoard','countOf','hitTotal','pageHead','gcard','groupBy','sheetTable','railCompact','stg','emptyBox','svg','IC',
  'searchGroups','searchView','srow','exitSearch','moveSel','srRows','activateSearchRow','lineOne','tipHints',
  'colWrite','colLoad','colRestore','dropAllStored','loadCollections','exportStore','importStore','pickStoreFile','colCount','dataStoreCard','saveNote','sendAsk','mark',
  'packNow','mirror','hydrate','applyPack','shortPath','bindDesktop','askText','fillSnipVars','mergeSettings',
  'clearCollection','resetAllContent','groupCtx',
  /* AI 速问：配置读取、状态判定、请求、错误翻译、测试连接、清空 */
  'aiProvider','aiCfg','aiReady','maskKey','aiOkText','aiRefreshStrip','aiStatusStrip','aiSettingsRows',
  'aiFetchDirect','aiRequest','aiErrText','aiPayload','aiSetProvider','findAsk','retryAsk','aiTest',
  'askClearDemo','askClearAll',
  'startClipWatch','stopClipWatch',
  /* 编辑能力：这几个是全站的"改一条"入口，缺一个就会有板块重新变回展示柜 */
  'askConfirm','askPick','askForm','editRecord','delRecord','FORMS','snipVars','nowClock',
  'ACT_KINDS','ACT_META','markRecent','agoText','atText',
  /* 场景：执行 + 编辑 + 失效探测 */
  'probeScenes','sceneMiss','runScene','runOneAct',
  'pickActTarget','editActTarget','editActName','addAct','renameScene','delScene','newScene',
  /* 终端：页面构建、纯逻辑（可单独喂数据验）、标签与面板生命周期、动作 */
  'buildTerm','termStrip','termExitCode','termCwdOf','termSummarize','termDangerous',
  'termQuote','termCdCmd','termShort','termDiagPrompt','termHandoffPrompt',
  'termBox','tok','termStash','termDetach','termMount','termLoadVendor','termPalette',
  'TERM_BOX',
  'termList','termRec','termActiveId','termActive','termPane',
  'termAddTab','termCloseTab','termRenameTab','termPickShell',
  'termEnsurePane','termEat','termFitSoon','termActivate',
  'termPaintTabs','termShellName',
  'termRun','termRunCmd','termPresetPick','termMoreMenu',
  'termCopyAll','termShowSummary','termPasteTo','termContext',
  'termToAsk','termKillAll','termEnter','termLeave','termSyncPin',
  /* 终端页瘦身（2026-09-22）删掉的三样：状态条 termPaintFoot、
     静态说明 termStaticNote、旧的 termRunPreset —— 调用点也一并清掉了
     （删函数留调用 = ReferenceError，_p46 的自查真抓到过 4 处）。
     说明文字本身没丢，搬进了 PAGE_INFO.term。 */
  'PAGE_INFO','TERM_PWSH_MISS','pageInfoLines','pageInfoOpen',
  /* 终端会话的生命周期收尾：删标签 / 整体换掉标签列表时都得走这两个，
     少了它们就是"进程在跑、界面上找不到" */
  'termDropPane','termPrune',
  /* 清空正文的唯一入口。原先 renderPage / invalidatePage / refresh / 导入存档
     四条路各写一遍 innerHTML=''，只有第一条记得摘终端容器 —— 所以合并成一个。 */
  'blankBody','blankAll'];
const missing = fns.filter(f => !new RegExp('(function\\s+' + f + '\\s*\\()|((const|let|var)\\s+' + f + '\\s*=)').test(js));
log.push('functions missing: ' + (missing.length ? missing.join(', ') : 'none'));

/* ---------- 退役的函数名 ----------
   上面那张 fns 表只管"该在的都在"，管不了反向的那件事：
   **函数删了、调用点还留着**。这一轮真在这上面栽过一次 ——
   _p46 把 termPaintFoot 的函数体删掉了，可是还有 4 处调用散在
   termActivate / pty.ensure().then / termEnter 里。构建照样绿，
   因为没人问过"这个名字还被谁叫着"；跑起来就是 ReferenceError。
   （顺带：那 4 处一开始被自查里的一条假红盖住了视线 ——
   判据命中了注释里对同一个名字的引用。两件事都要有人管。）

   所以：删一个函数，就把名字登记到这里。以后它**在代码里**再出现一次
   都算红。注释里提到不受限 —— 注释写清"这个名字已经删了、为什么删"
   是有价值的记录，不该被禁止；所以查之前先把注释剥掉。
   日志里两种都报（原始几处 / 代码里几处），这样"只在注释里"看得见。 */
const RETIRED = [
  ['termPaintFoot', '终端状态条（Shell/目录/状态/退出码）—— 终端的提示符里本来就有，撤了'],
  ['termStaticNote', '终端页四行静态说明 —— 搬进了 PAGE_INFO.term，挂页头 ⓘ'],
  ['termRunPreset',  '旧签名：从按钮的 data-cmd 取命令 —— 预设墙撤掉后改收命令文本 termRunCmd']
];
const stripC = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ')
                    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1 ');
const jsCode = stripC(js);
/* 剥注释这一手自己也要被验一次：剥完还得剩下绝大部分代码，
   而且里面那些 http(s):// 不能被当成行注释吃掉。剥坏了的剥 = 假绿。 */
const stripOk = jsCode.indexOf('function termPaintTabs()') >= 0
  && jsCode.indexOf('https://') >= 0
  && jsCode.length > js.length * 0.6;
const retiredRaw = [], retiredInCode = [];
RETIRED.forEach(([n, why]) => {
  const re = new RegExp('\\b' + n + '\\b', 'g');
  const raw = (js.match(re) || []).length, cod = (jsCode.match(re) || []).length;
  if (!raw) return;
  retiredRaw.push(n + '×' + raw + (cod ? '（★ 代码里 ' + cod + ' 处）' : '（仅在注释里）'));
  if (cod) retiredInCode.push(n + ' — ' + why);
});
log.push('退役函数名: 剥注释自检 ' + (stripOk ? 'ok' : '★ 剥坏了')
  + ' · 残留 ' + (retiredRaw.length ? retiredRaw.join(' · ') : 'none'));

const ids = ['hotzone','beam','scrim','panel','btnTheme','btnClose','tpop','rail','btnRail','track','pv','pvBack','pvClose','pvName','pvMeta','pvBody','foot','toast','toastMsg','ctx','onboard','btnStart','demoCursor','q','qHist'];
const mi = ids.filter(id => html.indexOf('id="' + id + '"') < 0);
log.push('missing ids: ' + (mi.length ? mi.join(', ') : 'none'));

/* ---------- 每个可见动作都要有归宿 ----------
   起因很实在：文件夹和网址这两页曾经只能靠右键编辑 —— 卡片上没有可见入口，
   等于"能看不能改"。这类缺口不是崩溃，不会报错，只会让人以为这工具没法用。
   所以把"按钮在、逻辑不在"变成构建期就能看出来的一件事：
   扫出所有 data-act，逐个确认 JS 里出现过这个名字（通常就是 handleAct 的某个
   分支，也可能像 pin-off 那样挂着自己的 addEventListener）。
   白名单要写清理由，否则下一个人只会顺手往里加。 */
const ACT_HANDLED_ELSEWHERE = {
  'pin-off': '$("pinBar").querySelector("button").addEventListener(...) 直接挂了 togglePin(false)，不走 handleAct'
};
const acts = [...new Set((html.match(/data-act="([a-z0-9-]+)"/g) || []).map(m => m.slice(10, -1)))];
const orphan = acts.filter(a => !ACT_HANDLED_ELSEWHERE[a]
  && js.indexOf("'" + a + "'") < 0 && js.indexOf('"' + a + '"') < 0);
log.push('data-act total: ' + acts.length + ' · orphan (no handler): ' + (orphan.length ? orphan.join(', ') : 'none'));

/* ---------- 页头「+」的动作也要查 ----------
   上面那条扫的是**静态 HTML** 里的 data-act。而页头那个「+」的动作名
   登记在 HEAD_ACT 表里、由 pageHead 在运行时才拼进 DOM，静态 HTML 里
   根本搜不到 —— 于是"哪些页有 +、每个 + 有没有处理分支"整条链路
   原本都在盲区里。现在把表里每一项拿出来核对两件事：
   1) 动作必须在 handleAct 里有分支（否则就是点着没反应的按钮）；
   2) 键必须是一个真实存在的页 id（拼错页名 → 按钮永远不出现，
      而这种"缺失"同样不会有任何报错）。 */
const headTbl = js.match(/const HEAD_ACT = \{([\s\S]*?)\n\};/);
/* 先剥注释再配对。第三次栽在同一个坑上了：注释里写「原来这里是 term:'term-new'」
   是正常的记录，可它长得和一条真登记**一模一样**，于是守卫把一个删掉的条目
   又算了一遍（total 报 12，实际 11）。假绿比红更坏 —— 它让人以为有人在看着。
   顺手把页名也打出来：数字对不上时能一眼看出是多了谁、少了谁。 */
const headPairs = headTbl
  ? [...stripC(headTbl[1]).matchAll(/([a-z]+)\s*:\s*'([a-z-]+)'/g)].map(m => [m[1], m[2]])
  : [];
/* 同样用捕获组，别用 slice 数字符 —— `act === '` 是 9 个字符而 `data-act="` 是 10 个，
   照抄另一处的位数就会把每个名字削掉首字母（踩过）。 */
/* 页 id 必须从 **PAGES 表本身** 取，不能在整份源码里搜 `{ id:'xxx',` ——
   那样任何一处对象字面量里的 id（data 里的、图标表里的）都会被当成合法页名，
   于是一个拼错的页 id 只要在别处偶然出现过，守卫就会给假通过。
   这正是"范围不划清，守卫只会在错误的时刻沉默"那一次踩过的坑。 */
const pagesTbl = js.match(/const PAGES = \[([\s\S]*?)\n\];/);
const pageIds = pagesTbl ? [...new Set([...pagesTbl[1].matchAll(/id:'([a-z]+)'/g)].map(m => m[1]))] : [];
const headNoHandler = headPairs.filter(([, a]) => js.indexOf("act === '" + a + "'") < 0);
const headBadPage = headPairs.filter(([pg]) => pageIds.indexOf(pg) < 0);
log.push('head-act total: ' + headPairs.length
  + ' → ' + (headPairs.length ? headPairs.map(p => p[0]).join('/') : 'none')
  + ' · no handler: ' + (headNoHandler.length ? headNoHandler.map(p => p[0] + '→' + p[1]).join(', ') : 'none')
  + ' · bad page id: ' + (headBadPage.length ? headBadPage.map(p => p[0]).join(', ') : 'none')
  + ' · pages: ' + pageIds.length);

/* 另一头：每张卡片（data-kind）都得有右键菜单。ctx-more 拿到空菜单会
   直接 return —— 于是按钮在、点了没反应，比没有按钮更误导。
   检查必须**限定在 ctxFor 函数体内部**：第一版在全文件里找 `kind === 'x'`，
   结果 recent 撞上了 handleOpen 里同名的一个分支，报了"有菜单"——它其实
   没有，卡片上也没挂 ⋯。范围不划清，守卫就会给假通过。
   这份名单是"刻意不给菜单"的，理由写在旁边，不许顺手往里加。
   曾经唯一在册的 recent 已经补齐了（可以移除误记的条目），所以现在是空的 ——
   空名单意味着这条守卫对**每一张**卡片都是真的，是最强的状态。 */
const CTX_NO_MENU = {};
const ctxStart = js.indexOf('function ctxFor(');
const ctxEnd = ctxStart < 0 ? -1 : js.indexOf('\nfunction ', ctxStart + 1);
const ctxBody = ctxStart < 0 ? '' : js.slice(ctxStart, ctxEnd < 0 ? js.length : ctxEnd);
const kinds = [...new Set((html.match(/data-kind="([a-zA-Z]+)"/g) || []).map(m => m.slice(11, -1)))];
const nomenu = kinds.filter(k => !CTX_NO_MENU[k] && ctxBody.indexOf("kind === '" + k + "'") < 0);
log.push('data-kind total: ' + kinds.length + ' · no ctxFor branch: ' + (nomenu.length ? nomenu.join(', ') : 'none')
  + (Object.keys(CTX_NO_MENU).length ? ' · 豁免 ' + Object.keys(CTX_NO_MENU).join(',') : ' · 无豁免'));

/* 第三头：桥上暴露的能力，渲染侧必须至少有一处真调用。
   反例就在眼前：「在文件夹中显示 / 打开原文件 / 用浏览器打开」三个按钮，
   而 preload 里 sys:reveal / sys:openPath / sys:openExternal 早就通了 ——
   三个处理分支却只各弹了一句 toast。桥通了没接线，按钮就是纯摆设，
   而且是最显眼的那个主按钮。人工翻查很容易漏，逐个能力数调用点最省事。 */
/* 能力清单**从 preload 现读**，不再手工维护。
   手工那张表已经漏过一次：这一轮加了 kb / aiEmbed / aiModels 三个能力，
   表里没有它们，于是「还一行都没接线」的状态照样报绿 —— 而且绿得毫无破绽
   （bridge total 仍是 11，看着很正常）。凡是要人手同步的清单都会腐烂，
   而它腐烂的方式是「安静地通过」，这比报错难查得多。 */
const BRIDGE_EXEMPT = {
  /* JZ.platform 读的是一个字符串常量，不是可调用的能力；
     「没人读它」和「写了能力没接线」是两回事。 */
  platform: '常量值（进程平台字符串），不是可调用的能力'
};
const preSrc = has('desktop/preload.js') ? read('desktop/preload.js') : '';
const preBody = preSrc.slice(preSrc.indexOf('exposeInMainWorld'));
const BRIDGE = [...new Set([...preBody.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\s*[:(]/gm)].map(m => m[1]))]
  .filter(k => !BRIDGE_EXEMPT[k]);
const unusedBridge = BRIDGE.filter(k => js.indexOf('JZ.' + k) < 0);
log.push('bridge total: ' + BRIDGE.length + ' · 从 preload 现读 · never called: '
  + (unusedBridge.length ? unusedBridge.join(', ') : 'none')
  + ' · 豁免 ' + (Object.keys(BRIDGE_EXEMPT).join(',') || '无'));

/* 一条记录在整段文本里占的区间：从它自己的起始标记，到**下一条**的起始
   标记。以前这里图省事写成"从标记往后切 N 个字符"，结果越界读到了下一条 ——
   把 deepseek 的地址清空之后守卫照样报 none，因为窗口滑进了 dashscope，
   被下一家的 https 满足了 /baseUrl:'http/。范围不划到边界，守卫只会在
   最需要它报错的时刻沉默。 */
function sliceEntries(text, re){
  const marks = [...text.matchAll(re)];
  return marks.map((m, i) => {
    const from = m.index;
    const to = (i + 1 < marks.length) ? marks[i + 1].index : text.length;
    return [m[1], text.slice(from, to)];
  });
}

/* ---------- 动作分支不许重复 ----------
   handleAct 是一长串 else-if，先命中的那个生效，后面同名的那个永远不执行。
   它是**悄悄死的**：不报错、不警告，只在你想改行为的时候发现"改了没反应"。
   这一轮光改一次就攒出四个重复分支（link-new / ask-tpl-new / col-clear /
   reset-content）。扫描范围限定在 handleAct 函数体内 —— 别的分发器
   （搜索结果 activateSearchRow）也用了同名的 act 参数，混在一起会误报。 */
const haStart = js.indexOf('function handleAct(');
const haEnd = haStart < 0 ? -1 : js.indexOf('\nfunction ', haStart + 1);
const haBody = haStart < 0 ? '' : js.slice(haStart, haEnd < 0 ? js.length : haEnd);
const actBranches = [...haBody.matchAll(/act === '([a-z-]+)'/g)].map(m => m[1]);
const actDup = [...new Set(actBranches.filter((a, i) => actBranches.indexOf(a) !== i))];
log.push('handleAct 分支: ' + actBranches.length + ' · 重复分支: ' + (actDup.length ? actDup.join(', ') : 'none'));

/* ---------- handleOpen 同样不许有重复分支 ----------
   同一个坑、另一个分发器。handleOpen 是一长串 else-if（kind === '…'），
   先命中的生效。这一轮就是在这里抓到的：note / shot 各写了两遍，
   后一遍（"点一下复制" / "点一下提示已钉住"）从来没执行过 ——
   而它读起来完全像是有意为之。handleAct 有这条守卫，handleOpen 当时漏了，
   于是同一类错误在另一半代码里继续长。
   另外顺手点名"有 kind 但 handleOpen 里没分支"的：这类 kind 在搜索结果里
   点下去什么都不发生（搜到了却按不动）。只有当这个 kind 的行自带 data-act、
   永远轮不到 handleOpen 时才允许豁免，豁免要写在这里，不许默许。 */
const hoStart = js.indexOf('function handleOpen(');
const hoEnd = hoStart < 0 ? -1 : js.indexOf('\nfunction ', hoStart + 1);
const hoBody = hoStart < 0 ? '' : js.slice(hoStart, hoEnd < 0 ? js.length : hoEnd);
const okBranches = [...hoBody.matchAll(/kind === '([a-zA-Z]+)'/g)].map(m => m[1]);
const okDup = [...new Set(okBranches.filter((a, i) => okBranches.indexOf(a) !== i))];
const HO_EXEMPT = ['sceneCard', 'sceneAct'];   /* 永远自带 data-act，走不到 handleOpen */
const okMissing = kinds.filter(k => okBranches.indexOf(k) < 0 && HO_EXEMPT.indexOf(k) < 0);
log.push('handleOpen 分支: ' + okBranches.length + ' · 重复分支: ' + (okDup.length ? okDup.join(', ') : 'none')
  + ' · 无分支(豁免 ' + (HO_EXEMPT.length ? HO_EXEMPT.join('/') : '无') + '): '
  + (okMissing.length ? okMissing.join(', ') : 'none'));

/* ---------- 分组头「+」的动作也要查 ----------
   和页头「+」是同一个坑：动作名登记在 GROUP_ADD 表里、由 gcard 在运行时
   才拼进 DOM，静态 HTML 里根本搜不到。把表里每一项拿出来核对两件事：
   1) 动作必须在 handleAct 里有分支；
   2) key 必须是一个真实出现过的 data-kind（拼错的 kind 会让那个分组的
      「+」永远不出现 —— 同样不会有任何报错）。 */
const grpTbl = js.match(/const GROUP_ADD = \{([\s\S]*?)\n\};/);
const grpPairs = grpTbl ? [...grpTbl[1].matchAll(/([a-zA-Z]+)\s*:\s*'([a-z-]+)'/g)].map(m => [m[1], m[2]]) : [];
const grpNoHandler = grpPairs.filter(([, a]) => js.indexOf("act === '" + a + "'") < 0);
const grpBadKind = grpPairs.filter(([k]) => kinds.indexOf(k) < 0);
log.push('group-add total: ' + grpPairs.length
  + ' · no handler: ' + (grpNoHandler.length ? grpNoHandler.map(p => p[0] + '→' + p[1]).join(', ') : 'none')
  + ' · bad kind: ' + (grpBadKind.length ? grpBadKind.map(p => p[0]).join(', ') : 'none'));

/* ---------- 存档表的完整性 ----------
   COLLECTIONS 是"哪些东西会被记住"的唯一名单，而这里面每一行都有三个
   必须成对出现的部件：seed（恢复示例）、fix（外部输入规整）、page（清空/
   恢复之后要重画哪一页）。漏掉任何一个都不会报错，只会表现成
   "点了「恢复示例」没反应"或者"清空了页面还显示旧数据" —— 正是最费时间的
   那类问题。FORMS 那张表同理：它决定每个 kind 能不能改。 */
const colTbl = js.match(/const COLLECTIONS = \[([\s\S]*?)\n\];/);
const colBody = colTbl ? colTbl[1] : '';
const colKeys = [...colBody.matchAll(/key:'([a-zA-Z]+)'/g)].map(m => m[1]);
const colBad = [];
sliceEntries(colBody, /\{ key:'([a-zA-Z]+)'/g).forEach(([k, one]) => {
  const noSeed = !/seed:/.test(one);
  const noFix  = !/fix:/.test(one);
  const pg = one.match(/page:'([a-z]+)'/);
  const badPage = !pg || pageIds.indexOf(pg[1]) < 0;
  if (noSeed || noFix || badPage)
    colBad.push(k + '[' + (noSeed ? '缺seed ' : '') + (noFix ? '缺fix ' : '')
      + (badPage ? 'page不对:' + (pg ? pg[1] : '无') : '') + ']');
});
log.push('collections: ' + colKeys.length + ' · 不完整: ' + (colBad.length ? colBad.join(', ') : 'none'));

/* noSeed 与空 seed 必须一致：标了 noSeed 却带着一堆演示数据（设置页不给你
   「恢复示例」，可数据里其实有），或者 seed 明明是空的却没标 noSeed
   （设置页摆一个按下去什么都不恢复的按钮）—— 两种都是"界面在说假话"。 */
const seedBad = [];
sliceEntries(colBody, /\{ key:'([a-zA-Z]+)'/g).forEach(function(e){
  const k = e[0], one = e[1];
  const noSeed = /noSeed\s*:\s*true/.test(one);
  const emptySeed = /seed\s*:\s*\(\)\s*=>\s*\[\s*\]/.test(one);
  if (noSeed !== emptySeed) seedBad.push(k + (noSeed ? '[标了noSeed但不是空seed]' : '[seed为空却没标noSeed]'));
});
log.push('collections noSeed 一致性: ' + (seedBad.length ? seedBad.join(', ') : 'none'));

const formTbl = js.match(/const FORMS = \{([\s\S]*?)\n\};/);
const formBody = formTbl ? formTbl[1] : '';
const formRows = [];
sliceEntries(formBody, /\n  ([a-zA-Z]+):\s*\{/g).forEach(([k, one]) => {
  formRows.push(k);
  const coll = one.match(/coll:'([a-zA-Z]+)'/);
  if (!coll || colKeys.indexOf(coll[1]) < 0) formRows.push('!' + k);
});
log.push('forms: ' + formRows.filter(s => s[0] !== '!').length
  + ' · coll 不存在: ' + (formRows.filter(s => s[0] === '!').map(s => s.slice(1)).join(', ') || 'none'));

/* ---------- AI 配置 ----------
   服务商预设表里每一家都必须给出地址与模型名，否则选中它之后状态条只会
   说"还没填"，用户不知道该填什么。
   另外设置页里每个 data-ai 的字段名都必须能在 state.settings.ai 的默认值
   里找到 —— 拼错一个字母，输入框就会变成一个"存了但没人读"的黑洞，
   界面上完全看不出来。 */
const aiTbl = js.match(/const AI_PROVIDERS = \[([\s\S]*?)\n\];/);
const aiEntries = aiTbl ? sliceEntries(aiTbl[1], /\{ id:'([a-z]+)'/g) : [];
const aiBad = [];
aiEntries.forEach(([id, one]) => {
  if (id === 'custom') return;   /* 自定义本来就该留空，让用户自己填 */
  if (!/baseUrl:'https?:\/\//.test(one)) aiBad.push(id + '[缺baseUrl]');
  if (!/model:'[^']/.test(one))          aiBad.push(id + '[缺model]');
});
log.push('ai providers: ' + aiEntries.length + ' · 缺地址或模型名: ' + (aiBad.length ? aiBad.join(', ') : 'none'));

/* alts = 「这家自己报上来的名字」，界面拿它渲染成可点的候选（aiModelChoices）。
   这里有一条会咬人的不变量：**预设的 model 必须在自己家的 alts 里**。
   否则 aiModelWarn 会对一个配置完全正确的用户报"这个名字不在名单里" ——
   假警报比没有警报更坏：用户会去改一个本来就对的东西。

   这条守卫的由来是一次真实的"DeepSeek 连不上"（2026-09-22）：存档里的 model
   是 'deepseek-chatdeepseek-flash' —— 输入框里原有 deepseek-chat，光标停在
   末尾又敲了一遍新名字，两个模型名拼成了一个词。Key 与网络都是好的
   （/v1/models 返回 200），服务端回的是 400。修法是让名单可点，
   而"可点"要成立，前提就是预设名自己得先在名单里。 */
const aiAltsBad = [];
let aiAltsHomes = 0;
aiEntries.forEach(([id, one]) => {
  const m = one.match(/alts:\[([^\]]*)\]/);
  if (!m) return;
  aiAltsHomes++;
  const list = (m[1].match(/'([^']+)'/g) || []).map(s => s.slice(1, -1));
  const preset = (one.match(/model:'([^']+)'/) || [])[1];
  if (!preset || list.indexOf(preset) < 0) aiAltsBad.push(id + '[预设 ' + preset + ' 不在名单里]');
});
log.push('ai alts: ' + aiAltsHomes + ' 家带候选名单 · 预设名不在自家名单里: '
  + (aiAltsBad.length ? aiAltsBad.join(', ') : 'none'));

/* 模型名候选的三处接线：卡里渲染这一块、动作分支能接住点选、状态条会说
   "不在名单里"。少任何一处，名单就只是一块好看的死东西 —— 而它在代码里
   看起来完全正常（"我写了"和"它接上了"是两件事，这个项目里已经栽过）。 */
const modelWireBad = [
  ['卡里渲染', js.indexOf('+ aiModelChipsHtml(c)') >= 0],
  ['点选分支', js.indexOf("act === 'ai-model-use'") >= 0],
  ['状态条告警', /const warn = aiModelWarn\(c\);/.test(js)]
].filter(x => !x[1]).map(x => x[0]);
log.push('模型名候选接线: ' + (modelWireBad.length
  ? '★ 缺 ' + modelWireBad.join(' / ')
  : 'ok（渲染 / 点选 / 告警 三处齐全）'));

const aiFields = [...new Set((js.match(/data-ai="([a-zA-Z]+)"/g) || []).map(m => m.slice(9, -1)))];
/* apiKey 是**派生字段**：它没有独立的存储位置，值取自 keys[当前服务商]
   （见 aiCfg）。留这一条在册是因为派生本身是刻意的 —— 存两份"当前 Key"
   迟早会走散，一份改了另一份没改，报出来的 401 就查不出原因。 */
const AI_FIELD_DERIVED = { apiKey: '派生自 keys[当前服务商]，不单独存' };
const aiDefKeys = ['provider','baseUrl','model','temperature','maxTokens','keys'];
const aiOrphan = aiFields.filter(f => aiDefKeys.indexOf(f) < 0 && !AI_FIELD_DERIVED[f]);
log.push('ai fields: ' + aiFields.join(',') + ' · 无对应配置项: '
  + (aiOrphan.length ? aiOrphan.join(', ') : 'none')
  + ' · 派生 ' + Object.keys(AI_FIELD_DERIVED).join(','));

log.push('color-mix left: ' + (html.match(/color-mix/g) || []).length);

/* ---------- 主题表 ----------
   原来这一行写死 /id:'(sunny|mint|berry)'/。加主题的时候它照样报 3，
   而"3"看上去完全正常 —— 一条永远不会因为"新主题没接上"而报错的守卫，
   等于装饰。改成从 THEMES 数组体里数，并逐套核对必填字段。
   这里只查"源码里写没写"，"运行时是不是真的补到 9 位色阶"由走查探针验
   （探针能直接读 THEMES.every(t => t.hues.length === 9)）。 */
const thStart = js.indexOf('const THEMES = [');
let thBody = '';
if (thStart >= 0){
  const thEnd = js.indexOf('\n];', thStart);
  thBody = js.slice(thStart, thEnd < 0 ? js.length : thEnd);
}
const themeIds = [...thBody.matchAll(/id:\s*'([a-z0-9]+)'/g)].map(m => m[1]);
const thNeed = ['name:', 'sub:', 'paper:', 'paper3:', 'side:', 'ink1:', 'ink3:', 'ink4:', 'hues:', 'glow:'];
const thMissing = [];
themeIds.forEach(id => {
  const at = thBody.indexOf("id:'" + id + "'");
  const seg = thBody.slice(at, at + 600);
  thNeed.forEach(k => { if (seg.indexOf(k) < 0) thMissing.push(id + '.' + k.replace(':', '')); });
});
const huesPadOk = /const HUES_PAD = \[[^\]]*\];[\s\S]{0,200}THEMES\.forEach\(/.test(js);
log.push('themes: ' + themeIds.length + ' · id: ' + (themeIds.join(' / ') || 'none')
  + ' · 缺字段: ' + (thMissing.length ? thMissing.join(', ') : 'none')
  + ' · 色阶补齐规则: ' + (huesPadOk ? 'ok' : '★ 缺失'));

/* 图标覆盖率：I 的 key 与代码里引用的图标名 */
/* ---------- 桌面版打包白名单 ----------
   package.json 的 build.files 是**白名单**：没登记进去的文件开发模式下
   一切正常（相对路径就在磁盘上），只有打包之后才会 "Cannot find module"。
   这种错只会在用户机器上出现，所以必须在构建期就核对：
   main.js / preload.js 里每一个 require('./x') 都得在白名单里。 */
const pkgPath = path.join(dir, 'desktop', 'package.json');
const missingInPack = [];
if (has('desktop/package.json')){
  const pkg = JSON.parse(read('desktop/package.json'));
  const list = (pkg.build && pkg.build.files) || [];
  ['main.js', 'preload.js'].forEach(f => {
    if (!has('desktop/' + f)) return;
    [...read('desktop/' + f).matchAll(/require\('\.\/([A-Za-z0-9_.-]+)'\)/g)]
      .map(m => m[1]).forEach(rel => {
        if (list.indexOf(rel) < 0) missingInPack.push(f + ' → ' + rel);
      });
  });
  ['main.js', 'preload.js'].forEach(f => {
    if (!has('desktop/' + f)) return;
    if (list.indexOf(f) < 0) missingInPack.push('(入口) ' + f);
  });
}
log.push('打包白名单: ' + (missingInPack.length
  ? '漏登记 ' + missingInPack.join(', ')
  : 'ok（main/preload 及其相对依赖都在 files 里）'));

/* ---------- 终端的原生依赖：三处必须同时登记 ----------
   终端和 AI 那一块的风险等级不一样，差别在"它是原生模块"：
     · dependencies   —— 装得到（npm install 在 node_modules 里放 .node）
     · build.files    —— 进得去（**白名单**，不登记的话开发模式照跑，
                          因为 node_modules 就在旁边，打包后才报
                          "Cannot find module '@lydell/node-pty'"）
     · build.asarUnpack —— 能被 dlopen（.node 压在 asar 里加载不了，
                          必须解出来）
   漏第三处的表现最迷惑：模块"找得到"但"加载不了"，报的是
   "was compiled against a different Node.js version" 之类的误导信息。 */
/* 白名单里的通配要能真正判定「覆盖」：一条 node_modules 全量通配
   （两个星号那种写法）是覆盖 node_modules/@lydell/node-pty 的。
   只比字面前缀的话，把白名单换成通配就报假红。 */
function globToRe(g){
  let out = '';
  for (let i = 0; i < g.length; i++){
    const c = g[i];
    if (c === '*'){
      if (g[i + 1] === '*'){ out += '(?:.*)'; i++; if (g[i + 1] === '/') i++; }
      else out += '[^/]*';
    } else out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$');
}
function coversPath(list, target){
  return (list || []).some(function (f){
    try { return globToRe(String(f)).test(target); } catch (e){ return false; }
  });
}
const nativeBad = [];
if (has('desktop/package.json')){
  const p2 = JSON.parse(read('desktop/package.json'));
  const deps = p2.dependencies || {};
  const fl = (p2.build && p2.build.files) || [];
  const un = (p2.build && p2.build.asarUnpack) || [];
  if (!deps['@lydell/node-pty']) nativeBad.push('dependencies 缺 @lydell/node-pty（终端要它）');
  if (!deps['@xterm/xterm'])     nativeBad.push('dependencies 缺 @xterm/xterm');
  if (!deps['@xterm/addon-fit']) nativeBad.push('dependencies 缺 @xterm/addon-fit');
  /* 知识库要解析 PDF / Word：这两条链的传递依赖很深（pdf-parse → pdfjs-dist
     → @napi-rs/canvas），逐条列举必然漏，所以白名单收成了 node_modules 全量通配。
     守卫这边改成按 glob 判覆盖，仍然能抓到「把通配删掉」这种情况。 */
  if (!deps['mammoth'])    nativeBad.push('dependencies 缺 mammoth（.docx 解析要它）');
  if (!deps['pdf-parse'])  nativeBad.push('dependencies 缺 pdf-parse（.pdf 解析要它）');
  if (!coversPath(fl, 'node_modules/@lydell/node-pty')) nativeBad.push('files 未覆盖 node_modules/@lydell/node-pty');
  if (!coversPath(fl, 'node_modules/@xterm/xterm'))     nativeBad.push('files 未覆盖 node_modules/@xterm/xterm');
  if (!coversPath(fl, 'node_modules/@xterm/addon-fit')) nativeBad.push('files 未覆盖 node_modules/@xterm/addon-fit');
  if (!coversPath(fl, 'node_modules/mammoth'))          nativeBad.push('files 未覆盖 node_modules/mammoth');
  if (!coversPath(fl, 'node_modules/pdf-parse'))        nativeBad.push('files 未覆盖 node_modules/pdf-parse');
  if (!un.some(f => f.indexOf('.node') >= 0)) nativeBad.push('asarUnpack 缺 **/*.node（原生模块压进 asar 加载不了）');
  /* 这三个是我们自己的模块，不是原生依赖，但同样属于「白名单漏一条就
     打包后才报 Cannot find module」的那一类 —— 本轮的 kb.js 就差点漏。
     按 glob 判，所以全量通配那种写法不会被误判成缺。 */
  ['main.js', 'preload.js', 'ai.js', 'term.js', 'kb.js', 'zones.js'].forEach(function (f){
    if (!coversPath(fl, f)) nativeBad.push('files 未覆盖 ' + f);
  });
}
log.push('终端打包登记: ' + (nativeBad.length ? '★ ' + nativeBad.join(' · ') : 'ok（依赖/白名单/解包三处齐全）'));

const iconKeys = (js.match(/^\s{0,2}([a-zA-Z]+):\s*$/gm) || []).length;
const usedIcons = new Set();
(js.match(/IC\('([a-zA-Z]+)'/g) || []).forEach(m => usedIcons.add(m.slice(4, -1)));
(js.match(/icon:'([a-zA-Z]+)'/g) || []).forEach(m => usedIcons.add(m.slice(6, -1)));
(js.match(/data-i="([a-zA-Z]+)"/g) || []).forEach(m => usedIcons.add(m.slice(8, -1)));
log.push('icons referenced: ' + usedIcons.size);
log.push('icon block keys: ' + new Set((js.match(/^  ([a-zA-Z]+):$/gm) || []).map(s => s.trim().slice(0, -1))).size);

/* ---------- 守卫总账 ----------
   上面十几条守卫各自把结论写进了 log。问题是：要人把 _build_result.txt
   从头读到尾，守卫就只算半个 —— 忘了看的那一次，红的和绿的长得一样。
   这里用**谓词**复述一遍每条守卫的判据（不是去猜日志文本长什么样：
   第一版就是猜的，`handleOpen 分支: … 重复分支: board … 无分支: none`
   因为行里还有另一个 "none" 而被判成绿 —— 猜字符串的守卫会自己骗自己）。
   新增守卫时把它的谓词补进这张表，否则新守卫的失败不进总账。 */
/* --- 终端的三条收尾约束 ---
   ① **清空正文只能有一个口子**。原先 renderPage / invalidatePage / refresh /
      导入存档 四处各写一遍 `delete b.dataset.rendered; b.innerHTML=''`，
      只有 renderPage 记得先把终端的常驻容器摘走。其余三处一旦触发，
      xterm 就画在一棵已经不在文档里的树上 —— 会话还在跑、屏幕上什么都没有。
      现在全部经 blankBody，所以"这行拼接"在全文件里应当恰好只剩 1 处。
   ② **常驻容器只能靠 TERM_BOX 那份引用找回**。改用 getElementById 的话，
      在"已被清出文档"这一刻它返回 null，于是新建一个空盒子、老树丢掉。
   ③ **标签列表被整体换掉时必须收掉会话**。挂点在 COLLECTIONS 的 terms.set 上：
      不做这一步，列表空了而主进程里的 powershell 还在跑 —— 看不到、也关不掉。 */
const rawClear = (js.match(/delete b\.dataset\.rendered/g) || []).length;
const boxLookup = (js.match(/\(['"]termBox['"]\)/g) || []).length;
const pruneWired = /key:'terms'[\s\S]{0,900}?termPrune\(\)/.test(js);
log.push('终端收尾: 清空正文口子 ' + (rawClear === 1 ? '1 处（blankBody）' : '★ ' + rawClear + ' 处')
  + ' · termBox 查找 ' + (boxLookup === 0 ? 'none' : '★ ' + boxLookup + ' 处（应用 TERM_BOX）')
  + ' · 批量换标签收会话 ' + (pruneWired ? 'ok' : '★ 缺'));

/* ---------- 嵌入模型的配置 ----------
   和 AI 那两条同一个道理，但对象是知识库那一套：
     ① EMBED_PROVIDERS 里每一家（自定义除外）都要有地址与模型名，
        否则选中它之后用户不知道该填什么；
     ② 设置页每个 data-emb 字段名都要能在 settings.ai.embed 的默认结构里找到 ——
        拼错一个字母，这个输入框就会变成一个「存了但没人读」的黑洞。
   单独立两条而不是塞进 ai-* 那两条：这是**另一组**配置，
   混在一起之后「改了嵌入地址把聊天也改了」会变成一个安静的 bug。 */
const embTbl = js.match(/const EMBED_PROVIDERS = \[([\s\S]*?)\n\];/);
const embEntries = embTbl ? sliceEntries(embTbl[1], /\{ id:'([a-z]+)'/g) : [];
const embBad = [];
embEntries.forEach(function (mx){
  const id = mx[0], one = mx[1];
  if (id === 'custom') return;
  if (!/baseUrl:'https?:\/\//.test(one)) embBad.push(id + '[缺baseUrl]');
  if (!/model:'[^']/.test(one))           embBad.push(id + '[缺model]');
});
log.push('embed providers: ' + embEntries.length + ' · 缺地址或模型名: '
  + (embBad.length ? embBad.join(', ') : 'none'));

const embFields = [...new Set((js.match(/data-emb="([a-zA-Z]+)"/g) || []).map(m => m.slice(10, -1)))];
/* provider 是选出来的、apiKey 存在 embed.keys[当前嵌入服务商] 下（派生），
   其余都是 embed 上的普通字段。 */
const EMB_DERIVED = { apiKey:'派生自 embed.keys[当前嵌入服务商]', provider:'选项，存在 embed.provider' };
const embDefKeys = ['provider', 'baseUrl', 'model', 'keys'];
const embOrphan = embFields.filter(f => embDefKeys.indexOf(f) < 0 && !EMB_DERIVED[f]);
log.push('embed fields: ' + (embFields.join(',') || 'none') + ' · 无对应配置项: '
  + (embOrphan.length ? embOrphan.join(', ') : 'none')
  + ' · 派生 ' + Object.keys(EMB_DERIVED).join(','));

/* 界面上"发出来的嵌入配置" ↔ ai.js 里"读得懂的字段名"，两边的契约。
   加这条是因为它真的断过一次，而且断得毫无征兆：aiEmbedCfg() 发的是
   { provider, baseUrl, model, apiKey }，而 buildEmbedBody 读的是
   r.embedBaseUrl || r.baseUrl、r.embedApiKey || r.apiKey、
   **r.embedModel（没有 || r.model）** —— 三格里两格回落了、偏偏模型名没回落。
   后果：用户在设置页把模型名填得好好的，点「测试嵌入」和「加文件夹」都只拿到
   一句「还没填嵌入模型名」。
   它为什么能活下来：单元测试（_llmtest）用的是 embedModel，正好是真实链路上
   从来不会有人传的那个名字。**测试用了实现喜欢的名字，就等于没测。**
   这条守卫没法验"跑起来通不通"（那是桌面自检的事），但能把"两边名字对不上"
   这个静态事实钉死。 */
const embCfgFn = js.match(/function aiEmbedCfg\(\)\{([\s\S]*?)\n\}/);
const embCfgRet = embCfgFn ? embCfgFn[1].match(/return \{([\s\S]*?)\};/) : null;
const embCfgKeys = embCfgRet
  ? [...new Set((embCfgRet[1].match(/([a-zA-Z]+)\s*:/g) || []).map(m => m.slice(0, -1).trim()))]
  : [];
const aiSrc = has('desktop/ai.js') ? read('desktop/ai.js') : '';
const embBodyFn = aiSrc.match(/function buildEmbedBody\(cfg\)\{([\s\S]*?)\n\}/);
const embBody = embBodyFn ? embBodyFn[1] : '';
/* provider 只在界面侧用来取 keys[provider]，ai.js 不认也不需要认它。 */
const EMB_WIRE_EXEMPT = { provider:'只在界面侧用来取 keys[当前服务商]' };
const EMB_WIRE = [
  ['baseUrl', /r\.embedBaseUrl\s*\|\|\s*r\.baseUrl/],
  ['model',   /r\.embedModel\s*\|\|\s*r\.model/],
  ['apiKey',  /r\.embedApiKey\s*\|\|\s*r\.apiKey/]
];
const embWireBad = EMB_WIRE
  .filter(([k, re]) => embCfgKeys.indexOf(k) >= 0 && !re.test(embBody))
  .map(([k]) => k + '[ai.js 读不到朴素名]');
log.push('embed 字段名契约: 界面发 ' + (embCfgKeys.join(',') || 'none')
  + ' · ai.js 读不出: ' + (embWireBad.length ? embWireBad.join(', ') : 'none')
  + (embBody ? '' : ' · ★ buildEmbedBody 没找到'));

/* ---------------------------------------------------------------
   窗口分区：编译不出来时必须如实报错，不许落成假成功。
   2026-09-22 抓到的那一次：某台机器上 Add-Type 现场编译 C# 失败
   （%TEMP% 里的 dll 起不来），于是 [JZz] 不存在、EnumWindows 一次没跑，
   脚本后面的分支却照常走完，最后吐 {"total":0,"ok":true} ——
   界面会说"整理好了"，一个窗口没动，还不给理由。
   这正是本项目最忌讳的那一类：**点得动、点了什么都不会发生**。
   守住两件事不回退：类型体检要排在用它之前，编码要排在编译之前。 */
const zsrc = fs.existsSync('desktop/zones.js') ? fs.readFileSync('desktop/zones.js', 'utf8') : '';
const zTypeChk = /"JZz"\s*-as\s*\[type\]/.test(zsrc);
/* `\))` 写一次不够：源码里是 `if (-not ("JZz" -as [type])) {` —— 两层括号。
   这类"守卫一上线就红"要分清是谁的错：先看形状，别急着改产品。 */
const zEarlyExit = /-as\s*\[type\][)]{1,2}\s*\{[\s\S]{0,900}?exit\s+1/.test(zsrc);
const zEarlyMsg = /不是报一句/.test(zsrc) && /ok = \$false/.test(zsrc);
/* 输出编码那句必须排在 Add-Type **之前**：否则提前退出时还没设编码，
   JSON 里的中文按 GBK 出去，宿主读回来是乱码 —— 错误信息比没有更难查。 */
const encLine = zsrc.split('\n').findIndex(l => l.indexOf('OutputEncoding') >= 0);
const addTypeLine = zsrc.split('\n').findIndex(l => l.indexOf('Add-Type -TypeDefinition') >= 0);
const zEncFirst = encLine >= 0 && addTypeLine >= 0 && encLine < addTypeLine;
log.push('窗口分区诚实失败: 类型体检 ' + (zTypeChk ? 'ok' : '★ 没有')
  + ' · 提前退出 ' + (zEarlyExit ? 'ok' : '★ 没有')
  + ' · 带原因 ' + (zEarlyMsg ? 'ok' : '★ 没有')
  + ' · 输出编码在 Add-Type 之前 ' + (zEncFirst ? 'ok（第 ' + (encLine + 1) + ' 行 < '
    + (addTypeLine + 1) + ' 行）' : '★ 不在'));
const GUARDS = [
  ['语法',        () => !syntaxErr],
  ['函数齐全',    () => missing.length === 0],
  ['退役函数',    () => stripOk && retiredInCode.length === 0],
  ['节点齐全',    () => mi.length === 0],
  ['data-act',    () => orphan.length === 0],
  ['head-act',    () => headNoHandler.length === 0 && headBadPage.length === 0],
  ['data-kind',   () => nomenu.length === 0],
  ['bridge',      () => unusedBridge.length === 0],
  ['handleAct',   () => actDup.length === 0],
  ['handleOpen',  () => okDup.length === 0 && okMissing.length === 0],
  ['group-add',   () => grpNoHandler.length === 0 && grpBadKind.length === 0],
  ['collections', () => colBad.length === 0],
  ['noSeed',      () => seedBad.length === 0],
  ['xterm-vendor',() => vendorMissing.length === 0],
  ['terminal-pack',() => nativeBad.length === 0],
  ['terminal-teardown',() => rawClear === 1 && boxLookup === 0 && pruneWired],
  ['forms',       () => !formRows.some(s => s[0] === '!')],
  ['ai-providers',() => aiBad.length === 0],
  ['ai-alts',     () => aiAltsBad.length === 0],
  ['ai-model-wire',() => modelWireBad.length === 0],
  ['ai-fields',   () => aiOrphan.length === 0],
  ['embed-providers',() => embEntries.length >= 2 && embBad.length === 0],
  ['embed-fields',() => embFields.length >= 3 && embOrphan.length === 0],
  ['embed-wire',  () => embCfgKeys.length >= 3 && embBody !== '' && embWireBad.length === 0],
  ['themes',      () => themeIds.length >= 3 && thMissing.length === 0 && huesPadOk],
  ['打包白名单',  () => missingInPack.length === 0],
  ['分区诚实失败',() => zTypeChk && zEarlyExit && zEarlyMsg && zEncFirst]
];
const guardBad = GUARDS.filter(([, ok]) => { try { return !ok(); } catch (e){ return true; } });
log.push('守卫总账: ' + (guardBad.length
  ? '★ 不绿 ' + guardBad.length + '/' + GUARDS.length + ' 条 → ' + guardBad.map(g => g[0]).join(' / ')
  : '全绿（' + GUARDS.length + ' 条）'));

fs.writeFileSync(path.join(dir, '_build_result.txt'), log.join('\n'), 'utf8');
