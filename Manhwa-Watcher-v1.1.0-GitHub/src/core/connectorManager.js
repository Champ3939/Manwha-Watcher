function normalizeHost(value) {
  try { return new URL(String(value || '')).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return String(value || '').trim().toLowerCase().replace(/^www\./, ''); }
}

class ConnectorManager {
  constructor(builtIns = [], recipeLoader = null, { getAutoDetectDomains = () => [] } = {}) {
    this.builtIns = builtIns;
    this.recipeLoader = recipeLoader;
    this.getAutoDetectDomains = getAutoDetectDomains;
    this.connectors = [];
    this.errors = [];
    this.reload();
  }

  reload() {
    const recipes = this.recipeLoader ? this.recipeLoader.load() : [];
    this.connectors = [...this.builtIns, ...recipes];
    this.errors = this.recipeLoader ? [...this.recipeLoader.errors] : [];
    return this.list();
  }

  getById(id) { return this.connectors.find((connector) => connector.id === id) || null; }
  getAutoDetect() { return this.connectors.find((connector) => connector.type === 'auto-detect') || null; }
  autoDetectPreferred(url) {
    const host = normalizeHost(url);
    if (!host) return false;
    const domains = Array.isArray(this.getAutoDetectDomains?.()) ? this.getAutoDetectDomains() : [];
    return domains.map(normalizeHost).filter(Boolean).some((domain) => host === domain || host.endsWith(`.${domain}`));
  }
  getPrimaryForUrl(url) {
    return this.connectors.find((connector) => connector.type !== 'auto-detect' && connector.canHandle(url)) || null;
  }
  getForUrl(url) {
    const auto = this.getAutoDetect();
    if (auto && this.autoDetectPreferred(url) && auto.canHandle(url)) return auto;
    const primary = this.getPrimaryForUrl(url);
    if (primary) return primary;
    return auto && auto.canHandle(url) ? auto : null;
  }
  list() {
    const preferred = new Set((Array.isArray(this.getAutoDetectDomains?.()) ? this.getAutoDetectDomains() : []).map(normalizeHost).filter(Boolean));
    return this.connectors.map((connector) => {
      const base = connector.describe ? connector.describe() : ({ id: connector.id, label: connector.label });
      if (connector.type === 'auto-detect') return { ...base, preferredDomains: [...preferred] };
      return base;
    });
  }
  diagnostics() { return { connectors: this.list(), errors: [...this.errors] }; }
}

module.exports = ConnectorManager;
