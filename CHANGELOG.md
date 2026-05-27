# CHANGELOG — mixi-sync-framework

## Fix B6: baseRate² double-count in PI phase computation

**Date**: 2026-05-25
**Severity**: CRITICA
**Tests fixed**: T07 (128→170), T08 (170→128), T12 (80→200), T13 (170→170.5)
**Regression check**: T01-T06, T09-T11 — no regression (all still PASS)

### Root cause

The PI controller in `pitch-shift-processor.ts` computes:

```typescript
const slaveBpm = this.slaveOriginalBpm * this.baseRate;  // line 224
```

Then uses `slaveBpm` in `virtualBeatPeriod(slaveBpm, ratio)` or `60 / slaveBpm`
to compute the slave beat period for phase comparison.

But `slaveTime` (the slave's audio position) already advances at
`baseRate * (1 + pllCorrection)` per wall second:

```typescript
const slaveRate = this.baseRate * (1.0 + this.pllCorrection);
this.slaveTime += dt * slaveRate;
```

So the phase computation becomes:

```
slaveFrac = slaveTime / slavePeriod
         = (... * baseRate * ...) / (60 / (originalBpm * baseRate))
         = ... * baseRate² * originalBpm / 60
                 ^^^^^^^^^^
                 double-counted
```

The correct computation should use `slaveOriginalBpm` without multiplying
by `baseRate`, because `baseRate` is already factored into `slaveTime`:

```
slaveFrac = slaveTime / (60 / originalBpm)
         = (... * baseRate * ...) * originalBpm / 60
         = ... * baseRate¹ * originalBpm / 60
                 ^^^^^^^^^^
                 correct
```

### Mathematical proof

Audio file has beats at positions: `offset + n × (60/originalBpm)`.
Phase at position P is: `((P - offset) / (60/originalBpm)) % 1`.
This is **independent of playback rate** — rate changes how fast P advances,
not where the beats are.

### Why it was hidden

When `baseRate = 1.0` (same BPM on both decks): `1.0² = 1.0`, no error.
The bug only manifests when `baseRate ≠ 1.0`, i.e., cross-genre or
different-BPM scenarios.

### Fix applied

**File**: `src/sync/WorkletPI.ts` line 158

```diff
- const slaveBpm = state.slaveOriginalBpm * state.baseRate;
+ const slaveBpm = state.slaveOriginalBpm;
```

**File**: `src/engine/SyncEngine.ts` — seek alignment + ground truth

Seek now uses `originalBpm` + harmonic `virtualBeatPeriod` instead of
the adjusted `slave.bpm` for phase computation during initial alignment
and ground truth error measurement.

### Results

| Metric | Before fix | After fix |
|--------|-----------|-----------|
| T07 (128→170) ē | 0.249300 | 0.000000 |
| T08 (170→128) ē | 0.250866 | 0.000000 |
| T12 (80→200) ē | 0.250000 | 0.000000 |
| T13 (170→170.5) ē | 0.050998 | 0.000000 |
| Gate 3 | ROSSO (9/13) | VERDE (13/13) |

---

## Backport to mixi

The fix requires changing **one line** in two files:

### 1. `src/audio/pitch-shift-processor.ts` line 224

```diff
- const slaveBpm = this.slaveOriginalBpm * this.baseRate;
+ const slaveBpm = this.slaveOriginalBpm;
```

### 2. `src/audio/PhaseLockLoop.ts` lines 402-404

```diff
  const ratio = findBestRatio(master.bpm, slave.originalBpm);
  const slavePeriod = ratio !== 1
-   ? virtualBeatPeriod(slave.bpm, ratio)
-   : 60 / slave.bpm;
+   ? virtualBeatPeriod(slave.originalBpm, ratio)
+   : 60 / slave.originalBpm;
```

### 3. `src/store/mixiStore.ts` — syncDeck() seek alignment (optional)

The seek phase alignment in `syncDeck()` also uses `effectiveBpm` (adjusted)
for the slave beat period. For correctness, it should use `originalBpm`:

```diff
- const thisBeatPeriod = 60 / effectiveBpm;
- const thisFrac = (((thisTime - thisDeck.firstBeatOffset) / thisBeatPeriod) % 1 + 1) % 1;
+ const ratio = findBestRatio(masterBpm, thisDeck.originalBpm);
+ const thisBeatPeriod = ratio !== 1
+   ? virtualBeatPeriod(thisDeck.originalBpm, ratio)
+   : 60 / thisDeck.originalBpm;
+ const thisFrac = (((thisTime - thisDeck.firstBeatOffset) / thisBeatPeriod) % 1 + 1) % 1;
```

This is optional because the seek error is small when BPMs are close, and
the PI controller will correct it. But for immediate lock, fixing the seek
eliminates the convergence delay.
