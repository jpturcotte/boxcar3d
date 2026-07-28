// documentation-status.test.js — the ACTIVE-STATUS documentation lint.
//
// WHY THIS EXISTS (the PR #29 post-merge defect): PR #29 merged fitness-vector
// v3 into `main`, but the repository's ACTIVE status regions kept branch-local
// phrasing — README's **Status:** block still said "main is unchanged … This
// branch carries PR #29 (open, not yet merged)", CLAUDE.md's current-phase
// header still said "this branch — OPEN, not yet merged to `main`", and the
// remediation proposal still dated its DISCHARGED notes "on the PR #29 branch
// (pending merge)". Main's own documentation described a pre-merge world.
//
// WHAT THIS PINS: branch-local status phrasing is banned ONLY inside the
// ACTIVE status regions (the regions a reader consults for "what is main
// NOW"). Historical regions — landed-phase retrospectives, decision records,
// dated evidence under docs/ — legitimately describe the branch/merge state
// of THEIR date and are untouched by this lint. The regions are derived from
// committed section markers, never from a duplicated line list; a marker that
// disappears FAILS loudly (a renamed section must not silently un-gate its
// region). The banned set is deliberately narrow — branch/merge-status
// phrasings, plus PR-status "open" phrasings such as "PR #29 (open" / "(open,"
// — never the bare word "open", which honest prose uses constantly.

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const readRepoFile = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

// The banned branch-local status phrasings (case-insensitive). Each entry is
// a regex whose .source is quoted in failure messages.
const BANNED = [
  /this branch/i,
  /not yet merged/i,
  /pending merge/i,
  /main is unchanged/i,
  /becomes main after merge/i,
  /PR #\d+ \(open/i, // "PR #29 (open, …" — PR-status open phrasing…
  /\(open,/i, //        …"(open, not yet merged)" — never the bare word "open"
];

// From the line containing `marker` to the next H2 (`## `) or EOF.
function spanFromMarkerToNextH2(text, marker) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.includes(marker));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

// From the LAST line matching `re` to EOF (the CURRENT phase is the last one).
function spanFromLastMatchToEof(text, re) {
  const lines = text.split('\n');
  let start = -1;
  lines.forEach((l, i) => { if (re.test(l)) start = i; });
  return start === -1 ? null : lines.slice(start).join('\n');
}

// From the LAST line matching `markerRe` to the next line matching
// `headerRe` (exclusive) or EOF — an active block that lives INSIDE a
// historical section but still hands off current guidance.
function spanFromLastMatchToNextHeader(text, markerRe, headerRe) {
  const lines = text.split('\n');
  let start = -1;
  lines.forEach((l, i) => { if (markerRe.test(l)) start = i; });
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (headerRe.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

// From the FIRST line matching `re` to EOF.
function spanFromFirstMatchToEof(text, re) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => re.test(l));
  return start === -1 ? null : lines.slice(start).join('\n');
}

// The ACTIVE regions, each identified by the committed marker that anchors it.
const ACTIVE_REGIONS = [
  {
    file: 'README.md',
    marker: '**Status:**',
    extract: (text) => spanFromMarkerToNextH2(text, '**Status:**'),
  },
  {
    // The PR-4 section's handoff block still carries ACTIVE guidance (its
    // pending items route the NEXT agent) even though a newer GA-phase
    // section follows it — the PR #31 review caught this block outside the
    // lint while it still said "the vector currently stores status only".
    file: 'CLAUDE.md',
    marker: 'the last **Recommended next steps block',
    extract: (text) => spanFromLastMatchToNextHeader(text, /\*\*Recommended next steps/, /^\*\*GA Phase/),
  },
  {
    file: 'CLAUDE.md',
    marker: 'the last **GA Phase … header',
    extract: (text) => spanFromLastMatchToEof(text, /^\*\*GA Phase/),
  },
  {
    file: 'docs/solver-divergence-remediation-2026-07.md',
    marker: '**Remaining work before it can land responsibly**',
    extract: (text) => spanFromMarkerToNextH2(text, 'Remaining work before it can land responsibly'),
  },
  {
    file: 'docs/solver-divergence-remediation-2026-07.md',
    marker: '## 5. Recommendation (to EOF)',
    extract: (text) => spanFromFirstMatchToEof(text, /^## 5\./),
  },
];

const bannedInSpan = (spanText) => BANNED.filter((re) => re.test(spanText)).map((re) => re.source);

describe('active-status documentation carries no branch-local phrasing', () => {
  for (const { file, marker, extract } of ACTIVE_REGIONS) {
    test(`${file} — ${marker}`, () => {
      const span = extract(readRepoFile(file));
      expect(span, `${file}: the section marker '${marker}' was NOT FOUND — a renamed section must update this lint in the same commit, never silently un-gate the region`).not.toBeNull();
      const hits = bannedInSpan(span);
      expect(
        hits,
        `${file} active region '${marker}' carries branch-local status phrasing: ${hits.join(', ')} — `
        + 'main is the merged state; update the active status text in the same commit as the merge (historical regions may keep dated branch phrasing)',
      ).toEqual([]);
    });
  }

  test('the CLAUDE.md active regions include the Recommended next steps handoff block (the PR #31 review gap)', () => {
    // The block sits INSIDE the landed PR-4 section, immediately before the
    // last **GA Phase header — an extraction covering only the final section
    // silently misses this active handoff. This test fails if the region is
    // removed from ACTIVE_REGIONS or its extraction is narrowed away.
    const recsRegion = ACTIVE_REGIONS.find((r) => r.file === 'CLAUDE.md' && r.marker.includes('Recommended next steps'));
    expect(recsRegion, 'the CLAUDE.md Recommended-next-steps active region must exist in ACTIVE_REGIONS').toBeDefined();
    const span = recsRegion.extract(readRepoFile('CLAUDE.md'));
    expect(span).not.toBeNull();
    expect(span).toContain('Recommended next steps');
    // …and the block ends where the current GA-phase section begins, so the
    // two CLAUDE.md regions together cover the whole active handoff tail.
    expect(span).not.toMatch(/^\*\*GA Phase/m);
  });

  test('the lint itself is not vacuous: historical-region phrasing passes, the same phrasing in the active span fails', () => {
    const historical = '## History\n\nBack then this branch carried PR #29 (open, not yet merged) — recorded history.\n';
    const activeClean = '**Status:** `main` includes PR #29: fitness-vector v3.\n\n## Next\n';
    const doc = `${historical}\n${activeClean}`;
    // The historical region is outside the **Status:** span, so the clean
    // active span yields no hits…
    expect(bannedInSpan(spanFromMarkerToNextH2(doc, '**Status:**'))).toEqual([]);
    // …and the SAME phrases drifted INTO the active span are caught.
    const drifted = doc.replace('fitness-vector v3.', 'fitness-vector v3 on this branch, PR #29 (open, not yet merged).');
    const hits = bannedInSpan(spanFromMarkerToNextH2(drifted, '**Status:**'));
    expect(hits).toContain('this branch');
    expect(hits).toContain('not yet merged');
    expect(hits).toContain('PR #\\d+ \\(open');
  });

  test('the banned set never fires on the bare word "open" (honest prose stays legal)', () => {
    expect(bannedInSpan('**Status:** the next measurement PR is open for design; main is the merged state.')).toEqual([]);
    expect(bannedInSpan('**Open, and the maintainer\'s call:** whether to ratify A-now.')).toEqual([]);
  });

  test('a missing marker fails loudly instead of silently un-gating its region', () => {
    expect(spanFromMarkerToNextH2('nothing here\n', '**Status:**')).toBeNull();
    expect(spanFromLastMatchToEof('nothing here\n', /^\*\*GA Phase/m)).toBeNull();
  });
});
