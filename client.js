/**
 * The Comate settings page.
 *
 * One job: let the user decide which of the licence's models appear in DSH's
 * model picker. A SaaS licence drives fifteen models, and a picker with fifteen
 * Comate rows is worse than one with the two somebody actually uses — but the
 * plugin has no way to guess which two, so the choice belongs to the person who
 * pays for the licence.
 *
 * ## Why the page is a `settings.section` and not a provider card
 *
 * `settings.models.provider-card` is per-provider chrome inside the Models
 * section, which is where a *credential* belongs. The model directory is a
 * plugin-level preference with its own save and its own explanation of what
 * "nothing ticked" means, so it gets a section of its own, beside the other
 * plugins that ship one.
 *
 * ## Why the draft is a mode, not just a list
 *
 * The stored value has two readings: an empty array means "follow the upstream
 * directory", while a non-empty array is an allow list. Rendering both as a
 * checkbox row would show zero ticks in the first case, which reads as "nothing
 * selected" — the opposite of what it does. So the card carries an explicit
 * mode, and only the manual mode has ticks to count.
 *
 * ## Why the save goes through the Host route
 *
 * `settings.mutate()` resolving is not proof the value landed (the sibling
 * plugins hit exactly that, and their cards announced saves that never
 * happened). The Host's `__save` route writes and then reads back, so this card
 * can tell "saved" from "the document kept its old value". A 404 there means
 * the route is absent — this file is loaded against a Host too old for it — and
 * only then does the card fall back to writing through the settings scope, and
 * it labels that result as unconfirmed rather than pretending otherwise.
 *
 * @module dsh-connect-comate/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-connect-comate',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The Loader entry id, which is also the settings namespace and the slot id. */
    const NAME = 'dsh-connect-comate'

    /** Where this card lands in the settings navigation (WorkBuddy is 35, market 40). */
    const SECTION_ORDER = 36

    const STATE_PATH = '/plugins/dsh-connect-comate/state'
    const SAVE_PATH = '/plugins/dsh-connect-comate/__save'

    /**
     * Simplified Chinese copy.
     *
     * Every string the card renders lives here rather than inline, because the
     * Host registers the table under the settings namespace and both languages
     * must name the same keys.
     */
    const zh = {
      'section.label': 'Comate',
      'status.loading': '正在读取 Comate 账号…',
      'status.signedIn': '已登录',
      'status.signedOut': '未登录',
      'status.hint': '模型目录来自 Comate 的许可证。这里勾掉的模型不会出现在 DSH 的模型选择器里，也不会被模型发现接口返回；已经用过的会话仍能继续解析到它们。',
      'status.retry': '重试',
      'mode.title': '模型目录',
      'mode.auto': '跟随上游目录',
      'mode.autoHint': 'Comate 报什么就是什么（当前 {count} 个）。许可证升级或新增模型时自动出现，不需要回来改。',
      'mode.manual': '手动选择',
      'mode.manualHint': '只有勾选的模型会出现在选择器里。上游下线某个模型后，这里残留的 id 会被忽略，不会把选择器清空。',
      'count.selected': '已选 {selected} / {total}',
      'count.all': '全部 {total} 个',
      'action.selectAll': '全选',
      'action.selectNone': '全不选',
      'action.reset': '恢复默认',
      'action.save': '保存',
      'action.saving': '保存中…',
      'action.discard': '撤销更改',
      'notice.saved': '已保存。选择器会立刻按新目录刷新。',
      'notice.savedUnconfirmed': '已保存（未确认）：宿主没有这条写入路由，值只写进了设置镜像。',
      'notice.failed': '保存失败：{message}',
      'notice.unsaved': '有未保存的更改。',
      'notice.needOne': '至少勾选一个模型，或切回「跟随上游目录」。',
      'notice.loadFailed': '读取模型目录失败：{message}',
      'notice.signedOutLoad': '没找到 Comate 登录凭证，读不到模型目录。先在终端执行一次 `zulu login`。',
      'model.context': '{value}K 上下文',
      'model.contextMillion': '{value}M 上下文',
      'usage.title': '今日积分',
      'usage.unavailable': '读不到积分数据',
      'todo.title': '未完成',
    }

    /** English copy, same keys. */
    const en = {
      'section.label': 'Comate',
      'status.loading': 'Reading the Comate account…',
      'status.signedIn': 'Signed in',
      'status.signedOut': 'Signed out',
      'status.hint': 'The model directory comes with the Comate licence. A model unticked here is not offered in DSH\'s picker and is not reported by model discovery; sessions that already used it can still resolve it.',
      'status.retry': 'Retry',
      'mode.title': 'Model directory',
      'mode.auto': 'Follow the upstream directory',
      'mode.autoHint': 'Whatever Comate reports ({count} right now). A licence upgrade or a new upstream model appears on its own — nothing to come back for.',
      'mode.manual': 'Choose manually',
      'mode.manualHint': 'Only ticked models are offered. A stored id that upstream retired is ignored rather than emptying the picker.',
      'count.selected': '{selected} of {total} selected',
      'count.all': 'All {total}',
      'action.selectAll': 'Select all',
      'action.selectNone': 'Select none',
      'action.reset': 'Reset',
      'action.save': 'Save',
      'action.saving': 'Saving…',
      'action.discard': 'Discard',
      'notice.saved': 'Saved. The picker refreshes against the new directory right away.',
      'notice.savedUnconfirmed': 'Saved (unconfirmed): the Host has no write route, so the value only reached the settings mirror.',
      'notice.failed': 'Save failed: {message}',
      'notice.unsaved': 'Unsaved changes.',
      'notice.needOne': 'Tick at least one model, or switch back to "Follow the upstream directory".',
      'notice.loadFailed': 'Could not read the model directory: {message}',
      'notice.signedOutLoad': 'No Comate sign-in was found, so there is no directory to read. Run `zulu login` in a terminal first.',
      'model.context': '{value}K context',
      'model.contextMillion': '{value}M context',
      'usage.title': 'Today\'s credits',
      'usage.unavailable': 'No credit data',
      'todo.title': 'Not done yet',
    }

    /**
     * Substitute `{name}` placeholders.
     *
     * The Host locale service has its own interpolation, but this table is read
     * through `bind()` and then formatted here so the card renders the same text
     * whether or not the service answers.
     *
     * @param template - the copy with placeholders.
     * @param values - placeholder values.
     * @returns the filled string.
     */
    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (whole, key) => (
        Object.hasOwn(values ?? {}, key) ? String(values[key]) : whole
      ))
    }

    /**
     * A translator with a built-in fallback.
     *
     * `bind()` may return a function that echoes unknown keys, and a card that
     * renders `mode.auto` verbatim looks like a missing translation rather than
     * a missing service — so an absent or unhelpful translator falls back to the
     * table above instead of trusting it.
     *
     * @param bound - the Host translator, if any.
     * @returns a `t(key, values?)` function.
     */
    function translator(bound) {
      return (key, values) => {
        if (typeof bound === 'function') {
          const rendered = bound(key, values)
          if (typeof rendered === 'string' && rendered !== key) return rendered
        }
        const table = typeof navigator !== 'undefined' && /^zh/i.test(navigator.language ?? '') ? zh : en
        const template = table[key] ?? zh[key] ?? key
        return format(template, values)
      }
    }

    /**
     * Card styles, over the Host's theme tokens.
     *
     * Only tokens this card can name from the documented set are used, each with
     * a fallback so a Host missing a token still renders text rather than
     * transparent blocks.
     */
    const CARD_CSS = [
      '.dsm-comate-root{display:flex;flex-direction:column;gap:16px;padding:4px 0 8px}',
      '.dsm-comate-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsm-comate-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}',
      '.dsm-comate-hint{margin:0;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary,#8a8f98)}',
      '.dsm-comate-badge{font-size:10px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#3a3b40);color:var(--dsw-alias-label-secondary,#8a8f98);white-space:nowrap}',
      '.dsm-comate-badge-on{border-color:var(--dsw-alias-state-success-primary,#12b76a);color:var(--dsw-alias-state-success-primary,#12b76a)}',
      '.dsm-comate-group{border:1px solid var(--dsw-alias-border-l1,#2e2f33);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#1c1d21);overflow:hidden}',
      '.dsm-comate-group-head{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#2e2f33)}',
      '.dsm-comate-choices{display:flex;flex-wrap:wrap;gap:8px}',
      '.dsm-comate-choice{appearance:none;font:inherit;font-size:12px;padding:4px 12px;border-radius:999px;cursor:pointer;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2,#3a3b40)}',
      '.dsm-comate-choice[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary,#5686fe);color:var(--dsw-alias-brand-primary,#5686fe)}',
      '.dsm-comate-choice:disabled{opacity:.5;cursor:default}',
      '.dsm-comate-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#2e2f33)}',
      '.dsm-comate-button{appearance:none;font:inherit;font-size:12px;padding:4px 12px;border-radius:999px;cursor:pointer;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2,#3a3b40)}',
      '.dsm-comate-button:disabled{opacity:.5;cursor:default}',
      '.dsm-comate-button-primary{background:var(--dsw-alias-brand-primary,#5686fe);border-color:var(--dsw-alias-brand-primary,#5686fe);color:#fff}',
      '.dsm-comate-count{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary,#8a8f98);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dsm-comate-list{margin:0;padding:0;list-style:none;max-height:340px;overflow:auto;display:flex;flex-direction:column}',
      '.dsm-comate-item{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#2e2f33)}',
      '.dsm-comate-item:last-child{border-bottom:0}',
      '.dsm-comate-item:hover{background:var(--dsw-alias-bg-layer-2,#24252a)}',
      '.dsm-comate-item label{display:flex;align-items:center;gap:8px;cursor:pointer;min-width:0;flex:1}',
      '.dsm-comate-item-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsm-comate-item-meta{font-size:11px;color:var(--dsw-alias-label-secondary,#8a8f98);white-space:nowrap}',
      '.dsm-comate-empty{margin:0;padding:16px 12px;font-size:12px;color:var(--dsw-alias-label-secondary,#8a8f98)}',
      '.dsm-comate-note{margin:0;font-size:12px;line-height:1.6}',
      '.dsm-comate-note-ok{color:var(--dsw-alias-state-success-primary,#12b76a)}',
      '.dsm-comate-note-warn{color:var(--dsw-alias-state-warn-primary,#f59e0b)}',
      '.dsm-comate-note-error{color:var(--dsw-alias-state-error-primary,#d92d20)}',
      '.dsm-comate-footer{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
    ].join('\n')

    /**
     * Install the card stylesheet once.
     *
     * The tag is keyed by plugin name so a second mount (HMR, or two sections)
     * does not stack duplicates, and it lives on `document.head` rather than in
     * the React tree so a re-render does not tear the styles back down.
     */
    function installStyles() {
      const key = 'dsh-connect-comate/client.css'
      if (document.querySelector(`style[data-plugin-css="${key}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-connect-comate'
      tag.dataset.pluginCss = key
      tag.textContent = CARD_CSS
      document.head.appendChild(tag)
    }

    /**
     * GET one of this plugin's read routes.
     *
     * @param path - an absolute path on the Host.
     * @returns the parsed JSON body.
     * @throws when the Host answers with a non-2xx status or a non-JSON body.
     */
    async function getJson(path) {
      const response = await fetch(path, {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      const body = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(messageOf(body, response.status))
      if (body === undefined) throw new Error('the Host returned no JSON')
      return body
    }

    /**
     * Pull a readable message out of one of this plugin's error bodies.
     *
     * @param body - the parsed body, or `undefined`.
     * @param status - the HTTP status, used when the body carries no message.
     * @returns a single-line message.
     */
    function messageOf(body, status) {
      if (typeof body === 'string' && body !== '') return body
      if (body !== null && typeof body === 'object') {
        const error = body.error
        if (typeof error === 'string' && error !== '') return error
        if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
        if (typeof body.detail === 'string' && body.detail !== '') return body.detail
      }
      return `HTTP ${String(status)}`
    }

    /**
     * Write the selection through the Host, then prove it landed.
     *
     * The 404 case is the only one that falls back to the settings scope: 404 is
     * "this Host has no such route", while 503 is "this Host has the route and
     * cannot reach its settings service". Treating those the same would let a
     * misconfigured Host look like an old one.
     *
     * @param scope - the settings scope, or `undefined`.
     * @param ids - the model ids to store; `[]` means "follow upstream".
     * @returns `{value, unconfirmed}`.
     * @throws when the Host definitively refused, or the fallback could not deliver.
     */
    async function writeSelection(scope, ids) {
      let response
      try {
        response = await fetch(SAVE_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ field: 'enabledModelIds', value: ids }),
        })
      } catch (error) {
        throw new Error(`the Host write route is unreachable (${String(error)})`)
      }

      const detail = await response.json().catch(() => undefined)
      if (response.status === 404) {
        if (scope === undefined) throw new Error('no write route and no settings scope to fall back to')
        const delivered = await Promise.resolve(scope.set('enabledModelIds', ids)).catch(() => false)
        if (delivered === false) throw new Error('the settings scope refused the write')
        const readBack = scope.getSnapshot?.().value?.enabledModelIds
        if (JSON.stringify(readBack) !== JSON.stringify(ids)) {
          throw new Error('the settings scope accepted the write but did not keep it')
        }
        return { value: ids, unconfirmed: true }
      }

      if (!response.ok) throw new Error(messageOf(detail, response.status))
      if (detail !== undefined && detail !== null && detail.ok === false) {
        throw new Error(detail.error ?? 'the Host wrote the value but read a different one back')
      }

      const value = Array.isArray(detail?.value) ? detail.value : ids
      // Mirror the confirmed value into the scope so the picker's live view and
      // the section agree without a second round trip.
      if (scope !== undefined) await Promise.resolve(scope.set('enabledModelIds', value)).catch(() => undefined)
      return { value, unconfirmed: false }
    }

    /**
     * Format a context window for the row's meta column.
     *
     * @param t - translator.
     * @param value - the window in tokens, if the roster reported one.
     * @returns the label, or an empty string.
     */
    function contextLabel(t, value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return ''
      if (value >= 1000 && value % 100000 === 0) return t('model.contextMillion', { value: value / 1000000 })
      return t('model.context', { value: Math.round(value / 1000) })
    }

    /**
     * The settings section itself.
     *
     * State is loaded once and re-read after a confirmed save; the draft lives
     * in local state so a half-made selection survives a re-render but not a
     * navigation away, which is the same trade every settings page makes.
     *
     * @param props - `{t, settingsScope, surface}`, injected at registration.
     */
    function ComateSection(props) {
      const t = props?.t ?? translator(undefined)
      const scope = props?.settingsScope

      const [snapshot, setSnapshot] = React.useState(undefined)
      const [failure, setFailure] = React.useState(undefined)
      const [reloads, setReloads] = React.useState(0)
      const [mode, setMode] = React.useState(undefined)
      const [draft, setDraft] = React.useState([])
      const [saving, setSaving] = React.useState(false)
      const [notice, setNotice] = React.useState(undefined)

      React.useEffect(() => {
        let live = true
        setSnapshot(undefined)
        setFailure(undefined)
        getJson(STATE_PATH)
          .then((value) => {
            if (!live) return
            setSnapshot(value)
            const stored = Array.isArray(value.enabledModelIds) ? value.enabledModelIds : []
            setMode(stored.length === 0 ? 'auto' : 'manual')
            setDraft(stored)
          })
          .catch((error) => {
            if (live) setFailure(error instanceof Error ? error.message : String(error))
          })
        return () => { live = false }
      }, [reloads])

      const roster = Array.isArray(snapshot?.roster) ? snapshot.roster : []
      const signedIn = snapshot?.signedIn === true
      const stored = Array.isArray(snapshot?.enabledModelIds) ? snapshot.enabledModelIds : []
      const storedMode = stored.length === 0 ? 'auto' : 'manual'
      const activeMode = mode ?? storedMode
      const dirty = snapshot !== undefined && (
        activeMode !== storedMode
        || JSON.stringify([...draft].sort()) !== JSON.stringify([...stored].sort())
      )
      const needsOne = activeMode === 'manual' && draft.length === 0

      const toggle = (id) => {
        setNotice(undefined)
        setMode('manual')
        setDraft((current) => {
          // Coming out of "follow upstream" every row is ticked, so a click has
          // to remove one from the full set. Seeding from `current` alone would
          // collapse the selection down to the single row that was clicked —
          // the opposite of what the tick it just drew said would happen.
          const base = activeMode === 'auto' ? roster.map((model) => model.id) : current
          return base.includes(id) ? base.filter((entry) => entry !== id) : [...base, id]
        })
      }

      const chooseMode = (next) => {
        setNotice(undefined)
        setMode(next)
        if (next === 'auto') setDraft([])
        else if (draft.length === 0) setDraft(roster.map((model) => model.id))
      }

      const discard = () => {
        setNotice(undefined)
        setMode(storedMode)
        setDraft(stored)
      }

      const save = async () => {
        setSaving(true)
        setNotice(undefined)
        try {
          const value = activeMode === 'auto' ? [] : draft
          const written = await writeSelection(scope, value)
          setMode(written.value.length === 0 ? 'auto' : 'manual')
          setDraft(written.value)
          setSnapshot((current) => (current === undefined ? current : {
            ...current,
            enabledModelIds: written.value,
            visibleModelIds: written.value.length === 0
              ? (current.roster ?? []).map((model) => model.id)
              : written.value,
          }))
          setNotice({ kind: written.unconfirmed ? 'warn' : 'ok', text: t(written.unconfirmed ? 'notice.savedUnconfirmed' : 'notice.saved') })
        } catch (error) {
          setNotice({ kind: 'error', text: t('notice.failed', { message: error instanceof Error ? error.message : String(error) }) })
        } finally {
          setSaving(false)
        }
      }

      // --- loading / failure ------------------------------------------------

      if (failure !== undefined) {
        return h('div', { className: 'dsm-comate-root' },
          h('p', { className: 'dsm-comate-note dsm-comate-note-error' }, t('notice.loadFailed', { message: failure })),
          h('div', { className: 'dsm-comate-footer' },
            h('button', {
              type: 'button',
              className: 'dsm-comate-button',
              onClick: () => setReloads((current) => current + 1),
            }, t('status.retry')),
          ),
        )
      }

      if (snapshot === undefined) {
        return h('div', { className: 'dsm-comate-root' },
          h('p', { className: 'dsm-comate-hint' }, t('status.loading')),
        )
      }

      // --- composed page ----------------------------------------------------

      const header = h('div', { className: 'dsm-comate-row' },
        h('p', { className: 'dsm-comate-title' }, t('mode.title')),
        h('span', {
          className: signedIn ? 'dsm-comate-badge dsm-comate-badge-on' : 'dsm-comate-badge',
        }, signedIn
          ? `${t('status.signedIn')}${typeof snapshot.credential?.displayName === 'string' ? ` · ${snapshot.credential.displayName}` : ''}`
          : t('status.signedOut')),
        h('span', { className: 'dsm-comate-count' }, activeMode === 'auto'
          ? t('count.all', { total: roster.length })
          : t('count.selected', { selected: draft.length, total: roster.length })),
      )

      const choices = h('div', { className: 'dsm-comate-choices' },
        h('button', {
          type: 'button',
          className: 'dsm-comate-choice',
          'aria-pressed': activeMode === 'auto',
          disabled: saving,
          onClick: () => chooseMode('auto'),
        }, t('mode.auto')),
        h('button', {
          type: 'button',
          className: 'dsm-comate-choice',
          'aria-pressed': activeMode === 'manual',
          disabled: saving,
          onClick: () => chooseMode('manual'),
        }, t('mode.manual')),
      )

      const modeHint = h('p', { className: 'dsm-comate-hint' }, activeMode === 'auto'
        ? t('mode.autoHint', { count: roster.length })
        : t('mode.manualHint'))

      const tools = activeMode === 'manual'
        ? h('div', { className: 'dsm-comate-tools' },
          h('button', {
            type: 'button',
            className: 'dsm-comate-button',
            disabled: saving || draft.length === roster.length,
            onClick: () => { setNotice(undefined); setDraft(roster.map((model) => model.id)) },
          }, t('action.selectAll')),
          h('button', {
            type: 'button',
            className: 'dsm-comate-button',
            disabled: saving || draft.length === 0,
            onClick: () => { setNotice(undefined); setDraft([]) },
          }, t('action.selectNone')),
          h('button', {
            type: 'button',
            className: 'dsm-comate-button',
            disabled: saving,
            onClick: () => chooseMode('auto'),
          }, t('action.reset')),
        )
        : null

      const list = roster.length === 0
        ? h('p', { className: 'dsm-comate-empty' }, signedIn ? t('usage.unavailable') : t('notice.signedOutLoad'))
        : h('ul', { className: 'dsm-comate-list' }, roster.map((model) => {
          const checked = activeMode === 'auto' || draft.includes(model.id)
          const meta = contextLabel(t, model.contextWindow)
          return h('li', { key: model.id, className: 'dsm-comate-item' },
            h('label', null,
              h('input', {
                type: 'checkbox',
                checked,
                // In "follow upstream" mode the ticks are informational; making
                // one click mean "switch to manual and keep the rest" is the
                // behaviour a user expects from a list they just started editing.
                disabled: saving || activeMode === 'auto',
                onChange: () => toggle(model.id),
              }),
              h('span', { className: 'dsm-comate-item-name' }, model.name ?? model.id),
            ),
            meta === '' ? null : h('span', { className: 'dsm-comate-item-meta' }, meta),
          )
        }))

      const footer = h('div', { className: 'dsm-comate-footer' },
        h('button', {
          type: 'button',
          className: 'dsm-comate-button dsm-comate-button-primary',
          disabled: saving || !dirty || needsOne,
          onClick: () => { void save() },
        }, t(saving ? 'action.saving' : 'action.save')),
        h('button', {
          type: 'button',
          className: 'dsm-comate-button',
          disabled: saving || !dirty,
          onClick: discard,
        }, t('action.discard')),
        needsOne
          ? h('span', { className: 'dsm-comate-note dsm-comate-note-warn' }, t('notice.needOne'))
          : null,
      )

      const noticeLine = notice === undefined
        ? (dirty ? h('p', { className: 'dsm-comate-note dsm-comate-note-warn' }, t('notice.unsaved')) : null)
        : h('p', {
          className: `dsm-comate-note ${
            notice.kind === 'ok' ? 'dsm-comate-note-ok' : notice.kind === 'warn' ? 'dsm-comate-note-warn' : 'dsm-comate-note-error'
          }`,
        }, notice.text)

      return h('div', { className: 'dsm-comate-root' },
        header,
        h('p', { className: 'dsm-comate-hint' }, t('status.hint')),
        h('div', { className: 'dsm-comate-group' },
          h('div', { className: 'dsm-comate-group-head' }, choices),
          modeHint,
          tools,
          list,
        ),
        noticeLine,
        footer,
      )
    }

    /**
     * The navigation icon, matching the shipped `icon.svg` motif.
     *
     * @param props - `{active}` from the slot; the inactive state is dimmed.
     */
    function ComateIcon(props) {
      const dim = props?.active === false
      return h('svg', {
        viewBox: '0 0 128 128',
        width: 16,
        height: 16,
        'aria-hidden': true,
        style: { display: 'block', opacity: dim ? 0.75 : 1 },
      },
        h('path', {
          d: 'M46 40 26 64l20 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 12,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M82 40l20 24-20 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 12,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M64 46l12 18-12 18-12-18z', fill: 'currentColor' }),
      )
    }

    /**
     * Which namespace the Host actually serves this plugin's settings under.
     *
     * The Loader entry id is the answer on every Host seen so far, but a profile
     * patch can alias the row, so the live `describe()` view is consulted first.
     *
     * @param ctx - the Cordis context.
     * @returns the namespace to bind copy and resolve the scope for.
     */
    function resolveNamespace(ctx) {
      const forms = ctx.get('configForms')
      if (forms === undefined) return NAME
      try {
        const namespaces = forms.describe().getSnapshot().view?.namespaces ?? []
        const served = namespaces.find((entry) => entry.ns === NAME)
        if (served !== undefined) return served.ns
        if (namespaces.length > 0) {
          console.error(
            `[dsh-connect-comate] the Host serves ${namespaces.length} settings namespace(s) `
            + `(${namespaces.map((entry) => entry.ns).join(', ')}) but none is "${NAME}"; `
            + 'the section registers under that name anyway, so its settings row will be missing.',
          )
        }
        return NAME
      } catch {
        return NAME
      }
    }

    /** Register the section and its icon; a slot mismatch costs the page, not the provider. */
    function apply(ctx) {
      try {
        installStyles()

        const namespace = resolveNamespace(ctx)
        ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-connect-comate: settings copy')
        const t = translator(ctx.locale.bind(namespace))

        const forms = ctx.get('configForms')
        const scope = forms === undefined ? undefined : forms.get(namespace)

        const disposers = []

        // `slots.inject(name, cb)` IS the probe: it waits for the slot to be
        // declared and runs `cb` once it exists, and on a Host that never
        // declares `settings.section` it does nothing at all instead of
        // registering into a slot nobody renders.
        const sectionInject = ctx.slots.inject('settings.section', () => {
          const registration = ctx.slots.register({
            name: 'settings.section',
            id: NAME,
            order: SECTION_ORDER,
            label: () => t('section.label'),
            locale: namespace,
            inject: () => ({ t, settingsScope: scope, surface: 'settings' }),
          }, ComateSection)
          disposers.push(registration)
          return registration
        })
        if (typeof sectionInject === 'function') disposers.push(sectionInject)

        try {
          const iconInject = ctx.slots.inject('settings.section.icon', () => {
            const registration = ctx.slots.register({
              name: 'settings.section.icon',
              id: NAME,
              locale: namespace,
            }, ComateIcon)
            disposers.push(registration)
            return registration
          })
          if (typeof iconInject === 'function') disposers.push(iconInject)
        } catch (error) {
          console.error('[dsh-connect-comate] the section icon failed to register:', error)
        }

        ctx.effect(() => () => {
          for (const dispose of disposers.splice(0)) {
            try {
              dispose()
            } catch {
              // A Host that already reclaimed the slot is not a failure.
            }
          }
        })
      } catch (error) {
        console.error('[dsh-connect-comate] the settings section failed to load (the provider is unaffected):', error)
      }
    }

    const inject = ['slots', 'locale']
    const name = NAME

    return { apply, inject, name }
  },
})
