import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { files?: string[] };

test('published channel entrypoints include every direct src import', () => {
  const packagedFiles = new Set(packageJson.files ?? []);
  const entrypoints = ['codex-channel.ts', 'opencode-channel.ts'];
  const missing: string[] = [];

  for (const entrypoint of entrypoints) {
    const source = readFileSync(new URL(`../${entrypoint}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/from ['"]\.\/src\/([^'"]+)\.js['"]/g)) {
      const requiredFile = `src/${match[1]}.ts`;
      if (!packagedFiles.has(requiredFile)) missing.push(`${entrypoint} -> ${requiredFile}`);
    }
  }

  assert.deepEqual(missing, []);
});
