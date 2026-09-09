import { describe, expect, it } from 'vitest'
import { summarizeCompletionBenchmark } from './completion-benchmark'

describe('completion benchmark reporting', () => {
  it('reports nearest-rank P50/P95/max and the product target', () => {
    const summary = summarizeCompletionBenchmark(
      Array.from({ length: 20 }, (_, index) => index + 1),
      100
    )

    expect(summary).toEqual({
      sampleCount: 20,
      p50Ms: 10,
      p95Ms: 19,
      maxMs: 20,
      targetP95Ms: 100,
      meetsTarget: true,
      report:
        'TypeScript warm completion: n=20 p50=10.00ms p95=19.00ms max=20.00ms target<100ms PASS'
    })
    expect(summary.report).toBe(
      'TypeScript warm completion: n=20 p50=10.00ms p95=19.00ms max=20.00ms target<100ms PASS'
    )
  })
})
