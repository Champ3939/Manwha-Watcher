const BaseConnector = require('./base');
const { normalizeLanguage } = require('../core/languageFilter');
const { normalizeSeriesStatus } = require('../core/seriesStatus');

class AutoDetectConnector extends BaseConnector {
  constructor(browser) {
    super('auto-detect', 'Automatische Web-Erkennung', { type: 'auto-detect' });
    this.browser = browser;
  }

  canHandle(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  async getSeriesInfo(url) {
    const info = await this.browser.discoverSeriesInfo(url);
    return {
      title: info.title || new URL(url).hostname,
      url: info.url || url,
      cover: info.cover || null,
      language: normalizeLanguage(info.language || info.pageLanguage) || null,
      status: normalizeSeriesStatus(info.status),
      connectorId: this.id,
      chapters: info.chapters || [],
      autoDetected: true
    };
  }

  async getChapters(series) {
    const info = await this.browser.discoverSeriesInfo(series.url);
    return info.chapters || [];
  }

  async getPages(_series, chapter) {
    if (!chapter?.url) throw new Error('Für dieses Kapitel ist keine URL gespeichert.');
    return this.browser.discoverReaderPages(chapter.url, { referer: _series?.url || null });
  }
}

module.exports = AutoDetectConnector;
