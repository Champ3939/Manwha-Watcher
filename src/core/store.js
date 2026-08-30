const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

function clone(value) { return structuredClone(value); }
function normUrl(value) {
  try {
    const u = new URL(String(value || ''));
    u.hash = '';
    return u.href.replace(/\/$/, '');
  } catch {
    return String(value || '').trim().replace(/\/$/, '');
  }
}
function parseJson(value, fallback = null) {
  try { return value == null ? fallback : JSON.parse(String(value)); } catch { return fallback; }
}
function toJson(value) { return JSON.stringify(value ?? null); }

const DEFAULT_SETTINGS = {
  checkIntervalMinutes: 30,
  autoCheck: true,
  autoUpdateScan: false,
  updateScanIntervalHours: 6,
  updateScanOnStartup: false,
  downloadRoot: null,
  syncRoot: '',
  requestDelayMs: 350,
  maxRetries: 2,
  notifications: true,
  languageFilterEnabled: true,
  allowedLanguages: ['en', 'de'],
  allowUnknownLanguage: false,
  seriesStatusFilterEnabled: true,
  allowedSeriesStatuses: ['ongoing', 'completed', 'hiatus', 'upcoming', 'unknown'],
  connectorAutoDetectDomains: []
};

class Store {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.file = path.join(baseDir, 'library.db');
    this.legacyFile = path.join(baseDir, 'library.json');
    this.db = null;
    this.load();
  }

  _open() {
    fs.mkdirSync(this.baseDir, { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS series (
        id TEXT PRIMARY KEY,
        url_key TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS downloads (
        id TEXT PRIMARY KEY,
        series_key TEXT NOT NULL,
        chapter_key TEXT NOT NULL,
        series_url TEXT NOT NULL,
        chapter_id TEXT NOT NULL,
        chapter_url TEXT NOT NULL,
        downloaded_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_downloads_series ON downloads(series_key);
      CREATE INDEX IF NOT EXISTS idx_downloads_time ON downloads(downloaded_at DESC);
      CREATE TABLE IF NOT EXISTS websites (
        id TEXT PRIMARY KEY,
        url_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_series (
        series_key TEXT PRIMARY KEY,
        series_url TEXT NOT NULL,
        title TEXT NOT NULL,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS series_status (
        series_key TEXT PRIMARY KEY,
        series_url TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reading_list (
        series_key TEXT PRIMARY KEY,
        series_url TEXT NOT NULL,
        title TEXT NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0,
        reading INTEGER NOT NULL DEFAULT 0,
        status TEXT,
        language TEXT,
        cover TEXT,
        data_json TEXT NOT NULL,
        added_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reading_favorite ON reading_list(favorite, reading);
      CREATE TABLE IF NOT EXISTS online_library (
        series_key TEXT PRIMARY KEY,
        series_url TEXT NOT NULL,
        title TEXT NOT NULL,
        cover TEXT,
        status TEXT,
        language TEXT,
        source TEXT,
        last_chapter_title TEXT,
        last_chapter_url TEXT,
        last_opened_at TEXT,
        data_json TEXT NOT NULL,
        added_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_online_library_title ON online_library(title COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_online_library_opened ON online_library(last_opened_at DESC);
      CREATE TABLE IF NOT EXISTS news (
        id TEXT PRIMARY KEY,
        scan_id TEXT NOT NULL,
        series_key TEXT NOT NULL,
        series_url TEXT NOT NULL,
        series_title TEXT NOT NULL,
        new_chapters INTEGER NOT NULL DEFAULT 0,
        downloaded INTEGER NOT NULL DEFAULT 0,
        errors_json TEXT NOT NULL,
        found_at TEXT NOT NULL,
        seen_at TEXT,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_news_scan ON news(scan_id, found_at DESC);
      CREATE INDEX IF NOT EXISTS idx_news_unseen ON news(seen_at, found_at DESC);
    `);
  }

  _tableCount(table) {
    return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count || 0);
  }

  _setMeta(key, value) {
    this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(String(key), String(value));
  }
  _getMeta(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(String(key))?.value ?? null; }

  load() {
    this.close();
    const dbExisted = fs.existsSync(this.file);
    this._open();
    const initialized = this._getMeta('schema_version');
    if (!initialized) {
      let migrated = false;
      if (!dbExisted && fs.existsSync(this.legacyFile)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(this.legacyFile, 'utf8'));
          this.importSnapshot(parsed, { clear: true });
          migrated = true;
          this._setMeta('legacy_json_migrated_at', new Date().toISOString());
        } catch (error) {
          const backup = `${this.legacyFile}.broken-${Date.now()}`;
          try { fs.copyFileSync(this.legacyFile, backup); } catch {}
        }
      }
      this._setMeta('schema_version', '2');
      this._setMeta('storage_engine', 'sqlite');
      if (!migrated) this._ensureDefaultSettings();
    } else {
      this._ensureDefaultSettings();
    }
  }

  close() {
    if (!this.db) return;
    try { this.db.close(); } catch {}
    this.db = null;
  }

  checkpoint() {
    // DELETE journaling keeps the DB self-contained, but optimize/checkpoint is cheap and
    // makes backups deterministic.
    try { this.db.exec('PRAGMA optimize;'); } catch {}
    return this.file;
  }

  save() { this.checkpoint(); }

  _ensureDefaultSettings() {
    const defaults = { ...DEFAULT_SETTINGS, downloadRoot: path.join(this.baseDir, 'downloads') };
    const stmt = this.db.prepare('INSERT OR IGNORE INTO settings(key,value_json) VALUES(?,?)');
    for (const [key, value] of Object.entries(defaults)) stmt.run(key, toJson(value));
  }

  getSettings() {
    const defaults = { ...DEFAULT_SETTINGS, downloadRoot: path.join(this.baseDir, 'downloads') };
    const rows = this.db.prepare('SELECT key,value_json FROM settings').all();
    const out = { ...defaults };
    for (const row of rows) out[row.key] = parseJson(row.value_json, out[row.key]);
    return out;
  }

  setSettings(patch) {
    const stmt = this.db.prepare('INSERT INTO settings(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [key, value] of Object.entries(patch || {})) stmt.run(key, toJson(value));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getSettings();
  }

  _seriesFromRow(row) { return row ? parseJson(row.data_json, null) : null; }
  listSeries() { return this.db.prepare('SELECT data_json FROM series ORDER BY created_at ASC').all().map((row) => this._seriesFromRow(row)).filter(Boolean); }
  getSeries(id) { return this._seriesFromRow(this.db.prepare('SELECT data_json FROM series WHERE id=?').get(String(id))); }

  addSeries(series) {
    const key = normUrl(series?.url);
    const existing = this.db.prepare('SELECT data_json FROM series WHERE url_key=?').get(key);
    if (existing) return clone(parseJson(existing.data_json, {}));
    const now = new Date().toISOString();
    const item = {
      id: crypto.randomUUID(), title: series.title, url: series.url, connectorId: series.connectorId, language: series.language || null, status: series.status || 'unknown',
      autoDownload: false, lastCheckedAt: null, lastError: null, chapters: series.chapters || []
    };
    this.db.prepare('INSERT INTO series(id,url_key,url,title,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(item.id, key, String(item.url || ''), String(item.title || 'Unbenannte Serie'), toJson(item), now, now);
    return clone(item);
  }

  updateSeries(id, patch) {
    const item = this.getSeries(id);
    if (!item) throw new Error('Serie nicht gefunden.');
    Object.assign(item, patch || {});
    const now = new Date().toISOString();
    this.db.prepare('UPDATE series SET url_key=?,url=?,title=?,data_json=?,updated_at=? WHERE id=?')
      .run(normUrl(item.url), String(item.url || ''), String(item.title || 'Unbenannte Serie'), toJson(item), now, String(id));
    return clone(item);
  }

  removeSeries(id) { return this.db.prepare('DELETE FROM series WHERE id=?').run(String(id)).changes > 0; }

  listWebsites() {
    return this.db.prepare('SELECT data_json FROM websites ORDER BY name COLLATE NOCASE ASC').all().map((row) => parseJson(row.data_json, null)).filter(Boolean);
  }

  _normalizeWebsite(input, current = null) {
    const rawUrl = String(input?.url ?? current?.url ?? '').trim();
    let parsed;
    try { parsed = new URL(rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`); }
    catch { throw new Error('Bitte eine gültige Webseiten-URL eingeben.'); }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('Nur http://- und https://-Webseiten können gespeichert werden.');
    parsed.hash = '';
    const url = parsed.href;
    const name = String(input?.name ?? current?.name ?? '').trim() || parsed.hostname.replace(/^www\./, '');
    return { url, name, key: normUrl(url) };
  }

  addWebsite(input) {
    const normalized = this._normalizeWebsite(input);
    const existing = this.db.prepare('SELECT data_json FROM websites WHERE url_key=?').get(normalized.key);
    const now = new Date().toISOString();
    if (existing) {
      const item = { ...parseJson(existing.data_json, {}), name: normalized.name, url: normalized.url, updatedAt: now };
      this.db.prepare('UPDATE websites SET name=?,url=?,data_json=?,updated_at=? WHERE url_key=?').run(item.name, item.url, toJson(item), now, normalized.key);
      return clone(item);
    }
    const item = { id: crypto.randomUUID(), name: normalized.name, url: normalized.url, createdAt: now, updatedAt: now };
    this.db.prepare('INSERT INTO websites(id,url_key,name,url,data_json,updated_at) VALUES(?,?,?,?,?,?)').run(item.id, normalized.key, item.name, item.url, toJson(item), now);
    return clone(item);
  }

  updateWebsite(id, patch) {
    const row = this.db.prepare('SELECT data_json FROM websites WHERE id=?').get(String(id));
    if (!row) throw new Error('Gespeicherte Webseite nicht gefunden.');
    const current = parseJson(row.data_json, {});
    const normalized = this._normalizeWebsite({ url: Object.prototype.hasOwnProperty.call(patch || {}, 'url') ? patch.url : current.url, name: Object.prototype.hasOwnProperty.call(patch || {}, 'name') ? patch.name : current.name }, current);
    const duplicate = this.db.prepare('SELECT id FROM websites WHERE url_key=? AND id<>?').get(normalized.key, String(id));
    if (duplicate) throw new Error('Diese Webseite ist bereits gespeichert.');
    const item = { ...current, url: normalized.url, name: normalized.name, updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE websites SET url_key=?,name=?,url=?,data_json=?,updated_at=? WHERE id=?')
      .run(normalized.key, item.name, item.url, toJson(item), item.updatedAt, String(id));
    return clone(item);
  }

  removeWebsite(id) { return this.db.prepare('DELETE FROM websites WHERE id=?').run(String(id)).changes > 0; }

  getSeriesStatus(seriesUrl, { maxAgeMs = 14 * 24 * 60 * 60 * 1000 } = {}) {
    const row = this.db.prepare('SELECT data_json FROM series_status WHERE series_key=?').get(normUrl(seriesUrl));
    if (!row) return null;
    const item = parseJson(row.data_json, null);
    if (!item) return null;
    if (maxAgeMs > 0 && item.updatedAt) {
      const age = Date.now() - new Date(item.updatedAt).getTime();
      if (Number.isFinite(age) && age > maxAgeMs) return null;
    }
    return clone(item);
  }

  setSeriesStatus(seriesUrl, status, extra = {}) {
    const key = normUrl(seriesUrl);
    if (!key) throw new Error('Serien-URL fehlt.');
    const existing = this.getSeriesStatus(seriesUrl, { maxAgeMs: 0 }) || {};
    const item = {
      ...existing,
      seriesUrl: String(seriesUrl || ''),
      status: String(status || 'unknown'),
      title: String(extra.title || existing.title || '').trim(),
      source: String(extra.source || existing.source || 'series-page'),
      updatedAt: new Date().toISOString()
    };
    this.db.prepare(`INSERT INTO series_status(series_key,series_url,status,updated_at,data_json) VALUES(?,?,?,?,?)
      ON CONFLICT(series_key) DO UPDATE SET series_url=excluded.series_url,status=excluded.status,updated_at=excluded.updated_at,data_json=excluded.data_json`)
      .run(key, item.seriesUrl, item.status, item.updatedAt, toJson(item));
    return clone(item);
  }

  setSeriesStatuses(records = []) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const record of Array.isArray(records) ? records : []) this.setSeriesStatus(record.seriesUrl, record.status, record);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return clone(records);
  }

  listSeriesStatuses({ maxAgeMs = 14 * 24 * 60 * 60 * 1000 } = {}) {
    const now = Date.now();
    return this.db.prepare('SELECT data_json FROM series_status ORDER BY updated_at DESC').all()
      .map((row) => parseJson(row.data_json, null)).filter(Boolean).filter((item) => {
        if (!(maxAgeMs > 0) || !item.updatedAt) return true;
        const age = now - new Date(item.updatedAt).getTime();
        return !Number.isFinite(age) || age <= maxAgeMs;
      });
  }

  listSyncSeries() {
    return this.db.prepare('SELECT data_json FROM sync_series ORDER BY title COLLATE NOCASE ASC').all().map((row) => parseJson(row.data_json, null)).filter(Boolean);
  }
  getSyncSeries(seriesUrl) {
    const row = this.db.prepare('SELECT data_json FROM sync_series WHERE series_key=?').get(normUrl(seriesUrl));
    return row ? clone(parseJson(row.data_json, null)) : null;
  }
  isSeriesSynced(seriesUrl) { return Boolean(this.getSyncSeries(seriesUrl)); }
  setSeriesSync({ seriesUrl, title, enabled }) {
    const rawUrl = String(seriesUrl || '').trim();
    if (!rawUrl) throw new Error('Serien-URL fehlt.');
    const key = normUrl(rawUrl);
    const current = this.getSyncSeries(rawUrl);
    if (!enabled) { this.db.prepare('DELETE FROM sync_series WHERE series_key=?').run(key); return null; }
    const now = new Date().toISOString();
    const next = {
      id: current?.id || crypto.randomUUID(), seriesUrl: rawUrl,
      title: String(title || current?.title || rawUrl).trim(),
      enabledAt: current?.enabledAt || now, updatedAt: now
    };
    this.db.prepare(`INSERT INTO sync_series(series_key,series_url,title,data_json,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(series_key) DO UPDATE SET series_url=excluded.series_url,title=excluded.title,data_json=excluded.data_json,updated_at=excluded.updated_at`)
      .run(key, next.seriesUrl, next.title, toJson(next), now);
    return clone(next);
  }

  listDownloads({ limit = 500 } = {}) {
    const cap = Math.max(1, Math.min(5000, Number(limit) || 500));
    return this.db.prepare('SELECT data_json FROM downloads ORDER BY downloaded_at DESC LIMIT ?').all(cap).map((row) => parseJson(row.data_json, null)).filter(Boolean);
  }
  findDownloadsForSeries(seriesUrl) {
    return this.db.prepare('SELECT data_json FROM downloads WHERE series_key=? ORDER BY downloaded_at ASC').all(normUrl(seriesUrl)).map((row) => parseJson(row.data_json, null)).filter(Boolean);
  }
  getDownload(seriesUrl, chapterId, chapterUrl = null) {
    const records = this.findDownloadsForSeries(seriesUrl);
    const cid = String(chapterId ?? ''); const chapterKey = chapterUrl ? normUrl(chapterUrl) : null;
    const found = records.find((item) => (cid && String(item.chapterId ?? '') === cid) || Boolean(chapterKey && item.chapterUrl && normUrl(item.chapterUrl) === chapterKey));
    return found ? clone(found) : null;
  }
  markDownloaded(record) {
    const normalized = {
      id: String(record.id || crypto.randomUUID()), seriesTitle: String(record.seriesTitle || 'Unbenannte Serie'), seriesUrl: String(record.seriesUrl || ''),
      chapterId: String(record.chapterId ?? ''), chapterTitle: String(record.chapterTitle || `Chapter ${record.chapterId ?? ''}`).trim(), chapterUrl: String(record.chapterUrl || ''),
      folder: String(record.folder || ''), file: String(record.file || ''), format: String(record.format || (record.file ? 'cbz' : 'folder')),
      pageCount: Math.max(0, Number(record.pageCount) || 0), downloadedAt: record.downloadedAt || new Date().toISOString()
    };
    const seriesKey = normUrl(normalized.seriesUrl);
    const chapterUrlKey = normUrl(normalized.chapterUrl);
    const existing = this.db.prepare('SELECT id,data_json FROM downloads WHERE series_key=?').all(seriesKey).find((row) => {
      const item = parseJson(row.data_json, {});
      if (normalized.chapterId && String(item.chapterId ?? '') === normalized.chapterId) return true;
      return Boolean(chapterUrlKey && item.chapterUrl && normUrl(item.chapterUrl) === chapterUrlKey);
    });
    if (existing) normalized.id = existing.id || normalized.id;
    const chapterKey = normalized.chapterId ? `id:${normalized.chapterId}` : `url:${chapterUrlKey}`;
    this.db.prepare(`INSERT INTO downloads(id,series_key,chapter_key,series_url,chapter_id,chapter_url,downloaded_at,data_json) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET series_key=excluded.series_key,chapter_key=excluded.chapter_key,series_url=excluded.series_url,chapter_id=excluded.chapter_id,chapter_url=excluded.chapter_url,downloaded_at=excluded.downloaded_at,data_json=excluded.data_json`)
      .run(normalized.id, seriesKey, chapterKey, normalized.seriesUrl, normalized.chapterId, normalized.chapterUrl, normalized.downloadedAt, toJson(normalized));
    return clone(normalized);
  }

  // Favorites / reading list -------------------------------------------------
  getReadingListEntry(seriesUrl) {
    const row = this.db.prepare('SELECT data_json FROM reading_list WHERE series_key=?').get(normUrl(seriesUrl));
    return row ? clone(parseJson(row.data_json, null)) : null;
  }
  listReadingList({ mode = 'all' } = {}) {
    let sql = 'SELECT data_json FROM reading_list';
    if (mode === 'favorites') sql += ' WHERE favorite=1';
    else if (mode === 'reading') sql += ' WHERE reading=1';
    sql += ' ORDER BY updated_at DESC, title COLLATE NOCASE ASC';
    return this.db.prepare(sql).all().map((row) => parseJson(row.data_json, null)).filter(Boolean);
  }
  setReadingList(input = {}) {
    const rawUrl = String(input.seriesUrl || input.url || '').trim();
    if (!rawUrl) throw new Error('Serien-URL fehlt.');
    const key = normUrl(rawUrl);
    const current = this.getReadingListEntry(rawUrl) || {};
    const now = new Date().toISOString();
    const item = {
      seriesUrl: rawUrl,
      title: String(input.title || current.title || rawUrl).trim(),
      cover: input.cover ?? current.cover ?? null,
      status: input.status ?? current.status ?? 'unknown',
      language: input.language ?? current.language ?? null,
      favorite: Object.prototype.hasOwnProperty.call(input, 'favorite') ? Boolean(input.favorite) : Boolean(current.favorite),
      reading: Object.prototype.hasOwnProperty.call(input, 'reading') ? Boolean(input.reading) : Boolean(current.reading),
      addedAt: current.addedAt || now,
      updatedAt: now
    };
    if (!item.favorite && !item.reading) {
      this.db.prepare('DELETE FROM reading_list WHERE series_key=?').run(key);
      return null;
    }
    this.db.prepare(`INSERT INTO reading_list(series_key,series_url,title,favorite,reading,status,language,cover,data_json,added_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(series_key) DO UPDATE SET series_url=excluded.series_url,title=excluded.title,favorite=excluded.favorite,reading=excluded.reading,status=excluded.status,language=excluded.language,cover=excluded.cover,data_json=excluded.data_json,updated_at=excluded.updated_at`)
      .run(key, item.seriesUrl, item.title, item.favorite ? 1 : 0, item.reading ? 1 : 0, String(item.status || 'unknown'), item.language || null, item.cover || null, toJson(item), item.addedAt, item.updatedAt);
    return clone(item);
  }

  // Online library -----------------------------------------------------------
  getOnlineLibraryEntry(seriesUrl) {
    const row = this.db.prepare('SELECT data_json FROM online_library WHERE series_key=?').get(normUrl(seriesUrl));
    return row ? clone(parseJson(row.data_json, null)) : null;
  }
  listOnlineLibrary({ query = '', limit = 10000 } = {}) {
    const needle = String(query || '').trim().toLowerCase();
    const cap = Math.max(1, Math.min(20000, Number(limit) || 10000));
    const rows = this.db.prepare('SELECT data_json FROM online_library ORDER BY COALESCE(last_opened_at, updated_at) DESC, title COLLATE NOCASE ASC LIMIT ?').all(cap);
    const items = rows.map((row) => parseJson(row.data_json, null)).filter(Boolean);
    if (!needle) return items;
    return items.filter((item) => String(item.title || '').toLowerCase().includes(needle) || String(item.seriesUrl || '').toLowerCase().includes(needle) || String(item.source || '').toLowerCase().includes(needle));
  }
  setOnlineLibrary(input = {}) {
    const rawUrl = String(input.seriesUrl || input.url || '').trim();
    if (!rawUrl) throw new Error('Serien-URL fehlt.');
    const key = normUrl(rawUrl);
    const current = this.getOnlineLibraryEntry(rawUrl) || {};
    const now = new Date().toISOString();
    const item = {
      seriesUrl: rawUrl,
      title: String(input.title || current.title || rawUrl).trim(),
      cover: input.cover ?? current.cover ?? null,
      status: input.status ?? current.status ?? 'unknown',
      language: input.language ?? current.language ?? null,
      source: input.source ?? current.source ?? null,
      lastChapterTitle: Object.prototype.hasOwnProperty.call(input, 'lastChapterTitle') ? input.lastChapterTitle : (current.lastChapterTitle ?? null),
      lastChapterUrl: Object.prototype.hasOwnProperty.call(input, 'lastChapterUrl') ? input.lastChapterUrl : (current.lastChapterUrl ?? null),
      lastOpenedAt: Object.prototype.hasOwnProperty.call(input, 'lastOpenedAt') ? input.lastOpenedAt : (current.lastOpenedAt ?? null),
      readChapters: Array.isArray(input.readChapters) ? input.readChapters : (Array.isArray(current.readChapters) ? current.readChapters : []),
      addedAt: current.addedAt || now,
      updatedAt: now
    };
    this.db.prepare(`INSERT INTO online_library(series_key,series_url,title,cover,status,language,source,last_chapter_title,last_chapter_url,last_opened_at,data_json,added_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(series_key) DO UPDATE SET series_url=excluded.series_url,title=excluded.title,cover=excluded.cover,status=excluded.status,language=excluded.language,source=excluded.source,last_chapter_title=excluded.last_chapter_title,last_chapter_url=excluded.last_chapter_url,last_opened_at=excluded.last_opened_at,data_json=excluded.data_json,updated_at=excluded.updated_at`)
      .run(key, item.seriesUrl, item.title, item.cover || null, String(item.status || 'unknown'), item.language || null, item.source || null, item.lastChapterTitle || null, item.lastChapterUrl || null, item.lastOpenedAt || null, toJson(item), item.addedAt, item.updatedAt);
    return clone(item);
  }
  removeOnlineLibrary(seriesUrl) {
    return this.db.prepare('DELETE FROM online_library WHERE series_key=?').run(normUrl(seriesUrl)).changes > 0;
  }
  _onlineChapterKey(chapter = {}) {
    const url = normUrl(chapter.url || chapter.chapterUrl || '');
    if (url) return `url:${url}`;
    const id = String(chapter.id || chapter.chapterId || '').trim();
    if (id) return `id:${id}`;
    const title = String(chapter.title || chapter.chapterTitle || '').trim().toLowerCase();
    return title ? `title:${title}` : '';
  }
  markOnlineLibraryRead(seriesUrl, chapter = {}) {
    const current = this.getOnlineLibraryEntry(seriesUrl);
    if (!current) return null;
    const now = new Date().toISOString();
    const key = this._onlineChapterKey(chapter);
    const readChapters = Array.isArray(current.readChapters) ? [...current.readChapters] : [];
    if (key) {
      const record = {
        id: String(chapter.id || chapter.chapterId || '').trim() || null,
        title: String(chapter.title || chapter.chapterTitle || '').trim() || null,
        url: String(chapter.url || chapter.chapterUrl || '').trim() || null,
        readAt: now
      };
      const index = readChapters.findIndex((item) => this._onlineChapterKey(item) === key);
      if (index >= 0) readChapters[index] = { ...readChapters[index], ...record };
      else readChapters.push(record);
    }
    return this.setOnlineLibrary({
      ...current,
      seriesUrl: current.seriesUrl || seriesUrl,
      lastChapterTitle: chapter.title || chapter.chapterTitle || current.lastChapterTitle || null,
      lastChapterUrl: chapter.url || chapter.chapterUrl || current.lastChapterUrl || null,
      lastOpenedAt: now,
      readChapters
    });
  }
  markOnlineLibraryUnread(seriesUrl, chapter = {}) {
    const current = this.getOnlineLibraryEntry(seriesUrl);
    if (!current) return null;
    const key = this._onlineChapterKey(chapter);
    if (!key) return clone(current);
    const readChapters = (Array.isArray(current.readChapters) ? current.readChapters : [])
      .filter((item) => this._onlineChapterKey(item) !== key);
    const lastKey = this._onlineChapterKey({ title: current.lastChapterTitle, url: current.lastChapterUrl });
    let lastChapterTitle = current.lastChapterTitle || null;
    let lastChapterUrl = current.lastChapterUrl || null;
    let lastOpenedAt = current.lastOpenedAt || null;
    if (lastKey && lastKey === key) {
      const newest = [...readChapters].sort((a, b) => String(b.readAt || '').localeCompare(String(a.readAt || '')))[0] || null;
      lastChapterTitle = newest?.title || null;
      lastChapterUrl = newest?.url || null;
      lastOpenedAt = newest?.readAt || null;
    }
    return this.setOnlineLibrary({ ...current, seriesUrl: current.seriesUrl || seriesUrl, readChapters, lastChapterTitle, lastChapterUrl, lastOpenedAt });
  }

  // Update news dashboard ----------------------------------------------------
  recordUpdateSummary(summary = {}) {
    const scanId = crypto.randomUUID();
    const foundAt = new Date().toISOString();
    const rows = (Array.isArray(summary.series) ? summary.series : []).filter((row) => Number(row?.newChapters || 0) > 0);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const item = {
          id: crypto.randomUUID(), scanId, seriesUrl: String(row.url || ''), title: String(row.title || row.url || 'Serie'),
          newChapters: Number(row.newChapters || 0), downloaded: Number(row.downloaded || 0), errors: Array.isArray(row.errors) ? row.errors : [],
          status: row.status || null, seriesStatus: row.seriesStatus || null, foundAt, seenAt: null
        };
        this.db.prepare('INSERT INTO news(id,scan_id,series_key,series_url,series_title,new_chapters,downloaded,errors_json,found_at,seen_at,data_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(item.id, scanId, normUrl(item.seriesUrl), item.seriesUrl, item.title, item.newChapters, item.downloaded, toJson(item.errors), foundAt, null, toJson(item));
      }
      this._setMeta('last_update_scan_id', scanId);
      this._setMeta('last_update_scan_at', foundAt);
      this._setMeta('last_update_scan_summary', toJson({ checkedSeries: summary.checkedSeries || 0, updatedSeries: summary.updatedSeries || 0, newChapters: summary.newChapters || 0, downloadedChapters: summary.downloadedChapters || 0, errors: summary.errors || 0 }));
      // Keep the DB tidy: 90 days or 2000 rows, whichever is smaller.
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      this.db.prepare('DELETE FROM news WHERE found_at < ?').run(cutoff);
      this.db.exec(`DELETE FROM news WHERE id IN (SELECT id FROM news ORDER BY found_at DESC LIMIT -1 OFFSET 2000)`);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { scanId, foundAt, count: rows.length };
  }
  listNews({ latestOnly = true, limit = 300 } = {}) {
    const cap = Math.max(1, Math.min(1000, Number(limit) || 300));
    const latest = this._getMeta('last_update_scan_id');
    const rows = latestOnly && latest
      ? this.db.prepare('SELECT data_json,seen_at FROM news WHERE scan_id=? ORDER BY found_at DESC LIMIT ?').all(latest, cap)
      : this.db.prepare('SELECT data_json,seen_at FROM news ORDER BY found_at DESC LIMIT ?').all(cap);
    return rows.map((row) => ({ ...parseJson(row.data_json, {}), seenAt: row.seen_at || parseJson(row.data_json, {})?.seenAt || null }));
  }
  getNewsSummary() {
    const latest = this._getMeta('last_update_scan_id');
    const scanAt = this._getMeta('last_update_scan_at');
    const scanSummary = parseJson(this._getMeta('last_update_scan_summary'), {});
    const unread = latest ? Number(this.db.prepare('SELECT COUNT(*) AS count FROM news WHERE scan_id=? AND seen_at IS NULL').get(latest)?.count || 0) : 0;
    const latestCount = latest ? Number(this.db.prepare('SELECT COUNT(*) AS count FROM news WHERE scan_id=?').get(latest)?.count || 0) : 0;
    return { latestScanId: latest, latestScanAt: scanAt, unread, latestCount, ...scanSummary };
  }
  markNewsSeen({ latestOnly = true } = {}) {
    const seenAt = new Date().toISOString();
    const latest = this._getMeta('last_update_scan_id');
    if (latestOnly && latest) this.db.prepare('UPDATE news SET seen_at=? WHERE scan_id=?').run(seenAt, latest);
    else this.db.prepare('UPDATE news SET seen_at=? WHERE seen_at IS NULL').run(seenAt);
    return this.getNewsSummary();
  }

  exportSnapshot() {
    return {
      settings: this.getSettings(),
      series: this.listSeries(),
      downloads: this.listDownloads({ limit: 5000 }),
      websites: this.listWebsites(),
      syncSeries: this.listSyncSeries(),
      seriesStatusCache: this.listSeriesStatuses({ maxAgeMs: 0 }),
      readingList: this.listReadingList({ mode: 'all' }),
      onlineLibrary: this.listOnlineLibrary({ limit: 20000 }),
      news: this.listNews({ latestOnly: false, limit: 2000 }),
      storage: { engine: 'sqlite', schemaVersion: 2, exportedAt: new Date().toISOString() }
    };
  }

  importSnapshot(snapshot, { clear = false } = {}) {
    const data = snapshot && typeof snapshot === 'object' ? snapshot : {};
    if (clear) {
      this.db.exec('DELETE FROM settings; DELETE FROM series; DELETE FROM downloads; DELETE FROM websites; DELETE FROM sync_series; DELETE FROM series_status; DELETE FROM reading_list; DELETE FROM online_library; DELETE FROM news;');
    }
    this._ensureDefaultSettings();
    this.setSettings(data.settings || {});
    for (const item of Array.isArray(data.series) ? data.series : []) {
      const existing = this.db.prepare('SELECT id FROM series WHERE url_key=?').get(normUrl(item.url));
      if (!existing) {
        const now = new Date().toISOString();
        const normalized = { ...item, id: item.id || crypto.randomUUID() };
        this.db.prepare('INSERT INTO series(id,url_key,url,title,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(normalized.id, normUrl(normalized.url), String(normalized.url || ''), String(normalized.title || 'Serie'), toJson(normalized), now, now);
      } else this.updateSeries(existing.id, item);
    }
    for (const item of Array.isArray(data.downloads) ? data.downloads : []) this.markDownloaded(item);
    for (const item of Array.isArray(data.websites) ? data.websites : []) this.addWebsite(item);
    for (const item of Array.isArray(data.syncSeries) ? data.syncSeries : []) this.setSeriesSync({ ...item, enabled: true });
    for (const item of Array.isArray(data.seriesStatusCache) ? data.seriesStatusCache : []) this.setSeriesStatus(item.seriesUrl, item.status, item);
    for (const item of Array.isArray(data.readingList) ? data.readingList : []) this.setReadingList(item);
    for (const item of Array.isArray(data.onlineLibrary) ? data.onlineLibrary : []) this.setOnlineLibrary(item);
    // Legacy snapshots did not have a news feed. New snapshots do; import the rows directly.
    for (const item of Array.isArray(data.news) ? data.news : []) {
      const scanId = item.scanId || 'imported'; const id = item.id || crypto.randomUUID();
      this.db.prepare('INSERT OR REPLACE INTO news(id,scan_id,series_key,series_url,series_title,new_chapters,downloaded,errors_json,found_at,seen_at,data_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, scanId, normUrl(item.seriesUrl), String(item.seriesUrl || ''), String(item.title || 'Serie'), Number(item.newChapters || 0), Number(item.downloaded || 0), toJson(item.errors || []), item.foundAt || new Date().toISOString(), item.seenAt || null, toJson(item));
    }
    this._setMeta('schema_version', '2');
    this._setMeta('storage_engine', 'sqlite');
    return this.exportSnapshot();
  }
}

module.exports = Store;
