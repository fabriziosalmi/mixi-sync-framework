/**
 * Smoke Test — Gate 2 verification
 *
 * G2.2: VDeck.phase returns correct values for known inputs
 * G2.4: VDeck A@170, VDeck B@170, offset 0 → phaseError = 0
 * G2.5: VDeck A@170, VDeck B@170, offset 100ms → phaseError = 0.283 ± 0.001
 */

import { VDeck } from '../src/engine/VDeck.js';
import { SyncEngine } from '../src/engine/SyncEngine.js';
import {
  createWorkletPIState,
  piTick,
  PI_CONSTANTS,
} from '../src/sync/WorkletPI.js';
import { findBestRatio } from '../src/sync/harmonicSync.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}`);
    failed++;
  }
}

function assertApprox(actual: number, expected: number, tolerance: number, msg: string): void {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (ok) {
    console.log(`  ✅ ${msg} (${actual.toFixed(6)} ≈ ${expected.toFixed(6)} ±${tolerance})`);
    passed++;
  } else {
    console.log(`  ❌ ${msg} (${actual.toFixed(6)} ≠ ${expected.toFixed(6)} ±${tolerance})`);
    failed++;
  }
}

// ── G2.2: VDeck.phase correctness ─────────────────────────────

console.log('\n── G2.2: VDeck.phase correctness ──');

{
  const deck = new VDeck({
    bpm: 120,
    originalBpm: 120,
    firstBeatOffset: 0,
    initialPosition: 0,
    playbackRate: 1.0,
  });

  // At t=0, phase should be 0
  assertApprox(deck.phase, 0, 0.0001, 'phase at t=0');

  // At t=0.25s (half a beat at 120 BPM, beat period = 0.5s)
  deck.position = 0.25;
  assertApprox(deck.phase, 0.5, 0.0001, 'phase at t=0.25s (half beat)');

  // At t=0.5s (exactly 1 beat)
  deck.position = 0.5;
  assertApprox(deck.phase, 0, 0.0001, 'phase at t=0.5s (1 beat)');

  // At t=0.375s (3/4 of a beat)
  deck.position = 0.375;
  assertApprox(deck.phase, 0.75, 0.0001, 'phase at t=0.375s (3/4 beat)');

  // With firstBeatOffset
  const deck2 = new VDeck({
    bpm: 170,
    originalBpm: 170,
    firstBeatOffset: 0.1,  // first beat at 100ms
    initialPosition: 0.1,  // at the first beat
    playbackRate: 1.0,
  });
  assertApprox(deck2.phase, 0, 0.0001, 'phase at firstBeatOffset');

  // Beat period at 170 = 60/170 = 0.352941176...s
  deck2.position = 0.1 + 60 / 170;
  assertApprox(deck2.phase, 0, 0.0001, 'phase at firstBeatOffset + 1 beat');
}

// ── G2.3: PI constants match mixi ─────────────────────────────

console.log('\n── G2.3: PI constants match mixi ──');

assertApprox(PI_CONSTANTS.DEADZONE, 0.003, 0, 'DEADZONE = 0.003');
assertApprox(PI_CONSTANTS.Kp, 0.04, 0, 'Kp = 0.04');
assertApprox(PI_CONSTANTS.Ki, 0.002, 0, 'Ki = 0.002');
assertApprox(PI_CONSTANTS.INTEGRAL_MAX, 0.05, 0, 'INTEGRAL_MAX = 0.05');
assertApprox(PI_CONSTANTS.MAX_CORRECTION, 0.003, 0, 'MAX_CORRECTION = 0.003');
assertApprox(PI_CONSTANTS.DISCONTINUITY_THRESHOLD, 0.25, 0, 'DISCONTINUITY_THRESHOLD = 0.25');

// ── G2.4: Identical decks, zero offset → phaseError = 0 ──────

console.log('\n── G2.4: 170+170 offset=0 → phaseError=0 ──');

{
  const master = new VDeck({
    bpm: 170, originalBpm: 170, firstBeatOffset: 0,
    initialPosition: 5.0, playbackRate: 1.0,
  });
  const slave = new VDeck({
    bpm: 170, originalBpm: 170, firstBeatOffset: 0,
    initialPosition: 5.0, playbackRate: 1.0,
  });

  const engine = new SyncEngine(master, slave, {
    simulateBugB1: false,
  });
  engine.startSync();

  // Run 100 ticks
  let maxError = 0;
  for (let i = 0; i < 100; i++) {
    const sample = engine.tick();
    maxError = Math.max(maxError, Math.abs(sample.phaseError));
  }

  assertApprox(maxError, 0, 0.001, 'max phaseError < 0.001');
}

// ── G2.5: 170+170 offset=100ms → phaseError = 0.283 ──────────

console.log('\n── G2.5: 170+170 offset=100ms → initial phaseError=0.283 ──');

{
  // At 170 BPM, beat period = 352.941ms
  // 100ms offset = 100 / 352.941 = 0.28333 phase
  const beatPeriod = 60 / 170;
  const expectedPhase = 0.1 / beatPeriod; // 100ms / beat_period

  const master = new VDeck({
    bpm: 170, originalBpm: 170, firstBeatOffset: 0,
    initialPosition: 5.0, playbackRate: 1.0,
  });
  const slave = new VDeck({
    bpm: 170, originalBpm: 170, firstBeatOffset: 0,
    initialPosition: 5.0 - 0.1, // 100ms behind
    playbackRate: 1.0,
  });

  // Before sync: verify phase error
  const masterPhase = master.phase;
  const slavePhase = slave.phase;
  let rawError = masterPhase - slavePhase;
  if (rawError > 0.5) rawError -= 1;
  if (rawError < -0.5) rawError += 1;

  assertApprox(Math.abs(rawError), expectedPhase, 0.001,
    `pre-sync phaseError ≈ ${expectedPhase.toFixed(4)}`);

  // After sync: engine should align them
  const engine = new SyncEngine(master, slave, {
    simulateBugB1: false,
  });
  engine.startSync();

  // First tick should already be near zero (seek happened in startSync)
  const firstSample = engine.tick();
  assertApprox(Math.abs(firstSample.phaseError), 0, 0.005,
    'post-sync phaseError ≈ 0 (seek aligned)');
}

// ── G2.extra: harmonicSync findBestRatio ──────────────────────

console.log('\n── G2.extra: harmonicSync ──');

assert(findBestRatio(170, 170) === 1, '170→170 ratio = 1');
assert(findBestRatio(170, 85) === 2, '170→85 ratio = 2');
assert(findBestRatio(128, 170) === 0.75, '128→170 ratio = 0.75 (4:3 harmonic)');
assert(findBestRatio(130, 130) === 1, '130→130 ratio = 1');

// ── G2.extra: PI controller basic behavior ────────────────────

console.log('\n── G2.extra: PI controller unit test ──');

{
  const state = createWorkletPIState();
  state.isSynced = true;
  state.masterBpm = 170;
  state.masterOriginalBpm = 170;
  state.masterFirstBeatOffset = 0;
  state.masterTime = 5.0;
  state.slaveOriginalBpm = 170;
  state.slaveFirstBeatOffset = 0;
  state.slaveTime = 5.0;
  state.baseRate = 1.0;

  // With zero offset, PI should produce ~zero correction
  const dt = 128 / 44100;
  const r = piTick(state, dt);
  assertApprox(Math.abs(r.pllCorrection), 0, 0.0001, 'PI correction ≈ 0 for zero error');
  assert(r.inDeadzone, 'zero error → in deadzone');
}

// ── Summary ───────────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`);
console.log(`  PASSED: ${passed}  FAILED: ${failed}`);
if (failed > 0) {
  console.log(`  ❌ GATE 2 FAILED`);
  process.exit(1);
} else {
  console.log(`  ✅ GATE 2 PASS`);
}
console.log('='.repeat(60));
