const BaseConnector = require('./base');
const { normalizeLanguage } = require('../core/languageFilter');

function normalizeHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

function makeExtractorScript(recipe, mode) {
  const cfg = mode === 'pages' ? recipe.pages : recipe.chapters;
  const payload = JSON.stringify({ recipe, cfg, mode });
  return `(() => {
    const data = ${payload};
    const cfg = data.cfg || {};
    const abs = (value) => { try { return new URL(value, location.href).href; } catch { return null; } };
    const textOf = (root, selector) => {
      const node = selector ? root.querySelector(selector) : root;
      return (node?.textContent || '').replace(/\\s+/g, ' ').trim();
    };
    const attrOf = (root, selector, attrs) => {
      const node = selector ? root.querySelector(selector) : root;
      if (!node) return null;
      for (const name of attrs || []) {
        const value = name === 'text' ? node.textContent : node.getAttribute(name);
        if (value && String(value).trim()) return String(value).trim();
      }
      return null;
    };
    const matchValue = (text, pattern) => {
      if (!pattern) return null;
      try { const match = String(text || '').match(new RegExp(pattern, 'i')); return match ? (match[1] ?? match[0]) : null; } catch { return null; }
    };

    if (data.mode === 'chapters') {
      const nodes = [...document.querySelectorAll(cfg.selector || '')];
      const out = nodes.map((root, index) => {
        const title = textOf(root, cfg.titleSelector) || 'Chapter ' + (index + 1);
        const rawUrl = attrOf(root, cfg.urlSelector, cfg.urlAttributes || ['href']);
        const url = abs(rawUrl);
        const rawId = cfg.idAttribute ? root.getAttribute(cfg.idAttribute) : null;
        const id = rawId || matchValue(url, cfg.idRegex) || matchValue(title, cfg.idRegex) || url || String(index + 1);
        const numberRaw = matchValue(title, cfg.numberRegex);
        const number = numberRaw == null ? null : Number(String(numberRaw).replace(',', '.'));
        return { id: String(id), title, url, number: Number.isFinite(number) ? number : null, downloaded: false };
      }).filter((item) => item.url);
      const seen = new Set();
      const unique = out.filter((item) => { const key = item.id + '|' + item.url; if (seen.has(key)) return false; seen.add(key); return true; });
      if (cfg.order === 'reverse-dom') unique.reverse();
      if (cfg.order === 'number-asc') unique.sort((a,b) => (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER));
      if (cfg.order === 'number-desc') unique.sort((a,b) => (b.number ?? -1) - (a.number ?? -1));
      return unique;
    }

    const nodes = [...document.querySelectorAll(cfg.selector || '')];
    return nodes.map((root, index) => {
      const raw = attrOf(root, cfg.urlSelector, cfg.urlAttributes || ['src', 'data-src', 'data-lazy-src', 'data-original']);
      const url = abs(raw);
      const filename = cfg.filenameAttribute ? root.getAttribute(cfg.filenameAttribute) : null;
      return url ? { url, filename: filename || null, index: index + 1, referer: location.href } : null;
    }).filter(Boolean);
  })()`;
}

class RecipeConnector extends BaseConnector {
  constructor(recipe, browser) {
    const domains = (recipe.domains || []).map(normalizeHost).filter(Boolean);
    super(`recipe:${recipe.id}`, recipe.label || recipe.id, { type: 'web-recipe', domains });
    this.recipe = recipe;
    this.browser = browser;
  }

  canHandle(url) {
    try {
      const host = normalizeHost(new URL(url).hostname);
      return this.domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
    } catch {
      return false;
    }
  }

  loadOptions(section) {
    const cfg = this.recipe[section] || {};
    return {
      waitForSelector: cfg.waitForSelector || cfg.selector || null,
      timeoutMs: this.recipe.timeoutMs || 30000,
      settleMs: cfg.settleMs || this.recipe.settleMs || 250,
      background: true
    };
  }

  titleScript() {
    const selector = this.recipe.series?.titleSelector;
    const payload = JSON.stringify(selector || '');
    return `(() => {
      const selector = ${payload};
      const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const selected = selector ? clean(document.querySelector(selector)?.textContent) : '';
      const meta = clean(document.querySelector('meta[property="og:title"]')?.content || document.querySelector('meta[name="twitter:title"]')?.content);
      const heading = clean(document.querySelector('h1')?.textContent || document.querySelector('h2')?.textContent);
      const doc = clean(document.title);
      const sane = (value) => value && value.length <= 180 && (value.match(/chapter/gi) || []).length < 3;
      if (sane(selected)) return selected;
      if (sane(meta)) return meta;
      if (sane(heading)) return heading;
      if (doc) return doc.split(/\\s+[|–—-]\\s+/)[0].trim() || doc;
      return location.hostname;
    })()`;
  }

  async getSeriesInfo(url) {
    const languageScript = `(() => { const marker = document.querySelector('[data-language],[data-lang],[class*=\"language\" i],[class*=\"lang-\" i]'); return marker?.getAttribute('data-language') || marker?.getAttribute('data-lang') || marker?.getAttribute('lang') || marker?.textContent?.trim() || document.querySelector('meta[http-equiv=\"content-language\" i]')?.content || document.querySelector('meta[name=\"language\" i]')?.content || document.documentElement?.getAttribute('lang') || null; })()`;
    const result = await this.browser.scrape(url, this.loadOptions('chapters'), `({ title: ${this.titleScript()}, language: ${languageScript}, chapters: ${makeExtractorScript(this.recipe, 'chapters')} })`);
    const title = result?.title;
    const language = normalizeLanguage(result?.language) || null;
    const chapters = Array.isArray(result?.chapters) ? result.chapters.map((chapter) => ({ ...chapter, language: chapter.language || language })) : result?.chapters;
    if (!Array.isArray(chapters) || !chapters.length) {
      throw new Error(`Connector „${this.label}“ konnte keine Kapitel finden.`);
    }
    return { title: title || new URL(url).hostname, url, connectorId: this.id, language, chapters };
  }

  async getChapters(series) {
    const chapters = await this.browser.scrape(series.url, this.loadOptions('chapters'), makeExtractorScript(this.recipe, 'chapters'));
    if (!Array.isArray(chapters)) throw new Error('Ungültige Kapitelliste vom Web-Connector.');
    return chapters.map((chapter) => ({ ...chapter, language: chapter.language || series?.language || null }));
  }

  async getPages(series, chapter) {
    if (!chapter.url) throw new Error('Für dieses Kapitel ist keine URL gespeichert.');
    const pages = await this.browser.scrape(chapter.url, { ...this.loadOptions('pages'), referer: series?.url || null, freshWindow: true }, makeExtractorScript(this.recipe, 'pages'));
    if (!Array.isArray(pages) || !pages.length) throw new Error(`Keine Seiten für „${chapter.title}“ gefunden.`);
    return pages.map((page) => ({ ...page, referer: page.referer || chapter.url || series?.url || null }));
  }
}

module.exports = RecipeConnector;
