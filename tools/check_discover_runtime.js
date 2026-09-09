const fs = require('fs');

const s = fs.readFileSync('src/core/browserService.js', 'utf8');
const methodStart = s.indexOf('async discoverSeriesInfo');
const marker = 'const result = await win.webContents.executeJavaScript(`';
const scriptStart = s.indexOf(marker, methodStart) + marker.length;
const scriptEnd = s.indexOf('`, true);', scriptStart);

if (methodStart < 0 || scriptStart < marker.length || scriptEnd < 0) {
  throw new Error('discoverSeriesInfo runtime script not found');
}

const raw = s.slice(scriptStart, scriptEnd);
if (raw.includes('${')) throw new Error('Unexpected template interpolation in discoverSeriesInfo runtime script');
const cooked = new Function('return `' + raw.replace(/`/g, '\\`') + '`;')();
new Function(cooked);
console.log('discoverSeriesInfo runtime script OK');
