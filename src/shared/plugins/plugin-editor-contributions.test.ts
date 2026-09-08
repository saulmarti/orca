import { describe, expect, it } from 'vitest'
import { pluginEditorProviderContributionSchema } from './plugin-editor-contributions'
import { parsePluginManifest } from './plugin-manifest'

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'demo',
    publisher: 'orca-samples',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: { panels: [], commands: [], events: [] },
    capabilities: [],
    ...overrides
  }
}

const editorProvider = {
  id: 'typescript',
  languages: ['typescript', 'javascript'],
  features: ['completion', 'diagnostics']
}

describe('plugin editor provider contributions', () => {
  it('accepts the MVP completion and diagnostics features', () => {
    expect(pluginEditorProviderContributionSchema.safeParse(editorProvider).success).toBe(true)
  })

  it('rejects unsupported features and duplicate languages', () => {
    expect(
      pluginEditorProviderContributionSchema.safeParse({
        ...editorProvider,
        features: ['hover']
      }).success
    ).toBe(false)
    expect(
      pluginEditorProviderContributionSchema.safeParse({
        ...editorProvider,
        languages: ['typescript', 'typescript']
      }).success
    ).toBe(false)
  })

  it('rejects duplicate editor provider ids', () => {
    const result = parsePluginManifest(
      manifest({
        main: 'worker.mjs',
        contributes: {
          panels: [],
          commands: [],
          events: [],
          editorProviders: [editorProvider, { ...editorProvider }]
        },
        capabilities: [{ kind: 'editor:languageService' }]
      })
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('duplicate editorProviders id: typescript')
    }
  })

  it('requires a worker entry when editor providers are declared', () => {
    const result = parsePluginManifest(
      manifest({
        contributes: {
          panels: [],
          commands: [],
          events: [],
          editorProviders: [editorProvider]
        },
        capabilities: [{ kind: 'editor:languageService' }]
      })
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('required when contributes.editorProviders is non-empty')
    }
  })

  it('requires language-service consent when editor providers are declared', () => {
    const result = parsePluginManifest(
      manifest({
        main: 'worker.mjs',
        contributes: {
          panels: [],
          commands: [],
          events: [],
          editorProviders: [editorProvider]
        }
      })
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('editor:languageService capability required')
    }
  })
})
