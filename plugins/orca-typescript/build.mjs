import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readdir, readFile, rm, mkdir, copyFile, lstat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const pluginRoot = import.meta.dirname
const repoRoot = resolve(pluginRoot, '..', '..')
const launchRoot = join(repoRoot, 'resources', 'plugins', 'launch')
const artifactRoot = join(launchRoot, 'stablyai.orca-typescript')
const manifestPath = join(pluginRoot, 'orca-plugin.json')
const ts6RuntimePath = require.resolve('@typescript/old')
const ts6LibDirectory = dirname(ts6RuntimePath)
const MAX_TOTAL_BYTES = 50 * 1024 * 1024

function frameLength(hash, length) {
  const bytes = Buffer.allocUnsafe(8)
  bytes.writeBigUInt64BE(BigInt(length))
  hash.update(bytes)
}

async function collectFiles(root, directory, files) {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) {
      throw new Error(`symlink not allowed in bundled plugin: ${relative(root, path)}`)
    }
    if (stat.isDirectory()) {
      await collectFiles(root, path, files)
      continue
    }
    if (!stat.isFile()) {
      throw new Error(`unsupported bundled plugin entry: ${relative(root, path)}`)
    }
    files.push({ path, size: stat.size })
  }
}

async function hashTree(root) {
  const files = []
  await collectFiles(root, root, files)
  const hash = createHash('sha256')
  hash.update('orca-plugin-tree-v1\0')
  let totalBytes = 0
  for (const file of files) {
    totalBytes += file.size
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`bundled plugin exceeds ${MAX_TOTAL_BYTES} bytes`)
    }
    const rel = relative(root, file.path).replaceAll('\\', '/')
    frameLength(hash, Buffer.byteLength(rel, 'utf8'))
    hash.update(rel, 'utf8')
    frameLength(hash, file.size)
    hash.update(await readFile(file.path))
  }
  return { hash: hash.digest('hex'), totalBytes, fileCount: files.length }
}

async function copyStandardLibraries() {
  const destination = join(artifactRoot, 'lib')
  await mkdir(destination, { recursive: true })
  const libraries = (await readdir(ts6LibDirectory))
    .filter((name) => name.startsWith('lib.') && name.endsWith('.d.ts'))
    .sort()
  if (libraries.length === 0) {
    throw new Error(`no TypeScript standard libraries found in ${ts6LibDirectory}`)
  }
  for (const library of libraries) {
    await copyFile(join(ts6LibDirectory, library), join(destination, library))
  }
  return libraries.length
}

async function updateBundledIndex(contentHash) {
  const indexPath = join(launchRoot, 'bundled-plugins.json')
  const index = JSON.parse(await readFile(indexPath, 'utf8'))
  const plugins = index.plugins.filter((entry) => entry.pluginKey !== 'stablyai.orca-typescript')
  plugins.push({
    pluginKey: 'stablyai.orca-typescript',
    path: 'stablyai.orca-typescript',
    contentHash
  })
  plugins.sort((a, b) => (a.pluginKey < b.pluginKey ? -1 : a.pluginKey > b.pluginKey ? 1 : 0))
  await writeFile(indexPath, `${JSON.stringify({ version: 1, plugins }, null, 2)}\n`)
}

async function main() {
  await rm(artifactRoot, { recursive: true, force: true })
  await mkdir(artifactRoot, { recursive: true })
  const workerPath = join(artifactRoot, 'worker.mjs')
  await build({
    entryPoints: [join(pluginRoot, 'src', 'index.ts')],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    banner: {
      js: "import { createRequire as __orcaCreateRequire } from 'node:module'; import { fileURLToPath as __orcaFileURLToPath } from 'node:url'; import { dirname as __orcaDirname } from 'node:path'; const require = __orcaCreateRequire(import.meta.url); const __filename = __orcaFileURLToPath(import.meta.url); const __dirname = __orcaDirname(__filename);"
    },
    sourcemap: false,
    legalComments: 'none'
  })
  const worker = await readFile(workerPath, 'utf8')
  await writeFile(workerPath, `${worker.replace(/[ \t]+$/gm, '').trimEnd()}\n`)
  await copyFile(manifestPath, join(artifactRoot, 'orca-plugin.json'))
  const libraryCount = await copyStandardLibraries()
  const hashed = await hashTree(artifactRoot)
  await updateBundledIndex(hashed.hash)
  console.log(
    `built stablyai.orca-typescript: ${hashed.fileCount} files, ${libraryCount} libs, ${hashed.totalBytes} bytes, ${hashed.hash}`
  )
}

await main()
