import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { VaultManifest } from './types.js'
import { readJson, writeJsonAtomic } from './utils.js'

export interface SealedJson { format: 'memory-ferry-aes-256-gcm'; version: 1; iv: string; tag: string; data: string }
export interface EncryptionManifest { algorithm: 'AES-256-GCM'; keyId: string; verifier: SealedJson }
export interface JsonCodec { encode(value: unknown, purpose: string): unknown; decode(value: unknown, purpose: string): unknown }

function bytes(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid encrypted data encoding.')
  const result = Buffer.from(value, 'base64')
  if (result.toString('base64') !== value || (length !== undefined && result.length !== length)) throw new Error('Invalid encrypted data length.')
  return result
}

export function seal(value: unknown, key: Buffer, aad: string): SealedJson {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return { format: 'memory-ferry-aes-256-gcm', version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

export function unseal(value: unknown, key: Buffer, aad: string): unknown {
  try {
    const envelope = value as SealedJson
    if (envelope?.format !== 'memory-ferry-aes-256-gcm' || envelope.version !== 1) throw new Error('Invalid envelope')
    const decipher = createDecipheriv('aes-256-gcm', key, bytes(envelope.iv, 12), { authTagLength: 16 })
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(bytes(envelope.tag, 16))
    return JSON.parse(Buffer.concat([decipher.update(bytes(envelope.data)), decipher.final()]).toString('utf8'))
  } catch {
    throw new Error('Encrypted data authentication failed. Check the key and synchronized files; no plaintext fallback is allowed.')
  }
}

export function validateEncryption(value: EncryptionManifest | undefined): asserts value is EncryptionManifest {
  if (!value || value.algorithm !== 'AES-256-GCM' || !/^[0-9a-f-]{36}$/.test(value.keyId)) throw new Error('Unsupported memory encryption format.')
}

function aad(manifest: VaultManifest, purpose: string): string {
  return JSON.stringify(['memory-ferry', 2, manifest.vaultId, manifest.encryption!.keyId, purpose])
}

async function canonical(candidate: string): Promise<string> {
  try { return await realpath(candidate) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = path.dirname(candidate)
    if (parent === candidate) throw error
    return path.join(await canonical(parent), path.basename(candidate))
  }
}

export async function requireOutsideVault(root: string, candidate: string): Promise<void> {
  const relative = path.relative(await canonical(path.resolve(root)), await canonical(path.resolve(candidate)))
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Encryption keys and local state must be outside the synchronized Vault. Choose a private local directory.')
  }
}

export async function createEncryption(manifest: VaultManifest, root: string, keyFile: string): Promise<EncryptionManifest> {
  await requireOutsideVault(root, keyFile)
  const key = randomBytes(32)
  const keyId = randomUUID()
  const encrypted = { ...manifest, encryption: { algorithm: 'AES-256-GCM', keyId } } as VaultManifest
  const verifier = seal({ check: 'memory-ferry-key-check' }, key, aad(encrypted, 'key-check'))
  await mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 })
  try {
    await writeFile(keyFile, JSON.stringify({ format: 'memory-ferry-key', version: 1, vaultId: manifest.vaultId, keyId, key: key.toString('base64') }) + '\n', { flag: 'wx', mode: 0o600 })
  } finally { key.fill(0) }
  return { algorithm: 'AES-256-GCM', keyId, verifier }
}

export async function openEncryption(manifest: VaultManifest, root: string, keyFile?: string): Promise<JsonCodec> {
  validateEncryption(manifest.encryption)
  if (!keyFile) throw new Error('Encrypted Vault is locked on this device. Import its key with: memory-ferry vault unlock <folder> --key-file <private-local-file>.')
  await requireOutsideVault(root, keyFile)
  const info = await stat(keyFile)
  if (!info.isFile() || info.size > 4096) throw new Error('Invalid encryption key file.')
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('Encryption key file must be private (chmod 600).')
  let material
  try { material = JSON.parse(await readFile(keyFile, 'utf8')) }
  catch { throw new Error('Unable to read a valid encryption key file.') }
  if (material?.format !== 'memory-ferry-key' || material.version !== 1 || material.vaultId !== manifest.vaultId || material.keyId !== manifest.encryption.keyId) throw new Error('This key file belongs to another Vault.')
  const key = bytes(material.key, 32)
  const check = unseal(manifest.encryption.verifier, key, aad(manifest, 'key-check')) as { check?: string }
  if (check?.check !== 'memory-ferry-key-check') throw new Error('Invalid encryption key verification.')
  return { encode: (value, purpose) => seal(value, key, aad(manifest, purpose)), decode: (value, purpose) => unseal(value, key, aad(manifest, purpose)) }
}

export async function readProtectedJson<T>(file: string, codec?: JsonCodec, purpose = path.basename(file)): Promise<T> {
  const value = await readJson<unknown>(file)
  return (codec ? codec.decode(value, purpose) : value) as T
}

export async function writeProtectedJson(file: string, value: unknown, codec?: JsonCodec, purpose = path.basename(file)): Promise<void> {
  await writeJsonAtomic(file, codec ? codec.encode(value, purpose) : value)
}
