import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as ts6 from '@typescript/typescript6'

const rootPackage = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
) as { devDependencies?: Record<string, string> }

describe('TypeScript compatibility runtime', () => {
  it('uses the TypeScript 6 tooling API without replacing Orca TypeScript 7', () => {
    expect(ts6.version).toMatch(/^6\./)
    expect(ts6.createLanguageService).toBeTypeOf('function')
    expect(rootPackage.devDependencies?.typescript).toMatch(/^\^7\./)
  })
})
