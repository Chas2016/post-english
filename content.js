// ============================================================
// content.js — 读帖英语 页面脚本
// 职责：
//  1. 只提取「正文」文本（跳过导航、按钮、链接、页眉页脚等 UI 元素）
//  2. 悬浮工具：切换翻译，在当前网页写 X 帖文
//  3. 按视窗翻译动态更新的正文，也可先读原文再按需查看译文
//  4. 双语渲染 + 划词翻译
// ============================================================

(() => {
  'use strict';

  // ============ 常量 ============

  // 不可翻译的标签（含 A 链接，链接文本整体跳过）
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR',
    'TEXTAREA', 'INPUT', 'SELECT', 'BUTTON', 'OPTION',
    'SVG', 'MATH', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED',
    'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'HEAD', 'TITLE', 'META', 'LINK',
    'TEMPLATE', 'A'
  ]);

  // 语义上「非正文」的容器（元素及其内部整体跳过）
  const SKIP_CONTAINER_SELECTOR =
    'nav, header, footer, aside, menu, dialog, form, figure, figcaption,' +
    '[role="navigation"], [role="banner"], [role="menu"], [role="menubar"],' +
    '[role="toolbar"], [role="complementary"], [role="contentinfo"],' +
    '[role="search"], [role="dialog"], [role="form"]';

  // class / id 命中这些关键词的元素视为非正文（导航、页脚、侧栏、评论、广告等）
  const SKIP_KEYWORD_RE =
    /(^|[-_ ])(nav|navbar|menu|logo|header|footer|sidebar|aside|breadcrumb|toolbar|pagination|copyright|cookie|advert|ad|banner|promo|share|social|comment|subscribe|newsletter|login|signin|signup|logout|lang|locale|sitemap|widget|trending|related|recommend|branding|search)([-_ ]|$)/i;

  // 视为「块级」的 display 值（其余视为行内）
  const BLOCK_DISPLAY = new Set([
    'block', 'flex', 'grid', 'list-item', 'table', 'table-row',
    'table-cell', 'table-caption', 'flow-root', 'inline-flex'
  ]);

  const MAX_BLOCK_CHARS = 4000;   // 单块最大文本长度
  const SHORT_TEXT = 40;          // 短文本阈值（低于此值须为完整句子）
  const SCAN_DELAY = 180;         // 合并连续滚动和 DOM 更新
  const BATCH_SIZE = 25;          // 每批翻译的块数

  const MODES = new Set(['bilingual', 'translation', 'original', 'study']);
  const INJECTED = '.tr-dock, .tr-compose-dialog, .tr-target-block, .tr-popup, .tr-status, [data-x-learning-ui]';
  const RETRY_DELAY = 4000;

  const state = {
    autoMode: false,
    displayMode: 'study',
    config: {},
    ball: null,
    composeButton: null,
    composer: null,
    observer: null,
    scanTimer: null,
    scanAgain: false,
    firstScan: false,
    statusTimer: null,
    busyGeneration: null,
    generation: 0,
    retryAt: 0,
    entries: new Map(),
    selectionRequest: 0
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'TRANSLATE_SELECTION':
        ready.then(() => translateSelection(msg.text));
        sendResponse({ ok: true });
        return false;
      case 'OPEN_X_COMPOSER':
        ready.then(() => {
          openComposer();
          sendResponse({ ok: true });
        }).catch(() => sendResponse({ ok: false }));
        return true;
      case 'GET_PAGE_STATE':
      case 'TRANSLATE_PAGE':
      case 'RESTORE_PAGE':
      case 'TOGGLE_TRANSLATE':
      case 'SET_DISPLAY_MODE':
        ready.then(() => {
          if (msg.type === 'TRANSLATE_PAGE') setAutoMode(true);
          if (msg.type === 'RESTORE_PAGE') setAutoMode(false);
          if (msg.type === 'TOGGLE_TRANSLATE') setAutoMode(!state.autoMode);
          if (msg.type === 'SET_DISPLAY_MODE') setDisplayMode(msg.mode);
          sendResponse({ enabled: state.autoMode, mode: state.displayMode });
        });
        return true;
      default:
        return false;
    }
  });

  const ready = init();

  async function init() {
    try {
      state.config = (await chrome.runtime.sendMessage({ type: 'GET_CONFIG' })) || {};
    } catch {
      // 读取失败时仍提供操作入口，使用时会显示配置提示。
    }
    if (MODES.has(state.config.displayMode)) state.displayMode = state.config.displayMode;
    applyDisplayMode();
    createFloatingBall();
    if (state.config.autoTranslate && hasProviderKey()) setAutoMode(true);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const key of ['activeProvider', 'providers', 'targetLang', 'enableCache', 'cacheRetentionDays', 'highlightAdvanced']) {
        if (changes[key]) state.config[key] = changes[key].newValue;
      }
      if (changes.targetLang) {
        state.generation++;
        restorePage();
        scheduleViewport();
      }
      if (changes.activeProvider || changes.providers) {
        state.retryAt = 0;
        if (hasProviderKey()) scheduleViewport();
      }
      if (changes.highlightAdvanced && !state.config.highlightAdvanced) clearHighlights(document);
    });
  }

  function createFloatingBall() {
    const dock = document.createElement('div');
    dock.className = 'tr-dock';
    dock.setAttribute('role', 'group');
    dock.setAttribute('aria-label', '读帖英语工具');
    const ball = document.createElement('button');
    ball.type = 'button';
    ball.className = 'tr-dock-button tr-ball';
    ball.textContent = '译';
    ball.addEventListener('click', () => setAutoMode(!state.autoMode));

    const composeButton = document.createElement('button');
    composeButton.type = 'button';
    composeButton.className = 'tr-dock-button tr-compose-launch';
    composeButton.textContent = '写 X';
    composeButton.title = '写 X 帖文';
    composeButton.setAttribute('aria-label', '写 X 帖文');
    composeButton.setAttribute('aria-haspopup', 'dialog');
    composeButton.addEventListener('click', openComposer);

    dock.append(ball, composeButton, createDockUsage());
    document.documentElement.appendChild(dock);
    state.ball = ball;
    state.composeButton = composeButton;
    updateBall();
  }

  function createDockUsage() {
    const host = document.createElement('div');
    host.className = 'tr-dock-usage';
    const shadow = host.attachShadow({ mode: 'closed' });
    const readout = document.createElement('div');
    readout.setAttribute('role', 'group');
    const label = document.createElement('span');
    label.setAttribute('part', 'label');
    label.setAttribute('aria-hidden', 'true');
    label.textContent = '今日 Token';
    const amount = document.createElement('span');
    amount.setAttribute('part', 'amount');
    amount.setAttribute('aria-hidden', 'true');
    amount.textContent = '…';
    readout.setAttribute('aria-label', '今日 Token 用量加载中');
    readout.append(label, amount);
    shadow.append(readout);

    const fullNumber = new Intl.NumberFormat('zh-CN');
    const compactNumber = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
    let refreshVersion = 0;
    let midnightTimer;

    async function refresh() {
      if (document.hidden) return;
      const version = ++refreshVersion;
      let today;
      try {
        const result = await chrome.runtime.sendMessage({ type: 'GET_TOKEN_USAGE', todayOnly: true });
        if (result?.ok && Number.isFinite(result.usage?.today?.totalTokens)) today = result.usage.today;
      } catch {
        // 扩展重载后，等待刷新页面恢复读取。
      }
      if (version !== refreshVersion) return;

      let description = '今日 Token 用量暂不可用';
      amount.textContent = '—';
      if (today) {
        const missing = today.unreportedRequests > 0;
        if (missing && today.totalTokens === 0 && today.unreportedRequests === today.requestCount) {
          description = '今日尚无可汇总的 Token 总量，' +
            fullNumber.format(today.unreportedRequests) + ' 次响应的用量未完整回传';
        } else {
          amount.textContent = compactNumber.format(today.totalTokens) + (missing ? '*' : '');
          description = '今日 Token ' + fullNumber.format(today.totalTokens) +
            '，输入 ' + fullNumber.format(today.inputTokens) + '，输出 ' + fullNumber.format(today.outputTokens);
          if (missing) description += '，' + fullNumber.format(today.unreportedRequests) + ' 次响应的用量未完整回传';
        }
      }
      readout.title = description;
      readout.setAttribute('aria-label', description);
    }

    function refreshDay() {
      clearTimeout(midnightTimer);
      if (document.hidden) return;
      refresh();
      const nextMidnight = new Date();
      nextMidnight.setHours(24, 0, 0, 0);
      midnightTimer = setTimeout(refreshDay, nextMidnight.getTime() - Date.now());
    }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.tokenUsageByDay) refresh();
    });
    document.addEventListener('visibilitychange', refreshDay);
    refreshDay();
    return host;
  }

  function openComposer() {
    state.composer ||= createComposerDialog();
    if (!state.composer.open) state.composer.showModal();
  }

  function createComposerDialog() {
    const url = chrome.runtime.getURL('compose/compose.html');
    const extensionOrigin = 'chrome-extension://' + chrome.runtime.id;
    const dialog = document.createElement('dialog');
    dialog.className = 'tr-compose-dialog';
    dialog.setAttribute('aria-labelledby', 'tr-compose-title');
    dialog.innerHTML =
      '<div class="tr-compose-head">' +
      '  <h2 id="tr-compose-title">写 X 帖文</h2>' +
      '  <button type="button" class="tr-popup-close" aria-label="关闭写帖" autofocus>×</button>' +
      '</div>' +
      '<div class="tr-compose-load" role="status">正在加载写帖工具…</div>' +
      '<iframe title="X 帖文编辑器" class="tr-compose-frame" allow="clipboard-write"></iframe>';

    const frame = dialog.querySelector('iframe');
    const loading = dialog.querySelector('.tr-compose-load');
    const close = dialog.querySelector('button');
    let outsidePointer = false;
    let loaded = false;
    const timeout = setTimeout(() => {
      dialog.dataset.load = 'unavailable';
      loading.textContent = '当前网页未能加载写帖工具。';
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = '在新标签页打开';
      loading.append(' ', link);
    }, 3000);

    window.addEventListener('message', (event) => {
      if (event.source !== frame.contentWindow || event.origin !== extensionOrigin) return;
      if (!loaded && event.data?.type === 'translate-plugin-composer-ready') {
        loaded = true;
        clearTimeout(timeout);
        dialog.dataset.load = 'ready';
        loading.hidden = true;
      }
      if (event.data?.type === 'translate-plugin-close-composer' && dialog.open) dialog.close();
    });

    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('pointerdown', (event) => {
      outsidePointer = event.target === dialog;
    });
    dialog.addEventListener('click', (event) => {
      if (outsidePointer && event.target === dialog) dialog.close();
      outsidePointer = false;
    });
    dialog.addEventListener('close', () => state.composeButton.focus({ preventScroll: true }));

    frame.src = url + '?embedded=1';
    document.documentElement.appendChild(dialog);
    return dialog;
  }

  function updateBall() {
    const label = state.displayMode === 'study' ? '先读原文' : '网页翻译';
    state.ball.classList.toggle('active', state.autoMode);
    state.ball.setAttribute('aria-pressed', String(state.autoMode));
    state.ball.setAttribute('aria-label', label);
    state.ball.title = state.autoMode ? '关闭本页' + label : '开启本页' + label;
  }

  function hasProviderKey() {
    return Boolean(state.config.providers?.[state.config.activeProvider]?.apiKey?.trim());
  }

  function setAutoMode(on) {
    if (state.autoMode === on) return;
    if (on && !hasProviderKey()) {
      showStatus('请先在插件设置中配置翻译引擎', true);
      return;
    }

    state.autoMode = on;
    updateBall();
    if (on) {
      state.firstScan = true;
      state.retryAt = 0;
      window.addEventListener('scroll', scheduleViewport, { passive: true, capture: true });
      window.addEventListener('resize', scheduleViewport, { passive: true });
      state.observer = new MutationObserver((records) => {
        if (records.some(isPageMutation)) scheduleViewport();
      });
      state.observer.observe(document.body, {
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['hidden', 'aria-hidden', 'aria-expanded'],
        subtree: true
      });
      scheduleViewport();
      return;
    }

    state.generation++;
    state.observer.disconnect();
    state.observer = null;
    window.removeEventListener('scroll', scheduleViewport, true);
    window.removeEventListener('resize', scheduleViewport);
    clearTimeout(state.scanTimer);
    state.scanTimer = null;
    state.scanAgain = false;
    restorePage();
  }

  function isPageMutation(record) {
    const element = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
    if (element?.closest(INJECTED + ', .tr-hl')) return false;
    if (record.type !== 'childList') return true;
    return [...record.addedNodes, ...record.removedNodes].some(
      (node) => node.nodeType !== Node.ELEMENT_NODE || !node.matches(INJECTED + ', .tr-hl')
    );
  }

  function setDisplayMode(mode) {
    if (!MODES.has(mode) || mode === state.displayMode) return;
    const reset = mode === 'study' || state.displayMode === 'study';
    if (reset || state.displayMode === 'original') state.firstScan = true;
    state.displayMode = mode;
    if (reset) {
      state.generation++;
      restorePage();
    }
    applyDisplayMode();
    updateBall();
    scheduleViewport();
  }

  function scheduleViewport() {
    if (!state.autoMode || state.scanTimer !== null) return;
    state.scanTimer = setTimeout(() => {
      state.scanTimer = null;
      translateViewport();
    }, SCAN_DELAY);
  }

  async function translateViewport() {
    if (!state.autoMode) return;
    const gen = state.generation;
    if (state.busyGeneration === gen) {
      state.scanAgain = true;
      return;
    }
    state.busyGeneration = gen;

    try {
      for (const entry of state.entries.values()) {
        if (!isCurrent(entry)) removeEntry(entry);
      }
      if (state.displayMode === 'original') return;
      const blocks = collectBlocks();
      if (state.firstScan) {
        state.firstScan = false;
        if (!blocks.length && !state.entries.size) {
          const selection = state.displayMode === 'study' ? '英文正文' : '可翻译的正文';
          showStatus('当前视窗未找到' + selection + '，可滚动查看后续内容');
        }
      }

      if (state.displayMode === 'study') {
        for (const block of blocks) createStudyEntry(block);
        return;
      }
      if (Date.now() < state.retryAt) return;
      for (let i = 0; i < blocks.length && state.generation === gen && state.displayMode !== 'original'; i += BATCH_SIZE) {
        await translateBatch(blocks.slice(i, i + BATCH_SIZE), gen);
      }
    } catch (error) {
      if (state.generation === gen) {
        state.retryAt = Date.now() + RETRY_DELAY;
        showStatus('翻译失败：' + error.message, true);
      }
    } finally {
      if (state.busyGeneration === gen) {
        state.busyGeneration = null;
        if (state.scanAgain) {
          state.scanAgain = false;
          scheduleViewport();
        }
      }
    }
  }

  async function requestTranslations(blocks) {
    const response = await chrome.runtime.sendMessage({
      type: 'DO_TRANSLATE',
      texts: blocks.map((block) => block.text),
      targets: blocks.map((block) => block.targetLang),
      config: state.config,
      host: location.host
    });
    if (!response?.ok) throw new Error(response?.error || '翻译服务未返回结果');
    return response.translations;
  }

  async function translateBatch(blocks, gen) {
    const entries = blocks.filter(isCurrent).map((block) => {
      const entry = createEntry(block);
      entry.textNode.textContent = '翻译中…';
      entry.target.classList.add('tr-loading');
      return entry;
    });
    if (!entries.length) return;
    let translations;
    try {
      translations = await requestTranslations(entries);
    } catch (error) {
      for (const entry of entries) removeEntry(entry);
      throw error;
    }
    if (state.generation !== gen) return;

    const english = [];
    entries.forEach((entry, index) => {
      const translation = translations[index]?.trim();
      if (translation && isCurrent(entry)) {
        entry.target.classList.remove('tr-loading');
        entry.textNode.textContent = translation;
        if (!entry.cell) entry.el.classList.add('tr-src-block');
        if (entry.lang === 'en') english.push(entry);
      } else {
        removeEntry(entry);
      }
    });

    hideStatus();
    if (state.config.highlightAdvanced && state.displayMode !== 'original') {
      highlightAdvancedInChunk(english, gen);
    }
  }

  // 对一批英文块做高级词汇高亮
  async function highlightAdvancedInChunk(blocks, gen) {
    if (!blocks.length) return;
    if (state.generation !== gen) return;
    const texts = blocks.map((b) => b.text);
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'ANALYZE_ADVANCED',
        texts,
        config: state.config
      });
      if (state.generation !== gen) return;
      if (!resp || !resp.ok || state.displayMode === 'original') return;
      const groups = resp.groups || [];
      blocks.forEach((b, idx) => {
        if (state.config.highlightAdvanced && isCurrent(b)) applyHighlight(b.el, groups[idx] || []);
      });
    } catch (e) {
      // 高亮失败静默忽略
    }
  }

  // 在原文块中给指定词汇/短语加高亮标记
  function applyHighlight(el, words) {
    if (!words || !words.length) return;
    clearHighlights(el);

    // 按长度降序，避免短词先命中长短语的子串
    const sorted = words.filter((w) => w && w.trim()).sort((a, b) => b.length - a.length);

    for (const word of sorted) {
      highlightWord(el, word);
    }
  }

  // 在元素的文本节点中高亮某个词（区分大小写）
  function highlightWord(root, word) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'g');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.parentElement?.closest(INJECTED + ', .tr-hl')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    for (const textNode of textNodes) {
      const text = textNode.nodeValue;
      regex.lastIndex = 0;
      if (!text || !regex.test(text)) continue;
      regex.lastIndex = 0;

      const frag = document.createDocumentFragment();
      let lastIndex = 0;
      let m;
      while ((m = regex.exec(text)) !== null) {
        if (m.index > lastIndex) {
          frag.appendChild(document.createTextNode(text.slice(lastIndex, m.index)));
        }
        const mark = document.createElement('mark');
        mark.className = 'tr-hl';
        mark.textContent = m[0];
        frag.appendChild(mark);
        lastIndex = m.index + m[0].length;
        if (m[0].length === 0) regex.lastIndex++;
      }
      if (lastIndex < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastIndex)));
      }
      textNode.parentNode.replaceChild(frag, textNode);
    }
  }

  // ============ 恢复原文 ============
  function clearHighlights(root) {
    root.querySelectorAll('.tr-hl').forEach((mark) => {
      const parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent));
      parent.normalize();
    });
  }

  function restorePage() {
    for (const entry of state.entries.values()) removeEntry(entry);
    hideStatus();
  }

  function applyDisplayMode() {
    document.documentElement.setAttribute('data-tr-mode', state.displayMode);
  }

  function collectBlocks() {
    const blocks = [];
    const selector = socialSelector();
    const social = selector ? document.querySelectorAll(selector) : [];
    const useSocialPosts = social.length > 0;
    const candidates = useSocialPosts ? social : document.body.getElementsByTagName('*');

    for (const el of candidates) {
      if (state.entries.has(el) || SKIP_TAGS.has(el.tagName)) continue;
      if (el.closest(SKIP_CONTAINER_SELECTOR +
          ', [contenteditable]:not([contenteditable="false"]), [aria-hidden="true"], [role="button"], a, ' + INJECTED)) continue;
      if (!isInViewport(el)) continue;

      if (useSocialPosts) {
        if (el.parentElement?.closest(selector)) continue;
      } else {
        if (hasSkipKeyword(el) || !BLOCK_DISPLAY.has(getDisplay(el)) || hasBlockChild(el)) continue;
      }

      const text = (el.innerText || '').trim();
      const declaredLang = el.getAttribute('lang')?.split('-')[0].toLowerCase();
      const lang = declaredLang && declaredLang !== 'und' ? declaredLang : detectLang(text);
      if (!isBodyText(text, lang, useSocialPosts)) continue;
      if (state.displayMode === 'study' && lang !== 'en') continue;

      blocks.push({ el, text, lang, targetLang: targetForLang(lang), rawText: sourceTextContent(el) });
    }
    return blocks;
  }

  function socialSelector() {
    const host = location.hostname.replace(/^www\./, '');
    if (host === 'x.com' || host === 'twitter.com') return '[data-testid="tweetText"]';
    if (host === 'facebook.com' || host.endsWith('.facebook.com')) {
      return '[data-ad-preview="message"], [data-ad-comet-preview="message"]';
    }
    return '';
  }

  // 是否有块级子元素（块级叶子才作为翻译单元）
  function hasBlockChild(el) {
    for (const child of el.children) {
      if (SKIP_TAGS.has(child.tagName)) continue;
      if (BLOCK_DISPLAY.has(getDisplay(child))) return true;
    }
    return false;
  }

  function getDisplay(el) {
    try {
      return getComputedStyle(el).display || 'inline';
    } catch (e) {
      return 'inline';
    }
  }

  // 判断文本是否为可翻译的正文：
  // 中英文均可（互译），长度适中，短文本须是完整句子
  function isBodyText(text, lang, social) {
    if (text.length < 2 || text.length > MAX_BLOCK_CHARS || !['en', 'zh'].includes(lang)) return false;
    if (social) return /[A-Za-z\p{Script=Han}]/u.test(text.replace(/https?:\/\/\S+|[@#]\S+/g, ''));
    if (text.length >= SHORT_TEXT || text.includes('\n')) return true;
    return /[.!?。！？]["')\]]?$/.test(text);
  }

  // 检测文本主要语言：'en' 英文 | 'zh' 中文 | 'other' 其他
  function detectLang(text) {
    const cn = (text.match(/[一-鿿]/g) || []).length;
    const en = (text.match(/[A-Za-z]/g) || []).length;
    const total = text.length || 1;
    if (cn / total >= 0.3) return 'zh';
    if (en / total >= 0.3) return 'en';
    if (cn > en && cn > 0) return 'zh';
    if (en > cn && en > 0) return 'en';
    return 'other';
  }

  // 根据原文语言决定翻译目标：中文→英文，英文→目标语言（默认中文）
  function targetForLang(lang) {
    if (lang === 'zh') return '英文';
    return (state.config && state.config.targetLang) || '中文';
  }

  // 元素自身及祖先的 class / id 是否命中非正文关键词
  function hasSkipKeyword(el) {
    let node = el;
    let depth = 0;
    while (node && node !== document.body && depth < 12) {
      const cls = typeof node.className === 'string'
        ? node.className
        : (node.className && node.className.baseVal) || '';
      const id = node.id || '';
      if (SKIP_KEYWORD_RE.test(cls + ' ' + id)) return true;
      node = node.parentElement;
      depth++;
    }
    return false;
  }

  // 是否在视窗内（含部分相交）
  function isInViewport(el) {
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    return rect.width > 0 && rect.height > 0 &&
      rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
  }

  // ============ 译文和学习模式控件 ============

  function createEntry(block) {
    const target = document.createElement('div');
    target.className = 'tr-target-block';
    const textNode = document.createElement('div');
    textNode.className = 'tr-target-text';
    target.append(textNode);

    const cell = block.el.matches('td, th');
    const sourceStyle = getComputedStyle(block.el);
    target.style.setProperty('--tr-source-color', sourceStyle.color);
    target.style.setProperty('--tr-source-font-size', sourceStyle.fontSize);
    if (cell) block.el.append(target);
    else block.el.after(target);

    const entry = { ...block, target, textNode, cell };
    state.entries.set(block.el, entry);
    return entry;
  }

  function sourceTextContent(el) {
    return Array.from(el.childNodes, (node) =>
      node.nodeType === Node.ELEMENT_NODE && node.matches('.tr-target-block') ? '' : node.textContent
    ).join('');
  }

  function isCurrent(entry) {
    if (!entry.el.isConnected || sourceTextContent(entry.el) !== entry.rawText) return false;
    if (!entry.target) return true;
    return entry.cell ? entry.target.parentElement === entry.el : entry.el.nextElementSibling === entry.target;
  }

  function removeEntry(entry) {
    entry.target.remove();
    if (state.entries.get(entry.el) !== entry) return;
    entry.el.classList.remove('tr-src-block');
    clearHighlights(entry.el);
    state.entries.delete(entry.el);
  }

  function createStudyEntry(block) {
    const entry = createEntry(block);
    entry.target.classList.add('tr-study');
    entry.textNode.hidden = true;
    entry.textNode.setAttribute('aria-live', 'polite');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tr-study-toggle';
    button.textContent = '查看译文';
    button.setAttribute('aria-expanded', 'false');
    entry.target.prepend(button);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleStudyTranslation(entry, button);
    });
  }

  async function toggleStudyTranslation(entry, button) {
    const show = entry.textNode.hidden;
    entry.textNode.hidden = !show;
    button.setAttribute('aria-expanded', String(show));
    button.textContent = show ? '收起译文' : '查看译文';
    if (!show || entry.pending || entry.translation) return;

    entry.pending = true;
    entry.textNode.textContent = '翻译中…';
    const gen = state.generation;
    try {
      const [translation] = await requestTranslations([entry]);
      if (state.generation !== gen || !isCurrent(entry)) return;
      if (!translation?.trim()) throw new Error('未收到译文');
      entry.translation = translation;
      entry.textNode.textContent = translation;
      if (state.config.highlightAdvanced) highlightAdvancedInChunk([entry], gen);
    } catch (error) {
      if (state.generation === gen && isCurrent(entry)) {
        entry.textNode.textContent = '翻译失败：' + error.message;
        button.textContent = '收起提示';
      }
    } finally {
      entry.pending = false;
    }
  }

  // ============ 划词翻译 ============
  async function translateSelection(text) {
    if (!text || !text.trim()) return;
    text = text.trim();
    const request = ++state.selectionRequest;
    const popup = getPopup();
    const result = popup.querySelector('.tr-popup-target');
    popup.querySelector('.tr-popup-source').textContent = text;
    result.textContent = '翻译中…';
    popup.classList.add('show');
    popup.querySelector('.tr-popup-close').focus({ preventScroll: true });

    try {
      const lang = detectLang(text);
      const targetLang = targetForLang(lang);
      const [translation] = await requestTranslations([{ text, targetLang }]);
      if (request === state.selectionRequest) result.textContent = translation || '未收到译文';
    } catch (err) {
      if (request === state.selectionRequest) result.textContent = '翻译失败：' + err.message;
    }
  }

  function getPopup() {
    let popup = document.getElementById('tr-popup');
    if (!popup) {
      popup = document.createElement('div');
      popup.id = 'tr-popup';
      popup.className = 'tr-popup';
      popup.setAttribute('role', 'dialog');
      popup.setAttribute('aria-label', '划词翻译');
      popup.innerHTML =
        '<div class="tr-popup-head">' +
        '  <span>划词翻译</span>' +
        '  <button type="button" class="tr-popup-close" aria-label="关闭">×</button>' +
        '</div>' +
        '<div class="tr-popup-body">' +
        '  <div class="tr-popup-source"></div>' +
        '  <div class="tr-popup-target" aria-live="polite"></div>' +
        '</div>';
      document.documentElement.appendChild(popup);
      const close = () => {
        state.selectionRequest++;
        popup.classList.remove('show');
      };
      popup.querySelector('.tr-popup-close').addEventListener('click', close);
      popup.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          close();
        }
      });
    }
    return popup;
  }

  // ============ 状态浮层 ============
  function showStatus(text, isError) {
    let status = document.getElementById('tr-status');
    if (!status) {
      status = document.createElement('div');
      status.id = 'tr-status';
      status.className = 'tr-status';
      status.setAttribute('role', 'status');
      document.documentElement.appendChild(status);
    }
    status.textContent = text;
    status.classList.toggle('error', !!isError);
    status.classList.add('show');
    clearTimeout(state.statusTimer);
    state.statusTimer = setTimeout(hideStatus, 4200);
  }

  function hideStatus() {
    clearTimeout(state.statusTimer);
    const status = document.getElementById('tr-status');
    if (status) status.classList.remove('show');
  }

})();
