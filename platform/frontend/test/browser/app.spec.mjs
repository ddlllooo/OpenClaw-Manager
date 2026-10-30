import { test, expect } from "@playwright/test";

const running = {
  id: "research",
  name: "研发助手",
  image: "openclaw/openclaw:2026.9.3",
  state: "running",
  uiUrl: "/ssh-gateway/research/",
  port: 19000,
  containerId: "container-research",
  resources: { cpus: 2, memory: "2g", memoryBytes: 2147483648, pidsLimit: 192 },
  createdAt: "2026-10-29T00:00:00Z",
  health: { ready: true, live: true },
};
const stopped = {
  ...running,
  id: "writing",
  name: "写作助手",
  state: "exited",
  containerId: "container-writing",
};
const system = { ncpu: 8, memTotal: 17179869184, serverVersion: "29.0.0" };
const model = {
  id: "example-model",
  pid: "openclaw-mgr-example",
  baseUrl: "https://example.com/v1",
  input: ["text", "image"],
  contextWindow: 128000,
  apiKeyMasked: "test****1234",
};
const calls = new WeakMap();
async function setup(page, { empty = false, auth = false } = {}) {
  const mutations = [];
  calls.set(page, mutations);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let rows = empty ? [] : [running, stopped];
  let authenticated = !auth;
  const file = { content: "# Agent rules\n", revision: "revision-original" };
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const body = req.postDataJSON();
    if (path === "/api/events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: 'retry: 60000\n\nevent: stats\ndata: {"id":"research","cpuPercent":12.5,"memUsed":512000000,"memPercent":24,"ts":1793232000000}\n\n',
      });
    if (path === "/api/session" && method === "DELETE") {
      authenticated = false;
      mutations.push({
        path,
        method,
        body,
        csrf: req.headers()["x-csrf-token"],
      });
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/session") {
      if (!authenticated && !req.headers().authorization)
        return route.fulfill({
          status: 401,
          json: { error: "Management authentication required" },
        });
      authenticated = true;
      return route.fulfill({ json: { csrf: "fixture-csrf" } });
    }
    if (method !== "GET") {
      mutations.push({
        path,
        method,
        body,
        csrf: req.headers()["x-csrf-token"],
      });
      if (path === "/api/connections/probe")
        return route.fulfill({
          json: { fingerprint: "SHA256:" + "a".repeat(43) },
        });
      if (path.endsWith("/chat/stream"))
        return route.fulfill({
          contentType: "application/x-ndjson",
          body: '{"kind":"chat","data":{"state":"delta","deltaText":"你好，世界"}}\n{"kind":"chat","data":{"state":"final","message":{"content":"你好，世界"}}}',
        });
      if (path.endsWith("/extensions/plugin/review"))
        return route.fulfill({
          json: {
            reviewRequired: true,
            reviewToken: "source-token",
            phase: "source",
            spec: body.spec,
            source: "https://registry.npmjs.org",
          },
        });
      if (
        path.endsWith("/extensions/plugin/install") &&
        body.reviewToken === "source-token"
      )
        return route.fulfill({
          json: {
            reviewRequired: true,
            reviewToken: "capability-token",
            phase: "capabilities",
            spec: body.spec,
            declared: { network: ["example.com"] },
          },
        });
      if (method === "PUT" && path.endsWith("/config")) {
        file.content = body.content;
        file.revision = "revision-saved";
      }
      if (path === "/api/instances" && method === "POST") {
        const created = { ...running, id: "new-instance", name: body.name };
        rows = [...rows, created];
        return route.fulfill({ json: { instance: created } });
      }
      if (path.endsWith("/start"))
        rows = rows.map((row) =>
          row.id === path.split("/")[3] ? { ...row, state: "running" } : row,
        );
      return route.fulfill({ json: { ok: true } });
    }
    let data;
    if (path === "/api/instances") data = { instances: rows, system };
    else if (path === "/api/connections/context")
      data = {
        device: { id: "local", name: "开发工作站" },
        devices: [
          {
            id: "local",
            name: "开发工作站",
            status: "connected",
            url: "http://127.0.0.1:18192/",
          },
        ],
      };
    else if (path === "/api/instances/recommendations")
      data = { recommended: { cpus: 2, memory: "2g", pidsLimit: 192 } };
    else if (path === "/api/images")
      data = {
        images: [
          {
            id: "image-1",
            tags: [running.image],
            purpose: "OpenClaw 运行镜像",
            size: 123456789,
          },
        ],
        defaultImage: running.image,
      };
    else if (path === "/api/images/tasks") data = { tasks: [] };
    else if (path === "/api/images/cleanup/preview")
      data = {
        previewId: "reviewed-preview",
        summary: { deleteImages: 1, deleteContainers: 0 },
        images: [{ name: "old-image", decision: "delete" }],
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      };
    else if (path === "/api/images/cleanup/history")
      data = { entries: [], nextCursor: null };
    else if (path === "/api/connections") data = { connections: [] };
    else if (path === "/api/connections/local-images") data = { images: [] };
    else if (path === "/api/backups/status")
      data = {
        state: "never",
        retentionDays: 7,
        schedule: { enabled: false },
        directory: "/backups",
      };
    else if (path === "/api/instances/kept") data = { kept: [] };
    else if (path === "/api/startup")
      data = {
        revision: "startup-rev",
        settings: {
          managerAutoStart: false,
          dockerAutoLaunch: false,
          instancesAutoStart: true,
          instanceOverrides: { research: false },
        },
        capabilities: {},
        instances: [running],
        status: { phase: "ready" },
      };
    else if (path.endsWith("/storage"))
      data = {
        bytes: 8589934592, fileCount: 1200, percent: 80,
        disk: { available: 42949672960 }, status: "warning",
        policy: { limitGiB: 10, minFreeGiB: 1, warnPercent: 80, stopPercent: 100 },
        mounts: [
          { folder: "openclaw", source: "/data/instances/research/openclaw", target: "/home/node/.openclaw", bytes: 1073741824 },
          { folder: "workspace", source: "/data/instances/research/workspace", target: "/home/node/.openclaw/workspace", bytes: 7516192768 },
          { folder: "auth", source: "/data/instances/research/auth", target: "/home/node/.config/openclaw", bytes: 1000 },
        ], coverage: "不含独立执行卷、镜像及容器可写层",
      };
    else if (path.endsWith("/storage/capabilities")) data = { supported:false, reason:"Windows 目录挂载不支持 XFS 项目配额；Docker Desktop 全局磁盘上限不是实例配额" };
    else if (path.endsWith("/storage/backups")) data = { backups: [] };
    else if (path.endsWith("/storage/cleanup")) data = { candidates: [{ path: "openclaw/logs/gateway.log.1", bytes: 1024 }], bytes: 1024, revision: "storage-reviewed" };
    else if (path.endsWith("/model"))
      data = { models: [model], defaultModel: `${model.pid}/${model.id}` };
    else if (path.endsWith("/failover"))
      data = {
        revision: "models-rev",
        models: [],
        model: { primary: `${model.pid}/${model.id}`, fallbacks: [] },
        imageModel: { primary: "", fallbacks: [] },
      };
    else if (path.endsWith("/feishu"))
      data = { configured: true, appId: "cli_fixture", enabled: true };
    else if (path.endsWith("/feishu-access"))
      data = {
        revision: "access-rev",
        account: "",
        accounts: [],
        effective: {
          dmPolicy: "allowlist",
          allowFrom: ["ou_123"],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
          groupSenderAllowFrom: [],
          requireMention: true,
        },
        groups: [],
      };
    else if (path.endsWith("/agents"))
      data = {
        revision: "agents-rev",
        models: [],
        agents: [{ id: "main", name: "主助手", workspace: "/workspace" }],
        bindings: [],
      };
    else if (path.endsWith("/extensions"))
      data = {
        revision: "extensions-rev",
        agentId: "main",
        agents: [{ id: "main" }],
        skills: [],
        plugins: [],
        isolatedPlugins: [],
        isolatedChannels: [],
      };
    else if (path.endsWith("/workspace/history")) data = { versions: [] };
    else if (
      path.endsWith("/workspace/file") ||
      path.endsWith("/config") ||
      path.endsWith("/env")
    )
      data = file;
    else if (path.endsWith("/workspace"))
      data = { files: [{ path: "AGENTS.md", exists: true }] };
    else if (path.endsWith("/automations")) data = { jobs: [], hasMore: false };
    else if (path.endsWith("/sessions"))
      data = {
        sessions: [
          {
            key: "agent:main:session-1",
            label: "测试会话",
            updatedAtMs: 1793232000000,
          },
        ],
        hasMore: false,
      };
    else if (path.endsWith("/messages"))
      data = { messages: [{ role: "user", text: "历史内容" }] };
    else if (path.endsWith("/logs")) data = { logs: "OpenClaw Gateway ready" };
    else if (path.endsWith("/history")) data = { samples: [] };
    else if (path.endsWith("/token")) data = { token: "fixture-gateway-token" };
    else
      return route.fulfill({
        status: 404,
        json: { error: `Unmocked GET ${path}` },
      });
    return route.fulfill({ json: data });
  });
  await page.goto("/");
  return { mutations, errors };
}
test("production React shell, search, state filters and responsive layout", async ({
  page,
}) => {
  const { errors } = await setup(page);
  await expect(
    page.getByRole("heading", { name: "工作空间", exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-manager-ui="react"]')).toHaveCount(1);
  expect(await page.locator('script[src*="/app.js"]').count()).toBe(0);
  await page.getByRole("button", { name: "未运行", exact: true }).click();
  await expect(
    page
      .getByRole("main")
      .getByRole("heading", { name: "研发助手", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("main").getByRole("heading", { name: "写作助手" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await page.getByPlaceholder("搜索实例…").fill("研发");
  await expect(
    page.getByRole("main").getByRole("heading", { name: "写作助手" }),
  ).toHaveCount(0);
  await page.getByPlaceholder("搜索实例…").fill("");
  await page.getByPlaceholder("搜索实例…").blur();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/workspace-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("button", { name: "部署设备", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "部署设备", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "关闭导航" }),
  ).not.toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/devices-mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test("authentication consumes bootstrap token without persisting it", async ({
  page,
}) => {
  const { errors } = await setup(page, { auth: true });
  await expect(
    page.getByRole("heading", { name: "进入工作空间" }),
  ).toBeVisible();
  await page.getByLabel("管理凭证").fill("fixture-token");
  await page.getByRole("button", { name: "连接工作空间" }).click();
  await expect(
    page.getByRole("heading", { name: "实例工作空间" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
  ).toBe(0);
  expect(errors).toEqual([]);
});

test("sidebar logout returns to login and remains logged out after reload", async ({
  page,
}) => {
  const { mutations, errors } = await setup(page);
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "进入工作空间", exact: true }),
  ).toBeVisible();
  expect(mutations.find((call) => call.path === "/api/session")).toMatchObject({
    method: "DELETE",
    csrf: "fixture-csrf",
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "进入工作空间", exact: true }),
  ).toBeVisible();
  await page.getByLabel("管理凭证", { exact: true }).fill("fixture-token");
  await page.getByRole("button", { name: "连接工作空间" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "工作空间", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("empty workspace creates an instance with recommended resources and CSRF", async ({
  page,
}) => {
  const { mutations, errors } = await setup(page, { empty: true });
  await page.getByRole("button", { name: "开通第一个实例" }).click();
  await page.getByLabel("实例名称", { exact: true }).fill("新助手");
  await page.getByRole("button", { name: "确认开通" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const creation = mutations.find((call) => call.path === "/api/instances");
  expect(creation.body.resources).toEqual({
    cpus: 2,
    memory: "2g",
    pidsLimit: 192,
  });
  expect(creation.csrf).toBe("fixture-csrf");
  expect(errors).toEqual([]);
});
test("instance tabs render without legacy scripts, including escaped content", async ({
  page,
}) => {
  const { errors } = await setup(page);
  await page
    .getByRole("main")
    .getByRole("heading", { name: "研发助手", exact: true })
    .click();
  for (const label of [
    "模型",
    "飞书渠道",
    "Agents",
    "工作区",
    "存储与备份",
    "定时任务",
    "会话",
    "技能与插件",
    "日志",
    "配置",
    "环境变量",
  ]) {
    await page.getByRole("tab", { name: label, exact: true }).click();
    await expect(page.getByRole("tabpanel")).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "正在加载" }),
    ).toHaveCount(0);
  }
  await page.getByRole("tab", { name: "概览", exact: true }).click();
  await page.screenshot({
    path: "test-results/instance-desktop.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test("storage exposes guard boundaries and submits only reviewed cleanup files", async ({ page }) => {
  const { mutations, errors } = await setup(page);
  await page.getByRole("main").getByRole("heading", { name: "研发助手", exact: true }).click();
  await page.getByRole("tab", { name: "存储与备份", exact: true }).click();
  await expect(page.getByText("无法保证瞬时写入不超过额度", { exact: false })).toBeVisible();
  await expect(page.getByText("数据用量已达到告警阈值", { exact: false })).toBeVisible();
  await expect(page.getByText("此宿主或实例暂不支持硬配额", { exact: true })).toBeVisible();
  await expect(page.getByText("当前状态：软保护", { exact: true })).toBeVisible();
  await expect(page.getByText("Windows 目录挂载不支持 XFS 项目配额", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "预览可清理文件" }).click();
  await expect(page.getByText("openclaw/logs/gateway.log.1", { exact: false })).toBeVisible();
  await page.screenshot({ path: "test-results/storage-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "清理预览中的文件" }).click();
  await page.getByRole("button", { name: "确认执行", exact: true }).click();
  expect(mutations.find(call => call.path.endsWith("/storage/cleanup"))).toMatchObject({method:"POST",body:{revision:"storage-reviewed"},csrf:"fixture-csrf"});
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/storage-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("verified hard quota shows inode headroom and bounded drain status", async ({page}) => {
  const {errors}=await setup(page);
  await page.route("**/api/instances/research/storage",route=>route.fulfill({json:{
    bytes:9.1*1024**3,fileCount:500,percent:91,disk:{available:40*1024**3},status:"blocked",hardQuota:true,
    policy:{mode:"hard",limitGiB:10,minFreeGiB:1,warnPercent:80,admissionPercent:90,stopPercent:95,drainSeconds:30,hardInodes:1000},
    quota:{usedInodes:910,hardInodes:1000},blocked:{reason:"数据容量达到停止接单阈值"},
    drain:{phase:"draining",activeCount:1},mounts:[],coverage:"实例目录硬配额",
  }}));
  await page.route("**/api/instances/research/storage/capabilities",route=>route.fulfill({json:{supported:true,backend:"xfs-project"}}));
  await page.getByRole("main").getByRole("heading",{name:"研发助手",exact:true}).click();
  await page.getByRole("tab",{name:"存储与备份",exact:true}).click();
  await expect(page.getByText("当前状态：硬配额已验证并生效",{exact:true})).toBeVisible();
  await expect(page.getByText("保护阶段：等待已接收任务收尾",{exact:false})).toBeVisible();
  await expect(page.getByRole("button",{name:"验证实际硬配额"})).toBeVisible();
  await expect(page.getByText("文件及目录 910 / 1000",{exact:false})).toBeVisible();
  await expect(page.getByRole("button",{name:"解除保护"})).toBeDisabled();
  expect(errors).toEqual([]);
});

test("config edits require preview, preserve revision and guard navigation", async ({
  page,
}) => {
  const { mutations } = await setup(page);
  await page
    .getByRole("main")
    .getByRole("heading", { name: "研发助手", exact: true })
    .click();
  await page.getByRole("tab", { name: "配置", exact: true }).click();
  await page
    .getByRole("textbox", { name: "openclaw.json内容" })
    .fill('{"changed":true}');
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("tab", { name: "日志" }).click();
  await expect(
    page.getByRole("textbox", { name: "openclaw.json内容" }),
  ).toBeVisible();
  expect(mutations).toHaveLength(0);
  await page.getByRole("button", { name: "预览修改" }).click();
  await page.getByRole("button", { name: "确认保存" }).click();
  await expect(page.getByText("未保存", { exact: true })).toHaveCount(0);
  expect(mutations[0]).toMatchObject({
    path: "/api/instances/research/config",
    method: "PUT",
    csrf: "fixture-csrf",
    body: { content: '{"changed":true}', revision: "revision-original" },
  });
});

test("APFS reboot recovery explains running intent and preserves manual stop semantics",async({page})=>{
  const {errors}=await setup(page);
  await page.route("**/api/startup",route=>route.fulfill({json:{
    settings:{managerAutoStart:true,dockerAutoLaunch:true,instancesAutoStart:true,instanceOverrides:{}},revision:"recovery-rev",
    instances:[{id:"research",name:"研发助手",enabled:true,effective:true}],status:{phase:"ready"},
    apfsRecovery:{enabled:true,instances:[{id:"research",desired:"running",phase:"running",detail:"已确认运行"}]},
  }}));
  await page.getByRole("button",{name:"启动与恢复",exact:true}).click();
  await expect(page.getByText("宿主重启后的实例恢复",{exact:true})).toBeVisible();
  await expect(page.getByText("手动停止、存储保护、迁移中或状态不明的实例保持停止",{exact:false})).toBeVisible();
  await expect(page.getByText("已记录运行意图",{exact:false})).toBeVisible();
  expect(errors).toEqual([]);
});
test("streaming chat accepts final line without newline and renders text safely", async ({
  page,
}) => {
  const { mutations, errors } = await setup(page);
  await page
    .getByRole("main")
    .getByRole("heading", { name: "研发助手", exact: true })
    .click();
  await page.getByRole("tab", { name: "对话", exact: true }).click();
  await page.getByLabel("消息内容").fill("你好");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("你好，世界", { exact: true })).toBeVisible();
  expect(mutations[0].body).toMatchObject({
    agentId: "main",
    message: "你好",
    attachments: [],
  });
  expect(errors).toEqual([]);
});
test("SSH fingerprint is invalidated after destination changes", async ({
  page,
}) => {
  const { mutations } = await setup(page);
  await page.getByRole("button", { name: "部署设备", exact: true }).click();
  await page.getByRole("button", { name: "连接远程设备", exact: true }).click();
  await page.getByLabel("主机地址", { exact: true }).fill("example.com");
  await page.getByRole("button", { name: "获取主机指纹" }).click();
  await page.getByLabel("已通过可信渠道核对，指纹一致").check();
  await expect(
    page.getByRole("button", { name: "连接设备", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("主机地址", { exact: true }).fill("other.example.com");
  await expect(
    page.getByLabel("已通过可信渠道核对，指纹一致"),
  ).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "连接设备", exact: true }),
  ).toBeDisabled();
  expect(
    mutations.filter((call) => call.path === "/api/connections"),
  ).toHaveLength(0);
});
test("plugin review requires typed spec and renewed consent for capabilities", async ({
  page,
}) => {
  const { mutations } = await setup(page);
  await page
    .getByRole("main")
    .getByRole("heading", { name: "研发助手", exact: true })
    .click();
  await page.getByRole("tab", { name: "技能与插件" }).click();
  await page.getByLabel("固定版本插件包").fill("@scope/example@1.2.3");
  await page.getByRole("button", { name: "审查插件" }).click();
  await page
    .getByLabel("输入完整包名与固定版本确认")
    .fill("@scope/example@1.2.3");
  await page.getByLabel("我已阅读报告，并同意本次审查中声明的权限").check();
  await page.getByRole("button", { name: "按审查结果安装" }).click();
  await expect(
    page.getByRole("button", { name: "按审查结果安装" }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("我已阅读报告，并同意本次审查中声明的权限"),
  ).not.toBeChecked();
  const install = mutations.find((call) =>
    call.path.endsWith("/plugin/install"),
  );
  expect(install.body).toMatchObject({
    reviewToken: "source-token",
    confirmSpec: "@scope/example@1.2.3",
    revision: "extensions-rev",
  });
});
test("cleanup submits only a reviewed preview and startup sends null to clear override", async ({
  page,
}) => {
  const { mutations, errors } = await setup(page);
  await page.getByRole("button", { name: "镜像仓库", exact: true }).click();
  await expect(page.getByRole("button", { name: "按预览清理" })).toHaveCount(0);
  await page.getByRole("button", { name: "生成清理预览" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "按预览清理" }).click();
  await expect
    .poll(
      () => mutations.find((call) => call.path === "/api/images/cleanup")?.body,
    )
    .toEqual({ previewId: "reviewed-preview" });
  await page.getByRole("button", { name: "启动与恢复", exact: true }).click();
  await page.getByLabel("研发助手 的自启策略").selectOption("");
  await page.getByRole("button", { name: "保存设置" }).click();
  expect(
    mutations.find((call) => call.path === "/api/startup").body
      .instanceOverrides,
  ).toEqual({ research: null });
  expect(errors).toEqual([]);
});

test("terminal sends binary input and closes its socket on tab change", async ({
  page,
}) => {
  const received = [];
  let closed = 0;
  await page.routeWebSocket("**/api/instances/*/terminal", (socket) => {
    socket.onMessage((message) => received.push(message));
    socket.onClose(() => {
      closed++;
    });
    socket.send(Buffer.from("fixture shell ready\r\n"));
  });
  const { errors } = await setup(page);
  await page
    .getByRole("main")
    .getByRole("heading", { name: "研发助手", exact: true })
    .click();
  await page.getByRole("tab", { name: "终端", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "已连接" }),
  ).toBeVisible();
  const input = page.locator(".xterm-helper-textarea");
  await input.focus();
  await page.keyboard.type("pwd");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => received.filter(Buffer.isBuffer).length)
    .toBeGreaterThan(0);
  await page.getByRole("tab", { name: "概览", exact: true }).click();
  await expect.poll(() => closed).toBe(1);
  expect(errors).toEqual([]);
});

test("model copy, Feishu access and session batch operations retain API contracts", async ({
  page,
}) => {
  const { mutations, errors } = await setup(page);
  await page
    .getByRole("main")
    .getByRole("heading", { name: "研发助手", exact: true })
    .click();
  await page.getByRole("tab", { name: "模型", exact: true }).click();
  await page.getByRole("button", { name: "添加模型", exact: true }).click();
  await page.getByLabel("模型 ID", { exact: true }).fill("second-model");
  await page
    .getByLabel("复用已有模型凭据", { exact: true })
    .selectOption("example-model");
  await page.getByLabel("输入能力", { exact: true }).selectOption("text");
  await page.getByLabel("上下文长度", { exact: true }).fill("128000");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    mutations.find((call) => call.path.endsWith("/model")).body,
  ).toMatchObject({
    copyKeyFrom: "example-model",
    input: ["text"],
    contextWindow: 128000,
  });
  await page.getByRole("tab", { name: "飞书渠道", exact: true }).click();
  await page.getByRole("button", { name: "编辑访问规则" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    mutations.find((call) => call.path.endsWith("/feishu-access")).body,
  ).toMatchObject({
    revision: "access-rev",
    patch: {
      dmPolicy: "allowlist",
      allowFrom: ["ou_123"],
      requireMention: true,
    },
  });
  await page.getByRole("tab", { name: "会话", exact: true }).click();
  await page.getByLabel("选择当前列表的所有会话").check();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "批量归档" }).click();
  await expect
    .poll(
      () =>
        mutations.find((call) => call.path.endsWith("/sessions/archive"))?.body,
    )
    .toEqual({ keys: ["agent:main:session-1"] });
  expect(errors).toEqual([]);
});
