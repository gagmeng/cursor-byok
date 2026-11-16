请从下方附件下载对应平台的安装包；Windows 同时提供便携版 ZIP。

## Antigravity 同步模型不再退回旧列表

- 账号 token 过期后同步模型，会先自动续期再拉取动态目录。此前同步路径没有续期逻辑，token 一过期每次同步都被拒绝，目录静默退回内置列表，上游新发布的模型永远不出现。
- 时钟偏差导致 token 看起来有效却被上游拒绝时，会自动续期并重试一次。续期失败仍然退回内置列表，同步不会整体失败。

## 同一会话切换模型不再报签名错误

- 模型的思考签名只在同一模型族内回放。此前从 Claude 切到 Gemini 会把 Claude 的签名发过去，上游直接返回 `HTTP 400: Corrupted thought signature`。
- 本次更新之前保存的签名没有模型族标记，一律不再回放。不会报错，但那些轮次的思考上下文不会传递。

## 模型目录以线上为准

- 同步成功时，目录完全由线上返回决定，内置列表只在探测失败时兜底。此前两者会合并，已下线的模型一直留在列表里，选中后只会拿到错误。

## 升级说明

- 本次没有数据库迁移，已有数据库直接使用。
- 内置 Google 插件从 `0.1.8` 升级到 `0.1.10`。应用启动时会自动替换已安装的旧版本。

## 验证

- 格式检查、Clippy、全量 Rust 测试、前端类型检查与构建已通过。
- 插件自身的 13 个测试全部通过，覆盖过期 token 同步、被拒 token 重试、续期失败兜底、目录替换、跨模型族签名隔离、别名解析到目标模型族。

---

## English summary

- **Antigravity model sync:** an expired access token is refreshed before the catalog request. Previously the sync path had no refresh, so an expired token made every sync answer 401 and silently fall back to the built-in list, hiding newly released models. A token rejected despite looking valid is refreshed and retried once, and a failed refresh still leaves the sync working from the built-in list.
- **Thought signatures are family scoped:** a signature is replayed only to the model family that produced it. Switching from Claude to Gemini in one conversation used to send Claude's signature to Gemini and fail with `HTTP 400: Corrupted thought signature`. Signatures stored before this release carry no family and are no longer replayed.
- **The live catalog wins:** a successful sync replaces the directory instead of merging the built-in list into it, so retired models stop showing up and failing on selection.
- **Upgrade:** no database migration. The built-in Google plugin moves from `0.1.8` to `0.1.10` and is replaced on next launch.
