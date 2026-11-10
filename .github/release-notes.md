请从下方附件下载对应平台的安装包；Windows 同时提供便携版 ZIP。

## 首次使用与完整连接诊断

- 新增“连接诊断”页，引导完成本地 CA、模型配置和 Cursor 接管；首次使用自动进入，也可稍后完成。
- 本地与 Remote SSH 分别生成诊断指令，逐项展示 Cursor 请求到达、响应订阅、上游有效响应和成功工具结果。直接模型测试不会误报完整链路已接通。
- SSH 窗口类型由用户选择，诊断不自动识别远程主机；终端往返验证与 Tab、Commit、MCP 等功能的验证独立。

## 模型健康与能力测试

- 新增“模型健康”页，展示最近 7 天实际调用的成功率、首个有效响应耗时、生成速度和最近错误；测试、取消及进行中的调用不影响健康成功率。
- 支持流式响应、工具调用往返、图片理解、缓存续接测试，保存最后结果并支持取消。全部能力最多发送 6 次请求，每项最长 90 秒，可能消耗提供商额度。
- 工具能力测试使用模拟结果，不执行工作区工具；缓存续接成功但未报告命中时显示“未能确认”。
- 模型下拉菜单加宽，完整显示长模型名和供应商分组，支持换行及窗口边界适配；修复嵌套菜单的 Escape 行为。

## 可靠性与配置保护

- 修复闲置会话清理后无法恢复；保留当前会话头和祖先，修复旧数据中的悬空引用。
- 模型改名、换密钥或改地址保留稳定身份及备用、Commit、审核和历史调用关联；拒绝不存在、环形及超过四跳的备用链，阻止删除仍被引用的模型。
- 静默启动按持久设置恢复接管；状态查询只读，刷新不再修改 Cursor 配置或强制退出 Cursor。
- 接管前记录原始代理及路由设置，关闭或退出时按所有权恢复，并保留用户期间修改。
- 管理接口增加同源会话鉴权，收紧 Host/Origin；模型列表不再返回 API Key 和自定义 Header 值。导出改为应用内鉴权下载，并支持服务重启后的会话恢复。

## 备份、迁移与界面修复

- 应用启动即创建原子备份，随后每日执行，失败后重试，保留最近 7 份。
- 设备迁移保留模型身份、备用关系、提示词和插件凭证，跳过已有配置；修复并发插件导入丢失账号。
- 迁移文件在预览前校验，导入期间阻止重复提交，成功后刷新模型和插件列表。
- 修复局部接口失败导致全部数据不显示、旧刷新覆盖新结果，以及年度热力图查询范围和本地时区错误。
- CI 纳入前端逻辑、隔离浏览器和全部内置插件测试。本地回归通过：466 项 Rust、38 项前端逻辑、23 项浏览器交互、62 项插件及 8 项发布脚本测试。

## 升级说明

- 数据库从 schema 12 自动前向迁移至 14；真实数据库副本验证业务行数保持一致、无外键违规。
- 设备迁移文件使用版本 3，旧版本文件不再导入。跨设备迁移前，请先升级并重新导出配置。
- 保持本机 cursor-byok 运行。首次接管或升级 Cursor 后，请自行完全退出并重启 Cursor，再新建对话验证。
- 验证覆盖隔离 HTTP/协议链路和浏览器交互；真实 SSH、各提供商能力和其他平台静默自启仍需在对应环境验收。

---

## English summary

- **Setup and connection diagnostics:** guided CA/model/takeover setup, with independent local and SSH request, stream, provider-response, and tool-result evidence.
- **Model health and capability probes:** seven-day real-call statistics plus cancellable streaming, tool-result continuation, vision, and cache tests. All tests use at most six provider requests; cache support remains inconclusive without a reported hit.
- **Reliable conversations and model references:** preserve idle conversation lineages and stable model identities; validate fallback targets, cycles, and depth; protect referenced models from deletion.
- **Safe takeover lifecycle:** restore persisted intent without opening a window, keep status reads side-effect free, and restore only settings still owned by the app.
- **Management access and exports:** same-origin sessions, redacted model lists, authenticated in-app downloads, and automatic session recovery after a service restart.
- **Backups and migration:** immediate atomic startup backup, seven-file retention, complete fallback/prompt/credential migration, and concurrent plugin-import protection.
- **Desktop fixes:** wider wrapping model menus, nested-menu dismissal, independent refresh results, validated imports, and complete annual statistics using the local calendar.
- **Upgrade:** schema 12 upgrades to 14 automatically. Portable configuration files now use version 3; upgrade and export a new file before moving configuration between machines.
