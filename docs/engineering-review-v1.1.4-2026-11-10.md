# V1.1.4 工程复查与功能改进建议

审查日期：2026-11-10。基线：`v1.1.4` / `ce6143f9c879a0f184462db4e08b7b32b797228e`。当前 Git remote：`gagmeng/cursor-byok`。

结论：确认 **9 类问题，其中 2 项 P1、7 项 P2**。8 类有隔离运行或浏览器复现，1 类通过仓库配置和链接直接确认。优先处理配置备份完整性和备用模型失效，再修正健康数据、测试结果和批量操作的一致性。

现有主流程具有清晰的模块边界；本轮选取的 84 项已有后端回归全部通过。新增复现揭示的是原有测试未覆盖的异常和交互边界。发现的问题不能推导为此前修复全部失效，也不能据此证明其余代码没有缺陷。

本轮产物为审查报告和本地复现材料；业务代码、数据库结构及版本号没有修改。临时挂入 Cargo 的复现测试已移出正式测试目录。原有未跟踪目录 `.claude/`、`apps/docs/` 保留。

**一、范围与证据等级**

覆盖主执行路径、SQLite 持久化与恢复、Provider 协议和失败切换、插件运行时与凭证、桌面交互、连接诊断与能力测试、搜索、更新及 CI。采用入口追踪、关键状态边界审查和针对性复现；不是对每行源代码的形式化验证。

| 证据 | 本轮结果 | 说明 |
| --- | --- | --- |
| 新增后端行为断言 | 8 个用例：1 个对照通过、7 个预期失败 | 7 个失败对应 6 类缺陷；修改和删除模型的竞态分别复现。断言表达应有行为，失败用于确认 V1.1.4 的问题。 |
| 隔离浏览器交互 | 2 个场景均复现，页面脚本异常为 0 | 从当前源码重新构建 demo，使用 Edge headless；覆盖模型键盘选择和概览查询失败。 |
| 原有后端回归 | 84 项通过 | 管理访问、诊断、外部 API、检查点恢复、错误生命周期、前缀稳定、工具、压缩、Commit、本地规则。 |
| 文档与实际仓库对照 | 下载和教程仓库不一致 | 通过 remote、README、应用教程地址、updater 地址确认。 |
| 发布平台实测 | 本轮未进行 | Windows 本地后端和浏览器证据不代表 macOS/Linux 原生窗口或真实 SSH 验收。 |

本地证据位于 `target/audit-v1.1.4/`，该目录被 Git 忽略：

```text
target/audit-v1.1.4/                 # 本轮隔离复现证据，不进入发布包
├── backend-probes.rs               # 8 个后端行为断言，仅使用虚拟凭证和临时数据
├── backend-probes.log              # 最终后端复现输出
├── browser-probes.mjs              # 2 个浏览器复现场景和临时静态服务器
├── browser-results.json            # 实际焦点、选项、查询失败和可见状态
├── browser-probes.log              # 浏览器复现输出
├── keyboard-selection.png          # 键盘选择后的界面
├── overview-failed-range.png       # 新范围按钮与旧范围图表同时出现
├── existing-regressions.log        # 第一组 35 项已有回归
├── runtime-regressions.log         # 第二组 49 项已有回归
├── code-measurements.json          # 源码目录和热点文件的实测行数
├── demo-build.log                  # 本轮 demo 构建输出
└── ui-demo/                        # 本轮从基线构建的隔离前端
```

环境：Windows，Rust `1.94.1`，Node `24.12.0`，Edge `157.0.4341.42`。所有上游响应来自本地模拟服务或 FakeProvider。未调用付费模型、安装 CA、开启接管或执行真实 Cursor/SSH 操作。

**二、当前结构与完整主路径**

下列行数为 Git 跟踪源码的物理行数，包含注释、空行及内联测试；独立测试目录单列，构建生成物不计。仅统计 `.rs/.ts/.tsx/.scss/.proto/.yml`，所以不代表整个仓库所有文件大小。协议目录统计的是仓库中的 `.proto`，不是构建生成的 Rust。

```text
E:/cursor-byok/
├── apps/desktop/
│   ├── src/                         # React 桌面管理界面；165 文件 / 15,915 行
│   │   ├── shell/                   # 窗口内导航、页面保活、全局操作
│   │   ├── features/
│   │   │   ├── home/                # 时间范围统计与年度活动
│   │   │   ├── models/              # 模型配置、分组和连通性测试
│   │   │   ├── diagnostics/         # 首次引导、连接证据、模型健康和能力测试
│   │   │   ├── calls/               # 调用列表与详情
│   │   │   ├── plugins/             # 插件账号、授权和模型目录
│   │   │   └── settings/            # 网络、迁移、存储、桌面和更新设置
│   │   └── shared/                  # 同源 HTTP、全局状态、浮层、虚拟列表、主题
│   └── src-tauri/src/               # 进程、托盘、窗口及更新替换；9 文件 / 1,243 行
├── server/
│   ├── src/                         # 服务端业务实现；219 文件 / 55,493 行
│   │   ├── app.rs                   # 依赖装配、启动维护、备份和关停
│   │   ├── api/                     # Cursor 协议入口与外部兼容 API
│   │   ├── control/                 # 管理 HTTP 的用例与状态读取
│   │   ├── cursor/
│   │   │   ├── transport/           # request_id 生命周期、输入排序、SSE 回放
│   │   │   ├── conversation/        # conversation 运行所有权和命令交付
│   │   │   ├── compile/             # 请求上下文编译为 PreparedRun
│   │   │   ├── checkpoint/          # 检查点构建、恢复和客户端 KV 依赖
│   │   │   ├── prompting/           # 静态提示词与工具目录
│   │   │   ├── tools/               # Cursor 工具交互、结果回收和审核
│   │   │   └── services/            # Tab、Commit、模型目录等协议服务
│   │   ├── run/                     # 模型循环、工具往返、压缩、重试和备用切换
│   │   ├── provider/                # 上游适配、响应规范化和调用记录
│   │   ├── plugin/                  # Deno、插件目录、私有状态和 worker
│   │   ├── store/                   # SQLite 事务、配置、历史和诊断持久化
│   │   ├── local_app/               # 本地 CA、代理和 Cursor 设置所有权
│   │   └── search/                  # 网页缓存与 Cursor 所在主机的代码快照
│   ├── migrations/                 # 已应用 SQL 迁移及表结构约束
│   ├── plugins/build-in/           # 6 个内置提供商插件；38 TS 文件 / 10,212 行
│   └── tests/                      # 集成回归与测试支持；22 文件 / 11,771 行
├── crates/semble-core/src/         # 代码索引与检索；30 Rust 文件 / 3,648 行
├── protocols/cursor/               # Cursor 协议定义；6 proto 文件 / 60,757 行
└── .github/workflows/              # CI、手动打包、Release；3 文件 / 506 行
```

```text
桌面启动
  → SQLite 连接、迁移、旧分支回收
  → 装配 Provider / 插件 / 会话 / 管理接口
  → 立即配置备份，后续每天执行；后台每小时维护
  → 绑定服务端口 → 恢复用户保存的接管意图 → 开始服务

Cursor 输入 / 本地或 SSH 工作区
  → 本地 TLS 代理 → BidiAppend 输入 + RunSSE 订阅
  → transport [request_id] → conversation [运行所有权]
  → compile / checkpoint [上下文和恢复边界]
  → run [模型循环 ↔ 工具往返 ↔ 检查点提交]
      → provider 或 Deno worker → 上游模型
      → Cursor 工具执行 → 工具结果 → SQLite
  → 输出事件 → SSE / 客户端 KV → Cursor

外部 Chat / Responses / Messages
  → 外部 API Key 校验 → 保存的模型映射
  → 协议相同：NativeForwarder 原样转发并旁路记录
  → 协议不同：解析 → Provider 统一事件 → 目标协议响应
  → SQLite 调用记录 → 概览 / 模型健康

React 管理界面
  → 同源 /__byok-api__/api + 管理 session
  → control → store / harness / plugin
  → 业务快照 → 组件呈现

退出
  → 关闭接管、恢复 Cursor 设置 → 取消会话和传输
  → 有界等待服务退出
```

模型稳定标识、追加式 Provider 历史、检查点所有权和同源管理接口应继续作为边界。新功能可以在现有目录内逐层增加，不需要引入另一套业务 IPC、历史序列化或数据库访问层。

**三、已确认缺陷与修复验收**

P1：下一轮优先修复的配置保护或可用性问题。P2：会导致状态误判、操作失败或明显交互障碍的问题。下列为本次新发现，编号 R01–R09 与上轮 D01–D11 分开。

| 编号 / 优先级 | 触发与实际结果 | 代码位置及证据 | 修复方向与验收规则 |
| --- | --- | --- | --- |
| **R01 / P1：备份成功却漏掉插件凭证** | 管理 Deno 未就绪或损坏，但插件账号 JSON 仍在磁盘时，迁移导出成功，`plugin_resources=[]`。自动备份使用同一导出逻辑，因此也会生成不完整文件。连续重启累积 7 个新备份后，有淘汰原完整备份的风险。 | `server/src/control/service.rs:265` 通过运行时插件描述枚举资源；`server/src/plugin/registry.rs:151` 在无运行时时返回空 resources。`app.rs:74` 写备份并只保留 7 个。隔离 fixture 保存 1 个真实资源形状的虚拟账号，运行时 Uninitialized，导出资源组为 0。淘汰风险来自保留策略的静态推导，本轮未循环创建 7 次备份。 | 备份枚举持久状态应独立于插件执行；所有已保存资源都须进入快照。若无法读取某项，应明确失败或标记不完整，且不淘汰最近完整快照。验收覆盖运行时缺失、插件加载失败、部分资源损坏和完整快照保留。 |
| **R02 / P1：鉴权或模型错误不触发备用模型** | 主模型没有输出，返回 401、403 或 404 时，配置的备用模型从未被调用；会话直接失败。相同配置返回 503 则能切换并完成。与界面“产出任何内容前失败时自动改用所选模型”的说明不一致。 | `server/src/run/model_cycle.rs:378` 将此类 4xx 标为不可重试；`server/src/run/engine.rs:450` 又用同一标记阻止备用切换。FakeProvider 复现：三类 4xx 都只有 1 次请求并 Failed；503 对照为 2 次请求并 Completed。 | 将“重试同一目标”和“切换不同目标”分开决策；对无输出的鉴权、权限、模型不可用错误允许按用户配置切换。保持取消、存储错误及已输出内容的边界。验收含 401/403/404/429/503、已输出、取消、链上限和请求参数确实使用备用配置。 |
| **R03 / P2：截断的原生流被记为成功** | 外部 API 同协议直通收到 HTTP 200、部分文本后正常 EOF，没有 finish_reason 或协议结束事件，记录却是 `completed / stop`，该模型健康成功率为 100%。转发字节本身保持原样。 | `server/src/api/byok/direct.rs:237` 在没有失败时把缺失结束原因默认 Stop；`:361` 观察器未记录完整结束状态。本地假 HTTP 上游复现后，`llm_calls` 和健康汇总均证实。非流式 HTTP 200 非 JSON 也存在直接记成功的静态路径，未在本轮另设用例。 | 保留原始转发语义，同时按三种协议验证终结证据；EOF、解析失败和观察器失败不能默认成功。验收包含每种协议的正常结束、半包、仅文本 EOF、错误事件及下游取消。 |
| **R04 / P2：旧能力测试结果覆盖新配置或复活已删模型结果** | 测试请求发出后修改 endpoint/key，原测试仍写入“通过”；测试中删除模型，结果表又出现已删模型的“通过”行。 | `server/src/control/capabilities.rs:85` 无条件保存；`server/src/store/models.rs:238,277` 在编辑/删除时清除结果，但无法阻止迟到写入。门控 Provider 分别复现编辑和删除时序，均在失效后重新持久化 1 条 passed。 | 测试必须绑定模型配置修订或指纹，提交结果时在事务中核对仍是同一配置。删除和变更后丢弃旧结果；前端也应清除失效快照。验收覆盖修改、删除、重新创建、并行客户端和插件模型配置变化。 |
| **R05 / P2：异常退出后的调用一直显示进行中** | 持久化了 running 调用但进程未写终态。重新走 `App::new` 后仍为 running、finished_at 为 null；模型健康也显示 running=1。无后续同会话请求的外部调用不会被“新 Run 替换旧 Run”的逻辑处理。 | `server/src/app.rs:139` 启动只迁移和回收；`server/src/store/sqlite.rs:20` 未收敛历史调用状态。隔离数据库保存未完成外部调用，关闭旧连接后重新创建 App 复现。模拟的是进程中断留下的数据库状态，不是强制终止真实进程。 | 在确定旧进程已不拥有执行权的启动边界收敛遗留调用为中断/取消，并写时间及原因；保留可恢复检查点和工具上下文。不能用“清空历史”代替恢复。验收同时检查调用终态与后续会话恢复。 |
| **R06 / P2：删除分组受模型排列顺序影响** | 同组中备用模型 B 排前、引用 B 的 A 排后。逐项删除先拒绝 B，再成功删 A，最后只剩 B；即使引用全部在待删组内，也要再次删除。 | `apps/desktop/src/features/models/CursorSettingsPage.tsx:266` 按组列表逐条删除；`server/src/store/models.rs:251` 正确拒绝删除仍被引用的单个模型。复用页面的调用顺序，在临时 Store 复现“1 次失败 + 1 个模型残留”。本轮未自动点击真实分组删除弹窗。 | 给批量操作定义整体语义：一次验证组外引用，在事务中删除组内关系和资源；出现组外依赖时明确列出，并保持整组状态一致。验收覆盖内部备用关系、组外引用、Commit/审核引用和中途写入失败。 |
| **R07 / P2：共享模型菜单无法用键盘选择后续项** | 打开菜单后焦点在第一项；按 ArrowDown 焦点不动，再按 Enter 仍选第一项。其他模型项和内部 checkbox 都不在正常 Tab 顺序中。 | `apps/desktop/src/shared/ui/ModelSelect.tsx:204` 只有首项 tabIndex=0；`:209` 只处理空格/Enter。浏览器实际观察：Sonnet → ArrowDown → 仍 Sonnet；应选第二项 Opus。 | 为单选、多选补齐方向键、Home/End、当前项焦点与虚拟列表滚动；保留 Escape 和焦点返回。验收至少用纯键盘选第二项、跨组、选列表末项和多选切换。此前加宽菜单的修复有效，本项是独立的键盘行为缺陷。 |
| **R08 / P2：统计查询失败后新标签配旧数据** | 概览从近一个月切换到近1小时，查询返回 503，按钮已选近1小时；图表仍是月数据、LLM 调用仍为 167，页面没有错误提示，刷新按钮也恢复可用。 | `apps/desktop/src/features/home/HomePage.tsx:62` 失败只 console.error，旧 rangeOverview 保留；`:82` 继续渲染旧数据。浏览器拦截实际 fetch 后复现；截图中小时标签下仍显示跨月日期。 | 将查询条件与结果作为一个快照；失败时显示可重试错误，保留旧数据须标明其真实时间范围和过期状态。年度数据失败同样处理。验收包括切换范围、模型筛选失败、迟到响应和失败后重试成功。 |
| **R09 / P2：使用教程和下载链接指向其他维护仓库** | 应用教程、README 下载和维护说明仍指向 zkldwxz；当前 remote 和实际 updater 是 gagmeng。用户按教程下载会进入另一维护分支。 | `apps/desktop/src/shell/AppLayout.tsx:31`、`README-CN.md:7,26,42,167`、`README.md` 对照 `tauri.conf.json:38` 和 `git remote get-url origin`。项目 release skill 的维护仓库说明也未同步。 | 统一当前项目的教程、下载、徽标和维护说明；保留上游来源和版权署名。验收扫描用户入口及更新清单，确认项目自己的下载均指向 gagmeng；不修改历史上游归属。 |

R04 的时序：

```text
                    t0                     t1                      t2
能力测试       读取旧配置、发请求 ───────────────────────────────→ 返回 passed
模型编辑/删除                          清除旧测试结果
当前保存逻辑                                                       无条件写回旧结果
应有行为       捕获配置身份/修订        使旧修订失效                 核对修订，丢弃旧结果
```

R05 的状态边界：

```text
同一进程内：运行 → 正常完成 / 取消 → 记录终态
异常退出后：SQLite 中 running 存活，但执行请求已死亡
新进程启动：应收敛旧调用状态，同时保留检查点供新的运行恢复
```

后者属于新的进程生命周期，不能把“保留会话恢复材料”理解为“旧 HTTP 调用仍在执行”。

**四、尚未计入缺陷数量的风险与补充验证**

| 风险 | 当前证据 | 下一步如何定性 |
| --- | --- | --- |
| 分组批量编辑可部分成功且界面未刷新 | `CursorSettingsPage.tsx:285` 顺序 GET/PUT；第二次失败时不回滚，也不到刷新语句。静态路径成立，未做浏览器故障注入。 | 在第二个 PUT 注入失败，检查数据库、列表快照、提示和重新提交行为；可与 R06 一起统一批量操作。 |
| 插件目录同步与开关并发丢失修改 | `plugin/state.rs:355,381` 读取与写回分开加锁，资源凭证则已用原子 modify。尚未构造确定性并发用例。 | 门控两个读写周期，验证同步模型与关闭模型并发时 enabled 是否丢失。 |
| 长流或慢订阅者内存增长 | `cursor/transport/output.rs:13` 保留所有历史帧，订阅队列无界；关闭后仍保留历史用于回放。没有可量化内存压测。 | 固定流长度、并发数、慢客户端和重连次数，测峰值与结束后内存；在保持重放语义下再决定背压或落盘。 |
| 远程 Git 缓存刷新语义不明确 | `semble-core/source/remote_git.rs:28` 仅首次 clone，后续 rev-parse 本地 HEAD；无 fetch，git 子进程无超时。 | 用可控 HTTP Git 仓库更新提交，验证用户要求 refresh 时是否能检索新代码，并测试中断/并发 clone。 |
| 插件移除与设置引用 | `plugin/registry.rs:988` 清除插件私有状态，但未像内置模型删除那样检查 Commit/审核引用。 | 配置插件模型为 Commit，移除后验证设置、选择器和生成错误；确定是阻止删除还是显式清理并提示。 |
| 原生更新的启动就绪和回滚边界 | 已有签名和替换回滚实现；就绪标记、服务启动及较慢数据库迁移之间尚未做进程级故障矩阵。 | 在可丢弃安装副本上注入启动失败、超时、文件占用和中途退出，逐项检查旧版本可启动和配置完整。 |

真实 Remote SSH Agent、远程工具、Tab、Commit 和断线恢复仍需按照 `docs/remote-ssh.md:50` 完成实测。直连探测通过、demo 通过或本地工具集成测试通过，都不能将 SSH 状态改为“已验证”。

**五、值得引入的功能与可验收收益**

建议先完成 R01–R09，再分阶段合入以下能力；前 4 项对可靠性和日常排错最直接。

| 顺序 / 功能 | 解决的实际问题 | 在现有工程中的落点 | 最小验收标准 |
| --- | --- | --- | --- |
| 1. **备份与恢复中心** | 自动备份目前没有界面状态；设备迁移采用“只补缺失”，不能恢复误改的同标识模型；导出范围也不包含全部系统设置、插件模型开关和本地规则。 | `server/control` 导出/恢复用例、`plugin/state` 持久快照、`store` 配置；`features/settings` 备份卡片。 | 显示最近完整备份、时间、范围及失败原因；预览恢复差异；按项选择覆盖或补充；恢复前保留当前快照；缺运行时可完整备份。迁移的默认跳过语义继续明确呈现，恢复单独定义。 |
| 2. **请求阶段、超时预算和重试可见性** | 普通模型请求默认总超时 60 分钟、无事件超时 30 分钟，最多重试 8 次、间隔固定 5 秒；用户难判断仍在处理还是已无进展。 | `config`、`provider`、`run/model_retry` 与 `features/calls`。 | 区分连接、等待首个有效事件、生成、重试、转备用；提供可配置总预算；取消立即生效；429 尊重 Retry-After 并受总预算限制；重试前显示原因和剩余次数。思考模型可设置合理的独立等待值。 |
| 3. **可检索的调用中心与实时详情** | 当前前端固定请求最近 200 条；详情页仅进入时取一次，请求结束后不会自动更新。更早错误及长请求排查困难。 | `store/llm_calls` 查询、`control` API、`features/calls`。 | 服务端游标分页，按模型/状态/时间/会话检索；进行中的详情持续更新，终态停止；可跳转相关会话和失败切换链；默认脱敏导出排错包，导出前展示范围。 |
| 4. **有时效和配置身份的模型健康页** | 测试通过状态容易被长期理解为持续健康；数据需要区分真实调用和主动测试。 | `control/capabilities`、`store/diagnostics`、`features/diagnostics`。 | 测试显示使用的配置修订、时间和过期状态；实际健康按时间窗/样本数展示；支持两模型手动对比首响应和速度；用户主动发起测试，并显示预计请求次数；配置变化立即失效。 |
| 5. **统一模型选择与批量管理** | 已配置模型多时缺少搜索；审核模型和备用模型仍用通用 Select，后者没有共享菜单的完整分组体验，审核下拉也未列插件模型。 | 继续扩展 `shared/ui/ModelSelect`；页面拥有选项和持久化；批量用例放 `control/store`。 | 搜索、键盘和分组在各入口一致；显示模型提供商与能力结果；审核选择支持已配置插件模型；批量编辑/删除预览引用影响，并保证整体或明确逐项结果。备用模型暂限内置时应明确范围。 |
| 6. **存储保留策略与清理预览** | 目前可手工清详细日志或全部统计，但长期运行缺少按时间/容量的保留管理。 | `store/storage`、`store/maintenance`、`features/settings`。 | 显示汇总、请求响应、追踪附件和恢复材料的占用；按天数/容量选择；执行前预览行数与估计释放量；不删除活跃或可恢复会话依赖；在真实数据库副本上记录前后行数和文件大小。 |
| 7. **更新进度与兼容性验收入口** | 更新界面主要只有 checking/installing 状态；用户不易判断下载进度和更新影响，SSH 能力也缺真实验收记录。 | `shared/store/updateStore`、`src-tauri/update`、`features/settings`、`docs/remote-ssh.md`。 | 显示下载进度、版本修改摘要和需要重启的状态；活跃生成时提示保存状态；以安装副本验证回滚；记录 Cursor 版本、OS、提供商/协议和每项 SSH 功能的实测结果。 |

前端性能可以作为后续测量项：本轮 demo 主 JS 为约 1.19 MB（gzip 398 KB），PingFang 字体约 10.97 MB，另有 Monaco 异步资源。构建成功且有大块提示，但这尚不能证明实际启动慢。先测原生 WebView 冷启动、首屏和内存，再决定页面/编辑器按需加载及字体裁剪；不以关闭警告作为优化。

**六、建议实施顺序与模块边界**

当前 review 未移动、合并、拆分或删除业务模块。以下是后续建议，与已实现结构分开：

```text
第一阶段：已有功能的可靠性
  control/service + plugin/state   → R01 完整备份
  run/model_cycle + run/engine     → R02 区分同目标重试和备用切换
  api/byok/direct                 → R03 完成证据
  capabilities + store            → R04 配置修订校验
  app + store                     → R05 启动收敛
  control + store + models 页面    → R06 原子批量操作
  shared/ui + home + docs          → R07–R09

第二阶段：可观察、可恢复
  settings + control              → 备份列表、差异预览和恢复
  calls + provider/run            → 分阶段调用状态、检索与实时详情
  diagnostics                     → 测试时效和配置身份

第三阶段：长期运行与平台体验
  store/maintenance               → 保留策略和清理预览
  shared/ui                       → 统一模型搜索与选择
  src-tauri/update + settings      → 更新反馈、进程故障矩阵
  真实 Cursor SSH 窗口            → 独立完成远程兼容性验收
```

先在现有模块中做最小修复。有新功能使职责变复杂时再拆分，避免只因文件较长而改架构。热点实测：`control/service.rs` 1,320 行、`plugin/registry.rs` 1,402 行、`run/engine.rs` 1,129 行、`store/models.rs` 627 行、`CursorSettingsPage.tsx` 581 行、`ModelSelect.tsx` 236 行、`HomePage.tsx` 199 行；同样包含测试、注释和空行。

若增加完整备份功能，建议将配置快照/恢复职责从 `control/service.rs` 移入同层专门模块，而不是扩张 service；页面负责呈现和用户选择，store 负责原子持久化，plugin 负责读写其持久状态。其余目录边界保持当前责任。

**七、验证结果与复查方式**

本轮执行的已有回归：

```powershell
cargo test -p cursor-server --test diagnostics --test external_api --test management_access --test checkpoint_recovery --test error_lifecycle
cargo test -p cursor-server --test prefix_stability --test tool_round --test compaction --test commit_message --test local_rules_context
```

合计 `35 + 49 = 84` 通过。本轮未重跑全工作区 Clippy、全部 Rust 测试、全部前端行为测试或原生发布构建；demo 构建用于复现，不能当成完整发布验证。

后端复现源码已归档到 `target/audit-v1.1.4/backend-probes.rs`；要再次运行，临时复制到 `server/tests/audit_v114_probe.rs`，执行以下命令，完成后将这一个临时文件移出正式测试目录：

```powershell
cargo test -p cursor-server --test audit_v114_probe -- --test-threads=1 --nocapture
```

当前基线应出现 7 个表达正确预期的失败断言和 1 个 503 对照通过。它们不是已合入的绿色回归，后续每个修复应将相应用例正式纳入并使之通过。

浏览器复查：

```powershell
# 在 apps/desktop 下构建隔离 demo
node node_modules/vite/bin/vite.js build --config vite.demo.config.ts --outDir ../../target/audit-v1.1.4/ui-demo
# 在仓库根目录执行；可通过 CURSOR_TEST_BROWSER 指定已安装的浏览器
node target/audit-v1.1.4/browser-probes.mjs
```

当前浏览器脚本检查问题可复现，因此进程成功表示捕获到了缺陷；修复实施时应把规则改写为正式正向回归。复现材料只在本机被忽略目录内，若需跨机器复查，应单独保留这些虚拟数据脚本和日志。

后续实施完成仍需执行项目完整 gate：`cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets -- -D warnings`、`cargo test --workspace --all-targets`、`npm --prefix apps/desktop run check`；前端交互变更补充行为/浏览器验证，插件变更跑对应 Deno 测试，存储改动在真实数据库副本测量前后行数与文件大小。不要直接修改已应用迁移，也不要为使检查变绿而修复无关工作区改动。
