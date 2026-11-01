import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { StateStore } from '../src/state.js'
import { Vault } from '../src/vault.js'
import { testEnv, unavailableEmbedding } from './helpers.js'

const execFileAsync = promisify(execFile)

test('recall and context accept --no-semantic', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-vault-cli-test-'))
  const stateHome = path.join(root, 'state')
  const vault = await Vault.init(path.join(root, 'vault'), 'CLI Test', new StateStore(stateHome), unavailableEmbedding)
  await vault.remember({ content: 'alpha command memory' })
  const env = {
    ...testEnv(),
    MEMORY_FERRY_HOME: stateHome,
    MEMORY_FERRY_EMBED: 'off',
  }
  const base = ['--import', 'tsx', 'src/cli.ts']

  const recall = await execFileAsync(process.execPath, [...base, 'recall', 'alpha', '--no-semantic', '--vault', vault.root, '--json'], { env })
  assert.match(recall.stdout, /alpha command memory/)
  const context = await execFileAsync(process.execPath, [...base, 'context', 'alpha', '--no-semantic', '--vault', vault.root], { env })
  assert.match(context.stdout, /alpha command memory/)
  const skills = await execFileAsync(process.execPath, [...base, 'skills', 'inspect', '--vault', vault.root, '--json'], { env })
  assert.match(skills.stdout, /"memory-ferry-memory"/)
  assert.match(skills.stdout, /"valid": true/)
})

test('shows English and Chinese help for the Memory Ferry CLI', async () => {
  const base = ['--import', 'tsx', 'src/cli.ts', '--help']
  const english = await execFileAsync(process.execPath, [...base, '--lang', 'en'], { env: testEnv() })
  assert.match(english.stdout, /Memory Ferry 1\.0\.0/)
  assert.match(english.stdout, /Cross-device|Local-first/)
  const chinese = await execFileAsync(process.execPath, [...base, '--lang', 'zh-CN'], { env: testEnv() })
  assert.match(chinese.stdout, /Memory Ferry · 记忆摆渡/)
  assert.match(chinese.stdout, /跨设备/)
})

test('doctor returns a machine-readable warning status and CLI reads announce partial results', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'memory-ferry-doctor-'));
  const state = new StateStore(path.join(root,'state'));
  const vault = await Vault.init(path.join(root,'vault'),'Doctor',state,unavailableEmbedding);
  await vault.remember({content:'Valid record'});
  await writeFile(path.join(vault.eventsPath,'broken.json'),'{');
  const env={...testEnv(),MEMORY_FERRY_HOME:state.home,MEMORY_FERRY_EMBED:'off'};
  const base=['--import','tsx','src/cli.ts'];
  await assert.rejects(execFileAsync(process.execPath,[...base,'doctor','--json'],{env}), (error:any)=>{
    assert.equal(error.code,2);
    assert.equal(JSON.parse(error.stdout).invalidEvents,1);
    return true;
  });
  const list = await execFileAsync(process.execPath,[...base,'list','--json'],{env});
  assert.equal(JSON.parse(list.stdout).length,1);
  assert.match(list.stderr,/results may be incomplete/);
});
