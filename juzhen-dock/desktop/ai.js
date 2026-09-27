/* ============================================================
   聚珍 · AI 请求（与 Electron 无关的纯 Node 模块）
   ------------------------------------------------------------
   为什么单独放一个文件、而不是写在 main.js 里：
     main.js 一开头就 require('electron')，普通 node 进程跑不起来，
     于是这段逻辑就只能靠"打开窗口、点一下、用肉眼看"来验证。
     把它摘出来之后，可以起一个本地 mock 服务真跑一遍所有分支
     （见 _aitest.js / _llmtest.js）—— 401 / 404 / 空 choices / 连不上 /
     超时 / 预算被推理吃满 这几条路，光靠手点是根本覆盖不到的。

   职责只有一件：按厂商方言拼一次**非流式**请求，把结果或原始错误
   如实带回去。不做重试循环（除了"输出预算被推理吃满"那一次翻倍重试）、
   不存会话、不碰界面。

   ------------------------------------------------------------
   与 agentic-island（同一套方言判定）的取舍：
     · 保留"按 host + 模型名判方言"。这是唯一能把"同一个 OpenAI 兼容
       端点、不同厂商的私有字段"分开的办法 —— 靠服务商 id 猜不行，
       因为用户可以手填任意 baseUrl。
     · 保留"输出预算被推理吃满 → 翻倍放宽重试一次"。推理型模型最气人的
       失败形态就是 HTTP 200 + 正文空串，界面看起来像"什么都没发生"。
     · 保留错误脱敏：上游报错经常把 Key 回显在正文里，不能原样贴到界面上。
     · **去掉** Anthropic 的图片分片转换：聚珍的问答不带图片输入，
       留着就是一段永远不会被执行的代码（而它读起来像已经支持了）。
     · 新增 /embeddings 与 /models：知识库要向量化、设置页要"测试连接"，
       这两件事都需要真的发一次请求，而不是弹一句"看起来没问题"。
   ============================================================ */

const DEFAULT_TIMEOUT = 90000;
const FAST_BUDGET = 900;
const DEEP_BUDGET = 3000;
/* DeepSeek 的 thinking 方言在深度模式下实测需要更大的预算：推理本身就能写到
   上万字，900 那种量级会被思考吃满、正文返回空串。 */
const DEEPSEEK_DEEP_BUDGET = 8000;

/* 最大输出的取值顺序：**用户填了就用用户的**，没填才按快/深给默认值。
   "设置页里那个数字不起作用"是最容易被发现、也最伤信任的一类 bug ——
   而它恰恰是在"给快/深两档各配一个默认值"这种改动里最容易丢掉的。 */
function budgetFor(cfg, deep, deepDefault){
  const v = Number(cfg && cfg.maxTokens);
  if (isFinite(v) && v > 0) return Math.max(1, Math.round(v));
  return deep ? (deepDefault || DEEP_BUDGET) : FAST_BUDGET;
}

/* ---------- 地址归一 ---------- */
/* 用户很容易把地址填成 `.../v1/chat/completions`（从文档里直接抄一行），
   那时再拼一次 /chat/completions 会变成 404。这里把已知的端点尾巴削掉。 */
function normalizeBaseUrl(raw){
  return String(raw || '').trim().replace(/\/+$/, '')
    .replace(/\/(?:chat\/completions|completions|messages|embeddings|models)$/i, '');
}
function hostOf(baseUrl){
  try { return new URL(normalizeBaseUrl(baseUrl)).hostname.toLowerCase(); }
  catch (e){ return ''; }
}

/* ---------- 方言判定 ----------
   只认**有据可依**的那几种；认不出来就用通用 OpenAI 兼容形态。
   宁可退回通用形态（地址与模型名是用户自己填的、通用形态是官方文档里的），
   也不要凭"这家应该也支持"去发一个私有字段 —— 那样报的错会莫名其妙。 */
function dialectOf(cfg){
  const r = cfg || {};
  const host = hostOf(r.baseUrl);
  const model = String(r.model || '').trim().toLowerCase();
  if (host === 'api.anthropic.com') return 'anthropic';
  if (/^gpt-5(?:\.|$)/.test(model) && host === 'api.openai.com') return 'openai-reasoning';
  /* DeepSeek 的 pro/flash 型号（含带版本段的 deepseek-v4-*）走 thinking 方言。
     版本段必须可选：官方同时提供 deepseek-flash / deepseek-pro 与
     deepseek-v4-flash，只匹配后者会让前者落到通用分支。 */
  if (/^deepseek-(?:v\d+(?:\.\d+)?-)?(?:pro|flash)$/.test(model)) return 'deepseek-thinking';
  /* 刻意**不**匹配 moonshot-v1-*：那是聚珍里默认填的型号，走通用形态；
     Kimi 的私有 thinking 字段只对 K3 / kimi-* 与 Kimi 域名生效。 */
  if (/^(?:k3|kimi-)/.test(model) || host === 'api.kimi.com') return 'kimi';
  return 'openai';
}
const DIALECT_NAME = {
  'openai': 'OpenAI 兼容（通用）',
  'deepseek-thinking': 'DeepSeek thinking 方言',
  'openai-reasoning': 'OpenAI 推理方言',
  'kimi': 'Kimi 新模型方言',
  'anthropic': 'Anthropic messages 方言'
};

/* ---------- 请求体 ---------- */
function timeoutOf(v){
  let t = Number(v);
  if (!isFinite(t) || t <= 0) t = DEFAULT_TIMEOUT;
  return Math.max(3000, Math.min(300000, t));
}
/* 把已构建请求体的输出预算改成 value。
   字段名随方言而异（max_tokens / max_completion_tokens），这里改写**已存在**
   的那个键，不重新推导分支逻辑 —— 否则重试时会把请求体改造成另一个方言。 */
function withOutputBudget(body, value){
  if (typeof body.max_completion_tokens === 'number') return Object.assign({}, body, { max_completion_tokens: value });
  return Object.assign({}, body, { max_tokens: value });
}
function outputBudgetOf(body){
  const v = body == null ? 0 : (body.max_completion_tokens !== undefined ? body.max_completion_tokens : body.max_tokens);
  return typeof v === 'number' ? v : 0;
}
/* 是否属于"输出预算被推理过程占满"——需要放宽预算重试一次。
   典型形态：HTTP 200、finish_reason=length、正文空串、reasoning_content 有内容
   （推理型模型把 max_tokens 全花在思考上，正文一个字都没写）。
   只认"被长度截断且正文为空"：内容被截断但非空的不重试 ——
   用户已经看到部分回答了，重试会让回答整个跳变。 */
function isBudgetExhausted(result){
  const r = result || {};
  if (typeof r.text === 'string' && r.text.trim()) return false;
  return r.finishReason === 'length';
}
function retryBudget(current){ return Math.max((Number(current) || 0) * 2, 12000); }

function cleanHistory(h){
  if (!Array.isArray(h)) return [];
  const out = [];
  h.forEach(function (m){
    if (!m) return;
    const c = String(m.content == null ? '' : m.content);
    if (!c.trim()) return;
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: c });
  });
  return out;
}

function buildChatBody(cfg){
  const r = cfg || {};
  const base = normalizeBaseUrl(r.baseUrl);
  const key = String(r.apiKey || '').trim();
  const model = String(r.model || '').trim();
  const system = String(r.system == null ? '' : r.system);
  const prompt = String(r.prompt == null ? '' : r.prompt);
  const history = cleanHistory(r.history);
  const deep = r.mode === 'deep';

  if (!base) return { ok: false, error: '还没填 API 地址' };
  if (!model) return { ok: false, error: '还没填模型名' };
  if (!prompt.trim() && !history.length) return { ok: false, error: '问题是空的' };

  let url;
  try { url = new URL(base); }
  catch (e){ return { ok: false, error: 'API 地址不是合法网址：' + base }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { ok: false, error: 'API 地址只支持 http / https（当前是 ' + url.protocol + '）' };

  const dialect = dialectOf({ baseUrl: base, model: model });
  const budget = budgetFor(r, deep);
  const temperature = r.temperature;
  const customTemp = (typeof temperature === 'number' && isFinite(temperature));

  let body, headers, endpoint;

  if (dialect === 'anthropic'){
    /* Anthropic 的 messages 方言：system 在顶层、输出上限必须写 max_tokens、
       认证走 x-api-key 而不是 Bearer。 */
    endpoint = '/messages';
    headers = Object.assign({ 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      key ? { 'x-api-key': key } : {});
    body = { model: model, max_tokens: budget, messages: history.concat([{ role: 'user', content: prompt }]) };
    if (system.trim()) body.system = system;
    if (deep && /^claude-(?:sonnet|opus|haiku)-/.test(String(model).toLowerCase()))
      body.thinking = { type: 'enabled', budget_tokens: Math.max(1024, Math.round(budget / 2)) };
    if (customTemp) body.temperature = temperature;
  } else if (dialect === 'deepseek-thinking'){
    /* 深度模式实测：给 reasoning_effort 反而更差 —— 推理能写到上万字仍不产出
       正文，即便预算给到 8000 也被吃满。不开 effort（服务端默认强度）
       在放宽后的预算下反而更快也更可靠。 */
    endpoint = '/chat/completions';
    headers = Object.assign({ 'Content-Type': 'application/json' }, key ? { Authorization: 'Bearer ' + key } : {});
    body = {
      model: model,
      messages: (system.trim() ? [{ role:'system', content:system }] : []).concat(history, [{ role:'user', content:prompt }]),
      max_tokens: budgetFor(r, deep, DEEPSEEK_DEEP_BUDGET),
      thinking: { type: deep ? 'enabled' : 'disabled' },
      stream: false
    };
    /* 关掉 thinking 时 900 预算足够，也才接受自定义采样参数；
       开启 thinking 时不发 temperature（很多服务端会直接报错）。 */
    if (!deep) body.temperature = customTemp ? temperature : 0.4;
  } else if (dialect === 'openai-reasoning'){
    endpoint = '/chat/completions';
    headers = Object.assign({ 'Content-Type': 'application/json' }, key ? { Authorization: 'Bearer ' + key } : {});
    body = {
      model: model,
      messages: (system.trim() ? [{ role:'system', content:system }] : []).concat(history, [{ role:'user', content:prompt }]),
      max_completion_tokens: budget,
      reasoning_effort: deep ? 'high' : 'low',
      stream: false
    };
    if (customTemp) body.temperature = temperature;
  } else if (dialect === 'kimi'){
    /* Kimi 新模型对 temperature 有固定约束，省略后由服务端挑一个与思考模式
       匹配的值；输出上限字段名是 max_completion_tokens。 */
    endpoint = '/chat/completions';
    headers = Object.assign({ 'Content-Type': 'application/json' }, key ? { Authorization: 'Bearer ' + key } : {});
    body = {
      model: model,
      messages: (system.trim() ? [{ role:'system', content:system }] : []).concat(history, [{ role:'user', content:prompt }]),
      max_completion_tokens: budget,
      stream: false
    };
    if (deep) body.thinking = { type: 'enabled' };
    if (String(model).toLowerCase() === 'k3') body.reasoning_effort = deep ? 'max' : 'low';
  } else {
    endpoint = '/chat/completions';
    headers = Object.assign({ 'Content-Type': 'application/json' }, key ? { Authorization: 'Bearer ' + key } : {});
    body = {
      model: model,
      messages: (system.trim() ? [{ role:'system', content:system }] : []).concat(history, [{ role:'user', content:prompt }]),
      max_tokens: budget,
      temperature: customTemp ? temperature : (deep ? 0.6 : 0.4),
      stream: false
    };
  }

  let full;
  try { full = new URL(base + endpoint).href; }
  catch (e){ return { ok: false, error: 'API 地址不是合法网址：' + base }; }

  return { ok: true, url: full, timeout: timeoutOf(r.timeoutMs), headers: headers, body: body,
    dialect: dialect, dialectName: DIALECT_NAME[dialect], mode: deep ? 'deep' : 'fast' };
}

/* ---------- 向量化 ---------- */
function buildEmbedBody(cfg){
  const r = cfg || {};
  const base = normalizeBaseUrl(r.embedBaseUrl || r.baseUrl);
  const key = String(r.embedApiKey || r.apiKey || '').trim();
  /* 三格都要能从"朴素字段名"回落。界面那边（aiEmbedCfg）发出来的就是
     { provider, baseUrl, model, apiKey } —— 只有 model 这一格原来漏了回落，
     后果是：用户在设置页把模型名填得好好的，点「测试嵌入」和「加文件夹」
     都只会得到一句「还没填嵌入模型名」。地址和 Key 都回落了、偏偏模型名不回落，
     这种"三格只错一格"的写法读起来完全正常，所以它熬过了单元测试 ——
     _llmtest 用的是 embedModel，正好是这条链路上真正不会有人传的那个名字。
     回落顺序：显式 embedXxx 优先，朴素名兜底。 */
  const model = String(r.embedModel || r.model || '').trim();
  /* 嵌入模型往往是另一家（DeepSeek / Kimi 不提供嵌入端点，而硅基流动有）。
     所以嵌入用的是**独立的**地址与模型，缺了就说缺了 —— */
  if (!base) return { ok: false, error: '还没填嵌入模型的 API 地址' };
  if (!model) return { ok: false, error: '还没填嵌入模型名' };
  if (hostOf(base) === 'api.anthropic.com')
    return { ok: false, error: 'Anthropic 没有 /embeddings 端点，知识库需要另外配一家提供嵌入模型的服务（例如硅基流动 / 通义 / Ollama）' };
  const input = Array.isArray(r.input) ? r.input.map(String) : [String(r.input == null ? '' : r.input)];
  if (!input.length || input.every(t => !t.trim())) return { ok: false, error: '要向量化的内容是空的' };
  let url;
  try { url = new URL(base + '/embeddings').href; }
  catch (e){ return { ok: false, error: '嵌入模型地址不是合法网址：' + base }; }
  return { ok: true, url: url, timeout: timeoutOf(r.embedTimeoutMs || r.timeoutMs),
    headers: Object.assign({ 'Content-Type': 'application/json' }, key ? { Authorization: 'Bearer ' + key } : {}),
    body: { model: model, input: input, encoding_format: 'float' } };
}
/* 有些服务端在 HTTP 200 里回一个 error 对象（尤其嵌入端点：模型名写错时
   常见）。只认状态码的话，这里会退化成一句"返回里没有 data[].embedding" ——
   把服务商自己的那句话丢掉，用户完全不知道是模型名错了。 */
function inlineError(j){
  if (!j || !j.error) return '';
  const e = j.error;
  const m = typeof e === 'string' ? e : (e.message || e.code || e.type || '');
  return m ? String(m) : '';
}

function pickEmbedding(text, status){
  let j = null;
  try { j = JSON.parse(text); } catch (e){}
  if (status && (status < 200 || status >= 300))
    return { ok: false, status: status, error: errorFrom(text, j) };
  const inl = inlineError(j);
  if (inl) return { ok: false, error: inl };
  const data = j && j.data;
  if (!Array.isArray(data) || !data.length)
    return { ok: false, error: '返回里没有 data[].embedding', raw: textOf(text).text.slice(0, 400) };
  const vecs = [];
  for (let i = 0; i < data.length; i++){
    const e = data[i] && data[i].embedding;
    if (!Array.isArray(e) || !e.length)
      return { ok: false, error: '第 ' + (i + 1) + ' 条的 embedding 不是数组', raw: textOf(text).text.slice(0, 300) };
    vecs.push(e.map(Number));
  }
  return { ok: true, vectors: vecs, dim: vecs[0].length, model: (j && j.model) || '', usage: (j && j.usage) || null };
}

/* ---------- 列模型（设置页的"测试连接"用它） ---------- */
function buildModelsRequest(cfg){
  const r = cfg || {};
  const base = normalizeBaseUrl(r.baseUrl);
  const key = String(r.apiKey || '').trim();
  if (!base) return { ok: false, error: '还没填 API 地址' };
  if (hostOf(base) === 'api.anthropic.com')
    return { ok: false, error: 'Anthropic 没有 /models 列表端点，请直接填模型名' };
  let url;
  try { url = new URL(base + '/models').href; }
  catch (e){ return { ok: false, error: 'API 地址不是合法网址：' + base }; }
  return { ok: true, url: url, timeout: Math.min(timeoutOf(r.timeoutMs), 20000),
    headers: Object.assign({}, key ? { Authorization: 'Bearer ' + key } : {}) };
}
function pickModels(text, status){
  let j = null;
  try { j = JSON.parse(text); } catch (e){}
  if (status && (status < 200 || status >= 300))
    return { ok: false, status: status, error: errorFrom(text, j) };
  const data = j && (j.data || j.models);
  if (!Array.isArray(data)) return { ok: false, error: '返回里没有模型列表', raw: textOf(text).text.slice(0, 300) };
  const ids = data.map(x => (typeof x === 'string' ? x : (x && (x.id || x.name)) || '')).filter(Boolean);
  return { ok: true, ids: ids };
}

/* ---------- 响应解析 ---------- */
/* 去掉标签只留文字。网关（nginx / 企业代理 / CDN）出错时经常直接吐一个
   HTML 错误页而不是 JSON，把整页 HTML 原样塞进错误提示里既难看也没信息量。 */
function textOf(raw){
  const t = String(raw == null ? '' : raw);
  if (!/^\s*</.test(t)) return { html: false, text: t };
  const plain = t.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { html: true, text: plain.slice(0, 160) || '(空白网页)' };
}
/* 上游报错可能回显密钥或 Authorization；返回渲染层前统一脱敏。
   这一步很重要：错误提示会显示在界面上，也会被复制进聊天记录。 */
function sanitizeLlmErrorDetail(raw, apiKey){
  let v = String(raw == null ? '' : raw);
  const k = String(apiKey || '').trim();
  if (k) v = v.split(k).join('[API_KEY]');
  return v
    .replace(/(authorization\s*[=:]\s*['"]?bearer\s+)[^\s'",}]+/gi, '$1[API_KEY]')
    .replace(/((?:api[_ -]?key|apikey|token|secret)\s*[=:]\s*['"]?)[^\s'",}]+/gi, '$1[API_KEY]')
    .replace(/\b(?:sk|dk|msk|kimi)-[A-Za-z0-9_-]{8,}\b/g, '[API_KEY]');
}
function errorFrom(text, parsed){
  const j = parsed || (function(){ try { return JSON.parse(text); } catch (e){ return null; } })();
  const fromJson = (j && j.error && (j.error.message || j.error.code || j.error.type))
    || (j && j.message) || (j && j.detail);
  if (fromJson) return String(typeof fromJson === 'string' ? fromJson : JSON.stringify(fromJson));
  const t = textOf(text);
  if (t.html) return '服务端返回的是一个网页而不是 JSON（多半是网关或代理的错误页）：' + t.text;
  return t.text.slice(0, 300);
}
/* 从响应里取回答。取不到就把原始正文截一段带回去 ——
   只说"解析失败"的话，用户和我们都没法知道对方到底回了什么。 */
function pickAnswer(text, status, dialect){
  let j = null;
  try { j = JSON.parse(text); } catch (e){}
  if (status && (status < 200 || status >= 300))
    return { ok: false, status: status, error: errorFrom(text, j) };

  /* 同 pickEmbedding：HTTP 200 里带 error 的情况也要把服务商原话带出来 */
  const inl = inlineError(j);
  if (inl && !(j && j.choices) && !(j && j.content)) return { ok: false, error: inl };

  if (dialect === 'anthropic'){
    const parts = Array.isArray(j && j.content) ? j.content : [];
    const out = parts.filter(x => x && x.type === 'text' && typeof x.text === 'string')
      .map(x => x.text).join('\n').trim();
    if (out) return { ok: true, text: out, reasoning: '', finishReason: (j && j.stop_reason) || '',
      usage: (j && j.usage) || null };
    return { ok: false, error: '返回里没有 content[].text', raw: textOf(text).text.slice(0, 400) };
  }

  const ch = j && j.choices && j.choices[0];
  const msg = ch && ch.message;
  const out = msg && (typeof msg.content === 'string' ? msg.content : null);
  const reasoning = (msg && (msg.reasoning_content || msg.reasoning)) || '';
  const finish = (ch && ch.finish_reason) || '';
  if (typeof out === 'string' && out.trim())
    return { ok: true, text: out, reasoning: String(reasoning || ''), finishReason: finish,
      usage: (j && j.usage) || null };
  /* 正文空但有推理内容：这不是"解析失败"，是"预算被思考吃满了" ——
     如实把这层意思带回去，交给 chatOnce 决定要不要放宽重试。 */
  if (!String(out || '').trim() && String(reasoning || '').trim())
    return { ok: true, text: '', reasoning: String(reasoning), finishReason: finish || 'length',
      usage: (j && j.usage) || null, empty: true };
  return { ok: false, error: '返回里没有 choices[0].message.content',
    raw: textOf(text).text.slice(0, 400) };
}

/* ---------- 发请求 ---------- */
async function post(req, label){
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), req.timeout);
  /* 用户中止（R25）：渲染侧的「停止」按钮经主进程把外部 signal 接到同一个
     ctl 上。区分两种中止——超时是网络问题、用户中止是主观决定，
     文案与后续处理都不同，不能混。 */
  const onUserAbort = () => ctl.abort();
  if (req.extSignal){
    if (req.extSignal.aborted) ctl.abort();
    else req.extSignal.addEventListener('abort', onUserAbort);
  }
  try {
    const res = await fetch(req.url, { method: 'POST', headers: req.headers,
      body: JSON.stringify(req.body), signal: ctl.signal });
    const text = await res.text();
    return { status: res.status, text: text };
  } catch (e){
    const aborted = e && (e.name === 'AbortError');
    if (aborted && req.extSignal && req.extSignal.aborted) return { abortedByUser: true };
    return { netError: aborted
      ? ('等了 ' + Math.round(req.timeout / 1000) + ' 秒还没返回，已放弃' + (label ? '（' + label + '）' : ''))
      : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
    if (req.extSignal) req.extSignal.removeEventListener('abort', onUserAbort);
  }
}

async function sendChat(cfg, budgetOverride, extSignal){
  const req = buildChatBody(cfg);
  if (!req.ok) return req;
  let body = req.body;
  if (typeof budgetOverride === 'number') body = withOutputBudget(body, budgetOverride);
  const r = await post({ url: req.url, headers: req.headers, body: body, timeout: req.timeout, extSignal: extSignal });
  if (r.abortedByUser) return { abortedByUser: true };
  const picked = r.netError
    ? { ok: false, error: r.netError }
    : pickAnswer(r.text, r.status, req.dialect);
  picked.dialect = req.dialect;
  picked.dialectName = req.dialectName;
  picked.mode = req.mode;
  picked.budget = outputBudgetOf(body);
  picked.apiKey = (cfg && cfg.apiKey) || '';
  if (!picked.ok) picked.error = sanitizeLlmErrorDetail(picked.error, (cfg && cfg.apiKey) || '');
  return picked;
}

/* 一次问答。只有一种重试：**输出预算被推理吃满**。
   别的失败（401 / 404 / 连不上 / 超时）重试只是浪费用户的时间 ——
   同一次请求再发一遍，结果是一样的，而界面会多转一圈。 */
async function chatOnce(cfg, extSignal){
  const first = await sendChat(cfg, null, extSignal);
  if (!first.ok){
    if (first.abortedByUser) return { ok: false, abortedByUser: true, error: '已停止生成' };
    return first;
  }
  if (!isBudgetExhausted(first)) return first;

  const from = first.budget;
  const to = retryBudget(from);
  const second = await sendChat(cfg, to, extSignal);
  if (second.ok && String(second.text || '').trim()){
    second.retried = true;
    second.retryFrom = from;
    second.retryTo = to;
    return second;
  }
  if (second.abortedByUser) return { ok: false, abortedByUser: true, error: '已停止生成' };
  if (!second.ok) { second.retried = true; second.retryFrom = from; second.retryTo = to; return second; }
  return { ok: false, retried: true, retryFrom: from, retryTo: to, dialect: first.dialect,
    dialectName: first.dialectName,
    error: '模型把输出预算全花在思考上、正文一个字都没给出。已经把预算从 ' + from
      + ' 放宽到 ' + to + ' 重试过一次，仍然是空的。可试：换成非推理型号、'
      + '或把「深」切回「快」、或在设置里把最大输出调大。' };
}

async function embedOnce(cfg){
  const req = buildEmbedBody(cfg);
  if (!req.ok) return req;
  const r = await post(req, '向量化');
  const picked = r.netError ? { ok: false, error: r.netError } : pickEmbedding(r.text, r.status);
  if (!picked.ok) picked.error = sanitizeLlmErrorDetail(picked.error, (cfg && (cfg.embedApiKey || cfg.apiKey)) || '');
  return picked;
}

async function modelsOnce(cfg){
  const req = buildModelsRequest(cfg);
  if (!req.ok) return req;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), req.timeout);
  let r;
  try {
    const res = await fetch(req.url, { method: 'GET', headers: req.headers, signal: ctl.signal });
    const text = await res.text();
    r = { status: res.status, text: text };
  } catch (e){
    r = { netError: (e && e.name === 'AbortError')
      ? ('等了 ' + Math.round(req.timeout / 1000) + ' 秒还没返回，已放弃（列模型）')
      : String((e && e.message) || e) };
  } finally { clearTimeout(timer); }
  const picked = r.netError ? { ok: false, error: r.netError } : pickModels(r.text, r.status);
  if (!picked.ok) picked.error = sanitizeLlmErrorDetail(picked.error, (cfg && cfg.apiKey) || '');
  return picked;
}

module.exports = {
  chatOnce: chatOnce, embedOnce: embedOnce, modelsOnce: modelsOnce,
  buildChatBody: buildChatBody, buildEmbedBody: buildEmbedBody, buildModelsRequest: buildModelsRequest,
  pickAnswer: pickAnswer, pickEmbedding: pickEmbedding, pickModels: pickModels,
  /* 下面这些是纯函数，单独导出是为了能直接喂数据测 —— 不必起网络 */
  normalizeBaseUrl: normalizeBaseUrl, hostOf: hostOf, dialectOf: dialectOf, DIALECT_NAME: DIALECT_NAME,
  withOutputBudget: withOutputBudget, outputBudgetOf: outputBudgetOf,
  isBudgetExhausted: isBudgetExhausted, retryBudget: retryBudget,
  sanitizeLlmErrorDetail: sanitizeLlmErrorDetail, textOf: textOf, errorFrom: errorFrom,
  cleanHistory: cleanHistory, FAST_BUDGET: FAST_BUDGET, DEEP_BUDGET: DEEP_BUDGET
};
