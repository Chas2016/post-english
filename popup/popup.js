(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const pageSite = $('page-site');
  const pageStatus = $('page-status');
  const pageAction = $('page-action');
  const pageHelp = $('page-help');
  const modeHelp = $('mode-help');
  const actionError = $('action-error');
  const modeGroup = $('mode-group');
  const modes = [...modeGroup.querySelectorAll('input')];
  const providerSelect = $('provider-select');
  const tokenUsage = $('token-usage');
  const expressionsButton = $('btn-x-expressions');
  const xHosts = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
  const numberFormat = new Intl.NumberFormat('zh-CN');
  const providers = { deepseek: 'DeepSeek', minimax: 'MiniMax' };
  const modeDescriptions = {
    study: '遇到读不懂的英文，再查看译文。',
    bilingual: '在原文下方显示译文。',
    translation: '译文可用后隐藏原文。',
    original: '保留网页原文。'
  };

  let config = null;
  let tab = null;
  let pageState = null;
  let busy = false;
  let usageRevision = 0;

  function siteName() {
    try {
      const url = new URL(tab?.url);
      return ['http:', 'https:'].includes(url.protocol) ? url.hostname : '';
    } catch {
      return '';
    }
  }

  function setError(message) {
    actionError.hidden = !message;
    actionError.textContent = message;
  }

  function hasKey(provider = config?.activeProvider) {
    return Boolean(config?.providers[provider]?.apiKey?.trim());
  }

  function renderProvider() {
    for (const option of providerSelect.options) {
      const model = config?.providers[option.value]?.model?.trim();
      option.textContent = model ? providers[option.value] + ' · ' + model : providers[option.value];
      option.title = option.textContent;
    }
    providerSelect.disabled = !config;
    providerSelect.value = config?.activeProvider || 'deepseek';
    providerSelect.title = providerSelect.selectedOptions[0]?.textContent || '';
  }

  async function refreshUsage() {
    const revision = ++usageRevision;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_TOKEN_USAGE', todayOnly: true });
      if (revision !== usageRevision || !response?.ok || !response.usage) return;
      const usage = response.usage;
      tokenUsage.textContent = usage.today
        ? '今日 Token · ' + numberFormat.format(usage.today.totalTokens)
        : 'Token 用量 · ' + numberFormat.format(usage.totalTokens);
    } catch {
      // 用量详情仍可从设置页打开。
    }
  }

  function pageControls(site) {
    if (!config) {
      return ['设置未读取', '重试', '暂时无法读取扩展设置。', 'warning'];
    }
    if (!pageState) {
      const help = site ? '请尝试刷新，或换一个网页。' : '请打开一个普通网页。';
      return ['页面不可用', '此页无法翻译', help, 'warning', true];
    }

    const provider = config.activeProvider;
    if (pageState.enabled) {
      const label = { study: '阅读辅助已开启', original: '仅显示原文' }[pageState.mode] || '翻译已开启';
      const help = !hasKey() && pageState.mode !== 'original'
        ? providers[provider] + ' 需要配置 API Key。'
        : '';
      return [label, '停止并恢复原文', help, help ? 'warning' : 'active'];
    }
    if (pageState.mode === 'original') {
      return ['仅显示原文', '此模式保留原文', '选择带译文的模式即可开始翻译。', '', true];
    }
    if (!hasKey()) {
      const otherConfigured = Object.keys(providers).find((name) => name !== provider && hasKey(name));
      const help = providers[provider] + ' 需要配置 API Key。' +
        (otherConfigured ? '也可切换至 ' + providers[otherConfigured] + '。' : '');
      return ['缺少 API Key', '前往设置', help, 'warning'];
    }

    return ['尚未开启', pageState.mode === 'study' ? '开启阅读辅助' : '开启本页翻译', '', ''];
  }

  function render() {
    const site = siteName();
    pageSite.textContent = site || '当前页面';
    pageSite.title = site;
    expressionsButton.hidden = !xHosts.has(site);

    const [status, action, help, tone, disabled] = pageControls(site);
    pageStatus.textContent = status;
    pageStatus.dataset.tone = tone;
    pageAction.textContent = action;
    pageAction.setAttribute('aria-disabled', String(busy || Boolean(disabled)));
    pageHelp.hidden = !help;
    pageHelp.textContent = help;

    const mode = pageState?.mode || config?.displayMode || 'study';
    modeGroup.disabled = !config;
    modes.forEach((input) => { input.checked = input.value === mode; });
    modeHelp.textContent = modeDescriptions[mode] || modeDescriptions.study;
    renderProvider();
  }

  async function messagePage(message) {
    if (!Number.isInteger(tab?.id)) throw new Error('当前标签页不可用');
    const response = await chrome.tabs.sendMessage(tab.id, message);
    if (typeof response?.enabled !== 'boolean' || !modes.some((mode) => mode.value === response.mode)) {
      throw new Error('页面未返回阅读状态');
    }
    return response;
  }

  async function readPage() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
    return messagePage({ type: 'GET_PAGE_STATE' });
  }

  async function load() {
    busy = true;
    setError('');
    pageStatus.textContent = '正在检查';
    pageAction.textContent = '正在检查…';
    pageAction.setAttribute('aria-disabled', 'true');
    const [settings, page] = await Promise.allSettled([
      chrome.runtime.sendMessage({ type: 'GET_CONFIG' }),
      readPage()
    ]);
    config = settings.status === 'fulfilled' && settings.value?.providers ? settings.value : null;
    pageState = page.status === 'fulfilled' ? page.value : null;
    busy = false;
    render();
  }

  async function save(partial) {
    const result = await chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config: partial });
    if (!result?.ok || !result.config) throw new Error('设置保存失败，请重试。');
    config = result.config;
  }

  async function openOptions() {
    try {
      await chrome.runtime.openOptionsPage();
    } catch {
      setError('设置页打开失败，请重试。');
    }
  }

  async function runAction(action, failureMessage) {
    if (busy) {
      render();
      return;
    }
    busy = true;
    setError('');
    pageAction.setAttribute('aria-disabled', 'true');
    try {
      await action();
    } catch {
      setError(failureMessage);
    } finally {
      busy = false;
      render();
    }
  }

  pageAction.addEventListener('click', () => {
    if (pageAction.getAttribute('aria-disabled') === 'true') return;
    if (!config) {
      load();
      return;
    }
    if (!pageState.enabled && !hasKey()) {
      openOptions();
      return;
    }
    const type = pageState.enabled ? 'RESTORE_PAGE' : 'TRANSLATE_PAGE';
    runAction(async () => {
      pageState = await messagePage({ type });
    }, '操作未完成，请刷新网页后重试。');
  });

  modeGroup.addEventListener('change', (event) => {
    const mode = event.target.value;
    runAction(async () => {
      await save({ displayMode: mode });
      if (!pageState) return;
      try {
        pageState = await messagePage({ type: 'SET_DISPLAY_MODE', mode });
      } catch {
        pageState = null;
        setError('阅读模式已保存，请刷新网页后查看。');
      }
    }, '阅读模式保存失败，请重试。');
  });

  providerSelect.addEventListener('change', () => {
    const activeProvider = providerSelect.value;
    runAction(() => save({ activeProvider }), '翻译引擎保存失败，请重试。');
  });

  $('btn-options').addEventListener('click', openOptions);
  tokenUsage.addEventListener('click', async () => {
    setError('');
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#token-usage') });
    } catch {
      setError('Token 用量打开失败，请重试。');
    }
  });
  const composeButton = $('btn-compose');
  expressionsButton.addEventListener('click', async () => {
    if (!Number.isInteger(tab?.id) || expressionsButton.disabled) return;
    setError('');
    expressionsButton.disabled = true;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_X_LEARNING_LIBRARY' });
      if (response?.ok) {
        window.close();
      } else {
        setError(response?.error || '请刷新 X 页面再打开我的表达。');
      }
    } catch {
      setError('请刷新 X 页面再打开我的表达。');
    } finally {
      expressionsButton.disabled = false;
    }
  });

  composeButton.addEventListener('click', async () => {
    if (composeButton.getAttribute('aria-disabled') === 'true') return;
    setError('');
    composeButton.setAttribute('aria-disabled', 'true');
    try {
      if (pageState && Number.isInteger(tab?.id)) {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_X_COMPOSER' }).catch(() => null);
        if (response?.ok) {
          window.close();
          return;
        }
      }
      await chrome.tabs.create({ url: chrome.runtime.getURL('compose/compose.html') });
    } catch {
      setError('帖文编辑器打开失败，请重试。');
    } finally {
      composeButton.removeAttribute('aria-disabled');
    }
  });

  chrome.commands.getAll().then((commands) => {
    const shortcut = commands.find((command) => command.name === 'toggle-translate')?.shortcut;
    if (!shortcut) return;
    $('shortcut-key').textContent = shortcut;
    $('shortcut').hidden = false;
  }).catch(() => {});

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && (changes.tokenUsage || changes.tokenUsageByDay)) refreshUsage();
    if (area === 'sync' && (changes.providers || changes.activeProvider)) {
      chrome.runtime.sendMessage({ type: 'GET_CONFIG' }).then((saved) => {
        if (!saved?.providers) return;
        config = saved;
        render();
      }).catch(() => {});
    }
  });

  load();
  refreshUsage();
})();
