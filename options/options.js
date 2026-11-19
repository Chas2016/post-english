// options.js — 插件设置
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const preferences = document.querySelectorAll('[data-preference]');
  const providerForms = document.querySelectorAll('[data-provider]');
  const providers = {
    deepseek: { prefix: 'ds', name: 'DeepSeek' },
    minimax: { prefix: 'mm', name: 'MiniMax' }
  };
  const defaultProvider = $('default-provider');
  const numberFormat = new Intl.NumberFormat('zh-CN');
  const moneyFormat = new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 12
  });
  const costSources = { reported: '回传', estimated: '估算' };
  const usageMetrics = document.querySelectorAll('[data-usage]');
  const usageCosts = document.querySelectorAll('[data-usage-cost]');
  const usageByProvider = document.querySelectorAll('[data-provider-usage]');
  const costsByProvider = document.querySelectorAll('[data-provider-cost]');
  const usageStatus = $('usage-status');
  const costStatus = $('usage-cost-status');
  const usageTable = $('usage-table');
  const usageTableBody = $('usage-days');
  const usageEmpty = $('usage-history-empty');
  const usagePagination = $('usage-pagination');
  const usagePrev = $('usage-prev');
  const usageNext = $('usage-next');
  const usagePage = $('usage-page');
  const cacheMetrics = document.querySelectorAll('[data-cache-stat]');
  const cacheStatus = $('cache-status');
  const bytesFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
  const daysPerPage = 7;
  let historyDays = [];
  let todayDate = '';
  let historyPage = 0;
  let usageRevision = 0;
  let cacheRevision = 0;
  let cacheRefreshTimer;
  let config;

  function setStatus(status, message, state = '') {
    status.dataset.state = state;
    status.textContent = message;
  }

  async function request(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || '插件未返回操作结果');
    return response;
  }

  function renderProviderOptions(saved) {
    for (const option of defaultProvider.options) {
      const model = saved.providers[option.value]?.model?.trim();
      const name = providers[option.value].name;
      option.textContent = model ? name + ' · ' + model : name;
      option.title = option.textContent;
    }
    defaultProvider.title = defaultProvider.selectedOptions[0]?.textContent || '';
  }

  function amountElements(amounts) {
    return Object.entries(amounts || {}).sort(([left], [right]) => left.localeCompare(right))
      .filter(([currency, amount]) => /^[A-Z]{3}$/.test(currency) && Number.isFinite(amount) && amount >= 0)
      .map(([currency, amount]) => {
        const element = document.createElement('span');
        element.className = 'usage-amount';
        const lessThanMinimum = amount > 0 && amount < 1e-12;
        const value = lessThanMinimum ? '<' + moneyFormat.format(1e-12) : moneyFormat.format(amount);
        element.textContent = currency + ' ' + value;
        return element;
      });
  }

  function unpricedRequests(usage) {
    return usage?.cost?.unpricedRequests ?? usage?.requestCount ?? 0;
  }

  function renderCostDetails(container, usage) {
    const entries = [];
    for (const [source, label] of Object.entries(costSources)) {
      const amounts = amountElements(usage?.cost?.[source]);
      if (!amounts.length) continue;
      const entry = document.createElement('span');
      entry.className = 'usage-cost-entry';
      const tag = document.createElement('span');
      tag.className = 'usage-cost-label';
      tag.textContent = label;
      entry.append(tag, ...amounts);
      entries.push(entry);
    }
    const missing = unpricedRequests(usage);
    if (missing > 0) {
      const tag = document.createElement('span');
      tag.className = 'usage-cost-label';
      tag.textContent = numberFormat.format(missing) + ' 次未计价';
      entries.push(tag);
    }
    container.replaceChildren(...entries);
    return entries.length > 0;
  }

  function renderCosts(usage) {
    for (const metric of usageCosts) {
      const amounts = amountElements(usage.cost?.[metric.dataset.usageCost]);
      if (amounts.length) metric.replaceChildren(...amounts);
      else metric.textContent = '—';
    }
    for (const metric of costsByProvider) {
      metric.hidden = !renderCostDetails(metric, usage.providers?.[metric.dataset.providerCost]);
    }
    const missing = unpricedRequests(usage);
    setStatus(costStatus, missing > 0
      ? numberFormat.format(missing) + ' 次请求未计价'
      : '');
  }

  function usageRow(day) {
    const row = document.createElement('tr');
    row.setAttribute('role', 'row');
    const date = document.createElement('time');
    date.dateTime = day.date;
    date.textContent = day.date;
    row.insertCell().append(date);
    if (day.date === todayDate) {
      const badge = document.createElement('span');
      badge.className = 'usage-today';
      badge.textContent = '今天';
      date.after(badge);
    }
    for (const key of ['totalTokens', 'inputTokens', 'outputTokens']) {
      row.insertCell().textContent = numberFormat.format(day[key]);
    }
    const fee = row.insertCell();
    fee.className = 'usage-day-cost';
    if (!renderCostDetails(fee, day)) fee.textContent = '—';
    for (const cell of row.cells) cell.setAttribute('role', 'cell');
    return row;
  }

  function renderUsageHistory() {
    const pageCount = Math.max(1, Math.ceil(historyDays.length / daysPerPage));
    historyPage = Math.min(historyPage, pageCount - 1);
    const start = historyPage * daysPerPage;
    usageTable.hidden = !historyDays.length;
    usageEmpty.hidden = Boolean(historyDays.length);
    usageTableBody.replaceChildren(...historyDays.slice(start, start + daysPerPage).map(usageRow));
    usagePagination.hidden = pageCount < 2;
    usagePrev.disabled = historyPage === 0;
    usageNext.disabled = historyPage === pageCount - 1;
    usagePage.textContent = (historyPage + 1) + ' / ' + pageCount;
  }

  function updateUsageHistory(usage) {
    todayDate = usage.today?.date || '';
    historyDays = Array.isArray(usage.days) ? usage.days : [];
    if (todayDate) {
      historyDays = [usage.today, ...historyDays.filter((day) => day.date !== todayDate)];
    }
    renderUsageHistory();
  }

  async function refreshUsage() {
    const revision = ++usageRevision;
    try {
      const { usage } = await request({ type: 'GET_TOKEN_USAGE' });
      if (revision !== usageRevision) return;
      if (!usage) throw new Error('插件未返回用量');
      for (const metric of usageMetrics) {
        metric.textContent = numberFormat.format(usage[metric.dataset.usage]);
      }
      for (const metric of usageByProvider) {
        const total = usage.providers[metric.dataset.providerUsage]?.totalTokens;
        metric.textContent = numberFormat.format(total ?? 0);
      }
      renderCosts(usage);
      updateUsageHistory(usage);
      const requests = usage.requestCount;
      const unreported = usage.unreportedRequests;
      const message = unreported > 0
        ? numberFormat.format(unreported) + ' 次请求未完整回传用量。'
        : (requests > 0 ? '' : '暂无用量记录。');
      setStatus(usageStatus, message);
    } catch {
      if (revision === usageRevision) {
        setStatus(usageStatus, '暂时无法读取用量，刷新此页后重试。', 'error');
      }
    }
  }

  async function refreshCacheStats() {
    const revision = ++cacheRevision;
    const status = $('cache-stats-status');
    try {
      const { stats } = await request({ type: 'GET_CACHE_STATS' });
      if (revision !== cacheRevision) return;
      for (const metric of cacheMetrics) {
        const key = metric.dataset.cacheStat;
        const value = stats[key];
        metric.textContent = numberFormat.format(value);
        if (key === 'bytes') {
          const [amount, unit] = value >= 1024 ** 2 ? [value / 1024 ** 2, 'MiB'] :
            value >= 1024 ? [value / 1024, 'KiB'] : [value, 'B'];
          metric.textContent = bytesFormat.format(amount) + ' ' + unit;
          metric.title = numberFormat.format(value) + ' 字节';
        }
      }
      setStatus(status, '');
    } catch {
      if (revision === cacheRevision) setStatus(status, '暂时无法读取缓存统计。', 'error');
    }
  }

  function renderPreference(input, value) {
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value;
    if (input === defaultProvider) {
      defaultProvider.title = defaultProvider.selectedOptions[0]?.textContent || '';
    }
  }

  function bindPreference(input) {
    const key = input.dataset.preference;
    const status = key === 'enableCache' || key === 'cacheRetentionDays' ? cacheStatus :
      $(key === 'activeProvider' ? 'service-status' : 'reading-status');
    let revision = 0;

    input.addEventListener('change', async () => {
      const saveRevision = ++revision;
      const readInput = () => input.type === 'checkbox' ? input.checked : input.value;
      const draft = readInput();
      let value = draft;
      if (key === 'cacheRetentionDays') value = Number(draft);
      if (key === 'targetLang') value = draft.trim() || '中文';
      setStatus(status, '正在保存…');
      try {
        const response = await request({ type: 'SAVE_CONFIG', config: { [key]: value } });
        config[key] = response.config?.[key] ?? value;
        if (revision !== saveRevision) return;
        if (readInput() === draft) renderPreference(input, config[key]);
        setStatus(status, '已保存。', 'success');
      } catch (error) {
        if (revision !== saveRevision) return;
        if (readInput() === draft) renderPreference(input, config[key]);
        setStatus(status, '保存失败：' + error.message, 'error');
      }
    });
  }

  function bindProvider(form) {
    const provider = form.dataset.provider;
    const { name, prefix } = providers[provider];
    const key = $(prefix + '-key');
    const base = $(prefix + '-base');
    const model = $(prefix + '-model');
    const modelChoice = $(prefix + '-model-choice');
    const manualModel = $(prefix + '-manual-model');
    const modelStatus = $(prefix + '-model-status');
    const fetchModels = $(prefix + '-fetch');
    const toggle = $(prefix + '-toggle');
    const badge = $(prefix + '-badge');
    const status = $(prefix + '-status');
    const fieldset = form.querySelector('fieldset');
    let savedModel = '';
    let selectedModel = '';
    let editingModel = false;
    let modelIds = [];
    let listRevision = 0;
    let fetchingModels = false;

    function modelGroup(label, ids) {
      const group = document.createElement('optgroup');
      group.label = label;
      group.append(...ids.map((id) => new Option(id, id)));
      return group;
    }

    function renderModelChoice() {
      const currentIds = [...new Set([selectedModel, savedModel])].filter(
        (id) => id && !modelIds.includes(id)
      );
      const groups = [];
      if (modelIds.length) groups.push(modelGroup('接口返回', modelIds));
      if (currentIds.length) groups.push(modelGroup('当前或已保存的模型', currentIds));
      groups.push(new Option('手动填写模型 ID', ''));
      modelChoice.replaceChildren(...groups);
      modelChoice.value = editingModel ? '' : selectedModel;
      manualModel.hidden = !editingModel;
    }

    function setFetchingModels(pending) {
      fetchingModels = pending;
      fetchModels.setAttribute('aria-disabled', String(pending));
      fetchModels.setAttribute('aria-busy', String(pending));
      fetchModels.textContent = pending ? '获取中…' : '获取列表';
    }

    function invalidateModelList() {
      if (!fetchingModels && !modelIds.length) return;
      listRevision++;
      modelIds = [];
      setFetchingModels(false);
      renderModelChoice();
      setStatus(modelStatus, '接口配置已更改，请重新获取。');
    }

    function readSettings() {
      return {
        apiKey: key.value.trim(),
        baseUrl: base.value.trim() || base.placeholder,
        model: editingModel ? model.value.trim() : selectedModel
      };
    }

    function renderSavedSettings(saved) {
      key.value = saved?.apiKey || '';
      base.value = saved?.baseUrl || base.placeholder;
      savedModel = saved?.model || '';
      selectedModel = savedModel;
      editingModel = !savedModel;
      model.value = '';
      renderModelChoice();
      const configured = Boolean(key.value.trim());
      badge.textContent = configured ? '已保存密钥' : '未配置';
      badge.classList.toggle('configured', configured);
    }

    async function runAction(pending, failed, action) {
      fieldset.disabled = true;
      setStatus(status, pending);
      try {
        const settings = readSettings();
        if (!settings.model) throw new Error('请选择模型或输入模型 ID');
        const info = await action(settings);
        setStatus(status, info, 'success');
      } catch (error) {
        setStatus(status, failed + '：' + error.message, 'error');
      } finally {
        fieldset.disabled = false;
      }
    }

    toggle.addEventListener('click', () => {
      const visible = key.type === 'password';
      key.type = visible ? 'text' : 'password';
      toggle.textContent = visible ? '隐藏' : '显示';
      toggle.setAttribute('aria-label', toggle.textContent + ' ' + name + ' API Key');
    });

    modelChoice.addEventListener('change', () => {
      editingModel = !modelChoice.value;
      if (!editingModel) selectedModel = modelChoice.value;
      manualModel.hidden = !editingModel;
      if (editingModel) {
        if (!model.value.trim()) model.value = selectedModel;
        model.focus();
        model.select();
      }
    });

    key.addEventListener('input', invalidateModelList);
    base.addEventListener('input', invalidateModelList);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (fieldset.disabled) return;
      runAction('正在保存配置…', '保存失败', async (settings) => {
        const response = await request({
          type: 'SAVE_CONFIG',
          config: { providers: { [provider]: settings } }
        });
        const saved = response.config?.providers?.[provider] || settings;
        config.providers[provider] = saved;
        renderProviderOptions(config);
        renderSavedSettings(saved);
        return '配置已保存。';
      });
    });

    $(prefix + '-test').addEventListener('click', () => {
      runAction('正在测试连接…', '连接失败', async (settings) => {
        if (!settings.apiKey) throw new Error('请输入 API Key');
        const response = await request({
          type: 'DO_TRANSLATE',
          texts: ['Hello, world!'],
          targets: ['中文'],
          config: {
            activeProvider: provider,
            providers: { [provider]: settings },
            enableCache: false
          }
        });
        const sample = response.translations?.[0]?.trim();
        if (!sample) throw new Error('服务未返回示例译文');
        return '连接成功。示例译文为“' + sample + '”。';
      });
    });

    fetchModels.addEventListener('click', async () => {
      if (fetchingModels) return;
      const settings = readSettings();
      if (!settings.apiKey) {
        setStatus(modelStatus, '填写 API Key 后即可获取列表。', 'error');
        key.focus();
        return;
      }
      const revision = ++listRevision;
      setFetchingModels(true);
      setStatus(modelStatus, '正在查询接口提供的模型…');
      try {
        const response = await request({
          type: 'FETCH_MODELS',
          provider,
          config: { providers: { [provider]: settings } }
        });
        if (revision !== listRevision) return;
        if (response.source !== 'api' || !Array.isArray(response.models)) {
          throw new Error('接口未返回可识别的模型列表');
        }
        modelIds = [...new Set(response.models.filter((id) => typeof id === 'string' && id.trim()))];
        renderModelChoice();
        if (modelIds.length) {
          setStatus(modelStatus, '接口返回 ' + modelIds.length + ' 个模型。', 'success');
        } else {
          setStatus(modelStatus, '接口未返回模型，可手动填写模型 ID。');
        }
      } catch (error) {
        if (revision !== listRevision) return;
        modelIds = [];
        renderModelChoice();
        setStatus(modelStatus, '获取失败：' + error.message + '。可手动填写模型 ID。', 'error');
      } finally {
        if (revision === listRevision) setFetchingModels(false);
      }
    });

    renderSavedSettings(config.providers[provider]);
    fieldset.disabled = false;
  }

  const clearCache = $('clear-cache');
  clearCache.addEventListener('click', async () => {
    clearCache.disabled = true;
    setStatus(cacheStatus, '正在清空缓存…');
    try {
      const response = await request({ type: 'CLEAR_CACHE' });
      setStatus(cacheStatus, '已清空 ' + response.count + ' 条缓存。', 'success');
      await refreshCacheStats();
    } catch (error) {
      setStatus(cacheStatus, '清空缓存失败：' + error.message, 'error');
    } finally {
      clearCache.disabled = false;
    }
  });

  async function init() {
    try {
      config = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
      if (!config?.providers) throw new Error('插件未返回设置');
      renderProviderOptions(config);
      for (const form of providerForms) bindProvider(form);
      for (const input of preferences) {
        renderPreference(input, config[input.dataset.preference]);
        bindPreference(input);
        input.disabled = false;
      }
      clearCache.disabled = false;
      setStatus($('reading-status'), '');
    } catch (error) {
      setStatus($('reading-status'), '载入设置失败：' + error.message + '。请重新打开此页面。', 'error');
    }
  }

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.tokenUsage || changes.tokenUsageByDay) refreshUsage();
    if (changes.localCacheHits || changes.xLearnCache || Object.keys(changes).some(key => key.startsWith('tr:'))) {
      clearTimeout(cacheRefreshTimer);
      cacheRefreshTimer = setTimeout(refreshCacheStats, 120);
    }
  });
  usagePrev.addEventListener('click', () => {
    historyPage--;
    renderUsageHistory();
  });
  usageNext.addEventListener('click', () => {
    historyPage++;
    renderUsageHistory();
  });
  window.addEventListener('focus', refreshUsage);
  window.addEventListener('focus', refreshCacheStats);
  refreshUsage();
  refreshCacheStats();
  init();
})();
