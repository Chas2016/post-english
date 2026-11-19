'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { existsSync, globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { homedir, tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

// Use CHROME_BIN to run against another Chrome or Chromium installation.
const chrome = process.env.CHROME_BIN || [
  ...(globSync?.(path.join(homedir(), '.cache/puppeteer/chrome-headless-shell/*/*/chrome-headless-shell')) || []),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].find(existsSync);

function runFixtures() {
  const context = globalThis.XLearningContext;
  const results = [];
  const main = document.querySelector('main');

  function timestamp(id, name = 'writer') {
    return `<a href="/${name}/status/${id}?s=20"><time>Now</time></a>`;
  }

  function text(value, lang = 'en') {
    return `<div data-testid="tweetText" lang="${lang}">${value}</div>`;
  }

  function article(id, content, extra = '', attributes = '') {
    return `<article data-testid="tweet" id="post-${id}" ${attributes}>
      ${timestamp(id)}${text(content)}${extra}<button data-x-learning-ui>读懂</button>
    </article>`;
  }

  function quote(id, content, nested = '') {
    return `<div role="link" tabindex="0">${timestamp(id, 'quoted')}${text(content)}${nested}</div>`;
  }

  function post(id) {
    return document.getElementById(`post-${id}`);
  }

  function expect(actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  function ids(result) {
    return result.sources.map(({ id, relation }) => [id, relation]);
  }

  function fixture(name, markup, check) {
    main.innerHTML = markup;
    getSelection().removeAllRanges();
    try {
      check();
      results.push({ name });
    } catch (error) {
      results.push({ name, error: error.stack });
    }
  }

  fixture('canonical current permalink and original body', article('27', 'That <span>aged well</span>.',
    '<div class="tr-target-block">中文译文</div><div data-testid="tweetTranslation">' + text('Native translation', 'fr') + '</div>'), () => {
    const result = context.resolve(post('27').querySelector('button'));
    expect(ids(result), [['27', 'current']]);
    expect(result.current.text, 'That aged well.');
    expect(result.current.url, 'https://x.com/writer/status/27');
    expect(result.current.language, 'en');
    expect(result.expression, '');
  });

  fixture('selected expression stays inside its exact native body', article('42', 'A <span>good call</span>.'), () => {
    const range = document.createRange();
    const selection = getSelection();
    range.selectNodeContents(post('42').querySelector('span'));
    selection.addRange(range);
    expect(context.resolve(null, selection).expression, 'good call');
    selection.removeAllRanges();
    range.selectNodeContents(post('42'));
    selection.addRange(range);
    expect(context.resolve(post('42'), selection), null);
  });

  fixture('a direct quote owns its text and identity, excluding its inner quote',
    article('400', 'We learned the hard way.', quote('401', 'No one will use this.', quote('402', 'A deeper quote.'))), () => {
      const result = context.resolve(post('400'));
      expect(ids(result), [['400', 'current'], ['401', 'quote']]);
      const evidence = context.sourceById(result, '401');
      expect(evidence.text, 'No one will use this.');
      expect(evidence.url, 'https://x.com/quoted/status/401');
      expect(context.sourceById(result, '402'), null);
      expect(context.resolve(evidence.element), null);
    });

  fixture('quote wrappers preserve the nested article identity',
    article('201', 'Linking them.', '<div data-testid="quoteTweet"><div role="link">' + article('202', 'The real quote.') + '</div></div>'), () => {
      const result = context.resolve(post('201'));
      expect(ids(result), [['201', 'current'], ['202', 'quote']]);
      expect(context.getCurrent(post('202')), null);
    });

  fixture('a quote block independently identifies its visible language-tagged body',
    article('220', 'See the other post.', `<div role="blockquote">${timestamp('222', 'another')}
      <div lang="en" dir="auto">The original remark.</div></div>`), () => {
      const result = context.resolve(post('220'));
      expect(ids(result), [['220', 'current'], ['222', 'quote']]);
      expect(context.sourceById(result, '222').text, 'The original remark.');
    });

  fixture('quote candidate without a visible stable identity is unavailable', article('600', 'What did they say?',
    `<div role="link">${text('Unidentified author’s text.')}</div>${quote('601', '<span>Hidden body.</span>').replace('role="link"', 'role="link" style="display:none"')}`), () => {
    expect(ids(context.resolve(post('600'))), [['600', 'current']]);
  });

  fixture('the previous visible neighbor and a profile reply link do not prove a parent', article('125', 'A nearby post.') +
    article('126', 'A separate short reply.', '<div data-testid="replyingTo">Replying to <a href="/writer">@writer</a></div>'), () => {
      expect(ids(context.resolve(post('126'))), [['126', 'current']]);
    });

  fixture('an explicit in-reply-to status matches the correct rendered parent',
    article('151', 'The directly addressed post.') + article('150', 'A misleading neighbor.') +
    article('152', 'That aged well.', '<div data-testid="replyingTo"><a href="/writer/status/151">Reply target</a></div>'), () => {
      const result = context.resolve(post('152'));
      expect(ids(result), [['152', 'current'], ['151', 'parent']]);
      expect(context.sourceById(result, '151').text, 'The directly addressed post.');
    });

  fixture('missing, conflicting or hidden parents are omitted',
    article('800', 'Unknown parent.', '', 'data-in-reply-to-status-id="999"') +
    article('801', 'Hidden.', '', 'hidden') + article('802', 'No visible parent.', '', 'data-in-reply-to-status-id="801"') +
    article('803', 'Conflicting parent.', '<a rel="in-reply-to" href="/writer/status/802">Reply target</a>', 'data-in-reply-to-status-id="800"'), () => {
      for (const id of ['800', '802', '803']) expect(ids(context.resolve(post(id))), [[id, 'current']]);
    });

  fixture('ordinary in-text status links and timestamps of quotes do not become the current post',
    `<article data-testid="tweet" id="post-18">${text('<a href="/writer/status/18">A link to a post.</a>')}${quote('19', 'A quote.')}</article>`, () => {
      expect(context.resolve(post('18')), null);
    });

  fixture('a competing permalink in a quote is discarded', article('880', 'Unambiguous main post.',
    `<div role="link" href="/writer/status/881">${timestamp('882')}${text('Ambiguous quote.')}</div>`), () => {
    expect(ids(context.resolve(post('880'))), [['880', 'current']]);
  });

  fixture('injected HTML leaves the snapshot intact; React reuse and navigation invalidate it',
    article('701', 'I’m in.', quote('702', 'We’re heading out at noon.')), () => {
      const original = context.resolve(post('701'));
      const hint = document.createElement('span');
      hint.dataset.xLearningUi = '';
      hint.textContent = 'Injected hint';
      original.current.element.append(hint);
      expect(context.isCurrent(original), true);
      const beforeNavigate = context.resolve(post('701'));
      location.hash = 'next';
      expect(context.isCurrent(beforeNavigate), false);
      const beforeRecycling = context.resolve(post('701'));
      post('701').querySelector('a').href = '/writer/status/703';
      expect(context.isCurrent(beforeRecycling), false);
    });

  fixture('body and relationship changes invalidate a pending response',
    article('501', 'I guess so.', quote('502', 'Can we go?')), () => {
      const initial = context.resolve(post('501'));
      context.sourceById(initial, '502').element.textContent = 'But is that safe?';
      expect(context.isCurrent(initial), false);
      const updated = context.resolve(post('501'));
      updated.current.element.textContent = 'Sounds good.';
      expect(context.isCurrent(updated), false);
    });

  document.querySelector('#results').textContent = encodeURIComponent(JSON.stringify(results));
}

test('X learning context in real Chromium DOM', { skip: chrome ? false : 'Set CHROME_BIN to run the browser fixtures' }, async (t) => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'x-context-'));
  t.after(() => rmSync(temporary, { force: true, recursive: true }));
  const fixture = path.join(temporary, 'index.html');
  const source = readFileSync(path.join(__dirname, '..', 'x-context.js'), 'utf8');
  writeFileSync(fixture, `<!doctype html><meta charset="utf-8"><main></main><pre id="results"></pre>
    <script>${source}\n(${runFixtures})();</script>`);
  const platformArgs = process.platform === 'darwin' ? ['--single-process'] : [];
  const result = spawnSync(chrome, [
    '--headless', '--disable-gpu', '--no-sandbox', '--disable-breakpad', '--disable-background-networking',
    ...platformArgs,
    '--no-first-run', `--user-data-dir=${path.join(temporary, 'profile')}`, '--dump-dom', pathToFileURL(fixture).href
  ], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, [result.error?.message, result.signal, result.stderr].filter(Boolean).join('\n'));
  const serialized = result.stdout.match(/<pre id="results">(.+?)<\/pre>/)?.[1];
  assert.ok(serialized, 'The fixture did not report results');
  const checks = JSON.parse(decodeURIComponent(serialized));
  assert.ok(checks.length >= 13, 'Missing regression cases');
  for (const { name, error } of checks) await t.test(name, () => assert.equal(error, undefined));
});
