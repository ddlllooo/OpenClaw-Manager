import { useState, lazy, Suspense } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Bot,
  Copy,
  Cpu,
  HardDrive,
  Loader2,
  Play,
  RotateCw,
  Settings2,
  Square,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Empty,
  ErrorNotice,
  FormDialog,
  JsonView,
  Loading,
  Resource,
  Status,
} from "@/components/shared";
import { useAction, useResource, canNavigate } from "@/lib/hooks";
import { request } from "@/lib/api";
import { bytes, date, networkRate, instancePath as ip } from "@/lib/utils";
import {
  Models,
  Feishu,
  FileEditor,
  Workspace,
  Automations,
  Sessions,
} from "./settings";
import { Agents, Extensions } from "./management";
import Chat from "./chat";
import Storage from "./storage";
const ContainerTerminal = lazy(() => import("./terminal"));
const fields = [
  {
    key: "cpus",
    label: "CPU 核数上限",
    type: "number",
    required: true,
    min: 0.1,
    step: 0.1,
  },
  { key: "memory", label: "内存上限", required: true, placeholder: "2g" },
  { key: "pidsLimit", label: "进程数上限", type: "number", min: 1 },
];
const tabs = [
  ["overview", "概览"],
  ["chat", "对话"],
  ["models", "模型"],
  ["feishu", "飞书渠道"],
  ["agents", "Agents"],
  ["workspace", "工作区"],
  ["storage", "存储与备份"],
  ["automations", "定时任务"],
  ["sessions", "会话"],
  ["extensions", "技能与插件"],
  ["terminal", "终端"],
  ["logs", "日志"],
  ["config", "配置"],
  ["env", "环境变量"],
];
export default function InstanceDetail({
  instance: row,
  samples,
  reload,
  back,
}) {
  const [tab, setTab] = useState("overview");
  const [dialog, setDialog] = useState(null);
  const { busy, run } = useAction();
  const mutate = (suffix, body = {}, method = "POST") =>
    request(ip(row.id, suffix), { method, body });
  const action = (name) =>
    run(async () => {
      await mutate(`/${name}`);
      await reload();
    }, "操作完成");
  const openUI = () => {
    // Reserve a tab synchronously so browsers do not block an asynchronous popup.
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    run(async () => {
      try {
        const { token } = await request(ip(row.id, "/token"));
        const url = new URL(row.uiUrl, location.href);
        url.hash = `token=${encodeURIComponent(token)}`;
        if (popup) popup.location.replace(url.href);
        else toast.error("请允许浏览器打开控制台窗口");
      } catch (error) {
        popup?.close();
        throw error;
      }
    });
  };
  return (
    <div className="page-enter">
      <button
        onClick={back}
        className="mb-6 flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        返回工作空间
      </button>
      <div className="mb-7 flex flex-wrap items-center justify-between gap-5">
        <div>
          <div className="mb-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            INSTANCE / {row.id}
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <h1 className="text-3xl font-semibold tracking-tight">
              {row.name}
            </h1>
            <Status state={row.state} />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setDialog("rename")}
              aria-label="重命名实例"
            >
              <Settings2 />
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={openUI}
            disabled={busy || row.state !== "running"}
          >
            打开控制台
            <ArrowUpRight />
          </Button>
          {row.state === "running" ? (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => action("restart")}
              >
                <RotateCw />
                重启
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => action("gateway-restart")}
              >
                重启网关
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => action("stop")}
              >
                <Square />
                停止
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => action("start")}>
              {busy ? <Loader2 className="animate-spin" /> : <Play />}启动实例
            </Button>
          )}
          <Button
            variant="destructive"
            size="icon"
            className="size-8"
            disabled={busy}
            onClick={() => setDialog("delete")}
            aria-label="删除实例"
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      {(row.lastError || row.error) && (
        <ErrorNotice>
          {row.lastError || row.error}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => action("clear-error")}
          >
            清除提示
          </Button>
        </ErrorNotice>
      )}
      {(row.configPending || row.envPending) && (
        <p
          role="status"
          className="mb-5 rounded-lg border border-warning/20 bg-warning/5 p-4 text-xs text-warning"
        >
          配置已修改，重启实例后应用。
        </p>
      )}
      <Tabs
        value={tab}
        onValueChange={(next) => {
          if (canNavigate()) setTab(next);
        }}
      >
        <TabsList aria-label="实例功能">
          {tabs.map(([key, label]) => (
            <TabsTrigger value={key} key={key}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">
          <Overview
            row={row}
            samples={samples}
            onResources={() => setDialog("resources")}
          />
        </TabsContent>
        <TabsContent value="models">
          <Models id={row.id} />
        </TabsContent>
        <TabsContent value="feishu">
          <Feishu id={row.id} />
        </TabsContent>
        <TabsContent value="chat">
          <Chat id={row.id} />
        </TabsContent>
        <TabsContent value="workspace">
          <Workspace id={row.id} />
        </TabsContent>
        <TabsContent value="storage">
          <Storage id={row.id} reloadInstance={reload} />
        </TabsContent>
        <TabsContent value="automations">
          <Automations id={row.id} />
        </TabsContent>
        <TabsContent value="sessions">
          <Sessions id={row.id} />
        </TabsContent>
        <TabsContent value="agents">
          <Agents id={row.id} />
        </TabsContent>
        <TabsContent value="extensions">
          <Extensions id={row.id} />
        </TabsContent>
        <TabsContent value="terminal">
          {row.state === "running" ? (
            <Suspense fallback={<Loading />}>
              <ContainerTerminal id={row.id} />
            </Suspense>
          ) : (
            <Empty
              title="实例未运行"
              description="启动实例后即可连接容器终端。"
            />
          )}
        </TabsContent>
        <TabsContent value="logs">
          <Logs id={row.id} />
        </TabsContent>
        <TabsContent value="config">
          <FileEditor path={ip(row.id, "/config")} title="openclaw.json" />
        </TabsContent>
        <TabsContent value="env">
          <FileEditor path={ip(row.id, "/env")} title="环境变量 .env" />
        </TabsContent>
      </Tabs>
      {dialog === "rename" && (
        <FormDialog
          title="重命名实例"
          initial={{ name: row.name }}
          fields={[
            { key: "name", label: "实例名称", required: true, wide: true },
          ]}
          onClose={() => setDialog(null)}
          submit={async (v) => {
            await mutate("", v, "PATCH");
            reload();
          }}
        />
      )}
      {dialog === "resources" && (
        <FormDialog
          title="调整实例资源"
          initial={{
            ...row.resources,
            memory:
              row.resources?.memory ||
              `${Math.round((row.resources?.memoryBytes || 2147483648) / 1024 ** 2)}m`,
          }}
          fields={fields}
          onClose={() => setDialog(null)}
          submit={async (v) => {
            await mutate("/resources", v, "PATCH");
            reload();
          }}
        />
      )}
      {dialog === "delete" && (
        <FormDialog
          title={`删除「${row.name}」？`}
          description="容器将停止并移除。可保留工作区数据，以便之后恢复实例。"
          initial={{ keepData: true }}
          fields={[
            {
              key: "keepData",
              label: "保留实例数据，允许后续恢复",
              type: "checkbox",
              wide: true,
            },
          ]}
          submitLabel="确认删除"
          onClose={() => setDialog(null)}
          submit={async (v) => {
            await request(ip(row.id, `?keepData=${v.keepData ? "1" : "0"}`), {
              method: "DELETE",
              body: {},
            });
            reload();
            back();
          }}
        />
      )}
    </div>
  );
}
function Overview({ row, samples, onResources }) {
  const history = useResource(ip(row.id, "/history"));
  const data = samples.length ? samples : history.data?.samples || [];
  const latest = row.state === "running" ? data.at(-1) : null;
  const network =
    row.state === "running" ? networkRate(data.at(-2), latest) : null;
  const [diagnostics, setDiagnostics] = useState(null);
  const [token, setToken] = useState(null);
  const { busy, run } = useAction();
  const reveal = () =>
    run(async () => {
      const result = await request(ip(row.id, "/token"));
      setToken(result.token);
    });
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          [
            "CPU 占用",
            latest ? `${latest.cpuPercent}%` : "—",
            `${row.resources?.cpus || "—"} 核上限`,
            Cpu,
          ],
          [
            "内存使用",
            latest ? bytes(latest.memUsed) : "—",
            `${bytes(row.resources?.memoryBytes)} 上限`,
            HardDrive,
          ],
          [
            "网络速率",
            network ? `${bytes(network.rx)}/s` : "—",
            network ? `↑ ${bytes(network.tx)}/s` : "等待采样",
            ArrowUpRight,
          ],
          [
            "网关就绪",
            row.health ? (row.health.ready ? "已就绪" : "未就绪") : "等待探测",
            `访问端口 ${row.port}`,
            Bot,
          ],
        ].map(([title, value, sub, Icon]) => (
          <Card key={title}>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="text-muted-foreground">{title}</CardTitle>
              <Icon className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <p className="mb-2 font-mono text-2xl">{value}</p>
              <p className="text-xs text-muted-foreground">{sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>CPU 资源趋势</CardTitle>
          <p className="text-xs text-muted-foreground">
            最近 {data.length} 个采样点 · 单核 100%
          </p>
        </CardHeader>
        <CardContent>
          {data.length > 1 ? (
            <svg
              viewBox="0 0 800 110"
              className="h-32 w-full"
              role="img"
              aria-label="CPU 使用率趋势"
            >
              <defs>
                <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--brand)" stopOpacity=".2" />
                  <stop
                    offset="100%"
                    stopColor="var(--brand)"
                    stopOpacity="0"
                  />
                </linearGradient>
              </defs>
              {[0, 50, 100].map((y) => (
                <line
                  key={y}
                  x1="0"
                  x2="800"
                  y1={y}
                  y2={y}
                  stroke="var(--border)"
                />
              ))}
              <polyline
                fill="none"
                stroke="var(--brand)"
                strokeWidth="2"
                points={data
                  .map(
                    (sample, i) =>
                      `${(i * 800) / (data.length - 1)},${100 - Math.min(100, sample.cpuPercent / (row.resources?.cpus || 1))}`,
                  )
                  .join(" ")}
              />
            </svg>
          ) : (
            <p className="py-8 text-center text-xs text-muted-foreground">
              等待资源采样。实例运行后自动更新。
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>实例信息</CardTitle>
          <Button variant="outline" size="sm" onClick={onResources}>
            调整资源
          </Button>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-5 text-xs sm:grid-cols-2">
            {[
              ["控制台地址", row.uiUrl],
              ["镜像", row.image],
              ["创建时间", date(row.createdAt)],
              ["容器 ID", row.containerId || "尚未创建"],
            ].map(([key, value]) => (
              <div key={key} className="min-w-0">
                <dt className="mb-2 text-muted-foreground">{key}</dt>
                <dd className="break-all font-mono">{value}</dd>
              </div>
            ))}
            <div className="sm:col-span-2">
              <dt className="mb-2 text-muted-foreground">Gateway Token</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <code className="break-all">{token || "••••••••••••••••"}</code>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={token ? () => setToken(null) : reveal}
                >
                  {token ? "隐藏" : "显示"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const data = await request(ip(row.id, "/token"));
                      await navigator.clipboard.writeText(data.token);
                    }, "已复制凭据")
                  }
                >
                  <Copy />
                  复制
                </Button>
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>实例诊断</CardTitle>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              run(async () =>
                setDiagnostics(
                  await request(ip(row.id, "/diagnostics"), {
                    method: "POST",
                    body: {},
                  }),
                ),
              )
            }
          >
            运行诊断
          </Button>
        </CardHeader>
        <CardContent>
          {diagnostics ? (
            <div className="space-y-3">
              {diagnostics.checks.map((check, i) => (
                <div key={i} className="rounded-lg border border-border p-4">
                  <div className="flex gap-2 text-sm">
                    <span
                      className={
                        check.status === "error"
                          ? "text-destructive"
                          : "text-success"
                      }
                    >
                      ●
                    </span>
                    {check.name || check.label || check.title}
                  </div>
                  <div className="mt-2">
                    {typeof check.detail === "string" ? (
                      <p className="text-xs text-muted-foreground">
                        {check.detail}
                      </p>
                    ) : (
                      <JsonView value={check.detail} />
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              检查容器、网关、模型和渠道状态。
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
function Logs({ id }) {
  const [auto, setAuto] = useState(false);
  const resource = useResource(ip(id, "/logs?tail=500"), auto ? 5000 : 0);
  return (
    <div>
      <div className="mb-4 flex justify-between gap-3">
        <h2 className="text-sm font-medium">容器日志</h2>
        <div className="flex gap-2">
          <Button
            variant={auto ? "secondary" : "outline"}
            size="sm"
            onClick={() => setAuto(!auto)}
          >
            {auto ? "停止自动刷新" : "自动刷新"}
          </Button>
          <Button variant="outline" size="sm" onClick={resource.reload}>
            刷新
          </Button>
        </div>
      </div>
      <Resource resource={resource}>
        {(data) => (
          <pre className="max-h-[65vh] min-h-72 overflow-auto rounded-lg border border-border bg-console p-5 font-mono text-xs leading-6 text-secondary-foreground">
            {data.logs || "暂无日志"}
          </pre>
        )}
      </Resource>
    </div>
  );
}
