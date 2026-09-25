# 聚珍 · Juzhen Dock

![version](https://img.shields.io/badge/version-0.5.0-blue)
![platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![license](https://img.shields.io/badge/license-MIT-green)

**常驻 Windows 屏幕右侧的桌面入口。** 鼠标碰到屏幕右缘即滑出，离开自动收起；
文件夹、网址、剪贴板、真终端、AI 速问都在一层之内，不用切窗口、不用找图标。

整个项目只有一份 UI 源码，同时产出**浏览器原型**与 **Electron 桌面版**两种形态。

> **直接下载桌面版**（免安装、免 Node 环境）：
> [聚珍 v0.5.0 便携版 · Windows x64](https://github.com/suzike/juzhen-dock/releases/latest)
>
> 首次启动若被 SmartScreen 拦下，选「更多信息 → 仍要运行」。源码全部公开，可自行构建复核。

---

## 一、功能板块

主界面共 14 个板块，按用途分为 5 组：

| 分组 | 板块 | 说明 |
|---|---|---|
| **今日** | 今日概览 | 待办 · 最近 · 场景，一屏看全 |
| **常用入口** | 文件夹直达 | 按父目录自动归类，点击直达 |
| | 快捷网址 | 按用途自动归类 |
| **内容沉淀** | 收藏箱 | 粘贴链接，自动识别平台 |
| | 临时暂存 | 引用式记录，点击即预览 |
| | 剪切板 | 持久留存，自动分型 |
| **效率工具** | 场景切换 | 一次点击切换整组环境 |
| | 终端 | 真 ConPTY 会话，多标签 |
| | 片段与命令 | 可复制，带变量占位 |
| | 工程换算 | 单位换算 · 湿空气 · PMV |
| | 速记 | 想到就记，不打断思路 |
| | 贴图 | 参考图钉在窗口最上层 |
| | AI 速问 | 唤出即问，可一键存入速记 |
| **系统** | 设置 | 配色、触发方式与显示方式 |

另有**窗口分区**：一键把桌面上散乱的窗口整理到预设分区，并支持还原。

---

## 二、两种形态

### 1. 浏览器原型（零依赖）

```
juzhen-dock/prototype.html
```

**单文件、563 KB、双击即开。** 全部 CSS、JS、插画、图标都内联在一个 HTML 里，
不需要 `npm install`，不需要构建。适合快速看效果、改样式、做设计评审。

浏览器里桌面版专有的能力（真实终端、窗口分区、贴图钉屏）不会渲染 —— 这是设计，
不是缺陷：一份源码靠 `window.JZ` 分流，见「架构」。

### 2. Electron 桌面版

```
juzhen-dock/desktop/
```

```bash
cd juzhen-dock/desktop
npm install
npm start                 # 开发运行

npm run pack              # 打包便携版 exe → dist/聚珍-<版本>-便携版.exe
```

> `.npmrc` 已配置 npmmirror 镜像，国内网络可直接安装。

---

## 三、架构

### 单文件构建流水线

**不维护两份 UI。** `_build.js` 按固定顺序拼装源码片段，一次产出两个产物：

```
_js_a.txt  ─┐                     ┌─→ prototype.html        （浏览器原型）
_icons.txt ─┤                     │
_illus.txt ─┤                     │
_js_b.txt  ─┼─→ _build.js ────────┤
_tools.txt ─┤   （含 27 条守卫）   │
_term.txt  ─┤                     └─→ desktop/app/index.html （Electron 前端）
_js_c.txt  ─┘

_css.txt  ──→ 内联进以上两者
```

分部件的理由：`_js_c.txt` 是 270 KB 的巨型文件，整文件改动的评审成本过高；
拆成 8 个片段后，改配色只碰 `_css.txt`，改终端只碰 `_term.txt`。

**`_term.txt` 必须排在 `_js_c.txt` 之前** —— 后者末尾是启动序列。

### 桌面版与浏览器版的分流

```js
const DESK = !!(window.JZ && window.JZ.isDesktop);
```

同一份 `index.html`：浏览器里 `window.JZ` 不存在 → 纯前端模式；
Electron 里 `preload.js` 注入 `window.JZ` → 启用真实终端、窗口分区等原生能力。

### Electron 侧模块

| 文件 | 职责 |
|---|---|
| `main.js` | 主进程：窗口策略、热区轮询、自检（`JZ_DIAG=1`） |
| `preload.js` | 唯一的渲染进程 ↔ 主进程桥（逐条白名单，不暴露 `ipcRenderer`） |
| `term.js` | ConPTY 终端会话管理 |
| `ai.js` | AI 服务商适配（8 家对话 + 5 家嵌入） |
| `kb.js` | 知识库：切片、嵌入、检索（RAG） |
| `zones.js` | 窗口分区：矩形计算 + PowerShell 执行 |

**窗口策略**：不是全屏透明穿透窗口，而是收起时 `win.hide()`、展开只覆盖右侧 680 px。
热区判定靠主进程以 40 ms 轮询 `screen.getCursorScreenPoint()`（因此不依赖任何原生模块），
判定逻辑抽成纯函数以便喂坐标自检 —— **自检不会真去移动用户的鼠标。**

---

## 四、验证体系

这个项目的验证不靠"看着没问题"，靠**可执行判据**。

### 1. 构建期守卫（27 条）

`node _build.js` 结束时打印一行总账：

```
守卫总账: 全绿（27 条）
```

守卫覆盖的范围（每一条都是谓词，不是字符串猜谜）：

- 语法、函数白名单、`data-act` / `data-kind` 孤条目
- **桥上每个能力必须 ≥1 处真实调用** —— 能跑通 ≠ 接线了
- **跨文件字段名契约**（界面发 `{provider,baseUrl,model,apiKey}`，`ai.js` 必须读得出）
- **退役函数名**：删函数必须连调用点一起删，名字进 `RETIRED` 表后
  在**剥掉注释**的代码里再出现就报红
- 打包白名单、终端依赖登记、主题色阶补齐

> **守卫写完必须反向验证一次**：故意改坏 → 确认报红 → 还原。
> 不能失败的守卫只是装饰。

### 2. 走查探针

以无头 Chrome 真实走查产物，逐条断言，按板块分文件：

```
_probe10.js   页头版式（13 页文字不被插画遮挡）
_probe23.js   可见入口审计
_probe28.js   主题与 WCAG 对比度
_probe29.js   终端页（116 项）
_probe32.js   透明度（按 alpha 断言，不看截图）
...
```

**验收读数字，不读截图** —— 30% 与 100% 透明度的截图差别很淡，
"看着差不多"可能真没生效。

### 3. 模块级单元测试（纯 Node，不依赖 Electron）

```bash
node _aitest.js      # AI 服务商适配
node _llmtest.js     # 错误映射（401/402/404/429）
node _kbtest.js      # 知识库检索
node _termtest.js    # 终端
node _pmvtest.js     # PMV 热舒适模型
node _zonetest.js    # 窗口分区矩形计算
node _zonerun.js     # 窗口分区真跑一次 PowerShell
```

### 4. Electron 端自检

```bash
JZ_DIAG=1 electron desktop --disable-gpu --disable-software-rasterizer --no-sandbox
```

逐页截图 + 结构化报告，写到 `userData/juzhen-dock-diag/_deskcheck.txt`。

> `--no-sandbox` 是承重参数：漏掉会导致 GPU 进程反复崩溃、以 exit 3 退出，
> 且**自检报告只写下第一行就没了**，症状与"抢不到单实例锁"完全一样。

---

## 五、AI 与知识库

**8 家对话服务商 + 5 家嵌入服务商**，各自独立配置地址与模型名。
换服务商时地址与模型名自动跟着换，**绝不复用 A 家的 Key 给 B 家**。

- **Key 存本机**：`settings.ai.keys[provider]`，明文存于本机 `localStorage`
  与 `userData`。不上传、不入库、不同步。
- **模型名带候选名单**：预设名不在服务商自家名单里时界面告警并允许点选 ——
  手抄的模型名会错，而且错得**像是网络问题**。
- **知识库诚实边界**：开启「只看知识库」时，若不可用 / 失败 / 无命中，
  **明确拒绝作答并说明原因**，绝不静默降级成模型自答；非该模式则声明
  「这条回答没接地」。
- 网页抓取**不执行 JavaScript**，抓不到就如实报错，不假装拿到了内容。

---

## 六、已知边界

以下项目**当前未实现**，界面以灰标签标注现状，不留"点得动、点了没反应"的开关：

| 项目 | 现状 |
|---|---|
| 贴图钉屏 | 尚未实现 |
| 文件内容解析 | 能打开、能定位，**不按扩展名解析内容** |
| 「最近使用」条目 | 只能移除，不能改名 |
| 窗口分区摆位 | 分区矩形计算与脚本执行已测；`SetWindowPos` 实际搬动窗口需人工点一次确认 |

另外两条**测量工具本身的局限**（不是产品缺陷，写在这里免得下一个人误判）：

- Electron `capturePage` 偶尔抓不到 xterm 那一层 —— **不要用截图判断终端有没有画出来**，
  判据是 `.xterm-rows` 的 `textContent`。
- 窗口隐藏时 Chromium 会暂停 `requestAnimationFrame`，xterm 的 `fit()` 不跑、
  不重绘 —— 这是"没机会画"，不是"画不出来"。

---

## 七、目录结构

```
.
├── juzhen-dock/
│   ├── _build.js              # 构建 + 27 条守卫
│   ├── _js_a.txt              # ┐
│   ├── _icons.txt             # │
│   ├── _illus.txt             # │
│   ├── _js_b.txt              # ├ 8 个源码片段
│   ├── _tools.txt             # │
│   ├── _term.txt              # │
│   ├── _js_c.txt              # ┘（270 KB，必须最后拼）
│   ├── _css.txt               # 样式（内联进产物）
│   ├── prototype.html         # ★ 构建产物 · 浏览器原型，双击即开
│   ├── _probe*.js             # 走查探针
│   ├── _zonetest.js           # 窗口分区：矩形计算
│   ├── _zonerun.js            # 窗口分区：真跑 PowerShell
│   ├── _*test.js              # 模块级单元测试
│   └── desktop/               # ★ Electron 桌面版
│       ├── main.js            #   主进程
│       ├── preload.js         #   桥（逐条白名单）
│       ├── term.js            #   ConPTY 终端
│       ├── ai.js              #   AI 服务商适配
│       ├── kb.js              #   知识库 RAG
│       ├── zones.js           #   窗口分区
│       ├── app/index.html     # ★ 构建产物 · 桌面版前端
│       └── app/vendor/        #   xterm.js
└── _ref/
    └── agentic-island/        # 设计参考（git submodule）
```

> 克隆后若要取得设计参考代码：
> ```bash
> git submodule update --init --recursive
> ```

---

## 八、许可

MIT，见 [LICENSE](LICENSE)。
