/**
 * WorkletPI — VERBATIM COPY of the PI controller from
 * mixi/src/audio/pitch-shift-processor.ts (lines 83-263)
 *
 * This is the actual sync engine that runs in mixi's AudioWorklet.
 * Extracted here for deterministic testing without Web Audio API.
 *
 * ALL constants, thresholds, and logic are identical to mixi.
 * Any divergence MUST be documented in CHANGELOG.md.
 */

import { findBestRatio, virtualBeatPeriod } from './harmonicSync.js';

// ── Constants (verbatim from pitch-shift-processor.ts) ──────

const DEADZONE = 0.003;
const Kp = 0.04;
const Ki = 0.002;
const INTEGRAL_MAX = 0.05;
const MAX_CORRECTION = 0.003;
const DISCONTINUITY_THRESHOLD = 0.25;

export interface WorkletPIState {
  isSynced: boolean;
  baseRate: number;
  pllCorrection: number;
  integral: number;
  lastPhaseDelta: number;

  masterBpm: number;
  masterOriginalBpm: number;
  masterFirstBeatOffset: number;
  masterTime: number;

  slaveBpm: number;
  slaveOriginalBpm: number;
  slaveFirstBeatOffset: number;
  slaveTime: number;

  pllTarget: number;
  onsetOffset: number;
  driftCorrection: number;
}

export function createWorkletPIState(): WorkletPIState {
  return {
    isSynced: false,
    baseRate: 1.0,
    pllCorrection: 0,
    integral: 0,
    lastPhaseDelta: 0,
    masterBpm: 0,
    masterOriginalBpm: 0,
    masterFirstBeatOffset: 0,
    masterTime: 0,
    slaveBpm: 0,
    slaveOriginalBpm: 0,
    slaveFirstBeatOffset: 0,
    slaveTime: 0,
    pllTarget: 0,
    onsetOffset: 0,
    driftCorrection: 0,
  };
}

/**
 * Sync command — equivalent to receiving { type: 'sync', ... } in the worklet.
 */
export function syncCommand(
  state: WorkletPIState,
  masterBpm: number,
  masterOriginalBpm: number,
  masterFirstBeatOffset: number,
  masterTime: number,
  slaveOriginalBpm: number,
  slaveFirstBeatOffset: number,
  slaveTime: number,
  pllTarget: number,
  onsetOffset: number,
): void {
  state.isSynced = true;
  state.masterBpm = masterBpm;
  state.masterOriginalBpm = masterOriginalBpm;
  state.masterFirstBeatOffset = masterFirstBeatOffset;
  state.masterTime = masterTime;
  state.slaveOriginalBpm = slaveOriginalBpm;
  state.slaveFirstBeatOffset = slaveFirstBeatOffset;
  state.slaveTime = slaveTime;
  state.pllTarget = pllTarget;
  state.onsetOffset = onsetOffset;
  state.integral = 0;
  state.pllCorrection = 0;
}

/**
 * Unsync command — equivalent to receiving { type: 'unsync' } in the worklet.
 */
export function unsyncCommand(state: WorkletPIState): void {
  state.isSynced = false;
  state.integral = 0;
  state.pllCorrection = 0;
}

/**
 * Update playheads — equivalent to receiving { type: 'updatePlayheads' }.
 */
export function updatePlayheads(
  state: WorkletPIState,
  masterTime: number,
  slaveTime: number,
): void {
  state.masterTime = masterTime;
  state.slaveTime = slaveTime;
}

export interface PITickResult {
  effectiveRate: number;
  phaseDelta: number;
  error: number;
  pllCorrection: number;
  integral: number;
  discontinuity: boolean;
  inDeadzone: boolean;
}

/**
 * One tick of the PI controller.
 *
 * VERBATIM logic from pitch-shift-processor.ts process() lines 204-263.
 * dt = time step in seconds.
 */
export function piTick(state: WorkletPIState, dt: number): PITickResult {
  const result: PITickResult = {
    effectiveRate: state.baseRate,
    phaseDelta: 0,
    error: 0,
    pllCorrection: state.pllCorrection,
    integral: state.integral,
    discontinuity: false,
    inDeadzone: false,
  };

  if (!state.isSynced) {
    return result;
  }

  // Integrate playheads
  const masterRate = state.masterOriginalBpm > 0
    ? (state.masterBpm / state.masterOriginalBpm)
    : 1.0;
  state.masterTime += dt * masterRate;

  const slaveRate = state.baseRate * (1.0 + state.pllCorrection);
  state.slaveTime += dt * slaveRate;

  // Calculate phase delta
  // B7 FIX: use masterOriginalBpm for period, not masterBpm.
  // masterTime is a file position — beats in the file are at 60/originalBpm intervals.
  // Using masterBpm (which differs from originalBpm after tempo change) causes
  // the same phase error as B6 but on the master side.
  const masterPeriod = 60 / state.masterOriginalBpm;
  // B6 FIX: use originalBpm, NOT originalBpm * baseRate.
  // slaveTime already advances at baseRate — multiplying again
  // would double-count baseRate (phase ∝ baseRate² instead of baseRate).
  const slaveBpm = state.slaveOriginalBpm;
  const ratio = findBestRatio(state.masterBpm, state.slaveOriginalBpm);
  const slavePeriod = ratio !== 1
    ? virtualBeatPeriod(slaveBpm, ratio)
    : 60 / slaveBpm;

  if (masterPeriod > 0 && slavePeriod > 0) {
    const masterFrac = (((state.masterTime - state.masterFirstBeatOffset) / masterPeriod) % 1 + 1) % 1;
    const slaveFrac = (((state.slaveTime - state.slaveFirstBeatOffset) / slavePeriod) % 1 + 1) % 1;

    let phaseDelta = masterFrac - slaveFrac;
    if (phaseDelta > 0.5) phaseDelta -= 1;
    if (phaseDelta < -0.5) phaseDelta += 1;

    result.phaseDelta = phaseDelta;

    // Discontinuity detection
    if (Math.abs(phaseDelta - state.lastPhaseDelta) > DISCONTINUITY_THRESHOLD) {
      state.integral = 0;
      state.lastPhaseDelta = phaseDelta;
      state.pllCorrection = 0;
      result.discontinuity = true;
    } else {
      state.lastPhaseDelta = phaseDelta;

      // Error = actual phase delta + onset offset - desired target
      const error = phaseDelta + state.onsetOffset - state.pllTarget;
      result.error = error;

      if (Math.abs(error) < DEADZONE) {
        state.integral *= 0.95;
        state.pllCorrection *= 0.95;
        result.inDeadzone = true;
      } else {
        const P = Kp * error;
        state.integral += error * dt;
        state.integral = Math.max(-INTEGRAL_MAX, Math.min(INTEGRAL_MAX, state.integral));
        const I = Ki * state.integral;
        const raw = P + I;
        state.pllCorrection = Math.max(-MAX_CORRECTION, Math.min(MAX_CORRECTION, raw));
      }
    }
  }

  result.pllCorrection = state.pllCorrection;
  result.integral = state.integral;
  result.effectiveRate = state.baseRate * (1.0 + state.pllCorrection + state.driftCorrection);

  return result;
}

// ── Exported constants for test verification ──────────────────

export const PI_CONSTANTS = {
  DEADZONE,
  Kp,
  Ki,
  INTEGRAL_MAX,
  MAX_CORRECTION,
  DISCONTINUITY_THRESHOLD,
} as const;
