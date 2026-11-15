请从下方附件下载对应平台的安装包；Windows 同时提供便携版 ZIP。

## 思考过程不再是一片空白

- OpenAI Responses 接口请求的思考摘要由「自动」改为「详细」。此前多数服务端只回一行摘要，推理面板看起来像什么都没想。
- Anthropic 只返回加密思考块（`redacted_thinking`）时，面板显示一条说明，而不是空白。加密块本身仍原样回传给上游，不影响后续轮次。

## 限流会等，而不是反复撞门

- 上游返回 429 但没有 `Retry-After` 时，等待时间从 1 分钟开始逐次翻倍，最长 30 分钟。此前固定等 5 秒，八次重试在不到一分钟内全部用光，一个需要等待几分钟的限流最终变成失败。
- 上游给了 `Retry-After` 时仍以它为准；等待时间超过剩余请求预算就不等待，直接结束。

## 上下文超限能正确地压缩

- 识别 Google 风格网关返回的 `context_too_large`。此前它被当作终止性错误，会话无法通过压缩恢复。

## 升级说明

- 本次没有数据库迁移，已有数据库直接使用。
- 限流退避只作用于 429；其他可重试错误（如 5xx）仍按固定的 5 秒重试。

## 验证

- 格式检查、Clippy、全量 Rust 测试、前端类型检查与构建已通过。
- 详细思考摘要、加密思考块占位、`context_too_large` 识别、限流退避与封顶，均有回归测试。

---

## English summary

- **Reasoning is visible:** the Responses API now asks for a `detailed` reasoning summary instead of `auto`, which most implementations satisfy with a single line. When Anthropic returns only an encrypted `redacted_thinking` block, the panel shows a notice instead of staying blank, and the encrypted block still reaches replay unchanged.
- **Rate limits wait:** a 429 without `Retry-After` backs off from one minute and doubles up to a 30-minute ceiling. The previous flat five-second retry spent all eight attempts in under a minute against a limit that outlasts them. A provider-sent `Retry-After` still wins, and no wait starts if it exceeds the remaining request budget.
- **Context overflow:** Google-style `context_too_large` is recognized, so the conversation compacts instead of failing terminally.
- **Upgrade:** no database migration. The backoff schedule applies to 429 only; other retryable failures keep the fixed five-second delay.
