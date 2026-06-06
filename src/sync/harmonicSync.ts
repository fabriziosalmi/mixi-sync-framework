/**
 * Harmonic Sync — VERBATIM COPY from mixi/src/audio/harmonicSync.ts
 *
 * Finds the best harmonic ratio between two BPM values for
 * cross-genre syncing (e.g. DnB 170 + House 128).
 */

const RATIOS = [1, 2, 0.5, 1.5, 0.75, 4 / 3, 3 / 4] as const;
const MAX_ERROR_BPM = 5;

export function findBestRatio(masterBpm: number, slaveBpm: number): number {
  if (!Number.isFinite(masterBpm) || !Number.isFinite(slaveBpm) || masterBpm <= 0 || slaveBpm <= 0) return 1;

  let bestRatio = 1;
  let bestError = Infinity;

  for (const ratio of RATIOS) {
    const targetBpm = masterBpm / ratio;
    const error = Math.abs(slaveBpm - targetBpm);
    if (error < bestError && error < MAX_ERROR_BPM) {
      bestError = error;
      bestRatio = ratio;
    }
  }

  return bestRatio;
}

export function virtualBeatPeriod(slaveBpm: number, ratio: number): number {
  if (slaveBpm <= 0 || ratio <= 0) return 0;
  return (60 / slaveBpm) / ratio;
}