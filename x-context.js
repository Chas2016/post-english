(() => {
  'use strict';

  const articleSelector = 'article[data-testid="tweet"]';
  const textSelector = '[data-testid="tweetText"]';
  const quotedTextSelector = 'div[lang][dir]';
  const quoteSelector = '[data-testid="quoteTweet"], [data-testid="quoteTweetContainer"], [data-testid="quote"], [role="blockquote"]';
  const cardSelector = `${quoteSelector}, [role="link"], a[href]`;
  const hiddenSelector = '[hidden], [aria-hidden="true"]';
  const excludedSelector = [
    '[data-x-learning-ui]', '.tr-target-block', '.tr-popup', '.tr-status',
    '[data-testid="tweetTranslation"]', '[data-testid="translation"]',
    '[data-testid="tweetTextTranslation"]', '[data-testid="tweet-text-show-more-link"]',
    hiddenSelector
  ].join(', ');
  const replyMarkerSelector = [
    '[data-testid="replyingTo"]', '[data-testid="replyingToContext"]',
    '[data-testid="replyingToStatusLink"]', 'a[rel~="in-reply-to"]'
  ].join(', ');
  const parentAttributes = ['data-in-reply-to-status-id', 'data-in-reply-to-tweet-id'];
  const statusIdPattern = /^[1-9]\d{0,19}$/;

  function asElement(node) {
    return node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  }

  function permalink(href) {
    if (!href) return null;
    let url;
    try {
      url = new URL(href, 'https://x.com');
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || !/^(?:www\.)?(?:x|twitter)\.com$/.test(url.host)) return null;
    const match = url.pathname.match(/^\/(?:[\w]{1,15}|i\/web)\/status\/([1-9]\d{0,19})\/?$/);
    if (!match) return null;
    const id = match[1];
    return { id, url: `https://x.com${url.pathname.replace(/\/$/, '')}` };
  }

  function isQuoteCard(element) {
    return element.matches(quoteSelector) ||
      (element.matches(cardSelector) && Boolean(element.querySelector(`${textSelector}, ${quotedTextSelector}`)));
  }

  function owns(scope, node) {
    if (scope === node) return true;
    if (!scope.contains(node)) return false;
    for (let ancestor = node.parentElement; ancestor && ancestor !== scope; ancestor = ancestor.parentElement) {
      if (ancestor.matches(articleSelector) || isQuoteCard(ancestor)) return false;
    }
    return true;
  }

  function ownMatches(scope, selector) {
    return Array.from(scope.querySelectorAll(selector)).filter((node) => owns(scope, node));
  }

  function isVisible(element) {
    return element.isConnected && !element.closest(excludedSelector) &&
      (typeof element.checkVisibility !== 'function' || element.checkVisibility({ visibilityProperty: true }));
  }

  function readText(element) {
    // 仅从原帖正文取文本。扩展按钮、原生译文和展开控件不参与释义或快照比较。
    function read(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.data;
      if (node.nodeType !== Node.ELEMENT_NODE || node.matches(excludedSelector)) return '';
      if (node.tagName === 'BR') return '\n';
      if (node.tagName === 'IMG') return node.getAttribute('alt') || '';
      return Array.from(node.childNodes, read).join('');
    }
    return normalizeText(read(element));
  }

  function normalizeText(value) {
    return value.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').trim();
  }

  function languageFor(element, text) {
    const language = element.getAttribute('lang')?.split('-')[0].toLowerCase();
    if (language && language !== 'und') return language;
    const letters = text.replace(/https?:\/\/\S+|[@#]\S+/g, '').match(/\p{L}/gu) || [];
    if (letters.length && letters.filter((letter) => /[a-z]/i.test(letter)).length / letters.length >= 0.8) return 'en';
    return 'und';
  }

  function ownPermalinks(scope) {
    const stamps = ownMatches(scope, 'time');
    const links = [scope, ...stamps.map((stamp) => stamp.closest('a[href]')), ...ownMatches(scope,
      '[data-testid="User-Name"] a[href], a[data-testid="tweetTimestamp"][href]')];
    const matches = new Map();
    for (const link of links) {
      if (!link || !scope.contains(link) || !isVisible(link) || !owns(scope, link) || link.closest(textSelector)) continue;
      const status = permalink(link.getAttribute('href'));
      if (status && !matches.has(status.id)) matches.set(status.id, status);
    }
    return matches;
  }

  function readPost(scope, relation, ownerArticle, fallbackStatus = null) {
    const elements = ownMatches(scope, textSelector).filter(isVisible);
    if (relation === 'quote' && !elements.length) {
      elements.push(...ownMatches(scope, quotedTextSelector).filter(isVisible));
    }
    if (elements.length !== 1) return null;
    const element = elements[0];
    const links = ownPermalinks(scope);
    if (fallbackStatus && !links.has(fallbackStatus.id)) links.set(fallbackStatus.id, fallbackStatus);
    if (links.size !== 1) return null;
    const status = links.values().next().value;
    const text = readText(element);
    if (!text) return null;
    return { ...status, text, element, article: ownerArticle, relation, language: languageFor(element, text) };
  }

  function inSupportedView() {
    return !/^\/(?:messages|i\/chat|chat|settings|compose)(?:\/|$)/i.test(location.pathname);
  }

  function getCurrent(target) {
    if (!inSupportedView()) return null;
    const element = asElement(target);
    const article = element?.closest(articleSelector);
    if (!article || article.parentElement?.closest(articleSelector) || !owns(article, element)) return null;
    if (element !== article && isQuoteCard(element)) return null;
    if (element.closest('[contenteditable], input, textarea, [data-testid="dmDrawer"]')) return null;
    return readPost(article, 'current', article);
  }

  function readQuote(card, article, outerStatus = null) {
    const cardLink = permalink(card.getAttribute('href'));
    if (cardLink && outerStatus && cardLink.id !== outerStatus.id) return null;
    const status = cardLink || outerStatus;
    const post = readPost(card, 'quote', article, status);
    if (post) return post;
    if (ownMatches(card, `${textSelector}, ${quotedTextSelector}`).length > 0) return null;

    // 某些引用外层链接内还有一个专用卡片或 article。只越过唯一的布局包装层。
    const innerCards = ownMatches(card, `${articleSelector}, ${cardSelector}`).filter((node) =>
      node.matches(articleSelector) || isQuoteCard(node)
    );
    if (innerCards.length !== 1) return null;
    return readQuote(innerCards[0], article, status);
  }

  function getQuote(article) {
    const quotes = ownMatches(article, cardSelector).filter(isQuoteCard).map((card) => readQuote(card, article)).filter(Boolean);
    return quotes.length === 1 ? quotes[0] : null;
  }

  function getParentId(article) {
    const ids = new Set(parentAttributes.map((attribute) => article.getAttribute(attribute)).filter((id) => statusIdPattern.test(id)));
    for (const marker of ownMatches(article, replyMarkerSelector)) {
      if (!isVisible(marker) || marker.closest(textSelector)) continue;
      const links = marker.matches('a[href]') ? [marker] : ownMatches(marker, 'a[href]');
      for (const link of links) {
        const status = permalink(link.getAttribute('href'));
        if (status && isVisible(link)) ids.add(status.id);
      }
    }
    return ids.size === 1 ? ids.values().next().value : null;
  }

  function getParent(current) {
    // 时间线位置和会话列表排序无法证明直接回复关系。仅接受明确指向目标帖的 ID。
    const id = getParentId(current.article);
    if (!id || id === current.id) return null;
    const matches = Array.from(current.article.ownerDocument.querySelectorAll(articleSelector))
      .filter((article) => ownPermalinks(article).has(id)).map(getCurrent)
      .filter((source) => source?.id === id);
    if (!matches.length || matches.some((candidate) => candidate.text !== matches[0].text)) return null;
    return { ...matches[0], relation: 'parent' };
  }

  function sourcesFor(current) {
    const sources = new Map([[current.id, current]]);
    for (const related of [getQuote(current.article), getParent(current)]) {
      if (related && !sources.has(related.id)) sources.set(related.id, related);
    }
    return [...sources.values()];
  }

  function selectedExpression(current, selection) {
    if (selection.isCollapsed || selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0);
    const endpoints = [asElement(range.startContainer), asElement(range.endContainer)];
    if (!endpoints.every((node) => current.element.contains(node) && !node.closest(excludedSelector))) return null;
    const expression = normalizeText(selection.toString());
    return expression && current.text.includes(expression) ? expression : null;
  }

  function snapshot(sources) {
    return JSON.stringify([location.href, ...sources.map(({ id, url, text, relation, language }) => [id, url, text, relation, language])]);
  }

  function resolve(target, selection = null) {
    const current = getCurrent(target || selection?.anchorNode);
    if (!current) return null;
    const expression = selection ? selectedExpression(current, selection) : '';
    if (expression === null) return null;
    const sources = sourcesFor(current);
    return { current, sources, expression, snapshotKey: snapshot(sources) };
  }

  function sourceById(context, id) {
    return context?.sources.find((source) => source.id === id) || null;
  }

  function isCurrent(context) {
    if (!context?.current?.element?.isConnected) return false;
    const updated = resolve(context.current.article);
    return Boolean(updated && updated.snapshotKey === context.snapshotKey &&
      updated.sources.every((source, index) => source.element === context.sources[index].element));
  }

  globalThis.XLearningContext = Object.freeze({ articleSelector, getCurrent, isCurrent, resolve, sourceById });
})();
