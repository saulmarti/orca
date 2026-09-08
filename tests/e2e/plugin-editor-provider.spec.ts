import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

async function installApprovedFixture(page: Page, sourcePath: string): Promise<string> {
  return page.evaluate(async (pluginPath) => {
    const settings = await window.api.settings.set({ pluginSystemEnabled: true })
    window.__store?.setState({ settings })
    await window.api.plugins.refresh()
    const installed = await window.api.plugins.install({ kind: 'local-path', path: pluginPath })
    if (!installed.ok) {
      throw new Error(installed.error)
    }
    const listed = await window.api.plugins.refresh()
    const plugin = listed.find((entry) => entry.pluginKey === installed.pluginKey)
    if (!plugin?.consentFingerprint) {
      throw new Error(`installed plugin ${installed.pluginKey} cannot be reviewed`)
    }
    await window.api.plugins.consent({
      pluginKey: plugin.pluginKey,
      reviewedFingerprint: plugin.consentFingerprint,
      decision: 'approve'
    })
    return plugin.pluginKey
  }, sourcePath)
}

async function activeWorktree(page: Page): Promise<{ id: string; path: string }> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const id = state?.activeWorktreeId
    if (!state || !id) {
      throw new Error('active worktree unavailable')
    }
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((candidate) => candidate.id === id)
    if (!worktree) {
      throw new Error('active worktree path unavailable')
    }
    return { id, path: worktree.path }
  })
}

async function openTypescript(page: Page, filePath: string, worktreeId: string): Promise<void> {
  await page.evaluate(
    ({ path, id }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('store unavailable')
      }
      state.openFile({
        filePath: path,
        relativePath: path.split(/[\\/]/).at(-1) ?? path,
        worktreeId: id,
        language: 'typescript',
        mode: 'edit'
      })
    },
    { path: filePath, id: worktreeId }
  )
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(() => page.evaluate(() => window.__monacoEditorE2E?.filePath ?? null))
    .toBe(filePath)
}

async function replaceEditorText(page: Page, text: string): Promise<void> {
  const monaco = page.locator('.monaco-editor').first()
  await monaco.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type(text)
}

async function triggerFixtureCompletion(page: Page): Promise<void> {
  await replaceEditorText(page, 'fixt')
  await page.keyboard.press('Control+Space')
}

test('surfaces plugin completion and diagnostics without renderer plugin code', async ({
  orcaPage
}) => {
  test.setTimeout(120_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const fixturePath = join(process.cwd(), 'examples', 'plugins', 'editor-provider-fixture')
  const worktree = await activeWorktree(orcaPage)
  const filePath = join(worktree.path, `plugin-editor-${Date.now()}.ts`)
  let pluginKey: string | null = null

  await writeFile(filePath, 'fixt\n')
  try {
    pluginKey = await installApprovedFixture(orcaPage, fixturePath)
    await openTypescript(orcaPage, filePath, worktree.id)

    await triggerFixtureCompletion(orcaPage)
    await expect(
      orcaPage.locator('.suggest-widget').getByText('fixtureCompletion', { exact: false })
    ).toBeVisible({ timeout: 15_000 })
    await orcaPage.keyboard.press('Escape')

    await replaceEditorText(orcaPage, 'fixture_error')
    await expect(orcaPage.locator('.monaco-editor .squiggly-error').first()).toBeVisible({
      timeout: 15_000
    })

    await replaceEditorText(orcaPage, 'fixture_ok')
    await expect(orcaPage.locator('.monaco-editor .squiggly-error')).toHaveCount(0, {
      timeout: 15_000
    })

    await orcaPage.evaluate(async (key) => {
      await window.api.plugins.setEnabled({ pluginKey: key, enabled: false })
    }, pluginKey)
    await triggerFixtureCompletion(orcaPage)
    await expect(
      orcaPage.locator('.suggest-widget').getByText('fixtureCompletion', { exact: false })
    ).toHaveCount(0)
    await expect(orcaPage.locator('.monaco-editor').first()).toBeVisible()
  } finally {
    if (pluginKey) {
      await orcaPage
        .evaluate(async (key) => {
          await window.api.plugins.remove({ pluginKey: key })
        }, pluginKey)
        .catch(() => undefined)
    }
    await rm(filePath, { force: true })
  }
})
