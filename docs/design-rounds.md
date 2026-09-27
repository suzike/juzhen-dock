# 前端设计优化 · 十轮验收台账

> 执行周期：2026-09-27。每轮结束由**独立审查 agent**按当轮验收标准复核，
> 判定含 heavyweight（重量级）与 quality（质量）两个维度；JSON 判定原文存各 agent 报告。
> 设计依据：[design-research.md](design-research.md)（shadcn/ui、MUI、Ant Design、
> Open Props、Arco/Semi/TDesign 等高星库的经验提炼）。
> 验收工具：27 条构建守卫 + `_probe34.js` 运行时冒烟（R5 轮新增）+ `_probe28.js` WCAG。

| 轮 | 主题 | 重量级内容 | 独立审查判定 |
|---|---|---|---|
| R1 | 设计令牌体系 | :root 新增 7 类结构令牌（间距 4/8 节奏、时长三档、缓动、高程、z 层表 8 档、焦点环旋钮、--fs-hero）；收编 260 处消费（117 时长 / 131 间距 / 8 z层 / 4 影·焦）；刻意例外 --dp/--di/--beam 带理由保留 | PASS · 重 260 处消费核验逐项吻合 |
| R2 | 排版与数字可读性 | 全站数字等宽（body 级 tabular-nums + 四类长文豁免名单）；字重四档令牌收编 114 处；页头「分组 · 两位页码」眉标落全部 14 页（短色条沿袭主色点缀传统） | PASS · 反向验证截图对 DOM 敏感 |
| R3 | 动效系统 | **修复真实缺口**：R1 新令牌不在"减少动效"覆盖内（117 处过渡无视动效开关）；全局按压缩放（`:where()` 降特异性——初版误用高特异性覆盖定制深压，审查抓出后修正）；--ease-out/--ease-in-out 死令牌接线；页头入场编排 | PASS · 缺口修复成立 |
| R4 | 状态设计 | 空态组件化（图标+主句+提示+真实动作按钮，3 处接线 folder-new/link-new/shot-paste）；骨架屏挂在真实 AI run 态（motion-off 与 reduced-motion 双关停）；统一禁用态；.badge 三档徽标 | PASS · 遗留：搜索页眉标 undefined（转 R5） |
| R5 | 全局搜索体验 | 修掉搜索页「undefined · 00」眉标 bug（pageHead 条件化 + 合成对象补 group）；命中高亮 `<mark class="hl">`；搜索历史（存 8 条/浮层/三个管理动作/blur 竞态保护） | 首审 **FAIL**：顶层 const TDZ 引用后置声明，整页加载即崩（静态守卫抓不到，无头渲染实锤）→ 一行修复 + 新增 `_probe34.js` 永久冒烟 → 复验 **PASS** |
| R6 | 今日概览升级 | 时段问候 + 当前场景进页头；SVG 待办进度环（空清单如实「—」不画假 100%，中央字号消化 --fs-hero）；快捷加待办（回车/按钮/焦点管理闭环，完整表单保留） | PASS · 环数学 17% 与种子数据逐位核对 |
| R7 | 工程换算增强 | 单位组 7→14（长度/质量/面积/体积/换热系数/导热系数/密度，系数 NIST 口径独立推导验算 Δ=1.13e-10）；结果行整行复制（带单位）；行尾 ⇄ 反向换算（dataset 走全精度，不经 fmtNum 截位） | PASS · 14 组/数学 ok/精度通道闭环 |
| R8 | 片段与速记增强 | 片段收藏（fav 存档字段 + ★ 筛选视图分离，重启保留/编辑不抹）；速记标签筛选（标签从数据现长，日期分组走筛选后集合）；片段变量会话级记忆回填 | PASS · fav 生命周期推理完整 |
| R9 | 主题系统扩展 | 新主题「黛色」「朱砂」（对比度 15.11:1 / 14.82:1，主题库 9→11 过色阶守卫）；夜间自动水墨七件套（口径函数/默认值/boot 接线/边界定时器/设置开关/关停恢复/手动选择预告） | PASS · 唯一缺口 nightAuto 默认字段仅注释 → 已补一行代码 |
| R10 | 可访问性与键盘操作 | 六类可点卡片焦点化（tabindex + 统一 Enter/空格激活，走同一 click 委托）；5 个开关 role=switch 补 aria-label；toast role=status aria-live；::selection 主色化；probe28 全主题对比度无不达标 | PASS · 输入路径零误伤（宿主判定 + tagName 豁免双保险） |
| R11 | 曜黑重构（深色仪表盘） | 主题系统深浅双模式：applyTheme/vars 派生链去白化（solid 驱动 + mixc 模式分支 + 纯黑阴影），CSS 结构白面收编 19+ 处；新主题曜夜/流萤（对比度 15.1/13.9:1）；夜间自动只接管浅色；进度环柔光 | PASS · 浅色派生数值逐项等于旧值零回归；两处残留（hover 洗色 ×4、tp-chips 白托）已清理 |
| R12 | 跟随系统 + 深色体验补全 | followSystem 设置（系统深色→曜夜，优先级高于夜间自动，两者互斥双向让位）；matchMedia 实时监听；color-scheme 注入（原生控件深浅）；_probe35 深色残留探针（曜夜 14 页零亮块） | PASS · 反向验证证实 color-scheme 回归只有渲染断言能接住 |
| R13 | 搜索升级命令面板 | 「动作」组置顶：9 条动作（新增×4/切换场景/换算/终端/导出存档/换主题）全部经 shim 复用 handleAct 既有分支零新造执行器；kw 补充词让「备份」搜到「导出」 | PASS · 9/9 动作无头断言可渲染可命中 |
| R14 | AI 速问 Markdown 渲染 | looksMd 探测门控（9/9 用例，行中单个 * 不误判）——有结构才走 renderMd，纯文本零回归；XSS 封闭（esc 先行）；代码块悬停复制（解码纯代码进剪切板） | PASS · 流式 :empty 骨架链不受影响 |
| R15 | 速问视觉与流式体验 | 回答气泡化（--surf 凹档）；流式块光标（reduced-motion 常显不闪）；代码块语言标签（截 12 字，给复制键让位） | PASS · R14 零回归（looksMd/骨架/复制键原样）；深色气泡/代码层次偏含蓄记为观感备注 |
| R16 | 主题切换圆形揭示 | View Transitions：applyThemeFx 坐标门控（只有用户点击才异步转场，程序化路径保持同步——首版全异步被 probe28 抓出 obsidian 1.07<7，修复后复验全绿）；VT CSS vt-fade/vt-reveal 142% 半径 | PASS · 反向验证删坐标门控后 probe28 精确复现 1.07 并被抓——探针体系独立接住该类回归 |
| R17 | 微内容细节 | Toast 倒计时进度条（2400ms 双处对齐，重置手法 none→reflow→空）；空态图标砖主题色光晕（veil 派生，深浅自适配）；侧栏激活图标微弹（spring） | PASS · 反向验证双向数值：删重置行则 restarted=0「条走完吐司还在」；微瑕三条（color 渐变覆盖已修）不阻塞 |
| R18 | 效率细节两连 | 片段变量**单表单化**（N+1 轮弹框 → 一次填完；会话记忆回填；取消不复制半成品）+ 待办完成沉底（纯展示排序，数据次序不动） | 首审 **FAIL**（fields 漏 k 键 → 输入塌缩 out[undefined]，必填拦截与留空语义矛盾）→ 补 k + req:false → 复验 **PASS**（Node 仿真三例 + 沉底 dump-dom） |
| R19 | 命令面板扩容 + 会话行美化 | 动作 9→13 条（读取剪切板/新开速问会话/贴图钉屏/夜间自动开关，新增 moon 双色图标）；当前会话名字点亮（cb-ink + bold） | PASS · 反向验证实锤「翻转失效时 toast 照报旧状态」的语义撒谎形态，实装行是必要承载 |
| R20 | 贴图钉窗随主题换装 | acc 链路九环：渲染侧发起 → 主进程 #RRGGBB 正则校验（sanitize + update 双处）→ jz:shotacc 推送 → 钉窗 paintAcc；setTheme paint 广播新主色给全部钉窗 | PASS · 链路九环无断点；JZ_DIAG 钉窗 5/5；CSS 注入面封闭（三处正则一致） |
| R21 | 快捷键帮助 + 主题弹层键盘导航 | `?` 一屏看全全部键位（askConfirm 同款 minip 生命周期；输入框豁免）；主题弹层开层落焦 + ↑↓ 导航 + Enter 原生激活；命令面板加「查看快捷键」 | PASS · 8 条键位文案逐条对源码无虚构；两处措辞偏差（Esc 顺序/Ctrl+Enter 范围）与 sc 块重复已修 |
| R22 | 统计数字 CountUp | 今日页两格统计从上次值滚到新值（560ms 三次方缓出 rAF）；首渲染/不变/减少动效三态不演；并发后写者胜终值正确 | 首审 **FAIL**（调用点漏传 cuKey → countUp 死代码，静态 grep 判据被源码行满足）→ 补两实参 + 渲染断言 data-cu=2 → 修复确认 |
| R23 | 空态图标个性化 | emptyBox 第三参 icon：场景 route/片段 code/速记 note/贴图 camera/文件夹 folder/网址 globe，默认 tray 兼容 | 首审 **FAIL**（函数签名未加第三参，6 处调用全是死参数；IC 失败形态查明：查无返回空 svg 静默进缓存）→ 补签名 → 产物断言接线为真 |
| R24 | 拖拽排序 | 全站统一协议（容器 data-dragsort/条目 data-dsid/drop 回调 DRAG_CB 三段式）：今日待办 + 片段组内，落盘即持久 | PASS · 行为级模拟 11 项全过；两处结构瑕疵（snip 键 g.name 误写、applyGroupOrder 死代码）已修 |
| R25 | 速问停止生成 + 存为片段 | 中止链路四层（渲染 token/IPC stopToken/主进程 ASK_STOP 表/ai.js extSignal 接入），abortedByUser 与超时严格区分；回答一键存为片段（「AI 回答」分组） | PASS · 单元级直测 9/9（慢速服务中止 234ms 返回）；_aitest 回归全过 |
| R26 | 真实站标 favicon | 网址行 + 剪切板 link 卡站标（google s2 服务 lazy 加载），error 委托三级降级（站标→图标→文字）；最近使用悬停显全路径 | PASS · 10/10 站标 src 与 host 一致；favicon 覆盖链死选择器已修（同位叠放）；内网域名第三方请求记为已知权衡 |
| R27 | 数据自动备份 | 每日快照轮转（backups/store-YYYY-MM-DD.json，保 7 份删最老，同日去重），writeStore 成功后触发、失败静默；store:backups/backup 两桥；设置页「自动备份」行（份数/最新/立即备份/打开目录）；备份即完整存档，可直接走导入恢复 | 首审 **FAIL**（R29 的 applyHotkey 作用域错误致启动必崩，被端到端实证）→ 修复后复验：备份生成 30832B/同日去重/轮转删至恰 7 份，全部实测 |
| R28 | 会话导出 + 使用计数 | copySessMd：整段问答拼 Markdown 复制（askSess ⋯ 菜单入口）；片段 uses 计数（fix 白名单重启保留、复制 +1、卡片 uses>0 才显示） | PASS · 审查建议 reverse（导出按先问后答）与取消不计数两处已修 |
| R29 | 唤起键可配置 | 三选一（Alt+Space / Ctrl+Alt+J / Ctrl+Shift+Space）动态重注册；白名单校验；boot 同步；Ctrl+Alt+J 永远兜底 | 首审 **FAIL**（applyHotkey 作用域 + ctrl-shift-space 分支缺失 + 气泡文案硬编码）→ applyHotkey 挪模块顶层 + 补第三键 toggle + 气泡随实际键 → 复验（JZ_DIAG 全绿零异常）|

## 过程结论（写给下一轮）

1. **静态守卫 + 运行时冒烟缺一不可**：R5 的 TDZ 崩溃 27 条守卫全绿照放行——
   守卫管语法与接线，"页面起来没有"只有真开一次才知道。`_probe34.js` 从此是常驻验收步骤。
2. **全局兜底规则必须 `:where()` 降权**：否则它是覆盖而不是兜底（R3 按压缩放教训）。
3. **顶层 const 声明永远放在它依赖的东西之后**（R5 教训，已写进源码注释）。
4. 审查 agent 抓到的真问题清单：特异性覆盖（R3）、搜索页 undefined 眉标（R4→R5）、
   TDZ 致命崩溃（R5）、nightAuto 默认字段未落地（R9）、vars() 白派生在深色下不可读
   （R11，probe28 抓出流萤 4.05<4.5）——五条全部修复并复验。
