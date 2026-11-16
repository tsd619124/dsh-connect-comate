/**
 * The write half of the settings page.
 *
 * Everything else this plugin exposes is a read. This one function is the only
 * place a request can change what the plugin will do next, so it is kept out of
 * the entry module and given the narrowest possible contract: one field name,
 * one value, and a read-back that proves the value reached the document.
 *
 * ## Why the write is confirmed by re-reading
 *
 * `settings.mutate()` resolving is not evidence that the value landed. On the
 * 0.2 line it can return while the document keeps its old value, which is
 * exactly the shape of a false "已保存" in the UI. So the row is re-read and
 * deep-compared, and a mismatch is reported as `ok: false` rather than a
 * success the card would have no way to doubt. The sibling plugins arrived at
 * this the hard way (their notes describe a settings page that announced a save
 * which never happened); doing it from the start costs one extra `describe()`.
 *
 * ## Why an absent service is 503 and not 404
 *
 * The browser half falls back to writing through the settings scope when the
 * host route is missing altogether (404). That fallback produces an
 * *unconfirmed* save it then labels as such, so 404 must mean "this host has no
 * such route" — never "this host could not reach its settings service". Those
 * two are different failures with different consequences.
 *
 * @module dsh-connect-comate/settings
 */

import { isDeepStrictEqual } from 'node:util'

import { normalizeModelIds } from './catalog.js'

/**
 * The fields the settings page may write, and how each one is merged.
 *
 * `'list'` replaces the stored value outright with a normalized id list: the
 * selection is a set the user ticked, not a map with siblings to preserve.
 */
const SAVE_FIELDS = {
  enabledModelIds: 'list',
}

/**
 * Read one field out of a settings row, unwrapping a volatile reference.
 *
 * @param row - a row from `settings.describe()`.
 * @param field - the field name.
 * @returns the value the host actually holds, or `undefined`.
 */
function readField(row, field) {
  const value = row?.value
  if (value === null || typeof value !== 'object') return undefined
  const field$ = value[field]
  if (field$ !== null && typeof field$ === 'object' && typeof field$.get === 'function') return field$.get()
  return field$
}

/**
 * Find the settings row this plugin owns.
 *
 * Matching is exact. A substring match would also hit a namespace belonging to
 * some other plugin whose name merely contains ours, and the write would then
 * land in someone else's document.
 *
 * @param rows - `settings.describe()`.
 * @param candidates - the namespaces to try, in priority order.
 * @returns the matching row, or `undefined`.
 */
function findSettingsRow(rows, candidates) {
  for (const candidate of candidates) {
    const exact = rows.find((entry) => String(entry.ns) === candidate)
    if (exact !== undefined) return exact
  }
  return undefined
}

/**
 * Write one field and prove it landed.
 *
 * @param options.settings - the host settings service.
 * @param options.field - which field to write.
 * @param options.value - the value the card posted.
 * @param options.candidates - namespaces to try, in priority order.
 * @returns `{ status, body }` — the HTTP status and the JSON payload.
 */
export async function applySettingsSave({ settings, field, value, candidates }) {
  if (typeof field !== 'string' || !Object.hasOwn(SAVE_FIELDS, field)) {
    return {
      status: 400,
      body: { error: `field must be one of ${Object.keys(SAVE_FIELDS).join(', ')}` },
    }
  }

  const rows = settings.describe()
  const row = findSettingsRow(rows, candidates)
  if (row === undefined) {
    return {
      status: 503,
      body: {
        error: `${candidates.join('/')} namespace missing from describe(); `
          + `known: ${rows.map((entry) => String(entry.ns)).join(', ')}`,
      },
    }
  }

  // The stored value is normalized before it is replaced: a document edited by
  // hand can hold a string where an array belongs, and writing that back would
  // make the picker fall back to "everything" on the next read with no
  // explanation.
  const normalized = SAVE_FIELDS[field] === 'list' ? normalizeModelIds(value) : value

  const ns = String(row.ns)
  await settings.mutate(ns, [{ op: 'set', path: [field], value: normalized }], undefined)

  const readBack = readField(settings.describe().find((entry) => String(entry.ns) === ns), field)
  if (!isDeepStrictEqual(readBack, normalized)) {
    return {
      status: 200,
      body: {
        ok: false,
        errorName: 'read-back-mismatch',
        error: 'settings.mutate returned but the value did not land in the document',
        value: normalized,
        readBack,
      },
    }
  }

  return { status: 200, body: { ok: true, value: normalized, readBack } }
}

/**
 * The `__save` route's verdict, factored out so the service-absent case is
 * assertable without a Host.
 *
 * @param settings - the settings service, or `undefined` when the fiber has none.
 * @param rawBody - the parsed request body; `field` and `value` are read off it.
 * @param options.candidates - the namespaces to try, in priority order.
 * @returns `{ status, body }` — the HTTP status and JSON payload the route sends.
 */
export async function saveFieldOutcome(settings, rawBody, { candidates }) {
  if (settings === undefined || settings === null) {
    return { status: 503, body: { error: 'settings service unavailable to this fiber' } }
  }
  const posted = rawBody ?? {}
  return applySettingsSave({
    settings,
    field: posted.field,
    value: posted.value,
    candidates,
  })
}

/** The fields the card may post, exported so the browser half and tests agree. */
export const WRITABLE_FIELDS = Object.freeze(Object.keys(SAVE_FIELDS))
