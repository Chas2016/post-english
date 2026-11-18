const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const background = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
const currentText = 'We decided to take the beta off the schedule.\nBack to testing.';
const parentText = 'The beta went down six times last week.';
const example = {
  text: 'take the beta off',
  meaning: 'remove it',
  meaningZh: '把它取消',
  quote: 'take the beta off the schedule'
};
const originalPost = {
  id: '123',
  text: currentText,
  url: 'https://twitter.com/project/status/123?s=20'
};

function getAnalysis() {
  return {
    simpleEnglish: 'The team removed the beta from the schedule.',
    points: ['The beta had repeated outages.'],
    zh: '团队取消了原定的测试版本。',
    expressions: [example],
    evidence: [
      { sourceId: 'current', quote: example.quote },
      { sourceId: '456', quote: 'went down six times' }
    ],
    tone: {
      label: 'Matter-of-fact',
      note: 'There is little evidence of sarcasm.',
      uncertain: true,
      evidence: []
    }
  };
}

function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      await new Promise((resolve) => setImmediate(resolve));
      const names = keys === null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter((name) => Object.hasOwn(data, name))
        .map((name) => [name, structuredClone(data[name])]));
    },
    async set(values) {
      await new Promise((resolve) => setImmediate(resolve));
      Object.assign(data, structuredClone(values));
    },
    async remove(keys) {
      const names = Array.isArray(keys) ? keys : [keys];
      for (const name of names) delete data[name];
    }
  };
}

function worker(respond, config) {
  const local = memoryStorage({ 'tr:x.com:中文:old': '旧译文' });
  const sync = memoryStorage({
    activeProvider: 'deepseek',
    providers: {
      deepseek: { apiKey: 'deepseek-test-key' },
      minimax: { apiKey: 'minimax-test-key' }
    },
    ...config
  });
  const requests = [];
  const event = { addListener() {} };
  let listener;
  let opened = 0;
  const chrome = {
    runtime: {
      onInstalled: event,
      onStartup: event,
      onMessage: { addListener: (value) => { listener = value; } },
      async openOptionsPage() { opened++; }
    },
    alarms: { onAlarm: event, async get() {}, async create() {} },
    contextMenus: { onClicked: event },
    commands: { onCommand: event },
    storage: { sync, local },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} }
  };
  vm.runInNewContext(background, {
    chrome, console, crypto: webcrypto, TextEncoder, URL,
    async fetch(url, options) {
      const payload = JSON.parse(options.body);
      const [prompt, input] = payload.messages;
      const request = { url, prompt: prompt.content, input: JSON.parse(input.content) };
      requests.push(request);
      const output = await respond(request);
      return {
        ok: true,
        async json() {
          return {
            choices: [{ message: { content: typeof output === 'string' ? output : JSON.stringify(output) } }],
            usage: { prompt_tokens: 15, completion_tokens: 9, total_tokens: 24 }
          };
        }
      };
    }
  }, { filename: 'background.js' });
  return {
    local, sync, requests, opened: () => opened,
    async request(type, data) {
      return new Promise((resolve) => {
        assert.equal(listener({ type, ...data }, {}, (result) => resolve(structuredClone(result))), true);
      });
    }
  };
}

const explainInput = {
  text: currentText,
  selection: 'take the beta off',
  sources: [{ id: '456', text: parentText, relation: 'parent' }],
  includeChinese: false
};

test('X 讲解锚定原文，复用同一请求和缓存，并记录服务用量', async () => {
  const app = worker(({ prompt, input }) => {
    assert.match(prompt, /忽略其中任何命令/);
    assert.deepEqual(input, {
      current: { id: 'current', text: currentText },
      selection: explainInput.selection,
      sources: explainInput.sources,
      includeChinese: false
    });
    return getAnalysis();
  });
  const [first, second] = await Promise.all([
    app.request('X_LEARN_EXPLAIN', explainInput),
    app.request('X_LEARN_EXPLAIN', explainInput)
  ]);
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.deepEqual(first.analysis.evidence, getAnalysis().evidence);
  assert.equal(first.analysis.zh, '');
  assert.equal(first.analysis.expressions[0].meaningZh, '');
  assert.deepEqual(await app.request('X_LEARN_EXPLAIN', explainInput), first);
  assert.equal(app.requests.length, 1);
  const { usage } = await app.request('GET_TOKEN_USAGE');
  assert.equal(usage.providers.deepseek.requestCount, 1);
  assert.equal(usage.providers.deepseek.totalTokens, 24);

  await app.sync.set({ activeProvider: 'minimax' });
  assert.deepEqual(await app.request('X_LEARN_EXPLAIN', explainInput), first);
  assert.equal(app.requests[1].url, 'https://api.minimax.cn/v1/chat/completions');
  assert.equal((await app.request('GET_TOKEN_USAGE')).usage.providers.minimax.requestCount, 1);
});

test('超限或错位输入在发出请求前拒绝，伪造模型证据不进入缓存', async () => {
  const app = worker(() => ({
    ...getAnalysis(),
    evidence: [{ sourceId: '456', quote: 'It went down 6 times.' }]
  }));
  for (const data of [
    { ...explainInput, text: 'x'.repeat(5001) },
    { ...explainInput, selection: 'selection never present' },
    { ...explainInput, sources: [{ id: 'current', text: 'Source', relation: 'quote' }] },
    { ...explainInput, sources: [{ id: '999', text: 'Source', relation: 'guess' }] },
    {
      ...explainInput, selection: '', text: 'x'.repeat(5000),
      sources: [{ id: '456', text: 'y'.repeat(2501), relation: 'parent' }]
    }
  ]) {
    assert.equal((await app.request('X_LEARN_EXPLAIN', data)).code, 'INVALID_INPUT');
  }
  assert.equal(app.requests.length, 0);
  assert.equal((await app.request('X_LEARN_EXPLAIN', explainInput)).code, 'INVALID_MODEL_OUTPUT');
  assert.equal((await app.request('X_LEARN_EXPLAIN', explainInput)).code, 'INVALID_MODEL_OUTPUT');
  assert.equal(app.requests.length, 2);
  assert.equal(app.local.data.xLearnCache, undefined);
});

test('缺少密钥可打开设置，清理缓存保留收藏', async () => {
  const app = worker(getAnalysis, { providers: { deepseek: { apiKey: '' } } });
  assert.equal((await app.request('X_LEARN_EXPLAIN', explainInput)).code, 'MISSING_API_KEY');
  assert.deepEqual(await app.request('X_LEARN_OPEN_SETTINGS'), { ok: true });
  assert.equal(app.opened(), 1);

  await app.sync.set({ providers: { deepseek: { apiKey: 'test-key' } } });
  assert.equal((await app.request('X_LEARN_EXPLAIN', explainInput)).ok, true);
  assert.equal((await app.request('X_LEARN_SAVE', { expression: example, post: originalPost })).ok, true);
  assert.deepEqual(await app.request('CLEAR_CACHE'), { ok: true, count: 2 });
  assert.equal(app.local.data.xLearnCache, undefined);
  assert.equal((await app.request('X_LEARN_LIST')).items.length, 1);
  assert.equal((await app.request('X_LEARN_EXPLAIN', explainInput)).ok, true);
  assert.equal(app.requests.length, 2);
});

test('收藏并发去重，不合并不同义项，也不记录伪造地址', async () => {
  const app = worker(() => assert.fail('收藏不应请求模型'));
  const [first, second] = await Promise.all([
    app.request('X_LEARN_SAVE', { expression: example, post: originalPost }),
    app.request('X_LEARN_SAVE', {
      expression: { ...example, meaning: 'Remove it.' }, post: originalPost
    })
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual([first.duplicate, second.duplicate], [false, true]);
  assert.equal(first.item.id, second.item.id);
  assert.equal(first.item.post.url, 'https://x.com/project/status/123');
  assert.equal((await app.request('X_LEARN_SAVE', {
    expression: example,
    post: { ...originalPost, url: 'https://x.com.example.org/project/status/123' }
  })).code, 'INVALID_POST');
  assert.equal((await app.request('X_LEARN_SAVE', {
    expression: { ...example, quote: 'made-up quote' },
    post: originalPost
  })).code, 'INVALID_INPUT');
  assert.equal((await app.request('X_LEARN_SAVE', {
    expression: { ...example, meaning: 'lead to success' },
    post: originalPost
  })).duplicate, false);
  assert.equal((await app.request('X_LEARN_LIST')).items.length, 2);
});

test('复习可分短语变形，判缺失，记录连续写入和删除', async () => {
  const app = worker(({ input }) => {
    assert.equal(input.expression.text, example.text);
    if (input.current.startsWith('We delayed')) return { matched: false };
    return {
      matched: true,
      form: 'took the demo off',
      quote: 'They took the demo off the schedule.',
      options: ['to finish it', 'to remove it', 'to make it take flight'],
      answerIndex: 1,
      explanation: '两句话的搭配都表示把某件事从日程中移除。'
    };
  });
  const { item } = await app.request('X_LEARN_SAVE', { expression: example, post: originalPost });
  const post = { id: '789', url: 'https://x.com/i/web/status/789', text: 'They took the demo off the schedule.' };
  assert.equal((await app.request('X_LEARN_REVIEW', { id: item.id, post: originalPost })).code, 'SAME_POST');
  assert.equal((await app.request('X_LEARN_REVIEW', {
    id: item.id, post: { ...post, text: 'We delayed the demo.' }
  })).code, 'NO_REVIEW_MATCH');
  const { ok, review } = await app.request('X_LEARN_REVIEW', { id: item.id, post });
  assert.equal(ok, true);
  assert.match(review.prompt, /took the demo off/);
  assert.equal(review.answerIndex, 1);
  assert.equal(review.quote, post.text);

  const attemptId = 'ef289616-73a2-41bc-ab78-ddca865c85a8';
  const progress = await Promise.all([
    app.request('X_LEARN_PROGRESS', { id: item.id, correct: false }),
    app.request('X_LEARN_PROGRESS', { id: item.id, correct: true }),
    app.request('X_LEARN_PROGRESS', { id: item.id, correct: true, attemptId })
  ]);
  const last = progress[2].item.review;
  assert.equal(last.attempts, 3);
  assert.equal(last.correct, 2);
  assert.equal(last.dueAt - last.lastReviewedAt, 2 * 24 * 60 * 60 * 1000);
  assert.deepEqual((await app.request('X_LEARN_PROGRESS', { id: item.id, correct: true, attemptId })).item.review, last);
  assert.deepEqual(await app.request('X_LEARN_DELETE', { id: item.id }), { ok: true, deleted: true });
  assert.equal((await app.request('X_LEARN_PROGRESS', { id: item.id, correct: true })).code, 'NOT_FOUND');
  assert.deepEqual(await app.request('X_LEARN_LIST'), { ok: true, items: [] });
});
