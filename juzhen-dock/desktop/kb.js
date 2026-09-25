/* ============================================================
   聚珍 · 知识库（本地 RAG）
   ------------------------------------------------------------
   链路：文件夹 / 文件 / 网页 / 一段文本
        → 按扩展名读成纯文本（PDF 走 pdf-parse、docx 走 mammoth）
        → 按段落切块（约 900 字、150 字重叠）
        → 调 OpenAI 兼容的 /embeddings 向量化
        → 落本机 JSON（原子写）
        → 检索时把问题也向量化，余弦相似取 top-k
        → 交给模型"只依据这些片段回答"，回答里带（片段N）引用

   三条设计约束（沿用 agentic-island 的做法，理由见各自注释）：
     1) **不 require electron**：存储目录与 embed 函数都由外部注入。
        否则这个文件只能在开了窗口的进程里跑，也就只能靠手点来验。
     2) **解析器惰性 require**：PDF / Word 的解析器没装时降级成"跳过并说明"，
        而不是整个知识库起不来。
     3) **诚实计量**：向量维度、块数、跳过了多少、为什么跳过，全部如实上报。
        知识库最容易被做假的地方就是"看起来索引了 200 个文件"。

   与 agentic-island 的取舍：
     · **去掉 wiki（LLM 合成知识页）**：那是另一条独立功能的入口，
       不是"文件接入 → 检索 → 接地作答"这条链路的一部分。
       留着一组没有界面调用的函数，就是"功能上死掉、读起来还活着"的代码。
     · **新增**：全局块数上限（见 MAX_CHUNKS 的注释）、内存缓存、
       软链接跳过、写操作串行化。这四条都是"长期用会出事"的那一类。
   ============================================================ */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/* ---------- 可调参数 ---------- */
const CHUNK = 900;           /* 每块目标字数 */
const OVERLAP = 150;         /* 相邻块的重叠字数（跨越切点的那句话不至于两边都断） */
const MAX_FILES = 2000;      /* 单次扫描的文件数上限 */
const MAX_TEXT_BYTES = 1500000;
const MAX_DOC_BYTES = 30 * 1024 * 1024;
/* 向量化分批：同时限"条数"与"总字符"。很多 embedding 端点对单请求 token 有硬
   上限，一次塞 50 个 900 字的块会直接 400 —— 而报出来的错往往看不出是这个原因。 */
const EMBED_MAX_ITEMS = 16;
const EMBED_MAX_CHARS = 24000;
/* 单文件块数上限：一个 1.5 MB 的日志文件能切出 1700 块，把整个索引撑成几十兆，
   而它对"回答问题"的边际价值很低。超出的部分不索引，并如实计入 skipReasons。 */
const MAX_CHUNKS_PER_FILE = 300;
/* 全库块数上限。索引是一份 JSON、每次检索都要读进内存，所以必须有上界 ——
   否则"加了一个大文件夹"会让面板在每次提问时卡住好几秒，而用户不知道原因。 */
const MAX_CHUNKS = 6000;

const TEXT_EXT = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst', '.org', '.tex',
  '.csv', '.json', '.yaml', '.yml', '.toml', '.ini', '.log',
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.java', '.c', '.cpp', '.cc',
  '.h', '.hpp', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.cs', '.vue', '.svelte',
  '.html', '.css', '.scss', '.sql', '.sh', '.ps1', '.bat', '.m', '.r', '.lua',
  /* 汽车软件这一行真在用、但"文本扩展名清单"里经常被漏掉的几种：
     A2L 标定描述、DBC 报文定义、ARXML 架构描述、SLX 之外常见的 .xml 变体。 */
  '.a2l', '.dbc', '.arxml']);
const BINARY_DOC_EXT = new Set(['.pdf', '.docx']);
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next',
  '.cache', 'coverage', '__pycache__', '.venv', 'venv', 'target', 'vendor']);

let storeDir = '';
let embedFn = null;
function storeFile(){ return path.join(storeDir, 'kb-index.json'); }
function initKb(opts){
  const o = opts || {};
  storeDir = String(o.dir || '');
  embedFn = typeof o.embed === 'function' ? o.embed : null;
  /* 目录自己建：原子写走的是 "<file>.tmp" → rename，目录不在时 writeFile 直接抛，
     而那个错会表现成"加文件夹失败"这种看不出原因的样子。 */
  try { fs.mkdirSync(storeDir, { recursive: true }); } catch (e){ /* */ }
  cache = null; cacheSig = '';
}

/* ---------- 读 / 写（原子写 + 串行化 + 内存缓存） ---------- */
let cache = null, cacheSig = '';
function sig(){ try { const st = fs.statSync(storeFile()); return st.size + ':' + st.mtimeMs; } catch (e){ return 'none'; } }
async function load(){
  const s = sig();
  if (cache && cacheSig === s) return cache;
  let data;
  try {
    data = JSON.parse(await fsp.readFile(storeFile(), 'utf8'));
  } catch (e){
    if (e && e.code !== 'ENOENT'){
      /* 索引坏了不要让整个功能哑掉：把它挪到 .bad.json 留证据，然后从空库开始。 */
      try { await fsp.copyFile(storeFile(), storeFile().replace(/\.json$/, '.bad.json')); } catch (e2){ /* */ }
    }
    data = { sources: [], docs: [] };
  }
  if (!data || typeof data !== 'object') data = { sources: [], docs: [] };
  if (!Array.isArray(data.sources)) data.sources = [];
  if (!Array.isArray(data.docs)) data.docs = [];
  cache = data; cacheSig = sig();
  return cache;
}
async function save(s){
  const p = storeFile();
  const tmp = p + '.tmp';
  const text = JSON.stringify(s);
  await fsp.writeFile(tmp, text, 'utf8');
  try { await fsp.rename(tmp, p); }
  catch (e){
    /* Windows 上目标被占用时 rename 会失败；退化成直接写，并清掉临时文件。 */
    await fsp.writeFile(p, text, 'utf8');
    try { await fsp.unlink(tmp); } catch (e2){ /* */ }
  }
  cache = s; cacheSig = sig();
}
/* 写操作串行化：UI 上连点两下"重新扫描"，两个 reindex 交错跑会把索引写成
   两份互相覆盖的结果（第二次读到的还是第一次写之前的快照）。 */
let chain = Promise.resolve();
function serial(fn){
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

/* ---------- 读文本 ---------- */
/* 返回 { text } 或 { skip: '原因' }。原因要具体到"是哪个环节不行"，
   因为用户唯一的出路就是据此去装依赖 / 换格式 / 删文件。 */
async function readFileText(file){
  const ext = path.extname(file).toLowerCase();
  try {
    if (BINARY_DOC_EXT.has(ext)){
      const st = await fsp.stat(file);
      if (st.size > MAX_DOC_BYTES) return { skip: '文件超过 ' + Math.round(MAX_DOC_BYTES / 1048576) + ' MB' };
      if (ext === '.pdf'){
        let PDFParse;
        try { ({ PDFParse } = require('pdf-parse')); }
        catch (e){ return { skip: '没装 pdf 解析器（desktop 目录下 npm i pdf-parse）' }; }
        const buf = await fsp.readFile(file);
        const parser = new PDFParse({ data: new Uint8Array(buf) });
        const r = await parser.getText();
        if (parser.destroy) { try { await parser.destroy(); } catch (e2){ /* */ } }
        const t = String((r && r.text) || '')
          /* pdf-parse v2 会在页与页之间插「-- 1 of 12 --」页码标记，
             不剥掉的话这些标记会被切进块里、混进向量，检索时变成噪声。 */
          .replace(/\n*-- \d+ of \d+ --\n*/g, '\n\n').trim();
        return t ? { text: t } : { skip: 'PDF 里没提取到文字（可能是扫描件）' };
      }
      let mammoth;
      try { mammoth = require('mammoth'); }
      catch (e){ return { skip: '没装 Word 解析器（desktop 目录下 npm i mammoth）' }; }
      const r = await mammoth.extractRawText({ path: file });
      const t = String((r && r.value) || '').trim();
      return t ? { text: t } : { skip: 'Word 文档里没提取到文字' };
    }
    if (TEXT_EXT.has(ext)){
      const st = await fsp.stat(file);
      if (st.size > MAX_TEXT_BYTES) return { skip: '文本文件超过 ' + Math.round(MAX_TEXT_BYTES / 1048576) + ' MB' };
      const raw = await fsp.readFile(file, 'utf8');
      /* 二进制文件被当成 .txt 命名时读进来会是一堆 U+FFFD；这种"读到了但没意义"
         的东西必须挡住，否则会污染索引、还会让向量化白花钱。 */
      const bad = (raw.match(/\uFFFD/g) || []).length;
      if (raw.length > 200 && bad / raw.length > 0.02)
        return { skip: '内容是二进制或非 UTF-8 编码' };
      return { text: raw };
    }
    return { skip: '不支持的格式（' + (ext || '无扩展名') + '）' };
  } catch (e){
    return { skip: '读取失败：' + String((e && e.message) || e).slice(0, 60) };
  }
}

/* ---------- 扫描 ---------- */
async function walk(dir, acc){
  const out = acc || [];
  if (out.length >= MAX_FILES) return out;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch (e){ return out; }
  for (let i = 0; i < entries.length; i++){
    if (out.length >= MAX_FILES) break;
    const e = entries[i];
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    /* 软链接一律不进：Windows 的目录联接能造出环，走进去会无限递归。 */
    if (e.isSymbolicLink && e.isSymbolicLink()) continue;
    if (e.isDirectory()){
      if (!SKIP_DIR.has(e.name)) await walk(full, out);
    } else {
      const ext = path.extname(e.name).toLowerCase();
      if (TEXT_EXT.has(ext) || BINARY_DOC_EXT.has(ext)) out.push(full);
    }
  }
  return out;
}

/* ---------- 切块 ---------- */
/* 按空行分段聚合到 ~900 字，带 150 字重叠；单段超长就硬切。
   重叠是必要的：跨越切点的那句结论如果两边各断一半，两边都检索不准。 */
function chunkText(text){
  const clean = String(text || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const paras = clean.split(/\n\n+/);
  const chunks = [];
  let buf = '';
  for (let i = 0; i < paras.length; i++){
    const p = paras[i];
    if ((buf + '\n\n' + p).length > CHUNK && buf){
      chunks.push(buf.trim());
      buf = buf.slice(Math.max(0, buf.length - OVERLAP));
    }
    buf += (buf ? '\n\n' : '') + p;
    while (buf.length > CHUNK * 1.6){
      chunks.push(buf.slice(0, CHUNK).trim());
      buf = buf.slice(CHUNK - OVERLAP);
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

/* ---------- 向量化 ---------- */
async function embedAll(texts){
  if (!embedFn) return { error: '向量化能力没有接上（主进程没有注入 embed）' };
  const out = [];
  let i = 0;
  while (i < texts.length){
    let j = i, chars = 0;
    while (j < texts.length && j - i < EMBED_MAX_ITEMS
           && (j === i || chars + texts[j].length <= EMBED_MAX_CHARS)){
      chars += texts[j].length; j++;
    }
    const batch = texts.slice(i, j);
    const r = await embedFn(batch);
    if (!r || !r.ok || !r.vectors) return { error: (r && r.error) || '向量化失败' };
    if (r.vectors.length !== batch.length)
      return { error: '向量数量不匹配（发 ' + batch.length + ' 收 ' + r.vectors.length
        + '）—— 这个嵌入端点可能不支持批量输入，或对单次条数有更严的限制' };
    out.push.apply(out, r.vectors);
    i = j;
  }
  return { vectors: out };
}

/* 稳定 id：同 kind + 同 target 得到同一个 id，重复添加＝覆盖重建，不会攒出重复源。
   刻意不用 Date.now()，否则"同一个文件夹加两次"会变成两条源。 */
function newId(kind, target){
  let h = 0;
  const s = kind + '|' + target;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return kind + '_' + (h >>> 0).toString(36);
}

function bump(acc, key, n){ acc[key] = (acc[key] || 0) + n; }

/* 读文件 → 切块 → 向量化，产出待落盘的 doc 记录。
   budget.left 是"还能再放多少块"（全库上限减去已经占用的），
   到了 0 就不再读文件 —— 而不是先全部读完再丢掉，那样白花向量化的钱。 */
async function indexFiles(sourceId, files, skipReasons, budget){
  const pending = [];
  let capped = false;
  for (let i = 0; i < files.length; i++){
    if (budget.left <= 0){
      capped = true;
      bump(skipReasons, '已达全库块数上限（' + MAX_CHUNKS + ' 块），剩下的 ' + (files.length - i) + ' 个文件没有索引', 1);
      break;
    }
    const f = files[i];
    const r = await readFileText(f);
    if (r.skip){ bump(skipReasons, r.skip, 1); continue; }
    let mtime = 0;
    try { mtime = (await fsp.stat(f)).mtimeMs; } catch (e){ /* */ }
    let parts = chunkText(r.text);
    if (parts.length > MAX_CHUNKS_PER_FILE){
      bump(skipReasons, '单文件块数超过 ' + MAX_CHUNKS_PER_FILE + '，只索引了前 ' + MAX_CHUNKS_PER_FILE + ' 块', 1);
      parts = parts.slice(0, MAX_CHUNKS_PER_FILE);
    }
    if (parts.length > budget.left){
      parts = parts.slice(0, budget.left);
      capped = true;
      bump(skipReasons, '已达全库块数上限（' + MAX_CHUNKS + ' 块），超出的块没有索引', 1);
    }
    budget.left -= parts.length;
    const base = path.basename(f);
    parts.forEach(function (t, k){
      pending.push({ title: base, path: f, chunk: k, text: t, mtime: mtime });
    });
  }
  if (!pending.length) return { docs: [], capped: capped };
  const res = await embedAll(pending.map(x => x.text));
  if (res.error) return { docs: [], error: res.error, capped: capped };
  const docs = pending.map(function (x, i){
    return { id: sourceId + ':' + x.path + '#' + x.chunk, sourceId: sourceId,
      title: x.title, path: x.path, chunk: x.chunk, text: x.text,
      vector: res.vectors[i], mtime: x.mtime };
  });
  return { docs: docs, capped: capped };
}

/* 把一次索引结果写回存档。skipReasons 是 {原因: 条数}，原样带回给界面 ——
   "扫了 8 个文件只索引了 3 个"必须能说出另外 5 个为什么没进去。 */
async function commit(id, kind, target, label, addedAt, docs, skipReasons){
  const s = await load();
  s.sources = s.sources.filter(x => x.id !== id)
    .concat([{ id: id, kind: kind, target: target, label: label, addedAt: addedAt }]);
  s.docs = s.docs.filter(d => d.sourceId !== id).concat(docs);
  /* 全库上限在**写入时**再兜一次：多个源各自都在预算内，合起来也可能超。
     超出时如实报告丢了多少，而不是悄悄截断。 */
  let dropped = 0;
  if (s.docs.length > MAX_CHUNKS){ dropped = s.docs.length - MAX_CHUNKS; s.docs = s.docs.slice(0, MAX_CHUNKS); }
  await save(s);
  return { ok: true, added: docs.length, total: s.docs.length, dropped: dropped, skipReasons: skipReasons };
}
/* 还能再放多少块 = 全库上限 - 已占用的块数。已占用从存档里现读，
   不是常量 —— 否则第二个源会以为自己拥有整份预算。 */
async function liveBudget(){
  const s = await load();
  return { left: Math.max(0, MAX_CHUNKS - s.docs.length) };
}

/* ---------- 对外：添加源 ---------- */
function addFolder(dir, addedAt){
  return serial(async function (){
    const target = String(dir || '');
    const files = await walk(target);
    if (!files.length) return { ok: false, error: '这个文件夹下没有可索引的文本 / 代码 / PDF / Word 文件' };
    const id = newId('folder', target);
    const skipReasons = {};
    if (files.length >= MAX_FILES)
      bump(skipReasons, '文件数超过 ' + MAX_FILES + ' 个，只扫了前 ' + MAX_FILES + ' 个', 1);
    const r = await indexFiles(id, files, skipReasons, await liveBudget());
    if (r.error) return { ok: false, error: r.error, skipReasons: skipReasons };
    if (!r.docs.length)
      return { ok: false, skipReasons: skipReasons,
        error: '扫到 ' + files.length + ' 个文件，但没有提取到可索引的文字' };
    return commit(id, 'folder', target, path.basename(target) || target, addedAt, r.docs, skipReasons);
  });
}
function addFiles(paths, addedAt){
  return serial(async function (){
    const list = (Array.isArray(paths) ? paths : []).map(String).filter(Boolean);
    if (!list.length) return { ok: false, error: '没有选择文件' };
    const id = newId('files', list.slice().sort().join('|'));
    const skipReasons = {};
    const r = await indexFiles(id, list, skipReasons, await liveBudget());
    if (r.error) return { ok: false, error: r.error, skipReasons: skipReasons };
    if (!r.docs.length)
      return { ok: false, skipReasons: skipReasons, error: '这些文件里没有提取到可索引的文字' };
    const label = list.length === 1 ? path.basename(list[0]) : (path.basename(list[0]) + ' 等 ' + list.length + ' 个文件');
    return commit(id, 'files', list.join('|'), label, addedAt, r.docs, skipReasons);
  });
}
function addUrl(url, title, text, addedAt){
  return serial(async function (){
    const clean = String(text || '').trim();
    const u = String(url || '').trim();
    if (!u) return { ok: false, error: '没有网址' };
    if (!clean) return { ok: false, error: '网页正文是空的（抓取失败，或这个页面正文由脚本渲染、抓不到）' };
    const id = newId('url', u);
    const parts = chunkText(clean);
    if (!parts.length) return { ok: false, error: '正文切不出可索引的块' };
    if (parts.length > MAX_CHUNKS_PER_FILE)
      return { ok: false, error: '这一个页面的正文超过 ' + MAX_CHUNKS_PER_FILE + ' 块，建议只存需要的段落' };
    const res = await embedAll(parts);
    if (res.error) return { ok: false, error: res.error };
    const label = String(title || u).slice(0, 120);
    const docs = parts.map(function (t, i){
      return { id: id + ':' + u + '#' + i, sourceId: id, title: label, path: u,
        chunk: i, text: t, vector: res.vectors[i], mtime: addedAt };
    });
    return commit(id, 'url', u, label, addedAt, docs, {});
  });
}
function addText(title, text, sourceKey, addedAt){
  return serial(async function (){
    const clean = String(text || '').trim();
    if (!clean) return { ok: false, error: '内容是空的' };
    if (clean.length > 500000) return { ok: false, error: '内容太长（超过 50 万字），先压缩再存' };
    const key = String(sourceKey || (title + '|' + addedAt)).slice(0, 512);
    const id = newId('text', key);
    const parts = chunkText(clean);
    if (!parts.length) return { ok: false, error: '切不出可索引的块' };
    const res = await embedAll(parts);
    if (res.error) return { ok: false, error: res.error };
    const label = String(title || '一段文本').trim().slice(0, 120);
    const p = 'text://' + encodeURIComponent(key);
    const docs = parts.map(function (t, i){
      return { id: id + ':' + i, sourceId: id, title: label, path: p,
        chunk: i, text: t, vector: res.vectors[i], mtime: addedAt };
    });
    return commit(id, 'text', p, label, addedAt, docs, {});
  });
}

/* ---------- 对外：读 ---------- */
async function listSources(){
  const s = await load();
  const n = {};
  s.docs.forEach(d => { n[d.sourceId] = (n[d.sourceId] || 0) + 1; });
  return s.sources.map(function (src){
    return { id: src.id, kind: src.kind, target: src.target, label: src.label,
      addedAt: src.addedAt, chunks: n[src.id] || 0 };
  });
}
async function stats(){
  const s = await load();
  let bytes = 0, dim = 0;
  try { bytes = fs.statSync(storeFile()).size; } catch (e){ /* */ }
  if (s.docs.length && Array.isArray(s.docs[0].vector)) dim = s.docs[0].vector.length;
  return { sources: s.sources.length, chunks: s.docs.length, dim: dim, bytes: bytes,
    cap: MAX_CHUNKS, file: storeFile() };
}
function removeSource(id){
  return serial(async function (){
    const s = await load();
    const before = s.docs.length;
    s.sources = s.sources.filter(x => x.id !== id);
    s.docs = s.docs.filter(d => d.sourceId !== id);
    await save(s);
    return { ok: true, removed: before - s.docs.length };
  });
}
function clearAll(){
  return serial(async function (){
    await save({ sources: [], docs: [] });
    return { ok: true };
  });
}

/* 增量重扫：只重嵌"新增的"和"mtime 变了的"文件，并删掉已经消失的文件的块。
   整库重建对一个大文件夹是分钟级的，而这个功能会被反复点。 */
function reindex(){
  return serial(async function (){
    const s = await load();
    let changed = 0, removed = 0, refetched = 0, failed = 0;
    const foldery = s.sources.filter(x => x.kind === 'folder');
    for (let i = 0; i < foldery.length; i++){
      const src = foldery[i];
      const files = await walk(src.target);
      const fileSet = {};
      files.forEach(f => { fileSet[f] = 1; });
      const known = {};
      s.docs.forEach(function (d){ if (d.sourceId === src.id) known[d.path] = d.mtime; });
      const stale = [];
      for (let k = 0; k < files.length; k++){
        const f = files[k];
        let m = 0;
        try { m = (await fsp.stat(f)).mtimeMs; } catch (e){ /* */ }
        if (!(f in known) || Math.abs((known[f] || 0) - m) > 1) stale.push(f);
      }
      const before = s.docs.length;
      s.docs = s.docs.filter(d => d.sourceId !== src.id || fileSet[d.path]);
      removed += before - s.docs.length;
      if (stale.length){
        const skipReasons = {};
        const r = await indexFiles(src.id, stale, skipReasons, await liveBudget());
        if (r.error){ failed++; continue; }
        const staleSet = {};
        stale.forEach(f => { staleSet[f] = 1; });
        s.docs = s.docs.filter(d => d.sourceId !== src.id || !staleSet[d.path]).concat(r.docs);
        changed += r.docs.length;
        refetched += stale.length;
      }
    }
    if (s.docs.length > MAX_CHUNKS) s.docs = s.docs.slice(0, MAX_CHUNKS);
    await save(s);
    return { ok: true, changed: changed, removed: removed, refetched: refetched,
      failed: failed, total: s.docs.length };
  });
}

/* ---------- 抓网页正文 ----------
   诚实的边界：这是**最朴素**的取 HTML 去标签，不跑 JavaScript。
   纯静态的文章页能抓到；靠脚本渲染正文的页面（很多文档站、SPA）抓下来会是空的，
   那时如实报"抓不到正文"，而不是存一块导航栏文字进知识库冒充内容。 */
async function fetchUrlText(url, timeoutMs){
  const u = String(url || '').trim();
  let parsed;
  try { parsed = new URL(u); }
  catch (e){ return { ok: false, error: '网址不合法：' + u }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return { ok: false, error: '只支持 http / https 网址' };
  const ms = Math.max(3000, Math.min(60000, Number(timeoutMs) || 20000));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  let res, raw;
  try {
    res = await fetch(parsed.href, { redirect: 'follow', signal: ctl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JuzhenDockKB/1.0)' } });
    raw = await res.text();
  } catch (e){
    return { ok: false, error: (e && e.name === 'AbortError')
      ? ('等了 ' + Math.round(ms / 1000) + ' 秒还没返回，已放弃')
      : ('抓取失败：' + String((e && e.message) || e)) };
  } finally { clearTimeout(timer); }

  if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + '（抓取被拒绝或页面不存在）' };
  const ctype = String(res.headers.get('content-type') || '').toLowerCase();
  if (ctype && !/text\/|html|json|xml/.test(ctype))
    return { ok: false, error: '这个地址返回的不是网页文本（content-type: ' + ctype + '）' };

  const isHtml = /html/.test(ctype) || /^\s*</.test(raw);
  let title = '';
  if (isHtml){
    const m = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (m) title = m[1].replace(/\s+/g, ' ').trim().slice(0, 120);
  } else {
    title = parsed.hostname + parsed.pathname;
  }
  const text = isHtml ? htmlToText(raw) : String(raw || '').trim();
  /* HTML 的门槛不能设成"非空"。正文由脚本渲染的页面在上面这一路只会留下
     <head> 里那几个字（现在 head 已经整段丢掉了，但别的边角也可能剩一点）——
     于是"SPA"这种两三个字的碎片会被当成正文存进索引，检索时偶尔冒出来，
     看着像知识库坏了。真要有价值，至少得有几十个字。
     非 HTML（text/plain 等）不加这个门槛：一个 10 个字的 .txt 是它本来的样子，
     不是"抓失败"。 */
  if (isHtml && text.length < 20)
    return { ok: false, error: '抓到了页面，但去掉标签之后几乎没有正文（正文多半是脚本渲染的，这里不执行脚本）' };
  if (!text) return { ok: false, error: '抓到的内容是空的' };
  return { ok: true, title: title || parsed.href, text: text, url: res.url || parsed.href, bytes: raw.length };
}
function htmlToText(html){
  return String(html || '')
    /* <head> 整段丢掉：里面有 <title>、<meta>、内联样式表。标题由调用方
       单独取（要单独显示），而它**不能**混进正文 —— 否则一个"正文为空"
       的页面会被它撑成"有内容"。 */
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    /* 导航与页脚在每个页面上都一样，进知识库就是纯噪声：检索时会大量命中
       这些"每个页面都有"的句子，把真正的内容挤下去。 */
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/* ---------- 检索 ---------- */
function cosine(a, b){
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++){ dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
/* 语义检索：把问题向量化 → 余弦相似 → top-k。
   **单文件最多 3 块**：同一份文档的相邻块天然高度相似，不去重的话 top-8 会被
   一个文件占满，"多个来源互相印证"这件事就没了。 */
async function search(query, k){
  const limit = Math.max(1, Math.min(30, Number(k) || 8));
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: '问题是空的' };
  const s = await load();
  if (!s.docs.length) return { ok: false, error: '知识库还是空的，先在「知识库」里加一个文件夹 / 文件 / 网页' };
  const res = await embedAll([q]);
  if (res.error) return { ok: false, error: res.error };
  const qv = res.vectors[0];
  if (!Array.isArray(qv) || !qv.length) return { ok: false, error: '问题向量化失败' };
  let dimMismatch = 0;
  const scored = s.docs.map(function (d){
    if (!Array.isArray(d.vector) || d.vector.length !== qv.length){ dimMismatch++; return { d: d, score: -1 }; }
    return { d: d, score: cosine(qv, d.vector) };
  }).sort((a, b) => b.score - a.score);
  const hits = [], perFile = {};
  for (let i = 0; i < scored.length && hits.length < limit; i++){
    const d = scored[i].d, score = scored[i].score;
    if (score < 0) continue;
    const c = perFile[d.path] || 0;
    if (c >= 3) continue;
    perFile[d.path] = c + 1;
    hits.push({ title: d.title, source: d.path, path: d.path, text: d.text, score: score });
  }
  return { ok: true, hits: hits, dimMismatch: dimMismatch,
    note: dimMismatch
      ? '有 ' + dimMismatch + ' 块向量的维度与当前嵌入模型对不上（换过嵌入模型？请「重新扫描」）'
      : '' };
}

module.exports = {
  initKb: initKb,
  addFolder: addFolder, addFiles: addFiles, addUrl: addUrl, addText: addText,
  listSources: listSources, removeSource: removeSource, clearAll: clearAll,
  reindex: reindex, search: search, stats: stats,
  fetchUrlText: fetchUrlText, htmlToText: htmlToText,
  /* 纯函数与常量：单独导出是为了能直接喂数据测，不必碰文件系统与网络 */
  chunkText: chunkText, cosine: cosine, newId: newId,
  readFileText: readFileText, walk: walk,
  TEXT_EXT: TEXT_EXT, BINARY_DOC_EXT: BINARY_DOC_EXT, SKIP_DIR: SKIP_DIR,
  LIMITS: { CHUNK: CHUNK, OVERLAP: OVERLAP, MAX_FILES: MAX_FILES,
    MAX_TEXT_BYTES: MAX_TEXT_BYTES, MAX_DOC_BYTES: MAX_DOC_BYTES,
    EMBED_MAX_ITEMS: EMBED_MAX_ITEMS, EMBED_MAX_CHARS: EMBED_MAX_CHARS,
    MAX_CHUNKS: MAX_CHUNKS, MAX_CHUNKS_PER_FILE: MAX_CHUNKS_PER_FILE }
};
