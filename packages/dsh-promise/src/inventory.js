/**
 * Read-only snapshot for the Promise header panel. It joins the ledger (jobs,
 * delegations, assessments, trust) with the live team roster so the client can
 * render both Agent Teams members and subagents from one shape.
 * @module dsh-promise/inventory
 */
import { trustView } from './trust.js'
import { invokeHint } from './router.js'

/**
 * @param {object} input
 * @param {import('./engine.js').PromiseEngine} input.engine
 * @param {string} input.sessionId
 * @param {number} [input.now]
 * @param {(sessionId:string)=>object|undefined} [input.memberById] live team member lookup
 * @returns {object} snapshot
 */
export function buildSnapshot({ engine, sessionId, now = Date.now(), memberById }) {
  const state = engine.state
  const jobs = [...state.jobs.values()].filter((job) => job.sessionId === sessionId)
  // Index once: snapshot runs once per poll per mounted session, so rescanning
  // every promise/assessment for every job grows quadratically with the ledger.
  const promiseById = new Map([...state.promises.values()].map((promise) => [promise.id, promise]))
  const assessmentByJob = new Map()
  for (const assessment of state.assessments.values()) {
    const current = assessmentByJob.get(assessment.jobId)
    if (!current || String(assessment.createdAt) >= String(current.createdAt)) {
      assessmentByJob.set(assessment.jobId, assessment)
    }
  }
  const trustCache = new Map()
  const rows = new Map()
  const recent = []

  for (const job of jobs) {
    const promise = promiseById.get(job.promiseId)
    if (!promise) continue
    const trustKey = `${promise.agent}\u0000${promise.capability}`
    let view = trustCache.get(trustKey)
    if (view === undefined) {
      view = engine.trustFor(promise.agent, promise.capability)
      trustCache.set(trustKey, view)
    }
    const key = trustKey
    let row = rows.get(key)
    if (!row) {
      const hint = invokeHint(promise.agent)
      const member = memberById?.(job.delegation?.sessionId)
      row = {
        kind: hint.kind,
        name: hint.kind === 'team' ? hint.member : (hint.agentPreset ?? promise.agent),
        agent: promise.agent,
        capability: promise.capability,
        statement: promise.statement,
        trust: Number(view.score.toFixed(3)),
        lower: Number(view.lower.toFixed(3)),
        evidence: view.count,
        mass: Number(view.mass.toFixed(2)),
        status: promise.status,
        sessionId: job.delegation?.sessionId ?? null,
        live: member?.status ?? null,
        jobs: 0,
        lastVerdict: null,
        lastAt: null,
      }
      rows.set(key, row)
    }
    row.jobs += 1
    const assessment = assessmentByJob.get(job.id)
    if (assessment && (!row.lastAt || String(assessment.createdAt) > row.lastAt)) {
      row.lastAt = assessment.createdAt
      row.lastVerdict = assessment.verdict
    }
    if (assessment) {
      recent.push({
        jobId: job.id,
        agent: promise.agent,
        capability: promise.capability,
        verdict: assessment.verdict,
        level: assessment.level,
        confidence: Number((assessment.confidence ?? 0).toFixed(3)),
        at: assessment.createdAt,
      })
    }
  }

  recent.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  const list = [...rows.values()].sort((a, b) => b.trust - a.trust)
  const withEvidence = list.filter((row) => row.evidence > 0)
  const credit = withEvidence.length > 0
    ? withEvidence.reduce((sum, row) => sum + row.trust, 0) / withEvidence.length
    : 0.5
  const breaches = state.breaches.filter((breach) => jobs.some((job) => job.id === breach.jobId)).length

  return {
    sessionId,
    generatedAt: new Date(now).toISOString(),
    header: {
      promises: list.length,
      credit: Number(credit.toFixed(3)),
      breaches,
      assessed: withEvidence.length,
    },
    rows: list,
    recent: recent.slice(0, 5),
  }
}
