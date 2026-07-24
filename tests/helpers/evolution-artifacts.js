// SHARED TEST HELPER — not a test file (vitest collects only `**/*.test.js`).
//
// `reforge` is what makes the replay and offline-seam suites meaningful.
// Flipping a byte in a committed artifact is caught by the component digest —
// correctly, and that is tested — but it tests the DIGEST, not the checks
// downstream of it. To reach a version gate, a coherence gate or a replay
// stage you need an artifact that is perfectly well-formed and self-consistent
// and still says something this build refuses or does not reproduce. `reforge`
// builds exactly that: it rewrites a component (or the header), recomputes
// every downstream digest, re-chains from the header, and re-assembles.
//
// It lives here rather than in one suite because two now need it, and a
// second hand-maintained copy of a digest-rechaining routine is the kind of
// duplication that drifts silently — one copy learning about a new component
// kind and the other not.

import {
  COMPONENT_KINDS, assembleHistory, decodeEvolutionHeader, decodeGenerationPayload,
  decodeHistoryFraming, digestComponent, digestGeneration, digestHeader,
  encodeEvolutionHeader, encodeGenerationPayload,
} from '../../src/sim/evolution-history.js';

/**
 * Rebuild a history artifact with mutations applied, and every digest,
 * chain link and framing field recomputed so it verifies cleanly.
 *
 * `mutateHeader` receives the DECODED header, `mutateHeaderBytes` the encoded
 * bytes, and `mutateRecord` a `{generationIndex, terminalReason, components}`
 * record plus its index. All are optional; with none, the output is the input.
 */
export async function reforge(bytes, { mutateHeader, mutateHeaderBytes, mutateRecord } = {}) {
  const framing = decodeHistoryFraming(bytes);
  let headerBytes = framing.headerBytes;
  if (mutateHeader) {
    const decoded = decodeEvolutionHeader(framing.headerBytes);
    headerBytes = encodeEvolutionHeader(mutateHeader({ ...decoded }));
  }
  if (mutateHeaderBytes) {
    headerBytes = new Uint8Array(headerBytes);
    mutateHeaderBytes(headerBytes);
  }
  const headerDigestBytes = await digestHeader(headerBytes);
  const generations = [];
  let previous = headerDigestBytes;
  for (let i = 0; i < framing.generations.length; i += 1) {
    const payload = decodeGenerationPayload(framing.generations[i].payloadBytes);
    const record = {
      generationIndex: payload.generationIndex,
      terminalReason: payload.terminalReason,
      components: { ...payload.components },
    };
    if (mutateRecord) mutateRecord(record, i);
    const digests = {};
    for (const kind of COMPONENT_KINDS) {
      digests[kind] = await digestComponent(kind, record.components[kind]);
    }
    const payloadBytes = encodeGenerationPayload(record, digests);
    const generationDigestBytes = await digestGeneration(previous, payloadBytes);
    previous = generationDigestBytes;
    generations.push({ payloadBytes, generationDigestBytes });
  }
  return (await assembleHistory({ headerBytes, headerDigestBytes, generations })).bytes;
}
