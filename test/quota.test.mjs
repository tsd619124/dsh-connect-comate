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
