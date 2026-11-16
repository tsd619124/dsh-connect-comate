/**
 * Token accounting read from Comate's own session store.
 *
 * The upstream credit endpoint gives a public SaaS account nothing (`data: null`),
 * and the internal-only quota endpoint is unreachable from outside Baidu. What is
 * available is better than a stall: after every turn the CLI writes the turn's
 * real usage into its session store, and it survives the process exiting.
 *
 * The store is `~/.comate-engine/store`:
 *
 * - `cli_chat_sessions.jsonl` — an index (one line per session state change) with
 *   `sessionUuid`, `title`, `workspaceDirectory`, `utime`, `sessionState`. It
 *   carries no usage.
 * - `chat_session_<sessionUuid>` — the detail document. Each assistant message
 *   carries `tokenUsage` (`contextUsed`, `contextLimit`, `usagePercentage`) and
 *   `modelUsage` (`total` plus a per-model breakdown of prompt, completion, cache
 *   read and total tokens).
 *
 * That is what this module reads. It is a courtesy read: every failure path
 * returns `undefined` rather than throwing, because a usage panel that breaks a
 * conversation is worse than one that says "unknown".
 *
 * @module dsh-connect-comate/usage
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Directory the CLI writes its session records to. */
export const STORE_DIR = join(homedir(), '.comate-engine', 'store')

/** The store's index file. */
const INDEX_FILE = 'cli_chat_sessions.jsonl'

/** Detail documents are named with this prefix. */
const DETAIL_PREFIX = 'chat_session_'

/**
 * The store directory, honouring an override for tests.
 *
 * The CLI has no environment variable for this location, so the override exists
 * only so the tests never read the developer's real store.
 *
 * @returns the absolute directory.
 */
function storeDir() {
  const override = process.env.DSH_CONNECT_COMATE_STORE
  return typeof override === 'string' && override !== '' ? override : STORE_DIR
}

/**
 * Read one JSON file, tolerating any failure.
 *
 * @param path - the file to read.
 * @returns the parsed value, or `undefined`.
 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * The newest session detail document in the store.
 *
 * Sessions are written on every turn, so modification time is the right ordering
 * key. The index file is consulted first for the session the CLI itself considers
 * most recent, and the directory is only scanned when that fails.
 *
 * @returns the newest session record, or `undefined`.
 */
export function latestSession() {
  const directory = storeDir()
  const index = readIndex(directory)
  const fromIndex = index.at(-1)
  if (fromIndex !== undefined) {
    const record = readJson(join(directory, `${DETAIL_PREFIX}${fromIndex.sessionUuid}`))
    if (record !== undefined) return record
  }
  return newestDetailDocument(directory)
}

/**
 * Read the index, newest last.
 *
 * @param directory - the store directory.
 * @returns the parsed lines, in file order.
 */
function readIndex(directory) {
  let text
  try {
    text = readFileSync(join(directory, INDEX_FILE), 'utf8')
  } catch {
    return []
  }
  const rows = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      // A half-written trailing line is normal while a turn is in flight.
    }
  }
  return rows
}

/**
 * Scan the store for the most recently modified detail document.
 *
 * @param directory - the store directory.
 * @returns the newest record, or `undefined`.
 */
function newestDetailDocument(directory) {
  let names
  try {
    names = readdirSync(directory)
  } catch {
    return undefined
  }
  let newest
  let newestAt = -1
  for (const name of names) {
    if (!name.startsWith(DETAIL_PREFIX)) continue
    const path = join(directory, name)
    try {
      const at = statSync(path).mtimeMs
      if (at <= newestAt) continue
      newestAt = at
      newest = path
    } catch {
      // Removed between listing and stat; not interesting.
    }
  }
  return newest === undefined ? undefined : readJson(newest)
}

/**
 * Total the per-message usage of a session record.
 *
 * Turns are summed rather than taken from the last message: the question is "what
 * did this conversation cost", and a single turn's numbers answer a different one.
 *
 * @param record - a session detail document.
 * @returns the totals, or `undefined` when the record carries no usage.
 */
export function totalsOf(record) {
  const messages = Array.isArray(record?.messages) ? record.messages : []
  let promptTokens = 0
  let completionTokens = 0
  let cacheReadTokens = 0
  let totalTokens = 0
  let callCount = 0
  let contextUsed
  let contextLimit
  const models = new Map()

  for (const message of messages) {
    const usage = message?.modelUsage
    const total = usage?.total
    if (total !== undefined && typeof total === 'object') {
      promptTokens += numberOr(total.promptTokens)
      completionTokens += numberOr(total.completionTokens)
      cacheReadTokens += numberOr(total.cacheReadTokens)
      totalTokens += numberOr(total.totalTokens)
      callCount += numberOr(total.callCount)
    }
    for (const model of Array.isArray(usage?.models) ? usage.models : []) {
      const id = typeof model?.modelId === 'string' ? model.modelId : undefined
      if (id === undefined) continue
      const entry = models.get(id) ?? { modelId: id, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, totalTokens: 0, callCount: 0 }
      entry.promptTokens += numberOr(model.promptTokens)
      entry.completionTokens += numberOr(model.completionTokens)
      entry.cacheReadTokens += numberOr(model.cacheReadTokens)
      entry.totalTokens += numberOr(model.totalTokens)
      entry.callCount += numberOr(model.callCount)
      models.set(id, entry)
    }
    const tokenUsage = message?.tokenUsage
    if (tokenUsage !== undefined && typeof tokenUsage === 'object') {
      // Context pressure is a property of the newest turn, not a sum.
      if (typeof tokenUsage.contextUsed === 'number') contextUsed = tokenUsage.contextUsed
      if (typeof tokenUsage.contextLimit === 'number') contextLimit = tokenUsage.contextLimit
    }
  }

  if (callCount === 0 && totalTokens === 0) return undefined
  return {
    promptTokens,
    completionTokens,
    cacheReadTokens,
    totalTokens,
    callCount,
    ...(contextUsed === undefined ? {} : { contextUsed }),
    ...(contextLimit === undefined ? {} : { contextLimit }),
    models: [...models.values()].sort((left, right) => right.totalTokens - left.totalTokens),
  }
}

/**
 * A finite non-negative number, or zero.
 *
 * @param value - anything the store may have written.
 * @returns the number, or zero.
 */
function numberOr(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * A short human summary of the newest session's usage.
 *
 * @param totals - from {@link totalsOf}.
 * @param ratioByModel - model id to credit multiplier, from the roster.
 * @returns one sentence, or `undefined` when there is nothing to say.
 */
export function describeTokens(totals, ratioByModel) {
  if (totals === undefined) return undefined
  const parts = [`本会话累计 ${formatTokens(totals.totalTokens)} tokens（${String(totals.callCount)} 次模型调用）`]
  if (totals.promptTokens > 0 || totals.completionTokens > 0) {
    parts.push(`输入 ${formatTokens(totals.promptTokens)} / 输出 ${formatTokens(totals.completionTokens)}`)
  }
  if (totals.cacheReadTokens > 0) parts.push(`缓存命中 ${formatTokens(totals.cacheReadTokens)}`)
  if (totals.contextUsed !== undefined && totals.contextLimit !== undefined) {
    const percent = totals.contextLimit === 0 ? 0 : (totals.contextUsed / totals.contextLimit) * 100
    parts.push(`上下文 ${formatTokens(totals.contextUsed)}/${formatTokens(totals.contextLimit)}（${percent.toFixed(1)}%）`)
  }
  const weighted = weightedCost(totals, ratioByModel)
  if (weighted !== undefined) parts.push(`按模型倍率约 ${weighted.toFixed(1)} 倍额度`)
  return parts.join('，')
}

/**
 * Credit-weighted token cost, when the roster advertises multipliers.
 *
 * Comate prices models as a multiplier on a base rate (`ratio`: 0.1x for the
 * cheapest preview model up to 1x). Without a published unit price that
 * multiplier is the only absolute-ish number available, so it is reported as a
 * multiplier total rather than dressed up as currency.
 *
 * @param totals - from {@link totalsOf}.
 * @param ratioByModel - model id to multiplier.
 * @returns the weighted total, or `undefined` when no ratio is known.
 */
export function weightedCost(totals, ratioByModel) {
  if (ratioByModel === undefined) return undefined
  let weighted = 0
  let matched = false
  for (const model of totals.models) {
    const ratio = ratioByModel(model.modelId)
    if (ratio === undefined) continue
    matched = true
    weighted += model.totalTokens * ratio
  }
  if (!matched) return undefined
  return weighted / 1000
}

/**
 * Format a token count compactly.
 *
 * @param value - the count.
 * @returns `1200` as `1.2k`, `1200000` as `1.2M`.
 */
function formatTokens(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

/**
 * Build a model-id to credit-multiplier lookup from a roster.
 *
 * Matching is exact first and then case-insensitive, because the store records
 * the display name the roster published (`Deepseek V4.1 Flash`) while the roster
 * itself is keyed by the opaque id.
 *
 * @param roster - model entries as `fetchModels` returns them.
 * @returns a lookup returning the multiplier or `undefined`.
 */
export function ratioLookup(roster) {
  const exact = new Map()
  const loose = new Map()
  for (const model of Array.isArray(roster) ? roster : []) {
    if (typeof model?.ratio !== 'number') continue
    if (typeof model.id === 'string') exact.set(model.id, model.ratio)
    if (typeof model.id === 'string') loose.set(model.id.toLowerCase(), model.ratio)
    if (typeof model.name === 'string') {
      exact.set(model.name, model.ratio)
      loose.set(model.name.toLowerCase(), model.ratio)
    }
  }
  return (id) => {
    if (typeof id !== 'string') return undefined
    return exact.get(id) ?? loose.get(id.toLowerCase())
  }
}

/**
 * Read the usage summary for the newest Comate session.
 *
 * @param options - a roster for the multiplier lookup.
 * @returns the totals, the rendered sentence, and the session it came from.
 */
export function readUsage(options = {}) {
  const record = latestSession()
  const totals = totalsOf(record)
  if (totals === undefined) return { available: false }
  const lookup = ratioLookup(options.roster)
  const multiplier = weightedCost(totals, lookup)
  return {
    available: true,
    ...(typeof record?.sessionUuid === 'string' ? { session: record.sessionUuid } : {}),
    ...totals,
    ...(multiplier === undefined ? {} : { creditMultiplier: multiplier }),
    summary: describeTokens(totals, lookup),
  }
}
