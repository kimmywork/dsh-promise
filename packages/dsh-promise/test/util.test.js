import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalJson, globToRegExp, matchGlobs, redact, sha256, truncateMiddle } from '../src/util.js'

test('canonicalJson sorts keys recursively', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }), canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }))
})

test('sha256 is stable and hex', () => {
  assert.equal(sha256('x'), sha256('x'))
  assert.match(sha256('x'), /^[0-9a-f]{64}$/)
})

test('glob **/ matches zero directories', () => {
  assert.ok(globToRegExp('**/*.ts').test('a.ts'))
  assert.ok(globToRegExp('**/*.ts').test('src/a/b.ts'))
  assert.ok(!globToRegExp('src/*.js').test('src/a/b.js'))
  assert.ok(globToRegExp('src/**').test('src/a/b.js'))
})

test('matchGlobs ignores slashes on windows style paths', () => {
  assert.ok(matchGlobs('src\\a.js', ['src/**']))
  assert.ok(!matchGlobs('other/a.js', ['src/**']))
})

test('truncateMiddle respects the byte budget', () => {
  const text = 'a'.repeat(500) + '中'.repeat(500)
  const out = truncateMiddle(text, 200)
  assert.ok(Buffer.byteLength(out, 'utf8') <= 200)
  assert.match(out, /truncated/)
})

test('redact removes configured secrets', () => {
  const out = redact('token sk-abcdefghijklmnop123 ok', ['sk-[A-Za-z0-9]{16,}'])
  assert.ok(!out.includes('sk-abcdefghijklmnop123'))
  assert.ok(out.includes('[REDACTED]'))
})

test('redact ignores an invalid pattern', () => {
  assert.equal(redact('abc', ['(']), 'abc')
})
