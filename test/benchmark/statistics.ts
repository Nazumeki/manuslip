function sortedSamples(values: readonly number[]): number[] {
  for (const [index, value] of values.entries()) {
    if (!Number.isFinite(value) || value < 0)
      throw new RangeError(`Invalid performance sample at index ${index}: ${String(value)}`)
  }
  return [...values].sort((a, b) => a - b)
}

function rank(sorted: readonly number[], fraction: number): number | null {
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? null
}

export function percentile(values: readonly number[], fraction = 0.95): number | null {
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1)
    throw new RangeError('Invalid percentile rank')
  return rank(sortedSamples(values), fraction)
}

export function summary(values: readonly number[]) {
  const sorted = sortedSamples(values)
  return {
    n: sorted.length,
    p50: rank(sorted, 0.5),
    p95: rank(sorted, 0.95),
    max: sorted.at(-1) ?? null,
  }
}
