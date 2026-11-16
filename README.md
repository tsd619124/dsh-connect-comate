# dsh-connect-comate

把本机已登录的 **文心快码（Comate / Zulu）** 接成 DSH 的一个模型 provider，并提供一个只读的积分 / 用量查询工具。

它不做三件事：不启动自己的登录流程、不写 Comate 的任何文件、不解密 IDE 的凭据库。它用的每一样东西都是你已经在用的。

---

## 它做了什么

| 能力 | 落点 | 说明 |
| --- | --- | --- |
| 模型 provider `comate` | `llm.registerAdapter` | 每一轮转接给受监管的本地 `zulu serve`，把它的 SSE 帧翻成 DSH 的 `StreamChunk`；一个 DSH 会话复用一个 Comate 会话 |
| 模型目录 | `llm.listModels` / `resolveModel` | 读 Comate 的账号级模型清单；拿不到时退回 `auto` |
| 设置页 `Comate` | `settings.section`（order 36） | 在 Settings 里勾选**要用哪几个模型**，没勾的不进模型选择器 |
| 提问转述 | `lib/turn.js` | Comate 中途中止等用户选择时，把问题渲染成一条可见回复，你答一句它就接着做 |
| 推理等级 | `llm.resolveModel` → `reasoning` | 按 Comate 自己给的档位（`low / high / max`）在模型选择器里开关；只有真的带 `effortConfig` 的模型才声明 |
| 图片输入 | `llm.resolveModel` → `inputModalities` | 声明能吃图的模型在 DSH 里会收到真实的图片块；插件自己上传后只把数字 id 交给 `zulu serve` |
| 积分 / 用量查询工具 | `comate_usage` | 对话里问「今天用了多少积分 / tokens」，只读：积分走接口，token 走 Comate 自己的会话记录 |
| 只读状态接口 | `/plugins/dsh-connect-comate/{status,state,models,usage,refresh}` | 状态、目录与选择、模型、积分、手动清缓存；全部 GET |
| 唯一写接口 | `POST /plugins/dsh-connect-comate/__save` | 保存模型勾选；走 `settings.mutate` 并回读校验 |

所有 HTTP 路由都只接受回环请求（含 DNS rebinding 与外部 Origin 一律 403）。

---

## 为什么走 `zulu serve`

Comate 在公网上**没有**任何 OpenAI 兼容的聊天端点。实测结论：

| 探测 | 结果 |
| --- | --- |
| `POST /v1/chat/completions` | 405 |
| `POST /api/v1/chat/completions` | 405 |
| `POST /api/openai/v1/chat/completions` | 405 |
| `POST /api/autowork/v1/chat/completions` | 403 |
| `/api/generate` | 代码补全专用，只回 `uuid`，不是聊天 |
| `/api/claudeCode/openapi/get_token` | 404/405（只在百度内网 `comate.baidu-int.com` 上挂） |
| `POST /api/v2/api/models/available` | 200，可用 |
| `GET /api/openapi/v3/agent/daily_cost` | 200，可用（积分） |

唯一受支持的编程接口就是 CLI 的 `zulu serve` 子命令。它把一轮对话流成 SSE，本插件负责翻译。

---

## 前置条件

1. **已安装 Comate**（`/Applications/Comate.app`），自带 `zulu` CLI。
2. **已完成一次 CLI 登录**：

   ```bash
   zulu login
   ```

   这条命令会开浏览器让你确认，凭证落在 `~/.comate/cli-login.json`（SaaS license）或 `~/.comate/login`（内网 token）。

   > 这一步**必须由你手动跑一次**。它是浏览器轮询授权，没有 TTY、没有人点确认就拿不到 token —— 无头环境下它会轮询 180 秒然后放弃，`~/.cot/logs/cot.log` 里能看到 `poll#NN saas token status=BAD_REQUEST ... message=未找到客户端信息`。

3. 想跳过登录或换账号，可以直接给凭证：

   ```bash
   export COMATE_LICENSE=<你的 license>
   ```

   环境变量优先于文件，且不需要重装插件。

---

## 安装

本仓库是一个完整的 bundle（host 半边 + 一个 Settings 页面）。用 DSH 的插件面板装**本地目录**：

```
Plugins（插件）→ 添加插件 → 包名或地址里填入本目录的绝对路径
```

例如 `/Users/you/Documents/deepseek-harness/default-workspace/dsh-connect-comate`。

对话框接受三种输入：npm 包名、GitHub 仓库地址、本地目录路径。本地目录必须是「有效的插件包」（有 `dsh.bundle.patch`），否则会报 `该路径不存在或不是有效的插件包`。

装完在 **Settings → Model providers** 里应该出现一行 `Comate (Zulu)`；在模型选择器里应该出现 `comate` 下的 `auto`（登录成功后还会有具体模型）。

卸载后 `zulu serve` 子进程会随插件 fiber 一起收掉 —— 清理走的是 `ZuluServer.stop()`（SIGTERM，5 秒后 SIGKILL），不是留给系统回收。

---

## 在 Settings 里挑模型

Comate 的账号级目录有十几个模型（Deepseek、GLM、ERNIE、Kimi、MiniMax……），全部塞进模型选择器既难找也没意义。所以插件在 Settings 左侧导航里加了一个 **Comate** 分区（排在 WorkBuddy 之后、插件市场之前）：

- 默认是「跟随上游目录」—— 不写任何配置，选择器里就是账号能用的全部模型。
- 点「手动选择」后勾你想用的，保存即可；没勾的模型**不会出现在模型选择器里**，也不会出现在 `/models` 与模型发现结果里。
- 「至少留一个」是硬约束：勾到 0 个时保存按钮会禁用并提示，因为空选择在语义上等于「跟随上游」，勾 0 个却又想用是矛盾的。
- 「恢复跟随上游」会把配置写回空数组。

写入路径是 `POST /plugins/dsh-connect-comate/__save` → host 侧 `settings.mutate(ns, [{op:'set', path:['enabledModelIds'], value}])`，**写完立刻重新 `describe()` 回读并深比较**；不一致会把「没落地」如实报成失败，而不是假装保存成功。这是刻意的：`mutate` resolve 不代表值真的写进了文档。

配置落在 `dsh-connect-comate` 这个 namespace 的 `enabledModelIds` 里，是一个字符串数组。手改 Settings 文档同样有效，插件每次都重读。

> 已隐藏的模型仍然能 `resolveModel` —— 否则旧会话恢复时会因为「模型不在目录里」直接以 metadata 错误结束。

---

## 用法

### 当模型用

在模型选择器里选 `comate / auto`（或登录后出现的具体模型），然后正常对话。

**一个 DSH 会话 = 一个 Comate 会话**。第一轮把整份 transcript 渲染成 query 发过去并记住这是哪个 conversationId；之后每轮**只发新增的内容**，靠 Comate 服务端自己的会话记忆续上。实测它跨轮、甚至跨 `zulu serve` 进程重启都记得（会话落在 `~/.comate-engine/store`），所以不需要重发历史。

只在四种情况下重开会话（并重发整份 transcript）：transcript 被改写（DSH 侧压缩过）、transcript 变短、切了模型、system prompt 变了。判断逻辑在 `lib/history.js`，每一种都会在日志里写明原因（`comate conversation restart (<reason>)`）。剩下唯一「什么都不发」的情况是 transcript 与上一轮完全相同 —— 那时不会为了空转去重启一个健康的会话。

### 推理等级与图片

Comate 的模型目录里，大部分模型只告诉你「支不支持思考」，只有 `Deepseek V4.1 Flash` 和 `GLM-5.3` 真的给出了**档位**（`low / high / max`，默认 `max`）。插件照着上游说的话做：有档位的模型在 DSH 里就能选推理等级，没档位的**不声明** —— 因为 DSH 对未声明的等级是直接报错（`does not support reasoning effort`），而不是悄悄忽略。宁可选择器里没有这一项，也不要给你一个选了不生效的开关。

图片是另一回事。模型目录里的 `supportImage` 决定插件声明 `inputModalities`：能吃图的模型（当前 6 个：Deepseek V4.1 Flash、ERNIE 5.5 Flash Preview、GLM-5.3-Flash、GLM-5v-Turbo、Kimi-K2.6、MiniMax M3）在 DSH 里会收到真实图片块；其余模型显式声明为纯文本，这时候 DSH 会在组请求前把图片投影成文字占位，**这一轮仍然能用**，而不是发过去让 Comate 报错。

附件目录拿不到时（比如没装 attachment 插件、或 roster 暂时拉不下来），图片会降级成正文里的「图片 N 张（未随文本传递）」，不会让整轮失败。内部版（`ptoken` 登录）目前不支持图片：Comate 的上传端点只认 license，插件会在本地就拒绝，而不是发过去吃一个 401。

### 需要你选择和确认时

Comate 的 `ask_user_question` 触发时，服务端会发一条 `awaiting` 的工具元素然后结束这一轮。插件把它渲染成一条**看得见的提问**，例如：

```
请选择
- 选 A 还是 B（可选：A / B）

直接回答即可，我会把答案转给 Comate 继续这次会话。
```

你直接回复「选 A」，插件会把这句话作为同一 Comate 会话的下一轮发过去，Comate 就接着原来的上下文继续（已端到端验证）。**不需要**重新解释前文，也不需要 `/sessions/:id/tool-results` 那套 resumeToken 协议。

### 查用量

在对话里问「今天 Comate 用了多少 tokens」，或者直接调用 `comate_usage` 工具。它读两处：

1. **积分接口**（`/api/openapi/v3/agent/daily_cost`）—— 公有云 SaaS 账号在这里拿到的是 `data: null`，所以这一半通常报 `no-data`；内网部署能拿到真实数字。
2. **Comate 自己的会话记录**（`~/.comate-engine/store/chat_session_<uuid>`）—— 每条 assistant 消息都带 `tokenUsage` 与 `modelUsage`，这是**真实发生的 token 消耗**，SaaS 账号同样有。

```json
{
  "available": false,
  "summary": "Comate 没有返回今日积分数据（可能该账号不计费）",
  "tokens": "本会话累计 212.1k tokens（7 次模型调用），输入 10.6k / 输出 1.0k，缓存命中 200.4k，上下文 40.0k/1.0M（4.0%），按模型倍率约 63.6 倍额度",
  "totalTokens": 212051,
  "promptTokens": 10597,
  "completionTokens": 1006,
  "cacheReadTokens": 200448,
  "callCount": 7,
  "contextUsed": 40036,
  "contextLimit": 1000000,
  "creditMultiplier": 63.6153,
  "signedIn": true,
  "credentialKind": "license"
}
```

`creditMultiplier` 是把每个模型实际 token 数按其倍率（模型目录里的 `ratio`：`0.1x` 到 `1x`）加权后除以 1000 —— 这是唯一能给出的绝对量级参考，不是货币单位。

未登录时它不会抛错：

```json
{
  "available": false,
  "summary": "Comate 未登录：先执行 `zulu login`，或设置 COMATE_LICENSE 环境变量",
  "reason": "not-signed-in",
  "signedIn": false
}
```

工具**永不返回 license 值本身**，只返回由它推导出的数字。

### HTTP 状态接口

```bash
# 状态：登录态、zulu 路径、serve 端口
curl http://127.0.0.1:52815/plugins/dsh-connect-comate/status

# 目录与当前选择：roster、enabledModelIds、visibleModelIds
curl http://127.0.0.1:52815/plugins/dsh-connect-comate/state

# 模型清单（已按选择收窄）
curl http://127.0.0.1:52815/plugins/dsh-connect-comate/models

# 积分 + 真实 token 用量
curl http://127.0.0.1:52815/plugins/dsh-connect-comate/usage

# 手动失效缓存（60 秒 TTL）
curl http://127.0.0.1:52815/plugins/dsh-connect-comate/refresh

# 保存模型选择（唯一写接口）
curl -X POST http://127.0.0.1:52815/plugins/dsh-connect-comate/__save \
  -H 'content-type: application/json' \
  -d '{"field":"enabledModelIds","value":["glm-5.3_37c550fc6d5b4fb2825abc2c1c88a6b3"]}'
```

读接口都是 GET；非回环请求（含 DNS rebinding 与外部 Origin）一律 403。写接口只接受 `POST` 与 JSON body（上限 64 KiB），非法字段返回 400，namespace 缺失返回 503。

---

## 配置项

Settings 面板里可改，全部 `.volatile()`，改完即生效、不用重启：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `displayName` | `Comate (Zulu)` | 模型选择器里显示的名字 |
| `zuluBin` | 空（自动探测） | `zulu` 启动器路径 |
| `workingDirectory` | 空（跟随会话） | Comate agent 的工作目录；空则跟随 DSH 会话的 workspace |
| `startupTimeoutSeconds` | `30`（5–180） | 等 `zulu serve` 变健康的上限 |
| `enabledModelIds` | `[]`（= 全部） | 模型白名单；一般不用手改，交给 Settings 页面 |

`zuluBin` 的自动探测顺序：配置值 → `~/.comate/zulu-cli/bin/zulu` → `/Applications/Comate.app/Contents/Resources/app/extensions/baiducomate.comate/dist/zulu-cli/bin/zulu` → `$PATH`。

---

## 设计上的几个硬决定

**不重试凭证类失败。** 重试策略走 DSH 自己的 `resolveRetryPolicy`，只允许 `TRANSPORT / TIMEOUT / RATE_LIMIT / SERVER / STREAM_CLOSED`。license 失效、积分耗尽这类失败重试一万次也不会好，只会让你多等。

> 这里踩过一个坑值得记：policy 的形状必须是 `{mode, maxRetries, retryableCodes, initialDelayMs, maxDelayMs, jitterRatio}`。手写 `{maxAttempts}` **不会报错** —— `llm-retry` 读 `policy.mode` 判断有没有上限，读到 `undefined` 就变成无限重试；读 `policy.initialDelayMs` 得到 `NaN`，退避变成 0ms。全绿测试也照样过，因为没有任何一处校验这个对象。

**TOOL 元素不进 transcript，除了「等你回答」的那一个。** Comate 的 agent 自己跑工具循环，它的 `TOOL` 元素描述的是 CLI 正在读哪个文件、跑哪条命令 —— 不是在请求 DSH 执行工具。把它们翻成 `tool-call` 会让 DSH **二次执行**同一件事，所以它们只被计数，不进正文。唯一的例外是 `awaiting` 的 `ask_user_question`：那不是工具调用，是**提问**，被渲染成一段可见文字，你回复的内容就是下一轮。

**一个 DSH 会话复用一个 Comate 会话，只在必要时重开。** 早期版本每轮换新 conversationId 并重发整份 transcript，理由是「`zulu serve` 只有 `query` 一个字段，依赖它的记忆会让 DSH 的压缩对它不可见」。前半句是对的，后半句用真机打探针证伪了：同一个 conversationId 连发两轮，甚至杀掉 `zulu serve` 重启之后，Comate 仍然记得上一轮说的话（会话在 `~/.comate-engine/store`）。所以现在默认复用，只在 transcript 被改写 / 变短 / 换模型 / 换 system prompt 这四种「服务端的世界与 DSH 的世界不再一致」的情况下重开，每次重开都在日志里写明原因。

**推理等级和图片只能走 `POST /session`。** Comate 的 HTTP API 有两个入口：`/api/v1/conversations/:id/messages` 和 `POST /session`。前者的请求白名单只取 14 个字段，`thinkingEnabled` 和 `effort` **不在里面** —— 你在 body 里传了它也不报错，直接丢掉。这正是「设置里能选推理等级但选了没用」的成因。`/session` 反过来把整个 body 交给会话注册表，`registry.configure(sessionId, {model, mode, thinkingEnabled, effort, …})` 会真的写进去，再由上游的 `POST …/v2/execute` 带出去（用本地代理截过包，`"effort":"low"` 与 `"effort":"max"` 确实不同）。代价是 `/session` 的模型字段必须用带哈希的真实 id（`deepseek-v4.1-flash_4827e…`），显示名会 `zulu.service.model.unavailable`；它的终帧是 `{kind:'completed'}` + `{type:'done'}` 而不是 `task_done`。

**图片由插件自己上传，只把数字 id 交给 serve。** `attachImages` 本来接受本地路径，由 `zulu serve` 自己上传 —— 但在 serve 进程里那条路是坏的：上传请求要带 `login-name` 头，而头部值取自 `getAuthInfo()`，serve 的启动路径没走过 license 校验，`authType` 不是 `'license'`，于是头是空的，服务端回 `401 license为空`，整轮变成 `status: exception`。绕法在源码里现成：`attachImages` 的元素若是纯数字字符串，serve 直接 `return {id, name: 'image-N', type:'IMAGE'}`，**跳过上传**。所以插件用 license 自己打 `…/autowork/v1/file/upload`，拿到 `data.id` 再发 `attachImages: ['788264']`，真机回得出图片里的字。上传失败不失败整轮，降级成文本占位。

**端口自己挑，不信 `--port 0`。** `zulu serve --port 0` 会把 `0` 原样回显，pid 文件里也写 `0`，而实际绑定的是内核挑的临时端口。所以本插件在 18810–18899 里自己探一个空闲端口再 spawn。

**鉴权只能靠 CLI 参数。** `zulu serve` 启动时会 `delete process.env.ZULU_SERVE_*`，再从 `--license` / `--ptoken` / `--username` 重建。所以环境变量那条路是死的，凭证必须以参数传；且三者互斥。

**失败也是 HTTP 200。** `zulu serve` 的 SSE 里，一轮失败不是靠状态码表达，而是帧里的 `{type:'task_failed'}` 或 `{kind:'completed', status:'failed'}`。只看 `response.ok` 会把失败当成功。

**空选择 = 跟随上游，不是「一个都不要」。** Comate 的目录会变（换账号、上新模型），把「什么都没勾」解释成「用全部」可以让新模型自动出现。反过来，勾了一个之后又全部取消，也回到全量而不是把选择器清空 —— 后者对用户是坏掉的界面。

**设置页注册用 `slots.inject` 探测，不做永久排队。** `ctx.slots.inject(name, cb)` 本身就是探测：宿主声明了 `settings.section` 才回调，没声明就什么都不做。所以在一个不带 settings UI 的宿主上，插件仍然只有 provider 功能，不会报错也不会留下悬空注册。

**写设置先走 host 端点，404 才退化成 scope 写入。** 客户端拿到的 `settingsScope` 是个镜像，直接 `scope.set` 可能只改了内存。所以客户端先 `POST /__save`，host 用真正的 `settings.mutate` 写文档并回读；只有宿主根本没有这条路由（404）时，才退化到 scope 写入并把结果标成「未确认」。503（host 有路由但这条 fiber 拿不到 settings 服务）**不**退化 —— 那是真的失败，静默降级会让人以为存上了。

---

## 开发

```bash
cd dsh-connect-comate
node --import ./test/register-loader.mjs --test "test/*.test.mjs"
```

118 个测试，全部在无 Host 环境下跑。三处替身：

- `test/loader.mjs` 是 Node loader hook，把 `@deepseek-ai/dsh-llm` 重定向到 `test/fixtures/dsh-llm.js`（镜像真实 base class 的默认方法与 `resolveRetryPolicy` 的形状），把 `@deepseek-ai/schemastery` 指向 profile 里的真实包。
- `test/fixtures/react.js` 是最小 React（`createElement` / `useState` / `useEffect` / `mount`），让 Settings 页能在 Node 里被真正渲染和断言，不需要浏览器。
- `test/usage.test.mjs` 用 `DSH_CONNECT_COMATE_STORE` 把会话存储指到临时目录，绝不读开发机上真实的 `~/.comate-engine/store`。

注意 glob 要加引号，直接写 `node --test test/` 会因为 loader 的交互报错。`test/setup.mjs` 会拦掉**所有非回环** `fetch` —— 测试不该打真实网络，但 `turn.test.mjs` 需要本地 `http.createServer` 喂 SSE，所以回环放行。

测试不进发布包：`package.json` 的 `files` 里没有 `test`。

### 目录

```
index.js             插件入口：注册 provider、发现、工具、路由
client.js            Settings 页：模型勾选（window.__ModuleLoader__ 工厂）
lib/adapter.js       LlmAdapter 实现
lib/zulu.js          zulu serve 的启动、健康门禁、关闭
lib/turn.js          SSE → StreamChunk 翻译，含 awaiting 提问
lib/prompt.js        transcript → query（整份 / 增量两种渲染）
lib/history.js       会话复用与重开判定
lib/usage.js         从 Comate 会话记录读 token 用量
lib/quota.js         模型目录 + 积分（60s 缓存）
lib/catalog.js       模型白名单的选择与收窄
lib/settings.js      /__save 的写入与回读校验
lib/paths.js         只读定位：zulu 路径、凭证
lib/guards.js        回环 / 方法 / JSON 响应守卫
lib/tool.js          comate_usage 工具
locale/{zh,en}.json  插件卡片与工具文案
```

---

## 平台探测（PLATFORM）—— 最容易踩的坑

`zulu serve` 自己决定打哪个 Comate 部署，规则是：

```js
let platform = process.env.PLATFORM || PLATFORM.INTERNAL   // 默认内网
```

枚举值是**小写**（`saas` / `internal` / `poc`），而 `~/.comate/cli-login.json` 里存的是大写
（`"platform": "SAAS"`）。不传 `PLATFORM` 时 CLI 会拿 SaaS 的 license 去打
`comate.baidu-int.com`，TLS 立刻被掐，每一轮都报
`您当前会话执行遇到了异常，请检测网络后重试！`——而 `zulu login`、`zulu status`、
`/api/v2/api/models/available` 全都正常，因为它们走的是另一条读 license 的路径。

插件在 spawn 时按登录文件里的平台注入小写值（`lib/zulu.js` 的 `platformEnv`），
未知平台故意不注入，让 CLI 自己把错误报出来，而不是猜错后变成静默失败。

## 已知边界

- **只支持 SaaS / 内网 / POC 三种部署**，按 `cli-login.json` 的 `platform` 自动注入 `PLATFORM`（见上一节）。内网模型目录与积分端点（`oneapi-comate.baidu-int.com`）在本机不可达，未做端到端验证。
- **SaaS 账号拿不到「剩余多少积分」这个绝对值**。`/api/openapi/v3/agent/daily_cost` 对真实 license 仍返回 `data: null`（带 `login-name` 头、换 `key` 参数、`user/quota` 端点都试过），积分面板是内网 `fetchUserQuota` + `kernel/quota/planUsageStatus` 专有的。作为替代，插件读 Comate 自己写的会话记录（`~/.comate-engine/store`）给出**真实 token 用量**与**按模型倍率折算的相对消耗**，见下一节。
- **未做 Comate IDE 的登录态复用**。IDE 把凭据存在 Electron `safeStorage` 里（`state.vscdb` 的 `comate_login_ID` 等），需要 GUI 授权才能解。CLI 登录是干净路径。
- **文件附件仍未接**。图片已经接上（见上一节）；`attachFiles` 走的是另一套上传与引用格式，没有验证，所以没有转发 —— 附文件时正文里会写明「内容未随文本传递」。
- **需要人工批准时只转述问题，不能代替你点「同意」**。Comate 会发 `awaiting` 的工具元素、并以 `{kind:'requires_action'}` 帧结束这一轮；两条路都渲染成一条可见回复（含选项），**你直接回答即可** —— 答案作为同一会话的下一轮发回去，Comate 接着做完（已端到端验证）。审批类工具（如 `run_command` 的确认）不会自动放行，也不会弹出 DSH 的确认卡片。边角处理：同一个提问会同时以元素和帧到达（按文本去重），而**回答过的提问在下一轮会被服务端重播一遍**，所以只有在那一轮不是正常结束（`ok` / `completed`）时才把提问亮出来。
- **DuMate 不在本仓库里**。DuMate 已另起一个独立插件 `dsh-connect-dumate`（同一作者），与本插件互不依赖、可共存；两者共享的只有三份零依赖小工具（`lib/guards.js`、`lib/catalog.js`、`lib/settings.js`）。那条旧判断里「DuMate 起不来」和「积分类接口走 BCE 签名、没有可验证通路」都在 2026-11-16 被证伪：桌面版能正常启动，模型走的是本机 `dumate-main-server` 上**完全免鉴权**的 `/api/qianfanproxy/v1`，积分走同端口带 `X-Dumate-Inapp-Key` 的 `/api/dumate/points/quota_overview`（那个 key 由 Electron 主进程每启动一次随机生成，从 `dumate-main-server` 的进程环境读）。细节见 `dsh-connect-dumate` 的 README。

---

## 上架

插件市场（`dshmarket`）自己**不含**任何插件条目 —— 它读的是一个独立策展列表：

```
https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
```

上架动作就是在那个仓库里开一个 PR，往 `data/plugins/` 加**一个** YAML 文件（`<owner>__<repo>.yml`），**不要**手工改 README —— README 与站点都是 `node scripts/generate-readme.mjs` 从 YAML 生成的。合并后站点和市场通常一天内自动收录，**不需要**往 dsh-market 仓库提条目。

本插件的条目已经提交：[PR #15843](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/15843)。

条目长这样（`category` 只能取列表里的值；本插件是 `model`）：

```yaml
url: https://github.com/tsd619124/dsh-connect-comate
name: tsd619124/dsh-connect-comate
category: model
icon: https://raw.githubusercontent.com/tsd619124/dsh-connect-comate/main/assets/icon-180.png
description:
  en: ...
  zh: ...
```

和上架有关的元数据，本包都已经带好：

- `engines.dsh`（`>=0.2.0-rc.0 <0.3`）—— 市场卡片用它显示「需要哪个 DSH 版本」。缺了它，卡片只能从 lockstep 的 `@deepseek-ai/dsh-*` peer 里猜。注意 DSH 判定它用的是 `semver.satisfies(..., {includePrerelease:true})`，所以这个范围能匹配 `0.2.2-rc.3`。
- **peer 范围必须写显式预发布分支**（`>=0.2.0-rc.0 <0.3.0-0 || >=0.2.2-rc.0 <0.3.0-0`）。普通 npm peer 解析**不带** `includePrerelease`，只写 `>=0.2.0-rc.0 <0.3` 会匹配不到任何 `0.2.x-rc` 运行时，别人 `npm install` 直接 `ERESOLVE`。验证方式：把 Release 里的 tarball 装进一个空项目，应看到 `added N packages` 且**没有** ERESOLVE 警告。
- `icon` + `exports["./icon"]` + 包内 `icon.svg`（1 KiB，深浅色自适应）—— Settings 导航用 SVG；市场条目另用 `assets/icon-180.png`（GitHub 托管的位图，因为列表**拒绝** SVG 与第三方图床）。
- `assets/` 已进 `files`，`npm pack` 出来的 tarball 里带着它。

为了让别人能装，包还必须能从 npm 装，或给出可用的 GitHub Release tarball：

```
https://github.com/tsd619124/dsh-connect-comate/releases/download/v0.1.0/dsh-connect-comate.tgz
```

> 资产名**不要**带版本号。带版本号时 `releases/latest/download/<name>.tgz` 会 404，因为 GitHub 只把不带版本号的名字当作稳定指向；这是 contributing.md 特意警告过的坑。

本地目录安装只是开发路径，不要写进给用户的安装说明。

自动化门槛（PR CI 会查）：条目数 ≤3、仓库 `package.json` 声明 `dsh.bundle`（只声明 `dsh.client` 会被拒）、仓库创建满 1 天、`awesome-lint` + 站点构建。描述会被逐句对着代码核，"夸大"是主要打回原因 —— 所以本插件的 SaaS 读不到积分、每轮重发整份 transcript 这两条，是**写进描述里**的，不是藏起来的。

---

## License

MIT
