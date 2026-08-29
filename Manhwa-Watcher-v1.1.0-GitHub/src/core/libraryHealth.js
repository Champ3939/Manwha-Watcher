const fs = require('fs');
const path = require('path');

function safeName(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim() || 'untitled';
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function statSafe(file) {
  try { return await fs.promises.stat(file); } catch { return null; }
}

async function diskStats(target) {
  const raw = String(target || '').trim();
  if (!raw) return { total: 0, free: 0, used: 0, available: false };
  try {
    await fs.promises.mkdir(raw, { recursive: true });
    if (typeof fs.promises.statfs !== 'function') return { total: 0, free: 0, used: 0, available: false };
    const info = await fs.promises.statfs(raw);
    const blockSize = toNumber(info.bsize || info.frsize || 0);
    const total = blockSize * toNumber(info.blocks);
    const free = blockSize * toNumber(info.bavail ?? info.bfree);
    return { total, free, used: Math.max(0, total - free), available: total > 0 };
  } catch {
    return { total: 0, free: 0, used: 0, available: false };
  }
}

async function walkDirectory(root, visitor) {
  const stack = [root];
  while (stack.length) {
    const folder = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(folder, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) await visitor(full, entry);
    }
  }
}

function parseChapterNumber(name) {
  const base = path.basename(String(name || ''), path.extname(String(name || '')));
  const match = base.match(/(?:^|\b)(?:chapter|chap(?:ter)?|ch)\s*[-_. ]*([0-9]+(?:[.,][0-9]+)?)(?:\b|$)/i)
    || base.match(/^\s*([0-9]+(?:[.,][0-9]+)?)\s*$/);
  if (!match) return null;
  const value = Number(String(match[1]).replace(',', '.'));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function findMissingIntegers(chapterNumbers) {
  const ints = [...new Set(chapterNumbers.filter((n) => Number.isInteger(n)).map(Number))].sort((a, b) => a - b);
  if (ints.length < 3) return [];
  const first = ints[0];
  const last = ints[ints.length - 1];
  if (last - first > 5000) return [];
  const set = new Set(ints);
  const missing = [];
  for (let n = first; n <= last; n += 1) {
    if (!set.has(n)) missing.push(n);
    if (missing.length >= 200) break;
  }
  return missing;
}

async function inspectCbz(file) {
  const stat = await statSafe(file);
  if (!stat?.isFile()) return { ok: false, error: 'Datei nicht gefunden.', entries: 0, hasComicInfo: false, imageCount: 0 };
  if (stat.size < 22) return { ok: false, error: 'Datei ist leer oder zu klein für ein ZIP/CBZ.', entries: 0, hasComicInfo: false, imageCount: 0 };
  let handle;
  try {
    handle = await fs.promises.open(file, 'r');
    const tailLength = Math.min(stat.size, 66000);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, stat.size - tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054B50) { eocd = i; break; }
    }
    if (eocd < 0) return { ok: false, error: 'ZIP-Endverzeichnis (EOCD) fehlt.', entries: 0, hasComicInfo: false, imageCount: 0 };
    const entries = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (!entries) return { ok: false, error: 'CBZ enthält keine Dateien.', entries: 0, hasComicInfo: false, imageCount: 0 };
    if (centralOffset + centralSize > stat.size) return { ok: false, error: 'ZIP-Zentralverzeichnis liegt außerhalb der Datei.', entries, hasComicInfo: false, imageCount: 0 };
    if (centralSize > 128 * 1024 * 1024) return { ok: false, error: 'ZIP-Zentralverzeichnis ist ungewöhnlich groß.', entries, hasComicInfo: false, imageCount: 0 };

    const central = Buffer.alloc(centralSize);
    await handle.read(central, 0, centralSize, centralOffset);
    let cursor = 0;
    let parsed = 0;
    let hasComicInfo = false;
    let imageCount = 0;
    while (cursor + 46 <= central.length && parsed < entries) {
      if (central.readUInt32LE(cursor) !== 0x02014B50) return { ok: false, error: `ZIP-Zentralverzeichnis ist bei Eintrag ${parsed + 1} beschädigt.`, entries, hasComicInfo, imageCount };
      const compressedSize = central.readUInt32LE(cursor + 20);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const localOffset = central.readUInt32LE(cursor + 42);
      if (localOffset >= stat.size) return { ok: false, error: `ZIP-Eintrag ${parsed + 1} verweist außerhalb der Datei.`, entries, hasComicInfo, imageCount };
      const nameStart = cursor + 46;
      const nameEnd = nameStart + nameLength;
      if (nameEnd > central.length) return { ok: false, error: 'ZIP-Dateiname ist abgeschnitten.', entries, hasComicInfo, imageCount };
      const filename = central.subarray(nameStart, nameEnd).toString('utf8');
      if (/^(?:.*\/)?ComicInfo\.xml$/i.test(filename)) hasComicInfo = true;
      if (/\.(?:jpe?g|png|webp|gif|avif)$/i.test(filename)) imageCount += 1;
      if (compressedSize > stat.size) return { ok: false, error: `ZIP-Eintrag „${filename}“ hat eine ungültige Größe.`, entries, hasComicInfo, imageCount };
      cursor = nameEnd + extraLength + commentLength;
      parsed += 1;
    }
    if (parsed !== entries) return { ok: false, error: `ZIP meldet ${entries} Einträge, ${parsed} konnten gelesen werden.`, entries, hasComicInfo, imageCount };
    if (!imageCount) return { ok: false, error: 'CBZ enthält keine erkannten Bildseiten.', entries, hasComicInfo, imageCount };
    return { ok: true, entries, hasComicInfo, imageCount, size: stat.size };
  } catch (error) {
    return { ok: false, error: String(error?.message || error || 'Unbekannter ZIP-Fehler'), entries: 0, hasComicInfo: false, imageCount: 0 };
  } finally {
    try { await handle?.close(); } catch {}
  }
}

async function scanFolderSummary(root, { collectSeries = false, deep = false, onProgress = () => {} } = {}) {
  const cleanRoot = String(root || '').trim();
  const summary = {
    root: cleanRoot,
    exists: false,
    bytes: 0,
    fileCount: 0,
    cbzCount: 0,
    seriesCount: 0,
    partCount: 0,
    metadataMissing: 0,
    corruptCount: 0,
    series: [],
    problems: [],
    missing: []
  };
  if (!cleanRoot) return summary;
  const rootStat = await statSafe(cleanRoot);
  if (!rootStat?.isDirectory()) return summary;
  summary.exists = true;

  let rootEntries = [];
  try { rootEntries = await fs.promises.readdir(cleanRoot, { withFileTypes: true }); } catch { return summary; }
  const seriesDirs = rootEntries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
  summary.seriesCount = seriesDirs.length;

  for (let index = 0; index < seriesDirs.length; index += 1) {
    const entry = seriesDirs[index];
    const seriesFolder = path.join(cleanRoot, entry.name);
    const row = { title: entry.name, folder: seriesFolder, bytes: 0, cbzCount: 0, fileCount: 0, partCount: 0, metadataMissing: 0, corruptCount: 0, missing: [] };
    const topChapterNumbers = [];
    let topEntries = [];
    try { topEntries = await fs.promises.readdir(seriesFolder, { withFileTypes: true }); } catch {}
    for (const top of topEntries) {
      if ((top.isFile() && /\.cbz$/i.test(top.name)) || top.isDirectory()) {
        const chapter = parseChapterNumber(top.name);
        if (chapter != null) topChapterNumbers.push(chapter);
      }
    }
    row.missing = findMissingIntegers(topChapterNumbers);
    if (row.missing.length) {
      summary.missing.push({ title: row.title, folder: row.folder, missing: row.missing });
      summary.problems.push({ type: 'missing', severity: 'warning', seriesTitle: row.title, folder: row.folder, message: `Möglicherweise fehlende Kapitel: ${row.missing.slice(0, 30).join(', ')}${row.missing.length > 30 ? ' …' : ''}`, missing: row.missing });
    }

    await walkDirectory(seriesFolder, async (file) => {
      const stat = await statSafe(file);
      if (!stat?.isFile()) return;
      row.bytes += stat.size;
      row.fileCount += 1;
      summary.bytes += stat.size;
      summary.fileCount += 1;
      if (/\.cbz$/i.test(file)) {
        row.cbzCount += 1;
        summary.cbzCount += 1;
        if (deep) {
          const check = await inspectCbz(file);
          if (!check.ok) {
            row.corruptCount += 1;
            summary.corruptCount += 1;
            summary.problems.push({ type: 'corrupt', severity: 'error', seriesTitle: row.title, file, folder: row.folder, message: check.error });
          } else if (!check.hasComicInfo) {
            row.metadataMissing += 1;
            summary.metadataMissing += 1;
            summary.problems.push({ type: 'metadata', severity: 'info', seriesTitle: row.title, file, folder: row.folder, imageCount: check.imageCount || 0, message: 'ComicInfo.xml fehlt und kann automatisch ergänzt werden.' });
          }
        }
      } else if (/\.cbz\.part$|\.part$/i.test(file)) {
        row.partCount += 1;
        summary.partCount += 1;
        summary.problems.push({ type: 'partial', severity: 'warning', seriesTitle: row.title, file, folder: row.folder, message: 'Unvollständige .part-Datei gefunden.' });
      }
    });
    if (collectSeries) summary.series.push(row);
    if (index === 0 || (index + 1) % 5 === 0 || index === seriesDirs.length - 1) {
      onProgress({ current: index + 1, total: seriesDirs.length, title: row.title, cbzCount: summary.cbzCount, bytes: summary.bytes, corruptCount: summary.corruptCount });
    }
  }

  // Also count loose files directly under the root, without treating them as series.
  for (const entry of rootEntries) {
    if (!entry.isFile()) continue;
    const file = path.join(cleanRoot, entry.name);
    const stat = await statSafe(file);
    if (!stat?.isFile()) continue;
    summary.bytes += stat.size;
    summary.fileCount += 1;
  }

  if (collectSeries) summary.series.sort((a, b) => b.bytes - a.bytes || a.title.localeCompare(b.title, 'de', { numeric: true }));
  return summary;
}

class LibraryHealth {
  constructor({ store, logger = null, onEvent = () => {} }) {
    this.store = store;
    this.logger = logger;
    this.onEvent = onEvent;
    this.running = false;
    this.lastResult = null;
  }

  status() { return { running: this.running, lastResult: this.lastResult }; }

  async scan({ deep = false } = {}) {
    if (this.running) throw new Error('Eine Bibliotheksprüfung läuft bereits.');
    this.running = true;
    const startedAt = new Date().toISOString();
    const settings = this.store.getSettings();
    const downloadRoot = String(settings.downloadRoot || '').trim();
    const syncRoot = String(settings.syncRoot || '').trim();
    this.onEvent({ type: 'library-scan-start', deep, downloadRoot, syncRoot });
    this.logger?.info('Bibliotheksprüfung gestartet', { deep, downloadRoot, syncRoot });
    try {
      const library = await scanFolderSummary(downloadRoot, {
        collectSeries: true,
        deep,
        onProgress: (progress) => this.onEvent({ type: 'library-scan-progress', deep, ...progress })
      });
      const [disk, sync, syncDisk] = await Promise.all([
        diskStats(downloadRoot),
        scanFolderSummary(syncRoot, { collectSeries: false, deep: false }),
        diskStats(syncRoot)
      ]);
      const knownDownloads = this.store.listDownloads({ limit: 5000 });
      const syncTargets = this.store.listSyncSeries();
      const result = {
        startedAt,
        finishedAt: new Date().toISOString(),
        deep,
        library,
        disk,
        sync: { ...sync, disk: syncDisk, targetCount: syncTargets.length },
        knownDownloads: knownDownloads.length,
        largestSeries: library.series.slice(0, 20),
        issueCount: library.problems.length
      };
      this.lastResult = result;
      this.onEvent({ type: 'library-scan-done', result });
      this.logger?.info('Bibliotheksprüfung beendet', { deep, series: library.seriesCount, cbz: library.cbzCount, bytes: library.bytes, issues: result.issueCount, corrupt: library.corruptCount, missingSeries: library.missing.length });
      return result;
    } catch (error) {
      this.onEvent({ type: 'library-scan-error', message: String(error?.message || error) });
      this.logger?.error('Bibliotheksprüfung fehlgeschlagen', { message: String(error?.message || error) });
      throw error;
    } finally {
      this.running = false;
    }
  }
}

module.exports = { LibraryHealth, inspectCbz, parseChapterNumber, findMissingIntegers, diskStats, scanFolderSummary, safeName };
