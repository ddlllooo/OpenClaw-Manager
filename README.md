# OpenClaw Manager

OpenClaw 的跨平台部署与管理工具，提供 Electron 桌面应用和浏览器管理界面。支持本机 Docker 实例管理、SSH 远程部署、多设备切换，以及离线镜像传输。

当前版本：**1.1.0**。源码位于 [`platform/`](platform/)。新版采用 React 管理界面，增加存储保护、加密备份和可选的运行隔离能力。

## 下载安装

前往 [v1.1.0 Release](https://github.com/ddlllooo/OpenClaw-Manager/releases/tag/v1.1.0) 下载 Windows 安装包：

| 安装包 | 适用系统 |
| --- | --- |
| [`OpenClaw.Manager.Setup.1.1.0.exe`](https://github.com/ddlllooo/OpenClaw-Manager/releases/download/v1.1.0/OpenClaw.Manager.Setup.1.1.0.exe) | Windows，包含 x64 / ARM64 安装资源 |
| `SHA256SUMS.txt` | 安装包及配套 blockmap 的 SHA-256 校验值 |

下载并运行 `.exe`，按安装向导选择目录。手动安装只需下载 `.exe`，无需单独下载 `.blockmap`。桌面应用自带运行时，无需另装 Node.js。本机部署需要 Docker CLI 和已启动的 Docker Linux 容器引擎；仅通过 SSH 管理远程设备时，本机可以不安装 Docker。Windows 本机部署请使用 Docker Desktop 的 Linux 容器模式。

在线备份是额外的宿主功能，需要 Python 3.9+；加密和沙箱工作区备份还需要 Python 能调用 Node.js，可安装 Node.js 并加入 PATH，或通过 `OPENCLAW_BACKUP_NODE` 指定可执行文件。桌面运行时不会自动配置给 Python 子进程。

可在 PowerShell 中执行 `Get-FileHash .\OpenClaw.Manager.Setup.1.1.0.exe -Algorithm SHA256`，与 Release 附带的 `SHA256SUMS.txt` 核对。Windows 安装包未配置代码签名，系统可能显示发布者未知提示；运行前请核对来源和校验值。

本次仅发布 Windows 安装包。macOS 用户可使用 [v1.0.5 历史安装包](https://github.com/ddlllooo/OpenClaw-Manager/releases/tag/v1.0.5)，或从当前源码构建；历史安装包不包含 1.1.0 的新功能。Linux 提供源码运行及 AppImage / deb 构建配置。

### 从旧版本升级

退出正在运行的桌面应用后安装新版。升级前备份实例数据、SSH 设备配置和备份解密密钥；继续使用原有用户数据目录，勿将运行数据复制到安装目录。现有实例不会自动启用隔离或迁移到硬配额存储；已部署的远程 Manager 也需要在目标设备上单独升级。Docker Compose 的独立控制服务迁移说明见 [平台文档](platform/README.md#独立-docker-控制服务)。

## 功能

- **实例管理**：创建、启动、停止、重启、删除实例，调整 CPU / 内存配额，查看健康状态、日志与资源趋势。
- **新版管理界面**：React、Vite、Tailwind CSS 和本地 shadcn/ui 组件，支持桌面与手机布局、设备切换、未保存编辑提示和流式状态更新。
- **模型和频道**：多个模型供应商、默认模型切换、模型能力识别、连通性测试及飞书频道配置。
- **对话和工作区**：流式对话、附件、会话管理、工作区与记忆文件编辑、定时任务、容器终端。
- **存储保护**：查看实例容量和宿主余量，设置告警、停止接单与保护停机阈值，清理预览、快照恢复和配置修复；保护解除后需手动启动实例。
- **备份和恢复**：AES-256-GCM 加密备份、完整性验证、保留数据恢复、升级保留与清理策略。解密密钥需独立保存，旧明文备份不会自动转换。
- **访问与运行隔离**：管理登录令牌、会话与 CSRF 校验、配置和日志脱敏、独立 Docker 控制服务；提供需显式部署的 Agent、插件和飞书隔离工具及出口规则。
- **多设备管理**：SSH 密码 / 私钥认证、主机指纹核对、设备保存与切换、自动重连。
- **离线镜像传输**：本机 Docker 镜像通过 SSH 流式导入目标 Docker，支持取消、架构及内容校验、已有镜像跳过。

Windows 本机目录使用容量监测与保护停机，无法提供文件系统硬配额。Linux XFS 项目配额及 macOS APFS 独立卷需要在对应宿主上配置并验证；Docker Desktop 的 Linux 引擎不代表 Windows 共享目录具备硬配额。可选隔离能力需要额外镜像、网络配置和显式迁移，安装桌面应用不会自动启用。详见 [平台功能与 API](platform/README.md) 和 [APFS 存储说明](platform/APFS-STORAGE.md)。

## 从源码运行

需要 **Node.js 22.12+** 和 npm。本机实例管理需要 Docker；在线备份需要 Python 3.9+，并能找到 Node.js 可执行文件。

```sh
git clone https://github.com/ddlllooo/OpenClaw-Manager.git
cd OpenClaw-Manager/platform
npm ci
npm start
```

浏览器打开 **http://127.0.0.1:18080**。其他启动方式：

```sh
# Electron 桌面开发模式
npm run app
# 浏览器后台服务
npm run web -- -d
# 停止由上述命令启动的后台服务
npm run web:stop
```

浏览器首次进入需要管理令牌。使用 `MANAGER_AUTH_TOKEN`，或读取实例目录旁的 `manager-auth/token`：默认源码路径为 `platform/data/manager-auth/token`。Electron 桌面应用会自动完成本机登录；退出登录会撤销现有会话及其流式连接。

### 常用配置

应用启动时自动读取 `platform/.env`，非空进程环境变量优先。可复制 `platform/.env.example` 为 `.env`，填写 `MANAGER_AUTH_TOKEN`（至少 32 个字符的随机令牌）。此文件属于 Manager 配置，与实例自己的 `.env` 不同；修改后重启 Manager 生效。`.env` 不提交 Git，也不会被打入镜像或前端资源。

| 环境变量 | 用途 |
| --- | --- |
| `MANAGER_PORT` | 管理端口，默认 `18080` |
| `MANAGER_BIND_ADDRESS` | 监听地址，默认 `127.0.0.1` |
| `MANAGER_AUTH_TOKEN` | 管理登录令牌；留空仍启用认证，自动使用持久随机令牌 |
| `OPENCLAW_ENV_FILE` | 自定义 Manager `.env` 文件的绝对路径 |
| `OPENCLAW_DATA_DIR` | 实例数据目录，直接指向 `instances` 目录 |
| `OPENCLAW_SSH_STATE_DIR` | 已保存 SSH 设备与加密凭据的存储目录 |
| `OPENCLAW_BACKUP_DIR` | 备份目录 |
| `OPENCLAW_BACKUP_PYTHON` | 备份使用的 Python 可执行文件 |
| `OPENCLAW_BACKUP_NODE` | 加密及沙箱备份使用的 Node.js 可执行文件；默认从 PATH 查找 |

源码模式实例默认保存在 `platform/data/instances/`；打包应用使用 Electron 用户数据目录中的 `data/instances/`。Windows 默认位于 `%APPDATA%\openclaw-docker\data\instances\`；桌面版自定义令牌可写入 `%APPDATA%\openclaw-docker\.env`，修改后重启应用。运行数据与凭据不随源码提交。

### SSH 远程部署

1. 打开设备 / SSH 管理界面，填写主机、端口、用户名与认证信息。
2. 获取主机指纹，通过目标设备或可信渠道核对后确认。
3. 选择自动部署并连接，或连接已有 Manager。目标设备需启用 SSH、允许 TCP 转发，并允许该 SSH 用户直接执行 Docker 命令。
4. 进入远程管理页，创建和管理实例。

首次自动部署需要目标设备能下载构建基础镜像和依赖。离线设备可先仅建立 SSH，传入预先准备的 Manager 与 OpenClaw 镜像，再离线启动 Manager。镜像架构须与目标 Linux 容器引擎匹配。

### Docker 部署 Manager

在 `platform/` 中将 [`compose.env.example`](platform/compose.env.example) 复制为 `compose.env`，将 [`.env.example`](platform/.env.example) 复制为 `.env` 并填写登录令牌，修改宿主机绝对目录、Docker socket 路径、UID/GID 等配置，创建所需挂载目录后运行。Compose 将 `.env` 以只读文件挂载给 Manager，令牌不进入镜像：

```sh
docker compose --env-file compose.env up -d --build
```

示例路径需要按设备替换。完整说明见 [容器部署说明](platform/CONTAINER-DEPLOYMENT.txt)。

## 开发与构建

在 `platform/` 中执行：

```sh
npm test
npm run build
npm run test:frontend
# 首次运行浏览器测试前安装测试浏览器
npx playwright install chromium
npm run test:ui
# Windows 上构建包含 x64 / ARM64 的 NSIS 安装包
npm run dist:win
# 在 macOS 上构建
npm run dist:mac
# 在 Linux 上构建
npm run dist:linux
```

安装包输出至 `platform/dist/`。构建钩子先编译 React 前端至 `platform/public/ui/`，再从 `package-lock.json` 自动生成 `deployment-lock.json`，供打包后的 SSH 部署使用。`npm start`、`npm run app` 和 `npm run web` 也会先构建前端；开发时可另开终端执行 `npm run build:watch`。依赖、构建产物及此锁文件副本不进入 Git；安装包通过 Releases 分发。

Windows 打包禁用原生依赖重编译，并排除 SSH 的可选 CPU 探测与加密二进制，使用 ssh2 的 JavaScript / Node.js crypto 实现，因此不需要 Visual Studio C++ 构建工具。若新增必需的原生运行依赖，需要重新评估此打包设置及各架构兼容性。

运行模块、依赖和脚本同时配置为 ASAR 外置文件，供独立 Docker 控制进程以及 Python 调用的 Node.js 备份脚本读取；复制解包后的应用时，需一并保留 `resources/app.asar.unpacked/`。

## 项目结构

```text
platform/
  electron/            桌面入口
  frontend/            React 管理界面、组件与浏览器测试
  public/ui/           前端构建产物（不进入 Git）
  public/              终端资源与旧界面兼容参考
  src/                 Docker、SSH、实例与 API 实现
  security/            Agent、插件与频道隔离运行组件
  scripts/             备份、启动与构建脚本
  test/                自动化测试与专项验证
  build/               应用图标
  control-ui-patches/   特定镜像的静态补丁与校验清单
  server.js            Web 服务入口
  Dockerfile           Manager 容器构建
  compose.yaml         容器部署配置
```

## 文档

- [平台功能与 API](platform/README.md)
- [React 管理界面与前端开发](platform/frontend/README.md)
- [macOS APFS 存储保护与迁移](platform/APFS-STORAGE.md)
- [模型配置](platform/MODEL-CONFIG.txt)
- [实例功能](platform/INSTANCE-FEATURES.txt)
- [备份](platform/BACKUPS.txt)
- [启动与恢复](platform/STARTUP.txt)
- [升级保留策略](platform/UPGRADE-RETENTION.txt)

平台文档保留了历史部署与验收记录；其中引用的本地 `ops/` 报告不随本仓库发布。安装和源码运行以本文件为入口。

## 数据与访问安全

管理服务可以操作 Docker、执行容器终端命令和读写实例配置，仅应向可信用户提供访问。服务默认监听回环地址，远程管理建议通过 SSH 隧道。实例配置、SSH 设备存储和备份可能包含 API Key、Gateway Token 等凭据，请妥善保护，避免提交到版本库。
