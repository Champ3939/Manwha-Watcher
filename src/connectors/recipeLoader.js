const fs = require('fs');
const path = require('path');
const RecipeConnector = require('./recipe');

const EXAMPLE_RECIPE = {
  "$schema": "manhwa-watcher-web-recipe-v1",
  "id": "my-authorized-site",
  "label": "My Authorized Site",
  "domains": ["comics.example.org"],
  "timeoutMs": 30000,
  "settleMs": 400,
  "series": { "titleSelector": "h1" },
  "chapters": {
    "selector": "a.chapter-link",
    "titleSelector": ".chapter-title",
    "urlAttributes": ["href"],
    "numberRegex": "(?:chapter|ch\\.?)[ \\t]*([0-9]+(?:[.,][0-9]+)?)",
    "order": "number-asc"
  },
  "pages": {
    "selector": ".reader img",
    "urlAttributes": ["src", "data-src", "data-lazy-src"],
    "waitForSelector": ".reader img"
  }
};

function validate(recipe, filename = 'Connector') {
  if (!recipe || typeof recipe !== 'object') throw new Error(`${filename}: JSON-Objekt erwartet.`);
  if (!recipe.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(recipe.id)) throw new Error(`${filename}: ungültige id.`);
  if (!Array.isArray(recipe.domains) || !recipe.domains.length) throw new Error(`${filename}: domains fehlt.`);
  if (recipe.domains.some((domain) => !/^[a-z0-9.-]+$/i.test(String(domain)))) throw new Error(`${filename}: ungültige Domain.`);
  if (!recipe.chapters?.selector) throw new Error(`${filename}: chapters.selector fehlt.`);
  if (!recipe.pages?.selector) throw new Error(`${filename}: pages.selector fehlt.`);
  return recipe;
}

class RecipeLoader {
  constructor(directory, browser) {
    this.directory = directory;
    this.browser = browser;
    this.errors = [];
  }

  ensureExample() {
    fs.mkdirSync(this.directory, { recursive: true });
    const file = path.join(this.directory, 'example-connector.json.example');
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(EXAMPLE_RECIPE, null, 2), 'utf8');
    const readme = path.join(this.directory, 'README.txt');
    fs.writeFileSync(readme, [
      'Manhwa Watcher v0.6 - Web Connector Recipes',
      '',
      'Connectoren koennen jetzt direkt im Connector-Labor der Anwendung erstellt und getestet werden.',
      'Alternativ kannst du weiterhin .json-Dateien in diesem Ordner ablegen.',
      'Die Datei example-connector.json.example zeigt das Format.',
      '',
      'Verwende Connectoren nur fuer Quellen, fuer die du die noetigen Rechte/Download-Erlaubnis hast.'
    ].join('\r\n'), 'utf8');
  }

  getFileForId(id) {
    const safe = String(id || '').replace(/[^a-z0-9._-]/gi, '_');
    return path.join(this.directory, `${safe}.json`);
  }

  save(recipe, { overwrite = false } = {}) {
    this.ensureExample();
    const normalized = validate(recipe, 'Connector');
    const file = this.getFileForId(normalized.id);
    if (fs.existsSync(file) && !overwrite) throw new Error(`Connector „${normalized.id}“ existiert bereits. Aktiviere „Überschreiben“, um ihn zu ersetzen.`);
    fs.writeFileSync(file, JSON.stringify(normalized, null, 2), 'utf8');
    return { file, recipe: normalized };
  }

  load() {
    this.ensureExample();
    this.errors = [];
    const connectors = [];
    for (const name of fs.readdirSync(this.directory).filter((name) => name.toLowerCase().endsWith('.json'))) {
      const file = path.join(this.directory, name);
      try {
        const recipe = validate(JSON.parse(fs.readFileSync(file, 'utf8')), name);
        connectors.push(new RecipeConnector(recipe, this.browser));
      } catch (error) {
        this.errors.push({ file: name, message: error.message });
      }
    }
    return connectors;
  }
}

RecipeLoader.validate = validate;
RecipeLoader.EXAMPLE_RECIPE = EXAMPLE_RECIPE;
module.exports = RecipeLoader;
