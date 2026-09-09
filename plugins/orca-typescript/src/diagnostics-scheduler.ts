import type { EditorDiagnosticsPublication } from '../../../src/shared/plugins/plugin-editor-protocol'

type DiagnosticRun = () => Promise<EditorDiagnosticsPublication> | EditorDiagnosticsPublication

type DiagnosticsSchedulerOptions = {
  publish: (publication: EditorDiagnosticsPublication) => void
  delayMs?: number
}

export class DiagnosticsScheduler {
  private readonly generations = new Map<string, number>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly delayMs: number

  constructor(private readonly options: DiagnosticsSchedulerOptions) {
    this.delayMs = options.delayMs ?? 300
  }

  schedule(documentId: string, run: DiagnosticRun): void {
    const generation = (this.generations.get(documentId) ?? 0) + 1
    this.generations.set(documentId, generation)
    const existing = this.timers.get(documentId)
    if (existing) {
      clearTimeout(existing)
    }
    this.timers.set(
      documentId,
      setTimeout(() => {
        this.timers.delete(documentId)
        void this.execute(documentId, generation, run)
      }, this.delayMs)
    )
  }

  cancel(documentId: string): void {
    this.generations.set(documentId, (this.generations.get(documentId) ?? 0) + 1)
    const timer = this.timers.get(documentId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(documentId)
    }
  }

  dispose(): void {
    for (const documentId of this.timers.keys()) {
      this.cancel(documentId)
    }
  }

  private async execute(documentId: string, generation: number, run: DiagnosticRun): Promise<void> {
    const publication = await run()
    if (this.generations.get(documentId) !== generation) {
      return
    }
    this.options.publish(publication)
  }
}
