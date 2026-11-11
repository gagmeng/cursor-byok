# V1.1.4 复查缺陷修复与 Magpie 分组同步验收

基线：`ce6143f9c879a0f184462db4e08b7b32b797228e`。对应审查：[V1.1.4 工程复查](./engineering-review-v1.1.4-2026-11-10.md)。本轮处理该报告 R01–R09、六项补充风险，以及用户要求的 Magpie 分组“同步模型”。版本保持 1.1.4；本轮为本地修改与构建，未发布新的 GitHub Release。

**交付行为**

Magpie 操作路径：模型 → 按供应商 → 分组设置 → 同步模型 → 勾选目录中的新模型 → 导入。

- 只有识别到 Magpie 模型的分组显示“同步模型”；读取已经保存的网关地址，保留端口，打开同步弹窗后自动查询。
- 弹窗可修改网关地址并重新查询；已有模型标记为已导入，用户选择本次新增项。
- Magpie 模型按网关 origin 与目录模型 ID 识别，修改显示名或客户端密钥后再次同步仍不会重复导入；已有稳定标识和用户配置保留。
- 旧查询晚到、修改地址、关闭后重开均不会覆盖当前目录；查询失败后可重试；同步提交期间防止重复导入。
- 导入时重新检查目录。选中模型已经从目录消失时整批拒绝并提示重新查询，避免悄悄只导入一部分。
- 分组设置中未保存的草稿不作为同步地址；用户可以先保存分组设置，或在同步弹窗中输入所需网关。

**已确认缺陷的修复**

| 编号 | 修复后的规则 | 实现与回归证据 |
| --- | --- | --- |
| R01 / P1 | 插件运行时不可用时，备份仍包含磁盘上的账号资源。资源损坏导致明确失败，不生成漏账号的成功快照，也不轮换掉最后完整备份。 | `plugin/data.rs` 在插件数据锁内枚举持久资源；`registry.rs` 直接导出私有数据；`app.rs` 连续八次损坏备份失败后原七份完整快照保持不变；集成测试覆盖无运行时。 |
| R02 / P1 | 主模型在输出前遇到 401、403、404 等提供商错误，可以切换用户配置的备用模型。同目标重试和备用切换分别判断。已发文本、思考、工具或明确达到输出限制后不会切换。 | `run/model_cycle.rs` 与 `engine.rs`；FakeProvider 对 401/403/404 和 503 均验证备用完成；工具已输出和 Length 终结回归。 |
| R03 / P2 | 原生直通依据 Chat、Responses、Messages 各自协议的完整结束证据记录成功。截断、无效 JSON、错误事件、观察器失败均不会记成成功。下游未读取响应体就关闭也会收敛为取消。 | `api/byok/direct.rs`；三种协议的完整/不完整流及 JSON 单元测试；本地假上游集成测试验证转发字节不变、健康成功率不误计、未 poll 即丢弃及非流式无效 JSON。 |
| R04 / P2 | 能力测试绑定模型配置修订。编辑、删除或插件配置变化使旧修订失效，迟到测试不会覆盖新配置或复活已删除结果。 | 新增第 15 号迁移，`store/diagnostics.rs` 条件保存；模型事务与插件配置锁；门控 Provider 复现编辑/删除竞态；插件前缀隔离；模型健康页随配置变化刷新。 |
| R05 / P2 | 新进程启动时，将上个进程留下的 running 调用、运行和请求追踪收敛为 cancelled，写入结束时间和中断原因。保留会话检查点。 | `store/recovery.rs`，由 `App::new` 在迁移后调用；隔离重启测试及原有检查点恢复回归。 |
| R06 / P2 | 删除分组是一个事务，先检查组外备用、Commit、审核引用，再解除待删组内部备用关系并整体删除。存在组外引用时整组不变。 | 新增 `/api/models/batch` DELETE；`store/models.rs` 批量删除；集成测试覆盖内部顺序及外部引用，桌面改调批量接口。 |
| R07 / P2 | 共享模型菜单支持方向键、Home、End、Enter、Space；虚拟列表跟随活动项滚动；关闭后恢复触发按钮焦点。 | `shared/ui/ModelSelect.tsx` 保持 listbox 根焦点和 `aria-activedescendant`；浏览器验证第二项、末项、首项及焦点恢复；既有长名称、多选和浮层回归。 |
| R08 / P2 | 概览切换条件时清除旧查询快照；失败显示明确错误并支持刷新。年度活动查询同样提示失败，迟到结果不能替代新条件。 | `features/home/HomePage.tsx`；浏览器注入 503，断言可见错误且旧调用统计不继续展示；新增文案完成中文、英文和葡语目录。 |
| R09 / P2 | 当前项目的下载、教程、徽标和维护入口统一为 `gagmeng/cursor-byok`，保留上游来源及版权说明。 | README、README-CN、AppLayout 与发布技能说明；对照实际 remote 和 updater 入口。 |

**六项补充风险的处理**

| 项目 | 当前实现与验证 | 边界 |
| --- | --- | --- |
| 分组编辑部分成功 | 新增 `/api/models/batch` PUT，在一个事务中更新全部模型、能力修订和结果。最后一项备用引用无效时，第一项配置、修订和旧测试结果均回滚。 | 页面仍先读取完整配置形成提交；服务端原子事务负责最终一致性。 |
| 插件模型开关丢更新 | 目录替换与 enabled 更新统一在 `PluginDataStore::modify` 锁内读改写。12 个并发关闭操作后全部保持关闭。 | 锁属于当前插件数据存储实例，应用正常运行按单实例拥有配置。 |
| 长流与慢订阅者内存增长 | 所有订阅者共享一份可回放输出日志；超过 1 MiB 或 512 帧后转入匿名临时文件。订阅者只有偏移与变更通知，无独立无界帧队列。8 MiB 输出对慢读和重连逐字节完整重放；损坏存储以协议错误结束。追踪直接使用已有有界记录器。 | 未进行系统级 RSS 压测。磁盘占用随总输出增长；日志在拥有者和订阅者均释放后自动清理。落盘采用锁内同步 I/O。 |
| 远程 Git 刷新、并发 clone 和卡住 | refresh 显式 fetch 默认 HEAD；相同 URL 的缓存受 OS 文件锁保护；锁和每个 Git 命令各有 30 秒上限；命令不交互，超时 kill 并回收直接子进程。索引使用提交对应的不可变 worktree，刷新不改正在读取的快照。 | 本地 Git fixture 验证默认分支切换、旧快照保持、四个并发 clone 和挂起子进程；未将其表述为真实 HTTP Git 或 SSH 实测。Git revision 快照保留在缓存中，本轮未增加缓存淘汰。 |
| 插件移除破坏 Commit/审核引用 | 设置写入、移除和能力结果操作共享插件配置锁。仍被 Commit 或审核使用的插件拒绝移除并保留账号；设置插件模型时验证模型描述。 | 回归分别验证两个引用入口；用户须先选择其他模型再移除。 |
| 更新就绪过早与崩溃被标记掩盖 | 桌面等待自身 health HTTP 返回 200 后才写就绪标记；仅端口 bind 不算就绪。更新方先检查新子进程仍存活，再读取标记；就绪总等待改为 180 秒，后台健康等待 120 秒。 | 回归覆盖 bound-but-not-serving、崩溃子进程和既有文件恢复；没有执行真实安装、替换当前运行程序或整套更新故障矩阵。 |

**当前目录职责和变化**

下列为修复后的实际结构。行数为物理行数，包含注释、空行和内联测试；独立测试单列，构建生成物和 i18n 生成目录不计。

```text
E:/cursor-byok/
├── apps/desktop/
│   ├── src/
│   │   ├── features/models/
│   │   │   ├── CursorSettingsPage.tsx             # 分组原子保存/删除与同步入口；592 行
│   │   │   └── MagpieModelImport.tsx              # 网关查询、世代隔离与勾选导入；359 行
│   │   ├── features/home/HomePage.tsx             # 条件对应的统计快照与错误；209 行
│   │   ├── features/diagnostics/
│   │   │   ├── ModelHealthPage.tsx                # 健康显示和测试结果刷新；68 行
│   │   │   └── reliabilityUi.test.mjs             # 四项故障/交互浏览器回归；119 行
│   │   └── shared/ui/ModelSelect.tsx              # 统一模型浮层及键盘导航；262 行
│   └── src-tauri/src/
│       ├── desktop.rs                            # 桌面启动、服务和健康就绪；373 行
│       └── update/replacement.rs                 # 更新替换、握手和回滚；323 行
├── server/
│   ├── src/
│   │   ├── app.rs                                # 依赖装配、启动恢复和定期备份
│   │   ├── control/
│   │   │   ├── models.rs                         # 管理模型 HTTP 用例；169 行
│   │   │   ├── capabilities.rs                   # 能力测试生命周期与修订核对；390 行
│   │   │   └── service.rs                        # 迁移、网关导入和设置用例；1,327 行
│   │   ├── api/byok/direct.rs                    # 原样转发、完整性观察与调用终态；479 行
│   │   ├── plugin/
│   │   │   ├── data.rs                           # 原子 JSON 持久化及资源快照；275 行
│   │   │   ├── state.rs                          # 插件资源和模型读改写；641 行
│   │   │   └── registry.rs                       # 插件配置所有权与运行时调用；1,552 行
│   │   ├── run/
│   │   │   ├── model_cycle.rs                    # 统一模型事件和失败边界；607 行
│   │   │   └── engine.rs                         # 模型/工具循环及备用切换；1,125 行
│   │   ├── cursor/transport/output.rs            # 共享输出日志与偏移订阅；245 行
│   │   └── store/
│   │       ├── models.rs                         # 模型事务、引用约束和修订失效；710 行
│   │       ├── diagnostics.rs                    # 诊断、健康和条件结果保存；212 行
│   │       └── recovery.rs                       # 新进程收敛旧运行终态（新增）；22 行
│   ├── migrations/0015_capability_configuration_revisions.sql
│   │                                             # 持久配置修订（新增）；4 行
│   └── tests/
│       ├── reliability_regressions.rs             # 14 项回归/测量入口（新增）；651 行
│       └── magpie_import.rs                       # 网关与选择导入集成测试；402 行
└── crates/semble-core/src/
    ├── source/remote_git.rs                       # Git 缓存锁、刷新和版本快照；298 行
    └── search/engine.rs                           # 索引查询与 refresh 调度；848 行
```

变化保持现有层次：新增 `store/recovery.rs`、第 15 号迁移和独立回归文件，没有将业务逻辑转入 Tauri IPC。`tempfile` 从 server 和 semble-core 的测试依赖移为正常依赖，复用已有包。

删除旧路径：移除插件数据中分离读写的 `update` 方法、Store 无条件能力结果保存方法、RunSSE 中多余无界追踪队列，以及页面逐项执行的分组写入/删除。它们由原子修改、条件保存、已有有界记录器和批量事务承接；无兼容层。

**完整执行路径与状态边界**

```text
桌面进程启动
  → Store::connect：前向迁移
  → settle_interrupted_calls：旧进程 running → cancelled；保留检查点
  → 装配 Provider / 插件 / transport / 管理 API
  → 立即完整配置备份 → 后续定期备份与维护
  → 服务端口 bind → 恢复保存的接管意图 → HTTP serve
  → 桌面自身 health 请求取得 200 → 写更新就绪标记

Cursor 输入 / BidiAppend / RunSSE
  → transport [request_id 输入与订阅]
  → conversation [当前运行所有权]
  → compile / checkpoint [规范历史与恢复材料]
  → run [模型 ↔ 工具；提交检查点]
      → Provider / 插件 → 上游
      → 输出前 Provider 失败：配置备用 → 新模型调用；否则既有重试/终止
  → OutputHub [唯一日志，内存 → 临时文件]
  → OutputSubscription [每订阅者偏移] → SSE → Cursor

外部 API
  → Key 校验 → 模型映射
  → 同协议 NativeForwarder [原样转发 + 协议观察]
  → 完成 / 错误 / 下游取消 → SQLite 调用终态 → 健康统计
  → 跨协议仍使用既有 Provider 规范化路径

React 管理操作
  → 同源 /__byok-api__/api → control
      → 分组更新/删除 → store 单事务 → 新快照
      → Magpie 查询 → 选择 → 重查目录 → store 去重事务 → 新快照
      → 能力测试 → 捕获修订 → Provider → 核对修订 → 保存或丢弃

退出
  → 既有接管恢复与取消流程 → 关闭会话/传输 → 有界等待退出
```

```text
能力测试： t0 捕获修订 r、发起请求 ──────────────────────→ t2 返回
配置变更：                         t1 同事务 r+1、清旧结果
结果保存：                                              核对仍为 r？
                                                        是：保存
                                                        否：返回未能确认，不持久化

模型删除：保留修订墓碑，阻止旧测试晚到后重新创建结果。
插件变更：持插件配置锁推进修订；保存时同锁验证模型仍存在且启用。

查询重开：关闭/地址变更/再次查询 → 新世代；旧世代响应全部丢弃。
进程重启：创建新的进程生命周期；旧 HTTP 执行权结束，检查点供新运行恢复。
```

**真实数据库副本测量**

对真实数据库只读备份得到 `target/fixes-v1.1.4/real-database-copy.db`，在该副本执行迁移和启动收敛测试。测试限定路径只能是工作区此副本，避免误指向正在使用的数据。

| 指标 | 升级前 | 升级后 |
| --- | ---: | ---: |
| SQLx 迁移条数 | 14 | 15 |
| 数据库字节数（checkpoint 后） | 19,030,016 | 19,038,208 |
| 模型 | 47 | 47 |
| LLM 调用 | 73 | 73 |
| 会话检查点 | 9 | 9 |
| 检查点消息 / 消息 | 8 / 8 | 8 / 8 |
| 能力测试结果 | 8 | 8 |
| 新配置修订表 | 不存在 | 0 |

文件增加 8,192 字节；除迁移记录外，所有原有表行数逐表断言保持不变。完整前后计数在 `database-after.json`。旧迁移均未修改。此测量验证升级与恢复材料保留；新代码处理遗留 running 状态另有隔离重启断言。

**验证和本地产物**

本地证据目录为 `target/fixes-v1.1.4/`。所有修复均保留对应回归；主要缺陷的修复前失败输出也在该忽略目录中，可与通过结果对照。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `cargo fmt --all -- --check` | 通过 | `fmt-final.log` |
| `cargo clippy --workspace --all-targets -- -D warnings` | 通过 | `clippy-final.log` |
| `cargo test --workspace --all-targets` | 491 通过、0 失败、5 ignored，26 个测试目标 | `workspace-tests-final.log` |
| `npm --prefix apps/desktop run check` | TypeScript、Node TypeScript、生产前端构建通过 | `frontend-check-final.log` |
| `npm --prefix apps/desktop test` | 38 通过；34 项浏览器用例由 UI 专用命令另跑 | `frontend-tests.log` |
| `npm --prefix apps/desktop run test:ui`，使用已安装 Edge | 34 通过、0 失败、0 跳过 | `ui-all-final.log` |
| `node --test .github/scripts/*.test.mjs` | 8 通过、0 失败 | `github-scripts-final.log` |
| 真实数据库副本升级和恢复材料保留 | 独立显式执行 1 通过 | `database-upgrade.log`、`database-after.json` |
| Tauri Debug 构建 `--debug --no-bundle` | 通过；Windows x64 PE | `desktop-build-debug-final.log` |
| Tauri Release 构建 `--no-bundle` | 通过；Windows x64 PE | `desktop-build-release-final.log` |
| `git diff --check` | 通过 | 最终工作树检查 |

全量 Rust 中的五项 ignored 分别是两个父测试显式启动的崩溃/挂起子进程 fixture、两项已有的独立数据库维护/历史迁移测量，以及本轮真实数据库副本测量。最后一项已按要求单独执行通过，未把 ignored 计入通过数量。本轮没有修改 `server/plugins/` 中的插件代码。

可复查命令：

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
npm --prefix apps/desktop run check
npm --prefix apps/desktop test
$env:CURSOR_TEST_BROWSER='C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
npm --prefix apps/desktop run test:ui
node --test .github/scripts/*.test.mjs
npm --prefix apps/desktop run tauri:build -- --debug --no-bundle
npm --prefix apps/desktop run tauri:build -- --no-bundle
```

数据库升级测量需要从旧数据库重新创建只读备份到限定副本路径；现有副本已经应用第 15 号迁移，反复运行不能作为另一次 14 → 15 升级证据。

本地构建使用现有 1.1.4 版本号。Debug 产物为 `target/debug/cursor-byok-desktop.exe`，Release 产物为 `target/release/cursor-byok-desktop.exe`；均包含当前前端资源。构建仍有原有 Vite 大块/动态导入提示和 Windows lib/bin 同名 PDB 提示，它们不阻断检查及 EXE 生成。

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| Debug EXE | 98,155,008 | `8AB2E2F1BA6DFC7E7E911D855FDCF229B8E80969F476D2A777FF2CAC1259EF52` |
| Release EXE | 72,251,392 | `F66EAA3B4F9ACA609CF97E47ECF97FC39C3BC7F9CA8F59CEA1CE300F2501E7A9` |

产物 PE machine 均为 `0x8664`；文件时间、大小和完整哈希记录于 `artifacts-final.json`。没有为验证构建而启动程序接管真实 Cursor 或执行真实更新替换。

所有新增模型交互使用本地假网关、FakeProvider 和隔离数据。真实 Cursor SSH 会话、macOS/Linux 原生窗口及完整安装升级仍需对应环境验收；这些边界不由本地测试代替。审查报告中的后续功能建议保留为建议，没有将其全部列为本轮缺陷或已交付功能。
