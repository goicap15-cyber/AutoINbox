const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');
function fixString(str) { let cur = str; for (let i = 0; i < 4; i++) { if (/[\u00C0-\u00FF\u201E\u2020\u2122\u2013\u201C\u201D\u2018\u2019]/.test(cur)) { try { const next = iconv.decode(iconv.encode(cur, 'win1252'), 'utf8'); if (!next.includes('\uFFFD') && next !== cur) cur = next; else break; } catch(e) { break; } } else break; } return cur; }
function walk(dir) { let files = []; for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).isDirectory()) files.push(...walk(p)); else if (/\.(js|jsx|json|css|html|sql)$/.test(p)) files.push(p); } return files; }
let count = 0; ['src', 'scripts'].forEach(dir => { if (fs.existsSync(dir)) walk(dir).forEach(file => { const orig = fs.readFileSync(file, 'utf8'); const fixed = fixString(orig); if (fixed !== orig) { fs.writeFileSync(file, fixed, 'utf8'); console.log('[FIXED MOJIBAKE]', file); count++; } }); }); console.log('Total fixed:', count);
