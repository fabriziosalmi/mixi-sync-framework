/**
 * MetricsCollector — Collects and computes KPIs from sync simulation.
 */

export interface MetricsSample {
  t: number;
  phaseError: number;
  piPhaseDelta: number;
  piError: number;
  pllCorrection: number;
  integral: number;
  effectiveRate: number;
  discontinuity: boolean;
  inDeadzone: boolean;
  masterPosition: number;
  slavePosition: number;
}

// ── V2 interfaces (optional for V1 compat) ────────────────────

export interface BpmChangeEvent {
  timeS: number;
  masterBpmBefore: number;
  masterBpmAfter: number;
  ratioChanged: boolean;
}

export interface SegmentMetrics {
  startS: number;
  endS: number;
  masterBpm: number;
  tRelockS: number | null;
  eMean: number;
  eMax: number;
}

export interface TestMetrics {
  testId: string;
  config: {
    masterBpm: number;
    slaveBpm: number;
    slaveOffsetMs: number;
    simulateBugB1: boolean;
    durationS: number;
    tickRateHz: number;
  };

  // Convergence
  tLockS: number | null;
  converged: boolean;

  // Post-lock error stats
  eMean: number;
  eMax: number;
  eStd: number;
  eMeanMs: number;
  eMaxMs: number;

  // Actions
  seeks: number;
  discontinuities: number;
  deadzonePercent: number;

  // Rate
  rateMin: number;
  rateMax: number;

  // Stability
  relockCount: number;

  // Timeseries (decimated for storage)
  timeseries: {
    t: number[];
    phaseError: number[];
    pllCorrection: number[];
    effectiveRate: number[];
    inDeadzone: boolean[];
  };

  // V2 optional fields
  bpmEvents?: BpmChangeEvent[];
  segments?: SegmentMetrics[];
  tRelockMaxS?: number | null;
}

/** Lock threshold: |phaseError| < this for 500ms = locked. */
const LOCK_THRESHOLD = 0.002;
/** Duration in seconds that error must stay below threshold to declare lock. */
const LOCK_HOLD_S = 0.5;

export class MetricsCollector {
  private samples: MetricsSample[] = [];
  private lockCandidateStart: number | null = null;
  private tLock: number | null = null;
  private lockLost = false;
  private relockCount = 0;
  private wasLocked = false;

  // V2: BPM change tracking
  private bpmEvents: BpmChangeEvent[] = [];
  private segmentStart: number = 0;
  private segmentBpm: number = 0;
  private segments: SegmentMetrics[] = [];
  private pendingRelockFrom: number | null = null;
  private relockTimes: number[] = [];

  addSample(sample: MetricsSample): void {
    this.samples.push(sample);

    // Lock detection
    const absError = Math.abs(sample.phaseError);
    if (absError < LOCK_THRESHOLD) {
      if (this.lockCandidateStart === null) {
        this.lockCandidateStart = sample.t;
      }
      const holdDuration = sample.t - this.lockCandidateStart;
      if (holdDuration >= LOCK_HOLD_S && this.tLock === null) {
        this.tLock = this.lockCandidateStart;
      }
      if (holdDuration >= LOCK_HOLD_S) {
        if (!this.wasLocked) {
          if (this.lockLost) this.relockCount++;
          this.wasLocked = true;

          // V2: record relock time from BPM change
          if (this.pendingRelockFrom !== null) {
            this.relockTimes.push(this.lockCandidateStart! - this.pendingRelockFrom);
            this.pendingRelockFrom = null;
          }
        }
      }
    } else {
      this.lockCandidateStart = null;
      if (this.wasLocked) {
        this.lockLost = true;
        this.wasLocked = false;
      }
    }
  }

  /**
   * Record a BPM change event (V2).
   * Resets lock detector to measure tRelock from this point.
   */
  recordBpmChange(timeS: number, bpmBefore: number, bpmAfter: number, ratioChanged: boolean): void {
    // Close current segment
    if (this.bpmEvents.length > 0 || this.segmentBpm > 0) {
      this.closeSegment(timeS);
    }

    this.bpmEvents.push({
      timeS,
      masterBpmBefore: bpmBefore,
      masterBpmAfter: bpmAfter,
      ratioChanged,
    });

    // Reset lock detector for relock measurement
    this.lockCandidateStart = null;
    if (this.wasLocked) {
      this.wasLocked = false;
      this.lockLost = true;
    }
    this.pendingRelockFrom = timeS;

    // Start new segment
    this.segmentStart = timeS;
    this.segmentBpm = bpmAfter;
  }

  private closeSegment(endS: number): void {
    const startS = this.segmentStart;
    if (endS <= startS) return;

    const segSamples = this.samples.filter(s => s.t >= startS && s.t < endS);
    if (segSamples.length === 0) return;

    const errors = segSamples.map(s => Math.abs(s.phaseError));
    const eMean = errors.reduce((a, b) => a + b, 0) / errors.length;
    const eMax = Math.max(...errors);

    // Find tRelock within this segment
    let tRelock: number | null = null;
    let candidateStart: number | null = null;
    for (const s of segSamples) {
      if (Math.abs(s.phaseError) < LOCK_THRESHOLD) {
        if (candidateStart === null) candidateStart = s.t;
        if (s.t - candidateStart >= LOCK_HOLD_S) {
          tRelock = candidateStart - startS;
          break;
        }
      } else {
        candidateStart = null;
      }
    }

    this.segments.push({ startS, endS, masterBpm: this.segmentBpm, tRelockS: tRelock, eMean, eMax });
  }

  compute(testId: string, config: TestMetrics['config']): TestMetrics {
    const n = this.samples.length;
    if (n === 0) {
      return this.emptyMetrics(testId, config);
    }

    const beatPeriod = 60 / config.masterBpm;

    // Post-lock stats
    const lockIdx = this.tLock !== null
      ? this.samples.findIndex(s => s.t >= this.tLock!)
      : -1;

    const postLock = lockIdx >= 0
      ? this.samples.slice(lockIdx)
      : this.samples; // if never locked, compute on all samples

    const errors = postLock.map(s => Math.abs(s.phaseError));
    const eMean = errors.reduce((a, b) => a + b, 0) / errors.length;
    const eMax = Math.max(...errors);
    const variance = errors.reduce((a, b) => a + (b - eMean) ** 2, 0) / errors.length;
    const eStd = Math.sqrt(variance);

    // Discontinuities
    const discontinuities = this.samples.filter(s => s.discontinuity).length;

    // Deadzone percentage (post-lock)
    const deadzoneCount = postLock.filter(s => s.inDeadzone).length;
    const deadzonePercent = postLock.length > 0 ? (deadzoneCount / postLock.length) * 100 : 0;

    // Rate range
    const rates = this.samples.map(s => s.effectiveRate);
    const rateMin = Math.min(...rates);
    const rateMax = Math.max(...rates);

    // Decimate timeseries: keep every Nth sample for ~1000 points total
    const decimation = Math.max(1, Math.floor(n / 1000));
    const ts = {
      t: [] as number[],
      phaseError: [] as number[],
      pllCorrection: [] as number[],
      effectiveRate: [] as number[],
      inDeadzone: [] as boolean[],
    };
    for (let i = 0; i < n; i += decimation) {
      const s = this.samples[i];
      ts.t.push(Math.round(s.t * 10000) / 10000);
      ts.phaseError.push(Math.round(s.phaseError * 1000000) / 1000000);
      ts.pllCorrection.push(Math.round(s.pllCorrection * 1000000) / 1000000);
      ts.effectiveRate.push(Math.round(s.effectiveRate * 1000000) / 1000000);
      ts.inDeadzone.push(s.inDeadzone);
    }

    // V2: close final segment if any
    if (this.bpmEvents.length > 0 && this.samples.length > 0) {
      this.closeSegment(this.samples[this.samples.length - 1].t);
    }

    const tRelockMaxS = this.relockTimes.length > 0
      ? Math.max(...this.relockTimes)
      : null;

    const result: TestMetrics = {
      testId,
      config,
      tLockS: this.tLock,
      converged: this.tLock !== null,
      eMean,
      eMax,
      eStd,
      eMeanMs: eMean * beatPeriod * 1000,
      eMaxMs: eMax * beatPeriod * 1000,
      seeks: 0, // no seeks in deterministic sim
      discontinuities,
      deadzonePercent,
      rateMin,
      rateMax,
      relockCount: this.relockCount,
      timeseries: ts,
    };

    // V2 optional fields — only include if there were BPM events
    if (this.bpmEvents.length > 0) {
      result.bpmEvents = this.bpmEvents;
      result.segments = this.segments;
      result.tRelockMaxS = tRelockMaxS;
    }

    return result;
  }

  private emptyMetrics(testId: string, config: TestMetrics['config']): TestMetrics {
    return {
      testId, config,
      tLockS: null, converged: false,
      eMean: 0, eMax: 0, eStd: 0, eMeanMs: 0, eMaxMs: 0,
      seeks: 0, discontinuities: 0, deadzonePercent: 0,
      rateMin: 0, rateMax: 0, relockCount: 0,
      timeseries: { t: [], phaseError: [], pllCorrection: [], effectiveRate: [], inDeadzone: [] },
    };
  }
}
