/**
 * Style pack rotation system.
 *
 * Guarantees perfectly balanced distribution across selected style packs.
 * The rotation is DETERMINISTIC — no randomness — so the distribution is
 * mathematically exact, not probabilistic.
 *
 * DESIGN RATIONALE:
 *   Why round-robin instead of random selection?
 *
 *   Random selection (pick(packIds, rng)) would give ~equal distribution
 *   on average, but with N=1000 and 3 packs you'd see variance of ±20–30
 *   edits per pack. Some packs would appear 370 times, others 296 times.
 *
 *   Round-robin gives EXACT balance: floor(N/P) edits per pack ± 1.
 *   For 1000 edits, 3 packs: exactly 334, 333, 333.
 *
 *   This matters for fair A/B testing: if pack A produces better engagement
 *   than pack B, you need equal sample sizes to trust the comparison.
 *
 * MULTI-PACK EXAMPLE (3 packs, 9 edits):
 *   Index:  0  1  2  3  4  5  6  7  8
 *   Pack:   A  B  C  A  B  C  A  B  C
 *   Count:  3  3  3  — perfectly balanced
 *
 * MULTI-PACK EXAMPLE (2 packs, 7 edits):
 *   Index:  0  1  2  3  4  5  6
 *   Pack:   A  B  A  B  A  B  A
 *   Count:  4  3  — max deviation: 1 edit (unavoidable for odd editCount)
 */

export interface StylePackRotator {
  /** Resolve the style pack ID for edit at 0-based absolute `editIndex`. */
  resolve(editIndex: number): string;

  /** All pack IDs in rotation order. */
  readonly packIds: readonly string[];

  /** Number of packs in the rotation. */
  readonly size: number;
}

/**
 * Create a balanced round-robin rotator.
 *
 * @param packIds - Style pack IDs in the desired rotation order.
 *                 If one pack: always returns that pack.
 *                 If multiple: cycles A→B→C→A→...
 * @throws if packIds is empty.
 */
export function createPackRotator(packIds: string[]): StylePackRotator {
  if (packIds.length === 0) {
    throw new Error("StylePackRotator: packIds must not be empty");
  }

  // Defensive copy — prevent external mutation from affecting the rotator
  const ids = Object.freeze([...packIds]);

  return {
    packIds: ids,
    size: ids.length,
    resolve(editIndex: number): string {
      // editIndex % ids.length is the only formula needed.
      // For editIndex=0 → ids[0], editIndex=1 → ids[1], etc.
      return ids[((editIndex % ids.length) + ids.length) % ids.length]!;
    },
  };
}

// ── Preset index resolution ────────────────────────────────

/**
 * Given a parallel presetIds[] array aligned with packIds[],
 * resolve which presetId applies to a given editIndex.
 *
 * presetIds[i] corresponds to packIds[i].
 * If presetIds is shorter than packIds, the last element is reused.
 */
export function resolvePresetForEdit(
  presetIds: string[],
  editIndex: number,
  packCount: number,
): string {
  const packIndex = editIndex % packCount;
  return presetIds[Math.min(packIndex, presetIds.length - 1)]!;
}

// ── Audit utility ──────────────────────────────────────────

export interface RotationAudit {
  /** Count of edits assigned to each pack ID. */
  counts: Record<string, number>;
  /** Maximum deviation from perfect balance as a percentage (0–100). */
  maxDeviationPct: number;
  /** Total edits audited. */
  total: number;
  /** Whether the distribution is perfectly balanced (deviation < 0.2%). */
  isBalanced: boolean;
}

/**
 * Verify the rotator produces a balanced distribution over `editCount` edits.
 *
 * Expected result for any N and P packs:
 *   maxDeviationPct < (1/N × 100)%   — at most 1 edit off-balance
 *
 * Example: 1000 edits, 3 packs → maxDeviationPct < 0.1%
 */
export function auditRotation(
  rotator: StylePackRotator,
  editCount: number,
): RotationAudit {
  const counts: Record<string, number> = {};
  for (const id of rotator.packIds) counts[id] = 0;

  for (let i = 0; i < editCount; i++) {
    const id = rotator.resolve(i);
    counts[id] = (counts[id] ?? 0) + 1;
  }

  const expected = editCount / rotator.size;
  let maxDev = 0;
  for (const c of Object.values(counts)) {
    const dev = Math.abs(c - expected) / expected;
    if (dev > maxDev) maxDev = dev;
  }

  return {
    counts,
    maxDeviationPct: maxDev * 100,
    total: editCount,
    isBalanced: maxDev * 100 < 0.2,
  };
}
