import test from 'node:test'
import assert from 'node:assert/strict'
import { JevClient, JevError, JevOversizeError } from '../src/jev.js'

function clientWith(fetchImpl) {
  return new JevClient({
    baseUrl: 'https://example.test/v1/systemone',
    apiKey: 'test-key',
    model: 'jev-test',
    timeoutMs: 5_000,
    fetchImpl,
    logger: () => {},
  })
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('sends the typed request with bearer auth and returns answers', async () => {
  let captured
  const client = clientWith(async (url, init) => {
    captured = { url, init }
    return jsonResponse({ model: 'jev-1.14.0', answers: { q: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 1 } })
  })
  const result = await client.ask({ a: 1 }, { q: { type: 'noul', instructions: 'x' } })
  assert.equal(result.model, 'jev-1.14.0')
  assert.equal(result.answers.q.noul, 0.9)
  assert.equal(captured.url, 'https://example.test/v1/systemone')
  assert.equal(captured.init.headers.Authorization, 'Bearer test-key')
  const body = JSON.parse(captured.init.body)
  assert.equal(body.model, 'jev-test')
  assert.deepEqual(body.state, { a: 1 })
})

test('maps authentication failures', async () => {
  const client = clientWith(async () => jsonResponse({ detail: { error_type: 'authentication_error' } }, 401))
  await assert.rejects(() => client.ask({}, { q: { type: 'noul' } }), (error) => error instanceof JevError && error.code === 'auth')
})

test('maps an oversized state to a dedicated error', async () => {
  const client = clientWith(async () => jsonResponse({ detail: { error_type: 'max_tokens_exceeded' } }, 400))
  await assert.rejects(() => client.ask({}, { q: { type: 'noul' } }), (error) => error instanceof JevOversizeError)
})

test('retries once on a 500 then succeeds', async () => {
  let calls = 0
  const client = clientWith(async () => {
    calls += 1
    if (calls === 1) return jsonResponse({ detail: { error_type: 'server_error' } }, 500)
    return jsonResponse({ model: 'm', answers: { q: { type: 'noul', noul: 0.5 } } })
  })
  const result = await client.ask({}, { q: { type: 'noul' } })
  assert.equal(calls, 2)
  assert.equal(result.answers.q.noul, 0.5)
})

test('rejects an invalid payload', async () => {
  const client = clientWith(async () => jsonResponse({ nope: true }))
  await assert.rejects(() => client.ask({}, { q: { type: 'noul' } }), /invalid payload/)
})

test('an unconfigured client refuses to call', async () => {
  const client = new JevClient({ baseUrl: 'https://example.test', apiKey: '', model: 'm', fetchImpl: async () => jsonResponse({}) })
  assert.equal(client.configured, false)
  await assert.rejects(() => client.ask({}, { q: { type: 'noul' } }), /no API key/)
})
