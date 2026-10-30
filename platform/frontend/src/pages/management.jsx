import { useState } from "react";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Check,
  Field,
  FormDialog,
  JsonView,
  Resource,
  Select,
} from "@/components/shared";
import { canNavigate, useAction, useResource } from "@/lib/hooks";
import { request } from "@/lib/api";
import { instancePath as ip } from "@/lib/utils";

export function Agents({ id }) {
  const resource = useResource(ip(id, "/agents"));
  const [edit, setEdit] = useState(null);
  const [binding, setBinding] = useState(false);
  const [file, setFile] = useState(null);
  const { busy, run } = useAction();
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium">Agents</h2>
        <Button size="sm" onClick={() => setEdit({})}>
          <Plus />
          新建 Agent
        </Button>
      </div>
      <Resource resource={resource}>
        {(data) => (
          <>
            <div className="grid gap-4 lg:grid-cols-2">
              {data.agents.map((agent) => (
                <Card key={agent.id}>
                  <CardHeader>
                    <CardTitle>{agent.name || agent.id}</CardTitle>
                    <p className="pt-1 font-mono text-xs text-muted-foreground">
                      {agent.id}
                    </p>
                  </CardHeader>
                  <CardContent>
                    <p className="mb-4 break-all font-mono text-xs leading-6 text-muted-foreground">
                      {agent.workspace}
                      <br />
                      模型：
                      {typeof agent.modelOverride === "string"
                        ? agent.modelOverride
                        : agent.modelOverride?.primary ||
                          data.defaultModel ||
                          "继承默认"}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEdit(agent)}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (canNavigate())
                            setFile({ id: agent.id, name: "AGENTS.md" });
                        }}
                      >
                        角色文件
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={
                          busy || agent.id === "main" || data.agents.length <= 1
                        }
                        onClick={() => {
                          if (
                            confirm(
                              `移除 Agent「${agent.name}」？工作区与会话数据保留。`,
                            )
                          )
                            run(async () => {
                              await request(
                                ip(
                                  id,
                                  `/agents/${encodeURIComponent(agent.id)}`,
                                ),
                                {
                                  method: "DELETE",
                                  body: { revision: data.revision },
                                },
                              );
                              resource.reload();
                            }, "Agent 已移除");
                        }}
                      >
                        移除
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>消息路由</CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setBinding(true)}
                >
                  添加路由
                </Button>
              </CardHeader>
              <CardContent>
                {!data.bindings?.length && (
                  <p className="text-xs text-muted-foreground">
                    暂无额外路由，使用默认 Agent。
                  </p>
                )}
                {data.bindings?.map((row) => (
                  <div
                    key={row.managerId}
                    className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-border p-3"
                  >
                    <div className="min-w-0 text-xs text-muted-foreground">
                      <p>
                        {row.agentId} ← {row.match.channel} /{" "}
                        {row.match.accountId || "*"}
                      </p>
                      <p className="mt-1 font-mono">{row.match.peer?.id}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        if (confirm("移除此消息路由？"))
                          run(async () => {
                            await request(
                              ip(id, `/agent-bindings/${row.managerId}`),
                              {
                                method: "DELETE",
                                body: { revision: data.revision },
                              },
                            );
                            resource.reload();
                          }, "路由已移除");
                      }}
                    >
                      移除
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
            {edit && (
              <FormDialog
                title={edit.id ? "编辑 Agent" : "新建 Agent"}
                initial={{
                  name: edit.name || "",
                  agentId: edit.id || "",
                  model:
                    typeof edit.modelOverride === "string"
                      ? edit.modelOverride
                      : edit.modelOverride?.primary || "",
                }}
                fields={[
                  ...(!edit.id
                    ? [
                        {
                          key: "agentId",
                          label: "Agent ID",
                          required: true,
                          wide: true,
                        },
                      ]
                    : []),
                  {
                    key: "name",
                    label: "显示名称",
                    required: true,
                    wide: true,
                  },
                  {
                    key: "model",
                    label: "模型",
                    wide: true,
                    options: [
                      { value: "", label: "继承默认模型" },
                      ...data.models.map((m) => ({
                        value: m.ref,
                        label: m.label || m.ref,
                      })),
                    ],
                  },
                ]}
                onClose={() => setEdit(null)}
                submit={async (v) => {
                  await request(
                    ip(
                      id,
                      `/agents${edit.id ? `/${encodeURIComponent(edit.id)}` : ""}`,
                    ),
                    {
                      method: edit.id ? "PUT" : "POST",
                      body: {
                        ...v,
                        ...(edit.id ? { model: v.model || null } : {}),
                        revision: data.revision,
                      },
                    },
                  );
                  resource.reload();
                }}
              />
            )}
            {binding && (
              <FormDialog
                title="添加飞书消息路由"
                initial={{
                  agentId: data.agents[0]?.id,
                  accountId: "*",
                  peerKind: "",
                  peerId: "",
                }}
                fields={[
                  {
                    key: "agentId",
                    label: "目标 Agent",
                    required: true,
                    options: data.agents.map((a) => ({
                      value: a.id,
                      label: a.name || a.id,
                    })),
                  },
                  {
                    key: "accountId",
                    label: "飞书账号 ID",
                    hint: "* 表示全部账号",
                  },
                  {
                    key: "peerKind",
                    label: "消息范围",
                    options: [
                      { value: "", label: "所有消息" },
                      { value: "direct", label: "指定用户" },
                      { value: "group", label: "指定群聊" },
                    ],
                  },
                  { key: "peerId", label: "用户 / 群 ID" },
                ]}
                onClose={() => setBinding(false)}
                submit={async (v) => {
                  await request(ip(id, "/agent-bindings"), {
                    method: "POST",
                    body: { ...v, revision: data.revision },
                  });
                  resource.reload();
                }}
              />
            )}
          </>
        )}
      </Resource>
      {file && (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>{file.id} · 角色文件</CardTitle>
            <Select
              className="w-40"
              value={file.name}
              onChange={(e) => {
                if (canNavigate()) setFile({ ...file, name: e.target.value });
              }}
            >
              {[
                "AGENTS.md",
                "SOUL.md",
                "IDENTITY.md",
                "USER.md",
                "TOOLS.md",
                "HEARTBEAT.md",
              ].map((name) => (
                <option key={name}>{name}</option>
              ))}
            </Select>
          </CardHeader>
          <CardContent>
            <AgentFile id={id} agentId={file.id} name={file.name} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
function AgentFile({ id, agentId, name }) {
  // Agent-file responses nest their content; adapt without changing backend contracts.
  const resource = useResource(
    ip(
      id,
      `/agents/${encodeURIComponent(agentId)}/file?name=${encodeURIComponent(name)}`,
    ),
  );
  const [edit, setEdit] = useState(false);
  return (
    <Resource resource={resource}>
      {(data) => (
        <>
          <pre className="mb-4 max-h-80 overflow-auto whitespace-pre-wrap text-xs leading-6 text-muted-foreground">
            {data.file?.content || "（空文件）"}
          </pre>
          <Button variant="outline" size="sm" onClick={() => setEdit(true)}>
            编辑角色规则
          </Button>
          {edit && (
            <FormDialog
              title={`编辑 ${name}`}
              initial={{ content: data.file?.content || "" }}
              fields={[
                {
                  key: "content",
                  label: "文件内容",
                  type: "textarea",
                  wide: true,
                },
              ]}
              onClose={() => setEdit(false)}
              submit={async (v) => {
                await request(
                  ip(id, `/agents/${encodeURIComponent(agentId)}/file`),
                  {
                    method: "PUT",
                    body: { name, content: v.content, revision: data.revision },
                  },
                );
                resource.reload();
              }}
            />
          )}
        </>
      )}
    </Resource>
  );
}

export function Extensions({ id }) {
  const resource = useResource(ip(id, "/extensions"));
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [detail, setDetail] = useState(null);
  const [spec, setSpec] = useState("");
  const [review, setReview] = useState(null);
  const [consent, setConsent] = useState(false);
  const [confirmSpec, setConfirmSpec] = useState("");
  const { busy, run } = useAction();
  const mutation = (suffix, method, body) =>
    run(async () => {
      const result = await request(ip(id, suffix), { method, body });
      resource.reload();
      return result;
    }, "扩展已更新");
  return (
    <div className="space-y-6">
      <h2 className="text-base font-medium">技能与插件</h2>
      <Resource resource={resource}>
        {(data) => (
          <>
            <Card>
              <CardHeader>
                <CardTitle>技能</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {!data.skills.length && (
                    <p className="text-xs text-muted-foreground">
                      尚无可用技能。
                    </p>
                  )}
                  {data.skills.map((skill) => (
                    <div
                      key={skill.skillKey || skill.name}
                      className="flex items-center justify-between gap-4 rounded-lg border border-border p-4"
                    >
                      <div className="min-w-0">
                        <p className="text-sm">{skill.name}</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          {skill.description}
                        </p>
                        <p className="mt-2 text-[10px] text-muted-foreground">
                          {skill.eligible ? "依赖就绪" : "依赖未就绪"}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          mutation("/extensions/skill", "PUT", {
                            revision: data.revision,
                            agentId: data.agentId,
                            skillKey: skill.skillKey || skill.name,
                            enabled: !!skill.disabled,
                          })
                        }
                      >
                        {skill.disabled ? "启用" : "停用"}
                      </Button>
                    </div>
                  ))}
                </div>
                <form
                  className="mt-5 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(async () =>
                      setResults(
                        await request(
                          ip(
                            id,
                            `/extensions/skill/search?q=${encodeURIComponent(query)}`,
                          ),
                        ),
                      ),
                    );
                  }}
                >
                  <Input
                    aria-label="搜索技能"
                    placeholder="搜索 ClawHub 技能…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    required
                  />
                  <Button variant="outline" disabled={busy}>
                    <Search />
                    搜索
                  </Button>
                </form>
                {results && (
                  <div className="mt-4 space-y-3">
                    {(
                      results.results ||
                      results.skills ||
                      results.items ||
                      []
                    ).map((row, i) => (
                      <div
                        key={row.slug || i}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
                      >
                        <span className="text-xs">{row.name || row.slug}</span>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            run(async () =>
                              setDetail({
                                slug: row.slug,
                                report: await request(
                                  ip(
                                    id,
                                    `/extensions/skill/detail?slug=${encodeURIComponent(row.slug)}`,
                                  ),
                                ),
                              }),
                            )
                          }
                        >
                          查看详情
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {detail && (
                  <div className="mt-4 space-y-3">
                    <JsonView value={detail.report} />
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        if (confirm(`安装技能 ${detail.slug}？`))
                          mutation("/extensions/skill/install", "POST", {
                            revision: data.revision,
                            agentId: data.agentId,
                            slug: detail.slug,
                          });
                      }}
                    >
                      安装此技能
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>插件</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {data.plugins.map((plugin) => (
                    <div
                      key={plugin.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4"
                    >
                      <div>
                        <p className="text-sm">{plugin.name || plugin.id}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {plugin.version} · {plugin.status}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            mutation("/extensions/plugin", "PUT", {
                              revision: data.revision,
                              pluginId: plugin.id,
                              enabled: !plugin.enabled,
                            })
                          }
                        >
                          {plugin.enabled ? "停用" : "启用"}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            if (confirm(`卸载插件 ${plugin.id}？`))
                              mutation("/extensions/plugin/uninstall", "POST", {
                                revision: data.revision,
                                pluginId: plugin.id,
                              });
                          }}
                        >
                          卸载
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
                <form
                  className="mt-5 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setReview(null);
                    setConsent(false);
                    setConfirmSpec("");
                    run(async () =>
                      setReview(
                        await request(ip(id, "/extensions/plugin/review"), {
                          method: "POST",
                          body: { spec, revision: data.revision },
                        }),
                      ),
                    );
                  }}
                >
                  <Input
                    aria-label="固定版本插件包"
                    placeholder="@scope/plugin@1.2.3"
                    value={spec}
                    onChange={(e) => {
                      setSpec(e.target.value);
                      setReview(null);
                      setConsent(false);
                      setConfirmSpec("");
                    }}
                    required
                  />
                  <Button variant="outline" disabled={busy}>
                    审查插件
                  </Button>
                </form>
                {review && (
                  <div className="mt-5 space-y-4">
                    <JsonView value={review} />
                    <p className="text-xs leading-6 text-muted-foreground">
                      检查完整审查报告，确认来源、版本和权限后再继续。
                    </p>
                    <Field label="输入完整包名与固定版本确认">
                      <Input
                        value={confirmSpec}
                        onChange={(e) => setConfirmSpec(e.target.value)}
                        placeholder={review.spec}
                      />
                    </Field>
                    <Check
                      label="我已阅读报告，并同意本次审查中声明的权限"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    <Button
                      size="sm"
                      disabled={busy || !consent || confirmSpec !== review.spec}
                      onClick={() =>
                        run(async () => {
                          const result = await request(
                            ip(id, "/extensions/plugin/install"),
                            {
                              method: "POST",
                              body: {
                                revision: data.revision,
                                spec,
                                reviewToken: review.reviewToken,
                                confirmSpec,
                              },
                            },
                          );
                          if (result.reviewRequired) {
                            setReview(result);
                            setConsent(false);
                            setConfirmSpec("");
                          } else {
                            setReview(null);
                            resource.reload();
                          }
                        }, "安装请求已处理")
                      }
                    >
                      按审查结果安装
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
            {(data.isolatedPlugins?.length > 0 ||
              data.isolatedChannels?.length > 0) && (
              <Card>
                <CardHeader>
                  <CardTitle>独立运行的扩展</CardTitle>
                </CardHeader>
                <CardContent>
                  <JsonView
                    value={{
                      plugins: data.isolatedPlugins,
                      channels: data.isolatedChannels,
                    }}
                  />
                </CardContent>
              </Card>
            )}
          </>
        )}
      </Resource>
    </div>
  );
}
