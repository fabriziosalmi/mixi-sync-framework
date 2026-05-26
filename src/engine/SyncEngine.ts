/**
 * SyncEngine — Deterministic simulation of mixi's sync system.
 *
 * Connects two VDecks through the WorkletPI controller,
 * optionally including the PhaseLockLoop bridge behavior
 * (updatePlayheads every N ticks).
 *
 * Tick rate is configurable but defaults to the worklet's real rate
 * (128 samples / 44100 Hz = ~344.5 Hz, dt = 0.002902s).
 */

import { VDeck } from './VDeck.js';
import {
  type WorkletPIState,
  createWorkletPIState,
  syncCommand,
  updatePlayheads,
  piTick,
  type PITickResult,
} from '../sync/WorkletPI.js';
import { findBestRatio, virtualBeatPeriod } from '../sync/harmonicSync.js';
import type { MetricsSample } from './MetricsCollector.js';

export interface SyncEngineConfig {
  /** Worklet tick rate in Hz (default: 344.53 = 44100/128). */
  tickRateHz: number;
  /** Bridge tick interval in seconds (default: 0.5 = PhaseLockLoop's 2 Hz). */
  bridgeIntervalS: number;
  /**
   * If true, simulate the getCurrentTime() bug from mixi (B1):
   * updatePlayheads uses base rate instead of effective rate.
   */
  simulateBugB1: boolean;
}

const DEFAULT_CONFIG: SyncEngineConfig = {
  tickRateHz: 44100 / 128,
  bridgeIntervalS: 0.5,
  simulateBugB1: true,
};

export class SyncEngine {
  readonly master: VDeck;
  readonly slave: VDeck;
  readonly piState: WorkletPIState;
  readonly config: SyncEngineConfig;

  private time = 0;
  private lastBridgeTime = 0;
  private tickCount = 0;
  private harmonicRatio = 1;

  /** Accumulated slave position using effective rate (true position). */
  private slaveEffectivePosition: number;

  constructor(master: VDeck, slave: VDeck, config?: Partial<SyncEngineConfig>) {
    this.master = master;
    this.slave = slave;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.piState = createWorkletPIState();
    this.slaveEffectivePosition = slave.position;
  }

  /**
   * Initialize sync — equivalent to store.syncDeck() sequence:
   * 1. Set slave playbackRate to match master BPM
   * 2. Phase-align via seek
   * 3. Send sync command to worklet PI
   */
  startSync(): void {
    // 1. Tempo match
    const ratio = findBestRatio(this.master.bpm, this.slave.originalBpm);
    const targetBpm = this.master.bpm / ratio;
    const newRate = targetBpm / this.slave.originalBpm;
    this.slave.playbackRate = newRate;
    this.slave.bpm = Math.round(this.slave.originalBpm * newRate * 10) / 10;

    // 2. Phase alignment using virtual beat period (harmonic-aware, B6 fix)
    this.harmonicRatio = ratio;
    // B7 FIX: use originalBpm, not bpm. Beats in the audio file are at
    // intervals of 60/originalBpm regardless of current playback rate.
    const masterBeatPeriod = 60 / this.master.originalBpm;
    const slaveBeatPeriod = ratio !== 1
      ? virtualBeatPeriod(this.slave.originalBpm, ratio)
      : 60 / this.slave.originalBpm;

    const masterFrac = (((this.master.position - this.master.firstBeatOffset) / masterBeatPeriod) % 1 + 1) % 1;
    const slaveFrac = (((this.slave.position - this.slave.firstBeatOffset) / slaveBeatPeriod) % 1 + 1) % 1;

    let phaseDelta = masterFrac - slaveFrac;
    if (phaseDelta > 0.5) phaseDelta -= 1;
    if (phaseDelta < -0.5) phaseDelta += 1;

    const seekOffset = phaseDelta * slaveBeatPeriod;
    this.slave.position = Math.max(0, this.slave.position + seekOffset);
    this.slaveEffectivePosition = this.slave.position;

    // 3. Sync command to PI
    this.piState.baseRate = newRate;
    syncCommand(
      this.piState,
      this.master.bpm,
      this.master.originalBpm,
      this.master.firstBeatOffset,
      this.master.position,
      this.slave.originalBpm,
      this.slave.firstBeatOffset,
      this.slave.position,
      0, // pllTarget
      0, // onsetOffset
    );

    this.lastBridgeTime = this.time;
  }

  /**
   * Run one simulation tick. Returns metrics for this tick.
   */
  tick(): MetricsSample {
    const dt = 1 / this.config.tickRateHz;
    this.time += dt;
    this.tickCount++;

    // 1. Advance master (always at its natural rate)
    this.master.tick(dt);

    // 2. Run PI controller
    const piResult = piTick(this.piState, dt);

    // 3. Advance slave at effective rate
    const effectiveRate = piResult.effectiveRate;
    this.slave.playbackRate = effectiveRate;
    this.slave.tick(dt);
    this.slaveEffectivePosition += dt * effectiveRate;

    // 4. Bridge tick (updatePlayheads) — every bridgeIntervalS
    if (this.time - this.lastBridgeTime >= this.config.bridgeIntervalS) {
      this.lastBridgeTime = this.time;

      if (this.config.simulateBugB1) {
        // BUG B1: getCurrentTime() uses base rate, not effective rate
        // This simulates the drift between reported and actual position
        const reportedSlaveTime = this.slave.position;
        // In real mixi, getCurrentTime() would compute:
        //   offset + (ctx.currentTime - startedAt) * transport.playbackRate
        // where transport.playbackRate = baseRate (not effective rate)
        // The difference accumulates over the bridge interval.
        updatePlayheads(this.piState, this.master.position, reportedSlaveTime);
      } else {
        // Fixed version: send actual positions
        updatePlayheads(this.piState, this.master.position, this.slaveEffectivePosition);
      }
    }

    // 5. Compute actual phase error (ground truth, using originalBpm + harmonic ratio)
    // Use originalBpm: beats in the audio file are at fixed intervals of 60/originalBpm.
    // master.bpm may differ from originalBpm after changeMasterBpm() — using it
    // would cause the same baseRate² error as B6 but on the master side.
    const masterBeatPeriod = 60 / this.master.originalBpm;
    const masterPhase = (((this.master.position - this.master.firstBeatOffset) / masterBeatPeriod) % 1 + 1) % 1;
    const gtSlavePeriod = this.harmonicRatio !== 1
      ? virtualBeatPeriod(this.slave.originalBpm, this.harmonicRatio)
      : 60 / this.slave.originalBpm;
    const slavePhase = (((this.slave.position - this.slave.firstBeatOffset) / gtSlavePeriod) % 1 + 1) % 1;

    let phaseError = masterPhase - slavePhase;
    if (phaseError > 0.5) phaseError -= 1;
    if (phaseError < -0.5) phaseError += 1;

    return {
      t: this.time,
      phaseError,
      piPhaseDelta: piResult.phaseDelta,
      piError: piResult.error,
      pllCorrection: piResult.pllCorrection,
      integral: piResult.integral,
      effectiveRate: effectiveRate,
      discontinuity: piResult.discontinuity,
      inDeadzone: piResult.inDeadzone,
      masterPosition: this.master.position,
      slavePosition: this.slave.position,
    };
  }

  /**
   * Change master BPM mid-simulation (DJ nudge, ramp, genre shift).
   *
   * Updates master deck rate, recalculates harmonic ratio,
   * adjusts slave baseRate and PI state. Does NOT reset integral
   * so the PI controller adapts smoothly.
   */
  changeMasterBpm(newBpm: number): void {
    const oldRatio = this.harmonicRatio;

    // 1. Update master deck (BPM + playbackRate)
    this.master.bpm = newBpm;
    this.master.playbackRate = newBpm / this.master.originalBpm;

    // 2. Recalculate harmonic ratio
    this.harmonicRatio = findBestRatio(newBpm, this.slave.originalBpm);

    // 3. New slave baseRate
    const targetBpm = newBpm / this.harmonicRatio;
    const newRate = targetBpm / this.slave.originalBpm;
    this.slave.playbackRate = newRate;
    this.slave.bpm = Math.round(this.slave.originalBpm * newRate * 10) / 10;

    // 4. If harmonic ratio changed, re-align slave phase via seek.
    // The virtual beat grid changes with ratio — without a seek, the slave
    // sits at the wrong phase in the new grid and the PI must slowly converge.
    // This mirrors what startSync() does at initial sync.
    if (this.harmonicRatio !== oldRatio) {
      const masterBeatPeriod = 60 / this.master.originalBpm;
      const slaveBeatPeriod = this.harmonicRatio !== 1
        ? virtualBeatPeriod(this.slave.originalBpm, this.harmonicRatio)
        : 60 / this.slave.originalBpm;

      const masterFrac = (((this.master.position - this.master.firstBeatOffset) / masterBeatPeriod) % 1 + 1) % 1;
      const slaveFrac = (((this.slave.position - this.slave.firstBeatOffset) / slaveBeatPeriod) % 1 + 1) % 1;

      let phaseDelta = masterFrac - slaveFrac;
      if (phaseDelta > 0.5) phaseDelta -= 1;
      if (phaseDelta < -0.5) phaseDelta += 1;

      const seekOffset = phaseDelta * slaveBeatPeriod;
      this.slave.position = Math.max(0, this.slave.position + seekOffset);
      this.slaveEffectivePosition = this.slave.position;
    }

    // 5. Update PI state (do NOT reset integral — PI adapts)
    this.piState.baseRate = newRate;
    this.piState.masterBpm = newBpm;
    // masterOriginalBpm stays the same (same master track)

    // 6. Re-sync PI playhead integrators to actual deck positions.
    // Without this, masterTime/slaveTime diverge from reality after
    // the BPM change and the PI sees a phantom phase error.
    this.piState.masterTime = this.master.position;
    this.piState.slaveTime = this.slave.position;
  }

  /** Current simulation time in seconds. */
  get currentTime(): number {
    return this.time;
  }
}
