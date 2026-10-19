# OpenClaw Manager

OpenClaw 的跨平台部署与管理工具，提供 Electron 桌面应用和浏览器管理界面。支持本机 Docker 实例管理、SSH 远程部署、多设备切换，以及离线镜像传输。

当前版本：**1.0.5**。源码位于 [`platform/`](platform/)。

## 下载安装

前往 [GitHub Releases](https://github.com/ddlllooo/OpenClaw-Manager/releases) 下载：

| 安装包 | 适用系统 |
| --- | --- |
| `OpenClaw.Manager.Setup.1.0.5.exe` | Windows，包含 x64 / ARM64 安装资源 |
| `OpenClaw.Manager-1.0.5-arm64.dmg` | macOS Apple Silicon |
| `OpenClaw.Manager-1.0.5-x64.dmg` | macOS Intel |

Release 附带 `SHA256SUMS.txt`，用于核对下载文件。桌面应用自带运行时，无需另装 Node.js。本机部署需要 Docker CLI 和已启动的 Docker Linux 容器引擎；仅通过 SSH 管理远程设备时，本机可以不安装 Docker。

Linux 提供源码运行及 AppImage / deb 构建配置，本次未附带 Linux 安装包。macOS 构建未配置 Developer ID 签名和公证，系统可能要求在“隐私与安全性”中批准打开；请先确认下载来源及校验值。

## 功能

- **实例管理**：创建、启动、停止、重启、删除实例，调整 CPU / 内存配额，查看健康状态、日志与资源趋势。
- **模型和频道**：多个模型供应商、默认模型切换、模型能力识别、连通性测试及飞书频道配置。
- **对话和工作区**：流式对话、附件、会话管理、工作区与记忆文件编辑、定时任务、容器终端。
- **备份和恢复**：实例备份、保留数据恢复、升级保留与清理策略。
- **多设备管理**：SSH 密码 / 私钥认证、主机指纹核对、设备保存与切换、自动重连。
- **离线镜像传输**：本机 Docker 镜像通过 SSH 流式导入目标 Docker，支持取消、架构及内容校验、已有镜像跳过。

## 从源码运行

需要 **Node.js 22.12+** 和 npm。本机实例管理需要 Docker；在线备份需要 Python 3.9+。

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

### 常用配置

通过启动进程的环境变量配置；应用不会自动读取 `.env` 文件。

| 环境变量 | 用途 |
| --- | --- |
| `MANAGER_PORT` | 管理端口，默认 `18080` |
| `MANAGER_BIND_ADDRESS` | 监听地址，默认 `127.0.0.1` |
| `OPENCLAW_DATA_DIR` | 实例数据目录，直接指向 `instances` 目录 |
| `OPENCLAW_SSH_STATE_DIR` | 已保存 SSH 设备与加密凭据的存储目录 |
| `OPENCLAW_BACKUP_DIR` | 备份目录 |
| `OPENCLAW_BACKUP_PYTHON` | 备份使用的 Python 可执行文件 |

源码模式实例默认保存在 `platform/data/instances/`；打包应用使用 Electron 用户数据目录中的 `data/instances/`。运行数据与凭据不随源码提交。

### SSH 远程部署

1. 打开设备 / SSH 管理界面，填写主机、端口、用户名与认证信息。
2. 获取主机指纹，通过目标设备或可信渠道核对后确认。
3. 选择自动部署并连接，或连接已有 Manager。目标设备需启用 SSH、允许 TCP 转发，并允许该 SSH 用户直接执行 Docker 命令。
4. 进入远程管理页，创建和管理实例。

首次自动部署需要目标设备能下载构建基础镜像和依赖。离线设备可先仅建立 SSH，传入预先准备的 Manager 与 OpenClaw 镜像，再离线启动 Manager。镜像架构须与目标 Linux 容器引擎匹配。

### Docker 部署 Manager

在 `platform/` 中将 [`compose.env.example`](platform/compose.env.example) 复制为 `compose.env`，修改宿主机绝对目录、Docker socket 路径、UID/GID 等配置，创建所需挂载目录后运行：

```sh
docker compose --env-file compose.env up -d --build
```

示例路径需要按设备替换。完整说明见 [容器部署说明](platform/CONTAINER-DEPLOYMENT.txt)。

## 开发与构建

在 `platform/` 中执行：

```sh
npm test
npm run dist:win
# 在 macOS 上构建
npm run dist:mac
# 在 Linux 上构建
npm run dist:linux
```

安装包输出至 `platform/dist/`。构建钩子从 `package-lock.json` 自动生成 `deployment-lock.json`，供打包后的 SSH 部署使用。依赖、构建产物及此锁文件副本不进入 Git；安装包通过 Releases 分发。

## 项目结构

```text
platform/
  electron/            桌面入口
  public/              管理界面与终端前端资源
  src/                 Docker、SSH、实例与 API 实现
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
- [模型配置](platform/MODEL-CONFIG.txt)
- [实例功能](platform/INSTANCE-FEATURES.txt)
- [备份](platform/BACKUPS.txt)
- [启动与恢复](platform/STARTUP.txt)
- [升级保留策略](platform/UPGRADE-RETENTION.txt)

平台文档保留了历史部署与验收记录；其中引用的本地 `ops/` 报告不随本仓库发布。安装和源码运行以本文件为入口。

## 数据与访问安全

管理服务可以操作 Docker、执行容器终端命令和读写实例配置，仅应向可信用户提供访问。服务默认监听回环地址，远程管理建议通过 SSH 隧道。实例配置、SSH 设备存储和备份可能包含 API Key、Gateway Token 等凭据，请妥善保护，避免提交到版本库。
