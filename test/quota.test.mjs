/**
 * Model-catalog mapping tests.
 *
 * The roster Comate returns is not in the units DSH consumes. `maxContextWindow`
 * is expressed in *thousands* of tokens (ERNIE 5.5 reports 1000 and describes
 * itself as "1M context"), while `LlmModelInfo.context.contextWindow` is a plain
 * token count. Getting that wrong does not throw — the conversation just starts
 * compacting after a thousand tokens — so the conversion is pinned here.
 *
 * @module dsh-connect-comate/test/quota
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fetchModels, invalidateComateCaches } from '../lib/quota.js'

/**
 * Replace the global `fetch` for the duration of one test.
 *
 * @param body - JSON body the stub should answer with.
 * @returns the request log plus a restore callback.
 */
function stubFetch(body) {
  const previous = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return {
    calls,
    restore() {
      globalThis.fetch = previous
    },
  }
}

const license = { kind: 'license', value: 'test-license', source: 'test' }

test('maxContextWindow is read as thousands of tokens', async () => {
  invalidateComateCaches()
  const stub = stubFetch({
    status: 'OK',
    data: {
      models: [
        { modelId: 'ernie', displayName: 'ERNIE', maxContextWindow: 1000, modelDescription: '1M context' },
        { modelId: 'glm', displayName: 'GLM', maxContextWindow: 200 },
        { modelId: 'deepseek', displayName: 'DeepSeek', maxContextWindow: 1024 },
      ],
    },
  })
  try {
    const models = await fetchModels({ credential: license, userAgent: 'test/1.0' })
    const byId = Object.fromEntries(models.map((model) => [model.id, model]))
    assert.equal(byId.ernie.contextWindow, 1_000_000)
    assert.equal(byId.glm.contextWindow, 200_000)
    assert.equal(byId.deepseek.contextWindow, 1_024_000)
  } finally {
    stub.restore()
    invalidateComateCaches()
  }
})

test('a model without a context window omits the field instead of guessing', async () => {
  invalidateComateCaches()
  const stub = stubFetch({
    status: 'OK',
    data: {
      models: [
        { modelId: 'no-window', displayName: 'No Window', maxContextWindow: null },
        { modelId: 'zero', displayName: 'Zero', maxContextWindow: 0 },
      ],
    },
  })
  try {
    const models = await fetchModels({ credential: license, userAgent: 'test/1.0' })
    for (const model of models) {
      assert.equal(model.contextWindow, undefined)
      assert.equal(Object.hasOwn(model, 'contextWindow'), false)
    }
  } finally {
    stub.restore()
    invalidateComateCaches()
  }
})

test('an unsigned-in account still gets the auto fallback', async () => {
  invalidateComateCaches()
  const stub = stubFetch({ status: 'OK', data: { models: [] } })
  try {
    const models = await fetchModels({ credential: undefined, userAgent: 'test/1.0' })
    assert.deepEqual(models, [{ id: 'auto', name: 'Auto', description: '让 Comate 自行选择模型' }])
    // No credential means no network call at all.
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
    invalidateComateCaches()
  }
})

test('the credit multiplier is parsed from the roster string form', async () => {
  const { parseRatio } = await import('./../lib/quota.js')
  // The roster publishes `"0.3x"`, not 0.3 — a numeric-only read drops every
  // multiplier, which silently disables relative spend reporting.
  assert.equal(parseRatio('0.3x'), 0.3)
  assert.equal(parseRatio('1x'), 1)
  assert.equal(parseRatio('0.1x'), 0.1)
  assert.equal(parseRatio(0.5), 0.5)
  assert.equal(parseRatio('2'), 2)
  assert.equal(parseRatio(''), undefined)
  assert.equal(parseRatio('abc'), undefined)
  assert.equal(parseRatio(0), undefined)
  assert.equal(parseRatio(undefined), undefined)
})

test('a roster entry carries its multiplier through', async () => {
  stubFetch({ status: 'OK', data: { models: [{ modelId: 'm1', displayName: 'M1', ratio: '0.3x', maxContextWindow: 200 }] } })
  const { fetchModels, invalidateComateCaches } = await import('./../lib/quota.js')
  invalidateComateCaches()
  const models = await fetchModels({ credential: { kind: 'license', value: 'ratio-fetch-1' }, userAgent: 'test' })
  assert.equal(models[0].ratio, 0.3)
})

test('image support survives the roster mapping', async () => {
  invalidateComateCaches()
  const stub = stubFetch({
    status: 'OK',
    data: {
      models: [
        { modelId: 'sees', displayName: 'Sees', supportImage: true },
        { modelId: 'blind', displayName: 'Blind', supportImage: false },
        { modelId: 'unknown', displayName: 'Unknown' },
      ],
    },
  })
  try {
    const models = await fetchModels({ credential: license, userAgent: 'test/1.0' })
    const byId = Object.fromEntries(models.map((model) => [model.id, model]))
    // `undefined` and `false` both mean "do not advertise image input"; only an
    // explicit `true` is evidence that a picture can be read.
    assert.equal(byId.sees.supportsImage, true)
    assert.equal(byId.blind.supportsImage, false)
    assert.equal(byId.unknown.supportsImage, false)
  } finally {
    stub.restore()
    invalidateComateCaches()
  }
})

test('effort levels come only from an effortConfig, never from supportEffort', async () => {
  invalidateComateCaches()
  const stub = stubFetch({
    status: 'OK',
    data: {
      models: [
        {
          modelId: 'has-levels',
          displayName: 'Has Levels',
          supportEffort: 'max',
          effortConfig: {
            paramKey: 'effort',
            defaultLevel: 'max',
            levels: [{ label: 'Low', value: 'low' }, { label: 'High', value: 'high' }, { label: 'Max', value: 'max' }],
          },
        },
        // A single `supportEffort` string names *one* depth, not a set to pick
        // from. Inventing levels from it would offer choices the model rejects.
        { modelId: 'only-a-string', displayName: 'Only A String', supportEffort: 'medium', effortConfig: null },
        {
          modelId: 'odd-default',
          displayName: 'Odd Default',
          effortConfig: { defaultLevel: 'nope', levels: [{ label: 'Low', value: 'low' }, { label: 'Low again', value: 'low' }] },
        },
      ],
    },
  })
  try {
    const models = await fetchModels({ credential: license, userAgent: 'test/1.0' })
    const byId = Object.fromEntries(models.map((model) => [model.id, model]))
    assert.deepEqual(byId['has-levels'].reasoning, {
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'high', name: 'High' },
        { id: 'max', name: 'Max' },
      ],
      defaultEffort: 'max',
    })
    assert.equal(byId['only-a-string'].reasoning, undefined)
    assert.equal(Object.hasOwn(byId['only-a-string'], 'reasoning'), false)
    // A default outside the offered levels is replaced by the first real level,
    // and duplicated values collapse: DSH rejects both.
    assert.deepEqual(byId['odd-default'].reasoning, {
      efforts: [{ id: 'low', name: 'Low' }],
      defaultEffort: 'low',
    })
  } finally {
    stub.restore()
    invalidateComateCaches()
  }
})

test('thinking support is read from the roster', async () => {
  invalidateComateCaches()
  const stub = stubFetch({
    status: 'OK',
    data: { models: [{ modelId: 'thinks', displayName: 'Thinks', supportThinking: true }, { modelId: 'plain', displayName: 'Plain' }] },
  })
  try {
    const models = await fetchModels({ credential: license, userAgent: 'test/1.0' })
    const byId = Object.fromEntries(models.map((model) => [model.id, model]))
    assert.equal(byId.thinks.supportsThinking, true)
    assert.equal(byId.plain.supportsThinking, false)
  } finally {
    stub.restore()
    invalidateComateCaches()
  }
})
