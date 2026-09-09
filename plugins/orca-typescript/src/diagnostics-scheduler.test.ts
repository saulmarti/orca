import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiagnosticsScheduler } from './diagnostics-scheduler'

const publication = (version: number) => ({
  documentId: 'doc-1',
  version,
  diagnostics: []
})

describe('DiagnosticsScheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('collapses rapid edits into one diagnostic run', async () => {
    const publish = vi.fn()
    const first = vi.fn(async () => publication(1))
    const second = vi.fn(async () => publication(2))
    const scheduler = new DiagnosticsScheduler({ publish, delayMs: 300 })

    scheduler.schedule('doc-1', first)
    scheduler.schedule('doc-1', second)
    await vi.advanceTimersByTimeAsync(300)

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(publication(2))
  })

  it('drops a running generation after a newer edit is scheduled', async () => {
    const publish = vi.fn()
    let resolveFirst!: (value: ReturnType<typeof publication>) => void
    const first = vi.fn(
      () => new Promise<ReturnType<typeof publication>>((resolve) => (resolveFirst = resolve))
    )
    const second = vi.fn(async () => publication(2))
    const scheduler = new DiagnosticsScheduler({ publish, delayMs: 300 })

    scheduler.schedule('doc-1', first)
    await vi.advanceTimersByTimeAsync(300)
    expect(first).toHaveBeenCalledTimes(1)

    scheduler.schedule('doc-1', second)
    resolveFirst(publication(1))
    await Promise.resolve()
    expect(publish).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(300)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(publication(2))
  })
})
