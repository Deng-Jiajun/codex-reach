# Codex Reach 协作入口

## 项目定位与文档

Codex Reach 通过 Tailscale 为 Windows 上的现有 Codex App 提供 Android 手机入口。采用 Rust 本地服务、H5 界面、Capacitor APK 和手机原生 SQLite，Android 构建环境集中在 GitHub Actions。

开始或恢复项目任务时，先读取 [产品规格](docs/产品规格.md) 的「当前范围」和「当前待处理问题」，再按本次任务读取相关章节。涉及方案取舍、历史约定或用户反馈时，读取 [决策记录](docs/决策记录.md) 中对应条目。

- [产品规格](docs/产品规格.md) 保存当前有效需求、交互语义和验收要求
- [决策记录](docs/决策记录.md) 保存决定依据、后续修订和待确认取舍
- [README](README.md) 面向使用者，说明安装、同步升级和日常操作
- [CHANGELOG](CHANGELOG.md) 按发布版本记录变更、验证结果和构建链接
- [开发与验证](docs/开发与验证.md) 保存工具链、本地构建、签名和覆盖安装验证步骤

新确认的需求更新产品规格，改变原方案时补充决策记录。临时排查材料和测试产物放在已忽略的 `artifacts/` 中。当前用户指令优先于文档中的旧记录。

手机端布局、手势、输入、附件或阅读交互任务读取项目内的 [codex-reach-mobile-ux](.agents/skills/codex-reach-mobile-ux/SKILL.md)。该 skill 提供设计与验证方法，功能规则以产品规格为准。

## 接口与数据升级规则

- Reach 手机端和 Windows 服务只维护当前发布版本的通信接口。变更路由、字段或行为时同步更新两端及对应测试，移除已替代的旧接口
- 两端使用同一个 Reach 发布版本标识。手机在连接时核对服务版本，服务在处理业务请求前核对客户端版本。对端版本缺失或不一致时拒绝继续，提示安装配套版本。Android `versionCode` 用于 APK 覆盖安装
- 手机和电脑的 SQLite 数据库优先增量升级。可直接新增表、索引、可空列或对旧记录有明确默认值的列，用含旧数据的库验证升级后的读写
- 若变更会改变旧值含义、要求重建表或删除已有数据，先说明受影响的已交付数据、如何转换或保留、如何验证，再按确认的方案实施

## 实现入口

| 目录或文件 | 职责 |
| --- | --- |
| `src/main.ts`、`index.html`、`src/style.css` | 列表、聊天、选择器、状态显示与移动端布局 |
| `src/api.ts`、`src/task-options.ts` | 手机 API 请求及模型、思考深度选项 |
| `src/cache.ts`、`src/sync.ts` | Android 历史缓存、分页与实时结果合并 |
| `src/requests.ts`、`src/files.ts`、`src/chat-actions.ts` | 审批和问答、附件、消息引用 |
| `server/src/main.rs` | HTTP API 和桌面功能调度 |
| `server/src/desktop.rs` | App Tools 命名管道和桌面 IPC |
| `server/src/app_server.rs` | App Server 数据读取 |
| `server/src/model.rs` | 手机展示数据及桌面数据转换 |
| `server/src/outbox.rs`、`server/src/files.rs` | 操作回执持久化、文件访问和上传 |
| `scripts/`、`android/app/src/androidTest/` | 同步测试、合成服务和 Android 交互回归 |

## 相关验证

在仓库根目录按改动范围执行。

```powershell
npm test
npm run build
cargo fmt --manifest-path server/Cargo.toml --check
cargo test --manifest-path server/Cargo.toml --locked
git diff --check
```

Android 同步命令为 `npm run android:sync`。APK 构建、签名、模拟器回归和安装包检查使用 `.github/workflows/android-verification.yml`。本机日常开发使用 Rust、Node.js 和浏览器，Android Studio 按具体原生排查需要使用。

界面改动核对手机尺寸、安全区、键盘、返回与滚动行为。交付说明分别记录本地构建、自动测试、真实桌面交互和 Android 真机验收结果。用户负责最终手机验收。
