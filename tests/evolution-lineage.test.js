// The canonical lineage codec contract (EVOLUTION_LINEAGE_VERSION 1).
//
// Pure: no physics, no Rapier, no clock. Three legs, matching the discipline
// the other canonical codecs are held to:
//   (1) round trips in BOTH directions — serialize(deserialize(b)) is
//       byte-identical and deserialize(serialize(x)) is leaf-equal under
//       Object.is;
//   (2) a COPY-DECLARED byte layout, so the geometry is asserted against a
//       literal rather than against the encoder's own arithmetic (an encoder
//       that changes stride and a test that derives stride from the encoder
//       move together and stay green);
//   (3) every malformed-stream class rejected LOUD, in this module's dialect,
//       with the stable `code` a caller branches on.
//
// The origin/parent sentinel rule and the zero-accounting rule are the two
// semantic invariants worth the most here: an elite copy that claims mutation
// work, or a derived row with no parent, is a lineage that lies about heredity
// while remaining perfectly well-formed bytes.

import { describe, test, expect } from 'vitest';

import {
  EVOLUTION_LINEAGE_VERSION, LINEAGE_ACCOUNTING_KEYS, LINEAGE_NO_PARENT, LINEAGE_ORIGINS,
  crossCheckLineage, deserializeLineage, lineageByteLength, serializeLineage,
  validateLineage, zeroLineageAccounting,
} from '../src/sim/evolution-lineage.js';
import { EvolutionError } from '../src/sim/evolution-contract.js';

// COPY-DECLARED geometry. Deliberately literals, never derived from the
// module: this is the drift tooth, and deriving it would let a stride change
// move both sides at once.
const DECLARED_HEADER_BYTES = 10; // u16 version + u32 generationIndex + u32 count
const DECLARED_ROW_BYTES = 53; // u32 id + u32 parent + u8 origin + 11 x u32
const DECLARED_ACCOUNTING_KEYS = Object.freeze([
  'eligibleContinuousLeafCount',
  'selectedLeafCount',
  'rawChangedLeafCount',
  'clampedLeafCount',
  'repairChangedLeafCount',
  'repairIntroducedLeafCount',
  'repairErasedLeafCount',
  'repairRedirectedLeafCount',
  'finalChangedLeafCount',
  'rawByteDeltaCount',
  'finalByteDeltaCount',
]);

const zero = () => ({ ...zeroLineageAccounting() });

const accounting = (overrides = {}) => ({ ...zero(), ...overrides });

const initializedLineage = (ids, generationIndex = 0) => ({
  lineageVersion: EVOLUTION_LINEAGE_VERSION,
  generationIndex,
  individuals: ids.map((individualId) => ({
    individualId, parentIndividualId: null, origin: 'initialized', accounting: zero(),
  })),
});

// A mixed generation: two elite copies then two mutated children — the exact
// shape the transition emits.
const mixedLineage = () => ({
  lineageVersion: EVOLUTION_LINEAGE_VERSION,
  generationIndex: 1,
  individuals: [
    { individualId: 4, parentIndividualId: 2, origin: 'eliteCopy', accounting: zero() },
    { individualId: 5, parentIndividualId: 0, origin: 'eliteCopy', accounting: zero() },
    {
      individualId: 6,
      parentIndividualId: 3,
      origin: 'continuousMutation',
      accounting: accounting({
        eligibleContinuousLeafCount: 68,
        selectedLeafCount: 3,
        rawChangedLeafCount: 3,
        clampedLeafCount: 1,
        repairChangedLeafCount: 2,
        repairIntroducedLeafCount: 1,
        repairErasedLeafCount: 0,
        repairRedirectedLeafCount: 1,
        finalChangedLeafCount: 4,
        rawByteDeltaCount: 19,
        finalByteDeltaCount: 27,
      }),
    },
    {
      individualId: 7,
      parentIndividualId: 3,
      origin: 'continuousMutation',
      accounting: accounting({ eligibleContinuousLeafCount: 68 }),
    },
  ],
});

const bytesEqual = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
};

function expectCode(fn, code, re) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  expect(threw, 'expected a throw').toBeInstanceOf(EvolutionError);
  expect(threw.code).toBe(code);
  if (re) expect(threw.message).toMatch(re);
  return threw;
}

describe('lineage geometry is declared, not derived', () => {
  test('the accounting key list and its ORDER are the copy-declared literal', () => {
    // Order is wire-significant: swapping two counters produces a stream that
    // decodes cleanly into different numbers.
    expect([...LINEAGE_ACCOUNTING_KEYS]).toEqual([...DECLARED_ACCOUNTING_KEYS]);
  });

  test('the origin enum order is the copy-declared literal (the index IS the byte)', () => {
    expect([...LINEAGE_ORIGINS]).toEqual(['initialized', 'eliteCopy', 'continuousMutation']);
  });

  test('byte length is header + count * row, at the declared literals', () => {
    expect(lineageByteLength(0)).toBe(DECLARED_HEADER_BYTES);
    expect(lineageByteLength(1)).toBe(DECLARED_HEADER_BYTES + DECLARED_ROW_BYTES);
    expect(lineageByteLength(20)).toBe(DECLARED_HEADER_BYTES + 20 * DECLARED_ROW_BYTES);
    expect(serializeLineage(mixedLineage()).length)
      .toBe(DECLARED_HEADER_BYTES + 4 * DECLARED_ROW_BYTES);
  });

  test('the header bytes are exactly version, generationIndex, count, little-endian', () => {
    const bytes = serializeLineage(initializedLineage([0, 1, 2], 7));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint16(0, true)).toBe(EVOLUTION_LINEAGE_VERSION);
    expect(view.getUint32(2, true)).toBe(7);
    expect(view.getUint32(6, true)).toBe(3);
    // …and the first row's parent is the reserved sentinel.
    expect(view.getUint32(10, true)).toBe(0);
    expect(view.getUint32(14, true)).toBe(LINEAGE_NO_PARENT);
    expect(view.getUint8(18)).toBe(0); // 'initialized'
  });
});

describe('round trips, both directions', () => {
  test.each([
    ['generation 0, all initialized', () => initializedLineage([0, 1, 2, 3])],
    ['a mixed elite/mutation generation', mixedLineage],
    ['a single-member generation', () => initializedLineage([0])],
    ['non-contiguous ascending ids', () => initializedLineage([3, 9, 4294967294], 5)],
  ])('%s: deserialize(serialize(x)) is leaf-equal and re-encodes byte-identically', (_name, build) => {
    const lineage = build();
    const bytes = serializeLineage(lineage);
    const decoded = deserializeLineage(bytes);
    expect(bytesEqual(serializeLineage(decoded), bytes)).toBe(true);
    expect(decoded.lineageVersion).toBe(EVOLUTION_LINEAGE_VERSION);
    expect(decoded.generationIndex).toBe(lineage.generationIndex);
    expect(decoded.individuals.length).toBe(lineage.individuals.length);
    decoded.individuals.forEach((row, i) => {
      const src = lineage.individuals[i];
      expect(Object.is(row.individualId, src.individualId)).toBe(true);
      expect(Object.is(row.parentIndividualId, src.parentIndividualId)).toBe(true);
      expect(row.origin).toBe(src.origin);
      for (const key of DECLARED_ACCOUNTING_KEYS) {
        expect(Object.is(row.accounting[key], src.accounting[key]), key).toBe(true);
      }
    });
  });

  test('the decoded record is FROZEN all the way down (it is an attestation)', () => {
    const decoded = deserializeLineage(serializeLineage(mixedLineage()));
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.individuals)).toBe(true);
    expect(Object.isFrozen(decoded.individuals[0])).toBe(true);
    expect(Object.isFrozen(decoded.individuals[0].accounting)).toBe(true);
  });

  test('the encoder returns fresh module-owned bytes on every call', () => {
    const lineage = mixedLineage();
    const a = serializeLineage(lineage);
    const b = serializeLineage(lineage);
    expect(a).not.toBe(b);
    expect(bytesEqual(a, b)).toBe(true);
  });
});

describe('the origin / parent sentinel rule holds in BOTH directions', () => {
  test('an initialized row must carry a null parent', () => {
    const lineage = initializedLineage([0, 1]);
    lineage.individuals[1].parentIndividualId = 0;
    expectCode(() => serializeLineage(lineage), 'invalidConfig', /initialized row has no parent/);
  });

  test('a derived row must name a parent', () => {
    const lineage = mixedLineage();
    lineage.individuals[0].parentIndividualId = null;
    expectCode(() => serializeLineage(lineage), 'invalidConfig', /parentIndividualId/);
  });

  test('a derived row may not name the reserved sentinel as a real parent', () => {
    const lineage = mixedLineage();
    lineage.individuals[0].parentIndividualId = LINEAGE_NO_PARENT;
    expectCode(() => serializeLineage(lineage), 'invalidConfig', /parentIndividualId/);
  });

  test('an individualId may not be the reserved sentinel', () => {
    const lineage = initializedLineage([LINEAGE_NO_PARENT]);
    expectCode(() => serializeLineage(lineage), 'invalidConfig', /reserved no-parent sentinel/);
  });

  test('the DECODER enforces the same rule: a hand-built initialized row with a parent fails', () => {
    const bytes = serializeLineage(initializedLineage([0]));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(14, 5, true); // parent 5 on an origin-0 row
    expectCode(() => deserializeLineage(bytes), 'malformedHistory', /must carry the no-parent sentinel/);
  });

  test('the DECODER rejects a derived row carrying the sentinel', () => {
    const bytes = serializeLineage(mixedLineage());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(14, LINEAGE_NO_PARENT, true); // row 0 is an eliteCopy
    expectCode(() => deserializeLineage(bytes), 'malformedHistory', /must name a parent/);
  });
});

describe('the zero-accounting rule for non-mutation rows', () => {
  test.each(['initialized', 'eliteCopy'])('a %s row with a non-zero counter is refused', (origin) => {
    const lineage = origin === 'initialized' ? initializedLineage([0]) : mixedLineage();
    lineage.individuals[0].accounting.selectedLeafCount = 1;
    expectCode(() => serializeLineage(lineage), 'invalidConfig', /must carry zero counters|consumed no operator work/);
  });

  test('the DECODER refuses the same contradiction from hand-built bytes', () => {
    const bytes = serializeLineage(mixedLineage());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Row 0 is an eliteCopy; its first counter sits at header + id + parent + origin.
    view.setUint32(DECLARED_HEADER_BYTES + 9, 3, true);
    expectCode(() => deserializeLineage(bytes), 'malformedHistory', /must carry zero counters/);
  });

  test('a continuousMutation row may carry any canonical uint32 counters', () => {
    const lineage = mixedLineage();
    lineage.individuals[3].accounting.finalByteDeltaCount = 4294967295;
    const decoded = deserializeLineage(serializeLineage(lineage));
    expect(decoded.individuals[3].accounting.finalByteDeltaCount).toBe(4294967295);
  });
});

describe('malformed input and malformed streams', () => {
  test('ids must be strictly ascending in the object AND in the stream', () => {
    const lineage = initializedLineage([0, 1]);
    lineage.individuals[1].individualId = 0;
    expectCode(() => serializeLineage(lineage), 'invalidConfig', /strictly ascending/);
    const bytes = serializeLineage(initializedLineage([0, 1]));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(DECLARED_HEADER_BYTES + DECLARED_ROW_BYTES, 0, true);
    expectCode(() => deserializeLineage(bytes), 'malformedHistory', /strictly ascending/);
  });

  test('an empty lineage is refused on both sides', () => {
    expectCode(() => serializeLineage({
      lineageVersion: EVOLUTION_LINEAGE_VERSION, generationIndex: 0, individuals: [],
    }), 'invalidConfig', /individuals/);
    const bytes = serializeLineage(initializedLineage([0]));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(6, 0, true);
    expectCode(() => deserializeLineage(bytes), 'malformedHistory', /individualCount/);
  });

  test('an unsupported version is `unsupportedVersion`, not generic corruption', () => {
    const bytes = serializeLineage(initializedLineage([0]));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint16(0, 2, true);
    expectCode(() => deserializeLineage(bytes), 'unsupportedVersion', /lineageVersion/);
  });

  test('a lying count is reported as a length identity, not a truncation deep in a row', () => {
    const bytes = serializeLineage(initializedLineage([0, 1]));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(6, 3, true);
    expectCode(() => deserializeLineage(bytes), 'malformedHistory', /byteLength/);
  });

  test('truncation and trailing bytes are both refused', () => {
    const bytes = serializeLineage(initializedLineage([0, 1]));
    expectCode(() => deserializeLineage(bytes.slice(0, bytes.length - 1)), 'malformedHistory', /byteLength|truncated/);
    const extended = new Uint8Array(bytes.length + 1);
    extended.set(bytes, 0);
    expectCode(() => deserializeLineage(extended), 'malformedHistory', /byteLength|trailing/);
  });

  test('an out-of-range origin byte is refused', () => {
    const bytes = serializeLineage(initializedLineage([0]));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(14, LINEAGE_NO_PARENT, true);
    view.setUint8(18, 7);
    expectCode(() => deserializeLineage(bytes), 'malformedHistory', /origin/);
  });

  test.each([
    ['a non-object lineage', 42],
    ['null', null],
    ['a wrong lineageVersion', { lineageVersion: 2, generationIndex: 0, individuals: [] }],
    ['a non-array individuals', { lineageVersion: 1, generationIndex: 0, individuals: {} }],
    ['a non-uint32 generationIndex', { lineageVersion: 1, generationIndex: -1, individuals: [] }],
  ])('%s is refused as invalidConfig', (_name, value) => {
    expectCode(() => serializeLineage(value), 'invalidConfig');
    expectCode(() => validateLineage(value), 'invalidConfig');
  });

  test('an accounting record with a missing or extra key is refused (exact key-set equality)', () => {
    const missing = initializedLineage([0]);
    delete missing.individuals[0].accounting.clampedLeafCount;
    expectCode(() => serializeLineage(missing), 'invalidConfig', /accounting/);
    const extra = initializedLineage([0]);
    extra.individuals[0].accounting.somethingElse = 0;
    expectCode(() => serializeLineage(extra), 'invalidConfig', /accounting/);
  });

  test('a non-canonical accounting value (float, negative, -0) is refused', () => {
    for (const bad of [1.5, -1, -0, NaN, '3']) {
      const lineage = mixedLineage();
      lineage.individuals[2].accounting.selectedLeafCount = bad;
      expectCode(() => serializeLineage(lineage), 'invalidConfig', /accounting/);
    }
  });
});

describe('crossCheckLineage — the agreement the codec cannot see', () => {
  test('generation 0 accepts all-initialized rows against a null predecessor', () => {
    const decoded = deserializeLineage(serializeLineage(initializedLineage([0, 1, 2])));
    expect(() => crossCheckLineage(decoded, 0, [0, 1, 2], null)).not.toThrow();
  });

  test('a derived row in generation 0 is refused', () => {
    const lineage = initializedLineage([0, 1]);
    lineage.individuals[1] = {
      individualId: 1, parentIndividualId: 0, origin: 'eliteCopy', accounting: zero(),
    };
    const decoded = deserializeLineage(serializeLineage(lineage));
    expectCode(() => crossCheckLineage(decoded, 0, [0, 1], null), 'malformedHistory', /no predecessor/);
  });

  test('an initialized row in a later generation is refused', () => {
    const lineage = mixedLineage();
    lineage.individuals[0] = {
      individualId: 4, parentIndividualId: null, origin: 'initialized', accounting: zero(),
    };
    const decoded = deserializeLineage(serializeLineage(lineage));
    expectCode(() => crossCheckLineage(decoded, 1, [4, 5, 6, 7], [0, 1, 2, 3]),
      'malformedHistory', /has a predecessor/);
  });

  test('a parent that does not exist in the preceding generation is refused', () => {
    const decoded = deserializeLineage(serializeLineage(mixedLineage()));
    expectCode(() => crossCheckLineage(decoded, 1, [4, 5, 6, 7], [0, 1, 9]),
      'malformedHistory', /not in generation 0/);
  });

  test('lineage ids must EXACTLY equal the paired population ids, in order', () => {
    const decoded = deserializeLineage(serializeLineage(mixedLineage()));
    expectCode(() => crossCheckLineage(decoded, 1, [4, 5, 6, 8], [0, 1, 2, 3]),
      'malformedHistory', /does not match population id/);
    expectCode(() => crossCheckLineage(decoded, 1, [4, 5, 6], [0, 1, 2, 3]),
      'malformedHistory', /rows for a population of/);
  });

  test('the record index must match the lineage generationIndex', () => {
    const decoded = deserializeLineage(serializeLineage(mixedLineage()));
    expectCode(() => crossCheckLineage(decoded, 2, [4, 5, 6, 7], [0, 1, 2, 3]),
      'malformedHistory', /does not match the record's/);
  });
});
