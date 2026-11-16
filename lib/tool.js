/**
 * The `comate_usage` tool: today's credit spend, readable from the conversation.
 *
 * The provider route already spends the credits, and `/plugins/dsh-connect-comate/usage`
 * exposes them over HTTP, but neither is reachable from a chat turn. A user who
 * asks "how much have I used today" should get an answer without leaving the
 * conversation, so the same read is offered as a tool.
 *
 * The tool is strictly read-only: it reads the CLI credential file and one
 * upstream endpoint. It never spawns `zulu serve`, never writes a credential,
 * and never returns the licence value itself — only the numbers derived from it.
 *
 * @module dsh-connect-comate/tool
 */

import { describeCredential } from './paths.js'
import { fetchModels, fetchQuota } from './quota.js'
import { readUsage } from './usage.js'

/** The tool name users and the model see. */
export const USAGE_TOOL_NAME = 'comate_usage'

/**
 * Render the quota result as the single line the tool card shows.
 *
 * @param quota - from `fetchQuota()`.
 * @returns a short human sentence.
 */
function summarize(quota) {
  if (quota.available === true) {
    const used = quota.usedQuota === undefined ? '未知' : String(quota.usedQuota)
    if (quota.unlimited === true) return `今日已用 ${used} 积分（该账号不限额度）`
    const remaining = quota.remainingQuota === undefined ? '未知' : String(quota.remainingQuota)
    return `今日已用 ${used} 积分，剩余 ${remaining}`
  }
  if (quota.reason === 'not-signed-in') return 'Comate 未登录：先执行 `zulu login`，或设置 COMATE_LICENSE 环境变量'
  if (quota.reason === 'no-data') return 'Comate 没有返回今日积分数据（可能该账号不计费）'
  if (quota.reason === 'unreachable') return '无法连接 Comate 积分接口（检查网络或代理）'
  if (quota.reason === 'rejected') return `Comate 拒绝了积分查询${typeof quota.detail === 'string' ? `：${quota.detail}` : ''}`
  return '未知的积分查询结果'
}

/**
 * Build the tool definition.
 *
 * `output.schema` is what the harness validates the returned value against, so
 * it is written as an object schema with every key the value can carry rather
 * than left as `additionalProperties: true`: the tool card renders from this,
 * and a schema that permits anything renders nothing.
 *
 * @param options - credential reader and attribution.
 * @returns the definition to hand to `tools.register`.
 */
export function buildUsageTool(options) {
  const { readCredential, userAgent } = options

  return {
    name: USAGE_TOOL_NAME,
    description: [
      '查询本机 Comate（文心快码 / Zulu）账号今日消耗的积分与剩余额度。',
      '只读：不改动 Comate 的任何文件，不启动额外进程，也不返回许可证本身。',
      '当用户询问「今天用了多少积分」「还剩多少额度」「Comate 账号状态」时使用。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          available: { type: 'boolean', description: '是否取到了真实积分数据' },
          summary: { type: 'string', description: '一句话结论，可直接展示' },
          tokens: { type: 'string', description: '本会话真实 token 用量（来自 Comate 自己的会话记录）' },
          totalTokens: { type: 'number', description: '本会话累计 token 数' },
          promptTokens: { type: 'number', description: '本会话输入 token 数' },
          completionTokens: { type: 'number', description: '本会话输出 token 数' },
          cacheReadTokens: { type: 'number', description: '本会话缓存命中 token 数' },
          callCount: { type: 'number', description: '本会话模型调用次数' },
          contextUsed: { type: 'number', description: '最近一轮占用的上下文 token 数' },
          contextLimit: { type: 'number', description: '最近一轮的上下文上限' },
          creditMultiplier: { type: 'number', description: '按模型倍率折算的相对额度消耗' },
          usedQuota: { type: 'number', description: '今日已消耗积分' },
          remainingQuota: { type: 'number', description: '今日剩余积分' },
          monthQuotaLimit: { type: 'number', description: '月度积分上限' },
          requestCount: { type: 'number', description: '今日请求次数' },
          unlimited: { type: 'boolean', description: '账号是否不限额度' },
          reason: { type: 'string', description: '取不到数据时的原因代码' },
          signedIn: { type: 'boolean', description: '是否已检测到 Comate 登录态' },
          credentialKind: { type: 'string', description: '凭据类型：license 或 token' },
        },
        required: ['available', 'summary', 'signedIn'],
        additionalProperties: false,
      },
      /**
       * The card shown in the conversation. One line is enough: the numbers are
       * already in `summary`, and a grid of zeros reads as a broken tool.
       *
       * @param _args - this tool takes no arguments.
       * @param value - the value returned by `execute`.
       * @returns the rendered content blocks.
       */
      render(_args, value) {
        const text = typeof value.tokens === 'string' ? `${value.summary}\n\n${value.tokens}` : value.summary
        return [{ type: 'text', text }]
      },
    },
    async execute(_args, execution) {
      const credential = readCredential()
      const described = describeCredential(credential)
      const quota = await fetchQuota({
        credential,
        userAgent,
        ...(execution?.signal === undefined ? {} : { signal: execution.signal }),
      })
      // The credit endpoint answers `data: null` for a public SaaS account, so
      // the real spend is read from the CLI's own session store instead. A
      // roster is only fetched to translate tokens into credit multipliers.
      const roster = await fetchModels({
        credential,
        userAgent,
        ...(execution?.signal === undefined ? {} : { signal: execution.signal }),
      })
      const usage = readUsage({ roster })

      return {
        available: quota.available === true,
        summary: summarize(quota),
        ...(usage.available === true
          ? {
              ...(typeof usage.summary === 'string' ? { tokens: usage.summary } : {}),
              ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
              ...(usage.promptTokens === undefined ? {} : { promptTokens: usage.promptTokens }),
              ...(usage.completionTokens === undefined ? {} : { completionTokens: usage.completionTokens }),
              ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
              ...(usage.callCount === undefined ? {} : { callCount: usage.callCount }),
              ...(usage.contextUsed === undefined ? {} : { contextUsed: usage.contextUsed }),
              ...(usage.contextLimit === undefined ? {} : { contextLimit: usage.contextLimit }),
              ...(usage.creditMultiplier === undefined ? {} : { creditMultiplier: usage.creditMultiplier }),
            }
          : {}),
        ...(quota.available === true
          ? {
              ...(quota.usedQuota === undefined ? {} : { usedQuota: quota.usedQuota }),
              ...(quota.remainingQuota === undefined ? {} : { remainingQuota: quota.remainingQuota }),
              ...(quota.monthQuotaLimit === undefined ? {} : { monthQuotaLimit: quota.monthQuotaLimit }),
              ...(quota.requestCount === undefined ? {} : { requestCount: quota.requestCount }),
              ...(quota.unlimited === undefined ? {} : { unlimited: quota.unlimited }),
            }
          : { reason: String(quota.reason ?? 'unknown') }),
        signedIn: described.signedIn === true,
        ...(described.signedIn === true && typeof described.kind === 'string'
          ? { credentialKind: described.kind }
          : {}),
      }
    },
  }
}
