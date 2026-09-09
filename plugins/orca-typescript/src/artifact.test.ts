import { readFile, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hashPluginTree } from '../../../src/main/plugins/plugin-content-hash'
import { parsePluginManifest } from '../../../src/shared/plugins/plugin-manifest'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const sourceRoot = resolve('plugins/orca-typescript')
const artifactRoot = resolve('resources/plugins/launch/stablyai.orca-typescript')

type JsonRecord = Record<string, unknown>

async function json<T extends JsonRecord>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

describe('orca-typescript bundled artifact', () => {
  it('declares the first-party provider identity and capabilities', async () => {
    const rawManifest = await json<JsonRecord>(join(sourceRoot, 'orca-plugin.json'))
    const parsedManifest = parsePluginManifest(rawManifest)
    expect(parsedManifest.ok).toBe(true)
    if (!parsedManifest.ok) {
      throw new Error(parsedManifest.error)
    }
    const manifest = parsedManifest.manifest
    expect(manifest).toMatchObject({
      publisher: 'stablyai',
      id: 'orca-typescript',
      main: 'worker.mjs',
      capabilities: [{ kind: 'editor:languageService' }, { kind: 'workspace:readFiles' }]
    })
    expect(manifest.contributes.editorProviders).toEqual([
      {
        id: 'typescript',
        languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
        features: ['completion', 'diagnostics']
      }
    ])
  })

  it('ships a self-contained bounded artifact with the full TS6 standard library set', async () => {
    const worker = await readFile(join(artifactRoot, 'worker.mjs'), 'utf8')
    expect(worker).not.toMatch(/from\s+['"]node:fs/)
    expect(worker).not.toMatch(/require\(['"]node:fs/)

    const libs = (await readdir(join(artifactRoot, 'lib')))
      .filter((name) => /^lib\..*\.d\.ts$/.test(name))
      .sort()
    const expectedLibs = (await readdir(dirname(require.resolve('@typescript/old'))))
      .filter((name) => /^lib\..*\.d\.ts$/.test(name))
      .sort()
    expect(libs).toEqual(expectedLibs)
    expect(libs).toContain('lib.es2022.full.d.ts')

    const hashed = await hashPluginTree(artifactRoot)
    expect(hashed.ok).toBe(true)
    if (!hashed.ok) {
      return
    }
    expect(hashed.totalBytes).toBeLessThan(50 * 1024 * 1024)
    expect(hashed.fileCount).toBeLessThanOrEqual(2_000)
  })

  it('loads the generated worker in a native Node ESM process', async () => {
    const workerPath = join(artifactRoot, 'worker.mjs')
    const script = `import(${JSON.stringify(`file://${workerPath}`)}).then((module) => { if (typeof module.default !== 'function') process.exit(2) })`
    await expect(
      execFileAsync(process.execPath, ['--input-type=module', '-e', script])
    ).resolves.toMatchObject({ stderr: '' })
  })

  it('matches the deterministic content hash in bundled-plugins.json', async () => {
    const hashed = await hashPluginTree(artifactRoot)
    expect(hashed.ok).toBe(true)
    if (!hashed.ok) {
      return
    }
    const index = await json<{ plugins: unknown[] } & JsonRecord>(
      resolve('resources/plugins/launch/bundled-plugins.json')
    )
    expect(index.plugins).toContainEqual({
      pluginKey: 'stablyai.orca-typescript',
      path: 'stablyai.orca-typescript',
      contentHash: hashed.hash
    })
  })
})
