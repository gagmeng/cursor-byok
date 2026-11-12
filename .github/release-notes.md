请从下方附件下载对应平台的安装包；Windows 同时提供便携版 ZIP。

## 修复：桌面端启动约两分钟后自行退出

- **原因** — 1.1.5 新增的就绪探测只接受 `HTTP/1.1 200`，而健康端点实际返回 `204 No Content`（它没有响应体）。探测在 120 秒窗口内全部失败，随后进程以状态 1 主动退出。
- **表现** — 应用启动、界面正常打开，但约两分钟后窗口消失、转发服务随之中断。
- **修复** — 探测改为接受任意 `2xx`，仍拒绝非 `2xx` 答复（那只能说明端口上有人监听，不说明是本应用的后端）。
- **连带修复** — 更新替换流程复用同一条就绪链路，此前会把替换后的新进程误报为「启动失败」。

## 改进：Zed 提供商上下文用量统计

- 带 prompt cache 的响应中，`input_tokens` 只代表缓存未命中的部分。插件此前只上报这一份，宿主记录下的上下文体积远小于模型实际读取量，压缩阈值与成本统计同时失真。
- 现在插件上报 `contextInputTokens` = 输入 + 缓存命中 + 缓存写入，宿主优先采用它，缺省时回退到 `inputTokens`。
- Anthropic、OpenAI Responses 与 Google 三条协议路径均已覆盖。
- Zed 插件图标更新为官方版本。

## 升级说明

- 本轮无数据库迁移，schema 保持在 15。
- Zed 插件版本升至 `0.1.1`，首次启动时会覆盖磁盘上的旧插件目录，新的用量统计随之生效。

## 验证

- 修复前：旧二进制在 17:30:27 启动，17:32:29 报「未就绪」并退出，正好 122 秒。
- 修复后：新二进制连续运行 9 分 24 秒（越过两个 120 秒窗口），健康端点稳定返回 `204`，日志零新增错误。
- 本地回归通过：格式检查、Clippy、全量 Rust 测试、前端类型检查与构建。
- 就绪探测新增三个测试，均使用真实健康端点的 `204`，另有一个 `503` 的反向用例。

---

## English summary

- **Startup fix:** the 1.1.5 readiness probe accepted only `HTTP/1.1 200`, but the health endpoint answers `204 No Content`. Every startup failed the probe for the full 120 s window and then exited with status 1, so the app closed itself about two minutes after launch. The probe now accepts any `2xx` and still rejects non-`2xx` replies. The update handshake shares this path, so a replaced process would also have been reported as failed to start.
- **Zed usage accounting:** prompt-cached responses report `input_tokens` as only the uncached remainder. The plugin now sends `contextInputTokens` (input + cache read + cache write) across the Anthropic, OpenAI Responses, and Google paths, and the host prefers it over the `inputTokens` fallback.
- **Upgrade:** no schema change (stays at 15); the Zed plugin moves to `0.1.1` so existing installs pick up the new provider source.
- **Validation:** the old binary exited 122 s after launch; the fixed binary ran 9m 24s across two 120 s windows with a steady `204` health reply and no new log errors. Formatting, Clippy, the full Rust suite, and the frontend type check and build passed.
