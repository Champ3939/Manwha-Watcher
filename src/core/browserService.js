const { BrowserWindow, session } = require('electron');
const http = require('http');
const https = require('https');
const zlib = require('zlib');

function timeoutPromise(ms, message) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeContentEncoding(buffer, encoding) {
  const value = String(encoding || '').toLowerCase().trim();
  if (!value || value === 'identity') return buffer;
  try {
    if (value.includes('br')) return zlib.brotliDecompressSync(buffer);
    if (value.includes('gzip')) return zlib.gunzipSync(buffer);
    if (value.includes('deflate')) return zlib.inflateSync(buffer);
  } catch {}
  return buffer;
}

function isBlockedByClient(error) {
  const code = Number(error?.errno ?? error?.code);
  const text = String(error?.message || error?.code || error || '');
  return code === -20 || /ERR_BLOCKED_BY_CLIENT/i.test(text);
}


function decodeMarkupUrl(value) {
  return String(value || '')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/gi, '"')
    .trim();
}

function parseTagAttributes(tag) {
  const attrs = {};
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match;
  while ((match = re.exec(String(tag || '')))) {
    attrs[String(match[1] || '').toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

function lastSrcsetUrl(value) {
  const parts = String(value || '').split(',').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return '';
  return parts[parts.length - 1].split(/\s+/)[0] || '';
}

function resolveHttpUrl(value, baseUrl) {
  const raw = decodeMarkupUrl(value);
  if (!raw || /^(?:data:|blob:|javascript:)/i.test(raw)) return null;
  try {
    const url = new URL(raw, baseUrl).href;
    return /^https?:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}


function normalizeDetectedStatus(value) {
  const raw = String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
  if (!raw) return 'unknown';
  if (/\b(?:cancelled|canceled|discontinued|axed)\b/i.test(raw)) return 'cancelled';
  if (/\b(?:dropped|abandoned|abandon(?:ed)?|stopped)\b/i.test(raw)) return 'dropped';
  if (/\b(?:hiatus|on hiatus|on hold|paused|pause|suspended)\b/i.test(raw)) return 'hiatus';
  if (/\b(?:completed|complete|finished|ended|complete[d]?)\b/i.test(raw)) return 'completed';
  if (/\b(?:upcoming|not yet released|coming soon|announced|pre release|unreleased)\b/i.test(raw)) return 'upcoming';
  if (/\b(?:ongoing|on going|publishing|releasing|active|serialization|serializing|updating|update in progress)\b/i.test(raw)) return 'ongoing';
  return 'unknown';
}

function decodeStatusText(value) {
  return String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function extractSeriesStatusFromHtml(html) {
  const source = String(html || '');
  const candidates = [];
  const push = (value, sourceName, score) => {
    const status = normalizeDetectedStatus(value);
    if (status !== 'unknown') candidates.push({ status, source: sourceName, score });
  };

  // Structured attributes / JSON are the strongest generic signal.
  for (const m of source.matchAll(/\b(?:data-status|data-state)\s*=\s*["']([^"']+)["']/gi)) push(m[1], 'data-attribute', 110);
  for (const m of source.matchAll(/["'](?:status|state|publicationStatus|seriesStatus)["']\s*:\s*["']([^"']{2,60})["']/gi)) push(m[1], 'json-status', 108);
  for (const m of source.matchAll(/["'](?:creativeWorkStatus|bookStatus)["']\s*:\s*["']([^"']{2,80})["']/gi)) push(m[1], 'schema-status', 106);
  for (const m of source.matchAll(/<([a-z0-9]+)\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:status|state)[^"']*["'][^>]*>([\s\S]{0,800}?)<\/\1>/gi)) push(m[2], 'status-element', 104);
  for (const m of source.matchAll(/\b(?:class|id)\s*=\s*["']([^"']*(?:status|state|ongoing|completed|complete|hiatus|cancelled|canceled|dropped|upcoming)[^"']*)["']/gi)) push(m[1], 'status-class-id', 102);
  for (const m of source.matchAll(/<input\b[^>]*(?:name|id)\s*=\s*["'][^"']*(?:status|state)[^"']*["'][^>]*>/gi)) { const attrs = parseTagAttributes(m[0]); push(attrs.value || attrs['data-value'], 'status-input', 109); }

  // WordPress/Madara and other common summary layouts put the label and value
  // into separate descendants of one item, e.g. "Status" + "OnGoing".
  for (const m of source.matchAll(/<[^>]+class=["'][^"']*(?:post-content[_-]?item|summary[_-]?item|info[_-]?item|detail[_-]?item)[^"']*["'][^>]*>([\s\S]{0,3500}?)<\/[^>]+>/gi)) {
    const text = decodeStatusText(m[1]);
    if (/\b(?:status|state|publication status|serialization status)\b/i.test(text)) push(text, 'summary-row', 103);
  }

  // Generic label/value neighbourhood. We intentionally inspect a generous
  // slice because nested themes may put many tags/classes between label/value.
  const lower = source.toLowerCase();
  const labelRe = /\b(?:publication\s+status|serialization\s+status|series\s+status|status|state)\b/gi;
  let label;
  let slices = 0;
  while ((label = labelRe.exec(source)) && slices < 80) {
    const from = Math.max(0, label.index - 150);
    const to = Math.min(source.length, label.index + 2600);
    const text = decodeStatusText(source.slice(from, to));
    const pos = text.search(/\b(?:publication\s+status|serialization\s+status|series\s+status|status|state)\b/i);
    const after = pos >= 0 ? text.slice(pos) : text;
    push(after.slice(0, 800), 'label-window', 101);
    slices += 1;
  }

  // Plain-text line pairs are especially reliable for rendered/crawler HTML:
  // Status\nOnGoing, State\nCompleted, etc.
  const text = decodeStatusText(source);
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^(?:publication\s+status|serialization\s+status|series\s+status|status|state)\s*[:\-]?$/i.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j += 1) {
      const status = normalizeDetectedStatus(lines[j]);
      if (status !== 'unknown') {
        candidates.push({ status, source: 'label-line', score: 105 - (j - i) });
        break;
      }
    }
  }

  // Last-resort label-nearby check over text rather than raw HTML.
  for (const m of text.matchAll(/(?:publication\s+status|serialization\s+status|series\s+status|status|state)\s*[:\-]?\s*(ongoing|on\s*going|publishing|releasing|active|serialization|serializing|updating|completed?|finished|ended|cancelled|canceled|discontinued|dropped|abandoned|hiatus|on\s+hold|paused|upcoming|not\s+yet\s+released|coming\s+soon)/gi)) push(m[1], 'text-label', 100);

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || { status: 'unknown', source: 'not-found', score: 0 };
}


function collectStatusDebugFromHtml(html) {
  const source = String(html || '');
  const decoded = decodeStatusText(source);
  const lines = decoded.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const lineHits = [];
  const keyword = /\b(?:status|state|ongoing|on\s*going|completed|complete|hiatus|on\s+hold|cancelled|canceled|dropped|discontinued|publishing|upcoming|finished|ended|updating)\b/i;
  for (let i = 0; i < lines.length && lineHits.length < 30; i += 1) {
    if (!keyword.test(lines[i])) continue;
    lineHits.push(lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 4)).join(' | ').slice(0, 900));
  }
  const rawHits = [];
  const rawRe = /(?:status|state|ongoing|completed|hiatus|cancelled|canceled|dropped|discontinued|publishing|upcoming)/ig;
  let m;
  while ((m = rawRe.exec(source)) && rawHits.length < 25) {
    rawHits.push(source.slice(Math.max(0, m.index - 180), Math.min(source.length, m.index + 420)).replace(/\s+/g, ' ').slice(0, 700));
  }
  const structured = [];
  for (const match of source.matchAll(/["']?([A-Za-z0-9_$.-]*(?:status|state)[A-Za-z0-9_$.-]*)["']?\s*[:=]\s*["']([^"']{1,100})["']/gi)) {
    structured.push(`${match[1]} = ${match[2]}`);
    if (structured.length >= 30) break;
  }
  const hit = extractSeriesStatusFromHtml(source);
  return { detected: hit, bytes: Buffer.byteLength(source), lineHits, structured, rawHits };
}

function extractReaderPagesFromHtml(html, baseUrl) {
  const source = String(html || '');
  const rows = [];
  const seen = new Set();
  const bad = /(?:logo|icon|avatar|emoji|banner|advert|\bad[sx]?\b|tracking|pixel|sprite|placeholder|spinner|loading)/i;
  const imageish = /(?:chapter|reader|page|comic|manga|manhwa|webtoon|upload|storage|cdn|image)/i;
  const add = (raw, meta = '', score = 0) => {
    const url = resolveHttpUrl(raw, baseUrl);
    if (!url || seen.has(url)) return;
    if (bad.test(`${url} ${meta}`)) return;
    let value = score;
    if (/\.(?:jpe?g|png|webp|gif|avif)(?:$|[?#])/i.test(url)) value += 20;
    if (imageish.test(`${url} ${meta}`)) value += 18;
    seen.add(url);
    rows.push({ url, score: value, order: rows.length });
  };

  const imgRe = /<img\b[^>]*>/gi;
  let match;
  while ((match = imgRe.exec(source))) {
    const attrs = parseTagAttributes(match[0]);
    const meta = [attrs.alt, attrs.class, attrs.id, attrs.role, attrs.itemprop].filter(Boolean).join(' ');
    const width = Number(String(attrs.width || '').replace(/[^0-9.]/g, '')) || 0;
    const height = Number(String(attrs.height || '').replace(/[^0-9.]/g, '')) || 0;
    let score = 35;
    if (width >= 320) score += 16;
    if (height >= 450) score += 22;
    if (height && width && height > width * 1.1) score += 10;
    const values = [
      attrs['data-src'], attrs['data-lazy-src'], attrs['data-original'], attrs['data-url'], attrs['data-cfsrc'],
      lastSrcsetUrl(attrs['data-srcset']), lastSrcsetUrl(attrs.srcset), attrs.src
    ];
    for (const value of values) add(value, meta, score);
  }

  const sourceRe = /<source\b[^>]*>/gi;
  while ((match = sourceRe.exec(source))) {
    const attrs = parseTagAttributes(match[0]);
    add(lastSrcsetUrl(attrs.srcset || attrs['data-srcset']), `${attrs.class || ''} picture source`, 34);
  }

  const normalized = source.replace(/\\u002f/gi, '/').replace(/\\\//g, '/').replace(/&amp;/gi, '&');
  const absoluteImageRe = /https?:\/\/[^\s"'<>]+?(?:\.(?:jpe?g|png|webp|gif|avif)(?:\?[^\s"'<>]*)?)(?=[\s"'<>]|$)/gi;
  while ((match = absoluteImageRe.exec(normalized))) add(match[0], 'serialized-image-url', 8);

  if (!rows.length) return [];
  const strong = rows.filter((item) => item.score >= 55);
  const selected = strong.length >= 2 ? strong : rows.filter((item) => item.score >= 30);
  return selected.slice(0, 500).map((item, index) => ({
    url: item.url,
    index: index + 1,
    filename: null,
    referer: baseUrl
  }));
}

class BrowserService {
  constructor({ partition = 'persist:manhwa-watcher-web', onEvent = () => {}, logger = null } = {}) {
    this.partition = partition;
    this.onEvent = onEvent;
    this.logger = logger;
    this.window = null;
    this.queue = Promise.resolve();
    this.userAgent = null;
    this.lastRequestedUrl = null;
    this.lastLoadedUrl = null;
    this.sessionConfigured = false;
    this.catalogCache = new Map();
  }

  getSession() {
    const ses = session.fromPartition(this.partition, { cache: true });
    if (!this.sessionConfigured) {
      this.sessionConfigured = true;
      try { ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false)); } catch {}
      try { ses.setPermissionCheckHandler(() => false); } catch {}
      this.logger?.info('Browser-Session konfiguriert', { partition: this.partition, permissions: 'deny-by-default' });
    }
    return ses;
  }

  sanitizeUserAgent(value) {
    return String(value || '')
      .replace(/\sElectron\/[\d.]+/gi, '')
      .replace(/\sManhwa[\s_-]*Watcher\/[\d.]+/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  async ensureWindow({ fresh = false, preserveVisibility = true } = {}) {
    let wasVisible = false;
    if (this.window && !this.window.isDestroyed()) {
      wasVisible = preserveVisibility && this.window.isVisible();
      if (!fresh) return this.window;
      try { this.window.destroy(); } catch {}
      this.window = null;
      await sleep(75);
    }

    const ses = this.getSession();
    this.window = new BrowserWindow({
      show: wasVisible,
      width: 1280,
      height: 900,
      title: 'Manhwa Watcher – Browser',
      backgroundColor: '#111827',
      paintWhenInitiallyHidden: true,
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false
      }
    });
    this.window.setMenuBarVisibility(false);
    this.window.webContents.setAudioMuted(true);
    this.window.webContents.setWindowOpenHandler(({ url }) => {
      this.logger?.info('Browser-Popup blockiert', { url });
      return { action: 'deny' };
    });

    const rawUserAgent = this.window.webContents.getUserAgent();
    this.userAgent = this.sanitizeUserAgent(rawUserAgent) || rawUserAgent;
    try { ses.setUserAgent(this.userAgent); } catch {}
    try { this.window.webContents.setUserAgent(this.userAgent); } catch {}

    this.logger?.info('Browserfenster erstellt', {
      visible: wasVisible,
      userAgent: this.userAgent,
      partition: this.partition
    });

    this.window.webContents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
      if (!isMainFrame) return;
      this.logger?.info('Browser-Navigation gestartet', { url });
    });
    this.window.webContents.on('did-finish-load', () => {
      this.logger?.info('Browser-Dokument fertig geladen', {
        url: this.window && !this.window.isDestroyed() ? this.window.webContents.getURL() : null
      });
    });
    this.window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      this.logger?.warn('Browser-Ladevorgang fehlgeschlagen', { errorCode, errorDescription, url: validatedURL });
      this.onEvent({ type: 'browser-load-error', errorCode, message: errorDescription, url: validatedURL });
    });
    this.window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      if (level < 2) return;
      this.logger?.warn('Browser-Konsole', {
        level,
        message: String(message || '').slice(0, 700),
        line,
        source: String(sourceId || '').slice(0, 300)
      });
    });
    this.window.webContents.on('render-process-gone', (_event, details) => {
      this.logger?.warn('Browser-Renderer wurde beendet', details || {});
      this.onEvent({ type: 'browser-renderer-gone', reason: details?.reason || 'unknown' });
      if (this.window && !this.window.isDestroyed()) {
        try { this.window.destroy(); } catch {}
      }
      this.window = null;
    });
    this.window.on('unresponsive', () => {
      this.logger?.warn('Browserfenster reagiert nicht mehr');
      this.onEvent({ type: 'browser-unresponsive' });
    });
    this.window.on('closed', () => { this.window = null; });
    return this.window;
  }

  serialize(task) {
    const next = this.queue.then(task);
    this.queue = next.catch(() => {});
    return next;
  }

  async _navigateWindow(win, url, { timeoutMs = 30000, settleMs = 0, waitForSelector = null, userAgent = null, referer = null, bypassCache = false } = {}) {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) throw new Error('Browserfenster ist nicht verfügbar.');
    if (win.webContents.isLoading()) {
      try { win.webContents.stop(); } catch {}
      await sleep(100);
    }

    const ua = this.sanitizeUserAgent(userAgent || this.userAgent) || undefined;
    const safeReferer = /^https?:\/\//i.test(String(referer || '')) ? String(referer) : null;
    const loadOptions = {};
    if (ua) loadOptions.userAgent = ua;
    if (safeReferer) loadOptions.httpReferrer = safeReferer;
    if (bypassCache) loadOptions.extraHeaders = 'Cache-Control: no-cache\r\nPragma: no-cache\r\n';
    this.logger?.info('Browser lädt URL', { url, userAgent: ua, referer: safeReferer, bypassCache: Boolean(bypassCache) });
    this.onEvent({ type: 'browser-load-start', url });

    await Promise.race([
      win.loadURL(url, Object.keys(loadOptions).length ? loadOptions : undefined),
      timeoutPromise(timeoutMs, `Zeitüberschreitung beim Laden von ${url}`)
    ]);

    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new Error('Browser-Renderer wurde während des Ladens beendet.');
    }

    const documentState = await win.webContents.executeJavaScript(`({
      href: location.href,
      readyState: document.readyState,
      hasDocument: Boolean(document.documentElement),
      bodyLength: document.body?.innerHTML?.length || 0,
      textLength: document.body?.innerText?.length || 0,
      title: document.title
    })`, true);

    if (!documentState?.hasDocument || documentState?.href === 'about:blank') {
      throw new Error('Browser hat nach der Navigation nur eine leere Seite geliefert.');
    }

    if (waitForSelector) await this.waitForSelector(waitForSelector, timeoutMs);
    if (settleMs) await sleep(Math.min(10000, Math.max(0, Number(settleMs) || 0)));

    this.lastLoadedUrl = win.webContents.getURL() || url;
    this.logger?.info('Browser-URL geladen', {
      requestedUrl: url,
      url: this.lastLoadedUrl,
      title: win.webContents.getTitle(),
      bodyLength: documentState.bodyLength,
      textLength: documentState.textLength
    });
    this.onEvent({ type: 'browser-load-done', url: this.lastLoadedUrl });
    return win;
  }

  async _recoverBlockedNavigation(url) {
    const ses = this.getSession();
    let origin = null;
    try { origin = new URL(url).origin; } catch {}
    this.logger?.warn('ERR_BLOCKED_BY_CLIENT: Browserzustand wird automatisch repariert', { url, origin });
    try {
      await ses.clearStorageData({
        ...(origin ? { origin } : {}),
        storages: ['serviceworkers', 'cachestorage']
      });
      this.logger?.info('Service-Worker/CacheStorage der Site wurden zurückgesetzt', { origin });
    } catch (error) {
      this.logger?.warn('Service-Worker konnten nicht gezielt zurückgesetzt werden', { origin, message: error.message });
    }
    try {
      await ses.clearCache();
      this.logger?.info('Chromium-HTTP-Cache wurde nach BLOCKED_BY_CLIENT geleert');
    } catch (error) {
      this.logger?.warn('Chromium-Cache konnte nicht geleert werden', { message: error.message });
    }
    try { await this.ensureWindow({ fresh: true, preserveVisibility: true }); } catch {}
    await sleep(250);
  }

  async _loadUnlocked(url, options = {}) {
    const target = String(url || '').trim();
    if (!target) throw new Error('URL fehlt.');
    this.lastRequestedUrl = target;

    const timeoutMs = Math.max(3000, Number(options.timeoutMs) || 30000);
    const attempts = options.retry === false ? 1 : 3;
    let lastError = null;
    let recoveredBlockedNavigation = false;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const win = await this.ensureWindow({
          fresh: Boolean(options.freshWindow) || attempt > 1,
          preserveVisibility: !options.background
        });
        this.logger?.info('Browser-Ladeversuch', { url: target, attempt, attempts });
        return await this._navigateWindow(win, target, {
          timeoutMs,
          settleMs: options.settleMs,
          waitForSelector: options.waitForSelector,
          userAgent: options.userAgent,
          referer: options.referer,
          bypassCache: Boolean(options.bypassCache) || recoveredBlockedNavigation
        });
      } catch (error) {
        lastError = error;
        const blocked = isBlockedByClient(error);
        this.logger?.warn('Browser-Navigation fehlgeschlagen', {
          url: target, attempt, message: error.message, code: error?.code ?? error?.errno ?? null, blockedByClient: blocked
        });
        if (blocked && !recoveredBlockedNavigation && attempt < attempts) {
          recoveredBlockedNavigation = true;
          this.onEvent({ type: 'browser-recovery', url: target, reason: 'ERR_BLOCKED_BY_CLIENT' });
          await this._recoverBlockedNavigation(target);
          continue;
        }
        if (attempt < attempts) {
          this.onEvent({ type: 'browser-retry', url: target, attempt: attempt + 1 });
          try { await this.ensureWindow({ fresh: true, preserveVisibility: true }); } catch {}
          await sleep(200);
        }
      }
    }
    throw lastError || new Error(`Seite konnte nicht geladen werden: ${target}`);
  }

  async load(url, options = {}) {
    return this.serialize(() => this._loadUnlocked(url, options));
  }

  async restartWindow({ reloadLast = true, fallbackUrl = null } = {}) {
    return this.serialize(async () => {
      const target = String(fallbackUrl || this.lastRequestedUrl || this.lastLoadedUrl || '').trim();
      const win = await this.ensureWindow({ fresh: true, preserveVisibility: true });
      this.logger?.info('Browserfenster wurde neu gestartet', { reloadLast, target: target || null });
      if (reloadLast && /^https?:\/\//i.test(target)) {
        try {
          await this._navigateWindow(win, target, { timeoutMs: 30000, settleMs: 450 });
        } catch (error) {
          this.logger?.warn('Browser-Neustart: letzte URL konnte nicht wieder geladen werden', { url: target, message: error.message });
          throw error;
        }
      }
      return { visible: win.isVisible(), url: win.webContents.getURL(), title: win.webContents.getTitle(), reloaded: Boolean(reloadLast && target) };
    });
  }

  async scrape(url, options, script) {
    return this.serialize(async () => {
      const opts = options || {};
      if (opts.background && this.window && !this.window.isDestroyed()) this.window.hide();
      const win = await this._loadUnlocked(url, opts);
      if (opts.background && !win.isDestroyed()) win.hide();
      return win.webContents.executeJavaScript(script, true);
    });
  }

  async waitForSelector(selector, timeoutMs = 30000) {
    const win = await this.ensureWindow();
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = await win.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, true);
      if (found) return true;
      await sleep(250);
    }
    throw new Error(`Element nicht gefunden: ${selector}`);
  }

  async execute(script) {
    const win = await this.ensureWindow();
    return win.webContents.executeJavaScript(script, true);
  }

  async inspectPage(url, options = {}) {
    return this.serialize(async () => {
      const win = await this._loadUnlocked(url, { ...options, freshWindow: options.freshWindow !== false });
      return win.webContents.executeJavaScript(`({
        url: location.href,
        hostname: location.hostname,
        title: document.title,
        readyState: document.readyState,
        textLength: document.body?.innerText?.length || 0,
        bodyLength: document.body?.innerHTML?.length || 0
      })`, true);
    });
  }

  async testSelector({ url = null, selector, textSelector = null, urlSelector = null, urlAttributes = [], limit = 25, settleMs = 350 }) {
    if (!selector) throw new Error('CSS-Selektor fehlt.');
    return this.serialize(async () => {
      const win = url ? await this._loadUnlocked(url, { settleMs, timeoutMs: 30000 }) : await this.ensureWindow();
      const payload = JSON.stringify({ selector, textSelector, urlSelector, urlAttributes, limit: Math.max(1, Math.min(100, Number(limit) || 25)) });
      return win.webContents.executeJavaScript(`(() => {
        const cfg = ${payload};
        const abs = (value) => { try { return new URL(value, location.href).href; } catch { return null; } };
        let nodes;
        try { nodes = [...document.querySelectorAll(cfg.selector)]; }
        catch (error) { return { error: 'Ungültiger CSS-Selektor: ' + error.message, count: 0, items: [] }; }
        const items = nodes.slice(0, cfg.limit).map((root, index) => {
          let textNode = root;
          let urlNode = root;
          try { if (cfg.textSelector) textNode = root.querySelector(cfg.textSelector) || root; } catch {}
          try { if (cfg.urlSelector) urlNode = root.querySelector(cfg.urlSelector) || root; } catch {}
          const text = (textNode?.textContent || '').replace(/\\s+/g, ' ').trim();
          let rawUrl = null;
          for (const attr of cfg.urlAttributes || []) {
            const value = attr === 'text' ? urlNode?.textContent : urlNode?.getAttribute?.(attr);
            if (value && String(value).trim()) { rawUrl = String(value).trim(); break; }
          }
          return { index: index + 1, text, url: rawUrl ? abs(rawUrl) : null, tag: root.tagName?.toLowerCase() || '' };
        });
        return { count: nodes.length, items, pageUrl: location.href, pageTitle: document.title };
      })()`, true);
    });
  }

  async analyzeSelectors({ url = null, settleMs = 500 } = {}) {
    return this.serialize(async () => {
      const win = url ? await this._loadUnlocked(url, { settleMs, timeoutMs: 30000 }) : await this.ensureWindow();
      return win.webContents.executeJavaScript(`(() => {
        const esc = (value) => CSS.escape(String(value || ''));
        const cleanClasses = (el) => [...(el.classList || [])].filter((name) => name && name.length < 48 && !/^__mw_/i.test(name) && !/^[a-f0-9]{10,}$/i.test(name)).slice(0, 3);
        const selectorFor = (el) => {
          if (!el || !el.tagName) return null;
          const tag = el.tagName.toLowerCase();
          if (el.id) return tag + '#' + esc(el.id);
          const classes = cleanClasses(el);
          if (classes.length) return tag + classes.map((c) => '.' + esc(c)).join('');
          return tag;
        };
        const count = (selector) => { try { return document.querySelectorAll(selector).length; } catch { return 0; } };
        const unique = (items) => {
          const seen = new Set();
          return items.filter((item) => item?.selector && !seen.has(item.selector) && seen.add(item.selector));
        };

        const titleSelectors = ['main h1', 'article h1', 'h1', '[itemprop="name"]', '.series-title', '.manga-title', '.post-title', '.entry-title'];
        const titles = unique(titleSelectors.map((selector) => {
          let el = null; try { el = document.querySelector(selector); } catch {}
          if (!el) return null;
          const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
          return text ? { selector, count: count(selector), example: text.slice(0, 140) } : null;
        }).filter(Boolean)).slice(0, 8);

        const anchors = [...document.querySelectorAll('a[href]')].filter((a) => {
          const text = (a.textContent || '').replace(/\\s+/g, ' ').trim();
          const href = a.getAttribute('href') || '';
          return /(?:chapter|chap(?:ter)?|ch\\.?)[\\s_#:-]*\\d/i.test(text + ' ' + href) || /\\/chapter[-_/]/i.test(href);
        });
        const chapterGroups = new Map();
        for (const a of anchors) {
          const selector = selectorFor(a);
          if (!selector) continue;
          const entry = chapterGroups.get(selector) || { selector, count: count(selector), examples: [] };
          if (entry.examples.length < 3) entry.examples.push((a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100));
          chapterGroups.set(selector, entry);
        }
        const chapters = [...chapterGroups.values()].filter((item) => item.count >= 1).sort((a,b) => b.count - a.count || a.selector.length - b.selector.length).slice(0, 10);

        const images = [...document.images].filter((img) => {
          const rect = img.getBoundingClientRect();
          const src = img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
          const alt = (img.alt || '').toLowerCase();
          if (!src) return false;
          if (/logo|icon|avatar|emoji|banner/.test(alt) && rect.width < 500) return false;
          return rect.width >= 180 || rect.height >= 220 || img.naturalWidth >= 500 || img.naturalHeight >= 500;
        });
        const imageGroups = new Map();
        for (const img of images) {
          const selector = selectorFor(img);
          if (!selector) continue;
          const entry = imageGroups.get(selector) || { selector, count: count(selector), examples: [] };
          if (entry.examples.length < 2) entry.examples.push((img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || '').slice(0, 180));
          imageGroups.set(selector, entry);
        }
        const pages = [...imageGroups.values()].filter((item) => item.count >= 1).sort((a,b) => b.count - a.count || a.selector.length - b.selector.length).slice(0, 10);

        return {
          url: location.href,
          title: document.title,
          stats: { anchors: document.links.length, images: document.images.length, bodyText: document.body?.innerText?.length || 0 },
          titles, chapters, pages
        };
      })()`, true);
    });
  }

  async _expandCatalogPage(win, { rounds = 16, pauseMs = 450 } = {}) {
    let stableRounds = 0;
    let clickedTotal = 0;
    const maxRounds = Math.max(2, Math.min(30, Number(rounds) || 16));
    for (let round = 0; round < maxRounds; round++) {
      const before = await win.webContents.executeJavaScript(`(() => ({
        height: Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0),
        links: document.links.length,
        y: window.scrollY
      }))()`, true);

      const clicked = await win.webContents.executeJavaScript(`(() => {
        const clean = (v) => String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const visible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 2 && r.height > 2 && st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || 1) > 0;
        };
        const pattern = /^(?:load|show|view)\\s+more(?:\\s+(?:manga|manhwa|series|titles?|items?))?|^(?:more|weitere|mehr laden|mehr anzeigen)$/i;
        const candidates = [...document.querySelectorAll('button,[role="button"]')]
          .filter(visible)
          .filter((el) => pattern.test(clean(el.innerText || el.textContent || el.getAttribute('aria-label'))));
        const button = candidates[0];
        if (!button) return false;
        try { button.click(); return true; } catch { return false; }
      })()`, true).catch(() => false);
      if (clicked) clickedTotal++;

      await win.webContents.executeJavaScript(`(() => {
        const h = Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0);
        window.scrollTo({ top: h, left: 0, behavior: 'instant' });
        return h;
      })()`, true).catch(() => null);
      await sleep(clicked ? Math.max(650, pauseMs) : pauseMs);

      const after = await win.webContents.executeJavaScript(`(() => ({
        height: Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0),
        links: document.links.length,
        y: window.scrollY
      }))()`, true);
      const changed = Number(after?.height || 0) > Number(before?.height || 0) + 20 || Number(after?.links || 0) > Number(before?.links || 0);
      stableRounds = changed || clicked ? 0 : stableRounds + 1;
      if (stableRounds >= 3) break;
    }
    await win.webContents.executeJavaScript(`window.scrollTo({ top: 0, left: 0, behavior: 'instant' })`, true).catch(() => null);
    return { clickedTotal };
  }

  async _catalogFingerprint(win) {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return null;
    return win.webContents.executeJavaScript(`(() => {
      const clean = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
      const active = [...document.querySelectorAll('[aria-current="page"],.active,.selected,[data-state="active"]')]
        .map((el) => clean(el.textContent || el.getAttribute('aria-label')))
        .filter(Boolean)
        .slice(0, 8)
        .join('|');
      const hrefs = [...document.querySelectorAll('main a[href],article a[href],[class*="series" i] a[href],[class*="manga" i] a[href],[class*="comic" i] a[href]')]
        .map((a) => a.href)
        .filter(Boolean)
        .slice(0, 120)
        .join('|');
      return {
        href: location.href,
        active,
        links: document.links.length,
        text: (document.querySelector('main')?.innerText || document.body?.innerText || '').slice(0, 5000),
        key: [location.href, active, hrefs].join('\\n')
      };
    })()`, true).catch(() => null);
  }

  async _catalogNextAction(win) {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return null;
    return win.webContents.executeJavaScript(`(() => {
      const clean = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || 1) > 0;
      };
      const disabled = (el) => Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true' || /(?:^|\\s)(?:disabled|is-disabled)(?:\\s|$)/i.test(String(el.className || '')));
      const pager = (el) => Boolean(el.closest('nav,[class*="pagination" i],[class*="pager" i],[class*="pages" i],[aria-label*="pagination" i],[class*="paginat" i]'));
      const rawCurrent = [...document.querySelectorAll('[aria-current="page"],nav .active,[class*="pagination" i] .active,[class*="pager" i] .active')]
        .map((el) => clean(el.textContent || el.getAttribute('aria-label')))
        .find((t) => /^\\d{1,4}$/.test(t));
      const current = rawCurrent ? Number(rawCurrent) : null;
      const controls = [...document.querySelectorAll('a[href],button,[role="button"]')].filter(visible).filter((el) => !disabled(el));
      const candidates = [];
      for (const el of controls) {
        const text = clean(el.innerText || el.textContent);
        const aria = clean(el.getAttribute('aria-label'));
        const title = clean(el.getAttribute('title'));
        const rel = clean(el.getAttribute('rel')).toLowerCase();
        const cls = clean(el.className).toLowerCase();
        const combined = [text, aria, title, cls].join(' ').toLowerCase();
        if (/\\b(?:prev|previous|zurück|zurueck|back)\\b/.test(combined)) continue;
        let score = 0;
        if (rel.split(/\\s+/).includes('next')) score += 500;
        if (/^(?:next|next page|weiter|nächste|naechste|older|older posts)$/i.test(text) || /(?:next|weiter|nächste|naechste)/i.test(aria + ' ' + title)) score += 380;
        if (/^(?:›|»|→|>)$/.test(text)) score += 340;
        if (/(?:^|[-_\\s])next(?:[-_\\s]|$)/i.test(cls)) score += 300;
        if (pager(el)) score += 100;
        const numeric = /^\\d{1,4}$/.test(text) ? Number(text) : null;
        if (numeric != null && current != null && numeric === current + 1) score += 260;
        if (numeric != null && current == null && pager(el)) score += 35;
        if (el.tagName === 'A' && el.href && /(?:[?&](?:page|paged|p)=\\d+|\\/(?:page|paged)\\/\\d+(?:\\/|$)|\\/page-\\d+(?:\\/|$))/i.test(el.href)) score += 90;
        if (score >= 180) candidates.push({ el, score, text: text || aria || title || 'next' });
      }
      candidates.sort((a,b) => b.score - a.score);
      const chosen = candidates[0];
      if (!chosen) return null;
      const el = chosen.el;
      const beforeUrl = location.href;
      if (el.tagName === 'A' && el.href) return { kind: 'url', url: el.href, label: chosen.text, score: chosen.score, beforeUrl };
      try {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.click();
        return { kind: 'click', label: chosen.text, score: chosen.score, beforeUrl };
      } catch {
        return null;
      }
    })()`, true).catch(() => null);
  }

  async _snapshotCatalogPage(win, { limit = 10000 } = {}) {
    const payload = JSON.stringify({ limit: Math.max(50, Math.min(20000, Number(limit) || 10000)) });
    return win.webContents.executeJavaScript(`(() => {
      const cfg = ${payload};
      const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const abs = (value) => { try { return new URL(value, location.href); } catch { return null; } };
      const badPath = /\\/(?:chapter|chapters|chap|ch[-_\\/]?\\d|episode|episodes|login|logout|register|account|profile|privacy|terms|dmca|contact|search|tag|tags|genre|genres|category|categories|author|artist|bookmark|bookmarks|favorite|favorites|history|settings)(?:[\\/-]|$)/i;
      const seriesPath = /\\/(?:series|manga|manhwa|comic|comics|title|titles|webtoon|book|books|novel)(?:\\/|$)/i;
      const badText = /^(?:home|latest|updates?|new releases?|popular|search|login|register|sign in|sign up|privacy|terms|dmca|contact|discord|facebook|twitter|instagram|next|previous|prev|read now|bookmarks?|favorites?|history|settings)$/i;
      const taxonomyText = /^(?:action|adventure|comedy|drama|fantasy|romance|horror|mystery|thriller|historical|sports?|supernatural|psychological|tragedy|sci[- ]?fi|science fiction|school life|slice of life|martial arts|mature|adult|ecchi|harem|isekai|shoujo|shojo|shounen|shonen|josei|seinen|yaoi|yuri|gender bender|mecha|demons?|magic|military|music|police|vampire|zombies?)$/i;
      const chapterText = /(?:^|\\b)(?:chapter|chap\\.?|ch\\.?|episode|ep\\.?)\\s*#?\\d/i;
      const navText = /^(?:(?:all|browse|view)\\s+)?(?:manga|manhwa|manhua|comics?|series|titles?|webtoons?|books?|novels?)(?:\\s+(?:list|directory|library|catalog|collection))?$|^(?:browse|directory|library|catalog|all titles|all series)$/i;
      const catalogPath = /\\/(?:manga|manhwa|manhua|comics?|series|titles?|webtoons?|browse|directory|library|catalog)(?:\\/|$)/i;
      const pagePattern = /(?:[?&](?:page|paged|p)=\\d+|\\/(?:page|paged)\\/\\d+(?:\\/|$)|\\/page-\\d+(?:\\/|$))/i;
      const nextText = /^(?:next|next page|older|older posts|weiter|nächste|naechste|›|»|→)$/i;
      const sameOrigin = (u) => u && u.origin === location.origin;
      const canonical = (u) => {
        u.hash = ''; u.searchParams.delete('utm_source'); u.searchParams.delete('utm_medium'); u.searchParams.delete('utm_campaign');
        return u.href.replace(/\\/$/, '');
      };
      const hasBadQuery = (u) => [...u.searchParams.keys()].some((key) => /^(?:genre|genres|category|categories|tag|tags|type|status|sort|filter|bookmark|bookmarks|favorite|favorites|search|q)$/i.test(key));
      const isNavigationContext = (a) => Boolean(a.closest('nav,header,footer,aside,[role="navigation"],[role="menu"],[class*="menu" i],[class*="navbar" i],[class*="sidebar" i],[class*="filter" i],[class*="genre" i],[class*="category" i],[class*="bookmark" i]'));
      const cardRoot = (a) => {
        const root = a.closest('article,[class*="card" i],[class*="series" i],[class*="manga" i],[class*="comic" i],[class*="novel" i],[class*="book" i],[class*="title-item" i],[class*="post" i],li');
        if (!root || root.closest('nav,header,footer,[role="navigation"],[role="menu"]')) return null;
        const links = root.querySelectorAll?.('a[href]').length || 0;
        return links <= 16 ? root : null;
      };
      const normalizeTitleText = (value) => clean(value)
        // Some cards place a decimal score directly before the title text.
        .replace(/^(?:10(?:[.,]0)?|[0-9](?:[.,][0-9]))\s+(?=[^\s]*[A-Za-z]|[A-Za-z])/, '')
        .replace(/\s+(?:[0-9]+\s*(?:chs?\.?|chapters?|episodes?|eps?\.?))(?:\s+.*)?$/i, '')
        .trim();
      const titleQuality = (value) => {
        const text = normalizeTitleText(value);
        if (!text || text.length < 2 || text.length > 160) return -1000;
        // Ratings, percentages and number-only badges are metadata, never titles.
        if (/^(?:10(?:[.,]0)?|[0-9](?:[.,][0-9])?)$/.test(text)) return -1000;
        if (/^[0-9]+(?:[.,][0-9]+)?%$/.test(text)) return -1000;
        if (/^[0-9\s.,:/()+-]+$/.test(text)) return -1000;
        if (/^[0-9]+\s*(?:chs?\.?|chapters?|episodes?|eps?\.?)(?:\s+(?:ongoing|completed?|finished|hiatus))?$/i.test(text)) return -1000;
        if (/^(?:ongoing|completed?|finished|hiatus|paused|cancelled|canceled|dropped|upcoming|bookmark|bookmarked|read|reading|new|hot)$/i.test(text)) return -1000;
        let score = 0;
        // toLowerCase/toUpperCase also catches non-ASCII letters without relying on Unicode regex properties.
        if (text.toLowerCase() !== text.toUpperCase()) score += 40;
        const words = text.split(/\s+/).filter(Boolean).length;
        score += Math.min(24, words * 4);
        if (text.length >= 3 && text.length <= 100) score += 18;
        if (words >= 2) score += 12;
        if (/[A-Za-z].*[A-Za-z]/.test(text)) score += 8;
        return score;
      };
      const normalizeStatus = (value) => {
        const raw = clean(value).toLowerCase().replace(/[\\s_-]+/g, ' ');
        if (!raw) return 'unknown';
        if (/\\b(?:cancelled|canceled|discontinued)\\b/i.test(raw)) return 'cancelled';
        if (/\\b(?:dropped|abandoned)\\b/i.test(raw)) return 'dropped';
        if (/\\b(?:hiatus|on hiatus|paused|pause)\\b/i.test(raw)) return 'hiatus';
        if (/\\b(?:completed|complete|finished|ended)\\b/i.test(raw)) return 'completed';
        if (/\\b(?:upcoming|not yet released|coming soon|announced|pre[- ]?release)\\b/i.test(raw)) return 'upcoming';
        if (/\\b(?:ongoing|on going|publishing|releasing|active|serialization)\\b/i.test(raw)) return 'ongoing';
        return 'unknown';
      };
      const statusFor = (a) => {
        const root = cardRoot(a) || a;
        const candidates = [];
        const push = (value) => { const text = clean(value); if (text) candidates.push(text); };
        for (const node of [...(root.querySelectorAll?.('[data-status],[data-state],[class*=\"status\" i],[class*=\"state\" i],[class*=\"badge\" i],[class*=\"tag\" i]') || [])].slice(0, 30)) {
          push(node.getAttribute?.('data-status')); push(node.getAttribute?.('data-state')); push(node.textContent);
        }
        push(root.getAttribute?.('data-status')); push(root.getAttribute?.('data-state'));
        push(root.innerText || root.textContent);
        for (const value of candidates) { const hit = normalizeStatus(value); if (hit !== 'unknown') return hit; }
        return 'unknown';
      };
      const bestText = (a) => {
        const root = cardRoot(a);
        const candidates = [];
        const push = (value, bonus = 0) => {
          const text = normalizeTitleText(value);
          const quality = titleQuality(text);
          if (quality <= -1000) return;
          candidates.push({ text, score: quality + bonus });
        };
        push(a.getAttribute('aria-label'), 24);
        push(a.getAttribute('title'), 20);
        push(a.querySelector('h1,h2,h3,h4,h5,h6')?.textContent, 46);
        push(a.querySelector('[class*="title" i],[class*="name" i]')?.textContent, 40);
        push(root?.querySelector('h1,h2,h3,h4,h5,h6')?.textContent, 44);
        push(root?.querySelector('[class*="title" i],[class*="name" i]')?.textContent, 38);

        // Many catalog cards use separate anchors for score and title, but both
        // anchors point to the exact same series URL. Inspect all same-target
        // links in the card so the human-readable title can beat a rating badge.
        if (root) {
          const target = abs(a.getAttribute('href'));
          const targetKey = target ? canonical(target) : '';
          for (const sibling of [...root.querySelectorAll('a[href]')].slice(0, 24)) {
            const siblingUrl = abs(sibling.getAttribute('href'));
            if (!siblingUrl || canonical(siblingUrl) !== targetKey) continue;
            push(sibling.querySelector('h1,h2,h3,h4,h5,h6')?.textContent, 52);
            push(sibling.querySelector('[class*="title" i],[class*="name" i]')?.textContent, 48);
            push(sibling.getAttribute('aria-label'), 28);
            push(sibling.getAttribute('title'), 24);
            push(sibling.textContent, 30);
          }
        }

        push(a.querySelector('img')?.getAttribute('alt'), 26);
        push(root?.querySelector('img')?.getAttribute('alt'), 18);
        push(a.textContent, 10);
        candidates.sort((x, y) => y.score - x.score || y.text.length - x.text.length);
        return candidates[0]?.text || '';
      };
      const fromSrcset = (value) => {
        const parts = clean(value).split(',').map((part) => part.trim()).filter(Boolean);
        if (!parts.length) return '';
        return parts[parts.length - 1].split(/\\s+/)[0] || '';
      };
      const imageUrl = (img) => {
        if (!img) return null;
        const raw = img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') ||
          img.getAttribute('data-original') || img.getAttribute('data-url') || img.getAttribute('data-cfsrc') ||
          fromSrcset(img.getAttribute('data-srcset') || img.getAttribute('srcset')) ||
          fromSrcset(img.closest('picture')?.querySelector('source')?.getAttribute('srcset'));
        const u = abs(raw);
        if (!u || !/^https?:$/.test(u.protocol)) return null;
        if (/transparent|placeholder|spacer|loading|blank\\.(?:gif|png)|1x1/i.test(u.href)) return null;
        return u.href;
      };
      const backgroundUrl = (el) => {
        if (!el) return null;
        const raw = el.style?.backgroundImage || getComputedStyle(el).backgroundImage || '';
        const m = String(raw).match(/url\\(["']?(.+?)["']?\\)/i);
        if (!m) return null;
        const u = abs(m[1]);
        return u && /^https?:$/.test(u.protocol) ? u.href : null;
      };
      const coverFor = (a) => {
        const ownImages = a.matches?.('img') ? [a] : [...(a.querySelectorAll?.('img') || [])].slice(0, 5);
        for (const img of ownImages) { const url = imageUrl(img); if (url) return { url, own: true }; }
        const ownBg = backgroundUrl(a); if (ownBg) return { url: ownBg, own: true };
        const root = cardRoot(a);
        if (root && root !== a) {
          const imgs = [...(root.querySelectorAll?.('img') || [])].slice(0, 8);
          for (const img of imgs) { const url = imageUrl(img); if (url) return { url, own: false }; }
          const bg = backgroundUrl(root); if (bg) return { url: bg, own: false };
          const bgNode = [...(root.querySelectorAll?.('[style*="background" i]') || [])].slice(0, 8).find((el) => backgroundUrl(el));
          const bg2 = backgroundUrl(bgNode); if (bg2) return { url: bg2, own: false };
        }
        return { url: null, own: false };
      };
      const routeKey = (u) => {
        const parts = u.pathname.split('/').filter(Boolean);
        if (!parts.length) return '/';
        if (parts.length === 1) return '/*';
        return '/' + parts.slice(0, -1).join('/') + '/*';
      };
      const declaredTotal = (() => {
        const values = [];
        const push = (value) => {
          const n = Number(String(value || '').replace(/[^0-9]/g, ''));
          if (Number.isFinite(n) && n >= 2 && n <= 100000) values.push(n);
        };
        for (const el of [...document.querySelectorAll('[data-total],[data-count],[class*="total" i],[class*="count" i]')].slice(0, 120)) {
          push(el.getAttribute?.('data-total'));
          push(el.getAttribute?.('data-count'));
          const text = clean(el.textContent);
          const m = text.match(/(?:total|series|titles|manga|manhwa|manhua|comics?|webtoons?|novels?)\\D{0,20}(\\d{2,6})|(\\d{2,6})\\D{0,12}(?:series|titles|manga|manhwa|manhua|comics?|webtoons?|novels?)/i);
          if (m) push(m[1] || m[2]);
        }
        const bodyText = clean(document.body?.innerText || '');
        const patterns = [
          /(?:browse|all|library|catalog|directory)\\s+(?:series|titles|manga|manhwa|manhua|comics?|webtoons?|novels?)\\D{0,24}(\\d{2,6})/i,
          /(?:series|titles|manga|manhwa|manhua|comics?|webtoons?|novels?)\\s*(?:total|count)?\\s*[:(]?\\s*(\\d{2,6})/i,
          /(\\d{2,6})\\s+(?:series|titles|manga|manhwa|manhua|comics?|webtoons?|novels?)\\b/i
        ];
        for (const re of patterns) { const m = bodyText.match(re); if (m) push(m[1]); }
        return values.length ? Math.max(...values) : null;
      })();
      const rows = new Map();
      const pagination = new Map();
      const catalogCandidates = new Map();

      for (const a of [...document.querySelectorAll('a[href]')]) {
        const u = abs(a.getAttribute('href'));
        if (!u || !/^https?:$/.test(u.protocol) || !sameOrigin(u)) continue;
        const text = clean(a.innerText || a.textContent || a.getAttribute('aria-label') || a.getAttribute('title'));
        const key = canonical(u);
        const depth = u.pathname.split('/').filter(Boolean).length;
        const navContext = isNavigationContext(a);

        let pscore = 0;
        const rel = clean(a.getAttribute('rel')).toLowerCase();
        if (rel.split(/\\s+/).includes('next')) pscore += 120;
        if (pagePattern.test(u.href)) pscore += 80;
        if (a.closest('nav,[class*="pagination" i],[class*="pager" i],[class*="pages" i],[aria-label*="pagination" i]')) pscore += 55;
        if (nextText.test(text)) pscore += 45;
        if (/^\\d{1,4}$/.test(text) && a.closest('nav,[class*="pagination" i],[class*="pager" i],[class*="pages" i]')) pscore += 30;
        if (pscore >= 70 && key !== canonical(new URL(location.href))) {
          const old = pagination.get(key);
          if (!old || pscore > old.score) pagination.set(key, { url: key, text, score: pscore });
        }

        let cscore = 0;
        if (navText.test(text)) cscore += 90;
        if (catalogPath.test(u.pathname) && depth <= 2) cscore += 45;
        if (/\\/(?:all|browse|directory|library|catalog)(?:\\/|$)/i.test(u.pathname)) cscore += 55;
        if (navContext) cscore += 20;
        if (depth <= 2) cscore += 10;
        if (badPath.test(u.pathname) || chapterText.test(text)) cscore = 0;
        if (cscore >= 60 && key !== canonical(new URL(location.href))) {
          const old = catalogCandidates.get(key);
          if (!old || cscore > old.score) catalogCandidates.set(key, { url: key, text, score: cscore });
        }

        if (u.pathname === '/' || badPath.test(u.pathname) || hasBadQuery(u)) continue;
        const title = bestText(a);
        if (!title || badText.test(title) || navText.test(title) || chapterText.test(title)) continue;
        if (/^(?:read|view|more|details|continue)$/i.test(title)) continue;
        const explicitSeriesPath = seriesPath.test(u.pathname);
        if (taxonomyText.test(title) && !explicitSeriesPath) continue;

        const heading = Boolean(a.querySelector('h1,h2,h3,h4') || cardRoot(a)?.querySelector('h1,h2,h3,h4'));
        const coverInfo = coverFor(a);
        const semanticClass = /title|manga|manhwa|comic|series|book|novel/i.test(String(a.className || '') + ' ' + String(cardRoot(a)?.className || ''));
        if (navContext && !explicitSeriesPath && !heading && !coverInfo.own) continue;

        let score = 0;
        const reasons = [];
        if (explicitSeriesPath) { score += 80; reasons.push('Serien-Pfad'); }
        if (heading) { score += 22; reasons.push('Titel-Element'); }
        if (coverInfo.url) { score += coverInfo.own ? 24 : 12; reasons.push(coverInfo.own ? 'Eigenes Cover' : 'Cover/Thumbnail'); }
        if (semanticClass) { score += 16; reasons.push('Serien-Klasse'); }
        if (cardRoot(a)) score += 8;
        if (navContext) score -= 55;
        const segments = u.pathname.split('/').filter(Boolean).length;
        if (segments >= 2 && segments <= 4) score += 8;
        if (title.length >= 3 && title.length <= 80) score += 8;
        if (/\\d{1,4}/.test(title) && title.length < 24) score -= 10;
        if (score < 28) continue;
        const existing = rows.get(key);
        const item = { title, titleQuality: titleQuality(title), url: key, cover: coverInfo.url || null, status: statusFor(a), score, reason: reasons.join(', ') || 'Link-Kandidat', routeKey: routeKey(u), navContext };
        if (!existing || item.score > existing.score ||
            (item.score === existing.score && item.titleQuality > (existing.titleQuality ?? -1000)) ||
            (item.score === existing.score && item.titleQuality === (existing.titleQuality ?? -1000) && item.title.length > existing.title.length)) {
          rows.set(key, item);
        }
      }

      // Learn the dominant URL shape from strong title cards and drop low-score
      // strays such as menu entries that happen to look like content cards.
      const raw = [...rows.values()];
      const routeStats = new Map();
      for (const item of raw) {
        if (item.score < 42 || item.navContext) continue;
        routeStats.set(item.routeKey, (routeStats.get(item.routeKey) || 0) + 1);
      }
      const dominantRoutes = [...routeStats.entries()]
        .filter(([, count]) => count >= 5)
        .sort((a,b) => b[1] - a[1])
        .slice(0, 3)
        .map(([key]) => key);
      const items = raw
        .filter((item) => !dominantRoutes.length || dominantRoutes.includes(item.routeKey) || item.score >= 72)
        .sort((a,b) => b.score - a.score || a.title.localeCompare(b.title))
        .slice(0, cfg.limit)
        .map(({ navContext, titleQuality, ...item }) => item);
      return {
        pageUrl: location.href,
        pageTitle: document.title,
        hostname: location.hostname,
        scannedLinks: document.links.length,
        count: items.length,
        rawCount: raw.length,
        declaredTotal,
        items,
        pagination: [...pagination.values()].sort((a,b) => b.score - a.score).slice(0, 60),
        catalogCandidates: [...catalogCandidates.values()].sort((a,b) => b.score - a.score).slice(0, 12),
        dominantRoutes
      };
    })()`, true);
  }

  async _catalogSnapshotAt(url, { settleMs = 500, limit = 10000, scrollRounds = 16 } = {}) {
    const win = await this._loadUnlocked(url, { settleMs, timeoutMs: 30000 });
    if (win && !win.isDestroyed()) win.hide();
    const expanded = await this._expandCatalogPage(win, { rounds: scrollRounds });
    const snapshot = await this._snapshotCatalogPage(win, { limit });
    return { ...snapshot, loadMoreClicks: expanded.clickedTotal || 0 };
  }

  async discoverSeries({ url, settleMs = 600, limit = 10000, maxPages = 60, force = false } = {}) {
    return this.serialize(async () => {
      const target = String(url || '').trim();
      if (!/^https?:\/\//i.test(target)) throw new Error('Bitte eine http://- oder https://-Katalog-URL eingeben.');
      const cacheKey = target.replace(/#.*$/, '').replace(/\/$/, '');
      const cached = this.catalogCache.get(cacheKey);
      if (!force && cached && Date.now() - cached.time < 15 * 60 * 1000) {
        this.logger?.info('Serien-Katalog aus Cache geladen', { url: target, count: cached.value?.count || 0 });
        return { ...cached.value, cached: true };
      }

      const cap = Math.max(100, Math.min(20000, Number(limit) || 10000));
      const pageCap = Math.max(1, Math.min(120, Number(maxPages) || 60));
      const rows = new Map();
      let scannedLinks = 0;
      let loadMoreClicks = 0;
      let requestedPage = null;
      let best = null;
      let interactivePages = 0;
      let usedObservedPagination = false;

      const merge = (snapshot) => {
        if (!snapshot) return;
        scannedLinks += Number(snapshot.scannedLinks || 0);
        loadMoreClicks += Number(snapshot.loadMoreClicks || 0);
        for (const item of snapshot.items || []) {
          const key = String(item.url || '').replace(/\/$/, '');
          if (!key) continue;
          const old = rows.get(key);
          if (!old || Number(item.score || 0) > Number(old.score || 0)) rows.set(key, item);
          else if (old) {
            if (!old.cover && item.cover) old.cover = item.cover;
            if ((!old.status || old.status === 'unknown') && item.status && item.status !== 'unknown') old.status = item.status;
          }
        }
      };

      const report = (phase, extra = {}) => this.onEvent({
        type: 'catalog-progress', phase, count: rows.size, ...extra
      });

      report('start', { url: target, current: 0, max: pageCap });
      requestedPage = await this._catalogSnapshotAt(target, { settleMs, limit: cap, scrollRounds: 18 });
      best = requestedPage;
      report('initial', { url: requestedPage.pageUrl || target, pageCount: requestedPage.count || 0, current: 1, max: pageCap });

      // A source button normally points to the domain root. Look for a dedicated
      // Browse / All Manga / Series / Library page and prefer it when it exposes
      // more title links than the landing page.
      const targetUrl = new URL(target);
      const shallowTarget = targetUrl.pathname.split('/').filter(Boolean).length <= 1;
      if (shallowTarget && (requestedPage.count || 0) < 120) {
        const candidates = (requestedPage.catalogCandidates || []).slice(0, 8);
        const directoryRank = (snap) => {
          if (!snap) return -1;
          const count = Number(snap.count || 0);
          const total = Number(snap.declaredTotal || 0);
          let pathBonus = 0;
          try {
            const pathname = new URL(String(snap.pageUrl || '')).pathname;
            if (/\/(?:browse|directory|library|catalog)(?:\/|$)/i.test(pathname)) pathBonus += 250000;
            else if (/\/(?:manga|manhwa|manhua|comics?|series|titles?|webtoons?)(?:\/|$)/i.test(pathname)) pathBonus += 100000;
          } catch {}
          // A real directory commonly shows only 10-30 cards per page while
          // declaring hundreds of titles overall. Prefer that over a homepage
          // that happens to contain more series-like links in one DOM snapshot.
          const totalBonus = total >= Math.max(25, count + 5) ? 1000000 + Math.min(total, 100000) * 10 : 0;
          return totalBonus + pathBonus + count;
        };
        for (let i = 0; i < candidates.length; i++) {
          const candidate = candidates[i];
          report('directory', { url: candidate.url, current: i + 1, max: candidates.length, pageCount: best?.count || 0 });
          try {
            const snap = await this._catalogSnapshotAt(candidate.url, { settleMs: Math.min(550, settleMs), limit: cap, scrollRounds: 14 });
            if (!best || directoryRank(snap) > directoryRank(best)) {
              this.logger?.info('Bessere Katalogseite gewählt', {
                previousUrl: best?.pageUrl || target,
                previousCount: Number(best?.count || 0),
                previousTotal: Number(best?.declaredTotal || 0) || null,
                catalogUrl: snap.pageUrl || candidate.url,
                pageCount: Number(snap.count || 0),
                declaredTotal: Number(snap.declaredTotal || 0) || null
              });
              best = snap;
            }
            if (Number(best.declaredTotal || 0) >= 180 && /\/(?:browse|directory|library|catalog)(?:\/|$)/i.test(new URL(String(best.pageUrl || '')).pathname)) break;
          } catch (error) {
            this.logger?.warn('Katalog-Verzeichnis konnte nicht geprüft werden', { url: candidate.url, message: error.message });
          }
        }
      }

      const visited = new Set();
      const queued = new Set();
      const queue = [];
      const enqueue = (entries = []) => {
        for (const entry of entries) {
          const u = String(entry?.url || '').replace(/#.*$/, '').replace(/\/$/, '');
          if (!u || visited.has(u) || queued.has(u)) continue;
          try {
            if (new URL(u).origin !== targetUrl.origin) continue;
          } catch { continue; }
          queued.add(u); queue.push(u);
        }
      };

      // Start with the most promising directory page, then follow only links
      // that the DOM snapshot classified as pagination.
      const startUrl = String(best?.pageUrl || target).replace(/#.*$/, '').replace(/\/$/, '');
      visited.add(startUrl);
      merge(best);
      enqueue(best?.pagination || []);

      while (queue.length && visited.size < pageCap && rows.size < cap) {
        const pageUrl = queue.shift();
        queued.delete(pageUrl);
        if (visited.has(pageUrl)) continue;
        visited.add(pageUrl);
        report('page', { url: pageUrl, current: visited.size, max: pageCap });
        try {
          const snap = await this._catalogSnapshotAt(pageUrl, { settleMs: Math.min(500, settleMs), limit: cap, scrollRounds: 12 });
          merge(snap);
          enqueue(snap.pagination || []);
        } catch (error) {
          this.logger?.warn('Katalog-Seite konnte nicht gelesen werden', { url: pageUrl, message: error.message });
        }
      }

      // If the site exposes numbered pagination URLs, continue that URL pattern
      // directly instead of relying on the small visible pager window. Many UIs
      // show only 5 numbers at once even though the catalog has many more pages.
      if (rows.size >= 8 && visited.size < pageCap && rows.size < cap) {
        const observed = [
          ...(best?.pagination || []),
          ...(requestedPage?.pagination || [])
        ].map((entry) => String(entry?.url || '')).filter(Boolean);
        const inferPaginator = () => {
          for (const raw of observed) {
            try {
              const u = new URL(raw);
              for (const key of ['page', 'paged', 'p']) {
                const value = Number(u.searchParams.get(key));
                if (Number.isInteger(value) && value >= 1) {
                  return {
                    kind: 'query', key,
                    make(page) { const out = new URL(String(best?.pageUrl || requestedPage?.pageUrl || target)); out.hash = ''; out.searchParams.set(key, String(page)); return out.href; },
                    number(rawUrl) { try { return Number(new URL(rawUrl).searchParams.get(key)) || 1; } catch { return 1; } }
                  };
                }
              }
              const m = u.pathname.match(/\/(page|paged)\/(\d+)\/?$/i);
              if (m) {
                const token = m[1];
                return {
                  kind: 'path', key: token,
                  make(page) { const out = new URL(String(best?.pageUrl || requestedPage?.pageUrl || target)); out.hash = ''; out.pathname = out.pathname.replace(new RegExp(`/(${token})/\\d+/?$`, 'i'), '').replace(/\/$/, '') + `/${token}/${page}`; return out.href; },
                  number(rawUrl) { try { const x = new URL(rawUrl).pathname.match(new RegExp(`/${token}/(\\d+)/?$`, 'i')); return x ? Number(x[1]) : 1; } catch { return 1; } }
                };
              }
            } catch {}
          }
          return null;
        };
        const paginator = inferPaginator();
        if (paginator) {
          usedObservedPagination = true;
          const visiblePages = observed.map((u) => paginator.number(u)).filter((n) => Number.isFinite(n) && n >= 1);
          const declaredTotal = Math.max(Number(best?.declaredTotal || 0), Number(requestedPage?.declaredTotal || 0)) || null;
          const pageSize = Math.max(Number(best?.count || 0), 1);
          const estimatedPages = declaredTotal ? Math.ceil(declaredTotal / pageSize) : null;
          const visibleMax = visiblePages.length ? Math.max(...visiblePages) : 1;
          const endPage = Math.min(pageCap, Math.max(estimatedPages || 0, visibleMax + (declaredTotal ? 0 : 8), 2));
          this.logger?.info('Nummerierte Katalog-Pagination erkannt', { kind: paginator.kind, key: paginator.key, declaredTotal, pageSize, estimatedPages, visibleMax, endPage });
          let emptyRounds = 0;
          for (let page = 2; page <= endPage && visited.size < pageCap && rows.size < cap; page++) {
            const guess = paginator.make(page).replace(/#.*$/, '').replace(/\/$/, '');
            if (visited.has(guess)) continue;
            report('page', { url: guess, current: page, max: endPage, expectedTotal: declaredTotal });
            try {
              const beforeCount = rows.size;
              const snap = await this._catalogSnapshotAt(guess, { settleMs: Math.min(480, settleMs), limit: cap, scrollRounds: 10 });
              visited.add(guess); merge(snap); enqueue(snap.pagination || []);
              const added = rows.size - beforeCount;
              emptyRounds = added > 0 ? 0 : emptyRounds + 1;
              if (declaredTotal && rows.size >= declaredTotal) break;
              if (emptyRounds >= 2) break;
            } catch (error) {
              emptyRounds += 1;
              this.logger?.debug?.('Direkte Katalogseite ohne Treffer', { page, url: guess, message: error.message });
              if (emptyRounds >= 2) break;
            }
          }
        }
      }

      // Some catalog pages have working ?page=N routes but do not render
      // pagination links in the DOM. Probe a few common page-2 forms and only
      // continue with a form when it contributes genuinely new series URLs.
      if (!usedObservedPagination && rows.size >= 15 && visited.size < pageCap && rows.size < cap) {
        const baseRaw = String(best?.pageUrl || requestedPage?.pageUrl || target);
        const makeGuess = (kind, page) => {
          const u = new URL(baseRaw);
          u.hash = '';
          if (kind === 'page-query') { u.searchParams.set('page', String(page)); return u.href; }
          if (kind === 'paged-query') { u.searchParams.set('paged', String(page)); return u.href; }
          const cleanPath = u.pathname.replace(/\/(?:page|paged)\/\d+\/?$/i, '').replace(/\/$/, '');
          u.pathname = `${cleanPath}/page/${page}`.replace(/\/{2,}/g, '/');
          return u.href;
        };
        let chosenKind = null;
        let page2Snapshot = null;
        for (const kind of ['page-query', 'paged-query', 'page-path']) {
          if (visited.size >= pageCap) break;
          const guess = makeGuess(kind, 2).replace(/#.*$/, '').replace(/\/$/, '');
          if (visited.has(guess)) continue;
          report('probe', { url: guess, current: visited.size + 1, max: pageCap });
          try {
            const snap = await this._catalogSnapshotAt(guess, { settleMs: Math.min(500, settleMs), limit: cap, scrollRounds: 10 });
            const novel = (snap.items || []).filter((item) => !rows.has(String(item.url || '').replace(/\/$/, ''))).length;
            if (novel >= Math.max(3, Math.min(10, Math.ceil((snap.items?.length || 0) * 0.05)))) {
              chosenKind = kind; page2Snapshot = snap; visited.add(guess); merge(snap); break;
            }
          } catch (error) {
            this.logger?.debug?.('Katalog-Pagination-Probe ohne Treffer', { url: guess, message: error.message });
          }
        }
        if (chosenKind && page2Snapshot) {
          let emptyRounds = 0;
          for (let page = 3; page <= pageCap && visited.size < pageCap && rows.size < cap; page++) {
            const guess = makeGuess(chosenKind, page).replace(/#.*$/, '').replace(/\/$/, '');
            if (visited.has(guess)) continue;
            report('page', { url: guess, current: visited.size + 1, max: pageCap });
            try {
              const beforeCount = rows.size;
              const snap = await this._catalogSnapshotAt(guess, { settleMs: Math.min(480, settleMs), limit: cap, scrollRounds: 10 });
              visited.add(guess); merge(snap);
              const added = rows.size - beforeCount;
              emptyRounds = added > 0 ? 0 : emptyRounds + 1;
              if (emptyRounds >= 2) break;
            } catch (error) {
              emptyRounds += 1;
              if (emptyRounds >= 2) break;
            }
          }
        }
      }

      // Reconcile a catalog that declares a larger total than we have actually
      // collected.  Some sites render only a tiny sliding window of numbered
      // links (for example 1-5) and our earlier graph walk can therefore finish
      // even though ?page=N continues far beyond the visible window.  Once a
      // numeric pagination shape is known, walk it sequentially until the
      // declared total is reached or several genuinely empty pages are seen.
      {
        const declaredTotal = Math.max(Number(best?.declaredTotal || 0), Number(requestedPage?.declaredTotal || 0)) || null;
        if (declaredTotal && rows.size < declaredTotal && visited.size < pageCap && rows.size < cap) {
          const baseRaw = String(best?.pageUrl || requestedPage?.pageUrl || target);
          const observed = [
            ...(best?.pagination || []),
            ...(requestedPage?.pagination || [])
          ].map((entry) => String(entry?.url || '')).filter(Boolean);

          const makerCandidates = [];
          const seenMaker = new Set();
          const addMaker = (id, make) => {
            if (seenMaker.has(id)) return;
            seenMaker.add(id);
            makerCandidates.push({ id, make });
          };

          for (const raw of observed) {
            try {
              const u = new URL(raw);
              for (const key of ['page', 'paged', 'p']) {
                const n = Number(u.searchParams.get(key));
                if (!Number.isInteger(n) || n < 2) continue;
                addMaker(`query:${key}`, (page) => {
                  const out = new URL(baseRaw); out.hash = ''; out.searchParams.set(key, String(page)); return out.href;
                });
              }
              const m = u.pathname.match(/\/(page|paged)\/(\d+)\/?$/i);
              if (m) {
                const token = m[1];
                addMaker(`path:${token}`, (page) => {
                  const out = new URL(baseRaw); out.hash = '';
                  const clean = out.pathname.replace(/\/(?:page|paged)\/\d+\/?$/i, '').replace(/\/$/, '');
                  out.pathname = `${clean}/${token}/${page}`.replace(/\/{2,}/g, '/');
                  return out.href;
                });
              }
            } catch {}
          }

          // If the page exposes a total but the pager uses buttons rather than
          // anchors, ?page=N is the safest generic first fallback.
          addMaker('query:page', (page) => {
            const out = new URL(baseRaw); out.hash = ''; out.searchParams.set('page', String(page)); return out.href;
          });

          let chosen = null;
          // Prefer a shape already observed in the DOM.  Otherwise validate a
          // candidate against page 2 before committing to a long sequential run.
          for (const candidate of makerCandidates) {
            if (candidate.id !== 'query:page' || observed.some((raw) => {
              try { return Number(new URL(raw).searchParams.get('page')) >= 2; } catch { return false; }
            })) {
              chosen = candidate;
              break;
            }
          }

          if (!chosen) {
            for (const candidate of makerCandidates) {
              try {
                const probeUrl = candidate.make(2).replace(/#.*$/, '').replace(/\/$/, '');
                const probe = await this._catalogSnapshotAt(probeUrl, { settleMs: Math.min(480, settleMs), limit: cap, scrollRounds: 10 });
                const novel = (probe.items || []).filter((item) => !rows.has(String(item.url || '').replace(/\/$/, ''))).length;
                // Page 2 may already have been collected by the visible pager;
                // accepting a non-empty snapshot is enough to establish the route.
                if (novel > 0 || Number(probe.count || 0) >= 3) {
                  chosen = candidate;
                  if (!visited.has(probeUrl)) { visited.add(probeUrl); merge(probe); }
                  break;
                }
              } catch (error) {
                this.logger?.debug?.('Katalog-Gesamtzahl-Pagination Probe fehlgeschlagen', { kind: candidate.id, message: error.message });
              }
            }
          }

          if (chosen) {
            this.logger?.info('Katalog-Gesamtzahl wird abgeglichen', { declaredTotal, collected: rows.size, pagination: chosen.id, pageCap });
            let noNovelRounds = 0;
            let errorRounds = 0;
            for (let page = 2; page <= pageCap && rows.size < declaredTotal && rows.size < cap; page++) {
              const guess = chosen.make(page).replace(/#.*$/, '').replace(/\/$/, '');
              if (visited.has(guess)) continue;
              report('reconcile-page', { url: guess, current: page, max: pageCap, expectedTotal: declaredTotal });
              try {
                const beforeCount = rows.size;
                const snap = await this._catalogSnapshotAt(guess, { settleMs: Math.min(480, settleMs), limit: cap, scrollRounds: 10 });
                visited.add(guess);
                merge(snap);
                const added = rows.size - beforeCount;
                errorRounds = 0;
                noNovelRounds = added > 0 ? 0 : noNovelRounds + 1;
                this.logger?.debug?.('Katalog-Gesamtzahl Seite gelesen', { page, added, collected: rows.size, declaredTotal, pageUrl: snap.pageUrl });
                if (rows.size >= declaredTotal) break;
                // Three consecutive pages with no new series is a much safer
                // end-of-catalog signal than the size of the visible pager.
                if (noNovelRounds >= 3) break;
              } catch (error) {
                errorRounds += 1;
                this.logger?.debug?.('Katalog-Gesamtzahl Seite fehlgeschlagen', { page, url: guess, message: error.message });
                if (errorRounds >= 3) break;
              }
            }
          }
        }
      }

      // Some modern catalog UIs expose only a small window of page links
      // (for example 1-4) and reveal later pages only via an icon/button. Walk
      // that control interactively until it disappears or repeatedly yields no
      // new titles. This is generic and does not depend on a particular site.
      if (rows.size >= 8 && rows.size < cap && interactivePages < pageCap) {
        const pagerStart = String(best?.pageUrl || requestedPage?.pageUrl || target);
        try {
          const pagerWin = await this._loadUnlocked(pagerStart, { settleMs: Math.min(500, settleMs), timeoutMs: 30000 });
          if (pagerWin && !pagerWin.isDestroyed()) pagerWin.hide();
          await this._expandCatalogPage(pagerWin, { rounds: 8, pauseMs: 350 });
          let previous = await this._catalogFingerprint(pagerWin);
          let noNovelRounds = 0;
          const seenFingerprints = new Set(previous?.key ? [previous.key] : []);

          while (interactivePages < pageCap && rows.size < cap) {
            const action = await this._catalogNextAction(pagerWin);
            if (!action) break;
            report('interactive-page', { url: pagerWin.webContents.getURL(), current: interactivePages + 1, max: pageCap, control: action.label });

            if (action.kind === 'url' && action.url) {
              await this._navigateWindow(pagerWin, action.url, { timeoutMs: 30000, settleMs: Math.min(450, settleMs) });
            } else {
              let changed = false;
              for (let wait = 0; wait < 20; wait += 1) {
                await sleep(250);
                const now = await this._catalogFingerprint(pagerWin);
                if (now?.key && now.key !== previous?.key) { changed = true; previous = now; break; }
              }
              if (!changed) await sleep(350);
            }

            await this._expandCatalogPage(pagerWin, { rounds: 8, pauseMs: 320 });
            const beforeCount = rows.size;
            const snap = await this._snapshotCatalogPage(pagerWin, { limit: cap });
            merge(snap);
            interactivePages += 1;
            const added = rows.size - beforeCount;
            const currentFingerprint = await this._catalogFingerprint(pagerWin);
            const repeated = Boolean(currentFingerprint?.key && seenFingerprints.has(currentFingerprint.key));
            if (currentFingerprint?.key) seenFingerprints.add(currentFingerprint.key);
            previous = currentFingerprint || previous;

            // A few already-known pages are normal when the first snapshot exposed
            // a short numeric window. Only stop after several consecutive rounds.
            if (added > 0) noNovelRounds = 0;
            else noNovelRounds += repeated ? 2 : 1;
            if (noNovelRounds >= 6) break;
          }
        } catch (error) {
          this.logger?.warn('Interaktive Katalog-Pagination konnte nicht fortgesetzt werden', { url: pagerStart, message: error.message });
        }
      }

      // Final cross-page cleanup: infer common series URL shapes and remove
      // low-confidence outliers that survived an individual page snapshot.
      let mergedItems = [...rows.values()];
      const routeCounts = new Map();
      for (const item of mergedItems) {
        const key = String(item.routeKey || '');
        if (key && Number(item.score || 0) >= 42) routeCounts.set(key, (routeCounts.get(key) || 0) + 1);
      }
      const commonRoutes = [...routeCounts.entries()]
        .filter(([, count]) => count >= 8)
        .sort((a,b) => b[1] - a[1])
        .slice(0, 4)
        .map(([key]) => key);
      if (commonRoutes.length) mergedItems = mergedItems.filter((item) => commonRoutes.includes(String(item.routeKey || '')) || Number(item.score || 0) >= 72);

      const items = mergedItems
        .sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base', numeric: true }))
        .slice(0, cap);
      const result = {
        requestedUrl: target,
        pageUrl: best?.pageUrl || requestedPage?.pageUrl || target,
        pageTitle: best?.pageTitle || requestedPage?.pageTitle || '',
        hostname: best?.hostname || requestedPage?.hostname || targetUrl.hostname,
        scannedLinks,
        pagesScanned: visited.size + interactivePages,
        loadMoreClicks,
        declaredTotal: Math.max(Number(best?.declaredTotal || 0), Number(requestedPage?.declaredTotal || 0)) || null,
        count: items.length,
        items,
        truncated: rows.size >= cap || visited.size >= pageCap || interactivePages >= pageCap,
        cached: false
      };
      this.catalogCache.set(cacheKey, { time: Date.now(), value: result });
      if (result.pageUrl) this.catalogCache.set(String(result.pageUrl).replace(/#.*$/, '').replace(/\/$/, ''), { time: Date.now(), value: result });
      report('done', { url: result.pageUrl, current: result.pagesScanned, max: pageCap, count: result.count });
      this.logger?.info('Vollständiger Serien-Katalog analysiert', {
        requestedUrl: target,
        catalogUrl: result.pageUrl,
        pagesScanned: result.pagesScanned,
        scannedLinks: result.scannedLinks,
        loadMoreClicks: result.loadMoreClicks,
        count: result.count,
        truncated: result.truncated
      });
      return result;
    });
  }

  async debugSeriesStatus(url, { referer = null, timeoutMs = 30000 } = {}) {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) throw new Error('Ungültige Serien-URL.');
    const report = { requestedUrl: target, http: null, browser: null };
    try {
      const response = await this._nodeRequest(target, {
        timeoutMs,
        referer,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        headers: { 'Cache-Control': 'no-cache' },
        quiet: true
      });
      const html = response.buffer.toString('utf8');
      report.http = { finalUrl: response.finalUrl || target, ...collectStatusDebugFromHtml(html) };
    } catch (error) {
      report.http = { error: String(error.message || error) };
    }
    try {
      report.browser = await this.serialize(async () => {
        const win = await this._loadUnlocked(target, { settleMs: 1800, timeoutMs, freshWindow: true, background: true });
        if (win && !win.isDestroyed()) win.hide();
        return win.webContents.executeJavaScript(`(() => {
          const clean = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
          const snippets = [];
          const add = (kind, value) => { const text = clean(value); if (!text) return; const key = kind + ':' + text; if (!snippets.some(x => x.key === key)) snippets.push({ key, kind, text: text.slice(0, 1200) }); };
          const statusRx = /\\b(?:status|state|ongoing|on\\s*going|publishing|updating|completed|complete|finished|ended|hiatus|on\\s+hold|paused|cancelled|canceled|discontinued|dropped|abandoned|upcoming|coming\\s+soon)\\b/i;
          for (const node of [...document.querySelectorAll('[data-status],[data-state],[class*=\"status\" i],[class*=\"state\" i],[id*=\"status\" i],[id*=\"state\" i]')].slice(0, 250)) {
            add('attr-node', [node.tagName, node.id, node.className, node.getAttribute?.('data-status'), node.getAttribute?.('data-state'), node.getAttribute?.('value'), node.textContent].filter(Boolean).join(' | '));
          }
          for (const node of [...document.querySelectorAll('body *')].slice(0, 15000)) {
            const own = clean(node.childElementCount ? [...node.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ') : node.textContent);
            if (/^(?:publication status|serialization status|series status|status|state)\\s*[:\\-]?$/i.test(own)) {
              add('label', node.outerHTML);
              add('label-parent', node.parentElement?.outerHTML);
              add('label-next', node.nextElementSibling?.outerHTML);
              add('label-parent-next', node.parentElement?.nextElementSibling?.outerHTML);
            } else if (/^(?:ongoing|on going|publishing|releasing|updating|completed|complete|finished|ended|hiatus|on hold|paused|cancelled|canceled|discontinued|dropped|abandoned|upcoming|coming soon)$/i.test(own)) {
              add('standalone-value', node.outerHTML);
            }
            if (snippets.length > 80) break;
          }
          for (const script of [...document.scripts].slice(0, 200)) {
            const text = String(script.textContent || '');
            if (!statusRx.test(text)) continue;
            const re = /(?:status|state|ongoing|completed|hiatus|cancelled|canceled|dropped|discontinued|publishing|upcoming)/ig;
            let m; let n = 0;
            while ((m = re.exec(text)) && n < 6) { add('script', text.slice(Math.max(0,m.index-220), Math.min(text.length,m.index+500))); n += 1; }
          }
          const bodyLines = String(document.body?.innerText || '').split(/\\r?\\n/).map(clean).filter(Boolean);
          const lineHits = [];
          for (let i=0;i<bodyLines.length && lineHits.length<40;i++) if (statusRx.test(bodyLines[i])) lineHits.push(bodyLines.slice(Math.max(0,i-2),Math.min(bodyLines.length,i+4)).join(' | ').slice(0,1200));
          return { url: location.href, title: document.title, htmlLang: document.documentElement?.lang || null, bodyLength: String(document.body?.innerText || '').length, lineHits, snippets: snippets.map(({key,...x}) => x) };
        })()`, true);
      });
    } catch (error) {
      report.browser = { error: String(error.message || error) };
    }
    try {
      const detected = await this.discoverSeriesStatus(target, { referer, timeoutMs });
      report.finalDetection = detected;
    } catch (error) {
      report.finalDetection = { status: 'unknown', error: String(error.message || error) };
    }
    this.logger?.info('Status-Debug erstellt', { url: target, finalStatus: report.finalDetection?.status || 'unknown', httpStatus: report.http?.detected?.status || 'unknown' });
    return report;
  }

  async discoverSeriesStatus(url, { referer = null, timeoutMs = 30000 } = {}) {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) throw new Error('Ungültige Serien-URL.');

    // First use the independent Node transport. It is much lighter than opening
    // hundreds of BrowserWindows and still reuses the persistent browser cookies.
    try {
      const response = await this._nodeRequest(target, {
        timeoutMs,
        referer,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        headers: { 'Cache-Control': 'no-cache' },
        quiet: true
      });
      const html = response.buffer.toString('utf8');
      const hit = extractSeriesStatusFromHtml(html);
      this.logger?.debug?.('Serienstatus über HTML geprüft', { url: target, status: hit.status, source: hit.source, bytes: response.buffer.length });
      if (hit.status !== 'unknown') return { url: response.finalUrl || target, status: hit.status, source: `http:${hit.source}` };
    } catch (error) {
      this.logger?.debug?.('Serienstatus HTTP-Prüfung fehlgeschlagen', { url: target, message: error.message });
    }

    // Browser fallback catches client-rendered metadata. It deliberately does
    // not require chapter detection, so a missing chapter selector cannot hide
    // an otherwise valid status.
    return this.serialize(async () => {
      const win = await this._loadUnlocked(target, { settleMs: 1100, timeoutMs });
      if (win && !win.isDestroyed()) win.hide();
      const result = await win.webContents.executeJavaScript(`(() => {
        const clean = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
        const norm = (value) => {
          const raw = clean(value).toLowerCase().replace(/[\\s_-]+/g, ' ');
          if (/\\b(?:cancelled|canceled|discontinued|axed)\\b/.test(raw)) return 'cancelled';
          if (/\\b(?:dropped|abandoned|stopped)\\b/.test(raw)) return 'dropped';
          if (/\\b(?:hiatus|on hiatus|on hold|paused|pause|suspended)\\b/.test(raw)) return 'hiatus';
          if (/\\b(?:completed|complete|finished|ended)\\b/.test(raw)) return 'completed';
          if (/\\b(?:upcoming|not yet released|coming soon|announced|pre release|pre-release|unreleased)\\b/.test(raw)) return 'upcoming';
          if (/\\b(?:ongoing|on going|publishing|releasing|active|serialization|serializing|updating)\\b/.test(raw)) return 'ongoing';
          return 'unknown';
        };
        const candidates = [];
        const push = (value, source, score) => { const status = norm(value); if (status !== 'unknown') candidates.push({ status, source, score }); };
        for (const node of [...document.querySelectorAll('[data-status],[data-state],[class*="status" i],[class*="state" i],[id*="status" i],[id*="state" i]')].slice(0, 300)) {
          push(node.getAttribute?.('data-status'), 'data-status', 110);
          push(node.getAttribute?.('data-state'), 'data-state', 110);
          push(node.getAttribute?.('value'), 'status-value', 109);
          push(node.className, 'status-class', 101);
          push(node.id, 'status-id', 101);
          push(node.textContent, 'status-node', 100);
        }
        for (const node of [...document.querySelectorAll('body *')].slice(0, 12000)) {
          const own = clean(node.childElementCount ? [...node.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ') : node.textContent);
          if (/^(?:ongoing|on going|publishing|releasing|updating|completed|complete|finished|ended|hiatus|on hold|paused|cancelled|canceled|discontinued|dropped|abandoned|upcoming|coming soon)$/i.test(own)) {
            let context = clean(node.parentElement?.textContent || '');
            const nearLabel = /\b(?:publication status|serialization status|series status|status|state)\b/i.test(context);
            push(own, nearLabel ? 'standalone-status-near-label' : 'standalone-status', nearLabel ? 109 : 82);
          }
        }
        for (const script of [...document.scripts].slice(0, 150)) {
          const text = String(script.textContent || '');
          for (const m of text.matchAll(/["']?(?:status|state|publicationStatus|seriesStatus|mangaStatus|comicStatus|releaseStatus)["']?\s*[:=]\s*["']([^"']{1,80})["']/gi)) push(m[1], 'script-status', 107);
        }

        // Common WordPress/Madara detail rows: a heading containing Status
        // and a separate summary/value element in the same row.
        const rows = [...document.querySelectorAll('.post-content_item,.post-content-item,.summary-item,.info-item,.detail-item,tr,dl,li')].slice(0, 500);
        for (const row of rows) {
          const rowText = clean(row.textContent);
          if (!/\\b(?:publication status|serialization status|series status|status|state)\\b/i.test(rowText)) continue;
          const heading = row.querySelector('.summary-heading,h1,h2,h3,h4,h5,h6,dt,th,label,strong,b');
          if (heading && !/\\b(?:publication status|serialization status|series status|status|state)\\b/i.test(clean(heading.textContent))) continue;
          const value = row.querySelector('.summary-content,dd,td,[class*="value" i],[class*="content" i]');
          push(value?.textContent || rowText, 'label-value-row', 108);
        }

        // Exact label node -> nearby sibling/container value.
        for (const node of [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,dt,th,label,strong,b,span,div,p')].slice(0, 2000)) {
          const label = clean(node.textContent);
          if (!/^(?:publication status|serialization status|series status|status|state)\\s*[:\\-]?$/i.test(label)) continue;
          let sibling = node.nextElementSibling;
          for (let step = 0; sibling && step < 4; step += 1, sibling = sibling.nextElementSibling) push(sibling.textContent, 'label-sibling', 106 - step);
          let parent = node.parentElement;
          for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) push(parent.textContent, 'label-parent', 104 - depth);
        }

        const rawText = String(document.body?.innerText || '');
        const lines = rawText.split(/\\r?\\n/).map(clean).filter(Boolean);
        for (let i = 0; i < lines.length; i += 1) {
          if (!/^(?:publication status|serialization status|series status|status|state)\\s*[:\\-]?$/i.test(lines[i])) continue;
          for (let j = i + 1; j < Math.min(lines.length, i + 6); j += 1) {
            const status = norm(lines[j]);
            if (status !== 'unknown') { candidates.push({ status, source: 'body-line', score: 105 - (j - i) }); break; }
          }
        }
        const text = clean(rawText);
        const explicit = text.match(/(?:publication status|serialization status|series status|status|state)\\s*[:\\-]?\\s*(ongoing|on going|publishing|releasing|active|serialization|serializing|updating|completed|complete|finished|ended|cancelled|canceled|discontinued|dropped|abandoned|hiatus|on hold|paused|upcoming|not yet released|coming soon)/i);
        if (explicit) push(explicit[1], 'body-label', 103);
        candidates.sort((a,b) => b.score - a.score);
        return candidates[0] || { status: 'unknown', source: 'not-found', score: 0 };
      })()`, true);
      this.logger?.debug?.('Serienstatus über Browser geprüft', { url: target, status: result?.status || 'unknown', source: result?.source || 'not-found' });
      return { url: win.webContents.getURL() || target, status: result?.status || 'unknown', source: `browser:${result?.source || 'not-found'}` };
    });
  }

  async discoverSeriesInfo(url, { settleMs = 650 } = {}) {
    return this.serialize(async () => {
      const target = String(url || '').trim();
      if (!/^https?:\/\//i.test(target)) throw new Error('Ungültige Serien-URL.');
      const win = await this._loadUnlocked(target, { settleMs, timeoutMs: 30000 });
      if (win && !win.isDestroyed()) win.hide();
      const result = await win.webContents.executeJavaScript(`(() => {
        const clean = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
        const abs = (v) => { try { return new URL(v, location.href).href.replace(/#.*$/, ''); } catch { return null; } };
        const normalizeLang = (value) => {
          const raw = clean(value).toLowerCase().replace(/_/g, '-');
          if (!raw) return null;
          const map = { english:'en', englisch:'en', eng:'en', en:'en', german:'de', deutsch:'de', deu:'de', ger:'de', de:'de', french:'fr', français:'fr', francais:'fr', fr:'fr', spanish:'es', español:'es', espanol:'es', es:'es', portuguese:'pt', português:'pt', portugues:'pt', pt:'pt', italian:'it', italiano:'it', it:'it', polish:'pl', polski:'pl', pl:'pl', russian:'ru', русский:'ru', ru:'ru', turkish:'tr', 'türkçe':'tr', turkce:'tr', tr:'tr', indonesian:'id', id:'id', vietnamese:'vi', vi:'vi', korean:'ko', ko:'ko', japanese:'ja', ja:'ja', chinese:'zh', zh:'zh', thai:'th', th:'th', arabic:'ar', ar:'ar' };
          return map[raw] || map[raw.split('-')[0]] || null;
        };
        const pageLanguage = (() => {
          const badge = document.querySelector('[data-language],[data-lang],[class*="language" i],[class*="lang-" i]');
          if (badge) {
            for (const value of [badge.getAttribute('data-language'), badge.getAttribute('data-lang'), badge.getAttribute('lang'), badge.textContent]) {
              const hit = normalizeLang(value); if (hit) return hit;
            }
          }
          const explicit = [
            document.querySelector('meta[http-equiv="content-language" i]')?.content,
            document.querySelector('meta[name="language" i]')?.content,
            document.querySelector('meta[property="og:locale" i]')?.content,
            document.documentElement?.getAttribute('lang')
          ];
          for (const value of explicit) { const hit = normalizeLang(value); if (hit) return hit; }
          try {
            const u = new URL(location.href);
            for (const key of ['lang','language','locale']) { const hit = normalizeLang(u.searchParams.get(key)); if (hit) return hit; }
            for (const part of u.pathname.split('/').filter(Boolean)) { if (part.length <= 7) { const hit = normalizeLang(part); if (hit) return hit; } }
          } catch {}
          return null;
        })();
        const normalizeStatus = (value) => {
          const raw = clean(value).toLowerCase().replace(/[\\s_-]+/g, ' ');
          if (!raw) return 'unknown';
          if (/\\b(?:cancelled|canceled|discontinued|axed)\\b/i.test(raw)) return 'cancelled';
          if (/\\b(?:dropped|abandoned|stopped)\\b/i.test(raw)) return 'dropped';
          if (/\\b(?:hiatus|on hiatus|on hold|paused|pause|suspended)\\b/i.test(raw)) return 'hiatus';
          if (/\\b(?:completed|complete|finished|ended)\\b/i.test(raw)) return 'completed';
          if (/\\b(?:upcoming|not yet released|coming soon|announced|pre[- ]?release|unreleased)\\b/i.test(raw)) return 'upcoming';
          if (/\\b(?:ongoing|on going|publishing|releasing|active|serialization|serializing|updating)\\b/i.test(raw)) return 'ongoing';
          return 'unknown';
        };
        const pageStatus = (() => {
          const candidates = [];
          const push = (value, score = 0) => { const text = clean(value); const status = normalizeStatus(text); if (status !== 'unknown') candidates.push({ status, score }); };
          for (const node of [...document.querySelectorAll('[data-status],[data-state],[class*=\"status\" i],[class*=\"state\" i],[class*=\"badge\" i]')].slice(0, 150)) {
            push(node.getAttribute?.('data-status'), 110); push(node.getAttribute?.('data-state'), 110); push(node.textContent, 98);
          }
          for (const row of [...document.querySelectorAll('.post-content_item,.post-content-item,.summary-item,.info-item,.detail-item,tr,dl,li')].slice(0, 500)) {
            const rowText = clean(row.textContent);
            if (!/\\b(?:publication status|serialization status|series status|status|state)\\b/i.test(rowText)) continue;
            const heading = row.querySelector('.summary-heading,h1,h2,h3,h4,h5,h6,dt,th,label,strong,b');
            if (heading && !/\\b(?:publication status|serialization status|series status|status|state)\\b/i.test(clean(heading.textContent))) continue;
            const value = row.querySelector('.summary-content,dd,td,[class*=\"value\" i],[class*=\"content\" i]');
            push(value?.textContent || rowText, 108);
          }
          const rawText = String(document.body?.innerText || '');
          const lines = rawText.split(/\\r?\\n/).map(clean).filter(Boolean);
          for (let i = 0; i < lines.length; i += 1) {
            if (!/^(?:publication status|serialization status|series status|status|state)\\s*[:\\-]?$/i.test(lines[i])) continue;
            for (let j = i + 1; j < Math.min(lines.length, i + 6); j += 1) push(lines[j], 106 - (j - i));
          }
          const bodyText = clean(rawText);
          const explicit = bodyText.match(/(?:publication status|serialization status|series status|status|state)\\s*[:\\-]?\\s*(ongoing|on going|publishing|releasing|active|serialization|serializing|updating|completed|complete|finished|ended|cancelled|canceled|discontinued|dropped|abandoned|hiatus|on hold|paused|upcoming|not yet released|coming soon)/i);
          if (explicit) push(explicit[1], 104);
          candidates.sort((a,b) => b.score - a.score);
          return candidates[0]?.status || 'unknown';
        })();
        const languageForNode = (el) => {
          let node = el;
          for (let depth = 0; depth < 5 && node; depth += 1, node = node.parentElement) {
            const marker = node.matches?.('[data-language],[data-lang],[lang],[class*="language" i],[class*="lang-" i]') ? node : node.querySelector?.('[data-language],[data-lang],[lang],[class*="language" i],[class*="lang-" i]');
            if (!marker) continue;
            for (const value of [marker.getAttribute?.('data-language'), marker.getAttribute?.('data-lang'), marker.getAttribute?.('lang'), marker.textContent]) {
              const hit = normalizeLang(value); if (hit) return hit;
            }
            const cls = String(marker.className || '');
            const m = cls.match(/(?:lang|language)[-_](en|de|fr|es|pt|it|pl|ru|tr|id|vi|ko|ja|zh|th|ar)(?:\b|_)/i);
            if (m) return normalizeLang(m[1]);
          }
          return pageLanguage;
        };
        const chapterRx = /(?:^|\\b)(?:chapter|chap(?:ter)?|ch\\.?|episode|ep\\.?)\\s*#?[-:]?\\s*(\\d+(?:[.,]\\d+)?)/i;
        const chapterPathRx = /(?:\\/|[-_])(?:chapter|chap|ch|episode|ep)(?:[-_\\/])?(\\d+(?:[.-]\\d+)?)(?:\\/|$|[-_?])/i;
        const badPath = /\\/(?:login|logout|register|account|profile|privacy|terms|dmca|contact|search|tag|genre|author|artist|bookmark|history)(?:[\\/-]|$)/i;
        const titleCandidates = [
          document.querySelector('meta[property="og:title"]')?.content,
          document.querySelector('meta[name="twitter:title"]')?.content,
          document.querySelector('[itemprop="name"]')?.textContent,
          document.querySelector('main h1')?.textContent,
          document.querySelector('article h1')?.textContent,
          document.querySelector('h1')?.textContent,
          document.querySelector('h2')?.textContent,
          document.title
        ].map(clean).filter(Boolean);
        let title = titleCandidates.find((t) => t.length >= 2 && t.length <= 180) || location.hostname;
        if (title === document.title && /\\s+[|–—-]\\s+/.test(title)) title = title.split(/\\s+[|–—-]\\s+/)[0].trim() || title;
        const ogImage = document.querySelector('meta[property="og:image"]')?.content || document.querySelector('meta[name="twitter:image"]')?.content || '';
        const cover = abs(ogImage);

        const rows = new Map();
        for (const a of [...document.querySelectorAll('a[href]')]) {
          const href = abs(a.getAttribute('href'));
          if (!href) continue;
          let u; try { u = new URL(href); } catch { continue; }
          if (u.origin !== location.origin || badPath.test(u.pathname)) continue;
          const text = clean(a.innerText || a.textContent || a.getAttribute('aria-label') || a.getAttribute('title'));
          const combined = text + ' ' + u.pathname;
          const tm = text.match(chapterRx);
          const pm = u.pathname.match(chapterPathRx);
          let score = 0;
          if (tm) score += 80;
          if (pm) score += 90;
          if (/chapter|chap|episode|ep/i.test(a.className || '')) score += 25;
          if (a.closest('[class*="chapter" i],[id*="chapter" i],[class*="episode" i],[id*="episode" i]')) score += 20;
          if (/\\/(?:chapter|chapters|episode|episodes)(?:\\/|-)/i.test(u.pathname)) score += 25;
          if (score < 55) continue;
          const rawNumber = tm?.[1] || pm?.[1] || null;
          const number = rawNumber == null ? null : Number(String(rawNumber).replace(',', '.').replace(/-(?=\\d+$)/, '.'));
          const concise = tm ? (text.match(/(?:chapter|chap(?:ter)?|ch\\.?|episode|ep\\.?)\\s*#?[-:]?\\s*\\d+(?:[.,]\\d+)?/i)?.[0] || text) : text;
          const chapterTitle = clean(concise) || (Number.isFinite(number) ? ('Chapter ' + number) : clean(u.pathname.split('/').filter(Boolean).pop()));
          const id = Number.isFinite(number) ? String(number) : href;
          const existing = rows.get(href);
          const item = { id, title: chapterTitle, url: href, number: Number.isFinite(number) ? number : null, downloaded: false, score, language: languageForNode(a) };
          if (!existing || item.score > existing.score || item.title.length < existing.title.length) rows.set(href, item);
        }
        let chapters = [...rows.values()];
        const numeric = chapters.filter((c) => Number.isFinite(c.number));
        if (numeric.length >= Math.max(3, Math.floor(chapters.length * 0.55))) {
          chapters.sort((a,b) => (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER));
        }
        return { title, url: location.href, cover, chapters, language: pageLanguage, pageLanguage, status: pageStatus, detected: true, pageTitle: document.title, hostname: location.hostname };
      })()`, true);
      if (!Array.isArray(result?.chapters) || !result.chapters.length) {
        throw new Error('Automatische Erkennung konnte auf dieser Serienseite keine Kapitel finden.');
      }
      this.logger?.info('Serie automatisch erkannt', { url: target, title: result.title, chapters: result.chapters.length });
      return result;
    });
  }

  async _cookieHeaderForUrl(url) {
    try {
      const cookies = await this.getSession().cookies.get({ url: String(url) });
      return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    } catch (error) {
      this.logger?.warn('Cookies konnten für direkten HTTP-Transport nicht gelesen werden', { url, message: error.message });
      return '';
    }
  }

  async _storeSetCookies(url, headers) {
    const values = Array.isArray(headers) ? headers : (headers ? [headers] : []);
    if (!values.length) return;
    const ses = this.getSession();
    for (const raw of values) {
      try {
        const parts = String(raw || '').split(';').map((part) => part.trim()).filter(Boolean);
        const first = parts.shift() || '';
        const eq = first.indexOf('=');
        if (eq <= 0) continue;
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1);
        const parsed = new URL(url);
        const details = { url: `${parsed.protocol}//${parsed.host}/`, name, value };
        for (const part of parts) {
          const [rawKey, ...rest] = part.split('=');
          const key = String(rawKey || '').trim().toLowerCase();
          const attrValue = rest.join('=').trim();
          if (key === 'path' && attrValue) details.path = attrValue;
          else if (key === 'domain' && attrValue) details.domain = attrValue.replace(/^\./, '');
          else if (key === 'secure') details.secure = true;
          else if (key === 'httponly') details.httpOnly = true;
          else if (key === 'samesite') {
            const same = attrValue.toLowerCase();
            details.sameSite = same === 'strict' ? 'strict' : same === 'none' ? 'no_restriction' : 'lax';
          } else if (key === 'max-age' && /^-?\d+$/.test(attrValue)) {
            const seconds = Number(attrValue);
            if (seconds > 0) details.expirationDate = Math.floor(Date.now() / 1000) + seconds;
          } else if (key === 'expires' && attrValue) {
            const when = Date.parse(attrValue);
            if (Number.isFinite(when)) details.expirationDate = Math.floor(when / 1000);
          }
        }
        await ses.cookies.set(details);
      } catch (error) {
        this.logger?.warn('Set-Cookie konnte nicht in Browser-Session übernommen werden', { url, message: error.message });
      }
    }
  }

  async _nodeRequest(url, options = {}, redirectCount = 0) {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) throw new Error(`Nicht unterstützte HTTP-URL: ${target}`);
    if (redirectCount > 8) throw new Error('Zu viele HTTP-Weiterleitungen.');
    const parsed = new URL(target);
    const cookie = await this._cookieHeaderForUrl(target);
    const headers = {
      'Accept': options.accept || '*/*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
      'Connection': 'keep-alive',
      ...(options.headers || {})
    };
    if (!headers['User-Agent'] && !headers['user-agent']) headers['User-Agent'] = this.userAgent || 'Mozilla/5.0';
    if (options.referer && !headers.Referer && !headers.referer) headers.Referer = String(options.referer);
    if (cookie && !headers.Cookie && !headers.cookie) headers.Cookie = cookie;
    const timeoutMs = Math.max(3000, Number(options.timeoutMs) || 30000);
    const transport = parsed.protocol === 'https:' ? https : http;
    if (!options.quiet) this.logger?.info('Direkter Node-HTTP-Request', { url: target, referer: options.referer || null, cookieCount: cookie ? cookie.split(';').length : 0 });

    const result = await new Promise((resolve, reject) => {
      const req = transport.request(parsed, {
        method: options.method || 'GET',
        headers,
        timeout: timeoutMs
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, statusMessage: res.statusMessage || '', headers: res.headers, buffer: Buffer.concat(chunks) }));
      });
      req.on('timeout', () => req.destroy(new Error(`Zeitüberschreitung beim HTTP-Abruf von ${target}`)));
      req.on('error', reject);
      req.end();
    });

    await this._storeSetCookies(target, result.headers['set-cookie']);
    const status = Number(result.statusCode || 0);
    if ([301, 302, 303, 307, 308].includes(status) && result.headers.location) {
      const nextUrl = new URL(String(result.headers.location), target).href;
      return this._nodeRequest(nextUrl, { ...options, referer: target, method: status === 303 ? 'GET' : (options.method || 'GET') }, redirectCount + 1);
    }
    const body = decodeContentEncoding(result.buffer, result.headers['content-encoding']);
    if (status < 200 || status >= 300) {
      const error = new Error(`HTTP ${status}${result.statusMessage ? ` ${result.statusMessage}` : ''} für ${target}`);
      error.statusCode = status;
      throw error;
    }
    return { buffer: body, headers: result.headers, finalUrl: target, statusCode: status };
  }

  async _fetchReaderPagesFromHtml(url, { referer = null, timeoutMs = 30000 } = {}) {
    const target = String(url || '').trim();
    this.logger?.info('Reader-HTML wird über unabhängigen Node-HTTP-Transport abgerufen', { url: target, referer: referer || null });
    this.onEvent({ type: 'reader-http-fallback-start', url: target });
    const response = await this._nodeRequest(target, {
      timeoutMs,
      referer,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
    });
    const html = response.buffer.toString('utf8');
    const finalUrl = response.finalUrl || target;
    const pages = extractReaderPagesFromHtml(html, finalUrl);
    if (!pages.length) throw new Error('Direkter HTTP-Fallback hat keine eindeutigen Reader-Bilder gefunden.');
    this.logger?.info('Reader-Seiten über unabhängigen HTTP-Fallback erkannt', { url: target, finalUrl, pages: pages.length, bytes: response.buffer.length });
    this.onEvent({ type: 'reader-http-fallback-done', url: target, pageCount: pages.length });
    return pages;
  }

  async discoverReaderPages(url, { settleMs = 550, scrollRounds = 14, referer = null } = {}) {
    return this.serialize(async () => {
      const target = String(url || '').trim();
      if (!/^https?:\/\//i.test(target)) throw new Error('Ungültige Kapitel-URL.');
      let win;
      try {
        // One direct navigation attempt first. If Chromium itself refuses the main-frame
        // request with ERR_BLOCKED_BY_CLIENT, do not keep destroying/retrying the renderer;
        // switch to the same persistent session's HTTP stack instead.
        win = await this._loadUnlocked(target, { settleMs, timeoutMs: 30000, referer, freshWindow: true, background: true, retry: false });
      } catch (error) {
        if (isBlockedByClient(error)) {
          this.logger?.warn('Reader-Navigation wurde von Chromium blockiert; HTTP-Fallback wird verwendet', { url: target, message: error.message });
          return this._fetchReaderPagesFromHtml(target, { referer, timeoutMs: 30000 });
        }
        // The HTTP fallback is also useful for server-rendered reader pages when a
        // navigation fails for another transient Chromium reason. Preserve the original
        // error if the fallback cannot extract anything.
        try {
          return await this._fetchReaderPagesFromHtml(target, { referer, timeoutMs: 30000 });
        } catch (fallbackError) {
          this.logger?.warn('Reader-HTTP-Fallback ebenfalls fehlgeschlagen', { url: target, original: error.message, fallback: fallbackError.message });
          throw error;
        }
      }
      if (win && !win.isDestroyed()) win.hide();
      const rounds = Math.max(2, Math.min(24, Number(scrollRounds) || 14));
      let stable = 0;
      let lastHeight = 0;
      for (let i = 0; i < rounds; i++) {
        const info = await win.webContents.executeJavaScript(`(() => {
          const h = Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0);
          const step = Math.max(window.innerHeight * 0.9, 700);
          window.scrollBy({ top: step, left: 0, behavior: 'instant' });
          return { height: h, y: window.scrollY, images: document.images.length };
        })()`, true).catch(() => null);
        await sleep(180);
        if (!info) continue;
        if (Math.abs(Number(info.height || 0) - lastHeight) < 20) stable += 1; else stable = 0;
        lastHeight = Number(info.height || 0);
        if (stable >= 3 && Number(info.y || 0) + 1000 >= lastHeight) break;
      }
      await win.webContents.executeJavaScript(`window.scrollTo({ top: 0, left: 0, behavior: 'instant' })`, true).catch(() => null);
      await sleep(200);
      const pages = await win.webContents.executeJavaScript(`(() => {
        const abs = (v) => { try { return new URL(v, location.href).href; } catch { return null; } };
        const clean = (v) => String(v || '').trim();
        const fromSrcset = (v) => {
          const parts = clean(v).split(',').map((p) => p.trim()).filter(Boolean);
          return parts.length ? (parts[parts.length - 1].split(/\\s+/)[0] || '') : '';
        };
        const rawUrl = (img) => img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') ||
          img.getAttribute('data-original') || img.getAttribute('data-url') || img.getAttribute('data-cfsrc') ||
          fromSrcset(img.getAttribute('data-srcset') || img.getAttribute('srcset')) ||
          fromSrcset(img.closest('picture')?.querySelector('source')?.getAttribute('srcset'));
        const bad = (value) => /(?:logo|icon|avatar|emoji|banner|advert|\\bad[sx]?\\b|tracking|pixel|sprite|placeholder|spinner|loading)/i.test(value || '');
        const readerSelectors = [
          '[class*="reader" i]', '[id*="reader" i]', '[class*="chapter-content" i]', '[id*="chapter-content" i]',
          '[class*="reading-content" i]', '[class*="comic" i][class*="content" i]', '[class*="pages" i]',
          'main article', 'article', 'main'
        ];
        const readerRoots = readerSelectors.flatMap((sel) => { try { return [...document.querySelectorAll(sel)]; } catch { return []; } });
        const inReader = (img) => readerRoots.some((root) => root.contains(img));
        const candidates = [];
        for (const img of [...document.images]) {
          const raw = rawUrl(img);
          const url = abs(raw);
          if (!url || !/^(?:https?:|data:)/i.test(url)) continue;
          const meta = [url, img.alt, img.className, img.id, img.parentElement?.className].join(' ');
          if (bad(meta)) continue;
          const r = img.getBoundingClientRect();
          const nw = Number(img.naturalWidth || img.width || r.width || 0);
          const nh = Number(img.naturalHeight || img.height || r.height || 0);
          let score = 0;
          if (inReader(img)) score += 85;
          if (nw >= 500) score += 35; else if (nw >= 320) score += 18;
          if (nh >= 700) score += 40; else if (nh >= 450) score += 20;
          if (nh > nw * 1.15) score += 14;
          if (/chapter|page|reader|comic|manga|manhwa/i.test(meta)) score += 20;
          if (nw > 0 && nh > 0 && (nw < 180 || nh < 180)) score -= 60;
          candidates.push({ url, score, nw, nh, referer: location.href });
        }
        const dedup = new Map();
        for (const item of candidates) {
          const old = dedup.get(item.url);
          if (!old || item.score > old.score) dedup.set(item.url, item);
        }
        const all = [...dedup.values()];
        const strongReader = all.filter((x) => x.score >= 90);
        const selected = strongReader.length >= 2 ? strongReader : all.filter((x) => x.score >= 55);
        return selected.slice(0, 500).map((item, index) => ({ url: item.url, index: index + 1, filename: null, referer: item.referer }));
      })()`, true);
      if (!Array.isArray(pages) || !pages.length) {
        try {
          return await this._fetchReaderPagesFromHtml(target, { referer, timeoutMs: 30000 });
        } catch {
          throw new Error('Automatische Reader-Erkennung konnte keine eindeutigen Comic-Seiten finden.');
        }
      }
      this.logger?.info('Reader-Seiten automatisch erkannt', { url: target, pages: pages.length });
      return pages;
    });
  }

  async pickElement({ url = null, mode = 'generic', timeoutMs = 90000 } = {}) {
    return this.serialize(async () => {
      const win = url ? await this._loadUnlocked(url, { settleMs: 350, timeoutMs: 30000 }) : await this.ensureWindow();
      win.show();
      win.focus();
      this.logger?.info('Element-Picker gestartet', { mode, url: win.webContents.getURL() });
      const payload = JSON.stringify({ mode, timeoutMs: Math.max(10000, Math.min(180000, Number(timeoutMs) || 90000)) });
      const result = await win.webContents.executeJavaScript(`(() => new Promise((resolve) => {
        const cfg = ${payload};
        const existing = document.getElementById('__mw_picker_style');
        if (existing) existing.remove();
        document.getElementById('__mw_picker_tip')?.remove();

        const esc = (value) => CSS.escape(String(value || ''));
        const internalClass = (name) => /^__mw_/i.test(String(name || ''));
        const looksGenerated = (name) => /^[a-f0-9]{10,}$/i.test(String(name || '')) || /^[A-Za-z0-9_-]{20,}$/.test(String(name || ''));
        const cleanClasses = (el) => [...(el?.classList || [])]
          .filter((name) => name && name.length < 64 && !internalClass(name) && !looksGenerated(name))
          .slice(0, 6);
        const qcount = (selector) => { try { return document.querySelectorAll(selector).length; } catch { return 0; } };
        const textOf = (el) => (el?.innerText || el?.textContent || el?.getAttribute?.('alt') || '').replace(/\\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el?.getBoundingClientRect) return false;
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
        };
        const genericBareTags = new Set(['div','span','a','p','section','article','main','li','ul','ol','button','label']);
        const isBareGeneric = (selector) => genericBareTags.has(String(selector || '').toLowerCase());
        const selectorSignals = (selector) => ({
          id: selector.includes('#'),
          attr: selector.includes('['),
          cls: selector.includes('.'),
          parent: selector.includes('>') || selector.includes(' '),
          semantic: /^(?:h1|h2|h3|img)(?:$|[#.\\[])/i.test(selector)
        });

        const classify = (item, targetText) => {
          if (!item || !item.selector || item.count < 1 || isBareGeneric(item.selector)) return { quality: 'bad', qualityLabel: 'Ungeeignet', symbol: '✗' };
          const signals = selectorSignals(item.selector);
          if (cfg.mode === 'title') {
            if (!targetText) return { quality: 'bad', qualityLabel: 'Kein Text', symbol: '✗' };
            if (item.count === 1 && (signals.id || signals.attr || signals.cls || signals.semantic)) return { quality: 'very-good', qualityLabel: 'Sehr gut', symbol: '✓' };
            if (item.count <= 3) return { quality: 'good', qualityLabel: 'Gut', symbol: '✓' };
            if (item.count <= 10) return { quality: 'warning', qualityLabel: 'Zu breit', symbol: '⚠' };
            return { quality: 'bad', qualityLabel: 'Viel zu allgemein', symbol: '✗' };
          }
          if (cfg.mode === 'chapters') {
            if (item.count >= 2 && item.count <= 250 && /^a(?:$|[#.\\[])/i.test(item.selector)) return { quality: 'very-good', qualityLabel: 'Sehr gut', symbol: '✓' };
            if (item.count >= 2 && item.count <= 250) return { quality: 'good', qualityLabel: 'Gut', symbol: '✓' };
            if (item.count === 1) return { quality: 'warning', qualityLabel: 'Nur ein Treffer', symbol: '⚠' };
            return { quality: 'bad', qualityLabel: 'Zu allgemein', symbol: '✗' };
          }
          if (cfg.mode === 'pages') {
            if (item.count >= 2 && /^img(?:$|[#.\\[])/i.test(item.selector)) return { quality: 'very-good', qualityLabel: 'Sehr gut', symbol: '✓' };
            if (item.count >= 1 && /^img(?:$|[#.\\[])/i.test(item.selector)) return { quality: 'good', qualityLabel: 'Gut', symbol: '✓' };
            if (item.count >= 1) return { quality: 'warning', qualityLabel: 'Prüfen', symbol: '⚠' };
            return { quality: 'bad', qualityLabel: 'Ungeeignet', symbol: '✗' };
          }
          return item.count === 1
            ? { quality: 'good', qualityLabel: 'Gut', symbol: '✓' }
            : { quality: 'warning', qualityLabel: 'Prüfen', symbol: '⚠' };
        };

        const stableClassWeight = (name) => {
          const value = String(name || '').toLowerCase();
          let score = 0;
          if (/(title|heading|chapter|reader|page|comic|manga|content|entry|episode|name)/.test(value)) score += 40;
          if (/^(?:text-|bg-|flex|grid|gap-|p-|m-|w-|h-|items-|justify-|rounded|border|font-|leading-|tracking-|hover:|visited:|dark:)/.test(value)) score -= 8;
          if (value.length <= 28) score += 5;
          return score;
        };

        const generalizedHrefSelector = (el, tag) => {
          const href = el?.getAttribute?.('href');
          if (!href || tag !== 'a') return [];
          const out = [];
          const path = String(href).split(/[?#]/)[0];
          const patterns = [
            /(.*\\/chapter[-_/])\\d+(?:[.-]\\d+)?\\/?$/i,
            /(.*\\/chap[-_/])\\d+(?:[.-]\\d+)?\\/?$/i,
            /(.*\\/ch[-_/])\\d+(?:[.-]\\d+)?\\/?$/i,
            /(.*\\/episode[-_/])\\d+(?:[.-]\\d+)?\\/?$/i
          ];
          for (const re of patterns) {
            const match = path.match(re);
            if (!match?.[1]) continue;
            let needle = match[1];
            try {
              const parsed = new URL(needle, location.href);
              needle = parsed.pathname;
            } catch {}
            if (needle.length >= 3 && needle.length < 180) out.push('a[href*="' + needle.replace(/"/g, '\\\\"') + '"]');
          }
          return out;
        };

        const candidatesFor = (el) => {
          const raw = [];
          if (!el?.tagName) return raw;
          const tag = el.tagName.toLowerCase();
          const targetText = textOf(el);
          const push = (selector, source) => {
            if (!selector || /__mw_/i.test(selector)) return;
            const count = qcount(selector);
            if (count < 1) return;
            raw.push({ selector, count, source });
          };

          if (el.id && !/^__mw_/i.test(el.id)) push(tag + '#' + esc(el.id), 'id');
          for (const attr of ['data-testid','data-id','data-slot','itemprop','aria-label','role']) {
            const value = el.getAttribute?.(attr);
            if (value && String(value).length < 100 && !String(value).includes('__mw_')) {
              push(tag + '[' + attr + '="' + String(value).replace(/"/g, '\\\\"') + '"]', 'attribute');
            }
          }

          const classes = cleanClasses(el).sort((a,b) => stableClassWeight(b) - stableClassWeight(a));
          for (const cls of classes.slice(0,4)) push(tag + '.' + esc(cls), 'class');
          if (classes.length > 1) push(tag + classes.slice(0,2).map((c) => '.' + esc(c)).join(''), 'classes');
          if (classes.length > 2) push(tag + classes.slice(0,3).map((c) => '.' + esc(c)).join(''), 'classes');

          if (cfg.mode === 'chapters') {
            for (const selector of generalizedHrefSelector(el, tag)) push(selector, 'href-pattern');
          }

          const parent = el.parentElement;
          if (parent?.tagName) {
            const ptag = parent.tagName.toLowerCase();
            const pclasses = cleanClasses(parent).sort((a,b) => stableClassWeight(b) - stableClassWeight(a));
            if (pclasses.length) {
              const childPart = classes[0] ? tag + '.' + esc(classes[0]) : tag;
              push(ptag + '.' + esc(pclasses[0]) + ' > ' + childPart, 'parent');
            }
          }

          if (cfg.mode === 'title' && ['h1','h2','h3'].includes(tag)) push(tag, 'semantic');
          if (cfg.mode === 'pages' && tag === 'img') push('img', 'semantic');

          const seen = new Set();
          const unique = raw.filter((item) => !seen.has(item.selector) && seen.add(item.selector));
          for (const item of unique) {
            const signals = selectorSignals(item.selector);
            let score = 0;
            if (item.source === 'id') score += 180;
            if (item.source === 'attribute') score += 150;
            if (item.source === 'href-pattern') score += 170;
            if (item.source === 'classes') score += 105;
            if (item.source === 'class') score += 80;
            if (item.source === 'parent') score += 55;
            if (signals.semantic) score += 80;
            if (isBareGeneric(item.selector)) score -= 10000;

            if (cfg.mode === 'title') {
              score += targetText ? 220 : -800;
              if (targetText.length > 180) score -= 250;
              if (item.count === 1) score += 1000;
              else if (item.count <= 3) score += 420;
              else score -= Math.min(item.count, 500) * 24;
              if (/^h[1-3]/i.test(item.selector)) score += 180;
            } else if (cfg.mode === 'chapters') {
              if (item.count >= 2 && item.count <= 250) score += 900 + Math.min(item.count, 120) * 3;
              else if (item.count === 1) score -= 180;
              else score -= 800;
              if (/^a(?:$|[#.\\[])/i.test(item.selector)) score += 180;
              if (item.source === 'href-pattern') score += 180;
            } else if (cfg.mode === 'pages') {
              if (item.count >= 2 && item.count <= 300) score += 900 + Math.min(item.count, 100) * 2;
              else if (item.count === 1) score += 300;
              else score -= 500;
              if (/^img(?:$|[#.\\[])/i.test(item.selector)) score += 220;
            } else {
              score += item.count === 1 ? 600 : 100;
            }
            score -= Math.min(item.selector.length, 180) * 0.6;
            item.score = Math.round(score);
            Object.assign(item, classify(item, targetText));
          }
          return unique
            .filter((item) => item.quality !== 'bad')
            .sort((a,b) => b.score - a.score || a.count - b.count || a.selector.length - b.selector.length);
        };

        const choose = (items) => items.find((item) => item.quality === 'very-good') || items.find((item) => item.quality === 'good') || items[0] || null;

        const titleDescendant = (raw) => {
          if (!raw?.querySelectorAll) return null;
          const preferred = [...raw.querySelectorAll('h1,h2,h3,[itemprop="name"],[data-testid*="title" i],[class*="title" i],strong,span,p')]
            .filter((el) => visible(el))
            .map((el) => {
              const text = textOf(el);
              const rect = el.getBoundingClientRect();
              let score = 0;
              if (!text || text.length > 180) return null;
              if (/^H[1-3]$/.test(el.tagName)) score += 500;
              if (el.matches?.('[itemprop="name"],[data-testid*="title" i],[class*="title" i]')) score += 300;
              if (text.length >= 2 && text.length <= 90) score += 180;
              score -= Math.min(rect.width * rect.height / 1000, 300);
              return { el, score };
            })
            .filter(Boolean)
            .sort((a,b) => b.score - a.score);
          return preferred[0]?.el || null;
        };

        const normalizeTarget = (raw) => {
          if (!raw?.closest) return { target: raw, adjusted: false, fromTag: raw?.tagName?.toLowerCase() || '' };
          const fromTag = raw.tagName?.toLowerCase() || '';
          if (cfg.mode === 'title') {
            const semantic = raw.closest('h1,h2,h3,[itemprop="name"],[data-testid*="title" i],[class*="title" i]');
            if (semantic && visible(semantic) && textOf(semantic)) return { target: semantic, adjusted: semantic !== raw, fromTag };
            const rawText = textOf(raw);
            if (!rawText || rawText.length > 180 || ['div','section','article','main'].includes(fromTag)) {
              const child = titleDescendant(raw);
              if (child) return { target: child, adjusted: child !== raw, fromTag };
            }
            return { target: raw, adjusted: false, fromTag };
          }
          if (cfg.mode === 'chapters') {
            const target = raw.closest('a[href]') || raw;
            return { target, adjusted: target !== raw, fromTag };
          }
          if (cfg.mode === 'pages') {
            const target = raw.closest('img') || raw.querySelector?.('img') || raw;
            return { target, adjusted: target !== raw, fromTag };
          }
          return { target: raw, adjusted: false, fromTag };
        };

        const style = document.createElement('style');
        style.id = '__mw_picker_style';
        style.textContent = '#__mw_picker_tip{position:fixed;z-index:2147483647;left:16px;top:16px;max-width:min(720px,calc(100vw - 32px));background:#0b1020;color:#fff;border:1px solid #ffbd2e;border-radius:10px;padding:10px 14px;font:13px system-ui;box-shadow:0 8px 30px #0008;pointer-events:none}#__mw_picker_box{position:fixed;z-index:2147483646;pointer-events:none;border:3px solid #ffbd2e;border-radius:4px;box-shadow:0 0 0 2px rgba(0,0,0,.45),0 0 18px rgba(255,189,46,.45);background:rgba(255,189,46,.06);display:none}html.__mw_picker_active,html.__mw_picker_active *{cursor:crosshair !important}';
        document.documentElement.appendChild(style);
        document.documentElement.classList.add('__mw_picker_active');
        const tip = document.createElement('div');
        tip.id = '__mw_picker_tip';
        tip.textContent = 'Manhwa Watcher: Element anklicken · gelber Rahmen = Auswahl · ESC = Abbrechen';
        const box = document.createElement('div');
        box.id = '__mw_picker_box';
        document.documentElement.append(tip, box);
        let hover = null;

        const drawBox = (target) => {
          if (!target?.getBoundingClientRect || target === document.documentElement || target === document.body) { box.style.display = 'none'; return; }
          const r = target.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) { box.style.display = 'none'; return; }
          box.style.display = 'block';
          box.style.left = Math.max(0, r.left - 2) + 'px';
          box.style.top = Math.max(0, r.top - 2) + 'px';
          box.style.width = Math.max(1, r.width + 4) + 'px';
          box.style.height = Math.max(1, r.height + 4) + 'px';
        };
        const cleanup = () => {
          clearTimeout(timer);
          document.removeEventListener('mousemove', move, true);
          document.removeEventListener('scroll', redraw, true);
          window.removeEventListener('resize', redraw, true);
          document.removeEventListener('click', click, true);
          document.removeEventListener('keydown', key, true);
          document.documentElement.classList.remove('__mw_picker_active');
          style.remove(); tip.remove(); box.remove();
        };
        const move = (event) => {
          const raw = document.elementFromPoint(event.clientX, event.clientY) || event.target;
          const normalized = normalizeTarget(raw);
          const target = normalized.target;
          if (!target || target === tip || target === box || target === document.documentElement || target === document.body) return;
          hover = target;
          drawBox(target);
          const previewText = textOf(target).slice(0, 100) || '(kein Text)';
          tip.textContent = 'Manhwa Watcher: ' + (target.tagName?.toLowerCase() || '?') + ' · ' + previewText + ' · klicken · ESC = Abbrechen';
        };
        const redraw = () => { if (hover) drawBox(hover); };
        const click = (event) => {
          const raw = document.elementFromPoint(event.clientX, event.clientY) || event.target;
          const normalized = normalizeTarget(raw);
          const target = normalized.target;
          if (!target || target === tip || target === box) return;
          event.preventDefault(); event.stopImmediatePropagation();
          const suggestions = candidatesFor(target);
          const best = choose(suggestions);
          const selector = best?.selector || null;
          const attrs = {};
          for (const name of ['href','src','data-src','data-lazy-src','data-original','class','id']) {
            const value = target.getAttribute?.(name); if (value && !String(value).includes('__mw_')) attrs[name] = value;
          }
          const result = {
            cancelled: false,
            mode: cfg.mode,
            selector,
            count: selector ? qcount(selector) : 0,
            quality: best?.quality || 'bad',
            qualityLabel: best?.qualityLabel || 'Kein brauchbarer Selektor',
            symbol: best?.symbol || '✗',
            tag: target.tagName?.toLowerCase() || '',
            originalTag: normalized.fromTag,
            autoAdjusted: Boolean(normalized.adjusted),
            text: textOf(target).slice(0, 240),
            attributes: attrs,
            suggestions: suggestions.slice(0, 12),
            warning: selector ? null : 'Kein stabiler CSS-Selektor gefunden. Bitte direkt auf das gewünschte Textelement klicken.',
            pageUrl: location.href
          };
          cleanup(); resolve(result);
        };
        const key = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault(); cleanup(); resolve({ cancelled: true, mode: cfg.mode, pageUrl: location.href });
          }
        };
        document.addEventListener('mousemove', move, true);
        document.addEventListener('scroll', redraw, true);
        window.addEventListener('resize', redraw, true);
        document.addEventListener('click', click, true);
        document.addEventListener('keydown', key, true);
        const timer = setTimeout(() => { cleanup(); resolve({ cancelled: true, timeout: true, mode: cfg.mode, pageUrl: location.href }); }, cfg.timeoutMs);
      }))()`, true);
      this.logger?.info('Element-Picker beendet', {
        mode,
        cancelled: Boolean(result?.cancelled),
        selector: result?.selector || null,
        count: result?.count || 0,
        quality: result?.quality || null,
        autoAdjusted: Boolean(result?.autoAdjusted)
      });
      return result;
    });
  }

  async highlightSelector({ url = null, selector, limit = 80 } = {}) {
    if (!selector) throw new Error('CSS-Selektor fehlt.');
    return this.serialize(async () => {
      const win = url ? await this._loadUnlocked(url, { settleMs: 250, timeoutMs: 30000 }) : await this.ensureWindow();
      win.show(); win.focus();
      const payload = JSON.stringify({ selector, limit: Math.max(1, Math.min(200, Number(limit) || 80)) });
      const result = await win.webContents.executeJavaScript(`(() => {
        document.querySelectorAll('.__mw_highlight').forEach((el) => el.classList.remove('__mw_highlight'));
        let style = document.getElementById('__mw_highlight_style');
        if (!style) { style = document.createElement('style'); style.id='__mw_highlight_style'; style.textContent='.__mw_highlight{outline:3px solid #ffbd2e !important;outline-offset:2px !important;background-color:rgba(255,189,46,.08) !important}'; document.documentElement.appendChild(style); }
        const cfg = ${payload};
        let nodes = [];
        try { nodes = [...document.querySelectorAll(cfg.selector)]; } catch (error) { return { error: 'Ungültiger CSS-Selektor: ' + error.message, count: 0 }; }
        nodes.slice(0,cfg.limit).forEach((el) => el.classList.add('__mw_highlight'));
        nodes[0]?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
        return { count: nodes.length, highlighted: Math.min(nodes.length,cfg.limit), pageUrl: location.href };
      })()`, true);
      this.logger?.info('Selektor im Browser markiert', { selector, count: result?.count || 0 });
      return result;
    });
  }

  async clearHighlights() {
    return this.serialize(async () => {
      const win = await this.ensureWindow();
      return win.webContents.executeJavaScript(`(() => { const nodes=[...document.querySelectorAll('.__mw_highlight')]; nodes.forEach((el)=>el.classList.remove('__mw_highlight')); document.getElementById('__mw_highlight_style')?.remove(); return nodes.length; })()`, true);
    });
  }

  async openLockedReader(rawUrl) {
    const requestedUrl = String(rawUrl || '').trim();
    if (!/^https?:\/\//i.test(requestedUrl)) throw new Error('Ungültige Reader-URL.');

    return this.serialize(async () => {
      // Always start the online reader in a fresh window. A reader page may run
      // advertising/redirect scripts after it has been visible for a while; those
      // must never influence the next chapter the user opens.
      let win = await this.ensureWindow({ fresh: true, preserveVisibility: false });
      win.hide();
      await this._navigateWindow(win, requestedUrl, { timeoutMs: 30000, settleMs: 150, bypassCache: false });

      let finalUrl = String(win.webContents.getURL() || requestedUrl);
      const compatible = (wanted, actual) => {
        try {
          const a = new URL(wanted); const b = new URL(actual);
          if (a.origin !== b.origin) return false;
          const clean = (p) => decodeURIComponent(p).replace(/\/+$/, '').toLowerCase();
          const ap = clean(a.pathname); const bp = clean(b.pathname);
          if (ap === bp) return true;
          // Canonical redirects often add/remove a suffix or a trailing chapter
          // segment. Keep them only when the meaningful path tokens still overlap.
          const tokens = (p) => p.split('/').filter(Boolean).filter((x) => x.length > 2 && !/^(?:chapter|chap|ch|read|reader|webtoon|manga|manhwa)$/i.test(x));
          const at = tokens(ap); const bt = new Set(tokens(bp));
          const overlap = at.filter((x) => bt.has(x)).length;
          const numbersA = new Set((ap.match(/\d+(?:\.\d+)?/g) || []));
          const numbersB = new Set((bp.match(/\d+(?:\.\d+)?/g) || []));
          const numberOverlap = [...numbersA].some((x) => numbersB.has(x));
          return overlap >= Math.min(2, Math.max(1, at.length)) && (numbersA.size === 0 || numberOverlap);
        } catch { return false; }
      };

      if (!compatible(requestedUrl, finalUrl)) {
        this.logger?.warn('Online-Reader wurde unerwartet umgeleitet; Original-URL wird erneut geladen', { requestedUrl, finalUrl });
        win = await this.ensureWindow({ fresh: true, preserveVisibility: false });
        await this._navigateWindow(win, requestedUrl, { timeoutMs: 30000, settleMs: 80, bypassCache: true });
        finalUrl = String(win.webContents.getURL() || requestedUrl);
        if (!compatible(requestedUrl, finalUrl)) {
          this.logger?.warn('Online-Reader blockiert fremde Zielseite', { requestedUrl, finalUrl });
          try { win.destroy(); } catch {}
          this.window = null;
          throw new Error('Die Webseite hat den Reader auf einen anderen Titel umgeleitet. Die Navigation wurde blockiert.');
        }
      }

      // Once the correct reader is loaded, keep this window on the same chapter.
      // Popups are already denied globally; this additionally blocks scripts that
      // try to replace the main document with another title/advertising route.
      const lockedUrl = finalUrl;
      const guard = (event, nextUrl) => {
        if (!compatible(lockedUrl, nextUrl)) {
          event.preventDefault();
          this.logger?.warn('Online-Reader: unerwartete Hauptnavigation blockiert', { lockedUrl, nextUrl });
        }
      };
      win.webContents.on('will-navigate', guard);
      win.once('closed', () => { try { win.webContents?.removeListener?.('will-navigate', guard); } catch {} });
      win.show();
      win.focus();
      this.lastRequestedUrl = requestedUrl;
      this.lastLoadedUrl = finalUrl;
      return { visible: true, url: finalUrl, title: win.webContents.getTitle() };
    });
  }

  async setVisible(visible, { fallbackUrl = null } = {}) {
    return this.serialize(async () => {
      let win = await this.ensureWindow();
      if (visible) {
        const current = win.webContents.getURL();
        const target = String(fallbackUrl || this.lastRequestedUrl || this.lastLoadedUrl || '').trim();
        if ((!current || current === 'about:blank') && /^https?:\/\//i.test(target)) {
          this.logger?.info('Browser anzeigen: leeres Fenster erkannt, URL wird geladen', { url: target });
          win = await this._loadUnlocked(target, { freshWindow: false, settleMs: 450, timeoutMs: 30000 });
        }
        win.show();
        win.focus();
      } else {
        win.hide();
      }
      return { visible: win.isVisible(), url: win.webContents.getURL(), title: win.webContents.getTitle() };
    });
  }

  async openDevTools() {
    const win = await this.ensureWindow();
    win.show();
    win.webContents.openDevTools({ mode: 'detach' });
    return true;
  }

  async fetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.referer) headers.set('Referer', options.referer);
    if (!headers.has('User-Agent') && this.userAgent) headers.set('User-Agent', this.userAgent);
    const response = await this.getSession().fetch(url, {
      method: options.method || 'GET',
      headers,
      redirect: 'follow',
      credentials: 'include'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} für ${url}`);
    return response;
  }

  async fetchJson(url, options = {}) {
    const response = await this.fetch(url, options);
    return response.json();
  }

  async fetchBinary(url, options = {}) {
    if (String(url).startsWith('data:')) {
      const match = String(url).match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
      if (!match) throw new Error('Ungültige data:-URL');
      return {
        buffer: match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8'),
        contentType: match[1] || 'application/octet-stream'
      };
    }
    try {
      const response = await this.fetch(url, options);
      const arrayBuffer = await response.arrayBuffer();
      return { buffer: Buffer.from(arrayBuffer), contentType: response.headers.get('content-type') || '' };
    } catch (error) {
      if (!isBlockedByClient(error) && Number(error?.statusCode || 0) >= 400) throw error;
      this.logger?.warn('Chromium-Binärabruf fehlgeschlagen; unabhängiger Node-HTTP-Transport wird versucht', { url: String(url), message: error.message });
      const response = await this._nodeRequest(String(url), {
        referer: options.referer || null,
        headers: options.headers || {},
        timeoutMs: 30000,
        accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      });
      const rawContentType = response.headers['content-type'];
      const contentType = Array.isArray(rawContentType) ? String(rawContentType[0] || '') : String(rawContentType || '');
      return { buffer: response.buffer, contentType };
    }
  }

  async selfTest() {
    const html = '<!doctype html><html><body><h1 id="mw-test">Browser Engine OK</h1><a class="chapter" href="https://example.invalid/chapter-1">Chapter 1</a></body></html>';
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    const result = await this.scrape(url, { waitForSelector: '#mw-test', timeoutMs: 5000 }, `({ title: document.querySelector('#mw-test')?.textContent, chapters: document.querySelectorAll('.chapter').length })`);
    return { ok: result?.title === 'Browser Engine OK' && result?.chapters === 1, ...result };
  }

  async clearSiteData() {
    const ses = this.getSession();
    await ses.clearCache();
    await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'cachestorage', 'serviceworkers'] });
    this.lastRequestedUrl = null;
    this.lastLoadedUrl = null;
    this.sessionConfigured = false;
    this.catalogCache = new Map();
    this.logger?.info('Browser-Cache und Site-Daten gelöscht');
    return true;
  }

  destroy() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}

module.exports = BrowserService;
