const BaseConnector = require('./base');
const { normalizeLanguage } = require('../core/languageFilter');
const { normalizeSeriesStatus } = require('../core/seriesStatus');

function normalizePathname(value) {
  try {
    return decodeURIComponent(new URL(String(value || '')).pathname)
      .replace(/\/+$/g, '')
      .toLowerCase();
  } catch {
    return '';
  }
}

function chapterFamily(value) {
  const pathname = normalizePathname(value);
  if (!pathname) return '';

  const slashPattern = pathname.match(/^(.*?)(?:\/(?:chapters?|chapter|chap|ch|episodes?|episode|ep)[-_/]?(?:\d+(?:[.-]\d+)?))(?:\/.*)?$/i);
  if (slashPattern?.[1]) return slashPattern[1].replace(/\/+$/g, '');

  const joinedPattern = pathname.match(/^(.*?)(?:[-_](?:chapter|chap|ch|episode|ep)[-_]?(?:\d+(?:[.-]\d+)?))(?:[-_/].*)?$/i);
  if (joinedPattern?.[1]) return joinedPattern[1].replace(/\/+$/g, '');

  return '';
}

function titleTokens(value) {
  const ignored = new Set([
    'manga', 'manhwa', 'manhua', 'webtoon', 'comic', 'comics', 'series', 'chapter', 'chapters',
    'read', 'reader', 'online', 'english', 'scan', 'scans', 'translation', 'official'
  ]);
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !ignored.has(token));
}

function filterSeriesChapters(seriesUrl, seriesTitle, chapters) {
  const list = Array.isArray(chapters) ? chapters.filter(Boolean) : [];
  if (list.length < 3) return list;

  let seriesOrigin = '';
  try { seriesOrigin = new URL(String(seriesUrl || '')).origin; } catch {}
  const seriesPath = normalizePathname(seriesUrl);
  const pathParts = seriesPath.split('/').filter(Boolean);
  const genericParts = new Set(['manga', 'manhwa', 'manhua', 'webtoon', 'comic', 'comics', 'series', 'title', 'read']);
  const seriesSlug = [...pathParts].reverse().find((part) => part.length >= 4 && !genericParts.has(part)) || '';
  const tokens = titleTokens(seriesTitle);

  const groups = new Map();
  for (const chapter of list) {
    const rawUrl = String(chapter?.url || '').trim();
    if (!rawUrl) continue;
    try {
      const parsed = new URL(rawUrl);
      if (seriesOrigin && parsed.origin !== seriesOrigin) continue;
    } catch {
      continue;
    }
    const family = chapterFamily(rawUrl);
    if (!family) continue;
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(chapter);
  }

  if (!groups.size) return list;

  const ranked = [...groups.entries()].map(([family, items]) => {
    let affinity = 0;
    if (seriesPath && family === seriesPath) affinity += 140;
    else if (seriesPath && (family.startsWith(`${seriesPath}/`) || seriesPath.startsWith(`${family}/`))) affinity += 80;
    if (seriesSlug && family.includes(seriesSlug)) affinity += 100;
    affinity += Math.min(75, tokens.filter((token) => family.includes(token)).length * 25);
    return { family, items, affinity };
  }).sort((a, b) => b.affinity - a.affinity || b.items.length - a.items.length);

  const best = ranked[0];
  const second = ranked[1];
  const groupedCount = ranked.reduce((sum, entry) => sum + entry.items.length, 0);
  let selected = null;

  // Strong URL/title relationship to the opened series wins even when the page
  // contains a large "latest chapters" or recommendation block from other titles.
  if (best && best.affinity >= 80 && best.items.length >= 2) {
    selected = best;
  } else if (best && best.items.length >= 2) {
    const dominant = best.items.length >= Math.ceil(groupedCount * 0.5)
      || best.items.length >= Math.max(2, Number(second?.items.length || 0) * 2);
    if (dominant) selected = best;
  }

  // If the page structure is ambiguous, preserve the old result rather than
  // accidentally hiding legitimate chapters on sites with unusual/opaque URLs.
  return selected ? selected.items : list;
}

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
    const chapters = filterSeriesChapters(info.url || url, info.title, info.chapters || []);
    return {
      title: info.title || new URL(url).hostname,
      url: info.url || url,
      cover: info.cover || null,
      language: normalizeLanguage(info.language || info.pageLanguage) || null,
      status: normalizeSeriesStatus(info.status),
      connectorId: this.id,
      chapters,
      autoDetected: true
    };
  }

  async getChapters(series) {
    const info = await this.browser.discoverSeriesInfo(series.url);
    return filterSeriesChapters(info.url || series.url, info.title || series.title, info.chapters || []);
  }

  async getPages(_series, chapter) {
    if (!chapter?.url) throw new Error('Für dieses Kapitel ist keine URL gespeichert.');
    return this.browser.discoverReaderPages(chapter.url, { referer: _series?.url || null });
  }
}

module.exports = AutoDetectConnector;
