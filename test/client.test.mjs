/**
 * The settings section, rendered.
 *
 * The Client half is the only part of this plugin a Host loads as a browser
 * artifact, so it is also the only part a plain `node --test` run does not
 * normally touch. These tests load it the way the module table does — through
 * `window.__ModuleLoader__` — hand it a React stand-in, and then assert on the
 * tree it produces: which slot it registers into, what the checkboxes say, and
 * what the save button actually posts.
 *
 * The point is not coverage for its own sake. The save path has three outcomes
 * that look identical on screen (saved, saved-but-unconfirmed, refused), and
 * the difference between them is whether the user's selection is really in the
 * document. That is worth a test that renders.
 *
 * @module dsh-connect-comate/test/client
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import * as React from './fixtures/react.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(here)

/**
 * A `document` just complete enough for `installStyles`.
 *
 * The client half only ever runs in a browser, so the harness plays one rather
 * than asking the module to defend against an environment it will never meet.
 * Keeping the real code path here is the point: the style tag is how the card
 * gets any of its layout, and a harness that skipped it would not notice a
 * broken selector.
 */
function installDocument() {
  const appended = []
  const findTag = (selector) => {
    const match = /^style\[data-plugin-css="(.*)"\]$/.exec(selector)
    if (match === null) return null
    return appended.find((tag) => tag.dataset.pluginCss === match[1]) ?? null
  }
  globalThis.document = {
    head: { appendChild: (tag) => { appended.push(tag); return tag } },
    createElement: () => ({ dataset: {}, textContent: '' }),
    querySelector: findTag,
  }
  return appended
}

const styledTags = installDocument()

/**
 * The slot registrations one `apply` run produced.
 *
 * @returns a fake Cordis context and the record it writes into.
 */
function context() {
  const record = {
    slots: [],
    icons: [],
    effects: [],
    injected: [],
    localeTables: new Map(),
    disposers: [],
  }

  const ctx = {
    get(name) {
      if (name !== 'configForms') return undefined
      return {
        describe: () => ({
          getSnapshot: () => ({ view: { namespaces: [{ ns: 'dsh-connect-comate' }] } }),
        }),
        get: (ns) => ({ __scope: ns, set: async () => true, getSnapshot: () => ({ value: {} }) }),
      }
    },
    on: () => () => {},
    provide: () => {},
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') record.effects.push(dispose)
      return () => {}
    },
    locale: {
      register(ns, tables) {
        record.localeTables.set(ns, tables)
        return () => record.localeTables.delete(ns)
      },
      bind(ns) {
        return (key, values) => {
          const table = record.localeTables.get(ns)
          const template = table?.zh?.[key]
          if (typeof template !== 'string') return key
          return template.replace(/\{(\w+)\}/g, (whole, name) => (
            values !== undefined && Object.hasOwn(values, name) ? String(values[name]) : whole
          ))
        }
      },
    },
    slots: {
      inject(name, callback) {
        record.injected.push(name)
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(registration, component) {
        record.slots.push({ registration, component })
        if (registration.name === 'settings.section.icon') record.icons.push({ registration, component })
        return () => {
          record.slots = record.slots.filter((entry) => entry.registration !== registration)
        }
      },
    },
  }

  return { ctx, record }
}

/**
 * Load `client.js` through the module table with a stand-in React.
 *
 * @returns the module's exports.
 */
function loadClient() {
  const source = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  let loaded
  const window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        loaded = { id, exports: factory((specifier) => {
          if (specifier === 'react') return React
          throw new Error(`the client half asked for an unexpected module: ${specifier}`)
        }) }
      },
    },
  }
  const evaluate = new Function('window', 'fetch', `${source}\nreturn window.__ModuleLoader__`)
  // A browser's `fetch` is looked up per call, so the harness must not freeze
  // the current one into the module: each test installs its own stub after the
  // client has loaded, and a captured binding would silently use the real one.
  evaluate(window, (...args) => globalThis.fetch(...args))
  assert.ok(loaded !== undefined, 'client.js never called window.__ModuleLoader__.load')
  assert.equal(loaded.id, 'dsh-connect-comate', 'the module table keys the factory by package name')
  return loaded.exports
}

/**
 * Run one `apply` and return the settings section registration.
 *
 * @returns the registration, its component, and the record.
 */
function mountSection() {
  const client = loadClient()
  assert.deepEqual(client.inject, ['slots', 'locale'], 'only guaranteed services are hard-injected')
  assert.equal(client.name, 'dsh-connect-comate')

  const { ctx, record } = context()
  client.apply(ctx)

  const section = record.slots.find((entry) => entry.registration.name === 'settings.section')
  assert.ok(section !== undefined, 'the section was never registered into settings.section')
  return { section, record, client }
}

/**
 * A fetch stand-in that answers this plugin's read route.
 *
 * @param state - the body `/state` should return.
 * @returns `{fetch, calls}`.
 */
function stubFetch(state) {
  const calls = []
  const fetch = async (input, init) => {
    calls.push({ url: String(input), init })
    if (String(input).endsWith('/state')) {
      return { ok: true, status: 200, json: async () => state }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'no route' }) }
  }
  return { fetch, calls }
}

const ROSTER = [
  { id: 'deepseek-v4-flash_aaaa', name: 'Deepseek V4 Flash', contextWindow: 1024000 },
  { id: 'glm-5.3_bbbb', name: 'GLM-5.3', contextWindow: 200000 },
  { id: 'kimi-k2.6_cccc', name: 'Kimi-K2.6' },
]

/**
 * One roster entry carrying every capability the row can print.
 *
 * Kept apart from `ROSTER` so the mode and count assertions keep describing the
 * same three models while this one exercises the meta column.
 */
const CAPABLE = {
  id: 'deepseek-v4.1-flash_dddd',
  name: 'Deepseek V4.1 Flash',
  contextWindow: 1000000,
  supportsImage: true,
  supportsThinking: true,
  reasoning: {
    efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }],
    defaultEffort: 'max',
  },
}

/**
 * Install a fetch stub for the duration of `body`.
 *
 * @param state - the `/state` body.
 * @param body - receives the stub.
 */
async function withFetch(state, body) {
  const original = globalThis.fetch
  const stub = stubFetch(state)
  globalThis.fetch = stub.fetch
  try {
    await body(stub)
  } finally {
    globalThis.fetch = original
  }
}

test('the section registers under its own id at an order beside the shipped sections', () => {
  const { section, record } = mountSection()
  const { registration } = section

  assert.equal(registration.id, 'dsh-connect-comate')
  assert.equal(registration.order, 36, 'the section sits between WorkBuddy (35) and the market (40)')
  assert.equal(typeof registration.label, 'function')
  assert.equal(registration.label(), 'Comate')
  assert.equal(registration.locale, 'dsh-connect-comate')

  const injected = registration.inject()
  assert.equal(injected.surface, 'settings', 'the shell draws the panel chrome, not the section')
  assert.equal(typeof injected.t, 'function')
  assert.ok(injected.settingsScope !== undefined, 'the derived settings scope reached the section')

  const icon = record.icons[0]
  assert.ok(icon !== undefined, 'a section without an icon renders a blank nav row')
  assert.equal(icon.registration.id, 'dsh-connect-comate')
})

test('both languages are registered under the namespace the section binds', () => {
  const { record } = mountSection()
  const tables = record.localeTables.get('dsh-connect-comate')

  assert.ok(tables !== undefined, 'no locale table was registered')
  const zhKeys = Object.keys(tables.zh).sort()
  const enKeys = Object.keys(tables.en).sort()
  assert.deepEqual(enKeys, zhKeys, 'a key present in one language and absent in the other renders as its own name')
  assert.equal(tables.zh['section.label'], 'Comate')
  assert.equal(tables.en['section.label'], 'Comate')
})

test('an untouched account renders the upstream directory with everything ticked and nothing to save', async () => {
  const { section } = mountSection()
  await withFetch({ signedIn: true, credential: { displayName: '光昱尘' }, roster: ROSTER, enabledModelIds: [] }, async () => {
    const mounted = await React.mount(section.component, section.registration.inject())
    const tree = mounted.tree

    const boxes = React.findAll(tree, (node) => node.type === 'input')
    assert.equal(boxes.length, ROSTER.length, 'one checkbox per model in the roster')
    assert.ok(boxes.every((box) => box.props.checked === true), 'an empty selection shows the whole directory ticked')
    assert.ok(boxes.every((box) => box.props.disabled === true), 'ticks are informational until manual mode is chosen')

    const text = React.textOf(tree)
    assert.ok(text.includes('跟随上游目录'), 'the mode the document is in is named')
    assert.ok(text.includes('全部 3 个'), 'the count says what the picker will really offer')
    assert.ok(text.includes('光昱尘'), 'the signed-in account is named')

    const save = React.findAll(tree, (node) => node.type === 'button' && React.textOf(node) === '保存')
    assert.equal(save.length, 1)
    assert.equal(save[0].props.disabled, true, 'an unchanged document offers no save')
  })
})

test('a stored selection renders as manual mode with only those ticks', async () => {
  const { section } = mountSection()
  await withFetch({ signedIn: true, roster: ROSTER, enabledModelIds: [ROSTER[1].id] }, async () => {
    const mounted = await React.mount(section.component, section.registration.inject())
    const boxes = React.findAll(mounted.tree, (node) => node.type === 'input')

    assert.equal(boxes.length, ROSTER.length, 'every roster model stays visible so it can be re-ticked')
    assert.deepEqual(boxes.map((box) => box.props.checked), [false, true, false])
    assert.ok(boxes.every((box) => box.props.disabled === false), 'manual mode makes the ticks editable')
    assert.ok(React.textOf(mounted.tree).includes('已选 1 / 3'))
  })
})

test('a row names the image input and the effort levels it actually has', async () => {
  const { section } = mountSection()
  const roster = [...ROSTER, CAPABLE]
  await withFetch({ signedIn: true, roster, enabledModelIds: [] }, async () => {
    const mounted = await React.mount(section.component, section.registration.inject())
    const rows = React.findAll(mounted.tree, (node) => node.type === 'li')

    assert.equal(rows.length, roster.length)
    const byName = new Map(rows.map((row) => [React.findAll(row, (node) => node.type === 'span' && String(node.props.className ?? '').includes('dsm-comate-item-name'))[0].children[0], React.textOf(row)]))

    const capable = byName.get('Deepseek V4.1 Flash')
    assert.ok(capable.includes('1M 上下文'), 'the context window still leads the column')
    assert.ok(capable.includes('图片输入'), 'a vision model says so without opening the composer')
    assert.ok(capable.includes('推理 Low / High / Max'), 'the levels come from the roster, not a guess')

    const textOnly = byName.get('Kimi-K2.6')
    assert.equal(textOnly.includes('图片输入'), false, 'a model the roster does not mark as vision stays silent')
    assert.equal(textOnly.includes('推理'), false, 'a model without effort levels does not advertise an empty control')
  })
})

test('switching to manual mode seeds the draft from the whole roster', async () => {
  const { section } = mountSection()
  await withFetch({ signedIn: true, roster: ROSTER, enabledModelIds: [] }, async () => {
    const mounted = await React.mount(section.component, section.registration.inject())

    const manual = React.findAll(mounted.tree, (node) => node.type === 'button' && React.textOf(node) === '手动选择')
    assert.equal(manual.length, 1)
    manual[0].props.onClick()

    await mounted.rerender()
    const boxes = React.findAll(mounted.tree, (node) => node.type === 'input')
    assert.ok(boxes.every((box) => box.props.checked === true), 'starting from "everything" and then narrowing is the expected flow')
    assert.ok(boxes.every((box) => box.props.disabled === false))
  })
})

test('a save posts the draft and reports the value the Host read back', async () => {
  const { section } = mountSection()
  const state = { signedIn: true, roster: ROSTER, enabledModelIds: [] }

  await withFetch(state, async (stub) => {
    const mounted = await React.mount(section.component, section.registration.inject())

    // Narrow through the UI rather than through state, so the toggle path is
    // exercised: manual mode starts from "all three", and each click removes one.
    const manual = React.findAll(mounted.tree, (node) => node.type === 'button' && React.textOf(node) === '手动选择')
    manual[0].props.onClick()
    await mounted.rerender()

    const boxes = React.findAll(mounted.tree, (node) => node.type === 'input')
    boxes[1].props.onChange()
    await mounted.rerender()

    // Answer the save the way the Host does: confirm the normalized value.
    const posted = []
    globalThis.fetch = async (input, init) => {
      posted.push({ url: String(input), init })
      if (String(input).endsWith('/__save')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, value: [ROSTER[1].id] }) }
      }
      return { ok: true, status: 200, json: async () => state }
    }

    const save = React.findAll(mounted.tree, (node) => node.type === 'button' && React.textOf(node) === '保存')
    assert.equal(save[0].props.disabled, false, 'a changed draft is saveable')
    save[0].props.onClick()

    for (let tick = 0; tick < 12; tick += 1) await Promise.resolve()
    await mounted.rerender()

    const write = posted.find((call) => call.url.endsWith('/__save'))
    assert.ok(write !== undefined, 'the save never reached the Host write route')
    assert.equal(write.init.method, 'POST')
    assert.equal(write.init.credentials, 'same-origin')
    assert.deepEqual(JSON.parse(write.init.body), {
      field: 'enabledModelIds',
      value: [ROSTER[0].id, ROSTER[2].id],
    })

    // The Host answered with a different (normalized) list; the card must show
    // what the document holds, not what it asked for.
    const text = React.textOf(mounted.tree)
    assert.ok(text.includes('已保存'), 'a confirmed save is announced as confirmed')
    assert.ok(!text.includes('未确认'), 'a confirmed save must not be labelled unconfirmed')
    assert.ok(text.includes('已选 1 / 3'), 'the card reflects the value the Host read back')

    globalThis.fetch = stub.fetch
  })
})

test('a 404 from the write route falls back to the scope and says the save is unconfirmed', async () => {
  const { section } = mountSection()
  const state = { signedIn: true, roster: ROSTER, enabledModelIds: [] }

  await withFetch(state, async () => {
    // A Host too old for the write route answers 404; the section may then fall
    // back to writing through the settings scope, but it must not call that
    // confirmed — the scope write is fire-and-forget with no read-back.
    const written = []
    const scope = {
      set: async (field, value) => { written.push({ field, value }); return true },
      getSnapshot: () => ({ value: { enabledModelIds: [ROSTER[0].id, ROSTER[2].id] } }),
    }
    globalThis.fetch = async (input) => (
      String(input).endsWith('/state')
        ? { ok: true, status: 200, json: async () => state }
        : { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
    )

    const props = { ...section.registration.inject(), settingsScope: scope }
    const mounted = await React.mount(section.component, props)
    const boxes = React.findAll(mounted.tree, (node) => node.type === 'input')
    boxes[1].props.onChange()
    await mounted.rerender()

    const save = React.findAll(mounted.tree, (node) => node.type === 'button' && React.textOf(node) === '保存')
    save[0].props.onClick()
    for (let tick = 0; tick < 12; tick += 1) await Promise.resolve()
    await mounted.rerender()

    assert.deepEqual(written.at(-1), { field: 'enabledModelIds', value: [ROSTER[0].id, ROSTER[2].id] })
    assert.ok(React.textOf(mounted.tree).includes('未确认'), 'a scope-only write is never reported as confirmed')
  })
})

test('a refused save keeps the draft and shows the Host error', async () => {
  const { section } = mountSection()
  const state = { signedIn: true, roster: ROSTER, enabledModelIds: [] }

  await withFetch(state, async () => {
    globalThis.fetch = async (input) => {
      if (String(input).endsWith('/state')) return { ok: true, status: 200, json: async () => state }
      return { ok: false, status: 503, json: async () => ({ error: 'settings service unavailable to this fiber' }) }
    }

    const mounted = await React.mount(section.component, section.registration.inject())
    const manual = React.findAll(mounted.tree, (node) => node.type === 'button' && React.textOf(node) === '手动选择')
    manual[0].props.onClick()
    await mounted.rerender()
    const boxes = React.findAll(mounted.tree, (node) => node.type === 'input')
    boxes[0].props.onChange()
    await mounted.rerender()

    const save = React.findAll(mounted.tree, (node) => node.type === 'button' && React.textOf(node) === '保存')
    save[0].props.onClick()
    for (let tick = 0; tick < 12; tick += 1) await Promise.resolve()
    mounted.rerender()

    const text = React.textOf(mounted.tree)
    assert.ok(text.includes('保存失败'), 'a refused save is reported as a failure')
    assert.ok(text.includes('503') || text.includes('unavailable'), 'the Host reason reaches the user')
    assert.ok(text.includes('已选 2 / 3'), 'a failed save leaves the draft alone')
  })
})

test('an empty manual selection cannot be saved', async () => {
  const { section } = mountSection()
  await withFetch({ signedIn: true, roster: ROSTER, enabledModelIds: [ROSTER[0].id] }, async () => {
    const mounted = await React.mount(section.component, section.registration.inject())
    const boxes = React.findAll(mounted.tree, (node) => node.type === 'input')
    boxes[0].props.onChange()
    await mounted.rerender()

    const save = React.findAll(mounted.tree, (node) => node.type === 'button' && React.textOf(node) === '保存')
    assert.equal(save[0].props.disabled, true, 'an empty allow list would mean "everything", which is a different intent')
    assert.ok(React.textOf(mounted.tree).includes('至少勾选一个模型'))
  })
})

test('a signed-out account says how to sign in instead of showing an empty list', async () => {
  const { section } = mountSection()
  await withFetch({ signedIn: false, credential: { signedIn: false }, roster: [], enabledModelIds: [] }, async () => {
    const mounted = await React.mount(section.component, section.registration.inject())
    const text = React.textOf(mounted.tree)

    assert.ok(text.includes('未登录'), 'the header reports the sign-in state')
    assert.ok(text.includes('zulu login'), 'the recovery step is named')
    assert.equal(React.findAll(mounted.tree, (node) => node.type === 'input').length, 0)
  })
})

test('a failed /state read offers a retry rather than a blank panel', async () => {
  const { section } = mountSection()
  await withFetch({}, async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'internal error' }) })
    const mounted = await React.mount(section.component, section.registration.inject())
    const text = React.textOf(mounted.tree)

    assert.ok(text.includes('读取模型目录失败'), 'the failure is surfaced')
    assert.ok(text.includes('internal error') || text.includes('HTTP 500'))
    const retry = React.findAll(mounted.tree, (node) => node.type === 'button' && React.textOf(node) === '重试')
    assert.equal(retry.length, 1)
  })
})

test('unmounting releases every slot registration the client took', () => {
  const client = loadClient()
  const { ctx, record } = context()
  client.apply(ctx)

  assert.ok(record.injected.includes('settings.section'))
  assert.ok(record.slots.length >= 1, 'at least the section was registered')
  const before = record.slots.length

  // `apply` wraps its cleanup in `ctx.effect`; running every recorded disposer
  // is what a Host does when the module unloads.
  for (const dispose of record.effects.splice(0)) dispose()
  assert.ok(record.slots.length < before, 'the section registration was released with the module')
})
