export function sampleStatistics(
  validValues: readonly number[],
  expectedCount: bigint,
) {
  const validCount = validValues.length;
  const missingCount = expectedCount - BigInt(validCount);
  const missingRate =
    expectedCount === 0n
      ? undefined
      : Number(missingCount) / Number(expectedCount);
  const coverage = { expectedCount, validCount, missingCount, missingRate };
  if (!validCount) return { ...coverage, metrics: undefined };

  const sorted = [...validValues].sort((left, right) => left - right);
  const minimum = sorted[0]!;
  const maximum = sorted[validCount - 1]!;
  // 归一化后再求均值和方差，避免极大样本溢出、极小样本平方后归零。
  const scale = Math.max(Math.abs(minimum), Math.abs(maximum)) || 1;
  const normalized = sorted.map((value) => value / scale);
  const mean = normalized.reduce((sum, value) => sum + value, 0) / validCount;
  const variance =
    normalized.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    validCount;

  function percentile(fraction: number) {
    const rank = (validCount - 1) * fraction;
    const lower = sorted[Math.floor(rank)]!;
    const upper = sorted[Math.ceil(rank)]!;
    const weight = rank % 1;
    return lower < 0 && upper > 0
      ? lower * (1 - weight) + upper * weight
      : lower + (upper - lower) * weight;
  }

  return {
    ...coverage,
    metrics: {
      minimum,
      maximum,
      average: Math.max(minimum, Math.min(maximum, mean * scale)),
      deviation: Math.min(1, Math.sqrt(variance)) * scale,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
    },
  };
}
