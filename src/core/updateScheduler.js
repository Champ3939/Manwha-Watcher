class UpdateScheduler {
  constructor({ store, scanner, logger = null, onEvent = () => {} }) {
    this.store = store;
    this.scanner = scanner;
    this.logger = logger;
    this.onEvent = onEvent;
    this.timer = null;
    this.startupTimer = null;
    this.running = false;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.timer = null;
    this.startupTimer = null;
  }

  status() {
    const settings = this.store.getSettings();
    return {
      enabled: Boolean(settings.autoUpdateScan),
      intervalHours: Math.max(1, Number(settings.updateScanIntervalHours) || 6),
      runOnStartup: Boolean(settings.updateScanOnStartup),
      running: this.running
    };
  }

  configure({ initial = false } = {}) {
    this.stop();
    const settings = this.store.getSettings();
    if (!settings.autoUpdateScan) return this.status();
    const hours = Math.max(1, Math.min(168, Number(settings.updateScanIntervalHours) || 6));
    this.timer = setInterval(() => this.run('interval').catch(() => {}), hours * 60 * 60 * 1000);
    if (initial && settings.updateScanOnStartup) {
      // Give the browser engine and UI a short moment to finish starting.
      this.startupTimer = setTimeout(() => this.run('startup').catch(() => {}), 15000);
    }
    this.logger?.info('Automatischer Update-Zeitplan konfiguriert', { hours, runOnStartup: Boolean(settings.updateScanOnStartup) });
    return this.status();
  }

  async run(reason = 'manual-schedule') {
    if (this.running) return { skipped: true, reason: 'scheduler-running' };
    this.running = true;
    this.onEvent({ type: 'scheduled-update-start', reason });
    this.logger?.info('Geplanter Update-Scan gestartet', { reason });
    try {
      const result = await this.scanner.scanAndUpdate();
      this.onEvent({ type: 'scheduled-update-done', reason, summary: result });
      this.logger?.info('Geplanter Update-Scan beendet', { reason, downloadedChapters: result?.downloadedChapters || 0, errors: result?.errors || 0, skipped: Boolean(result?.skipped) });
      return result;
    } catch (error) {
      this.onEvent({ type: 'scheduled-update-error', reason, message: String(error?.message || error) });
      this.logger?.error('Geplanter Update-Scan fehlgeschlagen', { reason, message: String(error?.message || error) });
      throw error;
    } finally {
      this.running = false;
    }
  }
}

module.exports = { UpdateScheduler };
