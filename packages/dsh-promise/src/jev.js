/**
 * Minimal TypeSafe System One (Jev) client. Typed questions in, typed answers
 * out; no prompt parsing and no key ever written to a log or a ledger.
 * @module dsh-promise/jev
 */
import { setTimeout as delay } from 'node:timers/promises'

export class JevError extends Error {
  constructor(message, { status = 0, code = 'jev-error' } = {}) {
    super(message)
    this.name = 'JevError'
    this.status = status
    this.code = code
  }
}

export class JevOversizeError extends JevError {
  constructor(message = 'state exceeds the model context window') {
    super(message, { status: 400, code: 'oversize' })
    this.name = 'JevOversizeError'
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504])

export class JevClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl
   * @param {string} [options.apiKey]
   * @param {string} [options.model]
   * @param {number} [options.timeoutMs]
   * @param {typeof fetch} [options.fetchImpl]
   * @param {(level:string, message:string)=>void} [options.logger]
   */
  constructor(options) {
    // Values may be functions so volatile config edits apply without a remount.
    this.options = options
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.log = options.logger ?? (() => {})
  }

  #option(value, fallback) {
    const resolved = typeof value === 'function' ? value() : value
    return resolved ?? fallback
  }

  get baseUrl() {
    return this.#option(this.options.baseUrl, 'https://api.typesafe.ai/v1/systemone')
  }

  get apiKey() {
    return this.#option(this.options.apiKey, '')
  }

  get model() {
    return this.#option(this.options.model, 'jev-latest')
  }

  get configured() {
    return Boolean(this.apiKey)
  }

  /**
   * @param {unknown} state
   * @param {Record<string, object>} questions
   * @param {{signal?: AbortSignal}} [options]
   */
  async ask(state, questions, options = {}) {
    if (!this.configured) throw new JevError('no API key configured', { code: 'not-configured' })
    const body = JSON.stringify({ model: this.model, state, questions })
    let lastError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.#request(body, options.signal)
      } catch (error) {
        lastError = error
        if (!(error instanceof JevError) || !RETRYABLE.has(error.status)) throw error
        await delay(250 * (attempt + 1))
      }
    }
    throw lastError
  }

  async #request(body, externalSignal) {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout
    let response
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
        signal,
      })
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new JevError('jev request timed out', { code: 'timeout' })
      }
      throw new JevError(`jev request failed: ${error?.message ?? 'network error'}`, { code: 'network' })
    }

    const text = await response.text().catch(() => '')
    let data
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = {}
    }

    if (!response.ok) {
      const detail = data?.detail
      const errorType = typeof detail === 'object' ? detail?.error_type : undefined
      if (errorType === 'max_tokens_exceeded') throw new JevOversizeError()
      if (response.status === 401) throw new JevError('jev authentication failed', { status: 401, code: 'auth' })
      if (response.status === 451) {
        throw new JevError('TypeSafe returned 451: not available in this region; Jev needs a working proxy', { status: 451, code: 'region-blocked' })
      }
      const message = typeof detail === 'object' ? detail?.message : typeof detail === 'string' ? detail : `http ${response.status}`
      throw new JevError(`jev error: ${message}`, { status: response.status, code: errorType ?? 'http-error' })
    }

    if (!data || typeof data !== 'object' || !data.answers || typeof data.answers !== 'object') {
      throw new JevError('jev returned an invalid payload', { code: 'invalid-response' })
    }
    return { model: data.model, answers: data.answers, usage: data.usage ?? null }
  }
}
