请从下方附件下载对应平台的安装包；Windows 同时提供便携版 ZIP。

## 调用记录可以检索，详情留在应用里

- 调用页可以按状态、模型、会话筛选，并继续加载更早的记录。
- 「查看详情」在应用窗口内打开。进行中的调用会持续刷新，并显示当前阶段：连接、等待首个事件、生成、重试或切换备用模型。
- 列表和详情的列名、状态跟随界面语言。

## 配置备份可以查看和恢复

- 系统设置列出最近 7 份自动备份，以及最近一次备份失败的原因。
- 可以查看与当前配置的差异，然后选择「跳过已有」或「覆盖已有」。恢复前会先写下当前配置。
- 备份包含插件模型目录。目录损坏时这次备份失败，不会换掉已经成功的备份。

## 请求超时可以配置

- 系统设置可以修改单次请求的总超时，以及等待下一个事件的流空闲时间。保存后对下一次模型调用生效。
- 上游返回 429 时按 `Retry-After` 等待，等待时间不超过剩余的总超时。

## 可靠性

- 运行中收到尚未实现的会话动作时，返回明确的协议错误，不再静默丢掉。
- 接管状态会检查 `http.noProxy`。这个键被加回去之后，不再显示为已接管。
- 关闭代理时，如果 5 秒内没有退出，会中止仍在监听的进程。
- 进程异常退出后，下次启动会解除指向已取消运行的会话所有权，检查点仍然保留。
- 远程代码索引只接受 HTTPS。同一仓库并发刷新时，等锁时间覆盖一次完整刷新。

## 升级说明

- 数据库增加第 16 号迁移：调用记录新增 `activity` 列，用来保存重试和备用切换说明。已有数据库启动时自动升级。
- 设备迁移文件仍是版本 3。旧文件可以继续导入；新导出的文件会带上插件模型目录。

## 验证

- 格式检查、Clippy、全量 Rust 测试、前端类型检查与构建已通过。
- 未实现的会话动作、崩溃后的会话所有权、备份失败不轮换、调用分页，均有回归测试。

---

## English summary

- **Calls:** filter by status, model, and conversation, and load older records. Call details stay in the app, keep refreshing while a call is running, and show whether it is connecting, waiting for the first event, generating, retrying, or failing over.
- **Backups:** the last seven automatic backups are listed with the latest failure. A preview compares them with the current configuration; restore can skip or overwrite existing identities, and writes a snapshot of the current configuration first. Plugin model catalogs are included. A corrupt catalog fails that backup instead of replacing a good one.
- **Timeouts:** the per-request budget and the stream idle wait are configurable and apply on the next model call. A 429 waits for `Retry-After` only while time remains in the budget.
- **Reliability:** unsupported in-flight conversation actions return a protocol error. Takeover status stays off when `http.noProxy` is put back. Stopping the proxy aborts a listener that does not exit within 5 seconds. Startup clears conversation ownership that still points at a cancelled run. Remote code indexing accepts HTTPS only, and the cache lock wait covers one full refresh.
- **Upgrade:** migration 16 adds `llm_calls.activity`. Device migration files stay at version 3; older files still import, and new exports include plugin model catalogs.
