import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Box,
  ChevronRight,
  CircleHelp,
  Cpu,
  DatabaseBackup,
  HardDrive,
  Layers3,
  LayoutDashboard,
  LogOut,
  Menu,
  Monitor,
  Plus,
  Search,
  Server,
  ShieldCheck,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Empty,
  ErrorNotice,
  FormDialog,
  Loading,
  PageHeading,
  Select,
  Status,
} from "@/components/shared";
import { canNavigate, useAction, useResource } from "@/lib/hooks";
import { request } from "@/lib/api";
import { bytes, date } from "@/lib/utils";
import InstanceDetail from "@/pages/instance";
import { ImagesPage, BackupsPage, StartupPage } from "@/pages/system";
import DevicesPage from "@/pages/devices";

const navigation = [
  ["overview", "工作空间", LayoutDashboard],
  ["devices", "部署设备", Monitor],
  ["images", "镜像仓库", Layers3],
  ["backups", "备份管理", DatabaseBackup],
  ["startup", "启动与恢复", ShieldCheck],
  ["activity", "活动记录", Activity],
];
const resourceFields = [
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
export { resourceFields };

export default function App({ onLogout }) {
  const { busy: loggingOut, run: runLogout } = useAction();
  const instances = useResource("/api/instances", 10000);
  const context = useResource("/api/connections/context", 15000);
  const [page, setPage] = useState(() =>
    new URLSearchParams(location.search).has("manageDevices")
      ? "devices"
      : "overview",
  );
  const [selected, setSelected] = useState(null);
  const [create, setCreate] = useState(false);
  const [query, setQuery] = useState("");
  const [mobile, setMobile] = useState(false);
  const [help, setHelp] = useState(false);
  const [events, setEvents] = useState([]);
  const [samples, setSamples] = useState({});
  const [health, setHealth] = useState({});
  const [online, setOnline] = useState(false);
  const serial = useRef(0);
  const rows = instances.data?.instances || [];
  const system = instances.data?.system;
  const running = rows.filter((row) => row.state === "running").length;
  const navigate = (next) => {
    if (canNavigate()) {
      if (next === "devices" && context.data?.mode === "ssh") {
        location.assign(new URL("?manageDevices=1", context.data.homeUrl).href);
        return;
      }
      setPage(next);
      setSelected(null);
      setMobile(false);
    }
  };
  const choose = (id) => {
    if (selected !== id && !canNavigate()) return;
    setPage("overview");
    setSelected(id);
    setMobile(false);
  };
  useEffect(() => {
    let source;
    const connect = () => {
      source?.close();
      if (document.hidden) {
        setOnline(false);
        return;
      }
      source = new EventSource("/api/events");
      source.onopen = () => setOnline(true);
      source.onerror = () => setOnline(false);
      source.addEventListener("stats", (e) => {
        const row = JSON.parse(e.data);
        setSamples((previous) => ({
          ...previous,
          [row.id]: [...(previous[row.id] || []).slice(-59), row],
        }));
      });
      source.addEventListener("health", (e) => {
        const data = JSON.parse(e.data);
        setHealth((previous) => ({ ...previous, [data.id]: data.health }));
      });
      for (const kind of ["lifecycle", "pull"])
        source.addEventListener(kind, (e) => {
          const data = JSON.parse(e.data);
          setEvents((previous) =>
            [
              { ...data, kind, key: ++serial.current, time: Date.now() },
              ...previous,
            ].slice(0, 200),
          );
          if (kind === "lifecycle" || ["done", "error"].includes(data.status))
            instances.reload();
        });
    };
    const visibility = () => {
      connect();
      if (!document.hidden) instances.reload();
    };
    connect();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      source?.close();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [instances.reload]);
  useEffect(() => {
    if (
      !instances.loading &&
      selected &&
      !rows.some((row) => row.id === selected)
    )
      setSelected(null);
  }, [instances.data, instances.loading, selected]);
  useEffect(() => {
    const keys = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setMobile(true);
        document.getElementById("workspace-search")?.focus();
      }
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, []);
  const active = rows.find((row) => row.id === selected);
  return (
    <div className="min-h-screen lg:flex">
      <a
        href="#main"
        className="sr-only fixed left-4 top-2 z-50 rounded bg-primary p-2 focus:not-sr-only"
      >
        跳转至主要内容
      </a>
      {mobile && (
        <button
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          aria-label="关闭导航"
          onClick={() => setMobile(false)}
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-border bg-sidebar transition-transform lg:translate-x-0 ${mobile ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex h-20 items-center gap-3 px-5">
          <div className="grid size-8 place-items-center rounded-lg bg-foreground">
            <Box className="size-5 text-background" strokeWidth={1.6} />
          </div>
          <div>
            <p className="text-sm font-semibold tracking-tight">OpenClaw</p>
            <p className="text-[10px] tracking-widest text-muted-foreground">
              MANAGER
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto lg:hidden"
            onClick={() => setMobile(false)}
            aria-label="关闭导航"
          >
            <X />
          </Button>
        </div>
        <div className="px-3">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 size-3.5 text-muted-foreground" />
            <Input
              id="workspace-search"
              className="h-9 border-border bg-secondary/40 pl-9 text-xs"
              placeholder="搜索实例…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <kbd className="pointer-events-none absolute right-2 top-2 rounded border border-border px-1 text-[10px] text-muted-foreground">
              ⌘ K
            </kbd>
          </div>
        </div>
        <div className="mx-3 my-5 rounded-lg border border-border p-2.5">
          <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted-foreground">
            <span className="size-1.5 rounded-full bg-success" />
            当前设备
          </div>
          <Select
            className="h-7 border-0 bg-transparent px-0 text-xs"
            aria-label="切换部署设备"
            value={context.data?.device.id || "local"}
            onChange={(e) => {
              const device = context.data?.devices.find(
                (d) => d.id === e.target.value,
              );
              if (device?.url && canNavigate()) location.assign(device.url);
            }}
          >
            {(
              context.data?.devices || [
                { id: "local", name: "本机 Docker", status: "connected" },
              ]
            ).map((device) => (
              <option
                key={device.id}
                value={device.id}
                disabled={!device.url && device.id !== "local"}
              >
                {device.name}
                {device.status !== "connected" ? " · 未连接" : ""}
              </option>
            ))}
          </Select>
        </div>
        <nav className="space-y-1 px-3" aria-label="主导航">
          {navigation.map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => navigate(id)}
              className={`flex h-9 w-full items-center gap-3 rounded-md px-3 text-[13px] transition-colors ${page === id && !active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"}`}
            >
              <Icon className="size-4" strokeWidth={1.6} />
              {label}
              {id === "overview" && (
                <span className="ml-auto text-[11px] opacity-70">
                  {rows.length}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="mt-7 flex min-h-0 flex-1 flex-col">
          <div className="mb-2 flex items-center justify-between px-6 text-[10px] tracking-widest text-muted-foreground">
            <span>实例</span>
            <button
              onClick={() => setCreate(true)}
              aria-label="创建实例"
              className="rounded p-1 hover:bg-accent"
            >
              <Plus className="size-3.5" />
            </button>
          </div>
          <div className="overflow-y-auto px-3">
            {rows
              .filter((row) =>
                row.name.toLowerCase().includes(query.toLowerCase()),
              )
              .map((row) => (
                <button
                  key={row.id}
                  onClick={() => choose(row.id)}
                  className={`mb-1 flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-xs ${selected === row.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"}`}
                >
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${row.state === "running" ? "bg-success" : "bg-inactive"}`}
                  />
                  <span className="truncate">{row.name}</span>
                </button>
              ))}
            {!rows.length && (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                创建你的第一个实例
              </p>
            )}
          </div>
        </div>
        <div className="mx-5 border-t border-border py-5">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="flex items-center gap-2">
              <span
                className={`size-1.5 rounded-full ${online ? "bg-success" : "bg-warning"}`}
              />
              {online ? "实时连接正常" : "正在重新连接"}
            </span>
            <button aria-label="使用帮助" onClick={() => setHelp(true)}>
              <CircleHelp className="size-4" />
            </button>
          </div>
          <Button
            variant="ghost"
            className="mt-3 w-full justify-start text-muted-foreground hover:text-foreground"
            disabled={loggingOut}
            onClick={() => {
              if (canNavigate()) runLogout(onLogout);
            }}
          >
            <LogOut />
            {loggingOut ? "正在退出…" : "退出登录"}
          </Button>
        </div>
      </aside>
      <div className="min-w-0 flex-1 lg:ml-60">
        <header className="flex h-14 items-center justify-between gap-3 border-b border-border px-5 sm:px-9">
          <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label="打开导航"
              onClick={() => setMobile(true)}
            >
              <Menu />
            </Button>
            <span className="hidden sm:inline">OpenClaw</span>
            <ChevronRight className="hidden size-3 sm:block" />
            <span className="truncate text-foreground/80">
              {active?.name || navigation.find((n) => n[0] === page)?.[1]}
            </span>
          </div>
          <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Server className="size-3.5" />
            {context.data?.device.name || "本机 Docker"}
          </span>
        </header>
        <main
          id="main"
          className="mx-auto max-w-[1500px] px-5 py-8 sm:px-9 sm:py-10"
        >
          {instances.error && (
            <ErrorNotice retry={instances.reload}>
              {instances.error}
            </ErrorNotice>
          )}
          {page === "overview" &&
            (active ? (
              <InstanceDetail
                key={active.id}
                instance={{
                  ...active,
                  health: health[active.id] || active.health,
                }}
                samples={samples[active.id] || []}
                reload={instances.reload}
                back={() => navigate("overview")}
              />
            ) : (
              <Dashboard
                rows={rows}
                system={system}
                loading={instances.loading}
                query={query}
                onSelect={choose}
                onCreate={() => setCreate(true)}
                samples={samples}
                events={events}
                navigate={navigate}
              />
            ))}
          {page === "images" && <ImagesPage events={events} />}
          {page === "devices" && <DevicesPage />}
          {page === "backups" && <BackupsPage />}
          {page === "startup" && <StartupPage />}
          {page === "activity" && (
            <>
              <PageHeading
                title="活动记录"
                description="当前连接期间的操作与系统事件，实时更新。"
                action={
                  <Button variant="outline" onClick={() => setEvents([])}>
                    清空记录
                  </Button>
                }
              />
              <EventList events={events} />
            </>
          )}
        </main>
        <footer className="mx-5 flex flex-wrap justify-between gap-2 border-t border-border py-6 text-[10px] tracking-wide text-muted-foreground sm:mx-9">
          <span>OpenClaw Manager</span>
          <span></span>
        </footer>
      </div>
      {create && (
        <CreateInstance
          rows={rows}
          onClose={() => setCreate(false)}
          onCreated={async (id) => {
            await instances.reload();
            setPage("overview");
            setSelected(id);
          }}
        />
      )}
      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent>
          <DialogTitle>你的部署工作空间</DialogTitle>
          <DialogDescription>
            在「工作空间」创建实例，在「部署设备」添加 SSH
            远程设备。选择实例可管理模型、对话、工作区、定时任务和终端。修改文件后请保存，再切换页面。管理界面默认使用本地端口
            18080。
          </DialogDescription>
          <p className="text-sm text-muted-foreground">
            快捷键：Ctrl / ⌘ + K 搜索实例。
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Dashboard({
  rows,
  system,
  loading,
  query,
  onSelect,
  onCreate,
  samples,
  events,
  navigate,
}) {
  const [filter, setFilter] = useState("all");
  const running = rows.filter((row) => row.state === "running").length;
  const filtered = rows.filter(
    (row) =>
      row.name.toLowerCase().includes(query.toLowerCase()) &&
      (filter === "all" ||
        (row.state === "running") === (filter === "running")),
  );
  return (
    <div className="page-enter">
      <PageHeading
        title="工作空间"
        action={
          <Button onClick={onCreate}>
            <Plus />
            开通新实例
          </Button>
        }
      />
      <div className="mb-9 grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[
          ["全部实例", rows.length, Box, "当前设备的工作环境"],
          ["运行中", running, Activity, "实例容器正在运行"],
          [
            "CPU 资源",
            system ? `${system.ncpu} 核` : "—",
            Cpu,
            system ? `Docker ${system.serverVersion}` : "等待 Docker 连接",
          ],
          [
            "宿主机内存",
            system ? bytes(system.memTotal) : "—",
            HardDrive,
            "Docker 可用总内存",
          ],
        ].map(([label, value, Icon, sub], index) => (
          <Card key={label} className="bg-card/60">
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="text-xs text-muted-foreground">
                {label}
              </CardTitle>
              <Icon
                className={`size-4 ${index === 1 ? "text-success/80" : "text-muted-foreground"}`}
              />
            </CardHeader>
            <CardContent>
              <div className="mb-2 font-mono text-3xl font-medium tracking-tight">
                {value}
              </div>
              <p className="text-[10px] text-muted-foreground">{sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-medium">实例工作空间</h2>
          <span className="rounded bg-secondary px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
            {rows.length}
          </span>
        </div>
        <div className="flex rounded-lg border border-border bg-card p-1">
          {[
            ["all", "全部"],
            ["running", "运行中"],
            ["idle", "未运行"],
          ].map(([id, label]) => (
            <button
              aria-pressed={filter === id}
              key={id}
              onClick={() => setFilter(id)}
              className={`rounded-md px-3 py-1.5 text-xs ${filter === id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <Loading />
      ) : !rows.length ? (
        <Card className="grid-surface">
          <Empty
            title="暂无实例"
            description="点击开通新实例，创建 OpenClaw 运行环境。"
            action={
              <Button onClick={onCreate}>
                <Plus />
                开通第一个实例
              </Button>
            }
          />
          <div className="grid border-t border-border sm:grid-cols-3">
            {[
              ["01", "准备运行环境", "选择镜像，按需分配资源。"],
              ["02", "连接你的模型", "配置供应商，选择适合的模型。"],
              ["03", "使用实例", "通过对话、工作区和渠道推进工作。"],
            ].map(([n, title, desc]) => (
              <div
                className="border-border p-6 sm:border-r last:border-0"
                key={n}
              >
                <span className="font-mono text-[10px] text-brand-ink">
                  {n}
                </span>
                <p className="my-2 text-xs font-medium">{title}</p>
                <p className="text-[11px] text-muted-foreground">{desc}</p>
              </div>
            ))}
          </div>
        </Card>
      ) : !filtered.length ? (
        <Empty title="没有匹配的实例" description="试试其他名称或运行状态。" />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {filtered.map((row) => {
            const stats =
              row.state === "running" ? samples[row.id]?.at(-1) : null;
            return (
              <button
                key={row.id}
                onClick={() => onSelect(row.id)}
                className="group min-w-0 rounded-xl border border-border bg-card p-5 text-left transition-colors hover:border-border-hover hover:bg-surface-hover"
              >
                <div className="mb-6 flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="rounded-lg border border-border bg-secondary p-2.5">
                      <Box className="size-5 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-medium">
                        {row.name}
                      </h3>
                      <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                        {row.id}
                      </p>
                    </div>
                  </div>
                  <Status state={row.state} />
                </div>
                <div className="mb-5 grid grid-cols-2 gap-4">
                  <div>
                    <p className="mb-2 text-[10px] text-muted-foreground">
                      CPU 占用
                    </p>
                    <p className="font-mono text-sm">
                      {stats ? `${stats.cpuPercent}%` : "—"}
                    </p>
                    <Meter
                      value={
                        stats
                          ? stats.cpuPercent / (row.resources?.cpus || 1)
                          : 0
                      }
                    />
                  </div>
                  <div>
                    <p className="mb-2 text-[10px] text-muted-foreground">
                      内存使用
                    </p>
                    <p className="font-mono text-sm">
                      {stats ? bytes(stats.memUsed) : "—"}
                    </p>
                    <Meter value={stats?.memPercent || 0} />
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-border pt-4 text-[10px] text-muted-foreground">
                  <span className="truncate font-mono">{row.image}</span>
                  <ArrowUpRight className="size-4 shrink-0 group-hover:text-brand-ink" />
                </div>
              </button>
            );
          })}
        </div>
      )}
      <div className="mt-9 grid gap-5 xl:grid-cols-[1fr_300px]">
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-medium">最近活动</h2>
            <button
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => navigate("activity")}
            >
              全部记录
              <ChevronRight className="size-3" />
            </button>
          </div>
          <EventList events={events.slice(0, 4)} compact />
        </section>
        <Card className="hero-glow">
          <CardHeader>
            <div className="mb-3 flex size-8 items-center justify-center rounded-lg border border-border">
              <Monitor className="size-4 text-brand-ink" />
            </div>
            <CardTitle>部署设备</CardTitle>
            <p className="pt-2 text-xs leading-6 text-muted-foreground">
              连接 SSH 远程设备，在同一个界面管理更多部署。
            </p>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate("devices")}
            >
              连接远程设备
              <ArrowUpRight />
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
export function Meter({ value }) {
  return (
    <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/5">
      <div
        className="h-full rounded-full bg-brand/80 transition-[width]"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}
export function EventList({ events, compact }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {!events.length ? (
        <p className="p-7 text-center text-xs text-muted-foreground">
          暂无活动。操作与系统事件将实时出现在这里。
        </p>
      ) : (
        events.map((event) => (
          <div
            key={event.key}
            className="flex items-start gap-3 border-b border-border px-5 py-4 last:border-0"
          >
            <Activity
              className={`mt-0.5 size-3.5 shrink-0 ${event.status === "error" ? "text-destructive" : "text-muted-foreground"}`}
            />
            <div className="min-w-0 flex-1">
              <p className="break-words text-xs">
                {event.kind === "pull"
                  ? `镜像 ${event.image || event.id} · ${event.status}`
                  : `${event.id} · ${event.action}`}
                {event.error && (
                  <span className="text-destructive"> · {event.error}</span>
                )}
                {event.progress && (
                  <span className="ml-2 text-muted-foreground">
                    {event.progress}
                  </span>
                )}
              </p>
              <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                {date(event.time)}
              </p>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
function CreateInstance({ rows, onClose, onCreated }) {
  const resource = useResource("/api/instances/recommendations");
  const images = useResource("/api/images");
  if (resource.loading || images.loading)
    return (
      <Dialog open onOpenChange={onClose}>
        <DialogContent>
          <DialogTitle>开通新实例</DialogTitle>
          <DialogDescription>正在读取本地镜像与资源建议。</DialogDescription>
          <Loading />
        </DialogContent>
      </Dialog>
    );
  return (
    <FormDialog
      title="开通新实例"
      description="为新的工作创建独立环境。资源默认采用宿主机推荐配置。"
      onClose={onClose}
      initial={{
        name: "",
        image: images.data?.defaultImage || "",
        ...resource.data?.recommended,
        cloneFrom: "",
      }}
      submitLabel="确认开通"
      fields={[
        {
          key: "name",
          label: "实例名称",
          required: true,
          placeholder: "例如：研发助手",
          wide: true,
        },
        { key: "image", label: "运行镜像", required: true, wide: true },
        ...resourceFields,
        {
          key: "port",
          label: "访问端口（可选）",
          type: "number",
          min: 1024,
          max: 65535,
          hint: "留空自动分配 19000–19999。",
        },
        {
          key: "cloneFrom",
          label: "复用模型配置",
          wide: true,
          options: [
            { value: "", label: "全新配置" },
            ...rows.map((row) => ({ value: row.id, label: row.name })),
          ],
        },
      ]}
      submit={async (v) => {
        const data = await request("/api/instances", {
          method: "POST",
          body: {
            name: v.name,
            image: v.image,
            resources: {
              cpus: Number(v.cpus),
              memory: v.memory,
              pidsLimit: Number(v.pidsLimit),
            },
            ...(v.port ? { port: Number(v.port) } : {}),
            ...(v.cloneFrom ? { cloneFrom: v.cloneFrom } : {}),
          },
        });
        await onCreated(data.instance.id);
      }}
    >
      {(_, set) => (
        <>
          {(resource.error || images.error) && (
            <ErrorNotice>{resource.error || images.error}</ErrorNotice>
          )}
          <div className="flex flex-wrap gap-2">
            {(images.data?.images || [])
              .filter((i) => i.instanceEligible !== false)
              .flatMap((image) => image.tags || [])
              .filter((tag) => tag !== "<none>:<none>")
              .map((tag) => (
                <Button
                  key={tag}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => set((v) => ({ ...v, image: tag }))}
                >
                  {tag}
                </Button>
              ))}
          </div>
          <p className="text-xs text-muted-foreground">
            首次下载镜像可能需要几分钟。进度会显示在活动记录中。
          </p>
        </>
      )}
    </FormDialog>
  );
}
