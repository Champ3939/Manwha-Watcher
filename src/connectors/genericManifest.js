const BaseConnector = require('./base');
const { normalizeLanguage } = require('../core/languageFilter');

class GenericManifestConnector extends BaseConnector {
  constructor(fetchJson) {
    super('generic-manifest', 'Generic JSON Manifest', { type: 'manifest' });
    this.fetchJson = fetchJson;
  }

  canHandle(url) {
    try {
      const parsed = new URL(url);
      return ['http:', 'https:'].includes(parsed.protocol) && parsed.pathname.toLowerCase().endsWith('.json');
    } catch {
      return false;
    }
  }

  async load(url) {
    const data = await this.fetchJson(url);
    if (!data || typeof data.title !== 'string' || !Array.isArray(data.chapters)) {
      throw new Error('Manifest muss einen Titel und ein chapters-Array enthalten.');
    }
    return data;
  }

  normalizeChapter(chapter, index) {
    const id = String(chapter.id ?? chapter.number ?? index + 1);
    return {
      id,
      title: String(chapter.title ?? `Chapter ${id}`),
      url: chapter.url || null,
      number: chapter.number ?? null,
      downloaded: Boolean(chapter.downloaded),
      language: normalizeLanguage(chapter.language) || null,
      pages: Array.isArray(chapter.pages) ? chapter.pages.map((page, pageIndex) => {
        if (typeof page === 'string') return { url: page, filename: null, index: pageIndex + 1 };
        return {
          url: page.url,
          filename: page.filename || null,
          referer: page.referer || null,
          headers: page.headers || null,
          index: pageIndex + 1
        };
      }) : []
    };
  }

  async getSeriesInfo(url) {
    const data = await this.load(url);
    return {
      title: data.title.trim(),
      url,
      connectorId: this.id,
      language: normalizeLanguage(data.language || data.lang) || null,
      chapters: data.chapters.map((chapter, index) => this.normalizeChapter(chapter, index))
    };
  }

  async getChapters(series) {
    const data = await this.load(series.url);
    return data.chapters.map((chapter, index) => this.normalizeChapter(chapter, index));
  }

  async getPages(_series, chapter) { return chapter.pages || []; }
}

module.exports = GenericManifestConnector;
