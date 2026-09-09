export type CompletionBenchmarkSummary = {
  sampleCount: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  targetP95Ms: number
  meetsTarget: boolean
  report: string
}

function nearestRank(sorted: readonly number[], quantile: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1)
  return sorted[index] ?? 0
}

export function summarizeCompletionBenchmark(
  samples: readonly number[],
  targetP95Ms: number
): CompletionBenchmarkSummary {
  const sorted = [...samples].sort((left, right) => left - right)
  const p50Ms = nearestRank(sorted, 0.5)
  const p95Ms = nearestRank(sorted, 0.95)
  const maxMs = sorted.at(-1) ?? 0
  const meetsTarget = p95Ms < targetP95Ms
  return {
    sampleCount: sorted.length,
    p50Ms,
    p95Ms,
    maxMs,
    targetP95Ms,
    meetsTarget,
    report: `TypeScript warm completion: n=${sorted.length} p50=${p50Ms.toFixed(2)}ms p95=${p95Ms.toFixed(2)}ms max=${maxMs.toFixed(2)}ms target<${targetP95Ms}ms ${meetsTarget ? 'PASS' : 'FAIL'}`
  }
}
