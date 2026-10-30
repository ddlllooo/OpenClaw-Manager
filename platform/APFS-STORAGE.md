# macOS APFS 实例硬容量保护

每个普通实例独占一个 APFSX 卷，设置 CapacityQuota，挂载到固定的 `/Volumes/oc-实例ID-随机标识` 新路径。实例 ID 和容器内部路径保持不变；宿主实际路径由外置保护记录解析，避免 Docker Desktop 对旧目录挂载引用的缓存。
额度覆盖 openclaw、workspace、auth、卷内其他文件和卷元数据；不覆盖镜像、容器可写层、Docker 日志、备份、回滚副本或独立执行卷。APFS 不提供本后端可验证的 inode 硬上限。

宿主服务通过签名 mailbox 只提供 quota-probe/status/apply。macOS 自动选择 apfs-volume；Linux 保持 XFS。APFS apply 只能验证已离线准备的同额卷，不能从 Web 创建、格式化、挂载、删除或静默扩缩容。

## 挂载与启动

root 所有的登记保存在 `/Library/Application Support/OpenClaw/APFS/<根目录哈希>.json`。验证 APFS Container UUID、Volume UUID、实际挂载点、独立设备、CapacityQuota 和四处挂载标记；Manager 自己也必须看到同一个卷标记。完整校验允许符号链接本身，不遍历链接目标；跨文件系统数据路径拒绝通过。卷的用量和宿主总余量来自 APFS 宿主，不能使用 Docker 共享目录的 statfs 冒充卷额度。

APFS 实例的 Docker RestartPolicy 固定为 no。宿主重启后由 root LaunchDaemon 按 UUID 挂载卷；宿主守护服务验证卷身份、额度、宿主余量、业务配置、原容器归属、三个实际挂载及 Docker 共享标记后，仅恢复重启前确认运行的实例。新建或原先停止的实例不会被补启；服务或 Docker 在同一次宿主启动中重启也不会触发补启。不会创建丢失的容器、拉取镜像或重放任务。未挂载卷下的空目录由 root 所有、模式 000，不能静默写入。原实例目录保留不可写的空占位目录供枚举，所有实例读写实际解析到已登记的新卷。Manager 显式绑定每个实际卷路径，实例使用 consistent 共享，绕过同步共享缓存。

运行检查点保存在额度之外的 `data/apfs-recovery.json`，停止禁启记录位于 `data/apfs-run-inhibit/`。平台手动停止在 Docker 停机之前持久化禁启记录，并与宿主恢复共用串行锁；存储保护、迁移及失败启动也禁止恢复。清理空间或解除保护不会自动清除禁启记录，必须显式手动启动并确认 Docker 已运行后重新登记。每个实例每次宿主启动最多自动尝试一次；尝试先落盘，守护进程崩溃后只核对结果，不重复启动。等待挂载或 Docker 就绪不消耗尝试次数；记录损坏、配额不符、用量达到停止接单线或身份不符时保持停止并报告错误。

守护服务监测到通过 Docker 直接停止的实例后也会撤销恢复资格（检查间隔约 3 秒）；需要停止意图立即持久化时应使用平台的停止入口。正常系统退出收到 SIGTERM 后冻结运行检查点，防止把系统关闭期间的停止当成人工停止。Docker Desktop 仍需要 macOS 登录会话，无人值守部署需由管理员明确启用自动登录或使用无需 GUI 登录的容器后端；本次服务器按用户授权启用 livzon 自动登录。自动登录不会替代数据卷与禁启记录的检查。

80% 告警，90% 停止接单并有界收尾，95% 紧急保护停机，卷的硬上限最终拒绝分配。旧 Gateway 不支持全局收尾协议时明确记录 fallback，使用有时限的 SIGTERM/Docker stop。空间/配额异常返回不可重试 507，解除保护需停机、降到告警线以下并验证数据及挂载。

## 离线迁移与恢复

工具必须由管理员安装到 root 持有且普通用户不可写的目录。`apfs_migrate.py` 仅作为 root CLI 执行，支持 prepare、switch、commit、status、rollback、mount。

1. prepare：盘点普通实例、保存原保护设置、创建新额度卷并临时挂载。不会动原数据或业务容器。
2. 平台调用 `POST /api/instances/:id/storage/drain`，确认关联容器全部停止并禁止自动重启。
3. switch：写入迁移锁，使用 ditto 不克隆复制，保留链接、资源叉、扩展属性和 ACL；逐个校验普通文件 SHA-256、链接目标、硬链接组、权限、UID/GID、扩展属性。仅排除 APFS 卷根处自动生成的 Spotlight、FSEvents 等元数据，原目录不允许包含这些保留根名称。保存原始清单及原目录到 root 的 0700 日志目录，然后挂载新卷并核验配额。任何中断都不自动删除原目录。
4. 重建 Manager 挂载，确认它看到正确卷；commit 解除迁移锁。标记实例需要重建，通过平台启动以重新绑定新卷。检查原镜像、业务配置、健康状态及其他实例均未意外变化。

示例（容量单位为字节，20 GiB = 21474836480；替换实际路径和 ID）：

```sh
sudo python3 apfs_migrate.py prepare --root /path/data/instances --id INSTANCE --bytes 21474836480
sudo python3 apfs_migrate.py switch --root /path/data/instances --id INSTANCE
sudo python3 apfs_migrate.py commit --root /path/data/instances --id INSTANCE
sudo python3 apfs_migrate.py status --root /path/data/instances --id INSTANCE
```

回滚前先停止该实例和 Manager。Docker Desktop 可能仍持有卷引用，工具的 `--force-unmount` 仅在 Manager 及该实例关联容器全部停止时允许。该选项只卸载登记的目标卷，不影响其他实例。

```sh
sudo python3 apfs_migrate.py rollback --root /path/data/instances --id INSTANCE --force-unmount
```

已 commit 的迁移可能有新业务写入，回滚必须额外显式 `--archive-new`；工具保留整个新卷，不删除数据。操作员必须比对并迁回新写入，不能把旧副本当作无损恢复。工具恢复原目录和原保护设置，保持停止；需恢复原容器名称/身份并重建 Manager 挂载，人工验证后启动。重复 rollback 幂等；已回滚后再次 prepare 会归档旧迁移日志。

APFS 扩容采用新建更大额度卷后离线迁移。不能用 `resizeContainer` 代替单卷配额修改。备份和回滚副本另行保留空间、权限及保留策略；平台现有实例加密备份入口仍拒绝符号链接，不能作为这些实例唯一迁移备份。

## 验证

`node --test test/storage*.test.js test/run-intent.test.js`；`python -B test/apfs_quota_test.py`；`python -B test/apfs_migration_test.py`；`python -B test/apfs_recovery_test.py`。

`python -B test/apfs-recovery-smoke.py IMAGE` 使用独立目录、模拟宿主启动标识和配额读数，配合真实 Docker 容器及只读共享标记探测，验证只恢复原先运行的实例、等待挂载、持久化手动停止、存储保护、观察器重启和每次启动只尝试一次。不会重启宿主或 Docker，也不挂载生产实例数据。

`test/apfs-smoke.py IMAGE` 必须在 macOS 上由 root 执行，仅创建带随机 ID 的 256 MiB 测试卷，使用独立数据目录和隔离 Manager。验证 Manager 不运行时真实 fsync 写入返回 ENOSPC/EDQUOT、签名宿主 RPC、实际配额与视图、507 拒绝、真实 Docker 停机、未挂载拒绝、UUID 重挂载及原数据回滚。仅删除本次创建、UUID 和名称均匹配的测试卷；不会挂载生产实例数据。
