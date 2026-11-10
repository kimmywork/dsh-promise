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

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-promise: dictionaries')
      const t = ctx.locale.bind(NS)
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
