export type OrcaHost = {
  host: { call(method: string, params?: unknown): Promise<unknown> }
  log(message: string): void
}

export type WorkspaceStatResult = {
  path: string
  status: 'ok' | 'missing'
  type?: 'file' | 'directory'
  byteLength?: number
  mtimeMs?: number
}

export type WorkspaceReadResult =
  | { path: string; status: 'ok'; content: string; byteLength: number; mtimeMs: number }
  | { path: string; status: 'missing' | 'not-file' | 'too-large' | 'binary' }

function chunks<T>(values: readonly T[], size = 256): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

export async function statWorkspacePaths(
  orca: OrcaHost,
  worktreeId: string,
  paths: string[]
): Promise<WorkspaceStatResult[]> {
  const results: WorkspaceStatResult[] = []
  for (const batch of chunks(paths)) {
    const value = (await orca.host.call('workspace.statFiles', { worktreeId, paths: batch })) as {
      results?: WorkspaceStatResult[]
    }
    results.push(...(value.results ?? []))
  }
  return results
}

export async function readWorkspacePaths(
  orca: OrcaHost,
  worktreeId: string,
  paths: string[]
): Promise<WorkspaceReadResult[]> {
  const results: WorkspaceReadResult[] = []
  for (const batch of chunks(paths)) {
    const value = (await orca.host.call('workspace.readFiles', { worktreeId, paths: batch })) as {
      results?: WorkspaceReadResult[]
    }
    results.push(...(value.results ?? []))
  }
  return results
}

export async function readWorkspaceDirectory(
  orca: OrcaHost,
  worktreeId: string,
  path: string
): Promise<{ name: string; path: string }[]> {
  const value = (await orca.host.call('workspace.readDirectory', { worktreeId, path })) as {
    status?: string
    entries?: { name: string; path: string }[]
  }
  return value.status === 'ok' ? (value.entries ?? []) : []
}
