/* 渲染进程与主进程之间唯一的通道。
   原型里所有"演示"动作（打开文件夹、开网址、读剪切板、存取档）
   都从 window.JZ 是否存在来判断自己跑在桌面版还是浏览器里 ——
   同一个 prototype.html 因此可以两用，不必维护两份。 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/* 窗口分区那两条调用的参数归一化。裸字符串与对象都收，主进程只认对象 ——
   写在这里而不是各调用点，是因为"发的人"以后还会多（托盘、快捷键、
   以后可能有的换边），每一处都自己拼一次对象，迟早有一处漏。 */
const normZoneArg = o => (typeof o === 'string') ? { layout: o } : (o || {});

contextBridge.exposeInMainWorld('JZ', {
  isDesktop: true,
  platform: process.platform,

  /* 存档 */
  store: {
    read:   ()        => ipcRenderer.invoke('store:read'),
    write:  (data)    => ipcRenderer.invoke('store:write', data),
    path:   ()        => ipcRenderer.invoke('store:path'),
    clear:  ()        => ipcRenderer.invoke('store:clear'),
    export: (data)    => ipcRenderer.invoke('store:export', data),
    import: ()        => ipcRenderer.invoke('store:import')
  },

  /* 真实系统 */
  openPath:     (p)   => ipcRenderer.invoke('sys:openPath', p),
  openExternal: (u)   => ipcRenderer.invoke('sys:openExternal', u),
  reveal:       (p)   => ipcRenderer.invoke('sys:reveal', p),
  pickFolder:   ()    => ipcRenderer.invoke('sys:pickFolder'),
  pickFile:     ()    => ipcRenderer.invoke('sys:pickFile'),
  meta:         ()    => ipcRenderer.invoke('sys:meta'),
  /* 批量问"这些路径在不在"。场景卡片靠它把失效的动作当场标出来 */
  probe:        (list) => ipcRenderer.invoke('sys:probe', list),
  /* 执行一条命令（场景里的 cmd 动作）。执行前渲染侧会先弹确认 */
  runCmd:       (cmd, cwd) => ipcRenderer.invoke('sys:runCmd', cmd, cwd),
  /* 把拖进来的文件复制成"实体副本"，返回副本的真实路径 */
  copyIn:       (p)   => ipcRenderer.invoke('store:copyIn', p),

  clipboard: {
    read:  () => ipcRenderer.invoke('clip:read'),
    write: (t) => ipcRenderer.invoke('clip:write', t)
  },

  /* AI 速问。放在主进程发：渲染侧直连要过 CORS（各家放行策略不一致），
     而且请求头里的 API Key 也就不必经过页面自身。 */
  aiChat: (req) => ipcRenderer.invoke('ai:chat', req),
  /* 单独试嵌入模型 / 列可用模型。设置页那两颗按钮走这里 ——
     "这个地址 + 这个模型名到底能不能出向量"只有真发一次请求才知道。 */
  aiEmbed:  (cfg, input) => ipcRenderer.invoke('llm:embed', { cfg: cfg, input: input }),
  aiModels: (cfg)        => ipcRenderer.invoke('llm:models', { cfg: cfg }),

  /* 知识库。全部 invoke：每一步都有"加了多少块 / 跳过了几个 / 为什么跳过"
     这类数字要回到界面上，做成单向消息就只能显示"已添加"。 */
  kb: {
    state:     (embed)        => ipcRenderer.invoke('kb:state', { embed: embed }),
    addFolder: (embed, dir)   => ipcRenderer.invoke('kb:addFolder', { embed: embed, dir: dir }),
    addFiles:  (embed, paths) => ipcRenderer.invoke('kb:addFiles', { embed: embed, paths: paths }),
    addUrl:    (embed, url)   => ipcRenderer.invoke('kb:addUrl', { embed: embed, url: url }),
    addText:   (embed, title, text, key) => ipcRenderer.invoke('kb:addText', { embed: embed, title: title, text: text, key: key }),
    remove:    (id)           => ipcRenderer.invoke('kb:remove', { id: id }),
    clear:     ()             => ipcRenderer.invoke('kb:clear'),
    reindex:   (embed)        => ipcRenderer.invoke('kb:reindex', { embed: embed }),
    search:    (embed, q, k)  => ipcRenderer.invoke('kb:search', { embed: embed, query: q, k: k })
  },

  /* 窗口分区。三条都要走 invoke：整理与还原是**会真动别人窗口**的操作，
     界面必须拿到"动了几块、跳过了几个、为什么跳过"，做成单向消息就只能
     显示"已整理"。

     参数形状在这里归一化：老的裸字符串（'quad'）和新的一整个对象
     （{ layout:'quad' }）都收。主进程那三个 handler 只认对象 ——
     渲染侧传对象却在这一层又被包成 { layout: { layout:'quad' } } 的话，
     主进程认不出来，会**静默退回默认的 split2**：界面点了"四分格"，
     窗口按"左右二分"摆，而且没有任何报错。本轮就是自检里那条
     "请求 split3、回执 layout=split2"把它抓出来的。 */
  zones: {
    state:   (o) => ipcRenderer.invoke('zones:state', normZoneArg(o)),
    apply:   (o) => ipcRenderer.invoke('zones:apply', normZoneArg(o)),
    restore: ()  => ipcRenderer.invoke('zones:restore')
  },

  /* 真终端。avail/ensure 用 invoke（有结果，界面要知道"到底起没起来"）；
     输入/改尺寸/杀会话用单向 send（每敲一个键发一次，走 invoke 会积
     一堆没人看的 Promise）。输出由主进程推回来。 */
  pty: {
    avail:   ()            => ipcRenderer.invoke('pty:avail'),
    ensure:  (id, opts)    => ipcRenderer.invoke('pty:ensure', id, opts),
    input:   (id, data)    => ipcRenderer.send('pty:input', id, data),
    resize:  (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill:    (id)          => ipcRenderer.send('pty:kill', id),
    killAll: ()            => ipcRenderer.send('pty:killall'),
    onData:  (fn)          => ipcRenderer.on('jz:pty', (_e, d) => fn(d)),
    onExit:  (fn)          => ipcRenderer.on('jz:ptyexit', (_e, d) => fn(d))
  },
  /* 让窗口真的拿到焦点。热区唤出用的是 showInactive()（刻意不抢焦点），
     那种状态下终端敲字一个字符都进不去 —— 进终端板块时显式要一次。 */
  focusPanel: () => ipcRenderer.send('panel:focus'),

  /* 拖进来的 File 对象 → 磁盘真实路径。
     Electron 32+ 的 File 不再带 .path，必须走 webUtils。 */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (e){ return ''; }
  },

  /* 面板 */
  ready:     ()    => ipcRenderer.send('panel:ready'),
  hide:      ()    => ipcRenderer.send('panel:hide'),
  quit:      ()    => ipcRenderer.send('panel:quit'),
  setPinned: (v)   => ipcRenderer.send('panel:pin', v),
  setDelay:  (ms)  => ipcRenderer.send('panel:delay', ms),
  /* "全屏应用时屏蔽热区"。开关真正生效的地方在主进程的热区判定里，
     渲染侧只负责把用户的选择送过去。 */
  setFsBlock: (v)  => ipcRenderer.send('panel:fsblock', v),
  closed:    ()    => ipcRenderer.send('panel:closed'),
  onPanel:   (fn)  => ipcRenderer.on('jz:panel', (_e, d) => fn(d)),
  /* 托盘里切换了贴住状态，主进程推回来 */
  onPin:     (fn)  => ipcRenderer.on('jz:pin', (_e, v) => fn(v)),
  /* 全屏探测的真实状态（第一个读数要等子进程把脚本编译起来才出得来，
     所以只能推，不能只在启动时问一次） */
  onFs:      (fn)  => ipcRenderer.on('jz:fs', (_e, d) => fn(d))
});
