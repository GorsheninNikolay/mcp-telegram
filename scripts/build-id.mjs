import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
const hash = createHash('sha256');
function visit(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) visit(path);
    else if (path !== 'src/build-id.ts' && path !== 'native/keychain-helper' && path !== 'native/session-lock') hash.update(path).update(readFileSync(path));
  }
}
visit('src'); visit('native'); hash.update(readFileSync('package-lock.json'));
writeFileSync('src/build-id.ts', `export const BUILD_ID = ${JSON.stringify(hash.digest('hex'))};\n`);
