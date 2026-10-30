# OpenClaw 跨平台 Docker 与 SSH 远程部署管理平台

当前版本：**1.1.0**。安装、升级、登录和构建步骤见 [项目 README](../README.md)，新版界面见 [前端说明](frontend/README.md)。本版本增加 React 管理界面、容量保护与加密恢复、独立 Docker 控制服务，以及可选的 Agent、插件和飞书隔离能力；macOS APFS 硬容量保护见 [APFS-STORAGE.md](APFS-STORAGE.md)。Windows 本次提供包含 x64 / ARM64 资源的 NSIS 安装包。

本文保留此前部署基线 `2026.10.16-ssh-image-transfer2` 的操作和验收记录，日期、服务器路径与既有定时任务仅适用于当时环境。涉及当前认证、Docker 控制服务与存储保护的行为，以项目 README 和本文后续对应功能章节为准。

| 使用方式 | macOS | Linux | Windows |
|---|---|---|---|
| Node.js Web / Electron 开发模式 | 支持 | 支持 | 支持 |
| 本机 Docker | Docker Desktop | Docker Engine / Desktop / rootless | Docker Desktop，Linux 容器模式 |
| SSH 客户端（本机可不装 Docker） | 密码 / 私钥 / Agent | 密码 / 私钥 / Agent | 密码 / 私钥；Agent 需设置 `SSH_AUTH_SOCK` |
| 桌面打包配置 | dmg / zip，arm64 / x64 | AppImage / deb，arm64 / x64 | NSIS，arm64 / x64 |

源码运行需要 Node.js 22.12+（推荐 24）和 npm；本机部署还需可用的 Docker CLI / Engine。原生进程的在线备份需要 Python 3.9+，Windows 使用 `python`、其他系统使用 `python3`，也可设置 `OPENCLAW_BACKUP_PYTHON`。SSH 自动部署的 Manager 镜像已包含 Docker CLI 与 Python。

### 通过 SSH 使用其他设备的资源

1. 在本机启动平台，点击「部署设备 / SSH」，填写目标主机、SSH 端口、用户名，以及密码或私钥。私钥支持口令，也支持使用运行平台进程的 `SSH_AUTH_SOCK`。
2. 点击「获取主机指纹」，通过目标设备或管理员提供的可信渠道核对 SHA256 指纹，再勾选确认。Linux/macOS 可在目标设备执行 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256`；若 SSH 协商了另一种主机密钥，请核对相应的主机公钥文件。指纹不匹配会终止连接。
3. 首次选择「自动部署并连接」；目标设备须已启用 SSH、允许 TCP 转发、运行 Docker 的 Linux 容器引擎，且 SSH 用户可以直接执行 `docker`。不会自动提权或安装目标设备的 Docker。Windows 目标支持 OpenSSH 的 cmd.exe 或 PowerShell 默认 shell，以及能够访问 Linux Docker 的 SSH 用户会话。
4. 等待远程构建完成，点击「进入远程管理」，在该页面开通实例。已存在的 Manager 可选择「连接已有 Manager」，填写其仅监听回环地址的管理端口。

远程模式的管理后端、实例配置、工作区、镜像和备份均位于目标 Docker。CPU/内存预算来自目标 Docker Engine；顶部磁盘空间来自目标数据所在文件系统（Docker Desktop 为其 Linux 虚拟机数据盘）。本机只承载界面和 SSH 转发，不把本机目录绑定给远程 Docker，也不复制本机已有实例。

自动部署使用容器 `openclaw-manager-ssh-<远程管理端口>` 和持久化卷 `<容器名>-data`，管理服务以 UID 1000 运行并加入目标 socket 所属组。同名容器只有带 `openclaw.ssh-manager=true` 标记才会复用，不覆盖已有容器。远程构建从白名单上传本项目源码和依赖清单，不包含 `data`、`ops`、本机 `node_modules` 或 SSH 凭据。自动部署首次需要目标设备能够下载构建镜像和 npm/Python 系统依赖；如需镜像代理，可在启动本机平台前设置 `OPENCLAW_SSH_NODE_IMAGE` 和 `OPENCLAW_SSH_DOCKER_CLI_IMAGE` 覆盖对应 Docker 构建基础镜像。

管理页面、API、日志 SSE、交互终端和实例 Control UI/WebSocket 均经 SSH 转发，本地监听仅使用 `127.0.0.1`，无需开放 Docker TCP 端口或实例公网端口。不同连接使用独立会话 cookie；原生进程自动分配本地端口，容器模式通过现有管理端口和独立的 `*.localhost` 来源提供访问。断开隧道或退出本机平台只关闭本地转发，远程 Manager 和实例继续运行。SSH 中断后需手动重新连接，密码/私钥不持久化，重启本机平台后需重新认证；连接记录也不落盘。此版本最多支持 8 个活动 SSH 连接。

Linux/Windows 原生运行及 SSH 自动部署中的「启动与恢复」由跨平台实现提供，支持实例 Docker 重启策略；容器化 Manager 也支持自身重启策略。Docker 开机启动需在目标系统配置；Linux/Windows 原生 Manager 开机启动需通过系统服务配置，页面会禁用不能控制的系统启动项。原有 macOS 宿主控制服务仍保留原流程。新设备不会自动继承文中旧 Mac 服务器的每日备份计划。

### 离线镜像传输与自动导入

1. 本机 Docker 中先准备与目标架构一致的 OpenClaw 镜像；需要在完全离线的新设备上运行 Manager 时，还须在本机预先构建本项目的 Manager 镜像，例如 `docker build -t openclaw-manager:offline .`（此构建在联网的本机完成）。
2. 已连接远程 Manager 的设备可以直接传输；没有 Manager 的离线设备，连接方式选择「仅建立 SSH（离线传镜像）」。此模式只需目标的 SSH 与 Docker 可用，不要求目标预先运行 Node.js 或 Manager。
3. 在「将本机镜像传到设备」中点击「读取 / 刷新本机镜像」，选择镜像与目标设备，点击「传输并导入」。可传输带标签的 OpenClaw 镜像及 Manager 镜像；普通基础镜像不会出现在选择器中。
4. 设备卡片显示检查、导出/传输、目标导入和校验阶段，以及已传输字节、平均速率与镜像架构。Docker 导出流没有精确的预先总大小，因此使用持续进度指示，不显示推算的百分比。可以取消，关闭弹窗不影响任务；断开 SSH 会取消传输。
5. 完全离线的新设备依次传输 Manager 和 OpenClaw 镜像后，点击设备卡片中的「离线启动 Manager」。该流程只使用目标已有镜像，不执行远程 build/pull，启动时指定 `--pull=never`；已有同名受管 Manager 会复用。然后进入远程管理页，选择已导入的 OpenClaw 镜像开通实例。

传输由本机后端直接读取 Docker 镜像，流经 SSH 后交给目标的 `docker image load`，不经过浏览器上传，也不在本机或远程生成额外 tar 文件。Docker 自身仍需磁盘空间保存/解包镜像层；空间不足会明确报告失败。传输仅使用本机已有镜像，不会自动下载源镜像。仅支持与目标 Linux 容器引擎原生架构相符的镜像；例如 amd64 与 arm64 不会自动互相转换。手头只有已导出的 tar 文件时，需先在本机通过 `docker load` 导入，再在本平台选择。

导出固定的不可变镜像 ID，并且不携带源标签。导入后校验配置、架构及文件层，再恢复用户选择的那一个标签并复查；Docker 经典存储与 containerd 存储导致的外层 ID 差异，通过导出清单中的配置 ID 进行校验。目标已有相同镜像时跳过传输；同名而内容不同，或导入期间目标标签发生冲突，均不会主动覆盖原标签。取消或失败不删除已导入的镜像/镜像层，也不停止实例；修复原因后可以重新传输（不支持断点续传）。每台设备一次仅允许一个镜像任务，全平台最多两个并行任务，传输期间本机自动镜像清理会等待。任务状态仅保存在当前平台进程中，重启后不保留历史。

源镜像导出和目标导入分别遵循 Docker 的 [image save](https://docs.docker.com/reference/cli/docker/image/save/) 与 [image load](https://docs.docker.com/reference/cli/docker/image/load/) 归档语义；隧道只传输镜像内容，不包含平台的实例配置、工作区或 SSH 凭据。

2026-10-16 外部 Linux 实测：通过本机新版 Manager 的正式会话/API，以 Ed25519 密钥连接用户提供的 Ubuntu/Docker 29.7.2 测试服务器。约 4 MB 时取消传输成功；随后完整传输 48,374,272 字节 QA 镜像、自动导入并验证 ID，在目标以 `--network none --pull=never` 成功执行；再次传输命中缓存、发送 0 字节。测试前后的原有容器 ID/名称/镜像/运行状态一致，专用 QA 镜像已清理。报告位于仓库 `ops/ssh-image-live-verification.json`。该记录使用 Windows 本机临时 Manager，验证镜像传输与离线运行链路；QA 镜像用于测试，不是真实 OpenClaw 业务镜像。

生产验收：已将 `2026.10.16-ssh-image-transfer2` 部署到 Mac `192.168.40.3` 并重启 Manager，候选 ARM64 Linux 镜像内全部 158 项测试通过。通过实际运行的 Mac 平台再次连接 Linux 测试服务器，完成取消、完整传输、自动导入、离线运行和缓存跳过；并使用独立临时 Manager 验证 SSH 管理页，浏览器显示目标设备 2 核、3.6 GiB 内存及约 18.9 GiB 可用磁盘。两端现有业务容器保持原状，Mac 实例配置与启动设置保持原状；专用测试容器、镜像和连接均已清理。部署与验收报告分别为 `ops/mac-ssh-image-deployment-verification.json`、`ops/ssh-image-production-verification.json`。未传输完整 OpenClaw 业务镜像。

验证记录：Windows Node.js 与 Linux 容器环境各通过 158 项 Node 测试；在线备份在 Linux 通过 8 项、Windows 通过 7 项，另 1 项因当前用户没有符号链接权限而跳过。新增测试覆盖流式导入、经典/containerd ID 兼容、缓存跳过、架构/标签冲突、损坏/不完整流、磁盘错误、取消与并发上限，以及无 Manager 的 SSH 模式和不 build/pull 的离线启动。`node test/ssh-image-smoke.cjs` 使用临时 SSH 服务和真实本机 Docker，成功导出、传输、导入并校验 48,374,272 字节的独立 QA 镜像；测试结束删除其专用镜像标签与容器，未使用真实 OpenClaw 数据或外部设备。原有 SSH、终端、SSE、会话和后台启动测试继续保留。Windows 上实际连接 Docker 命名管道及挂载验证见 `node test/docker-platform-smoke.cjs`。已在真实 macOS ARM64 主机完成 Manager 容器构建、测试及更新；未在 Windows ARM 设备运行，未生成各平台安装包。容器模式将每个 SSH 设备的管理页与 Gateway 放在独立的 `*.localhost` 来源，并通过现有管理端口访问；建议使用支持 localhost 子域名的 Chromium 浏览器。

当前维护版本：`1.1.0`；原有服务器部署基线为 `2026.10.15-instance-features1`。历史修复及部署验证见 `RELEASE-NOTES.txt`，每日备份见 `BACKUPS.txt`，页面降耗检查见 `ENERGY.txt` 和 `CONTROL-UI-ENERGY.txt`。下述 LaunchAgent、备份路径与定时计划均为原有 Mac 服务器配置。

服务器已配置每天 03:30（上海时间）在线备份全部实例与保留数据，保留最近 7 天。平台顶部显示成功/失败及下次运行，可立即备份或重试。数据库使用在线备份，不停止业务容器；备份默认保存在 `/Users/livzon/openclaw-backups/daily`。

管理页面仍仅监听本机回环地址。浏览器会自动建立带 HttpOnly/SameSite cookie 的本机管理会话；API 和终端要求该会话，写请求还要求 CSRF 校验。脚本客户端需先访问 `/api/session` 保存 cookie 和返回的 `csrf`，写请求带 `X-CSRF-Token`。Host/Origin 必须与管理端端口匹配。这是单用户本机平台的来源隔离，不是多用户账号权限系统。

配置编辑带版本冲突检查，校验通过后原子保存，并保留 `.bak.1`～`.bak.3` 和待应用配置的 `.last-good`。环境变量变更后，重启会安全重建容器并等待 `/readyz`；旧容器以 `-rollback-时间戳` 名称停止保留，数据挂载不变。不要同时手动启动旧、新容器。

新建/重建容器已修正健康检查脚本绝对路径，Docker 日志限制为每文件 `10m`、最多 `3` 份。模型克隆默认不复制渠道身份。Gateway Token 不再随实例列表返回，显示/复制时单独读取。执行 `npm test` 可运行缺陷回归测试。

通过 Web 界面在本地 Docker 中自动化开通、配置和监控 OpenClaw 实例。每个实例拥有独立容器、独立配置目录与独立端口。

## 启动

```bash
npm install
npm start        # Web 模式，监听 http://127.0.0.1:18080
```

### 桌面应用（Electron）

```bash
npm run app      # 以桌面应用运行（无需打包，改动代码后重启即可）
npm run dist     # 为当前系统打包（输出到 dist/）
npm run dist:mac # macOS dmg + zip
npm run dist:win # Windows NSIS 安装包
npm run dist:linux # Linux AppImage + deb
npm run watch    # 监听源码变化自动重新打包当前系统应用并重启（开发用）
```

### 原有 Mac 服务器配置（开机自启）

本机已配置 LaunchAgent `com.openclaw.manager.web`：登录时自动以 web 模式启动并常驻（`KeepAlive` 崩溃自动拉起），监听 `http://127.0.0.1:18080`，数据目录为仓库 `data/instances`。日志在 `/tmp/openclaw-web.log`。

```bash
launchctl kickstart -k gui/$(id -u)/com.openclaw.manager.web   # 重启服务
launchctl bootout gui/$(id -u)/com.openclaw.manager.web        # 停止并卸载
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.manager.web.plist  # 重新启用
```

与桌面应用共用 18080 端口，二者同时只能跑一个。临时改用桌面应用前先卸载 agent，用完再按上面命令恢复。

### 网页模式（手动）

与桌面应用同一套服务端代码，仅以纯 Web 服务方式供浏览器访问；默认使用仓库 `data/instances` 目录（桌面应用用的是用户目录副本，两边实例列表相互独立）。

```bash
npm run web            # 前台启动（Ctrl+C 停止）
npm run web -- -d      # 跨平台后台启动；输出日志路径（系统临时目录）
npm run web:stop       # 停止后台实例
PORT=18081 npm run web # macOS / Linux 自定义端口
# Windows PowerShell: $env:MANAGER_PORT='18081'; npm run web
```

注意：web 模式与桌面应用共用 18080 端口，二者同时只能跑一个；脚本检测到端口被占用（含桌面应用在运行）会给出提示而不是报错退出。

打包后的 `OpenClaw Manager.app`：
- 数据目录在 `~/Library/Application Support/openclaw-docker/data/instances/`（首次启动自动从仓库 `data/instances` 迁移）；可用环境变量 `OPENCLAW_DATA_DIR` 指向其它实例目录。
- 单实例锁：重复启动会唤起已有窗口，不会开第二个管理进程。
- 未签名构建（`identity: null`）：首次打开如被 Gatekeeper 拦截，右键 → 打开，或 `xattr -cr "OpenClaw Manager.app"`。

本机部署前提：已安装并运行 Docker Desktop（Windows 请选择 Linux 容器）或 Linux Docker Engine，并安装 Docker CLI。仅作为 SSH 客户端时，本机无需 Docker。支持 `DOCKER_SOCKET` 或 unix/npipe 格式的 `DOCKER_HOST`，Docker API 与 CLI 会使用同一个 socket；远程设备使用页面 SSH 功能。
若 Docker Hub 直连失败，可用环境变量 `DOCKER_MIRROR_PREFIX=docker.1ms.run` 走镜像加速拉取；Electron 下载慢可设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

## 功能

- **实例列表与详情**：详情页按 概览 / 模型与飞书 / 配置文件 / 日志 分区展示；实例可改名；列表按创建时间倒序。
- **配置克隆开通**：开通时可选择从现有实例复制模型/渠道配置（不含 Gateway 凭据），新实例免重复配置。
- **恢复保留数据**：删除时保留的数据可在侧栏「恢复保留的实例」中一键恢复回列表（端口冲突时自动改配）。
- **本地镜像仓库**：可将 OpenClaw 镜像预下载到本地 Docker 存储，之后开通实例直接读取本地镜像、完全离线部署，避免开通时网络超时。支持镜像列表/预下载（SSE 进度）/删除；删除被占用的镜像会得到明确提示。
- **自动化开通**：填写名称/镜像/端口即创建实例；镜像缺失时自动拉取（进度经 SSE 实时推送）；自动生成 Gateway Token、`openclaw.json`、`.env` 与独立配置目录（`data/instances/<id>/`）；拉取失败会保留记录并在详情页显示错误与「重试启动」。
- **系统资源配置**：开通时表单按宿主机总资源减去现有实例已分配量自动计算并预填推荐值（剩余 CPU 的 20%、剩余内存的 1/3，带下限保护），并显示计算依据，用户可自行修改；运行中调整经 `docker update` 即时生效。
- **容器性能监测**：每 3s 采样 CPU%、内存用量/上限、网络收发速率，经 SSE 推送实时刷新，并绘制最近 2 分钟 CPU/内存趋势 sparkline。
- **健康监测**：每 10s 探测 `/healthz` 与 `/readyz`，前端显示 健康·就绪 / 启动中 / 已停止 等状态徽标。
- **OpenClaw 配置**：在线编辑 `openclaw.json`（JSON 校验、一键格式化）与 `.env`（密钥脱敏显示；掩码行保存时自动还原原值，不会写坏密钥）。
- **模型配置**：为实例添加任意多个模型供应商（base_url / api_key / model，OpenAI 兼容接口）。「当前使用」卡片集中展示生效中的模型与凭据摘要，可直接测试连通；添加模型走独立表单，支持「复用现有模型的凭据」（同一供应商的多个模型免重复粘贴 api_key），也可取消「设为当前使用」仅保存备用；已保存的模型可随时**编辑**（改名 / base_url / api_key / 上下文长度，当前使用中的模型改名后自动跟随）；列表每行可单独 测试 / 复制凭据 / 切换默认 / 编辑 / 删除。新增模型自动识别**输入模态与上下文长度**，可手动指定文本/文本＋图像及实际 tokens，未知能力需手动填写；编辑仅更新修改字段，留空保留原值，并保留高级模型及供应商属性。点击「识别模型能力」可重新识别并预览，保存后生效。支持已有共享供应商配置；详见 `MODEL-CONFIG.txt`。api_key 保存后脱敏显示，留空表示保持原值。
- **飞书频道**：填写飞书企业自建应用的 App ID / App Secret 即可启用飞书频道（自动安装/启用 `@openclaw/feishu` 插件并重启实例建立 WebSocket 长连接），之后在飞书中 @机器人 即可对话；"检测连接"探测凭证有效性与连接状态。App Secret 脱敏显示，留空表示保持原值。
- **对话弹窗**：实例详情页"对话"按钮打开弹窗，通过实例 Gateway 运行 agent 回合（默认模型可配），直接在管理界面与 OpenClaw 对话，无需打开 Control UI；对话历史按实例独立保存。
- **交互式会话管理**：详情页新增「会话」页签，全部在管理平台内完成，无需进入 Control UI：会话列表（过滤、条数选择 50/100/500/全部、含子代理会话徽标区分）；查看完整历史 transcript（user/assistant/tool 消息、工具调用与结果、模型与 token 统计）；继续会话对话（在既有会话上下文上追加一个 agent 回合）；删除 / 归档 / 压缩会话（LLM 摘要压缩，或按行数截断保留末尾 N 行）。历史通过 `openclaw sessions export-trajectory` 导出事件流后归约为 chat 消息展示。
- **容器终端**：详情页「终端」页签提供浏览器内交互式 shell（xterm.js，经 WebSocket 桥接到 `docker exec` TTY），以 node 用户直接进入实例容器（工作目录 `/home/node`），支持 vim、Ctrl-C、窗口自适应 resize、断线自动重连与清屏/重连按钮；可用环境变量 `OPENCLAW_TERMINAL_SHELL=sh` 改用 sh。终端对配置文件与凭据有完整读写权限，请谨慎操作。
- **生命周期**：启动 / 停止 / 重启 / 删除（可选保留数据，操作期间按钮禁用防止重复点击）；Gateway Token 默认脱敏，支持一键复制/显示；容器日志支持行数选择、关键字过滤、自动刷新与下载。

新增功能（详见 `INSTANCE-FEATURES.txt`）：
- **工作区与记忆**：角色/规则/记忆文件编辑，保存前内容对照，冲突检测和最近 20 个历史版本恢复。
- **定时任务**：原生 OpenClaw 任务的新建、编辑、启停、立即执行与记录查询，支持 Cron/间隔/单次时间；默认停用且不推送。
- **附件对话**：图片与 PDF/文本/Office 文件上传，原生视觉输入、流式回复和停止生成；最多 4 个文件，单个 10MB、合计 20MB。
- **一键诊断**：概览页检查配置、容器、网关和 OpenClaw 诊断结果，只读执行并脱敏展示。

## API 概览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/instances` | 列表 / 开通（POST 可带 `cloneFrom` 复制配置） |
| PATCH | `/api/instances/:id` | 实例改名 |
| GET | `/api/instances/kept` | 保留数据（`<id>.kept`）列表 |
| POST | `/api/instances/kept/:id/restore` | 恢复保留数据为可用实例 |
| POST | `/api/instances/:id/clear-error` | 清除详情页错误提示 |
| POST | `/api/instances/:id/start\|stop\|restart` | 生命周期 |
| PATCH | `/api/instances/:id/resources` | 运行时资源调整 |
| GET/PUT | `/api/instances/:id/config` | openclaw.json |
| GET/PUT | `/api/instances/:id/env` | .env（读取脱敏；保存时掩码行自动还原） |
| GET/PUT | `/api/instances/:id/model` | 模型配置（base_url/api_key/model，PUT 可带 contextWindow/input；POST `/model/detect` 识别能力） |
| POST | `/api/instances/:id/model/test` | 模型连通测试（真实 agent 回合） |
| GET/PUT | `/api/instances/:id/feishu` | 飞书凭证配置（保存后自动重启实例） |
| POST | `/api/instances/:id/feishu/test` | 飞书连接探测 |
| POST | `/api/instances/:id/chat` | 对话：运行一个 agent 回合并返回回复 |
| GET | `/api/instances/:id/sessions?limit=N` | 会话列表（limit 支持 50/100/500/all，含子代理） |
| GET | `/api/instances/:id/sessions/:key/messages` | 会话历史 transcript（export-trajectory 归约为 chat 消息） |
| POST | `/api/instances/:id/sessions/:key/messages` | 继续会话：在既有会话上下文运行一个 agent 回合 |
| POST | `/api/instances/:id/sessions/delete\|archive` | 批量删除 / 归档会话（body: `{keys:[...]}`） |
| POST | `/api/instances/:id/sessions/compact` | 压缩会话上下文（可选 `maxLines` 按行截断） |
| GET | `/api/instances/:id/logs?tail=N` | 容器日志（tail 默认 200，上限 5000） |
| WS | `/api/instances/:id/terminal` | 交互式终端（WebSocket ⇄ `docker exec` TTY；二进制帧为输入输出，文本帧为 resize/错误/退出控制） |
| DELETE | `/api/instances/:id?keepData=1` | 删除容器并从列表移除；数据改名保留为 `data/instances/<id>.kept` |
| GET/POST | `/api/images`、`/api/images/pull` | 本地镜像列表 / 预下载 |
| DELETE | `/api/images/:tag` | 删除本地镜像（占用中返回 409） |
| GET | `/api/system` | 宿主机资源概况 |
| GET | `/api/connections/context` | 当前本机 / SSH 管理页面上下文 |
| GET/POST | `/api/connections` | 活动 SSH 连接 / 创建异步连接任务 |
| POST | `/api/connections/probe` | 获取待核对的 SSH 主机指纹 |
| DELETE | `/api/connections/:id` | 关闭隧道（不停止远程容器） |
| GET | `/api/connections/local-images` | 本机可传输的 OpenClaw / Manager 镜像 |
| POST | `/api/connections/:id/images/transfer` | `{image,imageId}` 开始异步流式传输和自动导入；进度在连接记录的 `transfer` 中 |
| POST | `/api/connections/:id/images/cancel` | 取消当前镜像传输 |
| POST | `/api/connections/:id/deploy-offline` | 仅 SSH 连接上使用已传入的 Manager 镜像离线启动管理服务 |
| GET | `/api/events` | SSE（stats/health/pull/lifecycle） |

## 安全提示

- 配置目录含 Gateway Token 与凭据（OAuth token 明文存于 SQLite），请按敏感文件对待。
- Gateway 仅绑定 `127.0.0.1`；如需局域网访问请自行评估 OpenClaw 安全加固指南。

Safari 页面降耗：后台暂停 SSE 监控和定时刷新，回前台恢复；可见页面合并监控重绘至最多每 5 秒一次。实例列表兜底刷新 30 秒，备份提示/启用的日志自动刷新 15 秒。隐藏终端不再闪烁光标，尺寸不变不重复发送 resize；不中断终端 shell 或服务器备份。刷新后新前端才会生效。


## 管理认证与模型密钥边界

管理端不再向匿名客户端自动签发会话。首次启动会在实例数据目录的父目录下生成 `manager-auth/token`，启动日志仅输出路径，不输出凭证。网页首次登录需输入文件中的凭证；也可设置 `MANAGER_AUTH_TOKEN` 为至少 32 字符的随机凭证。不要把凭证写进 Git、URL 查询参数或分享日志。会话有效期为 8 小时，原有 Host/Origin、CSRF 和 HttpOnly Cookie 校验保留。桌面端自动完成认证；网页后台启动和停止命令继续可用。

可在本目录创建 `.env`（模板为 [`.env.example`](.env.example)），填写 `MANAGER_AUTH_TOKEN`。源码模式的服务、桌面端和后台启动器都会自动读取它；非空进程环境变量优先，`OPENCLAW_ENV_FILE` 可指定其他配置文件。打包的桌面应用可在 Electron 用户数据目录放置 `.env`。令牌留空时仍使用自动生成的持久令牌，认证不会关闭。Docker Compose 把项目 `.env` 只读挂载到 `/run/openclaw-manager.env`，不将凭据打入镜像。修改配置后重启 Manager 并重新登录，不需要重启业务实例。

左侧菜单底部的“退出登录”通过 `DELETE /api/session` 注销当前会话，清除会话 Cookie，并断开该会话的实时事件流与终端连接。退出后刷新页面仍需重新输入令牌；其他独立登录会话及运行中的业务实例不受影响。

Compose 默认文件位置是 `${MANAGER_DATA_HOME}/manager-auth/token`，由已有数据挂载持久保存。SSH 远程页需输入远程 Manager 的凭证（不是本机凭证或 SSH 密码）。自动 SSH 部署的数据卷内，文件位于实例目录的同级 `manager-auth/token`；可由具备该远程 Docker 管理权限的管理员读取。旧远程 Manager 仍可连接，但需要升级远程服务才能获得新认证保护。

凭证文件和启动器状态文件属于秘密，数据目录和 `OPENCLAW_WEB_STATE_DIR` 应仅允许当前用户访问；Windows 上需用 NTFS ACL 保护这些目录，POSIX 文件 mode 不替代 Windows ACL。删除凭证文件后重启可生成新凭证；若配置了环境变量，应修改环境变量并重启。重启会使现有会话失效。

模型 API Key 仅可自动复用于相同来源（协议、主机、端口）的地址；同源路径调整、模型改名和元数据编辑保持兼容。更改来源时必须显式重新填写密钥，`copyKeyFrom` 同样受此限制。自动探测不跟随重定向。

新增或修改模型配置及自动探测默认使用 HTTPS；`localhost`、`127.0.0.1` 和 `::1` 的 HTTP 接口保留支持。可信局域网 HTTP 模型服务需在 Manager 环境变量 `MANAGER_MODEL_HTTP_ORIGINS` 中逐个配置完整来源，例如 `http://192.168.1.10:11434`，多个来源用逗号分隔；此配置明确允许明文传输。Compose 已传入这两个环境变量，SSH 自动部署可在远程 Manager 中单独配置。现有运行中模型配置不会被自动改写。

本次边界不替代完整网络出口控制：HTTPS 内网地址仍可用于自托管模型，尚未实现 DNS/IP 级 SSRF 隔离或 Agent 工具沙箱。


## 容器权限、Agent 工具和出口加固

新建/重建实例强制使用非 root 用户、删除全部 Linux capabilities、禁止通过 setuid 等方式提权，并在未指定时限制为 512 个进程。网关端口始终只发布到 127.0.0.1。只允许挂载该实例的配置、工作区、认证目录，拒绝符号链接和额外挂载。升级不再继承任意 HostConfig；危险旧权限、宿主命名空间、设备和 Docker socket 等额外挂载会在停止旧实例之前被拒绝。平台的容器检查和启停、删除、资源修改会核验受管标签，拒绝操作无关容器。已有运行容器的权限不会通过普通重启改变，需要重建/升级才生效。

默认 `OPENCLAW_AGENT_POLICY=compatible` 保留当前工具能力。可选 `restricted` 会为新实例设置 `tools.fs.workspaceOnly=true`、禁用 elevated，并拒绝运行时命令、网页/浏览器、远程节点、Agent 发消息和管理工具。模型调用及已有渠道正常回复仍保留。既有实例可先运行 `node scripts/restrict-agent.cjs INSTANCE_ID` 预览，再加 `--apply`，通过实例当前版本的 schema 校验后备份并保存；之后在 Manager 中配置 restricted 并重启实例。脚本必须使用该设备正确的 OPENCLAW_DATA_DIR。受限模式下后续配置保存/克隆不允许删除必要规则；已有不合规配置需要先迁移才可重建。

这属于工具禁用策略和容器权限收紧，并不提供独立命令沙箱：restricted 禁止执行命令，compatible 的命令仍运行在网关容器里。预先安装的恶意插件仍可能在网关进程内运行。平台没有为启用 OpenClaw Docker sandbox 而给实例挂载宿主 Docker socket；当前镜像缺少独立沙箱运行时，不能把配置开关当作已实现的命令隔离。参考官方工具权限说明：https://docs.openclaw.ai/gateway/security/tool-permissions 和 Docker sandbox 说明：https://docs.openclaw.ai/gateway/sandboxing/docker-backend 。

默认 `OPENCLAW_INSTANCE_EGRESS=compatible` 保留现有联网。可选 `offline` 为每个新建/重建实例创建带归属标签的 Docker internal bridge，关闭该网络容器互通，并把 DNS 指向容器自身回环地址；若网络被同名替换、失去 internal 标志或归属不符，创建失败，绝不退回普通 bridge。它会使模型 API、飞书等外部服务不可达，适用于离线审查/隔离，不适合继续使用云端模型的生产实例。已有容器不会自动切换网络，需重建；停机或删除实例后网络保留，管理员可在无容器使用时删除 `openclaw-isolated-实例ID`。

Docker internal 网络阻断对外路由，不等价于完整域名允许列表，也不隔离 Docker 宿主机可达服务。容器化 Manager 的跨网络健康检查可能不可达，启用前应在目标部署验证；失败时保持现有回滚流程。需要正常访问模型和渠道并限制其他出口的场景，仍需部署专用出口代理/宿主防火墙，不能单靠 HTTP_PROXY 环境变量。

早期加固只提供应用内 Docker 参数限制；当前独立控制服务已将 Compose 中的原始 socket 挂载移出 Manager，具体迁移范围与原生部署边界见下文“独立 Docker 控制服务”。

验证：`npm test`；真实隔离冒烟检查 `node test/security-smoke.cjs` 使用本地 OpenClaw 镜像（可用 SECURITY_SMOKE_IMAGE 指定），仅创建独立临时实例/网络，检查非 root、capabilities、禁止提权、外部 TCP 不可达，以及 restricted 配置通过当前镜像 schema；结束后清理测试容器、网络和目录。


## 配置、日志和备份的保密处理

配置编辑器默认脱敏 API Key、Token、密码、私钥、认证头及 env 等字段，使用绑定字段位置与原值的占位符。原样保存会在服务端恢复密钥；移动/篡改占位符会被拒绝。显式输入新值仍可更新密钥，删除字段仍会删除对应配置。Manager 重启后旧占位符失效，需要重新加载。`.env` 编辑器不再显示密钥首尾字符或 Gateway Token；单独复制网关 Token 的现有功能保留，需主动操作。凭据放在未识别的普通字段中仍可能显示，应该使用明确的凭据字段。

日志 API 对配置和环境变量中的已知凭据、常见 URL/Base64/JSON 编码、Bearer 和常见键值格式脱敏。通用 API 错误日志不再记录原始错误文本；诊断字符串也使用脱敏处理。此措施不自动清理旧日志，也不改变 OpenClaw/Docker 自身产生的原始日志：具备 Docker/宿主权限的管理员仍能读取它们。任意编码、拆分或改名的秘密无法仅靠正则保证识别。

新备份默认以 `.tar.gz.enc` 发布，使用 Node.js 标准 crypto 的 AES-256-GCM，随机 nonce、格式认证和完整性验证；发布前会解密回读并校验归档哈希。密钥默认位于实例数据目录父目录的 `backup-keys/key`，不在实例快照或备份目标目录中，也不写入状态和日志。可用 `OPENCLAW_BACKUP_KEY_FILE` 指定外部密钥文件，需为 32 字节原始随机数据；路径必须在实例数据和备份目录之外。Node.js 不在 PATH 时配置 `OPENCLAW_BACKUP_NODE` 为其绝对路径；宿主控制服务需要在该服务自身的环境中配置，不能只改 Manager 环境。

请独立、安全备份解密密钥。已有加密备份而密钥丢失时，新备份会失败，不会自动生成新密钥。篡改归档或使用错误密钥，解密会失败并清除未通过认证的临时输出。恢复命令为 `node scripts/backup_crypto.cjs decrypt 输入.tar.gz.enc 输出.tar.gz 密钥文件路径`，不会覆盖已有输出；解密后按原有流程在独立恢复目录验证内容再恢复。旧 `.tar.gz` 继续参与原有保留策略，不会自动加密或删除；应单独迁移已有明文副本。

压缩和加密期间仍会在权限为私有的 staging 目录短暂产生明文，正常结束或失败后清理；异常断电留下的 staging 会在下一次备份时清理。加密不能替代目录 ACL 或保护已被攻陷的宿主；Windows 请确认实例目录、密钥目录及备份目录的 NTFS ACL 仅授予所需账号。


## 独立 Docker 控制服务

Manager 默认通过独立控制服务访问 Docker。Compose 新增 docker-control 服务：仅该服务挂载真实 Docker socket；Manager 不再加入 socket 权限组，仅只读挂载共享控制 socket 目录，并等待控制服务健康后启动。控制服务使用相同 Manager 镜像，升级时两个服务应更新到同一构建版本。它不开放 TCP 端口，不联网，数据目录只读。控制服务不可用时请求失败，不回退到真实 socket。

本机网页/桌面启动会自动启动独立 Node 控制进程，选择私有 Unix socket 或随机 Windows 命名管道，并让 Dockerode 与 Docker CLI 使用该入口。父进程退出时关闭控制进程；已有独立服务可通过 OPENCLAW_CONTROL_SOCKET 指定。在原生运行下，两进程仍属于同一 OS 账号：该账号通常仍能访问原始 daemon，因此这不构成对完全攻陷该账号的强权限隔离。要移除管理进程直接访问 daemon 的能力，使用 Compose 隔离部署，或以不同服务账号部署控制端并配置 OS ACL。容器 Manager 缺少控制 socket 配置时会拒绝启动。

控制端默认拒绝未列出的 API，只提供平台需要的实例创建、检查、日志、资源调整、启停、升级重命名、受控 exec/终端、静态补丁以及镜像和隔离网络操作。它独立检查实例记录、名称、挂载、用户、capabilities 和命名空间。禁止 root exec、privileged、额外主机挂载、设备、宿主网络、daemon build、volume 管理、prune 和未知 exec ID。跨容器检查只返回容量规划元数据，不返回无关容器环境变量和挂载。镜像非强制拉取、导出、打标签和删除仍保留，以支持离线传输和缓存管理；控制服务仍是受信任的高权限组件，需维护和审计。

终端与网关 RPC 通过 Docker exec API 的双向升级流转发，支持 stdin 和 resize。exec ID 只在创建它的控制进程中有效，控制服务重启会中断终端，刷新后可重连。Manager 容器只能调整同部署 Manager 的重启策略，清理同部署已停止的旧 Manager；不能从控制接口创建或执行 Manager 容器。Manager 自身升级由宿主 Compose/现有宿主控制服务执行，业务实例的升级回滚继续由平台执行。

SSH 首次部署改为创建独立控制容器和 socket 卷，远程 Manager 不再挂载 daemon socket。SSH 首次构建、创建持久卷等引导工作仍通过已认证 SSH 在目标主机执行，这属于管理员引导权限；已保存的 SSH 管理凭据仍应按宿主级权限保护。已存在的旧 SSH Manager 会继续复用，不会自动停机替换；需要由管理员更新其部署以移除旧 socket 挂载，不能把仅更新本机前端视为已迁移远端。

迁移 Compose 时先备份现有部署配置并构建新的 Manager 镜像，再用该镜像执行 docker compose up -d；Compose 会创建控制服务并重建 Manager，业务容器和实例数据保持原位置。不要仅启动旧版 Manager 镜像配新 Compose。旧实例若有额外挂载、危险权限或不规范名称，控制端会拒绝操作，应先在宿主审查后迁移，不会自动放宽权限。不要向 Manager 挂载原始 socket、宿主根目录或控制服务的可写 socket 目录。

验证：npm test；node test/security-smoke.cjs 验证真实终端双向流、resize 和回滚重命名；node test/docker-control-smoke.cjs 使用两个独立临时容器验证客户端没有原始 socket，仍能经控制端执行命令、停止及回滚重命名，结束后删除测试容器和数据卷。生产切换前还应在目标操作系统核对 Compose 路径、UID 和现有实例兼容性。


## Agent 独立执行容器与出口白名单

本轮新增按实例显式迁移的 `ssh-sandbox-v1` 安全配置。每个已配置 Agent 使用独立 SSH 执行容器、独立 SSH 身份和工作区卷；exec、文件工具与媒体读取由 OpenClaw 原生 SSH sandbox 后端处理。执行容器不挂载网关配置、模型 API Key、渠道凭据、管理端 socket 或网关私钥。禁用 elevated、远程节点、原生 code_execution 等绕过路径；当前不接入 ACP/外部 Agent harness 和浏览器沙箱。不同 Agent 的执行卷及网络互相分离，同一个 Agent 的会话使用独立目录，但不作为互不信任租户的强隔离边界。

网关保留模型 API 与渠道进程。每个网关和执行容器有独立网络守卫，共享目标的网络命名空间，只具备该命名空间所需的 NET_ADMIN/NET_BIND_SERVICE，主机网络不变。应用启动必须等待守卫安装完成；网关和执行用户没有修改防火墙的权限。非白名单 DNS、直接外部 IP、IPv6、额外端口、Docker 内置 DNS 绕过被阻断。白名单通过受控 DNS 解析并临时放行 IPv4/端口，不仅依赖 HTTP_PROXY，因此普通 SDK、HTTP(S)、WSS 可沿用原有调用方式。白名单是网络目的地址控制，不能区分同一 IP/端口背后的其他虚拟主机或 API 路径，也不提供已批准目标上的数据防泄露保证。

迁移会从现有 models.providers.baseUrl 收集模型来源，并按已启用飞书/Lark 配置加入 Open API 和长连接主机。其他渠道、内置模型供应商、OAuth、特殊飞书文件/CDN 或地区域名需要用 --allow 补充精确来源；不使用通配符。解析器优先沿用现有设置，也可用 --resolver 指定可达的非回环 IPv4 DNS；应用不能绕过本地守卫直接使用该上游。显式 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 的实例暂不迁移，避免通用代理绕过目的地址规则；旧网关保持运行。私有地址、云元数据和 DNS 重绑定结果默认拒绝，自托管模型需显式 --allow-private；建议填写可从容器访问的固定 IPv4 来源。localhost 指容器自身，host.docker.internal 等特殊主机名需在目标环境确认解析，不能把它当作宿主模型的通用地址。工作容器默认无外部访问，必要时用 --tool-allow 为工具单独指定公共来源；不会自动获得网关模型凭据。

部署步骤（在 Docker 宿主管理员环境执行，不能通过 Agent 或普通 Manager 容器提权运行）：

1. 构建执行镜像：`docker build -f security/Dockerfile.worker -t openclaw-security-worker:latest .`。
2. 从当前实例已批准的 OpenClaw 镜像构建安全网关：`docker build -f security/Dockerfile.runtime --build-arg OPENCLAW_RUNTIME=当前运行镜像 -t openclaw-security-runtime:latest .`。不要用测试镜像版本替换生产版本；容器可写层的 UI/软件补丁需先纳入基础镜像。
3. 使用正确 OPENCLAW_DATA_DIR，运行 `node scripts/secure-instance.cjs 实例ID` 查看拟放行来源；加 `--apply` 执行迁移，可用 `--runtime 镜像`、`--worker 镜像` 指定版本，重复 `--allow https://example.com`、`--allow-private http://192.168.1.10:8000` 或 `--tool-allow https://example.com` 补充访问。

工具先检查文件系统和当前版本 schema，再准备执行容器，最后切换网关并等待健康检查。失败恢复旧配置、实例记录和网关；成功保留一个停止的旧网关供回滚。`node scripts/secure-instance.cjs 实例ID --rollback` 会先把沙箱产物快照保留到实例 manager/security 目录，再恢复上一代配置与网关。执行工作区卷不会随回滚删除。重建/升级、新增 Agent、调整出口使用同一迁移工具（新增用 --add-agent），避免 UI 通用重建丢失安全设置；已启用实例的配置保存不能移除沙箱规则，克隆不会复用原实例的凭据。迁移期间由 migration.lock 阻止平台写操作并延后备份；如果进程异常退出留下锁，确认原进程已结束后再人工清理。原生 OpenClaw 控制台也应避免并行修改。安全实例先回滚保留工作区快照，再通过平台删除；执行卷保留，需管理员按实例标签明确清理。

必须使用更新后的独立 Docker 控制服务：它负责网关重启时重建守卫，停止网关时同步暂停执行容器，启动时恢复，并定期检查已启动安全实例。守卫异常不会回退到网关本地执行或放开出口；Worker 地址改变时需要重新迁移以更新 SSH 主机校验及网络策略。不要单独删除守卫或给执行容器增加权限；SSH 仅接受已固定身份的 sandbox 用户（UID 65532，与网关及私钥所有者分离），禁用密码、root 登录、代理转发和端口转发。每个 Worker 默认 1 CPU/512 MiB，每个守卫 0.1 CPU/128 MiB，生产启用前应预留总资源。

现有宿主工作区首次由 OpenClaw 播种到远程工作区，之后沙箱卷成为工具实际读写位置，不自动同步回本地编辑器；回复附件通过 SSH 读取。重置沙箱会重新播种，应先备份沙箱产物。详见官方 SSH backend 文档：https://docs.openclaw.ai/gateway/sandboxing/ssh-backend 。平台每日加密备份新增每 Agent 工作区 tar；快照时短暂暂停该 Worker，网关保持运行，完成或断开后恢复，失败不发布不完整备份。恢复时解密外层归档，再从 `instances/实例目录/manager/sandbox-workspace-archives/Agent.tar` 恢复到对应工作区卷；不要将其中的链接或文件直接覆盖宿主系统目录。单个工作区快照默认上限 1 GiB，可用 OPENCLAW_SANDBOX_BACKUP_MAX_BYTES 调整。

当前运行时在部分 Windows 共享目录上不支持安全文件身份检查；迁移会在停旧网关前拒绝这类文件系统，也会检查管理数据目录与网关 UID 是否兼容。请在 Linux/WSL 文件系统或受支持的 Linux 数据卷中运行管理员迁移流程。测试覆盖 Linux Docker：真实 OpenClaw 模型/工具回合、文件读取隔离、两 Agent 分离、HTTP/WS、出口绕过、管理端重启、工作区备份及回滚；飞书使用协议模拟服务验证，没有使用真实生产凭据登录。

执行 `npm test` 和 `python test/test_backup.py` 运行回归；`node test/agent-sandbox-linux.cjs` 使用两个本地测试镜像完成隔离集成检查，创建的容器和卷带唯一 sandbox-smoke 标识并在结束时清理。首次测试需构建 :test 镜像，安全网关测试基础镜像通过 OPENCLAW_RUNTIME 指定本机已有的兼容 OpenClaw 版本。现有生产实例不会因为更新代码自动启用该配置。


### 插件安装来源与权限审查

“技能与插件”的 npm 插件安装改为“检查安装来源 → 确认固定包名和版本 → 审查实际制品权限 → 批准安装”。仅允许公共 `https://registry.npmjs.org` 的固定 SemVer 版本和 HTTPS 制品，拒绝 URL、本地路径、Git、别名、浮动标签、版本范围、缺少 SHA-512 或包名/版本不匹配的元数据。页面展示 registry 来源、发布者账号、制品地址和哈希；这些信息用于核对，不能证明发布者或代码可信。可选环境变量 `MANAGER_PLUGIN_ALLOWLIST=@openclaw/feishu,@company/reviewed-plugin` 将来源进一步限制为管理员列出的完整 npm 包名；空值不额外限制来源；新增原生插件仍需下方 MANAGER_NATIVE_PLUGIN_ALLOWLIST 明确信任。Compose 已透传该变量，原生/Electron 可在启动环境设置。

安装在实例正常用户下使用其 CLI 的事务安装管线，重新下载时验证已审查的 SHA-512，在提交前从实际制品提取完整权限。包括运行时默认豁免的官方插件，也执行独立的提交前权限预检；预检不导入插件代码，也不提交插件文件或配置。权限确认绑定包名、版本、完整性和整个权限报告，内容变化必须再次审查。确认凭证有效期 5 分钟、一次使用，并绑定管理会话、实例、容器和配置版本；失败或连接结果不明时不会自动重试。需要重新下载制品以在最终提交时复查，安装耗时可能增加。

不再传入 `--accept-capabilities` 或 `--acknowledge-install-policy-warning`。策略 `warn`、`block`、策略执行失败均保持拦截；页面没有“接受所有警告”捷径。根据 [OpenClaw 安装说明](https://docs.openclaw.ai/cli/plugins/install)，该警告确认参数会批准整次调用中遇到的所有警告，无法仅绑定已展示的一条；因此需要由管理员在受信任终端审查，或在明确审查来源后调整受信任的安装策略，再重新发起页面审查。启停插件改由运行时接口执行，保留其权限扩大和 deny 检查，不能直接写 `entries.enabled` 绕过授权。旧版本缺少必需安装/检查接口时明确拒绝，不回退到自动接受模式。

已有插件、部署、终端和升级入口保持可用；本次不自动安装插件、不修改运行中实例的安装策略、不开放额外网络出口。已配置出口白名单的实例若需安装插件及依赖，仍须由宿主管理员显式允许对应 registry/制品来源；不要为安装开放任意出口。插件权限声明不是 OS 沙箱，批准的插件仍是实例内受信任代码，能够接触实例数据和凭据。

验证：`npm test` 包含插件安装来源、确认凭证、权限变化、策略拦截和 HTTP 绕过回归；显式执行 `node test/plugin-install-smoke.cjs` 在无外网、无宿主挂载、无 Docker socket 的临时实例中使用合成 npm registry，验证真实制品安装、权限确认、哈希错误、过期权限令牌和 npm 生命周期脚本禁止执行。测试不使用真实第三方插件或业务账号。


### 独立插件执行与最小权限

OpenClaw 的[原生插件执行模型](https://docs.openclaw.ai/plugins/architecture)与网关共享进程，Agent 的 SSH/Docker 沙箱不能隔离原生插件。平台新增的是独立容器中的 **工具插件适配通道**：第三方代码仅在自己的容器里导入和执行，网关只运行平台自带的固定工具桥。不是把原生插件放进 `vm` 或 worker thread 后声称获得安全隔离。

每个插件强制 UID/GID 65532、独立 PID/挂载命名空间、只读根文件系统、全部 capability 删除、no-new-privileges、256 MiB 内存、0.5 CPU、64 PID、64 MiB 临时目录，不发布宿主端口。只挂载本插件的策略文件，不挂载实例配置、工作区、认证目录、模型配置、Docker socket 或其他插件目录；不复制网关环境变量，镜像内的预设环境也会被清空后仅设置固定 PATH/HOME/TMPDIR。策略文件的 `config` 仅接收管理员显式填写的本插件设置，平台不解析网关凭据引用、不自动复制任何模型或渠道密钥。插件默认没有持久数据目录，重启后临时状态会丢失。

网关与执行容器通过专用随机凭证通信；该凭证只能调用对应插件，不是网关令牌。工具桥只发送管理员批准工具的参数，不发送 `api`、`runtime`、网关配置、会话 ID、历史、认证头或隐式工作区内容。两端检查参数；网关端只接收有界纯文本工具结果，忽略远端的 `details` 等扩展字段，拒绝图片/附件路径、重定向、过大返回和未经允许的工具。参数使用严格、有限深度的 JSON Schema 子集：object（必须 additionalProperties=false）、array（必须 maxItems，最多100）、string（必须 maxLength，最多16384）、number/integer/boolean/null、enum、required 和数值/长度边界；不支持 $ref、正则、任意关键字和动态工具工厂，避免产生未实际执行的权限约束。

执行容器使用独立内核网络守卫：默认拒绝出口、其他实例、网关、云元数据、直接 IP/DNS 绕过；只对该插件策略 `origins` 中精确列出的公共来源开放端口，不继承网关的模型/飞书出口。沿用已有地址/端口白名单的限制，同 IP 和端口上的虚拟主机不能互相区分。这不是 DLP：管理员主动放进参数或本插件 config 的数据，插件可以处理，并可能发送到其获准来源。

启用需要 Docker 宿主管理员在已有 `ssh-sandbox-v1` 安全实例上显式迁移；Manager Web 和 Agent 没有任意创建插件容器的权限。基础镜像、适配代码和 Dockerfile 必须由管理员审查；只把审核后的插件产物及其锁定依赖复制到 `/plugin/`，不要用未审查的镜像替换隔离基础设施。镜像在迁移时解析为不可变 image ID，标签本身不是来源证明。

```sh
# 在 platform 目录中先构建基础设施与示例镜像
# 生产请使用已审查并固定摘要的基础镜像及插件产物。
docker build -f security/Dockerfile.plugin -t openclaw-security-plugin:latest .
docker build -f security/Dockerfile.plugin-example -t isolated-uppercase:reviewed .

# 默认仅预览。策略必须列出确切工具名、描述、参数和可选的公共出口。
node scripts/isolate-plugin.cjs INSTANCE --policy security/examples/uppercase-policy.json --image isolated-uppercase:reviewed
node scripts/isolate-plugin.cjs INSTANCE --policy security/examples/uppercase-policy.json --image isolated-uppercase:reviewed --apply

# 移除会撤销本次增加的工具授权，保留先前已有授权，且不自动恢复原生插件。
node scripts/isolate-plugin.cjs INSTANCE --remove sample --apply
```

适配插件使用预构建的 ESM `/plugin/index.mjs`，默认导出 `register(api)` 或带 register 的对象，只能用 `api.registerTool` 注册静态工具对象。工具的 `execute(callId,args)` 返回 `{content:[{type:"text",text:"..."}]}`。未批准的工具不注册；需要任意 runtime API、渠道/服务/钩子注册、上下文工厂、原生模块或持久文件接口的插件，需要专门适配，不能透明迁移。预检失败保留原入口；成功切换会短暂停止并重启网关，将同 ID 原生插件设为 disabled 和 deny，注册批准的工具，并向现有工具和沙箱策略增量加入这些具体工具名，保留原有 deny。网关启动后必须实际查到工具桥中的批准工具，才能报告成功；失败恢复旧配置并保持新的隔离资源不可用。受信任工具桥通过固定平台目录链接；仅这个平台自有模块使用能力批准，第三方代码不会被链接到网关，也不会接受安装策略警告。配置更新通过已安装运行时的事务写入器，保留其保护元数据、冲突检查和 last-good 快照。

控制服务会协调插件网络守卫、暂停/恢复和网关重启。IP 变化或资源归属不匹配时失败关闭，不回退到本地执行。配置编辑和插件启停/卸载 API 不能移除隔离策略或重启同 ID 原生插件。先移除独立插件再回滚 Agent 安全配置；恢复备份后需要重建镜像和执行容器，不能复用旧 IP/执行资源。独立执行容器不保存业务文件，无需将其临时目录加入实例备份；策略和元数据仍随现有加密备份保存。

为堵住新增原生插件读取密钥的入口，`MANAGER_NATIVE_PLUGIN_ALLOWLIST` 默认为空，即禁止通过平台新增原生 npm 插件；不修改现有插件启用状态，现有模型、飞书、部署、终端、升级功能的配置不被自动迁移。确需原生渠道/服务插件时，管理员可填入完整且已审查的 npm 包名，例如 `@openclaw/feishu`。该例外仍必须经过来源、固定版本、SHA-512 和权限审查，但 **仍与网关共享数据及密钥**。此前的 MANAGER_PLUGIN_ALLOWLIST 只限制包来源，不能替代这个原生执行信任开关。页面明确标出独立工具插件与原生执行模式，不把权限批准表述为隔离。

验证：`npm test` 覆盖参数、原生默认拒绝、授权撤销与桥接数据边界；显式 `node test/plugin-isolation-linux.cjs` 在临时 Linux 数据卷和合成插件中验证真实网关注册/调用、配置保护、受限容器、实例与模型/渠道/父进程环境读取失败、网关/元数据/外网连接拒绝、管理端停启、移除及网关恢复。此测试使用宿主 Docker 管理员权限创建临时基础设施；插件执行容器本身没有 Docker socket，也没有测试管理进程的挂载或权限。不使用生产模型或飞书账号。

### 飞书/Lark 原生渠道的独立收发适配

新增 `feishu-text-v1`，将飞书 SDK 和事件接收移出网关进程。它是明确选择的文字适配：支持私聊、群聊、@机器人、简单 peer 路由、文本和富文本中的文字，以及分段文字回复；支持 WebSocket 或验签并校验时效的加密 Webhook。媒体下载、文档/云盘/Bitable 工具、流式卡片、交互回调、主动推送、动态创建 Agent 和渠道控制命令尚未适配。其他原生渠道仍需分别实现适配，不能通过通用工具插件沙箱透明迁移。

收发容器使用 UID/GID 65532、只读根目录、cap-drop ALL、no-new-privileges、256 MiB 内存、0.5 CPU、64 PID，仅挂载自己的收发策略文件，临时状态位于有配额的 tmpfs，不记录容器日志。实例文件、模型密钥、网关令牌、Docker socket、其他账号凭据不进入该容器；镜像环境变量也会清空。内核出口只允许自己的可信代理和精确列出的飞书/Lark 长连接来源，不继承模型及网关出口。当前仅支持默认地区域名，不为自定义地区地址自动放宽白名单。

真实 AppSecret 和 tenant_access_token 仅由可信 Manager 代理保管；SDK 使用占位 AppSecret，并通过固定代理动作取得自己账号的 WebSocket URL。该 URL 仍是本账号的连接能力，应按凭据保护。Webhook 模式的 encryptKey/verificationToken 仅给自己的收发容器。代理令牌按账号随机生成，不能访问 Manager API、其他账号、模型或网关。收发层只能提交消息 ID；代理从飞书重新查询消息和会话，校验真实发送者、群、提及和时效，不能采信容器提交的正文或身份。回复也只能发给原始核验消息，内容由可信侧生成并脱敏，收发容器不能指定接收人或替换正文。应用需具备读取机器人可见消息、查询相应会话、机器人身份及回复消息所需权限，不应因此授予文档、通讯录管理等无关权限。

每个账号必须使用非默认的专用 Agent 和独立工作区；迁移仅将这些 Agent 限制为沙箱 `read/write/edit`，禁止 exec、提权、网关管理、消息工具、跨会话、记忆检索和其他工具，日常主 Agent 不变。聊天 RPC 强制 `suppressCommandInterpretation=true`，不支持此字段的旧运行时拒绝请求，不能省略该字段重试。按账号、会话和发送者生成新的会话键，不共享旧原生会话历史。同一个专用 Agent 的工作区仍是共同信任范围；互不信任的用户或群应路由到不同专用 Agent。此边界不阻止用户主动发送业务数据到已批准的模型/飞书，也不隔离仍被管理员信任的其他原生插件。

部署在 Docker 宿主管理员环境、已有 `ssh-sandbox-v1` 实例上显式执行，不经普通 Manager 或 Agent 提权。先更新 Manager 和独立 Docker 控制服务。Compose 和新 SSH 部署启用容器内 `18081` 代理监听，不发布宿主端口；原生 Manager 进程默认不开启，需设置 `OPENCLAW_CHANNEL_BRIDGE_LISTEN=私有接口IP:18081` 并限制来源。`--broker` 填收发容器可达的固定私有 IPv4 代理来源，容器部署通常使用 Manager 的 bridge 地址；不要填管理界面地址、网关端口、公网地址或把该端口公开到 LAN。IP 变化后须重新迁移。

```sh
# 在 platform 目录中；沿用前文已审查的 runtime/worker 镜像。
docker build -f security/Dockerfile.feishu -t openclaw-security-feishu:latest .
node scripts/secure-instance.cjs INSTANCE --add-agent feishu --apply

# 复制并编辑示例，填写明确用户/群 open_id 和专用 Agent。
# 先预览；默认从现有 channels.feishu 提取账号，不输出密钥。
node scripts/isolate-feishu.cjs INSTANCE --policy security/examples/feishu-policy.json --broker http://172.17.0.2:18081
node scripts/isolate-feishu.cjs INSTANCE --policy security/examples/feishu-policy.json --broker http://172.17.0.2:18081 --apply

# 仅调整已有专用 Agent 范围内的白名单与路由。
node scripts/isolate-feishu.cjs INSTANCE --update-access --policy security/examples/feishu-policy.json --apply
# 撤销并删除收发容器及本账号凭据；不恢复原生插件。
node scripts/isolate-feishu.cjs INSTANCE --remove --apply
```

新建隔离账号可用 `--credentials /secure/feishu-credentials.private.json` 提供原 `channels.feishu` 对象形状的私密文件，避免先向网关填写 AppSecret。文件仅支持字面量或环境变量凭据，不执行 file/exec/store 引用；禁止引用或共用模型密钥。不要将私密文件加入仓库或镜像上下文。Webhook 模式还需 `--webhook default=18792`（每账号独立端口），只绑定宿主 loopback；由反向代理仅发布 `/feishu/events` 并在飞书后台更新回调 URL，不发布健康检查或激活接口。

切换前应暂停或排空原生渠道流量；适配不搬运旧原生待收件队列，不保证跨旧/新渠道切换的消息恰好一次处理。工具先预检再停旧网关，删除网关中的原生飞书配置和相关环境变量，禁止原生插件重新启用，等待新网关就绪后才激活独立连接；失败恢复旧配置和入口。备份会比较渠道隔离元数据，凭据和可信侧作业随现有加密备份保护；不生成新的完整明文配置副本。运行中断后无法确认执行或发送结果的作业标为 unknown，不自动重放。作业正文和脱敏回复仍是业务数据，需保护 Manager 数据目录和备份。移除后保留禁用原生渠道的标记、专用 Agent 工作区和作业记录；不能通过 Agent 安全回滚自动恢复旧渠道密钥。

管理页面沿用白名单和群设置入口，隔离账号不提供 open/pairing 自动放行；原生 AppSecret 配置、启用、安装和绑定改写入口对已隔离账号拒绝操作。新增原生飞书的旧快捷安装路径已移除，须经过固定版本、完整性、权限和原生信任审查。

验证：`npm test`、`python -X utf8 test/test_backup.py`；`node test/feishu-isolation-linux.cjs` 使用真实 OpenClaw 网关与合成模型/飞书协议，覆盖签名 Webhook、权威消息复查、回复脱敏、去重、越权群拒绝、专用 Agent 工具边界、文件/网络隔离、停启、移除和原生恢复拦截；另验证锁定版本 SDK 在无真实 AppSecret 下的 WebSocket 发现接口。未使用真实飞书账号验证长连接、生产应用权限和回调配置，上线前应在测试应用验收。更新代码不会自动迁移任何现有实例。


## React 前端

管理界面已迁移到 **React + Tailwind CSS + shadcn/ui**，源码在 `frontend/`。
`npm start`、`npm run app` 与 `npm run web` 会先构建界面；开发时可在另一个终端运行 `npm run build:watch`，修改后刷新页面。

完整结构、部署流程和测试说明见 [前端说明](frontend/README.md)。

## 实例存储、容量保护与数据恢复

实例详情新增「存储与备份」。目前三个数据目录均为 bind mount：`openclaw` → `/home/node/.openclaw`、`workspace` → `/home/node/.openclaw/workspace`、`auth` → `/home/node/.config/openclaw`。界面展示宿主路径、容器路径、各挂载用量、整个实例目录用量及所在文件系统余量。路径由平台固定管理，不接受任意宿主目录挂载。迁移根目录应停机、备份、复制并校验后调整 `OPENCLAW_DATA_DIR`（Compose 同步调整 `MANAGER_DATA_HOME` 和宿主挂载），再重建容器；不要在线移动目录。

### 容量策略和写满处理

现有实例和未指定策略的新实例默认额度为 0，自动保护关闭，避免更新平台后意外停止业务。进入「容量策略」设置额度后生效；创建实例 API 也接受 `storage: {limitGiB: 10, warnPercent: 80, stopPercent: 95, minFreeGiB: 1}`。建议在 80% 告警、95% 停机，以便预留数据库收尾和恢复空间。策略文件位于实例根目录父目录的 `storage/<id>.json`，不在实例挂载中；应同时备份该管理目录。

每 5 秒检查空间及文件数，并串行扫描文件，按文件逻辑大小与已分配块大小的较大值保守计量（硬链接可能重复计数），整个实例目录中的配置、认证、工作区、管理历史及恢复暂存都计入。检测不会跳过正在对话的实例；正在创建的实例完成配置后才允许启动。告警在存储页显示；达到停机阈值，或开启额度后的文件系统余量低于保留值时，记录保护锁定、禁用容器自动重启并尝试正常停机。Docker 停机失败会保留锁定并在后续扫描重试；配置额度后无法完整扫描目录也会触发保护。

平台在管理目录预留 1MiB 应急空间，必要时释放以写入锁定记录。即使记录落盘失败或修改 Docker 重启策略失败，仍尝试停止运行容器；落盘彻底失败时，内存锁定只在本次进程中有效，应修复磁盘后确认策略状态。平台不会自动删除业务数据，也不会因空间恢复而自动启动。清理或扩容后点击「解除保护」，再手动启动；Node 启动设置和 Python 宿主恢复服务均尊重已落盘的保护锁定。Manager 未运行、Docker 不可达、实例操作长时间占用或外部工具直接写入时，不能依赖此轮询实现即时阻断。

**软保护模式不是文件系统硬配额。** 扫描与停机之间可能继续增长，不能保证严格的最大磁盘占用。Docker 的 `--storage-opt size` 作用于受支持存储驱动的容器可写层，不能用于限制这些宿主目录挂载。参见 [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/) 和 [Docker 存储驱动选项](https://docs.docker.com/reference/cli/dockerd/#storage-driver-options)。严格隔离应由 Linux 宿主管理员在专用数据文件系统上配置每实例 project quota（例如支持项目配额的 XFS），或使用独立限容文件系统；独立执行卷须各自纳入配额。Windows/macOS Docker Desktop 的全局磁盘上限不等于每实例配额。平台不会自动创建、格式化或重新挂载文件系统；硬配额模式通过下述宿主后端在已准备好的 XFS 上应用和验证。

实例统计和保护不覆盖 Docker 镜像、容器可写层、Docker 日志及安全沙箱/插件/飞书的独立执行卷。Docker 日志已有 10MB × 3 轮转限制；这些其他存储仍需宿主监测。不要把「实例目录未超额」理解为整个宿主机不会写满。

### 清理、备份与修复

- **清理：** 先预览，仅选择 `openclaw/logs` 下超过 7 天、以 `.log.数字` 或 `.log.日期`（可带 `.gz`）结尾的轮转日志。停机后确认执行；执行时复核预览版本、文件身份、大小及修改时间。活动日志、会话、记忆、工作区和数据库不参与自动选择。当前不自动清空业务数据。
- **实例备份：** 普通实例及相关容器停止后，将三个挂载目录打包为 AES-256-GCM 加密归档；备份包含 SHA-256 文件清单，发布前解密回读、逐文件校验并同步文件。备份存于 `OPENCLAW_INSTANCE_BACKUP_DIR/<id>/`，默认是实例根目录父目录下的 `instance-backups/<id>/`，必须位于实例数据目录之外。使用与全量备份一致的外置密钥规则，默认 `backup-keys/key`，可用 `OPENCLAW_BACKUP_KEY_FILE` 指定；已有加密备份却缺少密钥时拒绝生成替代密钥。备份文件无需在线解密即可保管，密钥需单独安全保存。
- **恢复：** 校验后仍需停机；恢复前自动备份当前数据，随后验证归档认证、实例身份、路径、文件哈希、清单、空间和配置策略，再替换三个挂载目录。恢复不会覆盖当前实例管理记录，网关身份不匹配会拒绝恢复。中途失败回滚原目录，未完成事务阻止平台启动，可在页面执行「回滚未完成恢复」。恢复后保持停止，启动时重建容器以应用恢复的环境变量。不要绕过平台在恢复过程中启动 Docker 容器。
- **备份空间：** 备份不占实例额度，但仍占目标文件系统空间。创建前保守要求约三倍源文件逻辑大小加 256MiB；恢复还需要解密校验及完整暂存空间。空间不足则失败并保留旧备份，不会为腾空间自动删除旧备份。实例备份不会自动过期，可确认删除旧版本；删除前必须验证另有可用副本，最后一份不允许删除。现有每日全量在线备份仍独立保留 7 天。建议将备份转存另一块磁盘或其他设备。
- **修复：** 提供目录和配置 JSON 检查，可从 `.last-good` 或 `.bak.1`～`.bak.3` 恢复配置；修复前先加密备份当前数据，结束后保持停止。数据库或业务数据损坏通过经过校验的备份恢复，不执行有损的原地数据库修复。文件哈希证明备份内容未变化，不能证明备份时业务数据本身健康，生产环境仍需定期做独立恢复演练。

安全沙箱、隔离插件和隔离飞书实例包含额外执行卷或管理凭据，本入口拒绝为它们生成或恢复不完整的三目录快照；继续使用平台全量备份及对应隔离迁移工具。链接及特殊文件也会拒绝维护，避免越界。校验过程会产生权限受限的临时明文文件，正常结束或失败会清除；宿主/进程强制中断后可能遗留 `.verify-*`、`.restore-*` 或 `.previous-*`，应先确认无活动任务或未完成事务，再由管理员检查处理，不能直接删除恢复事务所需的旧数据。

接口均位于 `/api/instances/:id/storage`，沿用会话认证、CSRF 和实例操作互斥：`GET /` 用量，`PATCH /policy` 策略，`POST /release` 解除，`GET/POST /cleanup` 预览/清理，`GET/POST /backups` 列表/备份，`POST /backups/:name/verify` 校验，`POST /backups/:name/restore` 恢复，`DELETE /backups/:name` 删除备份，`GET /diagnostics` 检查，`POST /repair-config` 配置修复（`source`），`POST /rollback` 恢复事务回滚。

验证：`node --test test/storage.test.js test/storage-api.test.js` 覆盖超额停机、宿主余量、ENOSPC、停机失败、清理预览变化、加密回读、篡改、路径逃逸、恢复中断及回滚、配置修复、最后备份保护和认证。`python -X utf8 test/startup_recovery_test.py` 覆盖宿主自启动锁定，`npm run test:ui` 覆盖存储页面和手机布局。故障注入覆盖控制流程；另用下述隔离 XFS 内核测试验证真实硬配额行为。


### XFS 硬配额后端及部署

macOS 现已提供独立 APFS 卷容量配额后端，宿主探测、挂载/UUID 校验、启动保护和离线迁移/回滚步骤见 [APFS-STORAGE.md](APFS-STORAGE.md)。该后端不提供 inode 硬限制；APFS 实例禁用 Docker 直接自动重启，由宿主守护服务在开机挂载、校验后仅恢复原先运行的实例。手动停止和存储保护持久化禁启，失败不循环拉起。

新增 `GET /api/instances/:id/storage/capabilities` 只读探测，区分“不支持”“支持但尚未应用”“已通过实际验证”。原有实例默认 `mode: soft`、容量 0，不会自动迁移或停止业务。硬配额仅支持 Linux、XFS、项目配额统计及 enforcement 同时开启、具备 `CAP_SYS_ADMIN` 的专用宿主服务，以及支持 `quotactl_fd` 系统调用（Linux 5.14+、64 位 x86-64/arm64 ABI）的环境；缺少工具、权限、挂载选项或通信服务都会返回明确原因。Windows/macOS 原生目录共享、非 XFS、未启用 enforcement、跨文件系统目录、链接及包含独立执行卷的隔离实例均不冒充支持。Docker Desktop 的 Linux 引擎与 Windows/macOS 目录挂载必须分开判断。

宿主管理员先准备已启用 `prjquota` 的专用 XFS 文件系统及实例目录。平台不运行 mkfs、mount、sudo，也不赋予 Manager 或业务容器特权。Linux 宿主需有 Python 3、xfsprogs、util-linux（findmnt）和 Docker CLI；服务必须看到与 Docker bind mounts 完全相同的宿主路径。平台代码和配额服务脚本应由 root 管理，不可被 Manager 或实例用户修改。

推荐以独立 systemd 服务运行 `scripts/quota_host_service.py`，例如：

```ini
[Unit]
Description=OpenClaw scoped host quota service
After=docker.service
RequiresMountsFor=/srv/openclaw/data/instances

[Service]
Type=simple
User=root
ExecStart=/usr/bin/python3 /opt/openclaw/platform/scripts/quota_host_service.py --root /srv/openclaw/data/instances --control /srv/openclaw/data/quota-control --gid 1000
Environment=DOCKER_HOST=unix:///var/run/docker.sock
Restart=on-failure
UMask=0027

[Install]
WantedBy=multi-user.target
```

示例路径和 `--gid` 须改为真实部署值；GID 应与 Manager 进程可使用的组一致。控制目录是 Manager 可访问的签名信箱（requests 写入、responses 读取），必须位于实例根目录之外；只向 Manager 挂载，不向实例挂载。上例控制目录位于已共享的 `MANAGER_DATA_HOME` 下，Compose 可沿用整个数据目录的同路径挂载。Manager 私有 `.env` 增加：

```dotenv
OPENCLAW_QUOTA_CONTROL_DIR=/srv/openclaw/data/quota-control
```

该服务只接受 `quota-probe`、`quota-status`、`quota-apply`，参数只有实例 ID、容量、inode 上限及校验开关；没有任意路径、命令执行、挂载或格式化接口。请求和响应复用 HMAC 签名、时效及重放校验。旧宿主控制服务也支持相同操作，但非 Linux 或无权限仍明确返回不支持。未配置宿主信箱的原生 Linux 进程可调用 Python 后端探测；容器内不会直接把 guest 文件系统视为宿主。为保证最小权限，生产推荐专用服务。

特权注册表默认在 `/var/lib/openclaw-quota/<实例根目录哈希>.json`，由 root 持有，位于整个 Manager 数据目录之外；可用宿主服务 `--registry` 选择同样受保护的位置。它记录项目 ID 和目录的设备、inode 身份。项目 ID 会避开已登记、已有配额/用量及 `/etc/projects` 中的条目；不会覆盖外部项目 ID，也不修改 `/etc/projects`。服务确认所有关联容器已停止后，先设置内核上限，再设置并检查目录树继承，随后读回空间和 inode 硬上限。应用中断、读回不符或目录身份变化会保持未验证状态，阻止平台启动，不会自动删除实际硬配额或退回软保护。

停机后通过页面「容量策略」选择硬配额，或提交：

```json
{
  "mode": "hard",
  "limitGiB": 10,
  "hardInodes": 100000,
  "warnPercent": 80,
  "admissionPercent": 90,
  "stopPercent": 95,
  "minFreeGiB": 1,
  "drainSeconds": 30
}
```

容量按 4KiB 向下对齐，至少 1MiB；inode 上限同时计算目录和文件。`POST /api/instances/:id/storage/quota/verify` 检查完整覆盖和实际限制；未验证返回错误。空间使用率和 inode 使用率取较高者进入保护。硬配额开启后，内核会在 Manager 退出时继续限制新分配；平台仍按 5 秒检测提前收尾。宿主在带项目配额目录上返回的 statfs 可能是项目余量，文件系统全局预留判断改用未分配项目的实例根目录。硬额度覆盖实例目录，不包括镜像、容器可写层、Docker 日志、其他执行卷和外置备份，不能把它解释为整个实例在所有位置的总磁盘上限。

扩容同样要求停机、应用、读回验证；新上限必须大于实际用量。已经登记硬配额的实例不能通过切换软模式或设置容量 0 撤销限制，以免出现未验证的安全降级。迁移或撤销应由宿主管理员离线处理注册表、配额及平台记录后重新验证。恢复暂存也计入硬额度，恢复前应显式扩容以容纳原数据及暂存，平台不会偷偷扩大限制。

### 超额收尾与恢复语义

默认 80% 告警、90% 停止接单并开始收尾、95% 提前停机、100% 内核硬拒绝；各阈值同时适用于空间与 inode。收尾最长 1–30 秒。新平台对话、附件提交、插件操作、手动定时任务、Gateway RPC 提交及新终端连接在入口被拦截，返回不可自动重试的 507；查看、取消、停止和存储维护仍可使用。正在对话不会使检测无限延期。

平台先持久化启动锁定，再调用运行中 Gateway 的 `gateway.suspend.prepare`（`drain: true`、`terminalPolicy: terminate`），随后轮询 `gateway.suspend.status`。只有运行时确认租约、截止时间及 ready，才报告正常收尾完成；该协议由 Gateway 关闭原生渠道、直连客户端及自动 cron 的新任务接收。终端进程不阻塞协议就绪，停止容器时会结束，不能承诺终端命令完整执行。文档见 [OpenClaw suspension handshake](https://github.com/openclaw/openclaw/blob/main/docs/gateway/external-apps.md#cooperative-host-suspension)，实际接口随运行版本变化。

旧版本不支持、返回字段不符、RPC 失败或租约失效时，明确记录回退原因并立即调用有时限的 Docker stop；达到收尾截止时间、停机阈值、宿主余量不足或验证丢失也会停止等待。Docker stop 给运行时 30 秒处理 SIGTERM，超时可能强制结束，因此显示“任务可能未完成或未保存”，不会伪称无损收尾。突发写满依靠内核兜底，同样不能保证未完成事务或任意文件写入成功。收到 ENOSPC、EDQUOT、SQLITE_FULL 等运行时错误会锁定新任务并触发保护，不自动重放可能已执行的任务。

停机后读回 Docker 状态，未确认退出则持续锁定并重试。禁止自动重启失败不会阻止尝试停机，失败原因仍保留。保护不会因用量下降自行解除，需先停止实例，将空间和 inode 用量降至告警阈值以下、确认配置和任务记录，再手动解除并启动。Node 和 Python 启动恢复服务都尊重锁定、收尾状态及未验证配额。备份不在写满时强行触发，避免加剧磁盘压力；仍使用已有备份或先扩容后备份。

验证命令：`node --test test/storage*.test.js`、`python -X utf8 test/storage_quota_test.py`、`python -X utf8 test/startup_recovery_test.py`、`python -X utf8 test/host_service_test.py`、`npm run test:ui`。真实 XFS 内核测试为 `node test/storage-quota-smoke.cjs`：创建带唯一标识的特权测试容器，网络关闭，不挂载宿主数据或 Docker socket；仅格式化容器内新建的 512MiB 普通文件并挂载为 XFS。测试验证控制进程退出后字节/inode 上限仍强制生效、显式扩容和外部篡改检测，结束时卸载并清理测试容器、镜像及构建临时目录。测试专用的 Docker CLI stub 代表空的实例容器集合；运行时收尾、停机失败、忙碌对话等通过单元测试及故障注入覆盖。
