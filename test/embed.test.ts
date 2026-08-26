import assert from 'node:assert/strict'
import test from 'node:test'
import { cosineSimilarity, embedText, embedderAvailable, type FetchFunction } from '../src/embed.js'

test('computes cosine similarity for identical and orthogonal vectors', () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1)
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
})

test('probes the configured Ollama host without using the real network', async () => {
  const calls: string[] = []
  const fetchFunction: FetchFunction = async (input) => {
    calls.push(String(input))
    return new Response('{}', { status: 200 })
  }

  assert.equal(await embedderAvailable({ OLLAMA_HOST: 'http://ollama.test/' }, fetchFunction), true)
  assert.deepEqual(calls, ['http://ollama.test/api/tags'])

  let called = false
  assert.equal(await embedderAvailable({ AGENT_VAULT_EMBED: 'off' }, async () => {
    called = true
    return new Response('{}')
  }), false)
  assert.equal(called, false)

  assert.equal(await embedderAvailable({}, async () => {
    throw new Error('offline')
  }), false)
})

test('embeds text and falls back to the legacy Ollama endpoint on 404', async () => {
  const calls: Array<{ url: string; body: Record<string, string> }> = []
  const fetchFunction: FetchFunction = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, string> })
    if (String(input).endsWith('/api/embed')) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify({ embedding: [0.25, 0.75] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  assert.deepEqual(await embedText('remember this', 'test-model', { OLLAMA_HOST: 'http://ollama.test' }, fetchFunction), [0.25, 0.75])
  assert.deepEqual(calls, [
    { url: 'http://ollama.test/api/embed', body: { model: 'test-model', input: 'remember this' } },
    { url: 'http://ollama.test/api/embeddings', body: { model: 'test-model', prompt: 'remember this' } },
  ])
})

test('uses the model from the injected environment when no model is passed', async () => {
  const fetchFunction: FetchFunction = async (_input, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { model: 'environment-model', input: 'text' })
    return new Response(JSON.stringify({ embeddings: [[1, 0]] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  assert.deepEqual(await embedText('text', undefined, { AGENT_VAULT_EMBED_MODEL: 'environment-model' }, fetchFunction), [1, 0])
})
