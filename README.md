# Pi Agent

把 Pi coding agent（`@earendil-works/pi-coding-agent`）接入 Coda。每个 Coda 会话启动一个 `pi --mode rpc` 子进程，由插件在 Coda 的 ACP JSON-RPC 和 Pi 的 JSONL RPC 之间转换。

## 要求

- Pi 由插件自动准备：安装或更新插件后，Coda 运行插件的「准备运行环境」（`agent/setup.mjs`）。这台机器已有 `pi`（设置里的路径、PATH 或下面的常见目录）就直接用；
  没有就用 Coda 自带的 Node 和 npm 把最新的 `@earendil-works/pi-coding-agent` 装进插件自己的状态目录（`$CODA_PLUGIN_STATE/pi`），不动全局。
  装不上时插件页会写原因并给「重试」；也可以自己 `npm i -g @earendil-works/pi-coding-agent`。
- 还要在 Coda 里添加 provider（见下），或在 pi 里完成登录。
- Node 由 Coda 提供（`$CODA_NODE`），插件本身不需要 npm 依赖。
- 直接使用本机 Pi 的配置、登录、扩展与会话目录（`$PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`），插件不复制也不改写它们；Coda 里开的会话也能在 `pi --resume` 里看到。

## 安装

在 Coda 的「设置 › 插件 › 从仓库添加…」中填入 `sealiu1997/coda_plugins_pi_agent`（或 `https://github.com/sealiu1997/coda_plugins_pi_agent`），版本留空即跟随默认分支。

在这台机器上试改请不要用仓库地址，填本机仓库的绝对路径：Coda 只读取已提交的内容，未提交的改动看不到。

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `pi.commandPath` | `pi` | `pi` 可执行文件路径；留为 `pi` 时依次检查 PATH、`~/.npm-global/bin`、`/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`~/.bun/bin`，最后是插件自己装的那份。填了路径却运行不了时，准备运行环境会报错，不另装一份。 |
| `pi.extraArgs` | 空 | 追加到 `pi --mode rpc` 的额外 CLI 参数。 |
| `pi.providers` | 无 | 一行一个 provider：地址、Key（密文）、协议、推理、上下文长度、最大输出。行名就是 Pi 里的 provider 名（不能带 `/`）。 |

## Provider

在 Coda 的「设置 › 插件 › Pi › Provider」里加一行：在「来源」里选别的插件提供的模型服务（如 CLIProxy 插件填好地址和 Key 后提供的「CLIProxy」），
或者自己填 OpenAI 兼容的地址（如 `https://example.com/v1`）和 Key。填完点「检查可用模型」就能看到这个地址列出哪些模型：地址列声明为 Coda 的模型地址（`coda-model-url`），由 Coda 统一检查，选了来源时检查那个服务。不用手写模型：

- 插件启动 Pi 时带上 `agent/providers.mjs` 扩展，它对每一行请求「地址/models」，把列出的模型注册成这个 provider 的模型；Key 从 Coda 的密文文件读（`CODA_PLUGIN_SECRETS`），不进 `models.json`。
- 列表给了上下文长度（OpenRouter 的 `context_length`、vLLM 的 `max_model_len`、llama.cpp 的 `meta.n_ctx_train`）就用它，否则用这一行的「上下文长度」；推理与最大输出取这一行的。
- 刷新：在 Coda 里点「重新读取模型」，Pi 重新启动、重新列。地址暂时连不上时用上次列出的（存在插件状态目录的 `provider-models.json`）。
- 与 `~/.pi/agent/models.json` 里的 provider 同名时，以 Coda 这一行为准。
- 需要支持密文、几列表格、模型服务与「检查可用模型」的 Coda（coda-console/coda#1387、#1410）。

## 协议映射

- `systemPrompt` 写入插件状态目录，并通过 `--append-system-prompt` 生效。
- 模型与推理强度映射为 `configOptions`，并转成 Pi 的 `set_model` / `set_thinking_level`。
- 文本、图片与资源输入转成 Pi `prompt`；输出按 `agent_settled` 结束一轮。
- 工具执行、思考流、会话标题与可用命令映射为 `session/update`。
- `_session/steering` 映射为 Pi `steer`；空闲时返回 `promptRequired`。
- Pi 扩展的确认、选择和输入请求映射为 ACP 审批或表单。
- 执行失败按 Coda 协议分类：上报额度耗尽（`quota_exhausted`）与临时服务故障（`service_unavailable`，`input: "accepted"`）；短时限流（rate limit）刻意保留为普通错误，不自动重试。

## 限制

- 不报告 Pi 后台任务、子 Agent 与定时唤醒（`_coda/wait`）。
- 不回放历史；Coda 保存自己的会话展示。
- 对尚未发过提示词、尚无会话文件的 Pi 会话执行 `session/load` 时，会以该 ID 启动一个空会话，Pi 会输出警告日志。
- 取消依赖 Pi 的 `clear_queue` / `abort`；约 10 秒未停止时会终止 Pi 子进程，后续轮次按需重新启动。
