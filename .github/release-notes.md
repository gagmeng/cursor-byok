请从下方附件下载对应平台的安装包；Windows 同时提供便携版 ZIP。

## 新增 WorkBuddy CN 接入

- 内置插件新增 WorkBuddy CN，用微信/QQ 扫码即可登录，不需要去开放平台注册应用。
- 支持导入本机 CodeBuddy 客户端已有的登录凭证，不必重新扫码。
- 模型目录内置腾讯混元、DeepSeek、GLM、Kimi、MiniMax、MiMo 等 16 个常用模型；同步时会再向网关拉取一次，网关返回的模型追加到列表，内置模型的名称与输出上限由网关数据补充。
- 账号卡片直接显示剩余积分与套餐名，点刷新即可重新拉取。

## 模型列表保留内置兜底

- WorkBuddy 网关的模型接口在部分环境只返回部分模型，因此同步采用「内置表为骨架、线上结果覆盖追加」的策略；网关拒绝凭证或网络异常时，列表不会变空，仍可正常选择和调用。

## 升级说明

- 本次没有数据库迁移，已有数据库直接使用。
- 新增的内置插件会在应用启动时自动安装；已安装的其他内置插件不受影响。
- 该插件只允许访问 `copilot.tencent.com`，不涉及其他域名。

## 验证

- 格式检查、Clippy、全量 Rust 测试、前端类型检查与构建已通过。
- 新插件自身的 11 个测试全部通过，覆盖模型列表解析与去重、地址拼接、会话请求头轮换、Bearer 鉴权、JWT 过期判断、凭证导入、凭证草稿键往返、内置模型表完整性、线上结果与内置表的合并语义。

---

## English summary

- **New WorkBuddy CN provider:** a built-in plugin that signs in with a WeChat/QQ QR code, so no open-platform application is needed. It can also import credentials already present in the local CodeBuddy client.
- **Model catalog:** 16 built-in models from Hunyuan, DeepSeek, GLM, Kimi, MiniMax and MiMo, merged with whatever the gateway returns so newly added models appear without a client update. The built-in table is kept as the fallback: a rejected credential or a network failure leaves the directory usable instead of empty.
- **Account panel** shows remaining credits and the plan name, refreshed on demand.
- **Upgrade:** no database migration. The new plugin is installed automatically on next launch, and its network access is limited to `copilot.tencent.com`.
