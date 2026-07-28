// THE CAPACITY POLICY HAS ONE HOME (static enforcement).
//
// `assertHistoryCapacity` lives in src/sim/evolution-capacity.js and is
// imported by exactly the two reader modules — evolution-run.js (fresh
// creation) and evolution-replay.js (persisted verification). Nothing
// re-exports it: the gate is internal, never public application API.

import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const CAPACITY_IMPORT = "import { assertHistoryCapacity } from './evolution-capacity.js';";

const SRC_FILES = [
  'src/main.js',
  ...['src/sim', 'src/ui', 'src/workers', 'src/platform', 'src/render']
    .flatMap((dir) => readdirSync(dir)
      .filter((name) => name.endsWith('.js'))
      .map((name) => `${dir}/${name}`)),
];

describe('the capacity policy gate has exactly one internal home', () => {
  test('evolution-run.js imports the shared gate', () => {
    expect(readFileSync('src/sim/evolution-run.js', 'utf8')).toContain(CAPACITY_IMPORT);
  });

  test('no src/ module re-exports the internal gate', () => {
    for (const file of SRC_FILES) {
      const source = readFileSync(file, 'utf8');
      const reExports = [...source.matchAll(/^\s*export[^;]*?from\s+'[^']*evolution-capacity\.js';/gm)];
      expect(reExports, `${file} must not re-export evolution-capacity.js`).toEqual([]);
    }
  });
});
