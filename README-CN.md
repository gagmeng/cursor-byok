<div align="center">

# cursor-byok

运行在本机的 Cursor 后端：用你自己的模型 API，保留 Agent 工具、Skills 和 MCP。

[English README](./README.md) · [下载](https://github.com/gagmeng/cursor-byok/releases/latest) · [Telegram](https://t.me/cursor_byok)

[![Release](https://img.shields.io/github/v/release/gagmeng/cursor-byok?style=flat-square)](https://github.com/gagmeng/cursor-byok/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/gagmeng/cursor-byok/total?style=flat-square)](https://github.com/gagmeng/cursor-byok/releases)
[![License](https://img.shields.io/github/license/gagmeng/cursor-byok?style=flat-square)](./LICENSE)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square)](https://github.com/gagmeng/cursor-byok/releases/latest)

</div>

![将 cursor-byok 连接到多种模型 API](./images/en-brand-1.png)

![cursor-byok 控制面板](./images/en-home-1.png)

## 这是什么

**cursor-byok** 在你的电脑上充当 Cursor 的本地后端。Cursor 把 Agent 请求发给本服务，本服务再转发到你配置的 OpenAI / Anthropic 兼容接口。

API Key 和设置只存在本机。模型流量仍会发往你选择的上游。本项目是独立项目，与 Cursor 官方没有关联。

当前维护和发版仓库是 [gagmeng/cursor-byok](https://github.com/gagmeng/cursor-byok)。与已归档上游的关系见 [本仓库与上游](#本仓库与上游)。

## 功能

- **自定义模型通道：** 每个模型独立配置地址、凭据、模型 ID、Header 和额外参数。
- **多种协议：** OpenAI Responses、OpenAI Chat Completions、Anthropic Messages。
- **内置供应商插件：** 含 ZCode（智谱 Coding Plan），复刻官方客户端身份。
- **Agent 循环：** 工具调用、Skills、MCP、子代理、多轮对话。
- **本地存储：** SQLite 检查点、启动时清理死血统、单文件设备迁移导出。
- **管理界面：** 模型编辑、连接测试、用量与缓存、插件与系统设置。
- **首次使用与连接诊断：** 引导完成 CA、模型和接管配置，分别记录本地与 SSH 的请求、响应订阅、上游响应及工具往返证据。
- **模型健康与能力测试：** 查看最近 7 天实际调用的成功率、首个有效响应和生成速度；主动验证流式、工具、图片及缓存续接能力。
- **桌面应用：** macOS / Windows / Linux，更新通道指向本仓库的 GitHub Releases。

## 快速开始

1. 从 [GitHub Releases](https://github.com/gagmeng/cursor-byok/releases/latest) 下载对应系统的安装包。
2. 打开 cursor-byok → **连接诊断**，按引导初始化并信任本地 CA。全新配置会自动进入该页，也可以稍后完成。
3. 在模型设置中添加模型（服务地址、API Key、模型名称），保存并运行 **测试**。
4. 保持 cursor-byok 运行。
5. **首次安装或升级 Cursor 后，完全退出并重新启动 Cursor，再新开一个对话**，在模型列表里选你配置的模型，不要选 **Auto**。
6. 回到 **连接诊断**，点击 **验证本地连接**，把生成的指令发到 Cursor 新对话。页面会逐项记录请求到达、响应订阅、模型有效响应和终端工具结果。

配置完成前已经打开的对话不会接到本地后端。

**模型健康** 页支持按模型查看真实调用统计和最后一次能力测试结果。测试会调用所选提供商，全部能力最多发送 6 次请求，每项最长 90 秒，可以取消。工具能力测试使用模拟结果，不执行工作区工具；连接诊断则要求 Cursor 实际执行终端 `echo`。缓存未报告命中会显示“未能确认”。

设备迁移使用版本 3 文件，保留模型稳定标识、备用关系、系统提示词和插件凭证；已有配置按标识跳过。升级后请重新导出迁移文件。应用启动即写一份自动备份，随后每日备份，保留最近 7 份，位置为应用数据目录下的 `backups/`。

## Remote SSH

请使用 **Cursor 3.21.16 或更高版本**。保持本机 cursor-byok 运行，并完成本地 CA、代理接管和模型配置。cursor-byok 的 **Cursor → Remote SSH 指南** 提供相同的步骤和可复制的设置。

1. 在 Cursor 中连接 SSH 主机。
2. 在 Cursor 设置中选择 **Remote [SSH: 主机]**，打开该主机的远程设置 JSON。每个 SSH 主机需单独配置，不能只修改本地 User 或工作区设置。合并以下属性，保留其他已有设置：

   ```json
   {
     "cursorAgentHost.remoteInferenceRoute": "always"
   }
   ```

3. 保存后，从命令面板运行 **Developer: Reload Window（重新加载窗口）**。
4. **新建对话**，手动选择已配置的 BYOK 模型（不要选择 **Auto**），然后发送请求。旧对话不能用于验证新路由。

```text
SSH 工作区 / 远程 Agent
    → Cursor 原生推理路由 → 本机 Cursor 客户端
    → 本机 cursor-byok → 已配置的模型服务商
工具仍在 SSH 工作区执行。
```

此路由**不需要 SSH 隧道，也不需要在远程主机安装本地 CA**。本地服务应保持仅监听回环地址，不要公开暴露服务或向远程主机复制 CA 私钥。

应用中的“**本地已接管 / 本地未接管**”仅表示本机代理配置。该状态或本地模型测试成功都不能验证 Remote SSH 是否可用。Agent 流式响应、远程文件和终端工具、搜索、WebFetch、MCP、Skills、Tab 和提交信息生成必须分别验证；本指南不代表所有功能已通过 SSH 端到端测试。参阅 [Remote SSH 验证清单](./docs/remote-ssh.md)。

完成上述设置后，在 **连接诊断 → 验证 SSH 连接** 生成独立指令，并在相应 SSH 窗口的新对话中发送。本地与 SSH 诊断分别保存；窗口类型由你选择，页面不会自动识别远程主机。终端往返成功只证明这条诊断链路，其他远程功能仍按清单验证。

### Remote SSH 故障排查

- **远程进程无法连接 `127.0.0.1` 或 `localhost`**：远程进程使用这些地址时指向远程主机，而不是本机桌面。先检查 **Remote [SSH: 主机]** 设置是否生效，重新加载窗口并新建对话，再考虑端口或网络问题。
- **证书错误**：与回环地址连接失败分开诊断。记录报错进程、目标地址和具体证书错误，检查实际发起连接的机器的信任配置。证书错误本身不代表需要隧道或在远程主机安装本地 CA。保持 TLS 验证开启，不要分享 CA 私钥或凭据。


## 模型配置

每个保存的模型就是一条独立的上游通道。

![模型设置页面](./images/en-model-1.png)

| 模型系列 | 模型类型 | 请求协议 |
| --- | --- | --- |
| Claude 系列 | **Anthropic** | Messages API |
| GPT / OpenAI 系列 | **OpenAI** | **Responses API**（优先；Chat Completions 容易丢掉提示词缓存） |
| 其他模型 | **OpenAI** | **Chat Completions API** |

常用字段：模型类型、请求协议、服务器地址（基础地址或完整 URL）、API Key、上游模型标识、Cursor 里显示的名称、上下文 / 最大输出 Token、推理强度、JSON Header、额外 JSON 参数。只填写服务商文档里有的字段。

ZCode 可通过插件导入凭证；插件启用后，手动模型也可以打开「伪造 ZCode 环境」。

## TAB 补全

Cursor 的 Tab 补全走独立 TAB 服务，不经过对话模型通道。在 **系统设置 → TAB 设置** 中选择：

- **公益服务（默认）：** 项目提供的公共服务，无需额外配置。
- **直连：** 使用当前登录 Cursor 账号对应的官方 TAB 服务。
- **自定义：** 自建 TAB 服务。最后一版源码在已归档上游：[`cursor-tab-server`](https://github.com/leookun/cursor-byok/tree/archive/v0.0.49/cursor-tab-server)。

改 TAB 模式后请重启 Cursor 并新开对话。

## 与官方账号并存

- 用自己的 Cursor 账号登录。若还停在旧版生成的假账号上，先退出再登录自己的账号。
- 账号有官方额度时，官方模型与本地模型可以混用。
- **Auto 只走官方模型。** 没有官方额度时，请手动选本地模型。
- 插件、代码库索引等 IDE 功能可继续使用。

## 数据流转

```text
Cursor 客户端
    │  Agent 请求、工具结果、KV blob
    ▼
cursor-byok（本机本应用）
    │  OpenAI / Anthropic 兼容 HTTP
    ▼
你配置的模型 API
```

密钥只作为请求头发往该 API，不会上传到本项目的服务器。

## 项目结构

```text
cursor-byok/
├── apps/desktop/          桌面 UI（React）与 Tauri 壳
├── server/                本地 Cursor 后端、存储、插件、管理 API
├── crates/semble-core/    本地代码索引 / 搜索
├── protocols/cursor/      捕获的 Cursor protobuf（唯一来源）
├── support/               协议提取、抓包、基准测试
├── .agents/skills/        各区域贡献规则
└── .github/workflows/     CI 与桌面 GitHub Release
```

## 本地开发

需要 Rust、Node.js / npm，以及 Tauri 2 的系统依赖。

```bash
npm --prefix apps/desktop install
make dev-web          # 后端 + Vite
make dev-desktop      # Tauri
make check            # fmt、clippy、测试、前端检查，与 CI 相同
```

改代码前请读 [AGENTS.md](./AGENTS.md) 和 [`.agents/skills/`](.agents/skills/)。

## 本仓库与上游

cursor-byok 由 [leookun](https://github.com/leookun) 在 [leookun/cursor-byok](https://github.com/leookun/cursor-byok) 创建。该仓库已于 **2026 年 10 月归档**。

**本仓库是后续维护点：** 修复、ZCode、存储与瘦身、更新签名、GitHub Release 都在 [gagmeng/cursor-byok](https://github.com/gagmeng/cursor-byok) 发布。安装包和 `latest.json` / `update.json` 指向这里。

原仓库的 MIT 代码仍是基础。致谢原作者和上游贡献者；本仓库在那棵提交树上继续维护。

## 社区

- [Telegram](https://t.me/cursor_byok)
- QQ 群：`1095916242`、`1094411438`、`1095918002`、`1094419321`

反馈问题时请带上操作系统、cursor-byok 版本、模型类型、协议、已脱敏的服务地址、错误信息和复现步骤。不要粘贴 API Key。

## 许可证

[MIT License](./LICENSE)。Copyright (c) 2026 leookun, zkldwxz。

原仓库贡献者：

<a href="https://github.com/leookun/cursor-byok/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=leookun/cursor-byok" alt="leookun/cursor-byok 贡献者" />
</a>
