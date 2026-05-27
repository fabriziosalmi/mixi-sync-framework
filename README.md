# mixi-sync-framework

Deterministic test harness for the [mixi](https://github.com/fabriziosalmi/mixi) sync engine. Discovers, validates, and benchmarks phase-lock bugs in isolation before backporting fixes to the real codebase.

## Results

**68/68 scenarios PASS** across 7 categories:

| Test Suite | PASS | Total | Note |
|------------|------|-------|------|
| V1 Static (13 scenarios x 2 modes) | 26 | 26 | All PERFECT (eMean=0) |
| V2 Dynamic BPM (Cat A-E) | 16 | 16 | All PERFECT (eMean=0) |
| V2 Imperfections (Cat F) | 8 | 8 | Sub-audible error |
| V2 Adversarial (Cat G) | 8 | 8 | 2 PI limits documented |
| V2 Combined stress (Cat H) | 10 | 10 | Dynamic BPM + imperfections |

## Bugs discovered

| ID | Severity | Description | Impact |
|----|----------|-------------|--------|
| **B6** | CRITICAL | `slaveBpm = slaveOriginalBpm * baseRate` double-counts rate (slaveTime already integrates at baseRate). Phase proportional to baseRate^2 | Cross-genre sync completely broken |
| **B7** | HIGH | `masterPeriod = 60 / masterBpm` uses rate-adjusted BPM. Beats in audio file are at `60/originalBpm` intervals regardless of playback rate | Phase drift after any BPM change |
| B1 | HIGH | `getCurrentTime()` ignores PLL micro-corrections, injecting ~1.5ms error every 500ms | PI oscillates, never converges |
| B3 | HIGH | `MAX_CORRECTION = +/-0.003` too low, convergence from 10% error takes 11.8s | Amplifies B6, slow convergence |
| B4 | MEDIUM | Deadzone decay 0.95^344/s zeroes correction instantly, causing hunting | Micro-oscillation +/-1ms |
| B2 | MEDIUM | `MixiSyncBridge.sendPacket()` uses `ctx.currentTime - firstBeatOffset` (meaningless) | Network sync only |
| B5 | LOW | `snap_offset_to_first_onset()` threshold too low, max 64 beat scan | Wrong offset on long intros |

## Backport to mixi

**Status: SHIPPED in [v0.5.10](https://github.com/fabriziosalmi/mixi/releases/tag/v0.5.10)**

Fix B6 + B7 backported as 6 one-liner changes across 3 files. Zero new dependencies. Zero new features.

### Changes applied

| # | Bug | File | Change |
|---|-----|------|--------|
| 1 | B6 | `pitch-shift-processor.ts:224` | `slaveBpm = slaveOriginalBpm` (was `* baseRate`) |
| 2 | B7 | `pitch-shift-processor.ts:223` | `masterPeriod = 60 / masterOriginalBpm` (was `masterBpm`) |
| 3 | B7 | `PhaseLockLoop.ts:398` | `masterPeriod = 60 / master.originalBpm` (was `master.bpm`) |
| 4 | B6 | `PhaseLockLoop.ts:402-404` | `slavePeriod` uses `slave.originalBpm` (was `slave.bpm`) |
| 5 | B7 | `mixiStore.ts:495` | `masterBeatPeriod = 60 / other.originalBpm` (was `masterBpm`) |
| 6 | B6 | `mixiStore.ts:502` | `thisBeatPeriod` uses `virtualBeatPeriod(thisDeck.originalBpm, ratio)` (was `60 / effectiveBpm`) |

### Impact per scenario

| Scenario | Before | After |
|----------|--------|-------|
| Same BPM (170 vs 170) | Works (baseRate=1, 1^2=1) | Identical |
| Near-BPM (170 vs 170.5) | Slow drift (correction 0.32% > MAX 0.3%) | Zero drift |
| Cross-genre (128 vs 170) | Broken (eMean=0.25, oscillation 175ms) | Zero error |
| Extreme (80 vs 200) | Broken (no valid ratio) | Zero error |

### Verification

- `tsc --noEmit` -- zero errors
- 586/586 unit tests PASS
- 32/32 mixer integration tests PASS (x6 runs via pre-push hooks)
- GitHub Actions Build & Release -- all 7 jobs green
- Release artifacts: DMG (arm64 + x86), AppImage, Windows exe

### Not backported (yet)

Fix 5+6 (dynamic BPM re-seek, playhead re-sync on BPM change) require new infrastructure in mixi. Currently mixi auto-unsyncs on pitch fader change. These fixes are prerequisite for continuous sync during BPM changes -- new functionality, not bug fix. Planned for a separate PR.

## Architecture

```
TestRunner
  |
  +-- VDeck A (position, bpm, offset, rate)
  +-- VDeck B
  |
  +-- SyncEngine (WorkletPI + phase alignment)
  |     |
  |     +-- masterFrac = ((masterTime - offset) / (60/originalBpm)) % 1
  |     +-- slaveFrac  = ((slaveTime  - offset) / slavePeriod) % 1
  |     +-- phaseDelta = wrap(masterFrac - slaveFrac)
  |     +-- PI: correction = Kp*error + Ki*integral
  |
  +-- MetricsCollector
        |
        +-- results/*.json
```

Deterministic simulation: no Web Audio API, no browser jitter, no GC pauses. Pure math at 344.5 Hz (128 samples @ 44100 Hz), matching the real worklet tick rate.

## Usage

```bash
# Run V1 static test matrix (13 scenarios x 2 modes)
npm test

# Run V2 dynamic test matrix (32 scenarios)
npm run test:matrix
```

## Documentation

- [PLAN.md](./PLAN.md) -- Mission plan with gates and KPI definitions
- [AUDIT.md](./AUDIT.md) -- Mathematical audit of mixi sync engine (bugs, proofs, results)
- [CHANGELOG.md](./CHANGELOG.md) -- Fix details with root cause analysis
