# Codex Reach

通过 Android 手机访问电脑上的 Codex。计划采用 Rust 本地服务、H5 界面、Capacitor Android 和原生 SQLite，Android 构建由 GitHub Actions 完成。

当前工程处于技术验证阶段，提供可安装的 SQLite 验证页面。聊天界面和 Rust 服务待实现。

2026-11-11 已在 GitHub Actions 的 Android 16 x86_64 模拟器中通过 SQLite 写入、分页、编辑替换、失败回滚和进程重启持久化检查，APK 签名与 16 KB 静态对齐检查也已通过。[验证记录](https://github.com/Deng-Jiajun/codex-reach/actions/runs/42857179646)

## 验证内容

- 从 WebView 通过 Capacitor 调用 Android SQLite 插件
- 批量写入 1000 条合成消息，按会话分页读取
- 在同一事务中替换最新轮次并保存同步位置
- 写入中途触发主键冲突，检查消息与同步位置均已回滚
- 关闭并重新打开连接后读取数据
- 在 CI 中停止应用进程，重新启动后核对消息、同步位置和持久化标记
- 检查 APK 签名、ZIP 16 KB 对齐和 64 位原生库的 ELF 加载段对齐

页面显示每项检查耗时。合成数据与 CI 模拟器耗时用于初步验证，真实长对话和手机性能另行测量。

## 工具链

| 组件 | 版本 |
| --- | --- |
| Node.js | 24 |
| Capacitor core / Android / CLI | 8.6.0 |
| Capacitor SQLite | 8.1.1 |
| JDK | 21，CI 提供 |
| Gradle | 8.14.3，使用 Wrapper |
| Android Gradle Plugin | 8.13.0 |
| Android SDK | min 24，compile / target 36 |

## 本地页面开发

```sh
npm ci
npm run dev
```

浏览器可预览页面。原生 SQLite 检查在 Android APK 内运行。

```sh
npm run android:sync
```

该命令构建 H5 并同步 Android 工程。安装包由 Actions 中的 `Android verification` 工作流生成，本地页面开发只需 Node.js。

## 安装验证包

1. 打开 Actions 中成功完成的 `Android verification` 运行
2. 下载 `codex-reach-verification-运行编号` 产物，解压取得 `app-debug.apk`
3. 安装 APK，点击「运行全部检查」，确认全部通过并记录数据标记
4. 在系统设置中强行停止应用，重新打开后点击「检查已保存数据」，确认检查通过且数据标记一致

验证包的 applicationId 为 `io.github.dengjiajun.codexreach.verification`，使用 CI 临时调试签名。不同 CI 运行生成的包可能需要卸载旧验证包后安装，卸载会清除验证数据。正式包的固定签名尚待配置。

当前 CI 使用 Android 16 x86_64 模拟器。ARM64 真机和 16 KB 页大小环境的运行验证待完成，静态对齐检查结果可在产物中查看。

## 数据与配置

验证数据库只包含合成数据。运行数据库、附件、本机配置及签名材料独立保存在运行环境中。仓库忽略数据库文件、`.env`、日志和 keystore。

## 依据

- [Capacitor Android 工作流](https://capacitorjs.com/docs/android)
- [SQLite 插件 8.1.1](https://github.com/capacitor-community/sqlite/releases/tag/v8.1.1)
- [Android 16 KB 页大小验证](https://developer.android.com/guide/practices/page-sizes)
