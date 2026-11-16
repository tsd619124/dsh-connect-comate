import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The store path is read at call time, so it can be reseated per test.
const usage = await import(
  '/Users/fengguanjia/Documents/deepseek-harness/default-workspace/dsh-connect-comate/lib/usage.js'
)

/**
 * Write a store fixture and point the reader at it.
 *
 * @param records - session records to write, keyed by uuid.
 * @param index - index rows, oldest first.
 * @returns the directory it wrote.
 */
function store(records, index = []) {
  const directory = mkdtempSync(join(tmpdir(), 'comate-store-'))
  process.env.DSH_CONNECT_COMATE_STORE = directory
  for (const [uuid, record] of Object.entries(records)) {
    writeFileSync(join(directory, `chat_session_${uuid}`), JSON.stringify(record))
  }
  writeFileSync(join(directory, 'cli_chat_sessions.jsonl'), index.map((row) => `${JSON.stringify(row)}\n`).join(''))
  return directory
}

/** A session record carrying the usage shape the CLI really writes. */
function session(uuid, messages) {
  return { sessionUuid: uuid, title: 't', messages }
}

/** One assistant message with a usage block. */
function assistantUsage(prompt, completion, cacheRead, contextUsed, contextLimit, modelId = 'DeepSeek V4.1 Flash') {
  return {
    role: 'assistant',
    tokenUsage: { contextUsed, contextLimit, usagePercentage: 1 },
    modelUsage: {
      total: { promptTokens: prompt, completionTokens: completion, cacheReadTokens: cacheRead, totalTokens: prompt + completion + cacheRead, callCount: 1 },
      models: [{ modelId, promptTokens: prompt, completionTokens: completion, cacheReadTokens: cacheRead, totalTokens: prompt + completion + cacheRead, callCount: 1 }],
    },
  }
}

test('totals sum every turn and keep the newest context pressure', () => {
  const record = session('s1', [
    { role: 'user' },
    assistantUsage(100, 20, 300, 400, 1000),
    { role: 'user' },
    assistantUsage(50, 10, 150, 900, 1000),
  ])
  const totals = usage.totalsOf(record)

  assert.equal(totals.promptTokens, 150)
  assert.equal(totals.completionTokens, 30)
  assert.equal(totals.cacheReadTokens, 450)
  assert.equal(totals.totalTokens, 630)
  assert.equal(totals.callCount, 2)
  assert.equal(totals.contextUsed, 900)
  assert.equal(totals.contextLimit, 1000)
  assert.deepEqual(totals.models.map((model) => model.modelId), ['DeepSeek V4.1 Flash'])
})

test('a record without usage totals to undefined rather than zeroes', () => {
  assert.equal(usage.totalsOf(session('s1', [{ role: 'user' }])), undefined)
  assert.equal(usage.totalsOf(undefined), undefined)
  // A usage block that recorded no calls is not a reading of zero: it is no reading.
  const idle = { role: 'assistant', modelUsage: { total: { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, totalTokens: 0, callCount: 0 } } }
  assert.equal(usage.totalsOf(session('s1', [idle])), undefined)
})

test('models are merged across turns and sorted by size', () => {
  const record = session('s1', [
    assistantUsage(10, 1, 0, 1, 100, 'big-model'),
    assistantUsage(200, 20, 0, 1, 100, 'small-model'),
    assistantUsage(5, 1, 0, 1, 100, 'big-model'),
  ])
  const totals = usage.totalsOf(record)

  assert.deepEqual(totals.models.map((model) => model.modelId), ['small-model', 'big-model'])
  assert.equal(totals.models[1].callCount, 2)
})

test('the newest session is found through the index', () => {
  const store1 = store(
    {
      old: session('old', [assistantUsage(1, 1, 0, 1, 10)]),
      fresh: session('fresh', [assistantUsage(7, 7, 0, 1, 10)]),
    },
    [{ sessionUuid: 'old' }, { sessionUuid: 'fresh' }],
  )
  assert.equal(usage.latestSession().sessionUuid, 'fresh')
  assert.ok(store1.includes('comate-store-'))
})

test('a missing index row falls back to the newest file on disk', () => {
  store(
    {
      a: session('a', [assistantUsage(1, 1, 0, 1, 10)]),
      b: session('b', [assistantUsage(2, 2, 0, 1, 10)]),
    },
    [{ sessionUuid: 'gone' }],
  )
  const record = usage.latestSession()
  assert.ok(record !== undefined && (record.sessionUuid === 'a' || record.sessionUuid === 'b'))
})

test('an unreadable store yields nothing instead of throwing', () => {
  process.env.DSH_CONNECT_COMATE_STORE = join(tmpdir(), 'comate-store-does-not-exist-xyz')
  assert.equal(usage.latestSession(), undefined)
  assert.deepEqual(usage.readUsage(), { available: false })
})

test('the summary reports tokens, context pressure, and relative spend', () => {
  const record = session('s1', [assistantUsage(1000, 100, 5000, 30000, 200000)])
  const totals = usage.totalsOf(record)
  const lookup = usage.ratioLookup([{ id: 'x', name: 'DeepSeek V4.1 Flash', ratio: 0.3 }])
  const summary = usage.describeTokens(totals, lookup)

  assert.match(summary, /本会话累计 6\.1k tokens/)
  assert.match(summary, /1 次模型调用/)
  assert.match(summary, /输入 1\.0k \/ 输出 100/)
  assert.match(summary, /缓存命中 5\.0k/)
  assert.match(summary, /上下文 30\.0k\/200\.0k（15\.0%）/)
  assert.match(summary, /按模型倍率约/)
})

test('the multiplier is matched by id and by display name', () => {
  const roster = [
    { id: 'glm-5.3_abc', name: 'GLM-5.3', ratio: 0.5 },
    { id: 'no-ratio', name: 'Free' },
  ]
  const lookup = usage.ratioLookup(roster)

  assert.equal(lookup('glm-5.3_abc'), 0.5)
  assert.equal(lookup('GLM-5.3'), 0.5)
  assert.equal(lookup('glm-5.3'), 0.5)
  assert.equal(lookup('no-ratio'), undefined)
  assert.equal(lookup(undefined), undefined)
})

test('weighted cost is token-weighted by multiplier, or undefined with no match', () => {
  const totals = usage.totalsOf(session('s1', [assistantUsage(1000, 0, 0, 1, 10, 'glm-5.3_abc')]))
  assert.equal(usage.weightedCost(totals, usage.ratioLookup([{ id: 'glm-5.3_abc', ratio: 0.5 }])), 0.5)
  assert.equal(usage.weightedCost(totals, usage.ratioLookup([{ id: 'other', ratio: 0.5 }])), undefined)
  assert.equal(usage.weightedCost(totals, usage.ratioLookup([])), undefined)
})

test('readUsage combines the newest session with the roster multipliers', () => {
  store({ s1: session('s1', [assistantUsage(1000, 0, 0, 1, 10, 'glm-5.3_abc')]) }, [{ sessionUuid: 's1' }])
  const readout = usage.readUsage({ roster: [{ id: 'glm-5.3_abc', ratio: 0.5 }] })

  assert.equal(readout.available, true)
  assert.equal(readout.session, 's1')
  assert.equal(readout.totalTokens, 1000)
  assert.equal(readout.creditMultiplier, 0.5)
  assert.match(readout.summary, /本会话累计 1\.0k tokens/)
})
