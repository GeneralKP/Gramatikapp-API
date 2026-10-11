import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const source = readFileSync(new URL('../src/features/phrases/wordBankGrammar.ts', import.meta.url), 'utf8');
const check = process.argv.includes('--check');
const generated = '// Generated from the API wordBankGrammar.ts. Run API scripts/generateWordBankGrammar.mjs.\n' + source;
for (const target of [
  '../../german-gramatic-web/src/core/generated/wordBankGrammar.ts',
  '../../german-gramatic-mobile/src/core/study/wordBankGrammar.ts',
]) {
  const path = new URL(target, import.meta.url);
  if (check) {
    if (readFileSync(path, 'utf8') !== generated) throw new Error(`Generated word-bank contract is stale: ${fileURLToPath(path)}`);
  } else {
    mkdirSync(dirname(fileURLToPath(path)), { recursive: true });
    writeFileSync(path, generated);
  }
}
console.log(check ? 'PASS web/mobile word-bank contract matches the API source.' : 'Generated the shared word-bank grouping contract for web and mobile.');
