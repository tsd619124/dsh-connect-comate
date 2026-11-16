/**
 * Tests for the settings write path.
 *
 * This is the only place a request can change what the plugin does next, so the
 * failures worth pinning are the quiet ones: a write that resolves without
 * landing, a namespace match that hits a neighbour, and a service-absent case
 * that answers 404 and invites the browser half to paper over it.
 *
 * @module dsh-connect-comate/test/settings
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applySettingsSave, saveFieldOutcome, WRITABLE_FIELDS } from '../lib/settings.js'

/**
 * A settings-service double.
 *
 * @param options.value - what the document holds for this plugin.
 * @param options.ns - the namespace it is served under.
 * @param options.lands - when false, `mutate` resolves but the value never
 *   reaches the document (the silent-failure mode the read-back exists for).
 * @param options.extraRows - other plugins' rows, to catch loose matching.
 * @returns the double plus a record of the writes it received.
 */
function settingsDouble({ value = {}, ns = 'dsh-connect-comate', lands = true, extraRows = [] } = {}) {
  const record = { mutations: [] }
  let document = { ...value }
  const describe = () => [
    { ns, value: { ...document }, revision: 1 },
    ...extraRows,
  ]
  return {
    record,
    describe,
    async mutate(namespace, ops) {
      record.mutations.push({ ns: namespace, ops })
      assert.equal(namespace, ns, 'a write must go to the plugin its own namespace')
      if (!lands) return
      for (const op of ops) if (op.op === 'set') document = { ...document, [op.path[0]]: op.value }
    },
  }
}

test('a save writes the normalized selection and confirms it landed', async () => {
  const settings = settingsDouble()
  const outcome = await applySettingsSave({
    settings,
    field: 'enabledModelIds',
    value: [' glm-5.3_ab ', 'glm-5.3_ab', 'auto', ''],
    candidates: ['dsh-connect-comate'],
  })
  assert.equal(outcome.status, 200)
  assert.equal(outcome.body.ok, true)
  // Normalization happens before the write, so the document never holds the
  // blanks the card might have posted.
  assert.deepEqual(outcome.body.value, ['glm-5.3_ab', 'auto'])
  assert.deepEqual(settings.record.mutations, [{
    ns: 'dsh-connect-comate',
    ops: [{ op: 'set', path: ['enabledModelIds'], value: ['glm-5.3_ab', 'auto'] }],
  }])
})

test('a write that resolves without landing is reported, not called success', async () => {
  // On the 0.2 line `mutate` resolving does not mean the document changed. A
  // save that reported success here is the false "已保存" the read-back prevents.
  const outcome = await applySettingsSave({
    settings: settingsDouble({ lands: false }),
    field: 'enabledModelIds',
    value: ['auto'],
    candidates: ['dsh-connect-comate'],
  })
  assert.equal(outcome.status, 200)
  assert.equal(outcome.body.ok, false)
  assert.equal(outcome.body.errorName, 'read-back-mismatch')
})

test('a field the card is not allowed to write is refused with 400', async () => {
  const settings = settingsDouble()
  for (const field of ['displayName', 'zuluBin', 'constructor', '__proto__', undefined]) {
    const outcome = await applySettingsSave({
      settings,
      field,
      value: 'x',
      candidates: ['dsh-connect-comate'],
    })
    assert.equal(outcome.status, 400, `${String(field)} must not be writable`)
  }
  assert.deepEqual(settings.record.mutations, [])
})

test('only the selection is writable', () => {
  assert.deepEqual(WRITABLE_FIELDS, ['enabledModelIds'])
})

test('a namespace match is exact, so a neighbouring plugin is never written', async () => {
  // `includes()` would also match this row and the write would land in a
  // document belonging to something else.
  const settings = settingsDouble({
    ns: 'dsh-connect-comate-extra',
    extraRows: [],
  })
  const outcome = await applySettingsSave({
    settings,
    field: 'enabledModelIds',
    value: ['auto'],
    candidates: ['dsh-connect-comate'],
  })
  assert.equal(outcome.status, 503)
  assert.match(outcome.body.error, /namespace missing/)
  assert.deepEqual(settings.record.mutations, [])
})

test('the served namespace is tried before the literal constant', async () => {
  const settings = settingsDouble({ ns: 'some-other-entry' })
  const outcome = await applySettingsSave({
    settings,
    field: 'enabledModelIds',
    value: ['auto'],
    candidates: ['some-other-entry', 'dsh-connect-comate'],
  })
  assert.equal(outcome.body.ok, true)
  assert.equal(settings.record.mutations[0].ns, 'some-other-entry')
})

test('an absent settings service answers 503, never 404', async () => {
  // The browser half reads 404 as "this host has no such route" and falls back
  // to an unverified scope write; a missing service must not look like that.
  for (const settings of [undefined, null]) {
    const outcome = await saveFieldOutcome(settings, { field: 'enabledModelIds', value: [] }, {
      candidates: ['dsh-connect-comate'],
    })
    assert.equal(outcome.status, 503)
    assert.equal(outcome.body.error, 'settings service unavailable to this fiber')
  }
})

test('an empty body is a refusal the route can report, not a throw', async () => {
  const outcome = await saveFieldOutcome(settingsDouble(), undefined, {
    candidates: ['dsh-connect-comate'],
  })
  assert.equal(outcome.status, 400)
})
