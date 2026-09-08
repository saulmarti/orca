import type { PluginCapabilityKind } from '../../shared/plugins/plugin-capabilities'
import type { PluginEditorProviderContribution } from '../../shared/plugins/plugin-editor-contributions'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'

export type EditorProviderCandidateGroup = readonly [
  ValidDiscoveredPlugin,
  readonly PluginEditorProviderContribution[]
]

function providerKey(pluginKey: string, providerId: string): string {
  return `${pluginKey}/${providerId}`
}

export function matchingEditorProviderGroups(options: {
  plugins: readonly DiscoveredPlugin[]
  languageId: string
  getGrantedCapabilities: (pluginKey: string) => readonly PluginCapabilityKind[] | null
}): EditorProviderCandidateGroup[] {
  const candidates = options.plugins
    .filter((plugin): plugin is ValidDiscoveredPlugin => !isInvalidDiscoveredPlugin(plugin))
    .flatMap((plugin) => {
      const capabilities = options.getGrantedCapabilities(plugin.pluginKey)
      if (!capabilities?.includes('editor:languageService')) {
        return []
      }
      return plugin.manifest.contributes.editorProviders
        .filter((provider) => provider.languages.includes(options.languageId))
        .map((contribution) => ({ plugin, contribution }))
    })
    .sort((left, right) =>
      providerKey(left.plugin.pluginKey, left.contribution.id).localeCompare(
        providerKey(right.plugin.pluginKey, right.contribution.id)
      )
    )

  const groups = new Map<ValidDiscoveredPlugin, PluginEditorProviderContribution[]>()
  for (const candidate of candidates) {
    const group = groups.get(candidate.plugin) ?? []
    group.push(candidate.contribution)
    groups.set(candidate.plugin, group)
  }
  return [...groups]
}
