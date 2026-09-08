# HTTP Touch Bar v1.2 开发说明

- 文档版本：v1.2
- 日期：2026-09-07
- 状态：已实现

## 1. 目标

v1.2 将浏览器副屏重构为固定的三个顶层页面：**系统监控、控制、快捷方式**。页面内容按功能或 App 卡片分组，默认聚焦 QQ 音乐、基础系统控制、本机 Codex 今日 Token 和常驻网站。

## 2. 页面结构

### 2.1 系统监控

- 系统资源：CPU、负载、内存、磁盘、电池。
- Codex 今日 Token：当日总调用次数、总 Token、输入、缓存输入、缓存写入、输出、推理输出，以及按模型汇总的调用次数和 Token。
- 设备与 Agent：主机名、macOS 版本、局域网地址、系统/Agent 运行时间、在线设备、操作次数和更新时间。

### 2.2 控制

- QQ 音乐：打开应用、上一首、播放/暂停、下一首。
- 系统控制：音量、切换静音、立即息屏。
- 默认不展示真正锁定账户、亮度、截图和 BTT 示例。

### 2.3 快捷方式

网站统一在 Mac 默认浏览器打开：

- 今日热榜：`https://rebang.today/`
- Linux.do：`https://linux.do/`
- SubAPI 控制台：`https://example.com/dashboard`
- 豆包：`https://www.doubao.com/chat`

应用快捷方式默认包含 QQ 音乐。

## 3. v2 配置协议

配置版本升级为 `version: 2`：

```text
applications
fixed tabs (monitor/control/shortcuts)
  └─ groups
      └─ items

actions
```

- `applications` 集中定义应用名称、Bundle ID 和图标。
- `tabs` 必须按照 `monitor → control → shortcuts` 排列。
- `groups` 支持 `section`、`app` 和 `metrics`。
- `items` 支持按钮、滑块、状态、Token 用量面板和占位项。
- `appShortcut` 只引用服务端配置的应用与键位，浏览器不能提交任意 Bundle ID 或按键。
- v1 `profiles/items` 配置仍可加载，Agent 会归一化成固定的 v2 页面。

## 4. QQ 音乐快捷键

QQ 音乐控制采用：

```text
检查应用和权限
→ 打开并激活 QQ 音乐
→ 等待应用进入前台
→ 发送配置的键盘组合
→ QQ 音乐保持前台
```

Agent 构建时会编译 `apps/agent/native/TouchBarMacHelper.swift`。原生助手使用 `AXIsProcessTrusted()` 检查辅助功能权限、通过 `NSWorkspace` 激活应用，并使用 `CGEvent` 发送按键。检查过程不会主动弹出授权请求。

默认快捷键：

| 操作 | QQ 音乐中需要配置的快捷键 |
|---|---|
| 上一首 | `Control + Option + Command + ←` |
| 播放/暂停 | `Control + Option + Command + Space` |
| 下一首 | `Control + Option + Command + →` |

使用步骤：

1. 在 QQ 音乐快捷键设置中将三个操作设置为上表组合；如使用其他组合，同步修改 Touch Bar JSON 配置。
2. 执行 `pnpm build`，确保原生助手已生成。
3. 在“系统设置 → 隐私与安全性 → 辅助功能”中允许运行 Agent/原生助手的本地程序。
4. 刷新副屏页面，让 Agent 重新检测动作可用性。

未授权、应用未安装或原生助手未构建时，按钮会禁用并展示具体原因。

## 5. 操作结果

`ActionResult.outcome` 分为：

- `verified`：已读取并确认最终状态，例如应用已进入前台或音量读取值一致。
- `accepted`：指令已正确发送，但无法读取目标应用最终状态，例如 QQ 音乐快捷键、打开网站和立即息屏。
- `failed`：权限、应用、配置、激活或执行失败。

界面分别使用绿色、蓝色和红色反馈。`ok` 字段保留，用于兼容 v1.1 客户端；`accepted` 与 `verified` 的 `ok` 均为 `true`。

每个动作还包含 `ActionAvailability`：`available`、`permission_required`、`app_missing`、`unsupported` 或 `misconfigured`。

## 6. Token 统计口径与性能

数据范围为 `~/.codex/sessions/当天目录/*.jsonl`：

- 从 `turn_context.turn_id/model` 建立模型映射。
- 唯一 `token_usage_record.response_id` 计为一次模型调用。
- 只累加 `payload.usage`，不累加 `turn_token_usage` 或 `thread_token_usage`。
- 跨文件按 `response_id` 去重，缺少模型映射时归入“未知模型”。
- 只解析 `turn_context` 和 `token_usage_record`；不解析提示词、回复或其他会话正文事件。

采集策略：

- CPU、内存和运行状态约每 3 秒刷新。
- 磁盘、电池、系统版本和 Token 约每 15 秒刷新。
- Token 首次扫描当日文件，随后按文件字节偏移只读取追加内容。
- 文件截断、替换、删除或日期跨过午夜时自动重建对应状态。
- 没有 WebSocket 客户端时停止周期采集。

Token 只代表本机 Codex 当日记录，不代表账号账单、API 全局用量或其他设备。

## 7. 验证

```bash
pnpm typecheck
pnpm test
pnpm build
```

实机验收还需验证：

- QQ 音乐三个快捷键在授权和完成 QQ 音乐快捷键配置后生效。
- 未授权时按钮禁用且不发送按键。
- 四个网站由 Mac 默认浏览器打开。
- “立即息屏”执行 `pmset displaysleepnow`。
- Token 总量和按模型调用次数与当日 JSONL 增量记录一致。
