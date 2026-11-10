/**
 * Append-only, hash-chained JSONL ledger. Every promise, job, assessment and
 * breach is an event; the trust table is a fold of assessment evidence, so a
 * full replay reproduces the same scores deterministically.
 * @module dsh-promise/ledger
 */
import fs from 'node:fs'
import path from 'node:path'
import { canonicalJson, nowIso, sha256 } from './util.js'
import { applyEvidence, recordKey } from './trust.js'

const GENESIS = 'genesis'

export class LedgerReadOnlyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LedgerReadOnlyError'
  }
}

function emptyState() {
  return {
    promises: new Map(),
    jobs: new Map(),
    assessments: new Map(),
    trust: new Map(),
    compositions: new Map(),
    breaches: [],
    counters: { jobs: 0, assessments: 0, observations: 0, accepted: 0, declined: 0 },
  }
}

export class Ledger {
  /**
   * @param {object} options
   * @param {string} options.dir
   * @param {number} [options.snapshotEvery]
   * @param {number} [options.prior]
   * @param {number} [options.halfLifeDays]
   * @param {(level:string, message:string)=>void} [options.logger]
   */
  constructor(options) {
    this.dir = options.dir
    this.snapshotEvery = Math.max(1, options.snapshotEvery ?? 200)
    this.prior = options.prior ?? 0.5
    this.halfLifeDays = options.halfLifeDays ?? 14
    this.log = options.logger ?? (() => {})
    this.file = path.join(this.dir, 'ledger.jsonl')
    this.snapshotFile = path.join(this.dir, 'snapshot.json')
    this.state = emptyState()
    this.lastSeq = -1
    this.lastHash = GENESIS
    this.readonly = false
    this.readonlyReason = null
  }

  open() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const snapshot = this.#readSnapshot()
    if (snapshot) {
      this.#hydrate(snapshot)
      this.lastSeq = snapshot.seq
      this.lastHash = snapshot.hash
    }
    this.#replayTail()
    return this
  }

  #readSnapshot() {
    if (!fs.existsSync(this.snapshotFile)) return null
    try {
      const parsed = JSON.parse(fs.readFileSync(this.snapshotFile, 'utf8'))
      if (!parsed || parsed.version !== 1 || !parsed.state) throw new Error('unsupported snapshot format')
      return parsed
    } catch (error) {
      this.#degrade(`snapshot unreadable: ${error.message}`)
      return null
    }
  }

  #hydrate(snapshot) {
    const state = snapshot.state
    this.state.promises = new Map((state.promises ?? []).map((record) => [record.id, record]))
    this.state.jobs = new Map((state.jobs ?? []).map((record) => [record.id, record]))
    this.state.assessments = new Map((state.assessments ?? []).map((record) => [record.id, record]))
    this.state.trust = new Map(state.trust ?? [])
    this.state.compositions = new Map((state.compositions ?? []).map((record) => [record.id, record]))
    this.state.breaches = state.breaches ?? []
    this.state.counters = { ...emptyState().counters, ...(state.counters ?? {}) }
  }

  #replayTail() {
    if (!fs.existsSync(this.file)) return
    const lines = fs.readFileSync(this.file, 'utf8').split('\n')
    for (const line of lines) {
      if (line.trim() === '') continue
      let event
      try {
        event = JSON.parse(line)
      } catch (error) {
        this.#degrade(`ledger line is not JSON: ${error.message}`)
        return
      }
      if (event.seq <= this.lastSeq) continue
      if (event.seq !== this.lastSeq + 1) {
        this.#degrade(`ledger sequence gap at ${event.seq}, expected ${this.lastSeq + 1}`)
        return
      }
      if (event.prevHash !== this.lastHash) {
        this.#degrade(`ledger chain break at ${event.seq}`)
        return
      }
      if (event.hash !== this.#hashEvent(event)) {
        this.#degrade(`ledger hash mismatch at ${event.seq}`)
        return
      }
      this.#apply(event)
      this.lastSeq = event.seq
      this.lastHash = event.hash
    }
  }

  #degrade(reason) {
    this.readonly = true
    this.readonlyReason = reason
    this.log('warn', `promise ledger is read-only: ${reason}`)
  }

  #hashEvent(event) {
    return sha256(`${event.prevHash}\n${canonicalJson({ seq: event.seq, at: event.at, type: event.type, payload: event.payload })}`)
  }

  /**
   * Append one event, persist it, and fold it into state.
   * @param {string} type
   * @param {object} payload
   */
  append(type, payload) {
    if (this.readonly) throw new LedgerReadOnlyError(`read-only: ${this.readonlyReason ?? 'ledger is read-only'}`)
    const seq = this.lastSeq + 1
    const at = nowIso()
    const event = { seq, at, type, payload, prevHash: this.lastHash }
    event.hash = this.#hashEvent(event)
    fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
    this.#apply(event)
    this.lastSeq = seq
    this.lastHash = event.hash
    if ((seq + 1) % this.snapshotEvery === 0) this.snapshot()
    return event
  }

  #apply(event) {
    const payload = event.payload ?? {}
    switch (event.type) {
      case 'promise/declared':
      case 'promise/updated': {
        if (payload.promise?.id) this.state.promises.set(payload.promise.id, payload.promise)
        break
      }
      case 'job/opened': {
        if (payload.job?.id) {
          this.state.jobs.set(payload.job.id, payload.job)
          this.state.counters.jobs += 1
        }
        break
      }
      case 'job/policy': {
        const job = this.state.jobs.get(payload.jobId)
        if (job && payload.policy) job.policy = payload.policy
        break
      }
      case 'job/linked': {
        const job = this.state.jobs.get(payload.jobId)
        if (job && payload.delegation) job.delegation = payload.delegation
        if (job && payload.policy) job.policy = payload.policy
        break
      }
      case 'job/closed': {
        const job = this.state.jobs.get(payload.jobId)
        if (job) {
          Object.assign(job, {
            closedAt: payload.closedAt ?? event.at,
            outcome: payload.outcome ?? job.outcome,
            latencyMs: payload.latencyMs ?? job.latencyMs,
            outputRef: payload.outputRef ?? job.outputRef,
            closedBy: payload.closedBy ?? 'settle',
            verdict: payload.verdict ?? job.verdict,
            assessmentId: payload.assessmentId ?? job.assessmentId,
          })
        }
        break
      }
      case 'assessment/recorded': {
        if (payload.assessment?.id) {
          this.state.assessments.set(payload.assessment.id, payload.assessment)
          this.state.counters.assessments += 1
        }
        for (const item of payload.evidence ?? []) {
          if (!item?.agent || !item?.capability || !item?.assessor) continue
          const policyId = item.policyId ?? payload.assessment?.policy?.id ?? 'legacy'
          const key = recordKey(item.agent, item.capability, item.assessor, policyId)
          const record = applyEvidence(
            this.state.trust.get(key),
            { score: item.score, weight: item.weight, at: item.at },
            { prior: this.prior, halfLifeDays: this.halfLifeDays },
          )
          this.state.trust.set(key, record)
        }
        break
      }
      case 'breach': {
        this.state.breaches.push({ ...payload, at: event.at })
        break
      }
      case 'composition/declared': {
        if (payload.composition?.id) this.state.compositions.set(payload.composition.id, payload.composition)
        break
      }
      case 'observation/unattributed': {
        this.state.counters.observations += 1
        break
      }
      case 'promise/accepted': {
        this.state.counters.accepted += 1
        break
      }
      case 'promise/declined': {
        this.state.counters.declined += 1
        break
      }
      default:
        break
    }
  }

  snapshot() {
    if (this.readonly) return
    const payload = {
      version: 1,
      seq: this.lastSeq,
      hash: this.lastHash,
      at: nowIso(),
      state: {
        promises: [...this.state.promises.values()],
        jobs: [...this.state.jobs.values()],
        assessments: [...this.state.assessments.values()],
        trust: [...this.state.trust.entries()],
        compositions: [...this.state.compositions.values()],
        breaches: this.state.breaches,
        counters: this.state.counters,
      },
    }
    const tmp = `${this.snapshotFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, this.snapshotFile)
  }

  /** Verify the whole file's chain from the beginning (used by tests and inspect). */
  verifyChain() {
    if (!fs.existsSync(this.file)) return { ok: true, events: 0 }
    let expectedSeq = 0
    let prevHash = GENESIS
    const lines = fs.readFileSync(this.file, 'utf8').split('\n')
    let events = 0
    for (const line of lines) {
      if (line.trim() === '') continue
      const event = JSON.parse(line)
      if (event.seq !== expectedSeq) return { ok: false, reason: `seq ${event.seq}, expected ${expectedSeq}`, events }
      if (event.prevHash !== prevHash) return { ok: false, reason: `prevHash mismatch at ${event.seq}`, events }
      if (event.hash !== this.#hashEvent(event)) return { ok: false, reason: `hash mismatch at ${event.seq}`, events }
      prevHash = event.hash
      expectedSeq += 1
      events += 1
    }
    return { ok: true, events }
  }
}
