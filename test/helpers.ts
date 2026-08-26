const BLOCKED_ENV = new Set([
  'DSH_HOME',
  'MINIMAX_DATA_DIR',
  'AGENT_VAULT_HOME',
  'AGENT_VAULT_PATH',
  'CODEX_HOME',
  'npm_config_cache',
])

function isBlocked(name: string): boolean {
  return BLOCKED_ENV.has(name) || name.includes('agent-vault') || name.includes('AGENT_VAULT')
}

export function testEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides }
  for (const name of Object.keys(env)) {
    if (isBlocked(name)) delete env[name]
  }
  return env
}
