import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * The client half is a hand-written DSH Client module, not an ESM library: it
 * registers a factory on `window.__ModuleLoader__`. Executing that factory is
 * the exact step the browser performs at boot, so these tests catch the class of
 * bug that took DSH down (a factory-scope ReferenceError) before packaging.
 */
let clientRevision = 0

async function loadClientModule() {
  let registration
  globalThis.window = {
    __ModuleLoader__: {
      load(module) {
        registration = module
      },
    },
  }
  clientRevision += 1
  await import(`../lib/client.js?test=${clientRevision}`)
  assert.ok(registration, 'client.js registered no module')
  assert.equal(registration.id, 'dsh-promise')

  const react = {
    createElement: (...args) => ({ args }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
  }
  const exports = registration.factory((specifier) => {
    if (specifier === 'react') return react
    throw new Error(`unexpected require: ${specifier}`)
  })
  return exports
}

function fakeContext({ mount } = {}) {
  const slots = []
  const injections = []
  const ctx = {
    effects: [],
    effect(fn, label) {
      ctx.effects.push(label)
      return fn()
    },
    locale: {
      register() {},
      bind: () => (key) => key,
    },
    slots: {
      inject(name, register) {
        slots.push({ name, register })
      },
      register(definition, component) {
        return { definition, component }
      },
    },
    inject(deps, callback) {
      injections.push({ deps, callback })
    },
    remote: {
      $mount: mount ?? (async () => () => {}),
    },
  }
  return { ctx, slots, injections }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('the client factory materializes and exports the plugin contract', async () => {
  const exports = await loadClientModule()
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'locale'])
})

test('apply registers the config row and defers the credit panel to the Remote face', async () => {
  const exports = await loadClientModule()
  const { ctx, slots, injections } = fakeContext()

  exports.apply(ctx)

  assert.ok(slots.some((entry) => entry.name === 'plugins.row.config'))
  assert.equal(injections.length, 1)
  assert.deepEqual(injections[0].deps, ['remote'])
})

test('a mounted snapshot Remote registers the header action with the session id', async () => {
  const exports = await loadClientModule()
  let contribution
  const { ctx, slots, injections } = fakeContext({
    mount: async (value) => {
      contribution = value
      return () => {}
    },
  })

  exports.apply(ctx)
  injections[0].callback(ctx)
  await flush()

  // The hand-written descriptor has to satisfy the Typert registry contract that
  // a generated artifact would: id, service binding, namespace/method, and a
  // strict codec (mode + typeSymbol + create) on every parameter and the result.
  assert.equal(contribution.package, 'dsh-promise')
  const descriptor = contribution.descriptors[0]
  assert.equal(descriptor.id, 'dsh-promise#promiseInventory/snapshot')
  assert.equal(descriptor.service, 'promiseInventory')
  assert.equal(descriptor.namespace, 'promiseInventory')
  assert.equal(descriptor.method, 'snapshot')
  assert.equal(descriptor.invocation.kind, 'direct')
  for (const codec of [descriptor.parameters[0].codec, descriptor.result]) {
    assert.equal(codec.mode, 'strict')
    assert.equal(typeof codec.typeSymbol, 'string')
    assert.equal(typeof codec.create, 'function')
  }

  const header = slots.find((entry) => entry.name === 'conversation.session.header.actions')
  assert.ok(header, 'header action was not registered')
  const props = header.register().definition.inject('session-42')
  assert.equal(props.sessionId, 'session-42')
  assert.equal(typeof props.load, 'function')
})

test('a missing Remote namespace hides the panel instead of throwing', async () => {
  const exports = await loadClientModule()
  const { ctx, slots, injections } = fakeContext({
    mount: async () => {
      throw new Error('namespace not published')
    },
  })

  assert.doesNotThrow(() => exports.apply(ctx))
  injections[0].callback(ctx)
  await flush()

  assert.ok(slots.some((entry) => entry.name === 'plugins.row.config'))
  assert.equal(slots.some((entry) => entry.name === 'conversation.session.header.actions'), false)
})
