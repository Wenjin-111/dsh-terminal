# dsh-terminal

DSH bundle 插件：在聊天界面打开交互式终端（node-pty + xterm.js），智能体可按需查看终端内容。

## 功能

- 悬浮终端窗（`shell.overlay` 层）：拖动标题栏移动位置、拖右下角手柄调整大小，位置与尺寸持久化（localStorage），`>_` 按钮控制显隐
- 同一会话可开多个终端（标签页切换）
- 终端类型可选：PowerShell / PowerShell 7 (pwsh) / Command Prompt（自动检测可用性，默认 PowerShell）
- 终端进程由插件在网关进程内用 node-pty（Windows ConPTY）管理，随会话保存、刷新页面后仍存活
- **智能体按需查看终端（无自动注入）**：
  - 终端输出不会自动注入智能体上下文；智能体需要时自行调用两个只读工具 `terminal_list` / `terminal_read` 拉取内容（`terminal_read` 支持 `offset` 分页回溯长输出，输出经 VT 状态机重建，无回显/重绘噪声）
  - 终端退出时发一条状态通知（仅非零退出码且非用户主动结束时唤醒智能体）
  - 面板「提请智能体注意」按钮唤醒智能体，由它自行调用 `terminal_read` 读取当前输出
- 深浅色主题跟随 DSW token 自动适配

## 安装

从 GitHub 安装（推荐）：

```bash
dsh plugin --profile web add github:Wenjin-111/dsh-terminal
```

或使用完整 git 地址：

```bash
dsh plugin --profile web add git+https://github.com/Wenjin-111/dsh-terminal.git
```

`dsh plugin add` 会把参数转发给 pnpm 安装到 profile，并在安装后自动对账：因本插件声明了 `dsh.bundle`，`dsh.profile.bundles` 会自动追加 `dsh-terminal`。

`lib/client.js` 已随仓库提交（预构建），git 安装无需任何构建步骤；本插件无 `prepare`/`install` 脚本，无需在 profile 的 `pnpm-workspace.yaml` 中配置 `allowBuilds`。

**重启网关后生效**：重启 `dsh web` 进程（重启会断开当前会话）。

> 依赖说明：宿主依赖 `@lydell/node-pty`（平台二进制通过其 optionalDependencies 预打包，无安装脚本）、`@deepseek-ai/dsh-typert-protocol` / `dsh-tools` / `dsh-llm`、`zod`。

## 使用

1. 重启后刷新页面，对话框右下角出现 `>_` 按钮，点击显示/隐藏终端窗口
2. 拖动窗口标题栏随意移动位置；拖右下角手柄调整大小（最小 340×220）；位置和大小自动记住，刷新后保持
3. 窗口头部选择终端类型，点击 `+` 新建终端（工作目录 = 当前会话工作区）
4. 直接在终端里敲命令；多个终端用标签页切换，`×` 关闭
5. 「提请智能体注意」：让智能体立即查看当前终端输出（它会用 `terminal_read` 读取）
6. 智能体侧：需要时自行调用 `terminal_list` / `terminal_read` 查看；终端退出或点「提请智能体注意」时会收到提示消息

## 卸载

```bash
dsh plugin --profile web remove dsh-terminal
# 再重启一次网关，入口消失
```

## 开发

本地修改源码时，先克隆并安装依赖：

```bash
git clone https://github.com/Wenjin-111/dsh-terminal.git
cd dsh-terminal
npm install          # 装 devDependencies（esbuild、xterm）与宿主依赖
npm run build:client # 把 src/client.jsx 打包成 lib/client.js
```

以本地目录（软链）方式安装进 profile（改代码后只需重启网关，无需重新 add）：

```bash
dsh plugin --profile web add link:./dsh-terminal   # 相对当前目录的本地路径
```

- Host 半：`lib/index.js`（PTY 管理 + terminalService RPC + 智能体注入 + 工具注册）
- Client 半源码：`src/client.jsx`（xterm.js + addon-fit + addon-web-links 打包进 client.js）
- 宿主侧冒烟测试：`node smoke-host.mjs`（真实 spawn PowerShell 验证 PTY/缓冲/注入）
- 单元/集成测试：`node test-echo.mjs`、`node test-host.mjs`

## 已知限制

- 终端会话只存在于网关进程内：重启网关后所有终端消失
- 终端绑定会话 id：切到另一个会话会看到那个会话自己的终端列表
- Windows 上默认使用 PowerShell 5.1；装了 pwsh 7 才可选
- 智能体对终端只读（无执行权限），用户输入的命令以网关进程权限运行（与本地终端一致）

## 安全提示

终端 = 在本机执行任意命令。插件不提供任何额外隔离：用户在终端里敲的命令与在系统终端里执行等效。
