import { useState } from "react";
import {
  ArchiveRestore,
  DatabaseBackup,
  Download,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Check,
  Empty,
  ErrorNotice,
  JsonView,
  PageHeading,
  Resource,
} from "@/components/shared";
import { useAction, useDirty, useResource } from "@/lib/hooks";
import { request } from "@/lib/api";
import { bytes, date } from "@/lib/utils";

export function ImagesPage({ events }) {
  const resource = useResource("/api/images", 15000);
  const tasks = useResource("/api/images/tasks", 5000);
  const [image, setImage] = useState("");
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState(null);
  const [entries, setEntries] = useState([]);
  const { busy, run } = useAction();
  const fetchHistory = async (cursor) => {
    const data = await request(
      `/api/images/cleanup/history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    setHistory(data);
    setEntries((previous) =>
      cursor ? [...previous, ...(data.entries || [])] : data.entries || [],
    );
  };
  const loadHistory = (cursor) => run(() => fetchHistory(cursor));
  return (
    <div className="page-enter space-y-6">
      <PageHeading title="镜像仓库" />
      <form
        className="flex flex-wrap gap-3 rounded-xl border border-border bg-card p-5"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await request("/api/images/pull", {
              method: "POST",
              body: { image },
            });
            tasks.reload();
          }, "镜像下载已开始");
        }}
      >
        <Input
          className="min-w-52 flex-1"
          aria-label="下载镜像名称"
          value={image}
          onChange={(e) => setImage(e.target.value)}
          placeholder={resource.data?.defaultImage || "输入完整镜像名称与标签"}
          required
        />
        <Button disabled={busy}>
          <Download />
          下载到本地
        </Button>
      </form>
      {tasks.data?.tasks
        .filter((task) => task.status === "running" || task.status === "error")
        .map((task) => (
          <div
            key={task.image}
            className="rounded-lg border border-border bg-card p-4 text-xs"
          >
            <p>
              {task.image} · {task.status === "running" ? "下载中" : "下载失败"}
            </p>
            <p role="status" className="mt-2 text-muted-foreground">
              {task.error ||
                events.find((e) => e.image === task.image && e.kind === "pull")
                  ?.progress ||
                "等待镜像层下载…"}
            </p>
          </div>
        ))}
      <Resource resource={resource}>
        {(data) =>
          !data.images.length ? (
            <Card>
              <Empty
                title="本地镜像仓库为空"
                description="输入 OpenClaw 运行镜像名称，下载后即可用于开通实例。"
              />
            </Card>
          ) : (
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>本地镜像 · {data.images.length}</CardTitle>
                <Button size="sm" variant="ghost" onClick={resource.reload}>
                  <RefreshCw />
                  刷新
                </Button>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-[10px] uppercase text-muted-foreground">
                      <tr>
                        <th className="pb-3 font-normal">镜像</th>
                        <th className="pb-3 font-normal">用途</th>
                        <th className="pb-3 text-right font-normal">大小</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.images.map((row, i) => (
                        <tr
                          key={row.id || i}
                          className="border-t border-border"
                        >
                          <td className="max-w-xs break-all py-4 pr-5 font-mono">
                            {(row.tags || row.repoTags || []).join(", ") ||
                              row.id?.slice(0, 20)}
                          </td>
                          <td className="py-4 text-muted-foreground">
                            {row.purpose || "运行镜像"}
                          </td>
                          <td className="py-4 text-right font-mono text-muted-foreground">
                            {bytes(row.size)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )
        }
      </Resource>
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>安全清理</CardTitle>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              run(async () => {
                setPreview(null);
                setResult(null);
                setPreview(await request("/api/images/cleanup/preview"));
              })
            }
          >
            生成清理预览
          </Button>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-xs leading-6 text-muted-foreground">
            保留实例最近一个回滚版本和 Manager
            上一版本。仍被引用的项目不会删除。预览有效期为 5 分钟。
          </p>
          {preview && (
            <>
              <JsonView value={preview} />
              {preview.blockedReason && (
                <ErrorNotice>{preview.blockedReason}</ErrorNotice>
              )}
              <Button
                className="mt-4"
                variant="destructive"
                size="sm"
                disabled={
                  busy ||
                  Date.parse(preview.expiresAt) <= Date.now() ||
                  !!preview.blockedReason ||
                  (!preview.summary.deleteImages &&
                    !preview.summary.deleteContainers)
                }
                onClick={() => {
                  if (
                    confirm(
                      `按预览清理 ${preview.summary.deleteImages} 个镜像、${preview.summary.deleteContainers} 个容器？`,
                    )
                  )
                    run(async () => {
                      const previewId = preview.previewId;
                      setPreview(null);
                      const data = await request("/api/images/cleanup", {
                        method: "POST",
                        body: { previewId },
                      });
                      setResult(data);
                      resource.reload();
                      await fetchHistory();
                    }, "清理已完成");
                }}
              >
                按预览清理
              </Button>
            </>
          )}
          {result && <JsonView value={result} />}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>清理历史</CardTitle>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => loadHistory()}
          >
            读取历史
          </Button>
        </CardHeader>
        <CardContent>
          {history ? (
            <>
              <JsonView value={entries} />
              {history.nextCursor && (
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => loadHistory(history.nextCursor)}
                >
                  加载更早记录
                </Button>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              按需读取历史清理记录。
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
export function BackupsPage() {
  const resource = useResource("/api/backups/status", 10000);
  const kept = useResource("/api/instances/kept");
  const { busy, run } = useAction();
  return (
    <div className="page-enter space-y-6">
      <PageHeading
        title="备份管理"
        description="检查自动备份状态，手动备份，或恢复保留的实例数据。"
        action={
          <Button
            disabled={busy || resource.data?.state === "running"}
            onClick={() =>
              run(async () => {
                await request("/api/backups/run", { method: "POST", body: {} });
                resource.reload();
              }, "备份已开始")
            }
          >
            <DatabaseBackup />
            立即备份
          </Button>
        }
      />
      <Resource resource={resource}>
        {(data) => (
          <Card>
            <CardHeader>
              <CardTitle>
                备份状态 ·{" "}
                {{
                  never: "尚未备份",
                  running: "执行中",
                  success: "成功",
                  failed: "失败",
                  overdue: "已逾期",
                  idle: "空闲",
                }[data.state] || data.state}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-6 text-xs sm:grid-cols-2">
                {[
                  [
                    "最近成功",
                    date(
                      data.lastSuccess?.completedAt ||
                        data.lastSuccess?.finishedAt ||
                        data.lastSuccess?.at ||
                        data.lastSuccess?.date,
                    ),
                  ],
                  ["下次执行", date(data.nextRunAt)],
                  ["保留时长", `${data.retentionDays} 天`],
                  [
                    "自动计划",
                    data.schedule?.enabled
                      ? `${data.schedule.hour}:${String(data.schedule.minute).padStart(2, "0")} · ${data.schedule.timezone}`
                      : "未启用",
                  ],
                  ["备份目录", data.directory],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="mb-2 text-muted-foreground">{label}</dt>
                    <dd className="break-all font-mono">{value}</dd>
                  </div>
                ))}
              </dl>
              {data.lastError && <ErrorNotice>{data.lastError}</ErrorNotice>}
            </CardContent>
          </Card>
        )}
      </Resource>
      <Card>
        <CardHeader>
          <CardTitle>保留的实例数据</CardTitle>
          <p className="text-xs text-muted-foreground">
            恢复后实例回到列表，需要重新启动容器；访问端口可能变化。
          </p>
        </CardHeader>
        <CardContent>
          <Resource resource={kept}>
            {(data) =>
              !data.kept.length ? (
                <Empty title="暂无待恢复的数据" />
              ) : (
                data.kept.map((row) => (
                  <div
                    key={row.id}
                    className="flex items-center justify-between gap-3 border-b border-border py-4"
                  >
                    <div>
                      <p className="text-sm">{row.name || row.id}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {row.id}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        if (confirm(`恢复实例 ${row.name || row.id}？`))
                          run(async () => {
                            await request(
                              `/api/instances/kept/${encodeURIComponent(row.id)}/restore`,
                              { method: "POST", body: {} },
                            );
                            kept.reload();
                          }, "实例已恢复");
                      }}
                    >
                      <ArchiveRestore />
                      恢复实例
                    </Button>
                  </div>
                ))
              )
            }
          </Resource>
        </CardContent>
      </Card>
    </div>
  );
}
export function StartupPage() {
  const resource = useResource("/api/startup");
  const { busy, run } = useAction();
  return (
    <div className="page-enter">
      <PageHeading
        title="启动与恢复"
        description="管理自动启动策略，检查宿主机与实例的恢复状态。"
        action={
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await request("/api/startup/check", {
                  method: "POST",
                  body: {},
                });
                resource.reload();
              }, "检查已完成")
            }
          >
            <ShieldCheck />
            立即检查
          </Button>
        }
      />
      <Resource resource={resource}>
        {(data) => (
          <StartupSettings
            key={data.revision}
            data={data}
            reload={resource.reload}
          />
        )}
      </Resource>
    </div>
  );
}
function StartupSettings({ data, reload }) {
  const [settings, setSettings] = useState(data.settings);
  const { busy, run } = useAction();
  const dirty = JSON.stringify(settings) !== JSON.stringify(data.settings);
  useDirty(dirty);
  return (
    <div className="space-y-5">
      {data.apfsRecovery?.enabled && <Card><CardHeader><CardTitle>宿主重启后的实例恢复</CardTitle></CardHeader><CardContent className="space-y-3 text-xs"><p>挂载并校验数据卷后，仅恢复重启前已确认运行的实例。手动停止、存储保护、迁移中或状态不明的实例保持停止；本次启动失败不反复重试。</p><div className="space-y-2">{(data.apfsRecovery.instances || []).map(row => <p key={row.id}>{data.instances?.find(i => i.id === row.id)?.name || row.id} · {row.desired === "running" ? "已记录运行意图" : "保持停止"} · {row.detail || row.phase}</p>)}</div></CardContent></Card>}
      {data.apfsRecovery?.error && <ErrorNotice>恢复记录异常，已禁止自动启动：{data.apfsRecovery.error}</ErrorNotice>}
      <Card>
        <CardHeader>
          <CardTitle>自动启动</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-5">
            {[
              ["managerAutoStart", "自动启动 Manager"],
              ["dockerAutoLaunch", "自动启动 Docker"],
              ["instancesAutoStart", "自动启动实例"],
            ].map(([key, label]) => (
              <Check
                key={key}
                label={label}
                disabled={
                  busy ||
                  (key !== "instancesAutoStart" &&
                    data.capabilities?.[key] === false)
                }
                checked={!!settings[key]}
                onChange={(e) =>
                  setSettings({ ...settings, [key]: e.target.checked })
                }
              />
            ))}
            <p className="text-xs leading-6 text-muted-foreground">
              不可选项由目标设备的系统服务管理。实例启动策略可单独覆盖。
            </p>
            <div className="space-y-3">
              {(data.instances || []).map((row) => (
                <div
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3"
                >
                  <span className="text-xs">{row.name || row.id}</span>
                  <select
                    aria-label={`${row.name || row.id} 的自启策略`}
                    className="rounded border border-input bg-background px-3 py-2 text-xs"
                    value={
                      settings.instanceOverrides?.[row.id] === undefined
                        ? ""
                        : String(settings.instanceOverrides[row.id])
                    }
                    onChange={(e) => {
                      const next = { ...(settings.instanceOverrides || {}) };
                      if (e.target.value === "") delete next[row.id];
                      else next[row.id] = e.target.value === "true";
                      setSettings({ ...settings, instanceOverrides: next });
                    }}
                  >
                    <option value="">跟随全局策略</option>
                    <option value="true">自动启动</option>
                    <option value="false">保持停止</option>
                  </select>
                </div>
              ))}
            </div>
            <Button
              disabled={!dirty || busy}
              onClick={() =>
                run(async () => {
                  await request("/api/startup", {
                    method: "PUT",
                    body: {
                      ...settings,
                      instanceOverrides: Object.fromEntries(
                        (data.instances || []).map((row) => [
                          row.id,
                          settings.instanceOverrides?.[row.id] ?? null,
                        ]),
                      ),
                      revision: data.revision,
                    },
                  });
                  reload();
                }, "启动设置已保存")
              }
            >
              保存设置
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>恢复检查结果</CardTitle>
        </CardHeader>
        <CardContent>
          <JsonView value={data.status} />
        </CardContent>
      </Card>
    </div>
  );
}
