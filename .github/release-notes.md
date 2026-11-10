请从下方附件下载对应平台的安装包；Windows 同时提供便携版 ZIP。

## 桌面界面与配色

- 统一深浅主题的配色与表面层次，增强主蓝色、成功绿色和警告琥珀色；主按钮白字对比度超过 5:1。
- 导航统一为同族单色图标，当前页面使用蓝色选中背景与左侧标记；保留 Cursor 和模型提供商的品牌标识。
- 统一按钮、输入框、选择器、卡片和弹窗的尺寸、圆角、间距与标题字重，协调模型、插件、设置及调用详情页面的视觉。
- 连接诊断与能力测试突出主操作，成功、失败和等待状态通过状态点与文字同时表达；弹窗取消与保存使用不同的按钮层级。

## 小窗口与键盘操作

- 概览在窄窗口使用时间范围选择框，保留全部预设、自定义日期与模型多选，避免筛选栏遮挡标题。
- 自定义筛选打开后自动进入输入框，关闭后将焦点返回可见触发器；Escape 按层级关闭模型菜单和筛选面板。
- 窗口跨宽窄布局缩放时重新定位筛选浮层，保留 V1.1.3 的长模型名换行、供应商分组、加宽菜单和窗口边界适配。
- 保持固定窗口栏、导航和页面操作区，滚动仅发生在原有内容视口内。

## 图表与可读性

- 增强 Token 用量图、缓存仪表和年度热力图的色彩辨识度，保留全部统计口径与数据系列。
- 修复切换主题后 Canvas 图表继续使用旧配色的问题，缓存中的页面也会随主题重绘。
- 补齐成功状态的主题颜色，改善说明文字对比度和键盘焦点可见性。
- 支持系统“减少动态效果”偏好，控件减少过渡、图表关闭动画。

## 验证与升级

- 本地回归通过：466 项 Rust 测试、38 项前端逻辑测试、30 项隔离浏览器测试；格式检查、Clippy、前端类型检查、三种语言完整性和 Windows 调试及优化构建通过。
- 新增 7 项界面与交互回归，覆盖深浅主题、中文/英文/葡萄牙文、最小窗口、焦点恢复、嵌套筛选、窗口缩放和图表主题切换。
- 本版本以桌面界面与交互优化为主，沿用 V1.1.3 的数据库 schema 14 和设备迁移文件版本 3；现有模型配置、连接诊断和能力测试继续可用。
- 发布附件与 V1.1.3 保持相同平台范围：Windows、macOS Intel/Apple Silicon、Linux，以及签名更新文件和自动更新清单。

---

## English summary

- **Desktop appearance:** stronger blue accents, clearer light/dark surface layers, consistent controls and spacing, monochrome navigation icons, and explicit selected-page indicators.
- **Diagnostics and actions:** readable status dots and labels, prominent connection/capability actions, and distinct cancel/save button hierarchy.
- **Compact windows and keyboard use:** all overview ranges and model filters remain available; custom filters receive focus, restore it on dismissal, and reposition when the window crosses layout breakpoints.
- **Charts and accessibility:** token, cache, and annual charts use clearer colors, repaint after theme changes even on cached pages, and respect reduced-motion preferences.
- **Validation:** 466 Rust tests, 38 frontend logic tests, and 30 isolated browser tests passed locally, alongside formatting, Clippy, type/build, localization, and Windows debug/optimized builds.
- **Upgrade:** retains V1.1.3's schema 14 and configuration export format 3, with the same platform packages and signed updater formats.

设计方法参考 [unslop by Damir Sokolovsky](https://github.com/heydamir/unslop)，CC BY 4.0。
