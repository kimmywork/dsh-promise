/**
 * Small pure helpers shared by the promise engine: canonical JSON, hashing,
 * identifiers, glob matching, truncation and redaction.
 * @module dsh-promise/util
 */
import { createHash, randomUUID } from 'node:crypto'

/** Recursively sort object keys so two equal values hash identically. */
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue
      out[key] = sortValue(value[key])
    }
    return out
  }
  return value
}

/** Deterministic JSON used by the ledger hash chain. */
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value))
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function newId(prefix = 'id') {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`
}

export function clamp01(n) {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

export function nowIso(at = Date.now()) {
  return new Date(at).toISOString()
}

export function parseMs(iso, fallback = Date.now()) {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : fallback
}

/**
 * Convert a glob (`*`, `**`, `?`) into an anchored RegExp. `**\/` matches zero
 * or more directories, so `**\/*.ts` also matches a root-level `a.ts`.
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
      continue
    }
    if (c === '?') {
      re += '[^/]'
      continue
    }
    if ('\\^$+.|()[]{}'.includes(c)) {
      re += `\\${c}`
      continue
    }
    re += c
  }
  return new RegExp(`^${re}$`)
}

export function matchGlobs(path, globs) {
  const normalized = String(path).replaceAll('\\', '/')
  return globs.some((glob) => globToRegExp(glob).test(normalized))
}

/** Trim text to a UTF-8 byte budget, keeping the middle marker explicit. */
export function truncateMiddle(text, maxBytes) {
  const value = String(text ?? '')
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const marker = '\n…[truncated]…\n'
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'))
  const headBudget = Math.floor(budget * 0.6)
  const tailBudget = budget - headBudget
  let head = ''
  let used = 0
  for (const ch of value) {
    const size = Buffer.byteLength(ch, 'utf8')
    if (used + size > headBudget) break
    head += ch
    used += size
  }
  let tail = ''
  used = 0
  const chars = [...value]
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const ch = chars[i]
    const size = Buffer.byteLength(ch, 'utf8')
    if (used + size > tailBudget) break
    tail = ch + tail
    used += size
  }
  return `${head}${marker}${tail}`
}

/** Replace configured secret patterns with a stable marker. */
export function redact(text, patterns = []) {
  let value = String(text ?? '')
  for (const pattern of patterns) {
    try {
      value = value.replace(new RegExp(pattern, 'g'), '[REDACTED]')
    } catch {
      // A bad operator-supplied pattern must never break assessment.
    }
  }
  return value
}

export function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'x'
}

/** Extract visible text from harness content blocks. */
export function blocksToText(content, maxBytes = 8192) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return truncateMiddle(parts.join('\n'), maxBytes)
}
