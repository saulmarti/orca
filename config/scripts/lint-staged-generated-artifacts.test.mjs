import { readFile } from 'node:fs/promises'
import micromatch from 'micromatch'
import { describe, expect, it } from 'vitest'

const packageJson = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8')
)
const config = packageJson['lint-staged']
const entries = Object.entries(config)
const codePattern = entries.find(([, commands]) => commands.includes('oxlint'))?.[0]
const dataPattern = entries.find(
  ([, commands]) => commands.length === 1 && commands[0] === 'oxfmt --write'
)?.[0]

describe('lint-staged generated artifact boundary', () => {
  it('lints authoring code but not immutable bundled plugin bytes', () => {
    expect(codePattern).toBeTruthy()
    expect(micromatch.isMatch('plugins/orca-typescript/src/index.ts', codePattern)).toBe(true)
    expect(micromatch.isMatch('resources/direct.ts', codePattern)).toBe(true)
    expect(micromatch.isMatch('resources/plugins/direct.ts', codePattern)).toBe(true)
    expect(micromatch.isMatch('resources/plugins/other/source.ts', codePattern)).toBe(true)
    expect(micromatch.isMatch('cloud/worker.ts', codePattern)).toBe(false)
    expect(
      micromatch.isMatch(
        'resources/plugins/launch/stablyai.orca-typescript/worker.mjs',
        codePattern
      )
    ).toBe(false)
  })

  it('formats authored JSON but not hash-addressed bundled manifests', () => {
    expect(dataPattern).toBeTruthy()
    expect(micromatch.isMatch('package.json', dataPattern)).toBe(true)
    expect(
      micromatch.isMatch(
        'resources/plugins/launch/stablyai.orca-typescript/orca-plugin.json',
        dataPattern
      )
    ).toBe(false)
  })
})
