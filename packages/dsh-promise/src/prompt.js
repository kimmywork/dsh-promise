/**
 * Static model-facing protocol section. It is intentionally dynamic-free (it
 * never embeds trust numbers) so the prompt prefix stays cacheable, and it
 * renders to an empty string until at least one promise exists.
 * @module dsh-promise/prompt
 */
export const PROTOCOL_TEXT = `## Promise protocol

This deployment tracks delegation as promises. A promise is a falsifiable quality
commitment from one agent (a preset, a tool, or a composition) about one capability.

- Before delegating substantive work, call \`promise_select\` with the capability,
  the need, and a risk tier. It returns a ranked shortlist backed by recorded
  evidence and a job id. Prefer the recommended agent; if you override it, say so.
- After the work finishes, call \`promise_settle\` with the job id, the outcome and
  the produced output. Settlement evaluates the promise, records evidence, and
  updates trust. Never report an agent as reliable without ledger evidence.
- Do not settle work you did not do, and do not claim a promise was met because
  tests passed if the change does not implement the request.
- Assessment levels are chosen by policy, not by you: L0 record only, L1 rules and
  executable checks, L2 sampled semantic assessment, L3 full assessment. A
  violated promise can put an agent on probation; a suspended promise is not
  eligible for routing.
- Use \`promise_inspect\` to read trust, promises, breaches and the ledger. A trust
  number is only meaningful with its evidence mass and assessor.`
