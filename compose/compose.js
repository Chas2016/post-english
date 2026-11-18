(() => {
  'use strict';

  const workspace = document.getElementById('workspace');
  const source = document.getElementById('source-text');
  const post = document.getElementById('post-text');
  const generate = document.getElementById('generate');
  const copy = document.getElementById('copy');
  const openX = document.getElementById('open-x');
  const count = document.getElementById('post-count');
  const status = document.getElementById('status');
  const configure = document.getElementById('configure');
  const usageLabel = document.getElementById('usage');
  const embedded = window.parent !== window && new URLSearchParams(location.search).get('embedded') === '1';
  const draftKey = 'x-compose-draft';
  const postLimit = 280;
  const shortUrlLength = 23;
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const tokenNumber = new Intl.NumberFormat('zh-CN');

  let generating = false;
  let editVersion = 0;
  let latestUsage;

  if (embedded) {
    document.documentElement.toggleAttribute('data-embedded', true);
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      window.parent.postMessage({ type: 'translate-plugin-close-composer' }, '*');
    });
  }

  if (navigator.platform.startsWith('Mac')) {
    document.getElementById('shortcut').textContent = '⌘ + Enter';
  }

  function report(message, { error = false, needsKey = false } = {}) {
    status.textContent = message;
    status.dataset.error = String(error);
    configure.hidden = !needsKey;
  }

  function reportUsage(usage) {
    const counts = [
      ['共', usage?.totalTokens],
      ['输入', usage?.inputTokens],
      ['输出', usage?.outputTokens]
    ].filter(([, total]) => Number.isSafeInteger(total) && total >= 0);
    usageLabel.hidden = false;
    usageLabel.textContent = counts.length
      ? '本次生成 · ' + counts.map(([label, total]) => label + ' ' + tokenNumber.format(total)).join(' · ') + ' Token'
      : '本次生成 · 服务商未返回 Token 用量';
  }

  // 按 X 的加权区间估算，常见 URL 和组合表情按一个单位处理。
  function estimatePostLength(text) {
    const normalized = text.normalize('NFC').replace(/(?:https?:\/\/|www\.)[^\s<>"'，。！？；：、]+/gi, (candidate) => {
      const url = candidate.replace(/[),.!?;:\]}]+$/, '');
      return 'x'.repeat(shortUrlLength) + candidate.slice(url.length);
    });

    let length = 0;
    for (const { segment } of segmenter.segment(normalized)) {
      if (/[\uFE0F\u20E3]|\p{Emoji_Presentation}/u.test(segment)) {
        length += 2;
        continue;
      }

      for (const character of segment) {
        const codePoint = character.codePointAt(0);
        const oneUnit = codePoint <= 0x10ff ||
          (codePoint >= 0x2000 && codePoint <= 0x200d) ||
          (codePoint >= 0x2010 && codePoint <= 0x201f) ||
          (codePoint >= 0x2032 && codePoint <= 0x2037);
        length += oneUnit ? 1 : 2;
      }
    }
    return length;
  }

  function render() {
    const text = post.value.trim();
    const length = estimatePostLength(text);
    const overLimit = length > postLimit;
    count.textContent = '约 ' + length + ' / ' + postLimit + (overLimit ? ' · 超出普通帖文长度' : '');
    count.dataset.long = String(overLimit);

    generate.disabled = generating || !source.value.trim();
    generate.textContent = generating ? '正在生成…' : '生成英文帖';
    copy.disabled = !text;
    openX.disabled = !text;
  }

  function saveDraft() {
    try {
      sessionStorage.setItem(draftKey, JSON.stringify({ source: source.value, post: post.value, usage: latestUsage }));
    } catch {
      // 草稿仍保留在页面中。
    }
  }

  function restoreDraft() {
    try {
      const draft = JSON.parse(sessionStorage.getItem(draftKey));
      if (draft && typeof draft.source === 'string') source.value = draft.source;
      if (draft && typeof draft.post === 'string') post.value = draft.post;
      if (draft?.usage !== undefined) {
        latestUsage = draft.usage;
        reportUsage(latestUsage);
      }
    } catch {
      // 直接使用空白编辑区。
    }
  }

  function onEdit() {
    editVersion++;
    if (!generating) report('');
    saveDraft();
    render();
  }

  workspace.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = source.value.trim();
    if (generating || !text) return;

    generating = true;
    const requestVersion = editVersion;
    report('正在生成英文帖文…');
    render();

    try {
      const response = await chrome.runtime.sendMessage({ type: 'GENERATE_X_POST', text });
      if (response?.ok) {
        latestUsage = response.usage ?? null;
        reportUsage(latestUsage);
        saveDraft();
      }
      if (editVersion !== requestVersion) {
        report('草稿已修改，可以再次生成。');
        return;
      }
      if (!response?.ok) {
        report(response?.error || '生成失败，请重试。', {
          error: true,
          needsKey: response?.code === 'MISSING_API_KEY' || /API Key/i.test(response?.error || '')
        });
        return;
      }
      if (typeof response.post !== 'string' || !response.post.trim()) {
        report('模型未返回帖文，请重试。', { error: true });
        return;
      }

      post.value = response.post.trim();
      saveDraft();
      report('英文帖文已生成。');
      post.focus({ preventScroll: true });
    } catch {
      report('暂时无法连接到扩展，请重试。', { error: true });
    } finally {
      generating = false;
      render();
    }
  });

  workspace.addEventListener('keydown', (event) => {
    if (event.isComposing || event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    if (!generate.disabled) workspace.requestSubmit();
  });

  source.addEventListener('input', onEdit);
  post.addEventListener('input', onEdit);

  copy.addEventListener('click', async () => {
    const text = post.value.trim();
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      report('已复制英文帖文。');
    } catch {
      post.focus();
      post.select();
      report('剪贴板暂不可用，已选中英文帖文，可手动复制。', { error: true });
    }
  });

  openX.addEventListener('click', async () => {
    const text = post.value.trim();
    if (!text) return;

    const url = new URL('https://x.com/intent/tweet');
    url.searchParams.set('text', text);
    try {
      await chrome.tabs.create({ url: url.href });
    } catch {
      report('无法打开 X，可复制帖文后在 X 中粘贴。', { error: true });
    }
  });

  restoreDraft();
  render();
  if (embedded) window.parent.postMessage({ type: 'translate-plugin-composer-ready' }, '*');
})();
