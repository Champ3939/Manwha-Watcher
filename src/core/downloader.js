const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildComicInfoXml } = require('./comicInfo');

function safeName(value) {
  return String(value)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim() || 'untitled';
}

function extensionFrom(url, contentType, fallback = '.jpg') {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (/^\.(jpg|jpeg|png|webp|gif|avif|svg)$/.test(ext)) return ext;
  } catch {}
  const map = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
    'image/gif': '.gif', 'image/avif': '.avif', 'image/svg+xml': '.svg'
  };
  return map[(contentType || '').split(';')[0].trim()] || fallback;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// CBZ is a normal ZIP archive. Comic pages are already compressed image formats,
// so storing them without an additional DEFLATE pass is fast and avoids dependencies.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const dosTime = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1F);
  const dosDate = (((year - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0x0F) << 5) | (date.getDate() & 0x1F);
  return { dosTime, dosDate };
}

class CbzWriter {
  constructor(filePath) {
    this.filePath = filePath;
    this.fd = fs.openSync(filePath, 'w');
    this.offset = 0;
    this.entries = [];
    this.closed = false;
  }

  write(buffer) {
    fs.writeSync(this.fd, buffer, 0, buffer.length, this.offset);
    this.offset += buffer.length;
  }

  addFile(filename, data) {
    const name = Buffer.from(String(filename).replace(/\\/g, '/'), 'utf8');
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const size = buffer.length;
    if (size > 0xFFFFFFFF || this.offset > 0xFFFFFFFF) throw new Error('Kapitel ist zu groß für das CBZ/ZIP32-Format.');
    const crc = crc32(buffer);
    const { dosTime, dosDate } = dosDateTime();
    const localOffset = this.offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034B50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(size, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    this.write(header);
    this.write(name);
    this.write(buffer);
    this.entries.push({ name, crc, size, dosTime, dosDate, localOffset });
  }

  finalize() {
    if (this.closed) return;
    const centralOffset = this.offset;
    for (const entry of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014B50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(entry.dosTime, 12);
      header.writeUInt16LE(entry.dosDate, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.size, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(entry.localOffset, 42);
      this.write(header);
      this.write(entry.name);
    }
    const centralSize = this.offset - centralOffset;
    if (this.entries.length > 0xFFFF || centralOffset > 0xFFFFFFFF || centralSize > 0xFFFFFFFF) throw new Error('Kapitel ist zu groß für das CBZ/ZIP32-Format.');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054B50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralOffset, 16);
    end.writeUInt16LE(0, 20);
    this.write(end);
    fs.closeSync(this.fd);
    this.closed = true;
  }

  abort() {
    if (!this.closed) {
      try { fs.closeSync(this.fd); } catch {}
      this.closed = true;
    }
    try { fs.rmSync(this.filePath, { force: true }); } catch {}
  }
}

class Downloader {
  constructor(fetchBinary, onEvent = () => {}, getSettings = () => ({})) {
    this.fetchBinary = fetchBinary;
    this.onEvent = onEvent;
    this.getSettings = getSettings;
    this.queue = Promise.resolve();
    this.queueItems = [];
    this.queueJobs = new Map();
  }

  publicQueueItem(item) {
    if (!item) return null;
    const { job: _job, ...safe } = item;
    return structuredClone(safe);
  }

  listQueue({ limit = 300 } = {}) {
    const cap = Math.max(1, Math.min(2000, Number(limit) || 300));
    return this.queueItems.slice(-cap).map((item) => this.publicQueueItem(item)).reverse();
  }

  emitQueue(item, type = 'queue-item-updated') {
    this.onEvent({ type, item: this.publicQueueItem(item) });
  }

  trimQueue() {
    if (this.queueItems.length <= 500) return;
    const active = this.queueItems.filter((item) => item.status === 'queued' || item.status === 'running');
    const finished = this.queueItems.filter((item) => item.status !== 'queued' && item.status !== 'running').slice(-350);
    this.queueItems = [...finished, ...active].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const keep = new Set(this.queueItems.map((item) => item.id));
    for (const id of this.queueJobs.keys()) if (!keep.has(id)) this.queueJobs.delete(id);
  }

  enqueue(job, { retryOf = null } = {}) {
    const id = crypto.randomUUID();
    const item = {
      id,
      retryOf,
      seriesId: String(job?.series?.id ?? ''),
      chapterId: String(job?.chapter?.id ?? ''),
      seriesTitle: String(job?.series?.title || 'Unbenannte Serie'),
      chapterTitle: String(job?.chapter?.title || `Chapter ${job?.chapter?.id ?? ''}`),
      status: 'queued',
      current: 0,
      total: Array.isArray(job?.pages) ? job.pages.length : 0,
      bulk: Boolean(job?.bulk),
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
      file: null
    };
    this.queueItems.push(item);
    this.queueJobs.set(id, job);
    this.trimQueue();
    this.emitQueue(item, 'queue-item-added');

    const task = this.queue.then(async () => {
      item.status = 'running';
      item.startedAt = new Date().toISOString();
      this.emitQueue(item);
      try {
        const result = await this.downloadChapter(job, item);
        item.status = 'done';
        item.current = item.total || result.pageCount || 0;
        item.total = result.pageCount || item.total || 0;
        item.file = result.file || null;
        item.finishedAt = new Date().toISOString();
        this.emitQueue(item);
        return result;
      } catch (error) {
        item.status = 'failed';
        item.error = String(error?.message || error || 'Unbekannter Fehler');
        item.finishedAt = new Date().toISOString();
        this.emitQueue(item, 'queue-item-error');
        throw error;
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }

  retryQueueItem(id) {
    const item = this.queueItems.find((entry) => entry.id === id);
    const job = this.queueJobs.get(id);
    if (!item || !job) throw new Error('Downloadjob ist nicht mehr verfügbar.');
    if (item.status !== 'failed') throw new Error('Nur fehlgeschlagene Downloads können erneut versucht werden.');
    return this.enqueue(job, { retryOf: id });
  }

  clearFinishedQueue() {
    const keep = this.queueItems.filter((item) => item.status === 'queued' || item.status === 'running');
    const keepIds = new Set(keep.map((item) => item.id));
    this.queueItems = keep;
    for (const id of this.queueJobs.keys()) if (!keepIds.has(id)) this.queueJobs.delete(id);
    this.onEvent({ type: 'queue-cleared' });
    return this.listQueue();
  }

  async fetchWithRetry(page) {
    const settings = this.getSettings();
    const retries = Math.max(0, Math.min(5, Number(settings.maxRetries) || 2));
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.fetchBinary(page.url, { referer: page.referer, headers: page.headers });
      } catch (error) {
        lastError = error;
        if (attempt < retries) await sleep(750 * (attempt + 1));
      }
    }
    throw lastError;
  }

  async downloadChapter({ series, chapter, pages, root, bulk = false }, queueItem = null) {
    if (!Array.isArray(pages) || !pages.length) throw new Error('Für dieses Kapitel wurden keine Reader-Seiten gefunden.');
    const seriesFolder = path.join(root, safeName(series.title));
    fs.mkdirSync(seriesFolder, { recursive: true });
    const cbzPath = path.join(seriesFolder, `${safeName(chapter.title)}.cbz`);
    const tempPath = `${cbzPath}.part`;
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    const writer = new CbzWriter(tempPath);
    this.onEvent({ type: 'chapter-start', seriesId: series.id, chapterId: chapter.id, folder: seriesFolder, file: cbzPath, total: pages.length, seriesTitle: series.title, chapterTitle: chapter.title, format: 'cbz', bulk: Boolean(bulk) });
    const settings = this.getSettings();
    const delay = Math.max(0, Math.min(10000, Number(settings.requestDelayMs) || 0));

    let written = 0;
    try {
      for (let i = 0; i < pages.length; i += 1) {
        const page = pages[i];
        if (!page?.url) continue;
        if (queueItem) {
          queueItem.current = written;
          queueItem.total = pages.length;
          this.emitQueue(queueItem);
        }
        this.onEvent({ type: 'page-start', seriesId: series.id, chapterId: chapter.id, current: i + 1, total: pages.length, url: page.url, bulk: Boolean(bulk) });
        const result = await this.fetchWithRetry(page);
        const ext = extensionFrom(page.url, result.contentType);
        const filename = `${String(written + 1).padStart(3, '0')}${ext}`;
        writer.addFile(filename, result.buffer);
        written += 1;
        if (queueItem) {
          queueItem.current = written;
          queueItem.total = pages.length;
          this.emitQueue(queueItem);
        }
        this.onEvent({ type: 'page-done', seriesId: series.id, chapterId: chapter.id, current: i + 1, total: pages.length, filename, bulk: Boolean(bulk) });
        if (delay && i < pages.length - 1) await sleep(delay);
      }
      if (!written) throw new Error('Keine gültigen Bildseiten heruntergeladen.');
      // ComicInfo.xml is metadata-only; the first story image stays 001.
      writer.addFile('ComicInfo.xml', buildComicInfoXml({ series, chapter, pageCount: written, generator: 'Manhwa Watcher v1.0.2' }));
      writer.finalize();
      try { fs.rmSync(cbzPath, { force: true }); } catch {}
      fs.renameSync(tempPath, cbzPath);
    } catch (error) {
      writer.abort();
      throw error;
    }

    this.onEvent({ type: 'chapter-done', seriesId: series.id, chapterId: chapter.id, folder: seriesFolder, file: cbzPath, chapterTitle: chapter.title, seriesTitle: series.title, pageCount: written, format: 'cbz', bulk: Boolean(bulk) });
    return { folder: seriesFolder, file: cbzPath, pageCount: written, format: 'cbz' };
  }
}

module.exports = Downloader;
