class BaseConnector {
  constructor(id, label, options = {}) {
    this.id = id;
    this.label = label;
    this.type = options.type || 'built-in';
    this.domains = Array.isArray(options.domains) ? options.domains : [];
  }

  canHandle(_url) { return false; }
  async getSeriesInfo(_url) { throw new Error('Not implemented'); }
  async getChapters(_series) { throw new Error('Not implemented'); }
  async getPages(_series, _chapter) { throw new Error('Not implemented'); }

  describe() {
    return { id: this.id, label: this.label, type: this.type, domains: this.domains };
  }
}

module.exports = BaseConnector;
