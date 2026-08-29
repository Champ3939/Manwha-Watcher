const BaseConnector = require('./base');

const svgPage = (text, bg) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200"><rect width="100%" height="100%" fill="${bg}"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-family="Arial" font-size="56" fill="white">${text}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
};

class DemoConnector extends BaseConnector {
  constructor() { super('demo', 'Built-in Demo', { type: 'demo' }); }
  canHandle(url) { return url === 'demo://sample'; }
  chapters() {
    return [
      { id: '1', title: 'Chapter 1', downloaded: false, pages: [
        { url: svgPage('Demo – Chapter 1 / Page 1', '#3d4c9b') },
        { url: svgPage('Demo – Chapter 1 / Page 2', '#62428f') }
      ] },
      { id: '2', title: 'Chapter 2', downloaded: false, pages: [
        { url: svgPage('Demo – Chapter 2 / Page 1', '#2f6f68') },
        { url: svgPage('Demo – Chapter 2 / Page 2', '#8b5a39') }
      ] }
    ];
  }
  async getSeriesInfo(url) { return { title: 'Manhwa Watcher Demo', url, connectorId: this.id, chapters: this.chapters() }; }
  async getChapters() { return this.chapters(); }
  async getPages(_series, chapter) { return chapter.pages || []; }
}
module.exports = DemoConnector;
