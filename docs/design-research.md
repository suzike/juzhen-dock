# 前端设计优化 · 调研笔记（R0）

> 目标：在动手优化前，先到 GitHub 上看高星前端组件库怎么做设计，
> 把可迁移的经验提炼成本项目的 10 轮优化方案。
> 本项目的美学身份是「纸墨」——九套主题各一套纸面、一套墨色、一个主色，
> 大面积铺色会"花"。借鉴的是**体系**（令牌、动效、状态、可访问性），不是外观。

## 一、调研对象（GitHub 高星）

| 库 | 星级（约） | 借鉴点 |
|---|---|---|
| MUI / Material UI | 120k+ | 高程（elevation）分级、统一的交互状态矩阵、动效缓动标准值 |
| Ant Design（蚂蚁） | 90k+ | 4/8 间距节奏、字阶（type ramp）、语义色映射（成功/警示/危险）、密度控制 |
| shadcn/ui（Radix + Tailwind） | 90k+ | 设计令牌即 CSS 变量、令牌是主题的唯一事实来源、可访问性原语（focus-visible、键盘管理） |
| Chakra UI | 38k+ | 组件尺寸档位（sm/md/lg）一套走天下、一致的 hover/active/disabled |
| Mantine | 28k+ | 阴影/圆角档位化、暗色模式由令牌推导而非逐条覆盖 |
| Element Plus / Naive UI | 25k / 17k | 中文排版的行高与字重习惯、表单控件的中轴对齐 |
| Arco Design（字节）/ Semi（抖音）/ TDesign（腾讯） | 5k–9k | 令牌分层（全局 → 组件）、动效令牌化、主题商店思路 |

另外单独立面参考 **Open Props**（令牌变量库）：
- 缓动按"强度档位"成族（ease-1…5 / spring / bounce）；
- 时长档位：instant 0ms / quick 80ms / moderate 260ms / gentle 420ms；
- 阴影带"色调 + 强度"两个旋钮（`--shadow-color` + `--shadow-strength`），一套阴影适配明暗两版；
- z-index 层级表（layer-1…5 + important）。

## 二、提炼成原则（每条都有本轮落点）

1. **令牌先行**（R1）：间距 4/8 节奏、圆角/字阶/阴影/时长/缓动/层级全部进 `:root`，
   主题只换"纸面 + 墨 + 主色"，结构令牌全主题共享。硬编码值逐批收编。
2. **排版是一等公民**（R2）：字阶固定档位；所有数字（尺寸、时间、计数）用
   `tabular-nums`——跳动是廉价感最大的来源；分组标签用字距 + 小字号做大写般的层级。
3. **动效有度量**（R3）：时长三档（快 140 / 中 240 / 慢 420ms），入场用弹性曲线、
   退场用快出曲线；每个可点元素有按压反馈；`prefers-reduced-motion` 一刀切关停。
4. **状态设计**（R4）：空态不是一句"没有"而是"下一步做什么"；加载用骨架不转圈；
   禁用必须带原因；徽标一套形状语义（计数 / 演示 / 不可用）。
5. **键盘与焦点**（R5/R10）：全局搜索支持 ↑↓ Enter Esc；focus-visible 环全局统一；
   纯图标按钮必须有可读名（aria-label）。
6. **功能增强也是设计**（R5–R8）：搜索分组高亮、今日进度环、换算器新单位组与
   一键复制、片段收藏与筛选——设计优化离开功能就是刷漆。
7. **主题扩展守边界**（R9）：新主题仍只带"纸面 + 墨 + 主色"三样，沿用现有
   色阶补齐规则（构建守卫盯着），不引入第二套结构变量。
8. **可访问性不是附加**（R10）：对比度按 WCAG 查（项目已有 probe28），
   滚动条/选区/光标这些"没人管的地方"也是门面。

## 三、来源

- shadcn/ui 设计原理与令牌体系：[Vercel — Anatomy of shadcn/ui](https://vercel.com) 、
  [Newline — Design Tokens](https://www.newline.co)、[ui.shadcn.com — Typeset](https://ui.shadcn.com)
- Open Props 令牌分档：[open-props.style](https://open-props.style/)
- 国产三系概览：[掘金 — B端常用9大开源组件库](https://juejin.cn)（Arco / Semi / TDesign 收录对比）
- 星级格局：[best-of-react（GitHub）](https://github.com/lukasmasuch/best-of-react)、
  [refine.dev — React Ecosystem](https://refine.dev)
