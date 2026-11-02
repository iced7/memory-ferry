import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFileAsync = promisify(execFile);
export async function verifyEncryption(command, prefix = []) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'memory-ferry-encryption-smoke-'));
  const vaultA = path.join(temporary, 'vault-a'), vaultB = path.join(temporary, 'vault-b');
  const stateA = path.join(temporary, 'state-a'), stateB = path.join(temporary, 'state-b');
  const envFor = state => ({ ...process.env, MEMORY_FERRY_HOME: state, MEMORY_FERRY_PATH: '', AGENT_VAULT_PATH: '', MEMORY_FERRY_EMBED: 'off' });
  const run = async (state, ...args) => (await execFileAsync(command, [...prefix, ...args], { env: envFor(state), windowsHide: true, timeout: 30_000 })).stdout;
  const sentinel = 'encrypted-CLI-MCP-portability-秘密-26391';
  try {
    const initialized = JSON.parse(await run(stateA, 'init', vaultA, '--encrypt', '--json'));
    assert.equal(initialized.privacy.encrypted, true);
    const saved = JSON.parse(await run(stateA, 'remember', sentinel, '--json'));
    await run(stateA, 'update', saved.id, '--content', `${sentinel}-updated`, '--json');
    assert.match(await run(stateA, 'recall', 'portability', '--no-semantic', '--json'), /26391-updated/);
    const history = JSON.parse(await run(stateA, 'history', saved.id, '--json'));
    await run(stateA, 'forget', saved.id, '--json');
    await run(stateA, 'restore', saved.id, history.at(-1).eventId, '--json');
    assert.match(await run(stateA, 'doctor', '--json'), /healthy/);
    const client = new Client({ name: 'encrypted-stdio-smoke', version: '1.0.0' });
    const transport = new StdioClientTransport({ command, args: [...prefix, 'mcp'], env: { ...getDefaultEnvironment(), MEMORY_FERRY_HOME: stateA, MEMORY_FERRY_EMBED: 'off' }, stderr: 'pipe' });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: 'memory_recall', arguments: { query: 'portability', semantic: false } });
      assert.ok(!result.isError);
      assert.ok(JSON.stringify(result.content).includes(sentinel));
    } finally { await client.close(); }
    await cp(vaultA, vaultB, { recursive: true });
    await assert.rejects(run(stateB, 'list', '--vault', vaultB, '--json'), error => /locked/.test(error.stderr));
    const keyB = path.join(temporary, 'device-b.key');
    await cp(initialized.privacy.keyFile, keyB); await chmod(keyB, 0o600);
    await run(stateB, 'vault', 'unlock', vaultB, '--key-file', keyB, '--json');
    assert.ok((await run(stateB, 'list', '--vault', vaultB, '--json')).includes(sentinel));
    await run(stateB, 'remember', 'second-device-sentinel', '--vault', vaultB, '--json');
    await cp(vaultB, vaultA, { recursive: true });
    assert.ok((await run(stateA, 'list', '--json')).includes('second-device-sentinel'));
    async function checkCiphertext(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await checkCiphertext(file);
        else assert.ok(!(await readFile(file, 'utf8')).includes(sentinel), 'Plaintext appeared in the synced Vault');
      }
    }
    await checkCiphertext(vaultA);
    await run(stateB, 'vault', 'lock', vaultB, '--json');
    await assert.rejects(run(stateB, 'list', '--vault', vaultB, '--json'), error => /locked/.test(error.stderr));
    console.log('Verified optional encrypted CLI, history/restore, MCP stdio, device-key import, sync, and locked access; no plaintext sentinel in synced files.');
  } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyEncryption(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url))]);
}
