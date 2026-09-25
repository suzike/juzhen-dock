/* ============================================================
   desktop/ai.js 的真实分支测试
   ------------------------------------------------------------
   做法：本机起一个 mock 服务，伪装成 OpenAI 兼容的 /chat/completions，
   然后把 ai.js **原样 require 进来**跑。不复制它的任何逻辑 ——
   复制一份判据，那份副本迟早跟真身走散，测了等于没测。

   验的是这几件事（这些恰好都是手点覆盖不到的）：
     [1] 成功路径：choices[0].message.content 被正确取出来
     [2] 发出去的请求体/请求头到底长什么样（system 消息、stream:false、
         max_tokens、temperature、Bearer 头）
     [3] 401 → 把服务端那句错误原文带回来，并留下 status
     [4] 404 → 同上（用来区分"地址/模型名写错"）
     [5] 返回里没有 choices → 不装作成功，把原始正文截一段带回去
     [6] 服务端吐 HTML（网关常见）→ 不能崩，也要能说清
     [7] 地址不是网址 / 没填模型名 → 本地就拦下，压根不发请求
     [8] 连不上 → 报错但不崩（用 http 明文，不会误报成跨域）
     [9] 超时 → 到点放弃，且不吊死在 fetch 上
   跑法：node _aitest.js   输出 _aitest.txt */
const fs = require('fs');
const path = require('path');
const http = require('http');
const dir = __dirname;

const AI = require(path.join(dir, 'desktop', 'ai.js'));

/* 每一次 mock 收到的请求都记在这里，供断言用 */
let seen = [];
let mode = 'ok';

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e){}
    seen.push({ url: req.url, method: req.method, auth: req.headers.authorization || '',
      ctype: req.headers['content-type'] || '', body: parsed, raw: raw });
    const send = (code, ctype, text) => {
      res.writeHead(code, { 'Content-Type': ctype });
      res.end(text);
    };
    if (mode === 'ok')
      return send(200, 'application/json', JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '正常' } }],
        usage: { prompt_tokens: 11, completion_tokens: 2 } }));
    if (mode === '401')
      return send(401, 'application/json', JSON.stringify({
        error: { message: 'Authentication Fails, Your api key is invalid' } }));
    if (mode === '404')
      return send(404, 'application/json', JSON.stringify({
        error: { message: 'Model Not Exist' } }));
    if (mode === 'nochoices')
      return send(200, 'application/json', JSON.stringify({ id: 'x', object: 'chat.completion' }));
    if (mode === 'html')
      return send(502, 'text/html', '<html><body><h1>502 Bad Gateway</h1></body></html>');
    if (mode === 'hang') return;   /* 不回复，专门验超时 */
  });
});

const out = [];
const p = s => { out.push(s); console.log(s); };

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port + '/v1';
  const cfg = { baseUrl: base, apiKey: 'sk-unit-test-key',
    model: 'mock-model', prompt: 'PMV 怎么算', system: '你是工程助手',
    temperature: 0.25, maxTokens: 512 };

  /* ---- [1][2] 成功路径 + 发出去的到底是什么 ---- */
  mode = 'ok'; seen = [];
  const r1 = await AI.chatOnce(cfg);
  const s1 = seen[0] || {};
  p('[1] 成功路径：ok = ' + r1.ok + ' · text = ' + JSON.stringify(r1.text)
    + ' · usage 带回来了 = ' + !!(r1.usage && r1.usage.prompt_tokens));
  p('[2] 实际发出的请求：method = ' + s1.method + ' · url = ' + s1.url
    + ' · Content-Type = ' + s1.ctype);
  p('    Authorization = ' + JSON.stringify(s1.auth) + '（必须是 Bearer + Key）');
  p('    body.model = ' + JSON.stringify(s1.body && s1.body.model)
    + ' · stream = ' + (s1.body && s1.body.stream)
    + ' · max_tokens = ' + (s1.body && s1.body.max_tokens)
    + ' · temperature = ' + (s1.body && s1.body.temperature));
  p('    messages = ' + JSON.stringify(s1.body && s1.body.messages));

  /* ---- [3] 401 ---- */
  mode = '401';
  const r3 = await AI.chatOnce(cfg);
  p('[3] 401：ok = ' + r3.ok + ' · status = ' + r3.status
    + ' · error = ' + JSON.stringify(r3.error)
    + '（要能把服务端原话带回来）');

  /* ---- [4] 404 ---- */
  mode = '404';
  const r4 = await AI.chatOnce(cfg);
  p('[4] 404：ok = ' + r4.ok + ' · status = ' + r4.status
    + ' · error = ' + JSON.stringify(r4.error));

  /* ---- [5] 没有 choices ---- */
  mode = 'nochoices';
  const r5 = await AI.chatOnce(cfg);
  p('[5] 无 choices：ok = ' + r5.ok + ' · error = ' + JSON.stringify(r5.error)
    + ' · 原始正文 = ' + JSON.stringify(String(r5.raw || '').slice(0, 60)));
  p('    不装作成功 = ' + (r5.ok === false && !r5.text));

  /* ---- [6] 网关吐 HTML ---- */
  mode = 'html';
  const r6 = await AI.chatOnce(cfg);
  p('[6] 502 + HTML：ok = ' + r6.ok + ' · status = ' + r6.status
    + ' · error = ' + JSON.stringify(String(r6.error || '').slice(0, 80))
    + '（不能崩，也不能把整页 HTML 塞进界面）');

  /* ---- [7] 本地就拦下的两种 ---- */
  const r7a = await AI.chatOnce({ baseUrl: '不是网址', model: 'm', prompt: 'q' });
  const r7b = await AI.chatOnce({ baseUrl: base, model: '', prompt: 'q' });
  const r7c = await AI.chatOnce({ baseUrl: base, model: 'm', prompt: '   ' });
  p('[7] 本地拦截：坏地址 → ' + JSON.stringify(r7a.error)
    + ' · 没模型名 → ' + JSON.stringify(r7b.error)
    + ' · 空问题 → ' + JSON.stringify(r7c.error));

  /* ---- [8] 连不上 ---- */
  const r8 = await AI.chatOnce({ baseUrl: 'http://127.0.0.1:1/v1', model: 'm',
    prompt: 'q', timeoutMs: 4000 });
  p('[8] 连不上：ok = ' + r8.ok + ' · error = ' + JSON.stringify(r8.error)
    + ' · 没伪造 status = ' + (r8.status === undefined));

  /* ---- [9] 超时 ---- */
  mode = 'hang';
  seen = [];
  const t0 = Date.now();
  const r9 = await AI.chatOnce(Object.assign({}, cfg, { timeoutMs: 3000 }));
  const dt = Date.now() - t0;
  p('[9] 超时：ok = ' + r9.ok + ' · error = ' + JSON.stringify(r9.error)
    + ' · 实际等了 ' + dt + ' ms（应接近 3000，且不许无限等）'
    + ' · 服务端确实收到了请求 = ' + (seen.length === 1));

  /* ---- 汇总 ---- */
  const fail = [];
  if (!r1.ok || r1.text !== '正常') fail.push('成功路径');
  if (s1.auth !== 'Bearer sk-unit-test-key') fail.push('Bearer 头');
  if (!s1.body || s1.body.stream !== false) fail.push('stream:false');
  if (!s1.body || s1.body.max_tokens !== 512) fail.push('max_tokens');
  if (!s1.body || s1.body.temperature !== 0.25) fail.push('temperature');
  if (!s1.body || !s1.body.messages || s1.body.messages.length !== 2) fail.push('system+user 两条消息');
  if (r3.ok || r3.status !== 401) fail.push('401');
  if (r4.ok || r4.status !== 404) fail.push('404');
  if (r5.ok) fail.push('空 choices 不该判成功');
  if (r6.ok || r6.status !== 502) fail.push('502');
  if (String(r6.error || '').indexOf('<') >= 0) fail.push('HTML 没被提炼');
  if (r7a.ok || r7b.ok || r7c.ok) fail.push('本地拦截');
  if (r8.ok) fail.push('连不上');
  if (r9.ok || dt > 8000) fail.push('超时');
  p('');
  p(fail.length ? ('!! 未通过：' + fail.join(' / ')) : '全部通过 · 14 项断言');

  server.close();
  fs.writeFileSync(path.join(dir, '_aitest.txt'), out.join('\n'), 'utf8');
  process.exit(0);
});
