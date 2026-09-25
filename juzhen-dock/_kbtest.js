/* ============================================================
   desktop/kb.js 的端到端测试（普通 node，不动 Electron、不联网）
   ------------------------------------------------------------
   知识库最容易"看起来做完了"的地方，恰恰是它最难手工验的地方：
     · 切块切出来的东西到底有没有重叠、顺序有没有乱；
     · 增量重扫是不是真的只重嵌了变过的那个文件（不然每次点都要几分钟）；
     · 检索是不是真的按语义排的（还是"有结果就行"）；
     · 换过嵌入模型之后维度对不上，是不是会静默给出乱序结果；
     · PDF / Word 到底有没有真解析出来（而不是被当成"跳过"然后报个成功的数字）。
   所以这里自己造 PDF 和 docx 两个真实文件（不用现成的库去造，
   免得"库能读自己写的东西"变成循环论证），再拿 kb.js 去读。

   跑法：node _kbtest.js   （结论同时写 _kbtest.txt）
   ============================================================ */
const fs = require('fs'), path = require('path'), http = require('http'), zlib = require('zlib');
const KB = require(path.join(__dirname, 'desktop', 'kb.js'));

const out = [], fails = [];
const p = s => { out.push(s); console.log(s); };
function ok(cond, label, extra){
  out.push('  ' + (cond ? '[ok] ' : '[!!] ') + label + (extra !== undefined ? '   ' + extra : ''));
  console.log('  ' + (cond ? '[ok] ' : '[!!] ') + label + (extra !== undefined ? '   ' + extra : ''));
  if (!cond) fails.push(label);
}

/* ---------- 测试沙箱 ---------- */
const TMP = path.join(__dirname, '_kbtmp');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const mk = (rel, content) => {
  const f = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return f;
};

/* ---------- 一个"确定的"伪嵌入：词袋哈希，语义相近的文本余弦就高 ----------
   用它而不是随机数：随机向量下"检索"只能验"返回了东西"，
   验不了"排得对不对"。 */
const DIM = 96;
function fakeEmbed(texts){
  return texts.map(function (t){
    const v = new Array(DIM).fill(0);
    const words = String(t).toLowerCase().match(/[a-z0-9\u4e00-\u9fa5]+/g) || [];
    words.forEach(function (w){
      let h = 0;
      for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) | 0;
      v[Math.abs(h) % DIM] += 1;
    });
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map(x => x / n);
  });
}
function makeEmbedder(opts){
  const o = opts || {};
  const calls = [];
  const fn = async function (texts){
    calls.push(texts.slice());
    if (o.failOn && o.failOn(texts)) return { ok: false, error: o.failOn(texts) };
    if (o.dim) return { ok: true, vectors: texts.map(() => new Array(o.dim).fill(0.5)) };
    return { ok: true, vectors: fakeEmbed(texts) };
  };
  fn.calls = calls;
  return fn;
}

/* ---------- 手工造一个真 PDF（自己算 xref 偏移，不借任何库） ---------- */
function makePdf(text){
  const esc = s => String(s).replace(/([()\\])/g, '\\$1');
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 4 0 R'
    + ' /Resources << /Font << /F1 5 0 R >> >> >>';
  const stream = 'BT /F1 14 Tf 20 140 Td (' + esc(text) + ') Tj ET';
  objs[4] = '<< /Length ' + Buffer.byteLength(stream, 'latin1') + ' >>\nstream\n' + stream + '\nendstream';
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let buf = Buffer.from('%PDF-1.4\n', 'latin1');
  const off = [];
  for (let i = 1; i <= 5; i++){
    off[i] = buf.length;
    buf = Buffer.concat([buf, Buffer.from(i + ' 0 obj\n' + objs[i] + '\nendobj\n', 'latin1')]);
  }
  const xref = buf.length;
  let tail = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) tail += String(off[i]).padStart(10, '0') + ' 00000 n \n';
  tail += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.concat([buf, Buffer.from(tail, 'latin1')]);
}

/* ---------- 手工造一个真 docx（ZIP store 法，不借任何库） ---------- */
const CRC_TABLE = (function (){
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++){
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf){
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function zipStore(files){
  const parts = [], central = [];
  let offset = 0;
  files.forEach(function (f){
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + data.length;
  });
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat(parts.concat([cd, end]));
}
function makeDocx(text){
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  return zipStore([
    { name: '[Content_Types].xml', data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>' },
    { name: '_rels/.rels', data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>' },
    { name: 'word/document.xml', data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="' + W + '"><w:body><w:p><w:r><w:t>' + text + '</w:t></w:r></w:p></w:body></w:document>' }
  ]);
}

async function main(){
  /* ================= 一、纯逻辑 ================= */
  p('===== 一、切块 / 相似度 / 稳定 id（纯函数）=====');
  const long = Array.from({ length: 40 }, (_, i) => '段落' + (i + 1) + '：' + '内容'.repeat(60)).join('\n\n');
  const cs = KB.chunkText(long);
  ok(cs.length > 3, '长文本被切成多块', cs.length + ' 块');
  const sizes = cs.map(c => c.length);
  ok(Math.max.apply(null, sizes) < KB.LIMITS.CHUNK * 1.7,
     '没有哪一块膨胀到不可控（硬切上限生效）', '最长 ' + Math.max.apply(null, sizes));
  ok(cs.every(c => c.trim().length > 0), '没有空块（空块会被向量化成噪声）');
  const head = cs.slice(0, -1).map(c => c.slice(-40));
  const nextStart = cs.slice(1).map(c => c.slice(0, 40));
  ok(head.some((t, i) => nextStart[i] && nextStart[i].indexOf(t.slice(-12)) >= 0),
     '相邻块之间真的有重叠（不然跨切点的结论两边都检索不准）');
  ok(KB.chunkText('').length === 0, '空文本切出 0 块（不是 1 个空块）');
  ok(KB.chunkText('   \n\n  ').length === 0, '全空白也是 0 块');

  const mkVec = s => fakeEmbed([s])[0];
  const relA = mkVec('热管理 标定 台架 数据采集 流程 说明 文档');
  const relB = mkVec('热管理 标定 台架 数据采集 流程 说明 附件');
  const unrel = mkVec('除霜 日照 强度 阈值 判定 逻辑 条件');
  ok(Math.abs(KB.cosine(relA, relA) - 1) < 1e-9, '同一文本的余弦是 1');
  /* 不写"无关文本必须 < 0.2"这种绝对阈值：本文件的伪嵌入是 96 维词袋哈希，
     短文本必然有桶碰撞，绝对阈值测的是这个哈希的性质、不是 cosine 的性质。
     真正要钉的是**相对关系**：相关的比无关的更相似。 */
  ok(KB.cosine(relA, relB) > KB.cosine(relA, unrel),
     '相关文本的相似度高于无关文本（这才是排序成立的前提）',
     KB.cosine(relA, relB).toFixed(3) + ' > ' + KB.cosine(relA, unrel).toFixed(3));
  ok(KB.cosine([], []) === 0, '空向量给 0 而不是 NaN（NaN 会让排序整个乱掉）');
  const shortVsLong = KB.cosine([1, 2], [1]);
  ok(isFinite(shortVsLong) && shortVsLong > 0,
     '长度不一致时按较短的维度算、返回有限值（不返回 NaN 把排序搞乱）',
     String(shortVsLong));

  ok(KB.newId('folder', 'D:\\a') === KB.newId('folder', 'D:\\a'), '同一个目标得到同一个 id（重复添加＝覆盖，不攒重复源）');
  ok(KB.newId('folder', 'D:\\a') !== KB.newId('files', 'D:\\a'), 'kind 不同则 id 不同');
  ok(KB.newId('folder', 'D:\\a') !== KB.newId('folder', 'D:\\b'), '目标不同则 id 不同');

  ok(KB.TEXT_EXT.has('.md') && KB.TEXT_EXT.has('.ts') && KB.TEXT_EXT.has('.a2l') && KB.TEXT_EXT.has('.dbc'),
     '文本扩展名含常见代码与 .a2l / .dbc（汽车这边真在用的两种）');
  ok(KB.SKIP_DIR.has('node_modules') && KB.SKIP_DIR.has('.git'), '噪声目录在跳过名单里');

  /* ================= 二、读文件（含真 PDF / 真 docx） ================= */
  p('');
  p('===== 二、读文件：真 PDF、真 docx、以及"读不了就说为什么" =====');
  const txt = mk('docs/note.md', '# 标题\n\n这是一段中文正文，用来验编码。\n');
  const r1 = await KB.readFileText(txt);
  ok(r1.text && r1.text.indexOf('中文正文') >= 0, 'md 按 UTF-8 读出来（中文不乱码）');

  const bin = mk('docs/fake.txt', Buffer.from([0x00, 0x01, 0xFF, 0xFE, 0x88, 0x99, 0x00, 0x7F].concat(new Array(300).fill(0x81))));
  const r2 = await KB.readFileText(bin);
  ok(r2.skip && /二进制|编码/.test(r2.skip),
     '假装成 .txt 的二进制被挡住（否则会污染索引、还白花向量化的钱）', r2.skip);

  const exe = mk('docs/app.exe', 'x');
  const r3 = await KB.readFileText(exe);
  ok(r3.skip && /不支持/.test(r3.skip), '不支持的扩展名给出具体原因', r3.skip);

  const r4 = await KB.readFileText(path.join(TMP, '不存在.md'));
  ok(r4.skip && /读取失败/.test(r4.skip), '文件不存在时给原因而不是抛异常', r4.skip);

  const big = mk('docs/big.txt', 'x'.repeat(KB.LIMITS.MAX_TEXT_BYTES + 100));
  const r5 = await KB.readFileText(big);
  ok(r5.skip && /超过/.test(r5.skip), '超大文本被挡（不让一个日志文件把索引撑爆）', r5.skip);

  const pdfPath = path.join(TMP, 'docs/manual.pdf');
  fs.writeFileSync(pdfPath, makePdf('JZ KB PDF TEXT OK'));
  const r6 = await KB.readFileText(pdfPath);
  ok(!!r6.text, '真 PDF 解析出来了', r6.text ? JSON.stringify(r6.text.slice(0, 40)) : r6.skip);
  ok(!r6.text || r6.text.indexOf('JZ KB PDF TEXT OK') >= 0, 'PDF 里的文字确实是原文');
  ok(!r6.text || !/-- \d+ of \d+ --/.test(r6.text), 'PDF 的页码标记被剥掉了（不然会混进向量当噪声）');

  const docxPath = path.join(TMP, 'docs/spec.docx');
  fs.writeFileSync(docxPath, makeDocx('JZ KB DOCX TEXT OK'));
  const r7 = await KB.readFileText(docxPath);
  ok(!!r7.text, '真 docx 解析出来了', r7.text ? JSON.stringify(r7.text.slice(0, 40)) : r7.skip);
  ok(!r7.text || r7.text.indexOf('JZ KB DOCX TEXT OK') >= 0, 'docx 里的文字确实是原文');

  /* ================= 三、扫描 ================= */
  p('');
  p('===== 三、扫描：跳过噪声目录与隐藏项 =====');
  mk('proj/src/a.ts', 'export const a = 1\n');
  mk('proj/src/deep/b.py', 'print("b")\n');
  mk('proj/node_modules/pkg/index.js', 'module.exports = 1\n');
  mk('proj/.git/config', '[core]\n');
  mk('proj/.hidden.md', 'hidden\n');
  mk('proj/readme.md', '# readme\n');
  mk('proj/logo.png', 'not really a png');
  const walked = await KB.walk(path.join(TMP, 'proj'));
  const rel = walked.map(f => path.relative(path.join(TMP, 'proj'), f).split(path.sep).join('/'));
  ok(rel.some(x => x === 'src/a.ts'), '扫到普通文件');
  ok(rel.some(x => x === 'src/deep/b.py'), '递归进了子目录');
  ok(!rel.some(x => x.indexOf('node_modules') >= 0), '跳过 node_modules');
  ok(!rel.some(x => x.indexOf('.git') >= 0), '跳过 .git');
  ok(!rel.some(x => x.indexOf('.hidden') >= 0), '跳过隐藏文件');
  ok(!rel.some(x => x.indexOf('logo.png') >= 0), '跳过不在支持清单里的扩展名');
  ok(rel.length === 3, '只扫到该扫的 3 个文件', rel.join(' / '));
  /* 目录联接（Windows 上不需要管理员权限的软链接）能造出环 —— 必须不进 */
  let linkOk = true;
  try { fs.symlinkSync(path.join(TMP, 'proj'), path.join(TMP, 'proj', 'src', 'loop'), 'junction'); }
  catch (e){ linkOk = false; }
  if (linkOk){
    const walked2 = await KB.walk(path.join(TMP, 'proj'));
    ok(walked2.length === 3, '软链接/联接不进去（否则会无限递归直到爆栈）', walked2.length + ' 个');
  } else {
    p('    · 本机不允许建联接，这一条跳过（不是通过）');
  }

  /* ================= 四、向量化分批 ================= */
  p('');
  p('===== 四、向量化必须分批（很多端点对单请求有硬上限）=====');
  const emb = makeEmbedder();
  KB.initKb({ dir: TMP, embed: emb });
  const many = Array.from({ length: 40 }, (_, i) => 'x'.repeat(KB.LIMITS.CHUNK));
  const add = await KB.addText('大批量', many.join('\n\n'), 'bulk', Date.now());
  ok(add.ok, '一个 40 块以上的源能加进去', add.ok ? (add.total + ' 块') : add.error);
  ok(emb.calls.length >= 3, '被分成了多批发出去', emb.calls.length + ' 批');
  ok(emb.calls.every(b => b.length <= KB.LIMITS.EMBED_MAX_ITEMS),
     '每一批都不超过条数上限 ' + KB.LIMITS.EMBED_MAX_ITEMS);
  ok(emb.calls.every(b => b.reduce((s, t) => s + t.length, 0) <= KB.LIMITS.EMBED_MAX_CHARS),
     '每一批都不超过字符上限 ' + KB.LIMITS.EMBED_MAX_CHARS);

  p('');
  p('===== 五、向量化失败要如实传播 =====');
  const embFail = makeEmbedder({ failOn: () => 'unauthorized: bad key' });
  KB.initKb({ dir: TMP, embed: embFail });
  const failed = await KB.addText('会失败', '内容内容内容', 'fail-src', Date.now());
  ok(failed.ok === false && /bad key/.test(failed.error),
     '嵌入端点报错时把原话带出来（而不是报"索引成功 0 块"）', failed.error);
  const noEmbed = (function (){ KB.initKb({ dir: TMP, embed: null }); return true; })();
  const noFn = await KB.addText('没接上', '内容', 'no-embed', Date.now());
  ok(noEmbed && noFn.ok === false && /没有接上/.test(noFn.error),
     '根本没注入嵌入能力时明确说，而不是静默成功');
  const mismatch = makeEmbedder({ dim: 8 });
  KB.initKb({ dir: TMP, embed: mismatch });
  const mm2 = await KB.addText('维度不同', '内容内容', 'dim-src', Date.now());
  ok(mm2.ok, '维度是多少不预设（不写死 1536），按返回的真实维度走');

  /* ================= 六、索引 → 检索 ================= */
  p('');
  p('===== 六、索引与语义检索 =====');
  const emb2 = makeEmbedder();
  KB.initKb({ dir: TMP, embed: emb2 });
  await KB.clearAll();
  mk('kb/setup.md', '热管理 标定 台架 数据采集 流程 说明\n\n' + '热管理 标定 相关细节。'.repeat(40));
  mk('kb/pmv.md', 'PMV 热舒适 模型 计算 公式 服装热阻 代谢率\n\n' + 'PMV 计算细节。'.repeat(40));
  mk('kb/defrost.md', '除霜 判定 日照 强度 阈值 逻辑\n\n' + '除霜判定细节。'.repeat(40));
  const added = await KB.addFolder(path.join(TMP, 'kb'), Date.now());
  ok(added.ok, '文件夹索引成功', added.ok ? (added.added + ' 块 · 共 ' + added.total) : added.error);
  ok(fs.existsSync(path.join(TMP, 'kb-index.json')), '索引落盘到 kb-index.json');
  ok(!fs.existsSync(path.join(TMP, 'kb-index.json.tmp')), '没留下 .tmp 残留（原子写）');
  const parsed = JSON.parse(fs.readFileSync(path.join(TMP, 'kb-index.json'), 'utf8'));
  ok(Array.isArray(parsed.docs) && parsed.docs.length > 0 && Array.isArray(parsed.docs[0].vector),
     '落盘内容是合法的 JSON 且带向量');

  const st = await KB.stats();
  ok(st.chunks === parsed.docs.length && st.dim === DIM, '统计里的块数与维度是真实的',
     st.chunks + ' 块 · ' + st.dim + ' 维 · ' + Math.round(st.bytes / 1024) + ' KB');

  const srcs = await KB.listSources();
  ok(srcs.length === 1 && srcs[0].kind === 'folder' && srcs[0].chunks > 0,
     '源列表带上真实的块数', JSON.stringify(srcs.map(s => s.label + ':' + s.chunks)));

  const sPmv = await KB.search('PMV 热舒适 模型 怎么算', 5);
  ok(sPmv.ok && sPmv.hits.length > 0, '检索有结果', sPmv.ok ? (sPmv.hits.length + ' 条') : sPmv.error);
  ok(sPmv.hits[0].path.indexOf('pmv.md') >= 0,
     '问 PMV 时第一条来自 pmv.md（按语义排的，不是"有结果就行"）',
     (sPmv.hits[0] || {}).title);
  ok(sPmv.hits[0].score > sPmv.hits[sPmv.hits.length - 1].score, '结果是按相似度降序的',
     sPmv.hits[0].score.toFixed(3) + ' → ' + sPmv.hits[sPmv.hits.length - 1].score.toFixed(3));
  const sDef = await KB.search('除霜 日照 阈值', 5);
  ok(sDef.hits[0].path.indexOf('defrost.md') >= 0, '换一个问题，第一条跟着换', sDef.hits[0].title);

  const perFile = {};
  sPmv.hits.forEach(h => { perFile[h.path] = (perFile[h.path] || 0) + 1; });
  ok(Object.keys(perFile).every(k => perFile[k] <= 3),
     '单个文件最多贡献 3 块（不然 top-k 会被一个文件占满，多个来源互相印证就没了)',
     JSON.stringify(perFile));

  const empty = await KB.search('   ', 5);
  ok(empty.ok === false, '空问题明确失败');

  p('');
  p('===== 七、换过嵌入模型：维度对不上要说出来 =====');
  KB.initKb({ dir: TMP, embed: makeEmbedder({ dim: 32 }) });
  const mism = await KB.search('PMV', 5);
  ok(mism.ok === true, '维度对不上时不崩（查询自身能成功）', mism.ok ? 'ok' : mism.error);
  ok(mism.dimMismatch > 0 && /维度/.test(mism.note),
     '但会明确说"有 N 块维度对不上，可能是换过嵌入模型"（不是静默给出乱序结果）',
     mism.note || String(mism.dimMismatch));

  /* ================= 八、增量重扫 ================= */
  p('');
  p('===== 八、增量重扫：只重嵌变过的文件 =====');
  const emb3 = makeEmbedder();
  KB.initKb({ dir: TMP, embed: emb3 });
  emb3.calls.length = 0;
  const noChange = await KB.reindex();
  ok(noChange.ok && noChange.refetched === 0,
     '什么都没改时一块都不重嵌（不然每次点都要等几分钟）', '重嵌文件 ' + noChange.refetched);
  ok(emb3.calls.length === 0, '没有发生任何向量化调用', emb3.calls.length + ' 批');

  const pmvFile = path.join(TMP, 'kb/pmv.md');
  const future = new Date(Date.now() + 5000);
  fs.writeFileSync(pmvFile, 'PMV 热舒适 模型 修改后的内容\n\n' + '改过。'.repeat(50));
  fs.utimesSync(pmvFile, future, future);
  emb3.calls.length = 0;
  const inc = await KB.reindex();
  ok(inc.ok && inc.refetched === 1,
     '只重嵌了改过的那 1 个文件', '重嵌文件 ' + inc.refetched + ' · 新增块 ' + inc.changed);

  fs.unlinkSync(pmvFile);
  const del = await KB.reindex();
  ok(del.ok && del.removed > 0, '文件被删掉之后，它的块也清了', '清掉 ' + del.removed + ' 块');

  p('');
  p('===== 九、移除源与全库清空 =====');
  const before = (await KB.stats()).chunks;
  const list2 = await KB.listSources();
  const rm = await KB.removeSource(list2[0].id);
  ok(rm.ok && rm.removed > 0, '移除一个源会连带删掉它的块', '删了 ' + rm.removed + ' 块');
  const after = (await KB.stats()).chunks;
  ok(after === before - rm.removed, '块数确实少了那么多', before + ' → ' + after);
  ok((await KB.listSources()).length === 0, '源列表里它也消失了');
  await KB.clearAll();
  ok((await KB.stats()).chunks === 0, '全库清空后一块不剩');
  const onEmpty = await KB.search('随便', 5);
  ok(onEmpty.ok === false && /空的/.test(onEmpty.error), '空库检索时明确提示去加东西', onEmpty.error);

  /* ================= 十、抓网页 ================= */
  p('');
  p('===== 十、抓网页正文 =====');
  const server = http.createServer(function (req, res){
    if (req.url === '/article'){
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><head><title>热管理标定指南</title><style>p{}</style></head>'
        + '<body><nav>导航导航</nav><h1>标定流程</h1><p>第一步：准备台架。</p>'
        + '<p>第二步：采集数据。</p><script>var x=1;</script><footer>页脚</footer></body></html>');
      return;
    }
    if (req.url === '/spa'){
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><head><title>SPA</title></head><body><div id="app"></div>'
        + '<script>document.getElementById("app").textContent="正文由脚本填"</script></body></html>');
      return;
    }
    if (req.url === '/text'){
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('纯文本内容\n第二行\n');
      return;
    }
    if (req.url === '/binary'){
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(Buffer.from([1, 2, 3]));
      return;
    }
    res.statusCode = 404; res.end('not found');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const P = server.address().port, U = 'http://127.0.0.1:' + P;

  const page = await KB.fetchUrlText(U + '/article');
  ok(page.ok, '静态文章页抓到了', page.ok ? JSON.stringify(page.title) : page.error);
  ok(page.ok && page.title === '热管理标定指南', '标题取到了');
  ok(page.ok && page.text.indexOf('第一步：准备台架') >= 0, '正文在');
  ok(page.ok && page.text.indexOf('var x=1') < 0, 'script 内容被去掉');
  ok(page.ok && page.text.indexOf('导航导航') < 0, 'nav 被去掉（导航混进知识库就是纯噪声）');
  ok(page.ok && page.text.indexOf('页脚') < 0, 'footer 被去掉');

  const spa = await KB.fetchUrlText(U + '/spa');
  ok(spa.ok === false && /脚本/.test(spa.error),
     '正文靠脚本渲染的页面：如实说抓不到，而不是存一段空壳进去', spa.error);

  const plain = await KB.fetchUrlText(U + '/text');
  ok(plain.ok && plain.text.indexOf('纯文本内容') >= 0, 'text/plain 直接当正文', JSON.stringify(plain.title));

  const binf = await KB.fetchUrlText(U + '/binary');
  ok(binf.ok === false && /不是网页文本/.test(binf.error), '二进制响应明确拒绝', binf.error);

  const nf = await KB.fetchUrlText(U + '/nope');
  ok(nf.ok === false && /404/.test(nf.error), '404 如实带回来', nf.error);

  const badUrl = await KB.fetchUrlText('file:///C:/Windows/win.ini');
  ok(badUrl.ok === false && /http/.test(badUrl.error), 'file:// 之类的协议被拒绝（不做本地文件读取的后门）', badUrl.error);

  const to = await KB.fetchUrlText('http://127.0.0.1:1/x', 3000);
  ok(to.ok === false && (to.error || '').length > 0, '连不上时给原因', (to.error || '').slice(0, 40));
  server.close();

  p('');
  p('===== 结论 =====');
  p('  失败项 = ' + (fails.length ? fails.join(' ｜ ') : '无'));
  p('  说明：PDF / docx 两个夹具是本文件**手工构造**的真实文件（自己算 xref 偏移、');
  p('        自己按 ZIP 规范打包），不是拿解析器的搭档库生成的 ——');
  p('        否则"库能读自己写的东西"就是循环论证。');
}

main().then(function (){
  fs.writeFileSync(path.join(__dirname, '_kbtest.txt'), out.join('\n') + '\n', 'utf8');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e){ /* */ }
  process.exit(fails.length ? 1 : 0);
}, function (e){
  p('[!] 测试自身抛错：' + (e && e.message) + '\n' + String(e && e.stack || '').split('\n').slice(0, 3).join('\n'));
  p('  失败项 = ' + fails.concat(['测试自身抛错']).join(' ｜ '));
  fs.writeFileSync(path.join(__dirname, '_kbtest.txt'), out.join('\n') + '\n', 'utf8');
  process.exit(1);
});
