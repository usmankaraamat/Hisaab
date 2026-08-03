/* Fails the build if a server-side secret ever reaches the client bundle.
 *
 * The publishable Supabase key is expected in dist/ — RLS is what protects it.
 * The service-role key and the model API keys must never appear: they live only
 * as Supabase Edge Function secrets. This runs after every build so a stray
 * VITE_ prefix or a hardcoded key cannot ship quietly.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

if (!existsSync(dist)) {
  console.error('No dist/ — run the build first.');
  process.exit(1);
}

// Prefixes, so this keeps working after a key rotation without being edited.
const FORBIDDEN = [
  { label: 'Anthropic API key', pattern: /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/ },
  // Both Gemini key formats: the older AIza… and the current AQ.… studio keys.
  { label: 'Gemini API key', pattern: /AIza[A-Za-z0-9_-]{30,}/ },
  { label: 'Gemini API key', pattern: /\bAQ\.[A-Za-z0-9_-]{30,}/ },
  { label: 'Supabase service-role key', pattern: /sb_secret_[A-Za-z0-9_-]{20,}/ },
  { label: 'Supabase legacy service_role JWT', pattern: /"role"\s*:\s*"service_role"/ },
];

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const findings = [];
for (const file of walk(dist)) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // binary asset
  }
  for (const { label, pattern } of FORBIDDEN) {
    if (pattern.test(text)) findings.push(`${label} in ${file.slice(root.length + 1)}`);
  }
}

if (findings.length) {
  console.error('\nBuild blocked — server-side secret found in the client bundle:');
  for (const f of findings) console.error(`  ${f}`);
  console.error('\nOnly VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY belong in the client.');
  process.exit(1);
}

console.log('Secret check: clean (no service-role or model API key in dist/).');
