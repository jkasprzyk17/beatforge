/**
 * Variation engine — resolves a unique VariationConfig for each generated edit.
 *
 * COMBINATORIAL EXPLOSION MATH (why 1000 edits are nearly always unique):
 *
 *   Given defaults:
 *     cutCount:     4–8 options (5 possible values)
 *     transitions:  8 options  per cut (e.g. 5 cuts → 8^4 = 4096 transition combos)
 *     lyricStyle:   4 options
 *     colorGrade:   8 options
 *     zoomStrength: continuous [1.04, 1.12] → effectively infinite
 *     grain:        continuous [0, 0.04]    → effectively infinite
 *
 *   For 5-cut edit:  5 × 4096 × 4 × 8 = 655,360 discrete style combinations
 *   Plus clip selection from 300-clip pool: C(300,5) = 19.6 billion combinations
 *
 *   Total unique edits possible: ~12.9 × 10^15 (12.9 quadrillion)
 *   Probability of any two matching at 1000 edits: astronomically low.
 *
 * Every parameter is drawn from the SAME seeded RNG instance that was
 * initialized for the edit. This means:
 *   - Same seed → same edit (reproducibility for debugging/re-render)
 *   - Different seed → statistically independent edit
 */

import {
  pick,
  randFloat,
  randBool,
  randInt,
  type RNG,
} from "./prng.js";
import {
  type ColorGrade,
  type Transition,
  type CaptionStyle,
} from "./presetService.js";

// ── Re-export types used by external callers ───────────────

export type { ColorGrade, Transition, CaptionStyle };
export type BeatDivision = 1 | 2 | 4;

// ── Variation pool — defines the universe of possible values ──

/**
 * Immutable configuration declaring all possible values for each parameter.
 * Defined once per batch; shared across all edits.
 * Can be overridden per-batch via the API request.
 */
export interface VariationPool {
  /** [min, max] cut count per edit (inclusive). Default: [4, 8] */
  cutCountRange: [number, number];

  /** Zoom punch multiplier [min, max]. Default: [1.04, 1.12] */
  zoomPunchStrengthRange: [number, number];

  /**
   * Beat division options.
   * 1 = cut every beat
   * 2 = cut every 2nd beat
   * 4 = cut every 4th beat (cinematic)
   */
  beatDivisionOptions: BeatDivision[];

  /** Transitions to sample from for inter-clip cuts. */
  transitionPool: Transition[];

  /** Caption animation styles to rotate through. */
  lyricStyles: CaptionStyle[];

  /** Color grades to apply to the whole edit. */
  colorGrades: ColorGrade[];

  /** Probability [0–1] that any given clip slot has speed variation. */
  speedVarianceProbability: number;

  /** Speed multiplier range for varied clips. Values outside [0.5, 2.0] may stutter. */
  speedVarianceRange: [number, number];

  /** Probability of RGB glitch effect on intro frames. */
  glitchProbability: number;

  /** Probability of white flash frames on drop timestamps. */
  flashDropProbability: number;

  /** Probability of cinematic letterbox bars. */
  letterboxProbability: number;

  /** Probability of lens vignette overlay. */
  vignetteProbability: number;

  /** Film grain intensity range [min, max]. 0 = off, 0.04 = subtle. */
  grainRange: [number, number];

  /** Probability of film grain. */
  filmGrainProbability: number;

  /** Probability of caption box background (readable on busy clips). */
  captionBoxProbability: number;
}

// ── Resolved variation — values locked in for ONE specific edit ──

/**
 * The concrete parameter set resolved from a VariationPool for a single edit.
 * This object is serialised into the generation_manifests table.
 * Reconstructing an edit from its manifest produces identical output.
 */
export interface ResolvedVariation {
  /** How many clips/segments this edit contains. */
  cutCount: number;

  /** Zoom punch multiplier applied at each cut point. */
  zoomPunchStrength: number;

  /** Beat division used when computing cut timestamps from the beat grid. */
  beatDivision: BeatDivision;

  /**
   * Transition type for each inter-clip boundary.
   * Length = cutCount - 1.
   */
  transitions: Transition[];

  /** Caption animation style for lyric overlay. */
  lyricStyle: CaptionStyle;

  /** Color grade applied to the entire composited video. */
  colorGrade: ColorGrade;

  /** Whether each clip slot has speed variation (length = cutCount). */
  speedVarianceClips: boolean[];

  /** Speed factor per clip slot (1.0 = normal). Length = cutCount. */
  speedFactors: number[];

  /** Apply RGB glitch effect to the intro (~0.5s). */
  applyGlitch: boolean;

  /** Apply white flash frames at detected drop timestamps. */
  applyFlashDrop: boolean;

  /** Apply cinematic letterbox bars (12% top/bottom). */
  applyLetterbox: boolean;

  /** Apply lens vignette overlay. */
  applyVignette: boolean;

  /** Film grain intensity (0 = off). */
  grainIntensity: number;

  /** Whether caption has a semi-transparent background box. */
  captionBoxBackground: boolean;
}

// ── Default pool ───────────────────────────────────────────

/**
 * Production-ready default variation pool.
 * Tuned for short-form viral content (15–60s TikTok/Reels/Shorts).
 * All probabilities derived from empirical A/B testing conventions.
 */
export const DEFAULT_VARIATION_POOL: VariationPool = {
  cutCountRange: [4, 8],
  zoomPunchStrengthRange: [1.04, 1.12],
  beatDivisionOptions: [1, 2, 4],
  transitionPool: [
    "fade",
    "glitch",
    "dissolve",
    "wipeleft",
    "pixelize",
    "squeezev",
    "zoomin",
    "hblur",
  ],
  lyricStyles: ["karaoke", "karaoke_pill", "bold_center", "minimal_clean"],
  colorGrades: [
    "dark_contrast",
    "vibrant",
    "muted",
    "warm",
    "cold",
    "teal_orange",
    "neon_glow",
    "film_noir",
  ],
  speedVarianceProbability: 0.35,
  speedVarianceRange: [0.92, 1.08],
  glitchProbability: 0.5,
  flashDropProbability: 0.6,
  letterboxProbability: 0.25,
  vignetteProbability: 0.4,
  grainRange: [0.0, 0.04],
  filmGrainProbability: 0.45,
  captionBoxProbability: 0.3,
};

// ── Core resolver ──────────────────────────────────────────

/**
 * Resolve a complete VariationConfig for a single edit.
 *
 * All randomness is consumed from `rng` in a fixed, deterministic order.
 * The rng must be at a fresh state for each edit (i.e. created from the
 * edit's per-edit seed via mulberry32(deriveSeed(masterSeed, editIndex))).
 *
 * Order of consumption matters — do not change order without bumping
 * the manifest schema version (would break existing reproducible seeds).
 *
 * @param pool       - The variation pool defining possible values
 * @param rng        - Seeded PRNG instance for this specific edit
 * @param maxClips   - Upper bound on cutCount (limits cuts to clip pool size)
 */
export function resolveVariation(
  pool: VariationPool,
  rng: RNG,
  maxClips?: number,
): ResolvedVariation {
  // 1. Cut count — capped by clip pool size to avoid out-of-bounds
  const minCuts = pool.cutCountRange[0];
  const maxCuts = pool.cutCountRange[1];
  const rawCutCount =
    minCuts + randInt(maxCuts - minCuts + 1, rng);
  const cutCount = maxClips != null
    ? Math.min(rawCutCount, maxClips)
    : rawCutCount;

  // 2. Zoom punch strength
  const zoomPunchStrength = randFloat(
    pool.zoomPunchStrengthRange[0],
    pool.zoomPunchStrengthRange[1],
    rng,
  );

  // 3. Beat division
  const beatDivision = pick(pool.beatDivisionOptions, rng);

  // 4. Per-cut transitions (cutCount - 1 transitions for cuts between segments)
  const transitions: Transition[] = [];
  for (let i = 0; i < cutCount - 1; i++) {
    transitions.push(pick(pool.transitionPool, rng));
  }

  // 5. Lyric style
  const lyricStyle = pick(pool.lyricStyles, rng);

  // 6. Color grade
  const colorGrade = pick(pool.colorGrades, rng);

  // 7. Per-clip speed variance (one decision per clip slot)
  const speedVarianceClips: boolean[] = [];
  const speedFactors: number[] = [];
  for (let i = 0; i < cutCount; i++) {
    const varies = randBool(pool.speedVarianceProbability, rng);
    speedVarianceClips.push(varies);
    speedFactors.push(
      varies
        ? randFloat(pool.speedVarianceRange[0], pool.speedVarianceRange[1], rng)
        : 1.0,
    );
  }

  // 8. Binary effect flags
  const applyGlitch = randBool(pool.glitchProbability, rng);
  const applyFlashDrop = randBool(pool.flashDropProbability, rng);
  const applyLetterbox = randBool(pool.letterboxProbability, rng);
  const applyVignette = randBool(pool.vignetteProbability, rng);

  // 9. Film grain intensity (0 if film grain not triggered)
  const grainIntensity = randBool(pool.filmGrainProbability, rng)
    ? randFloat(pool.grainRange[0], pool.grainRange[1], rng)
    : 0;

  // 10. Caption box
  const captionBoxBackground = randBool(pool.captionBoxProbability, rng);

  return {
    cutCount,
    zoomPunchStrength,
    beatDivision,
    transitions,
    lyricStyle,
    colorGrade,
    speedVarianceClips,
    speedFactors,
    applyGlitch,
    applyFlashDrop,
    applyLetterbox,
    applyVignette,
    grainIntensity,
    captionBoxBackground,
  };
}

/**
 * Merge a ResolvedVariation into a PresetConfig-compatible object.
 * Variation values take precedence over preset defaults.
 * Unknown keys are silently ignored by assembleVideo.
 */
export function mergeVariationIntoPreset(
  basePreset: Record<string, unknown> | null,
  variation: ResolvedVariation,
): Record<string, unknown> {
  return {
    ...(basePreset ?? {}),
    // Override preset values with variation-resolved values
    colorGrade: variation.colorGrade,
    zoomPunch: variation.zoomPunchStrength > 1.0,
    speedVariation: variation.speedVarianceClips.some(Boolean),
    flashOnDrop: variation.applyFlashDrop,
    filmGrain: variation.grainIntensity > 0,
    vignette: variation.applyVignette,
    letterbox: variation.applyLetterbox,
    captionBoxBackground: variation.captionBoxBackground,
    // Pass resolved values for downstream use
    _zoomPunchStrength: variation.zoomPunchStrength,
    _beatDivision: variation.beatDivision,
    _transitions: variation.transitions,
    _speedFactors: variation.speedFactors,
    _applyGlitch: variation.applyGlitch,
  };
}
