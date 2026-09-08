import { z } from 'zod'
import { pluginIdSchema } from './plugin-manifest-fields'

export const PLUGIN_EDITOR_PROVIDER_LIMIT = 16
export const PLUGIN_EDITOR_PROVIDER_LANGUAGE_LIMIT = 32
export const PLUGIN_EDITOR_PROVIDER_FEATURES = ['completion', 'diagnostics'] as const

export type PluginEditorProviderFeature = (typeof PLUGIN_EDITOR_PROVIDER_FEATURES)[number]
export type PluginEditorProviderContribution = {
  id: string
  languages: string[]
  features: PluginEditorProviderFeature[]
}

const editorLanguageIdSchema = z.string().trim().min(1).max(128)

export const pluginEditorProviderContributionSchema: z.ZodType<PluginEditorProviderContribution> = z
  .object({
    id: pluginIdSchema,
    languages: z.array(editorLanguageIdSchema).min(1).max(PLUGIN_EDITOR_PROVIDER_LANGUAGE_LIMIT),
    features: z
      .array(z.enum(PLUGIN_EDITOR_PROVIDER_FEATURES))
      .min(1)
      .max(PLUGIN_EDITOR_PROVIDER_FEATURES.length)
  })
  .strict()
  .superRefine((contribution, ctx) => {
    for (const key of ['languages', 'features'] as const) {
      const seen = new Set<string>()
      for (const [index, value] of contribution[key].entries()) {
        if (seen.has(value)) {
          ctx.addIssue({
            code: 'custom',
            path: [key, index],
            message: `duplicate ${key.slice(0, -1)}: ${value}`
          })
        }
        seen.add(value)
      }
    }
  })
