import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const TYPESCRIPT_PLUGIN_KEY = 'stablyai.orca-typescript'

async function approveBundledTypeScript(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const settings = await window.api.settings.set({ pluginSystemEnabled: true })
    window.__store?.setState({ settings })
  })
  await expect
    .poll(
      () =>
        page.evaluate(async (pluginKey) => {
          const listed = await window.api.plugins.refresh()
          const plugin = listed.find((entry) => entry.pluginKey === pluginKey)
          return plugin ? { bundled: plugin.bundled, fingerprint: plugin.consentFingerprint } : null
        }, TYPESCRIPT_PLUGIN_KEY),
      { timeout: 20_000 }
    )
    .toMatchObject({ bundled: true, fingerprint: expect.any(String) })
  await page.evaluate(async (pluginKey) => {
    const plugin = (await window.api.plugins.refresh()).find(
      (entry) => entry.pluginKey === pluginKey
    )
    if (!plugin?.consentFingerprint) {
      throw new Error(`bundled plugin ${pluginKey} cannot be reviewed`)
    }
    await window.api.plugins.consent({
      pluginKey,
      reviewedFingerprint: plugin.consentFingerprint,
      decision: 'approve'
    })
  }, TYPESCRIPT_PLUGIN_KEY)
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

async function openTypescript(
  page: Page,
  filePath: string,
  relativePath: string,
  worktreeId: string
): Promise<void> {
  await page.evaluate(
    ({ path, relative, id }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('store unavailable')
      }
      state.openFile({
        filePath: path,
        relativePath: relative,
        worktreeId: id,
        language: 'typescript',
        mode: 'edit'
      })
    },
    { path: filePath, relative: relativePath, id: worktreeId }
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

async function triggerCompletion(page: Page, text: string): Promise<void> {
  await replaceEditorText(page, text)
  await page.keyboard.press('Control+Space')
}

async function disableTypeScriptPlugin(page: Page): Promise<void> {
  await page.evaluate(async (pluginKey) => {
    await window.api.plugins.setEnabled({ pluginKey, enabled: false })
  }, TYPESCRIPT_PLUGIN_KEY)
}

test('provides real project-aware TypeScript completions and diagnostics', async ({ orcaPage }) => {
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const worktree = await activeWorktree(orcaPage)
  const projectName = `orca-typescript-e2e-${Date.now()}`
  const projectRoot = join(worktree.path, projectName)
  const sourceRoot = join(projectRoot, 'src')
  const examplePath = join(sourceRoot, 'example.ts')
  const relativeExamplePath = `${projectName}/src/example.ts`
  const completionText = [
    "import type { User } from './user'",
    'declare const user: User',
    'user.na'
  ].join('\n')

  await mkdir(sourceRoot, { recursive: true })
  await writeFile(
    join(projectRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler'
      },
      include: ['src/**/*.ts']
    })
  )
  await writeFile(
    join(sourceRoot, 'user.ts'),
    'export interface User { name: string; age: number }\n'
  )
  await writeFile(examplePath, `${completionText}\n`)

  try {
    await approveBundledTypeScript(orcaPage)
    await openTypescript(orcaPage, examplePath, relativeExamplePath, worktree.id)
    await expect
      .poll(
        () =>
          orcaPage.evaluate(
            async (pluginKey) =>
              (await window.api.plugins.list()).find((entry) => entry.pluginKey === pluginKey)
                ?.status,
            TYPESCRIPT_PLUGIN_KEY
          ),
        { timeout: 20_000 }
      )
      .toBe('running')

    await triggerCompletion(orcaPage, completionText)
    await expect(
      orcaPage.locator('.suggest-widget').getByText('name', { exact: true })
    ).toBeVisible({ timeout: 20_000 })
    await orcaPage.keyboard.press('Escape')

    const semanticErrorText = `${completionText.replace('user.na', 'user.name')}\nconst broken: number = 'wrong'`
    await replaceEditorText(orcaPage, semanticErrorText)
    await expect(orcaPage.locator('.monaco-editor .squiggly-error').first()).toBeVisible({
      timeout: 20_000
    })

    const correctedText = semanticErrorText.replace("'wrong'", '42')
    await replaceEditorText(orcaPage, correctedText)
    await expect(orcaPage.locator('.monaco-editor .squiggly-error')).toHaveCount(0, {
      timeout: 20_000
    })

    await disableTypeScriptPlugin(orcaPage)
    await triggerCompletion(orcaPage, completionText)
    await expect(
      orcaPage.locator('.suggest-widget').getByText('name', { exact: true })
    ).toHaveCount(0)
    await expect(orcaPage.locator('.monaco-editor').first()).toBeVisible()
    await orcaPage.keyboard.type('x')
  } finally {
    await disableTypeScriptPlugin(orcaPage).catch(() => undefined)
    await rm(projectRoot, { recursive: true, force: true })
  }
})
