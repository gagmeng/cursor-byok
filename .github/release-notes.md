请从下方附件下载对应平台的安装包；Windows 同时提供便携版 ZIP。

## 可靠性修复

- **插件运行时不可用时备份仍完整** — 备份直接导出磁盘上的账号资源；资源损坏时明确失败，不生成漏账号的成功快照，也不轮换掉最后一份完整备份。
- **主模型失败可切换备用** — 输出前遇到 401/403/404 等提供商错误时切换到用户配置的备用模型；已发出文本、思考、工具或达到输出限制后不再切换。
- **直通成功判定收紧** — Chat、Responses、Messages 三种协议各自依据完整结束证据记录成功；截断、无效 JSON、错误事件以及下游不读响应体就关闭都不再计为成功。
- **能力测试绑定配置修订** — 编辑、删除或插件配置变化使旧修订失效，迟到的测试结果不会覆盖新配置，也不会复活已删除结果。
- **重启后收敛残留调用** — 新进程启动时把上个进程留下的 running 调用、运行和请求追踪标记为 cancelled 并写入中断原因，保留会话检查点。
- **分组删除原子化** — 删除前先检查组外备用、Commit 与审核引用；存在组外引用时整组不变，不会删一半。

## Magpie 分组同步

- 只有识别到 Magpie 模型的分组显示"同步模型"，沿用已保存的网关地址，打开即查询。
- 弹窗内可修改地址重新查询；已有模型标为已导入，只导入本次勾选的新增项。
- 模型按网关 origin 与目录 ID 识别，改显示名或客户端密钥后再次同步不会重复导入，已有配置保留。
- 导入时重新核对目录：选中项已从目录消失则整批拒绝并提示重新查询，不会悄悄只导入一部分。

## 并发与资源

- **插件模型开关不再丢更新** — 目录替换与启用状态更新在同一把锁内读改写。
- **长流内存有界** — 订阅者共享一份可回放输出日志，超过 1 MiB 或 512 帧后转入临时文件，不再为每个订阅者维护无界队列。
- **远程 Git 刷新与并发 clone** — 缓存受文件锁保护，Git 命令 30 秒上限且不交互，超时回收；索引使用与提交对应的不可变 worktree。
- **插件移除保护引用** — 仍被 Commit 或审核使用的插件拒绝移除并保留账号。

## 界面与键盘

- 共享模型菜单支持方向键、Home、End、Enter、Space，虚拟列表跟随活动项滚动，关闭后焦点回到触发按钮。
- 概览切换条件时清除旧快照，失败显示明确错误并支持刷新；年度活动查询同样提示失败，迟到结果不会顶替新条件。
- 更新就绪判定改为等待自身 health 返回 200；更新方先确认新子进程存活再读就绪标记，就绪等待上限 180 秒。

## 验证与升级

- 本地回归通过：491 项 Rust 测试、38 项前端逻辑测试、34 项隔离浏览器测试；格式检查、Clippy、前端类型检查、三种语言完整性和 Windows 调试及优化构建通过。
- 新增第 15 号迁移（`model_capability_revisions`），数据库 schema 由 14 升至 15；现有模型配置、连接诊断和能力测试继续可用。
- 当前项目的下载、教程、徽标和维护入口统一为 `gagmeng/cursor-byok`，保留上游来源与版权说明。

---

## English summary

- **Reliability:** plugin backup keeps on-disk accounts even without a runtime; a main-model 401/403/404 can fall back to the configured backup before any output; direct passthrough only records success on each protocol's complete termination evidence; capability tests bind to a configuration revision; stale running calls are cancelled at startup; group deletion is atomic.
- **Magpie group sync:** groups recognised as Magpie expose a sync dialog that reuses the saved gateway, marks imported models, and rejects the whole batch if a selected model vanished from the catalog.
- **Concurrency:** plugin enable toggles are read-modify-write under one lock; long streams share a bounded replay log that spills to a temp file past 1 MiB or 512 frames; remote Git refreshes are lock-protected with 30 s command timeouts; plugin removal is refused while a Commit or review still references it.
- **Interface:** the model menu is fully keyboard operable and restores focus; overview queries clear stale snapshots and surface errors; update readiness waits for a real health 200.
- **Validation:** 491 Rust tests, 38 frontend logic tests, and 34 isolated browser tests passed locally, alongside formatting, Clippy, type/build, localization, and Windows debug/optimized builds.
- **Upgrade:** adds migration 15 (`model_capability_revisions`); schema moves from 14 to 15 while existing configuration, diagnostics, and capability results keep working.
