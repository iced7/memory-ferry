const BLOCKED_ENV = new Set([
  'DSH_HOME',
  'MINIMAX_DATA_DIR',
  'MEMORY_FERRY_HOME',
  'MEMORY_FERRY_PATH',
  'AGENT_VAULT_HOME',
  'AGENT_VAULT_PATH',
  'CODEX_HOME',
  'npm_config_cache',
])

export const unavailableEmbedding = {
  env: { MEMORY_FERRY_EMBED: 'off' },
  embedder: {
    available: async () => false,
    embed: async () => {
      throw new Error('Embedding must not run in this test')
    },
  },
}

function isBlocked(name: string): boolean {
  return BLOCKED_ENV.has(name) || name.includes('agent-vault') || name.includes('memory-ferry') || name.includes('AGENT_VAULT') || name.includes('MEMORY_FERRY')
}

export function testEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  // Blocking names are stripped AFTER merging so that even explicitly passed
  // real-config env vars (e.g. DSH_HOME in the UI sentinel test) never reach
  // adapters. Tests that need to control Memory Ferry vars pass a direct env
  // object instead (e.g. unavailableEmbedding.env).
  const env = { ...process.env, ...overrides }
  for (const name of Object.keys(env)) {
    if (isBlocked(name)) delete env[name]
  }
  // UI/CLI tests must never probe or invoke a real local embedding service.
  env.MEMORY_FERRY_EMBED = 'off'
  return env
}
