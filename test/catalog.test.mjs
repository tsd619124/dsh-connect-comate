/**
 * Tests for the selection rules that narrow the picker.
 *
 * The failure modes here are all silent: an over-eager filter leaves a provider
 * row with no models under it, and an over-eager passthrough puts fifteen models
 * back in a picker the user just cleaned up. Neither throws, so both are pinned.
 *
 * @module dsh-connect-comate/test/catalog
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeModelIds, selectModels, visibleModelIds } from '../lib/catalog.js'

/** A roster shaped like the upstream one, in serving order. */
const ROSTER = [
  { id: 'auto', name: 'Auto' },
  { id: 'glm-5.3_ab', name: 'GLM-5.3' },
  { id: 'deepseek-v4-flash_cd', name: 'Deepseek V4 Flash' },
]

test('an unset selection shows the whole roster', () => {
  // A user who never opened the settings page must still find Comate usable.
  assert.deepEqual(selectModels(ROSTER, []), ROSTER)
  assert.deepEqual(selectModels(ROSTER, undefined), ROSTER)
  assert.deepEqual(selectModels(ROSTER, null), ROSTER)
})

test('a selection narrows the roster and keeps the upstream order', () => {
  const selected = selectModels(ROSTER, ['deepseek-v4-flash_cd', 'auto'])
  // Order comes from the roster, not from the stored array: the upstream order
  // is the one the rest of the catalogue is sorted by.
  assert.deepEqual(selected.map((model) => model.id), ['auto', 'deepseek-v4-flash_cd'])
})

test('a selection that matches nothing falls back to the whole roster', () => {
  // Comate retires models. Filtering to zero would leave a picker with a
  // provider and nothing under it, and no hint about why.
  assert.deepEqual(selectModels(ROSTER, ['retired-model']), ROSTER)
})

test('normalizeModelIds drops blanks, duplicates, and non-strings', () => {
  assert.deepEqual(
    normalizeModelIds([' auto ', 'auto', '', '   ', 7, null, 'glm-5.3_ab']),
    ['auto', 'glm-5.3_ab'],
  )
})

test('normalizeModelIds treats a hand-edited document as no opinion', () => {
  // The settings document is a YAML file a person may edit; a string where an
  // array belongs must not become a one-character model id.
  assert.deepEqual(normalizeModelIds('auto'), [])
  assert.deepEqual(normalizeModelIds({ auto: true }), [])
  assert.deepEqual(normalizeModelIds(undefined), [])
})

test('visibleModelIds reports what the picker is really offering', () => {
  assert.deepEqual(visibleModelIds(ROSTER, []), ['auto', 'glm-5.3_ab', 'deepseek-v4-flash_cd'])
  assert.deepEqual(visibleModelIds(ROSTER, ['auto']), ['auto'])
  // The stale-selection fallback has to be visible through this helper too, or
  // the card would render every box unticked while the picker shows everything.
  assert.deepEqual(visibleModelIds(ROSTER, ['gone']), ['auto', 'glm-5.3_ab', 'deepseek-v4-flash_cd'])
})
