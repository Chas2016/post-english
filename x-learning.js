(() => {
  'use strict';

  const posts = globalThis.XLearningContext;
  const articleSelector = posts.articleSelector;
  const injected = '[data-x-learning-ui], .tr-target-block, .tr-popup, .tr-status, .tr-dock, .tr-compose-dialog';
  const statusPath = /^\/(?:[\w]{1,15}|i\/web|i)\/status\/(\d+)(?:\/|$)/;
  const privatePath = /^\/(?:messages|chat|compose|i\/(?:chat|messages|direct_messages))(?:\/|$)/;
  const evidenceHighlight = 'tr-x-learning-evidence';
  const maxPostLength = 5000;
  const maxContextLength = 7500;
  const attachments = new Map();
  const pending = new Set();
  let page = location.href;
  let scanFrame = 0;
  let selectionFrame = 0;
  let selectionKey = '';
  let activeContext;
  let highlighted;
  let highlightTimer;

  const ui = globalThis.XLearningUI.create({
    onAnalyze: explain,
    onTranslate: translate,
    onEvidence: revealEvidence,
    onSave: saveExpression,
    onList: async () => (await request('X_LEARN_LIST')).items,
    onDelete: (id) => request('X_LEARN_DELETE', { id }),
    onReview: createReview,
    onProgress: async ({ item, correct, attemptId }) =>
      (await request('X_LEARN_PROGRESS', { id: item.id, correct, attemptId })).item,
    onOpenSettings: () => request('X_LEARN_OPEN_SETTINGS')
  });

  const observer = new MutationObserver((records) => {
    for (const { target, addedNodes } of records) {
      const element = asElement(target);
      if (!element || element.closest(injected)) continue;
      let changed = false;
      for (const node of addedNodes) {
        const added = asElement(node);
        if (!added || added.closest(injected)) continue;
        changed = true;
        queueArticles(added);
      }
      const article = element.closest(articleSelector);
      if (article && (changed || addedNodes.length === 0)) pending.add(article);
    }
    scheduleScan();
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-testid', 'href', 'lang', 'hidden', 'aria-expanded', 'aria-hidden']
  });

  window.addEventListener('popstate', scheduleScan);
  window.navigation?.addEventListener('currententrychange', scheduleScan);
  window.addEventListener('scroll', dismissSelection, { capture: true, passive: true });
  window.addEventListener('resize', dismissSelection);
  document.addEventListener('selectionchange', scheduleSelection);
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'OPEN_X_LEARNING_LIBRARY') return false;
    if (hasLearningPage()) {
      ui.openSaved({ context: getDetailContext() });
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: '请在 X 首页或帖子详情页打开我的表达。' });
    }
    return false;
  });

  queueArticles(document.body);
  scheduleScan();

  function hasLearningPage() {
    return !privatePath.test(location.pathname);
  }

  function asElement(node) {
    return node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  }

  function queueArticles(element) {
    if (element.matches(articleSelector)) pending.add(element);
    element.querySelectorAll(articleSelector).forEach((article) => pending.add(article));
  }

  function scheduleScan() {
    if (!scanFrame) scanFrame = requestAnimationFrame(scan);
  }

  function scan() {
    scanFrame = 0;
    if (location.href !== page) {
      page = location.href;
      activeContext = null;
      ui.close({ restoreFocus: false });
      dismissSelection();
      clearEvidence();
      queueArticles(document.body);
    }

    if (activeContext && !posts.isCurrent(activeContext)) {
      activeContext = null;
      ui.closeCard({ restoreFocus: false });
      clearEvidence();
    }

    const enabled = hasLearningPage();
    for (const [article, entry] of attachments) {
      if (!enabled || !article.isConnected || !entry.body.isConnected || !entry.wrapper.isConnected) {
        entry.wrapper.remove();
        attachments.delete(article);
        if (enabled && article.isConnected) pending.add(article);
      }
    }

    if (enabled) {
      for (const article of pending) syncEntry(article);
    }
    pending.clear();
  }

  function getContext(target, selection) {
    if (!hasLearningPage()) return null;
    const context = posts.resolve(target, selection);
    return context?.current.language === 'en' ? context : null;
  }

  function syncEntry(article) {
    const entry = attachments.get(article);
    const post = article.isConnected ? posts.getCurrent(article) : null;
    if (entry && (post?.element !== entry.body || post.language !== 'en')) {
      entry.wrapper.remove();
      attachments.delete(article);
    }
    if (post?.language !== 'en' || attachments.has(article)) return;
    const button = ui.attach(post.element, { getContext: () => getContext(article) });
    if (button) {
      attachments.set(article, { body: post.element, wrapper: button.closest('.xl-entry') || button });
    }
  }

  function getDetailContext() {
    const id = statusPath.exec(location.pathname)?.[1];
    if (!id) return null;
    for (const article of document.querySelectorAll(articleSelector)) {
      if (posts.getCurrent(article)?.id === id) return getContext(article);
    }
    return null;
  }

  function dismissSelection() {
    if (!selectionKey) return;
    selectionKey = '';
    ui.clearSelection();
  }

  function scheduleSelection() {
    if (selectionFrame) return;
    selectionFrame = requestAnimationFrame(() => {
      selectionFrame = 0;
      const selection = window.getSelection();
      if (selection?.rangeCount === 1 && !selection.isCollapsed && hasLearningPage()) {
        const target = asElement(selection.anchorNode);
        const context = target && !target.closest(injected) ? getContext(target, selection) : null;
        if (context?.expression && context.expression.length <= 300) {
          const rect = selection.getRangeAt(0).getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const key = JSON.stringify([context.snapshotKey, context.expression, rect.top, rect.left]);
            if (key !== selectionKey) {
              selectionKey = key;
              ui.openSelection({
                text: context.expression,
                rect,
                target: context.current.element,
                getContext: () => posts.isCurrent(context) ? context : null
              });
            }
            return;
          }
        }
      }
      dismissSelection();
    });
  }

  function checkedContext(context) {
    if (!context || !hasLearningPage() || !posts.isCurrent(context)) {
      throw new Error('帖子内容已更新，请重新选择英文原文。');
    }
    return context;
  }

  async function request(type, values) {
    const response = await chrome.runtime.sendMessage({ type, ...values });
    if (!response?.ok) {
      throw Object.assign(new Error(response?.error || '操作未完成，请重试。'), { code: response?.code });
    }
    return response;
  }

  async function explain({ text, context }) {
    checkedContext(context);
    activeContext = context;
    const selection = text || context.expression;
    const currentText = supportedText(context.current.text, selection);
    let remaining = maxContextLength - currentText.length;
    const sources = [];
    for (const { id, text, relation } of context.sources) {
      if (relation === 'current' || text.length > Math.min(remaining, maxPostLength)) continue;
      sources.push({ id, text, relation });
      remaining -= text.length;
    }
    const response = await request('X_LEARN_EXPLAIN', {
      text: currentText,
      selection,
      sources,
      includeChinese: true
    });
    checkedContext(context);
    return response.analysis;
  }

  async function translate({ context }) {
    checkedContext(context);
    const config = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
    checkedContext(context);
    const response = await request('DO_TRANSLATE', {
      texts: [context.current.text],
      targets: [config?.targetLang || '中文'],
      host: location.host,
      config
    });
    checkedContext(context);
    const translation = response.translations?.[0];
    if (!translation?.trim()) throw new Error('未收到译文，请重试。');
    return translation;
  }

  function supportedText(text, excerpt) {
    if (text.length <= maxPostLength) return text;
    const offset = excerpt ? text.indexOf(excerpt) : -1;
    if (offset < 0) throw new Error('这条帖子较长，请划选一段英文再解释。');
    const start = Math.max(0, offset - Math.floor(maxPostLength / 2));
    return text.slice(start, start + maxPostLength).trim();
  }

  async function saveExpression({ expression, context }) {
    checkedContext(context);
    const { id, text, url } = context.current;
    return request('X_LEARN_SAVE', { expression, post: { id, text: supportedText(text, expression.quote), url } });
  }

  async function createReview({ item, context }) {
    checkedContext(context);
    const { id, text, url } = context.current;
    const response = await request('X_LEARN_REVIEW', {
      id: item.id,
      post: { id, text: supportedText(text, context.expression || item.expression.text), url }
    });
    checkedContext(context);
    return response.review;
  }

  function clearEvidence() {
    clearTimeout(highlightTimer);
    CSS.highlights?.delete(evidenceHighlight);
    highlighted?.classList.remove('xl-evidence-source');
    highlighted = null;
  }

  function revealEvidence({ context, evidence }) {
    try {
      checkedContext(context);
    } catch {
      return false;
    }
    const id = evidence.sourceId === 'current' ? context.current.id : evidence.sourceId;
    const source = posts.sourceById(context, id);
    if (!source?.element.isConnected || !source.text.includes(evidence.quote)) return false;

    clearEvidence();
    const range = evidenceRange(source.element, evidence.quote);
    if (range && CSS.highlights && typeof Highlight === 'function') {
      CSS.highlights.set(evidenceHighlight, new Highlight(range));
    } else {
      highlighted = source.element;
      highlighted.classList.add('xl-evidence-source');
    }
    source.element.scrollIntoView({
      block: 'center',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
    });
    highlightTimer = setTimeout(clearEvidence, 4500);
    return true;
  }

  function evidenceRange(element, quote) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const parts = [];
    let text = '';
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement.closest(injected + ', [aria-hidden="true"], [hidden]')) continue;
      parts.push({ node, start: text.length });
      text += node.data;
    }

    const start = text.indexOf(quote);
    if (start === -1) return null;
    const end = start + quote.length;
    const first = parts.find((part) => part.start + part.node.length > start);
    const last = parts.find((part) => part.start + part.node.length >= end);
    if (!first || !last) return null;
    const range = document.createRange();
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    return range;
  }
})();
