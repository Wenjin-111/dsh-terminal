# dsh-terminal 验收记录

- 验收日期：重启后（网关 cordis.yml 于 21:03:59 重写，即重启时间点）
- 验收人：智能体（自动核查）+ 用户（UI 实际操作）

## 验收清单

| # | 项目 | 方法 | 结果 |
|---|---|---|---|
| 1 | 安装进 profile web | `dsh plugin --profile web add D:\Dsh_work\dsh-terminal`；package.json `dependencies` 出现 `link:` 规格 | ✅ 通过 |
| 2 | bundles 自动对账 | `dsh.profile.bundles` 末尾出现 `dsh-terminal` | ✅ 通过 |
| 3 | 网关重启后宿主半加载 | 无报错；工具注册进智能体；注入消息正常投递 | ✅ 通过 |
| 4 | client.js 静态资产 | `GET /plugins/dsh-terminal/client.js` → HTTP 200（305,698 B），ModuleLoader 壳完整 | ✅ 通过 |
| 5 | 首页引导数据 | 根页面包含 `dsh-terminal` 注册项 | ✅ 通过 |
| 6 | 面板 UI（开关/新建/标签/关闭/类型选择） | 用户实际操作：创建 终端1（cmd）、输入命令、点「提请智能体注意」 | ✅ 通过 |
| 7 | 智能体实时回显（inject） | 智能体收到「终端活动 · 终端1」回显（含用户输入 `hi` 与 cmd 报错） | ✅ 通过 |
| 8 | 「提请智能体注意」唤醒（followup） | 智能体收到「用户请求你关注 终端1…」 | ✅ 通过 |
| 9 | 只读工具读取存活终端（terminal.list / terminal.read） | `terminal_list` → `终端1: id=term-1, shell=powershell, cwd=D:\Dsh_work, 运行中`；`terminal_read` → 完整读出 `echo hello-agent` 及输出 `hello-agent` | ✅ 通过 |

## 待补项说明（已解决）

第 9 项已于补验轮通过：用户在面板保持 终端1（powershell）开启，智能体调用两个只读工具成功列出并读取实时输出。

排查记录：首次验收时 `terminal_list` 为空、`term-1` 报「不存在」。注入消息（inject）与唤醒消息（followup）均精确送达当前会话智能体，证明客户端 sessionId 与智能体会话 id 一致、键无错位；因此空列表的原因是终端在验收前已结束（用户关闭或网关再次重启），而非 bug。网关重启清空终端是该版本已声明的限制（README「已知限制」）。

## 结论

**9/9 项全部通过**：安装、对账、网关加载、静态资产、引导注册、面板 UI、实时回显注入、手动唤醒、只读工具读取存活终端，全链路验收完成。
