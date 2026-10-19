# OpenClaw 跨平台 Docker 与 SSH 远程部署管理平台

本次构建：`2026.10.16-ssh-image-transfer2`。支持 macOS、Linux、Windows 本机运行，以及通过 SSH 在其他设备部署和管理 OpenClaw。顶部「部署设备 / SSH」现已支持从本机 Docker 流式传输镜像到目标 Docker 并自动导入。

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

当前维护版本：`1.0.5`；原有服务器部署基线为 `2026.10.15-instance-features1`。历史修复及部署验证见 `RELEASE-NOTES.txt`，每日备份见 `BACKUPS.txt`，页面降耗检查见 `ENERGY.txt` 和 `CONTROL-UI-ENERGY.txt`。下述 LaunchAgent、备份路径与定时计划均为原有 Mac 服务器配置。

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
