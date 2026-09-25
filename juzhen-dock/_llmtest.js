/* ============================================================
   desktop/ai.js 新增能力的分支测试（多轮 / 快深两档 / 方言 / 重试 / 嵌入）
   ------------------------------------------------------------
   为什么要有这个文件：这批能力的失败方式全都"看起来像成功"——
     · 快深两档如果没真改请求体，界面上切了模式、发出去的东西一模一样；
     · 多轮如果 history 没进 messages，模型看到的只有最后一句；
     · 「预算被推理吃满」如果没重试，用户拿到的是一个**空白回答**（HTTP 200）；
     · 上游把 Key 回显在错误里，如果不脱敏就会出现在界面上和复制出来的文本里。
   这四条靠手点都很难发现，所以在这里起一个 mock 服务，把"实际发出去的请求体"
   抓下来逐字段核对。

   跑法：node _llmtest.js   （结论同时写 _llmtest.txt）
   ============================================================ */
const http = require('http'), fs = require('fs'), path = require('path');
const AI = require(path.join(__dirname, 'desktop', 'ai.js'));

const out = [], fails = [];
const p = s => { out.push(s); console.log(s); };
function ok(cond, label, extra){
  out.push('  ' + (cond ? '[ok] ' : '[!!] ') + label + (extra !== undefined ? '   ' + extra : ''));
  console.log('  ' + (cond ? '[ok] ' : '[!!] ') + label + (extra !== undefined ? '   ' + extra : ''));
  if (!cond) fails.push(label);
}

/* ---------- mock 服务 ---------- */
let SEEN = [];              /* 每次请求的 {path, body} */
let REPLY = { kind: 'ok' };
const server = http.createServer((req, res) => {
  let buf = '';
  req.on('data', d => { buf += d; });
  req.on('end', () => {
    let body = null;
    try { body = buf ? JSON.parse(buf) : null; } catch (e){}
    SEEN.push({ path: req.url, body: body, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');

    if (REPLY.kind === 'http-error'){
      res.statusCode = REPLY.status || 401;
      res.end(REPLY.body || '{"error":{"message":"Authentication Fails, Your api key is invalid sk-abcdefghij1234567890"}}');
      return;
    }
    if (REPLY.kind === 'html-error'){
      res.statusCode = 502;
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><body><h1>502 Bad Gateway</h1></body></html>');
      return;
    }
    if (REPLY.kind === 'empty-no-frame'){
      res.end('{"id":"x","object":"chat.completion"}');
      return;
    }
    if (REPLY.kind === 'embed'){
      const n = Array.isArray(body && body.input) ? body.input.length : 1;
      res.end(JSON.stringify({ object:'list', model:(body && body.model) || 'e',
        data: Array.from({ length: n }, (_, i) => ({ object:'embedding', index:i, embedding:[0.1, 0.2, 0.3] })) }));
      return;
    }
    if (REPLY.kind === 'embed-bad'){
      res.end('{"error":{"message":"model not found: bge"}}');
      return;
    }
    if (REPLY.kind === 'models'){
      res.end('{"object":"list","data":[{"id":"m-one"},{"id":"m-two"}]}');
      return;
    }
    /* 预算被推理吃满 → 第一次回"截断且正文空"，第二次（预算被翻倍后）回正文。
       这正是推理型模型最气人的失败形态：HTTP 200、屏幕上什么都没有。 */
    if (REPLY.kind === 'budget'){
      const b = body || {};
      const budget = b.max_tokens !== undefined ? b.max_tokens : b.max_completion_tokens;
      if (budget < 12000){
        res.end(JSON.stringify({ id:'x', choices:[{ finish_reason:'length',
          message:{ role:'assistant', content:'', reasoning_content:'让我想想……（推理把预算吃光了）' } }] }));
      } else {
        res.end(JSON.stringify({ id:'x', choices:[{ finish_reason:'stop',
          message:{ role:'assistant', content:'放宽预算后的正常回答' } }],
          usage:{ prompt_tokens: 10, completion_tokens: 20 } }));
      }
      return;
    }
    if (REPLY.kind === 'budget-always'){
      res.end(JSON.stringify({ id:'x', choices:[{ finish_reason:'length',
        message:{ role:'assistant', content:'', reasoning_content:'推理中……' } }] }));
      return;
    }
    /* 正常 */
    const isAnthropic = /\/messages$/.test(req.url);
    res.end(isAnthropic
      ? JSON.stringify({ id:'m', content:[{ type:'text', text:'anthropic 的回答' }], stop_reason:'end_turn', usage:{ input_tokens:5, output_tokens:7 } })
      : JSON.stringify({ id:'x', choices:[{ finish_reason:'stop', message:{ role:'assistant', content:'普通回答' } }],
          usage:{ prompt_tokens: 3, completion_tokens: 4 } }));
  });
});

async function main(){
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const PORT = server.address().port;
  const base = 'http://127.0.0.1:' + PORT + '/v1';

  /* ================= 一、方言判定 ================= */
  p('===== 一、方言判定（靠 host + 模型名，不靠服务商 id）=====');
  const d = (baseUrl, model) => AI.dialectOf({ baseUrl: baseUrl, model: model });
  ok(d('https://api.deepseek.com/v1', 'deepseek-chat') === 'openai',
     'deepseek-chat 走通用形态（老型号未必接受 thinking 字段）');
  ok(d('https://api.deepseek.com/v1', 'deepseek-v4-pro') === 'deepseek-thinking',
     'deepseek-v4-pro 走 thinking 方言');
  ok(d('https://api.deepseek.com/v1', 'deepseek-flash') === 'deepseek-thinking',
     'deepseek-flash（无版本段）也走 thinking —— 只匹配带版本段的会漏掉它');
  ok(d('https://api.moonshot.cn/v1', 'moonshot-v1-8k') === 'openai',
     '聚珍默认的 moonshot-v1-8k 走通用形态（私有字段只对 K3 / kimi-* 生效）');
  ok(d('https://api.moonshot.cn/v1', 'kimi-k2') === 'kimi', 'kimi-k2 走 Kimi 方言');
  ok(d('https://api.moonshot.cn/v1', 'k3') === 'kimi', 'k3 走 Kimi 方言');
  ok(d('https://api.openai.com/v1', 'gpt-5.6') === 'openai-reasoning', 'gpt-5.6 走 OpenAI 推理方言');
  ok(d('https://api.openai.com/v1', 'gpt-4o-mini') === 'openai', 'gpt-4o-mini 走通用形态（不该乱发 reasoning_effort）');
  ok(d('https://api.openai.com/v1', 'gpt-5.1') === 'openai-reasoning', 'gpt-5.1 也认');
  /* 同一个模型名、不同的 baseUrl：代理过去时不该被当成官方端点 */
  ok(d('https://my-gateway.internal/v1', 'gpt-5.6') === 'openai',
     '把 gpt-5 的模型名填在内网网关上 → 回落通用形态（不猜对方支持什么）');
  ok(d('https://api.anthropic.com/v1', 'claude-sonnet-4-5') === 'anthropic', 'api.anthropic.com 走 messages 方言');
  ok(d('https://api.anthropic.com', 'claude-opus-4-5') === 'anthropic', '地址不带 /v1 也认');
  ['dashscope', 'zhipu', 'siliconflow'].forEach(function (k, i){
    const m = ['qwen-plus', 'glm-4-flash', 'Qwen/Qwen2.5-7B-Instruct'][i];
    ok(d('https://example.com/v1', m) === 'openai', m + ' 走通用形态');
  });
  ok(AI.DIALECT_NAME[AI.dialectOf({ baseUrl: base, model: 'x' })].length > 0,
     '每种方言都有人话名字（界面上要显示"按哪种形态发送"）');

  p('');
  p('===== 二、地址归一 =====');
  ok(AI.normalizeBaseUrl('https://a.com/v1/chat/completions') === 'https://a.com/v1',
     '从文档里抄了整行端点也不会拼成 404', AI.normalizeBaseUrl('https://a.com/v1/chat/completions'));
  ok(AI.normalizeBaseUrl('https://a.com/v1/') === 'https://a.com/v1', '去掉尾部斜杠');
  ok(AI.normalizeBaseUrl(' https://a.com/v1 ') === 'https://a.com/v1', '去掉首尾空格');
  ok(AI.normalizeBaseUrl('https://a.com/v1/embeddings') === 'https://a.com/v1', '嵌入端点尾巴也削掉');

  p('');
  p('===== 三、多轮：history 与 system 真的进了 messages =====');
  SEEN = []; REPLY = { kind: 'ok' };
  const hist = [
    { role:'user', content:'第一问' }, { role:'assistant', content:'第一答' },
    { role:'user', content:'第二问' }, { role:'assistant', content:'第二答' }
  ];
  const multi = await AI.chatOnce({ baseUrl: base, model: 'mock', apiKey: 'k',
    system: '你是热管理工程师', history: hist, prompt: '那第三问呢', temperature: 0.25, maxTokens: 512 });
  ok(multi.ok, '多轮请求成功', multi.ok ? multi.text : multi.error);
  const sent = SEEN[0].body.messages;
  ok(sent.length === 6, 'system + 4 轮历史 + 本轮问题 = 6 条', sent.length + ' 条');
  ok(sent[0].role === 'system' && sent[0].content === '你是热管理工程师', 'system 在最前面');
  ok(sent[1].content === '第一问' && sent[2].content === '第一答', '历史按原顺序进（不是只留最后一句）');
  ok(sent[5].role === 'user' && sent[5].content === '那第三问呢', '本轮问题在最后');
  const cleaned = AI.cleanHistory([{ role:'user', content:'  ' }, null, { role:'assistant', content:'留下' }]);
  ok(cleaned.length === 1 && cleaned[0].role === 'assistant', '空内容与 null 会被剔掉（不然服务端会直接报错）');
  SEEN = [];
  await AI.chatOnce({ baseUrl: base, model: 'mock', prompt: 'no system' });
  ok(SEEN[0].body.messages.length === 1, '没有 system 时不塞一个空 system 进去（有些服务端会因此报错）');

  p('');
  p('===== 四、快 / 深两档**真的**改了请求体 =====');
  /* 请求体形状直接问纯函数。故意的：OpenAI / Anthropic 那两个方言的 baseUrl
     是真实域名，凑到 mock 服务上就测不到"按 host 判方言"这件事了 ——
     而"发到哪个地址、带什么认证头"正是要验的东西之一。 */
  const reqOf = (cfg) => AI.buildChatBody(cfg);
  const bodyOf = (cfg) => reqOf(cfg).body;

  const genFast = bodyOf({ baseUrl: base, model: 'mock', prompt: 'q', mode: 'fast' });
  const genDeep = bodyOf({ baseUrl: base, model: 'mock', prompt: 'q', mode: 'deep' });
  ok(genFast.max_tokens === 900, '通用·快 → max_tokens 900', String(genFast.max_tokens));
  ok(genDeep.max_tokens === 3000, '通用·深 → max_tokens 3000', String(genDeep.max_tokens));
  ok(genFast.temperature === 0.4 && genDeep.temperature === 0.6, '通用 → 深档温度也更高');
  ok(genFast.thinking === undefined, '通用形态不乱加 thinking 字段');
  ok(/\/chat\/completions$/.test(reqOf({ baseUrl: base, model: 'mock', prompt: 'q' }).url),
     '通用形态打到 /chat/completions');

  const dsFast = bodyOf({ baseUrl: base, model: 'deepseek-v4-pro', prompt: 'q', mode: 'fast' });
  const dsDeep = bodyOf({ baseUrl: base, model: 'deepseek-v4-pro', prompt: 'q', mode: 'deep' });
  ok(dsFast.thinking && dsFast.thinking.type === 'disabled', 'DeepSeek·快 → thinking 关掉');
  ok(dsDeep.thinking && dsDeep.thinking.type === 'enabled', 'DeepSeek·深 → thinking 打开');
  ok(dsFast.temperature === 0.4, 'DeepSeek·快 带 temperature');
  ok(dsDeep.temperature === undefined, 'DeepSeek·深 不发 temperature（开着思考时服务端会拒）');
  ok(dsFast.max_tokens === 900 && dsDeep.max_tokens === 8000,
     'DeepSeek 深档的默认预算是 8000（比通用的 3000 大）', dsFast.max_tokens + ' / ' + dsDeep.max_tokens);
  ok(dsDeep.reasoning_effort === undefined,
     'DeepSeek **不**发 reasoning_effort（实测那会把推理写到上万字还不产出正文）');

  const oaFast = bodyOf({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6', prompt: 'q', mode: 'fast' });
  const oaDeep = bodyOf({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6', prompt: 'q', mode: 'deep' });
  ok(oaFast.max_completion_tokens === 900 && oaFast.max_tokens === undefined,
     'OpenAI 推理方言用 max_completion_tokens（不是 max_tokens）');
  ok(oaFast.reasoning_effort === 'low' && oaDeep.reasoning_effort === 'high',
     'OpenAI：快=low / 深=high', oaFast.reasoning_effort + ' / ' + oaDeep.reasoning_effort);

  const kiFast = bodyOf({ baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2', prompt: 'q', mode: 'fast' });
  const kiDeep = bodyOf({ baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2', prompt: 'q', mode: 'deep' });
  ok(kiFast.max_completion_tokens === 900 && kiFast.temperature === undefined,
     'Kimi 方言用 max_completion_tokens 且不发 temperature');
  ok(kiDeep.thinking && kiDeep.thinking.type === 'enabled', 'Kimi·深 → thinking 打开');
  const k3Deep = bodyOf({ baseUrl: 'https://api.moonshot.cn/v1', model: 'k3', prompt: 'q', mode: 'deep' });
  ok(k3Deep.reasoning_effort === 'max', 'K3 深档用 reasoning_effort=max（模型自己的映射）');

  const anReq = reqOf({ baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', prompt: 'q', system: 'sys', mode: 'fast', apiKey: 'ak-test-123' });
  const anDeep = bodyOf({ baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', prompt: 'q', system: 'sys', mode: 'deep' });
  ok(anReq.body.system === 'sys' && anReq.body.messages.length === 1,
     'Anthropic：system 在顶层、messages 里只有用户轮次（不是把它塞进 messages）');
  ok(anReq.body.max_tokens === 900, 'Anthropic 也有输出上限字段');
  ok(!anReq.body.thinking && anDeep.thinking && anDeep.thinking.type === 'enabled',
     'Anthropic·深 → thinking 打开（快档不发）');
  ok(/\/v1\/messages$/.test(anReq.url), 'Anthropic 打到 /messages 而不是 /chat/completions', anReq.url);
  ok(!!anReq.headers['x-api-key'] && !anReq.headers.authorization,
     'Anthropic 用 x-api-key 认证（用 Bearer 会被 401）', JSON.stringify(Object.keys(anReq.headers)));
  ok(anReq.headers['anthropic-version'] === '2023-06-01', '带上 anthropic-version 头');
  /* 真实发出去的那一次也必须落到 mock 上（收尾时整体跑一遍通用路径） */
  SEEN = []; REPLY = { kind: 'ok' };
  await AI.chatOnce({ baseUrl: base, model: 'mock', prompt: 'q', mode: 'deep' });
  ok(SEEN[0].body.max_tokens === 3000, '深档经真实通路发出去的也是 3000', String(SEEN[0].body.max_tokens));

  p('');
  p('===== 五、用户填的最大输出优先 =====');
  const custom = bodyOf({ baseUrl: base, model: 'mock', prompt: 'q', mode: 'deep', maxTokens: 512 });
  ok(custom.max_tokens === 512, '用户填了 512，深档也得发 512（设置页那个数字不能被悄悄覆盖）', String(custom.max_tokens));
  const customDs = bodyOf({ baseUrl: base, model: 'deepseek-v4-pro', prompt: 'q', mode: 'deep', maxTokens: 777 });
  ok(customDs.max_tokens === 777, 'DeepSeek 深档同理', String(customDs.max_tokens));
  const customT = bodyOf({ baseUrl: base, model: 'mock', prompt: 'q', mode: 'deep', temperature: 0.05 });
  ok(customT.temperature === 0.05, '用户填的温度优先于快/深默认值');

  p('');
  p('===== 六、输出预算被推理吃满 → 翻倍放宽重试一次 =====');
  SEEN = []; REPLY = { kind: 'budget' };
  const bz = await AI.chatOnce({ baseUrl: base, model: 'mock', prompt: 'q', mode: 'fast' });
  ok(bz.ok && bz.text === '放宽预算后的正常回答', '重试之后拿到了真回答', bz.ok ? bz.text : bz.error);
  ok(bz.retried === true, '结果里标了"这次是重试过的"（界面该说明一下）');
  ok(SEEN.length === 2, '总共发了 2 次请求（不是无限重试）', SEEN.length + ' 次');
  ok(SEEN[0].body.max_tokens === 900, '第一次用的是原预算 900');
  ok(SEEN[1].body.max_tokens === 12000, '第二次放宽到 12000（至少翻倍且抬到 12000）',
     String(SEEN[1].body.max_tokens));
  ok(bz.retryFrom === 900 && bz.retryTo === 12000, '把"从多少放宽到多少"带回来', bz.retryFrom + '→' + bz.retryTo);
  ok(SEEN[1].body.model === 'mock', '重试用的是**同一个**方言请求体（没被改造成另一种形态）');

  SEEN = []; REPLY = { kind: 'budget-always' };
  const bz2 = await AI.chatOnce({ baseUrl: base, model: 'mock', prompt: 'q' });
  ok(bz2.ok === false, '放宽了还是空的 → 明确失败，不返回一个空字符串假装成功');
  ok(/空|预算/.test(bz2.error) && bz2.error.indexOf('12000') > 0,
     '错误里说清了原因和放宽后的数值', bz2.error.slice(0, 80) + '…');
  ok(SEEN.length === 2, '仍然只发 2 次（不会一直翻倍下去）', SEEN.length + ' 次');

  /* DeepSeek 方言的重试要改 max_tokens 而不是加一个 max_completion_tokens */
  SEEN = []; REPLY = { kind: 'budget' };
  await AI.chatOnce({ baseUrl: base, model: 'deepseek-v4-pro', prompt: 'q' });
  ok(SEEN[1].body.max_tokens === 12000 && SEEN[1].body.max_completion_tokens === undefined,
     'DeepSeek 重试改的是它自己那个字段名（withOutputBudget 只改写已存在的键）');

  p('');
  p('===== 七、不构成重试的失败就只发一次 =====');
  SEEN = []; REPLY = { kind: 'http-error', status: 401 };
  const e401 = await AI.chatOnce({ baseUrl: base, model: 'mock', apiKey: 'sk-abcdefghij1234567890', prompt: 'q' });
  ok(e401.ok === false && e401.status === 401, '401 如实带回来', String(e401.status));
  ok(SEEN.length === 1, '401 **不**重试（再发一遍结果一样，只会让人多等一轮）', SEEN.length + ' 次');
  ok(e401.error.indexOf('sk-abcdefghij') < 0 && e401.error.indexOf('[API_KEY]') >= 0,
     '错误里回显的 Key 被脱敏了', e401.error.slice(0, 70) + '…');

  SEEN = []; REPLY = { kind: 'http-error', status: 404,
    body: '{"error":{"message":"Model Not Exist","authorization":"Bearer sk-abcdefghij1234567890"}}' };
  const e404 = await AI.chatOnce({ baseUrl: base, model: 'mock', apiKey: 'sk-abcdefghij1234567890', prompt: 'q' });
  ok(e404.error.indexOf('sk-abcdefghij') < 0, 'Authorization 里的 Key 也脱敏');

  SEEN = []; REPLY = { kind: 'html-error' };
  const eHtml = await AI.chatOnce({ baseUrl: base, model: 'mock', prompt: 'q' });
  ok(eHtml.ok === false && eHtml.error.indexOf('<h1>') < 0 && eHtml.error.indexOf('502') >= 0,
     '网关回 HTML 错误页时不把整页 HTML 塞进提示', eHtml.error.slice(0, 60));

  SEEN = []; REPLY = { kind: 'empty-no-frame' };
  const eNo = await AI.chatOnce({ baseUrl: base, model: 'mock', prompt: 'q' });
  ok(eNo.ok === false && eNo.raw, '没有 choices 时把原始正文带回来（"解析失败"是没信息量的）');

  p('');
  p('===== 八、sanitize 纯函数 =====');
  const KEY = 'sk-abcdefghij1234567890';
  ok(AI.sanitizeLlmErrorDetail('bad ' + KEY, KEY).indexOf(KEY) < 0, 'literal 的 Key 被替掉');
  ok(AI.sanitizeLlmErrorDetail('authorization: Bearer ' + KEY).indexOf(KEY) < 0, 'Bearer 形式被替掉');
  ok(AI.sanitizeLlmErrorDetail('api_key=' + KEY).indexOf(KEY) < 0, 'api_key= 形式被替掉');
  ok(AI.sanitizeLlmErrorDetail('{"apiKey":"' + KEY + '"}').indexOf(KEY) < 0, 'JSON 里的 apiKey 被替掉');
  ok(AI.sanitizeLlmErrorDetail('model not found').indexOf('[API_KEY]') < 0,
     '没有密钥的正常报错不被乱改');

  p('');
  p('===== 九、/embeddings（知识库要用）=====');
  SEEN = []; REPLY = { kind: 'embed' };
  const em = await AI.embedOnce({ embedBaseUrl: base, embedApiKey: 'ek', embedModel: 'bge-m3', input: ['甲', '乙', '丙'] });
  ok(em.ok && em.vectors.length === 3, '三条输入拿回三条向量', em.ok ? (em.vectors.length + ' 条') : em.error);
  ok(em.dim === 3, '维度从真实返回里读出来（不预设 1536 之类）', String(em.dim));
  ok(SEEN[0].path === '/v1/embeddings', '打到 /embeddings', SEEN[0].path);
  ok(SEEN[0].body.model === 'bge-m3' && Array.isArray(SEEN[0].body.input) && SEEN[0].body.input.length === 3,
     '请求体是 OpenAI 兼容的 {model, input[]}');
  const single = await AI.embedOnce({ embedBaseUrl: base, embedModel: 'bge-m3', input: '单条' });
  ok(single.ok && SEEN[1].body.input.length === 1, '传字符串也能用（自动包成数组）');

  const noEmbedBase = await AI.embedOnce({ embedModel: 'bge-m3', input: 'x' });
  ok(noEmbedBase.ok === false && /嵌入模型/.test(noEmbedBase.error),
     '没配嵌入地址 → 明确说缺什么（而不是拿聊天地址去瞎发）', noEmbedBase.error);
  const noEmbedModel = await AI.embedOnce({ embedBaseUrl: base, input: 'x' });
  ok(noEmbedModel.ok === false && /嵌入模型名/.test(noEmbedModel.error), '没填嵌入模型名 → 明确说');
  const anEmbed = await AI.embedOnce({ embedBaseUrl: 'https://api.anthropic.com/v1', embedModel: 'x', input: 'y' });
  ok(anEmbed.ok === false && /Anthropic/.test(anEmbed.error),
     'Anthropic 没有 /embeddings → 提前说清，不发一次注定 404 的请求', anEmbed.error.slice(0, 50) + '…');
  REPLY = { kind: 'embed-bad' };
  const emBad = await AI.embedOnce({ embedBaseUrl: base, embedModel: 'bge', input: 'x' });
  ok(emBad.ok === false && /model not found/.test(emBad.error),
     '嵌入模型不存在时把服务端原话带回来', emBad.error);

  /* 上面每一行用的都是 embedBaseUrl / embedApiKey / embedModel —— 也就是
     "实现希望调用方用的名字"。而界面上真正发出来的是另一组：设置页那几张卡
     统一叫 { provider, baseUrl, model, apiKey }（见桌面自检里打出来的
     aiEmbedCfg）。**只测实现喜欢的名字，等于没测** —— 嵌入模型名那一格
     正是因此在真实链路里一直空着，而这里全绿。所以下面这组专门按界面
     实际发出的形状再走一遍。 */
  SEEN = []; REPLY = { kind: 'embed' };
  const ui = await AI.embedOnce({ provider: 'siliconflow', baseUrl: base,
    model: 'BAAI/bge-m3', apiKey: 'sk-ui', input: ['按界面的字段名发一遍'] });
  ok(ui.ok === true, '按界面发的字段名（baseUrl/model/apiKey）能出向量', ui.ok ? 'ok' : ui.error);
  ok(SEEN.length && SEEN[0].body.model === 'BAAI/bge-m3',
     '模型名真的进了请求体（不能是空字符串）', SEEN.length ? JSON.stringify(SEEN[0].body.model) : '(没发出去)');
  ok(SEEN.length && SEEN[0].headers.authorization === 'Bearer sk-ui', '朴素名字的 Key 也认');
  ok(SEEN.length && SEEN[0].path === '/v1/embeddings', '朴素名字的地址也认', SEEN.length ? SEEN[0].path : '');

  p('');
  p('===== 十、/models（设置页「测试连接」用它）=====');
  SEEN = []; REPLY = { kind: 'models' };
  const md = await AI.modelsOnce({ baseUrl: base, apiKey: 'k' });
  ok(md.ok && md.ids.length === 2 && md.ids[0] === 'm-one', '列模型成功', md.ok ? md.ids.join(' / ') : md.error);
  ok(SEEN[0].path === '/v1/models', '打到 /models', SEEN[0].path);
  ok(!!SEEN[0].headers.authorization, '带上认证头');
  const mdNoBase = await AI.modelsOnce({ apiKey: 'k' });
  ok(mdNoBase.ok === false, '没地址 → 明确失败');
  const mdAn = await AI.modelsOnce({ baseUrl: 'https://api.anthropic.com/v1', apiKey: 'k' });
  ok(mdAn.ok === false && /Anthropic/.test(mdAn.error), 'Anthropic 没有 /models → 提前说清');

  p('');
  p('===== 结论 =====');
  p('  失败项 = ' + (fails.length ? fails.join(' ｜ ') : '无'));
  p('  说明：这些请求全部打在本机 mock 服务上，抓的是**实际发出去的请求体**；');
  p('        与真服务商的连通性由设置页的「测试连接」按钮负责，不在这里假装验证。');
}

main().then(function (){
  fs.writeFileSync(path.join(__dirname, '_llmtest.txt'), out.join('\n') + '\n', 'utf8');
  server.close();
  process.exit(fails.length ? 1 : 0);
}, function (e){
  p('[!] 测试自身抛错：' + (e && e.message));
  p('  失败项 = ' + fails.concat(['测试自身抛错']).join(' ｜ '));
  fs.writeFileSync(path.join(__dirname, '_llmtest.txt'), out.join('\n') + '\n', 'utf8');
  try { server.close(); } catch (err) { /* */ }
  process.exit(1);
});
