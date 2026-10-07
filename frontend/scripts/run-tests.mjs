// 用 esbuild 把 test/ 下的 TS 测试分别打成临时 CJS 包，再交给 node:test 运行；
// 临时包写在系统临时目录，仓库不留测试构建产物。
// fake-indexeddb 保持 external，通过 NODE_PATH 指向项目 node_modules 解析。
import { build } from 'esbuild'
import { readdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const projectRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const testDir = join(projectRoot, 'test')
const entryPoints = (await readdir(testDir))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => join(testDir, name))

if (entryPoints.length === 0) {
  console.error('未找到测试文件')
  process.exit(1)
}

const dir = await mkdtemp(join(tmpdir(), 'gbwoodprint-tests-'))

try {
  await build({
    entryPoints,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outdir: dir,
    external: ['fake-indexeddb'],
    absWorkingDir: projectRoot,
    logLevel: 'silent',
  })
  const testFiles = entryPoints.map((entry) =>
    join(dir, entry.slice(testDir.length + 1).replace(/\.ts$/, '.js')),
  )
  const result = spawnSync(process.execPath, ['--test', '--test-force-exit', ...testFiles], {
    stdio: 'inherit',
    env: { ...process.env, NODE_PATH: join(projectRoot, 'node_modules') },
  })
  process.exitCode = result.status ?? 1
} finally {
  await rm(dir, { recursive: true, force: true })
}
