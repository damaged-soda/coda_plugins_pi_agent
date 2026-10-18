# Pi Agent

把本机安装的 Pi coding agent（`@earendil-works/pi-coding-agent`）接入 Coda。每个 Coda 会话启动一个 `pi --mode rpc` 子进程，由插件在 Coda 的 ACP JSON-RPC 和 Pi 的 JSONL RPC 之间转换。

## 要求

- 已安装 `pi`，并已配置可用的 provider 或完成登录。
- Node 由 Coda 提供（`$CODA_NODE`），无需本插件安装任何 npm 依赖。
- 直接使用本机 Pi 的配置、登录、扩展与会话目录（`$PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`），插件不复制也不改写它们；Coda 里开的会话也能在 `pi --resume` 里看到。

## 安装

在 Coda 的「设置 › 插件 › 从仓库添加…」中填入 `sealiu1997/coda_plugins_pi_agent`（或 `https://github.com/sealiu1997/coda_plugins_pi_agent`），版本留空即跟随默认分支。

在这台机器上试改请不要用仓库地址，填本机仓库的绝对路径：Coda 只读取已提交的内容，未提交的改动看不到。

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `pi.commandPath` | `pi` | `pi` 可执行文件路径；找不到时依次检查 PATH、`~/.npm-global/bin`、`/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`~/.bun/bin`。 |
| `pi.extraArgs` | 空 | 追加到 `pi --mode rpc` 的额外 CLI 参数。 |

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
