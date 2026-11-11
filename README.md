# Codex Reach

通过 Android 手机访问 Windows 电脑上正在运行的 Codex。采用 Rust 本地服务、H5 界面、Capacitor Android 和原生 SQLite，GitHub Actions 构建 Android APK 与 Windows 服务包。

当前版本为 `0.2.0-preview`，支持以下操作。

- 填写服务地址与访问密钥，连接电脑
- 按项目筛选本机会话，搜索已加载的标题，分页读取更多会话
- 分页阅读聊天正文，显示 Markdown、思考摘要和工具记录
- 向现有聊天发送消息，执行期间追加输入，通过桌面 IPC 获取实时更新
- 在 Android SQLite 中缓存每个已打开会话的最近 10 轮，按消息保存正文
- 保留输入草稿，应用返回前台或连接恢复后重新读取当前会话

新建、置顶、编辑消息、模型选择、审批操作和附件操作待接入。当前发送继承桌面对话的设置，待处理的审批在电脑端完成。

## 电脑端服务

从 Actions 下载 Windows 服务包，解压后保留可执行文件和同目录的 `web` 文件夹。首次使用时，用已授权作为手机入口的 Codex 聊天 ID 初始化配置。

```powershell
.\codex-reach-server.exe --init=来源聊天ID
```

配置保存在 `%LOCALAPPDATA%\CodexReach\server.json`，其中的访问密钥由程序生成。`CODEX_REACH_HOME` 可以指定独立运行目录。

保持 Codex 和 Tailscale 运行，查询电脑的 Tailscale IPv4 地址。把下面示例中的 `100.64.0.1` 替换为该地址后启动服务。

```powershell
tailscale ip -4
.\codex-reach-server.exe --listen=127.0.0.1:4317 --listen=100.64.0.1:4317
```

也可把监听地址写入 `server.json` 的 `listen` 数组，之后直接启动程序。服务默认监听 `127.0.0.1:4317`。

在电脑浏览器打开 `http://127.0.0.1:4317/setup`，查看手机使用的服务地址并复制访问密钥。该配置页面校验本机来源与 Host，聊天 API 使用 Bearer 密钥认证。

服务连接当前用户的 `codex-app-tools-*` 和 `codex-ipc` 命名管道。工具管道提供会话列表、历史读取，以及向未加载会话投递消息的入口。IPC 提供实时快照、版本化增量与运行中会话的发送入口。当前适配依据为 Codex Windows `26.1103.7773.0`。

## 手机端

1. 连接与电脑相同的 Tailscale 网络
2. 安装 Actions 产物中的 APK
3. 填写 `/setup` 页面显示的服务地址与访问密钥
4. 选择项目或对话，读取历史并发送消息

每条发送使用独立请求 ID。服务先将请求保存到本地 SQLite，再投递给桌面。相同 ID 的重复请求返回已有结果。连接中断或服务退出导致结果不确定时，界面保留草稿并提示核对聊天记录，由用户确认后恢复编辑。

验证包的 applicationId 为 `io.github.dengjiajun.codexreach.verification`，使用 CI 临时调试签名。跨 CI 运行安装时可能需要卸载旧包，卸载会清除手机端缓存和草稿。正式包的固定签名尚待配置。

## 验证

2026-11-11 的 `0.1.0` 验证包已通过 GitHub Actions 的 Android 16 x86_64 模拟器检查，以及 REDMI K80 Pro、Android 16 真机检查。真机批量写入 1000 条合成消息耗时 129 ms，连续读取两页历史耗时 2 ms，保存数据再次读取耗时 20 ms，两次数据标记一致。[初始 CI 验证记录](https://github.com/Deng-Jiajun/codex-reach/actions/runs/42858452985)

`0.2.0` 的 Windows 服务已在本机完成项目和会话查询、真实桌面对话收发、相同请求重复提交验证。执行中追加的输入已进入同一轮，页面发送取得预期回复。服务重启后发送记录保留，页面自动重连并保留草稿。Android 的网络交互和离线缓存由工作流中的合成服务检查，实际手机网络连通与交互需在安装后核对。

连接页保留「SQLite 检查」入口，覆盖以下内容。

- 从 WebView 通过 Capacitor 调用 Android SQLite 插件
- 批量写入 1000 条合成消息，按会话分页读取
- 在同一事务中替换最新轮次并保存同步位置
- 写入中途触发主键冲突，检查消息与同步位置均已回滚
- 关闭并重新打开连接后读取数据
- 在 CI 中停止应用进程，重新启动后核对消息、同步位置和持久化标记
- 检查 APK 签名、ZIP 16 KB 对齐和 64 位原生库的 ELF 加载段对齐

工作流还检查错误密钥、项目与会话加载、HTTP 消息发送、实时回复、Markdown 清理，以及强行停止进程后在离线状态读取聊天缓存和草稿。Windows 服务执行 Rust 单元测试，并构建可执行文件。

页面显示每项检查耗时。合成数据与 CI 模拟器耗时用于初步验证，真实长对话和手机性能另行测量。

## 工具链

| 组件 | 版本 |
| --- | --- |
| Rust | 1.96.0 |
| Node.js | 24 |
| Capacitor core / Android / CLI | 8.6.0 |
| Capacitor SQLite | 8.1.1 |
| JDK | 21，CI 提供 |
| Gradle | 8.14.3，使用 Wrapper |
| Android Gradle Plugin | 8.13.0 |
| Android SDK | min 24，compile / target 36 |

## 本地开发

```sh
npm ci
npm run dev
```

浏览器可预览页面。原生 SQLite 检查在 Android APK 内运行。

```powershell
cargo test --manifest-path server/Cargo.toml --locked
cargo run --manifest-path server/Cargo.toml -- --web-dir=dist
```

```sh
npm run android:sync
```

该命令构建 H5 并同步 Android 工程。安装包由 Actions 中的 `Android verification` 工作流生成。Android SDK、JDK 和 Gradle 构建环境由 CI 提供。

## 安装验证包

1. 打开 Actions 中成功完成的 `Android verification` 运行
2. 下载 `codex-reach-verification-运行编号` 产物，解压取得 `app-debug.apk`
3. 安装 APK，从连接页打开「SQLite 检查」，点击「运行全部检查」，确认全部通过并记录数据标记
4. 在系统设置中强行停止应用，重新打开后点击「检查已保存数据」，确认检查通过且数据标记一致

当前 CI 使用 Android 16 x86_64、4 KB 页大小的模拟器。16 KB 页大小环境的运行验证待完成，静态对齐检查结果可在产物中查看。

## 数据与配置

验证数据库使用合成数据。实际聊天缓存保存在手机应用目录，服务配置和发送记录保存在电脑的运行目录。仓库忽略数据库文件、`.env`、日志、keystore 和构建产物。Android 关闭 Capacitor 调试日志，服务日志只记录启动地址和运行错误。

## 依据

- [Capacitor Android 工作流](https://capacitorjs.com/docs/android)
- [SQLite 插件 8.1.1](https://github.com/capacitor-community/sqlite/releases/tag/v8.1.1)
- [Android 16 KB 页大小验证](https://developer.android.com/guide/practices/page-sizes)
