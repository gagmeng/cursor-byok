# 缺陷修复与诊断功能验收 · 2026-11-10

已在当前工程集成 [工程评审](./engineering-review-2026-11-10.md) 的 D01–D11 修复，以及“完整连接诊断与首次使用引导”“模型健康与能力测试”。本记录描述当前实现，不将评审中的其他功能建议视为已交付内容。

## 用户入口和行为

| 入口 | 当前能力 | 验证成功的含义 |
| --- | --- | --- |
| 左侧“连接诊断” `#/diagnostics` | CA、模型、接管配置步骤；全新配置自动进入，可稍后完成；本地和 SSH 独立诊断指令及历史 | 请求到达、Cursor 响应订阅、上游有效响应、含诊断标记的成功工具结果各自有时间证据 |
| 左侧“模型健康” `#/model-health` | 最近 7 天实际调用的成功率、成功/失败、取消/进行中、平均首个有效响应、生成速度、最近错误 | 统计排除连通性与能力测试；成功率分母不含取消和进行中 |
| 模型健康中的能力测试 | 单项或全部测试、取消、持久化最后结果 | 每项按语义证据判定通过、失败、未能确认或已取消 |
| 系统设置“设备迁移” | 版本 3 导入/导出，导入预览、失败提示、防重复提交和成功后刷新 | 保留模型标识及备用关系，跳过已有模型/提示词/凭证 |
| 插件卡片“批量导出” | 在当前应用内下载，同源会话鉴权和重启后恢复 | 成功下载服务端附件内容，失败显示错误 |

首次使用顺序：初始化并信任 CA → 配置模型 → 开启接管 → 用户重启 Cursor → 新对话选择模型 → 复制诊断指令 → 逐项确认实际证据。连接诊断会在页面可见时每 3 秒刷新。

本地与 SSH 的诊断标记互相独立，创建后 15 分钟内可以绑定第一次匹配的 Cursor 请求，最多保留最近 10 次记录。窗口类型由用户选择；服务不会自动识别或证明远程操作系统。直接模型测试不创建连接成功证据。终端往返成功也不替代 Tab、Commit、MCP 等功能各自的验证。

能力测试的约束：每项最长 90 秒，全部最多 6 次请求，输出请求参数为 2048 token；收集的文本和思考分别限制为 64 KiB，工具参数为 4 KiB。测试使用独立调用标识，不改写 Cursor 会话历史。提供商自定义额外参数仍遵循原有请求配置语义。

| 能力 | 必须取得的证据 | 未通过的典型情况 |
| --- | --- | --- |
| 流式 | 至少两次非空文本增量，以及完整结束事件 | 只有单个文本事件为“未能确认”；没有结束事件为失败 |
| 工具 | `diagnostic_echo`、精确 JSON 参数、模拟结果后的第二轮继续生成 | 只有文本声称支持工具、错误参数或没有消费结果均失败 |
| 图片 | 将生成的红色 PNG 实际作为图片输入，并识别为 red | 不支持图片或回答颜色错误 |
| 缓存续接 | 两轮固定上下文、正确回忆 BLUE，以及提供商报告读取缓存 token | 续接成功但没有报告命中为“未能确认” |

## 已确认缺陷的处理

| 编号 | 修复后的用户可见规则 | 主要实现和回归 |
| --- | --- | --- |
| D01 | 会话闲置不导致当前会话头及祖先被回收；较新的脱离分支保留 24 小时恢复窗口；历史残缺引用由前向迁移清理 | `store/maintenance.rs`：`idle_conversations_resume_with_the_same_history_after_pruning_and_restart`；`store/migrations.rs`：`repairing_a_dangling_head_allows_the_same_conversation_to_resume` |
| D02 | 模型身份独立于名称、地址和密钥；编辑不打断备用、Commit、审核或历史调用引用；拒绝缺失、环形、超过 4 跳备用链；被引用的模型须先解除引用再删除 | `store/models.rs`：稳定身份、引用保留、失败事务回滚；`tests/magpie_import.rs`：凭据轮换后导入不重复 |
| D03 | 管理 API 校验字面回环 Host、精确同源 Origin 和浏览器站点来源，要求 HttpOnly/SameSite 会话；模型列表不返回 Key 和自定义 Header 值 | `control/access.rs`、`tests/management_access.rs`；编辑/复制时显式读取完整模型；客户端仅对明确标记的会话失效 401 恢复并重试一次 |
| D04 | 服务启动按持久意图恢复接管，静默启动不依赖 WebView 或状态查询 | `App::serve_on` → `restore_persisted_intent`；隔离子进程回归不发状态请求也启动代理 |
| D05 | 状态 GET 只读；刷新不改写 Cursor 设置、不重启 Cursor、不强杀进程 | 删除 `local_app/process.rs`；隔离生命周期测试比较查询前后设置及代理状态 |
| D06 | 接管前保存原值及应用值；关闭和退出只恢复仍属于本应用的键；保留接管期间用户修改 | `local_app/settings.rs`：先持久所有权日志再改设置，覆盖无接管、用户修改、崩溃与重新接管 |
| D07 | 启动即写可读取的原子备份，成功后每日执行；失败一分钟后重试；只保留最近 7 份；随应用取消后台任务 | `app.rs`：临时文件、sync、rename；短会话回归等待完整备份并断言保留数量和任务取消 |
| D08 | 迁移完整保留稳定标识和备用关系，按标识跳过已有提示词和凭证；模型/提示词事务失败不留下半成品 | `control/migration.rs`、`store/models.rs`、`store/model_system_prompts.rs`；插件资源读改写全程持锁，覆盖同时导入不丢账号 |
| D09 | 无关 API 失败不会丢弃成功快照；先发请求的迟到结果不能覆盖后发结果 | `shared/store/appStore.ts`：按域更新、刷新序号、调用列表独立序号；实际 store 隔离执行测试 |
| D10 | 损坏/缺字段/错误版本文件在预览前拒绝；导入期间阻止重复提交；成功后刷新共享模型/插件状态 | `migrationFile.ts` 纯函数回归和真实浏览器导入交互 |
| D11 | 年度热力图独立查询完整 365 个本地自然日；API 接收 IANA 时区，并按当地日界分桶 | `home/overviewDates.ts`、`store/overview.rs`：UTC+8 午夜、纽约夏令时和年度数据边界回归 |

额外集成修复：管理会话不能随外部浏览器共享，因此插件导出改为通过共享 HTTP 客户端取得 Blob 再下载；迁移导出使用同一实现，避免服务重启时静默下载错误文档。浏览器回归验证真实附件内容、文件名、失败提示和会话恢复。

模型选择器显示修复：共享下拉菜单以 420px 为最小目标宽度，并受窗口可用宽度约束，长模型名和供应商分组自动换行。模型健康页的选择框随窗口加宽，悬停可查看完整已选名称；嵌套筛选内按 Escape 只关闭当前模型菜单。新增回归覆盖完整名称、选择后焦点、窗口缩放、嵌套多选和批量选择。

## 当前实际结构

下列为物理行数，包含空行、注释和文件内测试；独立测试文件单列；生成的翻译目录和第三方代码不计入。目录注释是职责，不是行数汇总。

```text
apps/desktop/                                      # 桌面管理与原生壳
├── src/features/diagnostics/                       # 新增：引导、连接证据和模型诊断
│   ├── DiagnosticsPage.tsx                        # 引导与本地/SSH 证据呈现，76 行
│   ├── ModelHealthPage.tsx                        # 健康指标与能力测试操作，68 行
│   ├── diagnosticsStore.ts                        # 快照、刷新顺序和测试生命周期，60 行
│   ├── connectionSteps.ts                         # 证据到步骤状态和指令的纯映射，16 行
│   ├── Diagnostics.module.scss                    # 诊断页布局和状态样式，22 行
│   └── diagnosticsUi.test.mjs                     # 引导/模型选择/导入导出浏览器回归，296 行
├── src/shared/                                    # 同源访问与共享业务快照
│   ├── api.ts                                     # 管理会话、JSON 请求、附件下载，698 行
│   └── store/appStore.ts                          # 各域成功快照与过期响应控制，285 行
└── scripts/test-ui.mjs                             # 构建并运行隔离的浏览器验收

server/                                            # 协议运行、管理和持久化
├── src/app.rs                                     # 装配、启动、可取消备份/维护任务，412 行
├── src/control/                                   # HTTP 管理边界和诊断用例
│   ├── access.rs                                  # 新增：同源管理会话鉴权，110 行
│   ├── diagnostics.rs                             # 新增：诊断 DTO 与 API，112 行
│   └── capabilities.rs                            # 新增：有时间/输出限制的语义探针，369 行
├── src/store/                                     # SQLite 一致性和业务查询
│   ├── diagnostics.rs                             # 新增：证据/结果持久化及健康聚合，171 行
│   ├── models.rs                                  # 稳定模型身份、关系和导入事务，627 行
│   └── maintenance.rs                             # 保留当前会话血统并回收死分支，479 行
├── src/local_app/                                 # 本机 Cursor 接管生命周期
│   ├── mod.rs                                     # 启动恢复、只读状态、开启/关闭接管，307 行
│   └── settings.rs                                # 设置所有权、原值保存与恢复，261 行
├── migrations/                                    # 只新增前向迁移
│   ├── 0013_repair_configuration_references.sql    # 修复会话头与配置悬空引用，32 行
│   └── 0014_connection_diagnostics_and_capabilities.sql # 诊断证据和能力结果表，20 行
└── tests/diagnostics.rs                            # 语义探针与真实本地 HTTP/协议回归，551 行
```

新增模块以诊断职责集中在 `features/diagnostics`、`control` 和 `store`；原有协议、运行、插件和设置仍在原层。删除 `server/src/local_app/process.rs`（原 91 行强制退出 Cursor 的实现）。没有移动、合并既有模块，也没有新增旧格式读取分支；迁移文件只消费版本 3。已应用的 SQLx 迁移文件保持原样。

```text
启动
  → SQLite 前向迁移/修复 → 会话清理（保留当前会话头）
  → 建立 HTTP 监听 → 绑定后端地址 → 按持久意图启动代理/应用设置
  ├→ 原生窗口可见或静默运行
  ├→ 启动即备份 → 每日备份（失败一分钟后重试）
  └→ 每小时回收死分支

桌面页面/用户操作
  → 同源 HTTP 会话 → control（管理所有权边界）
  ├→ connection → local_app 状态 + store 中的实际请求证据
  └→ capability → provider → 独立一轮/两轮探针
                         → 收集事件/限时/取消 → store 最后结果 → 页面

Cursor 新对话中的诊断指令
  → 本地代理 → BidiAppend 输入（匹配标记并绑定请求）
  → RunSSE 订阅（允许订阅先于输入到达）
  → 会话/运行循环 → provider 上游有效响应 → Cursor 工具执行
  → BidiAppend 工具结果 → store 工具轮次 → RunSSE 输出
  → 管理页读取各阶段时间证据

退出
  → 停止代理 → 按所有权恢复设置 → 停止运行/服务
  → 取消备份和维护任务；持久接管意图留给下次启动
```

工具能力探针在服务内模拟结果；完整连接诊断由 Cursor 执行工具，两者的所有权和成功条件独立。后续新增能力可在 `Capability`、探针用例、持久化约束及页面标签处扩展，不需要改变 Cursor 历史投影规则。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `cargo fmt --all -- --check` | 通过 |
| `cargo clippy --workspace --all-targets -- -D warnings` | 通过 |
| `cargo test --workspace --all-targets` | 466 通过，0 失败，2 项真实副本测试默认忽略；25 个测试程序 |
| 两项真实数据库副本测试显式执行 | 2 项均通过，分别测量迁移和清理 |
| `npm --prefix apps/desktop run check` | 类型检查、三种语言完整性和生产构建通过 |
| `npm --prefix apps/desktop test` | 38 项逻辑测试通过；23 项浏览器测试交由下一行执行 |
| `npm --prefix apps/desktop run test:ui` | 23 通过，0 失败，0 跳过；三种语言最小窗口、模型选择、引导、取消、导入及导出交互 |
| `npm --prefix apps/desktop run tauri:build -- --debug --no-bundle` | Windows 调试应用构建通过，产物 `target/debug/cursor-byok-desktop.exe` |
| 6 个内置插件 `deno test --allow-all` | 62 通过，0 失败 |
| `.github/scripts/*.test.mjs` | 8 通过，0 失败 |

浏览器测试用隔离 demo 静态服务和本机 Chromium，不连接用户正在运行的管理服务。CI 已纳入 Node 行为测试、自动启动的隔离浏览器测试和全部内置插件测试。截图位于 `target/review-screenshots/`，详细日志位于 `target/review-*.log`。

既有构建提示仍存在：Vite 大 chunk、Tauri 无效动态导入，以及 Windows Cargo bin/lib 的 PDB 输出命名碰撞提示；本轮构建均成功。没有将打包优化作为本次功能的隐含交付项。

## 真实数据库副本测量

从本机现有数据库通过 SQLite backup API 创建两个隔离副本，分别用于迁移和清理；不写入源数据库。迁移数从 12 增至 14，新增诊断表初始为空。

| 项目 | 前 | 后 |
| --- | ---: | ---: |
| 主数据库字节数 | 18,501,632 | 18,522,112 |
| WAL 字节数 | 0 | 0 |
| 模型 / 系统提示词 | 47 / 1 | 47 / 1 |
| 会话 / 检查点 | 7 / 9 | 7 / 9 |
| 检查点消息 / 消息 | 8 / 8 | 8 / 8 |
| 运行 / 工具轮次 | 2 / 1 | 2 / 1 |
| Blob / 模型调用 | 5,382 / 62 | 5,382 / 62 |
| 外键违规 | 0 | 0 |

新增表带来 20,480 字节增量；该副本没有符合删除条件的数据，保留当前会话头及业务行是预期结果。清理行为另由死分支、宽限期、崩溃恢复和 VACUUM 回归覆盖。年度统计查询在此副本运行 20 次，中位 3,981 微秒，最大 6,222 微秒，仅代表这份数据库与当前机器。可复查 `target/review-storage-measurement.json`、`target/review-measurement.log` 和 `target/review-migration-measurement.log`。

## 实机验证边界

已经覆盖本地真实 HTTP 提供商桩、BidiAppend / RunSSE、KV ACK 和成功 Shell 结果的完整协议链；语义能力使用可控提供商流验证，生命周期使用独立子进程与临时 Cursor 设置。没有安装系统 CA、强制退出或接管真实 Cursor，没有发送真实提供商付费请求，也没有登录真实 SSH 主机。真实 SSH、多平台静默自启和不同提供商的能力仍须在相应环境中运行新诊断入口验收。

当前结果表示已确认的 11 项缺陷已修复并完成上述回归，不表示其余工程代码不存在未知缺陷。
