import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scrypt,
} from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { MemoryRecord, VaultEncryption } from './types.js'
import { pathExists, stableId } from './utils.js'

export const LOCKED_VAULT_MESSAGE = 'Vault is encrypted and not unlocked on this machine. Run: agent-vault unlock <path> --passphrase ...'

export const DEFAULT_ENCRYPTION: Omit<VaultEncryption, 'salt'> = {
  algo: 'chacha20-poly1305',
  kdf: 'scrypt',
  N: 16_384,
  r: 8,
  p: 1,
}

export function createEncryptionConfig(
  algo: VaultEncryption['algo'] = DEFAULT_ENCRYPTION.algo,
): VaultEncryption {
  return {
    ...DEFAULT_ENCRYPTION,
    algo,
    salt: randomBytes(16).toString('base64'),
  }
}

export function validateEncryptionConfig(value: VaultEncryption): void {
  if (
    !value
    || !['chacha20-poly1305', 'aes-256-gcm'].includes(value.algo)
    || value.kdf !== 'scrypt'
    || typeof value.salt !== 'string'
    || !value.salt
    || !Number.isInteger(value.N)
    || value.N < 2
    || value.N > 1_048_576
    || (value.N & (value.N - 1)) !== 0
    || !Number.isInteger(value.r)
    || value.r < 1
    || value.r > 32
    || !Number.isInteger(value.p)
    || value.p < 1
    || value.p > 16
  ) {
    throw new Error('Unsupported vault encryption configuration.')
  }
}

export async function deriveEncryptionKey(
  passphrase: string,
  encryption: VaultEncryption,
): Promise<Buffer> {
  validateEncryptionConfig(encryption)
  if (!passphrase) throw new Error('Passphrase cannot be empty.')
  const salt = Buffer.from(encryption.salt, 'base64')
  if (!salt.length) throw new Error('Unsupported vault encryption configuration.')
  const minimumMemory = 128 * encryption.N * encryption.r
  return await new Promise<Buffer>((resolve, reject) => {
    scrypt(passphrase, salt, 32, {
      N: encryption.N,
      r: encryption.r,
      p: encryption.p,
      maxmem: Math.max(32 * 1024 * 1024, minimumMemory + 16 * 1024 * 1024),
    }, (error, key) => {
      if (error) reject(error)
      else resolve(key as Buffer)
    })
  })
}

export function encryptRecord(
  record: MemoryRecord,
  key: Buffer,
  algo: VaultEncryption['algo'],
): string {
  const iv = randomBytes(12)
  const cipher = algo === 'chacha20-poly1305'
    ? createCipheriv('chacha20-poly1305', key, iv, { authTagLength: 16 })
    : createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(record), 'utf8'),
    cipher.final(),
  ])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
}

export function decryptRecord(
  ciphertext: string,
  key: Buffer,
  algo: VaultEncryption['algo'],
): MemoryRecord {
  const payload = Buffer.from(ciphertext, 'base64')
  if (payload.length < 29) throw new Error('Encrypted memory event has an invalid ciphertext.')
  const iv = payload.subarray(0, 12)
  const authTag = payload.subarray(12, 28)
  const encrypted = payload.subarray(28)
  const decipher = algo === 'chacha20-poly1305'
    ? createDecipheriv('chacha20-poly1305', key, iv, { authTagLength: 16 })
    : createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()])
  return JSON.parse(plaintext.toString('utf8')) as MemoryRecord
}

export function keyringPath(stateHome: string, vaultRoot: string): string {
  return path.join(stateHome, 'keys', `${stableId(path.resolve(vaultRoot))}.key`)
}

export async function readKey(keyFile: string): Promise<Buffer> {
  let encoded: string
  try {
    encoded = (await readFile(keyFile, 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(LOCKED_VAULT_MESSAGE)
    throw error
  }
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error(LOCKED_VAULT_MESSAGE)
  return key
}

export async function writeKey(keyFile: string, key: Buffer): Promise<void> {
  await mkdir(path.dirname(keyFile), { recursive: true })
  const pending = `${keyFile}.pending-${process.pid}-${randomUUID()}`
  try {
    await writeFile(pending, `${key.toString('base64')}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(pending, 0o600)
    await rename(pending, keyFile)
  } catch (error) {
    await rm(pending, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function removeKey(keyFile: string): Promise<boolean> {
  if (!(await pathExists(keyFile))) return false
  await rm(keyFile)
  return true
}
