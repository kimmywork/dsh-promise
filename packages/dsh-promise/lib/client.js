/**
 * dsh-promise client half: the configuration cell for the `promise` row on the
 * bundle's page in the Plugins tab. It edits the three volatile config fields
 * (Jev base URL, model, API key) and writes them through the Host settings
 * contract; the API key is write-only and never arrives in this module.
 *
 * Hand-written in the DSH client module format so the package needs no build
 * step: the web client loads `dsh.client` entries through __ModuleLoader__.
 */
window.__ModuleLoader__.load({
  id: 'dsh-promise',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const NS = 'promise'

    const zh = {
      summary: 'Jev 连接：Base URL、Model、API Key',
      title: 'Jev 连接',
      hint: '语义评估使用 TypeSafe System One。API Key 只写入本机 profile 配置；留空表示不修改，未配置时回退到环境变量。',
      baseUrl: 'Base URL',
      model: 'Model',
      apiKey: 'API Key',
      apiKeyHint: '留空表示不修改；保存后只显示「已配置」状态。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      failed: '保存失败，请检查 Base URL 或稍后重试',
      noop: '没有修改',
      invalid: 'Base URL 必须以 http:// 或 https:// 开头',
      loading: '正在读取配置…',
      unavailable: '该插件当前未启用，启用后才能编辑配置',
      readonly: '当前组合不允许在这里写入配置',
      secretNote: '注意：Key 会以明文保存在本机 profile 配置文件中。',
      configured: '已配置',
      action: '承诺',
      creditsTitle: '承诺与信用',
      creditsEmpty: '本会话还没有承诺',
      creditsLoading: '读取中…',
      creditsError: '读取失败',
      creditsTeam: '团队',
      creditsSubagent: '子代理',
      creditsEvidence: '证据',
      creditsRecent: '最近结算',
      creditsNoRecent: '暂无结算',
      creditsClose: '关闭',
      creditsUnknown: '未知',
    }
    const en = {
      summary: 'Jev connection: base URL, model, API key',
      title: 'Jev connection',
      hint: 'Semantic assessment uses TypeSafe System One. The API key is written to this machine’s profile config only; leave it empty to keep the current value, and the plugin falls back to the environment variable.',
      baseUrl: 'Base URL',
      model: 'Model',
      apiKey: 'API key',
      apiKeyHint: 'Leave empty to keep the current key; only the “configured” state is shown after saving.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      failed: 'Save failed; check the base URL and try again',
      noop: 'No changes',
      invalid: 'Base URL must start with http:// or https://',
      loading: 'Reading configuration…',
      unavailable: 'This plugin is not enabled, so its configuration cannot be edited here',
      readonly: 'This composition does not allow writing configuration here',
      secretNote: 'Note: the key is stored in plain text in this machine’s profile configuration.',
      configured: 'Configured',
      action: 'Promises',
      creditsTitle: 'Promises and credit',
      creditsEmpty: 'No promises in this session yet',
      creditsLoading: 'Loading…',
      creditsError: 'Failed to load',
      creditsTeam: 'team',
      creditsSubagent: 'subagent',
      creditsEvidence: 'evidence',
      creditsRecent: 'Recent settlements',
      creditsNoRecent: 'No settlements yet',
      creditsClose: 'Close',
      creditsUnknown: 'unknown',
    }

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 2px', fontSize: '13px', lineHeight: '20px' },
      hint: { color: 'var(--dsw-alias-label-tertiary)', margin: 0, fontSize: '12px', lineHeight: '18px' },
      field: { display: 'flex', flexDirection: 'column', gap: '5px' },
      label: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', fontWeight: 500 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-specific-menu)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        lineHeight: '18px',
        outline: 'none',
      },
      row: { display: 'flex', alignItems: 'center', gap: '10px' },
      button: {
        padding: '5px 14px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-fill-l2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
        cursor: 'pointer',
      },
      status: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      error: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      trigger: {
        padding: '3px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-fill-l1)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: 'pointer',
      },
      dialog: {
        position: 'fixed',
        margin: 0,
        padding: 0,
        border: 0,
        background: 'transparent',
        color: 'inherit',
        maxWidth: 'calc(100vw - 32px)',
        maxHeight: 'calc(100vh - 80px)',
        overflow: 'visible',
      },
      panel: {
        position: 'relative',
        boxSizing: 'border-box',
        width: '100%',
        maxHeight: 'min(440px, calc(100vh - 96px))',
        overflow: 'auto',
        padding: '10px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-specific-menu, #fff)',
        boxShadow: 'var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.18))',
        color: 'var(--dsw-alias-label-primary)',
      },
      panelTitle: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px', fontWeight: 600, marginBottom: '6px' },
      creditRow: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 4px', borderTop: '1px solid var(--dsw-alias-border-l1)' },
      rowHead: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' },
      dot: { width: '7px', height: '7px', borderRadius: '50%', flex: 'none' },
      name: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      kind: { marginLeft: 'auto', fontSize: '10px', color: 'var(--dsw-alias-label-tertiary)' },
      meta: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', paddingLeft: '13px' },
      verdict: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', paddingLeft: '13px' },
    }

    function Page(props) {
      const form = props.form
      const t = props.t
      const state = form.state || {}
      const value = state.value || {}
      const jev = value.jev || {}

      const [baseUrl, setBaseUrl] = react.useState(typeof jev.baseUrl === 'string' ? jev.baseUrl : '')
      const [model, setModel] = react.useState(typeof jev.model === 'string' ? jev.model : '')
      const [apiKey, setApiKey] = react.useState('')
      const [status, setStatus] = react.useState('idle')

      react.useEffect(() => {
        const next = ((form.state && form.state.value) || {}).jev || {}
        setBaseUrl(typeof next.baseUrl === 'string' ? next.baseUrl : '')
        setModel(typeof next.model === 'string' ? next.model : '')
      }, [state.revision])

      if (state.status === 'loading') return react.createElement('p', { style: styles.hint }, t('loading'))
      if (state.status === 'unavailable') return react.createElement('p', { style: styles.hint }, t('unavailable'))
      if (state.writable === false) return react.createElement('p', { style: styles.hint }, t('readonly'))

      const busy = status === 'saving'
      const save = async () => {
        const nextBase = baseUrl.trim()
        if (!/^https?:\/\//.test(nextBase)) {
          setStatus('invalid')
          return
        }
        const ops = []
        if (nextBase !== jev.baseUrl) ops.push({ op: 'set', path: ['jev', 'baseUrl'], value: nextBase })
        const nextModel = model.trim()
        if (nextModel && nextModel !== jev.model) ops.push({ op: 'set', path: ['jev', 'model'], value: nextModel })
        if (apiKey.trim() !== '') ops.push({ op: 'set', path: ['jev', 'apiKey'], value: apiKey.trim() })
        if (ops.length === 0) {
          setStatus('noop')
          return
        }
        setStatus('saving')
        try {
          const ok = await form.mutate(ops, state.revision)
          setStatus(ok ? 'saved' : 'failed')
          if (ok) setApiKey('')
        } catch {
          setStatus('failed')
        }
      }

      const field = (label, hint, input) => react.createElement('div', { style: styles.field }, [
        react.createElement('span', { style: styles.label, key: 'label' }, label),
        input,
        hint ? react.createElement('span', { style: styles.hint, key: 'hint' }, hint) : null,
      ])

      return react.createElement('div', { style: styles.root }, [
        react.createElement('p', { style: styles.hint, key: 'hint' }, t('hint')),
        field(t('baseUrl'), null, react.createElement('input', {
          key: 'baseUrl',
          style: styles.input,
          value: baseUrl,
          spellCheck: false,
          onChange: (event) => setBaseUrl(event.target.value),
        })),
        field(t('model'), null, react.createElement('input', {
          key: 'model',
          style: styles.input,
          value: model,
          spellCheck: false,
          onChange: (event) => setModel(event.target.value),
        })),
        field(t('apiKey'), t('apiKeyHint'), react.createElement('input', {
          key: 'apiKey',
          style: styles.input,
          type: 'password',
          value: apiKey,
          autoComplete: 'off',
          placeholder: '••••••••',
          onChange: (event) => setApiKey(event.target.value),
        })),
        react.createElement('div', { style: styles.row, key: 'actions' }, [
          react.createElement('button', {
            key: 'save',
            type: 'button',
            style: styles.button,
            disabled: busy,
            onClick: save,
          }, busy ? t('saving') : t('save')),
          status === 'idle' ? null : react.createElement('span', {
            key: 'status',
            style: status === 'failed' || status === 'invalid' ? styles.error : styles.status,
          }, t(status)),
        ]),
        react.createElement('p', { style: styles.hint, key: 'secret' }, t('secretNote')),
      ])
    }

    function PromiseRowConfig(props) {
      if (props.view === 'summary') return react.createElement('span', null, props.t('summary'))
      if (!props.form) return react.createElement('span', null, props.t('unavailable'))
      return react.createElement(Page, props)
    }


    async function loadSnapshot(ctx, sessionId) {
      // `ctx.get` resolves the namespace without a service-property read, which
      // Cordis rejects unless the exact service was injected into this context.
      const namespace = typeof ctx.get === 'function'
        ? ctx.get('remote.promiseInventory')
        : ctx.remote && ctx.remote.promiseInventory
      if (!namespace || typeof namespace.snapshot !== 'function') throw new Error('promiseInventory remote is not published')
      const result = await namespace.snapshot(String(sessionId))
      if (result && result.ok === false) throw new Error(result.error?.message ?? 'promiseInventory.snapshot failed')
      return result && result.value !== undefined ? result.value : result
    }

    function creditColor(row) {
      if (!row.evidence) return 'var(--dsw-alias-label-tertiary, #999)'
      if (row.status === 'suspended' || row.trust < 0.45) return 'var(--dsw-alias-state-error-primary, #d14343)'
      if (row.status === 'probation' || row.trust < 0.7) return 'var(--dsw-alias-state-warning-primary, #b7791f)'
      return 'var(--dsw-alias-state-success-primary, #2ea043)'
    }

    function PromiseCreditsAction(props) {
      const { sessionId, load, t } = props
      const [snapshot, setSnapshot] = react.useState(null)
      const [status, setStatus] = react.useState('idle')
      const [loaded, setLoaded] = react.useState(false)
      const dialogRef = react.useRef(null)
      const triggerRef = react.useRef(null)

      const fetchSnapshot = () => {
        if (loaded) return
        setLoaded(true)
        if (!sessionId) {
          setSnapshot({ error: 'no session id' })
          setStatus('error')
          return
        }
        setStatus('loading')
        Promise.resolve()
          .then(() => load(sessionId))
          .then((value) => {
            setSnapshot(value)
            setStatus('ready')
          })
          .catch((error) => {
            setSnapshot({ error: String(error?.message ?? error) })
            setStatus('error')
          })
      }

      const placePanel = () => {
        const dialog = dialogRef.current
        const trigger = triggerRef.current
        if (!dialog || !trigger || typeof trigger.getBoundingClientRect !== 'function') return
        const rect = trigger.getBoundingClientRect()
        const viewport = typeof window === 'undefined' ? 1440 : window.innerWidth
        const width = Math.max(240, Math.min(380, viewport - 32))
        const left = Math.max(12, Math.min(Math.round(rect.left), viewport - width - 12))
        dialog.style.top = `${Math.round(rect.bottom + 6)}px`
        dialog.style.left = `${left}px`
        dialog.style.right = 'auto'
        dialog.style.bottom = 'auto'
        dialog.style.width = `${width}px`
      }

      const openPanel = () => {
        const dialog = dialogRef.current
        if (!dialog) return
        placePanel()
        // showModal puts the panel in the browser top layer, so neither the
        // conversation's overflow nor any ancestor stacking context can hide it.
        if (typeof dialog.showModal === 'function') {
          if (!dialog.open) dialog.showModal()
        } else {
          dialog.setAttribute('open', '')
        }
        fetchSnapshot()
      }

      const closePanel = () => {
        const dialog = dialogRef.current
        if (!dialog) return
        if (typeof dialog.close === 'function' && dialog.open) dialog.close()
        else dialog.removeAttribute('open')
      }

      const header = snapshot?.header
      const label = `${t('action')}${header ? ` ${header.promises} · ${Number(header.credit).toFixed(2)}` : ''} ▾`

      const rows = []
      if (snapshot && snapshot.rows) {
        for (const row of snapshot.rows) {
          rows.push(react.createElement('div', { key: `${row.agent}:${row.capability}`, style: styles.creditRow }, [
            react.createElement('div', { key: 'head', style: styles.rowHead }, [
              react.createElement('span', { key: 'dot', style: { ...styles.dot, background: creditColor(row) } }),
              react.createElement('span', { key: 'name', style: styles.name }, row.name || row.agent),
              react.createElement('span', { key: 'kind', style: styles.kind }, t(row.kind === 'team' ? 'creditsTeam' : 'creditsSubagent')),
            ]),
            react.createElement('div', { key: 'cap', style: styles.meta }, row.capability),
            react.createElement('div', { key: 'credit', style: styles.verdict },
              row.evidence
                ? `${Number(row.trust).toFixed(2)} · lower ${Number(row.lower).toFixed(2)} · ${row.evidence} ${t('creditsEvidence')}`
                : t('creditsUnknown')),
            row.lastVerdict ? react.createElement('div', { key: 'verdict', style: styles.meta }, row.lastVerdict) : null,
          ]))
        }
      }

      const recent = (snapshot?.recent ?? []).map((entry, index) => react.createElement('div', {
        key: `r${index}`,
        style: styles.meta,
      }, `${entry.verdict} · L${entry.level} · ${Number(entry.confidence).toFixed(2)} · ${entry.capability}`))

      const body = status === 'loading'
        ? react.createElement('p', { style: styles.hint }, t('creditsLoading'))
        : status === 'error'
          ? react.createElement('p', { style: styles.error }, `${t('creditsError')}: ${snapshot?.error ?? ''}`)
          : rows.length === 0
            ? react.createElement('p', { style: styles.hint }, t('creditsEmpty'))
            : rows

      return react.createElement('span', {
        key: 'credits',
        style: { display: 'inline-flex' },
      }, [
        react.createElement('button', {
          key: 'trigger',
          ref: triggerRef,
          type: 'button',
          style: styles.trigger,
          'data-promise-credits': 'trigger',
          onClick: openPanel,
        }, label),
        react.createElement('dialog', {
          key: 'dialog',
          ref: dialogRef,
          'data-promise-credits': 'dialog',
          style: styles.dialog,
          onClick: (event) => {
            if (event.target === event.currentTarget) closePanel()
          },
        }, [
          react.createElement('div', {
            key: 'panel',
            'data-promise-credits': 'panel',
            style: styles.panel,
          }, [
            react.createElement('div', { key: 'title', style: styles.panelTitle }, [
              react.createElement('span', { key: 'label' }, t('creditsTitle')),
              react.createElement('button', {
                key: 'close',
                type: 'button',
                style: { ...styles.button, padding: '2px 8px' },
                onClick: closePanel,
              }, t('creditsClose')),
            ]),
            body,
            recent.length > 0
              ? react.createElement('div', { key: 'recent' }, [
                react.createElement('div', { key: 'recentTitle', style: { ...styles.label, marginTop: '8px' } }, t('creditsRecent')),
                ...recent,
              ])
              : react.createElement('p', { key: 'noRecent', style: { ...styles.hint, marginTop: '8px' } }, t('creditsNoRecent')),
          ]),
        ]),
      ])
    }

    /**
     * Hand-written Client contribution for the read-only snapshot Remote. The
     * generated artifact normally comes from the Typert compiler; this package is
     * outside the monorepo, so the single descriptor is declared here and mounted
     * through the same `remote.$mount` contract the generated artifacts use.
     */
    const SNAPSHOT_DESCRIPTOR = {
      id: 'dsh-promise#promiseInventory/snapshot',
      service: 'promiseInventory',
      namespace: 'promiseInventory',
      method: 'snapshot',
      description: 'Read the promise and credit snapshot for one session.',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'sessionId',
        wire: 'sessionId',
        source: 'json',
        codec: {
          mode: 'strict',
          typeSymbol: 'dsh-promise#SessionId',
          create: () => null,
          jsonSchema: { type: 'string' },
        },
      }],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-promise#PromiseSnapshot',
        create: () => null,
        jsonSchema: { type: 'object' },
      },
    }

    const headerSlot = (ctx, t) => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'promise-credits',
      order: 55,
      locale: NS,
      // `sessionId` and `t` come from the slot's standard kit (the slot is
      // session-scoped and declares `locale: NS`), so only the loader is ours.
      inject: () => ({ load: (id) => loadSnapshot(ctx, id) }),
    }, PromiseCreditsAction))

    function registerCreditsAction(ctx, t) {
      let disposed = false
      let release
      let pending
      try {
        if (typeof ctx.remote?.$mount !== 'function') return
        pending = ctx.remote.$mount({ package: 'dsh-promise', descriptors: [SNAPSHOT_DESCRIPTOR] })
      } catch {
        return
      }
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          disposed = true
          if (typeof release === 'function') release()
        }, 'dsh-promise: inventory remote')
      }
      Promise.resolve(pending)
        .then((dispose) => {
          release = dispose
          if (disposed) {
            if (typeof dispose === 'function') dispose()
            return
          }
          try {
            headerSlot(ctx, t)
          } catch {
            if (typeof dispose === 'function') dispose()
          }
        })
        .catch(() => {
          // No published namespace: keep the plugin usable and just omit the panel.
        })
    }

    const inject = ['slots', 'locale']

    function ensurePanelStyle() {
      if (typeof document === 'undefined' || document.getElementById('dsh-promise-credits-style')) return undefined
      const style = document.createElement('style')
      style.id = 'dsh-promise-credits-style'
      // A header popover should not dim the whole app; the dialog is only used
      // for top-layer positioning, not for modality.
      style.textContent = 'dialog[data-promise-credits]::backdrop{background:transparent}'
      document.head.appendChild(style)
      return () => style.remove()
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-promise: dictionaries')
      ctx.effect(() => ensurePanelStyle(), 'dsh-promise: credit panel style')
      const t = ctx.locale.bind(NS)

      // The credit panel needs the Client Remote face. Wait for it separately so
      // a composition without the API gateway still gets the settings form.
      if (typeof ctx.inject === 'function') {
        ctx.inject(['remote'], (scope) => registerCreditsAction(scope, t))
      }

      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: 'dsh-promise#promise',
        locale: NS,
        inject: () => ({ t }),
      }, PromiseRowConfig))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
