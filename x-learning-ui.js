(() => {
  'use strict';

  const UI_ATTRIBUTE = 'data-x-learning-ui';
  const STATUS_PATH = /^\/(?:[^/]+\/status|i\/web\/status)\/\d+\/?$/;
  const SOURCE_LABELS = { current: '当前帖', parent: '上文', root: '话题主帖', quote: '引用帖' };

  function create(options) {
    const entries = new WeakMap();
    let activeCard;
    let activeShelf;
    let selection;

    function element(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    }

    function root(node) {
      node.setAttribute(UI_ATTRIBUTE, '');
      return node;
    }

    function button(text, action, className = 'xl-button') {
      const node = element('button', className, text);
      node.type = 'button';
      node.addEventListener('click', event => {
        event.stopPropagation();
        if (node.getAttribute('aria-disabled') === 'true') return;
        action(node);
      });
      return node;
    }

    function link(text, href) {
      const node = element('a', 'xl-link', text);
      node.href = href;
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
      node.addEventListener('click', event => event.stopPropagation());
      return node;
    }

    function verifiedXUrl(value) {
      try {
        const url = new URL(value);
        if (url.protocol === 'https:' && ['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(url.hostname) &&
            !url.port && !url.username && !url.password && STATUS_PATH.test(url.pathname)) {
          return 'https://x.com' + url.pathname;
        }
      } catch {
        // 有效链接缺失时，仅显示内容。
      }
      return '';
    }

    function isDark(target) {
      const color = getComputedStyle(document.body).backgroundColor;
      const values = color?.match(/[\d.]+/g)?.map(Number);
      if (values?.length >= 3 && values[3] !== 0) {
        const [red, green, blue] = values;
        return red * .299 + green * .587 + blue * .114 < 125;
      }
      const foreground = getComputedStyle(target || document.body).color;
      const [red, green, blue] = foreground?.match(/[\d.]+/g)?.map(Number) || [];
      if (Number.isFinite(blue)) return red * .299 + green * .587 + blue * .114 > 150;
      return matchMedia('(prefers-color-scheme: dark)').matches;
    }

    function focus(node) {
      if (node?.isConnected) node.focus({ preventScroll: true });
    }

    function status(text) {
      const node = element('p', 'xl-status', text);
      node.setAttribute('role', 'status');
      return node;
    }

    function showError(node, error, fallback) {
      node.classList.add('xl-error');
      node.textContent = error?.message || fallback;
      if (options.onOpenSettings && ['MISSING_API_KEY', 'NO_API_KEY'].includes(error?.code)) {
        const settings = button('打开扩展设置', options.onOpenSettings);
        node.append(' ', settings);
      }
    }

    function dismissOnEscape(node, onDismiss) {
      node.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      });
    }

    function panel(tag, className, title, onDismiss) {
      const container = root(element(tag, className));
      container.addEventListener('click', event => event.stopPropagation());
      dismissOnEscape(container, onDismiss);
      const header = element('div', 'xl-head');
      const heading = element('h2', 'xl-title', title);
      heading.tabIndex = -1;
      const closeButton = button('×', onDismiss, 'xl-close');
      closeButton.setAttribute('aria-label', '关闭' + title);
      header.append(heading, closeButton);
      container.append(header);
      return { container, heading };
    }

    function closeCard({ restoreFocus = true } = {}) {
      if (!activeCard) return;
      const { container, anchor } = activeCard;
      activeCard = undefined;
      container.remove();
      anchor?.setAttribute('aria-expanded', 'false');
      if (restoreFocus) focus(anchor);
    }

    function closeShelf({ restoreFocus = true } = {}) {
      if (!activeShelf) return;
      const { container, anchor } = activeShelf;
      activeShelf = undefined;
      container.remove();
      anchor?.setAttribute('aria-expanded', 'false');
      if (restoreFocus) focus(anchor);
    }

    function clearSelection() {
      selection?.container.remove();
      selection = undefined;
    }

    function attach(target, { getContext }) {
      const existing = entries.get(target);
      if (existing?.anchor.isConnected) return existing.anchor;
      if (!target?.parentElement) return null;

      const container = root(element('div', 'xl-entry'));
      const anchor = button('帮我读懂', () => {
        if (activeCard?.anchor === anchor && activeCard.container.isConnected) {
          closeCard();
          return;
        }
        openCard(target, anchor, container, '', getContext);
      }, 'xl-launch');
      anchor.setAttribute('aria-expanded', 'false');
      container.append(anchor);
      target.after(container);
      entries.set(target, { container, anchor });
      return anchor;
    }

    function openSelection({ text, rect, target, getContext }) {
      if (!text || !rect || !target?.isConnected) return false;
      if (selection?.target === target && selection.text === text &&
          selection.rect.top === rect.top && selection.rect.left === rect.left) return true;
      clearSelection();

      const anchor = entries.get(target)?.anchor || attach(target, { getContext });
      const entry = entries.get(target)?.container;
      if (!anchor || !entry) return false;

      const container = root(element('div', 'xl-selection'));
      container.dataset.theme = isDark(target) ? 'dark' : 'light';
      const trigger = button('学这句', () => {
        clearSelection();
        openCard(target, anchor, entry, text, getContext);
      });
      trigger.setAttribute('aria-label', '学习选中的英文');
      trigger.addEventListener('mousedown', event => event.preventDefault());
      dismissOnEscape(container, () => {
        clearSelection();
        focus(anchor);
      });
      container.append(trigger);
      document.body.append(container);
      const width = container.offsetWidth;
      const height = container.offsetHeight;
      const left = Math.min(innerWidth - width - 8, rect.left);
      const top = rect.top >= height + 10 ? rect.top - height - 6 : rect.bottom + 6;
      container.style.left = Math.max(8, left) + 'px';
      container.style.top = Math.max(8, Math.min(innerHeight - height - 8, top)) + 'px';
      selection = { container, target, text, rect };
      return true;
    }

    function openCard(target, anchor, entry, text, getContext) {
      closeCard({ restoreFocus: false });
      clearSelection();
      const title = text ? '学这句' : '帮我读懂';
      const { container, heading } = panel('section', 'xl-card', title, closeCard);
      container.setAttribute('aria-label', title);
      container.dataset.theme = isDark(target) ? 'dark' : 'light';
      entry.after(container);
      anchor.setAttribute('aria-expanded', 'true');
      const card = { container, anchor };
      activeCard = card;
      focus(heading);
      analyzeCard(card, getContext, text);
    }

    async function analyzeCard(card, getContext, text) {
      const { container } = card;
      const body = element('div', 'xl-card-body');
      const loading = status(text ? '正在解读选中的英文…' : '正在解读这条帖…');
      body.append(loading);
      container.append(body);

      try {
        const context = getContext();
        if (!context?.current?.text) throw new Error('这条帖暂时不可用，请打开原帖后重试。');
        const result = await options.onAnalyze({ text, context });
        if (activeCard !== card || !container.isConnected) return;
        body.replaceChildren();
        renderAnalysis(body, result, context);
      } catch (error) {
        if (activeCard !== card || !container.isConnected) return;
        const errorLine = status();
        showError(errorLine, error, '暂时无法解读，请稍后重试。');
        const retry = button('重试', () => {
          body.remove();
          analyzeCard(card, getContext, text);
        });
        body.replaceChildren(errorLine, retry);
        focus(retry);
      }
    }

    function renderAnalysis(body, result, context) {
      if (result.zh) {
        const gist = element('p', 'xl-meaning', result.zh);
        gist.lang = 'zh-CN';
        body.append(gist);
      }

      const english = element('p', result.zh ? 'xl-point' : 'xl-meaning');
      const paraphrase = element('span', '', result.simpleEnglish);
      paraphrase.lang = 'en';
      english.append(element('span', 'xl-source-label', '简单英文'), ' ', paraphrase);
      body.append(english);
      renderActions(body, result, context);

      const details = element('details', 'xl-analysis-details');
      details.append(element('summary', '', '阅读要点与原文依据'));

      const points = element('ul', 'xl-analysis-points');
      points.lang = 'en';
      for (const point of result.points) {
        points.append(element('li', '', point));
      }
      details.append(points);

      const tone = result.tone;
      if (tone?.note) {
        const toneLine = element('p', 'xl-muted');
        toneLine.append(tone.uncertain ? '可能的语气 ' : '语气线索 ');
        const toneText = element('span', '', [tone.label, tone.note].filter(Boolean).join(' · '));
        toneText.lang = 'en';
        toneLine.append(toneText);
        details.append(toneLine);
      }

      const quotes = [...(tone?.evidence || []), ...(result.evidence || [])];
      const first = quotes[0];
      if (first) {
        details.append(evidenceQuote(first, context));
        const related = quotes.find(quote => quote.sourceId !== first.sourceId);
        if (related) details.append(evidenceQuote(related, context));
      }
      body.append(details);
    }

    function evidenceQuote(evidence, context) {
      const section = element('div', 'xl-evidence-section');
      const evidenceStatus = status();
      const evidenceText = element('q', 'xl-quote', evidence.quote);
      evidenceText.lang = 'en';
      const evidenceRow = element('div', 'xl-evidence');
      const relation = evidence.sourceId === 'current' ? 'current' :
        context.sources?.find(source => source.id === evidence.sourceId)?.relation;
      const label = SOURCE_LABELS[relation];
      if (label) evidenceRow.append(element('span', 'xl-source-label', label));
      evidenceRow.append(evidenceText);
      if (options.onEvidence) {
        evidenceRow.append(button('定位原文', async () => {
          try {
            const located = await options.onEvidence({ context, evidence });
            evidenceStatus.textContent = located === false ? '原文已不在当前页面。' : '';
          } catch {
            evidenceStatus.textContent = '暂时无法定位原文。';
          }
        }, 'xl-button xl-button--text'));
      }
      section.append(evidenceRow, evidenceStatus);
      return section;
    }

    function renderActions(body, result, context) {
      const expression = result.expressions?.[0];
      const actions = element('div', 'xl-actions');
      if (expression?.text) {
        const phrase = element('strong', 'xl-phrase', expression.text);
        phrase.lang = 'en';
        const expressionRow = element('div', 'xl-expression');
        expressionRow.append(phrase);
        if (expression.meaningZh || expression.meaning) {
          const definition = element('span', 'xl-muted', expression.meaningZh || expression.meaning);
          definition.lang = expression.meaningZh ? 'zh-CN' : 'en';
          expressionRow.append(definition);
        }
        body.append(expressionRow);
        const saveStatus = status();
        const save = button('收藏表达', async node => {
          node.setAttribute('aria-disabled', 'true');
          saveStatus.classList.remove('xl-error');
          saveStatus.textContent = '';
          try {
            const saved = await options.onSave({ expression, result, context });
            node.textContent = '已收藏';
            saveStatus.textContent = saved?.duplicate ? '此义项已在我的表达中。' : '已添加到我的表达。';
          } catch (error) {
            showError(saveStatus, error, '暂时无法收藏。');
            node.removeAttribute('aria-disabled');
          }
        }, 'xl-button xl-button--primary');
        if (options.onSave) actions.append(save);
        body.append(saveStatus);
      }

      const translation = expandable('整帖翻译', () => options.onTranslate({ context }));
      if (options.onTranslate) actions.append(translation.toggle);
      if (options.onReview && options.onList && context?.current?.id) {
        actions.append(button('用此帖复习', anchor => openSaved({ anchor, context })));
      }

      body.append(actions);
      if (options.onTranslate) body.append(translation.body);
    }

    function expandable(label, read) {
      let loaded = false;
      let pending = false;
      const body = element('p', 'xl-disclosure');
      body.hidden = true;
      body.setAttribute('role', 'status');
      const toggle = button(label, async node => {
        body.hidden = !body.hidden;
        node.setAttribute('aria-expanded', String(!body.hidden));
        if (body.hidden || loaded || pending) return;
        pending = true;
        body.classList.remove('xl-error');
        body.textContent = '正在加载…';
        try {
          const value = await read();
          if (!value) throw new Error('暂时没有结果，请稍后重试。');
          body.textContent = value;
          loaded = true;
        } catch (error) {
          showError(body, error, '加载失败，收起后可重试。');
        } finally {
          pending = false;
        }
      });
      toggle.setAttribute('aria-expanded', 'false');
      return { body, toggle };
    }

    async function openSaved({ anchor, context } = {}) {
      if (activeShelf && activeShelf.anchor === anchor && activeShelf.container.isConnected) {
        closeShelf();
        return;
      }
      closeShelf({ restoreFocus: false });
      const { container, heading } = panel('section', 'xl-shelf', '我的表达', closeShelf);
      container.setAttribute('role', 'dialog');
      container.setAttribute('aria-label', '我的表达');
      container.dataset.theme = isDark(anchor) ? 'dark' : 'light';
      const body = element('div', 'xl-shelf-body');
      container.append(body);
      document.body.append(container);
      anchor?.setAttribute('aria-expanded', 'true');
      const shelf = { container, anchor, body, context };
      activeShelf = shelf;
      focus(heading);
      await loadShelf(shelf);
    }

    async function loadShelf(shelf, focusIndex) {
      const { body, container, context } = shelf;
      body.replaceChildren(status('正在读取收藏…'));
      try {
        const items = await options.onList();
        if (activeShelf !== shelf || !container.isConnected) return;
        body.replaceChildren();
        if (!items.length) {
          body.append(status('还没有收藏。用「帮我读懂」或划词「学这句」收藏想记住的表达。'));
          if (focusIndex !== undefined) focus(container.querySelector('h2'));
          return;
        }

        const hint = context?.current?.id ? '用当前 X 帖测试收藏过的表达。' : '在另一条 X 帖的详情页打开这里，可以用该帖复习。';
        body.append(element('p', 'xl-shelf-hint', hint));
        const list = element('ul', 'xl-list');
        items.forEach((item, index) => list.append(savedItem(shelf, item, index)));
        body.append(list);
        if (focusIndex !== undefined) {
          const nextItem = list.children[Math.min(focusIndex, list.children.length - 1)];
          focus(nextItem?.querySelector('summary') || container.querySelector('h2'));
        }
      } catch (error) {
        if (activeShelf !== shelf || !container.isConnected) return;
        const message = status();
        showError(message, error, '暂时无法读取收藏。');
        body.replaceChildren(message, button('重试', () => loadShelf(shelf)));
      }
    }

    function savedItem(shelf, item, index) {
      const row = element('li', 'xl-saved-item');
      const expression = item.expression;
      const details = element('details', 'xl-saved-details');
      const heading = element('summary', 'xl-saved-heading', expression.text);
      heading.lang = 'en';
      details.append(heading);
      if (expression.meaning) details.append(element('p', 'xl-point', expression.meaning));
      if (expression.meaningZh) details.append(element('p', 'xl-point', expression.meaningZh));
      if (expression.quote) {
        const quote = element('q', 'xl-quote', expression.quote);
        quote.lang = 'en';
        details.append(quote);
      }
      const original = verifiedXUrl(item.post?.url);
      const searching = new URL('https://x.com/search');
      searching.searchParams.set('q', '"' + expression.text.replaceAll('"', '') + '" lang:en');
      searching.searchParams.set('src', 'typed_query');
      const actions = element('div', 'xl-actions');
      const reviewPost = shelf.context?.current;
      if (options.onReview && reviewPost?.id && reviewPost.id !== item.post?.id) {
        const reviewButton = button('用当前帖复习', () => openReview(shelf, item, index), 'xl-button xl-button--primary');
        actions.append(reviewButton);
      }
      if (original) actions.append(link('收藏出处', original));
      actions.append(link('在 X 找例句', searching.href));
      const removeStatus = status();
      const remove = button('删除', async node => {
        node.setAttribute('aria-disabled', 'true');
        try {
          await options.onDelete(item.id);
          if (activeShelf === shelf && shelf.container.isConnected) await loadShelf(shelf, index);
        } catch (error) {
          showError(removeStatus, error, '删除失败，请重试。');
          node.removeAttribute('aria-disabled');
        }
      }, 'xl-button xl-button--text');
      remove.setAttribute('aria-label', '删除表达 ' + expression.text);
      if (options.onDelete) actions.append(remove);
      row.append(details);
      const progress = item.review;
      if (progress?.attempts > 0) {
        row.append(element('p', 'xl-progress', '复习 ' + progress.attempts + ' 次 · 答对 ' + progress.correct + ' 次'));
      }
      row.append(actions, removeStatus);
      return row;
    }

    async function openReview(shelf, item, index) {
      const { body, container, context } = shelf;
      const view = element('div', 'xl-review');
      const back = button('返回收藏', () => loadShelf(shelf, index), 'xl-button xl-button--text');
      const loading = status('正在根据当前 X 帖准备题目…');
      body.replaceChildren(view);
      view.append(back, loading);
      focus(back);

      try {
        const result = await options.onReview({ item, context });
        if (activeShelf !== shelf || !container.isConnected || !view.isConnected) return;
        loading.remove();
        renderReview(view, shelf, item, result);
      } catch (error) {
        if (activeShelf !== shelf || !container.isConnected || !view.isConnected) return;
        showError(loading, error, '这条帖暂时不能用来复习，请换另一条。');
      }
    }

    function renderReview(view, shelf, item, result) {
      const prompt = element('h3', 'xl-review-prompt', result.prompt);
      const quote = element('q', 'xl-quote', result.quote);
      quote.lang = 'en';
      const source = verifiedXUrl(shelf.context?.current?.url);
      const answers = element('div', 'xl-answers');
      answers.setAttribute('role', 'group');
      answers.setAttribute('aria-label', '复习题选项');
      const feedback = status();
      feedback.tabIndex = -1;
      const attemptId = crypto.randomUUID();
      let answered = false;

      result.options.forEach((value, index) => {
        const answer = button(value, async node => {
          if (answered) return;
          answered = true;
          const correct = index === result.answerIndex;
          Array.from(answers.children).forEach((choice, position) => {
            choice.disabled = true;
            if (position === result.answerIndex) choice.dataset.answer = 'correct';
            else if (choice === node) choice.dataset.answer = 'incorrect';
          });
          const text = correct ? '答对了。' : '本题未答对。';
          feedback.textContent = text + ' ' + result.explanation;
          focus(feedback);
          if (!options.onProgress) return;
          await saveProgress(view, shelf, { item, correct, attemptId });
        }, 'xl-button xl-answer');
        answers.append(answer);
      });

      view.append(prompt, quote);
      if (source) view.append(link('本题出处', source));
      view.append(answers, feedback);
    }

    async function saveProgress(view, shelf, attempt) {
      const message = status('正在保存练习结果…');
      view.append(message);
      try {
        await options.onProgress(attempt);
        message.textContent = '已记录练习结果。';
      } catch (error) {
        if (activeShelf !== shelf || !view.isConnected) return;
        showError(message, error, '练习结果保存失败。');
        const retry = button('重试保存', () => {
          message.remove();
          saveProgress(view, shelf, attempt);
        });
        message.append(' ', retry);
      }
    }

    function close({ restoreFocus = true } = {}) {
      clearSelection();
      closeShelf({ restoreFocus: restoreFocus && !activeCard });
      closeCard({ restoreFocus });
    }

    return { attach, openSelection, clearSelection, openSaved, closeCard, closeShelf, close };
  }

  globalThis.XLearningUI = { create };
})();
