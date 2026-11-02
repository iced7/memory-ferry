import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { writeJsonAtomic } from '../src/utils.js'

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-ferry-atomic-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const file = path.join(root, 'index.json')
  await writeFile(file, '{"previous":true}\n')
  return { root, file }
}

test('atomic replacement retries transient Windows locks without removing the previous file', async (t) => {
  const { root, file } = await fixture(t)
  const failures = ['EPERM', 'EACCES', 'EBUSY']
  await writeJsonAtomic(file, { next: true }, {
    platform: 'win32', sleep: async () => undefined,
    rename: async (source, target) => {
      const code = failures.shift()
      if (code) {
        assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { previous: true })
        throw Object.assign(new Error('temporarily locked'), { code })
      }
      await rename(source, target)
    },
  })
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { next: true })
  assert.deepEqual(await readdir(root), ['index.json'])
})

test('permanent replacement failure is bounded, preserves the target, and cleans its temporary file', async (t) => {
  const { root, file } = await fixture(t)
  const failure = Object.assign(new Error('permanently denied'), { code: 'EPERM' })
  let totalDelay = 0
  await assert.rejects(writeJsonAtomic(file, { next: true }, {
    platform: 'win32',
    sleep: async (ms) => { totalDelay += ms; assert.ok(totalDelay < 5_000, 'retry must remain bounded') },
    rename: async () => { throw failure },
  }), error => error === failure)
  assert.ok(totalDelay > 0)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { previous: true })
  assert.deepEqual(await readdir(root), ['index.json'])
})

test('unrelated errors and non-Windows errors fail immediately without destroying existing data', async (t) => {
  const { root, file } = await fixture(t)
  for (const [platform, code] of [['win32', 'ENOSPC'], ['darwin', 'EPERM']] as const) {
    const failure = Object.assign(new Error('cannot replace'), { code })
    await assert.rejects(writeJsonAtomic(file, { next: true }, {
      platform, sleep: async () => { assert.fail('must not retry this error') },
      rename: async () => { throw failure },
    }), error => error === failure)
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { previous: true })
    assert.deepEqual(await readdir(root), ['index.json'])
  }
})

test('Windows replacement waits for a real file handle that denies delete sharing', { skip: process.platform !== 'win32', timeout: 15_000 }, async (t) => {
  const { root, file } = await fixture(t)
  const locker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$f=[IO.File]::Open($env:MF_LOCK_TEST_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); try { [Console]::Out.WriteLine("LOCKED"); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }',
  ], { env: { ...process.env, MF_LOCK_TEST_FILE: file }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const closed = once(locker, 'close')
  let stderr = ''
  locker.stderr.on('data', chunk => { stderr += chunk })
  t.after(() => { if (locker.exitCode === null) locker.kill() })
  const [ready] = await Promise.race([
    once(locker.stdout, 'data'),
    closed.then(() => { throw new Error(`Lock helper exited before acquiring the file: ${stderr}`) }),
  ])
  assert.match(String(ready), /LOCKED/)
  const release = setTimeout(() => locker.stdin.end('\n'), 300)
  try {
    await writeJsonAtomic(file, { next: true })
  } finally {
    clearTimeout(release)
    if (!locker.stdin.writableEnded) locker.stdin.end('\n')
    await closed
  }
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { next: true })
  assert.deepEqual(await readdir(root), ['index.json'])
})
