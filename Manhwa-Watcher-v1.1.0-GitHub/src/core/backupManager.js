const fs = require('fs');
const path = require('path');

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
  return {
    dosTime: ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | (Math.floor(date.getSeconds() / 2) & 0x1F),
    dosDate: (((year - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0x0F) << 5) | (date.getDate() & 0x1F)
  };
}

function normalizeZipName(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((part) => part === '..')) throw new Error(`Ungültiger ZIP-Pfad: ${value}`);
  return normalized;
}

function writeStoredZip(filePath, entries) {
  const fd = fs.openSync(filePath, 'w');
  let offset = 0;
  const central = [];
  const write = (buffer) => { fs.writeSync(fd, buffer, 0, buffer.length, offset); offset += buffer.length; };
  try {
    for (const rawEntry of entries) {
      const filename = normalizeZipName(rawEntry.name);
      const name = Buffer.from(filename, 'utf8');
      const data = Buffer.isBuffer(rawEntry.data) ? rawEntry.data : Buffer.from(String(rawEntry.data ?? ''), 'utf8');
      const crc = crc32(data);
      const { dosTime, dosDate } = dosDateTime();
      const localOffset = offset;
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034B50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(0, 8);
      header.writeUInt16LE(dosTime, 10); header.writeUInt16LE(dosDate, 12); header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26); header.writeUInt16LE(0, 28);
      write(header); write(name); write(data);
      central.push({ name, dataLength: data.length, crc, dosTime, dosDate, localOffset });
    }
    const centralOffset = offset;
    for (const entry of central) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014B50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x0800, 8); header.writeUInt16LE(0, 10);
      header.writeUInt16LE(entry.dosTime, 12); header.writeUInt16LE(entry.dosDate, 14); header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.dataLength, 20); header.writeUInt32LE(entry.dataLength, 24); header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt16LE(0, 30); header.writeUInt16LE(0, 32); header.writeUInt16LE(0, 34); header.writeUInt16LE(0, 36); header.writeUInt32LE(0, 38); header.writeUInt32LE(entry.localOffset, 42);
      write(header); write(entry.name);
    }
    const centralSize = offset - centralOffset;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054B50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(centralOffset, 16); end.writeUInt16LE(0, 20); write(end);
  } finally { fs.closeSync(fd); }
}

function readStoredZip(filePath) {
  const buffer = fs.readFileSync(filePath);
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const sig = buffer.readUInt32LE(offset);
    if (sig === 0x02014B50 || sig === 0x06054B50) break;
    if (sig !== 0x04034B50) throw new Error('Backup-ZIP hat ein unbekanntes Format.');
    if (offset + 30 > buffer.length) throw new Error('Backup-ZIP ist beschädigt.');
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    if (flags & 0x0008) throw new Error('Backup-ZIP mit Data-Descriptor wird nicht unterstützt.');
    if (method !== 0) throw new Error('Backup-ZIP muss von Manhwa Watcher erstellt worden sein (Store-ZIP).');
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length || uncompressedSize !== compressedSize) throw new Error('Backup-ZIP ist beschädigt.');
    const name = normalizeZipName(buffer.subarray(nameStart, nameStart + nameLength).toString('utf8'));
    entries.set(name, Buffer.from(buffer.subarray(dataStart, dataEnd)));
    offset = dataEnd;
  }
  return entries;
}

function walkFiles(root, relative = '') {
  const dir = path.join(root, relative);
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(root, rel));
    else if (entry.isFile()) result.push(rel);
  }
  return result;
}

class BackupManager {
  constructor({ dataDir, connectorDir, store = null, logger = null, appVersion = '1.0.0' }) {
    this.dataDir = dataDir;
    this.connectorDir = connectorDir;
    this.store = store;
    this.logger = logger;
    this.appVersion = appVersion;
  }

  exportTo(filePath) {
    const database = path.join(this.dataDir, 'library.db');
    this.store?.checkpoint?.();
    if (!fs.existsSync(database)) throw new Error('library.db wurde nicht gefunden.');
    const snapshot = this.store?.exportSnapshot?.() || null;
    const entries = [
      { name: 'backup-manifest.json', data: JSON.stringify({ format: 'manhwa-watcher-backup-v2', storage: 'sqlite', appVersion: this.appVersion, createdAt: new Date().toISOString() }, null, 2) },
      { name: 'library.db', data: fs.readFileSync(database) }
    ];
    if (snapshot) entries.push({ name: 'library.json', data: JSON.stringify(snapshot, null, 2) });
    let connectorCount = 0;
    for (const rel of walkFiles(this.connectorDir)) {
      if (!/\.json$/i.test(rel)) continue;
      entries.push({ name: `Connectors/${rel.replace(/\\/g, '/')}`, data: fs.readFileSync(path.join(this.connectorDir, rel)) });
      connectorCount += 1;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeStoredZip(filePath, entries);
    this.logger?.info('SQLite-Backup exportiert', { file: filePath, connectors: connectorCount });
    return { file: filePath, connectorCount, createdAt: new Date().toISOString(), storage: 'sqlite' };
  }

  restoreFrom(filePath) {
    const entries = readStoredZip(filePath);
    const databaseData = entries.get('library.db');
    const legacyData = entries.get('library.json');
    if (!databaseData && !legacyData) throw new Error('Das Backup enthält weder library.db noch library.json.');

    // Close SQLite before replacing the file. The caller re-opens it via store.load().
    this.store?.close?.();
    fs.mkdirSync(this.dataDir, { recursive: true });
    const currentDatabase = path.join(this.dataDir, 'library.db');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (fs.existsSync(currentDatabase)) fs.copyFileSync(currentDatabase, path.join(this.dataDir, `library.before-restore-${stamp}.db`));

    let storage = 'sqlite';
    if (databaseData) {
      fs.writeFileSync(currentDatabase, databaseData);
    } else {
      // Backward compatibility with v1.0.x backups. Removing the DB makes Store.load()
      // perform the one-time JSON -> SQLite migration.
      fs.rmSync(currentDatabase, { force: true });
      let parsed;
      try { parsed = JSON.parse(legacyData.toString('utf8')); }
      catch { throw new Error('library.json im Backup ist ungültig.'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('library.json im Backup hat ein ungültiges Format.');
      fs.writeFileSync(path.join(this.dataDir, 'library.json'), JSON.stringify(parsed, null, 2), 'utf8');
      storage = 'legacy-json-migration';
    }

    fs.mkdirSync(this.connectorDir, { recursive: true });
    let connectorCount = 0;
    for (const [name, data] of entries.entries()) {
      if (!name.startsWith('Connectors/') || !/\.json$/i.test(name)) continue;
      const rel = normalizeZipName(name.slice('Connectors/'.length));
      const target = path.resolve(this.connectorDir, rel);
      const root = path.resolve(this.connectorDir) + path.sep;
      if (!target.startsWith(root)) throw new Error('Ungültiger Connector-Pfad im Backup.');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      connectorCount += 1;
    }
    this.logger?.info('Backup wiederhergestellt', { file: filePath, connectors: connectorCount, storage });
    return { file: filePath, connectorCount, storage };
  }
}

module.exports = { BackupManager, writeStoredZip, readStoredZip };
