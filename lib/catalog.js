/**
 * Which Comate models the picker should offer.
 *
 * The upstream roster is a licence-wide list: a SaaS account can drive fifteen
 * models, and dumping all fifteen into DSH's model picker makes it harder to
 * find the one you actually use. The user's own selection narrows that list.
 *
 * ## The two rules that matter
 *
 * 1. **An empty selection means "everything".** A user who has never opened the
 *    settings page must still find Comate usable, and a plugin that shipped a
 *    model picker with nothing in it would look broken. So `[]` is not
 *    "none selected" — it is "no opinion", and no opinion shows the whole
 *    roster.
 * 2. **A selection that matches nothing means "everything" too.** A stored id
 *    can stop existing: Comate retires models, or the licence changes plan.
 *    Filtering down to zero would leave a picker with a provider row and no
 *    models under it, and the user's only route out would be a settings page
 *    they have no reason to suspect. The roster wins, and the next save
 *    rewrites the selection.
 *
 * @module dsh-connect-comate/catalog
 */

/**
 * Normalize a stored selection into a list of non-empty model ids.
 *
 * The value arrives from a settings document that a person may have edited by
 * hand, so the shape is not guaranteed: anything that is not an array becomes
 * "no opinion", and blank or non-string entries are dropped rather than kept
 * as unmatchable noise.
 *
 * @param value - the raw configured value.
 * @returns the ids to honour, in their stored order.
 */
export function normalizeModelIds(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const ids = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/**
 * Narrow a roster to the user's selection.
 *
 * @param models - the full upstream roster, in serving order.
 * @param enabledIds - the normalized selection; empty means "show everything".
 * @returns the models to offer, never empty when the roster is not.
 */
export function selectModels(models, enabledIds) {
  const ids = normalizeModelIds(enabledIds)
  if (ids.length === 0) return models
  const wanted = new Set(ids)
  const selected = models.filter((model) => wanted.has(model.id))
  // A selection that no longer matches a single model must not empty the picker.
  return selected.length === 0 ? models : selected
}

/**
 * Which ids the picker is actually showing.
 *
 * The settings page needs this to render checkboxes meaningfully: "nothing
 * ticked" and "nothing stored" look the same in the document but behave
 * differently in the picker, so the answer is computed from the same function
 * the picker uses rather than from the stored array.
 *
 * @param models - the full upstream roster.
 * @param enabledIds - the normalized selection.
 * @returns the ids currently offered.
 */
export function visibleModelIds(models, enabledIds) {
  return selectModels(models, enabledIds).map((model) => model.id)
}
