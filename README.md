# HTTP Touch Bar

> Status: Current · Last verified: 2026-09-08

把手机、平板或其他浏览器变成 Mac 的可信局域网触控副屏。

Mac 运行本地 Agent，浏览器通过 HTTP 完成配对、加载配置和执行预定义操作；状态与操作结果通过 WebSocket 推送。浏览器只能提交配置中的动作 ID，不能发送任意系统命令。

> 产品说明版本：**v1.3.0**（2026-09-08）。当前需求见 [`docs/requirements-v1.3.md`](docs/requirements-v1.3.md)；[`docs/requirements-v1.2.md`](docs/requirements-v1.2.md) 保留为历史版本说明。

## v1.3.0 概览

- 固定三个页面：系统监控、控制、快捷方式；导航占用保留底部空间，不覆盖页面内容。
- 自适应布局：宽度小于 `768px` 时单列；横屏且可用高度不超过 `520px` 时使用紧凑布局。
- 监控页依次显示系统资源、设备与 Agent、今日 AI 消费。默认三个分组均全宽；设备与 Agent 使用详情呈现，页面标题区域负责显示时间，不再单独放置“更新时间”状态项。
- 默认 AI 面板通过本地 `ccusage` 统计所有受支持的本地工具来源，当天按 Mac 本地时区计算，并展示来源和模型明细。
- QQ 音乐、系统控制、常驻网站和应用快捷方式仍由服务端配置的固定动作执行。
- 操作反馈成功后展示 5 秒；失败需要用户关闭，新的操作不会重播旧反馈。
- v1 JSON 配置仍可加载并自动归一化为 v2 固定页面布局；分组的 `presentation` 与 `span` 是可选提示，旧配置保持兼容。

## 环境

- macOS（优先 Apple Silicon）
- Node.js 24+
- pnpm 10+
- QQ 音乐默认 Bundle ID：`com.tencent.QQMusicMac`
- 构建 QQ 音乐原生快捷键助手需要 Xcode Command Line Tools
- `ccusage` `20.0.20` 由 Agent 依赖固定安装。其可选的平台原生二进制必须在常规 `pnpm install` 中成功安装，才能采集 AI 用量。

## 构建与启动

```bash
pnpm install
pnpm build
pnpm start
```

`pnpm build` 会先构建 Web 和协议，再编译 Agent 的 Swift 原生助手。Agent 启动后会输出局域网 URL、二维码和一次性六位配对码。手机/平板需与 Mac 位于同一可信局域网。

开发模式：

```bash
pnpm dev
```

默认配置位于 `apps/agent/config/default.json`，可分发示例位于 `config/touchbar.example.json`。自定义配置：

```bash
TOUCHBAR_CONFIG=/absolute/path/touchbar.json pnpm start
```

仓库中的 SubAPI 控制台地址为 `https://example.com/dashboard`，仅作占位。请将真实服务地址和其他个人配置放在 Git 忽略的 `.local/config/`，不要写回公开的默认配置或示例文件。例如：

```bash
mkdir -p .local/config
cp config/touchbar.example.json .local/config/touchbar.private.json
# 编辑本机配置后，以绝对路径传入 Agent：
TOUCHBAR_CONFIG="$PWD/.local/config/touchbar.private.json" pnpm start
```

配对凭证由 Agent 保存在用户目录下；本地配置、日志、采集报告、索引和构建产物不应提交到仓库。


设备管理：

```bash
pnpm devices list
pnpm devices revoke <device-id>
```

## QQ 音乐一次性配置

在 QQ 音乐中配置以下快捷键，并保持与默认 JSON 一致：

- 上一首：`Control + Option + Command + ←`
- 播放/暂停：`Control + Option + Command + Space`
- 下一首：`Control + Option + Command + →`

然后在“系统设置 → 隐私与安全性 → 辅助功能”中允许本地 Agent/原生助手。未授权时页面不会自动申请权限，QQ 音乐按钮会禁用并给出说明；本版本不改变 QQ 音乐的激活和快捷键投递策略。

QQ 音乐不提供可读取的标准播放状态，因此快捷键成功投递后显示**已发送**，不会伪装成**已验证成功**。

## AI 用量、范围与隐私

AI 面板运行固定版本的本地 `ccusage` CLI（`20.0.20`），读取该工具支持的本地来源，使用 JSON 输出和按 Agent 的分组结果汇总来源与模型。它只计算**今天**，以 Mac 本地时区为准；金额统一为 USD 估算值。

- 数据不是账户账单、API 全局用量或跨设备总额，也不提供 RMB、历史报表或手动价格编辑。
- 总 Token 沿用 `ccusage` 日报值；输入、输出、缓存读取、缓存写入分别展示。不得把日报、来源小计、模型明细三个重叠层级再次相加，也不在总 Token 上重复添加缓存。
- 缺少价格信息不表示免费：金额标记为未知或部分可估。当没有任何已知价格的金额可汇总时，总额显示 `—`。
- 上游未提供时，不显示调用次数或推理指标。
- Touch Bar Agent 只解析本地 CLI 的汇总 JSON，不接收、传输或展示提示词、回复正文及会话路径。`ccusage` 自身会在本机处理其支持的日志；这不代表底层工具从不读取含正文的日志文件。

采集首次触发时异步执行；有活动客户端时最多每 600 秒刷新一次，并使用 single-flight 避免并发重复采集。没有客户端时暂停；重连只在缓存过期后触发刷新。单次 CLI 调用超时为 60 秒；失败时保留当天缓存并标记为陈旧，跨过午夜则丢弃旧日期缓存。Agent 不会在后台执行 `npx`、下载“latest”版本或重新安装 `ccusage`。

如果 `ccusage` 命令或平台二进制不可用，AI 面板显示错误；Agent 的控制、配对和其他本地功能仍可用。

## 验证

完整集成验证由主线执行。配置范围可单独运行：

```bash
pnpm --filter @touchbar/agent exec vitest run test/config.test.ts
```

主线完整校验命令：

```bash
pnpm typecheck
pnpm test
pnpm build
```

## 安全边界

当前仅适用于可信局域网，使用 plain HTTP。不要通过端口转发将服务暴露到公网；公网访问需要 HTTPS、安全隧道或反向代理鉴权。
