import { useState } from "react";
import { Plus, RefreshCw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Card, CardHeader, CardContent, CardTitle } from "@/components/ui/card";
import {
  Check,
  Empty,
  ErrorNotice,
  Field,
  FormDialog,
  JsonView,
  Resource,
  Select,
} from "@/components/shared";
import { canNavigate, useAction, useDirty, useResource } from "@/lib/hooks";
import { request } from "@/lib/api";
import { date, instancePath as ip } from "@/lib/utils";

export function Models({ id }) {
  const resource = useResource(ip(id, "/model"));
  const [edit, setEdit] = useState(null);
  const [result, setResult] = useState(null);
  const { busy, run } = useAction();
  const fields = [
    {
      key: "model",
      label: "模型 ID",
      required: true,
      wide: true,
      placeholder: "例如：gpt-4.1",
    },
    {
      key: "baseUrl",
      label: "API 地址",
      type: "url",
      wide: true,
      placeholder: "https://api.openai.com/v1",
    },
    {
      key: "apiKey",
      label: "API Key",
      type: "password",
      wide: true,
      hint: "编辑时留空保留已保存的凭据。",
    },
    {
      key: "copyKeyFrom",
      label: "复用已有模型凭据",
      wide: true,
      options: [
        { value: "", label: "不复用" },
        ...(resource.data?.models || []).map((m) => ({
          value: m.id,
          label: m.id,
        })),
      ],
    },
    {
      key: "input",
      label: "输入能力",
      options: [
        { value: "auto", label: "自动检测" },
        { value: "text", label: "仅文本" },
        { value: "text,image", label: "文本 + 图像" },
      ],
    },
    { key: "contextWindow", label: "上下文长度", placeholder: "auto" },
    { key: "setDefault", label: "设为默认模型", type: "checkbox", wide: true },
  ];
  const mutation = (path, method, body) =>
    run(async () => {
      const data = await request(ip(id, path), { method, body });
      resource.reload();
      return data;
    }, "已更新模型");
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-medium">模型</h2>
          <p className="mt-2 text-xs text-muted-foreground">
            连接供应商，设置默认模型与故障切换策略。
          </p>
        </div>
        <Button size="sm" onClick={() => setEdit({})}>
          <Plus />
          添加模型
        </Button>
      </div>
      <Resource resource={resource}>
        {(data) => (
          <>
            {!data.models.length ? (
              <Empty
                title="连接第一个模型"
                description="添加兼容的 API 地址和凭据，即可开始对话。"
              />
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                {data.models.map((model) => (
                  <Card key={`${model.pid}/${model.id}`}>
                    <CardHeader>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <CardTitle>{model.id}</CardTitle>
                        {data.defaultModel === `${model.pid}/${model.id}` && (
                          <span className="rounded border border-brand/25 bg-brand/8 px-2 py-1 text-[10px] text-brand-ink">
                            默认模型
                          </span>
                        )}
                      </div>
                      <p className="break-all pt-2 font-mono text-[11px] text-muted-foreground">
                        {model.baseUrl}
                      </p>
                    </CardHeader>
                    <CardContent>
                      <div className="mb-5 flex flex-wrap gap-4 text-[11px] text-muted-foreground">
                        <span>{model.input?.join(" + ") || "能力未指定"}</span>
                        <span>
                          {model.contextWindow?.toLocaleString() || "—"} tokens
                        </span>
                        <span>{model.apiKeyMasked || "未配置凭据"}</span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setEdit(model)}
                        >
                          编辑
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            run(async () =>
                              setResult(
                                await request(ip(id, "/model/test"), {
                                  method: "POST",
                                  body: { model: model.id },
                                }),
                              ),
                            )
                          }
                        >
                          测试连接
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={
                            busy ||
                            data.defaultModel === `${model.pid}/${model.id}`
                          }
                          onClick={() =>
                            mutation("/model/default", "PUT", {
                              model: model.id,
                            })
                          }
                        >
                          设为默认
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={busy}
                          onClick={() => {
                            if (confirm(`删除模型 ${model.id}？`))
                              mutation(
                                `/model/${encodeURIComponent(model.id)}`,
                                "DELETE",
                                {},
                              );
                          }}
                        >
                          删除
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
            {result && <JsonView value={result} />}
            <Failover id={id} />
          </>
        )}
      </Resource>
      {edit && (
        <FormDialog
          title={edit.id ? "编辑模型" : "添加模型"}
          fields={fields}
          initial={{
            model: edit.id || "",
            baseUrl: edit.baseUrl || "",
            input: edit.input?.join(",") || "auto",
            contextWindow: edit.contextWindow || "auto",
            apiKey: "",
            setDefault: !edit.id,
            copyKeyFrom: "",
          }}
          onClose={() => setEdit(null)}
          submit={async (values) => {
            const body = {
              ...values,
              input: values.input === "auto" ? "auto" : values.input.split(","),
              contextWindow:
                values.contextWindow === "auto"
                  ? "auto"
                  : Number(values.contextWindow),
            };
            if (!body.apiKey) delete body.apiKey;
            if (!body.copyKeyFrom) delete body.copyKeyFrom;
            await request(
              ip(
                id,
                `/model${edit.id ? `/${encodeURIComponent(edit.id)}` : ""}`,
              ),
              { method: "PUT", body },
            );
            resource.reload();
          }}
        >
          {(values, set) => (
            <Button
              variant="outline"
              type="button"
              size="sm"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const detected = await request(ip(id, "/model/detect"), {
                    method: "POST",
                    body: values,
                  });
                  set((v) => ({
                    ...v,
                    input: detected.input?.join(",") || v.input,
                    contextWindow: detected.contextWindow || v.contextWindow,
                  }));
                }, "模型能力已检测")
              }
            >
              自动检测能力
            </Button>
          )}
        </FormDialog>
      )}
    </div>
  );
}
function Failover({ id }) {
  const resource = useResource(ip(id, "/failover"));
  const [editing, setEditing] = useState(false);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>故障切换</CardTitle>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEditing(true)}
          disabled={!resource.data}
        >
          编辑策略
        </Button>
      </CardHeader>
      <CardContent>
        {resource.error ? (
          <ErrorNotice retry={resource.reload}>{resource.error}</ErrorNotice>
        ) : (
          <p className="text-xs text-muted-foreground">
            主模型：{resource.data?.model.primary || "未设置"} · 备用：
            {resource.data?.model.fallbacks?.join(" → ") || "未设置"}
          </p>
        )}
      </CardContent>
      {editing && resource.data && (
        <FormDialog
          title="模型故障切换"
          description="填写 provider/model 完整引用；多个备用模型以逗号分隔，按顺序尝试。"
          initial={{
            primary: resource.data.model.primary,
            fallbacks: resource.data.model.fallbacks.join(","),
            imagePrimary: resource.data.imageModel.primary,
            imageFallbacks: resource.data.imageModel.fallbacks.join(","),
          }}
          fields={[
            { key: "primary", label: "主模型", wide: true },
            { key: "fallbacks", label: "备用模型", wide: true },
            { key: "imagePrimary", label: "图像主模型", wide: true },
            { key: "imageFallbacks", label: "图像备用模型", wide: true },
          ]}
          onClose={() => setEditing(false)}
          submit={async (v) => {
            await request(ip(id, "/failover"), {
              method: "PUT",
              body: {
                revision: resource.data.revision,
                model: {
                  primary: v.primary,
                  fallbacks: v.fallbacks
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                },
                imageModel: v.imagePrimary
                  ? {
                      primary: v.imagePrimary,
                      fallbacks: v.imageFallbacks
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    }
                  : null,
              },
            });
            resource.reload();
          }}
        />
      )}
    </Card>
  );
}
export function Feishu({ id }) {
  const resource = useResource(ip(id, "/feishu"));
  const [editing, setEditing] = useState(false);
  const [result, setResult] = useState(null);
  const { busy, run } = useAction();
  return (
    <div className="space-y-6">
      <Resource resource={resource}>
        {(data) => (
          <Card>
            <CardHeader>
              <CardTitle>飞书渠道</CardTitle>
              <p className="text-xs text-muted-foreground">
                {data.configured
                  ? "已配置飞书应用"
                  : "连接飞书机器人，在消息中协作。"}
              </p>
            </CardHeader>
            <CardContent>
              <p className="mb-4 font-mono text-xs text-muted-foreground">
                {data.appId || "尚未配置 App ID"}
                {data.isolated ? " · 独立适配器" : ""}
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => setEditing(true)}
                  disabled={data.isolated}
                >
                  配置凭据
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    run(async () =>
                      setResult(
                        await request(ip(id, "/feishu/test"), {
                          method: "POST",
                          body: {},
                        }),
                      ),
                    )
                  }
                >
                  测试连接
                </Button>
              </div>
              {result && (
                <div className="mt-4">
                  <JsonView value={result} />
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </Resource>
      <Access id={id} />
      {editing && (
        <FormDialog
          title="飞书应用凭据"
          description="保存后实例将重启以应用渠道配置。"
          initial={{
            appId: resource.data?.appId || "",
            enabled: resource.data?.enabled !== false,
            appSecret: "",
          }}
          fields={[
            { key: "appId", label: "App ID", required: true, wide: true },
            {
              key: "appSecret",
              label: "App Secret",
              type: "password",
              wide: true,
              hint: "留空保留已保存的凭据。",
            },
            { key: "enabled", label: "启用飞书", type: "checkbox", wide: true },
          ]}
          onClose={() => setEditing(false)}
          submit={async (v) => {
            await request(ip(id, "/feishu"), { method: "PUT", body: v });
            resource.reload();
          }}
        />
      )}
    </div>
  );
}
function Access({ id }) {
  const [account, setAccount] = useState("");
  const resource = useResource(
    ip(id, `/feishu-access?account=${encodeURIComponent(account)}`),
  );
  const [edit, setEdit] = useState(null);
  const [pairing, setPairing] = useState(null);
  const [code, setCode] = useState("");
  const { busy, run } = useAction();
  const list = (value) =>
    value
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-4">
        <CardTitle>飞书访问规则</CardTitle>
        <Select
          className="w-44"
          value={account}
          aria-label="飞书账号"
          onChange={(e) => setAccount(e.target.value)}
        >
          <option value="">默认账号</option>
          {resource.data?.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </CardHeader>
      <CardContent>
        <Resource resource={resource}>
          {(data) => (
            <div className="space-y-5">
              <div className="grid gap-4 text-xs sm:grid-cols-2">
                <p className="text-muted-foreground">
                  私聊策略：
                  <span className="text-foreground">
                    {data.effective.dmPolicy}
                  </span>
                </p>
                <p className="text-muted-foreground">
                  群聊策略：
                  <span className="text-foreground">
                    {data.effective.groupPolicy}
                  </span>
                </p>
                <p className="break-all text-muted-foreground">
                  允许用户：{data.effective.allowFrom.join(", ") || "未设置"}
                </p>
                <p className="text-muted-foreground">
                  回复要求：
                  {data.effective.requireMention ? "需 @ 提及" : "无需提及"}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setEdit({
                      type: "access",
                      ...data.effective,
                      allowFrom: data.effective.allowFrom.join(","),
                      groupAllowFrom: data.effective.groupAllowFrom.join(","),
                      groupSenderAllowFrom:
                        data.effective.groupSenderAllowFrom.join(","),
                    })
                  }
                >
                  编辑访问规则
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setEdit({
                      type: "group",
                      groupId: "",
                      enabled: "true",
                      requireMention: "true",
                    })
                  }
                >
                  添加群规则
                </Button>
              </div>
              {data.groups.map((group) => (
                <div
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                  key={group.id}
                >
                  <span className="font-mono text-xs text-muted-foreground">
                    {group.id} · {group.enabled === false ? "停用" : "启用"} ·{" "}
                    {group.requireMention === false
                      ? "无需提及"
                      : "需提及 / 继承"}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setEdit({
                        type: "group",
                        groupId: group.id,
                        enabled:
                          group.enabled === undefined
                            ? ""
                            : String(group.enabled),
                        requireMention:
                          group.requireMention === undefined
                            ? ""
                            : String(group.requireMention),
                      })
                    }
                  >
                    编辑
                  </Button>
                </div>
              ))}
              {!data.isolated && (
                <div className="space-y-3 border-t border-border pt-5">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      run(async () =>
                        setPairing(
                          await request(
                            ip(
                              id,
                              `/feishu-access/pairing?account=${encodeURIComponent(account)}`,
                            ),
                          ),
                        ),
                      )
                    }
                  >
                    读取待配对用户
                  </Button>
                  {pairing && <JsonView value={pairing} />}
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      run(async () => {
                        await request(
                          ip(id, "/feishu-access/pairing/approve"),
                          { method: "POST", body: { account, code } },
                        );
                        setCode("");
                        setPairing(null);
                      }, "配对已批准");
                    }}
                  >
                    <Input
                      aria-label="飞书配对码"
                      placeholder="输入配对码"
                      required
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                    />
                    <Button variant="outline" disabled={busy}>
                      批准配对
                    </Button>
                  </form>
                </div>
              )}
              {edit && (
                <FormDialog
                  title={
                    edit.type === "group" ? "群聊覆盖规则" : "飞书访问规则"
                  }
                  initial={edit}
                  fields={
                    edit.type === "group"
                      ? [
                          {
                            key: "groupId",
                            label: "群 ID",
                            required: true,
                            wide: true,
                            hint: data.isolated
                              ? "填写具体 oc_ 群 ID。"
                              : "填写 oc_ 群 ID，或 * 作为默认规则。",
                          },
                          ...["enabled", "requireMention"].map((key) => ({
                            key,
                            label: key === "enabled" ? "启用群聊" : "要求提及",
                            options: [
                              { value: "", label: "继承默认规则" },
                              { value: "true", label: "是" },
                              { value: "false", label: "否" },
                            ],
                          })),
                        ]
                      : [
                          {
                            key: "dmPolicy",
                            label: "私聊策略",
                            options: [
                              "pairing",
                              "allowlist",
                              "open",
                              "disabled",
                            ],
                          },
                          {
                            key: "groupPolicy",
                            label: "群聊策略",
                            options: ["allowlist", "open", "disabled"],
                          },
                          ...[
                            ["allowFrom", "用户白名单"],
                            ["groupAllowFrom", "群白名单"],
                            ["groupSenderAllowFrom", "群发言人白名单"],
                          ].map(([key, label]) => ({
                            key,
                            label,
                            wide: true,
                            hint: "多个 ID 用逗号或换行分隔。",
                          })),
                          {
                            key: "requireMention",
                            label: "群聊回复要求 @ 提及",
                            type: "checkbox",
                            wide: true,
                          },
                        ]
                  }
                  onClose={() => setEdit(null)}
                  submit={async (v) => {
                    const group = edit.type === "group";
                    const patch = group
                      ? {
                          enabled:
                            v.enabled === "" ? null : v.enabled === "true",
                          requireMention:
                            v.requireMention === ""
                              ? null
                              : v.requireMention === "true",
                        }
                      : {
                          dmPolicy: v.dmPolicy,
                          groupPolicy: v.groupPolicy,
                          allowFrom: list(v.allowFrom),
                          groupAllowFrom: list(v.groupAllowFrom),
                          groupSenderAllowFrom: list(v.groupSenderAllowFrom),
                          requireMention: v.requireMention,
                        };
                    await request(
                      ip(id, `/feishu-access${group ? "/group" : ""}`),
                      {
                        method: "PUT",
                        body: {
                          revision: data.revision,
                          account: data.account || account,
                          ...(group ? { groupId: v.groupId } : {}),
                          patch,
                        },
                      },
                    );
                    resource.reload();
                  }}
                />
              )}
            </div>
          )}
        </Resource>
      </CardContent>
    </Card>
  );
}

export function FileEditor({ path, title, extra = {}, afterSave }) {
  const resource = useResource(path);
  return (
    <Resource resource={resource}>
      {(data) => (
        <Editor
          key={`${path}:${data.revision}`}
          data={data}
          title={title}
          path={path}
          extra={extra}
          reload={resource.reload}
          afterSave={afterSave}
        />
      )}
    </Resource>
  );
}
function Editor({ data, title, path, extra, reload, afterSave }) {
  const [value, setValue] = useState(data.content || "");
  const [review, setReview] = useState(false);
  const { busy, run } = useAction();
  const dirty = value !== (data.content || "");
  useDirty(dirty);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-mono text-sm">
          {title}
          {dirty && <span className="ml-3 text-xs text-warning">未保存</span>}
        </h2>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (!dirty || confirm("放弃修改并重新加载？")) reload();
            }}
          >
            <RefreshCw />
            重新加载
          </Button>
          <Button
            size="sm"
            disabled={!dirty || busy}
            onClick={() => setReview(true)}
          >
            预览修改
          </Button>
        </div>
      </div>
      <Textarea
        className="min-h-[400px] font-mono text-xs leading-6"
        spellCheck={false}
        aria-label={`${title}内容`}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setReview(false);
        }}
      />
      {review && (
        <Card>
          <CardHeader>
            <CardTitle>确认以下修改</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-4 grid gap-3 md:grid-cols-2">
              <div>
                <p className="mb-2 text-xs text-muted-foreground">当前已保存</p>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded border border-destructive/15 bg-destructive/5 p-3 text-xs">
                  {data.content || "（空文件）"}
                </pre>
              </div>
              <div>
                <p className="mb-2 text-xs text-muted-foreground">待保存内容</p>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded border border-success/15 bg-success/5 p-3 text-xs">
                  {value || "（空文件）"}
                </pre>
              </div>
            </div>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await request(path.split("?")[0], {
                    method: "PUT",
                    body: { content: value, revision: data.revision, ...extra },
                  });
                  setReview(false);
                  reload();
                  afterSave?.();
                }, "内容已保存")
              }
            >
              <Save />
              确认保存
            </Button>
          </CardContent>
        </Card>
      )}
      <p className="text-xs leading-6 text-muted-foreground">
        保存前预览差异；服务端会检查版本，避免覆盖其他操作。凭据占位内容应保留原样。
      </p>
    </div>
  );
}
export function Workspace({ id }) {
  const files = useResource(ip(id, "/workspace"));
  const [path, setPath] = useState("AGENTS.md");
  const [newPath, setNewPath] = useState("");
  const history = useResource(
    ip(id, `/workspace/history?path=${encodeURIComponent(path)}`),
  );
  const [version, setVersion] = useState(null);
  const [generation, setGeneration] = useState(0);
  const { busy, run } = useAction();
  return (
    <div className="space-y-5">
      <div className="grid items-end gap-3 sm:grid-cols-2">
        <Field label="工作区文件">
          <Select
            value={path}
            onChange={(e) => {
              if (canNavigate()) {
                setPath(e.target.value);
                setVersion(null);
              }
            }}
          >
            {(files.data?.files || [{ path: "AGENTS.md" }]).map((file) => (
              <option key={file.path} value={file.path}>
                {file.path}
                {!file.exists ? " · 未创建" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (newPath && canNavigate()) {
              setPath(newPath);
              setVersion(null);
            }
          }}
        >
          <Input
            aria-label="新建记忆文件路径"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            placeholder="memory/notes.md"
          />
          <Button variant="outline" type="submit">
            打开 / 新建
          </Button>
        </form>
      </div>
      {files.error && (
        <ErrorNotice retry={files.reload}>{files.error}</ErrorNotice>
      )}
      <FileEditor
        key={`${path}:${generation}`}
        path={ip(id, `/workspace/file?path=${encodeURIComponent(path)}`)}
        title={path}
        extra={{ path }}
        afterSave={() => {
          files.reload();
          history.reload();
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Select
          className="max-w-sm"
          aria-label="历史版本"
          defaultValue=""
          disabled={busy}
          onChange={(e) => {
            if (e.target.value)
              run(async () => {
                const selected = e.target.value;
                const current = await request(
                  ip(id, `/workspace/file?path=${encodeURIComponent(path)}`),
                );
                const saved = await request(
                  ip(
                    id,
                    `/workspace/version?path=${encodeURIComponent(path)}&version=${encodeURIComponent(selected)}`,
                  ),
                );
                setVersion({ ...saved, baseRevision: current.revision });
              });
          }}
        >
          <option value="">选择历史版本预览</option>
          {history.data?.versions.map((v) => (
            <option key={v.version} value={v.version}>
              {date(v.savedAt)}
            </option>
          ))}
        </Select>
      </div>
      {version && (
        <Card>
          <CardHeader>
            <CardTitle>历史版本预览</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="mb-4 max-h-80 overflow-auto whitespace-pre-wrap text-xs leading-6 text-muted-foreground">
              {version.content}
            </pre>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  if (!canNavigate()) return;
                  await request(ip(id, "/workspace/file"), {
                    method: "PUT",
                    body: {
                      path,
                      content: version.content,
                      revision: version.baseRevision,
                    },
                  });
                  setVersion(null);
                  setGeneration((value) => value + 1);
                  history.reload();
                }, "历史版本已恢复")
              }
            >
              恢复此版本
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function Automations({ id }) {
  const [offset, setOffset] = useState(0);
  const resource = useResource(ip(id, `/automations?offset=${offset}`));
  const [edit, setEdit] = useState(null);
  const [runs, setRuns] = useState(null);
  const { busy, run } = useAction();
  const mutate = (path, method, body) =>
    run(async () => {
      await request(ip(id, path), { method, body });
      resource.reload();
    }, "任务已更新");
  const open = (job) =>
    setEdit({
      id: job?.id,
      revision: job?.managerRevision,
      name: job?.name || "",
      message: job?.payload?.message || "",
      kind: job?.schedule?.kind || "cron",
      time:
        job?.schedule?.expr ||
        (job?.schedule?.everyMs
          ? job.schedule.everyMs / 60000
          : job?.schedule?.at) ||
        "0 9 * * *",
      tz: job?.schedule?.tz || "Asia/Shanghai",
      model: job?.payload?.model || "",
      agentId: job?.agentId || "main",
      enabled: job?.enabled || false,
      channel: job?.delivery?.channel || "",
      to: job?.delivery?.to || "",
      accountId: job?.delivery?.accountId || "",
    });
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium">定时任务</h2>
        <Button size="sm" onClick={() => open()}>
          <Plus />
          新建任务
        </Button>
      </div>
      <Resource resource={resource}>
        {(data) => (
          <>
            {!data.jobs?.length ? (
              <Empty
                title="暂无定时任务"
                description="按计划让 Agent 执行工作。新建任务默认不启用。"
              />
            ) : (
              data.jobs.map((job) => (
                <Card key={job.id}>
                  <CardHeader>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <CardTitle>{job.name}</CardTitle>
                      <span className="text-xs text-muted-foreground">
                        {job.enabled ? "已启用" : "已停用"} ·{" "}
                        {job.schedule?.expr ||
                          (job.schedule?.everyMs
                            ? `每 ${job.schedule.everyMs / 60000} 分钟`
                            : job.schedule?.at)}
                      </span>
                    </div>
                    <p className="line-clamp-2 pt-2 text-xs leading-6 text-muted-foreground">
                      {job.payload?.message}
                    </p>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!job.editable}
                      onClick={() => open(job)}
                    >
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !job.editable}
                      onClick={() =>
                        mutate(
                          `/automations/${encodeURIComponent(job.id)}/run`,
                          "POST",
                          {},
                        )
                      }
                    >
                      立即执行
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        run(async () =>
                          setRuns(
                            await request(
                              ip(
                                id,
                                `/automations/${encodeURIComponent(job.id)}/runs`,
                              ),
                            ),
                          ),
                        )
                      }
                    >
                      执行记录
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy || !job.editable}
                      onClick={() => {
                        if (confirm(`删除任务「${job.name}」？`))
                          mutate(
                            `/automations/${encodeURIComponent(job.id)}`,
                            "DELETE",
                            {},
                          );
                      }}
                    >
                      删除
                    </Button>
                  </CardContent>
                </Card>
              ))
            )}
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!offset}
                onClick={() => setOffset(Math.max(0, offset - 100))}
              >
                上一页
              </Button>
              <Button size="sm" variant="outline" onClick={resource.reload}>
                刷新
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!data.hasMore}
                onClick={() => setOffset(offset + 100)}
              >
                下一页
              </Button>
            </div>
          </>
        )}
      </Resource>
      {runs && <JsonView value={runs} />}
      {edit && (
        <FormDialog
          title={edit.id ? "编辑定时任务" : "新建定时任务"}
          initial={edit}
          fields={[
            { key: "name", label: "任务名称", required: true, wide: true },
            {
              key: "message",
              label: "任务内容",
              type: "textarea",
              required: true,
              wide: true,
            },
            {
              key: "kind",
              label: "执行方式",
              options: [
                { value: "cron", label: "Cron 周期" },
                { value: "every", label: "固定间隔（分钟）" },
                { value: "at", label: "单次执行（ISO 时间）" },
              ],
            },
            { key: "time", label: "执行时间 / 间隔", required: true },
            { key: "tz", label: "时区" },
            { key: "agentId", label: "Agent ID", required: true },
            { key: "model", label: "模型（留空使用默认）", wide: true },
            { key: "channel", label: "推送渠道（留空不推送）" },
            { key: "to", label: "接收目标" },
            { key: "accountId", label: "渠道账号（可选）" },
            { key: "enabled", label: "启用任务", type: "checkbox" },
          ]}
          onClose={() => setEdit(null)}
          submit={async (v) => {
            const schedule =
              v.kind === "cron"
                ? { kind: "cron", expr: v.time, tz: v.tz }
                : v.kind === "every"
                  ? { kind: "every", everyMs: Number(v.time) * 60000 }
                  : { kind: "at", at: v.time };
            await request(
              ip(
                id,
                `/automations${edit.id ? `/${encodeURIComponent(edit.id)}` : ""}`,
              ),
              {
                method: edit.id ? "PUT" : "POST",
                body: {
                  name: v.name,
                  message: v.message,
                  enabled: v.enabled,
                  agentId: v.agentId,
                  model: v.model,
                  revision: edit.revision,
                  schedule,
                  delivery: v.channel
                    ? {
                        mode: "announce",
                        channel: v.channel,
                        to: v.to,
                        ...(v.accountId ? { accountId: v.accountId } : {}),
                      }
                    : { mode: "none" },
                },
              },
            );
            resource.reload();
          }}
        />
      )}
    </div>
  );
}
export function Sessions({ id }) {
  const [all, setAll] = useState(false);
  const [checked, setChecked] = useState([]);
  const resource = useResource(ip(id, `/sessions?limit=${all ? "all" : 100}`));
  const [selected, setSelected] = useState("");
  const transcript = useResource(
    selected
      ? ip(id, `/sessions/${encodeURIComponent(selected)}/messages`)
      : null,
  );
  const [message, setMessage] = useState("");
  const { busy, run } = useAction();
  useDirty(!!message);
  const action = (kind, key) =>
    run(async () => {
      await request(ip(id, `/sessions/${kind}`), {
        method: "POST",
        body:
          kind === "compact"
            ? { key }
            : { keys: Array.isArray(key) ? key : [key] },
      });
      setChecked([]);
      if (kind === "delete" || kind === "archive") setSelected("");
      resource.reload();
      transcript.reload();
    }, "操作已完成");
  return (
    <div className="grid gap-5 xl:grid-cols-[300px_1fr]">
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium">实例会话</h2>
          <Button variant="ghost" size="sm" onClick={resource.reload}>
            刷新
          </Button>
        </div>
        <Resource resource={resource}>
          {(data) => (
            <>
              {data.sessions.length > 0 && (
                <div className="mb-4 space-y-3">
                  <Check
                    label="选择当前列表的所有会话"
                    checked={checked.length === data.sessions.length}
                    onChange={(e) =>
                      setChecked(
                        e.target.checked
                          ? data.sessions.map((row) => row.key)
                          : [],
                      )
                    }
                  />
                  {checked.length > 0 && (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          if (
                            canNavigate() &&
                            confirm(`归档所选 ${checked.length} 个会话？`)
                          )
                            action("archive", checked);
                        }}
                      >
                        批量归档
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => {
                          if (
                            canNavigate() &&
                            confirm(`删除所选 ${checked.length} 个会话？`)
                          )
                            action("delete", checked);
                        }}
                      >
                        批量删除
                      </Button>
                    </div>
                  )}
                </div>
              )}
              {!data.sessions.length && <Empty title="暂无会话" />}
              {data.sessions.map((row) => (
                <div key={row.key} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-brand"
                    aria-label={`选择会话 ${row.label || row.key}`}
                    checked={checked.includes(row.key)}
                    onChange={(e) =>
                      setChecked((previous) =>
                        e.target.checked
                          ? [...previous, row.key]
                          : previous.filter((key) => key !== row.key),
                      )
                    }
                  />
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (canNavigate()) setSelected(row.key);
                    }}
                    className={`mb-2 min-w-0 flex-1 rounded-lg border border-border p-4 text-left ${selected === row.key ? "bg-accent" : "bg-card hover:bg-accent/50"}`}
                  >
                    <p className="truncate text-xs">
                      {row.label || row.displayName || row.key}
                    </p>
                    <p className="mt-2 text-[10px] text-muted-foreground">
                      {date(row.updatedAtMs)} · {row.totalTokens || 0} tokens
                    </p>
                  </button>
                </div>
              ))}
              {data.hasMore && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAll(true)}
                >
                  加载全部会话
                </Button>
              )}
            </>
          )}
        </Resource>
      </div>
      <div className="min-w-0">
        {!selected ? (
          <Empty
            title="选择一个会话"
            description="查看历史消息，或继续之前的工作。"
          />
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => action("compact", selected)}
              >
                压缩上下文
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (confirm("归档该会话？")) action("archive", selected);
                }}
              >
                归档
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  if (confirm("删除该会话？")) action("delete", selected);
                }}
              >
                删除
              </Button>
            </div>
            <Resource resource={transcript}>
              {(data) => (
                <div className="max-h-[460px] overflow-y-auto rounded-lg border border-border bg-card p-4">
                  {data.messages.map((row, index) => (
                    <div className="mb-5" key={index}>
                      <p className="mb-1 text-[10px] uppercase text-brand-ink">
                        {row.role}
                      </p>
                      <p className="whitespace-pre-wrap break-words text-xs leading-6 text-muted-foreground">
                        {row.text ||
                          (typeof row.content === "string"
                            ? row.content
                            : JSON.stringify(row.content))}
                      </p>
                      {row.toolCalls?.length > 0 && (
                        <JsonView value={row.toolCalls} />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Resource>
            <form
              className="mt-4 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  await request(
                    ip(
                      id,
                      `/sessions/${encodeURIComponent(selected)}/messages`,
                    ),
                    { method: "POST", body: { message } },
                  );
                  setMessage("");
                  transcript.reload();
                }, "消息已发送");
              }}
            >
              <Input
                aria-label="继续会话的消息"
                placeholder="继续这个会话…"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                required
              />
              <Button disabled={busy}>发送</Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
export function AdvancedResource({
  id,
  suffix,
  title,
  description,
  transform,
}) {
  const resource = useResource(ip(id, suffix));
  const [edit, setEdit] = useState(null);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{title}</CardTitle>
        <Button
          size="sm"
          variant="outline"
          disabled={!resource.data}
          onClick={() =>
            setEdit(
              JSON.stringify(
                transform ? transform(resource.data) : resource.data,
                null,
                2,
              ),
            )
          }
        >
          编辑
        </Button>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-xs leading-6 text-muted-foreground">
          {description}
        </p>
        <Resource resource={resource}>
          {(data) => <JsonView value={data} />}
        </Resource>
      </CardContent>
      {edit !== null && (
        <FormDialog
          title={title}
          description={description}
          initial={{ content: edit }}
          fields={[
            {
              key: "content",
              label: "高级配置（JSON）",
              type: "textarea",
              required: true,
              wide: true,
            },
          ]}
          onClose={() => setEdit(null)}
          submit={async (values) => {
            await request(ip(id, suffix), {
              method: "PUT",
              body: {
                ...JSON.parse(values.content),
                revision: resource.data.revision,
              },
            });
            resource.reload();
          }}
        />
      )}
    </Card>
  );
}
